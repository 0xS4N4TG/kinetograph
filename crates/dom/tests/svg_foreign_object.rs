//! A `<foreignObject>` in an `<svg>` holds HTML: it is laid out as a block of the object's width and
//! height, painted by the HTML painter, cut to its box, and carried through the SVG's transforms.
//! Before, one block element in it (a `div`, a `p`) made the whole `<svg>` vanish.

mod common;

use std::path::PathBuf;

use common::*;
use kinetograph_core::{Frame, Scene, render_still};
use kinetograph_dom::document::IslandCache;
use kinetograph_dom::request::IslandOutput;
use serde_json::{Value, json};

const WIDTH: u32 = 300;
const HEIGHT: u32 = 200;

fn svg(attrs: Value, children: Vec<Value>) -> Value {
    el_attrs("svg", "$0.0", attrs, "", children)
}

/// A `foreignObject` at `path` holding `children`.
fn fo(path: &str, x: &str, y: &str, w: &str, h: &str, style: &str, children: Vec<Value>) -> Value {
    el_attrs(
        "foreignObject",
        path,
        json!({ "x": x, "y": y, "width": w, "height": h }),
        style,
        children,
    )
}

fn rect(path: &str, x: &str, y: &str, w: &str, h: &str, fill: &str) -> Value {
    el_attrs(
        "rect",
        path,
        json!({ "x": x, "y": y, "width": w, "height": h, "fill": fill }),
        "",
        vec![],
    )
}

/// A request for `svg` in a `WIDTH` x `HEIGHT` page.
fn page(svg: Value) -> Value {
    let mut req = request(el("div", "$0", "", vec![svg]));
    req["viewport"] = json!({ "width": WIDTH, "height": HEIGHT });
    req
}

fn paint(req: &Value) -> IslandOutput {
    let parsed = parse(req);
    let island = kinetograph_dom::document::resolve(&parsed).expect("resolves");
    kinetograph_dom::paint::paint(&island.doc, &parsed)
}

fn render(out: &IslandOutput) -> Frame {
    let scene = json!({
        "width": WIDTH, "height": HEIGHT, "fps": 30, "durationInFrames": 1,
        "background": "#ffffff", "layers": out.layers,
    });
    render_still(
        Scene::from_json(&scene.to_string(), PathBuf::new()).unwrap(),
        0,
    )
    .unwrap()
}

/// The page painted and rendered; nothing may be reported unsupported.
fn drawn(req: &Value) -> Frame {
    let out = paint(req);
    assert!(
        out.unsupported.is_empty(),
        "unsupported: {:?}",
        out.unsupported
    );
    render(&out)
}

fn px(f: &Frame, x: u32, y: u32) -> [u8; 3] {
    let i = ((y * f.width + x) * 4) as usize;
    [f.rgba[i], f.rgba[i + 1], f.rgba[i + 2]]
}

const WHITE: [u8; 3] = [255, 255, 255];
const RED: [u8; 3] = [255, 0, 0];
const GREEN: [u8; 3] = [0, 255, 0];
const BLUE: [u8; 3] = [0, 0, 255];

fn block(path: &str, style: &str, children: Vec<Value>) -> Value {
    el("div", path, style, children)
}

/// The case that dropped the whole `<svg>`: a block element inside a `foreignObject`. The block, and the shape
/// beside the `foreignObject`, are both drawn.
#[test]
fn a_div_in_a_foreign_object_is_drawn_and_so_is_its_sibling() {
    let div = block("$0.0.0.0", "width:50px;height:20px;background:#f00", vec![]);
    let f = drawn(&page(svg(
        json!({ "width": "200", "height": "100", "viewBox": "0 0 200 100" }),
        vec![
            fo("$0.0.0", "10", "10", "100", "50", "", vec![div]),
            rect("$0.0.1", "0", "60", "20", "20", "#0000ff"),
        ],
    )));
    assert_eq!(px(&f, 20, 20), RED);
    assert_eq!(px(&f, 58, 28), RED);
    assert_eq!(px(&f, 62, 20), WHITE, "right of the div");
    assert_eq!(px(&f, 20, 34), WHITE, "below the div");
    assert_eq!(px(&f, 5, 65), BLUE, "the sibling rect");
}

