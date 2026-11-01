//! Inline elements with margin, border and padding, and the box Chrome gives
//! them. The numbers are Chrome for Testing 154's (`getBoundingClientRect`, see
//! crates/dom/tools/chrome-compare.mjs) for the same tree, DM Sans Medium.

mod common;

use common::*;
use kinetograph_dom::inline;
use kinetograph_dom::readback;
use serde_json::json;

fn near(got: f64, want: f64) -> bool {
    (got - want).abs() < 0.35
}

fn assert_rect(rect: &readback::Rect, x: f64, y: f64, w: f64, h: f64, what: &str) {
    assert!(
        near(rect.x, x) && near(rect.y, y) && near(rect.width, w) && near(rect.height, h),
        "{what}: got {rect:?}, Chrome has {x},{y} {w}x{h}"
    );
}

fn island() -> kinetograph_dom::document::IslandDocument {
    let root = el(
        "div",
        "$0",
        "font-family: 'DM Sans'; font-size: 20px; line-height: 30px; width: 600px",
        vec![
            text("Before "),
            el(
                "span",
                "$0.1",
                "padding: 0 20px; margin: 0 10px; border: 3px solid red; background: #ccc",
                vec![text("padded")],
            ),
            el("span", "$0.2", "", vec![text(" next")]),
            el("br", "$0.3", "", vec![]),
            el(
                "span",
                "$0.4",
                "padding: 8px 0; background: #ccc",
                vec![text("vertical padding")],
            ),
            el("br", "$0.5", "", vec![]),
            el("span", "$0.6", "font-size: 40px", vec![text("Big")]),
            text(" and "),
            el("span", "$0.8", "font-size: 10px", vec![text("tiny")]),
        ],
    );
    resolve(&request(root))
}

#[test]
fn padding_border_and_margin_of_an_inline_move_the_text() {
    let island = island();
    let boxes = readback::layout_boxes(&island);
    // margin 10 + border 3 + padding 20 on each side: the box starts after
    // "Before " + the 10px margin, and the text after it after the other margin.
    assert_rect(&boxes["$0.1"].rect, 76.6, -1.0, 120.1, 32.0, "padded span");
    assert_rect(
        &boxes["$0.2"].rect,
        206.6,
        2.0,
        46.6,
        26.0,
        "the span after it",
    );
}

#[test]
fn an_inline_box_is_the_content_area_of_its_font_plus_vertical_padding() {
    let island = island();
    let boxes = readback::layout_boxes(&island);
    // 26px of ascent and descent for DM Sans at 20px, 8px of padding each side.
    assert_rect(
        &boxes["$0.4"].rect,
        0.0,
        24.0,
        153.0,
        42.0,
        "vertical padding",
    );
    assert_rect(&boxes["$0.6"].rect, 0.0, 49.0, 57.3, 52.0, "40px text");
    assert_rect(&boxes["$0.8"].rect, 103.1, 79.0, 18.1, 13.0, "10px text");
}

#[test]
fn spacers_are_zero_height_boxes_not_part_of_the_path_map() {
    let island = island();
    let spacers = island
        .doc
        .tree()
        .iter()
        .filter(|(_, n)| {
            n.element_data()
                .is_some_and(|e| &*e.name.local == inline::SPACER_TAG)
        })
        .count();
    // Two inside and two outside the padded span.
    assert_eq!(spacers, 4);
    assert!(island.paths.values().all(|id| {
        island
            .doc
            .get_node(*id)
            .and_then(|n| n.element_data())
            .is_some_and(|e| &*e.name.local != inline::SPACER_TAG)
    }));
}

#[test]
fn a_wrapped_inline_has_the_left_edge_on_its_first_line_and_the_right_on_its_last() {
    let root = el(
        "div",
        "$0",
        "font-family: 'DM Sans'; font-size: 20px; line-height: 30px; width: 200px",
        vec![
            text("go "),
            el(
                "span",
                "$0.1",
                "padding: 0 12px; background: #ccc",
                vec![text("one two three four five six seven")],
            ),
        ],
    );
    let island = resolve(&request(root));
    let id = island.node("$0.1").unwrap();
    let fragments = inline::fragments(&island.doc, id).unwrap();
    assert!(fragments.len() >= 2, "{fragments:?}");
    let first = fragments.first().unwrap().rect;
    let last = fragments.last().unwrap().rect;
    // "go " is about 30px wide; the box starts there and ends at the line's end.
    assert!(first.x > 20.0 && first.x < 40.0, "{first:?}");
    // The following lines start at the left edge of the block, with no padding
    // (box-decoration-break: slice).
    assert!(near(last.x, 0.0), "{last:?}");
    // 12px of padding after the last word.
    let text_end = {
        let plain = el(
            "div",
            "$0",
            "font-family: 'DM Sans'; font-size: 20px; line-height: 30px; width: 200px",
            vec![
                text("go "),
                el(
                    "span",
                    "$0.1",
                    "",
                    vec![text("one two three four five six seven")],
                ),
            ],
        );
        let island = resolve(&request(plain));
        inline::fragments(&island.doc, island.node("$0.1").unwrap())
            .unwrap()
            .last()
            .unwrap()
            .rect
    };
    assert!(
        near(last.x + last.width, text_end.x + text_end.width + 12.0),
        "{last:?} {text_end:?}"
    );
}

