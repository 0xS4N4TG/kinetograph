//! Canvas layers: what a few commands leave in the pixels (docs/SCENE.md,
//! "canvas"). The whole feature set is in the `canvas` golden.

use std::path::Path;

use kinetograph_core::{Error, Frame, Scene, render_still};

/// A 16 x 16 scene, black background, with one canvas layer of `commands`.
fn render(commands: &str) -> Frame {
    let json = format!(
        r##"{{"width": 16, "height": 16, "fps": 30, "durationInFrames": 1, "background": "#000000",
            "fonts": {{"DM Sans": "../../../assets/fonts/DMSans-Medium.ttf"}},
            "layers": [{{"id": "c", "type": "canvas", "width": 16, "height": 16, "commands": {commands}}}]}}"##
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

#[test]
fn a_fill_draws_under_its_matrix() {
    let frame = render(&format!(
        r##"[{{"op": "fill", "path": "M0 0H4V4H0Z", "paint": {RED}, "m": [2, 0, 0, 2, 4, 4]}}]"##
    ));
    assert_eq!(px(&frame, 5, 5), [255, 0, 0, 255]);
    assert_eq!(px(&frame, 11, 11), [255, 0, 0, 255]);
    assert_eq!(px(&frame, 3, 3), [0, 0, 0, 255]);
    assert_eq!(px(&frame, 13, 13), [0, 0, 0, 255]);
}

#[test]
fn what_is_drawn_outside_the_canvas_box_is_cut() {
    let json = format!(
        r##"{{"width": 16, "height": 16, "fps": 30, "durationInFrames": 1, "background": "#000000",
            "layers": [{{"id": "c", "type": "canvas", "width": 8, "height": 8, "commands":
              [{{"op": "fill", "path": "M0 0H16V16H0Z", "paint": {RED}}}]}}]}}"##
    );
    let frame = render_still(Scene::from_json(&json, Default::default()).unwrap(), 0).unwrap();
    assert_eq!(px(&frame, 4, 4), [255, 0, 0, 255]);
    assert_eq!(px(&frame, 12, 12), [0, 0, 0, 255]);
}

#[test]
fn a_clip_holds_until_unclip() {
    let frame = render(&format!(
        r##"[{{"op": "clip", "path": "M0 0H8V16H0Z"}},
            {{"op": "fill", "path": "M0 0H16V4H0Z", "paint": {RED}}},
            {{"op": "unclip"}},
            {{"op": "fill", "path": "M0 8H16V12H0Z", "paint": {RED}}}]"##
    ));
    assert_eq!(px(&frame, 4, 2), [255, 0, 0, 255]);
    assert_eq!(px(&frame, 12, 2), [0, 0, 0, 255], "cut by the clip");
    assert_eq!(px(&frame, 12, 10), [255, 0, 0, 255], "past the unclip");
}

#[test]
fn global_alpha_and_destination_out() {
    let frame = render(&format!(
        r##"[{{"op": "fill", "path": "M0 0H16V16H0Z", "paint": {RED}, "a": 0.5}},
            {{"op": "fill", "path": "M0 0H8V8H0Z", "paint": {RED}, "blend": "destination-out"}}]"##
    ));
    // Half red over black, in linear light (SCENE.md, "Blend space"): 188.
    let half = px(&frame, 12, 12);
    assert!(
        (i32::from(half[0]) - 188).abs() <= 2 && half[1] == 0,
        "{half:?}"
    );
    assert_eq!(
        px(&frame, 4, 4),
        [0, 0, 0, 255],
        "erased back to the background"
    );
}

#[test]
fn a_linear_gradient_runs_between_its_stops() {
    let frame = render(
        r##"[{"op": "fill", "path": "M0 0H16V16H0Z",
              "paint": {"type": "linear", "x0": 0, "y0": 0, "x1": 16, "y1": 0,
                        "stops": [[0, "#000000"], [1, "#ffffff"]]}}]"##,
    );
    let (left, right) = (px(&frame, 1, 8)[0], px(&frame, 14, 8)[0]);
    assert!(left < 40 && right > 215, "{left} {right}");
}

#[test]
fn text_draws_with_the_scenes_font() {
    let frame = render(
        r##"[{"op": "text", "text": "Hi", "font": "DM Sans", "size": 14, "x": 1, "y": 14,
              "paint": {"type": "color", "color": "#ffffff"}}]"##,
    );
    let lit = (0..16)
        .flat_map(|y| (0..16).map(move |x| (x, y)))
        .filter(|&(x, y)| px(&frame, x, y)[0] > 128)
        .count();
    assert!(lit > 10, "{lit} pixels lit");
    assert_eq!(
        px(&frame, 14, 1),
        [0, 0, 0, 255],
        "above the baseline, away from the glyphs"
    );
}

fn rightmost_lit(frame: &Frame) -> usize {
    (0..frame.width as usize)
        .filter(|&x| (0..frame.height as usize).any(|y| px(frame, x, y)[0] > 32))
        .max()
        .expect("some pixel is lit")
}

