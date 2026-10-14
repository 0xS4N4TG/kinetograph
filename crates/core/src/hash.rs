//! The integer hash behind seeded noise, mirrored from `shaders/hash.wgsl`.
//!
//! The GPU does all the noise work; this copy exists so tests can pin the
//! hash's values and check noise maths on the CPU. A change to one side
//! without the other fails `wgsl_uses_the_same_constants` or the value tests.

const MUL: u32 = 747_796_405;
const ADD: u32 = 2_891_336_453;
const OUT_MUL: u32 = 277_803_737;

/// PCG hash of one u32.
pub fn hash(v: u32) -> u32 {
    let s = v.wrapping_mul(MUL).wrapping_add(ADD);
    let w = ((s >> ((s >> 28) + 4)) ^ s).wrapping_mul(OUT_MUL);
    (w >> 22) ^ w
}

/// One hash per (seed, pixel, frame).
pub fn cell_hash(seed: u32, x: u32, y: u32, frame: u32) -> u32 {
    hash(seed ^ hash(x ^ hash(y ^ hash(frame))))
}

/// A hash as a float in [0, 1): the top 24 bits.
pub fn unit_float(h: u32) -> f32 {
    (h >> 8) as f32 * (1.0 / 16_777_216.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `triangular` in shaders/grain.wgsl: two hashes summed, less 1.
    fn triangular(a: u32, b: u32) -> f32 {
        unit_float(a) + unit_float(b) - 1.0
    }

    /// `lattice` in shaders/grain.wgsl for one channel (`channel` 0 is the
    /// monochrome value too).
    fn lattice(seed: u32, frame: u32, ix: i32, iy: i32, channel: usize) -> f32 {
        let mut h = cell_hash(seed, ix as u32, iy as u32, frame);
        let mut r = Vec::new();
        for _ in 0..2 * channel + 2 {
            h = hash(h);
            r.push(h);
        }
        triangular(r[2 * channel], r[2 * channel + 1])
    }

    /// `grain_at` in shaders/grain.wgsl, channel 0.
    fn grain_at(seed: u32, frame: u32, x: i32, y: i32, size: f32) -> f32 {
        if size <= 1.0 {
            return lattice(seed, frame, x, y, 0);
        }
        let (px, py) = (x as f32 / size, y as f32 / size);
        let (ix, iy) = (px.floor(), py.floor());
        let (fx, fy) = (px - ix, py - iy);
        let smooth = |t: f32| t * t * (3.0 - 2.0 * t);
        let (wx, wy) = (smooth(fx), smooth(fy));
        let (ix, iy) = (ix as i32, iy as i32);
        let l = |dx, dy| lattice(seed, frame, ix + dx, iy + dy, 0);
        let top = l(0, 0) + (l(1, 0) - l(0, 0)) * wx;
        let bottom = l(0, 1) + (l(1, 1) - l(0, 1)) * wx;
        top + (bottom - top) * wy
    }

    fn mean_and_std(values: impl Iterator<Item = f32>) -> (f64, f64) {
        let values: Vec<f64> = values.map(f64::from).collect();
        let n = values.len() as f64;
        let mean = values.iter().sum::<f64>() / n;
        let var = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n;
        (mean, var.sqrt())
    }

    #[test]
    fn hash_values_are_pinned() {
        // From an independent implementation of the recipe. If these change,
        // every existing grain and dither pattern changes with them.
        for (input, want) in [
            (0, 0x07BB_2FE2),
            (1, 0xA8BE_EA3C),
            (2, 0x7A7E_CC88),
            (12345, 0xF45E_AD0E),
            (u32::MAX, 0xE62A_4902),
        ] {
            assert_eq!(hash(input), want, "hash({input})");
        }
    }

    #[test]
    fn cell_hash_nests_in_the_documented_order() {
        assert_eq!(cell_hash(0, 0, 0, 0), 2_368_882_721);
        assert_eq!(cell_hash(7, 3, 5, 0), 2_469_145_599);
        // Only the frame differs: an animated pattern changes every frame.
        assert_eq!(cell_hash(7, 3, 5, 1), 3_493_858_141);
        assert_eq!(cell_hash(1, u32::MAX, 2, 9), 4_058_080_902);
        assert_eq!(cell_hash(7, 3, 5, 1), hash(7 ^ hash(3 ^ hash(5 ^ hash(1)))));
    }

    #[test]
    fn unit_floats_are_in_zero_to_one() {
        assert_eq!(unit_float(0), 0.0);
        assert_eq!(unit_float(u32::MAX), 16_777_215.0 / 16_777_216.0);
        assert!(unit_float(u32::MAX) < 1.0);
        // The mean over many pixels of one frame is near a half.
        let mean = (0..4096)
            .map(|i| f64::from(unit_float(cell_hash(3, i % 64, i / 64, 0))))
            .sum::<f64>()
            / 4096.0;
        assert!((mean - 0.5).abs() < 0.02, "{mean}");
    }

    #[test]
    fn wgsl_uses_the_same_constants() {
        let wgsl = include_str!("shaders/hash.wgsl");
        for want in [
            format!("{MUL}u"),
            format!("{ADD}u"),
            format!("{OUT_MUL}u"),
            "(s >> 28u) + 4u".to_string(),
            "(w >> 22u) ^ w".to_string(),
            "hash(seed ^ hash(x ^ hash(y ^ hash(frame))))".to_string(),
            "f32(h >> 8u) * (1.0 / 16777216.0)".to_string(),
        ] {
            assert!(wgsl.contains(&want), "hash.wgsl lacks {want}");
        }
    }

    #[test]
    fn grain_is_triangular_with_zero_mean() {
        let (mean, std) = mean_and_std((0..64 * 64).map(|i| grain_at(7, 0, i % 64, i / 64, 1.0)));
        // A triangular distribution on [-1, 1] has standard deviation
        // 1/sqrt(6), about 0.408.
        assert!(mean.abs() < 0.02, "{mean}");
        assert!((std - 0.408).abs() < 0.02, "{std}");
        let all = (0..64 * 64).map(|i| grain_at(7, 0, i % 64, i / 64, 1.0));
        assert!(all.into_iter().all(|v| (-1.0..=1.0).contains(&v)));
        let wgsl = include_str!("shaders/grain.wgsl");
        assert!(wgsl.contains("unit_float(a) + unit_float(b) - 1.0"));
    }

    #[test]
    fn grain_depends_on_seed_pixel_and_frame_only() {
        let at = |seed, frame, x, y| grain_at(seed, frame, x, y, 1.0);
        assert_eq!(at(3, 5, 10, 20), at(3, 5, 10, 20));
        assert_ne!(at(3, 5, 10, 20), at(4, 5, 10, 20));
        assert_ne!(at(3, 5, 10, 20), at(3, 6, 10, 20));
        assert_ne!(at(3, 5, 10, 20), at(3, 5, 11, 20));
        assert_ne!(at(3, 5, 10, 20), at(3, 5, 10, 21));
        // The three colour channels are different noise.
        assert_ne!(lattice(3, 5, 10, 20, 0), lattice(3, 5, 10, 20, 1));
        assert_ne!(lattice(3, 5, 10, 20, 1), lattice(3, 5, 10, 20, 2));
    }

    #[test]
    fn bigger_grain_is_smoother_and_hits_the_lattice() {
        // Between neighbouring pixels the noise changes much less when the
        // grain cell is 8 pixels than when it is 1.
        let step = |size: f32| {
            let diffs = (0..2000).map(|i| {
                let (x, y) = (i % 50, i / 50);
                (grain_at(1, 0, x + 1, y, size) - grain_at(1, 0, x, y, size)).abs()
            });
            mean_and_std(diffs).0
        };
        assert!(step(8.0) < step(1.0) / 3.0, "{} {}", step(8.0), step(1.0));
        // At a multiple of the size the value is exactly the lattice point,
        // and a size just over 1 is nearly per-pixel noise.
        assert_eq!(grain_at(1, 0, 16, 24, 8.0), lattice(1, 0, 2, 3, 0));
        let close = (0..100)
            .map(|x| (grain_at(1, 0, x, 3, 1.001) - grain_at(1, 0, x, 3, 1.0)).abs())
            .fold(0.0, f32::max);
        assert!(close < 0.05, "{close}");
        // Smooth noise is fainter than raw noise.
        let (_, raw) = mean_and_std((0..64 * 64).map(|i| grain_at(2, 0, i % 64, i / 64, 1.0)));
        let (_, soft) = mean_and_std((0..64 * 64).map(|i| grain_at(2, 0, i % 64, i / 64, 8.0)));
        assert!(soft < raw);
    }
}
