//! `<canvas>` with a WebGPU context (packages/cli/skills/kinetograph-markup/references/ENGINE.md, "WebGPU"): the recording the TS side
//! puts in `data-kg-webgl` is one glsl layer with a `webgpu` part. Each case is a file of WebGPU calls
//! (`tests/webgpu/<name>.js`) and the recording the recorder made of it (`<name>.json`, `tools/webgpu-cases.mjs`).
//! The page has both: Chrome runs the calls on a real device (the oracle, headless on SwiftShader's Vulkan adapter, so
//! the numbers do not depend on the GPU), and the engine replays the recording on wgpu. The two pictures are compared
//! (they are in `target/paint-tests`), and ours against its committed golden.

mod paintkit;

use paintkit::compare;

fn case_file(name: &str, extension: &str) -> String {
    let path = paintkit::repo_root()
        .join("crates/dom/tests/webgpu")
        .join(format!("{name}.{extension}"));
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

fn size_of(script: &str) -> (u32, u32) {
    let line = script.lines().next().unwrap_or_default();
    let mut numbers = line
        .strip_prefix("// size: ")
        .unwrap_or_else(|| panic!("the first line is the size, got {line:?}"))
        .split(' ')
        .map(|n| n.parse::<u32>().unwrap());
    (numbers.next().unwrap(), numbers.next().unwrap())
}

/// The mean and largest difference from Chrome (`None` without Chrome).
fn run(name: &str, mean_limit: f64) -> Option<(f64, u8)> {
    let script = case_file(name, "js");
    let recording = case_file(name, "json");
    let (w, h) = size_of(&script);
    assert!(
        !recording.contains('\''),
        "{name}.json has a single quote, which would end its attribute"
    );
    let body = format!(
        "<canvas id=\"c\" width=\"{w}\" height=\"{h}\" data-kg-webgl='{}' style=\"display:block\"></canvas>\n\
         <script>\n\
         (async () => {{\n\
           const W = {w}, H = {h}, format = 'rgba8unorm';\n\
           const adapter = await navigator.gpu.requestAdapter();\n\
           const device = await adapter.requestDevice();\n\
           const context = document.getElementById('c').getContext('webgpu');\n\
           context.configure({{ device, format, alphaMode: 'premultiplied' }});\n\
           await (async function (device, context, format, W, H) {{\n{script}\n}})(device, context, format, W, H);\n\
           await device.queue.onSubmittedWorkDone();\n\
         }})();\n\
         </script>",
        recording.trim()
    );
    let (out, frame, diff) = compare(name, &body, w, h);
    assert!(
        out.unsupported.is_empty(),
        "{name}: unsupported {:?}",
        out.unsupported
    );
    paintkit::check_golden(name, &frame);
    println!("{name}: {diff:?}");
    if let Some(d) = diff {
        assert!(d.mean < mean_limit, "{name}: {d:?}");
    }
    diff.map(|d| (d.mean, d.max))
}

#[test]
fn webgpu_triangle() {
    run("webgpu_triangle", 1.0);
}

#[test]
fn webgpu_mesh() {
    run("webgpu_mesh", 1.5);
}

#[test]
fn webgpu_offscreen() {
    run("webgpu_offscreen", 1.0);
}

#[test]
fn webgpu_queries() {
    run("webgpu_queries", 1.0);
}

#[test]
fn webgpu_shadow() {
    run("webgpu_shadow", 1.5);
}

#[test]
fn webgpu_array() {
    run("webgpu_array", 1.0);
}
