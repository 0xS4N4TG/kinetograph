//! Helpers for the integration tests: requests written as JSON, fonts from the
//! repository, and the layout box of a path.

#![allow(dead_code)]

use std::path::PathBuf;

use kinetograph_dom::IslandRequest;
use kinetograph_dom::document::{self, IslandDocument};
use serde_json::{Value, json};

pub fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// `tests/fixtures/<name>`.
pub fn fixture(name: &str) -> String {
    manifest_dir()
        .join("tests/fixtures")
        .join(name)
        .to_string_lossy()
        .into_owned()
}

/// `assets/fonts/DMSans-Medium.ttf` of the repository.
pub fn dm_sans() -> String {
    manifest_dir()
        .join("../../assets/fonts/DMSans-Medium.ttf")
        .to_string_lossy()
        .into_owned()
}

pub fn inter_800() -> String {
    fixture("fonts/inter-800-latin.woff2")
}

pub fn archivo_black() -> String {
    fixture("fonts/archivo-black-400-latin.woff2")
}

pub fn jetbrains_mono() -> String {
    fixture("fonts/jetbrains-mono-700-latin.woff2")
}

/// An element node as JSON.
pub fn el(tag: &str, path: &str, style: &str, children: Vec<Value>) -> Value {
    json!({ "kind": "element", "tag": tag, "path": path, "style": style, "children": children })
}

pub fn el_attrs(tag: &str, path: &str, attrs: Value, style: &str, children: Vec<Value>) -> Value {
    json!({ "kind": "element", "tag": tag, "path": path, "attrs": attrs, "style": style, "children": children })
}

pub fn text(t: &str) -> Value {
    json!({ "kind": "text", "text": t })
}

/// A request for `root` in a 1000 x 500 composition with the test fonts
/// (`DM Sans` 400 and `Inter` 800) registered.
pub fn request(root: Value) -> Value {
    json!({
        "root": root,
        "viewport": { "width": 1000.0, "height": 500.0 },
        "fonts": { "DM Sans": dm_sans(), "Inter:800": inter_800() },
        "baseDir": manifest_dir().to_string_lossy(),
        "time": 0.0,
        "path": "$0",
    })
}

pub fn parse(request: &Value) -> IslandRequest {
    serde_json::from_value(request.clone()).expect("a valid request")
}

pub fn resolve(request: &Value) -> IslandDocument {
    document::resolve(&parse(request)).expect("resolves")
}

/// The border box of the element at `path`, in island coordinates: x, y, width, height.
pub fn bounds(island: &IslandDocument, path: &str) -> (f64, f64, f64, f64) {
    let id = island.node(path).unwrap_or_else(|| panic!("no node at {path}"));
    let r = island.doc.get_client_bounding_rect(id).expect("a box");
    (r.x, r.y, r.width, r.height)
}
