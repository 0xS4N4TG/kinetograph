//! The islands of a motion-blur pass: a document edited from one sample to the
//! next draws what a document built from the sample draws.

mod common;

use common::*;
use kinetograph_dom::document::{EditsError, IslandCache};
use kinetograph_dom::readback;
use serde_json::{Value, json};

fn sample(x: f64, label: &str, extra: &str) -> Value {
    let pill = |i: usize| {
        el(
            "div",
            &format!("$0.0.{i}"),
            &format!(
                "width: 60px; height: 20px; background: #345; opacity: {}",
                1.0 - x / 100.0
            ),
            vec![text(&format!("pill {i} {label}"))],
        )
    };
    let wall = el(
        "div",
        "$0.0",
        &format!("position: absolute; transform: translate({x}px, 3px) scale(1.5); {extra}"),
        (0..6).map(pill).collect(),
    );
    request(el("div", "$0", "position: absolute; inset: 0", vec![wall]))
}

fn drawn(cache: &mut IslandCache, request: &Value, pass: Option<u64>) -> String {
    let request = parse(request);
    let mut resolved = cache.resolve(&request, pass).unwrap();
    let out = serde_json::to_string(&resolved.paint(&request).layers).unwrap();
    cache.keep(request, resolved);
    out
}

#[test]
fn an_edited_document_draws_what_a_fresh_one_does() {
    let mut cache = IslandCache::default();
    let mut fresh = IslandCache::default();
    // Transform and opacity only, then text, then a size (layout), then a new element.
    let samples = [
        sample(0.0, "a", ""),
        sample(2.5, "a", ""),
        sample(5.0, "b", ""),
        sample(7.5, "b", "left: 40px; width: 300px"),
        {
            let mut s = sample(9.0, "b", "");
            s["root"]["children"][0]["children"][0]["children"] = json!([]);
            s
        },
    ];
    for s in &samples {
        // `None` is never kept, so it is always built afresh.
        assert_eq!(drawn(&mut cache, s, Some(7)), drawn(&mut fresh, s, None));
    }
}

#[test]
fn island_edits_draw_what_the_whole_request_does() {
    use kinetograph_dom::request::IslandEdits;
    let mut cache = IslandCache::default();
    let mut fresh = IslandCache::default();
    drawn(&mut cache, &sample(0.0, "a", ""), Some(20));
    // The wall moves (a transform alone), then a pill's text and size change (layout), in the pass and the next.
    let moved = "position: absolute; transform: translate(3px, 3px) scale(1.5)";
    let mut first = sample(0.0, "a", "");
    first["root"]["children"][0]["style"] = json!(moved);
    let mut second = first.clone();
    second["root"]["children"][0]["children"][2]["children"][0]["text"] = json!("pill two");
    second["root"]["children"][0]["children"][2]["style"] = json!("width: 90px; height: 30px");
    let steps = [
        (20, first, json!([{ "path": "$0.0", "style": moved }])),
        (
            21,
            second,
            json!([{ "path": "$0.0.2", "style": "width: 90px; height: 30px", "texts": [[0, "pill two"]] }]),
        ),
    ];
    for (pass, whole, set) in steps {
        let edits: IslandEdits = serde_json::from_value(
            json!({ "stamp": 0, "base": 0, "path": "$0", "time": 0.0, "set": set }),
        )
        .unwrap();
        let (request, mut resolved) = cache.resolve_edits(&edits, Some(pass)).unwrap();
        let out = serde_json::to_string(&resolved.paint(&request).layers).unwrap();
        cache.keep(request, resolved);
        assert_eq!(out, drawn(&mut fresh, &whole, None));
    }
    // Edited both times; nothing is kept for a pass that does not follow.
    assert_eq!(cache.counts(), (2, 1));
    let edits: IslandEdits = serde_json::from_value(
        json!({ "stamp": 0, "base": 0, "path": "$0", "time": 0.0, "set": [] }),
    )
    .unwrap();
    assert!(matches!(
        cache.resolve_edits(&edits, Some(30)),
        Err(EditsError::Stale(_))
    ));
}

