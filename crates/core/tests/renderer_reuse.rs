//! One `Renderer` taking one scene after another (`Renderer::set_scene`) must
//! draw every frame exactly as a renderer made for that scene does.

mod common;

use std::path::{Path, PathBuf};

use image::{ImageBuffer, Rgba};
use kinetograph_core::{Frame, Renderer, Scene, render_still};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn load(path: &str) -> Scene {
    Scene::load(&root().join(path)).unwrap()
}

/// Scenes that differ in size, margin, fonts, images, tables and shaders.
fn scenes() -> Vec<(&'static str, Scene, u32)> {
    [
        // 360x200 canvas with a shape, text and an image.
        ("../../examples/basic.json", 20),
        // A margin for the shadows, and animated shadow values.
        ("tests/scenes/shadows.json", 15),
        // A custom WGSL pipeline.
        ("tests/scenes/shader.json", 15),
        // An image with a gradient map, which reads a table.
        ("tests/scenes/gradient-map.json", 15),
        // A different size, many images and the font twice.
        ("../../examples/papercut-card.json", 30),
        // A mesh gradient, whose pass depends on the canvas size.
        ("tests/scenes/mesh-gradient.json", 15),
        // Layers that stay the same from one frame to the next.
        ("tests/scenes/clip-paths.json", 15),
    ]
    .into_iter()
    .map(|(path, frame)| (path, load(path), frame))
    .collect()
}

fn fresh(scene: &Scene, frame: u32) -> Frame {
    render_still(scene.clone(), frame).unwrap()
}

#[test]
fn scenes_in_turn_match_fresh_renderers() {
    let scenes = scenes();
    // Each scene several times and in different orders, so a renderer that
    // has seen everything is asked for scenes it has seen before, and for
    // sizes it has left and come back to.
    let order = [0, 1, 0, 2, 3, 4, 0, 5, 3, 1, 6, 4, 2, 0];
    for cache in [false, true] {
        let mut renderer = Renderer::new(scenes[order[0]].1.clone()).unwrap();
        renderer.set_layer_cache(cache);
        for (step, &i) in order.iter().enumerate() {
            let (name, scene, frame) = &scenes[i];
            renderer.set_scene(scene.clone()).unwrap();
            let got = renderer.render_frame(*frame).unwrap();
            let want = fresh(scene, *frame);
            assert_eq!(
                (got.width, got.height),
                (want.width, want.height),
                "step {step}, {name}, cache {cache}"
            );
            assert!(
                got.rgba == want.rgba,
                "step {step}, {name}, cache {cache}: not byte for byte what a new renderer draws"
            );
            // The frame after it, which the cache may serve in part.
            let next = renderer.render_frame(frame + 1).unwrap();
            assert!(
                next.rgba == fresh(scene, frame + 1).rgba,
                "step {step}, {name}, cache {cache}: the frame after"
            );
        }
    }
}

/// Vello keeps one image atlas per renderer, and every Lottie frame is a new
/// image in it, so a frame's pixels must not depend on which images the
/// renderer drew before (#12).
#[test]
fn lottie_frames_in_order_match_fresh_renderers() {
    let scene = load("tests/scenes/lottie.json");
    assert_eq!(scene.duration_in_frames, 60, "the scene runs 60 frames");
    let wanted: Vec<Frame> = (0..scene.duration_in_frames)
        .map(|frame| fresh(&scene, frame))
        .collect();
    for cache in [false, true] {
        let mut renderer = Renderer::new(scene.clone()).unwrap();
        renderer.set_layer_cache(cache);
        for (frame, want) in wanted.iter().enumerate() {
            let got = renderer.render_frame(frame as u32).unwrap();
            assert!(
                got.rgba == want.rgba,
                "frame {frame}, cache {cache}: not byte for byte what a new renderer draws"
            );
        }
    }
}

#[test]
fn the_same_scene_again_keeps_its_layer_cache() {
    common::pin_vello();
    let scene = load("tests/scenes/clip-paths.json");
    let mut renderer = Renderer::new(scene.clone()).unwrap();
    renderer.set_layer_cache(true);
    // A layer that stays the same is cached from its third frame on (a plain
    // leaf, or a group of them, is only noted in the first).
    renderer.render_frame(10).unwrap();
    renderer.render_frame(10).unwrap();
    let (hits_before, _) = renderer.layer_cache_counts();
    // The scene arrives again, as a video built from per-frame scenes sends
    // it: nothing about it changed, so nothing is drawn twice.
    renderer.set_scene(scene).unwrap();
    renderer.render_frame(10).unwrap();
    let (hits, _) = renderer.layer_cache_counts();
    assert!(
        hits > hits_before,
        "the layer cache was not used across set_scene"
    );
}

