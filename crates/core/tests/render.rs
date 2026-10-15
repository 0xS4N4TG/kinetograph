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

#[test]
fn frames_drawn_from_the_layer_cache_are_the_frames_drawn_without_it() {
    let load = |name: &str| {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/scenes")
            .join(format!("{name}.json"));
        Scene::load(&path).unwrap()
    };
    // Frames repeated, so that every layer can come from the cache; in an
    // order that moves on and comes back, so that some do and some do not;
    // and far apart, so that what changed has changed a lot. The scenes cover
    // what the cache keys on: mattes, the camera and 3D placement, motion
    // blur, backdrop blur (never kept), seeded patterns that change with the
    // frame, a shader that reads it, displacement, masks and clips.
    let frames = [10, 10, 11, 12, 11, 10, 25, 25];
    for name in [
        "backdrop-blur",
        "camera",
        "clip-paths",
        "corner-pin",
        "dither",
        "dot-matrix",
        "grain",
        "halftone",
        "masks",
        "mattes",
        "mesh-gradient",
        "motion-blur",
        "shader",
        "shadows",
        "turbulence",
    ] {
        let mut cached = Renderer::new(load(name)).unwrap();
        cached.set_layer_cache(true);
        let mut plain = Renderer::new(load(name)).unwrap();
        for frame in frames {
            let a = cached.render_frame(frame).unwrap();
            let b = plain.render_frame(frame).unwrap();
            assert_eq!(a.rgba, b.rgba, "{name}, frame {frame}");
        }
        let (hits, misses) = cached.layer_cache_counts();
        assert!(
            hits > 0 && misses > 0,
            "{name}: {hits} hits, {misses} misses"
        );
        assert_eq!(plain.layer_cache_counts(), (0, 0), "{name}: cache is off");
    }
}

#[test]
fn turning_the_layer_cache_off_gives_back_what_it_kept() {
    let mut renderer = Renderer::new(example()).unwrap();
    // Off, a new renderer finds and keeps nothing.
    let plain = renderer.render_frame(20).unwrap();
    assert_eq!(renderer.layer_cache_counts(), (0, 0));
    renderer.set_layer_cache(true);
    let first = renderer.render_frame(20).unwrap();
    let again = renderer.render_frame(20).unwrap();
    // A plain leaf is cached from its third frame (`LayerCache::note`).
    let third = renderer.render_frame(20).unwrap();
    assert_eq!(third.rgba, plain.rgba);
    let (hits, misses) = renderer.layer_cache_counts();
    assert!(hits > 0 && misses > 0);
    assert_eq!((&first.rgba, &again.rgba), (&plain.rgba, &plain.rgba));
    // Off and on again, the first frame finds nothing.
    renderer.set_layer_cache(false);
    renderer.set_layer_cache(true);
    let (before, _) = renderer.layer_cache_counts();
    assert_eq!(renderer.render_frame(20).unwrap().rgba, plain.rgba);
    assert_eq!(renderer.layer_cache_counts().0, before);
}

/// A canvas with a card and a bar that are displaced and an empty layer whose
/// shadow reaches `pin` pixels, which makes `pin` the scene's margin (the
/// displacements reach under 10). `card` is the card's transform and shape.
/// With `displaced` false the displacements are zero, which draws without them.
fn displaced_json(card: serde_json::Value, pin: u32, displaced: bool) -> serde_json::Value {
    let scale = |scale: f64| if displaced { scale } else { 0.0 };
    let mut card = card;
    card["id"] = "card".into();
    card["type"] = "shape".into();
    card["fill"] = "#f2ead8".into();
    card["effects"] = serde_json::json!([{
        "type": "displace", "scale": scale(14.0),
        "turbulence": {"type": "fractalNoise", "baseFrequency": 0.045, "numOctaves": 3, "seed": 7}
    }]);
    serde_json::json!({
        "width": 160, "height": 120, "fps": 30, "durationInFrames": 1,
        "background": "#1b1e26",
        "layers": [
            card,
            // Hangs off the right edge, so the margin lets its far part in.
            {"id": "bar", "type": "shape", "transform": {"x": 140.5, "y": 60.25},
             "shape": {"kind": "rect", "width": 40, "height": 30}, "fill": "#f6c177",
             "effects": [{
                "type": "displace", "scale": scale(10.0), "xChannelSelector": "B",
                "yChannelSelector": "A",
                "turbulence": {"type": "turbulence", "baseFrequency": [0.03, 0.06],
                               "numOctaves": 2, "seed": 11}
             }]},
            {"id": "pin", "type": "group", "children": [],
             "effects": [{"type": "dropShadow", "x": pin, "blur": 0}]}
        ]
    })
}

