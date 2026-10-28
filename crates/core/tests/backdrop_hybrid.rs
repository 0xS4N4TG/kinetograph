//! A layer the GPU compositor draws for Skia (a fallback, `render/skia/draw.rs`) that blurs its backdrop sees what Skia
//! drew before it, as CSS's backdrop-filter sees everything painted before the element in its backdrop root, whichever
//! backend drew it. Both Skia backends: the GPU one, and the CPU one (`KINETOGRAPH_SKIA_CPU=1`), which is set for part of
//! the one test here, so nothing else in this binary reads the environment meanwhile. The same test checks that a frame
//! with such a layer is the same bytes alone, in sequence and from four renderers at once.

use std::path::PathBuf;

use kinetograph_core::{Frame, Renderer, Scene, render_still};

/// A white 400x100 canvas with a red box at x 0..200 that Skia draws, then `panel`, composited in `space` ("linear" or
/// "srgb"): the green level along the middle row (255 where white, 0 where fully red).
fn green_row(panel: &str, space: &str) -> Vec<u8> {
    let json = format!(
        r##"{{"width": 400, "height": 100, "fps": 30, "durationInFrames": 1,
            "background": "#ffffff", "blendSpace": "{space}", "layers": [
              {{"id": "red", "type": "shape", "fill": "#ff0000",
                "shape": {{"kind": "rect", "width": 200, "height": 100}}}},
              {panel}]}}"##
    );
    let frame = render_still(Scene::from_json(&json, PathBuf::new()).unwrap(), 0).unwrap();
    let row = 50 * frame.width as usize * 4;
    (0..frame.width as usize)
        .map(|x| frame.rgba[row + 4 * x + 1])
        .collect()
}

const FROST: &str = r##"{"type": "backdropBlur", "radius": 20}"##;

/// The panel in a preserve3d group, which the GPU compositor draws; the red box is outside the group.
fn in_preserve3d() -> String {
    format!(
        r##"{{"id": "g", "type": "group", "preserve3d": true, "children": [
              {{"id": "panel", "type": "shape", "fill": "#ffffff00",
                "shape": {{"kind": "rect", "width": 400, "height": 100}}, "effects": [{FROST}]}}]}}"##
    )
}

/// The panel on its own, with an effect only the GPU compositor draws after its frost.
fn with_gpu_effect() -> String {
    format!(
        r##"{{"id": "panel", "type": "shape", "fill": "#ffffff00",
              "shape": {{"kind": "rect", "width": 400, "height": 100}},
              "effects": [{FROST}, {{"type": "chromaticAberration", "amount": 1}}]}}"##
    )
}

/// How far from the canvas's left and right edges the rows are compared.
const EDGE: usize = 50;

/// The red edge at x = 200 is blurred: red spills right of it and white left of it, as it does when Skia frosts the
/// panel itself (`reference`).
fn assert_frosted(green: &[u8], reference: &[u8], what: &str) {
    assert!(
        green[205] < 230,
        "{what}: green {} at 205, no red frost right of the edge",
        green[205]
    );
    assert!(
        green[195] > 30,
        "{what}: green {} at 195, no white frost left of the edge",
        green[195]
    );
    // Away from the canvas's edges, where the backends blur what lies past it a little differently.
    let (at, worst) = (EDGE..green.len() - EDGE)
        .map(|x| (x, green[x].abs_diff(reference[x])))
        .max_by_key(|&(_, d)| d)
        .unwrap();
    println!(
        "{what}: green at 190..=210 {:?}, reference {:?}, worst {worst} at x {at}",
        &green[190..=210],
        &reference[190..=210]
    );
    assert!(worst <= 4, "{what}: {worst} levels from the reference");
}

/// The panel alone, which Skia draws and frosts itself.
fn drawn_by_skia() -> String {
    format!(
        r##"{{"id": "panel", "type": "shape", "fill": "#ffffff00",
              "shape": {{"kind": "rect", "width": 400, "height": 100}}, "effects": [{FROST}]}}"##
    )
}

/// The red box drawn again in the preserve3d group, under the panel: the backdrop is Skia's canvas under the group's.
fn over_both() -> String {
    format!(
        r##"{{"id": "g", "type": "group", "preserve3d": true, "children": [
              {{"id": "red2", "type": "shape", "fill": "#ff0000",
                "shape": {{"kind": "rect", "width": 200, "height": 100}}}},
              {{"id": "panel", "type": "shape", "fill": "#ffffff00",
                "shape": {{"kind": "rect", "width": 400, "height": 100}}, "effects": [{FROST}]}}]}}"##
    )
}

