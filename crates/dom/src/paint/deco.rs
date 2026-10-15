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
    /// A box with a background colour and an opaque, solid, uniform border,
    /// and nothing between them (no picture, no inset shadow), is one shape:
    /// the colour fills the box inside the middle of the border, and the
    /// border is the stroke over its edge. Saves a layer per box.
    fn fill_and_border(&mut self, node: &'a Node, style: &ComputedValues, geom: &BoxGeom) -> Option<Value> {
        use super::util::{current_color, hex_of, resolve_color, rgba};
        use style::values::specified::BorderStyle as S;
        if self.canvas_node == Some(node.id) || !geom.has_border() {
            return None;
        }
        let w = geom.border[0];
        if geom.border.iter().any(|v| (*v - w).abs() > 1e-9) {
            return None;
        }
        let b = style.get_border();
        let sides = [
            (b.border_top_style, &b.border_top_color),
            (b.border_right_style, &b.border_right_color),
            (b.border_bottom_style, &b.border_bottom_color),
            (b.border_left_style, &b.border_left_color),
        ];
        let current = current_color(style);
        let color = rgba(&resolve_color(sides[0].1, &current));
        if color[3] < 1.0
            || sides.iter().any(|(st, c)| *st != S::Solid || rgba(&resolve_color(c, &current)) != color)
            || !matches!(b.border_image_source, style::values::generics::image::GenericImage::None)
        {
            return None;
        }
        let bg = style.get_background();
        let fill = rgba(&resolve_color(&bg.background_color, &current));
        let no_images = bg
            .background_image
            .0
            .iter()
            .all(|i| matches!(i, style::values::computed::Image::None));
        let clip_ok = bg
            .background_clip
            .0
            .iter()
            .all(|c| format!("{c:?}").to_lowercase().contains("border"));
        let inset = style.get_effects().box_shadow.0.iter().any(|s| s.inset);
        if fill[3] <= 0.0 || !no_images || !clip_ok || inset || self.kg_value(node, "--kg-background-clip").is_some() {
            return None;
        }
        // The shape is the border's centre line.
        let rect = geom.border_box().inset(w / 2.0, w / 2.0, w / 2.0, w / 2.0);
        if rect.is_empty() {
            return None;
        }
        let radii = geom.radii.inner(w / 2.0, w / 2.0, w / 2.0, w / 2.0);
        let id = self.layer_id(node, "bg");
        let mut shape = self.region_shape(&id, rect, radii, Value::String(hex_of(fill)));
        shape["stroke"] = serde_json::json!({ "color": hex_of(color), "width": super::util::num(w) });
        Some(shape)
    }

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
        if let Some(one) = self.fill_and_border(node, &style, &geom) {
            // The background colour and an opaque solid border are one shape.
            out.push(one);
        } else {
            if self.canvas_node != Some(node.id) {
                out.extend(self.background(node, &style, &geom));
            }
            out.extend(self.box_shadows(node, &style, &geom, true));
            out.extend(self.borders(node, &style, &geom));
        }
        for layer in &mut out {
            shift(layer, at.0, at.1);
        }
        out
    }
}
