//! A layer the GPU compositor draws for Skia (a fallback, `render/skia/draw.rs`) that blurs its backdrop sees what Skia
//! drew before it, as CSS's backdrop-filter sees everything painted before the element in its backdrop root, whichever
//! backend drew it. Both Skia backends: the GPU one, and the CPU one (`KINETOGRAPH_SKIA_CPU=1`), which is set for part of
//! the one test here, so nothing else in this binary reads the environment meanwhile.

use std::path::PathBuf;

use kinetograph_core::{Scene, render_still};

/// A white 400x100 canvas with a red box at x 0..200 that Skia draws, then `panel`: the green level along the middle
/// row (255 where white, 0 where fully red).
fn green_row(panel: &str) -> Vec<u8> {
    let json = format!(
        r##"{{"width": 400, "height": 100, "fps": 30, "durationInFrames": 1,
            "background": "#ffffff", "layers": [
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

/// The red edge at x = 200 is blurred: red spills right of it and white left of it, as much as when the GPU compositor
/// draws the box too (`reference`, the red box in the group).
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
    let worst = green
        .iter()
        .zip(reference)
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap();
    println!(
        "{what}: green at 190..=210 {:?}, reference {:?}, worst {worst}",
        &green[190..=210],
        &reference[190..=210]
    );
    assert!(worst <= 2, "{what}: {worst} levels from the reference");
}

/// The red box and the frosted panel both in a preserve3d group: the GPU compositor draws both.
fn reference() -> Vec<u8> {
    let json = format!(
        r##"{{"width": 400, "height": 100, "fps": 30, "durationInFrames": 1,
            "background": "#ffffff", "layers": [
              {{"id": "g", "type": "group", "preserve3d": true, "children": [
                {{"id": "red", "type": "shape", "fill": "#ff0000",
                  "shape": {{"kind": "rect", "width": 200, "height": 100}}}},
                {{"id": "panel", "type": "shape", "fill": "#ffffff00",
                  "shape": {{"kind": "rect", "width": 400, "height": 100}}, "effects": [{FROST}]}}]}}]}}"##
    );
    let frame = render_still(Scene::from_json(&json, PathBuf::new()).unwrap(), 0).unwrap();
    let row = 50 * frame.width as usize * 4;
    (0..frame.width as usize)
        .map(|x| frame.rgba[row + 4 * x + 1])
        .collect()
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
        let reference = reference();
        assert_frosted(
            &green_row(&in_preserve3d()),
            &reference,
            &format!("preserve3d group, cpu {cpu}"),
        );
        assert_frosted(
            &green_row(&with_gpu_effect()),
            &reference,
            &format!("GPU-only effect, cpu {cpu}"),
        );
    }
    unsafe { std::env::remove_var("KINETOGRAPH_SKIA_CPU") };
}
