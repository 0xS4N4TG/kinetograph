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
    let frame = render(&layer_with_vertex(vertex, &[("p", fragment)], "", "", &draw));
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
    assert_eq!(px(&frame, 15, 8)[..3], [0, 0, 0], "the point centred at x = 1.1 draws nothing");
    assert_eq!(px(&frame, 8, 8)[..3], [0, 0, 0], "point 0 is before `first`");
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
    all.push(blit_op(None, Some("t"), [0, 0, 16, 16], [0, 0, 16, 16], false));
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
    all.push(blit_op(None, Some("t"), [0, 0, 16, 16], [16, 0, 0, 16], false));
    all.push(r#"{"op": "clear", "color": [0, 1, 0, 1]}"#.into());
    all.push(blit_op(Some("t"), None, [8, 0, 16, 16], [0, 0, 8, 8], true));
    let frame = render(&layer_of(&[("f", FILL)], &targets(&[("t", 16)]), &ops(&all)));
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
    let frame = render(&layer_of(&[("s", SHOW)], &targets(&[("t", 16)]), &ops(&all)));
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
        upload_op("t", [1, 0], [1, 1], &[255, 255, 255, 128], r#", "premultiply": true"#),
        // Drawn after the uploads, over the lower half only.
        draw_in(
            "f",
            [0, 0, 16, 16],
            &format!(r#""scissor": [2, 0, 14, 16], {}"#, fill([1.0, 1.0, 0.0, 1.0])),
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
