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

/// A layer written as JSON: a group by its own fields and its children, anything else whole.
#[derive(Debug)]
pub enum Written {
    Layer(String),
    Group {
        /// The group's `id`, as JSON.
        id: Option<String>,
        /// Its fields but `children`, as the inside of a JSON object (`"id":"a","type":"group"`).
        own: String,
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
    let mut own = String::new();
    let mut children = Vec::new();
    for (name, value) in fields {
        match value {
            Value::Array(kids) if name == "children" => children = written(kids)?,
            _ => {
                if !own.is_empty() {
                    own.push(',');
                }
                own.push_str(&serde_json::to_string(name)?);
                own.push(':');
                own.push_str(&serde_json::to_string(value)?);
            }
        }
    }
    let id = fields.get("id").map(serde_json::to_string).transpose()?;
    Ok(Written::Group { id, own, children })
}

fn same(a: &Written, b: &Written) -> bool {
    match (a, b) {
        (Written::Layer(a), Written::Layer(b)) => a == b,
        (
            Written::Group {
                own: a,
                children: x,
                ..
            },
            Written::Group {
                own: b,
                children: y,
                ..
            },
        ) => a == b && x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y)),
        _ => false,
    }
}

fn push_whole(layer: &Written, out: &mut String) {
    match layer {
        Written::Layer(json) => out.push_str(json),
        Written::Group { own, children, .. } => {
            out.push('{');
            out.push_str(own);
            if !own.is_empty() {
                out.push(',');
            }
            out.push_str(r#""children":["#);
            for (i, child) in children.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                push_whole(child, out);
            }
            out.push_str("]}");
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
                Written::Group { id, own, children },
                Written::Group {
                    id: theirs,
                    children: their_children,
                    ..
                },
            ) if id == theirs => {
                out.push('{');
                out.push_str(own);
                if !own.is_empty() {
                    out.push(',');
                }
                out.push_str(r#""children":"#);
                push_layers(children, Some(their_children), out);
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
