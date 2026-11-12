//! WebGPU cube texture views (`dimension: "cube"` and `"cube-array"`, a layout's `viewDimension`): which face or layer a
//! shader's direction picks from a texture of six (or twelve) layers, in a 16 x 16 `glsl` layer. A recording the validation
//! refuses is a transparent canvas, never a panic.

use std::path::Path;

use kinetograph_core::{Frame, Scene, render_still};
use serde_json::{Value, json};

fn render(webgpu: Value) -> Frame {
    let layer = json!({"id": "g", "type": "glsl", "width": 16, "height": 16, "webgpu": webgpu});
    let scene = json!({"width": 16, "height": 16, "fps": 30, "durationInFrames": 1, "background": "#00000000", "layers": [layer]});
    render_still(Scene::from_json(&scene.to_string(), Path::new(env!("CARGO_MANIFEST_DIR")).join("tests")).unwrap(), 0).unwrap()
}

fn px(frame: &Frame, x: usize, y: usize) -> [u8; 4] {
    let i = (y * frame.width as usize + x) * 4;
    frame.rgba[i..i + 4].try_into().unwrap()
}

const FACES: [[f64; 4]; 6] = [[1.0, 0.0, 0.0, 1.0], [0.0, 1.0, 0.0, 1.0], [0.0, 0.0, 1.0, 1.0], [1.0, 1.0, 1.0, 1.0], [1.0, 1.0, 0.0, 1.0], [1.0, 0.0, 1.0, 1.0]];
const FRAME_FACES: [[u8; 4]; 6] = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255], [255, 255, 0, 255], [255, 0, 255, 255]];

/// Samples a cube map in `direction`, drawing the whole canvas with it.
fn cube_shader(direction: &str) -> String {
    format!(
        "@group(0) @binding(0) var t: texture_cube<f32>; @group(0) @binding(1) var s: sampler;
         @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {{ let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3)); return vec4f(p[i], 0, 1); }}
         @fragment fn fs() -> @location(0) vec4f {{ return textureSample(t, s, {direction}); }}"
    )
}

fn array_shader(direction: &str, index: u32) -> String {
    format!(
        "@group(0) @binding(0) var t: texture_cube_array<f32>; @group(0) @binding(1) var s: sampler;
         @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {{ let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3)); return vec4f(p[i], 0, 1); }}
         @fragment fn fs() -> @location(0) vec4f {{ return textureSample(t, s, {direction}, {index}); }}"
    )
}

/// The colour of layer `l`: the six faces, and past them the same colours shifted by one (so that a second cube differs).
fn colour(l: u32) -> usize {
    if l < 6 { l as usize } else { (l as usize + 1) % 6 }
}

/// A texture of `layers` layers, each cleared to its `colour`, then sampled through `view`.
fn sampled(shader: &str, layers: u32, view: Value) -> Frame {
    let mut passes: Vec<Value> = (0..layers).map(|l| json!({"k": "render", "target": {"texture": "a", "mip": 0, "layer": l}, "clear": FACES[colour(l)], "commands": []})).collect();
    passes.push(json!({"k": "render", "clear": [0, 0, 0, 1], "commands": [
        {"c": "pipeline", "id": "p"}, {"c": "bind", "index": 0, "group": "g"},
        {"c": "draw", "vertices": 3, "instances": 1, "first": 0, "firstInstance": 0}]}));
    render(json!({
        "modules": {"m": shader},
        "pipelines": {"p": {"vertex": {"module": "m", "entryPoint": "vs", "buffers": []},
            "fragment": {"module": "m", "entryPoint": "fs", "targets": [{"format": "rgba8unorm"}]},
            "primitive": {"topology": "triangle-list", "frontFace": "ccw", "cullMode": "none"}}},
        "samplers": {"s": {}},
        "bindGroups": {"g": {"layout": "auto:p:0", "entries": [{"binding": 0, "texture": view}, {"binding": 1, "sampler": "s"}]}},
        "textures": {"a": {"width": 8, "height": 8, "layers": layers, "mips": 1, "format": "rgba8unorm"}},
        "passes": passes
    }))
}

fn cube(layers: u32) -> Value {
    json!({"id": "a", "baseMip": 0, "mips": 1, "baseLayer": 0, "layers": layers, "dimension": if layers == 6 { "cube" } else { "cube-array" }})
}

#[test]
fn a_cube_view_gives_each_direction_its_face() {
    let directions = ["vec3f(1, 0, 0)", "vec3f(-1, 0, 0)", "vec3f(0, 1, 0)", "vec3f(0, -1, 0)", "vec3f(0, 0, 1)", "vec3f(0, 0, -1)"];
    for (face, direction) in directions.iter().enumerate() {
        assert_eq!(px(&sampled(&cube_shader(direction), 6, cube(6)), 8, 8), FRAME_FACES[face], "{direction}");
    }
}

#[test]
fn a_cube_array_view_picks_the_cube_by_index() {
    // Twelve layers: +Y of cube 0 is layer 2, of cube 1 layer 8 (colour 3).
    assert_eq!(px(&sampled(&array_shader("vec3f(0, 1, 0)", 0), 12, cube(12)), 8, 8), FRAME_FACES[2]);
    assert_eq!(px(&sampled(&array_shader("vec3f(0, 1, 0)", 1), 12, cube(12)), 8, 8), FRAME_FACES[3]);
    // A cube view of layers 6..12 is that second cube.
    let moved = json!({"id": "a", "baseMip": 0, "mips": 1, "baseLayer": 6, "layers": 6, "dimension": "cube"});
    assert_eq!(px(&sampled(&cube_shader("vec3f(0, 1, 0)"), 12, moved), 8, 8), FRAME_FACES[3]);
}

#[test]
fn a_cube_view_needs_six_layers_and_a_square_texture() {
    let five = json!({"id": "a", "baseMip": 0, "mips": 1, "baseLayer": 0, "layers": 5, "dimension": "cube"});
    assert_eq!(px(&sampled(&cube_shader("vec3f(1, 0, 0)"), 6, five), 8, 8), [0, 0, 0, 0]);
    let seven = json!({"id": "a", "baseMip": 0, "mips": 1, "baseLayer": 0, "layers": 7, "dimension": "cube-array"});
    assert_eq!(px(&sampled(&array_shader("vec3f(1, 0, 0)", 0), 12, seven), 8, 8), [0, 0, 0, 0]);
}
