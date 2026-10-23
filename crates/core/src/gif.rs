//! GIF layers: animated pictures decoded by the `image` crate.
//!
//! A GIF is decoded once, when a renderer opens it, into its full-screen
//! pictures (the `image` crate composes each frame over the ones before it by
//! the frame's disposal method), and the picture for a time is picked by the
//! frame delays (`docs/SCENE.md`, "gif"). All the pictures stay in memory.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read, Seek};
use std::path::Path;

use image::codecs::gif::GifDecoder;
use image::codecs::png::PngDecoder;
use image::codecs::webp::WebPDecoder;
use image::{AnimationDecoder, DynamicImage, Frames, ImageDecoder};
use peniko::{Blob, ImageAlphaType, ImageData, ImageFormat};

use crate::error::{Error, Result};
use crate::scene::{LayerKind, Scene, walk_layers};

/// A delay of this many milliseconds or less is not believed; browsers show
/// such a frame for `DEFAULT_DELAY_MS`.
const SHORTEST_DELAY_MS: u32 = 10;
const DEFAULT_DELAY_MS: u32 = 100;

/// How long a picture with the file's delay of `raw_ms` milliseconds shows.
pub fn delay_ms(raw_ms: u32) -> u32 {
    if raw_ms <= SHORTEST_DELAY_MS {
        DEFAULT_DELAY_MS
    } else {
        raw_ms
    }
}

/// The picture shown `seconds` into an animation whose pictures end at
/// `ends_ms` (the running sum of their delays). A time before 0 is the first
/// picture; one past the end is the last, or with `looped` wraps round.
pub fn picture_index(ends_ms: &[f64], seconds: f64, looped: bool) -> usize {
    let Some(&total) = ends_ms.last() else {
        return 0;
    };
    let mut ms = seconds * 1000.0;
    if ms < 0.0 || ms.is_nan() {
        return 0;
    }
    if looped {
        ms = ms.rem_euclid(total);
    }
    // The first picture that has not ended yet.
    ends_ms
        .iter()
        .position(|&end| ms < end)
        .unwrap_or(ends_ms.len() - 1)
}

/// Whether `path` starts with the signature of a GIF, an APNG or an animated
/// WebP.
pub fn is_gif(path: &Path) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut signature = [0_u8; 12];
    let n = file.read(&mut signature).unwrap_or(0);
    if n >= 6 && (&signature[..6] == b"GIF87a" || &signature[..6] == b"GIF89a") {
        return true;
    }
    if file.rewind().is_err() {
        return false;
    }
    if n >= 4 && signature[..4] == [0x89, 0x50, 0x4E, 0x47] {
        return PngDecoder::new(BufReader::new(file))
            .and_then(|d| d.is_apng())
            .unwrap_or(false);
    }
    if n == 12 && &signature[..4] == b"RIFF" && &signature[8..12] == b"WEBP" {
        return WebPDecoder::new(BufReader::new(file)).is_ok_and(|d| d.has_animation());
    }
    false
}

/// What a GIF file holds.
#[derive(Clone, Debug, PartialEq)]
pub struct GifInfo {
    /// The logical screen.
    pub width: u32,
    pub height: u32,
    pub pictures: u32,
    /// The sum of the delays, as shown (`delay_ms`).
    pub duration_ms: f64,
}

/// A GIF's pictures, one at a time: full-screen RGBA8 and the delay each
/// shows for, in milliseconds (`delay_ms`).
type Pictures = Box<dyn Iterator<Item = std::result::Result<(Vec<u8>, u32), String>>>;

fn map_frames(frames: Frames<'static>) -> Pictures {
    Box::new(frames.map(|frame| {
        let frame = frame.map_err(|e| format!("cannot decode ({e})"))?;
        let (numerator, denominator) = frame.delay().numer_denom_ms();
        let raw = (f64::from(numerator) / f64::from(denominator.max(1))).round() as u32;
        Ok((frame.into_buffer().into_raw(), delay_ms(raw)))
    }))
}

fn still_picture<D: ImageDecoder>(decoder: D) -> std::result::Result<Pictures, String> {
    let rgba = DynamicImage::from_decoder(decoder)
        .map_err(|e| format!("cannot decode ({e})"))?
        .into_rgba8()
        .into_raw();
    Ok(Box::new(std::iter::once(Ok((rgba, delay_ms(0))))))
}

