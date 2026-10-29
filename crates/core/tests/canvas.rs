//! Canvas layers: what a few commands leave in the pixels (packages/cli/skills/kinetograph/references/SCENE.md,
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

/// Canvas 2D gradients blend their stops without premultiplying alpha (HTML canvas spec; Chrome and Firefox do), unlike
/// CSS gradients (CSS Images 4): half way from transparent green to opaque red is a half-transparent (0.5, 0.5, 0), so
/// some green is left over black. Premultiplied, it would be (0.5, 0, 0) at half alpha, with no green at all.
#[test]
fn a_gradient_between_two_alphas_blends_unpremultiplied() {
    let frame = render(
        r##"[{"op": "fill", "path": "M0 0H16V16H0Z",
              "paint": {"type": "linear", "x0": 0, "y0": 0, "x1": 16, "y1": 0,
                        "stops": [[0, "#00ff0000"], [1, "#ff0000ff"]]}}]"##,
    );
    let mid = px(&frame, 8, 8);
    assert!(mid[1] > 40, "green is left at the middle: {mid:?}");
    assert!(mid[0] > 40, "{mid:?}");
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
    // (The pattern repeats, so the sampling at its outer edges mixes in the tile next to it.)
    assert!(px(&scaled, 0, 0)[0] > 120 && px(&scaled, 0, 0)[0] > 2 * px(&scaled, 0, 0)[2]);
    assert!(px(&scaled, 1, 0)[0] > px(&scaled, 1, 0)[2]);
    assert!(px(&scaled, 2, 0)[2] > px(&scaled, 2, 0)[0]);
    assert!(px(&scaled, 3, 0)[2] > 120 && px(&scaled, 3, 0)[2] > 2 * px(&scaled, 3, 0)[0]);
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
fn a_fill_with_a_canvas_pattern_tiles_and_clips() {
    let draw = |commands: &str| {
        let json = format!(
            r##"{{"width": 24, "height": 24, "fps": 30, "durationInFrames": 1, "background": "#000000",
                "layers": [{{"id": "c", "type": "canvas", "width": 24, "height": 24, "commands": {commands}}}]}}"##
        );
        render_still(Scene::from_json(&json, Default::default()).unwrap(), 0).unwrap()
    };
    let source = format!(
        r##"{{"kind": "canvas", "width": 10, "height": 10,
            "commands": [{{"op": "fill", "path": "M0 0H5V5H0Z", "paint": {RED}}}]}}"##
    );

    let repeating = draw(&format!(
        r##"[{{"op": "fill", "path": "M0 0H20V20H0Z",
              "paint": {{"type": "pattern", "source": {source}}}}}]"##
    ));
    assert_eq!(px(&repeating, 2, 2), [255, 0, 0, 255]);
    assert_eq!(px(&repeating, 7, 2), [0, 0, 0, 255]);
    assert_eq!(px(&repeating, 12, 2), [255, 0, 0, 255]);
    assert_eq!(px(&repeating, 2, 12), [255, 0, 0, 255]);
    assert_eq!(px(&repeating, 12, 12), [255, 0, 0, 255]);
    assert_eq!(px(&repeating, 17, 17), [0, 0, 0, 255]);
    assert_eq!(px(&repeating, 22, 2), [0, 0, 0, 255]);

    // Clipped to the fill path even inside a drawn tile's red square (10..15).
    let clipped = draw(&format!(
        r##"[{{"op": "fill", "path": "M0 0H12V12H0Z",
              "paint": {{"type": "pattern", "source": {source}}}}}]"##
    ));
    assert_eq!(px(&clipped, 11, 2), [255, 0, 0, 255]);
    assert_eq!(px(&clipped, 13, 2), [0, 0, 0, 255]);
    assert_eq!(px(&clipped, 2, 13), [0, 0, 0, 255]);

    let repeat_x_only = draw(&format!(
        r##"[{{"op": "fill", "path": "M0 0H20V20H0Z",
              "paint": {{"type": "pattern", "source": {source}, "repeatX": true, "repeatY": false}}}}]"##
    ));
    assert_eq!(px(&repeat_x_only, 2, 2), [255, 0, 0, 255]);
    assert_eq!(px(&repeat_x_only, 12, 2), [255, 0, 0, 255]);
    assert_eq!(px(&repeat_x_only, 2, 12), [0, 0, 0, 255]);
    assert_eq!(px(&repeat_x_only, 12, 12), [0, 0, 0, 255]);

    let scaled = draw(&format!(
        r##"[{{"op": "fill", "path": "M0 0H20V20H0Z",
              "paint": {{"type": "pattern", "source": {source}, "m": [2, 0, 0, 2, 0, 0]}}}}]"##
    ));
    assert_eq!(px(&scaled, 2, 2), [255, 0, 0, 255]);
    assert_eq!(px(&scaled, 7, 2), [255, 0, 0, 255]);
    assert_eq!(px(&scaled, 7, 7), [255, 0, 0, 255]);
    assert_eq!(px(&scaled, 12, 2), [0, 0, 0, 255]);
    assert_eq!(px(&scaled, 2, 12), [0, 0, 0, 255]);
    assert_eq!(px(&scaled, 17, 17), [0, 0, 0, 255]);
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