/// The repro, eight frames long, its frosted panel moving across the red edge in a preserve3d group.
fn moving() -> Scene {
    let json = r##"{"width": 400, "height": 200, "fps": 30, "durationInFrames": 8, "background": "#ffffff",
        "blendSpace": "srgb", "layers": [
          {"id": "red", "type": "shape", "fill": "#ff0000", "shape": {"kind": "rect", "width": 200, "height": 200}},
          {"id": "g", "type": "group", "preserve3d": true, "children": [
            {"id": "panel", "type": "shape", "fill": "#ffffff33",
              "transform": {"x": [{"frame": 0, "value": 60}, {"frame": 7, "value": 140}], "y": 50},
              "shape": {"kind": "rect", "width": 200, "height": 100},
              "effects": [{"type": "backdropBlur", "radius": 12}]}]}]}"##;
    Scene::from_json(json, PathBuf::new()).unwrap()
}

/// `frames` drawn one after another on one renderer with the layer cache on, one frame in flight, as a video render
/// draws them.
fn in_sequence(scene: &Scene, frames: &[u32]) -> Vec<Frame> {
    let mut renderer = Renderer::new(scene.clone()).unwrap();
    renderer.set_layer_cache(true);
    let mut out = Vec::new();
    let mut in_flight = None;
    for &frame in frames {
        let pending = renderer.start_frame(frame).unwrap();
        if let Some(previous) = in_flight.replace(pending) {
            out.push(renderer.finish_frame(previous).unwrap());
        }
    }
    out.push(renderer.finish_frame(in_flight.unwrap()).unwrap());
    out
}

/// A frame is the same bytes drawn alone, after the frames before it, or by one of four renderers at once (as
/// `render --concurrency 4` draws), each taking every fourth frame.
fn assert_pure(what: &str) {
    let scene = moving();
    let frames: Vec<u32> = (0..8).collect();
    let alone: Vec<Frame> = frames
        .iter()
        .map(|&f| render_still(scene.clone(), f).unwrap())
        .collect();
    let sequence = in_sequence(&scene, &frames);
    let mut parallel: Vec<Option<Frame>> = (0..frames.len()).map(|_| None).collect();
    std::thread::scope(|s| {
        let workers: Vec<_> = (0..4u32)
            .map(|k| {
                let scene = scene.clone();
                s.spawn(move || {
                    let mine: Vec<u32> = (k..8).step_by(4).collect();
                    mine.iter()
                        .copied()
                        .zip(in_sequence(&scene, &mine))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        for w in workers {
            for (f, frame) in w.join().unwrap() {
                parallel[f as usize] = Some(frame);
            }
        }
    });
    for (i, a) in alone.iter().enumerate() {
        assert!(
            a.rgba == sequence[i].rgba,
            "{what}: frame {i} in sequence differs from it alone"
        );
        let p = parallel[i].as_ref().unwrap();
        assert!(
            a.rgba == p.rgba,
            "{what}: frame {i} from four renderers differs from it alone"
        );
    }
    // The panel moves, so the frames differ: the comparison is not of one picture.
    assert!(
        alone[0].rgba != alone[7].rgba,
        "{what}: the panel does not move"
    );
}

#[test]
fn a_gpu_drawn_layer_blurs_the_backdrop_skia_drew() {
    for cpu in [false, true] {
        // SAFETY: the only test in this binary.
        unsafe {
            if cpu {
                std::env::set_var("KINETOGRAPH_SKIA_CPU", "1");
            } else {
                std::env::remove_var("KINETOGRAPH_SKIA_CPU");
            }
        }
        // In sRGB the GPU compositor blurs the sRGB-encoded backdrop, as Skia and CSS do.
        for space in ["linear", "srgb"] {
            let reference = green_row(&drawn_by_skia(), space);
            for (panel, what) in [
                (in_preserve3d(), "preserve3d group"),
                (with_gpu_effect(), "GPU-only effect"),
                (over_both(), "red in and out of the group"),
            ] {
                assert_frosted(
                    &green_row(&panel, space),
                    &reference,
                    &format!("{what}, {space}, cpu {cpu}"),
                );
            }
        }
        assert_pure(&format!("cpu {cpu}"));
    }
    unsafe { std::env::remove_var("KINETOGRAPH_SKIA_CPU") };
}
