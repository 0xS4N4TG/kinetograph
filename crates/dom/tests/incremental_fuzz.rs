//! Random trees under random chains of edits: a document edited from one frame to the next (`IslandCache`) draws
//! and lays out what a document built from the frame's tree does, after every edit. The trees mix blocks, flex and
//! grid boxes, inline text beside blocks (anonymous blocks), absolutely positioned boxes, `::before` from a sheet,
//! inline SVG, tables, `display: contents` and Tailwind-like classes; the edits are the ones animation makes
//! (transforms, opacity, offsets, sizes, display, font size, colour, custom properties descendants read, classes,
//! text).
//!
//! A second test makes the trees mostly inline content (spans in spans, with blocks among them).
//!
//! Seeded, so a failure repeats: `KG_FUZZ_SEEDS` sets how many seeds each test runs (default 48), `KG_FUZZ_SEED`
//! runs one.

mod common;

use std::collections::{BTreeMap, BTreeSet};

use common::*;
use kinetograph_dom::document::IslandCache;
use kinetograph_dom::readback;
use serde_json::{Value, json};

/// xorshift64*: enough randomness for a test, and no dependency. `inline` makes the trees mostly inline content
/// (spans in spans, blocks among them): seeds from `INLINE_SEEDS` up.
struct Rng(u64, bool);

const INLINE_SEEDS: u64 = 1 << 20;

impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1, seed >= INLINE_SEEDS)
    }
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn chance(&mut self, percent: usize) -> bool {
        self.below(100) < percent
    }
    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
    fn num(&mut self, lo: i64, hi: i64) -> i64 {
        lo + self.below((hi - lo + 1) as usize) as i64
    }
}

const SHEET: &str = "\
.flex { display: flex; gap: 6px; align-items: center } \
.col { flex-direction: column } \
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px } \
.p-2 { padding: 8px } .m-1 { margin: 4px } \
.rounded { border-radius: 6px } \
.bg-a { background: #345 } .bg-b { background: linear-gradient(90deg, #a33, #33a) } \
.border { border: 2px solid #789 } \
.text-lg { font-size: 22px; line-height: 1.4 } \
.bold { font-weight: 800; font-family: Inter } \
.ib { display: inline-block; width: 30px; height: 12px; background: #9a3 } \
.inline { display: inline } \
.hidden { display: none } \
.contents { display: contents } \
.abs { position: absolute; left: 10px; top: 20px } \
.rel { position: relative } \
.star::before { content: '*'; color: var(--c, crimson); padding-right: 3px } \
.uses-var { width: var(--w, 120px); color: var(--c, #111) } \
.shift { transform: translateX(var(--x, 0px)) } \
.shadow { box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4) } \
td, th { border: 1px solid #456; padding: 2px 4px }";

const CLASSES: [&str; 19] = [
    "flex", "col", "grid", "p-2", "m-1", "rounded", "bg-a", "bg-b", "border", "text-lg", "bold", "ib", "inline",
    "hidden", "contents", "rel", "star", "uses-var", "shift",
];

const WORDS: [&str; 10] = ["alpha", "beta", "gamma", "delta", "kinet", "frame", "Ω", "très", "go", "1234"];

#[derive(Clone, Debug)]
enum Node {
    El {
        tag: String,
        path: String,
        attrs: BTreeMap<String, String>,
        class: BTreeSet<String>,
        style: BTreeMap<String, String>,
        children: Vec<Node>,
    },
    Text(String),
}

fn words(rng: &mut Rng) -> String {
    (0..1 + rng.below(4)).map(|_| *rng.pick(&WORDS)).collect::<Vec<_>>().join(" ")
}

fn el(tag: &str, path: String, children: Vec<Node>) -> Node {
    Node::El {
        tag: tag.into(),
        path,
        attrs: BTreeMap::new(),
        class: BTreeSet::new(),
        style: BTreeMap::new(),
        children,
    }
}

fn set_style(node: &mut Node, k: &str, v: String) {
    if let Node::El { style, .. } = node {
        style.insert(k.into(), v);
    }
}

