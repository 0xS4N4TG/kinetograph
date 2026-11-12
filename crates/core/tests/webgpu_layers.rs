//! WebGPU texture arrays (`Texture::layers`, the `layer` of a pass target, an upload and a copy, a view's `baseLayer`,
//! `layers` and `dimension`) and passes with several colour attachments: what a recording leaves in the pixels of a 16 x 16
//! `glsl` layer. Each case has a version that differs only in the part it tests, so a test fails if the replay ignores it.
//! A recording the validation refuses is a transparent canvas, never a panic.

use std::path::Path;

use base64::Engine as _;
use kinetograph_core::{Frame, Scene, render_still};
use serde_json::{Value, json};

fn scene_of(webgpu: Value) -> Scene {
    let layer = json!({"id": "g", "type": "glsl", "width": 16, "height": 16, "webgpu": webgpu});
    let scene = json!({"width": 16, "height": 16, "fps": 30, "durationInFrames": 1, "background": "#00000000", "layers": [layer]});
    Scene::from_json(&scene.to_string(), Path::new(env!("CARGO_MANIFEST_DIR")).join("tests")).unwrap()
}

fn render(webgpu: Value) -> Frame {
    render_still(scene_of(webgpu), 0).unwrap()
}

fn px(frame: &Frame, x: usize, y: usize) -> [u8; 4] {
    let i = (y * frame.width as usize + x) * 4;
    frame.rgba[i..i + 4].try_into().unwrap()
}

const RED: [u8; 4] = [255, 0, 0, 255];
const GREEN: [u8; 4] = [0, 255, 0, 255];

const SHADERS: &str = "
    @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
        let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
        return vec4f(p[i], 0, 1);
    }
    @fragment fn red() -> @location(0) vec4f { return vec4f(1, 0, 0, 1); }";

const SAMPLE_2D: &str = "
    @group(0) @binding(0) var t: texture_2d<f32>;
    @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
        let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
        return vec4f(p[i], 0, 1);
    }
    @fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f { return textureLoad(t, vec2i(pos.xy), 0); }";

const SAMPLE_ARRAY: &str = "
    @group(0) @binding(0) var t: texture_2d_array<f32>;
    @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
        let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
        return vec4f(p[i], 0, 1);
    }
    @fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f { return textureLoad(t, vec2i(pos.xy), 1, 0); }";

fn pipeline(module: &str, vertex: &str, fragment: &str) -> Value {
    json!({"vertex": {"module": module, "entryPoint": vertex, "buffers": []},
        "fragment": {"module": module, "entryPoint": fragment, "targets": [{"format": "rgba8unorm"}]},
        "primitive": {"topology": "triangle-list", "frontFace": "ccw", "cullMode": "none"}})
}

fn draw(pipeline: &str) -> Value {
    json!([{"c": "pipeline", "id": pipeline}, {"c": "draw", "vertices": 3, "instances": 1, "first": 0, "firstInstance": 0}])
}

/// The canvas pass that draws `sampler` over the whole canvas, with the bind group `g`.
fn present() -> Value {
    json!({"k": "render", "clear": [0, 0, 0, 1], "commands": [
        {"c": "pipeline", "id": "ps"}, {"c": "bind", "index": 0, "group": "g"},
        {"c": "draw", "vertices": 3, "instances": 1, "first": 0, "firstInstance": 0}]})
}

/// A 16 x 16 two-layer texture `a`, a pipeline `ps` from `sampler` (the `fs` of that module) that draws `a`'s view `view`,
/// and `passes` before the canvas pass.
fn arrays(sampler: &str, view: Value, passes: Vec<Value>) -> Frame {
    let mut all = passes;
    all.push(present());
    render(json!({
        "modules": {"m": SHADERS, "s": sampler},
        "pipelines": {"red": pipeline("m", "vs", "red"), "ps": pipeline("s", "vs", "fs")},
        "bindGroups": {"g": {"layout": "auto:ps:0", "entries": [{"binding": 0, "texture": view}]}},
        "textures": {"a": {"width": 16, "height": 16, "layers": 2, "mips": 1, "format": "rgba8unorm"}},
        "passes": all
    }))
}

