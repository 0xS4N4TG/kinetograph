//! The JSON the TS side sends for one DOM island and what comes back
//! (packages/cli/skills/kinetograph/references/ENGINE.md §2). Owned by the orchestrator: a stream may add optional
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
    /// Earlier states of this island, oldest first. A CSS transition starts when a
    /// style value changes, and a frame has no "before" of its own; the caller
    /// supplies it here, and the engine replays the states in order to find
    /// when each value changed (`document::resolve`, packages/cli/skills/kinetograph/references/ENGINE.md §7.12).
    /// Empty: nothing transitions, every value is its final one.
    #[serde(default)]
    pub history: Vec<Snapshot>,
}

/// An earlier state of the island: its tree as it was at `time` (seconds).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub time: f64,
    pub root: DomNode,
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
        /// The box does not take part in the flow: it is placed at the top left of its containing block, over its
        /// siblings, as `position: absolute; left: 0; top: 0` does (a layer, a shape, a canvas: things that are
        /// drawn rather than laid out; an image or a text box stays in the flow).
        #[serde(default)]
        overlay: bool,
    },
}

/// What the island draws: `IslandResult` of `@kinetograph/compat`.
#[derive(Clone, Debug, Default, Serialize)]
pub struct IslandOutput {
    /// Scene layers (packages/cli/skills/kinetograph/references/SCENE.md) in paint order. `{"type": "native", "path", "x", "y", "width", "height"}` marks
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
}

/// `layers` written as changes from `base`, an earlier output of the same
/// island, matched by place: a layer that is the same as the one at index `i`
/// of `base` is `{"$same": i}`, and a group with the id of the one there
/// whose children differ is its own fields with `"$base": i` and its children
/// written as changes from that one's. Anything else is the layer itself.
pub fn delta(layers: Vec<Value>, base: &[Value]) -> Vec<Value> {
    layers
        .into_iter()
        .enumerate()
        .map(|(i, layer)| {
            let Some(was) = base.get(i) else {
                return layer;
            };
            if layer == *was {
                return serde_json::json!({ "$same": i });
            }
            let Some(Value::Array(theirs)) = was.get("children") else {
                return layer;
            };
            match layer {
                Value::Object(mut fields)
                    if fields.get("id") == was.get("id")
                        && matches!(fields.get("children"), Some(Value::Array(_))) =>
                {
                    if let Some(Value::Array(kids)) = fields.remove("children") {
                        fields.insert("children".into(), Value::Array(delta(kids, theirs)));
                    }
                    fields.insert("$base".into(), Value::from(i));
                    Value::Object(fields)
                }
                other => other,
            }
        })
        .collect()
}

/// `delta` undone: the layers it was given, from what it wrote and the same
/// `base`.
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
