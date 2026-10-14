//! Golden-image tests: render a scene and compare it with a committed PNG.
//!
//! The comparison is exact, which holds on the machine the goldens were made
//! on (Apple M4, Metal). A different GPU or driver may differ in a few low
//! bits; regenerate with `UPDATE_GOLDEN=1 cargo test --test golden` after
//! checking the difference by eye.

use std::path::{Path, PathBuf};

use image::{ExtendedColorType, ImageEncoder, codecs::png};
use kinetograph_core::{Frame, Renderer, Scene, render_still};

fn scene(relative: &str) -> Scene {
    Scene::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)).unwrap()
}

fn golden_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(format!("{name}.png"))
}

fn check(name: &str, frame: &Frame) {
    let path = golden_path(name);
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        let file = std::fs::File::create(&path).unwrap();
        png::PngEncoder::new_with_quality(
            file,
            png::CompressionType::Best,
            png::FilterType::Adaptive,
        )
        .write_image(
            &frame.rgba,
            frame.width,
            frame.height,
            ExtendedColorType::Rgba8,
        )
        .unwrap();
        return;
    }
    let golden = image::open(&path)
        .unwrap_or_else(|e| {
            panic!(
                "cannot read {}: {e} (run with UPDATE_GOLDEN=1)",
                path.display()
            )
        })
        .to_rgba8();
    assert_eq!(
        (golden.width(), golden.height()),
        (frame.width, frame.height),
        "{name}: size changed"
    );
    let differing: Vec<_> = golden
        .as_raw()
        .chunks(4)
        .zip(frame.rgba.chunks(4))
        .enumerate()
        .filter(|(_, (a, b))| a != b)
        .collect();
    if let Some((i, (want, got))) = differing.first() {
        let (x, y) = (*i as u32 % frame.width, *i as u32 / frame.width);
        panic!(
            "{name}: {} of {} pixels differ from {}; first at ({x}, {y}): want {want:?}, got {got:?}",
            differing.len(),
            frame.width * frame.height,
            path.display()
        );
    }
}

#[test]
fn papercut_card_matches_golden() {
    let frame = render_still(scene("../../examples/papercut-card.json"), 30).unwrap();
    check("papercut-card-f30", &frame);
}

#[test]
fn blend_and_blur_scene_matches_golden() {
    let frame = render_still(scene("tests/scenes/blend-blur.json"), 0).unwrap();
    check("blend-blur", &frame);
}

#[test]
fn clip_paths_match_golden() {
    // Frame 15 of 30: halfway through every clip animation.
    let frame = render_still(scene("tests/scenes/clip-paths.json"), 15).unwrap();
    check("clip-paths", &frame);
}

#[test]
fn gradient_masks_match_golden() {
    let frame = render_still(scene("tests/scenes/masks.json"), 15).unwrap();
    check("masks", &frame);
}

#[test]
fn track_mattes_match_golden() {
    let frame = render_still(scene("tests/scenes/mattes.json"), 15).unwrap();
    check("mattes", &frame);
}

#[test]
fn shadows_match_golden() {
    // Frame 15 of 30: halfway through every shadow animation. The scene has a
    // margin (its largest reach is the off-canvas layer's shadow), so this
    // also covers drawing outside the canvas.
    let frame = render_still(scene("tests/scenes/shadows.json"), 15).unwrap();
    check("shadows", &frame);
}

#[test]
fn colour_filters_match_golden() {
    // Frame 15 of 30: halfway through every filter animation. Covers filter
    // runs composed into one pass, a run split by a blur, a group, text,
    // layers hanging off the canvas, and a filter after a drop shadow.
    let frame = render_still(scene("tests/scenes/colour-filters.json"), 15).unwrap();
    check("colour-filters", &frame);
}

#[test]
fn rendering_is_deterministic() {
    // Mid-animation frame: keyframes, blur and multiply all in play.
    let card = || scene("../../examples/papercut-card.json");
    let first = render_still(card(), 12).unwrap();
    let second = render_still(card(), 12).unwrap();
    assert_eq!(first.rgba, second.rgba, "fresh renderers");

    // One renderer reused, with other frames in between.
    let mut renderer = Renderer::new(card()).unwrap();
    let a = renderer.render_frame(12).unwrap();
    renderer.render_frame(40).unwrap();
    let b = renderer.render_frame(12).unwrap();
    assert_eq!(a.rgba, first.rgba, "reused renderer, first frame");
    assert_eq!(b.rgba, first.rgba, "reused renderer, after another frame");

    let blend = || scene("tests/scenes/blend-blur.json");
    let x = render_still(blend(), 0).unwrap().encode_png().unwrap();
    let y = render_still(blend(), 0).unwrap().encode_png().unwrap();
    assert_eq!(x, y, "blend-blur PNG bytes");
}

#[test]
fn gradient_fills_match_golden() {
    // Frame 15 of 30: halfway through every animation. Covers linear,
    // radial and conic fills, a repeating one on a rotated layer hanging off
    // the canvas, reflecting and repeating gradients on text, and a path
    // shape half off the left edge.
    let frame = render_still(scene("tests/scenes/gradient-fills.json"), 15).unwrap();
    check("gradient-fills", &frame);
}
