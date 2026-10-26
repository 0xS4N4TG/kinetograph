//! An `<svg>`'s content is styled by the page's CSS cascade: rules whose
//! selectors cross from the HTML into the SVG reach the shapes, and the font
//! the HTML sets reaches the SVG's text.

mod common;

use common::*;
use kinetograph_dom::request::IslandOutput;
use serde_json::{Value, json};

/// A `div` (with `div_attrs` and `div_style`) holding an `<svg>` of a rect
/// (with `rect_attrs`), a circle and a text; `sheet` is the page's CSS.
fn page(sheet: &str, div_attrs: Value, div_style: &str, rect_attrs: Value, fonts: Value) -> Value {
    let mut r = json!({ "x": "10", "y": "10", "width": "80", "height": "40" });
    r.as_object_mut()
        .unwrap()
        .extend(rect_attrs.as_object().unwrap().clone());
    let rect = el_attrs("rect", "$0.0.0", r, "", vec![]);
    let circle = el_attrs(
        "circle",
        "$0.0.1",
        json!({ "cx": "150", "cy": "30", "r": "20" }),
        "",
        vec![],
    );
    let label = el_attrs(
        "text",
        "$0.0.2",
        json!({ "x": "10", "y": "90", "font-size": "30" }),
        "",
        vec![text("Hello")],
    );
    let svg = el_attrs(
        "svg",
        "$0.0",
        json!({ "width": "200", "height": "100", "viewBox": "0 0 200 100" }),
        "",
        vec![rect, circle, label],
    );
    let root = el_attrs("div", "$0", div_attrs, div_style, vec![svg]);
    let mut req = request(root);
    req["stylesheets"] = json!([sheet]);
    req["fonts"] = fonts;
    req
}

fn paint(req: &Value) -> IslandOutput {
    let parsed = parse(req);
    let island = kinetograph_dom::document::resolve(&parsed).expect("resolves");
    kinetograph_dom::paint::paint(&island.doc, &parsed)
}

fn json_of(out: &IslandOutput) -> String {
    out.layers.iter().map(|l| l.to_string()).collect()
}

/// Every shape layer of `out`, in order.
fn shapes(out: &IslandOutput) -> Vec<Value> {
    fn walk(v: &Value, acc: &mut Vec<Value>) {
        if v["type"] == "shape" {
            acc.push(v.clone());
        }
        for c in v["children"].as_array().into_iter().flatten() {
            walk(c, acc);
        }
    }
    let mut acc = Vec::new();
    for l in &out.layers {
        walk(l, &mut acc);
    }
    acc
}

/// The fill of the rect (the first shape).
fn rect_fill(req: &Value) -> String {
    shapes(&paint(req))[0]["fill"].as_str().unwrap().to_string()
}

