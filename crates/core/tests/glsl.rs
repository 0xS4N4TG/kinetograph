//! `glsl` layers: what a few recorded draws leave in the pixels
//! (docs/SCENE.md, "glsl"). The goldens in `golden.rs` cover the classic
//! shaders; these pin the state and the data a draw is given.

use std::path::Path;

use base64::Engine as _;
use kinetograph_core::{Error, Frame, Scene, render_still};

const QUAD_VERTEX_ES1: &str = "attribute vec2 a_pos; varying vec2 v_uv; \
    void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }";

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Two triangles over the whole clip space.
fn quad() -> String {
    let corners: [f32; 12] = [
        -1.0, -1.0, 1.0, -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0, 1.0,
    ];
    b64(&corners
        .iter()
        .flat_map(|f| f.to_le_bytes())
        .collect::<Vec<u8>>())
}

fn quad_attributes() -> String {
    r#"{"a_pos": {"buffer": "quad", "size": 2, "type": "f32", "normalized": false, "stride": 0, "offset": 0}}"#
        .to_string()
}

/// A draw of the quad with `fragment`, `extra` being more fields of the draw
/// (uniforms, units, blend).
fn draw(extra: &str) -> String {
    format!(
        r#"{{"op": "draw", "program": "p", "mode": "triangles", "first": 0, "count": 6,
            "attributes": {}, "viewport": [0, 0, 16, 16] {}}}"#,
        quad_attributes(),
        if extra.is_empty() {
            String::new()
        } else {
            format!(", {extra}")
        }
    )
}

fn layer(fragment: &str, extra_content: &str, ops: &str) -> String {
    format!(
        r#"{{"id": "g", "type": "glsl", "width": 16, "height": 16,
            "programs": {{"p": {{"vertex": {}, "fragment": {}, "attributes": {{"a_pos": 0}}}}}},
            "buffers": {{"quad": "{}"}}
            {extra_content}, "ops": [{ops}]}}"#,
        serde_json::to_string(QUAD_VERTEX_ES1).unwrap(),
        serde_json::to_string(fragment).unwrap(),
        quad()
    )
}

fn scene_of(layers: &str) -> Scene {
    let json = format!(
        r##"{{"width": 16, "height": 16, "fps": 30, "durationInFrames": 1, "background": "#000000",
            "layers": [{layers}]}}"##
    );
    Scene::from_json(&json, Path::new(env!("CARGO_MANIFEST_DIR")).join("tests")).unwrap()
}

