//! Building an island and laying it out: block, flex, grid and inline layout,
//! the containing box and the UA stylesheet.

mod common;

use common::*;
use serde_json::json;

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 0.01
}

#[test]
fn island_is_laid_out_in_the_viewport_sized_box() {
    // An absolutely positioned root with `inset: 0` fills the composition.
    let root = el(
        "div",
        "$0",
        "position: absolute; inset: 0",
        vec![el("div", "$0.0", "width: 50%; height: 25%", vec![])],
    );
    let island = resolve(&request(root));
    assert_eq!(bounds(&island, "$0"), (0.0, 0.0, 1000.0, 500.0));
    assert_eq!(bounds(&island, "$0.0"), (0.0, 0.0, 500.0, 125.0));
}

#[test]
fn block_root_takes_the_composition_width_and_margins_are_zero_on_body() {
    let root = el("div", "$0", "height: 40px", vec![]);
    let island = resolve(&request(root));
    // body has no margin, so the root sits at the origin and fills the line.
    assert_eq!(bounds(&island, "$0"), (0.0, 0.0, 1000.0, 40.0));
}

#[test]
fn flex_layout() {
    let root = el(
        "div",
        "$0",
        "display: flex; gap: 10px; width: 400px",
        vec![
            el("div", "$0.0", "flex: 1; height: 20px", vec![]),
            el("div", "$0.1", "width: 100px; height: 30px", vec![]),
            el("div", "$0.2", "flex: 2; height: 10px", vec![]),
        ],
    );
    let island = resolve(&request(root));
    // 400 - 100 - 2 * 10 = 280 shared 1:2.
    let (x0, _, w0, _) = bounds(&island, "$0.0");
    let (x1, _, w1, _) = bounds(&island, "$0.1");
    let (x2, _, w2, _) = bounds(&island, "$0.2");
    assert!(close(x0, 0.0) && close(w0, 280.0 / 3.0), "{x0} {w0}");
    assert!(close(x1, w0 + 10.0) && close(w1, 100.0));
    assert!(close(x2, x1 + 110.0) && close(w2, 560.0 / 3.0), "{x2} {w2}");
}

#[test]
fn grid_layout_with_place_items_and_calc() {
    let root = el(
        "div",
        "$0",
        "display: grid; grid-template-columns: 100px 1fr 2fr; grid-template-rows: 60px 40px; \
         width: calc(100px + 300px); place-items: center; column-gap: 0",
        vec![
            el("div", "$0.0", "width: 20px; height: 20px", vec![]),
            el("div", "$0.1", "grid-column: span 2; width: 40px; height: 10px", vec![]),
            el("div", "$0.2", "grid-column: 2; grid-row: 2; width: 10px; height: 10px", vec![]),
        ],
    );
    let island = resolve(&request(root));
    // Columns: 100, 100, 200. Item 0 centred in the 100 x 60 cell.
    assert_eq!(bounds(&island, "$0.0"), (40.0, 20.0, 20.0, 20.0));
    // Item 1 spans columns 2 and 3 (100..400), centred.
    assert_eq!(bounds(&island, "$0.1"), (100.0 + 130.0, 25.0, 40.0, 10.0));
    // Item 2 in column 2, row 2 (y 60..100).
    assert_eq!(bounds(&island, "$0.2"), (145.0, 75.0, 10.0, 10.0));
}

#[test]
fn inline_layout_wraps_text_and_places_inline_blocks() {
    let root = el(
        "div",
        "$0",
        "width: 300px; font-family: 'DM Sans'; font-size: 20px; line-height: 30px",
        vec![
            text("alpha "),
            el("span", "$0.1", "display: inline-block; width: 50px; height: 10px", vec![]),
            text(" beta gamma delta epsilon zeta eta theta iota kappa lambda"),
        ],
    );
    let island = resolve(&request(root));
    let (x, _, w, _) = bounds(&island, "$0.1");
    assert!(x > 0.0 && close(w, 50.0), "inline-block at x={x} w={w}");
    let (_, _, bw, bh) = bounds(&island, "$0");
    assert_eq!(bw, 300.0);
    // Several 30px lines.
    assert!(bh >= 60.0 && (bh / 30.0).fract() < 0.001, "height {bh}");
}

#[test]
fn ua_stylesheet_gives_chromes_heading_and_paragraph_defaults() {
    let root = el(
        "div",
        "$0",
        "font-family: 'DM Sans'",
        vec![
            el("h1", "$0.0", "", vec![text("Title")]),
            el("p", "$0.1", "", vec![text("body")]),
        ],
    );
    let island = resolve(&request(root));
    let (_, y, _, h) = bounds(&island, "$0.0");
    // h1 is 2em = 32px with 0.67em = 21.44px margins; the first margin collapses
    // through the root into the container (position: relative, no padding).
    assert!(close(y, 21.44), "h1 y {y}");
    assert!(h > 32.0 && h < 50.0, "h1 height {h}");
    let (_, py, _, _) = bounds(&island, "$0.1");
    // 21.44 collapses with the paragraph's 16px margin: the larger wins.
    assert!(close(py, y + h + 21.44), "p y {py}");
}

#[test]
fn native_nodes_are_boxes_of_their_given_size() {
    let root = el(
        "div",
        "$0",
        "padding: 5px",
        vec![
            json!({ "kind": "native", "path": "$0.0", "width": 120.0, "height": 40.0 }),
            json!({ "kind": "native", "path": "$0.1" }),
        ],
    );
    let island = resolve(&request(root));
    assert_eq!(bounds(&island, "$0.0"), (5.0, 5.0, 120.0, 40.0));
    assert_eq!(bounds(&island, "$0.1"), (5.0, 45.0, 0.0, 0.0));
}

#[test]
fn stylesheets_and_style_elements_apply_in_document_order() {
    let mut req = request(el_attrs(
        "div",
        "$0",
        json!({ "class": "box" }),
        "",
        vec![el(
            "style",
            "$0.0",
            "",
            vec![text(".box { height: 70px } .x::after { content: '&' }")],
        )],
    ));
    req["stylesheets"] = json!([".box { height: 30px; width: 90px }"]);
    let island = resolve(&req);
    // The tree's <style> comes after the imported sheet and wins on height.
    assert_eq!(bounds(&island, "$0"), (0.0, 0.0, 90.0, 70.0));
}

#[test]
fn svg_elements_are_in_the_svg_namespace() {
    use blitz_dom::{local_name, ns};
    let root = el_attrs(
        "svg",
        "$0",
        json!({ "viewBox": "0 0 10 10", "width": "100", "height": "50" }),
        "",
        vec![el_attrs("rect", "$0.0", json!({ "width": "5", "height": "5" }), "", vec![])],
    );
    let island = resolve(&request(root));
    let svg = island.doc.get_node(island.node("$0").unwrap()).unwrap();
    let data = svg.element_data().unwrap();
    assert_eq!(data.name.ns, ns!(svg));
    assert_eq!(data.name.local, local_name!("svg"));
    assert_eq!(data.attr(local_name!("viewbox")).or(data.attr(local_name!("viewBox"))), Some("0 0 10 10"));
    let rect = island.doc.get_node(island.node("$0.0").unwrap()).unwrap();
    assert_eq!(rect.element_data().unwrap().name.ns, ns!(svg));
    // A replaced box of the given size.
    assert_eq!(bounds(&island, "$0"), (0.0, 0.0, 100.0, 50.0));
}
