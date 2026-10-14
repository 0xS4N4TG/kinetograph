//! The `feTurbulence` noise of the W3C Filter Effects spec: Perlin noise from
//! a seeded Park-Miller generator, so a scene that ports an SVG filter (papercut's
//! `torn` and `rough`) draws the same pattern for the same attributes.
//!
//! The tables are built here, once per seed, and uploaded to the GPU as a
//! storage buffer (`Tables::to_bytes`); `shaders/turbulence.wgsl` evaluates
//! the noise per pixel. The evaluation is mirrored in Rust (`Tables::noise2`,
//! `Tables::turbulence`) in `f32`, like the shader, so tests can pin the
//! tables and the maths on the CPU.
//!
//! This is the spec's reference algorithm without `stitchTiles`.

/// Lattice size and mask of the reference code (`BSize`, `BM`).
const B_SIZE: usize = 0x100;
const B_MASK: i32 = 0xff;

/// Entries of the lattice and gradient tables: the 256 of the lattice twice,
/// plus the two the reference copies past it.
pub const TABLE_LEN: usize = 2 * B_SIZE + 2;

/// Most octaves a scene may ask for. Each one doubles the frequency, so past
/// ten the detail is far below a pixel for any sensible `baseFrequency`.
pub const MAX_OCTAVES: u32 = 10;

// The Park-Miller "minimal standard" generator (`RAND_m`, `RAND_a`, `RAND_q`
// and `RAND_r` in the spec).
const RAND_M: i64 = 2_147_483_647;
const RAND_A: i64 = 16_807;
const RAND_Q: i64 = 127_773;
const RAND_R: i64 = 2_836;

/// Brings a seed into the generator's range, 1..=2^31 - 2. A number from an
/// SVG attribute is truncated toward zero before this (`seed as i64`).
pub fn setup_seed(seed: i64) -> i64 {
    let mut seed = seed;
    if seed <= 0 {
        // `%` keeps the dividend's sign, as C's does.
        seed = -(seed % (RAND_M - 1)) + 1;
    }
    seed.min(RAND_M - 1)
}

/// The next number of the sequence, by Schrage's method (no overflow in 32
/// bits, which the reference needs; the `i64` here is only for convenience).
pub fn random(seed: i64) -> i64 {
    let result = RAND_A * (seed % RAND_Q) - RAND_R * (seed / RAND_Q);
    if result <= 0 { result + RAND_M } else { result }
}

/// The lattice selector and the four channels' gradient tables for one seed.
pub struct Tables {
    lattice: [u32; TABLE_LEN],
    /// `[channel][index]`, unit vectors (zero in the one case where the
    /// reference divides by zero, a gradient that came out as (0, 0)).
    gradient: [[[f32; 2]; TABLE_LEN]; 4],
}

impl Tables {
    /// The reference's `init(seed)`.
    pub fn new(seed: i64) -> Tables {
        let mut s = setup_seed(seed);
        let mut lattice = [0u32; TABLE_LEN];
        let mut gradient = [[[0.0f32; 2]; TABLE_LEN]; 4];
        for channel in &mut gradient {
            for (i, entry) in channel.iter_mut().take(B_SIZE).enumerate() {
                lattice[i] = i as u32;
                let mut g = [0.0f64; 2];
                for component in &mut g {
                    s = random(s);
                    *component = ((s % (2 * B_SIZE as i64)) - B_SIZE as i64) as f64 / B_SIZE as f64;
                }
                let length = (g[0] * g[0] + g[1] * g[1]).sqrt();
                if length > 0.0 {
                    *entry = [(g[0] / length) as f32, (g[1] / length) as f32];
                }
            }
        }
        // Shuffle the lattice from the top down.
        for i in (1..B_SIZE).rev() {
            let k = lattice[i];
            s = random(s);
            let j = (s % B_SIZE as i64) as usize;
            lattice[i] = lattice[j];
            lattice[j] = k;
        }
        for i in 0..B_SIZE + 2 {
            lattice[B_SIZE + i] = lattice[i];
            for channel in &mut gradient {
                channel[B_SIZE + i] = channel[i];
            }
        }
        Tables { lattice, gradient }
    }

