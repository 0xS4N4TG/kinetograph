//! WebGPU depth (`WebGpuPipeline::depth`, `WebGpuPass::depth`) and comparison samplers: what a recording with a depth
//! attachment leaves in the pixels of a 16 x 16 `glsl` layer. Each case has a version that differs only in the depth
//! part, so a test fails if the replay ignores it. A recording the validation refuses is a transparent canvas, never a panic.

use std::path::Path;

use kinetograph_core::{Frame, Scene, render_still};
use serde_json::{Value, json};

/// Two instances of a full-screen triangle: instance 0 is red at depth 0.2, instance 1 blue at depth 0.8, drawn after it.
const TWO_DEPTHS: &str = "
    struct V { @builtin(position) p: vec4f, @location(0) c: vec3f }
    @vertex fn vs(@builtin(vertex_index) i: u32, @builtin(instance_index) n: u32) -> V {
        let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
        var v: V;
        v.p = vec4f(p[i], select(0.2, 0.8, n == 1u), 1);
        v.c = select(vec3f(1, 0, 0), vec3f(0, 0, 1), n == 1u);
        return v;
    }
    @fragment fn fs(v: V) -> @location(0) vec4f { return vec4f(v.c, 1); }";

fn pipeline(depth: Option<Value>) -> Value {
    let mut p = json!({"vertex": {"module": "m", "entryPoint": "vs", "buffers": []},
        "fragment": {"module": "m", "entryPoint": "fs", "targets": [{"format": "rgba8unorm"}]},
        "primitive": {"topology": "triangle-list", "frontFace": "ccw", "cullMode": "none"}});
    if let Some(d) = depth {
        p["depth"] = d;
    }
    p
}

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

fn two_depths(pipeline: Value, depth: Option<Value>, depth_format: &str, depth_size: u32) -> Frame {
    let mut pass = json!({"k": "render", "clear": [0, 0, 0, 1], "commands": [
        {"c": "pipeline", "id": "p"},
        {"c": "draw", "vertices": 3, "instances": 2, "first": 0, "firstInstance": 0}]});
    if let Some(d) = depth {
        pass["depth"] = d;
    }
    render(json!({
        "modules": {"m": TWO_DEPTHS}, "pipelines": {"p": pipeline}, "bindGroups": {},
        "textures": {"d": {"width": depth_size, "height": depth_size, "mips": 1, "format": depth_format}},
        "passes": [pass]
    }))
}

const LESS: &str = r#"{"format":"depth24plus","write":true,"compare":"less"}"#;

fn depth_pass() -> Option<Value> {
    Some(json!({"texture": "d", "mip": 0, "clear": 1.0}))
}

#[test]
fn a_depth_test_keeps_the_nearer_triangle_whatever_the_draw_order() {
    let frame = two_depths(pipeline(Some(serde_json::from_str(LESS).unwrap())), depth_pass(), "depth24plus", 16);
    assert_eq!(px(&frame, 8, 8), [255, 0, 0, 255]);
}

#[test]
fn without_a_depth_state_the_later_triangle_wins() {
    let frame = two_depths(pipeline(None), None, "depth24plus", 16);
    assert_eq!(px(&frame, 8, 8), [0, 0, 255, 255]);
}

#[test]
fn the_compare_function_decides_which_triangle_stays() {
    let greater = json!({"format": "depth24plus", "write": true, "compare": "greater"});
    // Cleared to 0, `greater` passes both triangles, and the farther one (0.8) is the one that stays.
    let frame = two_depths(pipeline(Some(greater)), Some(json!({"texture": "d", "mip": 0, "clear": 0.0})), "depth24plus", 16);
    assert_eq!(px(&frame, 8, 8), [0, 0, 255, 255]);
}

#[test]
fn a_depth_attachment_that_is_loaded_keeps_what_an_earlier_pass_wrote() {
    let less = pipeline(Some(serde_json::from_str(LESS).unwrap()));
    let pass = |clear: Value, instances: u32, first: u32| {
        json!({"k": "render", "clear": clear, "depth": {"texture": "d", "mip": 0, "clear": if first == 0 { json!(1.0) } else { Value::Null }}, "commands": [
            {"c": "pipeline", "id": "p"},
            {"c": "draw", "vertices": 3, "instances": instances, "first": 0, "firstInstance": first}]})
    };
    // The first pass draws the red triangle (instance 0, depth 0.2). The second loads that depth and draws the blue one
    // (instance 1, depth 0.8) over it: it fails the test, so the red from the first pass stays (colour loaded too).
    let frame = render(json!({
        "modules": {"m": TWO_DEPTHS}, "pipelines": {"p": less}, "bindGroups": {},
        "textures": {"d": {"width": 16, "height": 16, "mips": 1, "format": "depth24plus"}},
        "passes": [pass(json!([0, 0, 0, 1]), 1, 0), pass(Value::Null, 1, 1)]
    }));
    assert_eq!(px(&frame, 8, 8), [255, 0, 0, 255]);
}

