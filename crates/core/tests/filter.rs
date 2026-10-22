//! `filterGraph`: what its primitives do to pixels, on the GPU.

mod common;

use std::path::PathBuf;

use kinetograph_core::{Frame, Scene, render_still};

/// Renders `layers` on a transparent 100x100 canvas.
fn render(layers: &str) -> Frame {
    let json = format!(
        r##"{{"width": 100, "height": 100, "fps": 30, "durationInFrames": 1,
              "background": "#00000000", "layers": {layers}}}"##
    );
    render_still(Scene::from_json(&json, PathBuf::new()).unwrap(), 0).unwrap()
}

fn px(frame: &Frame, x: usize, y: usize) -> [u8; 4] {
    let i = (y * frame.width as usize + x) * 4;
    frame.rgba[i..i + 4].try_into().unwrap()
}

/// A `width` x `height` white box at (`x`, `y`) with `primitives` run over
/// the canvas and 50 pixels around it (the region, in layer space).
fn boxed(x: i32, y: i32, width: i32, height: i32, primitives: &str) -> String {
    format!(
        r##"[{{"id": "box", "type": "shape", "shape": {{"kind": "rect", "width": {width}, "height": {height}}},
             "fill": "#ffffff", "transform": {{"x": {x}, "y": {y}}},
             "effects": [{{"type": "filterGraph", "filterUnits": "userSpaceOnUse",
                           "x": {rx}, "y": {ry}, "width": 200, "height": 200,
                           "primitives": {primitives}}}]}}]"##,
        rx = -x - 50,
        ry = -y - 50
    )
}

#[test]
fn a_flood_fills_its_subregion_only() {
    let layers = boxed(
        40,
        40,
        20,
        20,
        r##"[{"primitive": "feFlood", "floodColor": "#ff0000", "x": -30, "y": -30, "width": 60, "height": 60}]"##,
    );
    let f = render(&layers);
    assert_eq!(px(&f, 50, 50), [255, 0, 0, 255]);
    assert_eq!(px(&f, 10, 10), [255, 0, 0, 255]);
    assert_eq!(px(&f, 69, 69), [255, 0, 0, 255]);
    assert_eq!(px(&f, 9, 9)[3], 0);
    assert_eq!(px(&f, 70, 70)[3], 0);
}

#[test]
fn a_flood_keeps_its_colour_in_either_colour_space() {
    for space in ["sRGB", "linearRGB"] {
        let layers = boxed(
            0,
            0,
            10,
            10,
            &format!(
                r##"[{{"primitive": "feFlood", "floodColor": "#808040", "colorInterpolationFilters": "{space}"}}]"##
            ),
        );
        let f = render(&layers);
        let p = px(&f, 50, 50);
        for (got, want) in p.iter().zip([0x80, 0x80, 0x40, 255]) {
            assert!(got.abs_diff(want) <= 1, "{space}: {p:?}");
        }
    }
}

#[test]
fn an_offset_moves_the_layer_and_can_bring_in_what_hangs_off_the_canvas() {
    let f = render(&boxed(
        10,
        10,
        20,
        20,
        r##"[{"primitive": "feOffset", "dx": 30, "dy": 20}]"##,
    ));
    assert_eq!(px(&f, 50, 40), [255, 255, 255, 255]);
    assert_eq!(px(&f, 15, 15)[3], 0);
    // A box left of the canvas, pushed into it: the margin covers the reach.
    let f = render(&boxed(
        -30,
        10,
        20,
        20,
        r##"[{"primitive": "feOffset", "dx": 40}]"##,
    ));
    assert_eq!(px(&f, 15, 20), [255, 255, 255, 255]);
    assert_eq!(px(&f, 35, 20)[3], 0);
}