#[test]
fn a_document_carries_over_to_the_next_frame_and_only_to_it() {
    let mut cache = IslandCache::default();
    let mut fresh = IslandCache::default();
    // Frames 1, 2, 3 in sequence, then a jump to pass 9, with two samples in each frame.
    let frames = [(1, 0.0, "a"), (2, 4.0, "a"), (3, 8.0, "b"), (9, 12.0, "b")];
    for (pass, x, label) in frames {
        for dx in [0.0, 1.0] {
            let s = sample(x + dx, label, "");
            assert_eq!(drawn(&mut cache, &s, Some(pass)), drawn(&mut fresh, &s, None));
        }
    }
    // Built once at pass 1 and once after the jump; every other render edited.
    assert_eq!(cache.counts(), (6, 2));
    // An island a frame did not render is gone from the one after next.
    let mut other = request(el("div", "$1", "position: absolute; inset: 0", vec![]));
    other["path"] = json!("$1");
    drawn(&mut cache, &other, Some(10));
    drawn(&mut cache, &other, Some(11));
    let (_, built) = cache.counts();
    drawn(&mut cache, &sample(0.0, "a", ""), Some(12));
    assert_eq!(cache.counts().1, built + 1);
}

#[test]
fn a_later_render_is_written_as_changes_from_the_first() {
    use kinetograph_dom::request::{IslandOutput, undelta, write_output, written};
    let mut cache = IslandCache::default();
    // The layers of an output written as changes from `base`.
    let delta = |layers: &[Value], base: &[Value]| -> Value {
        let output = IslandOutput {
            layers: layers.to_vec(),
            ..IslandOutput::default()
        };
        let (now, base) = (written(layers).unwrap(), written(base).unwrap());
        let json = write_output(&output, &now, Some((&base, 3))).unwrap();
        serde_json::from_str::<Value>(&json).unwrap()["layers"].take()
    };
    let layers = |s: &Value, cache: &mut IslandCache| -> Vec<Value> {
        serde_json::from_str(&drawn(cache, s, Some(3))).unwrap()
    };
    let base = layers(&sample(0.0, "a", ""), &mut cache);
    for s in [
        sample(0.0, "a", ""),
        sample(2.5, "a", ""),
        sample(5.0, "b", ""),
        sample(7.5, "b", "left: 40px; width: 300px"),
    ] {
        let later = layers(&s, &mut cache);
        let changes = delta(&later, &base);
        assert_eq!(undelta(changes.as_array().unwrap(), &base), later);
    }
    // The same render is the first's, layer by layer.
    let same = delta(&base, &base);
    assert!(
        same.as_array()
            .unwrap()
            .iter()
            .enumerate()
            .all(|(i, l)| *l == json!({ "$same": i }))
    );
}

/// Style edits whose effects reach past the element: what children inherit,
/// and selectors that read the `style` attribute of the element or of a
/// sibling before it. (Not a pseudo-element: a restyle makes it a new node,
/// and its layers' ids, made from the node's id, differ from a fresh
/// build's; the picture does not. The same goes for the anonymous block
/// round inline content beside blocks.)
#[test]
fn a_style_edit_restyles_what_depends_on_it_as_a_fresh_build_does() {
    let page = |color: &str, size: f64, x: f64| {
        let mut r = request(el(
            "div",
            "$0",
            "position: absolute; inset: 0",
            vec![
                el(
                    "div",
                    "$0.0",
                    &format!("color: {color}; font-size: {size}px; transform: translateX({x}px)"),
                    vec![
                        el("p", "$0.0.0", "margin: 0", vec![text("inherits")]),
                        el(
                            "div",
                            "$0.0.1",
                            "border: 1em solid currentColor; width: 2em",
                            vec![],
                        ),
                    ],
                ),
                el("div", "$0.1", "height: 10px", vec![text("after")]),
                el_attrs(
                    "p",
                    "$0.2",
                    json!({ "class": "mark" }),
                    &format!("opacity: {}", x / 100.0),
                    vec![text("p")],
                ),
            ],
        ));
        r["stylesheets"] = json!(
            ["div[style*='red'] + div { width: 77px; background: blue } \
             .mark { color: inherit } \
             p[style*='0.5'] { color: green }"]
        );
        r
    };
    let mut cache = IslandCache::default();
    let mut fresh = IslandCache::default();
    for s in [
        page("black", 16.0, 0.0),
        page("red", 16.0, 10.0),
        page("red", 24.0, 50.0),
        page("black", 24.0, 50.0),
        page("black", 12.0, 20.0),
    ] {
        assert_eq!(drawn(&mut cache, &s, Some(9)), drawn(&mut fresh, &s, None));
    }
}

