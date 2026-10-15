//! Turns the `<svg>` elements of an HTML file into a scene (for comparing with
//! a browser): `cargo run -p kinetograph-dom --example svg_scene -- in.html
//! out.json [width height]`.
//!
//! Each top-level `<svg>` is painted by `paint_svg` at the position and size the
//! document's layout gives it. The page is `width` x `height` (default 800 x
//! 600), white.

use std::collections::BTreeMap;

use blitz_dom::{DocumentConfig, NodeId};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};
use kinetograph_dom::paint::svg::paint_svg;
use kinetograph_dom::request::{DomNode, IslandRequest, Size};
use serde_json::json;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let html = std::fs::read_to_string(&args[1]).expect("read the html");
    let (width, height) = (
        args.get(3).and_then(|w| w.parse().ok()).unwrap_or(800u32),
        args.get(4).and_then(|h| h.parse().ok()).unwrap_or(600u32),
    );
    let mut doc = HtmlDocument::from_html(
        &html,
        DocumentConfig {
            viewport: Some(Viewport::new(width, height, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    )
    .into_inner();
    doc.resolve(0.0);
    let request = IslandRequest {
        root: DomNode::Text {
            text: String::new(),
        },
        stylesheets: Vec::new(),
        viewport: Size {
            width: f64::from(width),
            height: f64::from(height),
        },
        fonts: BTreeMap::new(),
        base_dir: std::path::Path::new(&args[1])
            .parent()
            .map_or(".".into(), |p| p.to_string_lossy().into_owned()),
        public_dir: None,
        time: 0.0,
        path: "$0".into(),
    };
    let mut svgs: Vec<NodeId> = Vec::new();
    let mut stack = vec![doc.root_node().id];
    while let Some(id) = stack.pop() {
        let node = doc.get_node(id).expect("node");
        if node
            .data
            .is_element_with_tag_name(&blitz_dom::local_name!("svg"))
        {
            svgs.push(id);
            continue;
        }
        stack.extend(node.children.iter().rev().copied());
    }
    let mut layers = Vec::new();
    for (i, id) in svgs.iter().enumerate() {
        let rect = doc.get_client_bounding_rect(*id).expect("layout");
        let painted = paint_svg(
            &doc,
            &request,
            *id,
            [rect.width, rect.height],
            &format!("svg{i}"),
            &format!("$0.{i}"),
        );
        for u in &painted.unsupported {
            eprintln!("unsupported: {u:?}");
        }
        if let Some(mut layer) = painted.layer {
            layer["transform"] = json!({"x": rect.x, "y": rect.y});
            layers.push(layer);
        }
    }
    let scene = json!({
        "width": width, "height": height, "fps": 30, "durationInFrames": 1,
        "background": "#ffffff", "layers": layers,
    });
    std::fs::write(&args[2], serde_json::to_string_pretty(&scene).unwrap()).expect("write");
}
