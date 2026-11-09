//! An island's output written as JSON, its layers whole or as changes from the layers of an earlier render of the
//! island (the base): a layer that is the same as the one at index `i` of the base is `{"$same": i}`, and a group with
//! the id of the one there whose children differ is its own fields with `"$base": i` and its children written as
//! changes from that one's. Anything else is the layer itself.
//!
//! Each layer is written once, and kept as text for the next renders to be compared against: comparing text is far
//! cheaper than comparing the layers' values.

use serde::Serialize;
use serde_json::Value;

use super::{IslandOutput, Unsupported};

/// A layer written as JSON: a group by its own fields and its children, anything else whole. A group's fields keep
/// their place around `children`, so the layer reads back with its keys in the order a whole one has.
#[derive(Debug)]
pub enum Written {
    Layer(String),
    Group {
        /// The group's `id`, as JSON.
        id: Option<String>,
        /// Its fields before and after `children`, each as the inside of a JSON object (`"id":"a"`), or empty.
        before: String,
        after: String,
        children: Vec<Written>,
    },
}

/// `layers` written as JSON, layer by layer.
pub fn written(layers: &[Value]) -> serde_json::Result<Vec<Written>> {
    layers.iter().map(write_layer).collect()
}

fn write_layer(layer: &Value) -> serde_json::Result<Written> {
    let fields = match layer {
        Value::Object(fields) if matches!(fields.get("children"), Some(Value::Array(_))) => fields,
        _ => return serde_json::to_string(layer).map(Written::Layer),
    };
    let (mut before, mut after) = (String::new(), String::new());
    let mut children = None;
    for (name, value) in fields {
        if let (Value::Array(kids), "children") = (value, name.as_str()) {
            children = Some(written(kids)?);
            continue;
        }
        let own = if children.is_none() {
            &mut before
        } else {
            &mut after
        };
        if !own.is_empty() {
            own.push(',');
        }
        own.push_str(&serde_json::to_string(name)?);
        own.push(':');
        own.push_str(&serde_json::to_string(value)?);
    }
    let id = fields.get("id").map(serde_json::to_string).transpose()?;
    Ok(Written::Group {
        id,
        before,
        after,
        children: children.unwrap_or_default(),
    })
}

fn same(a: &Written, b: &Written) -> bool {
    match (a, b) {
        (Written::Layer(a), Written::Layer(b)) => a == b,
        (
            Written::Group {
                before: a,
                after: c,
                children: x,
                ..
            },
            Written::Group {
                before: b,
                after: d,
                children: y,
                ..
            },
        ) => a == b && c == d && x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y)),
        _ => false,
    }
}

/// A group as `{BEFORE,"children":CHILDREN,AFTER}`, with `children` writing the array.
fn push_group(before: &str, after: &str, out: &mut String, children: impl FnOnce(&mut String)) {
    out.push('{');
    out.push_str(before);
    if !before.is_empty() {
        out.push(',');
    }
    out.push_str(r#""children":"#);
    children(out);
    if !after.is_empty() {
        out.push(',');
        out.push_str(after);
    }
}

fn push_whole(layer: &Written, out: &mut String) {
    match layer {
        Written::Layer(json) => out.push_str(json),
        Written::Group {
            before,
            after,
            children,
            ..
        } => {
            push_group(before, after, out, |out| {
                out.push('[');
                for (i, child) in children.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    push_whole(child, out);
                }
                out.push(']');
            });
            out.push('}');
        }
    }
}

/// `layers` as a JSON array, written as changes from `base` when there is one.
fn push_layers(layers: &[Written], base: Option<&[Written]>, out: &mut String) {
    out.push('[');
    for (i, layer) in layers.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        let Some(was) = base.and_then(|base| base.get(i)) else {
            push_whole(layer, out);
            continue;
        };
        if same(layer, was) {
            out.push_str(&format!(r#"{{"$same":{i}}}"#));
            continue;
        }
        match (layer, was) {
            (
                Written::Group {
                    id,
                    before,
                    after,
                    children,
                },
                Written::Group {
                    id: theirs,
                    children: their_children,
                    ..
                },
            ) if id == theirs => {
                push_group(before, after, out, |out| {
                    push_layers(children, Some(their_children), out)
                });
                out.push_str(&format!(r#","$base":{i}}}"#));
            }
            _ => push_whole(layer, out),
        }
    }
    out.push(']');
}

/// `output` as JSON with its layers as `layers` writes them: as changes from `base` and with `"delta": pass` when
/// `base` is the layers of an earlier render of `pass`, else whole.
pub fn write_output(
    output: &IslandOutput,
    layers: &[Written],
    base: Option<(&[Written], u64)>,
) -> serde_json::Result<String> {
    #[derive(Serialize)]
    struct Rest<'a> {
        unsupported: &'a [Unsupported],
        camera: &'a Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        margin: Option<u32>,
        #[serde(rename = "blendSpace")]
        blend_space: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        delta: Option<u64>,
    }
    let rest = serde_json::to_string(&Rest {
        unsupported: &output.unsupported,
        camera: &output.camera,
        margin: output.margin,
        blend_space: output.blend_space,
        delta: base.map(|(_, pass)| pass),
    })?;
    let mut out = String::with_capacity(rest.len() + 64 * layers.len());
    out.push_str(r#"{"layers":"#);
    push_layers(layers, base.map(|(base, _)| base), &mut out);
    // `rest` is an object with fields: its own `{` is the comma after `layers`.
    out.push(',');
    out.push_str(&rest[1..]);
    Ok(out)
}

/// `layers` as a JSON array written as changes from `base` (as [`write_output`] writes them).
pub fn delta(layers: &[Value], base: &[Value]) -> serde_json::Result<String> {
    let (layers, base) = (written(layers)?, written(base)?);
    let mut out = String::new();
    push_layers(&layers, Some(&base), &mut out);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_whole_output_is_written_as_serde_writes_it() {
        let output = IslandOutput {
            layers: vec![
                json!({ "id": "a", "type": "group", "opacity": 0.5, "children": [
                    { "id": "b", "type": "shape" },
                    { "id": "c", "type": "group", "children": [] },
                ] }),
                json!({ "children": [], "zIndex": 2 }),
                json!({ "id": "d", "type": "text" }),
            ],
            margin: Some(4),
            blend_space: "srgb",
            ..IslandOutput::default()
        };
        let layers = written(&output.layers).unwrap();
        let whole = write_output(&output, &layers, None).unwrap();
        assert_eq!(whole, serde_json::to_string(&output).unwrap());
    }
}