/// Transforms alone changing between samples, as when a wall of cards moves:
/// the samples painted from the last paint draw what fresh ones do, through
/// a transform that becomes a plain move (painted whole again), a parent's
/// perspective, a percentage origin and a masked element.
#[test]
fn a_change_of_transforms_alone_draws_what_a_fresh_build_does() {
    let page = |x: f64, tick: f64, extra: &str| {
        let card = |i: usize| {
            el(
                "div",
                &format!("$0.0.{i}"),
                "position: absolute; width: 80px; height: 30px; display: flex; gap: 4px; background: #234; border: 2px solid #567; border-radius: 6px",
                vec![
                    el_attrs(
                        "svg",
                        &format!("$0.0.{i}.0"),
                        json!({ "width": "20", "height": "20", "viewBox": "0 0 20 20" }),
                        &format!(
                            "flex: none; transform: scale({})",
                            tick * (i as f64 + 1.0) / 4.0
                        ),
                        vec![el_attrs(
                            "circle",
                            &format!("$0.0.{i}.0.0"),
                            json!({ "cx": "10", "cy": "10", "r": "9", "fill": "#3fb950" }),
                            "",
                            vec![],
                        )],
                    ),
                    el(
                        "span",
                        &format!("$0.0.{i}.1"),
                        "",
                        vec![text(&format!("card {i}"))],
                    ),
                ],
            )
        };
        request(el(
            "div",
            "$0",
            "position: absolute; inset: 0; perspective: 400px",
            vec![
                el(
                    "div",
                    "$0.0",
                    &format!(
                        "position: absolute; width: 400px; height: 200px; transform-origin: 30% 40%; transform: translate({x}px, 3px) scale(1.25) {extra}"
                    ),
                    (0..4).map(card).collect(),
                ),
                el(
                    "div",
                    "$0.1",
                    &format!(
                        "position: absolute; top: 300px; width: 50px; height: 50px; background: red; mask-image: linear-gradient(black, transparent); transform: rotate({x}deg)"
                    ),
                    vec![],
                ),
            ],
        ))
    };
    let mut cache = IslandCache::default();
    let mut fresh = IslandCache::default();
    for s in [
        page(0.0, 0.0, ""),
        page(1.5, 0.0, ""),
        page(3.0, 0.5, ""),
        page(4.5, 1.0, "rotateY(10deg)"),
        page(6.0, 1.0, ""),
        page(6.0, 1.0, ""),
    ] {
        assert_eq!(drawn(&mut cache, &s, Some(11)), drawn(&mut fresh, &s, None));
    }
    // A transform that becomes the identity, and one that comes back.
    let flat = |t: &str| {
        request(el(
            "div",
            "$0",
            "position: absolute; inset: 0",
            vec![el(
                "div",
                "$0.0",
                &format!("width: 10px; height: 10px; background: #fff; transform: {t}"),
                vec![],
            )],
        ))
    };
    for t in [
        "scale(2)",
        "scale(1)",
        "translate(5px)",
        "scale(3)",
        "none",
        "scale(2)",
    ] {
        assert_eq!(
            drawn(&mut cache, &flat(t), Some(12)),
            drawn(&mut fresh, &flat(t), None),
            "{t}"
        );
    }
}

