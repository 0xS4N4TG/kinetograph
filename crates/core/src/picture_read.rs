//! `getImageData` of a canvas that holds one decoded picture, answered on the CPU (packages/cli/skills/kinetograph/references/SCENE.md,
//! "canvas"). A project that reads video pixels per frame (`onVideoFrame`, then `drawImage` and `getImageData`) cannot
//! afford to open the GPU for each read, so when the commands so far are one plain `drawImage` of a picture file or a
//! video frame, the pixels come from the decoder's cache and are resampled here. Any other canvas is drawn by the
//! renderer (`None` from `PictureReader::read`).
//!
//! The resampling is what the renderer does for such a draw: Skia's bilinear filter (`imageSmoothingEnabled`) or the
//! nearest texel, at pixel centres, with no mipmaps. At 1:1 the pixels are the picture's own.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use peniko::Blob;

use crate::canvas::{CanvasBlend, CanvasOp, CanvasSource, ImageOp};
use crate::video::{self, VideoDecoder};

/// The part of the canvas that is read: it may reach outside the canvas, where pixels are transparent black.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReadRect {
    pub x: i64,
    pub y: i64,
    pub width: u32,
    pub height: u32,
}

/// A decoded picture: straight-alpha RGBA8.
struct Picture {
    width: u32,
    height: u32,
    rgba: Blob<u8>,
}

/// A file's identity: a changed file is read again.
#[derive(Clone, Debug, PartialEq, Eq)]
struct FileKey {
    len: u64,
    modified: Option<SystemTime>,
}

impl FileKey {
    fn of(path: &Path) -> Option<FileKey> {
        let meta = std::fs::metadata(path).ok()?;
        Some(FileKey {
            len: meta.len(),
            modified: meta.modified().ok(),
        })
    }
}

const MAX_IMAGES: usize = 16;
const MAX_VIDEOS: usize = 4;

/// Decoders and pictures kept from one read to the next.
#[derive(Default)]
pub struct PictureReader {
    images: HashMap<PathBuf, (FileKey, Arc<Picture>)>,
    videos: HashMap<PathBuf, (FileKey, VideoDecoder)>,
}

impl PictureReader {
    /// The RGBA8 pixels (straight alpha) of `rect` of a canvas of `canvas` pixels drawn with `ops`, or `None` when
    /// `ops` are more than one plain `drawImage` of a picture file or a video frame, which only the renderer can draw.
    /// `Err` is a picture that cannot be read (a missing file, a decode failure).
    pub fn read(
        &mut self,
        base_dir: &Path,
        ops: &[CanvasOp],
        canvas: (u32, u32),
        rect: ReadRect,
    ) -> Result<Option<Vec<u8>>, String> {
        let Some(draw) = plain_draw(ops) else {
            return Ok(None);
        };
        let m = draw.state.m;
        // Only a scale and a shift keep the destination a pixel-aligned box.
        if !(m[1] == 0.0 && m[2] == 0.0 && m[0] > 0.0 && m[3] > 0.0)
            || !(draw.dw > 0.0 && draw.dh > 0.0)
        {
            return Ok(None);
        }
        let dest = [
            m[0] * draw.dx + m[4],
            m[3] * draw.dy + m[5],
            m[0] * draw.dw,
            m[3] * draw.dh,
        ];
        let Some(dest) = dest.iter().map(|v| whole(*v)).collect::<Option<Vec<i64>>>() else {
            return Ok(None);
        };
        let (dx, dy, dw, dh) = (dest[0], dest[1], dest[2], dest[3]);
        if dw <= 0 || dh <= 0 || dw > 16384 || dh > 16384 {
            return Ok(None);
        }
        let Some(picture) = self.picture(base_dir, &draw.source)? else {
            return Ok(None);
        };
        let (pw, ph) = (f64::from(picture.width), f64::from(picture.height));
        let (sx, sy) = (draw.sx.unwrap_or(0.0), draw.sy.unwrap_or(0.0));
        let (sw, sh) = (draw.sw.unwrap_or(pw), draw.sh.unwrap_or(ph));
        if !(sw > 0.0 && sh > 0.0) || !(sx.is_finite() && sy.is_finite()) {
            return Ok(None);
        }
        // Nearest-neighbour shrinking puts pixel centres exactly between texels, where the GPU's choice is its own:
        // that is the renderer's, so the bytes are the same whichever path reads them.
        if !draw.smooth && (sw > dw as f64 || sh > dh as f64) {
            return Ok(None);
        }
        // The pixels the draw covers: its box, cut to the canvas.
        let covered = (
            dx.max(0),
            dy.max(0),
            (dx + dw).min(i64::from(canvas.0)),
            (dy + dh).min(i64::from(canvas.1)),
        );
        let mut out = vec![0_u8; rect.width as usize * rect.height as usize * 4];
        let (x0, y0) = (covered.0.max(rect.x), covered.1.max(rect.y));
        let (x1, y1) = (
            covered.2.min(rect.x + i64::from(rect.width)),
            covered.3.min(rect.y + i64::from(rect.height)),
        );
        if x1 <= x0 || y1 <= y0 {
            return Ok(Some(out));
        }
        let cols = taps(x0, x1, dx, dw, sx, sw, picture.width, draw.smooth);
        let rows = taps(y0, y1, dy, dh, sy, sh, picture.height, draw.smooth);
        let stride = picture.width as usize * 4;
        let rgba = picture.rgba.data();
        // At 1:1 each row is the picture's own row: copied whole.
        let run = cols
            .iter()
            .enumerate()
            .all(|(i, c)| c.t == 0.0 && c.a == cols[0].a + i);
        for (row_index, row) in rows.iter().enumerate() {
            let oy = (y0 - rect.y) as usize + row_index;
            if run && row.t == 0.0 {
                let at = (oy * rect.width as usize + (x0 - rect.x) as usize) * 4;
                let from = row.a * stride + cols[0].a * 4;
                out[at..at + cols.len() * 4].copy_from_slice(&rgba[from..from + cols.len() * 4]);
                continue;
            }
            for (col_index, col) in cols.iter().enumerate() {
                let ox = (x0 - rect.x) as usize + col_index;
                let at = (oy * rect.width as usize + ox) * 4;
                out[at..at + 4].copy_from_slice(&blend(rgba, stride, row, col));
            }
        }
        Ok(Some(out))
    }

