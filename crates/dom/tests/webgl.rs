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

/// ANGLE's golden of a case, `tests/golden/angle/<name>.png` (with `UPDATE_GOLDEN=1`, written): no channel of any pixel may
/// differ by more than `ANGLE_GOLDEN_TOLERANCE`. The same machine and backend give the same bytes; the tolerance is for a
/// driver or ANGLE update that moves a rounding.
const ANGLE_GOLDEN_TOLERANCE: u8 = 3;

/// `ANGLE_GOLDEN_TOLERANCE=0` asks for the same bytes, to show a change leaves the pictures as they were.
fn golden_tolerance() -> u8 {
    std::env::var("ANGLE_GOLDEN_TOLERANCE").ok().and_then(|v| v.parse().ok()).unwrap_or(ANGLE_GOLDEN_TOLERANCE)
}

fn check_angle_golden(name: &str, frame: &kinetograph_core::Frame) {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("tests/golden/angle/{name}.png"));
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        paintkit::save_frame(frame, &path);
        return;
    }
    let golden = image::open(&path)
        .unwrap_or_else(|e| {
            panic!(
                "cannot read {}: {e} (run with UPDATE_GOLDEN=1 on the M4)",
                path.display()
            )
        })
        .to_rgba8();
    assert_eq!(
        (golden.width(), golden.height()),
        (frame.width, frame.height),
        "{name}: size changed"
    );
    let worst = golden
        .as_raw()
        .iter()
        .zip(&frame.rgba)
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap_or(0);
    assert!(
        worst <= golden_tolerance(),
        "{name}: a channel differs from {} by {worst} (the tolerance is {})",
        path.display(),
        golden_tolerance()
    );
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

/// The page of a case: its canvas with the recording, and the calls that made it.
fn body_of(name: &str) -> (String, u32, u32) {
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
    (body, w, h)
}

