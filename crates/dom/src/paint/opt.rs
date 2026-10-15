//! A last pass over the painted layers that removes what draws nothing and
//! what a layer can say itself: fewer layers for the compositor, the same
//! picture.

use serde_json::{Map, Value};

use super::util::num;

/// Optimises a layer list.
pub fn optimize(layers: Vec<Value>) -> Vec<Value> {
    // A matte source that draws nothing still has to be there.
    let sources: Vec<String> = layers
        .iter()
        .filter_map(|l| l["matte"]["layer"].as_str().map(str::to_string))
        .collect();
    layers
        .into_iter()
        .flat_map(|l| {
            let keep = l["id"].as_str().is_some_and(|id| sources.iter().any(|s| s == id));
            optimize_layer(l, keep)
        })
        .collect()
}

fn optimize_layer(mut layer: Value, keep: bool) -> Vec<Value> {
    if let Some(children) = layer.get_mut("children") {
        let list = std::mem::take(children);
        if let Value::Array(list) = list {
            *children = Value::Array(optimize(list));
        }
    }
    if !keep && draws_nothing(&layer) {
        return Vec::new();
    }
    vec![merge_single_child(layer)]
}

/// A shape with no area and no stroke, a group with nothing in it.
fn draws_nothing(layer: &Value) -> bool {
    match layer["type"].as_str() {
        Some("group") => {
            layer["children"].as_array().is_none_or(Vec::is_empty)
                // A matte source is not drawn, so it must stay.
                && layer.get("matte").is_none()
        }
        Some("shape") => {
            let size = |k: &str| layer["shape"][k].as_f64();
            let empty = matches!(layer["shape"]["kind"].as_str(), Some("rect" | "roundedRect" | "ellipse"))
                && (size("width").is_some_and(|w| w <= 0.0) || size("height").is_some_and(|h| h <= 0.0));
            empty && layer.get("stroke").is_none()
        }
        _ => false,
    }
}

/// The keys a leaf layer can have and still take its parent group's
/// transform, opacity, effects and clip.
const LEAF_KEYS: &[&str] = &[
    "id", "type", "shape", "fill", "stroke", "color", "runs", "boxWidth", "boxHeight", "src", "width",
    "height", "fit", "effects", "transform", "clip", "opacity", "text", "font", "size",
];

