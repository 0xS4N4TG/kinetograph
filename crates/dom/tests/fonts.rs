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
    let at = |weight: u32| width(fonts.clone(), &format!("font-family: Test; font-weight: {weight}"));
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
    assert_eq!(width(fonts.clone(), "font-family: Test; font-weight: bold"), heavy);
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
        assert!((w - archivo).abs() < 0.03 * archivo, "weight {weight}: {w} vs {archivo}");
    }
}

#[test]
fn style_matching() {
    let dm = reference(&dm_sans());
    let archivo = reference(&archivo_black());
    let fonts = json!({ "Test": dm_sans(), "Test:400i": archivo_black() });
    assert_eq!(width(fonts.clone(), "font-family: Test"), dm);
    assert_eq!(width(fonts.clone(), "font-family: Test; font-style: italic"), archivo);
}

#[test]
fn family_stack_and_names() {
    let dm = reference(&dm_sans());
    let archivo = reference(&archivo_black());
    let fonts = json!({ "DM Sans": dm_sans(), "Archivo:800": archivo_black() });
    // The first family of the stack that is registered wins.
    assert_eq!(width(fonts.clone(), "font-family: Missing, 'Archivo', 'DM Sans'; font-weight: 800"), archivo);
    assert_eq!(width(fonts.clone(), "font-family: Missing, 'DM Sans', Archivo"), dm);
    // Family names are case-insensitive, quoted or not.
    assert_eq!(width(fonts.clone(), "font-family: dm sans"), dm);
    assert_eq!(width(fonts.clone(), "font-family: \"ARCHIVO\"; font-weight: 800"), archivo);
    // A generic family, or a stack of nothing registered, falls back to a
    // registered font (the first key), never to a system font.
    // Here that is "Archivo:800", first in key order.
    assert_eq!(width(fonts.clone(), "font-family: sans-serif"), archivo);
    assert_eq!(width(fonts.clone(), "font-family: Helvetica Neue, Arial, sans-serif"), archivo);
    assert_eq!(width(fonts, "font-family: monospace"), archivo);
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