/// The mean and largest difference from Chrome (`None` without Chrome).
fn run(name: &str, mean_limit: f64) -> Option<(f64, u8)> {
    let (body, w, h) = body_of(name);
    let (out, frame, diff) = compare(name, &body, w, h);
    assert!(
        out.unsupported.is_empty(),
        "{name}: unsupported {:?}",
        out.unsupported
    );
    // The goldens in tests/golden are the hand-written replay's bytes. ANGLE has its own (tests/golden/angle, recorded on
    // the M4 with ANGLE's Metal backend, so a picture that is black or blank does not pass without Chrome), compared with a
    // tolerance; ANGLE on SwiftShader is held to Chrome's picture only.
    if !angle_mode() {
        paintkit::check_golden(name, &frame);
    } else if std::env::var("KINETOGRAPH_ANGLE_BACKEND").as_deref() != Ok("swiftshader") {
        check_angle_golden(name, &frame);
    }
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
    // ANGLE's Metal backend filters the cube faces a little differently from the SwiftShader one Chrome's oracle runs on
    // (mean 1.03, largest 32; SwiftShader gives 0): a real backend difference, so the limit is 1.5 with Metal.
    let swiftshader = std::env::var("KINETOGRAPH_ANGLE_BACKEND").as_deref() == Ok("swiftshader");
    run(
        "webgl2_cube_rt",
        if angle_mode() && !swiftshader {
            1.5
        } else {
            1.0
        },
    );
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

/// The cases of what `gl_FrontFacing` does (the hand-written replay does not follow `frontFace` with culling off, so these
/// run with `KINETOGRAPH_WEBGL=angle` only).
fn angle_only(name: &str) {
    if angle_mode() {
        run(name, 1.0);
    }
}

/// A case only ANGLE can draw: with ANGLE it is compared with Chrome as any other; the hand-written replay must stop the
/// frame with an `unsupported:` error that names the gap, not draw it wrong or crash.
fn angle_only_reported(name: &str) {
    if angle_mode() {
        run(name, 1.0);
        return;
    }
    let (body, w, h) = body_of(name);
    let error = match paintkit::try_render_body(&body, w, h) {
        Err(error) => error,
        Ok(_) => panic!("{name}: the hand-written replay drew a case it cannot draw"),
    };
    assert!(error.contains("unsupported:"), "{name}: {error}");
}

fn angle_mode() -> bool {
    std::env::var("KINETOGRAPH_WEBGL").as_deref() == Ok("angle")
}

#[test]
fn webgl2_clear_masks() {
    angle_only_reported("webgl2_clear_masks");
}

#[test]
fn webgl2_front_face() {
    angle_only("webgl2_front_face");
}

#[test]
fn webgl_depth_luminance() {
    run("webgl_depth_luminance", 1.0);
}

#[test]
fn webgl2_stencil_renderbuffer() {
    run("webgl2_stencil_renderbuffer", 1.0);
}

#[test]
fn webgl2_matrix_varying() {
    angle_only("webgl2_matrix_varying");
}

#[test]
fn webgl2_frag_depth_range() {
    angle_only("webgl2_frag_depth_range");
}

#[test]
fn webgl2_uniform_default_unset() {
    angle_only("webgl2_uniform_default_unset");
}

#[test]
fn webgl2_front_face_reset() {
    angle_only("webgl2_front_face_reset");
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

/// A frame is a pure function of its recording, whatever this thread drew before it: pairs of cases, one after the other
/// in a thread and the other way round in another, give the same bytes (the ANGLE context is one for each thread and keeps
/// its programs and enabled extensions).
#[test]
fn a_frame_does_not_depend_on_what_the_thread_drew_before() {
    let render = |names: Vec<&'static str>| {
        std::thread::spawn(move || {
            names
                .into_iter()
                .map(|n| {
                    let (body, w, h) = body_of(n);
                    (n, paintkit::render_body(&body, w, h).1.rgba)
                })
                .collect::<Vec<_>>()
        })
        .join()
        .unwrap()
    };
    for (a, b) in [
        ("webgl2_float_linear", "webgl_texture"),
        ("webgl2_float_blend", "webgl2_msaa_resolve"),
        ("webgl2_float_mipmap", "webgl_gradient"),
        ("webgl2_depth_texture", "webgl2_float_linear"),
        // State the context keeps: a narrowed depthRange, and the uniforms of a program of the same source.
        ("webgl2_depth_range_set", "webgl2_frag_depth_range"),
        ("webgl2_uniform_default_set", "webgl2_uniform_default_unset"),
        ("webgl2_uvec_default_set", "webgl2_uvec_default_unset"),
    ] {
        let ab = render(vec![a, b, a]);
        let ba = render(vec![b, a, b]);
        assert_eq!(ab[0].1, ab[2].1, "{a} after {b} differs from {a} first");
        assert_eq!(ba[0].1, ba[2].1, "{b} after {a} differs from {b} first");
        assert_eq!(
            ab[0].1, ba[1].1,
            "{a}: order of the thread's frames matters"
        );
        assert_eq!(
            ab[1].1, ba[0].1,
            "{b}: order of the thread's frames matters"
        );
    }
}

/// A page that never enabled `OES_texture_float_linear` reads a 32-bit float texture with a linear filter as an
/// incomplete one, even when the page drawn just before it on the same thread enabled the extension.
#[test]
fn an_extension_a_page_enabled_does_not_reach_the_next_page() {
    let (with, w, h) = body_of("webgl2_float_linear");
    let without = with
        .replace("gl.getExtension('OES_texture_float_linear');", "")
        .replace("\"floatLinear\":true", "\"floatLinear\":false");
    assert_ne!(with, without, "the case has no extension line to strip");
    let render = |bodies: Vec<String>| {
        std::thread::spawn(move || {
            bodies
                .iter()
                .map(|b| paintkit::render_body(b, w, h).1.rgba)
                .collect::<Vec<_>>()
        })
        .join()
        .unwrap()
    };
    let after = render(vec![with.clone(), without.clone()]);
    let alone = render(vec![without.clone(), with.clone()]);
    assert_eq!(
        after[1], alone[0],
        "the page without the extension drew differently after one with it"
    );
    assert_eq!(after[0], alone[1]);
    // The extension makes a difference to this case, or the test proves nothing.
    assert_ne!(
        after[0], after[1],
        "the case draws the same with and without the extension"
    );
}

/// A draw ANGLE rejects fails the frame with an error that names the op and its program, instead of drawing nothing.
#[test]
fn a_draw_angle_rejects_is_an_error_naming_the_op() {
    if !angle_mode() {
        return;
    }
    let (body, w, h) = body_of("webgl_gradient");
    // Far more vertices than the buffers hold: WebGL validation refuses the draw.
    let bad = body.replace("\"count\":6,", "\"count\":6000,");
    assert_ne!(bad, body, "the case has no draw of 6 vertices");
    let failure = std::panic::catch_unwind(|| paintkit::render_body(&bad, w, h)).err();
    let failure = failure.expect("a rejected draw must fail the frame");
    let text = failure
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| failure.downcast_ref::<&str>().map(|s| (*s).to_string()))
        .unwrap_or_default();
    assert!(
        text.contains("draw, program") && text.contains("GL error"),
        "{text}"
    );
}

