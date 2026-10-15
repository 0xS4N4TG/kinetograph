//! Font registration and matching: only registered files, matched by family
//! stack, weight and style as CSS font matching does.

mod common;

use common::*;
use serde_json::{Value, json};

const SAMPLE: &str = "Hamburgefonstiv Quickly";

/// The width of `SAMPLE` set in `style`, with `fonts` registered.
fn width(fonts: Value, style: &str) -> f64 {
    let root = el(
        "div",
        "$0",
        "",
        vec![el(
            "span",
            "$0.0",
            &format!("display: inline-block; font-size: 40px; white-space: nowrap; {style}"),
            vec![text(SAMPLE)],
        )],
    );
    let mut req = request(root);
    req["fonts"] = fonts;
    let island = resolve(&req);
    bounds(&island, "$0.0").2
}

/// The width of `SAMPLE` in a single font file registered as `X`.
fn reference(file: &str) -> f64 {
    width(json!({ "X": file }), "font-family: X")
}

#[test]
fn the_reference_fonts_differ() {
    let dm = reference(&dm_sans());
    let archivo = reference(&archivo_black());
    assert!(dm > 100.0 && archivo > 100.0);
    assert!((dm - archivo).abs() > 20.0, "{dm} {archivo}");
}

#[test]
fn weight_matching_follows_css() {
    let dm = reference(&dm_sans());
    let heavy = reference(&archivo_black());
    let fonts = json!({ "Test": dm_sans(), "Test:800": archivo_black() });
    let at = |weight: u32| {
        width(
            fonts.clone(),
            &format!("font-family: Test; font-weight: {weight}"),
        )
    };
    // Exact.
    assert_eq!(at(400), dm);
    assert_eq!(at(800), heavy);
    // 700 and 900: heavier first, then lighter -> 800.
    assert_eq!(at(700), heavy);
    assert_eq!(at(900), heavy);
    // 500 looks at 400 first (up to 500), 300 goes lighter then heavier -> 400.
    assert_eq!(at(500), dm);
    assert_eq!(at(300), dm);
    // Keywords.
    assert_eq!(
        width(fonts.clone(), "font-family: Test; font-weight: bold"),
        heavy
    );
    assert_eq!(width(fonts, "font-family: Test"), dm);
}

#[test]
fn only_one_weight_registered_serves_every_weight() {
    // The papercut case: a family is registered at one weight and the project
    // asks for others. The face is the only one, so it serves them all.
    let archivo = reference(&archivo_black());
    let fonts = json!({ "Archivo:800": archivo_black() });
    for weight in [100, 400, 700, 800, 900] {
        let w = width(
            fonts.clone(),
            &format!("font-family: Archivo; font-weight: {weight}"),
        );
        // Synthetic bold widens the glyphs a little for the heavy requests.
        assert!(
            (w - archivo).abs() < 0.03 * archivo,
            "weight {weight}: {w} vs {archivo}"
        );
    }
}

#[test]
fn a_variable_font_stays_at_its_registered_weight() {
    // inter-800-latin.woff2 is a variable font (wght 100 to 900, default 400),
    // as Google serves it for one weight. A browser holds it at the @font-face
    // weight, so the papercut's 400 and 900 text is drawn at 800.
    let at_400 = width(json!({ "Inter": inter_800() }), "font-family: Inter");
    let at_800 = width(
        json!({ "Inter:800": inter_800() }),
        "font-family: Inter; font-weight: 800",
    );
    assert!(
        (at_800 - at_400).abs() > 10.0,
        "800 instance {at_800} vs 400 instance {at_400}"
    );
    for weight in [100, 300, 400, 600, 800, 900] {
        let w = width(
            json!({ "Inter:800": inter_800() }),
            &format!("font-family: Inter; font-weight: {weight}"),
        );
        // Faux bold adds nothing to the advance: the same width at every weight.
        assert_eq!(w, at_800, "weight {weight}");
    }
    // Registered at 400, the same file is the 400 instance for every request.
    let w = width(
        json!({ "Inter": inter_800() }),
        "font-family: Inter; font-weight: 800",
    );
    assert_eq!(w, at_400);
}