fn render(layer: &str) -> Frame {
    render_still(scene_of(layer), 0).unwrap()
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

#[test]
fn gl_frag_coord_counts_up_from_the_bottom_row() {
    // Red grows to the right, green upwards, as in a browser.
    let frame = render(&layer(
        "precision mediump float; uniform vec2 u_res; \
         void main() { gl_FragColor = vec4(gl_FragCoord.x / u_res.x, gl_FragCoord.y / u_res.y, 0.0, 1.0); }",
        "",
        &draw(r#""uniforms": {"u_res": [{"kind": "f", "value": [16, 16]}]}"#),
    ));
    near(px(&frame, 0, 15), [8, 8, 0, 255], 6);
    near(px(&frame, 15, 15), [248, 8, 0, 255], 6);
    near(px(&frame, 0, 0), [8, 248, 0, 255], 6);
}

#[test]
fn varyings_arrays_matrices_and_bools_reach_the_shader() {
    // 0.25 + 0.5 (u_w[2]) + 0.0 (u_off is off) in red; the matrix's second
    // column in green.
    let frame = render(&layer(
        "precision mediump float; varying vec2 v_uv; uniform float u_w[3]; uniform mat2 u_m; \
         uniform bool u_on; uniform vec3 u_c[2]; \
         void main() { float r = u_w[0] + u_w[2] + (u_on ? 0.0 : 0.25); \
         gl_FragColor = vec4(r, u_m[1][0] + u_m[1][1], u_c[1].z, 1.0); }",
        "",
        &draw(
            r#""uniforms": {
              "u_w": [{"kind": "f", "value": [0.125, 0.0, 0.5]}],
              "u_m": [{"kind": "m", "value": [1, 0, 0.25, 0.5]}],
              "u_on": [{"kind": "i", "value": [0]}],
              "u_c": [{"kind": "f", "value": [0.75, 0, 0], "index": 1}]
            }"#,
        ),
    ));
    // 0.125 + 0.5 + 0.25 = 0.875 -> 223; 0.75 -> 191; blue 0.
    near(px(&frame, 8, 8), [223, 191, 0, 255], 3);
}

#[test]
fn a_texture_unit_is_sampled_with_its_wrap_and_filter() {
    // 2 x 1 texture, red then green, sampled nearest and clamped.
    let pixels = b64(&[255, 0, 0, 255, 0, 255, 0, 255]);
    let frame = render(&layer(
        "precision mediump float; varying vec2 v_uv; uniform sampler2D u_tex; \
         void main() { gl_FragColor = texture2D(u_tex, vec2(v_uv.x, 0.5)); }",
        &format!(r#", "textures": {{"t": {{"pixels": "{pixels}", "width": 2, "height": 1}}}}"#),
        &draw(
            r#""uniforms": {"u_tex": [{"kind": "i", "value": [3]}]},
               "units": {"3": {"texture": "t", "min": "NEAREST", "mag": "NEAREST",
                               "wrapS": "CLAMP_TO_EDGE", "wrapT": "CLAMP_TO_EDGE"}}"#,
        ),
    ));
    assert_eq!(px(&frame, 3, 8), [255, 0, 0, 255]);
    assert_eq!(px(&frame, 12, 8), [0, 255, 0, 255]);
}

#[test]
fn a_texture_that_needs_mipmaps_it_lacks_is_black() {
    // WebGL's default minification filter reads mipmaps; with none the
    // texture is incomplete and samples as opaque black.
    let pixels = b64(&[255, 0, 0, 255, 0, 255, 0, 255]);
    let frame = render(&layer(
        "precision mediump float; varying vec2 v_uv; uniform sampler2D u_tex; \
         void main() { gl_FragColor = texture2D(u_tex, vec2(v_uv.x, 0.5)); }",
        &format!(r#", "textures": {{"t": {{"pixels": "{pixels}", "width": 2, "height": 1}}}}"#),
        &draw(
            r#""uniforms": {"u_tex": [{"kind": "i", "value": [0]}]},
               "units": {"0": {"texture": "t"}}"#,
        ),
    ));
    assert_eq!(px(&frame, 3, 8), [0, 0, 0, 255]);
}

#[test]
fn blending_scissor_and_clear_follow_the_state() {
    let blend = r#""blend": {"srcRgb": "SRC_ALPHA", "dstRgb": "ONE_MINUS_SRC_ALPHA",
        "srcAlpha": "ONE", "dstAlpha": "ONE_MINUS_SRC_ALPHA", "eqRgb": "FUNC_ADD",
        "eqAlpha": "FUNC_ADD"}"#;
    let ops = format!(
        // A draw before the clear is gone with it.
        r#"{},
           {{"op": "clear", "color": [0, 0, 1, 1]}},
           {}"#,
        draw(""),
        draw(&format!(r#""scissor": [0, 0, 16, 8], {blend}"#)),
    );
    let frame = render(&layer(
        "precision mediump float; void main() { gl_FragColor = vec4(1.0, 0.0, 0.0, 0.5); }",
        "",
        &ops,
    ));
    // GL's y counts from the bottom, so the scissor keeps the lower half of the
    // picture: red at half alpha over blue there, the cleared blue above.
    near(px(&frame, 8, 12), [127, 0, 127, 255], 3);
    assert_eq!(px(&frame, 8, 3), [0, 0, 255, 255]);
}

#[test]
fn an_unpremultiplied_context_is_premultiplied_on_the_canvas() {
    // Straight (1, 0, 0, 0.5) over the black background: half red in light.
    let json = layer(
        "precision mediump float; void main() { gl_FragColor = vec4(1.0, 0.0, 0.0, 0.5); }",
        r#", "premultipliedAlpha": false"#,
        &draw(""),
    );
    let straight = render(&json);
    let premultiplied = render(&layer(
        "precision mediump float; void main() { gl_FragColor = vec4(0.5, 0.0, 0.0, 0.5); }",
        "",
        &draw(""),
    ));
    near(px(&straight, 8, 8), px(&premultiplied, 8, 8), 2);
    assert!(px(&straight, 8, 8)[0] > 100);
}

#[test]
fn a_broken_shader_fails_when_the_scene_loads() {
    let json = format!(
        r##"{{"width": 16, "height": 16, "fps": 30, "durationInFrames": 1,
            "layers": [{}]}}"##,
        layer(
            "precision mediump float;\nvoid main() {\n  gl_FragColor = vec4(nope);\n}",
            "",
            &draw("")
        )
    );
    let error = Scene::from_json(&json, Default::default()).unwrap_err();
    let Error::Scene(message) = error else {
        panic!("{error}")
    };
    assert!(
        message.contains("layer \"g\"") && message.contains("fragment shader: 3:"),
        "{message}"
    );
}

#[test]
fn a_draw_without_vertex_data_says_so() {
    let json = layer(
        "precision mediump float; void main() { gl_FragColor = vec4(1.0); }",
        "",
        r#"{"op": "draw", "program": "p", "mode": "triangles", "first": 0, "count": 3,
            "viewport": [0, 0, 16, 16]}"#,
    );
    let scene = scene_of(&json);
    let error = render_still(scene, 0).err().expect("must fail").to_string();
    assert!(
        error.contains("a_pos") && error.contains("no data"),
        "{error}"
    );
}