// ---- a picture drawn many times is stored once (`sources`) ----

/// A 24 x 24 scene with one canvas layer; `rest` is more of the layer's fields (`"sources": [...]`).
fn render_layer(commands: &str, rest: &str) -> Result<Frame, Error> {
    let json = format!(
        r##"{{"width": 24, "height": 24, "fps": 30, "durationInFrames": 1, "background": "#223344",
            "layers": [{{"id": "c", "type": "canvas", "width": 24, "height": 24, "commands": {commands}{rest}}}]}}"##
    );
    Scene::from_json(&json, Default::default()).and_then(|scene| render_still(scene, 0))
}

/// Draws of `source` under three different clips and transforms, with `source` inline or as `ref`s.
fn many_draws(source: &str) -> String {
    format!(
        r##"[{{"op": "clip", "path": "M0 0L14 2L3 14Z"}},
             {{"op": "image", "source": {source}, "dx": 0, "dy": 0, "dw": 8, "dh": 8, "m": [1.5, 0.3, -0.2, 1.2, 1, 1]}},
             {{"op": "unclip"}},
             {{"op": "clip", "path": "M10 10L24 12L12 24Z"}},
             {{"op": "image", "source": {source}, "dx": 0, "dy": 0, "dw": 8, "dh": 8, "a": 0.6, "m": [1.9, 0, 0.4, 1.7, 8, 9]}},
             {{"op": "unclip"}},
             {{"op": "image", "source": {source}, "sx": 1, "sy": 1, "sw": 4, "sh": 3, "dx": 14, "dy": 1, "dw": 8, "dh": 6, "smooth": false}},
             {{"op": "image", "source": {source}, "dx": 2, "dy": 16, "dw": 6, "dh": 6, "blend": "multiply"}}]"##
    )
}

const REF0: &str = r##"{"kind": "ref", "index": 0}"##;