    /// The decoded picture a source names, or `None` for a source this reader does not read (a canvas, SVG, a layer).
    fn picture(
        &mut self,
        base_dir: &Path,
        source: &CanvasSource,
    ) -> Result<Option<Arc<Picture>>, String> {
        match source {
            CanvasSource::Src { src } => {
                if crate::svg_picture::is_svg(src) || src.starts_with("data:") {
                    return Ok(None);
                }
                let path = base_dir.join(src);
                let key =
                    FileKey::of(&path).ok_or_else(|| format!("cannot read {}", path.display()))?;
                if let Some((held, picture)) = self.images.get(&path)
                    && *held == key
                {
                    return Ok(Some(picture.clone()));
                }
                let decoded = image::open(&path)
                    .map_err(|e| format!("{}: {e}", path.display()))?
                    .to_rgba8();
                let (width, height) = decoded.dimensions();
                let picture = Arc::new(Picture {
                    width,
                    height,
                    rgba: Blob::from(decoded.into_raw()),
                });
                if self.images.len() >= MAX_IMAGES {
                    self.images.clear();
                }
                self.images.insert(path, (key, picture.clone()));
                Ok(Some(picture))
            }
            CanvasSource::Video { src, time, end } => {
                let path = base_dir.join(src);
                let key =
                    FileKey::of(&path).ok_or_else(|| format!("cannot read {}", path.display()))?;
                if self.videos.get(&path).is_none_or(|(held, _)| *held != key) {
                    if self.videos.len() >= MAX_VIDEOS {
                        self.videos.clear();
                    }
                    video::init();
                    let info = video::probe(&path)
                        .map_err(|e| format!("video {}: {e}", path.display()))?;
                    let decoder = VideoDecoder::open(&path, info)
                        .map_err(|e| format!("video {}: {e}", path.display()))?;
                    self.videos.insert(path.clone(), (key, decoder));
                }
                let (_, decoder) = self.videos.get_mut(&path).expect("opened above");
                if !time.is_finite() {
                    return Err(format!(
                        "video {src:?}: the time must be a finite number of seconds"
                    ));
                }
                let info = decoder.info().clone();
                let at = info.media_time(time.max(0.0), end.unwrap_or(info.duration));
                let image = decoder
                    .picture(at.ts)
                    .map_err(|e| format!("video {src:?} at {:.3} s: {e}", at.seconds))?;
                // The bytes are the decoder's own (shared with its cache), not copied.
                Ok(Some(Arc::new(Picture {
                    width: image.width,
                    height: image.height,
                    rgba: image.data,
                })))
            }
            CanvasSource::Pixels { .. }
            | CanvasSource::Canvas { .. }
            | CanvasSource::Layer { .. } => Ok(None),
        }
    }
}

