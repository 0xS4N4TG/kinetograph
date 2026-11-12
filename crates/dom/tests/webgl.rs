//! `<canvas>` with a WebGL context (packages/cli/skills/kinetograph-markup/references/SCENE.md, "glsl"): the recording the TS side puts in `data-kg-webgl` is one
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

/// The context attributes the case asks for on its second line (`// attributes: {...}`), as JSON.
fn attributes_of(script: &str) -> String {
    script
        .lines()
        .nth(1)
        .and_then(|l| l.strip_prefix("// attributes: "))
        .unwrap_or("{}")
        .to_string()
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
    let attributes = attributes_of(&script);
    let body = format!(
        "<canvas id=\"c\" width=\"{w}\" height=\"{h}\" data-kg-webgl='{}' style=\"display:block\"></canvas>\n\
         <script>\n\
         const W = {w}, H = {h};\n\
         (function (gl, W, H) {{\n{script}\n}})(document.getElementById('c').getContext('{ctx}', {attributes}), W, H);\n\
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
fn webgl_stencil() {
    run("webgl_stencil", 1.0);
}

#[test]
fn webgl2_mrt() {
    run("webgl2_mrt", 1.0);
}

#[test]
fn webgl2_depth_texture() {
    run("webgl2_depth_texture", 1.0);
}

#[test]
fn webgl2_blit_depth_stencil() {
    run("webgl2_blit_depth_stencil", 1.0);
}

#[test]
fn webgl2_cube_rt() {
    run("webgl2_cube_rt", 1.0);
}

#[test]
fn webgl2_mipmap_after_draw() {
    run("webgl2_mipmap_after_draw", 1.0);
}

#[test]
fn webgl2_msaa_resolve() {
    run("webgl2_msaa_resolve", 1.0);
}

#[test]
fn webgl2_copytex() {
    run("webgl2_copytex", 1.0);
}

#[test]
fn webgl2_srgb_target() {
    run("webgl2_srgb_target", 1.0);
}

#[test]
fn webgl2_base_level() {
    run("webgl2_base_level", 1.0);
}

#[test]
fn webgl2_r8_rg8() {
    run("webgl2_r8_rg8", 1.0);
}

#[test]
fn webgl2_divisor2() {
    run("webgl2_divisor2", 1.0);
}

#[test]
fn webgl2_float_blit() {
    run("webgl2_float_blit", 1.0);
}

#[test]
fn webgl2_float_blend() {
    run("webgl2_float_blend", 1.0);
}

#[test]
fn webgl2_ubo_shared() {
    run("webgl2_ubo_shared", 1.0);
}

#[test]
fn webgl2_ubo_two_blocks() {
    run("webgl2_ubo_two_blocks", 1.0);
}

#[test]
fn webgl2_array_uniform_name() {
    run("webgl2_array_uniform_name", 1.0);
}

#[test]
fn webgl2_alpha_to_coverage() {
    run("webgl2_alpha_to_coverage", 6.0);
}

#[test]
fn webgl2_float_mipmap() {
    run("webgl2_float_mipmap", 1.0);
}

#[test]
fn webgl2_uniform_infinity() {
    run("webgl2_uniform_infinity", 1.0);
}

#[test]
fn webgl2_matrix_inverse() {
    run("webgl2_matrix_inverse", 1.0);
}

#[test]
fn webgl2_texture3d_float() {
    run("webgl2_texture3d_float", 1.0);
}

#[test]
fn webgl2_float_linear() {
    run("webgl2_float_linear", 1.0);
}

#[test]
fn webgl2_cube_depth() {
    run("webgl2_cube_depth", 1.0);
}

#[test]
fn webgl2_texture_layers() {
    run("webgl2_texture_layers", 1.0);
}

#[test]
fn webgl2_cube_float16() {
    run("webgl2_cube_float16", 1.0);
}

#[test]
fn webgl2_cube_float32() {
    run("webgl2_cube_float32", 1.0);
}

#[test]
fn webgl2_uniform_struct_tail() {
    run("webgl2_uniform_struct_tail", 1.0);
}

#[test]
fn webgl2_uniform_struct_types() {
    run("webgl2_uniform_struct_types", 1.0);
}

#[test]
fn webgl2_ubo_range() {
    run("webgl2_ubo_range", 1.0);
}

#[test]
fn webgl2_attr_int_to_float() {
    run("webgl2_attr_int_to_float", 1.0);
}

#[test]
fn webgl2_attr_int() {
    run("webgl2_attr_int", 1.0);
}

#[test]
fn webgl2_prelude() {
    run("webgl2_prelude", 1.0);
}

#[test]
fn webgl2_cube_mip_rt() {
    run("webgl2_cube_mip_rt", 1.0);
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
        "webgl_stencil",
        "webgl2_mrt",
        "webgl2_depth_texture",
        "webgl2_blit_depth_stencil",
        "webgl2_cube_rt",
        "webgl2_mipmap_after_draw",
        "webgl2_msaa_resolve",
        "webgl2_copytex",
        "webgl2_srgb_target",
        "webgl2_base_level",
        "webgl2_r8_rg8",
        "webgl2_divisor2",
        "webgl2_float_blit",
        "webgl2_float_blend",
        "webgl2_ubo_shared",
        "webgl2_ubo_two_blocks",
        "webgl2_ubo_range",
        "webgl2_array_uniform_name",
        "webgl2_alpha_to_coverage",
        "webgl2_float_mipmap",
        "webgl2_uniform_infinity",
        "webgl2_matrix_inverse",
        "webgl2_texture3d_float",
        "webgl2_float_linear",
        "webgl2_uniform_struct_tail",
        "webgl2_attr_int_to_float",
        "webgl2_attr_int",
        "webgl2_prelude",
        "webgl2_cube_mip_rt",
        "webgl2_cube_float16",
        "webgl2_cube_float32",
        "webgl2_cube_depth",
        "webgl2_texture_layers",
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
