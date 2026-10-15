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
    // a group hanging off the left edge, and on a translucent fill (so the
    // map sees partial alpha) on a half-opaque layer hanging off the right
    // and bottom edges. The same scene has a `lut` (a .cube table in
    // tests/scenes/looks) on an image whose cross-fade is half way, on text,
    // and on a group hanging off the top and right edges, all sharing one
    // table.
    let frame = render_still(scene("tests/scenes/gradient-map.json"), 15).unwrap();
    check("gradient-map", &frame);
}

#[test]
fn grain_matches_golden() {
    // Frame 15 of 30: the animated amount and size are half way. Covers fine
    // monochrome grain on an image, coloured grain, large smooth grain on
    // flat grey, text with grain that does not animate, grain staying put on
    // a rotating card, a translucent fill on a half-opaque layer (alpha
    // untouched), and a group at amount 1 hanging off the right and bottom
    // edges.
    let frame = render_still(scene("tests/scenes/grain.json"), 15).unwrap();
    check("grain", &frame);
}

#[test]
fn dither_matches_golden() {
    // Frame 15 of 30: the animated levels (5) and cell sizes are half way.
    // Covers ordered and seeded random dithering of grey ramps, an image, a
    // text gradient and a radial-filled group hanging off the left and
    // bottom edges, a random pattern that animates per frame, one that does
    // not (with the largest seed), and a translucent gradient fill on a
    // half-opaque layer, whose alpha must stay as it was.
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

#[test]
fn turbulence_matches_golden() {
    // Frame 15 of 30: the keyframed scales, frequencies and rotations are half
    // way. Covers papercut's `torn` (fractalNoise at 0.04, 4 octaves, seed 7)
    // on a rotating card with a shadow, `rough` (seed 11) on text, a
    // `turbulence`-type noise with per-axis frequencies and the B and A
    // channels on an image, a displaced group that is scaled and rotated so
    // the noise turns with it and hangs off the left and bottom edges, a bar
    // off the right edge (the margin lets its off-canvas part be pulled in),
    // zero octaves of `turbulence` on a half-transparent layer (a plain shift
    // by half the scale; `fractalNoise` would leave it in place), fractional and
    // negative seeds, and a zero scale (the layer untouched). The same scene
    // has `noise` layers: a grey strip of `turbulence`-type noise whose
    // frequency is animated, an rgba block that turns while hanging off the
    // bottom and right edges (anti-aliased, premultiplied alpha), and one cut
    // to a circle by a clip and scaled.
    let frame = render_still(scene("tests/scenes/turbulence.json"), 15).unwrap();
    check("turbulence", &frame);
}

#[test]
fn mesh_gradient_matches_golden() {
    // Frame 15 of 30: the animated points, rotations and scales are half way.
    // Covers a full-canvas 4 x 3 mesh whose interior and edge points have
    // drifted (the background), a photo cut out by a mesh used as a track
    // matte (colours fading to clear), a 5 x 2 ribbon whose points wave (and
    // whose lower colours are half-transparent), a rotating 3 x 2 card cut to
    // rounded corners by an inset clip with a drop shadow (so the scene has a
    // margin and the mesh is placed inside it), a scaled group of meshes
    // hanging off the left and bottom edges with a transparent middle column,
    // a screen-blended mesh with a fully transparent corner rotating off the
    // bottom-right corner (anti-aliased outer edge, straight-alpha colours),
    // and text on top.
    let frame = render_still(scene("tests/scenes/mesh-gradient.json"), 15).unwrap();
    check("mesh-gradient", &frame);
}

#[test]
fn camera_matches_golden() {
    // Frame 15 of 30: the animated rotations and depths are half way. Covers
    // perspective (a camera at 700 px, origin in the middle), `rotateY` on a
    // rotated image with a clip and a drop shadow (so the scene has a margin
    // that the warp must account for), `rotateX` on text, a flat group turned
    // past 90 degrees so its back shows mirrored, with a shadow, `z` alone
    // magnifying a card until it hangs off the top and right edges, and a thin
    // bar tipped toward the eye until its far end passes the eye plane (that
    // end is cut off, not mirrored back), drawn half transparent under the
    // rest. Also two preserve3d groups at the bottom: a stack of five cards
    // at different depths, listed out of depth order, turned about both axes
    // (two of them at one depth, so the later one in the list is on top), and
    // an orbit of four cards facing outward around a ring at 90% opacity,
    // turned a long way about the vertical axis, so some show their backs.
    // The ring holds an image matted by an ellipse, a flat group card with
    // text, and a nested preserve3d group of two discs on either side of the
    // ring's centre, turned on its own, which sort among the ring's cards.
    let frame = render_still(scene("tests/scenes/camera.json"), 15).unwrap();
    check("camera", &frame);
}

#[test]
fn corner_pin_matches_golden() {
    // Frame 15 of 30: the animated pins are half way. Covers an image with
    // two corners pinned (the other two left on the box) and one corner of
    // each animated, text with all four corners pinned, a rotated and scaled
    // card hanging off the right and bottom edges with a drop shadow before
    // the pin (so the shadow is pinned with it; the scene has a margin that
    // the warp must account for), a pinned image that is then turned in 3D
    // under a camera (the two warps compose), a pinned rectangle inside a
    // rotated, scaled group (the pin is in the child's space, through its
    // parent's matrix), and a rectangle whose pins are exactly its own
    // corners (drawn as if there were no effect).
    let frame = render_still(scene("tests/scenes/corner-pin.json"), 15).unwrap();
    check("corner-pin", &frame);
}

#[test]
fn motion_blur_matches_golden() {
    // Frame 15 of 30: the whip is at its fastest. Covers a group moving ~80
    // px a frame (a card with a drop shadow, so the scene has a margin, and
    // text) whose shutter is animated from 0.2 to 1.6 frames, a three-spoke
    // fan spinning 20 degrees a frame, hanging off the right edge, an ellipse
    // whose opacity steps from 0 to 1 across the frame under a two-frame
    // shutter (the fade is averaged too), an image cut by a moving ellipse
    // matte that is blurred with the same sample count (the matte smears with
    // it), a card spinning about the vertical axis under the camera (each
    // sub-frame is warped on its own), a square with a shut shutter (drawn
    // exactly as without motion blur) and text that does not move (stays
    // sharp).
    let frame = render_still(scene("tests/scenes/motion-blur.json"), 15).unwrap();
    check("motion-blur", &frame);
}

#[test]
fn image_fit_matches_golden() {
    // Frame 15 of 30: the animated widths are half way. Covers an image with
    // both sides left out (the file's 720 x 540, scaled by the layer), one
    // with only a width that is animated and one with only a height (the
    // aspect ratio kept, the outlines show the expected boxes), `contain` and
    // `cover` in a 140 x 80 box, a portrait photo covering a landscape box
    // whose width animates, and `contain` and `cover` on turned layers, one
    // of them half transparent.
    let frame = render_still(scene("tests/scenes/image-fit.json"), 15).unwrap();
    check("image-fit", &frame);
}

#[test]
fn box_units_match_golden() {
    // Frame 15 of 30: the conic angle, scale and rotation are half way.
    // Covers box-unit gradients on a rounded rect (diagonal), an ellipse
    // (radial, so an elliptical gradient), a rect with a conic gradient
    // stretched by its box, a repeating one on a rect that scales and turns,
    // a path whose box does not start at the origin, text with a reflecting
    // gradient, a luminance mask and an alpha mask in box units, and a rect
    // with no width (its gradient has no extent: the last stop, under a
    // white stroke).
    let frame = render_still(scene("tests/scenes/box-units.json"), 15).unwrap();
    check("box-units", &frame);
}

#[test]
fn motion_blur_frames_match_golden() {
    // Frame 15 of 30. Covers a rect whose four copies sit at different places
    // in different colours (the average of the four), text whose three copies
    // have different drop shadows (the scene's margin comes from the copies),
    // a group whose two copies are in different places and colours, and a
    // keyframed rect whose copies are resolved at their own sub-frame times
    // (the shutter is two frames wide).
    let frame = render_still(scene("tests/scenes/motion-frames.json"), 15).unwrap();
    check("motion-frames", &frame);
}

#[test]
fn flex_layout_matches_golden() {
    // Frame 15 of 30: the stack's gap, the wrap width and the card's scale
    // and turn are half way. Covers a space-between toolbar with padding, a
    // centred title, a margin, an absolute background and badge (left where
    // their transforms put them); a column that aligns to the end with a
    // growing item and an `alignSelf`; a wrapping row whose width animates
    // (the squares re-wrap) with a row and a column gap; baseline alignment
    // of two text sizes and a box; a reversed, centred row; and a card, a
    // layout group sized by its content, that is clipped by an `inset` clip
    // and faded by a box-unit mask (a layout group has a box) and turns and
    // scales about its centre by `originX`/`originY`, with a nested layout
    // group inside it.
    let frame = render_still(scene("tests/scenes/layout.json"), 15).unwrap();
    check("layout", &frame);
}

#[test]
fn lottie_matches_golden() {
    // Frame 15 of 60 (0.5 s): the animation's own time follows the frame
    // unless a layer gives `time`. Covers a Lottie JSON at its own size and a
    // `.lottie` archive fitted into a wide box (centred, aspect ratio kept,
    // outlined), a layer scaled to 2x (painted at the size it is drawn, not
    // upscaled), animated `time`, a held last frame (time past the end) and a
    // looped one, a turned, half-transparent layer with a drop shadow and an
    // inset clip, a box-unit mask, and two layers in a flex row sized by their
    // height alone (the aspect ratio gives the width), the second with motion
    // blur.
    let frame = render_still(scene("tests/scenes/lottie.json"), 15).unwrap();
    check("lottie", &frame);
}

#[test]
fn glyph_text_matches_golden() {
    // Frame 15 of 30: the staggered rise and fade-in of the first line are
    // under way, and the animated offset on the last character is half way.
    // Covers per-character offsets and opacity, scale and rotation about the
    // character's centre, a character in its own colour, a box-unit gradient
    // that moves with each character, centred two-line text where the
    // newline has an entry (ignored, its scale and offset must not show) and
    // an invisible character, and a drop shadow on text whose letters are
    // moved.
    let frame = render_still(scene("tests/scenes/glyph-text.json"), 15).unwrap();
    check("glyph-text", &frame);
}

#[test]
fn origin_and_align_match_golden() {
    // Frame 15 of 30: the rotations, scale and tilt are half way. Covers a
    // rect turning and shrinking about its centre (its outline stays put), an
    // ellipse turning about its bottom-right corner, a path turning about the
    // middle of its box (which does not start at the origin), a layer with
    // an anchor and an origin together, a card tilted about the vertical
    // axis through its centre under no camera, text turning about its centre,
    // and three-line text left, centre and right aligned in a 130 px wrap
    // width (outlined) and centred with no wrap width.
    let frame = render_still(scene("tests/scenes/origin-align.json"), 15).unwrap();
    check("origin-align", &frame);
}

#[test]
fn video_layers_match_golden() {
    // Frame 20 of 48 at 24 fps: 0.83 s into the clip. Covers a clip at its
    // own size scaled up, `contain` and `cover` in a square, a frame held by
    // `frame`, a clip at twice the rate that is trimmed and looped, a WebM
    // whose first picture is not at 0 starting late, a clip with a shadow, a
    // clip and an inset clip on a turned layer, a motion-blurred clip at
    // three times the rate, and two clips in a flex row.
    let frame = render_still(scene("tests/scenes/video.json"), 20).unwrap();
    check("video", &frame);
}

#[test]
fn gif_layers_match_golden() {
    // Frame 15 of 30: half a second in, which is the end of the GIF's 500 ms.
    // Covers each of its five pictures picked by `time` (the last has
    // transparent corners), the frame's own time looped (back to the first
    // picture) and held (the last), a time that is animated, `contain` and
    // `cover`, and a turned layer with a shadow and half transparent.
    let frame = render_still(scene("tests/scenes/gif.json"), 15).unwrap();
    check("gif", &frame);
}