/// The one picture draw in `ops` if there is nothing else that leaves a mark: no shadow, filter, alpha, composite
/// operation or clip. A `clearRect` before the draw changes nothing (the canvas starts empty).
fn plain_draw(ops: &[CanvasOp]) -> Option<&ImageOp> {
    let mut draws = ops
        .iter()
        .filter(|op| !matches!(op, CanvasOp::Fill(f) if f.state.blend == CanvasBlend::Clear));
    let CanvasOp::Image(draw) = draws.next()? else {
        return None;
    };
    if draws.next().is_some() {
        return None;
    }
    // A clear after the draw would not be a no-op.
    let at = ops.iter().position(|op| matches!(op, CanvasOp::Image(_)))?;
    if ops[at + 1..]
        .iter()
        .any(|op| matches!(op, CanvasOp::Fill(_)))
    {
        return None;
    }
    let s = &draw.state;
    (s.a == 1.0 && s.blend == CanvasBlend::SourceOver && s.shadow.is_none() && s.filter.is_empty())
        .then_some(draw)
}

/// `value` as a whole number of pixels, or `None` when it is not one (the edge would be anti-aliased).
fn whole(value: f64) -> Option<i64> {
    let rounded = value.round();
    ((value - rounded).abs() < 1e-9 && rounded.abs() < 1e6).then_some(rounded as i64)
}

/// Where one output row or column reads: two texels and the weight of the second.
#[derive(Clone, Copy)]
struct Tap {
    a: usize,
    b: usize,
    t: f32,
}

/// The taps of the canvas pixels `from..to` along one axis: the destination box starts at `d` and is `dn` pixels
/// across, and shows `s..s + sn` of a picture `n` texels across.
#[allow(clippy::too_many_arguments)]
fn taps(from: i64, to: i64, d: i64, dn: i64, s: f64, sn: f64, n: u32, smooth: bool) -> Vec<Tap> {
    // Samples stay inside the source rectangle (Skia's strict constraint) and the picture.
    let lo = (s.floor() as i64).clamp(0, i64::from(n) - 1);
    let hi = ((s + sn).ceil() as i64 - 1).clamp(lo, i64::from(n) - 1);
    let scale = sn / dn as f64;
    (from..to)
        .map(|c| {
            let at = s + ((c - d) as f64 + 0.5) * scale;
            if smooth {
                let at = at - 0.5;
                let base = at.floor();
                let t = (at - base) as f32;
                let a = (base as i64).clamp(lo, hi) as usize;
                let b = (base as i64 + 1).clamp(lo, hi) as usize;
                Tap {
                    a,
                    b,
                    t: if a == b { 0.0 } else { t },
                }
            } else {
                let a = (at.floor() as i64).clamp(lo, hi) as usize;
                Tap { a, b: a, t: 0.0 }
            }
        })
        .collect()
}

