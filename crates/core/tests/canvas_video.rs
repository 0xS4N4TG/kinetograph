//! `drawImage` of a video frame (`{ "kind": "video" }`, what `onVideoFrame` hands a project): the canvas draws the picture
//! a video layer shows at that time (packages/cli/skills/kinetograph/references/SCENE.md, "canvas").
//!
//! Needs a GPU; the M4 runs it with the rest of `crates/core/tests/`.

use std::path::{Path, PathBuf};

use kinetograph_core::{Frame, Scene, render_still};

fn base() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests")
}

/// A 64 x 36 canvas layer that draws `clip.mp4` at `time` seconds (and `end`, when given).
fn draw(time: f64, end: Option<f64>) -> Frame {
    let end = end.map_or(String::new(), |e| format!(r#", "end": {e}"#));
    let json = format!(
        r##"{{"width": 64, "height": 36, "fps": 24, "durationInFrames": 1, "background": "#000000",
            "layers": [{{"id": "c", "type": "canvas", "width": 64, "height": 36, "commands":
              [{{"op": "image", "source": {{"kind": "video", "src": "scenes/media/clip.mp4", "time": {time}{end}}},
                 "dx": 0, "dy": 0, "dw": 64, "dh": 36}}]}}]}}"##
    );
    render_still(Scene::from_json(&json, base()).unwrap(), 0).unwrap()
}

#[test]
fn a_video_source_draws_the_frame_a_video_layer_shows() {
    // The video layer at scene frame 12 of 24 fps is 0.5 s into the file.
    let json = r##"{"width": 64, "height": 36, "fps": 24, "durationInFrames": 24, "background": "#000000",
        "layers": [{"id": "v", "type": "video", "src": "scenes/media/clip.mp4"}]}"##;
    let layer = render_still(Scene::from_json(json, base()).unwrap(), 12).unwrap();
    let canvas = draw(0.5, None);
    let worst = canvas
        .rgba
        .iter()
        .zip(&layer.rgba)
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap();
    assert!(
        worst <= 2,
        "the canvas's frame is the layer's (worst channel difference {worst})"
    );
    assert!(
        canvas.rgba != draw(1.5, None).rgba,
        "another time is another picture"
    );
    assert!(
        canvas.rgba.chunks(4).any(|p| p[..3] != [0, 0, 0]),
        "the frame is drawn"
    );
}

#[test]
fn a_time_past_the_end_shows_the_last_picture() {
    // The file is 2 s long: the last picture is the one at its last instant, as for a layer.
    assert!(draw(9.0, None).rgba == draw(1.99, None).rgba);
    // `end` is where a trimmed clip stops: past it the picture before it.
    assert!(draw(1.5, Some(1.0)).rgba == draw(0.99, None).rgba);
}
