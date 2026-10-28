use std::path::PathBuf;

use kinetograph_core::{Scene, render_still};

/// A 200 x 120 box at (-50, -30) on a 100 x 60 canvas, so 50 pixels of it hang off each side: blue, with its left 50
/// pixels (all off the canvas) red. The CRT warp at full curvature reads the box further out than it draws.
fn overhanging(effects: &str) -> String {
    format!(
        r##"{{"width": 100, "height": 60, "fps": 30, "durationInFrames": 1, "background": "#000000",
            "layers": [{{"id": "g", "type": "group", "transform": {{"x": -50, "y": -30}},
                "children": [
                    {{"id": "blue", "type": "shape", "fill": "#0000ff", "shape": {{"kind": "rect", "width": 200, "height": 120}}}},
                    {{"id": "red", "type": "shape", "fill": "#ff0000", "shape": {{"kind": "rect", "width": 50, "height": 120}}}}
                ],
                "effects": [{{"type": "colorGrade", "box": [0, 0, 200, 120], "effects": {effects}}}]}}]}}"##
    )
}

#[test]
fn crt_warp_reads_the_part_of_the_box_off_the_canvas() {
    let scene = Scene::from_json(&overhanging(r#"{"crtCurvature": 1}"#), PathBuf::new()).unwrap();
    // The warp moves a point by up to half the box's larger side: the 50 pixels past the canvas are kept.
    assert!(scene.margin() >= 50, "margin {}", scene.margin());
    let frame = render_still(scene, 0).unwrap();
    let px = |x: usize, y: usize| {
        let i = (y * frame.width as usize + x) * 4;
        [frame.rgba[i], frame.rgba[i + 1], frame.rgba[i + 2]]
    };
    // The left edge of the canvas, half way down, shows the red stripe the warp pulls in from off the canvas (box x
    // 45.8), as a browser that has the whole box does; the middle stays blue.
    let [r, g, b] = px(1, 30);
    assert!(r > 200 && g < 30 && b < 30, "edge pixel {:?}", [r, g, b]);
    let [r, _, b] = px(50, 30);
    assert!(b > 200 && r < 30, "middle pixel {:?}", [r, b]);
}

#[test]
fn without_the_warp_the_box_off_the_canvas_is_not_drawn() {
    let frame = render_still(
        Scene::from_json(&overhanging(r#"{"crtCurvature": 0}"#), PathBuf::new()).unwrap(),
        0,
    )
    .unwrap();
    let i = (30 * frame.width as usize + 1) * 4;
    assert_eq!(&frame.rgba[i..i + 3], &[0, 0, 255]);
}
