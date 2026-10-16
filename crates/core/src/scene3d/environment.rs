//! Environment maps: the picture of the surroundings that lights a scene
//! (`Environment3d`), read from an equirectangular image file.
//!
//! A Radiance `.hdr` is read as linear light as it is; any other image
//! (`.png`, `.jpg`) is sRGB and is decoded to linear light, so it cannot hold
//! a light brighter than white. The texels are kept as 16-bit floats, which is
//! what the compositor uploads; it makes the maps the lighting is read from
//! (`compositor/environment.rs`) once per environment and keeps them.

use std::path::Path;

use half::f16;
use image::DynamicImage;

use super::mesh::next_id;
use crate::error::{Error, Result};

#[derive(Debug)]
pub struct Environment {
    /// What the compositor keys its GPU maps by (`MeshData::id`).
    pub id: u64,
    pub width: u32,
    pub height: u32,
    /// RGBA, 16-bit floats, little-endian, linear light, rows from the top.
    pub texels: Vec<u8>,
}

impl Environment {
    pub fn open(base_dir: &Path, src: &str) -> Result<Environment> {
        let path = base_dir.join(src);
        let image = image::open(&path).map_err(|e| {
            Error::Render(format!("cannot read environment {}: {e}", path.display()))
        })?;
        if image.width() < 2 || image.height() < 2 {
            return Err(Error::Render(format!(
                "environment {}: the picture must be at least 2 x 2",
                path.display()
            )));
        }
        Ok(Environment::new(&image))
    }

    pub fn new(image: &DynamicImage) -> Environment {
        // Float pictures (`.hdr`) are linear light already.
        let linear = matches!(
            image,
            DynamicImage::ImageRgb32F(_) | DynamicImage::ImageRgba32F(_)
        );
        let rgb = image.to_rgb32f();
        let mut texels = Vec::with_capacity(rgb.len() / 3 * 8);
        for p in rgb.pixels() {
            for c in p.0 {
                let c = if linear { c } else { srgb_to_linear(c) };
                // A finite half is the most a texel can hold.
                let half = f16::from_f32(c.clamp(0.0, f16::MAX.to_f32()));
                texels.extend(half.to_le_bytes());
            }
            texels.extend(f16::ONE.to_le_bytes());
        }
        Environment {
            id: next_id(),
            width: image.width(),
            height: image.height(),
            texels,
        }
    }
}

fn srgb_to_linear(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

#[cfg(test)]
mod tests {
    use image::{ImageBuffer, Rgb, Rgb32FImage, RgbImage};

    use super::*;

    fn texel(e: &Environment, x: u32, y: u32) -> [f32; 4] {
        let at = ((y * e.width + x) * 8) as usize;
        std::array::from_fn(|c| {
            f16::from_le_bytes([e.texels[at + 2 * c], e.texels[at + 2 * c + 1]]).to_f32()
        })
    }

    #[test]
    fn float_pictures_are_linear_light_and_may_exceed_one() {
        let hdr: Rgb32FImage = ImageBuffer::from_pixel(2, 2, Rgb([0.25, 8.0, 0.0]));
        let e = Environment::new(&DynamicImage::ImageRgb32F(hdr));
        assert_eq!((e.width, e.height, e.texels.len()), (2, 2, 32));
        assert_eq!(texel(&e, 1, 1), [0.25, 8.0, 0.0, 1.0]);
    }

    #[test]
    fn other_pictures_are_srgb_and_become_linear() {
        let ldr: RgbImage = ImageBuffer::from_pixel(2, 2, Rgb([255, 128, 0]));
        let e = Environment::new(&DynamicImage::ImageRgb8(ldr));
        let [r, g, b, a] = texel(&e, 0, 1);
        // sRGB 128 is 0.2158605 in linear light.
        assert_eq!((r, b, a), (1.0, 0.0, 1.0));
        assert!((g - 0.215_860_5).abs() < 1e-3, "{g}");
    }

    #[test]
    fn a_light_brighter_than_a_half_can_hold_is_held_at_the_most() {
        let hdr: Rgb32FImage = ImageBuffer::from_pixel(2, 2, Rgb([1e9, 1.0, 1.0]));
        let e = Environment::new(&DynamicImage::ImageRgb32F(hdr));
        assert_eq!(texel(&e, 0, 0)[0], 65504.0);
    }

    #[test]
    fn a_missing_file_is_an_error_naming_it() {
        let err = Environment::open(Path::new("/nonexistent"), "sky.hdr")
            .err()
            .unwrap();
        assert!(err.to_string().contains("sky.hdr"), "{err}");
    }
}