fn svg(rng: &mut Rng, path: String) -> Node {
    let mut circle = el("circle", format!("{path}.0"), vec![]);
    if let Node::El { attrs, .. } = &mut circle {
        attrs.insert("cx".into(), "10".into());
        attrs.insert("cy".into(), "10".into());
        attrs.insert("r".into(), rng.num(3, 9).to_string());
        attrs.insert("fill".into(), "currentColor".into());
    }
    let mut node = el("svg", path, vec![circle]);
    if let Node::El { attrs, .. } = &mut node {
        attrs.insert("width".into(), "20".into());
        attrs.insert("height".into(), "20".into());
        attrs.insert("viewBox".into(), "0 0 20 20".into());
    }
    node
}

fn table(rng: &mut Rng, path: String) -> Node {
    let rows = (0..1 + rng.below(3))
        .map(|r| {
            let cells = (0..1 + rng.below(3))
                .map(|c| el("td", format!("{path}.0.{r}.{c}"), vec![Node::Text(words(rng))]))
                .collect();
            el("tr", format!("{path}.0.{r}"), cells)
        })
        .collect();
    let mut t = el("table", path.clone(), vec![el("tbody", format!("{path}.0"), rows)]);
    if rng.chance(50) {
        set_style(&mut t, "border-collapse", "separate".into());
    }
    t
}

fn tree(rng: &mut Rng, path: String, depth: usize) -> Node {
    let leaf = depth >= 3;
    let tag = if leaf {
        *rng.pick(&["span", "b", "div", "span"])
    } else if rng.1 {
        *rng.pick(&["span", "span", "b", "em", "span", "div", "p", "svg"])
    } else {
        *rng.pick(&["div", "div", "span", "p", "section", "svg", "table", "div"])
    };
    match tag {
        "svg" => return svg(rng, path),
        "table" => return table(rng, path),
        _ => {}
    }
    let n = if leaf { rng.below(2) } else { rng.below(5) };
    let children = (0..n)
        .map(|i| {
            if rng.chance(35) {
                Node::Text(words(rng))
            } else {
                tree(rng, format!("{path}.{i}"), depth + 1)
            }
        })
        .collect();
    let mut node = el(tag, path, children);
    if let Node::El { class, style, .. } = &mut node {
        for _ in 0..rng.below(3) {
            class.insert(rng.pick(&CLASSES).to_string());
        }
        // `hidden` at build time hides too much of the tree to test.
        class.remove("hidden");
        if rng.chance(20) {
            style.insert("position".into(), "absolute".into());
            style.insert("left".into(), format!("{}px", rng.num(0, 300)));
            style.insert("top".into(), format!("{}px", rng.num(0, 200)));
        }
        if rng.chance(25) {
            style.insert("transform".into(), format!("translate({}px, {}px)", rng.num(-20, 20), rng.num(-9, 9)));
        }
        if rng.chance(15) {
            style.insert("--c".into(), (*rng.pick(&["#a00", "#0a0", "#00a"])).into());
        }
        if rng.chance(15) {
            style.insert("width".into(), format!("{}px", rng.num(40, 400)));
        }
    }
    node
}

/// The element paths of the tree that edits may touch (not inside an `<svg>`).
fn targets(node: &Node, out: &mut Vec<String>) {
    if let Node::El { tag, path, children, .. } = node {
        out.push(path.clone());
        if tag != "svg" {
            for c in children {
                targets(c, out);
            }
        }
    }
}

fn find<'a>(node: &'a mut Node, want: &str) -> Option<&'a mut Node> {
    match node {
        Node::El { path, .. } if path == want => Some(node),
        Node::El { children, .. } => children.iter_mut().find_map(|c| find(c, want)),
        Node::Text(_) => None,
    }
}