/// `p`, nested blocks, padding and margin: the HTML painter's backgrounds at the places block layout puts them.
#[test]
fn paragraphs_and_nested_blocks_are_laid_out_as_blocks() {
    let p = el(
        "p",
        "$0.0.0.0.0",
        "margin:0;height:10px;background:#00f",
        vec![],
    );
    let inner = block("$0.0.0.0", "padding:5px;background:#0f0", vec![p]);
    let f = drawn(&page(svg(
        json!({ "width": "200", "height": "100", "viewBox": "0 0 200 100" }),
        vec![fo("$0.0.0", "20", "10", "100", "60", "", vec![inner])],
    )));
    // The green block fills the object's width and wraps a 10px paragraph in 5px of padding: 100 x 20 at (20, 10).
    assert_eq!(px(&f, 22, 12), GREEN, "the padding");
    assert_eq!(px(&f, 25, 15), BLUE, "the paragraph's corner");
    assert_eq!(px(&f, 114, 24), BLUE, "the paragraph's other corner");
    assert_eq!(px(&f, 118, 28), GREEN, "padding under the paragraph");
    assert_eq!(px(&f, 60, 40), WHITE, "below the block");
}

/// A flex container in a `foreignObject`: its items are placed side by side.
#[test]
fn a_flex_container_in_a_foreign_object_places_its_items() {
    let a = block(
        "$0.0.0.0.0",
        "width:30px;height:20px;background:#f00",
        vec![],
    );
    let b = block(
        "$0.0.0.0.1",
        "width:30px;height:20px;background:#0f0",
        vec![],
    );
    let row = block("$0.0.0.0", "display:flex;gap:10px;width:100%", vec![a, b]);
    let f = drawn(&page(svg(
        json!({ "width": "200", "height": "100", "viewBox": "0 0 200 100" }),
        vec![fo("$0.0.0", "10", "10", "100", "50", "", vec![row])],
    )));
    assert_eq!(px(&f, 20, 20), RED);
    assert_eq!(px(&f, 45, 20), WHITE, "the gap");
    assert_eq!(px(&f, 55, 20), GREEN);
    assert_eq!(px(&f, 55, 35), WHITE, "below the items");
}

/// The `viewBox` scales the HTML with the rest of the SVG.
#[test]
fn a_view_box_scales_the_foreign_object() {
    let div = block("$0.0.0.0", "width:50px;height:20px;background:#f00", vec![]);
    let f = drawn(&page(svg(
        json!({ "width": "400", "height": "200", "viewBox": "0 0 200 100" }),
        vec![fo("$0.0.0", "10", "10", "100", "50", "", vec![div])],
    )));
    // x 10..60 and y 10..30 in the SVG are 20..120 and 20..60 on the page.
    assert_eq!(px(&f, 22, 22), RED);
    assert_eq!(px(&f, 118, 58), RED);
    assert_eq!(px(&f, 122, 40), WHITE);
    assert_eq!(px(&f, 60, 62), WHITE);
}

/// A transform on a parent turns the HTML with it.
#[test]
fn a_rotated_group_turns_the_foreign_object() {
    let div = block(
        "$0.0.0.0.0",
        "width:60px;height:20px;background:#f00",
        vec![],
    );
    let group = el_attrs(
        "g",
        "$0.0.0",
        json!({ "transform": "translate(100 0) rotate(90)" }),
        "",
        vec![fo("$0.0.0.0", "0", "0", "60", "20", "", vec![div])],
    );
    let f = drawn(&page(svg(
        json!({ "width": "200", "height": "100", "viewBox": "0 0 200 100" }),
        vec![group],
    )));
    // A quarter turn about (100, 0) puts the 60 x 20 box at x 80..100, y 0..60.
    assert_eq!(px(&f, 90, 30), RED);
    assert_eq!(px(&f, 90, 56), RED);
    assert_eq!(px(&f, 110, 10), WHITE);
    assert_eq!(px(&f, 40, 10), WHITE, "where it would be unturned");
}

/// A skew is no rotation and scale: the HTML is carried by a matrix.
#[test]
fn a_skewed_group_carries_the_foreign_object_by_a_matrix() {
    let div = block(
        "$0.0.0.0.0",
        "width:40px;height:40px;background:#00f",
        vec![],
    );
    let group = el_attrs(
        "g",
        "$0.0.0",
        json!({ "transform": "translate(10 10) skewX(45)" }),
        "",
        vec![fo("$0.0.0.0", "0", "0", "40", "40", "", vec![div])],
    );
    let f = drawn(&page(svg(
        json!({ "width": "200", "height": "100", "viewBox": "0 0 200 100" }),
        vec![group],
    )));
    // skewX(45) moves a point right by its y: the top edge stays at x 10..50, the bottom is at x 50..90.
    assert_eq!(px(&f, 15, 12), BLUE);
    assert_eq!(px(&f, 85, 47), BLUE);
    assert_eq!(px(&f, 15, 47), WHITE, "the bottom left has moved away");
}

