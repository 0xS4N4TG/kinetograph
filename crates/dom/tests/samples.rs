//! The islands of a motion-blur pass: a document edited from one sample to the
//! next draws what a document built from the sample draws.

mod common;

use common::*;
use kinetograph_dom::document::IslandCache;
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
    use kinetograph_dom::request::{delta, undelta};
    let mut cache = IslandCache::default();
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
        let written = delta(later.clone(), &base);
        assert_eq!(undelta(&written, &base), later);
    }
    // The same render is the first's, layer by layer.
    let same = delta(base.clone(), &base);
    assert!(
        same.iter()
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