/// The end card of the launch film: a word with an inline-block full stop whose scale is animated, in a block
/// whose own scale, opacity and blur finish first. One frame after another, a document edited from the frame
/// before draws what a fresh one does.
#[test]
fn an_inline_block_scaled_frame_after_frame_draws_what_a_fresh_build_does() {
    let back = |t: f64| {
        let t = 1.0 - t;
        1.0 - t * t * (3.2 * t - 2.2)
    };
    let card = |frame: u32| {
        let land = ((frame as f64 - 6.0) / 8.0).clamp(0.0, 1.0);
        let dot = back(((frame as f64 - 12.0) / 10.0).clamp(0.0, 1.0));
        request(el(
            "div",
            "$0",
            "position: absolute; inset: 0",
            vec![el(
                "div",
                "$0.0",
                "position: absolute; left: 0; right: 0; top: 100px; text-align: center; color: #111",
                vec![el(
                    "div",
                    "$0.0.0",
                    &format!(
                        "font-size: 100px; line-height: 1; opacity: {land}; transform: scale({}); filter: blur({}px)",
                        1.05 - 0.05 * land,
                        (1.0 - land) * 10.0
                    ),
                    vec![
                        text("kinetograph"),
                        el(
                            "span",
                            "$0.0.0.1",
                            &format!(
                                "color: red; display: inline-block; transform: scale({dot}); transform-origin: 50% 85%"
                            ),
                            vec![text(".")],
                        ),
                    ],
                )],
            )],
        ))
    };
    let mut cache = IslandCache::default();
    let mut fresh = IslandCache::default();
    for frame in 0..40u32 {
        let s = card(frame);
        assert_eq!(
            drawn(&mut cache, &s, Some(u64::from(frame) + 1)),
            drawn(&mut fresh, &s, None),
            "frame {frame}"
        );
    }
}

/// Nodes Blitz makes by itself (the block round text beside blocks, a pseudo-element) are made again when their
/// element is restyled, with new ids. Their layers are named by where they sit, so a document edited from the
/// frame before gives the ids of one built afresh.
#[test]
fn made_nodes_keep_their_layer_ids_across_edits() {
    let page = |x: f64, color: &str| {
        let mut r = request(el(
            "div",
            "$0",
            "position: absolute; inset: 0",
            vec![el(
                "div",
                "$0.0",
                &format!("color: {color}; transform: translateX({x}px)"),
                vec![
                    text("loose text before"),
                    el("div", "$0.0.0", "height: 10px; background: #345", vec![]),
                    text("loose text after"),
                    el_attrs(
                        "p",
                        "$0.0.1",
                        json!({ "class": "tag" }),
                        &format!("opacity: {}", 1.0 - x / 100.0),
                        vec![text("p")],
                    ),
                ],
            )],
        ));
        r["stylesheets"] = json!([".tag::before { content: 'x '; color: red }"]);
        r
    };
    let mut cache = IslandCache::default();
    let mut fresh = IslandCache::default();
    let mut ids = Vec::new();
    for (frame, (x, color)) in [(0.0, "#111"), (3.0, "#111"), (6.0, "#222"), (9.0, "#222")]
        .into_iter()
        .enumerate()
    {
        let s = page(x, color);
        let edited = drawn(&mut cache, &s, Some(frame as u64 + 1));
        assert_eq!(edited, drawn(&mut fresh, &s, None), "frame {frame}");
        ids.push(
            edited
                .split("\"id\":\"")
                .skip(1)
                .map(|t| t.split('"').next().unwrap().to_string())
                .collect::<Vec<_>>(),
        );
    }
    // The same layers, named the same, from one frame to the next (the first has no transform and full opacity,
    // so the groups of the second and third elements are not in it).
    assert!(ids[1..].windows(2).all(|w| w[0] == w[1]), "{ids:?}");
    assert!(ids[0].iter().any(|id| id.contains('!')), "{:?}", ids[0]);
}