/// Opens a GIF, PNG/APNG or WebP: its logical screen and its pictures.
fn decode(path: &Path) -> std::result::Result<(u32, u32, Pictures), String> {
    let mut file = File::open(path).map_err(|e| format!("cannot read: {e}"))?;
    let mut signature = [0_u8; 12];
    let n = file
        .read(&mut signature)
        .map_err(|e| format!("cannot read: {e}"))?;
    file.rewind().map_err(|e| format!("cannot read: {e}"))?;
    let reader = BufReader::new(file);

    if n >= 4 && signature[..4] == [0x89, 0x50, 0x4E, 0x47] {
        let decoder = PngDecoder::new(reader).map_err(|e| format!("not a PNG ({e})"))?;
        let (width, height) = decoder.dimensions();
        let is_apng = decoder
            .is_apng()
            .map_err(|e| format!("cannot decode ({e})"))?;
        let frames = if is_apng {
            let apng = decoder.apng().map_err(|e| format!("cannot decode ({e})"))?;
            map_frames(apng.into_frames())
        } else {
            still_picture(decoder)?
        };
        return Ok((width, height, frames));
    }

    if n == 12 && &signature[..4] == b"RIFF" && &signature[8..12] == b"WEBP" {
        let decoder = WebPDecoder::new(reader).map_err(|e| format!("not a WebP ({e})"))?;
        let (width, height) = decoder.dimensions();
        let frames = if decoder.has_animation() {
            map_frames(decoder.into_frames())
        } else {
            still_picture(decoder)?
        };
        return Ok((width, height, frames));
    }

    let decoder = GifDecoder::new(reader).map_err(|e| format!("not a GIF ({e})"))?;
    let (width, height) = decoder.dimensions();
    Ok((width, height, map_frames(decoder.into_frames())))
}

/// Reads how many pictures a GIF has and how long they last. (This decodes
/// the file; a GIF has no index to read instead.)
pub fn probe(path: &Path) -> std::result::Result<GifInfo, String> {
    let (width, height, frames) = decode(path)?;
    let mut pictures = 0;
    let mut duration_ms = 0.0;
    for frame in frames {
        let (_, delay) = frame?;
        pictures += 1;
        duration_ms += f64::from(delay);
    }
    if pictures == 0 {
        return Err("it has no pictures".into());
    }
    Ok(GifInfo {
        width,
        height,
        pictures,
        duration_ms,
    })
}

/// One GIF, decoded.
pub struct Gif {
    pictures: Vec<ImageData>,
    /// Where each picture ends, in milliseconds from the start.
    ends_ms: Vec<f64>,
}

impl Gif {
    pub fn open(path: &Path) -> std::result::Result<Gif, String> {
        let (width, height, frames) = decode(path)?;
        let mut pictures = Vec::new();
        let mut ends_ms = Vec::new();
        let mut end = 0.0;
        for frame in frames {
            let (rgba, delay) = frame?;
            end += f64::from(delay);
            ends_ms.push(end);
            pictures.push(ImageData {
                data: Blob::from(rgba),
                format: ImageFormat::Rgba8,
                alpha_type: ImageAlphaType::Alpha,
                width,
                height,
            });
        }
        if pictures.is_empty() {
            return Err("it has no pictures".into());
        }
        Ok(Gif { pictures, ends_ms })
    }

    /// The picture shown `seconds` in. The same picture twice is the same
    /// `ImageData`, so Skia keeps one image for it.
    pub fn picture(&self, seconds: f64, looped: bool) -> &ImageData {
        &self.pictures[picture_index(&self.ends_ms, seconds, looped)]
    }
}

/// Every GIF of a scene, decoded, by `src`.
#[derive(Default)]
pub struct Gifs {
    gifs: HashMap<String, Gif>,
}

impl Gifs {
    pub fn is_empty(&self) -> bool {
        self.gifs.is_empty()
    }

    /// Keeps `gif` as the one `src` names, replacing one of the same name.
    pub(crate) fn insert(&mut self, src: String, gif: Gif) {
        self.gifs.insert(src, gif);
    }