fn scene_of(json: &serde_json::Value) -> Scene {
    Scene::from_json(&json.to_string(), PathBuf::new()).unwrap()
}

/// A group whose `matrix3d()` only slides the plane 60 px right but has
/// perspective in it (so the layer is warped, not folded into the 2D matrix),
/// holding a red bar at layer x `bar_x`.
fn slid_scene(bar_x: f64) -> Scene {
    scene_of(&serde_json::json!({
        "width": 200, "height": 100, "fps": 30, "durationInFrames": 1, "background": "#000000",
        "layers": [{
            "id": "slid", "type": "group",
            "transform": {"matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -0.001, 60, 0, 0, 1]},
            "children": [{
                "id": "bar", "type": "shape", "fill": "#ff0000",
                "shape": {"kind": "rect", "width": 40, "height": 100},
                "transform": {"x": bar_x}
            }]
        }]
    }))
}

#[test]
fn a_warped_layer_keeps_what_the_warp_brings_in_from_off_the_canvas() {
    // The bar is at x -50..-10 and the warp slides the plane 60 px right, so it
    // shows at 10..50. A flat texture the size of the canvas has nothing there.
    let frame = render_still(slid_scene(-50.0), 0).unwrap();
    let px = |x: usize, y: usize| {
        let i = (y * frame.width as usize + x) * 4;
        frame.rgba[i..i + 4].to_vec()
    };
    assert_eq!(px(30, 50), [255, 0, 0, 255], "inside the slid bar");
    assert_eq!(px(5, 50), [0, 0, 0, 255], "left of it");
    assert_eq!(px(60, 50), [0, 0, 0, 255], "right of it");
    // Layers that start on the canvas are as they were.
    let on = render_still(slid_scene(20.0), 0).unwrap();
    let i = (50 * on.width as usize + 100) * 4;
    assert_eq!(
        &on.rgba[i..i + 4],
        [255, 0, 0, 255],
        "bar at 20 shows at 80..120"
    );
}

#[test]
fn displace_gives_the_same_pixels_at_any_margin() {
    // The first card sits on whole pixels and is scaled by a power of two, so
    // Vello draws it exactly wherever the margin puts it and only the
    // displacement is left to differ. The second is turned and placed between
    // pixels, as the papercut port's cards are.
    let cards = [
        serde_json::json!({
            "transform": {"x": 37.0, "y": 15.0, "scale": 2.0},
            "shape": {"kind": "rect", "width": 20, "height": 64}
        }),
        serde_json::json!({
            "transform": {"x": 52.3, "y": 14.6, "anchorX": 20, "anchorY": 126,
                          "rotation": 7, "scale": 1.37},
            "shape": {"kind": "roundedRect", "width": 40, "height": 252, "radius": 8}
        }),
    ];
    for (i, card) in cards.into_iter().enumerate() {
        // The margins before and after a parity change, and a distant one.
        let pins = [40, 41, 64];
        for displaced in [false, true] {
            let frames: Vec<_> = pins
                .into_iter()
                .map(|pin| {
                    let scene = scene_of(&displaced_json(card.clone(), pin, displaced));
                    assert_eq!(scene.margin(), pin);
                    render_still(scene, 0).unwrap()
                })
                .collect();
            for (pin, frame) in pins.iter().zip(&frames).skip(1) {
                let differing = frame
                    .rgba
                    .chunks(4)
                    .zip(frames[0].rgba.chunks(4))
                    .filter(|(a, b)| a != b)
                    .count();
                // Without the displacement, a difference is Vello's or the
                // blend's, not the displacement's.
                assert_eq!(
                    differing, 0,
                    "card {i}, displaced {displaced}: {differing} pixels differ between margins {} and {pin}",
                    pins[0]
                );
            }
            if displaced {
                // The displacement did something.
                let plain = displaced_json(card.clone(), pins[0], false);
                let plain = render_still(scene_of(&plain), 0).unwrap();
                assert_ne!(plain.rgba, frames[0].rgba, "card {i}: nothing displaced");

                // The scene's own `margin`, with no layer to pin it, is the
                // same margin: the same pixels.
                let mut json = displaced_json(card.clone(), 0, true);
                json["layers"].as_array_mut().unwrap().pop();
                json["margin"] = pins[1].into();
                let scene = scene_of(&json);
                assert_eq!(scene.margin(), pins[1]);
                let explicit = render_still(scene, 0).unwrap();
                assert!(
                    explicit.rgba == frames[1].rgba,
                    "card {i}: an explicit margin differs"
                );
            }
        }
    }
}
