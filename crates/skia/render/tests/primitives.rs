//! What trees of RN-Skia nodes leave in the pixels. Each test draws a small
//! canvas and reads pixels; the colours are `[r, g, b, a]` from 0 to 1, as the
//! authoring side writes them.

use std::path::PathBuf;

use kinetograph_skia::{Assets, Output, render};
use serde_json::{Value, json};

fn draw(nodes: Value) -> Output {
    draw_at(nodes, 32)
}

fn draw_at(nodes: Value, size: u32) -> Output {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    render(size, size, nodes.as_array().unwrap(), &mut Assets::default(), base).unwrap()
}

fn px(out: &Output, x: usize, y: usize) -> [u8; 4] {
    let i = (y * out.width as usize + x) * 4;
    out.rgba[i..i + 4].try_into().unwrap()
}

fn near(a: [u8; 4], b: [u8; 4], tolerance: i32) -> bool {
    a.iter().zip(&b).all(|(x, y)| (i32::from(*x) - i32::from(*y)).abs() <= tolerance)
}

fn assert_px(out: &Output, x: usize, y: usize, expected: [u8; 4]) {
    let got = px(out, x, y);
    assert!(near(got, expected, 2), "({x}, {y}) is {got:?}, expected {expected:?}");
}

const RED: [u8; 4] = [255, 0, 0, 255];
const GREEN: [u8; 4] = [0, 255, 0, 255];
const BLUE: [u8; 4] = [0, 0, 255, 255];
const CLEAR: [u8; 4] = [0, 0, 0, 0];

fn node(kind: &str, props: Value, children: Vec<Value>) -> Value {
    json!({ "type": kind, "props": props, "children": children })
}

fn rect(props: Value) -> Value {
    node("Rect", props, vec![])
}

#[test]
fn a_rect_is_filled_with_its_color() {
    let out = draw(json!([rect(json!({ "x": 4, "y": 4, "width": 8, "height": 8, "color": [1, 0, 0, 1] }))]));
    assert_px(&out, 8, 8, RED);
    assert_px(&out, 2, 2, CLEAR);
    assert_px(&out, 20, 20, CLEAR);
}

#[test]
fn a_group_passes_its_paint_to_the_nodes_in_it() {
    let out = draw(json!([node(
        "Group",
        json!({ "color": [0, 0, 1, 1] }),
        vec![rect(json!({ "x": 0, "y": 0, "width": 8, "height": 8 })), rect(json!({ "x": 16, "y": 0, "width": 8, "height": 8, "color": [0, 1, 0, 1] }))]
    )]));
    assert_px(&out, 4, 4, BLUE);
    assert_px(&out, 20, 4, GREEN);
}

#[test]
fn opacity_multiplies_down_the_groups() {
    let out = draw(json!([node(
        "Group",
        json!({ "opacity": 0.5 }),
        vec![node("Group", json!({ "opacity": 0.5 }), vec![rect(json!({ "x": 0, "y": 0, "width": 8, "height": 8, "color": [1, 0, 0, 1] }))])]
    )]));
    let got = px(&out, 4, 4);
    assert!(i32::from(got[3]).abs_diff(64) <= 2 && got[0] == 255, "{got:?}");
}

#[test]
fn a_stroke_draws_the_outline_only() {
    let out = draw(json!([rect(json!({
        "x": 4, "y": 4, "width": 24, "height": 24, "style": "stroke", "strokeWidth": 4, "color": [1, 0, 0, 1]
    }))]));
    assert_px(&out, 4, 16, RED);
    assert_px(&out, 16, 16, CLEAR);
}

#[test]
fn circles_ovals_lines_and_rounded_rects() {
    let out = draw(json!([
        node("Circle", json!({ "c": { "x": 8, "y": 8 }, "r": 6, "color": [1, 0, 0, 1] }), vec![]),
        node("Circle", json!({ "cx": 24, "cy": 8, "r": 6, "color": [0, 1, 0, 1] }), vec![]),
        node("RoundedRect", json!({ "x": 2, "y": 18, "width": 12, "height": 12, "r": 6, "color": [0, 0, 1, 1] }), vec![]),
        node("Line", json!({ "p1": { "x": 18, "y": 24 }, "p2": { "x": 30, "y": 24 }, "style": "stroke", "strokeWidth": 4, "color": [1, 0, 0, 1] }), vec![]),
    ]));
    assert_px(&out, 8, 8, RED);
    assert_px(&out, 24, 8, GREEN);
    assert_px(&out, 8, 24, BLUE);
    assert_px(&out, 2, 18, CLEAR);
    assert_px(&out, 24, 24, RED);
}