#[test]
fn rules_crossing_from_the_html_into_the_svg_reach_the_shapes() {
    let sheet = r#"
        [data-composition-id="x"] .bar { fill: #5c5c5c }
        .chart circle { stroke: red; stroke-width: 4px; fill: rgb(0, 128, 0) }
    "#;
    let req = page(
        sheet,
        json!({ "data-composition-id": "x", "class": "chart" }),
        "",
        json!({ "class": "bar" }),
        json!({ "DM Sans": dm_sans() }),
    );
    let s = shapes(&paint(&req));
    assert_eq!(s[0]["fill"], "#5c5c5cff");
    assert!(s[0]["stroke"].is_null());
    assert_eq!(s[1]["fill"], "#008000ff");
    assert_eq!(s[1]["stroke"]["color"], "#ff0000ff");
    assert_eq!(s[1]["stroke"]["width"], 4.0);

    // Attribute and child selectors reach it too, and so do properties that
    // are not colours.
    let sheet = r#"
        div[data-k="1"] > svg rect[data-bar] { fill: #123456; stroke: #abcdef; stroke-dasharray: 4 2 }
    "#;
    let req = page(
        sheet,
        json!({ "data-k": "1" }),
        "",
        json!({ "data-bar": "" }),
        json!({}),
    );
    let s = shapes(&paint(&req));
    assert_eq!(s[0]["fill"], "#123456ff");
    assert_eq!(s[0]["stroke"]["color"], "#abcdefff");
    assert_eq!(s[0]["stroke"]["dashArray"], json!([4.0, 2.0]));
}

#[test]
fn the_cascade_beats_a_presentation_attribute_and_inheritance_is_left_alone() {
    let attr = json!({ "fill": "#aabbcc" });
    // The rule wins over the attribute.
    let req = page(
        ".w rect { fill: #112233 }",
        json!({ "class": "w" }),
        "",
        attr.clone(),
        json!({}),
    );
    assert_eq!(rect_fill(&req), "#112233ff");
    // With no rule that reaches it, the attribute stands.
    let req = page(
        ".other rect { fill: #112233 }",
        json!({}),
        "",
        attr.clone(),
        json!({}),
    );
    assert_eq!(rect_fill(&req), "#aabbccff");
    // What the HTML passes down does not override an attribute, but fills a
    // shape that has none.
    let req = page("", json!({}), "fill: #445566", attr, json!({}));
    let s = shapes(&paint(&req));
    assert_eq!(s[0]["fill"], "#aabbccff");
    assert_eq!(s[1]["fill"], "#445566ff");
}

#[test]
fn a_class_toggled_between_frames_restyles_the_shapes() {
    let sheet = ".chart .bar.on { fill: #ff0000 } .chart .bar { fill: #00ff00 }";
    let frame = |class: &str| {
        rect_fill(&page(
            sheet,
            json!({ "class": "chart" }),
            "",
            json!({ "class": class }),
            json!({}),
        ))
    };
    assert_eq!(frame("bar"), "#00ff00ff");
    assert_eq!(frame("bar on"), "#ff0000ff");
    assert_eq!(frame("bar"), "#00ff00ff");
    // Nothing matches: drawn as before.
    let req = page(sheet, json!({}), "", json!({ "class": "bar" }), json!({}));
    assert_eq!(rect_fill(&req), "#000000ff");
}

#[test]
fn display_and_opacity_from_the_cascade_apply() {
    let req = page(
        ".chart circle { display: none } .chart rect { opacity: 0.25 }",
        json!({ "class": "chart" }),
        "",
        json!({}),
        json!({}),
    );
    let out = paint(&req);
    let s = shapes(&out);
    // Without the circle the text is the second shape.
    assert!(
        s.iter()
            .all(|v| !v["shape"]["d"].as_str().unwrap().contains("C 170 41.046"))
    );
    assert!(json_of(&out).contains("0.25"), "{}", json_of(&out));
}

/// The whole picture: the text is the part that differs between fonts.
fn glyphs(req: &Value) -> String {
    json_of(&paint(req))
}

fn unloaded(out: &IslandOutput) -> usize {
    out.unsupported
        .iter()
        .filter(|u| u.reason == kinetograph_dom::fonts::UNLOADED_REASON)
        .count()
}

#[test]
fn a_font_face_family_the_html_sets_reaches_the_svg_text_however_it_is_quoted() {
    let fonts = json!({ "Display Face": dm_sans(), "Bob's Face": archivo_black() });
    // The text with its family set on itself, as the references.
    let reference = |family: &str| {
        let mut req = page("", json!({}), "", json!({}), fonts.clone());
        req["root"]["children"][0]["children"][2]["attrs"]["font-family"] = json!(family);
        glyphs(&req)
    };
    let display = reference("Display Face");
    let bobs = reference("Bob's Face");
    assert_ne!(display, bobs);

    for (sheet, style, want) in [
        (
            ".t { font-family: \"Display Face\", sans-serif }",
            "",
            &display,
        ),
        ("", "font-family: \"Display Face\", serif", &display),
        ("", "font-family: 'Display Face'", &display),
        (".t { font-family: \"Bob's Face\" }", "", &bobs),
        ("", "font-family: \"Bob's Face\", monospace", &bobs),
    ] {
        let req = page(
            sheet,
            json!({ "class": "t" }),
            style,
            json!({}),
            fonts.clone(),
        );
        let out = paint(&req);
        assert_eq!(&glyphs(&req), want, "{sheet} {style}");
        assert_eq!(unloaded(&out), 0, "{sheet} {style}: {:?}", out.unsupported);
    }

    // The `<svg>` and its `<text>` setting the family themselves, quoted.
    let mut on_svg = page("", json!({}), "", json!({}), fonts.clone());
    on_svg["root"]["children"][0]["style"] = json!("font-family: \"Bob's Face\", monospace");
    assert_eq!(glyphs(&on_svg), bobs);
    let mut on_text = page("", json!({}), "", json!({}), fonts.clone());
    on_text["root"]["children"][0]["children"][2]["style"] = json!("font-family: \"Display Face\"");
    assert_eq!(glyphs(&on_text), display);
}

#[test]
fn colours_usvg_cannot_read_are_resolved_like_html_ones() {
    let fill_of = |sheet: &str, div_style: &str, fill: &str| {
        let req = page(
            sheet,
            json!({ "class": "c" }),
            div_style,
            json!({ "fill": fill }),
            json!({}),
        );
        rect_fill(&req)
    };
    // Attributes.
    assert_eq!(fill_of("", "", "rebeccapurple"), "#663399ff");
    assert_eq!(fill_of("", "", "rgb(18 52 86)"), "#123456ff");
    assert_eq!(fill_of("", "", "oklch(1 0 0)"), "#ffffffff");
    assert_eq!(fill_of("", "", "oklab(0 0 0)"), "#000000ff");
    assert_eq!(
        fill_of("", "", "color-mix(in srgb, #ff0000 50%, #0000ff 50%)"),
        "#800080ff"
    );
    assert!(fill_of("", "", "rgb(0 0 0 / 0.5)").starts_with("#000000"));
    // Custom properties, with and without a fallback, set on the HTML around.
    assert_eq!(fill_of("", "--c: #123456", "var(--c)"), "#123456ff");
    assert_eq!(fill_of("", "", "var(--nope, #654321)"), "#654321ff");
    assert_eq!(
        fill_of(".c { --c: oklch(1 0 0) }", "", "var(--c)"),
        "#ffffffff"
    );
    // From a rule, where Stylo computes them.
    assert_eq!(
        fill_of(".c rect { fill: oklch(1 0 0) }", "", "red"),
        "#ffffffff"
    );
    assert_eq!(
        fill_of(".c rect { fill: var(--c) }", "--c: rebeccapurple", "red"),
        "#663399ff"
    );
    // One that cannot be resolved is reported, not drawn black without a word.
    let req = page(
        "",
        json!({}),
        "",
        json!({ "fill": "var(--missing)" }),
        json!({}),
    );
    let out = paint(&req);
    assert!(
        out.unsupported
            .iter()
            .any(|u| u.property.as_deref() == Some("fill")),
        "{:?}",
        out.unsupported
    );
}

#[test]
fn text_anchor_and_the_other_svg_only_properties_cascade_too() {
    let fonts = json!({ "DM Sans": dm_sans() });
    // `text-anchor` from a rule is the attribute on the text.
    let rule = page(
        ".chart text { text-anchor: end }",
        json!({ "class": "chart" }),
        "",
        json!({}),
        fonts.clone(),
    );
    let mut attr = page("", json!({}), "", json!({}), fonts.clone());
    attr["root"]["children"][0]["children"][2]["attrs"]["text-anchor"] = json!("end");
    let plain = page("", json!({}), "", json!({}), fonts.clone());
    assert_eq!(json_of(&paint(&rule)), json_of(&paint(&attr)));
    assert_ne!(json_of(&paint(&rule)), json_of(&paint(&plain)));

    // What the HTML around the svg sets is inherited into it.
    let inherited = page("", json!({}), "text-anchor: end", json!({}), fonts.clone());
    assert_eq!(json_of(&paint(&inherited)), json_of(&paint(&attr)));

    // The same for `paint-order` and `shape-rendering`, which change the picture.
    let stroked = json!({ "stroke": "#ff0000", "stroke-width": "10" });
    let rule = page(
        ".chart rect { paint-order: stroke; shape-rendering: crispEdges }",
        json!({ "class": "chart" }),
        "",
        stroked.clone(),
        fonts.clone(),
    );
    let mut own = stroked.clone();
    own["paint-order"] = json!("stroke");
    own["shape-rendering"] = json!("crispEdges");
    let attr = page("", json!({}), "", own, fonts.clone());
    let plain = page("", json!({}), "", stroked, fonts);
    assert_eq!(json_of(&paint(&rule)), json_of(&paint(&attr)));
    assert_ne!(json_of(&paint(&rule)), json_of(&paint(&plain)));
}

/// The `d` of the rect (the first shape) as the layers have it.
fn rect_path(req: &Value) -> String {
    shapes(&paint(req))[0]["shape"]["d"]
        .as_str()
        .unwrap()
        .to_string()
}

#[test]
fn rules_inside_media_queries_reach_the_shapes() {
    // The composition is 1000 px wide.
    let sheet = r#"
        @media (min-width: 600px) { .chart .bar { fill: #112233 } }
        @media (max-width: 600px) { .chart .bar { fill: #ff0000 } }
        @media (min-width: 600px) { .chart circle { stroke: #445566 } }
    "#;
    let req = page(
        sheet,
        json!({ "class": "chart" }),
        "",
        json!({ "class": "bar" }),
        json!({}),
    );
    let s = shapes(&paint(&req));
    assert_eq!(s[0]["fill"], "#112233ff");
    assert_eq!(s[1]["stroke"]["color"], "#445566ff");
}

#[test]
fn transform_from_the_cascade_moves_the_shape() {
    let plain = rect_path(&page("", json!({}), "", json!({}), json!({})));
    assert!(plain.starts_with("M 10 10"), "{plain}");
    let sheet = ".chart .bar { transform: translate(100px, 20px) }";
    let req = page(
        sheet,
        json!({ "class": "chart" }),
        "",
        json!({ "class": "bar" }),
        json!({}),
    );
    let moved = rect_path(&req);
    assert!(moved.starts_with("M 110 30"), "{moved}");
    // The separate transform properties and the origin too.
    let sheet = ".chart .bar { rotate: 90deg; transform-origin: 50px 50px }";
    let req = page(
        sheet,
        json!({ "class": "chart" }),
        "",
        json!({ "class": "bar" }),
        json!({}),
    );
    assert_ne!(rect_path(&req), plain);
}

/// A rect inside `<svg>` with a filter, a clip path and a mask defined in it.
fn defs_page(sheet: &str) -> Value {
    let blur = el_attrs(
        "feGaussianBlur",
        "$0.0.0.0",
        json!({ "stdDeviation": "3" }),
        "",
        vec![],
    );
    let filter = el_attrs("filter", "$0.0.0", json!({ "id": "f" }), "", vec![blur]);
    let clip_rect = el_attrs(
        "rect",
        "$0.0.1.0",
        json!({ "x": "0", "y": "0", "width": "40", "height": "100" }),
        "",
        vec![],
    );
    let clip = el_attrs("clipPath", "$0.0.1", json!({ "id": "c" }), "", vec![clip_rect]);
    let defs = el("defs", "$0.0.2", "", vec![filter, clip]);
    let rect = el_attrs(
        "rect",
        "$0.0.3",
        json!({ "x": "10", "y": "10", "width": "80", "height": "40", "class": "bar" }),
        "",
        vec![],
    );
    let svg = el_attrs(
        "svg",
        "$0.0",
        json!({ "width": "200", "height": "100", "viewBox": "0 0 200 100" }),
        "",
        vec![defs, rect],
    );
    let root = el_attrs("div", "$0", json!({ "class": "chart" }), "", vec![svg]);
    let mut req = request(root);
    req["stylesheets"] = json!([sheet]);
    req
}

#[test]
fn filter_from_the_cascade_applies() {
    let plain = json_of(&paint(&defs_page("")));
    assert!(!plain.contains("filterGraph"), "{plain}");
    let filtered = json_of(&paint(&defs_page(".chart .bar { filter: url(#f) }")));
    assert!(filtered.contains("filterGraph"), "{filtered}");
}

#[test]
fn clip_path_from_the_cascade_applies() {
    let plain = json_of(&paint(&defs_page("")));
    let clipped = json_of(&paint(&defs_page(".chart .bar { clip-path: url(#c) }")));
    assert_ne!(clipped, plain);
    assert!(clipped.contains("M 0 0 L 40 0 L 40 100 L 0 100 Z"), "{clipped}");
}
