use std::path::{Path, PathBuf};

use kinetograph_core::{Error, Renderer, Scene, render_still};

fn example() -> Scene {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/basic.json");
    Scene::load(&path).unwrap()
}

#[test]
fn same_scene_and_frame_give_identical_bytes() {
    // Fresh GPU state each time...
    let a = render_still(example(), 20).unwrap().encode_png().unwrap();
    let b = render_still(example(), 20).unwrap().encode_png().unwrap();
    assert_eq!(a, b);

    // ...and one renderer reused, with another frame in between.
    let mut renderer = Renderer::new(example()).unwrap();
    let c = renderer.render_frame(20).unwrap().encode_png().unwrap();
    let other = renderer.render_frame(0).unwrap().encode_png().unwrap();
    let d = renderer.render_frame(20).unwrap().encode_png().unwrap();
    assert_eq!(a, c);
    assert_eq!(c, d);
    assert_ne!(c, other, "animated scene should change between frames");
}

#[test]
fn renders_all_layer_types() {
    let frame = render_still(example(), 20).unwrap();
    assert_eq!((frame.width, frame.height), (640, 360));
    let px = |x: usize, y: usize| {
        let i = (y * frame.width as usize + x) * 4;
        &frame.rgba[i..i + 4]
    };
    assert_eq!(px(2, 2), [0x14, 0x17, 0x1f, 0xff], "background");
    // Centre of the card (shape), the gradient image, and a glyph stem.
    assert_ne!(px(230, 120), px(2, 2), "shape");
    assert_ne!(px(530, 90), px(2, 2), "image");
    let text_pixels = (240..340)
        .flat_map(|y| (50..300).map(move |x| (x, y)))
        .filter(|&(x, y)| px(x, y)[0] > 200 && px(x, y)[2] > 200)
        .count();
    assert!(text_pixels > 200, "text drew {text_pixels} bright pixels");
}

#[test]
fn out_of_range_frames_error_before_rendering() {
    let scene = example();
    let duration = scene.duration_in_frames;
    for frame in [duration, duration + 100, u32::MAX] {
        match render_still(example(), frame) {
            Err(Error::FrameOutOfRange {
                frame: f,
                duration: d,
            }) => {
                assert_eq!((f, d), (frame, duration));
            }
            other => panic!(
                "frame {frame}: expected FrameOutOfRange, got {:?}",
                other.err()
            ),
        }
    }
    assert!(render_still(scene, duration - 1).is_ok());
}

#[test]
fn blends_in_linear_light() {
    let json = r##"{
        "width": 8, "height": 8, "fps": 30, "durationInFrames": 1,
        "background": "#000000",
        "layers": [
            {"id": "white", "type": "shape", "opacity": 0.5,
             "shape": {"kind": "rect", "width": 8, "height": 8}, "fill": "#ffffff"}
        ]
    }"##;
    let scene = Scene::from_json(json, PathBuf::new()).unwrap();
    let frame = render_still(scene, 0).unwrap();
    // 50% white over black is 0.5 in linear light, which is 188 in sRGB.
    // (Blending in sRGB space, as CSS does, would give 128.)
    for chunk in frame.rgba.chunks(4) {
        assert!(chunk[0].abs_diff(188) <= 1, "got {chunk:?}");
        assert_eq!(chunk[0], chunk[1]);
        assert_eq!(chunk[3], 255);
    }
}

#[test]
fn opaque_colours_survive_the_linear_round_trip() {
    let json = r##"{
        "width": 8, "height": 8, "fps": 30, "durationInFrames": 1,
        "background": "#102030",
        "layers": [
            {"id": "a", "type": "shape",
             "shape": {"kind": "rect", "width": 4, "height": 8}, "fill": "#c0ffee"},
            {"id": "g", "type": "group", "children": [
                {"id": "b", "type": "shape", "transform": {"x": 4},
                 "shape": {"kind": "rect", "width": 4, "height": 8}, "fill": "#7f3fbf"}]}
        ]
    }"##;
    let frame = render_still(Scene::from_json(json, PathBuf::new()).unwrap(), 0).unwrap();
    assert_eq!(&frame.rgba[4..8], [0xc0, 0xff, 0xee, 0xff]);
    assert_eq!(&frame.rgba[(5 * 4)..(5 * 4 + 4)], [0x7f, 0x3f, 0xbf, 0xff]);
}