#[test]
fn an_offset_turns_with_the_layer() {
    let layers = r##"[{"id": "box", "type": "group",
        "transform": {"x": 50, "y": 50, "rotation": 90},
        "children": [{"id": "r", "type": "shape", "shape": {"kind": "rect", "width": 10, "height": 10},
                      "fill": "#ffffff"}],
        "effects": [{"type": "filterGraph", "filterUnits": "userSpaceOnUse",
                     "x": -100, "y": -100, "width": 200, "height": 200,
                     "primitives": [{"primitive": "feOffset", "dx": 30}]}]}]"##;
    let f = render(layers);
    // Rotated by 90 degrees clockwise, the box covers x 40..50, y 50..60, and
    // +x in the layer is +y on the canvas.
    assert_eq!(px(&f, 45, 85), [255, 255, 255, 255]);
    assert_eq!(px(&f, 75, 55)[3], 0);
}

#[test]
fn a_dilation_grows_the_box_by_its_radius() {
    let f = render(&boxed(
        50,
        50,
        2,
        2,
        r##"[{"primitive": "feMorphology", "operator": "dilate", "radius": 3}]"##,
    ));
    assert_eq!(px(&f, 47, 50)[3], 255);
    assert_eq!(px(&f, 46, 50)[3], 0);
    assert_eq!(px(&f, 54, 50)[3], 255);
    assert_eq!(px(&f, 55, 50)[3], 0);
    assert_eq!(px(&f, 50, 47)[3], 255);
    assert_eq!(px(&f, 50, 46)[3], 0);
}

#[test]
fn an_erosion_shrinks_it() {
    let f = render(&boxed(
        20,
        20,
        40,
        40,
        r##"[{"primitive": "feMorphology", "operator": "erode", "radius": 5}]"##,
    ));
    assert_eq!(px(&f, 30, 30)[3], 255);
    assert_eq!(px(&f, 24, 40)[3], 0);
    assert_eq!(px(&f, 25, 40)[3], 255);
    assert_eq!(px(&f, 54, 40)[3], 255);
    assert_eq!(px(&f, 55, 40)[3], 0);
}

#[test]
fn a_tile_repeats_the_inputs_subregion() {
    let f = render(&boxed(
        0,
        0,
        4,
        4,
        r##"[{"primitive": "feOffset", "x": 0, "y": 0, "width": 10, "height": 10},
             {"primitive": "feTile"}]"##,
    ));
    assert_eq!(px(&f, 2, 2)[3], 255);
    assert_eq!(px(&f, 12, 2)[3], 255);
    assert_eq!(px(&f, 22, 32)[3], 255);
    assert_eq!(px(&f, 7, 2)[3], 0);
    assert_eq!(px(&f, 2, 7)[3], 0);
    assert_eq!(px(&f, 92, 93)[3], 255);
    assert_eq!(px(&f, 97, 97)[3], 0);
}

#[test]
fn a_blur_has_the_standard_deviation_it_is_given_along_each_axis() {
    common::pin_vello();
    // A one pixel wide column, blurred along x only.
    let f = render(&boxed(
        50,
        0,
        1,
        100,
        r##"[{"primitive": "feGaussianBlur", "stdDeviation": [5, 0]}]"##,
    ));
    let weights: Vec<f64> = (0..100)
        .map(|x| f64::from(px(&f, x, 50)[3]) / 255.0)
        .collect();
    let total: f64 = weights.iter().sum();
    let mean = weights
        .iter()
        .enumerate()
        .map(|(x, w)| (x as f64 + 0.5) * w)
        .sum::<f64>()
        / total;
    let var = weights
        .iter()
        .enumerate()
        .map(|(x, w)| (x as f64 + 0.5 - mean).powi(2) * w)
        .sum::<f64>()
        / total;
    assert!((total - 1.0).abs() < 0.05, "total {total}");
    assert!((var.sqrt() - 5.0).abs() < 0.3, "std {}", var.sqrt());
    // No blur along y: the column is as tall as before at its edge.
    assert!(px(&f, 50, 0)[3] > 0);
    assert_eq!(px(&f, 30, 0)[3], 0);
}

