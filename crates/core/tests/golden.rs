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

#[test]
fn backdrop_blur_matches_golden() {
    // Frame 15 of 30: halfway through every animation. Covers a frosted card
    // inside a moving group (with a disc under it in the group), frosted text
    // (alpha coverage), a frosted shape with a clip, and a card hanging off
    // the right edge, all over stripes, an image and text.
    let frame = render_still(scene("tests/scenes/backdrop-blur.json"), 15).unwrap();
    check("backdrop-blur", &frame);
}

#[test]
fn glow_matches_golden() {
    // Frame 15 of 30: halfway through every animation. Covers the layer's own
    // colours and a tint, text, a stroke-only ring at the maximum intensity
    // (the halo is capped), a half-transparent layer, a group, and layers
    // hanging off the left and right edges.
    let frame = render_still(scene("tests/scenes/glow.json"), 15).unwrap();
    check("glow", &frame);
}

#[test]
fn chromatic_aberration_matches_golden() {
    // Frame 15 of 30: halfway through every animation. Covers text, an image,
    // a group with a negative amount, a half-transparent shape, and layers
    // hanging off the top, right and left edges.
    let frame = render_still(scene("tests/scenes/chromatic-aberration.json"), 15).unwrap();
    check("chromatic-aberration", &frame);
}

#[test]
fn shader_matches_golden() {
    // Frame 15 of 30: halfway through the keyframed uniforms, 0.5 s in. Covers
    // one shader on two layers with different uniforms (a ripple on a
    // gradient card and on a bar hanging off the left edge, whose padding
    // lets the off-canvas part ripple in), and a second shader that reads
    // only the frame, on text and on a group.
    let frame = render_still(scene("tests/scenes/shader.json"), 15).unwrap();
    check("shader", &frame);
}

#[test]
fn gradient_map_matches_golden() {
    // Frame 15 of 30: the cross-fade on the photo is half way and the moving
    // stop is at its middle. Covers a four-stop map with a see-through first
    // stop and a translucent last one, a map on text with a gradient fill, on
    // a group hanging off the left edge, and on a half-opaque layer hanging
    // off the right and bottom edges. The same scene has a `lut` (a .cube
    // table in tests/scenes/looks) on an image whose cross-fade is half way,
    // on text, and on a group hanging off the top and right edges, all
    // sharing one table.
    let frame = render_still(scene("tests/scenes/gradient-map.json"), 15).unwrap();
    check("gradient-map", &frame);
}

#[test]
fn grain_matches_golden() {
    // Frame 15 of 30: the animated amount and size are half way. Covers fine
    // monochrome grain on an image, coloured grain, large smooth grain on
    // flat grey, text with grain that does not animate, grain staying put on
    // a rotating card, a half-transparent layer (alpha untouched), and a
    // group at amount 1 hanging off the right and bottom edges.
    let frame = render_still(scene("tests/scenes/grain.json"), 15).unwrap();
    check("grain", &frame);
}

#[test]
fn dither_matches_golden() {
    // Frame 15 of 30: the animated levels (5) and cell sizes are half way.
    // Covers ordered and seeded random dithering of grey ramps, an image, a
    // text gradient and a radial-filled group hanging off the left and
    // bottom edges, a random pattern that animates per frame, one that does
    // not (with the largest seed), and a half-transparent layer whose alpha
    // must stay as it was.
    let frame = render_still(scene("tests/scenes/dither.json"), 15).unwrap();
    check("dither", &frame);
}

#[test]
fn halftone_matches_golden() {
    // Frame 15 of 30: the animated cell sizes and grid angles are half way.
    // Covers circle, square and line dots on grey ramps (solid at white,
    // empty at black), an image in its own colours and inverted in a given
    // colour, text rotating and scaling so the screen turns with the layer, a
    // scaled group hanging off the left and bottom edges, and half-transparent
    // layers whose alpha and a colour's alpha must scale the dots.
    let frame = render_still(scene("tests/scenes/halftone.json"), 15).unwrap();
    check("halftone", &frame);
}

#[test]
fn dot_matrix_matches_golden() {
    // Frame 15 of 30: progress and the animated cell sizes are half way.
    // Covers a random reveal and a left-to-right sweep of an image, a sweep
    // across text that rotates (so the grid turns with the layer) and one
    // down a layer drawn upright, a rotating scaled layer, a scaled group
    // hanging off the left and bottom edges (random only: a group has no
    // box) with progress overshooting 0..1, a half-transparent layer, and
    // progress held at 1 (the layer untouched) and at 0 (nothing drawn).
    let frame = render_still(scene("tests/scenes/dot-matrix.json"), 15).unwrap();
    check("dot-matrix", &frame);
}
