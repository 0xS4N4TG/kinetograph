//! The painter behind the real front half: an island request (as the TS side
//! sends it) is built, styled and laid out by `document::resolve`, painted,
//! and the scene is rendered on the GPU.

mod common;
mod paintkit;

use serde_json::json;

use common::{el, el_attrs, request, text};
use kinetograph_dom::document;
use kinetograph_dom::paint::paint;

fn tile() -> String {
    paintkit::repo_root()
        .join("crates/dom/tests/assets/tile.png")
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

#[test]
fn a_native_element_leaves_a_placeholder_where_its_layers_go() {
    let native = json!({ "kind": "native", "path": "$0.1", "width": 120.0, "height": 40.0 });
    let req = request(el(
        "div",
        "$0",
        "width:1000px;height:500px",
        vec![el(
            "div",
            "$0.0",
            "position:absolute;left:30px;top:50px;padding:5px;background:#fff",
            vec![native],
        )],
    ));
    let parsed = common::parse(&req);
    let island = document::resolve(&parsed).expect("resolves");
    let out = paint(&island.doc, &parsed);
    fn find(layers: &[serde_json::Value]) -> Option<&serde_json::Value> {
        layers.iter().find_map(|l| {
            if l["type"] == "native" {
                Some(l)
            } else {
                find(l["children"].as_array().map_or(&[], |c| c.as_slice()))
            }
        })
    }
    let placeholder = find(&out.layers).unwrap_or_else(|| panic!("no placeholder in {:?}", out.layers));
    assert_eq!(placeholder["path"], "$0.1");
    assert_eq!(placeholder["x"], 35);
    assert_eq!(placeholder["y"], 55);
    assert_eq!(placeholder["width"], 120);
    assert_eq!(placeholder["height"], 40);
}

#[test]
fn a_papercut_style_card_paints_end_to_end() {
    let card = el_attrs(
        "div",
        "$0.0",
        json!({ "id": "card" }),
        &format!(
            "position:absolute;left:60px;top:40px;width:300px;height:180px;padding:12px;\
             background-color:#e9dcc0;background-image:url('file://{}');background-blend-mode:multiply;\
             background-repeat:repeat;border:6px solid #3a2f25;border-radius:18px;\
             box-shadow:inset 0 0 18px rgba(0,0,0,.35),0 10px 24px rgba(0,0,0,.4);\
             rotate:-3deg;letter-spacing:2px;color:#2a2018;font-family:'DM Sans';font-size:28px",
            tile()
        ),
        vec![
            text("Paper card"),
            el(
                "span",
                "$0.0.1",
                "display:block;font-size:16px;letter-spacing:0",
                vec![text("second line, no spacing")],
            ),
        ],
    );
    let req = request(el(
        "div",
        "$0",
        "width:1000px;height:500px;background:#8aa",
        vec![card],
    ));
    let parsed = common::parse(&req);
    let island = document::resolve(&parsed).expect("resolves");
    let out = paint(&island.doc, &parsed);
    assert!(out.unsupported.is_empty(), "{:?}", out.unsupported);
    let text = serde_json::to_string(&out.layers).unwrap();
    // The card is a group (it turns), its texture is tiled, and the id is the explicit one.
    assert!(text.contains("\"id\":\"card\""), "{text}");
    assert!(
        text.contains("\"type\":\"image\""),
        "the tiled background paint: {text}"
    );
    assert!(text.contains("\"repeatX\":true"), "{text}");
    assert!(text.contains("\"blendMode\":\"multiply\""), "{text}");
    assert!(text.contains("\"runs\""), "glyph runs: {text}");
    std::fs::create_dir_all(paintkit::out_dir()).unwrap();
    std::fs::write(
        paintkit::out_dir().join("island-card-scene.json"),
        serde_json::to_string_pretty(&paintkit::scene_json(&out, 1000, 500)).unwrap(),
    )
    .unwrap();
    // And it renders.
    let frame = paintkit::render_output(&out, 1000, 500);
    paintkit::save_frame(&frame, &paintkit::out_dir().join("island-card-ours.png"));
}