/// A program that does not compile is an error naming the shader, on every frame, and the cache keeps no half-made program.
#[test]
fn a_program_that_does_not_compile_is_an_error() {
    if !angle_mode() {
        return;
    }
    let (body, w, h) = body_of("webgl_gradient");
    let bad = body.replace("void main", "void mian");
    assert_ne!(bad, body, "the case has no main to break");
    for frame in 0..2 {
        let failure = std::panic::catch_unwind(|| paintkit::render_body(&bad, w, h)).err();
        let failure =
            failure.unwrap_or_else(|| panic!("frame {frame}: a shader that does not compile drew"));
        let text = failure
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| failure.downcast_ref::<&str>().map(|s| (*s).to_string()))
            .unwrap_or_default();
        assert!(
            text.contains("shader") || text.contains("link"),
            "frame {frame}: {text}"
        );
    }
}

/// Four threads painting at once give the bytes one thread does (ANGLE is entered one thread at a time).
#[test]
fn threads_painting_at_once_give_the_same_bytes() {
    if !angle_mode() {
        return;
    }
    let (body, w, h) = body_of("webgl2_mrt");
    let alone = paintkit::render_body(&body, w, h).1.rgba;
    let threads: Vec<_> = (0..4)
        .map(|_| {
            let body = body.clone();
            std::thread::spawn(move || {
                (0..6)
                    .map(|_| paintkit::render_body(&body, w, h).1.rgba)
                    .collect::<Vec<_>>()
            })
        })
        .collect();
    for thread in threads {
        for frame in thread.join().unwrap() {
            assert!(
                frame == alone,
                "a frame painted beside other threads differs from one painted alone"
            );
        }
    }
}

/// The recorder's ids are not promises about content: two scenes in one process that give a texture the same id and different
/// pixels each show their own (a kept texture is keyed by what it is made from, not by its id).
#[test]
fn a_texture_id_reused_with_other_pixels_shows_the_new_pixels() {
    let (first, w, h) = body_of("webgl_texture");
    // 4 x 4 RGBA of grey 128, in place of the checker of the case, under the same id.
    let grey = "gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";
    let marker = "\"pixels\":\"";
    let at = first.find(marker).expect("the case has a texture of pixels") + marker.len();
    let end = at + first[at..].find('"').unwrap();
    let second = format!("{}{grey}{}", &first[..at], &first[end..]);
    let render = |bodies: Vec<&String>| {
        let bodies: Vec<String> = bodies.into_iter().cloned().collect();
        std::thread::spawn(move || {
            bodies.iter().map(|b| paintkit::render_body(b, w, h).1.rgba).collect::<Vec<_>>()
        })
        .join()
        .unwrap()
    };
    let one_after_the_other = render(vec![&first, &second]);
    let alone = render(vec![&second]);
    assert_ne!(one_after_the_other[0], one_after_the_other[1], "the two textures draw alike");
    assert!(
        one_after_the_other[1] == alone[0],
        "the second scene drew the first one's texture"
    );
}
