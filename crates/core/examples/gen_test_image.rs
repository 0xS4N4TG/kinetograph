//! Regenerates `examples/gradient.png`, the test image used by
//! `examples/basic.json`: a 64x64 colour gradient with fixed-seed speckle and
//! a soft circular alpha edge. Everything is computed, so no third-party
//! pixels are involved.
//!
//! Run from the repository root:
//!   cargo run -p kinetograph-core --example gen_test_image

fn main() {
    let size = 64u32;
    let mut state: u32 = 1234;
    let mut noise = || {
        // 32-bit LCG; the seed is fixed so the output never changes.
        state = state.wrapping_mul(1664525).wrapping_add(1013904223);
        ((state >> 16) % 41) as i32 - 20
    };
    let mut img = image::RgbaImage::new(size, size);
    let last = (size - 1) as f32;
    for y in 0..size {
        for x in 0..size {
            let n = noise();
            let channel = |v: f32| (v as i32 + n).clamp(0, 255) as u8;
            let d = ((x as f32 - last / 2.0).powi(2) + (y as f32 - last / 2.0).powi(2)).sqrt();
            let alpha = (255.0 * (1.0 - (d - 28.0) / 4.0)).clamp(0.0, 255.0) as u8;
            img.put_pixel(
                x,
                y,
                image::Rgba([
                    channel(255.0 * x as f32 / last),
                    channel(255.0 * y as f32 / last),
                    channel(255.0 * (1.0 - x as f32 / last)),
                    alpha,
                ]),
            );
        }
    }
    img.save("examples/gradient.png").unwrap();
}
