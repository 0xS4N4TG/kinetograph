//! The islands of a motion-blur pass: a document edited from one sample to the
//! next draws what a document built from the sample draws.

mod common;

use common::*;
use kinetograph_dom::document::IslandCache;
use kinetograph_dom::paint;
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
    let resolved = cache.resolve(&request, pass).unwrap();
    let out = serde_json::to_string(&paint::paint(&resolved.island.doc, &request).layers).unwrap();
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
