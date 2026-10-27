//! CSS Motion Path: `offset-path`, `offset-distance`, `offset-rotate`,
//! `offset-anchor` and `offset-position` move and turn the element. The numbers
//! are the transformed bounding rect of a 100 x 50 box at (10, 20) in a
//! container at the island's origin.

mod common;

use common::*;
use kinetograph_dom::readback::{self, Rect};

fn rect(style: &str) -> Rect {
    let root = el(
        "div",
        "$0",
        "position: relative",
        vec![el(
            "div",
            "$0.0",
            &format!("position: absolute; left: 10px; top: 20px; width: 100px; height: 50px; {style}"),
            vec![],
        )],
    );
    let island = resolve(&request(root));
    readback::layout_boxes(&island)["$0.0"].rect
}

fn check(style: &str, x: f64, y: f64, w: f64, h: f64) {
    let r = rect(style);
    let ok = |a: f64, b: f64| (a - b).abs() < 0.2;
    assert!(
        ok(r.x, x) && ok(r.y, y) && ok(r.width, w) && ok(r.height, h),
        "{style}: got {r:?}, want {x} {y} {w} {h}"
    );
}

const PATH: &str = "offset-path: path('M 200 100 L 400 100 L 400 300');";

#[test]
fn path_distance_puts_the_centre_on_the_path() {
    // Auto anchor is the transform origin, the centre; travelling east, unrotated.
    check(&format!("{PATH} offset-distance: 0px"), 150.0, 75.0, 100.0, 50.0);
    check(&format!("{PATH} offset-distance: 100px"), 250.0, 75.0, 100.0, 50.0);
    // Without offset-distance the element sits at the start of the path.
    check(PATH, 150.0, 75.0, 100.0, 50.0);
}

#[test]
fn rotate_auto_follows_the_direction() {
    // 300px along: 100px down the second leg, heading south.
    check(&format!("{PATH} offset-distance: 300px"), 375.0, 150.0, 50.0, 100.0);
    // A percentage is of the path length (400): 75% is the same point.
    check(&format!("{PATH} offset-distance: 75%"), 375.0, 150.0, 50.0, 100.0);
    // An open path stops at its end.
    check(&format!("{PATH} offset-distance: 900px"), 375.0, 250.0, 50.0, 100.0);
}

#[test]
fn rotate_keywords_and_angles() {
    let at300 = format!("{PATH} offset-distance: 300px;");
    check(&format!("{at300} offset-rotate: 0deg"), 350.0, 175.0, 100.0, 50.0);
    check(&format!("{at300} offset-rotate: auto 90deg"), 350.0, 175.0, 100.0, 50.0);
    check(&format!("{at300} offset-rotate: reverse"), 375.0, 150.0, 50.0, 100.0);
    check(&format!("{PATH} offset-distance: 0px; offset-rotate: 90deg"), 175.0, 50.0, 50.0, 100.0);
}

#[test]
fn anchor_is_the_point_that_lands_on_the_path() {
    check(&format!("{PATH} offset-anchor: 0 0"), 200.0, 100.0, 100.0, 50.0);
    check(&format!("{PATH} offset-anchor: 100% 100%"), 100.0, 50.0, 100.0, 50.0);
}

#[test]
fn offset_sits_between_the_individual_properties_and_transform() {
    let at300 = format!("{PATH} offset-distance: 300px;");
    // `transform` is applied to the box first: its x is along the turned box, so south.
    check(&format!("{at300} transform: translate(10px, 0)"), 375.0, 160.0, 50.0, 100.0);
    // `translate` is applied last: along the parent's x.
    check(&format!("{at300} translate: 10px 0"), 385.0, 150.0, 50.0, 100.0);
}

#[test]
fn closed_paths_wrap() {
    let square = "offset-path: path('M 0 0 L 100 0 L 100 100 L 0 100 Z'); offset-anchor: 0 0; offset-rotate: 0deg;";
    check(&format!("{square} offset-distance: 50px"), 50.0, 0.0, 100.0, 50.0);
    check(&format!("{square} offset-distance: 450px"), 50.0, 0.0, 100.0, 50.0);
    check(&format!("{square} offset-distance: 350px"), 0.0, 50.0, 100.0, 50.0);
}

#[test]
fn basic_shapes_and_rays() {
    // A circle starts at its rightmost point and runs clockwise (south first).
    let circle = "offset-path: circle(50px at 100px 100px);";
    check(&format!("{circle} offset-distance: 0px"), 125.0, 50.0, 50.0, 100.0);
    let half = std::f64::consts::PI * 50.0;
    check(&format!("{circle} offset-distance: {half}px"), 25.0, 50.0, 50.0, 100.0);
    check(&format!("{circle} offset-distance: 50%"), 25.0, 50.0, 50.0, 100.0);
    // A polygon is closed through its first point.
    check(
        "offset-path: polygon(0 0, 100px 0, 100px 100px); offset-anchor: 0 0; offset-rotate: 0deg; offset-distance: 150px",
        100.0,
        50.0,
        100.0,
        50.0,
    );
    // ray(): 90deg points east from the offset position.
    check(
        "offset-path: ray(90deg); offset-position: 100px 100px; offset-distance: 50px",
        100.0,
        75.0,
        100.0,
        50.0,
    );
}

#[test]
fn no_offset_path_moves_nothing() {
    check("offset-distance: 100px; offset-rotate: 45deg", 10.0, 20.0, 100.0, 50.0);
    check("offset-path: none; offset-distance: 100px", 10.0, 20.0, 100.0, 50.0);
}