#[test]
fn a_wide_round_blur_keeps_its_standard_deviation_too() {
    common::pin_vello();
    let f = render(&boxed(
        50,
        0,
        1,
        100,
        r##"[{"primitive": "feGaussianBlur", "stdDeviation": [14, 14]}]"##,
    ));
    // Row 50 is far enough from the column's ends to see only its width, which
    // the blur also spreads vertically.
    let weights: Vec<f64> = (0..100)
        .map(|x| f64::from(px(&f, x, 50)[3]) / 255.0)
        .collect();
    let total: f64 = weights.iter().sum();
    let mean = weights
        .iter()
        .enumerate()
        .map(|(x, w)| (x as f64 + 0.5) * w)
        .sum::<f64>()
        / total;
    let var = weights
        .iter()
        .enumerate()
        .map(|(x, w)| (x as f64 + 0.5 - mean).powi(2) * w)
        .sum::<f64>()
        / total;
    // The canvas cuts the tails at 3 deviations, which trims a little.
    assert!((var.sqrt() - 14.0).abs() < 1.5, "std {}", var.sqrt());
}

#[test]
fn an_arithmetic_composite_adds_and_scales_premultiplied_values() {
    let f = render(&boxed(
        0,
        0,
        100,
        100,
        r##"[{"primitive": "feFlood", "floodColor": "#ffffff", "floodOpacity": 0.25, "result": "f"},
             {"primitive": "feComposite", "in": "f", "in2": "SourceGraphic", "operator": "arithmetic",
              "k1": 0, "k2": 2, "k3": 0, "k4": 0, "colorInterpolationFilters": "sRGB"}]"##,
    ));
    // 2 x (white at alpha 0.25) = white at alpha 0.5.
    let p = px(&f, 50, 50);
    assert!(p[3].abs_diff(128) <= 1, "{p:?}");
    assert!(p[0] >= 254, "{p:?}");
}

#[test]
fn a_component_transfer_maps_each_channel() {
    let f = render(&boxed(
        0,
        0,
        100,
        100,
        r##"[{"primitive": "feFlood", "floodColor": "#ff8000", "colorInterpolationFilters": "sRGB"},
             {"primitive": "feComponentTransfer", "colorInterpolationFilters": "sRGB",
              "funcR": {"type": "linear", "slope": 0.5, "intercept": 0},
              "funcG": {"type": "table", "tableValues": [1, 0]},
              "funcB": {"type": "discrete", "tableValues": [0.25, 0.75]}}]"##,
    ));
    let p = px(&f, 50, 50);
    // R: 1 -> 0.5; G: 0.502 -> table 1 -> 0 interpolated: 1 - 0.502 = 0.498;
    // B: 0 falls in the first of two steps.
    assert!(p[0].abs_diff(128) <= 1, "{p:?}");
    assert!(p[1].abs_diff(127) <= 1, "{p:?}");
    assert!(p[2].abs_diff(64) <= 1, "{p:?}");
}

#[test]
fn a_colour_matrix_swaps_channels() {
    let f = render(&boxed(
        0,
        0,
        100,
        100,
        r##"[{"primitive": "feFlood", "floodColor": "#ff4020"},
             {"primitive": "feColorMatrix", "type": "matrix",
              "values": [0, 0, 1, 0, 0,  0, 1, 0, 0, 0,  1, 0, 0, 0, 0,  0, 0, 0, 1, 0]}]"##,
    ));
    let p = px(&f, 50, 50);
    for (got, want) in p.iter().zip([0x20, 0x40, 0xff, 255]) {
        assert!(got.abs_diff(want) <= 1, "{p:?}");
    }
}

#[test]
fn a_drop_shadow_goes_under_the_layer() {
    let f = render(&boxed(
        20,
        20,
        20,
        20,
        r##"[{"primitive": "feDropShadow", "dx": 15, "dy": 15, "stdDeviation": 0,
              "floodColor": "#0000ff"}]"##,
    ));
    assert_eq!(px(&f, 30, 30), [255, 255, 255, 255]);
    assert_eq!(px(&f, 50, 50), [0, 0, 255, 255]);
    assert_eq!(px(&f, 70, 70)[3], 0);
}

