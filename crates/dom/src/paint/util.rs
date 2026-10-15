//! Small helpers shared by the painter: scene JSON builders and conversions
//! from Stylo's computed values.

use serde_json::{Map, Number, Value, json};
use style::color::{AbsoluteColor, ColorSpace};
use style::properties::ComputedValues;
use style::values::computed::{Color, Length, LengthPercentage};

/// A number rounded to 1/1000, which is far below a pixel and keeps the JSON
/// short and stable.
pub fn num(v: f64) -> Value {
    let r = (v * 1000.0).round() / 1000.0;
    let r = if r == 0.0 { 0.0 } else { r };
    if r.fract() == 0.0 && r.abs() < 1e15 {
        Value::Number(Number::from(r as i64))
    } else {
        Number::from_f64(r).map_or(Value::Null, Value::Number)
    }
}

/// Four decimals, for matrices and angles that must not drift.
pub fn num4(v: f64) -> Value {
    let r = (v * 10000.0).round() / 10000.0;
    let r = if r == 0.0 { 0.0 } else { r };
    if r.fract() == 0.0 && r.abs() < 1e15 {
        Value::Number(Number::from(r as i64))
    } else {
        Number::from_f64(r).map_or(Value::Null, Value::Number)
    }
}

/// sRGB components (0..1) and alpha of a resolved colour.
pub fn rgba(c: &AbsoluteColor) -> [f32; 4] {
    let s = c.to_color_space(ColorSpace::Srgb);
    [
        s.components.0.clamp(0.0, 1.0),
        s.components.1.clamp(0.0, 1.0),
        s.components.2.clamp(0.0, 1.0),
        s.alpha.clamp(0.0, 1.0),
    ]
}

/// `#rrggbb` or `#rrggbbaa`.
pub fn hex_of(c: [f32; 4]) -> String {
    let b = |v: f32| (v * 255.0).round().clamp(0.0, 255.0) as u8;
    if b(c[3]) == 255 {
        format!("#{:02x}{:02x}{:02x}", b(c[0]), b(c[1]), b(c[2]))
    } else {
        format!(
            "#{:02x}{:02x}{:02x}{:02x}",
            b(c[0]),
            b(c[1]),
            b(c[2]),
            b(c[3])
        )
    }
}

pub fn hex(c: &AbsoluteColor) -> String {
    hex_of(rgba(c))
}

/// A computed colour (which may be `currentcolor`) against the element's
/// `color`.
pub fn resolve_color(c: &Color, current: &AbsoluteColor) -> AbsoluteColor {
    c.resolve_to_absolute(current)
}

/// The colour of an element's text, `currentcolor`.
pub fn current_color(style: &ComputedValues) -> AbsoluteColor {
    style.get_inherited_text().color
}

/// `<length-percentage>` in pixels against a reference length.
pub fn lp(v: &LengthPercentage, basis: f64) -> f64 {
    f64::from(v.resolve(Length::new(basis as f32)).px())
}

/// A scene layer: `{ "id", "type", ...fields }`.
pub struct Layer(pub Map<String, Value>);

impl Layer {
    pub fn new(id: &str, ty: &str) -> Layer {
        let mut m = Map::new();
        m.insert("id".into(), Value::String(id.to_string()));
        m.insert("type".into(), Value::String(ty.to_string()));
        Layer(m)
    }

    pub fn set(mut self, key: &str, value: Value) -> Layer {
        self.0.insert(key.to_string(), value);
        self
    }

    /// Places the layer's origin at (x, y) in its parent.
    pub fn at(mut self, x: f64, y: f64) -> Layer {
        if x != 0.0 || y != 0.0 {
            let t = self
                .0
                .entry("transform")
                .or_insert_with(|| Value::Object(Map::new()));
            if let Value::Object(t) = t {
                t.insert("x".into(), num(x));
                t.insert("y".into(), num(y));
            }
        }
        self
    }

    pub fn build(self) -> Value {
        Value::Object(self.0)
    }
}