/// A caption: a flex line aligned on baselines, holding a plain word and a word that carries a doodle (an SVG with
/// paths) beside its text. Frame to frame only the doodle's attributes change. Restyling the SVG has to leave the
/// line sized as a fresh build sizes it.
#[test]
fn an_edited_svg_beside_text_leaves_the_line_as_fresh() {
    let caption = |draw: f64| {
        let petals: Vec<Value> = (0..3)
            .map(|i| {
                el_attrs(
                    "path",
                    &format!("$0.0.1.1.{i}"),
                    json!({
                        "d": format!("M0 0 Q{} 4 10 {}", i, 3 * i),
                        "fill": "none",
                        "stroke": "#f8c",
                        "stroke-width": "2",
                        "pathLength": "1",
                        "stroke-dasharray": "1 1",
                        "stroke-dashoffset": format!("{}", 1.0 - draw * (i as f64 + 1.0) / 3.0),
                    }),
                    "",
                    vec![],
                )
            })
            .collect();
        let word = el(
            "span",
            "$0.0.1",
            "position: relative; display: inline-block; margin: 0 22px",
            vec![
                el(
                    "span",
                    "$0.0.1.0",
                    "display: inline-block; font-family: Inter; font-weight: 800; font-size: 171px; line-height: 1; white-space: nowrap",
                    vec![text("screenshotting")],
                ),
                el_attrs(
                    "svg",
                    "$0.0.1.1",
                    json!({ "width": "60", "height": "60", "viewBox": "-30 -30 60 60" }),
                    "position: absolute; right: -52px; top: -30px; overflow: visible",
                    petals,
                ),
            ],
        );
        let plain = el(
            "span",
            "$0.0.0",
            "display: inline-block; margin: 0 18px; white-space: nowrap; font-size: 90px",
            vec![text("the")],
        );
        request(el(
            "div",
            "$0",
            "position: absolute; inset: 0",
            vec![el(
                "div",
                "$0.0",
                "position: absolute; bottom: 100px; width: 960px; display: flex; flex-wrap: wrap; align-items: baseline",
                vec![plain, word],
            )],
        ))
    };
    let mut cache = IslandCache::default();
    let mut fresh = IslandCache::default();
    for (frame, draw) in [0.0, 0.2, 0.4, 0.6, 1.0].into_iter().enumerate() {
        let s = caption(draw);
        assert_eq!(
            drawn(&mut cache, &s, Some(frame as u64 + 1)),
            drawn(&mut fresh, &s, None),
            "frame {frame}"
        );
    }
}

/// Text beside a float wraps round it: an edit that narrows the float lays the
/// lines beside it out again, as a fresh build does.
#[test]
fn text_beside_an_edited_float_wraps_as_fresh() {
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
                    "height: 80px; font: 16px 'DM Sans'",
                    vec![text("one two three four five six seven")],
                ),
            ],
        ))
    };
    let mut cache = IslandCache::default();
    let mut fresh = IslandCache::default();
    for (pass, float) in [60.0, 20.0, 50.0].into_iter().enumerate() {
        let s = page(float);
        assert_eq!(
            drawn(&mut cache, &s, Some(pass as u64 + 1)),
            drawn(&mut fresh, &s, None),
            "float {float}px"
        );
    }
}

/// An inline-block's overflow (`scrollWidth`, `scrollHeight`) is its final layout's: a measure of its line after an
/// edit, answered from taffy's size-only cache, leaves it alone.
#[test]
fn an_inline_block_keeps_its_overflow_when_its_line_is_measured_again() {
    let page = |display: &str| {
        request(el(
            "div",
            "$0",
            "position: absolute; inset: 0; font: 16px 'DM Sans'",
            vec![el(
                "div",
                "$0.0",
                &format!("display: {display}; flex-direction: column; width: 233px"),
                vec![el(
                    "section",
                    "$0.0.0",
                    "width: 284px",
                    vec![
                        el(
                            "span",
                            "$0.0.0.0",
                            "display: inline-block; width: 30px; height: 12px",
                            vec![text("1234 1234 1234 1234")],
                        ),
                        text("frame"),
                        // A block after the line: the line is an anonymous block's.
                        el("table", "$0.0.0.2", "", vec![]),
                    ],
                )],
            )],
        ))
    };
    let mut cache = IslandCache::default();
    for (pass, display) in ["block", "flex"].into_iter().enumerate() {
        let s = parse(&page(display));
        let resolved = cache.resolve(&s, Some(pass as u64 + 1)).unwrap();
        let edited = readback::layout_boxes(&resolved.island)["$0.0.0.0"].scroll;
        cache.keep(s.clone(), resolved);
        let fresh = IslandCache::default().resolve(&s, None).unwrap();
        let want = readback::layout_boxes(&fresh.island)["$0.0.0.0"].scroll;
        assert_eq!(edited, want, "display: {display}");
    }
}