#[test]
fn pixels_drawn_many_times_look_the_same_from_the_table() {
    // 2x2 RGBA: red, blue / green, white.
    let pixels = r##"{"kind": "pixels", "width": 2, "height": 2, "data": "/wAA/wAA//8A/wD//////w=="}"##;
    let inline = render_layer(&many_draws(pixels), "").unwrap();
    let table = render_layer(&many_draws(REF0), &format!(r#", "sources": [{pixels}]"#)).unwrap();
    assert_eq!(inline.rgba, table.rgba);
    assert_ne!(inline.rgba, render_layer("[]", "").unwrap().rgba, "something is drawn");
}

/// How many bytes of two frames differ, and by how much at most.
fn differ(a: &Frame, b: &Frame) -> (usize, u8) {
    let pairs = a.rgba.iter().zip(&b.rgba).filter(|(x, y)| x != y);
    (pairs.clone().count(), pairs.map(|(x, y)| x.abs_diff(*y)).max().unwrap_or(0))
}

#[test]
fn a_canvas_drawn_many_times_looks_the_same_from_the_table() {
    let fill = |path: &str, paint: &str, extra: &str| {
        format!(r##"{{"op": "fill", "path": "{path}", "paint": {paint}{extra}}}"##)
    };
    let yellow = r##"{"type": "color", "color": "#ffcc00"}"##;
    let blue = r##"{"type": "color", "color": "#0044ff"}"##;
    let pixels = r##"{"kind": "pixels", "width": 2, "height": 2, "data": "/wAA/wAA//8A/wD//////w=="}"##;
    let image = format!(r##"{{"op": "image", "source": {pixels}, "dx": 1, "dy": 1, "dw": 7, "dh": 6, "a": 0.7}}"##);
    let tiles = [
        ("a fill and alpha", vec![fill("M0 0H8V8H0Z", yellow, ""), fill("M2 2H8V8H2Z", RED, r#", "a": 0.5"#)]),
        ("blends", vec![
            fill("M0 0H8V8H0Z", yellow, ""),
            fill("M6 0H8V3H6Z", blue, r#", "blend": "multiply""#),
            fill("M0 5H5V8H0Z", blue, r#", "blend": "source-in""#),
            fill("M3 3H6V6H3Z", blue, r#", "blend": "destination-out", "a": 0.5"#),
            fill("M1 1H7V2H1Z", RED, r#", "blend": "lighter""#),
        ]),
        ("pictures and strokes", vec![
            image.clone(),
            r##"{"op": "stroke", "path": "M1 1L7 7", "paint": {"type": "color", "color": "#00ff88"}, "width": 2}"##.into(),
        ]),
        ("a canvas in it", vec![
            fill("M0 0H8V8H0Z", yellow, ""),
            format!(r##"{{"op": "image", "source": {{"kind": "canvas", "width": 4, "height": 4, "commands": [{}]}}, "dx": 2, "dy": 2, "dw": 4, "dh": 4, "a": 0.8}}"##, fill("M0 0H4V2H0Z", RED, "")),
        ]),
        // Clips and shadows are drawn straight, as before.
        ("a clip", vec![fill("M0 0H8V8H0Z", yellow, ""), r##"{"op": "clip", "path": "M0 0H6V6H0Z"}"##.into(), fill("M2 2H8V8H2Z", RED, ""), r##"{"op": "unclip"}"##.into()]),
        ("a shadow", vec![fill("M1 1H5V5H1Z", yellow, r##", "shadow": {"color": "#000000", "blur": 2, "x": 2, "y": 2}"##)]),
    ];
    let mut bad = Vec::new();
    for (name, ops) in tiles {
        let tile = format!(r##"{{"kind": "canvas", "width": 8, "height": 8, "commands": [{}]}}"##, ops.join(","));
        let inline = render_layer(&many_draws(&tile), "").unwrap();
        let table = render_layer(&many_draws(REF0), &format!(r#", "sources": [{tile}]"#)).unwrap();
        let (n, most) = differ(&inline, &table);
        if n > 0 {
            bad.push(format!("{name}: {n} bytes differ, by {most} at most"));
        }
        assert_ne!(inline.rgba, render_layer("[]", "").unwrap().rgba, "{name} draws something");
    }
    assert!(bad.is_empty(), "{bad:?}");
}

#[test]
fn a_table_entry_can_draw_an_earlier_entry() {
    // Entry 1 is a canvas that draws entry 0 twice; the layer draws entry 1 twice.
    let pixels = r##"{"kind": "pixels", "width": 2, "height": 1, "data": "/wAA/wAA//8="}"##;
    let tile_inline = format!(
        r##"{{"kind": "canvas", "width": 8, "height": 8, "commands": [
              {{"op": "image", "source": {pixels}, "dx": 0, "dy": 0, "dw": 8, "dh": 4}},
              {{"op": "image", "source": {pixels}, "dx": 0, "dy": 4, "dw": 4, "dh": 4}}]}}"##
    );
    let tile_ref = format!(
        r##"{{"kind": "canvas", "width": 8, "height": 8, "commands": [
              {{"op": "image", "source": {REF0}, "dx": 0, "dy": 0, "dw": 8, "dh": 4}},
              {{"op": "image", "source": {REF0}, "dx": 0, "dy": 4, "dw": 4, "dh": 4}}]}}"##
    );
    let two = |source: &str| {
        format!(
            r##"[{{"op": "image", "source": {source}, "dx": 0, "dy": 0, "dw": 8, "dh": 8}},
                 {{"op": "image", "source": {source}, "dx": 10, "dy": 3, "dw": 8, "dh": 8, "m": [1, 0.2, 0, 1, 0, 0]}}]"##
        )
    };
    let inline = render_layer(&two(&tile_inline), "").unwrap();
    let table = render_layer(
        &two(r##"{"kind": "ref", "index": 1}"##),
        &format!(r#", "sources": [{pixels}, {tile_ref}]"#),
    )
    .unwrap();
    assert_eq!(inline.rgba, table.rgba);
}

#[test]
fn a_ref_the_table_has_no_entry_for_is_an_error() {
    let err = render_layer(&many_draws(r##"{"kind": "ref", "index": 3}"##), r#", "sources": []"#).map(|_| ());
    // With no table at all the ref draws nothing; with a table that is too short the layer does not load.
    assert!(err.is_ok());
    let pixels = r##"{"kind": "pixels", "width": 1, "height": 1, "data": "/wAA/w=="}"##;
    let err = render_layer(&many_draws(r##"{"kind": "ref", "index": 3}"##), &format!(r#", "sources": [{pixels}]"#));
    assert!(err.is_err_and(|e| e.to_string().contains("canvas source 3")));
}
