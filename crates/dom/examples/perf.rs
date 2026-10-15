//! Per-frame cost of building and resolving a papercut-shaped island
//! (docs/ENGINE.md §7): `cargo run --release -p kinetograph-dom --example perf [slabs]`.
//!
//! The island imitates `lib/papercut/kit`: absolutely positioned "slabs" with a
//! grain `background-image`, `backgroundBlendMode`, rotation by the individual
//! `rotate`/`translate` properties, inset shadows and rounded corners, text
//! pills in a registered font, a few `<img>` and `<svg>`.

use std::time::Instant;

use kinetograph_dom::document::{self, PATH_ATTR};
use kinetograph_dom::{IslandRequest, readback};
use serde_json::{Value, json};

fn el(tag: &str, path: &str, style: String, children: Vec<Value>, attrs: Value) -> Value {
    json!({ "kind": "element", "tag": tag, "path": path, "attrs": attrs, "style": style, "children": children })
}

fn slab(path: &str, i: usize, grain: &str) -> Value {
    let (x, y) = ((i * 97) % 900, (i * 61) % 1700);
    let kids = vec![
        el(
            "div",
            &format!("{path}.0"),
            "position:absolute;left:0;top:0;width:100%;height:12%;background:#ffffff33".into(),
            vec![],
            json!({}),
        ),
        el(
            "div",
            &format!("{path}.1"),
            "position:absolute;left:0;bottom:0;width:100%;height:18%;background:linear-gradient(#0000,#0003)".into(),
            vec![],
            json!({}),
        ),
    ];
    el(
        "div",
        path,
        format!(
            "position:absolute;left:{x}px;top:{y}px;width:{}px;height:{}px;border-radius:4px;overflow:hidden;\
             rotate:{}deg;background-color:#e8dcc4;background-image:url({grain});background-size:520px;\
             background-blend-mode:multiply;box-shadow:inset 1.5px 1.5px 0 rgba(255,255,255,0.22)",
            120 + (i % 7) * 20,
            80 + (i % 5) * 30,
            (i % 9) as f64 - 4.0
        ),
        kids,
        json!({}),
    )
}

fn pill(path: &str, i: usize) -> Value {
    el(
        "div",
        path,
        format!(
            "position:absolute;left:{}px;top:{}px;translate:-50% -50%;rotate:{}deg;white-space:nowrap;\
             background:#222;color:#f3eee6;font-family:Inter;font-weight:800;font-size:30px;\
             letter-spacing:0.02em;padding:7px 15px 8px;border-radius:8px;\
             box-shadow:inset 1px 1px 0 rgba(255,255,255,0.18),1px 3px 5px rgba(0,0,0,0.35)",
            100 + (i * 53) % 800,
            100 + (i * 131) % 1700,
            (i % 5) as f64 - 2.0
        ),
        vec![json!({ "kind": "text", "text": format!("LABEL {i}") })],
        json!({}),
    )
}

fn island(slabs: usize, grain: &str, logo: &str, fonts: &Value, time: f64) -> Value {
    let mut kids = Vec::new();
    for i in 0..slabs {
        kids.push(slab(&format!("$0.{}", kids.len()), i, grain));
        if i % 3 == 0 {
            kids.push(pill(&format!("$0.{}", kids.len()), i));
        }
        if i % 10 == 0 {
            kids.push(el(
                "img",
                &format!("$0.{}", kids.len()),
                "position:absolute;left:10px;top:10px;width:200px;height:200px;object-fit:cover"
                    .into(),
                vec![],
                json!({ "src": logo }),
            ));
            kids.push(el(
                "svg",
                &format!("$0.{}", kids.len()),
                "position:absolute;left:300px;top:300px".into(),
                (0..6)
                    .map(|k| {
                        el(
                            "path",
                            &format!("$0.{}.{k}", kids.len()),
                            String::new(),
                            vec![],
                            json!({ "d": "M0-10 L2-2 L10 0 L2 2 L0 10 L-2 2 L-10 0 L-2-2Z", "fill": "#f5c542", "transform": format!("translate({} 20)", k * 24) }),
                        )
                    })
                    .collect(),
                json!({ "width": "160", "height": "40", "viewBox": "0 0 160 40" }),
            ));
        }
    }
    json!({
        "root": el("div", "$0", "position:absolute;inset:0;display:flex;flex-direction:column;background:#d9c9a6".into(), kids, json!({})),
        "viewport": { "width": 1080.0, "height": 1920.0 },
        "fonts": fonts,
        "baseDir": "/",
        "time": time,
        "path": "$0",
    })
}