fn layer_view(layer: u32) -> Value {
    json!({"id": "a", "baseMip": 0, "mips": 1, "baseLayer": layer})
}

/// A pass into `layer` of `a`, cleared to `clear`, that draws the red triangle when `red`.
fn into_layer(layer: u32, clear: [f64; 4], red: bool) -> Value {
    json!({"k": "render", "target": {"texture": "a", "mip": 0, "layer": layer}, "clear": clear, "commands": if red { draw("red") } else { json!([]) }})
}

#[test]
fn a_pass_draws_into_the_layer_it_names_and_a_2d_view_reads_one_layer() {
    let passes = || vec![into_layer(1, [0.0, 0.0, 0.0, 1.0], true), into_layer(0, [0.0, 1.0, 0.0, 1.0], false)];
    assert_eq!(px(&arrays(SAMPLE_2D, layer_view(1), passes()), 8, 8), RED);
    assert_eq!(px(&arrays(SAMPLE_2D, layer_view(0), passes()), 8, 8), GREEN);
}

#[test]
fn a_2d_array_view_is_read_by_a_texture_2d_array_binding() {
    let array = json!({"id": "a", "baseMip": 0, "mips": 1, "baseLayer": 0, "layers": 2, "dimension": "2d-array"});
    let passes = vec![into_layer(1, [0.0, 0.0, 0.0, 1.0], true), into_layer(0, [0.0, 1.0, 0.0, 1.0], false)];
    // The shader reads layer 1 of the array it is given.
    assert_eq!(px(&arrays(SAMPLE_ARRAY, array, passes), 8, 8), RED);
    // With the layers swapped, the same shader reads the other colour.
    let array = json!({"id": "a", "baseMip": 0, "mips": 1, "baseLayer": 0, "layers": 2, "dimension": "2d-array"});
    let swapped = vec![into_layer(0, [0.0, 0.0, 0.0, 1.0], true), into_layer(1, [0.0, 1.0, 0.0, 1.0], false)];
    assert_eq!(px(&arrays(SAMPLE_ARRAY, array, swapped), 8, 8), GREEN);
}

fn upload(layer: u32) -> Value {
    json!({"k": "upload", "texture": "a", "layer": layer, "x": 0, "y": 0, "width": 16, "height": 16, "source": {"raw": "px"}})
}

fn with_blob(mut frame: Value) -> Value {
    let texel: Vec<u8> = [10u8, 200, 30, 255].repeat(16 * 16);
    frame["blobs"] = json!({"px": base64::engine::general_purpose::STANDARD.encode(texel)});
    frame
}

#[test]
fn an_upload_and_a_copy_name_the_layer_they_write_and_read() {
    let build = |sampled: u32, copy: bool| {
        let mut passes = vec![upload(1)];
        if copy {
            passes.push(json!({"k": "copy", "from": {"texture": "a", "mip": 0, "layer": 1, "x": 0, "y": 0}, "to": {"texture": "a", "mip": 0, "layer": 0, "x": 0, "y": 0}, "width": 16, "height": 16}));
        }
        passes.push(present());
        render(with_blob(json!({
            "modules": {"s": SAMPLE_2D},
            "pipelines": {"ps": pipeline("s", "vs", "fs")},
            "bindGroups": {"g": {"layout": "auto:ps:0", "entries": [{"binding": 0, "texture": layer_view(sampled)}]}},
            "textures": {"a": {"width": 16, "height": 16, "layers": 2, "mips": 1, "format": "rgba8unorm"}},
            "passes": passes
        })))
    };
    assert_eq!(px(&build(1, false), 8, 8), [10, 200, 30, 255]);
    // Layer 0 was not written by the upload: transparent black until the copy.
    assert_eq!(px(&build(0, false), 8, 8), [0, 0, 0, 0]);
    assert_eq!(px(&build(0, true), 8, 8), [10, 200, 30, 255]);
}

