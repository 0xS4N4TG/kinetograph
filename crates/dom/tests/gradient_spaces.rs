//! Gradients that interpolate outside sRGB (`linear-gradient(in oklch, ...)`),
//! rendered on the GPU and compared with Chrome's rendering of the same page.
//! Each case is a 1080 px wide page of four bands (linear, linear with alpha
//! and a missing component, radial, conic). The goldens are ours, compared
//! exactly; Chrome is the oracle for the colour error, measured as CIE76 ΔE
//! over every pixel (the numbers print with `--nocapture`). The stops are
//! never achromatic: Chrome gives an achromatic stop (white, grey) a hue in
//! polar spaces, where CSS Color 4 makes its hue powerless, and we follow the
//! spec. Chrome dithers gradients by one 8-bit level, so about 0.3 mean and
//! 1.3 to 1.8 max ΔE is the floor between two correct renders; a few pixels
//! reach 3.3 at hue-wrap steps.

mod common;
mod paintkit;

const W: u32 = 1080;
const H: u32 = 240;

/// sRGB (0..255) to CIE Lab, D65.
fn lab(p: [u8; 3]) -> [f64; 3] {
    let lin = |v: u8| {
        let c = f64::from(v) / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    let (r, g, b) = (lin(p[0]), lin(p[1]), lin(p[2]));
    let x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    let y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    let z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
    let f = |t: f64| {
        if t > 216.0 / 24389.0 {
            t.cbrt()
        } else {
            (24389.0 / 27.0 * t + 16.0) / 116.0
        }
    };
    let (fx, fy, fz) = (f(x), f(y), f(z));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

fn delta_e(a: [u8; 3], b: [u8; 3]) -> f64 {
    let (la, lb) = (lab(a), lab(b));
    ((la[0] - lb[0]).powi(2) + (la[1] - lb[1]).powi(2) + (la[2] - lb[2]).powi(2)).sqrt()
}

/// The page for one interpolation clause, e.g. `in oklch longer hue`.
fn body(space: &str) -> String {
    let band = |top: u32, bg: String| {
        format!(
            r#"<div style="position:absolute;left:0;top:{top}px;width:{W}px;height:60px;background:{bg}"></div>"#
        )
    };
    [
        band(0, format!("linear-gradient(90deg in {space}, #ff2a00, #0044ff)")),
        band(
            60,
            format!("linear-gradient(90deg in {space}, #ffd000, rgba(0,160,90,.35) 55%, #7a00ff)"),
        ),
        band(
            120,
            format!("radial-gradient(ellipse 540px 60px at 50% 50% in {space}, #f4f0ff, #e0207a 60%, #103060)"),
        ),
        band(180, format!("conic-gradient(from 90deg at 50% 50% in {space}, #00c8ff, #ff00aa, #ffee00, #00c8ff)")),
    ]
    .concat()
}

fn case(name: &str, space: &str) {
    let (out, frame, _) = paintkit::compare(name, &body(space), W, H);
    paintkit::check_golden(name, &frame);
    assert!(
        out.unsupported.is_empty(),
        "{name}: unsupported {:?}",
        out.unsupported
    );
    let Some(reference) = paintkit::chrome(name, &body(space), W, H) else {
        return;
    };
    let ours = paintkit::frame_image(&frame);
    let (mut max, mut sum, mut worst) = (0.0_f64, 0.0_f64, (0, 0));
    for (x, y, p) in ours.enumerate_pixels() {
        let q = reference.get_pixel(x, y);
        let d = delta_e([p[0], p[1], p[2]], [q[0], q[1], q[2]]);
        sum += d;
        if d > max {
            (max, worst) = (d, (x, y));
        }
    }
    let mean = sum / f64::from(W * H);
    println!("{name}: {space}: max dE {max:.3} at {worst:?}, mean {mean:.4}");
    assert!(max < 3.5, "{name}: max dE {max:.3} at {worst:?}");
    assert!(mean < 0.35, "{name}: mean dE {mean:.4}");
}

macro_rules! space {
    ($name:ident, $space:expr) => {
        #[test]
        fn $name() {
            case(stringify!($name), $space);
        }
    };
}

space!(grad_space_srgb_linear, "srgb-linear");
space!(grad_space_oklab, "oklab");
space!(grad_space_oklch, "oklch");
space!(grad_space_oklch_longer, "oklch longer hue");
space!(grad_space_oklch_increasing, "oklch increasing hue");
space!(grad_space_oklch_decreasing, "oklch decreasing hue");
space!(grad_space_lab, "lab");
space!(grad_space_lch, "lch");
space!(grad_space_hsl, "hsl");
space!(grad_space_hsl_longer, "hsl longer hue");
space!(grad_space_hwb, "hwb");
space!(grad_space_xyz, "xyz");
space!(grad_space_display_p3, "display-p3");