#[test]
fn style_matching() {
    let dm = reference(&dm_sans());
    let archivo = reference(&archivo_black());
    let fonts = json!({ "Test": dm_sans(), "Test:400i": archivo_black() });
    assert_eq!(width(fonts.clone(), "font-family: Test"), dm);
    assert_eq!(
        width(fonts.clone(), "font-family: Test; font-style: italic"),
        archivo
    );
}

#[test]
fn family_stack_and_names() {
    let dm = reference(&dm_sans());
    let archivo = reference(&archivo_black());
    let fonts = json!({ "DM Sans": dm_sans(), "Archivo:800": archivo_black() });
    // The first family of the stack that is registered wins.
    assert_eq!(
        width(
            fonts.clone(),
            "font-family: Missing, 'Archivo', 'DM Sans'; font-weight: 800"
        ),
        archivo
    );
    assert_eq!(
        width(fonts.clone(), "font-family: Missing, 'DM Sans', Archivo"),
        dm
    );
    // Family names are case-insensitive, quoted or not.
    assert_eq!(width(fonts.clone(), "font-family: dm sans"), dm);
    assert_eq!(
        width(fonts.clone(), "font-family: \"ARCHIVO\"; font-weight: 800"),
        archivo
    );
    // A generic family, or a stack of nothing registered, falls back to a
    // registered font (the first key), never to a system font.
    // Here that is "Archivo:800", first in key order.
    assert_eq!(width(fonts.clone(), "font-family: sans-serif"), archivo);
    assert_eq!(
        width(
            fonts.clone(),
            "font-family: Helvetica Neue, Arial, sans-serif"
        ),
        archivo
    );
    assert_eq!(width(fonts, "font-family: monospace"), archivo);
}

#[test]
fn monospace_falls_back_to_a_fixed_pitch_font() {
    let dm = reference(&dm_sans());
    let mono = reference(&jetbrains_mono());
    // JetBrains Mono sorts before... after "DM Sans" ("J" > "D"); generic
    // families still prefer the proportional font, and `monospace` the fixed one.
    let fonts = json!({ "DM Sans": dm_sans(), "JetBrains Mono": jetbrains_mono() });
    assert_eq!(width(fonts.clone(), "font-family: sans-serif"), dm);
    assert_eq!(width(fonts.clone(), "font-family: Nope, serif"), dm);
    assert_eq!(width(fonts.clone(), "font-family: monospace"), mono);
    assert_eq!(
        width(fonts.clone(), "font-family: ui-monospace, monospace"),
        mono
    );
    // With only a mono font registered everything is mono.
    let only = json!({ "JetBrains Mono": jetbrains_mono() });
    assert_eq!(width(only, "font-family: sans-serif"), mono);
    // <code> and <pre> use `monospace` in the UA stylesheet.
    let root = el(
        "div",
        "$0",
        "font-size: 40px",
        vec![el(
            "code",
            "$0.0",
            "display: inline-block",
            vec![text(SAMPLE)],
        )],
    );
    let mut req = request(root);
    req["fonts"] = fonts;
    let island = resolve(&req);
    let code = bounds(&island, "$0.0").2;
    // Gecko's 13px monospace default does not apply: font-size is 40px as set.
    assert!((code - mono).abs() < 1.0, "{code} vs {mono}");
}

#[test]
fn woff2_files_are_unpacked() {
    // inter-800-latin.woff2 and the ttf both give text a width.
    assert!(reference(&inter_800()) > 100.0);
    assert!(reference(&jetbrains_mono()) > 100.0);
    // Monospace: SAMPLE has 23 characters, each 0.6em wide at 40px.
    let w = reference(&jetbrains_mono());
    assert!((w - 23.0 * 24.0).abs() < 1.0, "{w}");
}

#[test]
fn no_fonts_registered_still_resolves() {
    let w = width(json!({}), "font-family: X");
    assert!(w >= 0.0);
}

#[test]
fn a_bad_font_file_is_an_error() {
    let mut req = request(el("div", "$0", "", vec![]));
    req["fonts"] = json!({ "Broken": "/nonexistent/font.ttf" });
    assert!(kinetograph_dom::document::resolve(&parse(&req)).is_err());
}
