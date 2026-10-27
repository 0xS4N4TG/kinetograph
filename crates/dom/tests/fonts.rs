//! Font registration and matching: only registered files, matched by family
//! stack, weight and style as CSS font matching does.

mod common;

use common::*;
use serde_json::{Value, json};

const SAMPLE: &str = "Hamburgefonstiv Quickly";

/// The width of `SAMPLE` set in `style`, with `fonts` registered.
fn width(fonts: Value, style: &str) -> f64 {
    width_of(fonts, style, SAMPLE)
}

/// The width of `sample` set in `style`, with `fonts` registered.
fn width_of(fonts: Value, style: &str, sample: &str) -> f64 {
    let root = el(
        "div",
        "$0",
        "",
        vec![el(
            "span",
            "$0.0",
            &format!("display: inline-block; font-size: 40px; white-space: nowrap; {style}"),
            vec![text(sample)],
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
    // No fixed-pitch font registered: `monospace` is the bundled JetBrains
    // Mono (the same advance as the registered one at any weight), not a
    // proportional face.
    // Uneven letters tell a fixed-pitch face from a proportional one.
    let uneven = "iiiiiiiiWWWWWWWW";
    let mono = |style: &str| width_of(fonts.clone(), style, uneven);
    let reference = width_of(json!({ "X": jetbrains_mono() }), "font-family: X", uneven);
    assert_ne!(
        reference,
        width_of(fonts.clone(), "font-family: Archivo", uneven)
    );
    assert_eq!(mono("font-family: monospace"), reference);
    assert_eq!(mono("font-family: ui-monospace, monospace"), reference);
    assert_eq!(
        mono("font-family: Missing, monospace; font-weight: 800"),
        reference
    );
    // Other generic families are unchanged.
    assert_eq!(width(fonts, "font-family: cursive"), archivo);
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

/// The island painted with `fonts` registered.
fn painted(root: Value, fonts: Value) -> kinetograph_dom::request::IslandOutput {
    let mut req = request(root);
    req["fonts"] = fonts;
    let parsed = parse(&req);
    let island = kinetograph_dom::document::resolve(&parsed).expect("resolves");
    kinetograph_dom::paint::paint(&island.doc, &parsed)
}

fn fallback_only() -> Value {
    json!({ kinetograph_dom::fonts::FALLBACK_KEY: dm_sans() })
}

fn fallback_notes(
    out: &kinetograph_dom::request::IslandOutput,
) -> Vec<&kinetograph_dom::request::Unsupported> {
    out.unsupported
        .iter()
        .filter(|u| u.reason == kinetograph_dom::fonts::FALLBACK_REASON)
        .collect()
}

#[test]
fn html_text_with_no_loaded_font_is_drawn_in_the_fallback_and_reported() {
    let root = el(
        "div",
        "$0",
        "font-size: 40px; font-family: 'Helvetica Neue', Arial",
        vec![text("Hello")],
    );
    let out = painted(root.clone(), fallback_only());
    assert!(
        out.layers.iter().any(|l| l.to_string().contains("glyphs")),
        "{:?}",
        out.layers
    );
    let notes = fallback_notes(&out);
    assert_eq!(notes.len(), 1, "{:?}", out.unsupported);
    assert_eq!(notes[0].property.as_deref(), Some("font-family"));
    assert!(
        notes[0]
            .value
            .as_deref()
            .unwrap()
            .contains("Helvetica Neue")
    );

    // A project that registered a font is not told anything.
    let out = painted(root, json!({ "DM Sans": dm_sans() }));
    assert!(fallback_notes(&out).is_empty(), "{:?}", out.unsupported);
}

#[test]
fn svg_text_with_no_loaded_font_is_drawn_in_the_fallback_and_reported() {
    let label = el_attrs(
        "text",
        "$0.0.0",
        json!({ "x": "10", "y": "60", "font-size": "40", "font-family": "Helvetica Neue" }),
        "",
        vec![text("Hello")],
    );
    let svg = el_attrs(
        "svg",
        "$0.0",
        json!({ "width": "300", "height": "100", "viewBox": "0 0 300 100" }),
        "",
        vec![label],
    );
    let root = el("div", "$0", "", vec![svg]);
    let out = painted(root.clone(), fallback_only());
    let notes = fallback_notes(&out);
    assert_eq!(notes.len(), 1, "{:?}", out.unsupported);
    assert_eq!(notes[0].element, "text");
    assert_eq!(notes[0].value.as_deref(), Some("Helvetica Neue"));
    assert!(
        out.layers
            .iter()
            .any(|l| l.to_string().contains("\"type\":\"path\"") || l.to_string().contains("svg")),
        "{:?}",
        out.layers
    );

    let out = painted(root, json!({ "DM Sans": dm_sans() }));
    assert!(fallback_notes(&out).is_empty(), "{:?}", out.unsupported);
}

fn family_notes(out: &kinetograph_dom::request::IslandOutput) -> Vec<(String, String)> {
    out.unsupported
        .iter()
        .filter(|u| u.property.as_deref() == Some("font-family"))
        .map(|u| (u.value.clone().unwrap_or_default(), u.reason.clone()))
        .collect()
}

#[test]
fn text_whose_families_are_all_unloaded_is_drawn_and_reported_when_another_font_is_loaded() {
    let fonts = json!({ "DM Sans": dm_sans() });
    let one = |style: &str| {
        painted(
            el(
                "div",
                "$0",
                &format!("font-size: 40px; {style}"),
                vec![text("Hello")],
            ),
            fonts.clone(),
        )
    };
    let unloaded = kinetograph_dom::fonts::UNLOADED_REASON.to_string();

    // Drawn in the registered font (what fontique picks), and reported.
    let arial = one("font-family: Arial");
    let json = arial
        .layers
        .iter()
        .map(|l| l.to_string())
        .collect::<String>();
    assert!(json.contains("glyphs") && json.contains("DMSans"), "{json}");
    assert_eq!(
        family_notes(&arial),
        vec![("Arial".to_string(), unloaded.clone())]
    );

    // No font-family at all: the default serif names nothing loaded.
    let none = one("");
    assert_eq!(family_notes(&none).len(), 1, "{:?}", none.unsupported);
    assert_eq!(family_notes(&none)[0].1, unloaded);

    // Quoted names are the same family.
    assert!(family_notes(&one("font-family: \"DM Sans\"")).is_empty());
    assert!(family_notes(&one("font-family: 'DM Sans'")).is_empty());
    // A loaded family anywhere in the stack is enough.
    assert!(family_notes(&one("font-family: Arial, 'DM Sans', serif")).is_empty());
    assert!(family_notes(&one("font-family: 'dm sans'")).is_empty());
}

#[test]
fn svg_text_whose_families_are_all_unloaded_is_reported_when_another_font_is_loaded() {
    let fonts = json!({ "DM Sans": dm_sans() });
    let svg = |family: &str| {
        let label = el_attrs(
            "text",
            "$0.0.0",
            json!({ "x": "10", "y": "60", "font-size": "40", "font-family": family }),
            "",
            vec![text("Hello")],
        );
        let svg = el_attrs(
            "svg",
            "$0.0",
            json!({ "width": "300", "height": "100", "viewBox": "0 0 300 100" }),
            "",
            vec![label],
        );
        painted(el("div", "$0", "", vec![svg]), fonts.clone())
    };
    let helvetica = svg("Helvetica");
    assert_eq!(
        family_notes(&helvetica),
        vec![(
            "Helvetica".to_string(),
            kinetograph_dom::fonts::UNLOADED_REASON.to_string()
        )]
    );
    assert!(!helvetica.layers.is_empty());
    assert!(family_notes(&svg("DM Sans")).is_empty());
    assert!(family_notes(&svg("'DM Sans'")).is_empty());
    assert!(family_notes(&svg("\"DM Sans\", Arial")).is_empty());
}

/// An `<svg><text>` in a div that sets `div_style`; the text has `attrs`
/// besides its position. Two fonts are registered.
fn svg_text_layers(div_style: &str, attrs: Value) -> kinetograph_dom::request::IslandOutput {
    let mut a = json!({ "x": "10", "y": "60" });
    a.as_object_mut()
        .unwrap()
        .extend(attrs.as_object().unwrap().clone());
    let label = el_attrs("text", "$0.0.0", a, "", vec![text("Hello")]);
    let svg = el_attrs(
        "svg",
        "$0.0",
        json!({ "width": "300", "height": "100", "viewBox": "0 0 300 100" }),
        "",
        vec![label],
    );
    painted(
        el("div", "$0", div_style, vec![svg]),
        json!({ "DM Sans": dm_sans(), "Archivo": archivo_black() }),
    )
}

fn layers_json(out: &kinetograph_dom::request::IslandOutput) -> String {
    out.layers.iter().map(|l| l.to_string()).collect()
}

#[test]
fn svg_text_inherits_its_font_from_the_html_around_it() {
    let inherited = svg_text_layers("font-family: DM Sans; font-size: 40px", json!({}));
    let explicit = svg_text_layers("", json!({ "font-family": "DM Sans", "font-size": "40" }));
    let other = svg_text_layers("", json!({ "font-family": "Archivo", "font-size": "40" }));
    assert_ne!(layers_json(&explicit), layers_json(&other));
    assert_eq!(layers_json(&inherited), layers_json(&explicit));
    assert!(
        family_notes(&inherited).is_empty(),
        "{:?}",
        inherited.unsupported
    );

    // The text's own family still wins over the inherited one.
    let own = svg_text_layers(
        "font-family: DM Sans; font-size: 40px",
        json!({ "font-family": "Archivo" }),
    );
    assert_eq!(layers_json(&own), layers_json(&other));

    // Weight is inherited too.
    let w = svg_text_layers(
        "font-family: DM Sans; font-size: 40px; font-weight: 700",
        json!({}),
    );
    let w_explicit = svg_text_layers(
        "",
        json!({ "font-family": "DM Sans", "font-size": "40", "font-weight": "700" }),
    );
    assert_eq!(layers_json(&w), layers_json(&w_explicit));
}

// ---- characters the font lacks ----

fn glyph_notes(
    out: &kinetograph_dom::request::IslandOutput,
) -> Vec<&kinetograph_dom::request::Unsupported> {
    out.unsupported
        .iter()
        .filter(|u| u.reason.starts_with("no glyph for"))
        .collect()
}

fn all_layers(out: &kinetograph_dom::request::IslandOutput) -> String {
    out.layers.iter().map(|l| l.to_string()).collect()
}

#[test]
fn a_character_the_font_lacks_is_drawn_in_a_bundled_fallback_font() {
    let root = el(
        "div",
        "$0",
        "font-size: 40px; font-family: 'DM Sans'",
        vec![text("Germany \u{2192} Austria")],
    );
    let out = painted(root, json!({ "DM Sans": dm_sans() }));
    // The letters are in the project's file, the arrow in the bundled Noto Sans Math.
    let layers = all_layers(&out);
    assert!(layers.contains("builtin:NotoSansMath"), "{layers}");
    assert!(layers.contains("DMSans-Medium.ttf"), "{layers}");
    assert!(glyph_notes(&out).is_empty(), "{:?}", out.unsupported);

    // The built-in fallback font (no project font) falls back the same way.
    let root = el("div", "$0", "font-size: 40px", vec![text("A \u{2192} B")]);
    let out = painted(root, fallback_only());
    assert!(all_layers(&out).contains("builtin:NotoSansMath"));
    assert!(glyph_notes(&out).is_empty(), "{:?}", out.unsupported);
}

#[test]
fn a_character_no_font_has_is_reported_with_its_code_point_and_the_font_list() {
    // U+0378 is unassigned: no bundled font has it either.
    let root = el(
        "div",
        "$0",
        "font-size: 40px; font-family: 'DM Sans', sans-serif",
        vec![text("a\u{378}b")],
    );
    let out = painted(root, json!({ "DM Sans": dm_sans() }));
    let notes = glyph_notes(&out);
    assert_eq!(notes.len(), 1, "{:?}", out.unsupported);
    assert_eq!(notes[0].property.as_deref(), Some("font-family"));
    assert!(notes[0].reason.contains("U+0378"), "{}", notes[0].reason);
    assert!(notes[0].value.as_deref().unwrap().contains("DM Sans"));

    // Spaces and other characters that are not drawn are not gaps.
    let root = el(
        "div",
        "$0",
        "font-size: 40px; font-family: 'DM Sans'",
        vec![text("a\u{200B}b\u{FE0F} c")],
    );
    let out = painted(root, json!({ "DM Sans": dm_sans() }));
    assert!(glyph_notes(&out).is_empty(), "{:?}", out.unsupported);
}

#[test]
fn svg_text_falls_back_to_the_bundled_fonts() {
    let with = |s: &str| {
        let label = el_attrs(
            "text",
            "$0.0.0",
            json!({ "x": "10", "y": "60", "font-size": "40", "font-family": "DM Sans" }),
            "",
            vec![text(s)],
        );
        let svg = el_attrs(
            "svg",
            "$0.0",
            json!({ "width": "300", "height": "100", "viewBox": "0 0 300 100" }),
            "",
            vec![label],
        );
        painted(
            el("div", "$0", "", vec![svg]),
            json!({ "DM Sans": dm_sans() }),
        )
    };
    // U+0378 gets the missing-glyph box of the first font, U+2192 the arrow of a bundled one.
    assert_ne!(
        layers_json(&with("\u{2192}")),
        layers_json(&with("\u{378}"))
    );
}

/// `Hello` in an `<svg><text>` with the given `font-family`, `fonts` registered.
fn svg_text_in(family: &str, fonts: Value) -> String {
    let label = el_attrs(
        "text",
        "$0.0.0",
        json!({ "x": "10", "y": "60", "font-size": "40", "font-family": family }),
        "",
        vec![text("Hello")],
    );
    let svg = el_attrs(
        "svg",
        "$0.0",
        json!({ "width": "300", "height": "100", "viewBox": "0 0 300 100" }),
        "",
        vec![label],
    );
    layers_json(&painted(el("div", "$0", "", vec![svg]), fonts))
}

#[test]
fn svg_text_monospace_is_a_fixed_pitch_font_as_in_html() {
    // A registered fixed-pitch font is what `monospace` draws, as for HTML text.
    // (The SVG font database reads TrueType files, so unpack the WOFF2 fixture first.)
    let ttf = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("jetbrains-mono-700.ttf");
    let woff2 = std::fs::read(jetbrains_mono()).unwrap();
    std::fs::write(&ttf, blitz_dom::decode_font_bytes(&woff2).as_ref()).unwrap();
    let with_mono = json!({ "DM Sans": dm_sans(), "Code": ttf.to_string_lossy() });
    assert_eq!(
        svg_text_in("monospace", with_mono.clone()),
        svg_text_in("Code", with_mono)
    );
    // With none, it is the bundled JetBrains Mono, not the first registered font.
    let proportional = json!({ "DM Sans": dm_sans(), "Archivo": archivo_black() });
    let mono = svg_text_in("monospace", proportional.clone());
    assert_ne!(mono, svg_text_in("DM Sans", proportional.clone()));
    assert_ne!(mono, svg_text_in("Archivo", proportional));
}