/// Changes one thing of the element at a random path; returns what, for a failure's message.
fn edit(rng: &mut Rng, root: &mut Node) -> String {
    let mut paths = Vec::new();
    targets(root, &mut paths);
    let path = rng.pick(&paths).clone();
    let node = find(root, &path).expect("a target");
    let Node::El { tag, style, class, children, .. } = node else { unreachable!() };
    let mut kind = rng.below(14);
    // A table part given another display or position is laid out in ways a browser does not (Blitz's tables): those
    // stay.
    let table_part = matches!(tag.as_str(), "table" | "tbody" | "tr" | "td");
    if table_part && matches!(kind, 6 | 10 | 11) {
        kind = 13;
    }
    let what = match kind {
        0 | 1 | 2 => {
            let v = if rng.chance(15) {
                "none".to_string()
            } else {
                format!(
                    "translate({}px, {}px) rotate({}deg) scale({})",
                    rng.num(-40, 40),
                    rng.num(-20, 20),
                    rng.num(-30, 30),
                    1.0 + rng.num(-3, 3) as f64 / 10.0
                )
            };
            style.insert("transform".into(), v.clone());
            format!("transform {v}")
        }
        3 => {
            let v = format!("{}", rng.num(0, 10) as f64 / 10.0);
            style.insert("opacity".into(), v.clone());
            format!("opacity {v}")
        }
        4 => {
            let (l, t) = (rng.num(0, 300), rng.num(0, 200));
            style.insert("left".into(), format!("{l}px"));
            style.insert("top".into(), format!("{t}px"));
            if rng.chance(30) && !table_part {
                style.insert("position".into(), (*rng.pick(&["absolute", "relative", "static"])).into());
            }
            format!("left/top {l} {t}")
        }
        5 => {
            let v = format!("{}px", rng.num(20, 500));
            style.insert("width".into(), v.clone());
            format!("width {v}")
        }
        6 => {
            let v = *rng.pick(&["none", "block", "inline", "flex", "inline-block", "contents", "grid"]);
            style.insert("display".into(), v.into());
            format!("display {v}")
        }
        7 => {
            let v = format!("{}px", rng.num(8, 30));
            style.insert("font-size".into(), v.clone());
            format!("font-size {v}")
        }
        8 => {
            let v = *rng.pick(&["#c00", "#0c0", "#00c", "rgb(10 20 30 / 50%)", "currentColor"]);
            style.insert("color".into(), v.into());
            format!("color {v}")
        }
        9 => {
            let (k, v) = match rng.below(3) {
                0 => ("--c", (*rng.pick(&["#a00", "#0a0", "#00a", "orange"])).to_string()),
                1 => ("--w", format!("{}px", rng.num(10, 300))),
                _ => ("--x", format!("{}px", rng.num(-50, 50))),
            };
            style.insert(k.into(), v.clone());
            format!("{k} {v}")
        }
        10 | 11 => {
            let c = rng.pick(&CLASSES).to_string();
            let on = !class.remove(&c);
            if on {
                class.insert(c.clone());
            }
            format!("class {c} {}", if on { "on" } else { "off" })
        }
        12 => {
            // A text of the element, or a property taken away.
            match children.iter_mut().find(|c| matches!(c, Node::Text(_))) {
                Some(Node::Text(t)) => {
                    *t = words(rng);
                    format!("text {t}")
                }
                _ => match style.keys().nth(0).cloned() {
                    Some(k) => {
                        style.remove(&k);
                        format!("remove {k}")
                    }
                    None => "nothing".into(),
                },
            }
        }
        _ => {
            if tag == "svg" {
                "nothing".into()
            } else {
                let v = format!("{}px", rng.num(0, 16));
                style.insert("padding".into(), v.clone());
                format!("padding {v}")
            }
        }
    };
    format!("{path}: {what}")
}

fn to_json(node: &Node) -> Value {
    match node {
        Node::Text(t) => text(t),
        Node::El { tag, path, attrs, class, style, children } => {
            let mut attrs = attrs.clone();
            if !class.is_empty() {
                attrs.insert("class".into(), class.iter().cloned().collect::<Vec<_>>().join(" "));
            }
            let style: String = style.iter().map(|(k, v)| format!("{k}: {v}; ")).collect();
            el_attrs(tag, path, json!(attrs), style.trim_end(), children.iter().map(to_json).collect())
        }
    }
}

