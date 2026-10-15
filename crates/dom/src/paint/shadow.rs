//! `box-shadow`, outer and inset, of any shape.
//!
//! A shadow is a shape layer of the shadow's colour, blurred, and cut to the
//! side of the box it falls on: an outer shadow only outside the border edge,
//! an inset one only inside the padding edge. So it works for any radii,
//! spread and offset, with borders and background images.

use blitz_dom::Node;
use kurbo::BezPath;
use serde_json::{Value, json};
use style::properties::ComputedValues;

use super::Painter;
use super::geom::{
    BoxGeom, Radii, Rect, Region, path_d, rounded_rect_path, rounded_rect_path_reversed,
};
use super::util::{Layer, current_color, hex, num, path_shape, resolve_color};

/// A rectangle that holds a shape and everything a blur of `sigma` spreads
/// out of it.
fn room(r: Rect, sigma: f64, extra: f64) -> Rect {
    r.inflate(3.0 * sigma + extra + 2.0)
}

impl<'a> Painter<'a> {
    /// The box's shadows of one kind (`inset` or outer), first shadow on top.
    pub fn box_shadows(
        &mut self,
        node: &'a Node,
        style: &ComputedValues,
        geom: &BoxGeom,
        inset: bool,
    ) -> Vec<Value> {
        let shadows = &style.get_effects().box_shadow.0;
        if shadows.is_empty() {
            return Vec::new();
        }
        let current = current_color(style);
        let mut out = Vec::new();
        // The last shadow is the lowest.
        for (i, s) in shadows.iter().enumerate().rev() {
            if s.inset != inset {
                continue;
            }
            let color = resolve_color(&s.base.color, &current);
            if super::util::rgba(&color)[3] <= 0.0 {
                continue;
            }
            let dx = f64::from(s.base.horizontal.px());
            let dy = f64::from(s.base.vertical.px());
            let blur = f64::from(s.base.blur.0.px());
            let spread = f64::from(s.spread.px());
            let sigma = blur / 2.0;
            let id = self.layer_id(
                node,
                &format!("{}shadow{i}", if inset { "inset" } else { "" }),
            );
            let layer = if inset {
                inset_shadow(&id, geom, (dx, dy), sigma, spread, &hex(&color))
            } else {
                outer_shadow(&id, geom, (dx, dy), sigma, spread, &hex(&color))
            };
            if let Some(layer) = layer {
                out.push(layer);
                self.note_reach(3.0 * sigma + dx.abs().max(dy.abs()) + spread.abs());
            }
        }
        out
    }
}

/// An outer shadow: the border box offset and grown by the spread, filled,
/// blurred, and cut to what lies outside the border box.
fn outer_shadow(
    id: &str,
    geom: &BoxGeom,
    (dx, dy): (f64, f64),
    sigma: f64,
    spread: f64,
    color: &str,
) -> Option<Value> {
    let b = geom.border_box();
    let rect = b.translate(dx, dy).inflate(spread);
    if rect.is_empty() && spread >= 0.0 {
        return None;
    }
    let radii = geom.radii.spread(spread).fitted(rect.w, rect.h);
    // The shape is drawn in the box's space; the clip leaves the border box out.
    let shape = rounded_rect_path(rect, radii);
    let big = room(rect.union(&b), sigma, 0.0);
    let mut clip = rounded_rect_path(big, Radii::ZERO);
    clip.extend(
        rounded_rect_path_reversed(b, geom.radii)
            .elements()
            .iter()
            .copied(),
    );
    let mut layer = path_shape(id, &path_d(&shape), json!(color))
        .set("clip", json!({ "kind": "path", "d": path_d(&clip) }));
    if sigma >= 0.05 {
        layer = layer.set("effects", json!([{ "type": "blur", "radius": num(sigma) }]));
    }
    Some(layer.build())
}

/// An inset shadow: the padding box less a hole (the padding box offset and
/// shrunk by the spread) is filled, blurred, and cut to the padding box.
fn inset_shadow(
    id: &str,
    geom: &BoxGeom,
    (dx, dy): (f64, f64),
    sigma: f64,
    spread: f64,
    color: &str,
) -> Option<Value> {
    let (pad, pad_radii) = geom.region(Region::Padding);
    if pad.is_empty() {
        return None;
    }
    // The light shows through the hole; everything else is shadow.
    let hole = pad.translate(dx, dy).inflate(-spread);
    let big = room(pad.union(&hole), sigma, spread.abs());
    let mut path = rounded_rect_path(big, Radii::ZERO);
    if !hole.is_empty() {
        let hole_radii = pad_radii.spread(-spread).fitted(hole.w, hole.h);
        path.extend(
            rounded_rect_path_reversed(hole, hole_radii)
                .elements()
                .iter()
                .copied(),
        );
    }
    let clip: BezPath = rounded_rect_path(pad, pad_radii);
    let mut layer = path_shape(id, &path_d(&path), json!(color))
        .set("clip", json!({ "kind": "path", "d": path_d(&clip) }));
    if sigma >= 0.05 {
        layer = layer.set("effects", json!([{ "type": "blur", "radius": num(sigma) }]));
    }
    Some(layer.build())
}

#[allow(dead_code)]
fn unused(_: Layer) {}
