//! Readback: layout boxes, transformed bounding rects and computed styles.

mod common;

use common::*;
use kinetograph_dom::readback::{self, ElementBox};
use serde_json::json;

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 0.05
}

fn rect_close(r: &readback::Rect, x: f64, y: f64, w: f64, h: f64) -> bool {
    close(r.x, x) && close(r.y, y) && close(r.width, w) && close(r.height, h)
}

/// The boxes of a 100 x 50 element at (10, 20) with the given extra style.
fn boxed(style: &str) -> ElementBox {
    let root = el(
        "div",
        "$0",
        "position: relative",
        vec![el(
            "div",
            "$0.0",
            &format!(
                "position: absolute; left: 10px; top: 20px; width: 100px; height: 50px; {style}"
            ),
            vec![],
        )],
    );
    let island = resolve(&request(root));
    readback::layout_boxes(&island)["$0.0"]
}

#[test]
fn plain_box() {
    let b = boxed("");
    assert_eq!((b.x, b.y, b.width, b.height), (10.0, 20.0, 100.0, 50.0));
    assert!(rect_close(&b.rect, 10.0, 20.0, 100.0, 50.0));
    assert_eq!((b.client.width, b.client.height), (100.0, 50.0));
    assert_eq!((b.scroll.width, b.scroll.height), (100.0, 50.0));
}

#[test]
fn translate_moves_the_rect_not_the_offset_box() {
    let b = boxed("transform: translate(30px, 5px)");
    assert_eq!((b.x, b.y, b.width, b.height), (10.0, 20.0, 100.0, 50.0));
    assert!(rect_close(&b.rect, 40.0, 25.0, 100.0, 50.0), "{:?}", b.rect);
}

#[test]
fn rotate_about_the_centre() {
    let b = boxed("transform: rotate(90deg)");
    // Centre (60, 45); a quarter turn swaps the sides.
    assert!(rect_close(&b.rect, 35.0, -5.0, 50.0, 100.0), "{:?}", b.rect);
    let b = boxed("transform: rotate(45deg)");
    let diag = (100.0 + 50.0) / 2.0_f64.sqrt();
    assert!(
        rect_close(&b.rect, 60.0 - diag / 2.0, 45.0 - diag / 2.0, diag, diag),
        "{:?}",
        b.rect
    );
}

#[test]
fn scale_and_transform_origin() {
    let b = boxed("transform: scale(2, 3); transform-origin: 0 0");
    assert!(
        rect_close(&b.rect, 10.0, 20.0, 200.0, 150.0),
        "{:?}",
        b.rect
    );
    let b = boxed("transform: scale(0.5)");
    assert!(rect_close(&b.rect, 35.0, 32.5, 50.0, 25.0), "{:?}", b.rect);
}

#[test]
fn individual_transform_properties_compose_in_css_order() {
    // translate, then rotate, then scale, then transform: the transform is applied to the box first.
    let b = boxed("translate: 10px 0; scale: 2; transform-origin: 0 0");
    assert!(
        rect_close(&b.rect, 20.0, 20.0, 200.0, 100.0),
        "{:?}",
        b.rect
    );
    let b = boxed("rotate: 90deg");
    assert!(rect_close(&b.rect, 35.0, -5.0, 50.0, 100.0), "{:?}", b.rect);
}

#[test]
fn skew() {
    let b = boxed("transform: skewX(45deg); transform-origin: 0 0");
    // x' = x + y * tan(45) = x + y: widens by the height.
    assert!(rect_close(&b.rect, 10.0, 20.0, 150.0, 50.0), "{:?}", b.rect);
}