fn count(v: &Value) -> usize {
    1 + v["children"]
        .as_array()
        .map(|c| c.iter().map(count).sum::<usize>())
        .unwrap_or(0)
}

fn main() {
    let dir = std::env::temp_dir().join("kg-dom-perf");
    std::fs::create_dir_all(&dir).unwrap();
    let grain = dir.join("grain.png");
    let logo = dir.join("logo.png");
    let noise = image::RgbaImage::from_fn(512, 512, |x, y| {
        let v = 200 + ((x * 7 + y * 13) % 55) as u8;
        image::Rgba([v, v, v, 255])
    });
    noise.save(&grain).unwrap();
    image::RgbaImage::from_pixel(256, 256, image::Rgba([30, 120, 200, 255]))
        .save(&logo)
        .unwrap();
    let fonts = json!({ "Inter:800": format!("{}/tests/fixtures/fonts/inter-800-latin.woff2", env!("CARGO_MANIFEST_DIR")) });

    let mut sizes: Vec<usize> = std::env::args()
        .skip(1)
        .map(|a| a.parse().unwrap())
        .collect();
    if sizes.is_empty() {
        sizes = vec![10, 40, 120];
    }
    for slabs in sizes {
        let value = island(
            slabs,
            grain.to_str().unwrap(),
            logo.to_str().unwrap(),
            &fonts,
            0.5,
        );
        let nodes = count(&value["root"]);
        let json_text = serde_json::to_string(&value).unwrap();

        // The fixed costs of a fresh document, apart from its tree.
        {
            let request: IslandRequest = serde_json::from_str(&json_text).unwrap();
            let mut fonts_ms = Vec::new();
            let mut empty_ms = Vec::new();
            for _ in 0..20 {
                let t = Instant::now();
                let ctx =
                    kinetograph_dom::fonts::font_context(&request.fonts, std::path::Path::new("/"))
                        .unwrap();
                fonts_ms.push(t.elapsed().as_secs_f64() * 1e3);
                let t = Instant::now();
                let mut empty = request.clone();
                empty.root =
                    serde_json::from_value(el("div", "$0", String::new(), vec![], json!({})))
                        .unwrap();
                let _ = document::resolve(&empty).unwrap();
                empty_ms.push(t.elapsed().as_secs_f64() * 1e3);
                drop(ctx);
            }
            fonts_ms.sort_by(f64::total_cmp);
            empty_ms.sort_by(f64::total_cmp);
            println!(
                "     fixed: font_context {:.2} ms, an empty island's whole resolve {:.2} ms",
                fonts_ms[10], empty_ms[10]
            );
        }

        let mut parse = Vec::new();
        let mut build = Vec::new();
        let mut total = Vec::new();
        let mut boxes = Vec::new();
        for round in 0..25 {
            let t = Instant::now();
            let request: IslandRequest = serde_json::from_str(&json_text).unwrap();
            let p = t.elapsed();
            let t = Instant::now();
            let (_built, _files) = document::build(&request).unwrap();
            let b = t.elapsed();
            let t = Instant::now();
            let island = document::resolve(&request).unwrap();
            let r = t.elapsed();
            let t = Instant::now();
            let _ = readback::layout_boxes(&island);
            let x = t.elapsed();
            if round >= 5 {
                parse.push(p.as_secs_f64() * 1e3);
                build.push(b.as_secs_f64() * 1e3);
                total.push(r.as_secs_f64() * 1e3);
                boxes.push(x.as_secs_f64() * 1e3);
            }
        }
        let med = |v: &mut Vec<f64>| {
            v.sort_by(f64::total_cmp);
            v[v.len() / 2]
        };
        println!(
            "{slabs:>4} slabs, {nodes:>5} nodes, {:>7} bytes: parse {:.2} ms, build {:.2} ms, build+resolve {:.2} ms (resolve alone {:.2}), layout_boxes {:.2} ms",
            json_text.len(),
            med(&mut parse),
            med(&mut build),
            med(&mut total),
            med(&mut total) - med(&mut build),
            med(&mut boxes)
        );
    }
    let _ = PATH_ATTR;
}