#[test]
fn text_letter_and_word_spacing_move_glyphs_right() {
    let default_letter = render(
        r##"[{"op": "text", "text": "II", "font": "DM Sans", "size": 10, "x": 1, "y": 12,
              "paint": {"type": "color", "color": "#ffffff"}}]"##,
    );
    let zero_letter = render(
        r##"[{"op": "text", "text": "II", "font": "DM Sans", "size": 10, "x": 1, "y": 12,
              "letterSpacing": 0, "paint": {"type": "color", "color": "#ffffff"}}]"##,
    );
    let spaced_letter = render(
        r##"[{"op": "text", "text": "II", "font": "DM Sans", "size": 10, "x": 1, "y": 12,
              "letterSpacing": 10, "paint": {"type": "color", "color": "#ffffff"}}]"##,
    );
    assert_eq!(default_letter.rgba, zero_letter.rgba);
    assert_ne!(zero_letter.rgba, spaced_letter.rgba);
    assert!(rightmost_lit(&spaced_letter) > rightmost_lit(&zero_letter));

    let default_word = render(
        r##"[{"op": "text", "text": "I I", "font": "DM Sans", "size": 8, "x": 1, "y": 12,
              "paint": {"type": "color", "color": "#ffffff"}}]"##,
    );
    let zero_word = render(
        r##"[{"op": "text", "text": "I I", "font": "DM Sans", "size": 8, "x": 1, "y": 12,
              "wordSpacing": 0, "paint": {"type": "color", "color": "#ffffff"}}]"##,
    );
    let spaced_word = render(
        r##"[{"op": "text", "text": "I I", "font": "DM Sans", "size": 8, "x": 1, "y": 12,
              "wordSpacing": 6, "paint": {"type": "color", "color": "#ffffff"}}]"##,
    );
    assert_eq!(default_word.rgba, zero_word.rgba);
    assert_ne!(zero_word.rgba, spaced_word.rgba);
    assert!(rightmost_lit(&spaced_word) > rightmost_lit(&zero_word));
}

#[test]
fn a_pattern_transforms_its_tile_space_by_m() {
    // 2x2 RGBA: left column red, right column blue.
    let data = "/wAA/wAA//8/AAD/AAD//w==";
    let plain = render(&format!(
        r##"[{{"op": "fill", "path": "M0 0H16V16H0Z",
              "paint": {{"type": "pattern",
                        "source": {{"kind": "pixels", "width": 2, "height": 2, "data": "{data}"}}}}}}]"##
    ));
    let scaled = render(&format!(
        r##"[{{"op": "fill", "path": "M0 0H16V16H0Z",
              "paint": {{"type": "pattern",
                        "source": {{"kind": "pixels", "width": 2, "height": 2, "data": "{data}"}},
                        "m": [2, 0, 0, 2, 0, 0]}}}}]"##
    ));
    // Without `m`, each pattern pixel is 1 canvas pixel wide: x=0 is red, x=1 is blue.
    assert!(px(&plain, 0, 0)[0] > 200 && px(&plain, 0, 0)[2] < 50);
    assert!(px(&plain, 1, 0)[2] > 200 && px(&plain, 1, 0)[0] < 50);
    // With `m = [2, 0, 0, 2, 0, 0]`, each pattern pixel is 2x2 canvas pixels wide: x=0..2 are
    // red and x=2..4 blue (the sampling is smooth, so the middle two are mixes).
    assert_ne!(plain.rgba, scaled.rgba);
    assert!(px(&scaled, 0, 0)[0] > 200 && px(&scaled, 0, 0)[2] < 50);
    assert!(px(&scaled, 1, 0)[0] > px(&scaled, 1, 0)[2]);
    assert!(px(&scaled, 2, 0)[2] > px(&scaled, 2, 0)[0]);
    assert!(px(&scaled, 3, 0)[2] > 200 && px(&scaled, 3, 0)[0] < 50);
}

#[test]
fn pixels_are_drawn_without_smoothing_when_asked() {
    // 2 x 1: red, then blue, stretched to 16 wide: a hard edge at 8.
    let frame = render(
        r##"[{"op": "image", "source": {"kind": "pixels", "width": 2, "height": 1,
                "data": "/wAA/wAA//8="}, "dx": 0, "dy": 0, "dw": 16, "dh": 16, "smooth": false}]"##,
    );
    assert_eq!(px(&frame, 4, 8), [255, 0, 0, 255]);
    assert_eq!(px(&frame, 12, 8), [0, 0, 255, 255]);
    assert_eq!(px(&frame, 7, 8), [255, 0, 0, 255]);
    assert_eq!(px(&frame, 8, 8), [0, 0, 255, 255]);
}

#[test]
fn a_command_with_bad_path_data_is_refused_with_the_layer() {
    let json = r##"{"width": 4, "height": 4, "fps": 30, "durationInFrames": 1, "layers": [
        {"id": "c", "type": "canvas", "width": 4, "height": 4, "commands":
          [{"op": "fill", "path": "M0 0 Q", "paint": {"type": "color", "color": "#fff"}}]}]}"##;
    match Scene::from_json(json, Default::default()) {
        Err(Error::Scene(message)) => {
            assert!(
                message.contains("layer \"c\"") && message.contains("bad path"),
                "{message}"
            );
        }
        other => panic!("expected a scene error, got {:?}", other.err()),
    }
}
