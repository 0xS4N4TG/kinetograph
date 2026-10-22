//! Canvas layers with shadows and filters: what a command drawn with
//! `shadowColor` and the rest, or with a `filter`, leaves in the pixels
//! (docs/SCENE.md, "canvas"). The look of both is in the `canvas-effects`
//! golden.

mod common;

use std::path::Path;

use kinetograph_core::{Frame, Renderer, Scene, render_still};

/// A 64 x 64 scene, black background, with one canvas layer of `commands`.
fn render(commands: &str) -> Frame {
    let json = format!(
        r##"{{"width": 64, "height": 64, "fps": 30, "durationInFrames": 1, "background": "#000000",
            "fonts": {{"DM Sans": "../../../assets/fonts/DMSans-Medium.ttf"}},
            "layers": [{{"id": "c", "type": "canvas", "width": 64, "height": 64, "commands": {commands}}}]}}"##
    );
    let scene =
        Scene::from_json(&json, Path::new(env!("CARGO_MANIFEST_DIR")).join("tests")).unwrap();
    render_still(scene, 0).unwrap()
}

fn px(frame: &Frame, x: usize, y: usize) -> [u8; 4] {
    let i = (y * frame.width as usize + x) * 4;
    frame.rgba[i..i + 4].try_into().unwrap()
}

const RED: &str = r##"{"type": "color", "color": "#ff0000"}"##;

/// A red 16 x 16 square at (16, 16) drawn with `extra`: more fields of the
/// command, after a comma.
fn square(extra: &str) -> String {
    format!(r##"[{{"op": "fill", "path": "M16 16H32V32H16Z", "paint": {RED}{extra}}}]"##)
}

const BLUE_SHADOW: &str = r##", "shadow": {"color": "#0000ff", "blur": 0, "x": 12, "y": 12}"##;

/// A 16 x 16 square at (16, 16) of `color` drawn with a `filter`.
fn filtered(color: &str, filter: &str) -> Frame {
    render(&format!(
        r##"[{{"op": "fill", "path": "M16 16H32V32H16Z", "paint": {{"type": "color", "color": "{color}"}},
              "filter": {filter}}}]"##
    ))
}

/// Whether `got` is within `slack` levels of `want` on every channel.
fn near(got: [u8; 4], want: [u8; 4], slack: i32) -> bool {
    got.iter()
        .zip(want)
        .all(|(&g, w)| (i32::from(g) - i32::from(w)).abs() <= slack)
}

#[test]
fn a_shadow_is_cast_under_the_shape_at_its_offset() {
    let frame = render(&square(BLUE_SHADOW));
    assert_eq!(px(&frame, 20, 20), [255, 0, 0, 255], "the shape on top");
    assert_eq!(px(&frame, 28, 28), [255, 0, 0, 255], "over the shadow");
    assert_eq!(px(&frame, 40, 40), [0, 0, 255, 255], "the shadow, offset");
    assert_eq!(px(&frame, 40, 20), [0, 0, 0, 255], "above the shadow");
    assert_eq!(px(&frame, 52, 52), [0, 0, 0, 255], "past the shadow");
}

#[test]
fn a_shadows_blur_spreads_it_with_half_the_blur_as_the_deviation() {
    // shadowBlur 12 is a deviation of 6 pixels: the edge, half covered, is
    // half the colour, and the shadow reaches a few deviations past it.
    let frame = render(&square(
        r##", "shadow": {"color": "#0000ff", "blur": 12, "x": 0, "y": 0}"##,
    ));
    let edge = px(&frame, 15, 24);
    assert!(
        (60..=200).contains(&edge[2]) && edge[0] == 0,
        "half covered at the edge: {edge:?}"
    );
    let near_edge = px(&frame, 12, 24)[2];
    let far = px(&frame, 5, 24)[2];
    assert!(
        edge[2] > near_edge && near_edge > far && far > 0,
        "{edge:?} {near_edge} {far}"
    );
    assert_eq!(
        px(&frame, 24, 24),
        [255, 0, 0, 255],
        "the shape is not blurred"
    );
}

#[test]
fn a_shadows_offset_is_not_scaled_by_the_transform() {
    // The square is drawn twice the size; the shadow still lies 6 pixels off.
    let frame = render(&format!(
        r##"[{{"op": "fill", "path": "M8 8H24V24H8Z", "paint": {RED}, "m": [2, 0, 0, 2, 0, 0],
              "shadow": {{"color": "#0000ff", "blur": 0, "x": 6, "y": 6}}}}]"##
    ));
    assert_eq!(px(&frame, 40, 40), [255, 0, 0, 255], "the shape");
    assert_eq!(px(&frame, 50, 50), [0, 0, 255, 255], "shadow up to 48 + 6");
    assert_eq!(px(&frame, 55, 55), [0, 0, 0, 255], "past 48 + 6");
}

