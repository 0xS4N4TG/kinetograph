//! Canvas passes (docs/SCENE.md, "Canvas passes"): a group whose picture is a Canvas 2D drawing of its children, and the
//! two things a WebGL pass reads of a child that depend on how the page uploaded it (`flipY`, `premultiply`). These run
//! on whichever backend the environment picks: a canvas pass is drawn by the wgpu path on both.

use std::path::Path;

use kinetograph_core::{Error, Frame, Scene, render_still};

fn scene_of(layers: &str) -> Scene {
    let json = format!(
        r##"{{"width": 16, "height": 16, "fps": 30, "durationInFrames": 1, "background": "#000000",
            "layers": [{layers}]}}"##
    );
    Scene::from_json(&json, Path::new(env!("CARGO_MANIFEST_DIR")).join("tests")).unwrap()
}

fn render(layers: &str) -> Frame {
    render_still(scene_of(layers), 0).unwrap()
}

fn px(frame: &Frame, x: usize, y: usize) -> [u8; 4] {
    let i = (y * frame.width as usize + x) * 4;
    frame.rgba[i..i + 4].try_into().unwrap()
}

fn near(got: [u8; 4], want: [u8; 4], tolerance: i32) {
    for c in 0..4 {
        assert!(
            (i32::from(got[c]) - i32::from(want[c])).abs() <= tolerance,
            "{got:?} is not within {tolerance} of {want:?}"
        );
    }
}

/// A rect of `w` x `h` at the origin.
fn rect(id: &str, w: u32, h: u32, color: &str, extra: &str) -> String {
    format!(
        r##"{{"id": "{id}", "type": "shape", "shape": {{"kind": "rect", "width": {w}, "height": {h}}},
            "fill": "{color}" {extra}}}"##
    )
}

/// The picture of the child `id`, drawn over the whole 16 x 16 canvas.
fn draw_layer(id: &str, extra: &str) -> String {
    format!(
        r#"{{"op": "image", "source": {{"kind": "layer", "id": "{id}", "width": 16, "height": 16}},
            "dx": 0, "dy": 0, "dw": 16, "dh": 16 {extra}}}"#
    )
}

/// A canvas pass over `children` that draws `commands`.
fn pass(children: &[String], commands: &[String]) -> String {
    format!(
        r#"{{"id": "pass", "type": "group", "children": [{}],
            "canvas": {{"width": 16, "height": 16, "commands": [{}]}}}}"#,
        children.join(", "),
        commands.join(", ")
    )
}