/// A box an edit makes `display: contents`, or non-atomic inline content, keeps no layout children: they are laid out
/// by the box around it now, and point at it as their layout parent (Blitz's debug check; damage propagation follows
/// it). Fuzz seeds 27 and 1048582.
#[test]
fn a_box_that_stops_being_one_gives_up_its_layout_children() {
    let contents = |display: &str| {
        request(el(
            "div",
            "$0",
            "position: absolute; inset: 0; display: grid",
            vec![el(
                "p",
                "$0.0",
                &format!("display: {display}"),
                vec![el(
                    "div",
                    "$0.0.0",
                    "width: 10px; height: 10px; background: #f80",
                    vec![],
                )],
            )],
        ))
    };
    let inline = |display: &str| {
        request(el(
            "div",
            "$0",
            "position: absolute; inset: 0; font: 16px 'DM Sans'",
            vec![
                text("a"),
                el(
                    "span",
                    "$0.1",
                    "",
                    vec![el(
                        "div",
                        "$0.1.0",
                        &format!("display: {display}; width: 10px; height: 10px; background: #f80"),
                        vec![],
                    )],
                ),
                text("b"),
            ],
        ))
    };
    let pages = [
        [contents("block"), contents("contents")],
        [inline("block"), inline("inline-block")],
    ];
    for [first, edited] in &pages {
        let mut cache = IslandCache::default();
        drawn(&mut cache, first, Some(1));
        assert_eq!(
            drawn(&mut cache, edited, Some(2)),
            drawn(&mut IslandCache::default(), edited, None)
        );
    }
}

/// An empty box whose only layout child was its `::before`, made `display: contents` as the pseudo-element goes,
/// keeps no layout children: the freed pseudo-element is not one (fuzz seed 581).
#[test]
fn an_emptied_box_made_display_contents_keeps_no_freed_pseudo_element() {
    let page = |class: &str| {
        let mut r = request(el(
            "div",
            "$0",
            "position: absolute; inset: 0; font: 16px 'DM Sans'",
            vec![el_attrs(
                "div",
                "$0.0",
                json!({ "class": class }),
                "padding: 9px; border: 2px solid #789",
                vec![],
            )],
        ));
        r["stylesheets"] = json!([
            ".star::before { content: '*'; color: crimson } .contents { display: contents }"
        ]);
        r
    };
    let (first, edited) = (page("star"), page("contents"));
    let mut cache = IslandCache::default();
    drawn(&mut cache, &first, Some(1));
    assert_eq!(
        drawn(&mut cache, &edited, Some(2)),
        drawn(&mut IslandCache::default(), &edited, None)
    );
}

/// A flex box an edit hides inside an inline root keeps none of the layout or paint children it had: when the inline
/// content beside it goes too and its parent lays it out as a block child, the old anonymous block holding its text
/// was drawn (fuzz seed 1048688).
#[test]
fn a_box_hidden_inside_inline_content_keeps_no_old_children() {
    let page = |span: &str, em: &str| {
        request(el(
            "div",
            "$0",
            "position: absolute; inset: 0; font: 16px 'DM Sans'",
            vec![el(
                "p",
                "$0.0",
                "",
                vec![
                    el("span", "$0.0.0", &format!("display: {span}"), vec![text("1234")]),
                    el("em", "$0.0.1", &format!("display: {em}"), vec![text("delta")]),
                ],
            )],
        ))
    };
    let frames = [
        page("flex", "inline"),
        page("none", "inline"),
        page("none", "none"),
    ];
    let mut cache = IslandCache::default();
    for (i, f) in frames.iter().enumerate() {
        assert_eq!(
            drawn(&mut cache, f, Some(i as u64 + 1)),
            drawn(&mut IslandCache::default(), f, None),
            "frame {i}"
        );
    }
}

/// An inline-block whose first line is measured from the cache sits on that line's baseline: a measurement taken from
/// taffy's cache keeps no baselines, so an edit inside the box (a transform) gave it the baseline of the block after
/// the line, and the line round it lost height (fuzz seed 1052669).
#[test]
fn an_edited_inline_block_keeps_the_baseline_of_its_cached_first_line() {
    let page = |transform: &str| {
        request(el(
            "div",
            "$0",
            "position: absolute; inset: 0; font: 16px 'DM Sans'",
            vec![el(
                "div",
                "$0.0",
                "position: absolute; background: #345",
                vec![
                    el(
                        "em",
                        "$0.0.0",
                        "display: inline-block; font-size: 8px",
                        vec![
                            text("alpha"),
                            el(
                                "p",
                                "$0.0.0.1",
                                &format!("padding: 8px; width: 116px; transform: {transform}"),
                                vec![text("beta")],
                            ),
                        ],
                    ),
                    text("gamma"),
                ],
            )],
        ))
    };
    let (first, edited) = (page("scale(1.3)"), page("none"));
    let mut cache = IslandCache::default();
    drawn(&mut cache, &first, Some(1));
    assert_eq!(
        drawn(&mut cache, &edited, Some(2)),
        drawn(&mut IslandCache::default(), &edited, None)
    );
}

