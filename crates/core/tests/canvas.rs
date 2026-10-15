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