#[test]
fn a_canvas_pass_draws_its_child_as_a_picture_and_the_child_not_on_its_own() {
    // The left half in red, drawn by the pass at the right: a child is a picture, not a layer.
    let frame = render(&pass(
        &[rect("a", 8, 16, "#ff0000", "")],
        &[draw_layer("a", "").replace(r#""dx": 0"#, r#""dx": 8"#)],
    ));
    assert_eq!(px(&frame, 3, 8), [0, 0, 0, 255]);
    near(px(&frame, 12, 8), [255, 0, 0, 255], 1);
}

#[test]
fn a_canvas_pass_draws_over_its_picture_with_the_composite_operations() {
    // `source-atop` colours what is there: the red half turns blue, the empty half stays empty.
    let frame = render(&pass(
        &[rect("a", 8, 16, "#ff0000", "")],
        &[
            draw_layer("a", ""),
            r##"{"op": "fill", "path": "M0 0L16 0L16 16L0 16Z", "paint": {"type": "color", "color": "#0000ff"},
                "blend": "source-atop"}"##
                .to_string(),
        ],
    ));
    near(px(&frame, 3, 8), [0, 0, 255, 255], 1);
    assert_eq!(px(&frame, 12, 8), [0, 0, 0, 255]);
}

#[test]
fn a_canvas_pass_runs_a_filter_on_its_picture() {
    let frame = render(&pass(
        &[rect("a", 16, 16, "#ff0000", "")],
        &[draw_layer("a", r#", "filter": [{"type": "invert", "amount": 1}]"#)],
    ));
    near(px(&frame, 8, 8), [0, 255, 255, 255], 2);
}

#[test]
fn a_canvas_pass_sees_the_child_with_its_own_transform_and_opacity() {
    let frame = render(&pass(
        &[rect("a", 8, 8, "#00ff00", r#", "opacity": 0.5, "transform": {"x": 8, "y": 8}"#)],
        &[draw_layer("a", "")],
    ));
    assert_eq!(px(&frame, 3, 3), [0, 0, 0, 255]);
    // Half of the green in linear light, which is 188 encoded.
    near(px(&frame, 12, 12), [0, 188, 0, 255], 3);
}

#[test]
fn a_canvas_pass_names_children_it_has() {
    let json = format!(
        r##"{{"width": 16, "height": 16, "fps": 30, "durationInFrames": 1, "layers": [{}]}}"##,
        pass(&[rect("a", 8, 16, "#ff0000", "")], &[draw_layer("nope", "")])
    );
    let Error::Scene(message) = Scene::from_json(&json, Default::default()).unwrap_err() else {
        panic!("not a scene error")
    };
    assert!(
        message.contains("\"pass\"") && message.contains("\"nope\"") && message.contains("not one of its children"),
        "{message}"
    );
}

/// A shader group that shows the child `a` (red on the top half) through `texture`, one fragment colour per pixel.
fn shader_group(texture: &str) -> String {
    let vertex = "attribute vec2 a_pos; varying vec2 v_uv; void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }";
    let fragment = "precision mediump float; varying vec2 v_uv; uniform sampler2D u_a; \
        void main() { gl_FragColor = vec4(texture2D(u_a, vec2(v_uv.x, 1.0 - v_uv.y)).rgb, 1.0); }";
    let corners: [f32; 12] = [-1.0, -1.0, 1.0, -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0, 1.0];
    let bytes: Vec<u8> = corners.iter().flat_map(|f| f.to_le_bytes()).collect();
    use base64::Engine as _;
    let quad = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!(
        r#"{{"id": "pass", "type": "group", "children": [{}],
            "glsl": {{"width": 16, "height": 16,
              "programs": {{"p": {{"vertex": {}, "fragment": {}, "attributes": {{"a_pos": 0}}}}}},
              "buffers": {{"quad": "{quad}"}},
              "textures": {{"a": {texture}}},
              "ops": [{{"op": "draw", "program": "p", "mode": "triangles", "first": 0, "count": 6,
                 "attributes": {{"a_pos": {{"buffer": "quad", "size": 2, "type": "f32", "normalized": false, "stride": 0, "offset": 0}}}},
                 "viewport": [0, 0, 16, 16],
                 "uniforms": {{"u_a": [{{"kind": "i", "value": [0]}}]}},
                 "units": {{"0": {{"texture": "a", "min": "NEAREST", "mag": "NEAREST", "wrapS": "CLAMP_TO_EDGE", "wrapT": "CLAMP_TO_EDGE"}}}}}}]}}}}"#,
        rect("a", 16, 8, "#ff0000", ""),
        serde_json::to_string(vertex).unwrap(),
        serde_json::to_string(fragment).unwrap(),
    )
}

#[test]
fn a_layer_texture_uploaded_with_flip_y_is_turned_over() {
    // Not flipped: the red top half is at the top. Flipped (UNPACK_FLIP_Y_WEBGL): at the bottom.
    let plain = render(&shader_group(r#"{"layer": "a"}"#));
    assert_eq!(px(&plain, 8, 3), [255, 0, 0, 255]);
    assert_eq!(px(&plain, 8, 12), [0, 0, 0, 255]);
    let flipped = render(&shader_group(r#"{"layer": "a", "flipY": true}"#));
    assert_eq!(px(&flipped, 8, 3), [0, 0, 0, 255]);
    assert_eq!(px(&flipped, 8, 12), [255, 0, 0, 255]);
}

#[test]
fn a_layer_texture_uploaded_premultiplied_has_its_colour_times_its_alpha() {
    let half = |texture: &str| {
        shader_group(texture).replace(
            r##""fill": "#ff0000""##,
            r##""fill": "#ff0000", "opacity": 0.5"##,
        )
    };
    // Straight, the colour is the red as it is; premultiplied, half of it in the encoded values.
    near(px(&render(&half(r#"{"layer": "a"}"#)), 8, 3), [255, 0, 0, 255], 1);
    near(px(&render(&half(r#"{"layer": "a", "premultiply": true}"#)), 8, 3), [128, 0, 0, 255], 2);
}
