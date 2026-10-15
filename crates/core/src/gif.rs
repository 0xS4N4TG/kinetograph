//! GIF layers: animated pictures decoded by the `image` crate.
//!
//! A GIF is decoded once, when a renderer opens it, into its full-screen
//! pictures (the `image` crate composes each frame over the ones before it by
//! the frame's disposal method), and the picture for a time is picked by the
//! frame delays (`docs/SCENE.md`, "gif"). All the pictures stay in memory.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

use image::codecs::gif::GifDecoder;
use image::{AnimationDecoder, ImageDecoder};
use vello::peniko::{Blob, ImageAlphaType, ImageData, ImageFormat};

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

/// Whether `path` starts with the signature of a GIF.
pub fn is_gif(path: &Path) -> bool {
    let mut signature = [0_u8; 6];
    File::open(path)
        .and_then(|mut f| f.read_exact(&mut signature))
        .is_ok()
        && (&signature == b"GIF87a" || &signature == b"GIF89a")
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

/// The pictures of a GIF file, one at a time, with the delay each shows for.
fn decode(
    path: &Path,
) -> std::result::Result<
    (
        u32,
        u32,
        impl Iterator<Item = std::result::Result<(Vec<u8>, u32), String>>,
    ),
    String,
> {
    let file = File::open(path).map_err(|e| format!("cannot read: {e}"))?;
    let decoder = GifDecoder::new(BufReader::new(file)).map_err(|e| format!("not a GIF ({e})"))?;
    let (width, height) = decoder.dimensions();
    let frames = decoder.into_frames().map(|frame| {
        let frame = frame.map_err(|e| format!("cannot decode ({e})"))?;
        let (numerator, denominator) = frame.delay().numer_denom_ms();
        let raw = (f64::from(numerator) / f64::from(denominator.max(1))).round() as u32;
        Ok((frame.into_buffer().into_raw(), delay_ms(raw)))
    });
    Ok((width, height, frames))
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
    /// `ImageData`, so it is one entry in Vello's image atlas.
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
        assert!(probe(&png).unwrap_err().contains("not a GIF"));
        let err = open_gif(Path::new("."), "spin", "nope.gif")
            .err()
            .unwrap()
            .to_string();
        assert!(
            err.contains("\"spin\"") && err.contains("nope.gif"),
            "{err}"
        );
    }
}
