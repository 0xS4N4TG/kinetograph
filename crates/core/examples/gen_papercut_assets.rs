//! Regenerates the two images used by `examples/papercut-card.json`:
//!
//! - `examples/card-art.png`: a 720x540 layered-hills landscape
//! - `examples/grain.png`: a 540x960 paper grain, mostly near-white, for a
//!   multiply layer
//!
//! Everything is computed from fixed seeds, so no third-party pixels are
//! involved. The committed PNGs are the reference: a different libm could
//! differ from them by a pixel or two when this is re-run.
//!
//! Run from the repository root:
//!   cargo run -p kinetograph-core --example gen_papercut_assets

use image::{GrayImage, Luma, Rgb, RgbImage};

/// 32-bit LCG; the seed is fixed so the output never changes.
struct Lcg(u32);

impl Lcg {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        self.0 >> 8
    }

    /// Uniform in 0..1.
    fn unit(&mut self) -> f64 {
        f64::from(self.next() & 0xffff) / 65536.0
    }

    /// Uniform in -amount..=amount.
    fn jitter(&mut self, amount: i32) -> i32 {
        (self.next() % (2 * amount as u32 + 1)) as i32 - amount
    }
}

fn mix(a: [f64; 3], b: [f64; 3], t: f64) -> [f64; 3] {
    [0, 1, 2].map(|i| a[i] + (b[i] - a[i]) * t)
}

fn card_art() {
    let (width, height) = (720u32, 540u32);
    let mut rng = Lcg(2024);
    let sky_top = [250.0, 214.0, 168.0];
    let sky_bottom = [253.0, 240.0, 214.0];
    // Back to front: ridge colour, base height, wave amplitudes.
    let hills = [
        ([226.0, 150.0, 110.0], 0.52, 0.06),
        ([191.0, 117.0, 92.0], 0.62, 0.07),
        ([122.0, 98.0, 98.0], 0.73, 0.06),
        ([62.0, 58.0, 74.0], 0.85, 0.05),
    ]
    .map(|(color, base, amp)| {
        let waves = [0, 1, 2].map(|k| {
            (
                (1.0 + f64::from(k) * 1.7) * (0.8 + rng.unit() * 0.6),
                rng.unit() * std::f64::consts::TAU,
                1.0 / (1.0 + f64::from(k) * 1.4),
            )
        });
        (color, base, amp, waves)
    });
    let (sun_x, sun_y, sun_r) = (0.68 * f64::from(width), 0.34 * f64::from(height), 70.0);

    let mut img = RgbImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let (fx, fy) = (
                f64::from(x) / f64::from(width),
                f64::from(y) / f64::from(height),
            );
            let mut color = mix(sky_top, sky_bottom, fy.powf(0.8));
            let d = ((f64::from(x) - sun_x).powi(2) + (f64::from(y) - sun_y).powi(2)).sqrt();
            if d < sun_r {
                color = [255.0, 244.0, 224.0];
            } else if d < sun_r + 40.0 {
                color = mix(
                    color,
                    [255.0, 232.0, 190.0],
                    0.5 * (1.0 - (d - sun_r) / 40.0),
                );
            }
            for (ridge, base, amp, waves) in &hills {
                let wave: f64 = waves
                    .iter()
                    .map(|(freq, phase, weight)| {
                        weight * (fx * freq * std::f64::consts::TAU + phase).sin()
                    })
                    .sum();
                if fy > base + amp * wave {
                    color = *ridge;
                }
            }
            let n = rng.jitter(5);
            img.put_pixel(x, y, Rgb(color.map(|v| (v as i32 + n).clamp(0, 255) as u8)));
        }
    }
    img.save("examples/card-art.png").unwrap();
}

fn grain() {
    let (width, height) = (540u32, 960u32);
    let mut rng = Lcg(77);
    // Low-frequency blotches: a coarse grid, interpolated.
    let (gw, gh) = (28usize, 49usize);
    let coarse: Vec<f64> = (0..gw * gh).map(|_| rng.unit() * 2.0 - 1.0).collect();
    let blotch = |x: f64, y: f64| {
        let (gx, gy) = (
            x / f64::from(width) * (gw - 1) as f64,
            y / f64::from(height) * (gh - 1) as f64,
        );
        let (x0, y0) = (gx.floor() as usize, gy.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(gw - 1), (y0 + 1).min(gh - 1));
        let (tx, ty) = (gx - x0 as f64, gy - y0 as f64);
        let at = |x: usize, y: usize| coarse[y * gw + x];
        let top = at(x0, y0) * (1.0 - tx) + at(x1, y0) * tx;
        let bottom = at(x0, y1) * (1.0 - tx) + at(x1, y1) * tx;
        top * (1.0 - ty) + bottom * ty
    };

    let mut img = GrayImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let value = 243.0 + 5.0 * blotch(f64::from(x), f64::from(y)) + f64::from(rng.jitter(9));
            img.put_pixel(x, y, Luma([value.round().clamp(0.0, 255.0) as u8]));
        }
    }
    img.save("examples/grain.png").unwrap();
}

fn main() {
    card_art();
    grain();
}
