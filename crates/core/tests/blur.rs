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