#[test]
fn a_path_is_filled_by_its_fill_rule() {
    let star = "M2 2H30V30H2ZM10 10H22V22H10Z";
    let winding = draw(json!([node("Path", json!({ "path": star, "color": [1, 0, 0, 1] }), vec![])]));
    assert_px(&winding, 16, 16, RED);
    let even_odd = draw(json!([node("Path", json!({ "path": { "d": star, "fillType": "evenOdd" }, "color": [1, 0, 0, 1] }), vec![])]));
    assert_px(&even_odd, 16, 16, CLEAR);
    assert_px(&even_odd, 5, 5, RED);
}

#[test]
fn a_path_can_be_trimmed() {
    let out = draw(json!([node(
        "Path",
        json!({ "path": "M0 16H32", "style": "stroke", "strokeWidth": 4, "start": 0, "end": 0.5, "color": [1, 0, 0, 1] }),
        vec![]
    )]));
    assert_px(&out, 8, 16, RED);
    assert_px(&out, 24, 16, CLEAR);
}

#[test]
fn a_linear_gradient_child_paints_the_node() {
    let out = draw(json!([node(
        "Rect",
        json!({ "x": 0, "y": 0, "width": 32, "height": 32 }),
        vec![node(
            "LinearGradient",
            json!({ "start": { "x": 0, "y": 0 }, "end": { "x": 32, "y": 0 }, "colors": [[1, 0, 0, 1], [0, 0, 1, 1]] }),
            vec![]
        )]
    )]));
    let left = px(&out, 1, 16);
    let right = px(&out, 30, 16);
    assert!(left[0] > 230 && left[2] < 25, "{left:?}");
    assert!(right[2] > 230 && right[0] < 25, "{right:?}");
}

#[test]
fn radial_sweep_and_conical_gradients_make_shaders() {
    let colors = json!([[1, 0, 0, 1], [0, 1, 0, 1]]);
    for (kind, props) in [
        ("RadialGradient", json!({ "c": { "x": 16, "y": 16 }, "r": 16, "colors": colors })),
        ("SweepGradient", json!({ "c": { "x": 16, "y": 16 }, "colors": colors })),
        (
            "TwoPointConicalGradient",
            json!({ "start": { "x": 8, "y": 16 }, "startR": 2, "end": { "x": 24, "y": 16 }, "endR": 8, "colors": colors }),
        ),
    ] {
        let out = draw(json!([node("Fill", json!({}), vec![node(kind, props, vec![])])]));
        assert!(px(&out, 16, 16)[3] == 255, "{kind}");
    }
}

#[test]
fn a_transform_moves_the_group_and_an_origin_turns_it_about_a_point() {
    let moved = draw(json!([node(
        "Group",
        json!({ "transform": [{ "translateX": 16 }, { "translateY": 8 }] }),
        vec![rect(json!({ "x": 0, "y": 0, "width": 8, "height": 8, "color": [1, 0, 0, 1] }))]
    )]));
    assert_px(&moved, 20, 12, RED);
    assert_px(&moved, 4, 4, CLEAR);
    let turned = draw(json!([node(
        "Group",
        json!({ "transform": [{ "rotate": std::f64::consts::FRAC_PI_2 }], "origin": { "x": 16, "y": 16 } }),
        vec![rect(json!({ "x": 16, "y": 16, "width": 8, "height": 8, "color": [1, 0, 0, 1] }))]
    )]));
    // A quarter turn clockwise about the centre takes the lower right to the lower left.
    assert_px(&turned, 12, 20, RED);
    assert_px(&turned, 20, 20, CLEAR);
}

