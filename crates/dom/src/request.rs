//! The JSON the TS side sends for one DOM island and what comes back
//! (docs/ENGINE.md §2). Owned by the orchestrator: a stream may add optional
//! fields; changing an existing one goes through the orchestrator.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One DOM island at one frame.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IslandRequest {
    pub root: DomNode,
    /// CSS text, in document order: `<style>` elements and imported `.css` files.
    #[serde(default)]
    pub stylesheets: Vec<String>,
    /// The composition's size: the box the island is laid out in.
    pub viewport: Size,
    /// `fontKey` of `@kinetograph/scene` (`Inter`, `Inter:800`, `Inter:400i`) → absolute font file.
    #[serde(default)]
    pub fonts: BTreeMap<String, String>,
    /// Relative paths in `src`/`url()` resolve against this, then `public_dir`.
    pub base_dir: String,
    #[serde(default)]
    pub public_dir: Option<String>,
    /// Seconds (frame / fps): the clock CSS animations and transitions read.
    #[serde(default)]
    pub time: f64,
    /// The island root's host-tree path (`$0.2`).
    pub path: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DomNode {
    Element {
        /// Lower-case HTML or SVG tag.
        tag: String,
        /// The element's host-tree path; layer ids and readback use it.
        path: String,
        /// Attributes as the DOM would have them: `class`, `id`, `src`, SVG attributes, … (strings).
        #[serde(default)]
        attrs: BTreeMap<String, String>,
        /// The `style` prop as CSS declarations (React's rules: unitless numbers get `px`).
        #[serde(default)]
        style: String,
        #[serde(default)]
        children: Vec<DomNode>,
    },
    Text {
        text: String,
    },
    /// A native `kg-*` element inside the island: a replaced box. Its layers are made by the TS side and put where
    /// the `native` placeholder layer comes back.
    Native {
        path: String,
        #[serde(default)]
        width: Option<f64>,
        #[serde(default)]
        height: Option<f64>,
    },
}

/// What the island draws: `IslandResult` of `@kinetograph/compat`.
#[derive(Clone, Debug, Default, Serialize)]
pub struct IslandOutput {
    /// Scene layers (docs/SCENE.md) in paint order. `{"type": "native", "path", "x", "y", "width", "height"}` marks
    /// where a `Native` node's layers go.
    pub layers: Vec<Value>,
    /// What could not be drawn as Chrome would draw it; the frame then goes to the Chrome fallback while it exists.
    pub unsupported: Vec<Unsupported>,
    /// A scene camera, when the island needs one.
    pub camera: Option<Value>,
}

/// `Unsupported` of `@kinetograph/scene`.
#[derive(Clone, Debug, Serialize)]
pub struct Unsupported {
    /// `'$0.2.1 <div>'`
    pub path: String,
    pub element: String,
    pub property: Option<String>,
    pub value: Option<String>,
    pub reason: String,
}
