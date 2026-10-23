//! `<canvas>` with a WebGL context (packages/cli/skills/kinetograph/references/SCENE.md, "glsl"): the recording the TS side puts in `data-kg-webgl` is one
//! glsl layer in the painted scene. Each case is a file of WebGL calls (`tests/webgl/<name>.js`) and the recording
//! the recorder made of it (`<name>.json`, `tools/webgl-cases.mjs`). The page has both: Chrome runs the calls with
//! its own WebGL (the oracle; SwiftShader, so the numbers do not depend on the GPU), and the engine runs the
//! recording with naga and wgpu. The two pictures are compared (they are in `target/paint-tests`), and ours
//! against its committed golden.

mod paintkit;

use paintkit::compare;

fn case_file(name: &str, extension: &str) -> String {
    let path = paintkit::repo_root()
        .join("crates/dom/tests/webgl")
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
    // GLSL ES 3.00 needs a WebGL 2 context.
    let ctx = if script.contains("#version 300 es") {
        "webgl2"
    } else {
        "webgl"
    };
    let body = format!(
        "<canvas id=\"c\" width=\"{w}\" height=\"{h}\" data-kg-webgl='{}' style=\"display:block\"></canvas>\n\
         <script>\n\
         const W = {w}, H = {h};\n\
         (function (gl, W, H) {{\n{script}\n}})(document.getElementById('c').getContext('{ctx}'), W, H);\n\
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
fn webgl_gradient() {
    run("webgl_gradient", 1.0);
}

#[test]
fn webgl_noise() {
    run("webgl_noise", 1.0);
}

#[test]
fn webgl_texture() {
    run("webgl_texture", 2.0);
}

#[test]
fn webgl_framebuffer() {
    run("webgl_framebuffer", 1.0);
}

#[test]
fn a_canvas_with_a_recording_is_one_glsl_layer_at_its_bitmap_size() {
    let recording = case_file("webgl_gradient", "json");
    let body = format!(
        "<canvas id=\"c\" width=\"96\" height=\"64\" data-kg-webgl='{}' style=\"display:block\"></canvas>",
        recording.trim()
    );
    let layers = paintkit::paint_html(&paintkit::page(&body), 200, 100).layers;
    let canvas = layers
        .iter()
        .find(|l| l["id"].as_str().is_some_and(|id| id.starts_with("c")))
        .expect("a glsl layer");
    assert_eq!(canvas["type"], "glsl");
    assert_eq!(canvas["width"].as_f64(), Some(96.0));
    assert!(canvas["ops"].as_array().is_some_and(|ops| !ops.is_empty()));
}

#[test]
fn the_committed_recordings_parse_as_the_scene_format_does() {
    for name in [
        "webgl_gradient",
        "webgl_noise",
        "webgl_texture",
        "webgl_framebuffer",
    ] {
        let content: serde_json::Value = serde_json::from_str(&case_file(name, "json")).unwrap();
        let mut layer = serde_json::json!({ "id": "c", "type": "glsl", "width": 10, "height": 10 });
        layer
            .as_object_mut()
            .unwrap()
            .extend(content.as_object().unwrap().clone());
        let scene = serde_json::json!({
            "width": 10, "height": 10, "fps": 30, "durationInFrames": 1, "layers": [layer],
        });
        kinetograph_core::Scene::from_json(&scene.to_string(), Default::default())
            .unwrap_or_else(|e| panic!("{name}: {e}"));
    }
}
