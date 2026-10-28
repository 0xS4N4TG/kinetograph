//! WebGPU compute (`webgpu::Step::Compute` and the buffer steps): what a recording that dispatches leaves in the pixels
//! (packages/cli/skills/kinetograph/references/ENGINE.md, "WebGPU"). Each case is a `glsl` layer of 16 x 16 whose
//! `webgpu` part runs a compute pass that writes a known pattern into a storage texture or a storage buffer, then a render
//! pass that reads it back into the canvas, so the pixels are the pattern, exactly. A recording that asks for more than
//! the device has, or for what wgpu refuses, is a transparent canvas and a warning, never a panic.

use std::path::Path;

use base64::Engine as _;
use kinetograph_core::{Frame, Scene, render_still};
use serde_json::{Value, json};

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn words(values: &[u32]) -> String {
    b64(&values.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>())
}

/// A full-screen triangle and a fragment shader named `fs` that reads what `body` says.
fn present(declarations: &str, body: &str) -> String {
    format!(
        "{declarations}
        @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {{
            let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
            return vec4f(p[i], 0, 1);
        }}
        @fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {{
            let xy = vec2i(pos.xy);
            {body}
        }}"
    )
}

const RENDER_PIPELINE: &str = r#"{"vertex":{"module":"mr","entryPoint":"vs","buffers":[]},
    "fragment":{"module":"mr","entryPoint":"fs","targets":[{"format":"rgba8unorm"}]},
    "primitive":{"topology":"triangle-list","frontFace":"ccw","cullMode":"none"}}"#;

fn render_pipeline() -> Value {
    serde_json::from_str(RENDER_PIPELINE).unwrap()
}

fn texture_bind(binding: u32, id: &str) -> Value {
    json!({"binding": binding, "texture": {"id": id, "baseMip": 0, "mips": 1}})
}

fn draw_pass() -> Value {
    json!({"k": "render", "clear": [0, 0, 0, 1], "commands": [
        {"c": "pipeline", "id": "rp"},
        {"c": "bind", "index": 0, "group": "gr"},
        {"c": "draw", "vertices": 3, "instances": 1, "first": 0, "firstInstance": 0}]})
}