#[test]
fn a_merge_stacks_its_nodes_in_order() {
    let f = render(&boxed(
        0,
        0,
        10,
        10,
        r##"[{"primitive": "feFlood", "floodColor": "#ff0000", "result": "a"},
             {"primitive": "feFlood", "floodColor": "#0000ff", "floodOpacity": 0.5, "result": "b"},
             {"primitive": "feMerge", "nodes": ["a", "b"], "colorInterpolationFilters": "sRGB"}]"##,
    ));
    let p = px(&f, 50, 50);
    // Half blue over red, mixed in sRGB.
    assert!(
        p[0].abs_diff(128) <= 2 && p[2].abs_diff(128) <= 2 && p[3] == 255,
        "{p:?}"
    );
}

#[test]
fn turbulence_is_the_same_every_time_and_depends_on_the_seed() {
    let make = |seed: i32| {
        render(&boxed(
            0,
            0,
            10,
            10,
            &format!(
                r##"[{{"primitive": "feTurbulence", "type": "fractalNoise", "baseFrequency": 0.08,
                      "numOctaves": 3, "seed": {seed}}}]"##
            ),
        ))
    };
    let (a, b, c) = (make(3), make(3), make(4));
    assert_eq!(a.rgba, b.rgba);
    assert_ne!(a.rgba, c.rgba);
    // Fractal noise is centred on a middle grey, whatever the seed.
    let mean: f64 = a.rgba.chunks(4).map(|p| f64::from(p[0])).sum::<f64>() / 10000.0;
    assert!((100.0..200.0).contains(&mean), "mean {mean}");
}

#[test]
fn a_displacement_by_a_flat_map_shifts_the_layer() {
    // A map that is 0.75 in red everywhere (flood in sRGB) moves a pixel to
    // where `scale * 0.25` is, to the right: the layer reads from +x.
    let f = render(&boxed(
        20,
        20,
        20,
        20,
        r##"[{"primitive": "feFlood", "floodColor": "#bf0000", "result": "map"},
             {"primitive": "feDisplacementMap", "in": "SourceGraphic", "in2": "map",
              "scale": 40, "xChannelSelector": "R", "yChannelSelector": "B",
              "colorInterpolationFilters": "sRGB"}]"##,
    ));
    // R is 0.749: x + 40 * 0.249 = x + 10: the box appears 10 pixels to the left.
    // B is 0: y + 40 * (0 - 0.5) = y - 20: it appears 20 pixels lower.
    assert_eq!(px(&f, 15, 45)[3], 255);
    assert_eq!(px(&f, 25, 25)[3], 0);
}

#[test]
fn a_group_without_a_box_needs_its_region() {
    let layers = r##"[{"id": "g", "type": "group", "children": [],
        "effects": [{"type": "filterGraph", "primitives": []}]}]"##;
    let json = format!(
        r##"{{"width": 10, "height": 10, "fps": 30, "durationInFrames": 1, "layers": {layers}}}"##
    );
    let err = Scene::from_json(&json, PathBuf::new())
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("\"g\"") && err.contains("filterGraph"),
        "{err}"
    );
}

#[test]
fn the_default_region_is_ten_percent_beyond_the_box() {
    // A 40 x 40 box at (30, 30): the region is -4..44 in layer space, so a
    // flood fills 26..74 on the canvas.
    let layers = r##"[{"id": "b", "type": "shape", "shape": {"kind": "rect", "width": 40, "height": 40},
        "fill": "#ffffff", "transform": {"x": 30, "y": 30},
        "effects": [{"type": "filterGraph",
                     "primitives": [{"primitive": "feFlood", "floodColor": "#00ff00"}]}]}]"##;
    let f = render(layers);
    assert_eq!(px(&f, 26, 50), [0, 255, 0, 255]);
    assert_eq!(px(&f, 73, 50), [0, 255, 0, 255]);
    assert_eq!(px(&f, 25, 50)[3], 0);
    assert_eq!(px(&f, 74, 50)[3], 0);
}