#[test]
fn a_shadow_takes_the_alpha_the_shape_is_drawn_with() {
    let opaque = render(&square(BLUE_SHADOW));
    let faint = render(&square(&format!("{BLUE_SHADOW}, \"a\": 0.5")));
    assert_eq!(px(&opaque, 40, 40)[2], 255);
    // Half blue over black, in linear light (SCENE.md, "Blend space").
    assert!(near(px(&faint, 40, 40), [0, 0, 188, 255], 3));
    // A shadow colour with alpha scales it as well.
    let tinted = render(&square(
        r##", "shadow": {"color": "#0000ff80", "blur": 0, "x": 12, "y": 12}"##,
    ));
    assert!(near(px(&tinted, 40, 40), [0, 0, 188, 255], 3));
}

#[test]
fn a_shadow_is_cut_by_the_clip_and_composited_with_the_blend_mode() {
    let clipped = render(&format!(
        r##"[{{"op": "clip", "path": "M0 0H40V64H0Z"}},
            {{"op": "fill", "path": "M16 16H32V32H16Z", "paint": {RED}{BLUE_SHADOW}}}]"##
    ));
    assert_eq!(px(&clipped, 36, 40), [0, 0, 255, 255], "inside the clip");
    assert_eq!(px(&clipped, 42, 40), [0, 0, 0, 255], "cut off");
    // `destination-over` puts the shadow and the shape behind what is there.
    let behind = render(&format!(
        r##"[{{"op": "fill", "path": "M0 0H64V64H0Z", "paint": {{"type": "color", "color": "#00ff00"}}}},
            {{"op": "fill", "path": "M16 16H32V32H16Z", "paint": {RED}{BLUE_SHADOW},
              "blend": "destination-over"}}]"##
    ));
    assert_eq!(px(&behind, 20, 20), [0, 255, 0, 255], "behind the green");
    assert_eq!(px(&behind, 40, 40), [0, 255, 0, 255]);
}

#[test]
fn text_strokes_and_pictures_cast_shadows() {
    let text = render(
        r##"[{"op": "text", "text": "HH", "font": "DM Sans", "size": 30, "x": 4, "y": 36,
              "paint": {"type": "color", "color": "#ffffff"},
              "shadow": {"color": "#0000ff", "blur": 0, "x": 5, "y": 5}}]"##,
    );
    let blue = (0..64)
        .flat_map(|y| (0..64).map(move |x| (x, y)))
        .filter(|&(x, y)| {
            let p = px(&text, x, y);
            p[2] > 200 && p[0] < 60
        })
        .count();
    assert!(blue > 30, "{blue} shadow pixels of the text");

    let stroke = render(
        r##"[{"op": "stroke", "path": "M10 20H30", "width": 4,
              "paint": {"type": "color", "color": "#ff0000"},
              "shadow": {"color": "#0000ff", "blur": 0, "x": 0, "y": 10}}]"##,
    );
    assert_eq!(px(&stroke, 20, 20), [255, 0, 0, 255]);
    assert_eq!(px(&stroke, 20, 30), [0, 0, 255, 255]);

    // A 2 x 1 picture, red then blue, stretched to 16 x 8.
    let picture = render(
        r##"[{"op": "image", "source": {"kind": "pixels", "width": 2, "height": 1,
                "data": "/wAA/wAA//8="}, "dx": 8, "dy": 8, "dw": 16, "dh": 8, "smooth": false,
              "shadow": {"color": "#00ff00", "blur": 0, "x": 20, "y": 20}}]"##,
    );
    assert_eq!(px(&picture, 12, 12), [255, 0, 0, 255]);
    assert_eq!(
        px(&picture, 36, 32),
        [0, 255, 0, 255],
        "the picture's outline"
    );
    assert_eq!(px(&picture, 36, 20), [0, 0, 0, 255]);
}

#[test]
fn a_canvas_drawn_into_another_keeps_its_shadows() {
    let frame = render(&format!(
        r##"[{{"op": "image", "source": {{"kind": "canvas", "width": 64, "height": 64, "commands":
              [{{"op": "fill", "path": "M16 16H32V32H16Z", "paint": {RED}{BLUE_SHADOW}}}]}},
            "dx": 0, "dy": 0, "dw": 64, "dh": 64}}]"##
    ));
    assert_eq!(px(&frame, 20, 20), [255, 0, 0, 255]);
    assert_eq!(px(&frame, 40, 40), [0, 0, 255, 255]);
}