#[test]
fn a_clip_cuts_what_is_drawn_and_invert_clip_cuts_the_other_way() {
    let rect_in = |invert: bool| {
        draw(json!([node(
            "Group",
            json!({ "clip": { "x": 0, "y": 0, "width": 16, "height": 32 }, "invertClip": invert }),
            vec![rect(json!({ "x": 0, "y": 0, "width": 32, "height": 32, "color": [1, 0, 0, 1] }))]
        )]))
    };
    let kept = rect_in(false);
    assert_px(&kept, 8, 8, RED);
    assert_px(&kept, 24, 8, CLEAR);
    let inverted = rect_in(true);
    assert_px(&inverted, 8, 8, CLEAR);
    assert_px(&inverted, 24, 8, RED);
}

#[test]
fn paint_children_repeat_the_drawing_once_for_each() {
    let out = draw(json!([node(
        "Rect",
        json!({ "x": 8, "y": 8, "width": 16, "height": 16 }),
        vec![
            node("Paint", json!({ "color": [1, 0, 0, 1] }), vec![]),
            node("Paint", json!({ "color": [0, 0, 1, 1], "style": "stroke", "strokeWidth": 4 }), vec![]),
        ]
    )]));
    // The inherited paint (black) fills, then the red fill, then the blue stroke on top.
    assert_px(&out, 16, 16, RED);
    assert_px(&out, 8, 16, BLUE);
}

#[test]
fn a_blur_child_blurs_what_the_node_draws() {
    let out = draw(json!([node(
        "Rect",
        json!({ "x": 8, "y": 8, "width": 16, "height": 16, "color": [1, 0, 0, 1] }),
        vec![node("BlurImageFilter", json!({ "blur": 3 }), vec![])]
    )]));
    assert_px(&out, 16, 16, RED);
    let edge = px(&out, 8, 16);
    assert!(edge[3] > 40 && edge[3] < 215, "the edge is half way: {edge:?}");
    assert!(px(&out, 2, 16)[3] < 40);
}

#[test]
fn a_blur_mask_blurs_the_shape_not_the_layer() {
    let out = draw(json!([node(
        "Rect",
        json!({ "x": 8, "y": 8, "width": 16, "height": 16, "color": [1, 0, 0, 1] }),
        vec![node("BlurMaskFilter", json!({ "blur": 3, "style": "normal" }), vec![])]
    )]));
    let edge = px(&out, 8, 16);
    assert!(edge[3] > 40 && edge[3] < 215, "{edge:?}");
}

#[test]
fn a_drop_shadow_adds_a_shadow_behind() {
    let out = draw(json!([node(
        "Rect",
        json!({ "x": 4, "y": 4, "width": 12, "height": 12, "color": [1, 0, 0, 1] }),
        vec![node("DropShadowImageFilter", json!({ "dx": 8, "dy": 8, "blur": 0, "color": [0, 0, 1, 1] }), vec![])]
    )]));
    assert_px(&out, 8, 8, RED);
    assert_px(&out, 20, 20, BLUE);
}

#[test]
fn a_color_matrix_filters_the_colors() {
    // Red in, green out: the red row writes the green channel.
    let swap = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
    let out = draw(json!([node(
        "Rect",
        json!({ "x": 0, "y": 0, "width": 32, "height": 32, "color": [1, 0, 0, 1] }),
        vec![node("MatrixColorFilter", json!({ "matrix": swap }), vec![])]
    )]));
    assert_px(&out, 16, 16, GREEN);
}

#[test]
fn a_dash_path_effect_breaks_the_line() {
    let out = draw(json!([node(
        "Line",
        json!({ "p1": { "x": 0, "y": 16 }, "p2": { "x": 32, "y": 16 }, "style": "stroke", "strokeWidth": 4, "color": [1, 0, 0, 1] }),
        vec![node("DashPathEffect", json!({ "intervals": [8, 8], "phase": 0 }), vec![])]
    )]));
    assert_px(&out, 4, 16, RED);
    assert_px(&out, 12, 16, CLEAR);
    assert_px(&out, 20, 16, RED);
}

