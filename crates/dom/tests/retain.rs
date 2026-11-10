//! Retained paint: an edited document whose stacking contexts are replayed
//! from its last paint draws what a whole paint of it does, and what a
//! document built afresh draws.

mod common;

use common::*;
use kinetograph_dom::document::IslandCache;
use kinetograph_dom::paint;
use serde_json::{Value, json};

/// The knobs of the page, each reaching one validity rule.
#[derive(Clone)]
struct Page {
    /// The wall's transform (a change to its group alone).
    x: f64,
    /// The text of card 2 (a change inside the wall).
    label: &'static str,
    /// The panel's background (a change to the parent of the panel's child context).
    panel: &'static str,
    /// The width of card 1 (a change of a context's size).
    width: f64,
    /// Where the z-indexed box hoisted out of card 3 is (a change hoisted into card 3's context).
    hoisted: f64,
    /// The root's background (a change to the root's own content).
    root: &'static str,
    /// Whether the box before the wall, with `id="dup"` as card 0 has, is a group of its own: its
    /// group takes the id before card 0 can (a change outside the wall that changes the wall's layer ids).
    dup: bool,
    /// The colour of the gradient outside the wall that card 1's picture fills with (a change that reaches by id).
    stop: &'static str,
    /// The text of a box clamped to two lines (a change that moves its ellipsis).
    clamped: &'static str,
}

const BASE: Page = Page {
    x: 0.0,
    label: "two",
    panel: "#123",
    width: 60.0,
    hoisted: 4.0,
    root: "#000",
    dup: false,
    stop: "#f00",
    clamped: "one two three four five six seven eight nine ten",
};

fn page(p: &Page) -> Value {
    let card = |i: usize| {
        let mut children = vec![text(&format!("card {i}"))];
        if i == 2 {
            children = vec![text(p.label)];
        }
        if i == 1 {
            children.push(el_attrs(
                "svg",
                "$0.1.1.1",
                json!({ "width": "10", "height": "10" }),
                "",
                vec![el_attrs(
                    "rect",
                    "$0.1.1.1.0",
                    json!({ "width": "10", "height": "10", "fill": "url(#g)" }),
                    "",
                    vec![],
                )],
            ));
        }
        if i == 3 {
            children.push(el(
                "div",
                "$0.1.3.1",
                &format!(
                    "position: absolute; z-index: 2; left: {}px; top: 2px; width: 8px; height: 8px; background: #f80",
                    p.hoisted
                ),
                vec![],
            ));
        }
        let width = if i == 1 { p.width } else { 60.0 };
        let attrs = if i == 0 {
            json!({ "id": "dup" })
        } else {
            json!({})
        };
        el_attrs(
            "div",
            &format!("$0.1.{i}"),
            attrs,
            &format!(
                "position: relative; width: {width}px; height: 20px; margin: 2px; background: #345; opacity: 0.{}",
                9 - i
            ),
            children,
        )
    };
    let before = el_attrs(
        "div",
        "$0.0",
        json!({ "id": "dup" }),
        &format!(
            "width: 10px; height: 10px; background: #0f0; opacity: {}",
            if p.dup { 0.5 } else { 1.0 }
        ),
        vec![],
    );
    let defs = el_attrs(
        "svg",
        "$0.3",
        json!({ "width": "0", "height": "0" }),
        "position: absolute",
        vec![el_attrs(
            "linearGradient",
            "$0.3.0",
            json!({ "id": "g" }),
            "",
            vec![
                el_attrs(
                    "stop",
                    "$0.3.0.0",
                    json!({ "offset": "0", "stop-color": p.stop }),
                    "",
                    vec![],
                ),
                el_attrs(
                    "stop",
                    "$0.3.0.1",
                    json!({ "offset": "1", "stop-color": "#00f" }),
                    "",
                    vec![],
                ),
            ],
        )],
    );
    let clamp = el(
        "div",
        "$0.4",
        "width: 80px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; opacity: 0.9",
        vec![text(p.clamped)],
    );
    let wall = el(
        "div",
        "$0.1",
        &format!("transform: translate({}px, 3px) rotate(2deg)", p.x),
        (0..4).map(card).collect(),
    );
    let panel = el(
        "div",
        "$0.2",
        &format!("opacity: 0.8; background: {}; padding: 4px", p.panel),
        vec![el(
            "div",
            "$0.2.0",
            "transform: rotate(5deg); width: 40px; height: 12px; background: #fa0",
            vec![text("inner")],
        )],
    );
    request(el(
        "div",
        "$0",
        &format!("position: absolute; inset: 0; background: {}", p.root),
        vec![before, wall, panel, defs, clamp],
    ))
}

/// The island's whole output from the cache at `pass`, a whole paint of the
/// same document, and how many contents the paint replayed.
fn painted(cache: &mut IslandCache, request: &Value, pass: Option<u64>) -> (String, String, u64) {
    let request = parse(request);
    let mut resolved = cache.resolve(&request, pass).unwrap();
    let retained = serde_json::to_string(&resolved.paint(&request)).unwrap();
    let whole = serde_json::to_string(&paint::paint(&resolved.island.doc, &request)).unwrap();
    let replayed = resolved.replayed().0;
    cache.keep(request, resolved);
    (retained, whole, replayed)
}