#[test]
fn transforms_of_ancestors_apply_to_descendants() {
    let root = el(
        "div",
        "$0",
        "",
        vec![el(
            "div",
            "$0.0",
            "width: 200px; height: 100px; transform: translate(50px, 0) scale(2); transform-origin: 0 0",
            vec![el(
                "div",
                "$0.0.0",
                "margin-left: 10px; width: 20px; height: 10px",
                vec![],
            )],
        )],
    );
    let island = resolve(&request(root));
    let boxes = readback::layout_boxes(&island);
    let child = boxes["$0.0.0"];
    // Offset box is untransformed, relative to the island.
    assert_eq!(
        (child.x, child.y, child.width, child.height),
        (10.0, 0.0, 20.0, 10.0)
    );
    assert!(
        rect_close(&child.rect, 70.0, 0.0, 40.0, 20.0),
        "{:?}",
        child.rect
    );
    let parent = boxes["$0.0"];
    assert!(
        rect_close(&parent.rect, 50.0, 0.0, 400.0, 200.0),
        "{:?}",
        parent.rect
    );
}

#[test]
fn perspective_and_rotate_y() {
    let b = boxed(
        "width: 100px; height: 100px; left: 0; top: 0; transform: perspective(500px) rotateY(45deg)",
    );
    // Centre (50, 50). x = +-50 goes to x' = 35.355 at z' = -+35.355; w = 1 -+ 0.0707.
    assert!(
        rect_close(&b.rect, 50.0 - 38.04, 50.0 - 53.8, 71.06, 107.6),
        "{:?}",
        b.rect
    );
}

#[test]
fn perspective_property_on_the_parent() {
    let root = el(
        "div",
        "$0",
        "perspective: 500px; width: 100px; height: 100px; perspective-origin: 50% 50%",
        vec![el(
            "div",
            "$0.0",
            "width: 100px; height: 100px; transform: rotateY(45deg)",
            vec![],
        )],
    );
    let island = resolve(&request(root));
    let b = readback::layout_boxes(&island)["$0.0"];
    assert!(
        rect_close(&b.rect, 50.0 - 38.04, 50.0 - 53.8, 71.06, 107.6),
        "{:?}",
        b.rect
    );
}

#[test]
fn flat_parent_flattens_but_preserve_3d_keeps_depth() {
    // Child rotated about X by 60deg inside a parent rotated about X by 60deg:
    // preserve-3d composes them in 3D (a 120deg turn); flat flattens the child
    // into the parent's plane first (a 60deg foreshortening then another).
    let make = |style: &str| {
        let root = el(
            "div",
            "$0",
            &format!("width: 100px; height: 100px; transform: rotateX(60deg); {style}"),
            vec![el(
                "div",
                "$0.0",
                "width: 100px; height: 100px; transform: rotateX(60deg)",
                vec![],
            )],
        );
        readback::layout_boxes(&resolve(&request(root)))["$0.0"].rect
    };
    let flat = make("");
    let deep = make("transform-style: preserve-3d");
    // Flat: 100 * cos60 * cos60 = 25 tall. Preserve-3d: 100 * |cos120| = 50 tall.
    assert!(close(flat.height, 25.0), "{flat:?}");
    assert!(close(deep.height, 50.0), "{deep:?}");
}

#[test]
fn inline_elements_report_their_line_fragments() {
    let root = el(
        "div",
        "$0",
        "width: 200px; font-family: 'DM Sans'; font-size: 20px; line-height: 30px",
        vec![
            text("ab "),
            el(
                "span",
                "$0.1",
                "",
                vec![text("cd ef gh ij kl mn op qr st uv wx yz")],
            ),
        ],
    );
    let island = resolve(&request(root));
    let boxes = readback::layout_boxes(&island);
    let span = boxes["$0.1"];
    // Wrapped over several lines. Chrome's box for an inline is the font's content
    // area (26px for DM Sans at 20px), not the 30px line: the lines add up to
    // (lines - 1) * 30 + 26.
    assert!(span.height >= 56.0, "{span:?}");
    assert!(
        ((span.height - 26.0) / 30.0).fract().abs() < 1e-3,
        "{span:?}"
    );
    assert!(span.width > 100.0 && span.width <= 200.0, "{span:?}");
    assert_eq!((span.client.width, span.client.height), (0.0, 0.0));
}

