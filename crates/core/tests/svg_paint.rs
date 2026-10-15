//! What the scene needs to draw SVG: stroke caps, joins, dashes, the fill
//! rule, a gradient's matrix and focal point, and an sRGB luminance matte.

use std::path::PathBuf;

use kinetograph_core::{Frame, Scene, render_still};

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

fn path(d: &str, extra: &str) -> String {
    format!(
        r##"[{{"id": "p", "type": "shape", "shape": {{"kind": "path", "d": "{d}"}}, {extra}}}]"##
    )
}

#[test]
fn a_dash_pattern_alternates_along_the_line() {
    let f = render(&path(
        "M 10 50 L 90 50",
        r##""stroke": {"color": "#ffffff", "width": 10, "dashArray": [10, 10]}"##,
    ));
    assert_eq!(px(&f, 15, 50)[3], 255);
    assert_eq!(px(&f, 25, 50)[3], 0);
    assert_eq!(px(&f, 35, 50)[3], 255);
    assert_eq!(px(&f, 85, 50)[3], 0);
}

#[test]
fn a_dash_offset_starts_further_into_the_pattern() {
    let f = render(&path(
        "M 10 50 L 90 50",
        r##""stroke": {"color": "#ffffff", "width": 10, "dashArray": [10, 10], "dashOffset": 10}"##,
    ));
    assert_eq!(px(&f, 15, 50)[3], 0);
    assert_eq!(px(&f, 25, 50)[3], 255);
}

#[test]
fn caps_finish_the_ends() {
    let cap = |cap: &str| {
        render(&path(
            "M 30 50 L 70 50",
            &format!(r##""stroke": {{"color": "#ffffff", "width": 20, "cap": "{cap}"}}"##),
        ))
    };
    assert_eq!(px(&cap("butt"), 27, 50)[3], 0);
    assert_eq!(px(&cap("square"), 27, 50)[3], 255);
    assert_eq!(px(&cap("square"), 21, 40)[3], 255);
    assert_eq!(px(&cap("round"), 27, 50)[3], 255);
    // The corner of the square cap is cut off by the round one.
    assert!(px(&cap("round"), 21, 41)[3] < 200);
}

#[test]
fn joins_finish_the_corners() {
    let join = |join: &str, limit: f64| {
        render(&path(
            "M 20 80 L 50 20 L 80 80",
            &format!(
                r##""stroke": {{"color": "#ffffff", "width": 10, "join": "{join}", "miterLimit": {limit}}}"##
            ),
        ))
    };
    // The miter tip, about 11 pixels above the corner.
    assert_eq!(px(&join("miter", 4.0), 50, 13)[3], 255);
    assert_eq!(px(&join("bevel", 4.0), 50, 13)[3], 0);
    assert_eq!(px(&join("round", 4.0), 50, 13)[3], 0);
    // Over the limit the miter becomes a bevel.
    assert_eq!(px(&join("miter", 1.5), 50, 13)[3], 0);
}

#[test]
fn the_even_odd_rule_leaves_holes() {
    let d = "M 10 10 H 90 V 90 H 10 Z M 30 30 H 70 V 70 H 30 Z";
    let rule = |rule: &str| {
        render(&path(
            d,
            &format!(r##""fill": "#ffffff", "fillRule": "{rule}""##),
        ))
    };
    assert_eq!(px(&rule("nonzero"), 50, 50)[3], 255);
    assert_eq!(px(&rule("evenodd"), 50, 50)[3], 0);
    assert_eq!(px(&rule("evenodd"), 20, 20)[3], 255);
}

#[test]
fn a_gradient_has_a_matrix_of_its_own() {
    // Red at x 0 to blue at x 1 in the gradient's space, stretched by 100.
    let layers = r##"[{"id": "r", "type": "shape", "shape": {"kind": "rect", "width": 100, "height": 100},
        "fill": {"type": "linear", "x0": 0, "y0": 0, "x1": 1, "y1": 0, "transform": [100, 0, 0, 1, 0, 0],
                 "stops": [{"offset": 0, "color": "#ff0000"}, {"offset": 1, "color": "#0000ff"}]}}]"##;
    let f = render(layers);
    let (left, right) = (px(&f, 5, 50), px(&f, 95, 50));
    assert!(left[0] > 200 && left[2] < 60, "{left:?}");
    assert!(right[2] > 200 && right[0] < 60, "{right:?}");
}

