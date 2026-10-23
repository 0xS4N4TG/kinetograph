//! SVG goldens: an HTML page with inline `<svg>` (or a CSS `filter: url(#id)`)
//! painted by `kinetograph_dom::paint::svg` into a scene and rendered on the GPU,
//! compared exactly with a committed PNG (made on the M4; regenerate with
//! `UPDATE_GOLDEN=1 cargo test -p kinetograph-dom --test svg_golden` after
//! checking the change by eye). Each page was also rendered by Chrome for
//! Testing and compared with the result by eye and by pixel difference; the
//! numbers are in packages/cli/skills/kinetograph/references/ENGINE.md section 9.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use blitz_dom::{BaseDocument, DocumentConfig, NodeId};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};
use kinetograph_core::{Frame, Scene, render_still};
use kinetograph_dom::paint::svg::{filter_graph, paint_svg};
use kinetograph_dom::request::{DomNode, IslandRequest, Size};
use serde_json::{Value, json};

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests")
}

fn document(name: &str, width: u32, height: u32) -> (BaseDocument, IslandRequest) {
    let html = std::fs::read_to_string(dir().join("svg").join(name)).unwrap();
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
        fonts: BTreeMap::from([(
            "DM".to_string(),
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../assets/fonts/DMSans-Medium.ttf")
                .to_string_lossy()
                .into_owned(),
        )]),
        base_dir: dir().join("svg").to_string_lossy().into_owned(),
        public_dir: None,
        time: 0.0,
        path: "$0".into(),
        history: Vec::new(),
    };
    (doc, request)
}

fn render(layers: Vec<Value>, width: u32, height: u32, background: &str) -> Frame {
    let scene = json!({
        "width": width, "height": height, "fps": 30, "durationInFrames": 1,
        "background": background, "layers": layers,
    });
    render_still(
        Scene::from_json(&scene.to_string(), PathBuf::new()).unwrap(),
        0,
    )
    .unwrap()
}

/// The top-level `<svg>` elements of the page, painted where layout puts them.
fn svg_page(name: &str, width: u32, height: u32) -> Frame {
    let (doc, request) = document(name, width, height);
    let mut svgs: Vec<NodeId> = Vec::new();
    let mut stack = vec![doc.root_node().id];
    while let Some(id) = stack.pop() {
        let node = doc.get_node(id).unwrap();
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
        let rect = doc.get_client_bounding_rect(*id).unwrap();
        // A zero-sized <svg> only holds definitions.
        if rect.width == 0.0 || rect.height == 0.0 {
            continue;
        }
        let painted = paint_svg(
            &doc,
            &request,
            *id,
            [rect.width, rect.height],
            &format!("svg{i}"),
            &format!("$0.{i}"),
        );
        assert!(
            painted.unsupported.is_empty(),
            "{name}: {:?}",
            painted.unsupported
        );
        let mut layer = painted.layer.unwrap();
        layer["transform"] = json!({"x": rect.x, "y": rect.y});
        layers.push(layer);
    }
    render(layers, width, height, "#ffffff")
}

fn check(name: &str, frame: &Frame) {
    let path = dir().join("golden").join(format!("{name}.png"));
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, frame.encode_png().unwrap()).unwrap();
        return;
    }
    let golden = image::load_from_memory(&std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "cannot read {}: {e} (run with UPDATE_GOLDEN=1)",
            path.display()
        )
    }))
    .unwrap()
    .to_rgba8();
    assert_eq!(
        (golden.width(), golden.height()),
        (frame.width, frame.height),
        "{name}: size changed"
    );
    let differing = golden
        .as_raw()
        .chunks(4)
        .zip(frame.rgba.chunks(4))
        .filter(|(a, b)| a != b)
        .count();
    assert_eq!(
        differing,
        0,
        "{name}: pixels differ from {}",
        path.display()
    );
}

#[test]
fn basic_shapes_gradients_and_strokes_match_golden() {
    check("svg-shapes", &svg_page("shapes.html", 400, 300));
}

#[test]
fn clips_masks_patterns_markers_and_filters_match_golden() {
    check("svg-features", &svg_page("features.html", 480, 360));
}

#[test]
fn text_css_transforms_use_and_nested_svg_match_golden() {
    check(
        "svg-text-transforms",
        &svg_page("text-transforms.html", 400, 240),
    );
}

#[test]
fn papercut_ink_strokes_match_golden() {
    // proof.tsx's Stroke: a dashed round mask with pathLength, a filtered group
    // that multiplies into the page, `filter: url(#rough)` from another <svg>.
    check("svg-papercut-ink", &svg_page("papercut-ink.html", 540, 360));
}

#[test]
fn css_filter_url_on_boxes_matches_golden() {
    // papercut's Paper: a div with `filter: url(#torn)`, and one with
    // `url(#rough)` and a rotation. The box painter (stream 2) calls
    // `filter_graph` with the box's size; the effect goes on the box's layer.
    let (doc, request) = document("papercut-torn.html", 420, 340);
    let boxes = [
        ("torn", "#f3e6c8", [60.0, 50.0, 300.0, 160.0], 0.0),
        ("rough", "#e9c46a", [100.0, 240.0, 200.0, 80.0], -4.0),
    ];
    let mut layers = Vec::new();
    for (i, (id, color, [x, y, w, h], rotation)) in boxes.into_iter().enumerate() {
        let effect = filter_graph(
            &doc,
            &request,
            &format!("url(#{id})"),
            [0.0, 0.0, w, h],
            &format!("box{i}"),
            &format!("$0.{i}"),
        )
        .unwrap();
        assert!(effect.unsupported.is_empty());
        layers.push(json!({
            "id": format!("box{i}"), "type": "shape",
            "shape": {"kind": "rect", "width": w, "height": h}, "fill": color,
            "transform": {"x": x + w / 2.0, "y": y + h / 2.0, "rotation": rotation,
                          "anchorX": w / 2.0, "anchorY": h / 2.0},
            "effects": [effect.effect],
        }));
    }
    check("svg-papercut-torn", &render(layers, 420, 340, "#ffffff"));
    // A reference to nothing is ignored, as CSS does.
    assert!(
        filter_graph(
            &doc,
            &request,
            "url(#nope)",
            [0.0, 0.0, 1.0, 1.0],
            "x",
            "$0"
        )
        .is_none()
    );
}