/// A box whose font size changes while it is `display: none` draws its `::before` in the new size once it shows: the
/// pseudo-element kept while it was hidden was given the new style there, and nothing rebuilt its text (fuzz seeds
/// 6269 and 1056777).
#[test]
fn a_pseudo_element_restyled_while_hidden_is_drawn_in_its_new_style() {
    let page = |style: &str| {
        let mut r = request(el(
            "div",
            "$0",
            "position: absolute; inset: 0; font: 16px 'DM Sans'",
            vec![el_attrs("div", "$0.0", json!({ "class": "star" }), style, vec![])],
        ));
        r["stylesheets"] = json!([".star::before { content: '*'; color: crimson }"]);
        r
    };
    let frames = [
        page(""),
        page("display: none; font-size: 13px"),
        page("display: contents; font-size: 13px"),
    ];
    let mut cache = IslandCache::default();
    for (i, f) in frames.iter().enumerate() {
        assert_eq!(
            drawn(&mut cache, f, Some(i as u64 + 1)),
            drawn(&mut IslandCache::default(), f, None),
            "frame {i}"
        );
    }
}

/// A fresh document draws the `::before` of an inline element two levels inside an inline root: Blitz decided whether
/// to look inside a child from the root's display, not the child's, so it never did (fuzz seeds 9645, 9919, 1054367,
/// 1056915 and 1057946, where the edited document drew it and the fresh one did not).
#[test]
fn a_fresh_document_draws_the_pseudo_element_of_a_nested_inline() {
    let page = |sheet: &str| {
        let mut r = request(el(
            "div",
            "$0",
            "position: absolute; inset: 0; font: 16px 'DM Sans'",
            vec![el(
                "span",
                "$0.0",
                "",
                vec![el_attrs("span", "$0.0.0", json!({ "class": "star" }), "", vec![text("x")])],
            )],
        ));
        r["stylesheets"] = json!([sheet]);
        r
    };
    assert_ne!(
        drawn(&mut IslandCache::default(), &page(".star::before { content: '*'; color: crimson }"), None),
        drawn(&mut IslandCache::default(), &page(""), None),
    );
}

/// A block inside a `display: contents` element inside inline content breaks the line, as it does with an inline
/// element there: Blitz did not look through the contents element for it, so it laid the block out as an inline box
/// on the line, and an edit that made the element inline left the inline beside the block with no box (fuzz seed
/// 1056963).
#[test]
fn a_block_inside_display_contents_inside_inline_content_breaks_the_line() {
    let page = |b: &str| {
        request(el(
            "div",
            "$0",
            "position: absolute; inset: 0; font: 16px 'DM Sans'",
            vec![el(
                "em",
                "$0.0",
                "",
                vec![
                    el(
                        "b",
                        "$0.0.0",
                        &format!("display: {b}"),
                        vec![
                            text("alpha"),
                            el("span", "$0.0.0.1", "", vec![text("beta"), el("div", "$0.0.0.1.1", "", vec![])]),
                        ],
                    ),
                    text("gamma"),
                ],
            )],
        ))
    };
    let (_, _, width, _) = bounds(&resolve(&page("contents")), "$0.0.0.1.1");
    assert_eq!(width, 1000.0, "the block takes the line's width");
    let mut cache = IslandCache::default();
    drawn(&mut cache, &page("contents"), Some(1));
    assert_eq!(
        drawn(&mut cache, &page("inline"), Some(2)),
        drawn(&mut IslandCache::default(), &page("inline"), None)
    );
}

