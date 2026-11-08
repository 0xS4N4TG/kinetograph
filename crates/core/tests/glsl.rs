//! `glsl` layers: what a few recorded draws leave in the pixels
//! (packages/cli/skills/kinetograph/references/SCENE.md, "glsl"). The goldens in `golden.rs` cover the classic
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

/// A draw of the quad with the program `program`, over the 16 x 16 drawing
/// buffer or, with `target` (a texture's id and side), that square texture;
/// `extra` being more fields of the draw (uniforms, units, blend).
fn draw_with(program: &str, target: Option<(&str, u32)>, extra: &str) -> String {
    let (side, target) = match target {
        Some((id, side)) => (side, format!(r#", "target": "{id}""#)),
        None => (16, String::new()),
    };
    format!(
        r#"{{"op": "draw", "program": "{program}", "mode": "triangles", "first": 0, "count": 6,
            "attributes": {}, "viewport": [0, 0, {side}, {side}] {target} {}}}"#,
        quad_attributes(),
        if extra.is_empty() {
            String::new()
        } else {
            format!(", {extra}")
        }
    )
}

/// A draw of the quad with the program `p`.
fn draw(extra: &str) -> String {
    draw_with("p", None, extra)
}

/// A layer with the fragment shaders `programs` (id and source), all with the
/// quad's vertex shader.
fn layer_of(programs: &[(&str, &str)], extra_content: &str, ops: &str) -> String {
    layer_with_vertex(QUAD_VERTEX_ES1, programs, "", extra_content, ops)
}

/// `layer_of` with a vertex shader of its own.
fn layer_with_vertex(
    vertex: &str,
    programs: &[(&str, &str)],
    more_buffers: &str,
    extra_content: &str,
    ops: &str,
) -> String {
    let programs: Vec<String> = programs
        .iter()
        .map(|(id, fragment)| {
            format!(
                r#""{id}": {{"vertex": {}, "fragment": {}, "attributes": {{"a_pos": 0}}}}"#,
                serde_json::to_string(vertex).unwrap(),
                serde_json::to_string(fragment).unwrap(),
            )
        })
        .collect();
    format!(
        r#"{{"id": "g", "type": "glsl", "width": 16, "height": 16,
            "programs": {{{}}},
            "buffers": {{"quad": "{}"{more_buffers}}}
            {extra_content}, "ops": [{ops}]}}"#,
        programs.join(", "),
        quad()
    )
}

fn layer(fragment: &str, extra_content: &str, ops: &str) -> String {
    layer_of(&[("p", fragment)], extra_content, ops)
}

fn scene_of(layers: &str) -> Scene {
    let json = format!(
        r##"{{"blendSpace": "linear", "width": 16, "height": 16, "fps": 30, "durationInFrames": 1, "background": "#000000",
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
fn gl_vertex_id_counts_from_the_first_vertex_of_the_draw() {
    // The quad's second triangle is vertices 3, 4, 5: (-1,1), (1,-1), (1,1).
    let vertex = "#version 300 es\nin vec2 a_pos; out float v_id; \
        void main() { v_id = float(gl_VertexID); gl_Position = vec4(a_pos, 0.0, 1.0); }";
    let fragment = "#version 300 es\nprecision mediump float; in float v_id; out vec4 o; \
        void main() { o = vec4(v_id / 8.0, 0.0, 0.0, 1.0); }";
    let draw = format!(
        r#"{{"op": "draw", "program": "p", "mode": "triangles", "first": 3, "count": 3,
            "attributes": {}, "viewport": [0, 0, 16, 16]}}"#,
        quad_attributes()
    );
    let frame = render(&layer_with_vertex(
        vertex,
        &[("p", fragment)],
        "",
        "",
        &draw,
    ));
    near(px(&frame, 0, 0), [96, 0, 0, 255], 14);
    near(px(&frame, 15, 15), [127, 0, 0, 255], 14);
    near(px(&frame, 15, 0), [159, 0, 0, 255], 14);
    // The first triangle is not drawn.
    near(px(&frame, 0, 15), [0, 0, 0, 255], 0);
}

/// A draw of `count` points from a buffer of `[x, y]` pairs.
fn points_draw(first: u32, count: u32, extra: &str) -> String {
    format!(
        r#"{{"op": "draw", "program": "p", "mode": "points", "first": {first}, "count": {count},
            "attributes": {{"a_pos": {{"buffer": "pts", "size": 2, "type": "f32", "normalized": false,
            "stride": 0, "offset": 0}}}}, "viewport": [0, 0, 16, 16]{extra}}}"#
    )
}

fn points_buffer(points: &[[f32; 2]]) -> String {
    b64(&points
        .iter()
        .flatten()
        .flat_map(|f| f.to_le_bytes())
        .collect::<Vec<u8>>())
}

#[test]
fn points_are_squares_of_gl_point_size_with_a_point_coord() {
    // Two points: (-0.5, 0.5) of 4 pixels, which covers x 2..6 and y 2..6 from
    // the top; and (0.5, -0.5) of 6 pixels, which covers x 9..15 and y 9..15.
    let vertex = "attribute vec2 a_pos; void main() { \
        gl_PointSize = a_pos.x < 0.0 ? 4.0 : 6.0; gl_Position = vec4(a_pos, 0.0, 1.0); }";
    let fragment = "precision mediump float; void main() { \
        gl_FragColor = vec4(gl_PointCoord, 0.0, 1.0); }";
    let buffer = points_buffer(&[[-0.5, 0.5], [0.5, -0.5]]);
    let layer = layer_with_vertex(
        vertex,
        &[("p", fragment)],
        &format!(r#", "pts": "{buffer}""#),
        "",
        &points_draw(0, 2, ""),
    );
    let frame = render(&layer);
    // Outside both points: nothing.
    assert_eq!(px(&frame, 0, 0)[..3], [0, 0, 0]);
    assert_eq!(px(&frame, 8, 8)[..3], [0, 0, 0]);
    assert_eq!(px(&frame, 1, 3)[..3], [0, 0, 0]);
    assert_eq!(px(&frame, 6, 3)[..3], [0, 0, 0]);
    // The first point: x 2..6, y 2..6; gl_PointCoord y counts down.
    near(px(&frame, 2, 2), [32, 32, 0, 255], 3);
    near(px(&frame, 5, 2), [223, 32, 0, 255], 3);
    near(px(&frame, 2, 5), [32, 223, 0, 255], 3);
    // The second: x 9..15, y 9..15.
    near(px(&frame, 9, 9), [21, 21, 0, 255], 3);
    near(px(&frame, 14, 14), [234, 234, 0, 255], 3);
    assert_eq!(px(&frame, 8, 9)[..3], [0, 0, 0]);
    assert_eq!(px(&frame, 15, 9)[..3], [0, 0, 0]);
}

#[test]
fn a_point_centred_outside_the_clip_volume_is_not_drawn_and_gl_vertex_id_is_its_index() {
    // Point 1 is off to the right (its sprite would reach in); `first` starts
    // at point 1 of three, so the ids drawn are 1 and 2.
    let vertex = "attribute vec2 a_pos; varying float v_id; void main() { \
        v_id = float(gl_VertexID); gl_PointSize = 4.0; gl_Position = vec4(a_pos, 0.0, 1.0); }";
    let fragment = "precision mediump float; varying float v_id; void main() { \
        gl_FragColor = vec4(v_id / 4.0, 0.0, 0.0, 1.0); }";
    let buffer = points_buffer(&[[0.0, 0.0], [1.1, 0.0], [-0.5, 0.5]]);
    let layer = layer_with_vertex(
        vertex,
        &[("p", fragment)],
        &format!(r#", "pts": "{buffer}""#),
        "",
        &points_draw(1, 2, ""),
    );
    let frame = render(&layer);
    assert_eq!(
        px(&frame, 15, 8)[..3],
        [0, 0, 0],
        "the point centred at x = 1.1 draws nothing"
    );
    assert_eq!(
        px(&frame, 8, 8)[..3],
        [0, 0, 0],
        "point 0 is before `first`"
    );
    near(px(&frame, 3, 3), [127, 0, 0, 255], 2);
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

/// A shader group of the 16 x 16 scene: a rect covering the left half in red
/// (`a`), one covering the top half in blue (`b`), and `fragment` over them,
/// which samples both.
fn shader_group(fragment: &str) -> String {
    let rect = |id: &str, w: u32, h: u32, color: &str| {
        format!(
            r##"{{"id": "{id}", "type": "shape", "shape": {{"kind": "rect", "width": {w}, "height": {h}}},
                "fill": "{color}"}}"##
        )
    };
    let unit = |n: u32, texture: &str| {
        format!(
            r#""{n}": {{"texture": "{texture}", "min": "NEAREST", "mag": "NEAREST",
                         "wrapS": "CLAMP_TO_EDGE", "wrapT": "CLAMP_TO_EDGE"}}"#
        )
    };
    format!(
        r#"{{"id": "pass", "type": "group", "children": [{}, {}],
            "glsl": {{"width": 16, "height": 16, "programs": {{"p": {{"vertex": {}, "fragment": {},
                       "attributes": {{"a_pos": 0}}}}}},
              "buffers": {{"quad": "{}"}},
              "textures": {{"a": {{"layer": "a"}}, "b": {{"layer": "b"}}}},
              "ops": [{}]}}}}"#,
        rect("a", 8, 16, "#ff0000"),
        rect("b", 16, 8, "#0000ff"),
        serde_json::to_string(QUAD_VERTEX_ES1).unwrap(),
        serde_json::to_string(fragment).unwrap(),
        quad(),
        draw(&format!(
            r#""uniforms": {{"u_a": [{{"kind": "i", "value": [0]}}], "u_b": [{{"kind": "i", "value": [1]}}]}},
               "units": {{{}, {}}}"#,
            unit(0, "a"),
            unit(1, "b")
        )),
    )
}

#[test]
fn a_shader_group_samples_its_children_as_pictures() {
    // Where `b` is blue (the top half) the shader shows `b`, elsewhere `a`;
    // the rows count from the top of the group, as the pictures' do.
    let frame = render(&shader_group(
        "precision mediump float; varying vec2 v_uv; uniform sampler2D u_a; uniform sampler2D u_b; \
         void main() { vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y); \
         gl_FragColor = uv.y < 0.5 ? texture2D(u_b, uv) : texture2D(u_a, uv); }",
    ));
    assert_eq!(px(&frame, 12, 3), [0, 0, 255, 255]);
    assert_eq!(px(&frame, 3, 3), [0, 0, 255, 255]);
    assert_eq!(px(&frame, 3, 12), [255, 0, 0, 255]);
    // `a` covers the left half only: the bottom right is the background.
    assert_eq!(px(&frame, 12, 12), [0, 0, 0, 255]);
}

#[test]
fn the_children_of_a_shader_group_are_not_drawn_on_their_own() {
    // The shader paints nothing: neither child shows through.
    let frame = render(&shader_group(
        "precision mediump float; void main() { gl_FragColor = vec4(0.0); }",
    ));
    assert_eq!(px(&frame, 3, 12), [0, 0, 0, 255]);
    assert_eq!(px(&frame, 12, 3), [0, 0, 0, 255]);
}

#[test]
fn a_shader_group_names_children_it_has() {
    let json = shader_group("precision mediump float; void main() { gl_FragColor = vec4(1.0); }")
        .replace(r#""layer": "b""#, r#""layer": "nope""#);
    let json = format!(
        r##"{{"width": 16, "height": 16, "fps": 30, "durationInFrames": 1, "layers": [{json}]}}"##
    );
    let Error::Scene(message) = Scene::from_json(&json, Default::default()).unwrap_err() else {
        panic!("not a scene error")
    };
    assert!(
        message.contains("\"pass\"")
            && message.contains("\"nope\"")
            && message.contains("not one of its children"),
        "{message}"
    );
}

// ---- target textures (a framebuffer's) ----

const FILL: &str = "precision mediump float; uniform vec4 u_color; \
    void main() { gl_FragColor = u_color; }";
const SHOW: &str = "precision mediump float; varying vec2 v_uv; uniform sampler2D u_tex; \
    void main() { gl_FragColor = texture2D(u_tex, v_uv); }";
/// `u_tex * u_scale + u_add`, for a pass that reads a target and writes another.
const MAD: &str = "precision mediump float; varying vec2 v_uv; uniform sampler2D u_tex; \
    uniform vec4 u_scale; uniform vec4 u_add; \
    void main() { gl_FragColor = texture2D(u_tex, v_uv) * u_scale + u_add; }";

/// `"uniforms"` from calls of a name, a kind (`f` or `i`) and values.
fn uniforms(calls: &[(&str, &str, &[f64])]) -> String {
    let calls: Vec<String> = calls
        .iter()
        .map(|(name, kind, value)| {
            format!(r#""{name}": [{{"kind": "{kind}", "value": {value:?}}}]"#)
        })
        .collect();
    format!(r#""uniforms": {{{}}}"#, calls.join(", "))
}

/// The unit 0 of a draw, holding `texture`, nearest and clamped.
fn unit(texture: &str) -> String {
    format!(
        r#""units": {{"0": {{"texture": "{texture}", "min": "NEAREST", "mag": "NEAREST",
            "wrapS": "CLAMP_TO_EDGE", "wrapT": "CLAMP_TO_EDGE"}}}}"#
    )
}

/// The fields of a draw that sample `texture` into `u_tex`.
fn sampling(texture: &str) -> String {
    format!("{}, {}", uniforms(&[("u_tex", "i", &[0.0])]), unit(texture))
}

fn fill(color: [f64; 4]) -> String {
    uniforms(&[("u_color", "f", &color)])
}

/// A `MAD` pass over `texture`.
fn mad(texture: &str, scale: [f64; 4], add: [f64; 4]) -> String {
    format!(
        "{}, {}",
        uniforms(&[
            ("u_tex", "i", &[0.0]),
            ("u_scale", "f", &scale),
            ("u_add", "f", &add),
        ]),
        unit(texture)
    )
}

