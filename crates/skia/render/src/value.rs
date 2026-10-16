//! Reading the JSON the authoring side writes (docs/AUTHORING.md §7.7). The
//! values are RN-Skia's own, normalised by the authoring side: a colour is
//! `[r, g, b, a]` with every channel from 0 to 1, a point `{ x, y }`, a rect
//! `{ x, y, width, height }`, a matrix nine numbers, a path SVG path data.

use serde_json::Value;
use skia_safe::{Color4f, Matrix, Path, Point, RRect, Rect, Vector};

use crate::Error;

/// A node's props, or any object, with typed reads. A missing key reads as
/// `None`; a key of the wrong type is an error naming it.
#[derive(Clone, Copy)]
pub struct Props<'a>(pub &'a Value);

pub fn err<T>(message: impl Into<String>) -> Result<T, Error> {
    Err(Error(message.into()))
}

impl<'a> Props<'a> {
    pub fn get(&self, key: &str) -> Option<&'a Value> {
        self.0.get(key).filter(|v| !v.is_null())
    }

    pub fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    pub fn props(&self, key: &str) -> Option<Props<'a>> {
        self.get(key).map(Props)
    }

    pub fn f32(&self, key: &str) -> Result<Option<f32>, Error> {
        match self.get(key) {
            None => Ok(None),
            Some(v) => as_f32(v)
                .map(Some)
                .ok_or_else(|| Error(format!("{key} must be a number"))),
        }
    }

    pub fn f32_or(&self, key: &str, default: f32) -> Result<f32, Error> {
        Ok(self.f32(key)?.unwrap_or(default))
    }

    pub fn bool(&self, key: &str) -> Option<bool> {
        self.get(key).and_then(Value::as_bool)
    }

    pub fn str(&self, key: &str) -> Option<&'a str> {
        self.get(key).and_then(Value::as_str)
    }

    pub fn array(&self, key: &str) -> Option<&'a Vec<Value>> {
        self.get(key).and_then(Value::as_array)
    }

    pub fn f32s(&self, key: &str) -> Result<Option<Vec<f32>>, Error> {
        match self.get(key) {
            None => Ok(None),
            Some(v) => floats(v)
                .map(Some)
                .ok_or_else(|| Error(format!("{key} must be a list of numbers"))),
        }
    }

    pub fn color(&self, key: &str) -> Result<Option<Color4f>, Error> {
        match self.get(key) {
            None => Ok(None),
            Some(v) => color(v).map(Some).ok_or_else(|| Error(format!("{key} must be a colour"))),
        }
    }

    pub fn point(&self, key: &str) -> Result<Option<Point>, Error> {
        match self.get(key) {
            None => Ok(None),
            Some(v) => point(v).map(Some).ok_or_else(|| Error(format!("{key} must be a point"))),
        }
    }

    /// A radius: one number or `{ x, y }`.
    pub fn radius(&self, key: &str) -> Result<Option<Vector>, Error> {
        match self.get(key) {
            None => Ok(None),
            Some(v) => match as_f32(v) {
                Some(r) => Ok(Some(Vector::new(r, r))),
                None => point(v).map(Some).ok_or_else(|| Error(format!("{key} must be a radius"))),
            },
        }
    }

    /// `rect` (an object), else `x`, `y`, `width` and `height`.
    pub fn rect(&self) -> Result<Option<Rect>, Error> {
        if let Some(rect) = self.get("rect") {
            return rect_of(rect).map(Some).ok_or_else(|| Error("rect must be a rect".into()));
        }
        match (self.f32("width")?, self.f32("height")?) {
            (Some(width), Some(height)) => {
                let x = self.f32_or("x", 0.0)?;
                let y = self.f32_or("y", 0.0)?;
                Ok(Some(Rect::from_xywh(x, y, width, height)))
            }
            _ => Ok(None),
        }
    }

    pub fn matrix(&self, key: &str) -> Result<Option<Matrix>, Error> {
        match self.get(key) {
            None => Ok(None),
            Some(v) => matrix(v).map(Some).ok_or_else(|| Error(format!("{key} must be a matrix"))),
        }
    }

    pub fn path(&self, key: &str) -> Result<Option<Path>, Error> {
        match self.get(key) {
            None => Ok(None),
            Some(v) => path(v).map(Some),
        }
    }
}

pub fn as_f32(v: &Value) -> Option<f32> {
    v.as_f64().map(|n| n as f32)
}

pub fn floats(v: &Value) -> Option<Vec<f32>> {
    v.as_array()?.iter().map(as_f32).collect()
}

/// `[r, g, b, a]`, each 0 to 1.
pub fn color(v: &Value) -> Option<Color4f> {
    let c = floats(v)?;
    match c[..] {
        [r, g, b, a] => Some(Color4f::new(r, g, b, a)),
        [r, g, b] => Some(Color4f::new(r, g, b, 1.0)),
        _ => None,
    }
}

pub fn point(v: &Value) -> Option<Point> {
    Some(Point::new(as_f32(v.get("x")?)?, as_f32(v.get("y")?)?))
}

pub fn rect_of(v: &Value) -> Option<Rect> {
    let n = |k: &str| as_f32(v.get(k)?);
    Some(Rect::from_xywh(n("x")?, n("y")?, n("width")?, n("height")?))
}

/// A rounded rect: `{ rect, rx, ry }`.
pub fn rrect_of(v: &Value) -> Option<RRect> {
    let rect = rect_of(v.get("rect")?)?;
    let rx = as_f32(v.get("rx")?)?;
    let ry = as_f32(v.get("ry")?)?;
    Some(RRect::new_rect_xy(rect, rx, ry))
}

/// Nine numbers, row by row (`scaleX, skewX, transX, skewY, scaleY, transY, p0, p1, p2`), or a 4 x 4 matrix of 16
/// (column major, as RN-Skia's `Matrix4`), of which the 2D part is used.
pub fn matrix(v: &Value) -> Option<Matrix> {
    let m = floats(v)?;
    match m.len() {
        9 => Some(Matrix::new_all(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8])),
        16 => Some(Matrix::new_all(m[0], m[4], m[12], m[1], m[5], m[13], m[3], m[7], m[15])),
        _ => None,
    }
}

/// SVG path data, or `{ d, fillType }`.
pub fn path(v: &Value) -> Result<Path, Error> {
    let (d, fill) = match v {
        Value::String(d) => (d.as_str(), None),
        Value::Object(o) => (
            o.get("d").and_then(Value::as_str).ok_or_else(|| Error("path needs d".into()))?,
            o.get("fillType").and_then(Value::as_str),
        ),
        _ => return err("path must be SVG path data"),
    };
    let mut path = Path::from_svg(d).ok_or_else(|| Error(format!("invalid path data: {d}")))?;
    if let Some(fill) = fill {
        path = path.with_fill_type(fill_type(fill));
    }
    Ok(path)
}

pub fn fill_type(name: &str) -> skia_safe::PathFillType {
    use skia_safe::PathFillType;
    match name {
        "evenOdd" => PathFillType::EvenOdd,
        "inverseWinding" => PathFillType::InverseWinding,
        "inverseEvenOdd" => PathFillType::InverseEvenOdd,
        _ => PathFillType::Winding,
    }
}
