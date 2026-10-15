//! `Renderer.preview` (docs/AUTHORING.md §11.2): a rendered frame scaled down
//! by a box filter and encoded as JPEG or PNG for the studio.
//!
//! The filter averages, over each output pixel's exact footprint in the
//! source (fractional coverage at the edges), premultiplied sRGB values: the
//! colour channels times alpha. A transparent pixel therefore contributes no
//! colour. JPEG has no alpha and is flattened over black, which is the
//! premultiplied value itself; PNG divides alpha back out. At scale 1 the
//! footprint is the pixel, so an opaque PNG is the render's bytes.

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::{ExtendedColorType, ImageEncoder};
use napi::bindgen_prelude::Buffer;

use crate::error::{Code, Result, error, invalid};
use crate::{PreviewImage, PreviewOptions};

const DEFAULT_QUALITY: u8 = 80;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Format {
    Jpeg,
    Png,
}

/// The options after checking.
struct Checked {
    scale: f64,
    format: Format,
    quality: u8,
}

fn check(options: &PreviewOptions) -> Result<Checked> {
    let scale = options.scale.unwrap_or(1.0);
    if !(scale.is_finite() && scale > 0.0 && scale <= 1.0) {
        return Err(invalid(format!(
            "scale must be a number above 0 and at most 1, got {scale}"
        )));
    }
    let format = match options.format.as_deref() {
        None | Some("jpeg") => Format::Jpeg,
        Some("png") => Format::Png,
        Some(other) => {
            return Err(invalid(format!(
                "format must be \"jpeg\" or \"png\", got \"{other}\""
            )));
        }
    };
    let quality = match options.quality {
        None => DEFAULT_QUALITY,
        Some(q) if q.is_finite() && q.fract() == 0.0 && (1.0..=100.0).contains(&q) => q as u8,
        Some(q) => {
            return Err(invalid(format!(
                "quality must be a whole number from 1 to 100, got {q}"
            )));
        }
    };
    Ok(Checked {
        scale,
        format,
        quality,
    })
}

/// `round(size * scale)`, at least 1 and at most `size`.
fn scaled(size: u32, scale: f64) -> u32 {
    ((f64::from(size) * scale).round() as u32).clamp(1, size)
}

/// For each of `out` output cells over `size` source cells, the first source
/// cell it covers and the weight of each cell from there: the overlap of the
/// cell with the output cell's footprint, over the footprint's length, so the
/// weights of an output cell add up to 1.
fn footprints(size: u32, out: u32) -> Vec<(usize, Vec<f32>)> {
    let step = f64::from(size) / f64::from(out);
    (0..out)
        .map(|o| {
            let start = f64::from(o) * step;
            // The last cell ends exactly at the edge, whatever the rounding.
            let end = if o + 1 == out {
                f64::from(size)
            } else {
                f64::from(o + 1) * step
            };
            let first = (start.floor() as usize).min(size as usize - 1);
            let last = (end.ceil() as usize).max(first + 1).min(size as usize);
            let weights = (first..last)
                .map(|i| {
                    let overlap = (end.min((i + 1) as f64) - start.max(i as f64)).max(0.0);
                    (overlap / step) as f32
                })
                .collect();
            (first, weights)
        })
        .collect()
}

/// `rgba` (straight alpha, `width * height * 4` bytes) box-filtered to
/// `out_width x out_height`, as premultiplied `[r, g, b, a]` floats in 0..=255
/// per pixel (`r` is the average of `r * a / 255`).
fn downscale(
    rgba: &[u8],
    width: u32,
    height: u32,
    out_width: u32,
    out_height: u32,
) -> Vec<[f32; 4]> {
    let (w, ow, oh) = (width as usize, out_width as usize, out_height as usize);
    let columns = footprints(width, out_width);
    let rows = footprints(height, out_height);
    let mut out = vec![[0.0f32; 4]; ow * oh];
    let mut line = vec![[0.0f32; 4]; ow];

    for (oy, (first_row, weights)) in rows.iter().enumerate() {
        let acc = &mut out[oy * ow..(oy + 1) * ow];
        for (dy, &wy) in weights.iter().enumerate() {
            let y = first_row + dy;
            let source = &rgba[y * w * 4..(y + 1) * w * 4];
            // One source row, filtered horizontally into `line`.
            for (cell, (first, weights)) in line.iter_mut().zip(&columns) {
                let mut sum = [0.0f32; 4];
                for (dx, &wx) in weights.iter().enumerate() {
                    let p = &source[(first + dx) * 4..(first + dx) * 4 + 4];
                    let a = f32::from(p[3]);
                    sum[0] += wx * f32::from(p[0]) * a / 255.0;
                    sum[1] += wx * f32::from(p[1]) * a / 255.0;
                    sum[2] += wx * f32::from(p[2]) * a / 255.0;
                    sum[3] += wx * a;
                }
                *cell = sum;
            }
            for (a, l) in acc.iter_mut().zip(&line) {
                for c in 0..4 {
                    a[c] += wy * l[c];
                }
            }
        }
    }
    out
}

