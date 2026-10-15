//! The CSS features Blitz did not lay out or draw (docs/HANDOFF.md §8,
//! "CSS gaps"), through the island pipeline: `-webkit-line-clamp`,
//! `@container` and transitions. The pictures are in `features.rs`.

mod common;

use common::*;

const FOX: &str = "The quick brown fox jumps over the lazy dog and keeps running far away";
const CLAMP: &str = "display: -webkit-box; -webkit-box-orient: vertical; width: 150px; \
                     font-size: 16px; line-height: 20px; ";

/// The height of a clamped box holding `text_` and the top of the box after it.
fn clamped(extra: &str, text_: &str) -> (f64, f64) {
    let root = el(
        "div",
        "$0",
        "",
        vec![
            el("div", "$0.0", &format!("{CLAMP}{extra}"), vec![text(text_)]),
            el("div", "$0.1", "height: 7px", vec![]),
        ],
    );
    let island = resolve(&request(root));
    let (_, _, _, h) = bounds(&island, "$0.0");
    let (_, y, _, _) = bounds(&island, "$0.1");
    (h, y)
}

#[test]
fn line_clamp_cuts_the_height_at_the_nth_line() {
    // The text takes four lines; the box is two lines tall and what follows it
    // sits below that, not below the fourth line.
    let (h, next) = clamped("-webkit-line-clamp: 2", FOX);
    assert_eq!((h, next), (40.0, 40.0));
    let (h, _) = clamped("-webkit-line-clamp: 3", FOX);
    assert_eq!(h, 60.0);
}

#[test]
fn line_clamp_leaves_short_text_and_other_boxes_alone() {
    // Fewer lines than the clamp.
    let (h, _) = clamped("-webkit-line-clamp: 5", FOX);
    assert!(h >= 80.0, "{h}");
    // Not a vertical legacy box: no clamp.
    let root = el(
        "div",
        "$0",
        "width: 150px; font-size: 16px; line-height: 20px; -webkit-line-clamp: 2",
        vec![text(FOX)],
    );
    let island = resolve(&request(root));
    assert!(bounds(&island, "$0").3 >= 80.0);
    // An explicit height stays.
    let (h, _) = clamped("-webkit-line-clamp: 2; height: 100px", FOX);
    assert_eq!(h, 100.0);
}

#[test]
fn line_clamp_counts_padding_and_box_sizing() {
    let (h, _) = clamped(
        "-webkit-line-clamp: 2; padding: 4px 0; border: 2px solid",
        FOX,
    );
    assert_eq!(h, 40.0 + 8.0 + 4.0);
    let (h, _) = clamped(
        "-webkit-line-clamp: 2; padding: 4px 0; border: 2px solid; box-sizing: border-box",
        FOX,
    );
    assert_eq!(h, 40.0 + 8.0 + 4.0);
}

#[test]
fn line_clamp_counts_lines_across_paragraphs() {
    let root = el(
        "div",
        "$0",
        &format!("{CLAMP}-webkit-line-clamp: 3"),
        vec![
            el(
                "p",
                "$0.0",
                "margin: 6px 0",
                vec![text("The quick brown fox jumps")],
            ),
            el("p", "$0.1", "margin: 6px 0", vec![text(FOX)]),
        ],
    );
    let island = resolve(&request(root));
    // 6 + 2 lines (40) + 6 + 1 line (20): the bottom of the third line.
    assert_eq!(bounds(&island, "$0").3, 72.0);
}

/// A container of `width` with a child that `@container` rules style.
fn container_island(width: &str, css: &str) -> kinetograph_dom::document::IslandDocument {
    let mut req = request(el(
        "div",
        "$0",
        "",
        vec![el_attrs(
            "div",
            "$0.0",
            serde_json::json!({ "class": "c" }),
            &format!("width: {width}; padding: 10px"),
            vec![el_attrs(
                "div",
                "$0.0.0",
                serde_json::json!({ "class": "i" }),
                "",
                vec![],
            )],
        )],
    ));
    req["stylesheets"] = serde_json::json!([css]);
    resolve(&req)
}

#[test]
fn container_query_matches_the_containers_content_box_after_layout() {
    let css = ".c{container-type:inline-size}.i{height:10px}\
               @container (min-width:200px){.i{height:50px}}";
    // 320 px of content is wide, 100 px is not: the rule needs the size layout gave.
    assert_eq!(bounds(&container_island("320px", css), "$0.0.0").3, 50.0);
    assert_eq!(bounds(&container_island("100px", css), "$0.0.0").3, 10.0);
    // The padding is not part of what a query sees.
    assert_eq!(bounds(&container_island("190px", css), "$0.0.0").3, 10.0);
}

#[test]
fn container_query_takes_the_nearest_named_container_and_the_container_units() {
    let css = ".c{container:card / inline-size}.i{height:10cqh;width:50cqw}\
               @container card (width >= 300px){.i{height:50px}}";
    let island = container_island("320px", css);
    let (_, _, w, h) = bounds(&island, "$0.0.0");
    // 50cqw of 320; the named query matches and its height wins over `cqh`.
    assert_eq!((w, h), (160.0, 50.0));
}

#[test]
fn container_query_that_reshapes_its_content_settles() {
    // The container's own size does not depend on the query it feeds.
    let css = ".c{container-type:inline-size}\
               @container (min-width:200px){.i{padding:20px}}\
               @container (max-width:199px){.i{padding:5px}}";
    let island = container_island("320px", css);
    assert_eq!(bounds(&island, "$0.0.0").2, 320.0);
}