#[test]
fn right_to_left_inlines_put_the_start_edge_on_the_right() {
    let make = |padding: &str| {
        let root = el(
            "div",
            "$0",
            "font-family: 'DM Sans'; font-size: 20px; width: 300px; direction: rtl",
            vec![el("span", "$0.0", padding, vec![text("abc")])],
        );
        let island = resolve(&request(root));
        readback::layout_boxes(&island)["$0.0"].rect
    };
    let plain = make("");
    let left = make("padding-left: 30px");
    let right = make("padding-right: 30px");
    // Padding on either side widens the box by 30; the text stays at the right edge
    // when the padding is on the left, and moves in when it is on the right.
    assert!(near(left.width, plain.width + 30.0), "{left:?} {plain:?}");
    assert!(near(right.width, plain.width + 30.0), "{right:?} {plain:?}");
    assert!(near(left.x + left.width, 300.0), "{left:?}");
    assert!(near(right.x + right.width, 300.0), "{right:?}");
}

#[test]
fn inline_blocks_and_flex_items_are_untouched() {
    let root = el(
        "div",
        "$0",
        "font-family: 'DM Sans'; font-size: 20px; width: 400px",
        vec![
            el(
                "span",
                "$0.0",
                "display: inline-block; padding: 0 10px; margin: 0 5px; width: 50px; height: 20px",
                vec![],
            ),
            el(
                "div",
                "$0.1",
                "display: flex",
                vec![el(
                    "span",
                    "$0.1.0",
                    "padding: 0 7px; width: 30px; height: 10px",
                    vec![],
                )],
            ),
        ],
    );
    let island = resolve(&request(root));
    let boxes = readback::layout_boxes(&island);
    assert_eq!(boxes["$0.0"].x, 5.0);
    assert_eq!(boxes["$0.0"].width, 70.0);
    assert_eq!(boxes["$0.1.0"].width, 44.0);
    let _ = json!(null);
}

// Bidi isolation (issue #72): in an RTL paragraph an isolated LTR run keeps its sign on the left, `-1.43%`, where
// the same text with no isolation resolves as `1.43%-` (the minus is a neutral between the Hebrew and the digits).
// The boxes of the sign and of the number tell the order, as in Chrome for Testing's rendering of the same tree.
const HEBREW: &str = "\u{5e9}\u{5dc}\u{5d5}\u{5dd} ";

/// A row of an RTL paragraph: `label`, then an element of `tag` and `style` holding the sign and the number in a
/// span each (`<row>.1` is the element, `<row>.1.0` the sign, `<row>.1.1` the number).
fn bidi_row(row: &str, label: &str, tag: &str, style: &str) -> serde_json::Value {
    let (mut kids, k) = if label.is_empty() {
        (Vec::new(), 0)
    } else {
        (vec![text(label)], 1)
    };
    let path = format!("{row}.{k}");
    kids.push(el(
        tag,
        &path,
        style,
        vec![
            el("span", &format!("{path}.0"), "", vec![text("-")]),
            el("span", &format!("{path}.1"), "", vec![text("1.43%")]),
        ],
    ));
    el("div", row, "", kids)
}

fn bidi_island() -> kinetograph_dom::document::IslandDocument {
    let root = el(
        "div",
        "$0",
        "font-family: 'DM Sans'; font-size: 20px; width: 400px; direction: rtl",
        vec![
            bidi_row("$0.0", "", "bdi", ""),
            bidi_row("$0.1", HEBREW, "bdi", ""),
            bidi_row("$0.2", HEBREW, "span", "direction: ltr; unicode-bidi: isolate"),
            bidi_row("$0.3", HEBREW, "span", ""),
            bidi_row("$0.4", HEBREW, "span", "direction: ltr; unicode-bidi: isolate-override"),
            bidi_row("$0.5", HEBREW, "span", "unicode-bidi: plaintext"),
        ],
    );
    resolve(&request(root))
}

#[test]
fn an_isolated_ltr_run_in_an_rtl_paragraph_keeps_its_sign_on_the_left() {
    let island = bidi_island();
    let boxes = readback::layout_boxes(&island);
    let sign_left = |row: &str, k: usize| {
        let sign = &boxes[&format!("{row}.{k}.0")].rect;
        let number = &boxes[&format!("{row}.{k}.1")].rect;
        sign.x < number.x
    };
    assert!(sign_left("$0.0", 0), "<bdi> alone");
    assert!(sign_left("$0.1", 1), "label and <bdi>");
    assert!(sign_left("$0.2", 1), "unicode-bidi: isolate with direction: ltr");
    assert!(sign_left("$0.4", 1), "unicode-bidi: isolate-override");
    assert!(sign_left("$0.5", 1), "unicode-bidi: plaintext, no strong character: left to right");
    // No isolation: the sign is on the right of the number, in Chrome too.
    assert!(!sign_left("$0.3", 1), "no isolation");
}

#[test]
fn an_isolated_run_stays_beside_its_label_and_adds_no_width() {
    let island = bidi_island();
    let boxes = readback::layout_boxes(&island);
    let width = |p: &str| {
        let (a, b) = (&boxes[&format!("{p}.0")].rect, &boxes[&format!("{p}.1")].rect);
        (a.x.min(b.x), (a.x + a.width).max(b.x + b.width))
    };
    let (iso_l, iso_r) = width("$0.1.1");
    let (plain_l, plain_r) = width("$0.3.1");
    assert!(near(iso_r - iso_l, plain_r - plain_l), "same width: {iso_l}..{iso_r} vs {plain_l}..{plain_r}");
    // Both are left of the label, which is at the right edge in both rows.
    assert!(near(iso_r, plain_r), "the run ends where the unisolated one does");
}
