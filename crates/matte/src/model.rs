//! The two models and what each takes in and gives out, as their Hugging Face repositories' preprocessor configs say
//! (`preprocessor_config.json` of `Xenova/modnet` and `onnx-community/BEN2-ONNX`):
//!
//! - `modnet`: the shortest side resized to 512, the other in proportion and rounded down to a multiple of 32
//!   (`size_divisibility`), bilinear, RGB scaled to 0..1 then `(v - 0.5) / 0.5`. One output, the matte `1 x 1 x H x W`
//!   in 0..1 at the input's size.
//! - `ben2-base`: the whole frame resized to 1024 x 1024 (not padded, so the aspect changes and comes back with the
//!   matte), bilinear, RGB scaled to 0..1 then the ImageNet mean and standard deviation. One output, the matte
//!   `1 x 1 x 1024 x 1024`.
//!
//! The matte is resized back to the source's size with the same bilinear filter.

use crate::resize::{resize_plane, resize_rgba_planes};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Model {
    Modnet,
    Ben2Base,
}

impl Model {
    pub fn parse(id: &str) -> Result<Model, String> {
        match id {
            "modnet" => Ok(Model::Modnet),
            "ben2-base" => Ok(Model::Ben2Base),
            _ => Err(format!("unknown model {id:?}: use modnet or ben2-base")),
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Model::Modnet => "modnet",
            Model::Ben2Base => "ben2-base",
        }
    }

    /// Whether the model runs on a GPU or neural-engine back end when the build has one. MODNet does not: CoreML gave
    /// it no gain (`infer`), and on the CPU it runs at video speed. BEN2 does: its CPU time is 8 to 9 s a frame.
    pub fn uses_gpu(self) -> bool {
        self == Model::Ben2Base
    }

    /// The model's input name and the one output it reads.
    pub fn io(self) -> (&'static str, &'static str) {
        match self {
            Model::Modnet => ("input", "output"),
            Model::Ben2Base => ("pixel_values", "alphas"),
        }
    }

    /// The size a `width` x `height` frame is resized to for the model: width, height.
    pub fn input_size(self, width: u32, height: u32) -> (u32, u32) {
        match self {
            Model::Ben2Base => (1024, 1024),
            Model::Modnet => {
                let (w, h) = (f64::from(width.max(1)), f64::from(height.max(1)));
                let (iw, ih) = if w <= h {
                    (512.0, h * 512.0 / w)
                } else {
                    (w * 512.0 / h, 512.0)
                };
                let floor32 = |v: f64| ((v / 32.0).floor() as u32).max(1) * 32;
                (floor32(iw), floor32(ih))
            }
        }
    }

