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
}
