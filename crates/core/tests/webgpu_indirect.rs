//! WebGPU indirect calls the GPU wrote the arguments of (`Command::DrawIndirect`, `DrawIndexedIndirect`,
//! `ComputeCommand::DispatchIndirect`), in a 16 x 16 `glsl` layer: a compute pass writes the arguments into a buffer, and the
//! next pass reads them. Each case has a version whose arguments differ, so a test fails if the replay ignores them.
//! A recording the validation refuses is a transparent canvas, never a panic.

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

const RED: [u8; 4] = [255, 0, 0, 255];
const BLACK: [u8; 4] = [0, 0, 0, 255];

/// Writes `values` (the arguments) into the buffer `B1`.
fn writer(values: &[u32]) -> String {
    let stores: String = values.iter().enumerate().map(|(n, v)| format!("args[{n}] = {v}u;")).collect();
    format!("@group(0) @binding(0) var<storage, read_write> args: array<u32>; @compute @workgroup_size(1) fn write() {{ {stores} }}")
}

const DRAW: &str = "
    @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
        let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
        return vec4f(p[i], 0, 1);
    }
    @fragment fn fs() -> @location(0) vec4f { return vec4f(1, 0, 0, 1); }";

fn write_args(values: &[u32]) -> Value {
    json!({
        "modules": {"w": writer(values), "m": DRAW},
        "computePipelines": {"cw": {"module": "w", "entryPoint": "write"}},
        "pipelines": {"rp": {"vertex": {"module": "m", "entryPoint": "vs", "buffers": []},
            "fragment": {"module": "m", "entryPoint": "fs", "targets": [{"format": "rgba8unorm"}]},
            "primitive": {"topology": "triangle-list", "frontFace": "ccw", "cullMode": "none"}}},
        "gpuBuffers": {"B1": {"size": 32}},
        "bindGroups": {"gw": {"layout": "auto:cw:0", "entries": [{"binding": 0, "buffer": "B1", "offset": 0, "size": 32}]}},
    })
}

fn write_pass() -> Value {
    json!({"k": "compute", "commands": [{"c": "pipeline", "id": "cw"}, {"c": "bind", "index": 0, "group": "gw"}, {"c": "dispatch", "x": 1, "y": 1, "z": 1}]})
}

fn indirect_draw(offset: u64) -> Value {
    json!({"k": "render", "clear": [0, 0, 0, 1], "commands": [{"c": "pipeline", "id": "rp"}, {"c": "drawIndirect", "buffer": "B1", "offset": offset}]})
}

#[test]
fn a_draw_indirect_draws_what_the_arguments_a_pass_wrote_say() {
    let frame = |args: &[u32]| {
        let mut webgpu = write_args(args);
        webgpu["passes"] = json!([write_pass(), indirect_draw(0)]);
        render(webgpu)
    };
    assert_eq!(px(&frame(&[3, 1, 0, 0]), 8, 8), RED);
    assert_eq!(px(&frame(&[0, 1, 0, 0]), 8, 8), BLACK);
    assert_eq!(px(&frame(&[3, 0, 0, 0]), 8, 8), BLACK);
}

#[test]
fn a_draw_indirect_reads_its_arguments_at_the_offset() {
    let mut webgpu = write_args(&[0, 0, 0, 0, 3, 1, 0, 0]);
    webgpu["passes"] = json!([write_pass(), indirect_draw(16)]);
    assert_eq!(px(&render(webgpu), 8, 8), RED);
}

#[test]
fn a_draw_indexed_indirect_draws_the_indices_the_arguments_name() {
    let frame = |count: u32| {
        let mut webgpu = write_args(&[count, 1, 0, 0, 0]);
        webgpu["buffers"] = json!({"I": "AAABAAIAAAA="});
        webgpu["passes"] = json!([write_pass(), {"k": "render", "clear": [0, 0, 0, 1], "commands": [
            {"c": "pipeline", "id": "rp"}, {"c": "index", "buffer": "I", "format": "uint16", "offset": 0},
            {"c": "drawIndexedIndirect", "buffer": "B1", "offset": 0}]}]);
        render(webgpu)
    };
    assert_eq!(px(&frame(3), 8, 8), RED);
    assert_eq!(px(&frame(0), 8, 8), BLACK);
}

