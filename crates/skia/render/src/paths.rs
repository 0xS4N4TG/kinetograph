//! `Skia.Path` operations that need Skia's geometry: the authoring side keeps a
//! path as SVG data and asks here for the boolean ops, simplifying, trimming,
//! dashing, stroking, transforming, bounds and hit tests.

use serde_json::{Value, json};
use skia_safe::{
    Paint, PaintStyle, Path, PathBuilder, PathOp, StrokeRec, dash_path_effect, path_utils,
    trim_path_effect,
};

use crate::Error;
use crate::enums;
use crate::value::{Props, err, path as path_of};

/// `{ call, ... }` in, `{ d, fillType, bounds }` (or `{ contains }`, `{ length }`) out. `d` is SVG path data.
pub fn path_call(request: &Value) -> Result<Value, Error> {
    let p = Props(request);
    let call = p
        .str("call")
        .ok_or_else(|| Error("a path call needs a call".into()))?;
    let path = path_of(
        request
            .get("path")
            .ok_or_else(|| Error("a path call needs a path".into()))?,
    )?;
    let result = match call {
        "op" => {
            let other = path_of(
                request
                    .get("other")
                    .ok_or_else(|| Error("op needs another path".into()))?,
            )?;
            let op = match p.str("op").unwrap_or("union") {
                "difference" => PathOp::Difference,
                "intersect" => PathOp::Intersect,
                "union" => PathOp::Union,
                "xor" => PathOp::XOR,
                "reverseDifference" => PathOp::ReverseDifference,
                other => return err(format!("unknown path op {other:?}")),
            };
            skia_safe::op(&path, &other, op)
        }
        "simplify" => skia_safe::simplify(&path),
        "trim" => {
            let mode = if p.bool("complement") == Some(true) {
                trim_path_effect::Mode::Inverted
            } else {
                trim_path_effect::Mode::Normal
            };
            let effect =
                trim_path_effect::new(p.f32_or("start", 0.0)?, p.f32_or("end", 1.0)?, mode);
            effect
                .and_then(|e| e.filter_path(&path, &StrokeRec::new_fill(), path.bounds()))
                .map(|(out, _)| Path::from(out))
        }
        "dash" => {
            let (on, off) = (p.f32_or("on", 1.0)?, p.f32_or("off", 1.0)?);
            let effect = dash_path_effect::new(&[on, off], p.f32_or("phase", 0.0)?);
            effect
                .and_then(|e| e.filter_path(&path, &StrokeRec::new_fill(), path.bounds()))
                .map(|(out, _)| Path::from(out))
        }
        "stroke" => {
            let mut paint = Paint::default();
            paint.set_style(PaintStyle::Stroke);
            paint.set_stroke_width(p.f32_or("width", 1.0)?);
            paint.set_stroke_miter(p.f32_or("miter", 4.0)?);
            paint.set_stroke_join(enums::paint_join(p.str("join").unwrap_or("miter"))?);
            paint.set_stroke_cap(enums::paint_cap(p.str("cap").unwrap_or("butt"))?);
            let mut out = PathBuilder::new();
            path_utils::fill_path_with_paint(&path, &paint, &mut out, None, None);
            Some(out.detach())
        }
        "transform" => {
            let matrix = p
                .matrix("matrix")?
                .ok_or_else(|| Error("transform needs a matrix".into()))?;
            Some(path.make_transform(&matrix))
        }
        "contains" => {
            let at = p
                .point("point")?
                .ok_or_else(|| Error("contains needs a point".into()))?;
            return Ok(json!({ "contains": path.contains(at) }));
        }
        "length" => {
            let total: f32 =
                skia_safe::ContourMeasureIter::new(&path, p.bool("closed") == Some(true), 1.0)
                    .map(|c| c.length())
                    .sum();
            return Ok(json!({ "length": total }));
        }
        "bounds" => Some(path),
        other => return err(format!("unknown path call {other:?}")),
    };
    let out = result.ok_or_else(|| Error(format!("the path {call} failed")))?;
    let b = out.compute_tight_bounds();
    Ok(json!({
        "d": out.to_svg(),
        "fillType": fill_type_name(out.fill_type()),
        "bounds": { "x": b.left, "y": b.top, "width": b.width(), "height": b.height() },
    }))
}

fn fill_type_name(t: skia_safe::PathFillType) -> &'static str {
    use skia_safe::PathFillType as Fill;
    match t {
        Fill::Winding => "winding",
        Fill::EvenOdd => "evenOdd",
        Fill::InverseWinding => "inverseWinding",
        Fill::InverseEvenOdd => "inverseEvenOdd",
    }
}
