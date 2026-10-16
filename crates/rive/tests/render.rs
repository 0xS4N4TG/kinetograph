//! A Rive file played to the commands of a canvas layer, and what those leave
//! in the pixels. `assets/volume_bars.riv` is from the MIT-licensed
//! rive-app/rive-runtime repository (renderer/webgpu_player/rivs): a 96 x 47
//! artboard of three dark bars whose heights animate.

use std::path::PathBuf;

use kinetograph_core::{Frame, Scene, render_still};
use kinetograph_rive::{Alignment, Fit, Frame as Play, Riv, Select};
use serde_json::Value;

const SIZE: u32 = 200;

fn asset() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/assets/volume_bars.riv")
}

fn pictures() -> PathBuf {
    std::env::temp_dir().join("kinetograph-rive-tests")
}

fn play(time: f64) -> Play {
    Play {
        artboard: None,
        animation: None,
        state_machine: None,
        time,
        width: SIZE as f32,
        height: SIZE as f32,
        fit: Fit::Contain,
        alignment: Alignment::default(),
    }
}

fn commands(frame: &Play) -> Vec<Value> {
    let riv = Riv::open(&std::fs::read(asset()).unwrap()).unwrap();
    riv.frame(frame, &pictures()).unwrap()
}

/// The commands drawn on a white 200 x 200 scene.
fn render(commands: &[Value]) -> Frame {
    let json = serde_json::json!({
        "width": SIZE, "height": SIZE, "fps": 30, "durationInFrames": 1, "background": "#ffffff",
        "layers": [{ "id": "rive", "type": "canvas", "width": SIZE, "height": SIZE, "commands": commands }],
    });
    render_still(Scene::from_json(&json.to_string(), PathBuf::new()).unwrap(), 0).unwrap()
}

fn px(frame: &Frame, x: usize, y: usize) -> [u8; 4] {
    let i = (y * frame.width as usize + x) * 4;
    frame.rgba[i..i + 4].try_into().unwrap()
}

fn is_dark(pixel: [u8; 4]) -> bool {
    // The bars are #232323 over white.
    pixel[..3].iter().all(|&c| (i32::from(c) - 35).abs() <= 2)
}

fn is_white(pixel: [u8; 4]) -> bool {
    pixel[..3].iter().all(|&c| c >= 253)
}

#[test]
fn the_bars_follow_the_time() {
    let start = render(&commands(&play(0.0)));
    let later = render(&commands(&play(0.5)));
    // The right bar is 4 pixels tall at the start (around y = 140) and 74 at
    // 0.5 s (y = 68 to 142); the middle bar is 51 tall at both.
    assert!(is_white(px(&start, 152, 100)), "{:?}", px(&start, 152, 100));
    assert!(is_dark(px(&later, 152, 100)), "{:?}", px(&later, 152, 100));
    assert!(is_dark(px(&start, 100, 117)) && is_dark(px(&later, 100, 117)));
    // Above the artboard there is nothing to draw.
    assert!(is_white(px(&later, 100, 20)));
}

#[test]
fn a_frame_does_not_depend_on_the_frames_played_before_it() {
    let riv = Riv::open(&std::fs::read(asset()).unwrap()).unwrap();
    let fresh = riv.frame(&play(0.5), &pictures()).unwrap();
    riv.frame(&play(1.0), &pictures()).unwrap();
    riv.frame(&play(0.2), &pictures()).unwrap();
    assert_eq!(riv.frame(&play(0.5), &pictures()).unwrap(), fresh);
}

#[test]
fn fit_and_alignment_place_the_artboard() {
    // The artboard is twice as wide as tall, so `contain` in a square leaves the
    // top and bottom free; `cover` fills the height and cuts the sides.
    let top_left = |fit, alignment| {
        let mut play = play(0.0);
        play.fit = fit;
        play.alignment = alignment;
        render(&commands(&play))
    };
    // The artboard's clip is the first command: its matrix is the fit.
    let matrix = |fit, alignment| {
        let mut play = play(0.0);
        play.fit = fit;
        play.alignment = alignment;
        commands(&play)[0]["m"].clone()
    };
    let contain = matrix(Fit::Contain, Alignment { x: 0.0, y: 0.0 });
    let high = matrix(Fit::Contain, Alignment { x: 0.0, y: -1.0 });
    let cover = matrix(Fit::Cover, Alignment { x: 0.0, y: 0.0 });
    let number = |m: &Value, i: usize| m[i].as_f64().unwrap();
    assert!((number(&contain, 0) - 200.0 / 96.703125).abs() < 1e-3);
    assert!((number(&contain, 5) - (200.0 - 47.20703 * number(&contain, 3)) / 2.0).abs() < 1e-3);
    assert_eq!(number(&high, 5), 0.0);
    assert!((number(&cover, 0) - 200.0 / 47.20703).abs() < 1e-3);
    // And the bars it draws stay inside the canvas box either way.
    assert!(is_white(px(&top_left(Fit::Contain, Alignment { x: 0.0, y: -1.0 }), 100, 190)));
}

#[test]
fn a_missing_artboard_or_animation_is_an_error_naming_it() {
    let riv = Riv::open(&std::fs::read(asset()).unwrap()).unwrap();
    let mut wanted = play(0.0);
    wanted.artboard = Some(Select::Name("nope".into()));
    let message = riv.frame(&wanted, &pictures()).unwrap_err().to_string();
    assert!(message.contains("artboard") && message.contains("nope"), "{message}");

    let mut wanted = play(0.0);
    wanted.animation = Some(Select::Index(9));
    let message = riv.frame(&wanted, &pictures()).unwrap_err().to_string();
    assert!(message.contains("animation") && message.contains('9'), "{message}");
}

#[test]
fn something_that_is_not_a_rive_file_is_an_error() {
    assert!(Riv::open(b"not a rive file").is_err());
}