/// One output pixel: the four texels of the taps, mixed in premultiplied alpha and returned straight.
fn blend(rgba: &[u8], stride: usize, row: &Tap, col: &Tap) -> [u8; 4] {
    let texel = |y: usize, x: usize| -> [u8; 4] {
        let i = y * stride + x * 4;
        [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
    };
    if row.t == 0.0 && col.t == 0.0 {
        return texel(row.a, col.a);
    }
    let t = [
        texel(row.a, col.a),
        texel(row.a, col.b),
        texel(row.b, col.a),
        texel(row.b, col.b),
    ];
    let w = [
        (1.0 - row.t) * (1.0 - col.t),
        (1.0 - row.t) * col.t,
        row.t * (1.0 - col.t),
        row.t * col.t,
    ];
    let alpha: f32 = (0..4).map(|k| w[k] * f32::from(t[k][3])).sum();
    if alpha <= 0.0 {
        return [0, 0, 0, 0];
    }
    let mut out = [0_u8; 4];
    for (c, slot) in out.iter_mut().enumerate().take(3) {
        let premul: f32 = (0..4)
            .map(|k| w[k] * f32::from(t[k][c]) * f32::from(t[k][3]) / 255.0)
            .sum();
        *slot = (premul * 255.0 / alpha).round().clamp(0.0, 255.0) as u8;
    }
    out[3] = alpha.round().clamp(0.0, 255.0) as u8;
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ops(json: &str) -> Vec<CanvasOp> {
        serde_json::from_str(json).expect("commands parse")
    }

    fn media(file: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/scenes/media")
            .join(file)
    }

    #[test]
    fn one_to_one_is_the_pictures_own_pixels() {
        let commands = ops(
            r#"[{"op":"image","source":{"kind":"src","src":"checker.png"},"dx":0,"dy":0,"dw":64,"dh":64}]"#,
        );
        let rect = ReadRect {
            x: 0,
            y: 0,
            width: 64,
            height: 64,
        };
        let got = PictureReader::default()
            .read(&media(""), &commands, (64, 64), rect)
            .unwrap()
            .unwrap();
        assert_eq!(
            got,
            image::open(media("checker.png"))
                .unwrap()
                .to_rgba8()
                .into_raw()
        );
    }

    #[test]
    fn more_than_one_draw_is_the_renderers() {
        let commands = ops(
            r#"[{"op":"image","source":{"kind":"src","src":"checker.png"},"dx":0,"dy":0,"dw":8,"dh":8},
                {"op":"image","source":{"kind":"src","src":"flat.png"},"dx":0,"dy":0,"dw":8,"dh":8}]"#,
        );
        let mut reader = PictureReader::default();
        let rect = ReadRect {
            x: 0,
            y: 0,
            width: 8,
            height: 8,
        };
        assert_eq!(
            reader.read(&media(""), &commands, (8, 8), rect).unwrap(),
            None
        );
    }

    #[test]
    fn a_draw_with_alpha_a_shadow_or_a_turn_is_the_renderers() {
        let rect = ReadRect {
            x: 0,
            y: 0,
            width: 8,
            height: 8,
        };
        let mut reader = PictureReader::default();
        for state in [
            r#""a":0.5"#,
            r#""blend":"multiply""#,
            r#""m":[0,1,-1,0,0,0]"#,
            r#""filter":[{"type":"grayscale","amount":1}]"#,
        ] {
            let json = format!(
                r#"[{{"op":"image","source":{{"kind":"src","src":"checker.png"}},"dx":0,"dy":0,"dw":8,"dh":8,{state}}}]"#
            );
            assert_eq!(
                reader.read(&media(""), &ops(&json), (8, 8), rect).unwrap(),
                None,
                "{state}"
            );
        }
    }

    #[test]
    fn a_nearest_neighbour_shrink_is_the_renderers() {
        let shrunk = ops(
            r#"[{"op":"image","source":{"kind":"src","src":"checker.png"},"dx":0,"dy":0,"dw":32,"dh":32,"smooth":false}]"#,
        );
        let grown = ops(
            r#"[{"op":"image","source":{"kind":"src","src":"checker.png"},"dx":0,"dy":0,"dw":128,"dh":128,"smooth":false}]"#,
        );
        let rect = ReadRect {
            x: 0,
            y: 0,
            width: 32,
            height: 32,
        };
        let mut reader = PictureReader::default();
        assert_eq!(
            reader.read(&media(""), &shrunk, (32, 32), rect).unwrap(),
            None
        );
        assert!(
            reader
                .read(
                    &media(""),
                    &grown,
                    (128, 128),
                    ReadRect {
                        width: 128,
                        height: 128,
                        ..rect
                    }
                )
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn a_box_off_the_pixel_grid_is_the_renderers() {
        let commands = ops(
            r#"[{"op":"image","source":{"kind":"src","src":"checker.png"},"dx":0.5,"dy":0,"dw":8,"dh":8}]"#,
        );
        let rect = ReadRect {
            x: 0,
            y: 0,
            width: 8,
            height: 8,
        };
        assert_eq!(
            PictureReader::default()
                .read(&media(""), &commands, (8, 8), rect)
                .unwrap(),
            None
        );
    }

    #[test]
    fn a_missing_file_is_an_error() {
        let commands = ops(
            r#"[{"op":"image","source":{"kind":"src","src":"nope.png"},"dx":0,"dy":0,"dw":8,"dh":8}]"#,
        );
        let rect = ReadRect {
            x: 0,
            y: 0,
            width: 8,
            height: 8,
        };
        assert!(
            PictureReader::default()
                .read(&media(""), &commands, (8, 8), rect)
                .is_err()
        );
    }

    #[test]
    fn pixels_outside_the_draw_and_the_canvas_are_transparent() {
        // An 8 x 8 picture drawn at (2, 2) on a 10 x 10 canvas, read over (-1, -1) to (11, 11).
        let commands = ops(
            r#"[{"op":"image","source":{"kind":"src","src":"flat.png"},"dx":2,"dy":2,"dw":8,"dh":8}]"#,
        );
        let rect = ReadRect {
            x: -1,
            y: -1,
            width: 12,
            height: 12,
        };
        let got = PictureReader::default()
            .read(&media(""), &commands, (10, 10), rect)
            .unwrap()
            .unwrap();
        let alpha = |x: usize, y: usize| got[(y * 12 + x) * 4 + 3];
        assert_eq!(alpha(0, 0), 0, "outside the canvas");
        assert_eq!(alpha(2, 2), 0, "canvas, left of the draw");
        assert_ne!(alpha(3, 3), 0, "inside the draw");
        assert_eq!(alpha(11, 11), 0, "outside the canvas");
    }

    #[test]
    fn a_leading_clear_changes_nothing() {
        let commands = ops(
            r##"[{"op":"fill","path":"M0 0L8 0L8 8L0 8Z","paint":{"type":"color","color":"#000000"},"blend":"clear"},
                {"op":"image","source":{"kind":"src","src":"flat.png"},"dx":0,"dy":0,"dw":8,"dh":8}]"##,
        );
        let rect = ReadRect {
            x: 0,
            y: 0,
            width: 8,
            height: 8,
        };
        assert!(
            PictureReader::default()
                .read(&media(""), &commands, (8, 8), rect)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn a_video_frame_is_read_at_the_size_asked() {
        let commands = ops(
            r#"[{"op":"image","source":{"kind":"video","src":"clip.mp4","time":0.5},"dx":0,"dy":0,"dw":32,"dh":18}]"#,
        );
        let rect = ReadRect {
            x: 0,
            y: 0,
            width: 32,
            height: 18,
        };
        let mut reader = PictureReader::default();
        let a = reader
            .read(&media(""), &commands, (32, 18), rect)
            .unwrap()
            .unwrap();
        let b = reader
            .read(&media(""), &commands, (32, 18), rect)
            .unwrap()
            .unwrap();
        assert_eq!(a.len(), 32 * 18 * 4);
        assert_eq!(a, b, "the same frame twice is the same bytes");
        assert!(a.chunks(4).all(|p| p[3] == 255), "a video frame is opaque");
        assert!(a.iter().any(|v| *v != 0), "the frame has a picture");
        // A fresh reader (a fresh decoder) reads the same frame.
        let c = PictureReader::default()
            .read(&media(""), &commands, (32, 18), rect)
            .unwrap()
            .unwrap();
        assert_eq!(a, c);
    }

    /// The alpha of a matte video (`matte-4444.mkv`: ProRes 4444, a disc of radius 10 whose centre is at x = 8 + 4n on
    /// frame n of 12 fps, y = 18) comes through the decoder, so a project can read a matte's alpha per frame.
    #[test]
    fn a_matte_video_keeps_its_alpha() {
        let alpha_at = |frame: u32| {
            let time = f64::from(frame) / 12.0;
            let commands = ops(&format!(
                r#"[{{"op":"image","source":{{"kind":"video","src":"matte-4444.mkv","time":{time}}},"dx":0,"dy":0,"dw":64,"dh":36}}]"#
            ));
            let rect = ReadRect {
                x: 0,
                y: 0,
                width: 64,
                height: 36,
            };
            let rgba = PictureReader::default()
                .read(&media(""), &commands, (64, 36), rect)
                .unwrap()
                .unwrap();
            move |x: usize, y: usize| rgba[(y * 64 + x) * 4 + 3]
        };
        for frame in [0_u32, 5, 11] {
            let alpha = alpha_at(frame);
            let centre = 8 + 4 * frame as usize;
            assert_eq!(alpha(centre, 18), 255, "frame {frame}: inside the disc");
            assert_eq!(alpha(centre, 2), 0, "frame {frame}: above the disc");
            assert_eq!(alpha((centre + 24) % 64, 18), 0, "frame {frame}: far from the disc");
        }
    }

    #[test]
    fn bilinear_halves_a_two_texel_picture_to_its_mean() {
        // Two texels, 0 and 200, shrunk to one: the middle of the bilinear footprint.
        let rgba = [0, 0, 0, 255, 200, 200, 200, 255];
        let cols = taps(0, 1, 0, 1, 0.0, 2.0, 2, true);
        let rows = taps(0, 1, 0, 1, 0.0, 1.0, 1, true);
        assert_eq!(blend(&rgba, 8, &rows[0], &cols[0]), [100, 100, 100, 255]);
    }

    #[test]
    fn nearest_picks_the_texel_under_the_pixel_centre() {
        let cols = taps(0, 4, 0, 4, 0.0, 2.0, 2, false);
        assert_eq!(
            cols.iter().map(|t| t.a).collect::<Vec<_>>(),
            vec![0, 0, 1, 1]
        );
    }
}
