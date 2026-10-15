//! Elements Remotion projects may put in the tree, including ones the painter
//! cannot draw: they must lay out (or not) without taking the process down.

mod common;

use common::*;
use serde_json::json;

#[test]
fn every_html_element_lays_out() {
    let tags = [
        "div",
        "span",
        "p",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "a",
        "b",
        "i",
        "em",
        "strong",
        "small",
        "u",
        "s",
        "sub",
        "sup",
        "code",
        "pre",
        "kbd",
        "samp",
        "mark",
        "blockquote",
        "ul",
        "ol",
        "li",
        "dl",
        "dt",
        "dd",
        "table",
        "thead",
        "tbody",
        "tfoot",
        "tr",
        "td",
        "th",
        "caption",
        "colgroup",
        "col",
        "figure",
        "figcaption",
        "section",
        "article",
        "header",
        "footer",
        "nav",
        "main",
        "aside",
        "hr",
        "br",
        "wbr",
        "img",
        "video",
        "audio",
        "source",
        "canvas",
        "iframe",
        "object",
        "embed",
        "input",
        "textarea",
        "select",
        "option",
        "button",
        "label",
        "form",
        "fieldset",
        "legend",
        "details",
        "summary",
        "dialog",
        "template",
        "slot",
        "noscript",
        "picture",
        "map",
        "area",
        "progress",
        "meter",
        "output",
        "ruby",
        "rt",
        "svg",
        "math",
        "center",
        "font",
        "marquee",
        "unknown-element",
    ];
    for tag in tags {
        let root = el(
            "div",
            "$0",
            "",
            vec![el_attrs(
                tag,
                "$0.0",
                json!({ "src": "nope.png", "href": "x", "type": "text", "value": "v" }),
                "width: 50px; height: 20px",
                vec![
                    text("content"),
                    el("span", "$0.0.0", "", vec![text("inner")]),
                ],
            )],
        );
        let island = resolve(&request(root));
        // A box or not, but a number that makes sense.
        let (_, _, w, h) = island
            .doc
            .get_client_bounding_rect(island.node("$0.0").unwrap())
            .map(|r| (r.x, r.y, r.width, r.height))
            .unwrap_or_default();
        assert!(
            w.is_finite() && h.is_finite() && w >= 0.0 && h >= 0.0,
            "<{tag}>"
        );
    }
}

#[test]
fn deep_trees_and_empty_islands() {
    let mut node = el("div", "$0.99", "width: 10px; height: 10px", vec![]);
    for depth in (0..99).rev() {
        node = el("div", &format!("$0.{depth}"), "padding: 1px", vec![node]);
    }
    let island = resolve(&request(el("div", "$0", "", vec![node])));
    let (x, _, _, _) = common::bounds(&island, "$0.99");
    assert_eq!(x, 99.0);

    // Nothing in the island at all.
    let island = resolve(&request(el("div", "$0", "", vec![])));
    assert_eq!(common::bounds(&island, "$0").3, 0.0);
    // Only text.
    let island = resolve(&request(text("just text")));
    assert!(island.root.is_some());
}

#[test]
fn bad_css_is_ignored_as_a_browser_ignores_it() {
    let root = el(
        "div",
        "$0",
        "width: 30px; height: ; colour: red; width: banana; margin: 1px 2px 3px 4px 5px; height: 12px",
        vec![],
    );
    let island = resolve(&request(root));
    assert_eq!(common::bounds(&island, "$0"), (0.0, 0.0, 30.0, 12.0));
}

#[test]
fn zero_and_odd_viewports() {
    for (w, h) in [(0.0, 0.0), (1.0, 1.0), (1080.0, 1920.0), (333.5, 77.25)] {
        let mut req = request(el("div", "$0", "width: 50%; height: 50%", vec![]));
        req["viewport"] = json!({ "width": w, "height": h });
        let island = resolve(&req);
        let (_, _, bw, _) = common::bounds(&island, "$0");
        assert!((bw - w / 2.0).abs() < 0.02, "{w}: {bw}");
    }
}
