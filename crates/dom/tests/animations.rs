//! CSS animations are a pure function of the request's time.

mod common;

use common::*;
use serde_json::{Value, json};

const SHEET: &str = "
@keyframes grow { from { width: 100px } to { width: 300px } }
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
.grow { height: 10px; animation: grow 2s linear both }
.fade { height: 10px; width: 10px; animation: fade 1s linear both }
.late { height: 10px; width: 50px; animation: grow 1s linear 1s both }
.loop { height: 10px; animation: grow 1s linear infinite }
.eased { height: 10px; animation: grow 1s ease-in both }
.alt { height: 10px; animation: grow 1s linear infinite alternate }
.twice { height: 10px; width: 40px; animation: grow 1s linear 2.5 }
";

fn at(time: f64, class: &str) -> Value {
    let mut req = request(el_attrs("div", "$0", json!({ "class": class }), "", vec![]));
    req["stylesheets"] = json!([SHEET]);
    req["time"] = json!(time);
    req
}

fn width_at(time: f64, class: &str) -> f64 {
    bounds(&resolve(&at(time, class)), "$0").2
}

fn opacity_at(time: f64) -> f32 {
    let island = resolve(&at(time, "fade"));
    let node = island.doc.get_node(island.node("$0").unwrap()).unwrap();
    node.primary_styles().unwrap().get_effects().opacity
}

#[test]
fn keyframes_sample_at_the_requests_time() {
    for (t, expected) in [(0.0, 100.0), (0.5, 150.0), (1.0, 200.0), (1.5, 250.0)] {
        let w = width_at(t, "grow");
        assert!((w - expected).abs() < 1.0, "t={t}: {w} vs {expected}");
    }
    // `both` fills forwards after the end.
    assert!((width_at(2.0, "grow") - 300.0).abs() < 1.0);
    assert!((width_at(10.0, "grow") - 300.0).abs() < 1.0);
}

#[test]
fn opacity_animates() {
    for (t, expected) in [(0.0, 0.0), (0.25, 0.25), (0.75, 0.75), (1.0, 1.0), (3.0, 1.0)] {
        let o = opacity_at(t);
        assert!((o - expected).abs() < 0.01, "t={t}: {o} vs {expected}");
    }
}

#[test]
fn delay_holds_the_first_keyframe_then_runs() {
    // `both` fill: 50px (from the rule, not the animation... the from keyframe) until 1s.
    let before = width_at(0.5, "late");
    assert!((before - 100.0).abs() < 1.0, "{before}");
    let mid = width_at(1.5, "late");
    assert!((mid - 200.0).abs() < 1.0, "{mid}");
    assert!((width_at(2.5, "late") - 300.0).abs() < 1.0);
}

#[test]
fn iterations_repeat() {
    for (t, expected) in [(0.25, 150.0), (1.25, 150.0), (7.75, 250.0)] {
        let w = width_at(t, "loop");
        assert!((w - expected).abs() < 1.0, "t={t}: {w} vs {expected}");
    }
}

#[test]
fn easing_applies() {
    // ease-in, cubic-bezier(.42, 0, 1, 1), is at about 0.315 of the way at 0.5.
    let w = width_at(0.5, "eased");
    assert!((w - (100.0 + 200.0 * 0.3153)).abs() < 1.5, "{w}");
}

#[test]
fn a_frame_does_not_depend_on_what_was_rendered_before() {
    // Out of order, repeated: the same time always gives the same box.
    let order = [1.5, 0.0, 1.5, 0.25, 1.5, 1.0, 0.25];
    let widths: Vec<f64> = order.iter().map(|t| width_at(*t, "grow")).collect();
    assert_eq!(widths[0], widths[2]);
    assert_eq!(widths[0], widths[4]);
    assert_eq!(widths[3], widths[6]);
    assert!(widths[1] < widths[3] && widths[3] < widths[5] && widths[5] < widths[0]);
}

#[test]
fn animated_layout_moves_siblings() {
    let mut req = request(el(
        "div",
        "$0",
        "display: flex",
        vec![
            el_attrs("div", "$0.0", json!({ "class": "grow" }), "", vec![]),
            el("div", "$0.1", "width: 20px; height: 10px", vec![]),
        ],
    ));
    req["stylesheets"] = json!([SHEET]);
    req["time"] = json!(1.0);
    let island = resolve(&req);
    let (x, _, _, _) = bounds(&island, "$0.1");
    assert!((x - 200.0).abs() < 1.0, "{x}");
}

#[test]
fn alternate_direction_reverses_every_other_iteration() {
    for (t, expected) in [(0.25, 150.0), (1.25, 250.0), (2.25, 150.0), (5.25, 250.0)] {
        let w = width_at(t, "alt");
        assert!((w - expected).abs() < 1.0, "t={t}: {w} vs {expected}");
    }
}

#[test]
fn finite_iterations_end_and_the_rule_applies_again() {
    // 2.5 iterations: at 2.25 it is a quarter into the third.
    assert!((width_at(2.25, "twice") - 150.0).abs() < 1.0);
    // Over, and no fill-mode: the element's own width.
    assert!((width_at(2.75, "twice") - 40.0).abs() < 1.0);
    assert!((width_at(60.0, "twice") - 40.0).abs() < 1.0);
}

#[test]
fn transitions_do_not_run_in_a_fresh_document() {
    // A transition needs a style change between two styles; a frame is one style.
    let mut req = request(el_attrs("div", "$0", json!({ "class": "t" }), "", vec![]));
    req["stylesheets"] = json!([".t { width: 100px; height: 10px; transition: width 1s linear } "]);
    req["time"] = json!(0.5);
    assert_eq!(bounds(&resolve(&req), "$0").2, 100.0);
}