#[test]
fn a_dispatch_indirect_launches_the_counts_a_pass_wrote() {
    let fill = "@group(0) @binding(0) var out: texture_storage_2d<rgba8unorm, write>;
        @compute @workgroup_size(4, 4) fn main(@builtin(global_invocation_id) id: vec3u) { textureStore(out, vec2i(id.xy), vec4f(1, 0, 0, 1)); }";
    let show = "@group(0) @binding(0) var tex: texture_2d<f32>;
        @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3)); return vec4f(p[i], 0, 1); }
        @fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f { return textureLoad(tex, vec2i(pos.xy), 0); }";
    let frame = |args: &[u32]| {
        let mut webgpu = write_args(args);
        webgpu["modules"]["f"] = json!(fill);
        webgpu["modules"]["s"] = json!(show);
        webgpu["computePipelines"]["cf"] = json!({"module": "f", "entryPoint": "main"});
        webgpu["pipelines"]["ps"] = json!({"vertex": {"module": "s", "entryPoint": "vs", "buffers": []},
            "fragment": {"module": "s", "entryPoint": "fs", "targets": [{"format": "rgba8unorm"}]},
            "primitive": {"topology": "triangle-list", "frontFace": "ccw", "cullMode": "none"}});
        webgpu["textures"] = json!({"t": {"width": 16, "height": 16, "mips": 1, "format": "rgba8unorm"}});
        let view = json!({"id": "t", "baseMip": 0, "mips": 1});
        webgpu["bindGroups"]["gf"] = json!({"layout": "auto:cf:0", "entries": [{"binding": 0, "texture": view}]});
        webgpu["bindGroups"]["gs"] = json!({"layout": "auto:ps:0", "entries": [{"binding": 0, "texture": view}]});
        webgpu["passes"] = json!([write_pass(),
            {"k": "compute", "commands": [{"c": "pipeline", "id": "cf"}, {"c": "bind", "index": 0, "group": "gf"}, {"c": "dispatchIndirect", "buffer": "B1", "offset": 0}]},
            {"k": "render", "clear": [0, 0, 0, 1], "commands": [{"c": "pipeline", "id": "ps"}, {"c": "bind", "index": 0, "group": "gs"}, {"c": "draw", "vertices": 3, "instances": 1, "first": 0, "firstInstance": 0}]}]);
        render(webgpu)
    };
    let all = frame(&[4, 4, 1]);
    assert_eq!((px(&all, 1, 1), px(&all, 14, 14)), (RED, RED));
    let left = frame(&[2, 4, 1]);
    assert_eq!((px(&left, 1, 1), px(&left, 14, 14)), (RED, [0, 0, 0, 0]));
}

#[test]
fn arguments_outside_the_buffer_or_in_one_the_gpu_does_not_write_draw_nothing_and_do_not_panic() {
    let mut webgpu = write_args(&[3, 1, 0, 0]);
    webgpu["passes"] = json!([write_pass(), indirect_draw(24)]);
    assert_eq!(px(&render(webgpu), 8, 8), [0, 0, 0, 0]);
    let mut webgpu = write_args(&[3, 1, 0, 0]);
    webgpu["passes"] = json!([write_pass(), indirect_draw(2)]);
    assert_eq!(px(&render(webgpu), 8, 8), [0, 0, 0, 0]);
    let mut webgpu = write_args(&[3, 1, 0, 0]);
    let mut pass = indirect_draw(0);
    pass["commands"][1]["buffer"] = json!("B9");
    webgpu["passes"] = json!([write_pass(), pass]);
    assert_eq!(px(&render(webgpu), 8, 8), [0, 0, 0, 0]);
}