#[test]
fn a_replayed_paint_is_the_whole_paint_and_a_fresh_build_s() {
    let steps: Vec<(&str, Page, bool)> = vec![
        ("first", BASE.clone(), false),
        ("same", BASE.clone(), true),
        ("same again", BASE.clone(), true),
        ("group only", Page { x: 12.0, ..BASE }, true),
        (
            "dirty child",
            Page {
                x: 12.0,
                label: "TWO!",
                ..BASE
            },
            true,
        ),
        (
            "dirty parent",
            Page {
                panel: "#456",
                ..BASE
            },
            true,
        ),
        (
            "size",
            Page {
                width: 90.0,
                ..BASE
            },
            true,
        ),
        (
            "hoisted",
            Page {
                hoisted: 30.0,
                ..BASE
            },
            true,
        ),
        (
            "root",
            Page {
                root: "#222",
                ..BASE
            },
            true,
        ),
        ("id taken before", Page { dup: true, ..BASE }, true),
        ("id free again", BASE.clone(), true),
        ("beside a clamp", Page { x: 5.0, ..BASE }, true),
        (
            "clamp moves",
            Page {
                clamped: "one two",
                ..BASE
            },
            false,
        ),
        ("clamp back", BASE.clone(), false),
        (
            "gradient",
            Page {
                stop: "#0f0",
                ..BASE
            },
            false,
        ),
    ];
    let mut cache = IslandCache::default();
    let mut fresh = IslandCache::default();
    for (pass, (name, p, replays)) in steps.iter().enumerate() {
        let request = page(p);
        let (retained, whole, replayed) = painted(&mut cache, &request, Some(pass as u64));
        assert_eq!(
            retained, whole,
            "{name}: the replayed paint differs from a whole one"
        );
        let (built, _, _) = painted(&mut fresh, &request, None);
        let layers = |s: &str| serde_json::from_str::<Value>(s).unwrap()["layers"].clone();
        assert_eq!(
            layers(&retained),
            layers(&built),
            "{name}: differs from a fresh build"
        );
        assert_eq!(replayed > 0, *replays, "{name}: replayed {replayed}");
    }
}

/// A document painted again with nothing changed replays every context; a
/// change to one card repaints that card and what holds it, not its siblings.
#[test]
fn only_what_holds_a_change_is_painted_again() {
    let mut cache = IslandCache::default();
    let count = |cache: &mut IslandCache, p: &Page, pass: u64| {
        let request = parse(&page(p));
        let mut resolved = cache.resolve(&request, Some(pass)).unwrap();
        resolved.paint(&request);
        let counts = resolved.replayed();
        cache.keep(request, resolved);
        counts
    };
    // Contexts: the root, the wall, its four cards, the hoisted box, the panel and its child, the clamped box.
    assert_eq!(count(&mut cache, &BASE, 1), (0, 10));
    // Nothing changed: the root's content is replayed whole.
    assert_eq!(count(&mut cache, &BASE, 2), (1, 0));
    // Card 2's text: card 2, the wall and the root are painted, the other cards (and the hoisted box in card 3) replayed.
    let (replayed, painted) = count(
        &mut cache,
        &Page {
            label: "TWO!",
            ..BASE
        },
        3,
    );
    assert_eq!(painted, 3);
    assert_eq!(replayed, 5);
}

/// Each step's retained paint is the whole paint of the same document.
fn assert_replays_whole(steps: &[(&str, Value)]) {
    let mut cache = IslandCache::default();
    for (pass, (name, request)) in steps.iter().enumerate() {
        let (retained, whole, _) = painted(&mut cache, request, Some(pass as u64));
        assert_eq!(
            retained, whole,
            "{name}: the replayed paint differs from a whole one"
        );
    }
}

/// A context's lines wrap round a float outside it: a float that narrows
/// moves them, though the context's own box stays.
#[test]
fn text_beside_a_float_that_changes_is_painted_again() {
    let page = |float: f64| {
        request(el(
            "div",
            "$0",
            "position: absolute; inset: 0; width: 120px",
            vec![
                el(
                    "div",
                    "$0.0",
                    &format!("float: left; width: {float}px; height: 30px; background: #f80"),
                    vec![],
                ),
                el(
                    "div",
                    "$0.1",
                    "opacity: 0.9; height: 80px; font: 16px 'DM Sans'",
                    vec![text("one two three four five six seven")],
                ),
            ],
        ))
    };
    assert_replays_whole(&[("first", page(60.0)), ("narrower float", page(50.0))]);
}

/// A cell's column background is drawn in the context the table is in (Blitz
/// gives rows and columns no box, so a row is never a context of its own),
/// and a column is inside the table: a change to it paints that context again.
#[test]
fn a_column_that_changes_paints_the_table_s_context_again() {
    let page = |col: &str| {
        let table = el(
            "table",
            "$0.0",
            "border-spacing: 0; opacity: 0.9",
            vec![
                el(
                    "colgroup",
                    "$0.0.0",
                    "",
                    vec![el("col", "$0.0.0.0", &format!("background: {col}"), vec![])],
                ),
                el(
                    "tbody",
                    "$0.0.1",
                    "",
                    vec![el(
                        "tr",
                        "$0.0.1.0",
                        "opacity: 0.9",
                        vec![el(
                            "td",
                            "$0.0.1.0.0",
                            "width: 40px; height: 20px; opacity: 0.8",
                            vec![text("a")],
                        )],
                    )],
                ),
            ],
        );
        request(el("div", "$0", "position: absolute; inset: 0", vec![table]))
    };
    assert_replays_whole(&[("first", page("#f80")), ("column", page("#08f"))]);
}
