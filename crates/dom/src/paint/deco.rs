//! One element's own box: shadows, background, border, outline.

use blitz_dom::Node;
use serde_json::Value;
use style::properties::ComputedValues;

use super::geom::{BoxGeom, Radii};
use super::util::{lp, shift};
use super::{Origin, Painter};

/// The box of a laid-out element: sizes from layout, radii from style.
pub fn box_geom(node: &Node, style: &ComputedValues) -> BoxGeom {
    let l = node.final_layout();
    let (w, h) = (f64::from(l.size.width), f64::from(l.size.height));
    let radius = |c: &style::values::computed::BorderCornerRadius| {
        (lp(&c.0.width.0, w), lp(&c.0.height.0, h))
    };
    let b = style.get_border();
    let radii = Radii {
        tl: radius(&b.border_top_left_radius),
        tr: radius(&b.border_top_right_radius),
        br: radius(&b.border_bottom_right_radius),
        bl: radius(&b.border_bottom_left_radius),
    }
    .fitted(w, h);
    BoxGeom {
        w,
        h,
        border: [
            f64::from(l.border.top),
            f64::from(l.border.right),
            f64::from(l.border.bottom),
            f64::from(l.border.left),
        ],
        padding: [
            f64::from(l.padding.top),
            f64::from(l.padding.right),
            f64::from(l.padding.bottom),
            f64::from(l.padding.left),
        ],
        radii,
    }
}

impl<'a> Painter<'a> {
    /// The layers of `node`'s own box at `at`: outer shadows, background,
    /// inset shadows, border. Content is not included.
    pub fn decoration(&mut self, node: &'a Node, at: Origin, _is_sc_root: bool) -> Vec<Value> {
        let Some(style) = node.primary_styles() else {
            return Vec::new();
        };
        self.audit(node, &style);
        if !self.is_visible(node) {
            return Vec::new();
        }
        let geom = box_geom(node, &style);
        let mut out = Vec::new();
        out.extend(self.box_shadows(node, &style, &geom, false));
        if self.canvas_node != Some(node.id) {
            out.extend(self.background(node, &style, &geom));
        }
        out.extend(self.box_shadows(node, &style, &geom, true));
        out.extend(self.borders(node, &style, &geom));
        for layer in &mut out {
            shift(layer, at.0, at.1);
        }
        out
    }
}
