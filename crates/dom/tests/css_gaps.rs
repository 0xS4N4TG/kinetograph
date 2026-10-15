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

#[test]
fn a_line_too_narrow_for_any_content_moves_below_the_floats() {
    let float = |side: &str, path: &str| {
        el(
            "div",
            path,
            &format!("float: {side}; width: 60px; height: 30px"),
            vec![],
        )
    };
    let root = el(
        "div",
        "$0",
        "width: 150px; font-size: 16px; line-height: 20px",
        vec![
            float("left", "$0.0"),
            float("right", "$0.1"),
            el(
                "div",
                "$0.2",
                "text-align: center",
                vec![text("Centered line between floats")],
            ),
        ],
    );
    let island = resolve(&request(root));
    // The 30 px between the floats holds no word of it: both lines start below them.
    let (_, y, _, h) = bounds(&island, "$0.2");
    assert_eq!(y, 0.0);
    assert!(h >= 70.0, "{h}");
    assert_eq!(bounds(&island, "$0").3, h);
    // A gap that fits a word keeps the text beside the float.
    let narrow = el(
        "div",
        "$0",
        "width: 150px; font-size: 16px; line-height: 20px",
        vec![
            el(
                "div",
                "$0.0",
                "float: left; width: 100px; height: 30px",
                vec![],
            ),
            el(
                "div",
                "$0.1",
                "",
                vec![text("An extra long text that wraps")],
            ),
        ],
    );
    let island = resolve(&request(narrow));
    assert!(bounds(&island, "$0").3 < 100.0);
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

// ---- transitions ----

/// A request for one `div` whose `style` is `states[i].1` at `states[i].0`
/// seconds (the last state is the request's own).
fn transition_request(states: &[(f64, &str)]) -> serde_json::Value {
    let tree = |style: &str| el_attrs("div", "$0", serde_json::json!({}), style, vec![text("x")]);
    let (last_time, last_style) = *states.last().unwrap();
    let mut req = request(tree(last_style));
    req["time"] = serde_json::json!(last_time);
    req["history"] = states[..states.len() - 1]
        .iter()
        .map(|(time, style)| serde_json::json!({ "time": time, "root": tree(style) }))
        .collect();
    req
}

fn opacity_of(req: &serde_json::Value) -> f64 {
    let island = resolve(req);
    let v = island
        .doc
        .resolved_style_value(island.node("$0").unwrap(), "opacity");
    v.parse().unwrap_or_else(|_| panic!("opacity {v:?}"))
}

const FADE: &str = "transition: opacity 1s linear; ";

#[test]
fn a_transition_starts_at_the_first_state_that_shows_the_new_value() {
    let off = format!("{FADE}opacity: 0");
    let on = format!("{FADE}opacity: 1");
    // Hidden until 1 s, shown from the state at 1 s on.
    for (time, want) in [
        (1.0, 0.0),
        (1.25, 0.25),
        (1.5, 0.5),
        (1.75, 0.75),
        (2.0, 1.0),
    ] {
        let req = transition_request(&[(0.0, &off), (0.5, &off), (1.0, &on), (time, &on)]);
        let got = opacity_of(&req);
        assert!((got - want).abs() < 1e-6, "t={time}: {got}, want {want}");
    }
    // Well after the end it is the final value.
    let req = transition_request(&[(0.0, &off), (1.0, &on), (30.0, &on)]);
    assert_eq!(opacity_of(&req), 1.0);
}

#[test]
fn a_transition_is_a_function_of_the_request() {
    let off = format!("{FADE}opacity: 0");
    let on = format!("{FADE}opacity: 1");
    let req = transition_request(&[(0.0, &off), (1.0, &on), (1.4, &on)]);
    let a = opacity_of(&req);
    let b = opacity_of(&req);
    assert_eq!(a, b);
    assert!((a - 0.4).abs() < 1e-6, "{a}");
    // States after the request's time are not part of its past.
    let mut late = req.clone();
    late["history"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({ "time": 9.0, "root": el_attrs("div", "$0", serde_json::json!({}), "opacity: 0", vec![text("x")]) }));
    assert_eq!(opacity_of(&late), a);
}

#[test]
fn without_history_there_is_nothing_to_transition_from() {
    let on = format!("{FADE}opacity: 1");
    let req = transition_request(&[(0.25, &on)]);
    assert_eq!(opacity_of(&req), 1.0);
}

#[test]
fn a_transition_honours_delay_duration_and_easing() {
    let off = "transition: opacity 2s cubic-bezier(0, 0, 1, 1) 0.5s; opacity: 0";
    let on = "transition: opacity 2s cubic-bezier(0, 0, 1, 1) 0.5s; opacity: 1";
    // Change at 1 s; waits 0.5 s; runs 2 s.
    for (time, want) in [(1.25, 0.0), (1.5, 0.0), (2.0, 0.25), (2.5, 0.5), (3.5, 1.0)] {
        let req = transition_request(&[(0.0, off), (1.0, on), (time, on)]);
        let got = opacity_of(&req);
        assert!((got - want).abs() < 1e-6, "t={time}: {got}, want {want}");
    }
    // An easing curve is not linear: at the midpoint `ease-in` is behind.
    let ease = |s: &str| format!("transition: opacity 1s ease-in; opacity: {s}");
    let mid = opacity_of(&transition_request(&[
        (0.0, &ease("0")),
        (1.0, &ease("1")),
        (1.5, &ease("1")),
    ]));
    assert!(mid > 0.1 && mid < 0.45, "{mid}");
}

#[test]
fn transitions_follow_class_attributes_and_stylesheets() {
    let tree = |class: &str| {
        el_attrs(
            "div",
            "$0",
            serde_json::json!({ "class": class }),
            "",
            vec![text("x")],
        )
    };
    let mut req = request(tree("on"));
    req["stylesheets"] =
        serde_json::json!([".box{transition:opacity 1s linear;opacity:0}.on{opacity:1}"]);
    req["time"] = serde_json::json!(1.5);
    req["history"] = serde_json::json!([
        { "time": 0.0, "root": tree("box") },
        { "time": 1.0, "root": tree("box on") },
    ]);
    req["root"] = tree("box on");
    let got = opacity_of(&req);
    assert!((got - 0.5).abs() < 1e-6, "{got}");
}

#[test]
fn a_state_that_changes_the_structure_restarts_the_replay() {
    let off = format!("{FADE}opacity: 0");
    let on = format!("{FADE}opacity: 1");
    let tree = |style: &str, extra: bool| {
        let mut kids = vec![text("x")];
        if extra {
            kids.push(el("b", "$0.0", "", vec![text("new")]));
        }
        el_attrs("div", "$0", serde_json::json!({}), style, kids)
    };
    let mut req = request(tree(&on, true));
    req["time"] = serde_json::json!(1.5);
    req["history"] = serde_json::json!([
        { "time": 0.0, "root": tree(&off, false) },
        { "time": 1.0, "root": tree(&on, true) },
    ]);
    // The second state adds an element, so it is a new document that starts at 1: no transition.
    assert_eq!(opacity_of(&req), 1.0);
}

#[test]
fn a_transition_reaches_the_painted_layer() {
    let off = format!("{FADE}opacity: 0; background: #f00; width: 40px; height: 40px");
    let on = format!("{FADE}opacity: 1; background: #f00; width: 40px; height: 40px");
    let req = transition_request(&[(0.0, &off), (1.0, &on), (1.5, &on)]);
    let island = resolve(&req);
    let out = kinetograph_dom::paint::paint(&island.doc, &parse(&req));
    let json = serde_json::to_string(&out.layers).unwrap();
    assert!(json.contains("\"opacity\":0.5"), "{json}");
}

// ---- tables ----
//
// The numbers are Chrome's (getBoundingClientRect of the same markup, Chrome for Testing 154).

fn box_div(path: &str, w: u32, h: u32) -> serde_json::Value {
    el("div", path, &format!("width: {w}px; height: {h}px"), vec![])
}

fn table_at(
    path: &str,
    pos: (u32, u32),
    style: &str,
    rows: Vec<serde_json::Value>,
) -> serde_json::Value {
    el(
        "table",
        path,
        &format!(
            "position: absolute; left: {}px; top: {}px; border-spacing: 0; {style}",
            pos.0, pos.1
        ),
        rows,
    )
}

fn tr(path: &str, cells: Vec<serde_json::Value>) -> serde_json::Value {
    el("tr", path, "", cells)
}

fn td(path: &str, style: &str, children: Vec<serde_json::Value>) -> serde_json::Value {
    el("td", path, style, children)
}

fn near(got: (f64, f64, f64, f64), want: (f64, f64, f64, f64), what: &str) {
    let d = |a: f64, b: f64| (a - b).abs() < 0.05;
    assert!(
        d(got.0, want.0) && d(got.1, want.1) && d(got.2, want.2) && d(got.3, want.3),
        "{what}: {got:?}, want {want:?}"
    );
}

#[test]
fn table_columns_share_the_width_in_proportion_to_what_they_want() {
    let root = el(
        "div",
        "$0",
        "",
        vec![table_at(
            "$0.0",
            (10, 10),
            "width: 300px",
            vec![tr(
                "$0.0.0",
                vec![
                    td("$0.0.0.0", "", vec![box_div("$0.0.0.0.0", 100, 10)]),
                    td("$0.0.0.1", "", vec![box_div("$0.0.0.1.0", 20, 10)]),
                ],
            )],
        )],
    );
    let island = resolve(&request(root));
    near(bounds(&island, "$0.0"), (10.0, 10.0, 300.0, 12.0), "table");
    near(
        bounds(&island, "$0.0.0.0"),
        (10.0, 10.0, 246.765625, 12.0),
        "a",
    );
    near(
        bounds(&island, "$0.0.0.1"),
        (256.765625, 10.0, 53.234375, 12.0),
        "b",
    );
}

#[test]
fn a_cell_that_spans_columns_asks_the_columns_without_a_width() {
    let root = el(
        "div",
        "$0",
        "",
        vec![table_at(
            "$0.0",
            (10, 60),
            "",
            vec![
                tr(
                    "$0.0.0",
                    vec![
                        td("$0.0.0.0", "", vec![box_div("$0.0.0.0.0", 100, 10)]),
                        td(
                            "$0.0.0.1",
                            "width: 30px",
                            vec![box_div("$0.0.0.1.0", 20, 10)],
                        ),
                    ],
                ),
                tr(
                    "$0.0.1",
                    vec![el_attrs(
                        "td",
                        "$0.0.1.0",
                        serde_json::json!({ "colspan": "2" }),
                        "",
                        vec![box_div("$0.0.1.0.0", 200, 10)],
                    )],
                ),
            ],
        )],
    );
    let island = resolve(&request(root));
    near(bounds(&island, "$0.0"), (10.0, 60.0, 202.0, 24.0), "table");
    near(bounds(&island, "$0.0.0.0"), (10.0, 60.0, 170.0, 12.0), "c");
    near(bounds(&island, "$0.0.0.1"), (180.0, 60.0, 32.0, 12.0), "d");
    near(bounds(&island, "$0.0.1.0"), (10.0, 72.0, 202.0, 12.0), "e");
}

#[test]
fn a_percentage_column_takes_its_share_and_the_others_the_rest() {
    let root = el(
        "div",
        "$0",
        "",
        vec![table_at(
            "$0.0",
            (10, 120),
            "width: 400px",
            vec![tr(
                "$0.0.0",
                vec![
                    td(
                        "$0.0.0.0",
                        "width: 25%",
                        vec![box_div("$0.0.0.0.0", 10, 10)],
                    ),
                    td("$0.0.0.1", "", vec![box_div("$0.0.0.1.0", 50, 10)]),
                    td("$0.0.0.2", "", vec![box_div("$0.0.0.2.0", 150, 10)]),
                ],
            )],
        )],
    );
    let island = resolve(&request(root));
    near(bounds(&island, "$0.0.0.0"), (10.0, 120.0, 100.0, 12.0), "f");
    near(
        bounds(&island, "$0.0.0.1"),
        (110.0, 120.0, 76.46875, 12.0),
        "g",
    );
    near(
        bounds(&island, "$0.0.0.2"),
        (186.46875, 120.0, 223.53125, 12.0),
        "h",
    );
}

#[test]
fn captions_sit_above_and_below_the_grid_inside_the_tables_box() {
    let root = el(
        "div",
        "$0",
        "",
        vec![table_at(
            "$0.0",
            (10, 180),
            "width: 200px",
            vec![
                el(
                    "caption",
                    "$0.0.0",
                    "height: 30px; margin: 2px 0",
                    vec![text("cap")],
                ),
                tr(
                    "$0.0.1",
                    vec![td("$0.0.1.0", "height: 40px", vec![text("x")])],
                ),
                el(
                    "caption",
                    "$0.0.2",
                    "caption-side: bottom; height: 10px",
                    vec![],
                ),
            ],
        )],
    );
    let island = resolve(&request(root));
    near(bounds(&island, "$0.0"), (10.0, 180.0, 200.0, 84.0), "table");
    near(
        bounds(&island, "$0.0.0"),
        (10.0, 182.0, 200.0, 30.0),
        "caption",
    );
    near(
        bounds(&island, "$0.0.1.0"),
        (10.0, 214.0, 200.0, 40.0),
        "cell",
    );
    near(
        bounds(&island, "$0.0.2"),
        (10.0, 254.0, 200.0, 10.0),
        "bottom caption",
    );
}

#[test]
fn a_cells_height_is_its_border_box_and_a_rowspan_cell_spans_the_rows() {
    let root = el(
        "div",
        "$0",
        "",
        vec![table_at(
            "$0.0",
            (300, 10),
            "",
            vec![
                tr(
                    "$0.0.0",
                    vec![
                        el_attrs(
                            "td",
                            "$0.0.0.0",
                            serde_json::json!({ "rowspan": "2" }),
                            "width: 30px; height: 10px",
                            vec![],
                        ),
                        td("$0.0.0.1", "height: 15px", vec![]),
                    ],
                ),
                tr("$0.0.1", vec![td("$0.0.1.0", "height: 25px", vec![])]),
            ],
        )],
    );
    let island = resolve(&request(root));
    near(bounds(&island, "$0.0"), (300.0, 10.0, 34.0, 40.0), "table");
    near(bounds(&island, "$0.0.0.0"), (300.0, 10.0, 32.0, 40.0), "j");
    near(bounds(&island, "$0.0.0.1"), (332.0, 10.0, 2.0, 15.0), "k");
    near(bounds(&island, "$0.0.1.0"), (332.0, 25.0, 2.0, 25.0), "l");
}

/// A one-row, one-cell table with a bordered 50 by 20 cell.
fn lone_cell(
    table: &str,
    cell: &str,
    pos: (u32, u32),
    content: bool,
) -> (serde_json::Value, serde_json::Value) {
    let t = table_at(
        "$0.0",
        pos,
        table,
        vec![tr(
            "$0.0.0",
            vec![td(
                "$0.0.0.0",
                cell,
                if content {
                    vec![box_div("$0.0.0.0.0", 1, 20)]
                } else {
                    vec![]
                },
            )],
        )],
    );
    let root = el("div", "$0", "", vec![t]);
    (root, serde_json::json!(null))
}

#[test]
fn separate_borders_add_to_the_cell_and_collapsed_ones_are_shared_in_halves() {
    let cell = "width: 50px; height: 20px; padding: 0; border: 1px solid #000";
    let (root, _) = lone_cell("", cell, (10, 10), false);
    let island = resolve(&request(root));
    near(
        bounds(&island, "$0.0.0.0"),
        (10.0, 10.0, 52.0, 20.0),
        "separate",
    );

    let cell = "width: 50px; height: 20px; padding: 3px; border: 1px solid #000";
    let (root, _) = lone_cell("border-collapse: collapse", cell, (200, 10), false);
    let island = resolve(&request(root));
    near(
        bounds(&island, "$0.0"),
        (200.0, 10.0, 58.0, 21.0),
        "collapsed table",
    );
    near(
        bounds(&island, "$0.0.0.0"),
        (200.5, 10.5, 57.0, 20.0),
        "collapsed cell",
    );
    // Each collapsed border is halved between the cells (and the table) that share it.
    let cell = "width: 50px; padding: 0; border: 2px solid #000";
    let (root, _) = lone_cell("border-collapse: collapse", cell, (200, 100), true);
    let island = resolve(&request(root));
    near(
        bounds(&island, "$0.0"),
        (200.0, 100.0, 54.0, 24.0),
        "table, cell border 2",
    );
    near(
        bounds(&island, "$0.0.0.0"),
        (201.0, 101.0, 52.0, 22.0),
        "cell, border 2",
    );
    let (root, _) = lone_cell(
        "border-collapse: collapse; border: 4px solid #a00",
        cell,
        (10, 100),
        true,
    );
    let island = resolve(&request(root));
    near(
        bounds(&island, "$0.0"),
        (10.0, 100.0, 58.0, 28.0),
        "table, border 4",
    );
    near(
        bounds(&island, "$0.0.0.0"),
        (12.0, 102.0, 54.0, 24.0),
        "cell under border 4",
    );
}