/// The `textures` of a layer: square target textures by id and side.
fn targets(sides: &[(&str, u32)]) -> String {
    let textures: Vec<String> = sides
        .iter()
        .map(|(id, side)| {
            format!(r#""{id}": {{"target": true, "width": {side}, "height": {side}}}"#)
        })
        .collect();
    format!(r#", "textures": {{{}}}"#, textures.join(", "))
}

fn ops(ops: &[String]) -> String {
    ops.join(", ")
}

fn render_error(layer: &str) -> String {
    render_still(scene_of(layer), 0)
        .err()
        .expect("must fail")
        .to_string()
}

#[test]
fn a_texture_drawn_into_is_sampled_upright() {
    // The coordinates are GL's: red grows to the right and green upwards, in
    // the texture and so on the canvas that shows it.
    let frame = render(&layer_of(
        &[
            (
                "c",
                "precision mediump float; void main() { \
                 gl_FragColor = vec4(gl_FragCoord.x / 8.0, gl_FragCoord.y / 8.0, 0.0, 1.0); }",
            ),
            ("s", SHOW),
        ],
        &targets(&[("rt", 8)]),
        &ops(&[
            draw_with("c", Some(("rt", 8)), ""),
            draw_with("s", None, &sampling("rt")),
        ]),
    ));
    near(px(&frame, 0, 15), [16, 16, 0, 255], 6);
    near(px(&frame, 15, 15), [239, 16, 0, 255], 6);
    near(px(&frame, 0, 0), [16, 239, 0, 255], 6);
}

#[test]
fn clear_scissor_and_winding_follow_gls_rows_in_a_texture() {
    // Blue everywhere, red in the lower half (GL's y counts from the bottom).
    let frame = render(&layer_of(
        &[("f", FILL), ("s", SHOW)],
        &targets(&[("rt", 8)]),
        &ops(&[
            r#"{"op": "clear", "color": [0, 0, 1, 1], "target": "rt"}"#.into(),
            draw_with(
                "f",
                Some(("rt", 8)),
                &format!(r#""scissor": [0, 0, 8, 4], {}"#, fill([1.0, 0.0, 0.0, 1.0])),
            ),
            draw_with("s", None, &sampling("rt")),
        ]),
    ));
    near(px(&frame, 8, 12), [255, 0, 0, 255], 3);
    near(px(&frame, 8, 3), [0, 0, 255, 255], 3);

    // The quad is counter-clockwise: it is a front face when CCW is the front
    // and is culled when CW is, in a texture as on the canvas.
    for (front, want) in [("CCW", [255, 255, 255, 255]), ("CW", [0, 0, 0, 255])] {
        let cull = format!(r#""cull": {{"face": "BACK", "front": "{front}"}}"#);
        let frame = render(&layer_of(
            &[("f", FILL), ("s", SHOW)],
            &targets(&[("rt", 8)]),
            &ops(&[
                draw_with("f", Some(("rt", 8)), &format!("{cull}, {}", fill([1.0; 4]))),
                draw_with("s", None, &sampling("rt")),
            ]),
        ));
        near(px(&frame, 8, 8), want, 2);
    }
}

#[test]
fn two_textures_ping_pong() {
    // a = (0.1, 0.2, 0.3); b = a * 2; a = b + 0.05; the canvas shows a.
    let frame = render(&layer_of(
        &[("f", FILL), ("m", MAD), ("s", SHOW)],
        &targets(&[("a", 8), ("b", 8)]),
        &ops(&[
            draw_with("f", Some(("a", 8)), &fill([0.1, 0.2, 0.3, 1.0])),
            draw_with(
                "m",
                Some(("b", 8)),
                &mad("a", [2.0, 2.0, 2.0, 1.0], [0.0; 4]),
            ),
            draw_with(
                "m",
                Some(("a", 8)),
                &mad("b", [1.0; 4], [0.05, 0.05, 0.05, 0.0]),
            ),
            draw_with("s", None, &sampling("a")),
        ]),
    ));
    near(px(&frame, 8, 8), [65, 117, 166, 255], 6);
}

#[test]
fn the_drawing_buffer_sees_a_texture_as_it_was_when_it_drew() {
    // Red is drawn into the texture and shown on all of the canvas; then the
    // texture is blue and shown on the lower half only.
    let frame = render(&layer_of(
        &[("f", FILL), ("s", SHOW)],
        &targets(&[("rt", 8)]),
        &ops(&[
            draw_with("f", Some(("rt", 8)), &fill([1.0, 0.0, 0.0, 1.0])),
            draw_with("s", None, &sampling("rt")),
            draw_with("f", Some(("rt", 8)), &fill([0.0, 0.0, 1.0, 1.0])),
            draw_with(
                "s",
                None,
                &format!(r#""scissor": [0, 0, 16, 8], {}"#, sampling("rt")),
            ),
        ]),
    ));
    near(px(&frame, 8, 3), [255, 0, 0, 255], 3);
    near(px(&frame, 8, 12), [0, 0, 255, 255], 3);
}

#[test]
fn a_clear_of_the_drawing_buffer_keeps_what_the_textures_were_given() {
    let frame = render(&layer_of(
        &[("f", FILL), ("s", SHOW)],
        &targets(&[("rt", 8)]),
        &ops(&[
            draw_with("f", Some(("rt", 8)), &fill([0.0, 1.0, 0.0, 1.0])),
            r#"{"op": "clear", "color": [1, 0, 0, 1]}"#.into(),
            draw_with("s", None, &sampling("rt")),
        ]),
    ));
    assert_eq!(px(&frame, 8, 8), [0, 255, 0, 255]);
}

#[test]
fn a_texture_nothing_drew_into_is_transparent_black() {
    let frame = render(&layer_of(
        &[("s", SHOW)],
        &targets(&[("rt", 8)]),
        &draw_with("s", None, &sampling("rt")),
    ));
    assert_eq!(px(&frame, 8, 8), [0, 0, 0, 255]);
}

#[test]
fn a_draw_that_samples_its_own_target_is_refused() {
    let error = render_error(&layer_of(
        &[("s", SHOW)],
        &targets(&[("rt", 8)]),
        &draw_with("s", Some(("rt", 8)), &sampling("rt")),
    ));
    assert!(error.contains("renders to"), "{error}");
}

#[test]
fn a_target_must_be_a_target_texture_of_a_size_the_device_draws() {
    let pixels = b64(&[255, 0, 0, 255]);
    let plain =
        format!(r#", "textures": {{"rt": {{"pixels": "{pixels}", "width": 1, "height": 1}}}}"#);
    let error = render_error(&layer_of(
        &[("f", FILL)],
        &plain,
        &draw_with("f", Some(("rt", 1)), ""),
    ));
    assert!(error.contains("not a target texture"), "{error}");
    let error = render_error(&layer_of(
        &[("f", FILL)],
        "",
        &draw_with("f", Some(("gone", 1)), ""),
    ));
    assert!(error.contains("not a target texture"), "{error}");

    for side in [0, 8193] {
        let error = render_error(&layer_of(
            &[("f", FILL)],
            &targets(&[("rt", side)]),
            &draw_with("f", Some(("rt", 8)), ""),
        ));
        assert!(error.contains("render target"), "{error}");
    }

    // Two of the largest and a third cannot all be held.
    let clears: Vec<String> = ["a", "b", "c"]
        .iter()
        .map(|id| format!(r#"{{"op": "clear", "color": [0, 0, 0, 1], "target": "{id}"}}"#))
        .collect();
    let error = render_error(&layer_of(
        &[("f", FILL)],
        &targets(&[("a", 8192), ("b", 8192), ("c", 8192)]),
        &ops(&clears),
    ));
    assert!(error.contains("MiB"), "{error}");
}

#[test]
fn a_viewport_outside_its_target_is_refused() {
    let error = render_error(&layer_of(
        &[("f", FILL)],
        &targets(&[("rt", 8)]),
        &draw_with("f", Some(("rt", 16)), ""),
    ));
    assert!(error.contains("reaches outside the 8 x 8"), "{error}");
}

// ---- blitFramebuffer ----

/// A draw of the quad with the program `program` into the `[x, y, w, h]` of the drawing buffer.
fn draw_in(program: &str, viewport: [i32; 4], extra: &str) -> String {
    format!(
        r#"{{"op": "draw", "program": "{program}", "mode": "triangles", "first": 0, "count": 6,
            "attributes": {}, "viewport": {viewport:?}, {extra}}}"#,
        quad_attributes()
    )
}

/// A `blitFramebuffer` of `from` to `to`; the drawing buffer is `None`.
fn blit_op(
    src: Option<&str>,
    target: Option<&str>,
    from: [i32; 4],
    to: [i32; 4],
    linear: bool,
) -> String {
    let src = src.map_or(String::new(), |s| format!(r#", "src": "{s}""#));
    let target = target.map_or(String::new(), |s| format!(r#", "target": "{s}""#));
    format!(r#"{{"op": "blit", "from": {from:?}, "to": {to:?}, "linear": {linear}{src}{target}}}"#)
}

/// Red in the left half of the 16 x 16 drawing buffer, blue in its lower right quadrant.
fn red_and_blue() -> Vec<String> {
    vec![
        draw_in("f", [0, 0, 8, 16], &fill([1.0, 0.0, 0.0, 1.0])),
        draw_in("f", [8, 0, 8, 8], &fill([0.0, 0.0, 1.0, 1.0])),
    ]
}

#[test]
fn a_blit_copies_the_drawing_buffer_into_a_texture_as_it_was() {
    // Copied, then the drawing buffer is cleared: the texture still has the picture, upright.
    let mut all = red_and_blue();
    all.push(blit_op(
        None,
        Some("t"),
        [0, 0, 16, 16],
        [0, 0, 16, 16],
        false,
    ));
    all.push(r#"{"op": "clear", "color": [0, 0, 0, 1]}"#.into());
    all.push(draw_in("s", [0, 0, 16, 16], &sampling("t")));
    let frame = render(&layer_of(
        &[("f", FILL), ("s", SHOW)],
        &targets(&[("t", 16)]),
        &ops(&all),
    ));
    assert_eq!(px(&frame, 3, 3), [255, 0, 0, 255]);
    assert_eq!(px(&frame, 3, 12), [255, 0, 0, 255]);
    assert_eq!(px(&frame, 12, 12), [0, 0, 255, 255]);
    assert_eq!(px(&frame, 12, 3), [0, 0, 0, 255]);
}

#[test]
fn a_blit_mirrors_and_stretches_by_its_rectangles() {
    // The picture mirrored into the texture: red is then on its right, blue at its lower left.
    // The texture's right half is shrunk by LINEAR into the buffer's lower left quadrant.
    let mut all = red_and_blue();
    all.push(blit_op(
        None,
        Some("t"),
        [0, 0, 16, 16],
        [16, 0, 0, 16],
        false,
    ));
    all.push(r#"{"op": "clear", "color": [0, 1, 0, 1]}"#.into());
    all.push(blit_op(Some("t"), None, [8, 0, 16, 16], [0, 0, 8, 8], true));
    let frame = render(&layer_of(
        &[("f", FILL)],
        &targets(&[("t", 16)]),
        &ops(&all),
    ));
    near(px(&frame, 3, 12), [255, 0, 0, 255], 2);
    near(px(&frame, 3, 9), [255, 0, 0, 255], 2);
    assert_eq!(px(&frame, 12, 12), [0, 255, 0, 255]);
    assert_eq!(px(&frame, 3, 3), [0, 255, 0, 255]);
}

#[test]
fn a_blit_within_one_buffer_is_refused() {
    let error = render_error(&layer_of(
        &[("f", FILL)],
        &targets(&[("t", 16)]),
        &blit_op(Some("t"), Some("t"), [0, 0, 4, 4], [4, 4, 8, 8], false),
    ));
    assert!(error.contains("same buffer"), "{error}");
}

// ---- texSubImage2D into a target ----

fn upload_op(target: &str, at: [u32; 2], size: [u32; 2], rgba: &[u8], flags: &str) -> String {
    format!(
        r#"{{"op": "upload", "target": "{target}", "x": {}, "y": {}, "width": {}, "height": {},
            "pixels": "{}"{flags}}}"#,
        at[0],
        at[1],
        size[0],
        size[1],
        b64(rgba)
    )
}

#[test]
fn an_upload_writes_pixels_over_what_the_target_holds_at_its_offset() {
    // Blue everywhere, a 2 x 2 red patch at (2, 3), then a draw over it that keeps the
    // blue: the patch is after the clear and before the second draw.
    let red = [255u8, 0, 0, 255].repeat(4);
    let mut all = vec![
        r#"{"op": "clear", "color": [0, 0, 1, 1], "target": "t"}"#.to_string(),
        upload_op("t", [2, 3], [2, 2], &red, ""),
    ];
    all.push(draw_in("s", [0, 0, 16, 16], &sampling("t")));
    let frame = render(&layer_of(
        &[("s", SHOW)],
        &targets(&[("t", 16)]),
        &ops(&all),
    ));
    // GL's rows 3 and 4 of the texture are the canvas's rows 12 and 11.
    assert_eq!(px(&frame, 2, 12), [255, 0, 0, 255]);
    assert_eq!(px(&frame, 3, 11), [255, 0, 0, 255]);
    assert_eq!(px(&frame, 4, 12), [0, 0, 255, 255]);
    assert_eq!(px(&frame, 2, 10), [0, 0, 255, 255]);
    assert_eq!(px(&frame, 0, 0), [0, 0, 255, 255]);
}

#[test]
fn an_upload_honours_flip_y_and_premultiply_and_keeps_its_place_among_draws() {
    // A 1 x 2 patch, red above green, flipped; half-transparent white premultiplied elsewhere.
    let patch = [255u8, 0, 0, 255, 0, 255, 0, 255];
    let all = vec![
        r#"{"op": "clear", "color": [0, 0, 0, 1], "target": "t"}"#.to_string(),
        upload_op("t", [0, 0], [1, 2], &patch, r#", "flipY": true"#),
        upload_op(
            "t",
            [1, 0],
            [1, 1],
            &[255, 255, 255, 128],
            r#", "premultiply": true"#,
        ),
        // Drawn after the uploads, over the lower half only.
        draw_in(
            "f",
            [0, 0, 16, 16],
            &format!(
                r#""scissor": [2, 0, 14, 16], {}"#,
                fill([1.0, 1.0, 0.0, 1.0])
            ),
        )
        .replace(r#""viewport""#, r#""target": "t", "viewport""#),
        draw_in("s", [0, 0, 16, 16], &sampling("t")),
    ];
    let frame = render(&layer_of(
        &[("f", FILL), ("s", SHOW)],
        &targets(&[("t", 16)]),
        &ops(&all),
    ));
    // Flipped: the green row is the texture's row 0 (canvas row 15), the red one row 1.
    assert_eq!(px(&frame, 0, 15), [0, 255, 0, 255]);
    assert_eq!(px(&frame, 0, 14), [255, 0, 0, 255]);
    // Half-transparent white, placed over black in linear light.
    near(px(&frame, 1, 15), [188, 188, 188, 255], 3);
    // The draw covers what is right of x = 2, over the uploads' black.
    assert_eq!(px(&frame, 5, 15), [255, 255, 0, 255]);
}

// ---- instancing ----

#[test]
fn instanced_draws_advance_attributes_with_a_divisor_per_instance_and_count_gl_instance_id() {
    let vertex = "#version 300 es\nin vec2 a_pos; in vec2 a_off; out float v_i; \
        void main() { v_i = float(gl_InstanceID); \
        gl_Position = vec4(a_pos * 0.25 + a_off, 0.0, 1.0); }";
    let fragment = "#version 300 es\nprecision mediump float; in float v_i; out vec4 o; \
        void main() { o = vec4(1.0 - v_i, v_i, 0.0, 1.0); }";
    let offsets = points_buffer(&[[-0.5, -0.5], [0.5, 0.5]]);
    let draw = format!(
        r#"{{"op": "draw", "program": "p", "mode": "triangles", "first": 0, "count": 6, "instances": 2,
            "attributes": {}, "viewport": [0, 0, 16, 16]}}"#,
        quad_attributes().replacen(
            "}}",
            r#"}, "a_off": {"buffer": "off", "size": 2, "type": "f32", "divisor": 1}}"#,
            1
        )
    );
    let frame = render(&layer_with_vertex(
        vertex,
        &[("p", fragment)],
        &format!(r#", "off": "{offsets}""#),
        "",
        &draw,
    ));
    // Instance 0 at the lower left (2 pixels each way from (4, 4) up), instance 1 at the upper right.
    assert_eq!(px(&frame, 4, 12), [255, 0, 0, 255]);
    assert_eq!(px(&frame, 12, 4), [0, 255, 0, 255]);
    assert_eq!(px(&frame, 4, 4)[..3], [0, 0, 0]);
    assert_eq!(px(&frame, 12, 12)[..3], [0, 0, 0]);
}

// ---- the depth test ----

const Z_VERTEX: &str = "attribute vec2 a_pos; uniform float u_z; varying vec2 v_uv; \
    void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, u_z, 1.0); }";
const RED: [f64; 4] = [1.0, 0.0, 0.0, 1.0];
const GREEN: [f64; 4] = [0.0, 1.0, 0.0, 1.0];
const BLUE: [f64; 4] = [0.0, 0.0, 1.0, 1.0];

fn depth_state(func: &str, mask: bool, near: f64, far: f64) -> String {
    format!(r#""depth": {{"func": "{func}", "mask": {mask}, "near": {near}, "far": {far}}}"#)
}

/// A draw of the quad at clip depth `z` (window depth `(z + 1) / 2`) in `color`, with `state`.
fn z_draw(z: f64, color: [f64; 4], state: &str) -> String {
    let uniforms = uniforms(&[("u_z", "f", &[z]), ("u_color", "f", &color)]);
    draw(&if state.is_empty() {
        uniforms
    } else {
        format!("{uniforms}, {state}")
    })
}

fn z_layer(extra_content: &str, draws: &[String]) -> Frame {
    render(&layer_with_vertex(
        Z_VERTEX,
        &[("p", FILL), ("s", SHOW)],
        "",
        extra_content,
        &ops(draws),
    ))
}

fn centre(frame: &Frame) -> [u8; 4] {
    px(frame, 8, 8)
}

#[test]
fn the_depth_test_keeps_the_nearer_draw_in_any_order() {
    let less = depth_state("LESS", true, 0.0, 1.0);
    // Red is nearer than green, drawn first or last; blue is nearer than both.
    let a = z_layer("", &[z_draw(-0.5, RED, &less), z_draw(0.5, GREEN, &less)]);
    let b = z_layer("", &[z_draw(0.5, GREEN, &less), z_draw(-0.5, RED, &less)]);
    assert_eq!(centre(&a), [255, 0, 0, 255]);
    assert_eq!(centre(&b), [255, 0, 0, 255]);
    let c = z_layer(
        "",
        &[
            z_draw(0.0, RED, &less),
            z_draw(0.5, GREEN, &less),
            z_draw(-0.9, BLUE, &less),
        ],
    );
    assert_eq!(centre(&c), [0, 0, 255, 255]);
    // The same draws with no depth test are painter's order.
    let d = z_layer("", &[z_draw(-0.5, RED, ""), z_draw(0.5, GREEN, "")]);
    assert_eq!(centre(&d), [0, 255, 0, 255]);
}

#[test]
fn each_depth_function_passes_the_draws_it_should() {
    // Red is stored at window depth 0.5 (ALWAYS, so it is drawn); green is tried at 0.25, 0.5 and 0.75.
    let table: [(&str, [bool; 3]); 8] = [
        ("NEVER", [false, false, false]),
        ("LESS", [true, false, false]),
        ("EQUAL", [false, true, false]),
        ("LEQUAL", [true, true, false]),
        ("GREATER", [false, false, true]),
        ("NOTEQUAL", [true, false, true]),
        ("GEQUAL", [false, true, true]),
        ("ALWAYS", [true, true, true]),
    ];
    for (func, passes) in table {
        for (z, pass) in [-0.5, 0.0, 0.5].into_iter().zip(passes) {
            let frame = z_layer(
                "",
                &[
                    z_draw(0.0, RED, &depth_state("ALWAYS", true, 0.0, 1.0)),
                    z_draw(z, GREEN, &depth_state(func, true, 0.0, 1.0)),
                ],
            );
            let want = if pass {
                [0, 255, 0, 255]
            } else {
                [255, 0, 0, 255]
            };
            assert_eq!(centre(&frame), want, "{func} at z = {z}");
        }
    }
}

#[test]
fn a_draw_with_the_depth_mask_off_tests_but_writes_no_depth() {
    // Red tests against the cleared depth but leaves it at 1, so the farther green passes too.
    let frame = z_layer(
        "",
        &[
            z_draw(-0.5, RED, &depth_state("LESS", false, 0.0, 1.0)),
            z_draw(0.5, GREEN, &depth_state("LESS", true, 0.0, 1.0)),
        ],
    );
    assert_eq!(centre(&frame), [0, 255, 0, 255]);
}

#[test]
fn clear_depth_resets_the_depth_buffer_to_its_value_and_a_colour_clear_leaves_it() {
    let less = depth_state("LESS", true, 0.0, 1.0);
    // A depth clear to 1 lets a farther draw pass again.
    let frame = z_layer(
        "",
        &[
            z_draw(-0.5, RED, &less),
            r#"{"op": "clear", "depth": 1}"#.into(),
            z_draw(0.5, GREEN, &less),
        ],
    );
    assert_eq!(centre(&frame), [0, 255, 0, 255]);
    // A depth clear to 0.25 stops a draw at window depth 0.5 and lets one at 0.125 in.
    let stopped = z_layer(
        "",
        &[
            r#"{"op": "clear", "color": [0, 0, 0, 1], "depth": 0.25}"#.into(),
            z_draw(0.0, RED, &less),
        ],
    );
    assert_eq!(centre(&stopped), [0, 0, 0, 255]);
    let passed = z_layer(
        "",
        &[
            r#"{"op": "clear", "color": [0, 0, 0, 1], "depth": 0.25}"#.into(),
            z_draw(-0.75, GREEN, &less),
        ],
    );
    assert_eq!(centre(&passed), [0, 255, 0, 255]);
    // A colour clear alone clears the picture, not the depth: the farther draw fails against red's depth.
    let frame = z_layer(
        "",
        &[
            z_draw(-0.5, RED, &less),
            r#"{"op": "clear", "color": [0, 0, 1, 1]}"#.into(),
            z_draw(0.5, GREEN, &less),
        ],
    );
    assert_eq!(centre(&frame), [0, 0, 255, 255]);
}

#[test]
fn depth_range_maps_the_window_depth() {
    // Red at clip depth 0 with the range 0..0.2 is at window depth 0.1, nearer than green at 0.25.
    let frame = z_layer(
        "",
        &[
            z_draw(0.0, RED, &depth_state("LESS", true, 0.0, 0.2)),
            z_draw(-0.5, GREEN, &depth_state("LESS", true, 0.0, 1.0)),
        ],
    );
    assert_eq!(centre(&frame), [255, 0, 0, 255]);
}

#[test]
fn a_polygon_offset_pulls_a_coplanar_draw_through() {
    // Two draws at one depth: LESS refuses the second, unless a negative offset moves it nearer.
    let offset = r#""polygonOffset": {"factor": -1, "units": -1}"#;
    let less = depth_state("LESS", true, 0.0, 1.0);
    let plain = z_layer("", &[z_draw(0.0, RED, &less), z_draw(0.0, GREEN, &less)]);
    assert_eq!(centre(&plain), [255, 0, 0, 255]);
    let pulled = z_layer(
        "",
        &[
            z_draw(0.0, RED, &less),
            z_draw(0.0, GREEN, &format!("{less}, {offset}")),
        ],
    );
    assert_eq!(centre(&pulled), [0, 255, 0, 255]);
}

#[test]
fn a_framebuffer_tests_against_its_own_depth_buffer() {
    let less = depth_state("LESS", true, 0.0, 1.0);
    let into_rt = |z: f64, color: [f64; 4], state: &str| {
        let uniforms = uniforms(&[("u_z", "f", &[z]), ("u_color", "f", &color)]);
        draw_with(
            "p",
            Some(("rt", 8)),
            &format!(r#"{uniforms}, {state}, "depthStencil": "rtd""#),
        )
    };
    let textures = r#", "textures": {"rt": {"target": true, "width": 8, "height": 8},
        "rtd": {"target": true, "width": 8, "height": 8, "format": "depth"}}"#;
    // The blue draw is farther than the red one in the target, so red shows on the canvas.
    let frame = z_layer(
        textures,
        &[
            into_rt(-0.5, RED, &less),
            into_rt(0.5, BLUE, &less),
            draw_with("s", None, &sampling("rt")),
        ],
    );
    near(px(&frame, 8, 8), [255, 0, 0, 255], 2);
    // A depth clear of the target alone lets the farther draw in.
    let frame = z_layer(
        textures,
        &[
            into_rt(-0.5, RED, &less),
            r#"{"op": "clear", "depth": 1, "target": "rt", "depthStencil": "rtd"}"#.into(),
            into_rt(0.5, BLUE, &less),
            draw_with("s", None, &sampling("rt")),
        ],
    );
    near(px(&frame, 8, 8), [0, 0, 255, 255], 2);
}

#[test]
fn a_program_with_ten_attributes_draws() {
    // Each attribute is a vertex buffer of its own to the GPU, and a device allows eight by default; the engine's
    // device asks for more. Ten attributes all read the quad; the colour sums nine of them.
    let names: Vec<String> = (0..10).map(|i| format!("a{i}")).collect();
    let declarations: String = names
        .iter()
        .map(|n| format!("attribute vec2 {n}; "))
        .collect();
    let sum: String = names[1..]
        .iter()
        .map(|n| format!("{n}.x"))
        .collect::<Vec<_>>()
        .join(" + ");
    let vertex = format!(
        "{declarations}varying float v_sum; void main() {{ v_sum = {sum}; gl_Position = vec4(a0, 0.0, 1.0); }}"
    );
    let fragment = "precision mediump float; varying float v_sum; \
        void main() { gl_FragColor = vec4(0.5 + v_sum / 18.0, 0.0, 0.0, 1.0); }";
    let locations: Vec<String> = names
        .iter()
        .enumerate()
        .map(|(i, n)| format!(r#""{n}": {i}"#))
        .collect();
    let attributes: Vec<String> = names
        .iter()
        .map(|n| format!(r#""{n}": {{"buffer": "quad", "size": 2, "type": "f32", "normalized": false, "stride": 0, "offset": 0}}"#))
        .collect();
    let draw = format!(
        r#"{{"op": "draw", "program": "p", "mode": "triangles", "first": 0, "count": 6,
            "attributes": {{{}}}, "viewport": [0, 0, 16, 16]}}"#,
        attributes.join(", ")
    );
    let layer = format!(
        r#"{{"id": "g", "type": "glsl", "width": 16, "height": 16,
            "programs": {{"p": {{"vertex": {}, "fragment": {}, "attributes": {{{}}}}}}},
            "buffers": {{"quad": "{}"}}, "ops": [{draw}]}}"#,
        serde_json::to_string(&vertex).unwrap(),
        serde_json::to_string(fragment).unwrap(),
        locations.join(", "),
        quad()
    );
    let frame = render(&layer);
    near(px(&frame, 15, 8), [250, 0, 0, 255], 12);
    near(px(&frame, 0, 8), [5, 0, 0, 255], 12);
}

// ---- stencil, several outputs, depth textures, levels, depth and stencil blits ----

/// The quad at the depth `u_z` (clip space), in GLSL ES 3.00.
const QUAD_VERTEX_ES3_Z: &str = "#version 300 es\nin vec2 a_pos; out vec2 v_uv; uniform float u_z; \
    void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, u_z, 1.0); }";
const FILL_ES3: &str = "#version 300 es\nprecision mediump float; uniform vec4 u_color; out vec4 o; \
    void main() { o = u_color; }";
const SHOW_ES3: &str = "#version 300 es\nprecision highp float; in vec2 v_uv; uniform highp sampler2D u_tex; \
    uniform float u_lod; out vec4 o; void main() { o = textureLod(u_tex, v_uv, u_lod); }";

/// A layer of ES 3.00 programs (`programs`: id and fragment shader) on the `u_z` quad.
fn layer_es3(programs: &[(&str, &str)], extra_content: &str, ops: &str) -> String {
    layer_with_vertex(QUAD_VERTEX_ES3_Z, programs, "", extra_content, ops)
}

/// A stencil test that does `zpass` on both faces with `func` against `reference`.
fn stencil(func: &str, reference: u32, zpass: &str) -> String {
    format!(
        r#""stencil": {{"ref": {reference}, "valueMask": 255, "writeMask": 255,
            "front": {{"func": "{func}", "fail": "KEEP", "zfail": "KEEP", "zpass": "{zpass}"}},
            "back": {{"func": "{func}", "fail": "KEEP", "zfail": "KEEP", "zpass": "{zpass}"}}}}"#
    )
}

/// The uniforms of `FILL_ES3` on the quad at `z`.
fn z_fill(z: f64, color: [f64; 4]) -> String {
    uniforms(&[("u_z", "f", &[z]), ("u_color", "f", &color)])
}

/// A draw of `SHOW_ES3` over `viewport` of the drawing buffer, reading level `lod` of `texture`.
fn show_level(texture: &str, viewport: [i32; 4], lod: f64) -> String {
    draw_in(
        "s3",
        viewport,
        &format!(
            "{}, {}",
            uniforms(&[("u_tex", "i", &[0.0]), ("u_lod", "f", &[lod])]),
            unit(texture)
        ),
    )
}

/// A depth test with GL's defaults but `func`.
fn depth(func: &str) -> String {
    format!(r#""depth": {{"func": "{func}", "mask": true, "near": 0, "far": 1}}"#)
}

#[test]
fn the_stencil_test_keeps_a_draw_where_an_earlier_one_marked_the_buffer() {
    // The left half marks the stencil with 1; a green quad over everything passes only there.
    let all = ops(&[
        r#"{"op": "clear", "color": [0, 0, 0, 1], "stencil": 0}"#.to_string(),
        draw_in(
            "f",
            [0, 0, 8, 16],
            &format!(
                "{}, {}",
                z_fill(0.0, [0.0, 0.0, 1.0, 1.0]),
                stencil("ALWAYS", 1, "REPLACE")
            ),
        ),
        draw_in(
            "f",
            [0, 0, 16, 16],
            &format!(
                "{}, {}",
                z_fill(0.0, [0.0, 1.0, 0.0, 1.0]),
                stencil("EQUAL", 1, "KEEP")
            ),
        ),
    ]);
    let frame = render(&layer_es3(&[("f", FILL_ES3)], r#", "stencil": true"#, &all));
    assert_eq!(px(&frame, 3, 8), [0, 255, 0, 255]);
    assert_eq!(px(&frame, 12, 8), [0, 0, 0, 255]);

    // A framebuffer's stencil renderbuffer does the same, upside down as a framebuffer is.
    let textures = r#", "textures": {"c": {"target": true, "width": 16, "height": 16},
        "s": {"target": true, "width": 16, "height": 16, "format": "stencil"}}"#;
    let fb = r#""target": "c", "depthStencil": "s""#;
    let all = ops(&[
        format!(r#"{{"op": "clear", "color": [0, 0, 0, 1], "stencil": 0, {fb}}}"#),
        draw_in(
            "f",
            [0, 0, 16, 8],
            &format!(
                "{}, {}, {fb}",
                z_fill(0.0, [0.0, 0.0, 1.0, 1.0]),
                stencil("ALWAYS", 7, "REPLACE")
            ),
        ),
        draw_in(
            "f",
            [0, 0, 16, 16],
            &format!(
                "{}, {}, {fb}",
                z_fill(0.0, [1.0, 0.0, 0.0, 1.0]),
                stencil("NOTEQUAL", 7, "KEEP")
            ),
        ),
        show_level("c", [0, 0, 16, 16], 0.0),
    ]);
    let frame = render(&layer_es3(
        &[("f", FILL_ES3), ("s3", SHOW_ES3)],
        textures,
        &all,
    ));
    // GL's lower half (marked) keeps its blue; the upper half turns red.
    assert_eq!(px(&frame, 8, 12), [0, 0, 255, 255]);
    assert_eq!(px(&frame, 8, 3), [255, 0, 0, 255]);
}

#[test]
fn a_draw_writes_each_output_to_its_attachment() {
    let mrt = "#version 300 es\nprecision mediump float; layout(location = 0) out vec4 a; \
        layout(location = 1) out vec4 b; void main() { a = vec4(1.0, 0.0, 0.0, 1.0); b = vec4(0.0, 0.0, 1.0, 1.0); }";
    let textures = r#", "textures": {"a": {"target": true, "width": 16, "height": 16},
        "b": {"target": true, "width": 16, "height": 16}}"#;
    for (outputs, left) in [
        (r#"[{"target": "a"}, {"target": "b"}]"#, [255, 0, 0, 255]),
        // NONE for output 0: only b is written, and a shows the black behind the layer.
        (r#"[null, {"target": "b"}]"#, [0, 0, 0, 255]),
    ] {
        let all = ops(&[
            draw_in(
                "m",
                [0, 0, 16, 16],
                &format!(r#"{}, "outputs": {outputs}"#, z_fill(0.0, [0.0; 4])),
            ),
            show_level("a", [0, 0, 8, 16], 0.0),
            show_level("b", [8, 0, 8, 16], 0.0),
        ]);
        let frame = render(&layer_es3(&[("m", mrt), ("s3", SHOW_ES3)], textures, &all));
        assert_eq!(px(&frame, 3, 8), left, "{outputs}");
        assert_eq!(px(&frame, 12, 8), [0, 0, 255, 255], "{outputs}");
    }
}

#[test]
fn a_depth_texture_is_drawn_into_and_sampled_as_its_depth() {
    // A quad at z 0.5 (depth 0.75) into the depth texture, which the canvas then samples as (d, 0, 0, 1);
    // one nothing drew into holds 1, as a browser's new depth texture does.
    let textures = r#", "textures": {"c": {"target": true, "width": 16, "height": 16},
        "d": {"target": true, "width": 16, "height": 16, "format": "depth"},
        "e": {"target": true, "width": 16, "height": 16, "format": "depthStencil"}}"#;
    let all = ops(&[
        draw_in(
            "f",
            [0, 0, 16, 16],
            &format!(
                r#"{}, {}, "target": "c", "depthStencil": "d""#,
                z_fill(0.5, [0.0, 1.0, 0.0, 1.0]),
                depth("ALWAYS")
            ),
        ),
        show_level("d", [0, 0, 8, 16], 0.0),
        show_level("e", [8, 0, 8, 16], 0.0),
    ]);
    let frame = render(&layer_es3(
        &[("f", FILL_ES3), ("s3", SHOW_ES3)],
        textures,
        &all,
    ));
    near(px(&frame, 3, 8), [191, 0, 0, 255], 1);
    assert_eq!(px(&frame, 12, 8), [255, 0, 0, 255]);
}

#[test]
fn a_level_of_a_texture_is_a_target_and_sampled_at_that_level() {
    let textures =
        r#", "textures": {"t": {"target": true, "width": 16, "height": 16, "levels": 3}}"#;
    let all = ops(&[
        draw_in(
            "f",
            [0, 0, 16, 16],
            &format!(r#"{}, "target": "t""#, z_fill(0.0, [1.0, 0.0, 0.0, 1.0])),
        ),
        draw_in(
            "f",
            [0, 0, 8, 8],
            &format!(
                r#"{}, "target": "t", "level": 1"#,
                z_fill(0.0, [0.0, 1.0, 0.0, 1.0])
            ),
        ),
        show_level("t", [0, 0, 8, 16], 0.0),
        // With a filter that reads mipmaps (else the base level is all GL samples), and TEXTURE_MAX_LEVEL at its
        // last level (else three levels of a 16 x 16 texture are incomplete, and it samples black).
        show_level("t", [8, 0, 8, 16], 1.0).replace(
            r#""min": "NEAREST""#,
            r#""maxLevel": 2, "min": "NEAREST_MIPMAP_NEAREST""#,
        ),
    ]);
    let frame = render(&layer_es3(
        &[("f", FILL_ES3), ("s3", SHOW_ES3)],
        textures,
        &all,
    ));
    assert_eq!(px(&frame, 3, 8), [255, 0, 0, 255]);
    assert_eq!(px(&frame, 12, 8), [0, 255, 0, 255]);
}

#[test]
fn a_blit_copies_depth_and_stencil_into_the_drawing_buffer() {
    // A framebuffer's depth-and-stencil buffer gets depth 0.75 and stencil 5 in its left half, and is blitted to
    // the canvas whole. On the canvas a red quad at depth 0.9 is behind the copied depth on the left and in front
    // of the cleared 1 on the right; a green one at depth 0.5 that tests EQUAL 5 shows only on the left.
    let textures = r#", "textures": {"c": {"target": true, "width": 16, "height": 16},
        "ds": {"target": true, "width": 16, "height": 16, "format": "depthStencil"}}"#;
    let fb = r#""target": "c", "depthStencil": "ds""#;
    let all = ops(&[
        draw_in(
            "f",
            [0, 0, 8, 16],
            &format!(
                "{}, {}, {}, {fb}",
                z_fill(0.5, [0.0; 4]),
                depth("ALWAYS"),
                stencil("ALWAYS", 5, "REPLACE")
            ),
        ),
        r#"{"op": "clear", "color": [0, 0, 0, 1], "depth": 1, "stencil": 0}"#.to_string(),
        r#"{"op": "blit", "aspect": "depthStencil", "src": "ds", "from": [0, 0, 16, 16], "to": [0, 0, 16, 16]}"#
            .to_string(),
        draw_in("f", [0, 0, 16, 16], &format!("{}, {}", z_fill(0.8, [1.0, 0.0, 0.0, 1.0]), depth("LESS"))),
        draw_in(
            "f",
            [0, 0, 16, 16],
            &format!(
                "{}, {}, {}",
                z_fill(0.0, [0.0, 1.0, 0.0, 1.0]),
                depth("LESS"),
                stencil("EQUAL", 5, "KEEP")
            ),
        ),
    ]);
    let frame = render(&layer_es3(
        &[("f", FILL_ES3)],
        &format!(r#", "stencil": true{textures}"#),
        &all,
    ));
    assert_eq!(px(&frame, 3, 8), [0, 255, 0, 255]);
    assert_eq!(px(&frame, 12, 8), [255, 0, 0, 255]);
}

/// A PNG of `w` x `h` pixels of one colour, as a `data:` URL.
fn png_url(w: u32, h: u32, rgba: [u8; 4]) -> String {
    let img = image::RgbaImage::from_pixel(w, h, image::Rgba(rgba));
    let mut bytes = Vec::new();
    img.write_to(
        &mut std::io::Cursor::new(&mut bytes),
        image::ImageFormat::Png,
    )
    .unwrap();
    format!("data:image/png;base64,{}", b64(&bytes))
}

#[test]
fn tex_sub_image_2d_lays_a_picture_file_over_a_target_and_over_a_file_texture() {
    let red = png_url(16, 16, [255, 0, 0, 255]);
    let blue = png_url(8, 16, [0, 0, 255, 255]);
    let textures = format!(
        r#", "textures": {{"t": {{"target": true, "width": 16, "height": 16}},
            "f": {{"src": "{red}", "patches": [{{"x": 8, "y": 0, "width": 8, "height": 16, "src": "{blue}"}}]}}}}"#
    );
    let all = ops(&[
        r#"{"op": "clear", "color": [0, 1, 0, 1], "target": "t"}"#.to_string(),
        format!(
            r#"{{"op": "upload", "target": "t", "x": 0, "y": 0, "width": 8, "height": 16, "src": "{blue}"}}"#
        ),
        show_level("t", [0, 0, 8, 16], 0.0),
        show_level("f", [8, 0, 8, 16], 0.0),
    ]);
    let frame = render(&layer_es3(&[("s3", SHOW_ES3)], &textures, &all));
    // The target: blue on its left half, the clear's green on its right; the file texture: red, then blue.
    assert_eq!(px(&frame, 1, 8), [0, 0, 255, 255]);
    assert_eq!(px(&frame, 6, 8), [0, 255, 0, 255]);
    assert_eq!(px(&frame, 9, 8), [255, 0, 0, 255]);
    assert_eq!(px(&frame, 14, 8), [0, 0, 255, 255]);
}

/// A 64 x 64 canvas with a cream background and a group 30 px past it on every side holding a 124 x 124 `glsl`
/// layer of one colour, blurred by `radius` (not at all if 0).
fn overhanging_glsl(radius: u32) -> Scene {
    let effects = if radius > 0 {
        format!(r#""effects": [{{"type": "blur", "radius": {radius}}}],"#)
    } else {
        String::new()
    };
    let glsl = layer(
        "precision mediump float; void main() { gl_FragColor = vec4(0.1, 0.2, 0.6, 1.0); }",
        "",
        &draw(""),
    )
    .replace(r#""width": 16, "height": 16"#, r#""width": 124, "height": 124"#)
    .replace("[0, 0, 16, 16]", "[0, 0, 124, 124]");
    let json = format!(
        r##"{{"width": 64, "height": 64, "fps": 30, "durationInFrames": 1, "background": "#f6d9c3",
            "layers": [{{"id": "over", "type": "group", {effects} "transform": {{"x": -30, "y": -30}},
                "children": [{glsl}]}}]}}"##
    );
    Scene::from_json(&json, Path::new(env!("CARGO_MANIFEST_DIR")).join("tests")).unwrap()
}

#[test]
fn a_blurred_glsl_layer_past_the_canvas_stays_opaque_at_the_edges() {
    // Issue 91: what the wgpu path draws was cut at the canvas before the blur, which faded the frame's edges.
    let sharp = render_still(overhanging_glsl(0), 0).unwrap();
    let blurred = render_still(overhanging_glsl(6), 0).unwrap();
    for (x, y) in [(0, 32), (1, 32), (32, 0), (32, 63), (63, 32), (0, 0), (63, 63)] {
        let (a, b) = (px(&sharp, x, y), px(&blurred, x, y));
        near(b, a, 5);
    }
}

// ---- vertex texture fetch and 3D textures ----

const ES3_QUAD_FRAGMENT: &str = "#version 300 es\nprecision highp float; in vec4 v_col; out vec4 o; \
    void main() { o = v_col; }";

/// A 2 x 1 texture, red then green, as the layer's `textures`.
fn red_green() -> String {
    format!(
        r#", "textures": {{"t": {{"pixels": "{}", "width": 2, "height": 1}}}}"#,
        b64(&[255, 0, 0, 255, 0, 255, 0, 255])
    )
}

#[test]
fn a_vertex_shader_reads_a_texture_at_level_zero() {
    // `texture` in a vertex shader has no derivatives: it reads level 0, with the unit's filter.
    for read in [
        "texture(u_tex, vec2(0.75, 0.5))",
        "texelFetch(u_tex, ivec2(1, 0), 0)",
    ] {
        let vertex = format!(
            "#version 300 es\nin vec2 a_pos; out vec4 v_col; uniform sampler2D u_tex; \
             void main() {{ v_col = {read}; gl_Position = vec4(a_pos, 0.0, 1.0); }}"
        );
        let frame = render(&layer_with_vertex(
            &vertex,
            &[("p", ES3_QUAD_FRAGMENT)],
            "",
            &red_green(),
            &draw(&sampling("t")),
        ));
        assert_eq!(px(&frame, 8, 8), [0, 255, 0, 255], "{read}");
    }
}

#[test]
fn both_stages_share_one_sampler_and_one_unit() {
    // The vertex shader reads the green texel, the fragment shader adds the red one.
    let vertex = "#version 300 es\nin vec2 a_pos; out vec4 v_col; uniform sampler2D u_tex; \
        void main() { v_col = texelFetch(u_tex, ivec2(1, 0), 0); \
        gl_Position = vec4(a_pos, 0.0, 1.0); }";
    let fragment = "#version 300 es\nprecision highp float; in vec4 v_col; uniform sampler2D u_tex; \
        out vec4 o; void main() { o = v_col + texelFetch(u_tex, ivec2(0, 0), 0); }";
    let frame = render(&layer_with_vertex(
        vertex,
        &[("p", fragment)],
        "",
        &red_green(),
        &draw(&sampling("t")),
    ));
    assert_eq!(px(&frame, 8, 8)[..3], [255, 255, 0]);
}

#[test]
fn a_vertex_shader_that_moves_vertices_by_a_texture_draws_them_there() {
    // The texel decides the quad's x offset: red (1.0) moves it out of the clip volume, so nothing is drawn.
    let vertex = "#version 300 es\nin vec2 a_pos; out vec4 v_col; uniform sampler2D u_tex; \
        void main() { float shift = texelFetch(u_tex, ivec2(0, 0), 0).r * 4.0; \
        v_col = vec4(1.0); gl_Position = vec4(a_pos.x + shift, a_pos.y, 0.0, 1.0); }";
    let frame = render(&layer_with_vertex(
        vertex,
        &[("p", ES3_QUAD_FRAGMENT)],
        "",
        &red_green(),
        &draw(&sampling("t")),
    ));
    assert_eq!(px(&frame, 8, 8), [0, 0, 0, 255]);
}

/// A 2 x 2 x 2 RGBA8 texture whose texel (x, y, z) is (x, y, z, 1).
fn volume() -> String {
    let mut texels = Vec::new();
    for z in 0..2u8 {
        for y in 0..2u8 {
            for x in 0..2u8 {
                texels.extend([x * 255, y * 255, z * 255, 255]);
            }
        }
    }
    format!(
        r#", "textures": {{"v": {{"pixels": "{}", "width": 2, "height": 2, "depth": 2}}}}"#,
        b64(&texels)
    )
}

fn volume_unit(filter: &str) -> String {
    format!(
        r#""uniforms": {{"u_vol": [{{"kind": "i", "value": [0]}}]}},
            "units": {{"0": {{"texture": "v", "min": "{filter}", "mag": "{filter}",
                "wrapS": "CLAMP_TO_EDGE", "wrapT": "CLAMP_TO_EDGE", "wrapR": "CLAMP_TO_EDGE"}}}}"#
    )
}

fn volume_fragment(read: &str) -> String {
    format!(
        "#version 300 es\nprecision highp float; precision highp sampler3D; in vec2 v_uv; \
         uniform sampler3D u_vol; out vec4 o; void main() {{ o = {read}; }}"
    )
}

#[test]
fn a_3d_texture_is_fetched_and_sampled_by_x_y_and_z() {
    let fetch = volume_fragment("vec4(texelFetch(u_vol, ivec3(1, 0, 1), 0).rgb, 1.0)");
    let frame = render(&layer_with_vertex(
        QUAD_VERTEX_ES1_AS_ES3,
        &[("p", &fetch)],
        "",
        &volume(),
        &draw(&volume_unit("NEAREST")),
    ));
    assert_eq!(px(&frame, 8, 8), [255, 0, 255, 255]);
    // Sampled at z = 0.75 (the second layer), x and y from the picture: GL's y counts up.
    let sample = volume_fragment("vec4(texture(u_vol, vec3(v_uv, 0.75)).rgb, 1.0)");
    let frame = render(&layer_with_vertex(
        QUAD_VERTEX_ES1_AS_ES3,
        &[("p", &sample)],
        "",
        &volume(),
        &draw(&volume_unit("NEAREST")),
    ));
    assert_eq!(px(&frame, 12, 3), [255, 255, 255, 255]);
    assert_eq!(px(&frame, 3, 12), [0, 0, 255, 255]);
}

#[test]
fn a_3d_texture_filters_trilinearly() {
    let sample = volume_fragment("vec4(texture(u_vol, vec3(0.5, 0.5, 0.5)).rgb, 1.0)");
    let frame = render(&layer_with_vertex(
        QUAD_VERTEX_ES1_AS_ES3,
        &[("p", &sample)],
        "",
        &volume(),
        &draw(&volume_unit("LINEAR")),
    ));
    near(px(&frame, 8, 8), [128, 128, 128, 255], 2);
}

#[test]
fn a_3d_texture_of_half_floats_keeps_values_beyond_one() {
    use base64::Engine as _;
    // Two texels: (0.5, 0.25, 2.0, 1.0) and (4.0, 0.0, 0.0, 1.0).
    let floats: Vec<u8> = [0.5f32, 0.25, 2.0, 1.0, 4.0, 0.0, 0.0, 1.0]
        .iter()
        .flat_map(|f| f.to_le_bytes())
        .collect();
    let content = format!(
        r#", "textures": {{"v": {{"floats": "{}", "width": 2, "height": 1, "depth": 1}}}}"#,
        base64::engine::general_purpose::STANDARD.encode(floats)
    );
    // 2.0 and 4.0 are kept, not clamped to 1: halved, they are 1.0 and 2.0.
    let read = volume_fragment(
        "vec4(texelFetch(u_vol, ivec3(0, 0, 0), 0).rgb * vec3(1.0, 1.0, 0.5) \
         + texelFetch(u_vol, ivec3(1, 0, 0), 0).rgb * 0.0, 1.0)",
    );
    let frame = render(&layer_with_vertex(
        QUAD_VERTEX_ES1_AS_ES3,
        &[("p", &read)],
        "",
        &content,
        &draw(&volume_unit("NEAREST")),
    ));
    near(px(&frame, 8, 8), [128, 64, 255, 255], 2);
    let big = volume_fragment("vec4(texelFetch(u_vol, ivec3(1, 0, 0), 0).r * 0.25, 0.0, 0.0, 1.0)");
    let frame = render(&layer_with_vertex(
        QUAD_VERTEX_ES1_AS_ES3,
        &[("p", &big)],
        "",
        &content,
        &draw(&volume_unit("NEAREST")),
    ));
    assert_eq!(px(&frame, 8, 8), [255, 0, 0, 255]);
}

#[test]
fn a_3d_sampler_with_no_texture_reads_black() {
    let fetch = volume_fragment("texture(u_vol, vec3(0.5))");
    let frame = render(&layer_with_vertex(
        QUAD_VERTEX_ES1_AS_ES3,
        &[("p", &fetch)],
        "",
        "",
        &draw(r#""uniforms": {"u_vol": [{"kind": "i", "value": [0]}]}"#),
    ));
    assert_eq!(px(&frame, 8, 8), [0, 0, 0, 255]);
}

#[test]
fn a_3d_sampler_on_a_unit_holding_a_2d_texture_is_refused() {
    let fetch = volume_fragment("texture(u_vol, vec3(0.5))");
    let e = render_error(&layer_with_vertex(
        QUAD_VERTEX_ES1_AS_ES3,
        &[("p", &fetch)],
        "",
        &red_green(),
        &draw(&volume_unit("NEAREST").replace(r#""v""#, r#""t""#)),
    ));
    assert!(e.contains("3D") && e.contains("2D"), "{e}");
}

const QUAD_VERTEX_ES1_AS_ES3: &str = "#version 300 es\nin vec2 a_pos; out vec2 v_uv; \
    void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }";

/// A float texture of `values` (four floats a texel) as the layer's `textures`.
fn float_texture(values: &[f32], width: u32, float32: bool) -> String {
    use base64::Engine as _;
    let bytes: Vec<u8> = values.iter().flat_map(|f| f.to_le_bytes()).collect();
    format!(
        r#", "textures": {{"f": {{"floats": "{}", "width": {width}, "height": 1, "float32": {float32}}}}}"#,
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

fn float_unit(filter: &str) -> String {
    format!(
        r#""uniforms": {{"u_tex": [{{"kind": "i", "value": [0]}}]}},
            "units": {{"0": {{"texture": "f", "min": "{filter}", "mag": "{filter}",
                "wrapS": "CLAMP_TO_EDGE", "wrapT": "CLAMP_TO_EDGE"}}}}"#
    )
}

fn float_fragment(read: &str) -> String {
    format!(
        "#version 300 es\nprecision highp float; in vec2 v_uv; uniform highp sampler2D u_tex; \
         out vec4 o; void main() {{ o = vec4(vec3({read}), 1.0); }}"
    )
}

fn render_floats(texture: &str, filter: &str, read: &str) -> Frame {
    render(&layer_with_vertex(
        QUAD_VERTEX_ES1_AS_ES3,
        &[("p", &float_fragment(read))],
        "",
        texture,
        &draw(&float_unit(filter)),
    ))
}

// R32F texels, as the red channel and (r, 0, 0, 1).
const R32F: [f32; 16] = [
    0.0, 0.0, 0.0, 1.0, 0.25, 0.0, 0.0, 1.0, 0.5, 0.0, 0.0, 1.0, 2.0, 0.0, 0.0, 1.0,
];

#[test]
fn a_32_bit_float_texture_is_fetched_and_sampled_nearest() {
    let texture = float_texture(&R32F, 4, true);
    let frame = render_floats(&texture, "NEAREST", "texelFetch(u_tex, ivec2(2, 0), 0).r");
    near(px(&frame, 8, 8), [128, 128, 128, 255], 1);
    // Sampled at x = 0.4, the texel [0.25, 0.5): 0.25 / texel 1.
    let frame = render_floats(&texture, "NEAREST", "texture(u_tex, vec2(0.4, 0.5)).r");
    near(px(&frame, 8, 8), [64, 64, 64, 255], 1);
    // Values beyond one are kept (2.0 draws as white), and what the format lacks reads (0, 0, 1).
    let frame = render_floats(&texture, "NEAREST", "texelFetch(u_tex, ivec2(3, 0), 0).r");
    assert_eq!(px(&frame, 8, 8), [255, 255, 255, 255]);
    let frame = render_floats(&texture, "NEAREST", "texelFetch(u_tex, ivec2(3, 0), 0).a * 0.5");
    near(px(&frame, 8, 8), [128, 128, 128, 255], 1);
}

#[test]
fn a_32_bit_float_texture_with_a_linear_filter_is_incomplete_and_reads_black() {
    // WebGL 2 filters them only with an extension: without it the texture samples (0, 0, 0, 1).
    let texture = float_texture(&R32F, 4, true);
    for filter in ["LINEAR", "NEAREST_MIPMAP_LINEAR"] {
        let frame = render_floats(&texture, filter, "texture(u_tex, vec2(0.4, 0.5)).r");
        assert_eq!(px(&frame, 8, 8), [0, 0, 0, 255], "{filter}");
    }
}

#[test]
fn a_16_bit_float_texture_filters_and_keeps_values_beyond_one() {
    // Two texels of red: 0 and 1; halfway between them is 0.5.
    let texture = float_texture(&[0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0], 2, false);
    let frame = render_floats(&texture, "LINEAR", "texture(u_tex, vec2(0.5, 0.5)).r");
    near(px(&frame, 8, 8), [128, 128, 128, 255], 2);
    let texture = float_texture(&[4.0, 0.0, 0.0, 1.0], 1, false);
    let frame = render_floats(&texture, "NEAREST", "texelFetch(u_tex, ivec2(0), 0).r * 0.25");
    assert_eq!(px(&frame, 8, 8), [255, 255, 255, 255]);
}

// ---- cube maps ----

/// A cube map of six solid 2 x 2 faces, in GL's order: +X red, -X green, +Y blue, -Y yellow, +Z white, -Z
/// magenta.
fn solid_cube() -> String {
    let colors: [[u8; 4]; 6] = [
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [255, 255, 0, 255],
        [255, 255, 255, 255],
        [255, 0, 255, 255],
    ];
    cube_of(&colors.map(|c| c.repeat(4)), 2, "")
}

fn cube_of(faces: &[Vec<u8>; 6], side: u32, extra: &str) -> String {
    let faces: Vec<String> = faces
        .iter()
        .map(|f| format!(r#"{{"pixels": "{}"}}"#, b64(f)))
        .collect();
    format!(
        r#"{{"cube": true, "width": {side}, "height": {side}{extra}, "faces": [{}]}}"#,
        faces.join(", ")
    )
}

const CUBE_FRAGMENT: &str = "precision mediump float; uniform samplerCube u_env; uniform vec3 u_dir; \
    void main() { gl_FragColor = textureCube(u_env, u_dir); }";

/// The pixel a fragment shader reading `cube` along `dir` draws.
fn sample_cube(cube: &str, dir: [f64; 3]) -> [u8; 4] {
    let frame = render(&layer(
        CUBE_FRAGMENT,
        &format!(r#", "textures": {{"c": {cube}}}"#),
        &draw(&format!(
            r#"{}, "units": {{"0": {{"texture": "c", "min": "NEAREST", "mag": "NEAREST"}}}}"#,
            uniforms(&[("u_env", "i", &[0.0]), ("u_dir", "f", &dir)])
        )),
    ));
    px(&frame, 8, 8)
}

#[test]
fn a_cube_map_is_read_along_each_axis_by_its_face() {
    let cube = solid_cube();
    let want = [
        ([1.0, 0.0, 0.0], [255, 0, 0, 255]),
        ([-1.0, 0.0, 0.0], [0, 255, 0, 255]),
        ([0.0, 1.0, 0.0], [0, 0, 255, 255]),
        ([0.0, -1.0, 0.0], [255, 255, 0, 255]),
        ([0.0, 0.0, 1.0], [255, 255, 255, 255]),
        ([0.0, 0.0, -1.0], [255, 0, 255, 255]),
    ];
    for (dir, color) in want {
        // A direction need not be unit length.
        let got = sample_cube(&cube, dir.map(|c| c * 3.0));
        near(got, color, 2);
    }
}

#[test]
fn a_cube_face_keeps_the_orientation_gl_gives_it() {
    // +Z seen from the origin has +x to the right and +y up, its first row at the top: a texel's row 0 is
    // where y is +1. The other faces are all white so a wrong layer shows.
    let quarters: Vec<u8> = [
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [10, 20, 30, 255],
    ]
    .concat();
    let white = [255u8; 16].to_vec();
    let faces = [
        white.clone(),
        white.clone(),
        white.clone(),
        white.clone(),
        quarters,
        white,
    ];
    let cube = cube_of(&faces, 2, "");
    near(sample_cube(&cube, [-0.5, 0.5, 1.0]), [255, 0, 0, 255], 2);
    near(sample_cube(&cube, [0.5, 0.5, 1.0]), [0, 255, 0, 255], 2);
    near(sample_cube(&cube, [-0.5, -0.5, 1.0]), [0, 0, 255, 255], 2);
    near(sample_cube(&cube, [0.5, -0.5, 1.0]), [10, 20, 30, 255], 2);
}

#[test]
fn an_incomplete_cube_map_is_opaque_black() {
    let cube = r#"{"cube": true, "faces": []}"#;
    assert_eq!(sample_cube(cube, [1.0, 0.0, 0.0]), [0, 0, 0, 255]);
}

#[test]
fn a_cube_map_needs_mipmaps_for_a_mipmapped_filter() {
    let cube = solid_cube();
    let sample = |cube: &str| {
        let frame = render(&layer(
            CUBE_FRAGMENT,
            &format!(r#", "textures": {{"c": {cube}}}"#),
            &draw(&format!(
                r#"{}, "units": {{"0": {{"texture": "c"}}}}"#,
                uniforms(&[("u_env", "i", &[0.0]), ("u_dir", "f", &[1.0, 0.0, 0.0])])
            )),
        ));
        px(&frame, 8, 8)
    };
    // The default minification filter reads mipmaps: without them the cube is incomplete.
    assert_eq!(sample(&cube), [0, 0, 0, 255]);
    let mipped = cube.replace(r#""height": 2,"#, r#""height": 2, "mipmaps": true,"#);
    near(sample(&mipped), [255, 0, 0, 255], 2);
}

#[test]
fn a_webgl_two_shader_reads_a_cube_map_with_texture() {
    let frame = render(&layer_of(
        &[(
            "p",
            "#version 300 es\nprecision highp float; uniform samplerCube u_env; out vec4 o;\n\
             void main() { o = texture(u_env, vec3(0.0, 1.0, 0.0)); }",
        )],
        &format!(r#", "textures": {{"c": {}}}"#, solid_cube()),
        &draw(&format!(
            r#"{}, "units": {{"0": {{"texture": "c", "min": "NEAREST", "mag": "NEAREST"}}}}"#,
            uniforms(&[("u_env", "i", &[0.0])])
        )),
    ));
    near(px(&frame, 8, 8), [0, 0, 255, 255], 2);
}

#[test]
fn a_cube_map_in_a_unit_read_as_a_2d_texture_is_an_error() {
    let layer = layer(
        "precision mediump float; uniform sampler2D u_tex; void main() { gl_FragColor = texture2D(u_tex, vec2(0.5)); }",
        &format!(r#", "textures": {{"c": {}}}"#, solid_cube()),
        &draw(&format!(
            r#"{}, "units": {{"0": {{"texture": "c"}}}}"#,
            uniforms(&[("u_tex", "i", &[0.0])])
        )),
    );
    let Err(error) = render_still(scene_of(&layer), 0) else {
        panic!("the draw should fail");
    };
    let error = error.to_string();
    assert!(error.contains("cube map"), "{error}");
}

// ---- a clear with the scissor test on ----

/// The fragment shader of a scissored clear of the depth or stencil alone: no colour output.
const NO_OUTPUT_ES3: &str =
    "#version 300 es\nprecision highp float;\nuniform vec4 u_color;\n\nvoid main() {  }\n";

/// What the recording makes of a clear with the scissor test on: the quad over the box (the viewport), writing the
/// clear values (the colour, the depth through an ALWAYS test, the stencil by REPLACE).
fn scissored_clear(extra: &str) -> String {
    draw_in(
        "e",
        [4, 2, 8, 6],
        &format!(r#""scissor": [4, 2, 8, 6], "colorMask": [false, false, false, false], {extra}"#),
    )
}

/// The same with the colour written.
fn scissored_colour_clear(color: [f64; 4]) -> String {
    draw_in("f", [4, 2, 8, 6], &format!(r#""scissor": [4, 2, 8, 6], {}"#, z_fill(0.0, color)))
}

#[test]
fn a_scissored_clear_changes_the_box_alone() {
    for antialias in ["", r#", "antialias": true"#] {
        let all = ops(&[draw_in("f", [0, 0, 16, 16], &z_fill(0.0, RED)), scissored_colour_clear(BLUE)]);
        let frame = render(&layer_es3(&[("f", FILL_ES3)], antialias, &all));
        // GL's rows count from the bottom: the box is rows 8 to 13 from the top, columns 4 to 11.
        assert_eq!(px(&frame, 8, 10), [0, 0, 255, 255], "inside {antialias}");
        assert_eq!(px(&frame, 4, 8), [0, 0, 255, 255], "corner {antialias}");
        assert_eq!(px(&frame, 3, 10), [255, 0, 0, 255], "left {antialias}");
        assert_eq!(px(&frame, 12, 10), [255, 0, 0, 255], "right {antialias}");
        assert_eq!(px(&frame, 8, 7), [255, 0, 0, 255], "above {antialias}");
        assert_eq!(px(&frame, 8, 14), [255, 0, 0, 255], "below {antialias}");
    }
}

#[test]
fn a_scissored_depth_clear_changes_the_depth_inside_the_box_alone() {
    let always = r#""depth": {"func": "ALWAYS", "mask": true, "near": 0, "far": 1}"#;
    let all = ops(&[
        r#"{"op": "clear", "color": [0, 0, 0, 1], "depth": 1}"#.to_string(),
        scissored_clear(&format!("{}, {always}", uniforms(&[("u_z", "f", &[-0.5]), ("u_color", "f", &[0.0; 4])]))),
        // Red at window depth 0.5, tested LESS: the box now holds 0.25, so it stops there.
        draw_in("f", [0, 0, 16, 16], &format!("{}, {}", z_fill(0.0, RED), depth("LESS"))),
    ]);
    let frame = render(&layer_es3(&[("f", FILL_ES3), ("e", NO_OUTPUT_ES3)], "", &all));
    assert_eq!(px(&frame, 8, 10), [0, 0, 0, 255]);
    assert_eq!(px(&frame, 2, 10), [255, 0, 0, 255]);
}

#[test]
fn a_scissored_stencil_clear_changes_the_stencil_inside_the_box_alone() {
    let replace = stencil("ALWAYS", 5, "REPLACE");
    let all = ops(&[
        r#"{"op": "clear", "color": [0, 0, 0, 1], "stencil": 0}"#.to_string(),
        scissored_clear(&format!("{}, {replace}", uniforms(&[("u_z", "f", &[0.0]), ("u_color", "f", &[0.0; 4])]))),
        draw_in("f", [0, 0, 16, 16], &format!("{}, {}", z_fill(0.0, GREEN), stencil("EQUAL", 5, "KEEP"))),
    ]);
    let frame = render(&layer_es3(&[("f", FILL_ES3), ("e", NO_OUTPUT_ES3)], r#", "stencil": true"#, &all));
    assert_eq!(px(&frame, 8, 10), [0, 255, 0, 255]);
    assert_eq!(px(&frame, 2, 10), [0, 0, 0, 255]);
}

// ---- 2D array textures ----

/// A 2 x 2 array of three layers: layer 0 is red, 1 is green, 2 is blue, and the first texel of layer 1 is white.
fn layers() -> String {
    let mut texels = Vec::new();
    for layer in 0..3usize {
        for texel in 0..4 {
            let mut c = [0u8, 0, 0, 255];
            c[layer] = 255;
            if layer == 1 && texel == 0 {
                c = [255; 4];
            }
            texels.extend(c);
        }
    }
    format!(
        r#", "textures": {{"a": {{"pixels": "{}", "width": 2, "height": 2, "depth": 3, "array": true}}}}"#,
        b64(&texels)
    )
}

fn layers_unit(filter: &str) -> String {
    format!(
        r#""uniforms": {{"u_layers": [{{"kind": "i", "value": [0]}}]}},
            "units": {{"0": {{"texture": "a", "min": "{filter}", "mag": "{filter}",
                "wrapS": "CLAMP_TO_EDGE", "wrapT": "CLAMP_TO_EDGE"}}}}"#
    )
}

fn layers_fragment(read: &str) -> String {
    format!(
        "#version 300 es\nprecision highp float; precision highp sampler2DArray; in vec2 v_uv; \
         uniform sampler2DArray u_layers; out vec4 o; void main() {{ o = {read}; }}"
    )
}

#[test]
fn a_2d_array_texture_is_fetched_and_sampled_by_layer() {
    for (read, want) in [
        ("texelFetch(u_layers, ivec3(0, 0, 0), 0)", [255, 0, 0, 255]),
        ("texelFetch(u_layers, ivec3(1, 1, 2), 0)", [0, 0, 255, 255]),
        ("texture(u_layers, vec3(0.25, 0.25, 1.0))", [255, 255, 255, 255]),
        ("texture(u_layers, vec3(0.75, 0.75, 1.0))", [0, 255, 0, 255]),
        ("texture(u_layers, vec3(0.75, 0.75, 2.0))", [0, 0, 255, 255]),
    ] {
        let fragment = layers_fragment(read);
        let frame = render(&layer_with_vertex(
            QUAD_VERTEX_ES1_AS_ES3,
            &[("p", &fragment)],
            "",
            &layers(),
            &draw(&layers_unit("NEAREST")),
        ));
        assert_eq!(px(&frame, 8, 8), want, "{read}");
    }
}

#[test]
fn a_2d_array_layer_index_is_rounded_and_clamped_and_never_blends_layers() {
    // Layer 1.4 rounds to 1, and 7.0 clamps to the last layer, even with LINEAR filtering.
    for (read, want) in [
        ("texture(u_layers, vec3(0.75, 0.75, 1.4))", [0, 255, 0, 255]),
        ("texture(u_layers, vec3(0.75, 0.75, 7.0))", [0, 0, 255, 255]),
    ] {
        let fragment = layers_fragment(read);
        let frame = render(&layer_with_vertex(
            QUAD_VERTEX_ES1_AS_ES3,
            &[("p", &fragment)],
            "",
            &layers(),
            &draw(&layers_unit("LINEAR")),
        ));
        assert_eq!(px(&frame, 8, 8), want, "{read}");
    }
}

#[test]
fn a_2d_array_sampler_with_no_texture_reads_black() {
    let fragment = layers_fragment("texture(u_layers, vec3(0.5, 0.5, 0.0))");
    let frame = render(&layer_with_vertex(
        QUAD_VERTEX_ES1_AS_ES3,
        &[("p", &fragment)],
        "",
        "",
        &draw(r#""uniforms": {"u_layers": [{"kind": "i", "value": [0]}]}"#),
    ));
    assert_eq!(px(&frame, 8, 8), [0, 0, 0, 255]);
}

#[test]
fn a_2d_array_sampler_on_a_unit_holding_a_3d_texture_is_refused() {
    let fragment = layers_fragment("texture(u_layers, vec3(0.5))");
    let e = render_error(&layer_with_vertex(
        QUAD_VERTEX_ES1_AS_ES3,
        &[("p", &fragment)],
        "",
        &volume(),
        &draw(&layers_unit("NEAREST").replace(r#""a""#, r#""v""#)),
    ));
    assert!(e.contains("2D array") && e.contains("3D"), "{e}");
}

#[test]
fn a_vertex_shader_fetches_from_a_2d_array_texture() {
    // The vertex shader reads the first texel of layer 1 and hands it to the fragment shader.
    let vertex = "#version 300 es\nin vec2 a_pos; uniform highp sampler2DArray u_layers; out vec4 v_c; \
        void main() { v_c = texelFetch(u_layers, ivec3(0, 0, 1), 0); gl_Position = vec4(a_pos, 0.0, 1.0); }";
    let fragment = "#version 300 es\nprecision highp float; in vec4 v_c; out vec4 o; void main() { o = v_c; }";
    let frame = render(&layer_with_vertex(
        vertex,
        &[("p", fragment)],
        "",
        &layers(),
        &draw(&layers_unit("NEAREST")),
    ));
    assert_eq!(px(&frame, 8, 8), [255, 255, 255, 255]);
}

// ---- array uniforms whose length is a macro ----

#[test]
fn an_array_uniform_sized_by_a_macro_takes_its_values() {
    let vertex = "#version 300 es\nin vec2 a_pos; out vec4 v_c;\n#define MORPHTARGETS_COUNT 3\n\
        uniform float morphTargetInfluences[ MORPHTARGETS_COUNT ];\n\
        void main() { v_c = vec4(morphTargetInfluences[0], morphTargetInfluences[1], morphTargetInfluences[2], 1.0); \
        gl_Position = vec4(a_pos, 0.0, 1.0); }";
    let fragment = "#version 300 es\nprecision highp float; in vec4 v_c; out vec4 o; void main() { o = v_c; }";
    let frame = render(&layer_with_vertex(
        vertex,
        &[("p", fragment)],
        "",
        "",
        &draw(&uniforms(&[("morphTargetInfluences", "f", &[1.0, 0.5, 0.0])])),
    ));
    near(px(&frame, 8, 8), [255, 128, 0, 255], 2);
}

#[test]
fn an_array_uniform_sized_by_a_macro_that_depends_on_a_condition_fails_when_the_scene_loads() {
    let vertex = "#version 300 es\nin vec2 a_pos;\n#ifdef FAST\n#define N 3\n#endif\n\
        uniform float w[N]; void main() { gl_Position = vec4(a_pos, w[0], 1.0); }";
    let fragment = "#version 300 es\nprecision highp float; out vec4 o; void main() { o = vec4(1.0); }";
    let json = format!(
        r##"{{"width": 16, "height": 16, "fps": 30, "durationInFrames": 1, "layers": [{}]}}"##,
        layer_with_vertex(vertex, &[("p", fragment)], "", "", &draw(""))
    );
    let Error::Scene(message) = Scene::from_json(&json, Default::default()).unwrap_err() else {
        panic!("not a scene error")
    };
    assert!(message.contains("macro defined as one"), "{message}");
}

// ---- constant attributes (vertexAttrib*) ----

/// A draw of the quad whose vertex shader reads a second attribute, `a_color`, given as `extra` in the attributes.
fn draw_with_color(extra: &str, first_and_count: (u32, u32)) -> String {
    format!(
        r#"{{"op": "draw", "program": "p", "mode": "triangles", "first": {}, "count": {},
            "attributes": {{"a_pos": {{"buffer": "quad", "size": 2, "type": "f32"}}, "a_color": {extra}}},
            "viewport": [0, 0, 16, 16]}}"#,
        first_and_count.0, first_and_count.1
    )
}

const COLOR_VERTEX: &str = "#version 300 es\nin vec2 a_pos; in vec3 a_color; out vec3 v_c; \
    void main() { v_c = a_color; gl_Position = vec4(a_pos, 0.0, 1.0); }";
const COLOR_FRAGMENT: &str =
    "#version 300 es\nprecision highp float; in vec3 v_c; out vec4 o; void main() { o = vec4(v_c, 1.0); }";

#[test]
fn a_disabled_attribute_reads_its_current_value_for_every_vertex() {
    let constant = r#"{"buffer": "constant:1,0.5,0,1", "size": 4, "type": "f32", "constant": [1, 0.5, 0, 1]}"#;
    let frame = render(&layer_with_vertex(
        COLOR_VERTEX,
        &[("p", COLOR_FRAGMENT)],
        "",
        "",
        &draw_with_color(constant, (0, 6)),
    ));
    near(px(&frame, 3, 3), [255, 128, 0, 255], 2);
    near(px(&frame, 12, 12), [255, 128, 0, 255], 2);
}

#[test]
fn a_constant_attribute_follows_the_draws_first_vertex_and_the_default_is_0_0_0_1() {
    // Only vertices 3 to 5 are drawn (the second triangle): a constant has as many copies as the draw reaches.
    let constant = r#"{"buffer": "constant:0,0,0,1", "size": 4, "type": "f32", "constant": [0, 0, 0, 1]}"#;
    let frame = render(&layer_with_vertex(
        COLOR_VERTEX,
        &[("p", COLOR_FRAGMENT)],
        "",
        "",
        &draw_with_color(constant, (3, 3)),
    ));
    assert_eq!(px(&frame, 12, 12), [0, 0, 0, 255]);
}

#[test]
fn two_draws_with_one_constant_and_different_lengths_both_draw() {
    let constant = r#"{"buffer": "constant:0,1,0,1", "size": 4, "type": "f32", "constant": [0, 1, 0, 1]}"#;
    let all = ops(&[draw_with_color(constant, (0, 3)), draw_with_color(constant, (0, 6))]);
    let frame = render(&layer_with_vertex(COLOR_VERTEX, &[("p", COLOR_FRAGMENT)], "", "", &all));
    assert_eq!(px(&frame, 12, 12), [0, 255, 0, 255]);
    assert_eq!(px(&frame, 3, 3), [0, 255, 0, 255]);
}

#[test]
fn a_constant_attribute_that_is_not_four_floats_is_refused() {
    let constant = r#"{"buffer": "constant:1,1,1,1", "size": 3, "type": "f32", "constant": [1, 1, 1, 1]}"#;
    let e = render_error(&layer_with_vertex(
        COLOR_VERTEX,
        &[("p", COLOR_FRAGMENT)],
        "",
        "",
        &draw_with_color(constant, (0, 6)),
    ));
    assert!(e.contains("constant attribute"), "{e}");
}

#[test]
fn an_attribute_with_nothing_given_says_so() {
    let e = render_error(&layer_with_vertex(
        COLOR_VERTEX,
        &[("p", COLOR_FRAGMENT)],
        "",
        "",
        &draw("").replace(r#""attributes": {"a_pos""#, r#""attributes": {"unused""#),
    ));
    assert!(e.contains("no data"), "{e}");
}

#[test]
fn a_constant_attribute_read_for_a_huge_vertex_count_is_refused_not_allocated() {
    let constant = r#"{"buffer": "constant:0,1,0,1", "size": 4, "type": "f32", "constant": [0, 1, 0, 1]}"#;
    // A far first vertex: first + count reaches 4 billion, which would be 64 GB of copies.
    let e = render_error(&layer_with_vertex(
        "#version 300 es\nin vec3 a_color; in vec2 a_pos; out vec3 v_c; \
            void main() { v_c = a_color; gl_Position = vec4(a_pos, 0.0, 1.0); }",
        &[("p", COLOR_FRAGMENT)],
        "",
        "",
        &draw_with_color(constant, (4_000_000_000, 6)),
    ));
    assert!(e.contains("constant attribute") && e.contains("at most"), "{e}");
}

// ---- matrix attributes (instanceMatrix) ----

/// An instanced `mat4` attribute `inst`: its four columns are read at `columns` (the first column's location 1), from
/// a buffer of 64-byte matrices, the first scaling by 0.5 and the second moving the quad right by 0.5.
fn instanced_matrix_draw(instances: u32) -> (String, String) {
    let matrices: [[f32; 16]; 2] = [
        [0.5, 0.0, 0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0],
        [0.25, 0.0, 0.0, 0.0, 0.0, 0.25, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.5, 0.5, 0.0, 1.0],
    ];
    let bytes: Vec<u8> = matrices.iter().flatten().flat_map(|f| f.to_le_bytes()).collect();
    let columns: Vec<String> = (0..4)
        .map(|c| {
            format!(
                r#""inst[{c}]": {{"buffer": "m", "size": 4, "type": "f32", "stride": 64, "offset": {}, "divisor": 1}}"#,
                c * 16
            )
        })
        .collect();
    let draw = format!(
        r#"{{"op": "draw", "program": "p", "mode": "triangles", "first": 0, "count": 6, "instances": {instances},
            "attributes": {{"a_pos": {{"buffer": "quad", "size": 2, "type": "f32"}}, {}}},
            "viewport": [0, 0, 16, 16]}}"#,
        columns.join(", ")
    );
    (draw, format!(r#", "m": "{}""#, b64(&bytes)))
}

const MATRIX_VERTEX: &str = "#version 300 es\nin vec2 a_pos; in mat4 inst;\n\
    void main() { gl_Position = inst * vec4(a_pos, 0.0, 1.0); }";
const RED_FRAGMENT: &str = "#version 300 es\nprecision highp float; out vec4 o; void main() { o = vec4(1.0, 0.0, 0.0, 1.0); }";

#[test]
fn an_instanced_mat4_attribute_is_read_a_column_at_a_time() {
    let (draw, buffer) = instanced_matrix_draw(2);
    let frame = render(&layer_with_vertex(
        MATRIX_VERTEX,
        &[("p", RED_FRAGMENT)],
        &buffer,
        "",
        &draw,
    ));
    // The first instance is the middle half of the picture; the second a quarter-size quad over the upper right
    // (GL's y counts up, so the picture's upper right is y > 0).
    assert_eq!(px(&frame, 8, 8), [255, 0, 0, 255]);
    assert_eq!(px(&frame, 2, 2), [0, 0, 0, 255]);
    assert_eq!(px(&frame, 12, 3), [255, 0, 0, 255]);
    assert_eq!(px(&frame, 14, 14), [0, 0, 0, 255]);
}

// ---- float render targets ----

/// A square colour target `rt` of `side` and the float format `format`.
fn float_target(format: &str, side: u32) -> String {
    format!(
        r#", "textures": {{"rt": {{"target": true, "width": {side}, "height": {side}, "colorFormat": "{format}"}}}}"#
    )
}

/// `u_tex * 0.25` of the drawing buffer's picture, so a target holding 2.0 reads as 0.5.
const QUARTER: &str = "precision highp float; varying vec2 v_uv; uniform sampler2D u_tex; \
    void main() { gl_FragColor = vec4(texture2D(u_tex, v_uv).rgb * 0.25, 1.0); }";

fn through_a_float_target(format: &str, filter: &str) -> Frame {
    let sampling = format!(
        r#"{}, "units": {{"0": {{"texture": "rt", "min": "{filter}", "mag": "{filter}",
            "wrapS": "CLAMP_TO_EDGE", "wrapT": "CLAMP_TO_EDGE"}}}}"#,
        uniforms(&[("u_tex", "i", &[0.0])])
    );
    render(&layer_of(
        &[("f", FILL), ("q", QUARTER)],
        &float_target(format, 8),
        &ops(&[
            // Red of 2.0 (beyond what 8 bits hold) in the lower half of the target, 4.0 green over the rest.
            draw_with("f", Some(("rt", 8)), &fill([2.0, 4.0, 0.0, 1.0])),
            draw_with("q", None, &sampling),
        ]),
    ))
}

#[test]
fn a_half_float_target_keeps_values_beyond_one() {
    let frame = through_a_float_target("RGBA16F", "LINEAR");
    // 2.0 and 4.0 times a quarter: 0.5 and 1.0.
    near(px(&frame, 8, 8), [128, 255, 0, 255], 3);
}

#[test]
fn a_single_channel_and_a_two_channel_float_target_are_drawn_into() {
    for format in ["R16F", "RG16F", "R32F", "RG32F"] {
        let frame = through_a_float_target(format, "NEAREST");
        // A single channel reads (r, 0, 0, 1); two read (r, g, 0, 1).
        let green = if format.starts_with("RG") { 255 } else { 0 };
        near(px(&frame, 8, 8), [128, green, 0, 255], 3);
    }
}

#[test]
fn a_32_bit_float_target_reads_nearest_and_is_black_otherwise() {
    near(px(&through_a_float_target("RGBA32F", "NEAREST"), 8, 8), [128, 255, 0, 255], 3);
    // As in a browser without OES_texture_float_linear.
    assert_eq!(px(&through_a_float_target("RGBA32F", "LINEAR"), 8, 8), [0, 0, 0, 255]);
}

#[test]
fn a_clear_of_a_float_target_keeps_values_beyond_one() {
    let sampling = format!(
        r#"{}, "units": {{"0": {{"texture": "rt", "min": "NEAREST", "mag": "NEAREST"}}}}"#,
        uniforms(&[("u_tex", "i", &[0.0])])
    );
    let frame = render(&layer_of(
        &[("q", QUARTER)],
        &float_target("RGBA16F", 8),
        &ops(&[
            r#"{"op": "clear", "target": "rt", "color": [0.5, 0.25, 0, 1]}"#.to_string(),
            draw_with("q", None, &sampling),
        ]),
    ));
    near(px(&frame, 8, 8), [32, 16, 0, 255], 3);
}

#[test]
fn a_blit_to_a_float_target_is_refused() {
    let e = render_error(&layer_of(
        &[("f", FILL)],
        &float_target("RGBA16F", 8),
        &ops(&[
            draw_in("f", [0, 0, 16, 16], &fill([1.0; 4])),
            blit_op(None, Some("rt"), [0, 0, 8, 8], [0, 0, 8, 8], false),
        ]),
    ));
    assert!(e.contains("float render target"), "{e}");
}

// ---- struct uniforms ----

const LIGHT_FRAGMENT: &str = "#version 300 es\nprecision highp float;\n\
    struct DirectionalLight {\n  vec3 direction;\n  vec3 color;\n};\n\
    uniform DirectionalLight directionalLights[ 2 ];\nuniform float opacity;\nout vec4 o;\n\
    void main() { o = vec4(directionalLights[0].color + directionalLights[1].direction, opacity); }";

#[test]
fn the_fields_of_a_struct_uniform_array_are_set_one_by_one() {
    let calls = r#""uniforms": {
        "directionalLights[0].color": [{"kind": "f", "value": [0.5, 0, 0]}],
        "directionalLights[1].direction": [{"kind": "f", "value": [0, 0.25, 1]}],
        "directionalLights[1].color": [{"kind": "f", "value": [1, 1, 1]}],
        "opacity": [{"kind": "f", "value": [1]}]}"#;
    let frame = render(&layer_with_vertex(
        QUAD_VERTEX_ES1_AS_ES3,
        &[("p", LIGHT_FRAGMENT)],
        "",
        "",
        &draw(calls),
    ));
    // Element 0's colour and element 1's direction: (0.5, 0.25, 1).
    near(px(&frame, 8, 8), [128, 64, 255, 255], 2);
}

#[test]
fn half_floats_pack_and_unpack() {
    let frag = "#version 300 es\nprecision highp float; in vec2 v_uv; out vec4 o; void main() { \
        uint p = packHalf2x16(vec2(0.5, 0.25)); vec2 back = unpackHalf2x16(p); o = vec4(back, float(p & 0xffffu) / 15360.0, 1.0); }";
    let frame = render(&layer_with_vertex(QUAD_VERTEX_ES1_AS_ES3, &[("p", frag)], "", "", &draw("")));
    // 0.5 and 0.25 survive, and 0.5 is 0x3800 in the low half: 14336 / 15360.
    near(px(&frame, 8, 8), [128, 64, 238, 255], 3);
}

// ---- sampler parameters, precision qualifiers, modf ----

#[test]
fn a_sampler_passed_to_a_function_is_sampled() {
    // The same 2 x 1 texture through one function that takes it, and one that passes it on; the unit is 3.
    let frag = "#version 300 es\nprecision highp float; in vec2 v_uv; uniform highp sampler2D u_tex; out vec4 o;\n\
        vec4 pick(in highp sampler2D s, vec2 uv) { return texture(s, vec2(uv.x, 0.5)); }\n\
        vec4 twice(sampler2D s, vec2 uv) { return pick(s, uv); }\n\
        void main() { o = twice(u_tex, v_uv); }";
    let frame = render(&layer_with_vertex(
        QUAD_VERTEX_ES1_AS_ES3,
        &[("p", frag)],
        "",
        &red_green(),
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
fn modf_and_matrix_comp_mult_compute_what_glsl_says() {
    let frag = "#version 300 es\nprecision highp float; in vec2 v_uv; out vec4 o; void main() {\n\
        float whole; float part = modf(2.25, whole); vec2 w2; vec2 p2 = modf(vec2(-1.5, 3.75), w2);\n\
        mat2 m = matrixCompMult(mat2(2.0, 1.0, 1.0, 2.0), mat2(0.25, 3.0, 5.0, 0.125));\n\
        o = vec4(part + p2.y, whole / 4.0 + w2.x * -0.25, m[0][0] + m[1][1], m[0][1] + m[1][0]); }";
    let frame = render(&layer_with_vertex(QUAD_VERTEX_ES1_AS_ES3, &[("p", frag)], "", "", &draw("")));
    // part 0.25 + 0.75 = 1.0; 2 / 4 + (-1 * -0.25) = 0.75; 0.5 + 0.25 = 0.75; 3 + 5 = 8 (clamped to 1).
    near(px(&frame, 8, 8), [255, 191, 191, 255], 3);
}

// ---- lines ----

/// A draw of `mode` over the vertices `points` (clip space, in the buffer "v"), red.
fn line_draw(mode: &str, count: usize, extra: &str) -> String {
    format!(
        r#"{{"op": "draw", "program": "p", "mode": "{mode}", "first": 0, "count": {count},
            "attributes": {{"a_pos": {{"buffer": "v", "size": 2, "type": "f32"}}}},
            "viewport": [0, 0, 16, 16] {extra}}}"#
    )
}

fn line_layer(points: &[[f32; 2]], draw: &str) -> Frame {
    let bytes: Vec<u8> = points.iter().flatten().flat_map(|f| f.to_le_bytes()).collect();
    let frag = "#version 300 es\nprecision highp float; out vec4 o; void main() { o = vec4(1.0, 0.0, 0.0, 1.0); }";
    render(&layer_with_vertex(
        QUAD_VERTEX_ES1_AS_ES3,
        &[("p", frag)],
        &format!(r#", "v": "{}""#, b64(&bytes)),
        "",
        draw,
    ))
}

fn red_pixels(frame: &Frame) -> usize {
    (0..16)
        .flat_map(|y| (0..16).map(move |x| (x, y)))
        .filter(|&(x, y)| px(frame, x, y)[0] > 128)
        .count()
}

#[test]
fn lines_are_one_pixel_wide() {
    // Across the picture a little above its middle: one row of red, 16 pixels, whatever the rows around.
    let frame = line_layer(&[[-1.0, 0.03], [1.0, 0.03]], &line_draw("lines", 2, ""));
    assert_eq!(red_pixels(&frame), 16);
    assert_eq!(px(&frame, 8, 7), [255, 0, 0, 255]);
    assert_eq!(px(&frame, 8, 6), [0, 0, 0, 255]);
    assert_eq!(px(&frame, 8, 8), [0, 0, 0, 255]);
}

#[test]
fn a_line_list_takes_pairs_and_a_strip_joins_them() {
    let corners: [[f32; 2]; 4] = [[-0.9, -0.9], [0.9, -0.9], [0.9, 0.9], [-0.9, 0.9]];
    let list = red_pixels(&line_layer(&corners, &line_draw("lines", 4, "")));
    let strip = red_pixels(&line_layer(&corners, &line_draw("lineStrip", 4, "")));
    let looped = red_pixels(&line_layer(&corners, &line_draw("lineLoop", 4, "")));
    // Two sides; three sides; four.
    assert!(list > 20 && list < strip, "{list} {strip}");
    assert!(strip < looped, "{strip} {looped}");
    // The loop is a closed square: its middle is empty.
    assert_eq!(px(&line_layer(&corners, &line_draw("lineLoop", 4, "")), 8, 8), [0, 0, 0, 255]);
}

#[test]
fn a_line_loop_of_indices_closes_on_its_first_index() {
    let corners: [[f32; 2]; 4] = [[-0.9, -0.9], [0.9, -0.9], [0.9, 0.9], [-0.9, 0.9]];
    let indices: Vec<u8> = [0u16, 1, 2, 3].iter().flat_map(|i| i.to_le_bytes()).collect();
    let extra = r#", "indices": {"buffer": "i", "type": "u16", "offset": 0}"#;
    let bytes: Vec<u8> = corners.iter().flatten().flat_map(|f| f.to_le_bytes()).collect();
    let frag = "#version 300 es\nprecision highp float; out vec4 o; void main() { o = vec4(1.0, 0.0, 0.0, 1.0); }";
    let frame = render(&layer_with_vertex(
        QUAD_VERTEX_ES1_AS_ES3,
        &[("p", frag)],
        &format!(r#", "v": "{}", "i": "{}""#, b64(&bytes), b64(&indices)),
        "",
        &line_draw("lineLoop", 4, extra),
    ));
    let strip = red_pixels(&line_layer(&corners, &line_draw("lineStrip", 4, "")));
    assert!(red_pixels(&frame) > strip);
}

#[test]
fn lines_are_not_culled_or_offset() {
    let cull = r#", "cull": {"face": "BACK", "front": "CCW"}"#;
    let frame = line_layer(&[[-1.0, 0.03], [1.0, 0.03]], &line_draw("lines", 2, cull));
    assert_eq!(red_pixels(&frame), 16);
}

// ---- sRGB textures ----

fn grey_texture(srgb: bool) -> String {
    format!(
        r#", "textures": {{"t": {{"pixels": "{}", "width": 1, "height": 1{}}}}}"#,
        b64(&[188, 188, 188, 255]),
        if srgb { r#", "srgb": true"# } else { "" }
    )
}

fn sampled_grey(srgb: bool, mipmaps: bool) -> Frame {
    let content = grey_texture(srgb).replace(
        r#""height": 1"#,
        &format!(r#""height": 1{}"#, if mipmaps { r#", "mipmaps": true"# } else { "" }),
    );
    render(&layer(
        "precision mediump float; varying vec2 v_uv; uniform sampler2D u_tex; \
         void main() { gl_FragColor = texture2D(u_tex, v_uv); }",
        &content,
        &draw(
            r#""uniforms": {"u_tex": [{"kind": "i", "value": [0]}]},
               "units": {"0": {"texture": "t", "min": "LINEAR", "mag": "LINEAR",
                               "wrapS": "CLAMP_TO_EDGE", "wrapT": "CLAMP_TO_EDGE"}}"#,
        ),
    ))
}

#[test]
fn an_srgb_texture_is_read_as_linear() {
    // The byte 188 is 0.737 in sRGB, which is 0.5 in linear light.
    near(px(&sampled_grey(true, false), 8, 8), [128, 128, 128, 255], 3);
    // The same bytes, not sRGB, are read as they are.
    near(px(&sampled_grey(false, false), 8, 8), [188, 188, 188, 255], 1);
    // Mip levels of an sRGB texture are made too.
    near(px(&sampled_grey(true, true), 8, 8), [128, 128, 128, 255], 3);
}

// ---- shadow samplers ----

const SHADOW_FRAGMENT: &str = "#version 300 es\nprecision highp float; precision highp sampler2DShadow; in vec2 v_uv; \
    uniform sampler2DShadow maps[2]; out vec4 o; \
    void main() { o = vec4(texture(maps[1], vec3(v_uv, 0.5)), texture(maps[0], vec3(v_uv, 0.5)), 0.0, 1.0); }";

fn depth_target() -> &'static str {
    r#", "textures": {"d": {"target": true, "width": 8, "height": 8, "format": "depth"},
                    "e": {"target": true, "width": 8, "height": 8, "format": "depth"}}"#
}

fn shadow_unit(texture: &str, compare: &str) -> String {
    format!(
        r#"{{"texture": "{texture}", "min": "NEAREST", "mag": "NEAREST", "wrapS": "CLAMP_TO_EDGE", "wrapT": "CLAMP_TO_EDGE"{compare}}}"#
    )
}

#[test]
fn an_array_of_shadow_samplers_compares_each_map_with_the_reference() {
    // Map "d" holds depth 0.25 (the unit of element 1), map "e" 0.75 (element 0). A reference of 0.5 passes LEQUAL
    // against 0.75 and fails against 0.25.
    let frame = render(&layer_with_vertex(
        QUAD_VERTEX_ES1_AS_ES3,
        &[("p", SHADOW_FRAGMENT)],
        "",
        depth_target(),
        &ops(&[
            r#"{"op": "clear", "depthStencil": "d", "depth": 0.25}"#.to_string(),
            r#"{"op": "clear", "depthStencil": "e", "depth": 0.75}"#.to_string(),
            draw(&format!(
                r#""uniforms": {{"maps": [{{"kind": "i", "value": [4, 3]}}]}}, "units": {{"3": {}, "4": {}}}"#,
                shadow_unit("d", r#", "compare": "LEQUAL""#),
                shadow_unit("e", r#", "compare": "LEQUAL""#)
            )),
        ]),
    ));
    // maps[1] is unit 3 (depth 0.25): shadowed, 0; maps[0] is unit 4 (depth 0.75): lit, 1.
    assert_eq!(px(&frame, 8, 8), [0, 255, 0, 255]);
    // GREATER turns it round.
    let frame = render(&layer_with_vertex(
        QUAD_VERTEX_ES1_AS_ES3,
        &[("p", SHADOW_FRAGMENT)],
        "",
        depth_target(),
        &ops(&[
            r#"{"op": "clear", "depthStencil": "d", "depth": 0.25}"#.to_string(),
            r#"{"op": "clear", "depthStencil": "e", "depth": 0.75}"#.to_string(),
            draw(&format!(
                r#""uniforms": {{"maps": [{{"kind": "i", "value": [4, 3]}}]}}, "units": {{"3": {}, "4": {}}}"#,
                shadow_unit("d", r#", "compare": "GREATER""#),
                shadow_unit("e", r#", "compare": "GREATER""#)
            )),
        ]),
    ));
    assert_eq!(px(&frame, 8, 8), [255, 0, 0, 255]);
}

#[test]
fn a_shadow_sampler_needs_a_depth_texture() {
    let e = render_error(&layer_with_vertex(
        QUAD_VERTEX_ES1_AS_ES3,
        &[("p", SHADOW_FRAGMENT)],
        "",
        &red_green(),
        &draw(&format!(
            r#""uniforms": {{"maps": [{{"kind": "i", "value": [3, 3]}}]}}, "units": {{"3": {}}}"#,
            shadow_unit("t", r#", "compare": "LEQUAL""#)
        )),
    ));
    assert!(e.contains("not a depth texture"), "{e}");
    let e = render_error(&layer_with_vertex(
        QUAD_VERTEX_ES1_AS_ES3,
        &[("p", SHADOW_FRAGMENT)],
        "",
        "",
        &draw(""),
    ));
    assert!(e.contains("holds no depth texture"), "{e}");
}
