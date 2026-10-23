//! Identical-frame reuse (`kinetograph_core::reuse`): with it on, a frame that
//! is the same as the frame before is not drawn, and every frame must still be
//! byte for byte what a new renderer without reuse draws. A frame that changes
//! only through time (a shader's time, grain, a playing video, a GIF or Lottie
//! playing, a canvas's commands, a file that changed) must be drawn.
//!
//! Needs a GPU; the M4 runs it with the rest of `crates/core/tests/`.


use std::path::{Path, PathBuf};

use image::{ImageBuffer, Rgba};
use kinetograph_core::{Frame, Renderer, Scene, render_still};

fn scenes_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scenes")
}

/// A 160x90 scene of `layers` (a JSON list's insides), 30 frames at 30 fps.
fn scene_in(dir: &Path, layers: &str) -> Scene {
    let json = format!(
        r##"{{ "width": 160, "height": 90, "fps": 30, "durationInFrames": 30, "background": "#202020",
              "layers": [{layers}] }}"##
    );
    Scene::from_json(&json, dir.to_path_buf()).unwrap()
}

fn scene(layers: &str) -> Scene {
    scene_in(&scenes_dir(), layers)
}

const MOVING_THEN_HELD: &str = r##"
    { "id": "box", "type": "shape", "shape": { "kind": "rect", "width": 30, "height": 20 }, "fill": "#f6c177",
      "transform": { "x": [{ "frame": 0, "value": 10 }, { "frame": 5, "value": 60 }], "y": 30 } }"##;

/// Frames `frames` of `scenes` (one scene per frame, as a project's frames
/// come), drawn one after another on one renderer with reuse and the layer
/// cache on, one frame in flight as a video render draws them. Returns the
/// frames and which of them were repeats.
fn run(scenes: &[Scene], frames: &[u32]) -> (Vec<Frame>, Vec<bool>) {
    let mut renderer = Renderer::new(scenes[0].clone()).unwrap();
    renderer.set_layer_cache(true);
    renderer.set_frame_reuse(true);
    let mut out = Vec::new();
    let mut repeats = Vec::new();
    let mut in_flight = None;
    for (i, &frame) in frames.iter().enumerate() {
        renderer
            .set_scene(scenes[i.min(scenes.len() - 1)].clone())
            .unwrap();
        let pending = renderer.start_frame(frame).unwrap();
        repeats.push(pending.is_repeat());
        if let Some(previous) = in_flight.replace(pending) {
            out.push(renderer.finish_frame(previous).unwrap());
        }
    }
    out.push(renderer.finish_frame(in_flight.unwrap()).unwrap());
    assert_eq!(
        renderer.repeated_frames(),
        repeats.iter().filter(|r| **r).count() as u64
    );
    (out, repeats)
}

/// Every frame is what a new renderer, without reuse, draws.
fn check(scenes: &[Scene], frames: &[u32], got: &[Frame], what: &str) {
    for (i, (&frame, got)) in frames.iter().zip(got).enumerate() {
        let want = render_still(scenes[i.min(scenes.len() - 1)].clone(), frame).unwrap();
        assert!(
            got.rgba == want.rgba,
            "{what}: frame {frame} differs from a fresh renderer's"
        );
    }
}

#[test]
fn a_held_frame_is_not_drawn_again_and_is_the_same() {
    let scenes = [scene(MOVING_THEN_HELD)];
    let frames: Vec<u32> = (0..12).collect();
    let (got, repeats) = run(&scenes, &frames);
    // The box moves until frame 5 and stays there.
    let want: Vec<bool> = frames.iter().map(|&f| f > 5).collect();
    assert_eq!(repeats, want);
    check(&scenes, &frames, &got, "held");
}

#[test]
fn a_held_video_picture_and_a_held_gif_time_are_reused() {
    // A video showing one picture and a GIF at one time: the same frame.
    let scenes = [scene(
        r##"{ "id": "v", "type": "video", "src": "media/clip.mp4", "frame": 10, "width": 64 },
           { "id": "g", "type": "gif", "src": "media/spinner.gif", "time": 0.15, "transform": { "x": 80 } }"##,
    )];
    let frames: Vec<u32> = (0..6).collect();
    let (got, repeats) = run(&scenes, &frames);
    assert_eq!(repeats, [false, true, true, true, true, true]);
    check(&scenes, &frames, &got, "held media");
}

/// Frames that change through one time-dependent input alone are all drawn,
/// and do change.
#[test]
fn a_frame_that_changes_only_through_time_is_drawn() {
    let cases = [
        (
            "shader time",
            r##"{ "id": "s", "type": "shape", "shape": { "kind": "rect", "width": 100, "height": 60 }, "fill": "#808080",
                 "effects": [{ "type": "shader",
                   "code": "fn effect(px: vec2<f32>) -> vec4<f32> { let c = layer(px); return vec4<f32>(c.rgb * (0.5 + 0.5 * sin(globals.time * 9.0)), c.a); }" }] }"##,
        ),
        (
            "grain",
            r##"{ "id": "s", "type": "shape", "shape": { "kind": "rect", "width": 100, "height": 60 }, "fill": "#808080",
                 "effects": [{ "type": "grain", "amount": 0.3, "seed": 3 }] }"##,
        ),
        (
            "video",
            r##"{ "id": "v", "type": "video", "src": "media/clip.mp4", "width": 96 }"##,
        ),
        (
            "gif",
            r##"{ "id": "g", "type": "gif", "src": "media/spinner.gif", "transform": { "scale": 2 } }"##,
        ),
        (
            "lottie",
            r##"{ "id": "l", "type": "lottie", "src": "anims/burst.json", "width": 90 }"##,
        ),
    ];
    for (what, layers) in cases {
        let scenes = [scene(layers)];
        let frames: Vec<u32> = (0..6).collect();
        let (got, repeats) = run(&scenes, &frames);
        assert!(
            repeats.iter().all(|r| !r),
            "{what}: a frame was reused: {repeats:?}"
        );
        assert!(
            got.windows(2).any(|w| w[0].rgba != w[1].rgba),
            "{what}: the frames do not change, so the case proves nothing"
        );
        check(&scenes, &frames, &got, what);
    }
}

