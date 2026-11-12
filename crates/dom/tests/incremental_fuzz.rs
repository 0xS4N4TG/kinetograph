//! Random trees under random chains of edits: a document edited from one frame to the next (`IslandCache`) draws
//! and lays out what a document built from the frame's tree does, after every edit. The trees mix blocks, flex and
//! grid boxes, inline text beside blocks (anonymous blocks), absolutely positioned boxes, `::before` from a sheet,
//! inline SVG, tables, `display: contents` and Tailwind-like classes; the edits are the ones animation makes
//! (transforms, opacity, offsets, sizes, display, font size, colour, custom properties descendants read, classes,
//! text) and the ones mounting makes (a child added or taken away, which renumbers the paths after it).
//!
//! A second test makes the trees mostly inline content (spans in spans, with blocks among them).
//!
//! Seeded, so a failure repeats: `KG_FUZZ_SEEDS` sets how many seeds each test runs (default `DEFAULT_SEEDS`; a deep
//! run is `KG_FUZZ_SEEDS=20000`), `KG_FUZZ_SEED` runs one.

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

/// How many seeds each test runs when `KG_FUZZ_SEEDS` does not say (a deep run is `KG_FUZZ_SEEDS=20000`). The first
/// seed that found the stale containing block of an out-of-flow box (`a_box_back_in_flow_...` below) was
/// `INLINE_SEEDS` + 686: 48 seeds found nothing.
const DEFAULT_SEEDS: u64 = 700;