/// A group of one leaf layer is that leaf with the group's fields: the
/// group's transform is about the group's origin, so the leaf's offset
/// moves into the anchor.
fn merge_single_child(group: Value) -> Value {
    let Some(g) = group.as_object() else {
        return group;
    };
    if g.get("type").and_then(Value::as_str) != Some("group") {
        return group;
    }
    let Some([child]) = g.get("children").and_then(Value::as_array).map(Vec::as_slice) else {
        return group;
    };
    let Some(c) = child.as_object() else {
        return group;
    };
    let group_keys_ok = g
        .keys()
        .all(|k| matches!(k.as_str(), "id" | "type" | "children" | "transform" | "opacity" | "effects" | "clip" | "blendMode"));
    let leaf_ok = c.keys().all(|k| LEAF_KEYS.contains(&k.as_str()))
        && c.get("type").and_then(Value::as_str).is_some_and(|t| t != "group");
    // One clip, one blend, and a leaf transform that is only a move.
    let clips_ok = !(g.contains_key("clip") && c.contains_key("clip"));
    let leaf_t = c.get("transform").and_then(Value::as_object);
    let leaf_move_only = leaf_t.is_none_or(|t| t.keys().all(|k| k == "x" || k == "y"));
    let leaf_has_blend = c.get("blendMode").is_some();
    let group_has_group_blend = g.get("blendMode").is_some();
    if !(group_keys_ok && leaf_ok && clips_ok && leaf_move_only && !(leaf_has_blend && group_has_group_blend)) {
        return group;
    }
    // A group's clip is in the group's space: with an offset leaf it would
    // have to move too, so such a pair is left alone.
    let (cx, cy) = leaf_t.map_or((0.0, 0.0), |t| (t.get("x").and_then(Value::as_f64).unwrap_or(0.0), t.get("y").and_then(Value::as_f64).unwrap_or(0.0)));
    if g.contains_key("clip") && (cx != 0.0 || cy != 0.0) {
        return group;
    }

    let mut out: Map<String, Value> = c.clone();
    // Transform: the group's, with the anchor moved by the leaf's offset.
    let mut t: Map<String, Value> = g
        .get("transform")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let only_a_move = t.keys().all(|k| k == "x" || k == "y");
    if (cx != 0.0 || cy != 0.0) && only_a_move {
        let gx = t.get("x").and_then(Value::as_f64).unwrap_or(0.0);
        let gy = t.get("y").and_then(Value::as_f64).unwrap_or(0.0);
        t.insert("x".into(), num(gx + cx));
        t.insert("y".into(), num(gy + cy));
    } else if cx != 0.0 || cy != 0.0 {
        let ax = t.get("anchorX").and_then(Value::as_f64).unwrap_or(0.0) - cx;
        let ay = t.get("anchorY").and_then(Value::as_f64).unwrap_or(0.0) - cy;
        t.insert("anchorX".into(), num(ax));
        t.insert("anchorY".into(), num(ay));
    }
    if t.is_empty() {
        out.remove("transform");
    } else {
        out.insert("transform".into(), Value::Object(t));
    }
    // Effects: the leaf's first, then the group's.
    let mut effects: Vec<Value> = c.get("effects").and_then(Value::as_array).cloned().unwrap_or_default();
    effects.extend(g.get("effects").and_then(Value::as_array).cloned().unwrap_or_default());
    if effects.is_empty() {
        out.remove("effects");
    } else {
        out.insert("effects".into(), Value::Array(effects));
    }
    if let Some(clip) = g.get("clip") {
        out.insert("clip".into(), clip.clone());
    }
    if let Some(b) = g.get("blendMode") {
        out.insert("blendMode".into(), b.clone());
    }
    let opacity = g.get("opacity").and_then(Value::as_f64).unwrap_or(1.0) * c.get("opacity").and_then(Value::as_f64).unwrap_or(1.0);
    if opacity < 1.0 {
        out.insert("opacity".into(), super::util::num4(opacity));
    } else {
        out.remove("opacity");
    }
    // The group's id stays: nothing refers to either.
    if let Some(id) = g.get("id") {
        out.insert("id".into(), id.clone());
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_shapes_and_groups_go() {
        let out = optimize(vec![
            json!({"id":"a","type":"shape","shape":{"kind":"rect","width":0,"height":5},"fill":"#000"}),
            json!({"id":"g","type":"group","children":[]}),
            json!({"id":"b","type":"shape","shape":{"kind":"rect","width":3,"height":5},"fill":"#000"}),
        ]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["id"], "b");
    }

    #[test]
    fn a_group_of_one_leaf_is_the_leaf_with_the_groups_fields() {
        let out = optimize(vec![json!({
            "id": "g", "type": "group", "opacity": 0.5,
            "transform": { "x": 100, "y": 50, "anchorX": 20, "anchorY": 10, "matrix": [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1] },
            "children": [ { "id": "t", "type": "text", "color": "#000", "runs": [],
                            "transform": { "x": 4, "y": 6 }, "effects": [ { "type": "blur", "radius": 1 } ] } ]
        })]);
        assert_eq!(out.len(), 1);
        let l = &out[0];
        assert_eq!(l["type"], "text");
        assert_eq!(l["opacity"], 0.5);
        // The leaf sits 4,6 inside the group, whose anchor is 20,10: so the
        // layer's own anchor is 16,4.
        assert_eq!(l["transform"]["anchorX"], 16);
        assert_eq!(l["transform"]["anchorY"], 4);
        assert_eq!(l["transform"]["x"], 100);
        assert!(l["transform"]["matrix"].is_array());
    }

    #[test]
    fn groups_with_several_children_or_a_matte_stay() {
        let g = json!({ "id": "g", "type": "group", "opacity": 0.5, "children": [
            { "id": "a", "type": "shape", "shape": {"kind":"rect","width":1,"height":1}, "fill": "#000" },
            { "id": "b", "type": "shape", "shape": {"kind":"rect","width":1,"height":1}, "fill": "#000" } ] });
        assert_eq!(optimize(vec![g.clone()]), vec![g]);
        let m = json!({ "id": "g", "type": "group", "children": [
            { "id": "a", "type": "shape", "shape": {"kind":"rect","width":1,"height":1}, "fill": "#000", "matte": {"layer":"x"} } ] });
        assert_eq!(optimize(vec![m.clone()]), vec![m]);
    }
}