    /// Which picture of `src` is shown `seconds` in.
    pub(crate) fn index(&self, src: &str, seconds: f64, looped: bool) -> Option<usize> {
        let gif = self.gifs.get(src)?;
        Some(picture_index(&gif.ends_ms, seconds, looped))
    }

    /// The picture `src` shows `seconds` in, as an image to draw.
    pub fn image(&self, src: &str, seconds: f64, looped: bool) -> Result<ImageData> {
        let gif = self
            .gifs
            .get(src)
            .ok_or_else(|| Error::Render(format!("gif {src:?} was not loaded")))?;
        Ok(gif.picture(seconds, looped).clone())
    }
}

/// The `(layer id, src)` of every GIF layer in the scene, motion-blur copies
/// included, in order of use. One used twice is listed twice.
pub(crate) fn gif_sources(scene: &Scene) -> Vec<(String, String)> {
    let mut sources = Vec::new();
    walk_layers(&scene.layers, &mut |layer| {
        if let LayerKind::Gif(g) = &layer.kind {
            sources.push((layer.id.clone(), g.src.clone()));
        }
    });
    sources
}

/// Decodes the GIF `src` of layer `id`, relative to `base_dir`; the error
/// names the layer and the file.
pub(crate) fn open_gif(base_dir: &Path, id: &str, src: &str) -> Result<Gif> {
    let path = base_dir.join(src);
    Gif::open(&path)
        .map_err(|e| Error::Render(format!("layer {id:?}: gif {}: {e}", path.display())))
}

