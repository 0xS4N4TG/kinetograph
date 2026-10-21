//! Replays the island requests of one frame, as `renderDomIsland` saw them, and
//! times each step per island: `cargo run --release -p kinetograph-dom
//! --example sample_pass <dir> [repeats]`, where `<dir>` holds `req-<i>.json`
//! and `index.json` (`[{ "i", "pass", "path" }]`, in call order).

use std::collections::BTreeMap;
use std::time::Instant;

use kinetograph_dom::document::{self, IslandCache};

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = args.next().expect("a directory of captured requests");
    let repeats: usize = args
        .next()
        .map_or(5, |n| n.parse().expect("a number of repeats"));
    let index: Vec<serde_json::Value> =
        serde_json::from_str(&std::fs::read_to_string(format!("{dir}/index.json")).unwrap())
            .unwrap();
    let calls: Vec<(String, Option<u64>, String)> = index
        .iter()
        .map(|e| {
            let i = e["i"].as_u64().unwrap();
            (
                e["path"].as_str().unwrap().to_string(),
                e["pass"].as_u64(),
                std::fs::read_to_string(format!("{dir}/req-{i}.json")).unwrap(),
            )
        })
        .collect();
    document::enable_css_features();
    let mut cache = IslandCache::default();
    // [parse, resolve, paint, serialize, keep] in ms, summed per (path, main or sample).
    let mut sums: BTreeMap<String, ([f64; 5], usize)> = BTreeMap::new();
    for round in 0..=repeats {
        for (path, pass, json) in &calls {
            // Each round is a pass of its own, as each frame is.
            let pass = pass.map(|p| p + round as u64 * 1000);
            let t0 = Instant::now();
            let request = document::parse_request(json).unwrap();
            let t1 = Instant::now();
            let mut resolved = cache.resolve(&request, pass).unwrap();
            let t2 = Instant::now();
            let output = resolved.paint(&request);
            let t3 = Instant::now();
            let text = serde_json::to_string(&output).unwrap();
            let t4 = Instant::now();
            cache.keep(request, resolved);
            drop(output);
            let t5 = Instant::now();
            std::hint::black_box(text);
            if round == 0 {
                continue; // warm-up
            }
            let key = format!("{path} {}", if pass.is_some() { "sample" } else { "main" });
            let entry = sums.entry(key).or_default();
            for (slot, d) in entry
                .0
                .iter_mut()
                .zip([t1 - t0, t2 - t1, t3 - t2, t4 - t3, t5 - t4])
            {
                *slot += d.as_secs_f64() * 1000.0;
            }
            entry.1 += 1;
        }
    }
    println!(
        "{:<24} {:>6} {:>8} {:>8} {:>8} {:>8} {:>8}",
        "island", "calls", "parse", "resolve", "paint", "write", "keep"
    );
    for (key, (ms, n)) in &sums {
        let n = *n as f64;
        println!(
            "{key:<24} {:>6} {:>8.3} {:>8.3} {:>8.3} {:>8.3} {:>8.3}",
            n / repeats as f64,
            ms[0] / n,
            ms[1] / n,
            ms[2] / n,
            ms[3] / n,
            ms[4] / n
        );
    }
}
