//! Text and CSS features the papercut corpus uses (docs/DECISION_RENDERING_CRITICAL.md
//! §4): letter-spacing, white-space: pre, vertical-align, inline-blocks next to
//! text, `@font-face` and linked stylesheets from project files.

mod common;

use common::*;
use serde_json::{Value, json};

fn span_width(style: &str, content: &str) -> f64 {
    let root = el(
        "div",
        "$0",
        "font-family: 'DM Sans'; font-size: 20px",
        vec![el(
            "span",
            "$0.0",
            &format!("display: inline-block; {style}"),
            vec![text(content)],
        )],
    );
    bounds(&resolve(&request(root)), "$0.0").2
}

#[test]
fn letter_spacing_widens_text() {
    let plain = span_width("", "Hello world");
    let spaced = span_width("letter-spacing: 3px", "Hello world");
    // 11 characters, each followed by 3px (Chrome adds it after every character).
    assert!((spaced - plain - 33.0).abs() < 1.0, "{plain} {spaced}");
    let em = span_width("letter-spacing: 0.1em", "Hello world");
    assert!((em - plain - 22.0).abs() < 1.0, "{plain} {em}");
}

#[test]
fn white_space_pre_keeps_spaces_and_breaks() {
    let one = span_width("white-space: pre", "a b");
    let wide = span_width("white-space: pre", "a        b");
    let collapsed = span_width("", "a        b");
    assert!(wide > one + 30.0, "{one} {wide}");
    assert!((collapsed - one).abs() < 1.0, "{collapsed} {one}");

    let root = el(
        "div",
        "$0",
        "font-family: 'DM Sans'; font-size: 20px; line-height: 30px; white-space: pre",
        vec![text("one\n  two\nthree")],
    );
    let (_, _, _, h) = bounds(&resolve(&request(root)), "$0");
    assert_eq!(h, 90.0);
    let nowrap = el(
        "div",
        "$0",
        "width: 50px; font-family: 'DM Sans'; font-size: 20px; line-height: 30px; white-space: nowrap",
        vec![text("a long line that does not wrap")],
    );
    assert_eq!(bounds(&resolve(&request(nowrap)), "$0").3, 30.0);
}

#[test]
fn vertical_align_moves_inline_boxes() {
    let make = |align: &str| {
        let root = el(
            "div",
            "$0",
            "font-family: 'DM Sans'; font-size: 20px; line-height: 30px",
            vec![
                text("Text "),
                el(
                    "span",
                    "$0.1",
                    &format!(
                        "display: inline-block; width: 10px; height: 10px; vertical-align: {align}"
                    ),
                    vec![],
                ),
            ],
        );
        let island = resolve(&request(root));
        bounds(&island, "$0.1").1
    };
    let baseline = make("baseline");
    let top = make("top");
    let middle = make("middle");
    let bottom = make("bottom");
    assert!(top < middle && middle < bottom, "{top} {middle} {bottom}");
    assert!(baseline > top && baseline < bottom + 1.0, "{baseline}");
    assert_eq!(top, 0.0);
}

#[test]
fn inline_block_beside_text_shares_the_line() {
    let root = el(
        "div",
        "$0",
        "font-family: 'DM Sans'; font-size: 20px; line-height: 30px",
        vec![
            text("left "),
            el(
                "span",
                "$0.1",
                "display: inline-block; width: 40px; height: 20px",
                vec![text("")],
            ),
            text(" right"),
        ],
    );
    let island = resolve(&request(root));
    let (x, y, w, _) = bounds(&island, "$0.1");
    assert!(x > 20.0 && w == 40.0 && y < 30.0, "{x} {y}");
    assert_eq!(bounds(&island, "$0").3, 30.0);
}

#[test]
fn text_align_and_line_height() {
    let root = el(
        "div",
        "$0",
        "width: 300px; text-align: center; font-family: 'DM Sans'; font-size: 20px; line-height: 2",
        vec![el("span", "$0.0", "", vec![text("mid")])],
    );
    let island = resolve(&request(root));
    let (x, _, w, _) = bounds(&island, "$0.0");
    assert!((x + w / 2.0 - 150.0).abs() < 1.0, "{x} {w}");
    assert_eq!(bounds(&island, "$0").3, 40.0);
}

#[test]
fn uppercase_transform_changes_the_text() {
    let lower = span_width("", "hello");
    let upper = span_width("text-transform: uppercase", "hello");
    let typed = span_width("", "HELLO");
    assert!(upper > lower);
    assert!((upper - typed).abs() < 0.5);
}

#[test]
fn font_face_from_a_project_file() {
    let dm = span_width("", "Hamburgefonstiv");
    let mut req = request(el(
        "div",
        "$0",
        "",
        vec![el(
            "span",
            "$0.0",
            "display: inline-block; font-size: 20px; font-family: Brand",
            vec![text("Hamburgefonstiv")],
        )],
    ));
    // Not in `fonts`: only the stylesheet's @font-face names the file.
    req["fonts"] = json!({});
    req["baseDir"] = json!(manifest_dir().join("tests/fixtures"));
    req["stylesheets"] = json!([
        "@font-face { font-family: Brand; src: url(fonts/archivo-black-400-latin.woff2) format('woff2'); }"
    ]);
    let island = resolve(&req);
    let w = bounds(&island, "$0.0").2;
    assert!(w > 50.0 && (w - dm).abs() > 5.0, "{w} vs {dm}");
    assert!(island.missing.is_empty(), "{:?}", island.missing);
}

#[test]
fn linked_stylesheets_and_imports_load_from_project_files() {
    let dir = std::env::temp_dir().join(format!("kg-dom-test-css-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("a.css"), "@import url(b.css); .a { width: 33px }").unwrap();
    std::fs::write(dir.join("b.css"), ".b { height: 22px; display: block }").unwrap();
    let root: Value = el(
        "div",
        "$0",
        "",
        vec![
            el_attrs(
                "link",
                "$0.0",
                json!({ "rel": "stylesheet", "href": "a.css" }),
                "",
                vec![],
            ),
            el_attrs("div", "$0.1", json!({ "class": "a b" }), "", vec![]),
        ],
    );
    let mut req = request(root);
    req["baseDir"] = json!(dir);
    let island = resolve(&req);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(bounds(&island, "$0.1"), (0.0, 0.0, 33.0, 22.0));
}

#[test]
fn hidden_attribute_hides() {
    let root = el(
        "div",
        "$0",
        "",
        vec![el_attrs(
            "div",
            "$0.0",
            json!({ "hidden": "" }),
            "height: 10px",
            vec![],
        )],
    );
    let island = resolve(&request(root));
    assert_eq!(bounds(&island, "$0").3, 0.0);
}
