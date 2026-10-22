mod common;

use std::path::PathBuf;

use kinetograph_core::{Frame, Scene, render_still};

fn render(json: &str) -> Frame {
    render_still(Scene::from_json(json, PathBuf::new()).unwrap(), 0).unwrap()
}

fn to_linear(v: u8) -> f64 {
    let v = f64::from(v) / 255.0;
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// Linear-light red channel as rows of f64.
fn red(frame: &Frame) -> Vec<Vec<f64>> {
    frame
        .rgba
        .chunks(frame.width as usize * 4)
        .map(|row| row.chunks(4).map(|px| to_linear(px[0])).collect())
        .collect()
}

/// Marginal along x of a 24x24 white square at `x`, `y` on a square canvas of
/// `size` pixels, blurred by `radius`: (total energy, mean x, variance x).
fn blurred_square(size: usize, x: f64, radius: f64) -> (f64, f64, f64) {
    let json = format!(
        r##"{{"width": {size}, "height": {size}, "fps": 30, "durationInFrames": 1,
            "layers": [{{"id": "dot", "type": "shape", "fill": "#ffffff",
                "shape": {{"kind": "rect", "width": 24, "height": 24}},
                "transform": {{"x": {x}, "y": {y}}},
                "effects": [{{"type": "blur", "radius": {radius}}}]}}]}}"##,
        y = size / 2 - 12
    );
    let rows = red(&render(&json));
    let marginal: Vec<f64> = (0..size)
        .map(|x| rows.iter().map(|row| row[x]).sum())
        .collect();
    let total: f64 = marginal.iter().sum();
    let mean = marginal
        .iter()
        .enumerate()
        .map(|(x, m)| (x as f64 + 0.5) * m)
        .sum::<f64>()
        / total;
    let variance = marginal
        .iter()
        .enumerate()
        .map(|(x, m)| (x as f64 + 0.5 - mean).powi(2) * m)
        .sum::<f64>()
        / total;
    (total, mean, variance)
}

#[test]
fn blur_radius_is_the_standard_deviation() {
    common::pin_vello();
    // A 24x24 white square has a variance of (24^2 - 1) / 12 per axis; blurring
    // adds sigma^2.
    let square_variance = (24.0 * 24.0 - 1.0) / 12.0;
    for radius in [
        2.0, 3.0, 5.0, 8.0, 12.0, 16.0, 20.0, 32.0, 44.0, 64.0, 100.0, 128.0,
    ] {
        let (total, mean, variance) = blurred_square(1024, 500.0, radius);
        let sigma = (variance - square_variance).sqrt();
        assert!(
            (total / 576.0 - 1.0).abs() < 0.03,
            "radius {radius}: energy {total} of 576"
        );
        assert!(
            (mean - 512.0).abs() < 0.2,
            "radius {radius}: centre moved to {mean}"
        );
        assert!(
            (sigma / radius - 1.0).abs() < 0.05,
            "radius {radius}: measured sigma {sigma}"
        );
    }
}

/// The error function, to 1.5e-7 (Abramowitz and Stegun 7.1.26).
fn erf(x: f64) -> f64 {
    let t = 1.0 / (1.0 + 0.3275911 * x.abs());
    let poly = t
        * (0.254829592
            + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    (1.0 - poly * (-x * x).exp()).copysign(x)
}

#[test]
fn large_radii_are_blurred_too() {
    // A big white square blurred up to the limit of 512: its centre and the
    // middle of one edge follow the Gaussian's integral over the square.
    for (size, side, radius) in [
        (2048, 600.0, 200.0),
        (2048, 600.0, 256.0),
        (4096, 1200.0, 512.0),
    ] {
        let json = format!(
            r##"{{"width": {size}, "height": {size}, "fps": 30, "durationInFrames": 1,
                "layers": [{{"id": "sq", "type": "shape", "fill": "#ffffff",
                    "shape": {{"kind": "rect", "width": {side}, "height": {side}}},
                    "transform": {{"x": {o}, "y": {o}}},
                    "effects": [{{"type": "blur", "radius": {radius}}}]}}]}}"##,
            o = (size as f64 - side) / 2.0
        );
        let rows = red(&render(&json));
        let mid = size / 2;
        let half = side / 2.0;
        // Fraction of the square's mass inside a half-width `a` of the centre line,
        // seen from `d` away.
        let cover = |d: f64| {
            0.5 * (erf((half - d) / (radius * 2f64.sqrt()))
                + erf((half + d) / (radius * 2f64.sqrt())))
        };
        let centre = cover(0.0) * cover(0.0);
        let edge = cover(half) * cover(0.0);
        let got_centre = rows[mid][mid];
        let got_edge = rows[mid][(size as f64 / 2.0 - half) as usize];
        assert!(
            (got_centre / centre - 1.0).abs() < 0.03,
            "radius {radius}: centre {got_centre}, want {centre}"
        );
        assert!(
            (got_edge / edge - 1.0).abs() < 0.03,
            "radius {radius}: edge {got_edge}, want {edge}"
        );
    }
}

#[test]
fn blurred_layer_follows_its_position() {
    // Moving a small layer one pixel at a time must move its blur by the same
    // amount, at radii on both sides of every change in the number of levels.
    for radius in [6.0, 20.0, 44.0, 100.0] {
        let (_, base, _) = blurred_square(1024, 500.0, radius);
        for step in 1..=16 {
            let (_, mean, _) = blurred_square(1024, 500.0 + step as f64, radius);
            assert!(
                (mean - base - step as f64).abs() < 0.1,
                "radius {radius}, step {step}: moved {}",
                mean - base
            );
        }
    }
}

#[test]
fn blur_fades_out_at_the_canvas_edge() {
    // A full-canvas white layer blurred: the middle stays white, and the
    // border fades towards transparent (about half coverage right at the
    // edge) rather than staying white from edge clamping.
    let json = r##"{"width": 128, "height": 128, "fps": 30, "durationInFrames": 1,
        "layers": [{"id": "all", "type": "shape", "fill": "#ffffff",
            "shape": {"kind": "rect", "width": 128, "height": 128},
            "effects": [{"type": "blur", "radius": 10}]}]}"##;
    let frame = render(json);
    let px = |x: usize, y: usize| frame.rgba[(y * 128 + x) * 4];
    assert_eq!(px(64, 64), 255);
    assert!((150..=220).contains(&px(0, 64)), "edge pixel {}", px(0, 64));
    assert!(
        px(0, 0) < px(0, 64),
        "corner should be dimmer than the edge"
    );
}

#[test]
fn blur_radius_can_be_keyframed() {
    let json = r##"{"width": 64, "height": 64, "fps": 30, "durationInFrames": 3,
        "layers": [{"id": "dot", "type": "shape", "fill": "#ffffff",
            "shape": {"kind": "rect", "width": 8, "height": 8},
            "transform": {"x": 28, "y": 28},
            "effects": [{"type": "blur", "radius": [
                {"frame": 0, "value": 0}, {"frame": 2, "value": 6}]}]}]}"##;
    let scene = Scene::from_json(json, PathBuf::new()).unwrap();
    let peak = |frame| {
        let f = render_still(scene.clone(), frame).unwrap();
        f.rgba.chunks(4).map(|p| p[0]).max().unwrap()
    };
    // Radius 0 leaves the square untouched; larger radii spread it out.
    assert_eq!(peak(0), 255);
    assert!(
        peak(1) < 255 && peak(2) < peak(1),
        "peaks fall as radius grows"
    );
}