impl Rng {
    fn new(seed: u64) -> Self {
        Rng(
            seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1,
            seed >= INLINE_SEEDS,
        )
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
    "flex", "col", "grid", "p-2", "m-1", "rounded", "bg-a", "bg-b", "border", "text-lg", "bold",
    "ib", "inline", "hidden", "contents", "rel", "star", "uses-var", "shift",
];

const WORDS: [&str; 10] = [
    "alpha", "beta", "gamma", "delta", "kinet", "frame", "Ω", "très", "go", "1234",
];

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
    (0..1 + rng.below(4))
        .map(|_| *rng.pick(&WORDS))
        .collect::<Vec<_>>()
        .join(" ")
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
                .map(|c| {
                    el(
                        "td",
                        format!("{path}.0.{r}.{c}"),
                        vec![Node::Text(words(rng))],
                    )
                })
                .collect();
            el("tr", format!("{path}.0.{r}"), cells)
        })
        .collect();
    let mut t = el(
        "table",
        path.clone(),
        vec![el("tbody", format!("{path}.0"), rows)],
    );
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
            style.insert(
                "transform".into(),
                format!("translate({}px, {}px)", rng.num(-20, 20), rng.num(-9, 9)),
            );
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
    if let Node::El {
        tag,
        path,
        children,
        ..
    } = node
    {
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
    let Node::El {
        tag,
        style,
        class,
        children,
        ..
    } = node
    else {
        unreachable!()
    };
    let mut kind = rng.below(16);
    // A table part given another display or position is laid out in ways a browser does not (Blitz's tables): those
    // stay. So do its children, and an `<svg>`'s.
    let table_part = matches!(tag.as_str(), "table" | "tbody" | "tr" | "td");
    if (table_part || tag == "svg") && matches!(kind, 6 | 10 | 11 | 14 | 15) {
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
                style.insert(
                    "position".into(),
                    (*rng.pick(&["absolute", "relative", "static"])).into(),
                );
            }
            format!("left/top {l} {t}")
        }
        5 => {
            let v = format!("{}px", rng.num(20, 500));
            style.insert("width".into(), v.clone());
            format!("width {v}")
        }
        6 => {
            let v = *rng.pick(&[
                "none",
                "block",
                "inline",
                "flex",
                "inline-block",
                "contents",
                "grid",
            ]);
            style.insert("display".into(), v.into());
            format!("display {v}")
        }
        7 => {
            let v = format!("{}px", rng.num(8, 30));
            style.insert("font-size".into(), v.clone());
            format!("font-size {v}")
        }
        8 => {
            let v = *rng.pick(&[
                "#c00",
                "#0c0",
                "#00c",
                "rgb(10 20 30 / 50%)",
                "currentColor",
            ]);
            style.insert("color".into(), v.into());
            format!("color {v}")
        }
        9 => {
            let (k, v) = match rng.below(3) {
                0 => (
                    "--c",
                    (*rng.pick(&["#a00", "#0a0", "#00a", "orange"])).to_string(),
                ),
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
        14 => {
            let at = rng.below(children.len() + 1);
            let child = if rng.chance(30) {
                Node::Text(words(rng))
            } else {
                tree(rng, String::new(), 2)
            };
            children.insert(at, child);
            renumber(root, "$0.0");
            format!("insert at {at}")
        }
        15 if !children.is_empty() => {
            let at = rng.below(children.len());
            children.remove(at);
            renumber(root, "$0.0");
            format!("remove at {at}")
        }
        12 | 15 => {
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

/// Gives each element the path of its place: its parent's and its index among the children that are not text.
fn renumber(node: &mut Node, at: &str) {
    if let Node::El { path, children, .. } = node {
        *path = at.to_string();
        let mut i = 0;
        for c in children {
            if matches!(c, Node::El { .. }) {
                renumber(c, &format!("{at}.{i}"));
                i += 1;
            }
        }
    }
}

fn to_json(node: &Node) -> Value {
    match node {
        Node::Text(t) => text(t),
        Node::El {
            tag,
            path,
            attrs,
            class,
            style,
            children,
        } => {
            let mut attrs = attrs.clone();
            if !class.is_empty() {
                attrs.insert(
                    "class".into(),
                    class.iter().cloned().collect::<Vec<_>>().join(" "),
                );
            }
            let style: String = style.iter().map(|(k, v)| format!("{k}: {v}; ")).collect();
            el_attrs(
                tag,
                path,
                json!(attrs),
                style.trim_end(),
                children.iter().map(to_json).collect(),
            )
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
            std::fs::write(
                dir.join("request.json"),
                serde_json::to_string_pretty(&request).unwrap(),
            )
            .ok();
            std::fs::write(
                dir.join("before.json"),
                serde_json::to_string_pretty(&previous).unwrap(),
            )
            .ok();
            std::fs::write(
                dir.join("edited.json"),
                serde_json::to_string_pretty(&got).unwrap(),
            )
            .ok();
            std::fs::write(
                dir.join("fresh.json"),
                serde_json::to_string_pretty(&want).unwrap(),
            )
            .ok();
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
            if (one >= INLINE_SEEDS) == (first >= INLINE_SEEDS) {
                vec![one]
            } else {
                vec![]
            }
        }
        Err(_) => {
            let n = std::env::var("KG_FUZZ_SEEDS")
                .ok()
                .and_then(|n| n.parse().ok())
                .unwrap_or(DEFAULT_SEEDS);
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
    assert!(
        failures.is_empty(),
        "{} of {} seeds failed:\n{}",
        failures.len(),
        seeds.len(),
        failures.join("\n")
    );
}

/// The island of `to` drawn by a document edited from `from` in the next frame, beside a fresh build of it.
fn edited_and_fresh(from: Value, to: Value) -> (Value, Value) {
    let mut cache = IslandCache::default();
    drawn(&mut cache, &request(from), Some(1));
    let to = request(to);
    let got = drawn(&mut cache, &to, Some(2));
    assert_eq!(cache.counts(), (1, 1), "the second frame edits the first's document");
    (got, drawn(&mut IslandCache::default(), &to, None))
}

/// Seed 1092 of the gap tests, cut down: a transformed box holds an absolutely positioned one (it is its containing
/// block), then is `display: contents` in the frame that puts the box inside back in flow. Nothing lays the outer one
/// out again, and the inner one must not keep it as its containing block: its box would be moved by the outer's
/// transform, and its text not drawn at all.
#[test]
fn a_box_back_in_flow_leaves_a_containing_block_that_became_display_contents() {
    let tree = |outer: &str, inner: &str| {
        let inner = common::el("div", "$0.0.0.0.0", inner, vec![text("kinet")]);
        let outer = common::el("div", "$0.0.0.0", outer, vec![inner]);
        common::el("div", "$0", "", vec![common::el("div", "$0.0", "", vec![common::el("div", "$0.0.0", "", vec![outer])])])
    };
    let (got, want) = edited_and_fresh(
        tree("transform: translate(-14px, -5px)", "position: absolute"),
        tree("transform: translate(-14px, -5px); display: contents", ""),
    );
    assert_eq!(got, want);
}

/// Seed 1049262, cut down: the containing block is an absolutely positioned `<span>` that is an inline again (a span
/// of its parent's text, with no box) in the frame that puts the box inside back in flow.
#[test]
fn a_box_back_in_flow_leaves_a_containing_block_that_became_an_inline() {
    let tree = |outer: &str, inner: &str| {
        let inner = common::el("p", "$0.0.0", &format!("display: inline-block; width: 309px; height: 12px; {inner}"), vec![]);
        common::el("div", "$0", "", vec![common::el("span", "$0.0", outer, vec![inner])])
    };
    let (got, want) = edited_and_fresh(
        tree(
            "position: absolute; left: 46px; top: 165px; transform: translate(-21px, -6px)",
            "position: absolute; left: 232px; top: 79px",
        ),
        tree("", ""),
    );
    assert_eq!(got, want);
}

/// Frames drawn one after the other through one cache (each the next pass), and the last frame's island built afresh.
fn chain_and_fresh(frames: Vec<Value>) -> (Value, Value) {
    let mut cache = IslandCache::default();
    let mut got = Value::Null;
    for (i, frame) in frames.iter().enumerate() {
        got = drawn(&mut cache, frame, Some(1 + i as u64));
    }
    assert_eq!(cache.counts().0, frames.len() as u64 - 1, "every frame after the first edits the document before");
    (got, drawn(&mut IslandCache::default(), frames.last().unwrap(), None))
}

/// The request of a frame whose tree is `root` (path `$0.0`), as the fuzz makes it: the page's root, and the sheet.
fn fuzz_page(root: Value) -> Value {
    let mut r = request(el_attrs(
        "div",
        "$0",
        json!({}),
        "position: absolute; inset: 0; font-family: 'DM Sans'; font-size: 16px",
        vec![root],
    ));
    r["stylesheets"] = json!([SHEET]);
    r
}

/// Seed 1051095 (inline-heavy gaps in blocks), cut down: a block with a `::before` becomes `display: contents` inside
/// inline content (where its pseudo-element is not built into the text) in the frame that gives it a bigger font, then
/// a block again. The pseudo-element took the font size in the style system while no box held it, and its text was
/// not shaped again when the block had a box again: the block was as tall as before. (The fuzz's own sheet gives
/// the pseudo-element padding, which makes the edited document be built again in the middle frame, so that the seed
/// no longer reaches the edit; this sheet does not.)
#[test]
fn a_pseudo_element_that_had_no_box_while_its_owner_was_display_contents_is_shaped_again() {
    let tree = |style: &str| {
        let owner = el_attrs("p", "$0.0.0", json!({ "class": "star" }), style, vec![]);
        let mut page = fuzz_page(common::el("div", "$0.0", "", vec![text("alpha"), owner]));
        page["stylesheets"] = json!([".star::before { content: '*' }"]);
        page
    };
    let (got, want) = chain_and_fresh(vec![tree(""), tree("display: contents; font-size: 30px"), tree("font-size: 30px")]);
    assert_eq!(got, want);
}

/// Seed 1052885 (by edits, a jump back), cut down: a `<span>` inside a `display: contents` element inside inline
/// content has no box, then the contents element is a block again, which makes the `<span>` one that holds a block.
/// Nothing built the `<span>`'s layout children again, and the block inside kept the layout parent it had as inline
/// content: it was never laid out at its place (a width of 0).
#[test]
fn a_node_that_was_inline_content_is_built_as_a_box_when_it_stops_being_inline_content() {
    let tree = |contents: &str, inner: &str| {
        let inner = common::el("div", "$0.0.0.0.0", inner, vec![]);
        let span = common::el("span", "$0.0.0.0", "", vec![inner]);
        let contents = el_attrs("div", "$0.0.0", json!({}), contents, vec![span]);
        fuzz_page(common::el("div", "$0.0", "", vec![common::el("span", "$0.0.0", "", vec![contents])]))
    };
    let (got, want) = chain_and_fresh(vec![
        tree("display: contents; position: absolute", "transform: translate(-39px, 12px)"),
        tree("", ""),
    ]);
    assert_eq!(got, want);
}

/// Seed 1051916 (gaps in blocks), cut down: a flex item's font size goes from 16 to 30px and its child (a block with a
/// flex box and a text in it) goes from block to inline-block in one edit. The line round the inline-block took its
/// baseline from a measurement of the flex box that the cache answered with the final layout's baselines; a measurement
/// that is not cached gives a flex box none (taffy's measure of one is its size only), so the line was taller than in
/// the document built afresh.
#[test]
fn an_inline_block_sits_on_the_line_the_same_whether_its_flex_child_was_measured_before_or_not() {
    let tree = |item: &str, inline: &str| {
        let flex = el_attrs("div", "$0.0.0.0.0.0", json!({ "class": "flex" }), "", vec![text("gamma")]);
        let b = common::el("b", "$0.0.0.0.0", &format!("font-size: 22px; {inline}"), vec![flex, text("1234")]);
        let item = common::el("div", "$0.0.0.0", item, vec![b]);
        let p = common::el("p", "$0.0.0", "display: flex", vec![item]);
        fuzz_page(common::el("div", "$0.0", "", vec![p]))
    };
    let (got, want) = chain_and_fresh(vec![tree("", ""), tree("font-size: 30px", "display: inline-block")]);
    assert_eq!(got, want);
}

/// Seed 1052922 (by edits, a jump back), cut down: a block inside inline content (`<b><em><div>`) goes through a frame
/// where `<b>` is `display: contents`, which makes the page's block lay the `<div>` out as an inline box (width 0
/// for the empty block), and then back. Nothing damaged the `<div>` but a repaint, and it kept the layout cache of
/// the first container's algorithm: a width of 0 where the block's container gives it the width of the box.
#[test]
fn a_block_whose_container_changed_is_not_laid_out_from_the_cache_of_the_old_container() {
    let tree = |b: &str, div: &str| {
        let div = common::el("div", "$0.0.0.0.0.0", div, vec![]);
        let em = common::el("em", "$0.0.0.0.0", "", vec![div]);
        let b = common::el("b", "$0.0.0.0", b, vec![em]);
        fuzz_page(common::el("div", "$0.0", "", vec![common::el("span", "$0.0.0", "", vec![b])]))
    };
    let turn = "transform: translate(-8px, -18px) rotate(-10deg) scale(1.3)";
    let (got, want) = chain_and_fresh(vec![
        tree("width: 94px", turn),
        tree("display: contents; position: absolute; width: 94px", &format!("opacity: 0.2; {turn}")),
        tree("width: 94px", turn),
    ]);
    assert_eq!(got, want);
}

/// What a box keeps that is not its layout (its stacking context, the hoisted entries it gave an ancestor's stacking
/// context, the container size a query saw, a transform and the overflow of its content) must not survive the edit
/// that makes it `display: contents`: the document drawn is the one built from the same request.
fn becomes_display_contents(style: &str, children: impl Fn() -> Vec<Value>, sheet: Option<&str>) {
    let tree = |contents: &str| {
        let owner = el_attrs("div", "$0.0.0", json!({ "class": "cq" }), &format!("{style}; {contents}"), children());
        let sibling = common::el("div", "$0.0.1", "position: absolute; z-index: 1; left: 30px; top: 8px; width: 60px; height: 20px; background: #a33", vec![]);
        let mut page = fuzz_page(common::el("div", "$0.0", "", vec![owner, sibling]));
        if let Some(sheet) = sheet {
            page["stylesheets"] = json!([SHEET, sheet]);
        }
        page
    };
    let (got, want) = chain_and_fresh(vec![tree(""), tree("display: contents")]);
    assert_eq!(got, want);
}

#[test]
fn a_stacking_context_is_not_kept_by_a_box_that_becomes_display_contents() {
    becomes_display_contents(
        "position: relative; z-index: 2; width: 100px; height: 30px; background: #345",
        || vec![text("kinet")],
        None,
    );
}

#[test]
fn the_entries_a_box_gave_an_enclosing_stacking_context_are_not_kept_when_it_becomes_display_contents() {
    becomes_display_contents(
        "width: 100px; height: 30px",
        || vec![common::el("div", "$0.0.0.0", "position: absolute; z-index: 3; left: 5px; top: 5px; width: 40px; height: 20px; background: #3a3", vec![])],
        None,
    );
}

#[test]
fn a_container_size_is_not_kept_by_a_box_that_becomes_display_contents() {
    becomes_display_contents(
        "container-type: inline-size; width: 400px",
        || vec![el_attrs("span", "$0.0.0.0", json!({ "class": "t" }), "", vec![text("kinet")])],
        Some("@container (min-width: 300px) { .t { color: #c00 } }"),
    );
}

#[test]
fn a_transform_and_overflow_are_not_kept_by_a_box_that_becomes_display_contents() {
    becomes_display_contents(
        "transform: rotate(10deg); overflow: hidden; width: 50px; height: 20px",
        || vec![text("a long text that does not fit in the box it is in")],
        None,
    );
}

/// Seed 1060260, cut down: an absolutely positioned block after a block in a relative `<span>` is hoisted to the
/// anonymous block that wraps the `<span>` (the span is inline content, no containing block of its own). The frame
/// that puts it back in flow builds the parent's layout children again, which frees the anonymous block. Nothing
/// took the freed block off the box as its containing block, and readback placed the box 16px up from it.
#[test]
fn a_box_back_in_flow_does_not_keep_a_freed_anonymous_block_as_its_containing_block() {
    let tree = |p: &str| {
        let p = common::el("p", "$0.0.1.0", p, vec![]);
        let span = el_attrs("span", "$0.0.1", json!({ "class": "rel" }), "", vec![p]);
        fuzz_page(common::el("div", "$0.0", "", vec![common::el("div", "$0.0.0", "", vec![]), span]))
    };
    let (got, want) = chain_and_fresh(vec![tree("position: absolute; left: 108px; top: 139px"), tree("")]);
    assert_eq!(got, want);
}

/// Seed 1060462, cut down: a `<span>` holding a block and a text is inside a `display: contents` element inside inline
/// content, and the frame changes the contents element's `position` (which damages it, not the `<span>`). The `<span>`
/// is built as a box now, but the paint tree skipped it, as nothing damaged it: it had no paint children, and
/// its text was not drawn.
#[test]
fn a_node_built_again_after_being_inline_content_has_its_paint_children_built() {
    let tree = |position: &str| {
        let div = common::el("div", "$0.0.0.0.0.0", "", vec![]);
        let span = common::el("span", "$0.0.0.0.0", "", vec![div, text("frame")]);
        let contents = el_attrs("em", "$0.0.0.0", json!({ "class": "contents" }), position, vec![span]);
        fuzz_page(common::el("div", "$0.0", "", vec![common::el("em", "$0.0.0", "", vec![contents])]))
    };
    let (got, want) = chain_and_fresh(vec![tree("position: absolute"), tree("position: static")]);
    assert_eq!(got, want);
}

/// Seed 15909, cut down: the text of a table cell in a block in a flex box, and the frame that makes the block a flex
/// box too. Measuring the block's content again broke the text into lines at another width (it wrapped), and the cell's
/// final layout was taken from the cache that described the lines of the run before: the text was drawn as two
/// lines in a cell that is one line tall.
#[test]
fn a_cached_final_layout_is_not_taken_for_text_broken_by_a_later_measurement() {
    let tree = |col: &str| {
        let td = common::el("td", "$0.0.0.0.0.0", "", vec![text("go gamma")]);
        let table = common::el("table", "$0.0.0.0.0", "", vec![td]);
        let col = el_attrs("div", "$0.0.0.0", json!({ "class": "col" }), col, vec![table]);
        fuzz_page(common::el("div", "$0.0", "", vec![el_attrs("div", "$0.0.0", json!({ "class": "flex" }), "", vec![col])]))
    };
    let (got, want) = chain_and_fresh(vec![tree(""), tree("display: flex")]);
    assert_eq!(got, want);
}

/// The page of the container query tests: a `.cq` box that is a size container, a `.t` text that is red when the
/// container is 300px wide or more, in a `.wrap` box of `wrap` width.
fn container_page(wrap: &str, cq: &str) -> Value {
    let span = el_attrs("span", "$0.0.0.0.0", json!({ "class": "t" }), "", vec![text("kinet")]);
    let owner = el_attrs("div", "$0.0.0.0", json!({ "class": "cq" }), &format!("container-type: inline-size; {cq}"), vec![span]);
    let wrap = common::el("div", "$0.0.0", &format!("width: {wrap}"), vec![owner]);
    let mut page = fuzz_page(common::el("div", "$0.0", "", vec![wrap]));
    page["stylesheets"] = json!([SHEET, "@container (min-width: 300px) { .t { color: #c00 } }"]);
    page
}

/// A container that stops generating a box (`display: none` here, `display: contents` above) has no size for its
/// queries: they do not match, as in a document built with it hidden.
#[test]
fn a_container_that_becomes_display_none_has_no_size_for_its_queries() {
    let (got, want) = chain_and_fresh(vec![container_page("400px", ""), container_page("400px", "display: none")]);
    assert_eq!(got, want);
}

/// And when its box comes back, the queries see the size it has.
#[test]
fn a_container_whose_box_comes_back_is_asked_its_size_again() {
    let (got, want) = chain_and_fresh(vec![
        container_page("400px", ""),
        container_page("400px", "display: contents"),
        container_page("400px", ""),
    ]);
    assert_eq!(got, want);
    let (got, want) = chain_and_fresh(vec![
        container_page("400px", ""),
        container_page("400px", "display: none"),
        container_page("400px", ""),
    ]);
    assert_eq!(got, want);
}

/// A container whose size changes with no style of its own changing (the box round it is resized).
#[test]
fn a_container_resized_by_its_parent_is_asked_its_size_again() {
    let (got, want) = chain_and_fresh(vec![container_page("400px", ""), container_page("200px", ""), container_page("400px", "")]);
    assert_eq!(got, want);
}
