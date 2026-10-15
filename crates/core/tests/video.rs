//! Video and GIF layers on a `Renderer`: a frame's pixels must depend only on
//! (scene, frame), never on what the renderer decoded or drew before. A
//! video decoder keeps its place between frames and seeks on a jump, and a
//! renderer reuses its decoders when it takes a new scene, so frames rendered
//! out of order, in order, on one renderer or a new one each, and one scene
//! per frame (as the TSX authoring layer hands them over) must all be the
//! same bytes.
//!
//! Needs a GPU; the M4 runs it with the rest of `crates/core/tests/`.

use std::path::{Path, PathBuf};

use kinetograph_core::{Frame, Renderer, Scene, render_still};

fn load(relative: &str) -> Scene {
    let path: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
    Scene::load(&path).unwrap()
}

/// Frames of video.json, 48 at 24 fps: several keyframes of clip.mp4 (every 12
/// pictures) apart, so decoding from the middle needs a seek.
const FRAMES: [u32; 9] = [0, 1, 11, 12, 13, 24, 25, 40, 47];

fn fresh(scene: &Scene, frame: u32) -> Frame {
    render_still(scene.clone(), frame).unwrap()
}

fn same(a: &Frame, b: &Frame, what: &str) {
    assert_eq!((a.width, a.height), (b.width, b.height), "{what}: size");
    assert!(a.rgba == b.rgba, "{what}: not byte for byte the same frame");
}

#[test]
fn video_frames_are_the_same_in_any_order() {
    let scene = load("tests/scenes/video.json");
    let reference: Vec<Frame> = FRAMES.iter().map(|&f| fresh(&scene, f)).collect();

    // Different frames differ, so the comparisons below mean something.
    assert!(reference[0].rgba != reference[3].rgba);
    assert!(reference[3].rgba != reference[5].rgba);

    for cache in [false, true] {
        let mut renderer = Renderer::new(scene.clone()).unwrap();
        renderer.set_layer_cache(cache);
        // In order, then backwards, then jumping about: every kind of move
        // for the decoders (forward, a seek back, a long jump forward).
        let order: Vec<usize> = (0..FRAMES.len())
            .chain((0..FRAMES.len()).rev())
            .chain([4, 8, 1, 7, 2, 6, 0, 5, 3, 8, 0])
            .collect();
        for (step, &i) in order.iter().enumerate() {
            let got = renderer.render_frame(FRAMES[i]).unwrap();
            same(
                &got,
                &reference[i],
                &format!("step {step}, frame {}, cache {cache}", FRAMES[i]),
            );
        }
    }
}

#[test]
fn every_frame_in_a_row_matches_a_fresh_renderer() {
    // A render: all frames one after another on one renderer, the layer cache
    // on. Every picture of the clip goes through the decoder in turn.
    let scene = load("tests/scenes/video.json");
    let mut renderer = Renderer::new(scene.clone()).unwrap();
    renderer.set_layer_cache(true);
    for frame in 0..scene.duration_in_frames {
        let got = renderer.render_frame(frame).unwrap();
        // Every fourth frame is checked against a new renderer, which has
        // decoded nothing else.
        if frame % 4 == 0 {
            same(&got, &fresh(&scene, frame), &format!("frame {frame}"));
        }
    }
}

#[test]
fn a_scene_per_frame_keeps_the_decoders_and_the_pixels() {
    // The authoring layer hands the renderer a new `Scene` for each frame
    // (`set_scene`); the decoders stay, and the frames are the same.
    let scene = load("tests/scenes/video.json");
    let mut renderer = Renderer::new(scene.clone()).unwrap();
    renderer.set_layer_cache(true);
    for &frame in &[3, 4, 5, 30, 6, 2, 47, 8] {
        renderer.set_scene(scene.clone()).unwrap();
        let got = renderer.render_frame(frame).unwrap();
        same(
            &got,
            &fresh(&scene, frame),
            &format!("scene per frame {frame}"),
        );
    }
}

#[test]
fn gif_frames_are_the_same_in_any_order() {
    let scene = load("tests/scenes/gif.json");
    let frames = [0, 3, 6, 9, 12, 15, 18, 29];
    let reference: Vec<Frame> = frames.iter().map(|&f| fresh(&scene, f)).collect();
    assert!(reference[0].rgba != reference[3].rgba);
    let mut renderer = Renderer::new(scene.clone()).unwrap();
    for &i in &[7, 0, 5, 2, 6, 1, 4, 3, 0, 7] {
        let got = renderer.render_frame(frames[i]).unwrap();
        same(&got, &reference[i], &format!("gif frame {}", frames[i]));
    }
}

#[test]
fn a_video_and_a_gif_scene_share_one_renderer() {
    // Taking a scene with videos and GIFs after one without (and back) leaves
    // the frames as a new renderer's.
    let video = load("tests/scenes/video.json");
    let gif = load("tests/scenes/gif.json");
    let plain = load("tests/scenes/shadows.json");
    let mut renderer = Renderer::new(plain.clone()).unwrap();
    for (scene, frame) in [
        (&video, 20),
        (&plain, 15),
        (&gif, 15),
        (&video, 5),
        (&gif, 9),
        (&plain, 15),
        (&video, 20),
    ] {
        renderer.set_scene(scene.clone()).unwrap();
        let got = renderer.render_frame(frame).unwrap();
        same(&got, &fresh(scene, frame), &format!("frame {frame}"));
    }
}