#[test]
fn a_focal_radial_gradient_starts_at_its_focus() {
    let layers = r##"[{"id": "r", "type": "shape", "shape": {"kind": "rect", "width": 100, "height": 100},
        "fill": {"type": "radial", "cx": 50, "cy": 50, "r": 50, "fx": 20, "fy": 50,
                 "stops": [{"offset": 0, "color": "#ffffff"}, {"offset": 1, "color": "#000000"}]}}]"##;
    let f = render(layers);
    // Brightest at the focus, and brighter on the focus's side of the centre.
    assert!(px(&f, 20, 50)[0] > 240, "{:?}", px(&f, 20, 50));
    assert!(px(&f, 35, 50)[0] > px(&f, 65, 50)[0]);
}

#[test]
fn an_srgb_luminance_matte_reads_the_encoded_colour() {
    let layers = |mode: &str| {
        format!(
            r##"[{{"id": "photo", "type": "shape", "shape": {{"kind": "rect", "width": 100, "height": 100}},
                  "fill": "#ffffff", "matte": {{"layer": "m", "mode": "{mode}"}}}},
                 {{"id": "m", "type": "shape", "shape": {{"kind": "rect", "width": 100, "height": 100}},
                  "fill": "#808080"}}]"##
        )
    };
    // 0x80 is 0.5 encoded and 0.216 in linear light.
    let srgb = px(&render(&layers("srgbLuminance")), 50, 50)[3];
    let linear = px(&render(&layers("luminance")), 50, 50)[3];
    assert!(srgb.abs_diff(128) <= 2, "{srgb}");
    assert!(linear.abs_diff(55) <= 3, "{linear}");
}

#[test]
fn a_skewed_linear_gradient_tilts_its_lines_of_one_colour() {
    // t = (x - y / 2) / 100 in the painted space: red at 0, blue at 1. The
    // matrix shears the gradient's space, so equal colours run along lines that
    // are not perpendicular to the line from the first point to the second.
    let layers = r##"[{"id": "r", "type": "shape", "shape": {"kind": "rect", "width": 100, "height": 100},
        "fill": {"type": "linear", "x0": 0, "y0": 0, "x1": 1, "y1": 0, "transform": [100, 0, 50, 100, 0, 0],
                 "stops": [{"offset": 0, "color": "#ff0000"}, {"offset": 1, "color": "#0000ff"}]}}]"##;
    let f = render(layers);
    // t = 0.6 at (80, 40) and 0.4 at (80, 80): red is 1 - t.
    let (a, b) = (px(&f, 80, 40), px(&f, 80, 80));
    assert!(a[0].abs_diff(102) <= 4, "{a:?}");
    assert!(b[0].abs_diff(153) <= 4, "{b:?}");
}

#[test]
fn a_pass_through_group_blends_its_children_with_what_is_behind_it() {
    let layers = |pass: bool| {
        format!(
            r##"[{{"id": "back", "type": "shape", "shape": {{"kind": "rect", "width": 100, "height": 100}},
                  "fill": "#ff0000"}},
                 {{"id": "g", "type": "group", "passThrough": {pass}, "children": [
                   {{"id": "c", "type": "shape", "shape": {{"kind": "rect", "width": 100, "height": 100}},
                     "fill": "#00ff00", "blendMode": "multiply"}}]}}]"##
        )
    };
    // Red times green is black; in a group of its own, green multiplies nothing.
    assert_eq!(px(&render(&layers(true)), 50, 50), [0, 0, 0, 255]);
    assert_eq!(px(&render(&layers(false)), 50, 50), [0, 255, 0, 255]);
}