#[test]
fn hidden_and_boxless_elements_are_zero() {
    let root = el(
        "div",
        "$0",
        "",
        vec![
            el(
                "div",
                "$0.0",
                "display: none; width: 10px; height: 10px",
                vec![],
            ),
            el("div", "$0.1", "display: contents", vec![]),
        ],
    );
    let island = resolve(&request(root));
    let boxes = readback::layout_boxes(&island);
    assert_eq!(boxes["$0.0"], ElementBox::default());
    assert_eq!(boxes["$0.1"], ElementBox::default());
}

#[test]
fn client_and_scroll_sizes() {
    let root = el(
        "div",
        "$0",
        "width: 100px; height: 60px; padding: 5px; border: 3px solid; box-sizing: border-box; overflow: hidden",
        vec![el("div", "$0.0", "width: 300px; height: 200px", vec![])],
    );
    let island = resolve(&request(root));
    let b = readback::layout_boxes(&island)["$0"];
    assert_eq!((b.width, b.height), (100.0, 60.0));
    // Padding box: border box minus 2 * 3.
    assert_eq!((b.client.width, b.client.height), (94.0, 54.0));
    // Content 300 x 200 starting 5 + 3 in, plus the padding at the far side.
    assert!(b.scroll.width >= 300.0 && b.scroll.height >= 200.0, "{b:?}");
}

#[test]
fn native_placeholders_have_boxes() {
    let root = el(
        "div",
        "$0",
        "padding-left: 7px",
        vec![json!({ "kind": "native", "path": "$0.0", "width": 30.0, "height": 20.0 })],
    );
    let island = resolve(&request(root));
    let b = readback::layout_boxes(&island)["$0.0"];
    assert_eq!((b.x, b.y, b.width, b.height), (7.0, 0.0, 30.0, 20.0));
}

#[test]
fn layout_boxes_serialize_as_the_contract_says() {
    let island = resolve(&request(el(
        "div",
        "$0",
        "width: 10px; height: 5px",
        vec![],
    )));
    let value = serde_json::to_value(readback::layout_boxes(&island)).unwrap();
    assert_eq!(
        value["$0"],
        json!({
            "x": 0.0, "y": 0.0, "width": 10.0, "height": 5.0,
            "rect": { "x": 0.0, "y": 0.0, "width": 10.0, "height": 5.0 },
            "client": { "width": 10.0, "height": 5.0 },
            "scroll": { "width": 10.0, "height": 5.0 }
        })
    );
}

#[test]
fn computed_styles() {
    let root = el(
        "div",
        "$0",
        "font-size: 20px; color: rgb(255, 0, 0); width: 50%; height: 30px; margin-left: 5px; \
         transform: translate(10px, 5px); --accent: 12px; display: flex",
        vec![el(
            "span",
            "$0.0",
            "font-size: 2em; font-weight: bold",
            vec![text("x")],
        )],
    );
    let island = resolve(&request(root));
    let get = |path: &str, props: &[&str]| {
        readback::computed_style(
            &island,
            path,
            &props.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        )
        .unwrap()
    };
    let v = get(
        "$0",
        &[
            "fontSize",
            "color",
            "width",
            "height",
            "marginLeft",
            "transform",
            "--accent",
            "display",
            "nonsense",
        ],
    );
    assert_eq!(v[0], "20px");
    assert_eq!(v[1], "rgb(255, 0, 0)");
    assert_eq!(v[2], "500px");
    assert_eq!(v[3], "30px");
    assert_eq!(v[4], "5px");
    assert_eq!(v[5], "matrix(1, 0, 0, 1, 10, 5)");
    assert_eq!(v[6], "12px");
    assert_eq!(v[7], "flex");
    assert_eq!(v[8], "");
    // Inherited and relative values.
    let c = get("$0.0", &["font-size", "font-weight", "color"]);
    assert_eq!(c, ["40px", "700", "rgb(255, 0, 0)"]);
    assert!(readback::computed_style(&island, "$9", &[]).is_none());
}