fn byte(v: f32) -> u8 {
    (v + 0.5).clamp(0.0, 255.0) as u8
}

/// Premultiplied pixels flattened over black, as RGB8.
fn to_rgb(pixels: &[[f32; 4]]) -> Vec<u8> {
    pixels
        .iter()
        .flat_map(|p| [byte(p[0]), byte(p[1]), byte(p[2])])
        .collect()
}

/// Premultiplied pixels back to straight alpha, as RGBA8.
fn to_rgba(pixels: &[[f32; 4]]) -> Vec<u8> {
    pixels
        .iter()
        .flat_map(|p| {
            let a = p[3];
            let un = |c: f32| if a > 0.0 { byte(c * 255.0 / a) } else { 0 };
            [un(p[0]), un(p[1]), un(p[2]), byte(a)]
        })
        .collect()
}

fn encode_jpeg(rgb: &[u8], width: u32, height: u32, quality: u8) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, quality)
        .write_image(rgb, width, height, ExtendedColorType::Rgb8)
        .map_err(|e| error(Code::Render, format!("JPEG encode failed: {e}")))?;
    Ok(out)
}

fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    PngEncoder::new(&mut out)
        .write_image(rgba, width, height, ExtendedColorType::Rgba8)
        .map_err(|e| error(Code::Render, format!("PNG encode failed: {e}")))?;
    Ok(out)
}