#[test]
fn blur_spreads_the_shape_and_keeps_its_middle() {
    let frame = filtered("#ff0000", r##"[{"type": "blur", "radius": 3}]"##);
    assert!(near(px(&frame, 24, 24), [255, 0, 0, 255], 2), "the middle");
    let outside = px(&frame, 13, 24);
    assert!(outside[0] > 0 && outside[0] < 128, "{outside:?}");
    let edge = px(&frame, 16, 24);
    assert!(edge[0] > outside[0] && edge[0] < 255, "{edge:?}");
}

#[test]
fn the_colour_filters_follow_css() {
    let slack = 3;
    let one = |color: &str, filter: &str| px(&filtered(color, filter), 24, 24);
    assert!(near(
        one("#ff8000", r##"[{"type": "brightness", "amount": 0.5}]"##),
        [128, 64, 0, 255],
        slack
    ));
    assert!(near(
        one("#ffffff", r##"[{"type": "contrast", "amount": 0.5}]"##),
        [191, 191, 191, 255],
        slack
    ));
    assert!(near(
        one("#ff0000", r##"[{"type": "grayscale", "amount": 1}]"##),
        [54, 54, 54, 255],
        slack
    ));
    assert!(near(
        one("#ff0000", r##"[{"type": "invert", "amount": 1}]"##),
        [0, 255, 255, 255],
        slack
    ));
    assert!(near(
        one("#ffffff", r##"[{"type": "sepia", "amount": 1}]"##),
        [255, 255, 239, 255],
        slack
    ));
    assert!(near(
        one("#ff0000", r##"[{"type": "saturate", "amount": 0}]"##),
        [54, 54, 54, 255],
        slack
    ));
    // Half-way through the wheel, red is cyan-ish: red falls, blue and green
    // rise.
    let turned = one("#ff0000", r##"[{"type": "hueRotate", "angle": 180}]"##);
    assert!(
        turned[0] < 60 && turned[1] > 100 && turned[2] > 100,
        "{turned:?}"
    );
    // A list runs in order: brightness first, then the inversion.
    assert!(near(
        one(
            "#ff8000",
            r##"[{"type": "brightness", "amount": 0.5}, {"type": "invert", "amount": 1}]"##
        ),
        [127, 191, 255, 255],
        slack
    ));
}

#[test]
fn a_drop_shadow_filter_adds_a_copy_beside_the_shape() {
    let frame = filtered(
        "#ff0000",
        r##"[{"type": "dropShadow", "x": 12, "y": 0, "blur": 0, "color": "#0000ff"}]"##,
    );
    assert_eq!(px(&frame, 20, 24), [255, 0, 0, 255], "the shape");
    assert_eq!(px(&frame, 36, 24), [0, 0, 255, 255], "its shadow");
    assert_eq!(px(&frame, 36, 40), [0, 0, 0, 255]);
}

#[test]
fn a_filter_and_a_shadow_together_cast_the_shadow_of_the_filtered_shape() {
    // Inverted red is cyan; a shadow of it is blue, offset, under the cyan.
    let frame = render(&square(&format!(
        r##"{BLUE_SHADOW}, "filter": [{{"type": "invert", "amount": 1}}]"##
    )));
    assert!(near(px(&frame, 20, 20), [0, 255, 255, 255], 2));
    assert_eq!(px(&frame, 40, 40), [0, 0, 255, 255]);
}

#[test]
fn filtered_commands_are_composited_with_their_alpha_and_blend_mode() {
    let faint = render(&square(
        r##", "filter": [{"type": "grayscale", "amount": 1}], "a": 0.5"##,
    ));
    // Grey 54 at half alpha over black, in linear light.
    let p = px(&faint, 24, 24);
    assert!(
        p[0] == p[1] && p[1] == p[2] && p[0] > 10 && p[0] < 54,
        "{p:?}"
    );
    let erased = render(&format!(
        r##"[{{"op": "fill", "path": "M0 0H64V64H0Z", "paint": {RED}}},
            {{"op": "fill", "path": "M16 16H32V32H16Z", "paint": {RED}, "blend": "destination-out",
              "filter": [{{"type": "blur", "radius": 0.01}}]}}]"##
    ));
    assert_eq!(px(&erased, 24, 24), [0, 0, 0, 255], "erased");
    assert_eq!(px(&erased, 48, 48), [255, 0, 0, 255]);
}

#[test]
fn commands_with_no_shadow_and_no_filter_are_drawn_as_they_were() {
    let plain = render(&square(""));
    assert_eq!(px(&plain, 16, 16), [255, 0, 0, 255]);
    assert_eq!(px(&plain, 15, 16), [0, 0, 0, 255]);
    let empty = render(&square(r##", "filter": [], "shadow": null"##));
    assert_eq!(plain.rgba, empty.rgba);
}

fn load(name: &str) -> Scene {
    Scene::load(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/scenes")
            .join(name),
    )
    .unwrap()
}

#[test]
fn a_renderer_draws_the_same_pixels_again_and_after_other_scenes() {
    // The pictures a shadow makes live in Vello's image atlas for a frame;
    // none of that may reach the next one.
    let effects = load("canvas-effects.json");
    let other = load("canvas.json");
    let want = render_still(effects.clone(), 0).unwrap();
    let mut renderer = Renderer::new(effects.clone()).unwrap();
    for cache in [false, true] {
        renderer.set_layer_cache(cache);
        for (scene, is_effects) in [
            (&effects, true),
            (&other, false),
            (&effects, true),
            (&effects, true),
        ] {
            renderer.set_scene(scene.clone()).unwrap();
            let got = renderer.render_frame(0).unwrap();
            if is_effects {
                assert!(got.rgba == want.rgba, "cache {cache}");
            }
        }
    }
}

/// A 64 x 64 scene (with `scene` fields, after a comma) holding one 24 x 24
/// canvas layer (with `layer` fields) with a red 8 x 8 square at (4, 4) and a
/// blue shadow 6 pixels to the right and down of it.
fn placed(scene: &str, layer: &str) -> Frame {
    let json = format!(
        r##"{{"width": 64, "height": 64, "fps": 30, "durationInFrames": 2, "background": "#000000"{scene},
            "layers": [{{"id": "c", "type": "canvas", "width": 24, "height": 24, {layer}
              "commands": [{{"op": "fill", "path": "M4 4h8v8h-8Z", "paint": {RED},
                "shadow": {{"color": "#0000ff", "x": 6, "y": 6}}}}]}}]}}"##
    );
    render_still(Scene::from_json(&json, Default::default()).unwrap(), 1).unwrap()
}

#[test]
fn shadows_follow_the_layers_transform_and_the_scenes_margin() {
    let frame = placed("", r##""transform": {"x": 20, "y": 30},"##);
    assert_eq!(px(&frame, 26, 36), [255, 0, 0, 255], "the shape");
    assert_eq!(px(&frame, 36, 46), [0, 0, 255, 255], "its shadow");
    // A margin moves where Vello draws, not what is drawn.
    let margined = placed(
        r##", "margin": 12"##,
        r##""transform": {"x": 20, "y": 30},"##,
    );
    assert!(frame.rgba == margined.rgba);
    // Turned a quarter, the shadow turns with the layer.
    let turned = placed("", r##""transform": {"x": 40, "y": 10, "rotation": 90},"##);
    assert_eq!(px(&turned, 33, 16), [255, 0, 0, 255], "the shape, turned");
    assert_eq!(px(&turned, 25, 24), [0, 0, 255, 255], "its shadow, turned");
    assert_eq!(px(&turned, 38, 24), [0, 0, 0, 255], "not where it was");
}

#[test]
fn a_scaled_layer_scales_its_shadows() {
    // The canvas is stretched, as CSS stretches a bitmap: twice the shape, and
    // twice the offset.
    let frame = placed("", r##""transform": {"scale": 2},"##);
    assert_eq!(px(&frame, 16, 16), [255, 0, 0, 255], "the shape, 8 to 24");
    assert_eq!(px(&frame, 30, 30), [0, 0, 255, 255], "its shadow, 12 on");
    assert_eq!(px(&frame, 38, 38), [0, 0, 0, 255]);
    // And twice the blur: a deviation of 4 instead of 2 from a blur of 4 and 8.
    let json = |scale: &str, blur: u32| {
        let commands = format!(
            r##"[{{"op": "fill", "path": "M8 8h16v16h-16Z", "paint": {RED},
                  "shadow": {{"color": "#0000ff", "blur": {blur}}}}}]"##
        );
        let json = format!(
            r##"{{"width": 64, "height": 64, "fps": 30, "durationInFrames": 1, "background": "#000000",
                "layers": [{{"id": "c", "type": "canvas", "width": 64, "height": 64,
                  "transform": {{"scale": {scale}}}, "commands": {commands}}}]}}"##
        );
        render_still(Scene::from_json(&json, Default::default()).unwrap(), 0).unwrap()
    };
    let (wide, narrow) = (json("2", 4), json("1", 8));
    // The same profile 4 pixels outside the edge of a shape: a deviation of 4
    // in both.
    let (a, b) = (px(&wide, 12, 32)[2], px(&narrow, 4, 16)[2]);
    assert!(
        a > 20 && (i32::from(a) - i32::from(b)).abs() <= 10,
        "{a} {b}"
    );
}

#[test]
fn a_motion_blurred_canvas_with_a_shadow_draws() {
    // Each sample is drawn into the box it covers, not the whole canvas.
    let frame = placed(
        "",
        r##""transform": {"x": [{"frame": 0, "value": 0}, {"frame": 1, "value": 20}], "y": 10},
            "motionBlur": {"samples": 4, "shutter": 0.5},"##,
    );
    let shadow = (0..64 * 64)
        .map(|i| px(&frame, i % 64, i / 64))
        .filter(|p| p[2] > 100 && p[0] < 60)
        .count();
    assert!(shadow > 40, "{shadow} shadow pixels");
}

/// A 2400 x 2000 scene of `frames` frames whose canvas has `count` commands, each
/// a small red square at (10 + 10 i, 10) with a blue shadow 20 pixels below it
/// and a speck in the far corner, which makes the command's picture the size of
/// the whole canvas: 4.8 million pixels.
fn whole_canvas_pictures(count: usize, frames: u32) -> Scene {
    let commands: Vec<String> = (0..count)
        .map(|i| {
            format!(
                r##"{{"op": "fill", "path": "M{} 10h4v4h-4Z M2390 1990h1v1h-1Z", "paint": {RED},
                      "shadow": {{"color": "#0000ff", "y": 20}}}}"##,
                10 + i * 10
            )
        })
        .collect();
    let json = format!(
        r##"{{"width": 2400, "height": 2000, "fps": 30, "durationInFrames": {frames},
            "background": "#000000", "layers": [{{"id": "c", "type": "canvas",
              "width": 2400, "height": 2000, "commands": [{}]}}]}}"##,
        commands.join(",")
    );
    Scene::from_json(&json, Default::default()).unwrap()
}

/// Whether the shadow of command `i` of `whole_canvas_pictures` is drawn.
fn has_shadow(frame: &Frame, i: usize) -> bool {
    px(frame, 11 + 10 * i, 30) == [0, 0, 255, 255]
}

#[test]
fn pictures_past_what_vellos_atlas_holds_are_an_error_not_a_hole() {
    common::pin_vello();
    // Vello's atlas is 8192 x 8192; 11 of these are over three quarters of it.
    let message = render_still(whole_canvas_pictures(11, 1), 0)
        .err()
        .expect("too many pictures")
        .to_string();
    assert!(message.contains("image atlas"), "{message}");
    // A renderer that refused one frame draws the next.
    let mut renderer = Renderer::new(whole_canvas_pictures(11, 1)).unwrap();
    assert!(renderer.render_frame(0).is_err());
    renderer.set_scene(whole_canvas_pictures(5, 1)).unwrap();
    let frame = renderer.render_frame(0).unwrap();
    assert!((0..5).all(|i| has_shadow(&frame, i)));
}

#[test]
fn pictures_give_their_place_back_between_frames() {
    // Eight a frame are within the budget, and each frame after the first must
    // find the atlas as empty as the first did: Vello would keep the pictures
    // of the last two frames and have no room for the third.
    let mut renderer = Renderer::new(whole_canvas_pictures(8, 4)).unwrap();
    for frame in 0..4 {
        let drawn = renderer.render_frame(frame).unwrap();
        for i in 0..8 {
            assert!(has_shadow(&drawn, i), "frame {frame}, shadow {i}");
        }
    }
}

#[test]
fn many_shadows_in_one_frame_all_draw() {
    // Each shadow is a picture in the atlas; a few hundred must fit. The
    // squares are 2 pixels across, 4 apart, and each shadow falls in the gap.
    let commands: Vec<String> = (0..256)
        .map(|i| {
            let (x, y) = (1 + (i % 16) * 4, 1 + (i / 16) * 4);
            format!(
                r##"{{"op": "fill", "path": "M{x} {y}h2v2h-2Z", "paint": {RED},
                      "shadow": {{"color": "#0000ff", "x": 2, "y": 0}}}}"##
            )
        })
        .collect();
    let frame = render(&format!("[{}]", commands.join(",")));
    let count = |color: [u8; 4]| {
        (0..64 * 64)
            .filter(|i| px(&frame, i % 64, i / 64) == color)
            .count()
    };
    assert_eq!(count([255, 0, 0, 255]), 256 * 4, "every square");
    // The last column's shadows are cut by the canvas edge, a column wide.
    assert_eq!(count([0, 0, 255, 255]), 256 * 4 - 16 * 2, "every shadow");
}