/// A square picture of one colour, saved as `dir/pic.png`.
fn write_picture(dir: &Path, colour: [u8; 4]) {
    std::fs::create_dir_all(dir).unwrap();
    ImageBuffer::from_pixel(32, 32, Rgba(colour))
        .save(dir.join("pic.png"))
        .unwrap();
}

fn picture_scene(dir: &Path) -> Scene {
    let json = r#"{
        "width": 64, "height": 64, "fps": 30, "durationInFrames": 2,
        "layers": [
            { "id": "pic", "type": "image", "src": "pic.png", "width": 64, "height": 64 }
        ]
    }"#;
    Scene::from_json(json, dir.to_path_buf()).unwrap()
}

#[test]
fn a_name_that_means_another_file_is_read_again() {
    common::pin_vello();
    let base = std::env::temp_dir().join(format!("kinetograph-reuse-{}", std::process::id()));
    let (red, blue) = (base.join("red"), base.join("blue"));
    write_picture(&red, [255, 0, 0, 255]);
    write_picture(&blue, [0, 0, 255, 255]);

    let mut renderer = Renderer::new(picture_scene(&red)).unwrap();
    renderer.set_layer_cache(true);
    let first = renderer.render_frame(0).unwrap();
    // The same `src` and layer id, from another directory: a cached texture
    // of the red picture must not be drawn.
    renderer.set_scene(picture_scene(&blue)).unwrap();
    let second = renderer.render_frame(0).unwrap();
    assert_ne!(first.rgba, second.rgba);
    assert_eq!(first.rgba, fresh(&picture_scene(&red), 0).rgba);
    assert_eq!(second.rgba, fresh(&picture_scene(&blue), 0).rgba);

    // And back.
    renderer.set_scene(picture_scene(&red)).unwrap();
    assert_eq!(renderer.render_frame(0).unwrap().rgba, first.rgba);
    let _ = std::fs::remove_dir_all(&base);
}

/// A canvas with shadows is drawn in runs through the image renderer, and a run of solid paths holds no image. Vello
/// replaced its image atlas for such a run while the cache went on counting the pictures drawn before it as uploaded,
/// so a picture drawn after it came out blank, and a video drawn in chunks on several renderers differed from one drawn
/// on a single renderer.
#[test]
fn a_picture_is_drawn_after_a_canvas_run_of_solid_paths_as_a_new_renderer_draws_it() {
    let base = std::env::temp_dir().join(format!("kinetograph-atlas-{}", std::process::id()));
    write_picture(&base, [200, 40, 40, 255]);
    let picture = picture_scene(&base);
    let canvas = load("tests/scenes/canvas-effects.json");
    let want = fresh(&picture, 0);
    assert_eq!(&want.rgba[..4], &[200, 40, 40, 255], "the picture is drawn");

    for cache in [false, true] {
        let mut renderer = Renderer::new(picture.clone()).unwrap();
        renderer.set_layer_cache(cache);
        assert!(
            renderer.render_frame(0).unwrap().rgba == want.rgba,
            "cache {cache}: the first picture"
        );
        for round in 0..2 {
            renderer.set_scene(canvas.clone()).unwrap();
            renderer.render_frame(0).unwrap();
            renderer.set_scene(picture.clone()).unwrap();
            let got = renderer.render_frame(0).unwrap();
            assert!(
                got.rgba == want.rgba,
                "cache {cache}, round {round}: the picture after a canvas run is not what a new renderer draws"
            );
        }
    }
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn a_scene_that_cannot_load_leaves_the_renderer_as_it_was() {
    let scene = load("../../examples/basic.json");
    let mut renderer = Renderer::new(scene.clone()).unwrap();
    let before = renderer.render_frame(20).unwrap();

    let missing = Scene::from_json(
        r#"{
            "width": 64, "height": 64, "fps": 30, "durationInFrames": 2,
            "layers": [
                { "id": "pic", "type": "image", "src": "no-such-file.png", "width": 64, "height": 64 }
            ]
        }"#,
        std::env::temp_dir(),
    )
    .unwrap();
    assert!(renderer.set_scene(missing).is_err());

    assert_eq!(renderer.scene().width, scene.width);
    assert_eq!(renderer.render_frame(20).unwrap().rgba, before.rgba);
}