#[test]
fn a_canvas_is_reused_only_while_its_commands_are_the_same() {
    let canvas = |colour: &str| {
        scene(&format!(
            r##"{{ "id": "c", "type": "canvas", "width": 160, "height": 90,
                  "commands": [{{ "op": "fill", "path": "M10 10h50v40h-50Z", "paint": {{ "type": "color", "color": "{colour}" }} }}] }}"##
        ))
    };
    // A scene per frame, as a project hands them over: two the same, then
    // another colour, then that again.
    let scenes = [
        canvas("#ff0000"),
        canvas("#ff0000"),
        canvas("#00ff00"),
        canvas("#00ff00"),
    ];
    let frames = [0, 1, 2, 3];
    let (got, repeats) = run(&scenes, &frames);
    assert_eq!(repeats, [false, true, false, true]);
    assert!(got[1].rgba != got[2].rgba);
    check(&scenes, &frames, &got, "canvas");
}

#[test]
fn a_picture_file_that_changed_is_drawn_again() {
    let dir = std::env::temp_dir().join(format!("kinetograph-frame-reuse-{}", std::process::id()));
    let write = |colour: [u8; 4]| {
        std::fs::create_dir_all(&dir).unwrap();
        ImageBuffer::from_pixel(32, 32, Rgba(colour))
            .save(dir.join("pic.png"))
            .unwrap();
    };
    let layers = r##"{ "id": "p", "type": "image", "src": "pic.png", "width": 64, "height": 64 }"##;
    write([255, 0, 0, 255]);
    let mut renderer = Renderer::new(scene_in(&dir, layers)).unwrap();
    renderer.set_frame_reuse(true);
    let red = renderer.render_frame(0).unwrap();
    renderer.set_scene(scene_in(&dir, layers)).unwrap();
    let again = renderer.start_frame(1).unwrap();
    assert!(again.is_repeat(), "the same file, the same scene");
    assert!(renderer.finish_frame(again).unwrap().rgba == red.rgba);
    // The same name, the same scene, other pixels in the file.
    write([0, 0, 255, 255]);
    renderer.set_scene(scene_in(&dir, layers)).unwrap();
    let blue = renderer.start_frame(2).unwrap();
    assert!(
        !blue.is_repeat(),
        "a frame drawn from a changed file was reused"
    );
    let blue = renderer.finish_frame(blue).unwrap();
    assert!(blue.rgba != red.rgba);
    assert!(blue.rgba == render_still(scene_in(&dir, layers), 2).unwrap().rgba);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn forgetting_the_frame_or_turning_reuse_off_draws_the_next() {
    let s = scene(MOVING_THEN_HELD);
    let mut renderer = Renderer::new(s.clone()).unwrap();
    renderer.set_frame_reuse(true);
    let first = renderer.render_frame(10).unwrap();
    renderer.forget_frame();
    let next = renderer.start_frame(11).unwrap();
    assert!(!next.is_repeat());
    renderer.finish_frame(next).unwrap();
    let next = renderer.start_frame(12).unwrap();
    assert!(next.is_repeat());
    assert!(renderer.finish_frame(next).unwrap().rgba == first.rgba);
    renderer.set_frame_reuse(false);
    let next = renderer.start_frame(13).unwrap();
    assert!(!next.is_repeat());
    renderer.finish_frame(next).unwrap();
    assert_eq!(renderer.repeated_frames(), 1);
}

#[test]
fn frames_started_ahead_keep_the_pixels_their_repeats_need() {
    // Several frames in flight (the addon's startFrame allows any number):
    // a repeat, then a frame that differs, then a repeat of that, all
    // started before any is finished.
    let s = scene(MOVING_THEN_HELD);
    let mut renderer = Renderer::new(s.clone()).unwrap();
    renderer.set_frame_reuse(true);
    let frames = [4, 5, 6, 7];
    let pending: Vec<_> = frames
        .iter()
        .map(|&f| renderer.start_frame(f).unwrap())
        .collect();
    assert_eq!(
        pending.iter().map(|p| p.is_repeat()).collect::<Vec<_>>(),
        [false, false, true, true]
    );
    for (pending, &frame) in pending.into_iter().zip(&frames) {
        let got = renderer.finish_frame(pending).unwrap();
        assert!(
            got.rgba == render_still(s.clone(), frame).unwrap().rgba,
            "frame {frame}"
        );
    }
}