/// Decodes every GIF the scene refers to. The renderer reads them a file at a
/// time (`render::read_assets`); this is for the test that every committed
/// scene's files load.
#[cfg(test)]
pub(crate) fn load_gifs(scene: &Scene) -> Result<Gifs> {
    let mut gifs = Gifs::default();
    for (id, src) in gif_sources(scene) {
        if gifs.gifs.contains_key(&src) {
            continue;
        }
        let gif = open_gif(&scene.base_dir, &id, &src)?;
        gifs.insert(src, gif);
    }
    Ok(gifs)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn spinner() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scenes/media/spinner.gif")
    }

    fn px(image: &ImageData, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * image.width + x) * 4) as usize;
        let d = image.data.as_ref();
        [d[i], d[i + 1], d[i + 2], d[i + 3]]
    }

    #[test]
    fn a_delay_of_ten_milliseconds_or_less_counts_as_a_hundred() {
        assert_eq!(delay_ms(0), 100);
        assert_eq!(delay_ms(10), 100);
        assert_eq!(delay_ms(11), 11);
        assert_eq!(delay_ms(40), 40);
        assert_eq!(delay_ms(2000), 2000);
    }

    #[test]
    fn the_picture_comes_from_the_summed_delays() {
        // Delays 100, 100, 40, 200, 60 ms.
        let ends = [100.0, 200.0, 240.0, 440.0, 500.0];
        let at = |seconds, looped| picture_index(&ends, seconds, looped);
        assert_eq!(at(0.0, false), 0);
        assert_eq!(at(0.099, false), 0);
        // A picture shows from its start up to the next one's.
        assert_eq!(at(0.1, false), 1);
        assert_eq!(at(0.199, false), 1);
        assert_eq!(at(0.2, false), 2);
        assert_eq!(at(0.24, false), 3);
        assert_eq!(at(0.44, false), 4);
        assert_eq!(at(0.499, false), 4);
        // Below 0 is the first picture, with or without a loop.
        assert_eq!(at(-0.3, false), 0);
        assert_eq!(at(-0.3, true), 0);
        // Past the end: held, or wrapped round.
        assert_eq!(at(0.5, false), 4);
        assert_eq!(at(60.0, false), 4);
        assert_eq!(at(0.5, true), 0);
        assert_eq!(at(0.65, true), 1);
        assert_eq!(at(1.74, true), 3);
        // One picture is always that picture.
        assert_eq!(picture_index(&[100.0], 7.0, true), 0);
        assert_eq!(picture_index(&[], 7.0, true), 0);
    }

    #[test]
    fn a_gif_is_read_with_its_delays_and_composed_pictures() {
        let info = probe(&spinner()).unwrap();
        assert_eq!((info.width, info.height, info.pictures), (32, 24, 5));
        // 0 -> 100, 10 -> 100, 40, 200 and 60 ms.
        assert_eq!(info.duration_ms, 500.0);
        assert!(is_gif(&spinner()));

        let gif = Gif::open(&spinner()).unwrap();
        let near = |got: [u8; 4], want: [u8; 3]| {
            got[3] == 255 && got.iter().zip(want).all(|(a, b)| a.abs_diff(b) <= 4)
        };
        // Red, green, blue, yellow: whole pictures.
        let colours = [
            (0.0, [220, 30, 30]),
            (0.15, [30, 200, 60]),
            (0.22, [30, 60, 220]),
            (0.3, [240, 220, 40]),
        ];
        for (seconds, colour) in colours {
            let picture = gif.picture(seconds, false);
            assert_eq!((picture.width, picture.height), (32, 24));
            assert!(
                near(px(picture, 3, 3), colour),
                "{seconds}: {:?}",
                px(picture, 3, 3)
            );
            assert!(near(px(picture, 28, 20), colour), "{seconds}");
        }
        // The last picture follows one disposed to the background: its
        // transparent corners show nothing, and the white square is there.
        let last = gif.picture(0.47, false);
        assert_eq!(px(last, 1, 1)[3], 0);
        assert_eq!(px(last, 30, 22)[3], 0);
        assert!(near(px(last, 15, 11), [255, 255, 255]));
        // The same picture is the same image, so the atlas holds it once.
        assert_eq!(
            gif.picture(0.01, false).data.id(),
            gif.picture(0.5, true).data.id()
        );
        assert_ne!(
            gif.picture(0.01, false).data.id(),
            gif.picture(0.15, false).data.id()
        );
    }

    #[test]
    fn says_what_is_wrong_with_a_file() {
        let missing = probe(&spinner().with_file_name("nope.gif")).unwrap_err();
        assert!(missing.contains("cannot read"), "{missing}");
        let png = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/card-art.png");
        assert!(!is_gif(&png));
        // A plain still PNG works as a one-picture animation (100 ms).
        let still = probe(&png).unwrap();
        assert_eq!((still.pictures, still.duration_ms), (1, 100.0));
        // A non-image file is rejected as not a GIF.
        let wav = spinner().with_file_name("tone-mono.wav");
        assert!(!is_gif(&wav));
        assert!(probe(&wav).unwrap_err().contains("not a GIF"));
        let err = open_gif(Path::new("."), "spin", "nope.gif")
            .err()
            .unwrap()
            .to_string();
        assert!(
            err.contains("\"spin\"") && err.contains("nope.gif"),
            "{err}"
        );
    }

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFF_u32;
        for &b in bytes {
            crc ^= u32::from(b);
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    fn push_png_chunk(out: &mut Vec<u8>, tag: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let start = out.len();
        out.extend_from_slice(tag);
        out.extend_from_slice(data);
        let crc = crc32(&out[start..]);
        out.extend_from_slice(&crc.to_be_bytes());
    }

    fn encode_single_png_idat(width: u32, height: u32, rgba: [u8; 4]) -> Vec<u8> {
        use image::{ExtendedColorType, ImageEncoder, codecs::png::PngEncoder};
        let mut png = Vec::new();
        let pixels = rgba.repeat((width * height) as usize);
        PngEncoder::new(&mut png)
            .write_image(&pixels, width, height, ExtendedColorType::Rgba8)
            .unwrap();
        // Extract concatenated IDAT payload bytes from the encoded PNG.
        let mut idat = Vec::new();
        let mut pos = 8;
        while pos + 8 <= png.len() {
            let len = u32::from_be_bytes(png[pos..pos + 4].try_into().unwrap()) as usize;
            let tag = &png[pos + 4..pos + 8];
            let data = &png[pos + 8..pos + 8 + len];
            if tag == b"IDAT" {
                idat.extend_from_slice(data);
            }
            pos += 12 + len;
        }
        idat
    }

    fn fctl_data(seq: u32, width: u32, height: u32, delay_num: u16, delay_den: u16) -> Vec<u8> {
        let mut d = Vec::with_capacity(26);
        d.extend_from_slice(&seq.to_be_bytes());
        d.extend_from_slice(&width.to_be_bytes());
        d.extend_from_slice(&height.to_be_bytes());
        d.extend_from_slice(&0_u32.to_be_bytes()); // x_offset
        d.extend_from_slice(&0_u32.to_be_bytes()); // y_offset
        d.extend_from_slice(&delay_num.to_be_bytes());
        d.extend_from_slice(&delay_den.to_be_bytes());
        d.push(0); // dispose_op: APNG_DISPOSE_OP_NONE
        d.push(0); // blend_op: APNG_BLEND_OP_SOURCE
        d
    }

    fn build_two_frame_apng(
        width: u32,
        height: u32,
        c0: [u8; 4],
        c1: [u8; 4],
        delay_ms: u16,
    ) -> Vec<u8> {
        let mut out = Vec::from(&b"\x89PNG\r\n\x1a\n"[..]);
        let mut ihdr = Vec::with_capacity(13);
        ihdr.extend_from_slice(&width.to_be_bytes());
        ihdr.extend_from_slice(&height.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit RGBA
        push_png_chunk(&mut out, b"IHDR", &ihdr);

        let mut actl = Vec::with_capacity(8);
        actl.extend_from_slice(&2_u32.to_be_bytes()); // num_frames = 2
        actl.extend_from_slice(&0_u32.to_be_bytes()); // num_plays = 0
        push_png_chunk(&mut out, b"acTL", &actl);

        // Frame 0: fcTL (seq=0) + IDAT
        push_png_chunk(
            &mut out,
            b"fcTL",
            &fctl_data(0, width, height, delay_ms, 1000),
        );
        let idat0 = encode_single_png_idat(width, height, c0);
        push_png_chunk(&mut out, b"IDAT", &idat0);

        // Frame 1: fcTL (seq=1) + fdAT (seq=2)
        push_png_chunk(
            &mut out,
            b"fcTL",
            &fctl_data(1, width, height, delay_ms, 1000),
        );
        let idat1 = encode_single_png_idat(width, height, c1);
        let mut fdat = Vec::with_capacity(4 + idat1.len());
        fdat.extend_from_slice(&2_u32.to_be_bytes());
        fdat.extend_from_slice(&idat1);
        push_png_chunk(&mut out, b"fdAT", &fdat);

        push_png_chunk(&mut out, b"IEND", &[]);
        out
    }

    fn encode_vp8l_chunk(width: u32, height: u32, rgba: [u8; 4]) -> Vec<u8> {
        use image::{ExtendedColorType, codecs::webp::WebPEncoder};
        let mut webp = Vec::new();
        let pixels = rgba.repeat((width * height) as usize);
        WebPEncoder::new_lossless(&mut webp)
            .encode(&pixels, width, height, ExtendedColorType::Rgba8)
            .unwrap();
        // Strip the 12-byte "RIFF....WEBP" header to keep the "VP8L..." chunk.
        webp.split_off(12)
    }

    fn push_riff_chunk(out: &mut Vec<u8>, tag: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(tag);
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(data);
        if data.len() % 2 == 1 {
            out.push(0);
        }
    }

    fn build_anmf_payload(width: u32, height: u32, duration_ms: u32, vp8l_chunk: &[u8]) -> Vec<u8> {
        let mut anmf = Vec::with_capacity(16 + vp8l_chunk.len());
        anmf.extend_from_slice(&[0, 0, 0]); // frame X = 0
        anmf.extend_from_slice(&[0, 0, 0]); // frame Y = 0
        let w = width - 1;
        let h = height - 1;
        anmf.extend_from_slice(&[w as u8, (w >> 8) as u8, (w >> 16) as u8]);
        anmf.extend_from_slice(&[h as u8, (h >> 8) as u8, (h >> 16) as u8]);
        anmf.extend_from_slice(&[
            duration_ms as u8,
            (duration_ms >> 8) as u8,
            (duration_ms >> 16) as u8,
        ]);
        // Reserved (6 bits) | blending method = 1 (do not blend, bit 1 = 0x02) | disposal = 0
        anmf.push(0x02);
        anmf.extend_from_slice(vp8l_chunk);
        anmf
    }

    fn build_two_frame_webp(
        width: u32,
        height: u32,
        c0: [u8; 4],
        c1: [u8; 4],
        delay_ms: u32,
    ) -> Vec<u8> {
        let mut chunks = Vec::new();
        // VP8X: flags (0x02 = animation, 0x10 = alpha) + 3 reserved + (w-1) u24 + (h-1) u24
        let mut vp8x = Vec::with_capacity(10);
        vp8x.extend_from_slice(&[0x12, 0, 0, 0]);
        let w = width - 1;
        let h = height - 1;
        vp8x.extend_from_slice(&[w as u8, (w >> 8) as u8, (w >> 16) as u8]);
        vp8x.extend_from_slice(&[h as u8, (h >> 8) as u8, (h >> 16) as u8]);
        push_riff_chunk(&mut chunks, b"VP8X", &vp8x);

        // ANIM: background color (BGRA = 0) + loop count (0 = infinite)
        push_riff_chunk(&mut chunks, b"ANIM", &[0, 0, 0, 0, 0, 0]);

        let vp8l0 = encode_vp8l_chunk(width, height, c0);
        let anmf0 = build_anmf_payload(width, height, delay_ms, &vp8l0);
        push_riff_chunk(&mut chunks, b"ANMF", &anmf0);

        let vp8l1 = encode_vp8l_chunk(width, height, c1);
        let anmf1 = build_anmf_payload(width, height, delay_ms, &vp8l1);
        push_riff_chunk(&mut chunks, b"ANMF", &anmf1);

        let mut riff = Vec::with_capacity(12 + chunks.len());
        riff.extend_from_slice(b"RIFF");
        riff.extend_from_slice(&((4 + chunks.len()) as u32).to_le_bytes());
        riff.extend_from_slice(b"WEBP");
        riff.extend_from_slice(&chunks);
        riff
    }

    #[test]
    fn apng_and_animated_webp_are_decoded_with_frame_delays() {
        let dir = std::env::temp_dir().join(format!("kinetograph-anim-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let red = [230, 20, 40, 255];
        let blue = [20, 80, 240, 255];

        // APNG (and with a non-matching extension to verify signature detection).
        let apng_path = dir.join("anim.apng");
        std::fs::write(&apng_path, build_two_frame_apng(4, 3, red, blue, 100)).unwrap();
        assert!(is_gif(&apng_path));
        let info = probe(&apng_path).unwrap();
        assert_eq!((info.width, info.height, info.pictures), (4, 3, 2));
        assert_eq!(info.duration_ms, 200.0);
        let apng = Gif::open(&apng_path).unwrap();
        assert_eq!(px(apng.picture(0.05, false), 1, 1), red);
        assert_eq!(px(apng.picture(0.15, false), 1, 1), blue);
        assert_eq!(px(apng.picture(0.25, true), 1, 1), red);

        // Animated WebP.
        let webp_path = dir.join("anim.webp");
        std::fs::write(&webp_path, build_two_frame_webp(4, 3, red, blue, 100)).unwrap();
        assert!(is_gif(&webp_path));
        let info = probe(&webp_path).unwrap();
        assert_eq!((info.width, info.height, info.pictures), (4, 3, 2));
        assert_eq!(info.duration_ms, 200.0);
        let webp = Gif::open(&webp_path).unwrap();
        assert_eq!(px(webp.picture(0.05, false), 1, 1), red);
        assert_eq!(px(webp.picture(0.15, false), 1, 1), blue);
        assert_eq!(px(webp.picture(0.25, true), 1, 1), red);

        // Still WebP works as a 1-picture animation and is not flagged as animated by is_gif.
        let still_webp_path = dir.join("still.webp");
        {
            use image::{ExtendedColorType, codecs::webp::WebPEncoder};
            let mut buf = Vec::new();
            WebPEncoder::new_lossless(&mut buf)
                .encode(&red.repeat(12), 4, 3, ExtendedColorType::Rgba8)
                .unwrap();
            std::fs::write(&still_webp_path, buf).unwrap();
        }
        assert!(!is_gif(&still_webp_path));
        let still_info = probe(&still_webp_path).unwrap();
        assert_eq!(
            (still_info.width, still_info.height, still_info.pictures),
            (4, 3, 1)
        );
        assert_eq!(still_info.duration_ms, 100.0);
        let still_webp = Gif::open(&still_webp_path).unwrap();
        assert_eq!(px(still_webp.picture(0.05, false), 1, 1), red);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