fn page(root: &Node, time: f64) -> Value {
    let mut r = request(el_attrs(
        "div",
        "$0",
        json!({}),
        "position: absolute; inset: 0; font-family: 'DM Sans'; font-size: 16px",
        vec![to_json(root)],
    ));
    r["stylesheets"] = json!([SHEET]);
    r["time"] = json!(time);
    r
}

/// What the island draws and its boxes.
fn drawn(cache: &mut IslandCache, request: &Value, pass: Option<u64>) -> Value {
    let request = parse(request);
    let mut resolved = cache.resolve(&request, pass).unwrap();
    let out = resolved.paint(&request);
    let boxes = readback::layout_boxes(&resolved.island);
    let seen = json!({
        "layers": out.layers,
        "unsupported": out.unsupported,
        "margin": out.margin,
        "camera": out.camera,
        "boxes": boxes,
    });
    cache.keep(request, resolved);
    seen
}

fn run(seed: u64, steps: usize) -> Result<(), String> {
    let mut rng = Rng::new(seed);
    let mut root = tree(&mut rng, "$0.0".into(), 0);
    let mut cache = IslandCache::default();
    let mut log = vec!["built".to_string()];
    let mut previous = Vec::new();
    for step in 0..steps {
        // Most steps are the next frame; some another sample of the same one.
        let pass = 1 + step as u64 - (step > 0 && rng.chance(20)) as u64;
        let request = page(&root, step as f64 / 30.0);
        let got = drawn(&mut cache, &request, Some(pass));
        let want = drawn(&mut IslandCache::default(), &request, None);
        if got != want {
            let dir = std::env::temp_dir().join(format!("kg-incremental-fuzz-{seed}"));
            std::fs::create_dir_all(&dir).ok();
            std::fs::write(dir.join("request.json"), serde_json::to_string_pretty(&request).unwrap()).ok();
            std::fs::write(dir.join("before.json"), serde_json::to_string_pretty(&previous).unwrap()).ok();
            std::fs::write(dir.join("edited.json"), serde_json::to_string_pretty(&got).unwrap()).ok();
            std::fs::write(dir.join("fresh.json"), serde_json::to_string_pretty(&want).unwrap()).ok();
            return Err(format!(
                "seed {seed}, step {step}: the edited document differs from a fresh one (written to {}); edits: {}",
                dir.display(),
                log.join(" | ")
            ));
        }
        previous.push(json!({ "pass": pass, "request": request }));
        log.push(format!("step {}:", step + 1));
        for _ in 0..1 + rng.below(3) {
            log.push(edit(&mut rng, &mut root));
        }
    }
    Ok(())
}

#[test]
fn an_edited_document_matches_a_fresh_one_under_random_edits() {
    check(0);
}

#[test]
fn an_edited_inline_heavy_document_matches_a_fresh_one_under_random_edits() {
    check(INLINE_SEEDS);
}

/// Runs `KG_FUZZ_SEEDS` seeds from `first` (or `KG_FUZZ_SEED` alone, if it is in this test's range).
fn check(first: u64) {
    let seeds: Vec<u64> = match std::env::var("KG_FUZZ_SEED") {
        Ok(one) => {
            let one: u64 = one.parse().expect("a seed");
            if (one >= INLINE_SEEDS) == (first >= INLINE_SEEDS) { vec![one] } else { vec![] }
        }
        Err(_) => {
            let n = std::env::var("KG_FUZZ_SEEDS").ok().and_then(|n| n.parse().ok()).unwrap_or(48);
            (first..first + n).collect()
        }
    };
    let failures: Vec<String> = seeds
        .iter()
        .filter_map(|&seed| {
            std::panic::catch_unwind(|| run(seed, 14))
                .unwrap_or_else(|_| Err(format!("seed {seed}: panicked")))
                .err()
        })
        .collect();
    assert!(failures.is_empty(), "{} of {} seeds failed:\n{}", failures.len(), seeds.len(), failures.join("\n"));
}