#[test]
fn a_layer_that_is_not_there_draws_nothing_and_does_not_panic() {
    let good = || vec![into_layer(1, [0.0, 0.0, 0.0, 1.0], true)];
    assert_eq!(px(&arrays(SAMPLE_2D, layer_view(1), good()), 8, 8), RED);
    // A pass into layer 2 of a texture of two, a view of layers past the end, a 2d view of two layers.
    assert_eq!(px(&arrays(SAMPLE_2D, layer_view(1), vec![into_layer(2, [0.0; 4], false)]), 8, 8)[3], 0);
    assert_eq!(px(&arrays(SAMPLE_2D, layer_view(2), good()), 8, 8)[3], 0);
    assert_eq!(px(&arrays(SAMPLE_2D, json!({"id": "a", "baseMip": 0, "mips": 1, "layers": 2}), good()), 8, 8)[3], 0);
    assert_eq!(px(&arrays(SAMPLE_2D, json!({"id": "a", "baseMip": 0, "mips": 1, "layers": 2, "dimension": "cube"}), good()), 8, 8)[3], 0);
}

#[test]
fn a_binding_and_its_view_must_have_the_same_dimension_and_a_multisampled_array_is_refused() {
    let layouts = |dimension: Option<&str>| {
        let mut entry = json!({"binding": 0, "visibility": 2, "type": "texture"});
        if let Some(d) = dimension {
            entry["viewDimension"] = json!(d);
        }
        json!({"l": [entry]})
    };
    let frame = |dimension: Option<&str>, view: Value| {
        render(json!({
            "modules": {"m": SHADERS, "s": SAMPLE_2D},
            "layouts": layouts(dimension),
            "pipelines": {"red": pipeline("m", "vs", "red"), "ps": {"layout": ["l"], "vertex": {"module": "s", "entryPoint": "vs", "buffers": []},
                "fragment": {"module": "s", "entryPoint": "fs", "targets": [{"format": "rgba8unorm"}]},
                "primitive": {"topology": "triangle-list", "frontFace": "ccw", "cullMode": "none"}}},
            "bindGroups": {"g": {"layout": "l", "entries": [{"binding": 0, "texture": view}]}},
            "textures": {"a": {"width": 16, "height": 16, "layers": 2, "mips": 1, "format": "rgba8unorm"}},
            "passes": [into_layer(1, [0.0, 0.0, 0.0, 1.0], true), present()]
        }))
    };
    // The shader wants a texture_2d, so a 2d layout and a 2d view are the combination that draws.
    assert_eq!(px(&frame(None, layer_view(1)), 8, 8), RED);
    let array_view = json!({"id": "a", "baseMip": 0, "mips": 1, "layers": 2, "dimension": "2d-array"});
    // A 2d-array view for a 2d layout is refused by the validation: nothing at all is drawn, not even the clear.
    let mismatched = frame(None, array_view.clone());
    assert_eq!(px(&mismatched, 8, 8), [0, 0, 0, 0]);
    let mismatched = frame(Some("2d-array"), layer_view(1));
    assert_eq!(px(&mismatched, 8, 8), [0, 0, 0, 0]);
    let multisampled = render(json!({
        "modules": {"m": SHADERS}, "pipelines": {"p": pipeline("m", "vs", "red")}, "bindGroups": {},
        "textures": {"a": {"width": 16, "height": 16, "layers": 2, "mips": 1, "format": "rgba8unorm", "samples": 4}},
        "passes": [present_nothing()]
    }));
    assert_eq!(px(&multisampled, 8, 8), [0, 0, 0, 0]);
}

/// A canvas pass that draws red, for recordings with no bind group.
fn present_nothing() -> Value {
    json!({"k": "render", "clear": [0, 0, 0, 1], "commands": draw("p")})
}