    /// Per channel (R, G, B): the mean and standard deviation the 0..1 colour is normalised with.
    pub fn normalisation(self) -> ([f32; 3], [f32; 3]) {
        match self {
            Model::Modnet => ([0.5; 3], [0.5; 3]),
            Model::Ben2Base => ([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        }
    }

    /// A tightly packed RGBA8 frame as the model's input: `1 x 3 x ih x iw` floats, channels one after another.
    pub fn preprocess(self, rgba: &[u8], width: u32, height: u32) -> Vec<f32> {
        let (iw, ih) = self.input_size(width, height);
        let (mean, std) = self.normalisation();
        let mut planes = resize_rgba_planes(
            rgba,
            width as usize,
            height as usize,
            iw as usize,
            ih as usize,
        );
        let n = iw as usize * ih as usize;
        for (c, plane) in planes.chunks_exact_mut(n).enumerate() {
            for v in plane {
                *v = (*v / 255.0 - mean[c]) / std[c];
            }
        }
        planes
    }
}

/// The model's matte (`iw` x `ih`, 0..1) as 8-bit alpha at the frame's size (`width` x `height`).
pub fn alpha_from_matte(matte: &[f32], iw: u32, ih: u32, width: u32, height: u32) -> Vec<u8> {
    let full = if (iw, ih) == (width, height) {
        matte.to_vec()
    } else {
        resize_plane(
            matte,
            iw as usize,
            ih as usize,
            width as usize,
            height as usize,
        )
    };
    full.into_iter()
        .map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)
        .collect()
}

/// `rgba` with its alpha channel replaced by `alpha`: the subject, straight (not premultiplied) as the alpha encoders
/// take it.
pub fn with_alpha(rgba: &[u8], alpha: &[u8]) -> Vec<u8> {
    let mut out = rgba.to_vec();
    for (px, a) in out.chunks_exact_mut(4).zip(alpha) {
        px[3] = *a;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modnet_sizes_follow_the_shortest_side() {
        assert_eq!(Model::Modnet.input_size(1920, 1080), (896, 512));
        assert_eq!(Model::Modnet.input_size(1080, 1920), (512, 896));
        assert_eq!(Model::Modnet.input_size(1000, 1000), (512, 512));
        // 640x480: 683 wide at 512 high, down to 672.
        assert_eq!(Model::Modnet.input_size(640, 480), (672, 512));
        // Whole blocks of 32, the shortest side 512.
        for (w, h) in [(1920, 1080), (333, 777), (1280, 720), (50, 300), (7, 7)] {
            let (iw, ih) = Model::Modnet.input_size(w, h);
            assert!(iw % 32 == 0 && ih % 32 == 0, "{w}x{h}: {iw}x{ih}");
            assert_eq!(iw.min(ih), 512, "{w}x{h}");
        }
    }

    #[test]
    fn ben2_squashes_every_frame_to_1024_square() {
        assert_eq!(Model::Ben2Base.input_size(1920, 1080), (1024, 1024));
        assert_eq!(Model::Ben2Base.input_size(10, 10), (1024, 1024));
    }

    #[test]
    fn only_ben2_goes_to_the_gpu() {
        // MODNet gains nothing from CoreML: see `infer`.
        assert!(!Model::Modnet.uses_gpu());
        assert!(Model::Ben2Base.uses_gpu());
    }

    #[test]
    fn model_ids_round_trip() {
        for m in [Model::Modnet, Model::Ben2Base] {
            assert_eq!(Model::parse(m.id()), Ok(m));
        }
        assert!(Model::parse("rvm").is_err());
    }

    #[test]
    fn modnet_input_is_zero_centred() {
        // A white frame is +1, a black one -1, mid grey (127.5) 0.
        let white = vec![255u8; 64 * 64 * 4];
        let out = Model::Modnet.preprocess(&white, 64, 64);
        let (iw, ih) = Model::Modnet.input_size(64, 64);
        assert_eq!(out.len(), 3 * (iw * ih) as usize);
        assert!(out.iter().all(|v| (v - 1.0).abs() < 1e-4));
        let black: Vec<u8> = [0, 0, 0, 255].repeat(64 * 64);
        assert!(
            Model::Modnet
                .preprocess(&black, 64, 64)
                .iter()
                .all(|v| (v + 1.0).abs() < 1e-4)
        );
    }

    #[test]
    fn ben2_input_uses_the_imagenet_statistics_per_channel() {
        // Pure red: channel 0 is (1 - 0.485) / 0.229, the others (0 - mean) / std.
        let red: Vec<u8> = [255, 0, 0, 255].repeat(32 * 32);
        let out = Model::Ben2Base.preprocess(&red, 32, 32);
        let n = 1024 * 1024;
        assert_eq!(out.len(), 3 * n);
        let near = |a: f32, b: f32| (a - b).abs() < 1e-3;
        assert!(near(out[0], (1.0 - 0.485) / 0.229));
        assert!(near(out[n], -0.456 / 0.224));
        assert!(near(out[2 * n + n - 1], -0.406 / 0.225));
    }

    #[test]
    fn the_alpha_is_clamped_scaled_and_brought_back_to_the_frame_size() {
        let matte = [-0.2, 0.0, 0.5, 1.4];
        // Same size: no resampling.
        assert_eq!(alpha_from_matte(&matte, 2, 2, 2, 2), vec![0, 0, 128, 255]);
        // Flat matte, any size.
        let flat = alpha_from_matte(&[1.0; 16], 4, 4, 10, 6);
        assert_eq!(flat.len(), 60);
        assert!(flat.iter().all(|a| *a == 255));
        // A hard vertical edge stays between its two sides, soft in the middle only.
        let edge: Vec<f32> = (0..8)
            .flat_map(|_| [0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0])
            .collect();
        let up = alpha_from_matte(&edge, 8, 8, 16, 16);
        let row = &up[..16];
        assert_eq!((row[0], row[15]), (0, 255));
        assert!(row.windows(2).all(|w| w[0] <= w[1]), "{row:?}");
    }

    #[test]
    fn the_subject_keeps_its_colour_and_takes_the_alpha() {
        let out = with_alpha(&[10, 20, 30, 255, 40, 50, 60, 255], &[0, 128]);
        assert_eq!(out, vec![10, 20, 30, 0, 40, 50, 60, 128]);
    }
}