/// `rgba` is a full-size straight-alpha sRGB frame, `width * height * 4` bytes.
pub fn preview(
    rgba: &[u8],
    width: u32,
    height: u32,
    options: &PreviewOptions,
) -> Result<PreviewImage> {
    let options = check(options)?;
    if width == 0 || height == 0 || rgba.len() as u64 != u64::from(width) * u64::from(height) * 4 {
        return Err(error(
            Code::Render,
            format!(
                "preview: a {width}x{height} frame needs {} bytes, got {}",
                u64::from(width) * u64::from(height) * 4,
                rgba.len()
            ),
        ));
    }
    let out_width = scaled(width, options.scale);
    let out_height = scaled(height, options.scale);
    let pixels = downscale(rgba, width, height, out_width, out_height);
    let (mime, data) = match options.format {
        Format::Jpeg => (
            "image/jpeg",
            encode_jpeg(&to_rgb(&pixels), out_width, out_height, options.quality)?,
        ),
        Format::Png => (
            "image/png",
            encode_png(&to_rgba(&pixels), out_width, out_height)?,
        ),
    };
    Ok(PreviewImage {
        width: out_width,
        height: out_height,
        mime: mime.to_string(),
        data: Buffer::from(data),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(scale: f64, format: &str) -> PreviewOptions {
        PreviewOptions {
            scale: Some(scale),
            format: Some(format.into()),
            quality: None,
        }
    }

    fn decode(data: &[u8]) -> image::RgbaImage {
        image::load_from_memory(data).unwrap().to_rgba8()
    }

    fn grid(width: u32, height: u32, pixel: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
        let mut out = Vec::new();
        for y in 0..height {
            for x in 0..width {
                out.extend_from_slice(&pixel(x, y));
            }
        }
        out
    }

    fn close(a: u8, b: u8, tolerance: u8) -> bool {
        a.abs_diff(b) <= tolerance
    }

    #[test]
    fn output_size_is_rounded_and_at_least_one() {
        assert_eq!(scaled(1080, 0.5), 540);
        assert_eq!(scaled(1081, 0.5), 541); // 540.5 rounds away from zero
        assert_eq!(scaled(1920, 1.0), 1920);
        assert_eq!(scaled(10, 0.04), 1);
        assert_eq!(scaled(1, 0.5), 1);
        assert_eq!(scaled(3, 0.9999), 3);
    }

    #[test]
    fn weights_of_an_output_cell_add_up_to_one() {
        for (size, out) in [(3, 2), (7, 3), (1080, 540), (1081, 541), (10, 1), (5, 5)] {
            for (o, (_, weights)) in footprints(size, out).iter().enumerate() {
                let total: f32 = weights.iter().sum();
                assert!(
                    (total - 1.0).abs() < 1e-4,
                    "{size}->{out} cell {o}: {total}"
                );
            }
        }
    }

    #[test]
    fn opaque_scale_one_png_is_the_render_byte_for_byte() {
        let rgba = grid(16, 11, |x, y| {
            [(x * 17) as u8, (y * 23) as u8, ((x ^ y) * 9) as u8, 255]
        });
        let image = preview(&rgba, 16, 11, &options(1.0, "png")).unwrap();
        assert_eq!((image.width, image.height), (16, 11));
        assert_eq!(image.mime, "image/png");
        assert_eq!(decode(&image.data).as_raw(), &rgba);
    }

    #[test]
    fn scale_one_keeps_translucent_pixels_to_within_rounding() {
        let rgba = grid(9, 7, |x, y| {
            let a = [255, 128, 3, 200, 17][((x + y) % 5) as usize];
            [
                (x * 29 + y) as u8,
                (y * 37 + 11) as u8,
                (x * y * 5) as u8,
                a,
            ]
        });
        let image = preview(&rgba, 9, 7, &options(1.0, "png")).unwrap();
        let decoded = decode(&image.data);
        for (got, want) in decoded.as_raw().chunks(4).zip(rgba.chunks(4)) {
            assert_eq!(got[3], want[3]);
            // Premultiplying at low alpha loses colour levels; that is the filter's cost, not an error.
            let tolerance = 255 / want[3].max(1) + 1;
            for c in 0..3 {
                assert!(close(got[c], want[c], tolerance), "{got:?} vs {want:?}");
            }
        }
    }

    #[test]
    fn a_uniform_frame_stays_uniform_at_any_scale() {
        let rgba = grid(37, 23, |_, _| [200, 100, 50, 255]);
        for scale in [1.0, 0.5, 0.3333, 0.1, 0.77] {
            let image = preview(&rgba, 37, 23, &options(scale, "png")).unwrap();
            assert_eq!(
                (image.width, image.height),
                (scaled(37, scale), scaled(23, scale))
            );
            for p in decode(&image.data).pixels() {
                assert_eq!(p.0, [200, 100, 50, 255], "scale {scale}");
            }
        }
    }

    #[test]
    fn a_two_by_two_block_is_averaged() {
        let rgba = [
            0, 0, 0, 255, 100, 100, 100, 255, //
            200, 200, 200, 255, 100, 100, 100, 255,
        ];
        let image = preview(&rgba, 2, 2, &options(0.5, "png")).unwrap();
        assert_eq!((image.width, image.height), (1, 1));
        assert_eq!(decode(&image.data).as_raw(), &[100, 100, 100, 255]);
    }

    #[test]
    fn edge_pixels_count_by_fractional_coverage() {
        // Three columns into two: the footprints are [0, 1.5) and [1.5, 3).
        let rgba = grid(3, 1, |x, _| {
            let v = [0u8, 30, 60][x as usize];
            [v, v, v, 255]
        });
        let image = preview(&rgba, 3, 1, &options(0.6667, "png")).unwrap();
        assert_eq!((image.width, image.height), (2, 1));
        let decoded = decode(&image.data);
        assert_eq!(decoded.get_pixel(0, 0).0, [10, 10, 10, 255]);
        assert_eq!(decoded.get_pixel(1, 0).0, [50, 50, 50, 255]);
    }

    #[test]
    fn rows_are_filtered_the_same_way() {
        let rgba = grid(1, 3, |_, y| {
            let v = [0u8, 30, 60][y as usize];
            [v, v, v, 255]
        });
        let image = preview(&rgba, 1, 3, &options(0.6667, "png")).unwrap();
        assert_eq!((image.width, image.height), (1, 2));
        let decoded = decode(&image.data);
        assert_eq!(decoded.get_pixel(0, 0).0, [10, 10, 10, 255]);
        assert_eq!(decoded.get_pixel(0, 1).0, [50, 50, 50, 255]);
    }

    #[test]
    fn averaging_is_premultiplied() {
        // A transparent red pixel next to an opaque blue one: the red must not tint the average.
        let rgba = [255, 0, 0, 0, 0, 0, 255, 255];
        let image = preview(&rgba, 2, 1, &options(0.5, "png")).unwrap();
        let p = decode(&image.data).get_pixel(0, 0).0;
        assert_eq!(p[0], 0);
        assert_eq!(p[1], 0);
        assert!(close(p[2], 255, 1), "{p:?}");
        assert!(close(p[3], 128, 1), "{p:?}");
    }

    #[test]
    fn jpeg_is_flattened_over_black() {
        let rgba = [255, 0, 0, 0, 0, 0, 255, 255];
        let image = preview(&rgba, 2, 1, &options(0.5, "jpeg")).unwrap();
        assert_eq!(image.mime, "image/jpeg");
        assert_eq!((image.width, image.height), (1, 1));
        let p = decode(&image.data).get_pixel(0, 0).0;
        // Blue at half coverage over black, with JPEG's error.
        assert!(close(p[2], 128, 6), "{p:?}");
        assert!(p[0] < 8 && p[1] < 8, "{p:?}");
    }

    #[test]
    fn jpeg_is_the_default_and_quality_changes_the_size() {
        let rgba = grid(64, 64, |x, y| {
            [(x * 4) as u8, (y * 4) as u8, ((x * y) % 256) as u8, 255]
        });
        let default = preview(&rgba, 64, 64, &PreviewOptions::default()).unwrap();
        assert_eq!(default.mime, "image/jpeg");
        assert_eq!((default.width, default.height), (64, 64));
        assert_eq!(&default.data[..2], &[0xFF, 0xD8]);
        let low = preview(
            &rgba,
            64,
            64,
            &PreviewOptions {
                quality: Some(5.0),
                ..PreviewOptions::default()
            },
        )
        .unwrap();
        assert!(low.data.len() < default.data.len());
    }

    #[test]
    fn png_has_the_png_signature() {
        let rgba = grid(4, 4, |_, _| [1, 2, 3, 255]);
        let image = preview(&rgba, 4, 4, &options(0.5, "png")).unwrap();
        assert_eq!(&image.data[..4], &[0x89, b'P', b'N', b'G']);
    }

    #[test]
    fn tiny_scales_give_one_pixel() {
        let rgba = grid(40, 30, |x, _| [if x < 20 { 0 } else { 100 }, 0, 0, 255]);
        let image = preview(&rgba, 40, 30, &options(0.001, "png")).unwrap();
        assert_eq!((image.width, image.height), (1, 1));
        assert_eq!(decode(&image.data).as_raw(), &[50, 0, 0, 255]);
    }

    #[test]
    fn bad_options_are_invalid_arg() {
        let rgba = grid(2, 2, |_, _| [0, 0, 0, 255]);
        let scale = |s: f64| PreviewOptions {
            scale: Some(s),
            ..Default::default()
        };
        let format = |f: &str| PreviewOptions {
            format: Some(f.into()),
            ..Default::default()
        };
        let quality = |q: f64| PreviewOptions {
            quality: Some(q),
            ..Default::default()
        };
        let bad = [
            scale(0.0),
            scale(-0.5),
            scale(1.5),
            scale(f64::NAN),
            format("gif"),
            format("JPEG"),
            quality(0.0),
            quality(101.0),
            quality(80.5),
            quality(f64::INFINITY),
        ];
        for options in bad {
            let e = preview(&rgba, 2, 2, &options).err().unwrap();
            assert_eq!(e.status, Code::InvalidArg, "{}", e.reason);
        }
    }

    #[test]
    fn a_wrong_sized_buffer_is_a_render_error() {
        let e = preview(&[0; 7], 2, 1, &PreviewOptions::default())
            .err()
            .unwrap();
        assert_eq!(e.status, Code::Render);
        assert!(e.reason.contains("needs 8 bytes"), "{}", e.reason);
    }
}