/// The object's box cuts its content (`overflow: hidden`); the property can ask for more.
#[test]
fn the_box_clips_the_content_unless_overflow_is_visible() {
    let big = |path: &str| block(path, "width:100px;height:100px;background:#0f0", vec![]);
    let clipped = fo("$0.0.0", "10", "10", "40", "20", "", vec![big("$0.0.0.0")]);
    let open = fo(
        "$0.0.1",
        "110",
        "10",
        "40",
        "20",
        "overflow:visible",
        vec![big("$0.0.1.0")],
    );
    let f = drawn(&page(svg(
        json!({ "width": "300", "height": "150", "viewBox": "0 0 300 150" }),
        vec![clipped, open],
    )));
    assert_eq!(px(&f, 30, 20), GREEN, "inside");
    assert_eq!(px(&f, 60, 20), WHITE, "right of the box");
    assert_eq!(px(&f, 20, 40), WHITE, "below the box");
    assert_eq!(px(&f, 130, 20), GREEN, "inside, overflow visible");
    assert_eq!(px(&f, 160, 20), GREEN, "right of the box, overflow visible");
}

/// Text in a `foreignObject` goes through the text painter, at the object's place.
#[test]
fn text_in_a_foreign_object_is_text_at_the_objects_place() {
    let label = el_attrs(
        "div",
        "$0.0.0.0",
        json!({}),
        "font-family:'DM Sans';font-size:20px;color:#123456",
        vec![text("Hello")],
    );
    let out = paint(&page(svg(
        json!({ "width": "200", "height": "100", "viewBox": "0 0 200 100" }),
        vec![fo("$0.0.0", "30", "40", "100", "30", "", vec![label])],
    )));
    assert!(out.unsupported.is_empty(), "{:?}", out.unsupported);
    fn find(v: &Value, acc: &mut Vec<Value>) {
        if v["type"] == "text" {
            acc.push(v.clone());
        }
        for c in v["children"].as_array().into_iter().flatten() {
            find(c, acc);
        }
    }
    let mut texts = Vec::new();
    for l in &out.layers {
        find(l, &mut texts);
    }
    assert_eq!(texts.len(), 1, "{texts:?}");
    assert_eq!(texts[0]["color"], "#123456");
    assert_eq!(texts[0]["transform"]["x"], 30.0);
    assert_eq!(texts[0]["transform"]["y"], 40.0);
}

/// What cannot be drawn is said, and the shapes beside it are drawn anyway.
#[test]
fn a_foreign_object_that_cannot_be_drawn_is_reported_and_its_siblings_are_drawn() {
    let div = block("$0.0.0.0", "width:50px;height:20px;background:#f00", vec![]);
    let req = page(svg(
        json!({ "width": "200", "height": "100", "viewBox": "0 0 200 100" }),
        vec![
            fo("$0.0.0", "10", "10", "50%", "50", "", vec![div]),
            rect("$0.0.1", "0", "60", "20", "20", "#0000ff"),
        ],
    ));
    let out = paint(&req);
    assert!(
        out.unsupported
            .iter()
            .any(|u| u.element == "foreignObject" && u.reason.contains("percentage")),
        "{:?}",
        out.unsupported
    );
    let f = render(&out);
    assert_eq!(px(&f, 5, 65), BLUE, "the sibling rect");
}

/// Whether the layers hold a text layer.
fn has_text(out: &IslandOutput) -> bool {
    fn find(v: &Value) -> bool {
        v["type"] == "text" || v["children"].as_array().is_some_and(|c| c.iter().any(find))
    }
    out.layers.iter().any(find)
}