    /// What `shaders/turbulence.wgsl` reads as `Tables`: the lattice as u32s,
    /// then the four channels' gradients as pairs of f32, channel after
    /// channel.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(TABLE_LEN * 4 + 4 * TABLE_LEN * 8);
        for v in self.lattice {
            bytes.extend(v.to_le_bytes());
        }
        for channel in &self.gradient {
            for g in channel {
                bytes.extend(g[0].to_le_bytes());
                bytes.extend(g[1].to_le_bytes());
            }
        }
        bytes
    }

    /// One octave of Perlin noise in -1..1 for `channel` (0..4, R G B A) at
    /// `v` (the reference's `noise2`).
    pub fn noise2(&self, channel: usize, v: [f32; 2]) -> f32 {
        // The reference's setup is t = v + PerlinN (4096), b0 = int(t) & BM,
        // r0 = t - int(t), in double precision. 4096 is a multiple of the
        // lattice size, so for any v above -4096 that is floor(v) & BM and
        // v - floor(v), which this computes directly: adding 4096 would cost
        // an f32 twelve bits of the fraction.
        let setup = |v: f32| {
            let cell = v.floor();
            let b0 = (cell as i32) & B_MASK;
            let b1 = (b0 + 1) & B_MASK;
            let r0 = v - cell;
            (b0 as usize, b1 as usize, r0, r0 - 1.0)
        };
        let (bx0, bx1, rx0, rx1) = setup(v[0]);
        let (by0, by1, ry0, ry1) = setup(v[1]);
        let i = self.lattice[bx0] as usize;
        let j = self.lattice[bx1] as usize;
        let b00 = self.lattice[i + by0] as usize;
        let b10 = self.lattice[j + by0] as usize;
        let b01 = self.lattice[i + by1] as usize;
        let b11 = self.lattice[j + by1] as usize;
        let s_curve = |t: f32| t * t * (3.0 - 2.0 * t);
        let lerp = |t: f32, a: f32, b: f32| a + t * (b - a);
        let (sx, sy) = (s_curve(rx0), s_curve(ry0));
        let g = &self.gradient[channel];
        let dot = |g: [f32; 2], x: f32, y: f32| x * g[0] + y * g[1];
        let a = lerp(sx, dot(g[b00], rx0, ry0), dot(g[b10], rx1, ry0));
        let b = lerp(sx, dot(g[b01], rx0, ry1), dot(g[b11], rx1, ry1));
        lerp(sy, a, b)
    }

    /// The channel's value in 0..1 at `point`, summing `octaves` octaves of
    /// noise from `frequency` (per axis): `fractal` is `fractalNoise`
    /// ((sum + 1) / 2), otherwise `turbulence` (the sum of absolute values).
    ///
    /// No octaves sums nothing, so it is the formula's value for 0: a middle
    /// grey for `fractalNoise` and black for `turbulence`, as the reference
    /// code (and a browser) draws it.
    pub fn turbulence(
        &self,
        channel: usize,
        point: [f32; 2],
        frequency: [f32; 2],
        octaves: u32,
        fractal: bool,
    ) -> f32 {
        let mut sum = 0.0f32;
        let mut v = [point[0] * frequency[0], point[1] * frequency[1]];
        let mut ratio = 1.0f32;
        for _ in 0..octaves {
            let n = self.noise2(channel, v);
            sum += if fractal { n } else { n.abs() } / ratio;
            v = [v[0] * 2.0, v[1] * 2.0];
            ratio *= 2.0;
        }
        let value = if fractal { (sum + 1.0) * 0.5 } else { sum };
        value.clamp(0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Values from an independent Python transcription of the spec's C code
    /// (f64 throughout), so the f32 maths here is held to within rounding.
    fn near(got: f32, want: f64, what: &str) {
        assert!(
            (f64::from(got) - want).abs() < 2e-5,
            "{what}: {got} vs {want}"
        );
    }

    #[test]
    fn the_generator_matches_the_park_miller_check_values() {
        let mut s = 1;
        let first: Vec<i64> = (0..5)
            .map(|_| {
                s = random(s);
                s
            })
            .collect();
        assert_eq!(
            first,
            [
                16_807,
                282_475_249,
                1_622_650_073,
                984_943_658,
                1_144_108_930
            ]
        );
        // The classic check: from seed 1 the 10000th number is 1043618065.
        let mut s = 1;
        for _ in 0..10_000 {
            s = random(s);
        }
        assert_eq!(s, 1_043_618_065);
    }

    #[test]
    fn the_generator_never_leaves_its_range() {
        let mut s = setup_seed(2_147_483_646);
        for _ in 0..1000 {
            s = random(s);
            assert!((1..RAND_M).contains(&s), "{s}");
        }
    }

    #[test]
    fn setup_seed_handles_zero_negative_and_huge_seeds() {
        assert_eq!(setup_seed(7), 7);
        assert_eq!(setup_seed(1), 1);
        // Zero and negatives are folded into 1..: -(s % (m - 1)) + 1.
        assert_eq!(setup_seed(0), 1);
        assert_eq!(setup_seed(-5), 6);
        assert_eq!(setup_seed(-(RAND_M - 1)), 1);
        assert_eq!(setup_seed(-(RAND_M - 1) - 3), 4);
        // Past the range it is held at m - 1.
        assert_eq!(setup_seed(RAND_M - 1), RAND_M - 1);
        assert_eq!(setup_seed(RAND_M), RAND_M - 1);
        assert_eq!(setup_seed(i64::MAX), RAND_M - 1);
        // The extremes of the input cannot overflow.
        assert!((1..RAND_M).contains(&setup_seed(i64::MIN)));
    }

    #[test]
    fn seeds_that_setup_maps_together_share_tables() {
        assert_eq!(Tables::new(0).to_bytes(), Tables::new(1).to_bytes());
        assert_eq!(
            Tables::new(RAND_M).to_bytes(),
            Tables::new(RAND_M + 99).to_bytes()
        );
        assert_ne!(Tables::new(7).to_bytes(), Tables::new(11).to_bytes());
    }

    #[test]
    fn the_lattice_is_a_permutation_repeated_past_its_end() {
        for seed in [7, 11, 0, -5, 123_456_789] {
            let t = Tables::new(seed);
            let mut seen = [false; B_SIZE];
            for &v in &t.lattice[..B_SIZE] {
                assert!(!seen[v as usize], "seed {seed}: {v} twice");
                seen[v as usize] = true;
            }
            assert!(seen.iter().all(|&s| s), "seed {seed}");
            for i in 0..B_SIZE + 2 {
                assert_eq!(
                    t.lattice[B_SIZE + i],
                    t.lattice[i],
                    "seed {seed}, index {i}"
                );
                for k in 0..4 {
                    assert_eq!(t.gradient[k][B_SIZE + i], t.gradient[k][i]);
                }
            }
        }
    }

    #[test]
    fn the_lattice_and_gradients_are_pinned() {
        let t = Tables::new(7);
        assert_eq!(t.lattice[..8], [250, 41, 203, 214, 171, 141, 30, 240]);
        assert_eq!(t.lattice[255], 97);
        assert_eq!(t.lattice[512..514], [250, 41]);
        near(t.gradient[0][0][0], 0.8099421215430211, "grad 0,0 x");
        near(t.gradient[0][0][1], -0.5865098121518428, "grad 0,0 y");
        near(t.gradient[3][255][0], -0.9220633683509137, "grad 3,255 x");
        near(t.gradient[3][255][1], 0.3870389447398897, "grad 3,255 y");

        let t = Tables::new(11);
        assert_eq!(t.lattice[..8], [147, 46, 223, 84, 51, 191, 174, 43]);
        assert_eq!(t.lattice[255], 87);
        near(t.gradient[0][0][0], -0.789553665046511, "seed 11 grad x");

        // Seed 0 is seed 1 after setup_seed; -5 is 6.
        assert_eq!(Tables::new(0).lattice[..4], [190, 142, 200, 122]);
        assert_eq!(Tables::new(-5).lattice[..4], [190, 46, 64, 22]);
    }

    #[test]
    fn gradients_have_unit_length() {
        for seed in [7, 11, 0, -5, 2_147_483_647, 4242] {
            let t = Tables::new(seed);
            for (k, channel) in t.gradient.iter().enumerate() {
                for (i, g) in channel.iter().enumerate() {
                    let length = (g[0] * g[0] + g[1] * g[1]).sqrt();
                    assert!(
                        (length - 1.0).abs() < 1e-6,
                        "seed {seed}, {k}/{i}: {length}"
                    );
                }
            }
        }
    }

    #[test]
    fn tables_are_deterministic() {
        assert_eq!(Tables::new(7).to_bytes(), Tables::new(7).to_bytes());
        let a = Tables::new(7);
        let b = Tables::new(7);
        let p = [13.7, -42.25];
        assert_eq!(
            a.turbulence(1, p, [0.04, 0.04], 4, true),
            b.turbulence(1, p, [0.04, 0.04], 4, true)
        );
    }

    #[test]
    fn the_byte_layout_is_the_lattice_then_each_channels_gradients() {
        let t = Tables::new(7);
        let bytes = t.to_bytes();
        assert_eq!(bytes.len(), TABLE_LEN * 4 + 4 * TABLE_LEN * 8);
        let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        assert_eq!(word(0), 250);
        assert_eq!(word(4), 41);
        let gradients = TABLE_LEN * 4;
        // Channel 3's entry 255: the last channel, 255 entries in.
        let at = gradients + (3 * TABLE_LEN + 255) * 8;
        assert_eq!(f32::from_bits(word(at)), t.gradient[3][255][0]);
        assert_eq!(f32::from_bits(word(at + 4)), t.gradient[3][255][1]);
    }

    #[test]
    fn noise_matches_the_reference_implementation() {
        let t = Tables::new(7);
        for (ch, want) in [
            (0, -0.29021668673041423),
            (1, -0.16551689615621862),
            (2, 0.20870705805166417),
            (3, -0.16301160965538686),
        ] {
            near(t.noise2(ch, [12.3, 45.6]), want, "seed 7 noise2");
        }
        near(t.noise2(0, [12.3, 45.6]), -0.29021668673041423, "seed 7");
        let t = Tables::new(11);
        near(t.noise2(1, [12.3, 45.6]), 0.07689596442053637, "seed 11");
        near(
            t.turbulence(0, [10.5, 20.25], [0.04, 0.04], 4, true),
            0.6930731947080324,
            "seed 11 fractalNoise",
        );
        let t = Tables::new(7);
        near(
            t.turbulence(0, [10.5, 20.25], [0.04, 0.04], 4, true),
            0.40363833395189375,
            "seed 7 fractalNoise",
        );
        // Different frequencies per axis, and the absolute-value sum.
        near(
            t.turbulence(2, [10.5, 20.25], [0.04, 0.08], 3, false),
            0.4859881390558106,
            "seed 7 turbulence",
        );
        let t = Tables::new(-5);
        near(
            t.turbulence(0, [10.5, 20.25], [0.04, 0.04], 4, true),
            0.3421720422092241,
            "seed -5",
        );
    }

    #[test]
    fn noise_is_zero_on_the_lattice_and_continuous_across_it() {
        let t = Tables::new(7);
        for (x, y) in [(0.0, 0.0), (3.0, 5.0), (-7.0, 2.0), (100.0, -100.0)] {
            for ch in 0..4 {
                assert!(t.noise2(ch, [x, y]).abs() < 1e-6, "{ch} at {x},{y}");
            }
        }
        // Either side of a lattice line the value barely changes.
        let below = t.noise2(0, [4.9999, 2.3]);
        let above = t.noise2(0, [5.0001, 2.3]);
        assert!((below - above).abs() < 1e-3, "{below} vs {above}");
    }

    #[test]
    fn noise_repeats_every_256_cells_and_handles_negative_coordinates() {
        let t = Tables::new(11);
        let a = t.noise2(0, [3.25, 9.5]);
        let b = t.noise2(0, [3.25 + 256.0, 9.5 + 512.0]);
        assert!((a - b).abs() < 1e-3, "{a} vs {b}");
        // Negative coordinates wrap like positive ones and give finite values
        // in range.
        for v in [-0.5, -17.3, -4000.0, -5000.5] {
            let n = t.noise2(2, [v, v]);
            assert!(n.is_finite() && n.abs() <= 1.0, "{v}: {n}");
        }
    }

    #[test]
    fn channel_values_stay_in_zero_to_one() {
        let t = Tables::new(7);
        let mut fractal_sum = 0.0;
        let mut turbulence_sum = 0.0;
        let n = 64 * 64;
        for i in 0..n {
            let p = [(i % 64) as f32 * 3.7, (i / 64) as f32 * 3.7];
            for ch in 0..4 {
                for octaves in [1, 4, 10] {
                    for fractal in [true, false] {
                        let v = t.turbulence(ch, p, [0.04, 0.04], octaves, fractal);
                        assert!((0.0..=1.0).contains(&v), "{v}");
                    }
                }
            }
            fractal_sum += t.turbulence(0, p, [0.04, 0.04], 4, true);
            turbulence_sum += t.turbulence(0, p, [0.04, 0.04], 4, false);
        }
        // fractalNoise is centred on the middle grey; turbulence is not
        // (|n| is positive) but stays well under 1 at four octaves.
        let fractal_mean = fractal_sum / n as f32;
        assert!((fractal_mean - 0.5).abs() < 0.05, "{fractal_mean}");
        let turbulence_mean = turbulence_sum / n as f32;
        assert!((0.1..0.6).contains(&turbulence_mean), "{turbulence_mean}");
    }

    #[test]
    fn more_octaves_add_detail_and_none_is_the_formulas_zero() {
        let t = Tables::new(7);
        let p = [57.5, 31.5];
        let one = t.turbulence(0, p, [0.04, 0.04], 1, true);
        let four = t.turbulence(0, p, [0.04, 0.04], 4, true);
        assert_ne!(one, four);
        // No octaves: a sum of 0, a middle grey for fractalNoise in every
        // channel (alpha too) and black for turbulence.
        for ch in 0..4 {
            assert_eq!(t.turbulence(ch, p, [0.04, 0.04], 0, true), 0.5);
            assert_eq!(t.turbulence(ch, p, [0.04, 0.04], 0, false), 0.0);
        }
        // Zero frequency samples one point: noise 0 there, so fractalNoise is
        // a middle grey and turbulence is black.
        assert_eq!(t.turbulence(0, p, [0.0, 0.0], 4, true), 0.5);
        assert_eq!(t.turbulence(0, p, [0.0, 0.0], 4, false), 0.0);
    }

    #[test]
    fn the_wgsl_uses_the_same_constants() {
        let wgsl = include_str!("shaders/turbulence.wgsl");
        for want in [
            format!("& vec2<i32>({B_MASK})"),
            format!("array<u32, {TABLE_LEN}>"),
            format!("array<vec2<f32>, {}>", 4 * TABLE_LEN),
            format!("{TABLE_LEN}u"),
        ] {
            assert!(wgsl.contains(&want), "turbulence.wgsl lacks {want}");
        }
    }
}
