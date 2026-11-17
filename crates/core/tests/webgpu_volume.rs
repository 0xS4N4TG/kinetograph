//! WebGPU 3d textures (`Texture::dimension: "3d"`, whose layers are slices): a pass into one slice, an upload into a slice,
//! the `3d` view and layout dimension, and what the validation refuses (a slice a level does not have, a 2d view of a 3d
//! texture), in a 16 x 16 `glsl` layer. A recording the validation refuses is a transparent canvas, never a panic.

use std::path::Path;

use base64::Engine as _;
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

const RED: [u8; 4] = [255, 0, 0, 255];
const GREEN: [u8; 4] = [0, 255, 0, 255];
const NOTHING: [u8; 4] = [0, 0, 0, 0];

const SHADERS: &str = "
    @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
        let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
        return vec4f(p[i], 0, 1);
    }
    @fragment fn red() -> @location(0) vec4f { return vec4f(1, 0, 0, 1); }";

/// Loads the texel (0, 0) of slice `z` of level `mip` of a 3d texture, over the whole canvas.
fn load_slice(z: u32, mip: u32) -> String {
    format!(
        "@group(0) @binding(0) var t: texture_3d<f32>;
         @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {{ let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3)); return vec4f(p[i], 0, 1); }}
         @fragment fn fs() -> @location(0) vec4f {{ return textureLoad(t, vec3i(0, 0, {z}), {mip}); }}"
    )
}

fn pipeline(module: &str, fragment: &str) -> Value {
    json!({"vertex": {"module": module, "entryPoint": "vs", "buffers": []},
        "fragment": {"module": module, "entryPoint": fragment, "targets": [{"format": "rgba8unorm"}]},
        "primitive": {"topology": "triangle-list", "frontFace": "ccw", "cullMode": "none"}})
}

fn draw(pipeline: &str) -> Value {
    json!([{"c": "pipeline", "id": pipeline}, {"c": "draw", "vertices": 3, "instances": 1, "first": 0, "firstInstance": 0}])
}

/// A 4 x 4 x 4 texture `v` of two levels, `passes` into it, then a canvas pass that shows slice `z` of level `mip` through `view`.
fn volume(z: u32, mip: u32, view: Value, mut passes: Vec<Value>, blobs: Value) -> Frame {
    passes.push(json!({"k": "render", "clear": [0, 0, 0, 1], "commands": [
        {"c": "pipeline", "id": "ps"}, {"c": "bind", "index": 0, "group": "g"},
        {"c": "draw", "vertices": 3, "instances": 1, "first": 0, "firstInstance": 0}]}));
    render(json!({
        "modules": {"m": SHADERS, "s": load_slice(z, mip)},
        "pipelines": {"red": pipeline("m", "red"), "ps": pipeline("s", "fs")},
        "bindGroups": {"g": {"layout": "auto:ps:0", "entries": [{"binding": 0, "texture": view}]}},
        "textures": {"v": {"width": 4, "height": 4, "layers": 4, "dimension": "3d", "mips": 2, "format": "rgba8unorm"}},
        "blobs": blobs,
        "passes": passes
    }))
}

fn whole_view(mips: u32) -> Value {
    json!({"id": "v", "baseMip": 0, "mips": mips, "dimension": "3d"})
}

fn into_slice(slice: u32, mip: u32, clear: [f64; 4], red: bool) -> Value {
    json!({"k": "render", "target": {"texture": "v", "mip": mip, "layer": slice}, "clear": clear, "commands": if red { draw("red") } else { json!([]) }})
}

#[test]
fn a_pass_draws_into_the_slice_it_names() {
    let passes = || vec![into_slice(1, 0, [0.0, 0.0, 0.0, 1.0], true), into_slice(0, 0, [0.0, 1.0, 0.0, 1.0], false)];
    assert_eq!(px(&volume(1, 0, whole_view(2), passes(), json!({})), 8, 8), RED);
    assert_eq!(px(&volume(0, 0, whole_view(2), passes(), json!({})), 8, 8), GREEN);
}

#[test]
fn an_upload_names_the_slice_it_writes() {
    let texel: Vec<u8> = [10u8, 200, 30, 255].repeat(16);
    let blobs = json!({"px": base64::engine::general_purpose::STANDARD.encode(texel)});
    let upload = json!({"k": "upload", "texture": "v", "layer": 2, "x": 0, "y": 0, "width": 4, "height": 4, "source": {"raw": "px"}});
    assert_eq!(px(&volume(2, 0, whole_view(2), vec![upload.clone()], blobs.clone()), 8, 8), [10, 200, 30, 255]);
    assert_eq!(px(&volume(1, 0, whole_view(2), vec![upload], blobs), 8, 8), NOTHING);
}

#[test]
fn a_level_has_half_the_slices_of_the_one_before() {
    // Level 1 of a 4 x 4 x 4 texture is 2 x 2 x 2: slice 1 is there, slice 2 is not.
    let ok = volume(1, 1, whole_view(2), vec![into_slice(1, 1, [1.0, 0.0, 0.0, 1.0], false)], json!({}));
    assert_eq!(px(&ok, 8, 8), RED);
    let refused = volume(1, 1, whole_view(2), vec![into_slice(2, 1, [1.0, 0.0, 0.0, 1.0], false)], json!({}));
    assert_eq!(px(&refused, 8, 8), NOTHING);
}

#[test]
fn a_3d_texture_is_seen_through_3d_views_only() {
    let flat = json!({"id": "v", "baseMip": 0, "mips": 1});
    assert_eq!(px(&volume(0, 0, flat, vec![into_slice(0, 0, [1.0, 0.0, 0.0, 1.0], false)], json!({})), 8, 8), NOTHING);
}