/// An inline that holds a block (`<span><p>..</p></span>`, as Mermaid's labels are) is laid out as a block, and its text
/// is painted: it used to be left out, in HTML as in a `foreignObject`.
#[test]
fn an_inline_that_holds_a_block_paints_its_text() {
    let label = |path: &str| {
        let p = el("p", &format!("{path}.0.0"), "margin:0", vec![text("Start")]);
        el(
            "div",
            path,
            "",
            vec![el("span", &format!("{path}.0"), "", vec![p])],
        )
    };
    let mut html = request(el(
        "div",
        "$0",
        "font-family:'DM Sans';font-size:14px",
        vec![label("$0.0")],
    ));
    html["viewport"] = json!({ "width": WIDTH, "height": HEIGHT });
    assert!(has_text(&paint(&html)), "in HTML");

    let out = paint(&page(svg(
        json!({ "width": "200", "height": "100", "viewBox": "0 0 200 100" }),
        vec![fo(
            "$0.0.0",
            "10",
            "10",
            "100",
            "30",
            "font-family:'DM Sans'",
            vec![label("$0.0.0.0")],
        )],
    )));
    assert!(has_text(&out), "in a foreignObject");
}

/// The width of the box at `path` after layout.
fn width_of(req: &Value, path: &str) -> f32 {
    let island = resolve(req);
    let id = island
        .node(path)
        .unwrap_or_else(|| panic!("no node at {path}"));
    island.doc.get_node(id).unwrap().final_layout().size.width
}

/// Libraries centre a label with `display: table-cell` or `table` on a div that is no table part (Mermaid's HTML labels
/// do): an anonymous table sizes to its content, so the box is as wide as the text in a `foreignObject` that has no
/// width yet, as an `inline-block`'s is.
#[test]
fn a_table_cell_or_table_that_is_no_table_part_sizes_to_its_content() {
    let label = |style: &str, size: &str| {
        let div = block(
            "$0.0.0.0",
            &format!("white-space:nowrap;max-width:120px;{style}"),
            vec![text("Start")],
        );
        page(svg(
            json!({ "width": "200", "height": "100", "viewBox": "0 0 200 100",
                    "font-family": "DM Sans", "font-size": "14" }),
            vec![fo("$0.0.0", "10", "10", size, size, "", vec![div])],
        ))
    };
    let shrunk = width_of(&label("display:inline-block", "0"), "$0.0.0.0");
    assert!(shrunk > 20.0 && shrunk < 60.0, "{shrunk}");
    assert_eq!(
        width_of(&label("display:table-cell", "0"), "$0.0.0.0"),
        shrunk
    );
    // A table of that width takes the width asked for, with its text in an anonymous cell.
    assert_eq!(
        width_of(&label("display:table;width:120px", "0"), "$0.0.0.0"),
        120.0
    );
    assert!(
        has_text(&paint(&label("display:table;width:120px", "150"))),
        "the text of the table"
    );
}

/// A `foreignObject` edited from one frame to the next (as the renderer edits a document between frames) draws what
/// a fresh build of the same frame does.
#[test]
fn a_foreign_object_edited_between_frames_draws_as_a_fresh_build_does() {
    let frame = |color: &str, width: &str, rect_fill: &str| {
        let div = block(
            "$0.0.0.0",
            &format!("width:{width}px;height:20px;background:{color}"),
            vec![],
        );
        page(svg(
            json!({ "width": "200", "height": "100", "viewBox": "0 0 200 100" }),
            vec![
                fo("$0.0.0", "10", "10", "100", "50", "", vec![div]),
                rect("$0.0.1", "0", "60", "20", "20", rect_fill),
            ],
        ))
    };
    let layers = |cache: &mut IslandCache, req: &Value, pass: Option<u64>| {
        let request = parse(req);
        let mut resolved = cache.resolve(&request, pass).unwrap();
        let out = serde_json::to_string(&resolved.paint(&request).layers).unwrap();
        cache.keep(request, resolved);
        out
    };
    let frames = [
        frame("#f00", "50", "#0000ff"),
        frame("#0f0", "50", "#0000ff"),
        frame("#0f0", "80", "#0000ff"),
        frame("#0f0", "80", "#ff00ff"),
        frame("#f00", "30", "#ff00ff"),
    ];
    let mut cache = IslandCache::default();
    let mut seen = std::collections::BTreeSet::new();
    for (i, f) in frames.iter().enumerate() {
        let edited = layers(&mut cache, f, Some(i as u64));
        let fresh = layers(&mut IslandCache::default(), f, None);
        assert_eq!(edited, fresh, "frame {i}");
        seen.insert(edited);
    }
    assert_eq!(seen.len(), frames.len(), "the frames differ");
}
