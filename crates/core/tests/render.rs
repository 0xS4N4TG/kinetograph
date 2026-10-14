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
