//! State machine inputs set for a time, the file's description, and assets outside the file. The `.riv` files in
//! `tests/assets` other than `volume_bars.riv` are rive-app/rive-runtime's unit test files (MIT):
//! `state_machine_triggers.riv` (a trigger), `blend_test.riv` (number inputs of a blend state), `walle.riv` (two
//! pictures referenced by file name) and `hosted_font_file.riv` (a font on Rive's CDN).

use std::path::PathBuf;

use kinetograph_core as _;
use kinetograph_rive::{Alignment, AssetKind, Fit, Frame, InputChange, InputValue, Riv, Select};
use serde_json::Value;

fn asset(name: &str) -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/assets")
            .join(name),
    )
    .unwrap()
}

fn pictures() -> PathBuf {
    std::env::temp_dir().join("kinetograph-rive-tests")
}

fn play(time: f64, state_machine: Option<&str>, inputs: Vec<InputChange>) -> Frame {
    Frame {
        artboard: None,
        animation: None,
        state_machine: state_machine.map(|s| Select::Name(s.into())),
        time,
        width: 200.0,
        height: 200.0,
        fit: Fit::Contain,
        alignment: Alignment::default(),
        inputs,
    }
}

fn set(time: f64, name: &str, value: InputValue) -> InputChange {
    InputChange {
        time,
        name: name.into(),
        value,
    }
}

#[test]
fn the_description_lists_artboards_animations_state_machines_and_inputs() {
    let info = Riv::open(&asset("blend_test.riv")).unwrap().info();
    let board = &info["artboards"][0];
    assert_eq!(board["name"], "New Artboard");
    assert_eq!(board["width"].as_f64(), Some(767.0));
    let animations: Vec<&str> = board["animations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        animations,
        [
            "very long animation name",
            "rotate",
            "vertical",
            "horizontal"
        ]
    );
    let blend = &board["stateMachines"][1];
    assert_eq!(blend["name"], "blend");
    assert_eq!(blend["inputs"][0]["name"], "verticality");
    assert_eq!(blend["inputs"][0]["type"], "number");
    let triggers = Riv::open(&asset("state_machine_triggers.riv"))
        .unwrap()
        .info();
    assert_eq!(
        triggers["artboards"][0]["stateMachines"][0]["inputs"][0]["type"],
        "trigger"
    );
}

#[test]
fn a_number_input_changes_what_a_blend_state_draws() {
    let riv = Riv::open(&asset("blend_test.riv")).unwrap();
    let at = |value: f32| {
        riv.frame(
            &play(
                0.5,
                Some("blend"),
                vec![set(0.0, "verticality", InputValue::Number(value))],
            ),
            &pictures(),
        )
        .unwrap()
    };
    let defaults = riv
        .frame(&play(0.5, Some("blend"), vec![]), &pictures())
        .unwrap();
    assert_ne!(at(0.0), at(100.0));
    // The default is 66.6: setting it again draws the same.
    assert_eq!(at(66.62781), defaults);
    // A frame is a function of the inputs given for each time, whatever was played before.
    assert_eq!(at(0.0), at(0.0));
}

#[test]
fn an_input_takes_effect_from_its_time() {
    let riv = Riv::open(&asset("blend_test.riv")).unwrap();
    let late = vec![set(1.0, "verticality", InputValue::Number(0.0))];
    let before = riv
        .frame(&play(0.5, Some("blend"), late.clone()), &pictures())
        .unwrap();
    let defaults = riv
        .frame(&play(0.5, Some("blend"), vec![]), &pictures())
        .unwrap();
    assert_eq!(
        before, defaults,
        "a change after the frame's time does nothing yet"
    );
    let after = riv
        .frame(&play(1.5, Some("blend"), late), &pictures())
        .unwrap();
    assert_ne!(
        after,
        riv.frame(&play(1.5, Some("blend"), vec![]), &pictures())
            .unwrap()
    );
}

#[test]
fn a_trigger_fires_at_its_time() {
    let riv = Riv::open(&asset("state_machine_triggers.riv")).unwrap();
    let still = riv
        .frame(&play(1.0, Some("State Machine 1"), vec![]), &pictures())
        .unwrap();
    let fired = riv
        .frame(
            &play(
                1.0,
                Some("State Machine 1"),
                vec![set(0.2, "Trigger 1", InputValue::Fire)],
            ),
            &pictures(),
        )
        .unwrap();
    assert_ne!(still, fired);
}

#[test]
fn an_unknown_input_or_one_of_another_type_is_an_error_naming_it() {
    let riv = Riv::open(&asset("blend_test.riv")).unwrap();
    let wrong = |change| {
        riv.frame(&play(0.1, Some("blend"), vec![change]), &pictures())
            .unwrap_err()
            .to_string()
    };
    assert!(wrong(set(0.0, "nope", InputValue::Number(1.0))).contains("\"nope\""));
    assert!(wrong(set(0.0, "verticality", InputValue::Bool(true))).contains("boolean input"));
    // Inputs need a state machine.
    let message = Riv::open(&asset("volume_bars.riv"))
        .unwrap()
        .frame(
            &play(0.1, None, vec![set(0.0, "x", InputValue::Fire)]),
            &pictures(),
        )
        .unwrap_err()
        .to_string();
    assert!(message.contains("state machine"), "{message}");
}

fn images(commands: &[Value]) -> usize {
    commands.iter().filter(|c| c["op"] == "image").count()
}

/// A 2 x 2 PNG.
fn png() -> Vec<u8> {
    let mut out = Vec::new();
    let image = image::RgbaImage::from_pixel(2, 2, image::Rgba([255, 0, 0, 255]));
    image
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .unwrap();
    out
}

#[test]
fn referenced_pictures_are_drawn_when_given_and_listed_as_missing_when_not() {
    let bytes = asset("walle.riv");
    let bare = Riv::open(&bytes).unwrap();
    assert_eq!(bare.assets().len(), 2);
    assert!(
        bare.assets()
            .iter()
            .all(|a| a.missing() && a.kind == "image")
    );
    assert_eq!(bare.assets()[0].unique_filename, "walle-370.png");
    let without = bare.frame(&play(0.0, None, vec![]), &pictures()).unwrap();
    assert_eq!(images(&without), 0);

    let picture = png();
    let given = Riv::open_with(&bytes, &mut |request| {
        (request.unique_filename == "walle-370.png").then(|| picture.clone())
    })
    .unwrap();
    assert!(!given.assets()[0].missing() && given.assets()[1].missing());
    let with = given.frame(&play(0.0, None, vec![]), &pictures()).unwrap();
    assert_eq!(images(&with), 1);
}

#[test]
fn a_hosted_font_is_listed_with_its_cdn_id() {
    let riv = Riv::open(&asset("hosted_font_file.riv")).unwrap();
    let font = &riv.assets()[0];
    assert_eq!(font.kind, "font");
    assert!(!font.cdn_uuid.is_empty());
    assert!(font.missing());
    let dm_sans = std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../assets/fonts/DMSans-Medium.ttf"),
    )
    .unwrap();
    let given = Riv::open_with(&asset("hosted_font_file.riv"), &mut |r| {
        (r.kind == AssetKind::Font).then(|| dm_sans.clone())
    });
    assert!(!given.unwrap().assets()[0].missing());
}