const SHADOW: &str = "
    @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
        let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
        return vec4f(p[i], 0.3, 1);
    }
    @fragment fn fs0() -> @location(0) vec4f { return vec4f(0, 0, 0, 1); }
    @group(0) @binding(0) var map: texture_depth_2d;
    @group(0) @binding(1) var cmp: sampler_comparison;
    @fragment fn fs1(@builtin(position) pos: vec4f) -> @location(0) vec4f {
        let lit = textureSampleCompare(map, cmp, pos.xy / 16.0, 0.5);
        return vec4f(lit, lit, lit, 1);
    }";

fn shadow(compare: Option<&str>) -> Frame {
    let target = |fragment: &str, depth: Option<Value>| {
        let mut p = pipeline(depth);
        p["vertex"]["module"] = json!("m");
        p["fragment"]["entryPoint"] = json!(fragment);
        p
    };
    let mut sampler = json!({});
    if let Some(c) = compare {
        sampler["compare"] = json!(c);
    }
    render(json!({
        "modules": {"m": SHADOW},
        // The first pass writes depth 0.3 over the left half of the texture (a scissor), the rest stays at the clear, 1.0.
        "pipelines": {
            "pd": target("fs0", Some(json!({"format": "depth32float", "write": true, "compare": "less"}))),
            "pc": target("fs1", None),
        },
        "layouts": {"l": [
            {"binding": 0, "visibility": 2, "type": "texture", "sampleType": "depth"},
            {"binding": 1, "visibility": 2, "type": "sampler", "samplerType": "comparison"}]},
        "bindGroups": {"g": {"layout": "auto:pc:0", "entries": [
            {"binding": 0, "texture": {"id": "d", "baseMip": 0, "mips": 1}},
            {"binding": 1, "sampler": "s"}]}},
        "textures": {
            "d": {"width": 16, "height": 16, "mips": 1, "format": "depth32float"},
            "c": {"width": 16, "height": 16, "mips": 1, "format": "rgba8unorm"}},
        "samplers": {"s": sampler},
        "passes": [
            {"k": "render", "target": {"texture": "c", "mip": 0}, "clear": [0, 0, 0, 1], "depth": {"texture": "d", "mip": 0, "clear": 1.0},
             "commands": [{"c": "pipeline", "id": "pd"}, {"c": "scissor", "x": 0, "y": 0, "width": 8, "height": 16},
                          {"c": "draw", "vertices": 3, "instances": 1, "first": 0, "firstInstance": 0}]},
            {"k": "render", "clear": [0, 0, 0, 1], "commands": [
                {"c": "pipeline", "id": "pc"}, {"c": "bind", "index": 0, "group": "g"},
                {"c": "draw", "vertices": 3, "instances": 1, "first": 0, "firstInstance": 0}]}]
    }))
}

#[test]
fn a_comparison_sampler_reads_a_depth_texture_a_pass_wrote() {
    // Reference 0.5: `less` is true where the stored depth is above it (the cleared half) and false where it is 0.3.
    let frame = shadow(Some("less"));
    assert_eq!(px(&frame, 12, 8), [255, 255, 255, 255], "stored depth 1.0 is above 0.5");
    assert_eq!(px(&frame, 4, 8), [0, 0, 0, 255], "stored depth 0.3 is below 0.5");
    // The opposite compare swaps the halves, so the sampler's compare is what decides.
    let frame = shadow(Some("greater"));
    assert_eq!(px(&frame, 12, 8), [0, 0, 0, 255]);
    assert_eq!(px(&frame, 4, 8), [255, 255, 255, 255]);
}

#[test]
fn a_depth_attachment_the_wrong_size_or_format_draws_nothing_and_does_not_panic() {
    let less = || Some(serde_json::from_str::<Value>(LESS).unwrap());
    let wrong_size = two_depths(pipeline(less()), depth_pass(), "depth24plus", 8);
    assert_eq!(px(&wrong_size, 8, 8)[3], 0);
    let colour_format = two_depths(pipeline(less()), depth_pass(), "rgba8unorm", 16);
    assert_eq!(px(&colour_format, 8, 8)[3], 0);
    let good = two_depths(pipeline(less()), depth_pass(), "depth24plus", 16);
    assert_eq!(px(&good, 8, 8)[3], 255);
}