/// An edit that gives elements other paths, as adding or taking away a sibling before them does while the tree keeps
/// its shape, finds them by the new paths: the document kept the paths it was built with, so its boxes were read back
/// under the old ones (fuzz seeds 1050087, 1051753, 1051937, 1053790 and 1053819).
#[test]
fn an_element_given_another_path_is_found_by_it() {
    let page = |a: &str, b: &str| {
        request(el(
            "div",
            "$0",
            "position: absolute; inset: 0",
            vec![
                el("div", a, "width: 10px; height: 10px", vec![]),
                el("div", b, "width: 20px; height: 20px", vec![]),
            ],
        ))
    };
    let (first, edited) = (page("$0.0", "$0.1"), page("$0.1", "$0.2"));
    let mut cache = IslandCache::default();
    drawn(&mut cache, &first, Some(1));
    let request = parse(&edited);
    let resolved = cache.resolve(&request, Some(2)).unwrap();
    let fresh = IslandCache::default().resolve(&request, None).unwrap();
    let paths = |r: &kinetograph_dom::document::Resolved| {
        readback::layout_boxes(&r.island)
            .into_iter()
            .map(|(path, b)| (path, b.width))
            .collect::<Vec<_>>()
    };
    assert_eq!(paths(&resolved), paths(&fresh));
}

/// Every rect shape in `layers`, as its width and height.
fn rects(layers: &Value, out: &mut Vec<(f64, f64)>) {
    match layers {
        Value::Array(list) => list.iter().for_each(|l| rects(l, out)),
        Value::Object(layer) => {
            if let Some(shape) = layer.get("shape")
                && let (Some(w), Some(h)) = (shape["width"].as_f64(), shape["height"].as_f64())
            {
                out.push((w, h));
            }
            if let Some(children) = layer.get("children") {
                rects(children, out);
            }
        }
        _ => {}
    }
}

#[test]
fn an_element_that_starts_with_no_size_or_no_paint_is_drawn_once_it_grows() {
    // Each bar starts at zero width, zero height, `display: none` or `opacity: 0` and gets its size by pass 3.
    let frame = |width: f64, height: f64, shown: bool| {
        let bar = |i: usize, style: String| el("div", &format!("$0.{i}"), &style, vec![]);
        let base = "position: absolute; left: 4px; background: #264653;";
        let display = if shown { "block" } else { "none" };
        let alpha = if shown { 1 } else { 0 };
        let bars = vec![
            bar(0, format!("{base} top: 0px; width: {width}px; height: 8px")),
            bar(1, format!("{base} top: 10px; width: 40px; height: {height}px")),
            bar(2, format!("{base} top: 20px; width: 60px; height: 8px; display: {display}")),
            bar(3, format!("{base} top: 30px; width: 70px; height: 8px; opacity: {alpha}")),
        ];
        request(el("div", "$0", "position: absolute; inset: 0", bars))
    };
    let mut cache = IslandCache::default();
    let mut fresh = IslandCache::default();
    let mut seen = vec![];
    for (pass, (width, height, shown)) in [(0.0, 0.0, false), (25.0, 4.0, false), (50.0, 8.0, true)]
        .into_iter()
        .enumerate()
    {
        let s = frame(width, height, shown);
        let edited = drawn(&mut cache, &s, Some(pass as u64 + 1));
        assert_eq!(edited, drawn(&mut fresh, &s, None), "pass {pass}");
        let mut boxes = vec![];
        rects(&serde_json::from_str(&edited).unwrap(), &mut boxes);
        seen.push(boxes);
    }
    let has = |boxes: &[(f64, f64)], w: f64, h: f64| {
        boxes.iter().any(|b| (b.0 - w).abs() < 0.01 && (b.1 - h).abs() < 0.01)
    };
    assert!(!has(&seen[0], 0.0, 8.0) && !has(&seen[0], 40.0, 0.0), "{:?}", seen[0]);
    assert!(has(&seen[1], 25.0, 8.0) && has(&seen[1], 40.0, 4.0), "{:?}", seen[1]);
    assert!(!has(&seen[1], 60.0, 8.0), "display: none draws nothing: {:?}", seen[1]);
    assert!(has(&seen[2], 50.0, 8.0) && has(&seen[2], 40.0, 8.0), "{:?}", seen[2]);
    assert!(has(&seen[2], 60.0, 8.0) && has(&seen[2], 70.0, 8.0), "{:?}", seen[2]);
}