#[test]
fn a_layer_composites_its_children_together_before_the_paint() {
    // Two overlapping opaque rects drawn in a layer with half opacity are half transparent where they overlap.
    let out = draw(json!([node(
        "Group",
        json!({ "layer": { "type": "Paint", "props": { "opacity": 0.5 }, "children": [] } }),
        vec![
            rect(json!({ "x": 0, "y": 0, "width": 20, "height": 20, "color": [1, 0, 0, 1] })),
            rect(json!({ "x": 10, "y": 10, "width": 20, "height": 20, "color": [1, 0, 0, 1] })),
        ]
    )]));
    let overlap = px(&out, 15, 15);
    let single = px(&out, 5, 5);
    assert!(near(overlap, single, 2), "{overlap:?} {single:?}");
    assert!(i32::from(single[3]).abs_diff(128) <= 2);
}

#[test]
fn a_blend_mode_changes_how_a_node_meets_the_ones_before() {
    let out = draw(json!([
        rect(json!({ "x": 0, "y": 0, "width": 32, "height": 32, "color": [1, 1, 0, 1] })),
        rect(json!({ "x": 0, "y": 0, "width": 32, "height": 32, "color": [0, 1, 1, 1], "blendMode": "multiply" })),
    ]));
    // Yellow times cyan is green.
    assert_px(&out, 16, 16, GREEN);
}

#[test]
fn a_runtime_effect_runs_skia_sksl() {
    let sksl = "uniform float2 size; uniform half4 tint; half4 main(float2 xy) { return half4(xy.x / size.x, 0, 0, 1) * tint; }";
    let out = draw(json!([node(
        "Fill",
        json!({}),
        vec![node(
            "Shader",
            json!({ "source": { "sksl": sksl }, "uniforms": { "size": [32, 32], "tint": [1, 1, 1, 1] } }),
            vec![]
        )]
    )]));
    // Red grows to the right.
    assert!(px(&out, 2, 16)[0] < 30, "{:?}", px(&out, 2, 16));
    assert!(px(&out, 30, 16)[0] > 225, "{:?}", px(&out, 30, 16));
    assert_px(&out, 30, 16, [px(&out, 30, 16)[0], 0, 0, 255]);
}

#[test]
fn a_runtime_effect_that_does_not_compile_is_an_error_with_skias_message() {
    let tree = json!([node("Fill", json!({}), vec![node("Shader", json!({ "source": { "sksl": "half4 main(float2 xy) { return nope; }" }, "uniforms": {} }), vec![])])]);
    let message = render(8, 8, tree.as_array().unwrap(), &mut Assets::default(), PathBuf::new()).err().unwrap().to_string();
    assert!(message.contains("SkSL") && message.contains("nope"), "{message}");
}

#[test]
fn a_missing_uniform_is_named() {
    let sksl = "uniform float t; half4 main(float2 xy) { return half4(t, 0, 0, 1); }";
    let tree = json!([node("Fill", json!({}), vec![node("Shader", json!({ "source": { "sksl": sksl }, "uniforms": {} }), vec![])])]);
    let message = render(8, 8, tree.as_array().unwrap(), &mut Assets::default(), PathBuf::new()).err().unwrap().to_string();
    assert!(message.contains("uniform t"), "{message}");
}

#[test]
fn text_is_drawn_with_a_registered_font() {
    let font = json!({ "file": "assets/fonts/DMSans-Medium.ttf", "size": 24 });
    let out = draw_at(
        json!([node("Text", json!({ "x": 2, "y": 24, "text": "H", "font": font, "color": [1, 0, 0, 1] }), vec![])]),
        32,
    );
    let drawn = (0..32usize).flat_map(|y| (0..32usize).map(move |x| (x, y))).filter(|&(x, y)| px(&out, x, y)[3] > 200).count();
    assert!(drawn > 30, "{drawn} pixels of H");
}

#[test]
fn a_node_that_is_not_drawn_is_reported_not_failed() {
    let out = draw(json!([node("Atlas", json!({}), vec![])]));
    assert_eq!(out.unsupported.len(), 1);
    assert_eq!(out.unsupported[0].element, "Atlas");
}

#[test]
fn the_same_tree_gives_the_same_pixels() {
    let tree = json!([node(
        "Circle",
        json!({ "cx": 16, "cy": 16, "r": 12 }),
        vec![node("RadialGradient", json!({ "c": { "x": 16, "y": 16 }, "r": 12, "colors": [[1, 0, 0, 1], [0, 0, 1, 1]] }), vec![])]
    )]);
    assert_eq!(draw(tree.clone()).rgba, draw(tree).rgba);
}