/// Moves a finished layer by (dx, dy) in its parent.
pub fn shift(layer: &mut Value, dx: f64, dy: f64) {
    if dx == 0.0 && dy == 0.0 {
        return;
    }
    let Some(obj) = layer.as_object_mut() else {
        return;
    };
    let t = obj
        .entry("transform")
        .or_insert_with(|| Value::Object(Map::new()));
    if let Value::Object(t) = t {
        let get = |t: &Map<String, Value>, k: &str| t.get(k).and_then(Value::as_f64).unwrap_or(0.0);
        let x = get(t, "x") + dx;
        let y = get(t, "y") + dy;
        t.insert("x".into(), num(x));
        t.insert("y".into(), num(y));
    }
}

pub fn group(id: &str, children: Vec<Value>) -> Layer {
    Layer::new(id, "group").set("children", Value::Array(children))
}

/// A filled rectangle (or rounded one) shape layer at (x, y).
pub fn rect_shape(id: &str, w: f64, h: f64, radius: f64, fill: Value) -> Layer {
    let shape = if radius > 0.0 {
        json!({ "kind": "roundedRect", "width": num(w), "height": num(h), "radius": num(radius) })
    } else {
        json!({ "kind": "rect", "width": num(w), "height": num(h) })
    };
    Layer::new(id, "shape")
        .set("shape", shape)
        .set("fill", fill)
}

/// A filled path shape layer; the path is in the layer's own space.
pub fn path_shape(id: &str, d: &str, fill: Value) -> Layer {
    Layer::new(id, "shape")
        .set("shape", json!({ "kind": "path", "d": d }))
        .set("fill", fill)
}

/// A CSS colour written out: `transparent`, `#rgb`, `#rgba`, `#rrggbb`,
/// `#rrggbbaa`, `rgb()`/`rgba()` and a few names. `None` for anything else
/// (including `currentcolor`, which the caller knows).
pub fn parse_css_color(s: &str) -> Option<[f32; 4]> {
    let s = s.trim().to_ascii_lowercase();
    match s.as_str() {
        "transparent" => return Some([0.0; 4]),
        "black" => return Some([0.0, 0.0, 0.0, 1.0]),
        "white" => return Some([1.0, 1.0, 1.0, 1.0]),
        "red" => return Some([1.0, 0.0, 0.0, 1.0]),
        "blue" => return Some([0.0, 0.0, 1.0, 1.0]),
        "green" => return Some([0.0, 128.0 / 255.0, 0.0, 1.0]),
        _ => {}
    }
    if let Some(h) = s.strip_prefix('#') {
        let d: Vec<u8> = h
            .chars()
            .filter_map(|c| c.to_digit(16).map(|v| v as u8))
            .collect();
        if d.len() != h.len() {
            return None;
        }
        let two = |a: u8, b: u8| f32::from(a * 16 + b) / 255.0;
        return match d.len() {
            3 => Some([two(d[0], d[0]), two(d[1], d[1]), two(d[2], d[2]), 1.0]),
            4 => Some([
                two(d[0], d[0]),
                two(d[1], d[1]),
                two(d[2], d[2]),
                two(d[3], d[3]),
            ]),
            6 => Some([two(d[0], d[1]), two(d[2], d[3]), two(d[4], d[5]), 1.0]),
            8 => Some([
                two(d[0], d[1]),
                two(d[2], d[3]),
                two(d[4], d[5]),
                two(d[6], d[7]),
            ]),
            _ => None,
        };
    }
    let inner = s
        .strip_prefix("rgba(")
        .or_else(|| s.strip_prefix("rgb("))?
        .strip_suffix(')')?;
    let parts: Vec<&str> = inner
        .split(|c: char| c == ',' || c == '/' || c.is_whitespace())
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() < 3 {
        return None;
    }
    let chan = |p: &str| -> Option<f32> {
        if let Some(v) = p.strip_suffix('%') {
            v.parse::<f32>().ok().map(|v| v / 100.0)
        } else {
            p.parse::<f32>().ok().map(|v| v / 255.0)
        }
    };
    let a = match parts.get(3) {
        Some(p) => {
            if let Some(v) = p.strip_suffix('%') {
                v.parse::<f32>().ok()? / 100.0
            } else {
                p.parse::<f32>().ok()?
            }
        }
        None => 1.0,
    };
    Some([
        chan(parts[0])?.clamp(0.0, 1.0),
        chan(parts[1])?.clamp(0.0, 1.0),
        chan(parts[2])?.clamp(0.0, 1.0),
        a.clamp(0.0, 1.0),
    ])
}