#[test]
fn timing_a_frame_does_not_change_its_pixels() {
    let mut renderer = Renderer::new(example()).unwrap();
    let plain = renderer.render_frame(20).unwrap();
    let (timed, t) = renderer.render_timed(20).unwrap();
    assert_eq!(plain.rgba, timed.rgba);
    assert!(t.raster_ms > 0.0 && t.composite_ms > 0.0 && t.readback_ms > 0.0);
    assert!(t.resolve_ms >= 0.0);
    // Timing is off again afterwards.
    assert_eq!(renderer.render_frame(20).unwrap().rgba, plain.rgba);
}

#[test]
fn a_shadow_can_fall_on_the_canvas_from_a_layer_outside_it() {
    // The red square is wholly left of the canvas, 20..40 pixels past its
    // edge. Its opaque black shadow lands 40 pixels to the right, on the
    // canvas, which needs the margin to have kept the square at all.
    let json = r##"{
        "width": 100, "height": 60, "fps": 30, "durationInFrames": 1,
        "background": "#ffffff",
        "layers": [
            {"id": "square", "type": "shape", "transform": {"x": -30, "y": 20},
             "shape": {"kind": "rect", "width": 20, "height": 20}, "fill": "#ff0000",
             "effects": [{"type": "dropShadow", "x": 40, "color": "#000000"}]}
        ]
    }"##;
    let frame = render_still(Scene::from_json(json, PathBuf::new()).unwrap(), 0).unwrap();
    let px = |x: usize, y: usize| {
        let i = (y * frame.width as usize + x) * 4;
        [
            frame.rgba[i],
            frame.rgba[i + 1],
            frame.rgba[i + 2],
            frame.rgba[i + 3],
        ]
    };
    assert_eq!((frame.width, frame.height), (100, 60));
    assert_eq!(px(20, 30), [0, 0, 0, 255], "inside the shadow");
    for (x, y) in [(5, 30), (50, 30), (20, 10), (20, 50)] {
        assert_eq!(px(x, y), [255, 255, 255, 255], "outside it at ({x}, {y})");
    }
}

#[test]
fn a_margin_does_not_move_or_change_the_canvas() {
    // The second scene adds an invisible shadow far from anything, which
    // only gives it a margin. The canvas must come out identical.
    let scene = |extra: &str| {
        let json = format!(
            r##"{{"width": 96, "height": 64, "fps": 30, "durationInFrames": 1,
                "background": "#203040",
                "layers": [
                    {{"id": "disc", "type": "shape", "transform": {{"x": 10.5, "y": 8.25}},
                     "shape": {{"kind": "ellipse", "width": 50, "height": 40}}, "fill": "#f6c177",
                     "effects": [{{"type": "blur", "radius": 3}}]}}
                    {extra}]}}"##
        );
        Scene::from_json(&json, PathBuf::new()).unwrap()
    };
    let shadow = r##", {"id": "ghost", "type": "shape",
        "shape": {"kind": "rect", "width": 4, "height": 4}, "fill": "#fff",
        "effects": [{"type": "dropShadow", "x": 24, "blur": 8, "color": "#00000000"}]}"##;
    assert_eq!(scene("").margin(), 0);
    assert!(scene(shadow).margin() > 0);
    let plain = render_still(scene(""), 0).unwrap();
    let padded = render_still(scene(shadow), 0).unwrap();
    // The ghost layer is white on a dark background, so ignore its corner.
    // With a margin Vello draws the disc at a translated position, where f32
    // rounding of the edge can flip an MSAA sample; after the blur that is at
    // most one level. A canvas moved by even one pixel differs by tens.
    for (i, (a, b)) in plain.rgba.chunks(4).zip(padded.rgba.chunks(4)).enumerate() {
        let (x, y) = (i % 96, i / 96);
        if x < 4 && y < 4 {
            continue;
        }
        let close = a.iter().zip(b).all(|(p, q)| p.abs_diff(*q) <= 1);
        assert!(close, "pixel ({x}, {y}): {a:?} vs {b:?}");
    }
}