fn dispatch_pass(x: u32, y: u32, z: u32) -> Value {
    json!({"k": "compute", "commands": [
        {"c": "pipeline", "id": "cp"},
        {"c": "bind", "index": 0, "group": "gc"},
        {"c": "dispatch", "x": x, "y": y, "z": z}]})
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

/// A compute pipeline `cp` over `compute`, the render pipeline `rp` over `present`, with automatic layouts.
fn base(compute: &str, present_wgsl: &str) -> Value {
    json!({
        "modules": {"mc": compute, "mr": present_wgsl},
        "computePipelines": {"cp": {"module": "mc", "entryPoint": "main"}},
        "pipelines": {"rp": render_pipeline()},
        "bindGroups": {},
        "textures": {},
        "passes": [],
    })
}

#[test]
fn a_compute_pass_writes_a_storage_texture_and_a_render_pass_samples_it_exactly() {
    let compute = "@group(0) @binding(0) var out: texture_storage_2d<rgba8unorm, write>;
        @compute @workgroup_size(4, 4) fn main(@builtin(global_invocation_id) id: vec3u) {
            textureStore(out, vec2i(id.xy), vec4f(f32(id.x) / 15.0, f32(id.y) / 15.0, f32(id.x + id.y) / 30.0, 1.0));
        }";
    let present = present("@group(0) @binding(0) var tex: texture_2d<f32>;", "return textureLoad(tex, xy, 0);");
    let mut webgpu = base(compute, &present);
    webgpu["textures"] = json!({"t": {"width": 16, "height": 16, "mips": 1, "format": "rgba8unorm"}});
    webgpu["bindGroups"] = json!({
        "gc": {"layout": "auto:cp:0", "entries": [texture_bind(0, "t")]},
        "gr": {"layout": "auto:rp:0", "entries": [texture_bind(0, "t")]},
    });
    webgpu["passes"] = json!([dispatch_pass(4, 4, 1), draw_pass()]);
    let frame = render(webgpu);
    for y in 0..16usize {
        for x in 0..16usize {
            // x / 15 of 255 is 17 x; (x + y) / 30 of 255 is 8.5 (x + y), which unorm rounds to the nearest, half up.
            let blue = ((x + y) as f32 * 8.5).round() as u8;
            assert_eq!(px(&frame, x, y), [17 * x as u8, 17 * y as u8, blue, 255], "pixel {x},{y}");
        }
    }
}

#[test]
fn a_storage_buffer_is_written_by_the_queue_updated_by_a_pass_and_read_by_a_later_one() {
    // The buffer starts as 0..16 (a write step), a compute pass makes each word w -> 2 w + 1 and a second one adds 3 to
    // the word its invocation owns: the page's order is the replay's. Pixel x of every row is then 2 x + 4.
    let compute = "@group(0) @binding(0) var<storage, read_write> data: array<u32>;
        @compute @workgroup_size(16) fn main(@builtin(global_invocation_id) id: vec3u) { data[id.x] = data[id.x] * 2u + 1u; }
        @compute @workgroup_size(16) fn add(@builtin(global_invocation_id) id: vec3u) { data[id.x] = data[id.x] + 3u; }";
    let present = present(
        "@group(0) @binding(0) var<storage, read> data: array<u32>;",
        "return vec4f(f32(data[u32(xy.x)]) / 255.0, 0.0, 0.0, 1.0);",
    );
    let mut webgpu = base(compute, &present);
    webgpu["computePipelines"]["add"] = json!({"module": "mc", "entryPoint": "add"});
    webgpu["gpuBuffers"] = json!({"B1": {"size": 64}});
    webgpu["blobs"] = json!({"init": words(&(0..16).collect::<Vec<u32>>())});
    let group = json!({"layout": "auto:cp:0", "entries": [{"binding": 0, "buffer": "B1", "offset": 0, "size": 64}]});
    let add_group = json!({"layout": "auto:add:0", "entries": [{"binding": 0, "buffer": "B1", "offset": 0, "size": 64}]});
    let read_group = json!({"layout": "auto:rp:0", "entries": [{"binding": 0, "buffer": "B1", "offset": 0, "size": 64}]});
    webgpu["bindGroups"] = json!({"gc": group, "ga": add_group, "gr": read_group});
    webgpu["passes"] = json!([
        {"k": "writeBuffer", "buffer": "B1", "offset": 0, "data": "init"},
        dispatch_pass(1, 1, 1),
        {"k": "compute", "commands": [{"c": "pipeline", "id": "add"}, {"c": "bind", "index": 0, "group": "ga"}, {"c": "dispatch", "x": 1, "y": 1, "z": 1}]},
        draw_pass(),
    ]);
    let frame = render(webgpu);
    for y in [0usize, 7, 15] {
        for x in 0..16usize {
            assert_eq!(px(&frame, x, y), [(2 * x + 4) as u8, 0, 0, 255], "pixel {x},{y}");
        }
    }
}

#[test]
fn buffer_copies_and_clears_run_in_order_with_the_passes() {
    // B1 = 0..16 by a write, B2 = a copy of it, B1 is cleared; the render pass shows B2 (x) and B1 (the blue channel, 0).
    let compute = "@compute @workgroup_size(1) fn main() {}";
    let present = present(
        "@group(0) @binding(0) var<storage, read> a: array<u32>; @group(0) @binding(1) var<storage, read> b: array<u32>;",
        "return vec4f(f32(a[u32(xy.x)]) / 255.0, 0.0, f32(b[u32(xy.x)]) / 255.0, 1.0);",
    );
    let mut webgpu = base(compute, &present);
    webgpu["gpuBuffers"] = json!({"B1": {"size": 64}, "B2": {"size": 64}});
    webgpu["blobs"] = json!({"init": words(&(0..16).map(|n| n * 10).collect::<Vec<u32>>())});
    webgpu["bindGroups"] = json!({"gr": {"layout": "auto:rp:0", "entries": [
        {"binding": 0, "buffer": "B2", "offset": 0, "size": 64}, {"binding": 1, "buffer": "B1", "offset": 0, "size": 64}]}});
    webgpu["passes"] = json!([
        {"k": "writeBuffer", "buffer": "B1", "offset": 0, "data": "init"},
        {"k": "copyBuffer", "from": "B1", "fromOffset": 0, "to": "B2", "toOffset": 0, "size": 64},
        {"k": "clearBuffer", "buffer": "B1", "offset": 0, "size": 32},
        draw_pass(),
    ]);
    let frame = render(webgpu);
    for x in 0..16usize {
        // The first 32 bytes (8 words) of B1 are cleared; the rest still hold 10 x.
        let blue = if x < 8 { 0 } else { (x * 10) as u8 };
        assert_eq!(px(&frame, x, 3), [(x * 10) as u8, 0, blue, 255], "pixel {x}");
    }
}

#[test]
fn a_32_bit_float_storage_texture_is_sampled_as_unfilterable_float() {
    let compute = "@group(0) @binding(0) var out: texture_storage_2d<rgba32float, write>;
        @compute @workgroup_size(4, 4) fn main(@builtin(global_invocation_id) id: vec3u) {
            textureStore(out, vec2i(id.xy), vec4f(f32(id.x % 6u) * 0.2, f32(id.y % 6u) * 0.2, 0.0, 1.0));
        }";
    let present = present(
        "@group(0) @binding(0) var tex: texture_2d<f32>; @group(0) @binding(1) var samp: sampler;",
        "return textureSample(tex, samp, (vec2f(xy) + vec2f(0.5)) / 16.0);",
    );
    let mut webgpu = base(compute, &present);
    webgpu["layouts"] = json!({
        "lc": [{"binding": 0, "visibility": 4, "type": "storage-texture", "format": "rgba32float"}],
        "lr": [{"binding": 0, "visibility": 2, "type": "texture", "sampleType": "unfilterable-float"},
               {"binding": 1, "visibility": 2, "type": "sampler", "samplerType": "non-filtering"}],
    });
    webgpu["computePipelines"]["cp"]["layout"] = json!(["lc"]);
    webgpu["pipelines"]["rp"]["layout"] = json!(["lr"]);
    webgpu["samplers"] = json!({"s": {}});
    webgpu["textures"] = json!({"t": {"width": 16, "height": 16, "mips": 1, "format": "rgba32float"}});
    webgpu["bindGroups"] = json!({
        "gc": {"layout": "lc", "entries": [texture_bind(0, "t")]},
        "gr": {"layout": "lr", "entries": [texture_bind(0, "t"), {"binding": 1, "sampler": "s"}]},
    });
    webgpu["passes"] = json!([dispatch_pass(4, 4, 1), draw_pass()]);
    let frame = render(webgpu);
    for (x, y) in [(0usize, 0usize), (1, 0), (5, 2), (6, 1), (13, 14), (15, 15)] {
        let channel = |n: usize| ((n % 6) as f32 * 0.2 * 255.0).round() as u8;
        assert_eq!(px(&frame, x, y), [channel(x), channel(y), 0, 255], "pixel {x},{y}");
    }
}

#[test]
fn a_read_write_r32float_storage_texture_keeps_what_an_earlier_pass_wrote() {
    let compute = "@group(0) @binding(0) var acc: texture_storage_2d<r32float, read_write>;
        @compute @workgroup_size(4, 4) fn main(@builtin(global_invocation_id) id: vec3u) {
            let at = vec2i(id.xy);
            textureStore(acc, at, vec4f(textureLoad(acc, at).x + 0.25, 0.0, 0.0, 1.0));
        }";
    let present = present("@group(0) @binding(0) var tex: texture_2d<f32>;", "return vec4f(textureLoad(tex, xy, 0).x, 0.0, 0.0, 1.0);");
    let mut webgpu = base(compute, &present);
    webgpu["layouts"] = json!({
        "lc": [{"binding": 0, "visibility": 4, "type": "storage-texture", "access": "read-write", "format": "r32float"}],
        "lr": [{"binding": 0, "visibility": 2, "type": "texture", "sampleType": "unfilterable-float"}],
    });
    webgpu["computePipelines"]["cp"]["layout"] = json!(["lc"]);
    webgpu["pipelines"]["rp"]["layout"] = json!(["lr"]);
    webgpu["textures"] = json!({"t": {"width": 16, "height": 16, "mips": 1, "format": "r32float"}});
    webgpu["bindGroups"] = json!({
        "gc": {"layout": "lc", "entries": [texture_bind(0, "t")]},
        "gr": {"layout": "lr", "entries": [texture_bind(0, "t")]},
    });
    // Three passes add 0.25 each time: 0.75 of 255 is 191.25.
    webgpu["passes"] = json!([dispatch_pass(4, 4, 1), dispatch_pass(4, 4, 1), dispatch_pass(4, 4, 1), draw_pass()]);
    let frame = render(webgpu);
    assert_eq!(px(&frame, 0, 0), [191, 0, 0, 255]);
    assert_eq!(px(&frame, 15, 15), [191, 0, 0, 255]);
}

/// The canvas a recording that cannot be drawn leaves: nothing (the layer's drawing buffer is cleared).
fn assert_nothing_drawn(frame: &Frame) {
    for (x, y) in [(0usize, 0usize), (8, 8), (15, 15)] {
        assert_eq!(px(frame, x, y)[3], 0, "pixel {x},{y} should be transparent: {:?}", px(frame, x, y));
    }
}

fn pattern() -> Value {
    let compute = "@group(0) @binding(0) var out: texture_storage_2d<rgba8unorm, write>;
        @compute @workgroup_size(4, 4) fn main(@builtin(global_invocation_id) id: vec3u) { textureStore(out, vec2i(id.xy), vec4f(1)); }";
    let present = present("@group(0) @binding(0) var tex: texture_2d<f32>;", "return textureLoad(tex, xy, 0);");
    let mut webgpu = base(compute, &present);
    webgpu["textures"] = json!({"t": {"width": 16, "height": 16, "mips": 1, "format": "rgba8unorm"}});
    webgpu["bindGroups"] = json!({
        "gc": {"layout": "auto:cp:0", "entries": [texture_bind(0, "t")]},
        "gr": {"layout": "auto:rp:0", "entries": [texture_bind(0, "t")]},
    });
    webgpu["passes"] = json!([dispatch_pass(4, 4, 1), draw_pass()]);
    webgpu
}

#[test]
fn the_good_pattern_draws_so_the_bad_ones_below_differ_only_in_what_is_wrong() {
    let frame = render(pattern());
    assert_eq!(px(&frame, 3, 3), [255, 255, 255, 255]);
}

#[test]
fn a_dispatch_over_the_limit_a_workgroup_over_the_limit_and_too_many_dispatches_draw_nothing() {
    let mut huge = pattern();
    huge["passes"][0] = dispatch_pass(70000, 1, 1);
    assert_nothing_drawn(&render(huge));

    let mut too_many = pattern();
    let commands: Vec<Value> = [json!({"c": "pipeline", "id": "cp"}), json!({"c": "bind", "index": 0, "group": "gc"})]
        .into_iter()
        .chain((0..5000).map(|_| json!({"c": "dispatch", "x": 1, "y": 1, "z": 1})))
        .collect();
    too_many["passes"][0] = json!({"k": "compute", "commands": commands});
    assert_nothing_drawn(&render(too_many));

    let mut wide = pattern();
    wide["modules"]["mc"] = json!(
        "@group(0) @binding(0) var out: texture_storage_2d<rgba8unorm, write>;
         @compute @workgroup_size(32, 32) fn main(@builtin(global_invocation_id) id: vec3u) { textureStore(out, vec2i(id.xy), vec4f(1)); }"
    );
    assert_nothing_drawn(&render(wide));
}

#[test]
fn what_wgpu_refuses_is_a_warning_and_a_transparent_canvas_not_a_panic() {
    // The shader says rgba8unorm and the texture is rgba16float: the bind group does not fit the pipeline's layout.
    let mut mismatch = pattern();
    mismatch["textures"]["t"]["format"] = json!("rgba16float");
    assert_nothing_drawn(&render(mismatch));

    // A compute pass that names a bind group no layout of the pipeline has.
    let mut stray = pattern();
    stray["passes"][0]["commands"][1]["index"] = json!(3);
    assert_nothing_drawn(&render(stray));

    // A module that is not WGSL.
    let mut broken = pattern();
    broken["modules"]["mc"] = json!("fn main( {");
    assert_nothing_drawn(&render(broken));

    // A storage texture view of two levels, a buffer binding past its buffer, a step that names nothing.
    let mut views = pattern();
    views["textures"]["t"]["mips"] = json!(2);
    views["bindGroups"]["gc"]["entries"][0]["texture"]["mips"] = json!(2);
    assert_nothing_drawn(&render(views));
    let mut ghost = pattern();
    ghost["passes"][1] = json!({"k": "clearBuffer", "buffer": "B7", "offset": 0, "size": 4});
    assert_nothing_drawn(&render(ghost));
}

/// A canvas of `format` (with `extra` in the recording) that one render pass fills with `colour`, under a layer
/// `opacity`, over black.
fn filled(format: &str, colour: [f32; 4], extra: Value, opacity: f64) -> Frame {
    let [r, g, b, a] = colour;
    let module = present("", &format!("return vec4f({r:?}, {g:?}, {b:?}, {a:?});"));
    let mut pipeline = render_pipeline();
    pipeline["fragment"]["targets"][0]["format"] = json!(format);
    let mut webgpu = json!({
        "modules": {"mr": module},
        "pipelines": {"rp": pipeline},
        "passes": [{"k": "render", "clear": [0, 0, 0, 1], "commands": [
            {"c": "pipeline", "id": "rp"},
            {"c": "draw", "vertices": 3, "instances": 1, "first": 0, "firstInstance": 0}]}],
    });
    for (k, v) in extra.as_object().unwrap() {
        webgpu[k] = v.clone();
    }
    let layer = json!({"id": "g", "type": "glsl", "width": 16, "height": 16, "opacity": opacity, "webgpu": webgpu});
    let scene = json!({"width": 16, "height": 16, "fps": 30, "durationInFrames": 1, "background": "#000000", "layers": [layer]});
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    render_still(Scene::from_json(&scene.to_string(), base).unwrap(), 0).unwrap()
}

fn srgb_to_linear(c: f64) -> f64 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

fn linear_to_srgb(l: f64) -> f64 {
    if l <= 0.003_130_8 { l * 12.92 } else { 1.055 * l.powf(1.0 / 2.4) - 0.055 }
}

#[test]
fn an_rgba16float_canvas_keeps_its_precision_through_compositing() {
    // 569/4096 is between two 8-bit steps. At a quarter opacity over black, an 8-bit canvas rounds it to 35/255 first
    // and comes out 13; the half-float canvas keeps it and comes out 14, as the exact sum says.
    let v = 569.0 / 4096.0;
    let exact = (255.0 * linear_to_srgb(0.25 * srgb_to_linear(v))).round() as u8;
    assert_eq!(exact, 14);
    let grey = [v as f32, v as f32, v as f32, 1.0];
    let wide = filled("rgba16float", grey, json!({"canvasFormat": "rgba16float"}), 0.25);
    assert_eq!(px(&wide, 8, 8)[..3], [exact; 3]);
    let narrow = filled("rgba8unorm", grey, json!({}), 0.25);
    assert_eq!(px(&narrow, 8, 8)[..3], [13; 3]);
    // Out of range is clipped, as a canvas of the standard tone mapping is.
    let clipped = filled("rgba16float", [2.0, -1.0, 0.6, 1.0], json!({"canvasFormat": "rgba16float"}), 1.0);
    assert_eq!(px(&clipped, 8, 8), [255, 0, 153, 255]);
    // A pipeline whose target is not the canvas's format is refused: nothing over the black.
    let mismatched = filled("rgba8unorm", [1.0, 1.0, 1.0, 1.0], json!({"canvasFormat": "rgba16float"}), 1.0);
    assert_eq!(px(&mismatched, 8, 8), [0, 0, 0, 255]);
}

#[test]
fn a_display_p3_canvas_is_converted_to_srgb_primaries() {
    let lin = [0.6, 0.4, 0.2].map(srgb_to_linear);
    // Linear Display P3 to linear sRGB (CSS Color 4), by rows.
    let m = [
        [1.2249401, -0.2249404, 0.0],
        [-0.0420569, 1.0420571, 0.0],
        [-0.0196376, -0.0786361, 1.0982735],
    ];
    let want: Vec<i32> = m
        .iter()
        .map(|row| (255.0 * linear_to_srgb(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2])).round() as i32)
        .collect();
    let colour = [0.6, 0.4, 0.2, 1.0];
    for (format, extra) in [
        ("rgba8unorm", json!({"colorSpace": "display-p3"})),
        ("rgba16float", json!({"colorSpace": "display-p3", "canvasFormat": "rgba16float"})),
    ] {
        let got = px(&filled(format, colour, extra, 1.0), 8, 8);
        for (g, w) in got.iter().zip(&want) {
            assert!((i32::from(*g) - w).abs() <= 1, "{format}: {got:?}, want {want:?}");
        }
    }
    // The same values in sRGB are drawn as they are.
    assert_eq!(px(&filled("rgba8unorm", colour, json!({}), 1.0), 8, 8), [153, 102, 51, 255]);
    // A P3 red outside sRGB's gamut is clipped into it.
    let red = filled("rgba8unorm", [1.0, 0.0, 0.0, 1.0], json!({"colorSpace": "display-p3"}), 1.0);
    assert_eq!(px(&red, 8, 8), [255, 0, 0, 255]);
}
