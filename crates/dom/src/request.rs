//! The JSON the TS side sends for one DOM island and what comes back
//! (packages/cli/skills/kinetograph-markup/references/ENGINE.md §2).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

mod node_de;
mod written;

pub use written::{Written, write_output, written};

/// One DOM island at one frame.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IslandRequest {
    pub root: DomNode,
    /// CSS text, in document order: `<style>` elements and imported `.css` files.
    #[serde(default)]
    pub stylesheets: Vec<String>,
    /// The composition's size: the box the island is laid out in.
    pub viewport: Size,
    /// `fontKey` of `@kinetographdev/scene` (`Inter`, `Inter:800`, `Inter:400i`) → absolute font file.
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
    /// Earlier states of this island, oldest first. A CSS transition starts when a
    /// style value changes, and a frame has no "before" of its own; the caller
    /// supplies it here, and the engine replays the states in order to find
    /// when each value changed (`document::resolve`, packages/cli/skills/kinetograph-markup/references/ENGINE.md §7.12).
    /// Empty: nothing transitions, every value is its final one.
    #[serde(default)]
    pub history: Vec<Snapshot>,
}

/// What a script changed in an island since the state of it the addon holds (`IslandCache::resolve_edits`), instead
/// of the whole request again. The caller numbers the states it sends (`stamp`); `base` is the one these edits are
/// made to.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IslandEdits {
    pub stamp: u64,
    pub base: u64,
    /// The island root's host-tree path.
    pub path: String,
    /// The request's `time` in the new state.
    pub time: f64,
    /// The elements that changed, in any order.
    pub set: Vec<NodeEdit>,
}

/// An element's new attributes and `style` (each left out when it did not change), and the new text of some of its
/// text children, by index in its `children`.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeEdit {
    pub path: String,
    #[serde(default)]
    pub attrs: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub style: Option<String>,
    #[serde(default)]
    pub texts: Vec<(usize, String)>,
}

/// An earlier state of the island: its tree as it was at `time` (seconds).
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub time: f64,
    pub root: DomNode,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

/// A node by its `kind` (`element`, `text`, `native`), read by hand (`node_de`); a field said to default to nothing
/// can be left out.
#[derive(Clone, Debug, PartialEq)]
pub enum DomNode {
    Element {
        /// Lower-case HTML or SVG tag.
        tag: String,
        /// The element's host-tree path; layer ids and readback use it.
        path: String,
        /// Attributes as the DOM would have them: `class`, `id`, `src`, SVG attributes, … (strings). Default: none.
        attrs: BTreeMap<String, String>,
        /// The `style` prop as CSS declarations (React's rules: unitless numbers get `px`). Default: none.
        style: String,
        /// Default: none.
        children: Vec<DomNode>,
    },
    Text {
        text: String,
    },
    /// A native `kg-*` element inside the island: a replaced box. Its layers are made by the TS side and put where
    /// the `native` placeholder layer comes back.
    Native {
        path: String,
        width: Option<f64>,
        height: Option<f64>,
        /// The box does not take part in the flow: it is placed at the top left of its containing block, over its
        /// siblings, as `position: absolute; left: 0; top: 0` does (a layer, a shape, a canvas: things that are
        /// drawn rather than laid out; an image or a text box stays in the flow). Default: false.
        overlay: bool,
    },
}

/// What the island draws: `IslandResult` of `@kinetographdev/compat`.
#[derive(Clone, Debug, Default, Serialize)]
pub struct IslandOutput {
    /// Scene layers (packages/cli/skills/kinetograph-markup/references/SCENE.md) in paint order. `{"type": "native", "path", "x", "y", "width", "height"}` marks
    /// where a `Native` node's layers go.
    pub layers: Vec<Value>,
    /// What could not be drawn as Chrome would draw it; the frame is drawn without it, or approximated, and the CLI warns.
    pub unsupported: Vec<Unsupported>,
    /// A scene camera, when the island needs one.
    pub camera: Option<Value>,
    /// The least scene `margin` (pixels) the island needs: how far its blurs
    /// (shadows, text shadows) reach past their layers, so a shadow that
    /// falls on the canvas from a layer near its edge is blurred from real
    /// pixels. The scene's margin is the largest of this and its effects'.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub margin: Option<u32>,
    /// The scene's `blendSpace` the island is painted for: `"srgb"`, because
    /// CSS composites sRGB-encoded values (a translucent shadow or overlay
    /// looks as Chrome's only when the layers are blended that way). The scene
    /// that holds the island's layers must set it.
    #[serde(rename = "blendSpace")]
    pub blend_space: &'static str,
    /// What the render was asked to report of elements it drew (`probes` of `renderDomIsland`), by host-tree path.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub probes: BTreeMap<String, Probe>,
}

/// What a script that checks the layout of a frame reads of an element, from the layout the frame is drawn from: its
/// `getBoundingClientRect` size and the computed `overflow-x` and `overflow-y`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Probe {
    pub width: f64,
    pub height: f64,
    #[serde(rename = "overflowX")]
    pub overflow_x: String,
    #[serde(rename = "overflowY")]
    pub overflow_y: String,
}

/// The layers [`write_output`] wrote as changes from `base`, put back
/// together.
pub fn undelta(layers: &[Value], base: &[Value]) -> Vec<Value> {
    layers
        .iter()
        .map(|layer| {
            if let Some(i) = layer.get("$same").and_then(Value::as_u64) {
                return base[i as usize].clone();
            }
            let Some(i) = layer.get("$base").and_then(Value::as_u64) else {
                return layer.clone();
            };
            let mut fields = layer.as_object().cloned().unwrap_or_default();
            fields.remove("$base");
            let theirs = base[i as usize]["children"]
                .as_array()
                .map_or(&[][..], Vec::as_slice);
            let kids = fields["children"].as_array().map_or(&[][..], Vec::as_slice);
            let kids = undelta(kids, theirs);
            fields.insert("children".into(), Value::Array(kids));
            Value::Object(fields)
        })
        .collect()
}

/// `Unsupported` of `@kinetographdev/scene`.
#[derive(Clone, Debug, Serialize)]
pub struct Unsupported {
    /// `'$0.2.1 <div>'`
    pub path: String,
    pub element: String,
    pub property: Option<String>,
    pub value: Option<String>,
    pub reason: String,
}
