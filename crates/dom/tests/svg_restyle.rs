//! An `<svg>` edited from one frame to the next (as the renderer does in a
//! sequence of frames, and as a script does between frames) is styled by the
//! page's cascade as the same page built afresh is.

mod common;

use common::*;
use kinetograph_dom::document::IslandCache;
use serde_json::{Value, json};

/// A page of an `<svg>` of circles `a`, `b`, `c` and `d` (each with the
/// attributes `attrs` gives it) and `rects` rects, in a `div` of class
/// `div_class`; `style` is the last circle's `style` attribute. The sheet has
/// rules that read a class, a `data-` attribute, the `style` attribute, a
/// sibling and the position among the siblings, and two inside `@media`.
fn page(div_class: &str, attrs: [Value; 4], style: &str, rects: usize) -> Value {
    let circle = |i: usize, id: &str| {
        let mut a = json!({ "cx": (30 + 60 * i).to_string(), "cy": "30", "r": "20", "id": id });
        a.as_object_mut()
            .unwrap()
            .extend(attrs[i].as_object().unwrap().clone());
        let style = if i == 3 { style } else { "" };
        el_attrs("circle", &format!("$0.0.{i}"), a, style, vec![])
    };
    let mut children: Vec<Value> = ["a", "b", "c", "d"]
        .iter()
        .enumerate()
        .map(|(i, id)| circle(i, id))
        .collect();
    for i in 0..rects {
        children.push(el_attrs(
            "rect",
            &format!("$0.0.{}", 4 + i),
            json!({ "x": (10 + 50 * i).to_string(), "y": "70", "width": "40", "height": "20" }),
            "",
            vec![],
        ));
    }
    let svg = el_attrs(
        "svg",
        "$0.0",
        json!({ "width": "300", "height": "100", "viewBox": "0 0 300 100" }),
        "",
        children,
    );
    let mut req = request(el_attrs(
        "div",
        "$0",
        json!({ "class": div_class }),
        "",
        vec![svg],
    ));
    req["stylesheets"] = json!([".chart circle { fill: #888888 }
         .chart rect { fill: #777777 }
         .chart circle.on { fill: #ff0000 }
         .chart [data-k=\"1\"] { fill: #00ff00 }
         .chart [style*=\"opacity: 0.5\"] { fill: #0000ff }
         .chart circle.on + circle { fill: #ffff00 }
         .chart rect:nth-child(6) { fill: #00ffff }
         @media (min-width: 100px) { .chart .m.on { fill: #ff00ff } }
         @media (max-width: 100px) { .chart .m.on { fill: #123456 } }
         .lit .chart circle { stroke: #abcdef; stroke-width: 3px }"]);
    req
}

fn drawn(cache: &mut IslandCache, request: &Value, pass: Option<u64>) -> String {
    let request = parse(request);
    let mut resolved = cache.resolve(&request, pass).unwrap();
    let out = serde_json::to_string(&resolved.paint(&request).layers).unwrap();
    cache.keep(request, resolved);
    out
}

/// The frames edit one another (a class added, removed or toggled, an
/// attribute a selector reads, the `style` attribute, a sibling's class, a rect
/// added before others so `:nth-child` moves, a class on an ancestor, a rule
/// inside `@media`) and every one draws what a fresh build of it draws.
#[test]
fn an_svg_edited_between_frames_is_restyled_as_a_fresh_build_is() {
    let none = || json!({});
    let c = |class: &str| json!({ "class": class });
    let frames: Vec<Value> = vec![
        page("chart", [c("x"), c("m"), none(), none()], "", 5),
        // Class added.
        page("chart", [c("x on"), c("m"), none(), none()], "", 5),
        // Class removed again; the sibling rule lets go.
        page("chart", [c("x"), c("m"), none(), none()], "", 5),
        // The `@media` rule, reached by a class added later.
        page("chart", [c("x"), c("m on"), none(), none()], "", 5),
        // A class and a data attribute.
        page(
            "chart",
            [c("on"), c("m on"), json!({ "data-k": "1" }), none()],
            "",
            5,
        ),
        // The style attribute, read by a selector.
        page(
            "chart",
            [c("on"), c("m"), none(), none()],
            "opacity: 0.5",
            5,
        ),
        page(
            "chart",
            [c("on"), c("m"), none(), none()],
            "opacity: 0.9",
            5,
        ),
        // The ancestor's class.
        page("chart lit", [c("on"), c("m"), none(), none()], "", 5),
        page("chart", [c("on"), c("m"), none(), none()], "", 5),
        // A rect more: the structure changes (a fresh build), then edits go on.
        page("chart", [c("on"), c("m"), none(), none()], "", 6),
        page("chart", [c("x"), c("m"), none(), none()], "", 6),
        page("chart", [c("on"), c("m"), none(), none()], "", 6),
    ];
    let mut cache = IslandCache::default();
    let mut fresh = IslandCache::default();
    let mut seen = std::collections::BTreeSet::new();
    for (i, f) in frames.iter().enumerate() {
        let edited = drawn(&mut cache, f, Some(i as u64));
        assert_eq!(edited, drawn(&mut fresh, f, None), "frame {i}");
        seen.insert(edited);
    }
    // The frames that differ look different.
    assert!(seen.len() >= 8, "{} distinct frames", seen.len());
    let (edited, _) = cache.counts();
    assert!(edited >= 8, "the frames were rebuilt, not edited: {edited}");
}
