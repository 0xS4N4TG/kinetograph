//! `clip-path` (every basic shape and `path()`, against any reference box)
//! and `mask-image` (gradients and pictures with size, position, repeat,
//! origin, clip and mode).

use blitz_dom::Node;
use kurbo::{BezPath, Ellipse as KEllipse, Shape};
use serde_json::{Value, json};
use style::color::AbsoluteColor;
use style::properties::ComputedValues;
use style::values::computed::basic_shape::{BasicShape, ClipPath};
use style::values::computed::{BackgroundRepeat, Image};
use style::values::generics::basic_shape::{
    FillRule, GenericPathOrShapeFunction as PathOrShape, GenericShapeRadius as Radius,
    ShapeGeometryBox,
};
use style::values::generics::position::GenericPositionOrAuto as PosOrAuto;
use style_traits::ToCss;

use super::Painter;
use super::background::{ImageLayerSpec, region_named};
use super::geom::{BoxGeom, Radii, Rect, Region, path_d, rounded_rect_path};
use super::util::{Layer, lp, num};

impl<'a> Painter<'a> {
    /// The scene clip for `clip-path`, in the group's coordinates (origin: the
    /// border box's corner).
    pub fn clip_path(
        &mut self,
        node: &'a Node,
        style: &ComputedValues,
        geom: &BoxGeom,
    ) -> Option<Value> {
        match &style.get_svg().clip_path {
            ClipPath::None => None,
            ClipPath::Url(_) => {
                self.report(
                    node,
                    "clip-path",
                    "url()",
                    "an SVG clip path is drawn by the SVG painter (not connected yet)",
                );
                None
            }
            ClipPath::Box(b) => {
                let (rect, radii) = self.reference_box(node, geom, b);
                Some(self.region_clip(rect, radii, 0.0, 0.0))
            }
            ClipPath::Shape(shape, b) => {
                let (rect, radii) = self.reference_box(node, geom, b);
                self.shape_clip(node, shape, rect, radii)
            }
        }
    }

    fn reference_box(
        &mut self,
        node: &Node,
        geom: &BoxGeom,
        b: &ShapeGeometryBox,
    ) -> (Rect, Radii) {
        let name = format!("{b:?}");
        if name.contains("MarginBox") {
            self.report(
                node,
                "clip-path",
                "margin-box",
                "a margin-box reference is taken as the border box",
            );
        }
        geom.region(match region_named(&name) {
            // `region_named` knows padding and content; ElementDependent and
            // the rest are the border box.
            r => r,
        })
    }

    fn shape_clip(
        &mut self,
        node: &Node,
        shape: &BasicShape,
        r: Rect,
        radii: Radii,
    ) -> Option<Value> {
        let (w, h) = (r.w, r.h);
        match shape {
            BasicShape::Rect(inset) => {
                let top = lp(&inset.rect.0, h);
                let right = lp(&inset.rect.1, w);
                let bottom = lp(&inset.rect.2, h);
                let left = lp(&inset.rect.3, w);
                let inner = Rect::new(
                    r.x + left,
                    r.y + top,
                    (w - left - right).max(0.0),
                    (h - top - bottom).max(0.0),
                );
                let rad = |c: &style::values::computed::BorderCornerRadius| {
                    (lp(&c.0.width.0, inner.w), lp(&c.0.height.0, inner.h))
                };
                let radii = Radii {
                    tl: rad(&inset.round.top_left),
                    tr: rad(&inset.round.top_right),
                    br: rad(&inset.round.bottom_right),
                    bl: rad(&inset.round.bottom_left),
                }
                .fitted(inner.w, inner.h);
                let _ = radii;
                Some(self.region_clip(inner, radii, 0.0, 0.0))
            }
            BasicShape::Circle(c) => {
                let (cx, cy) = match &c.position {
                    PosOrAuto::Position(p) => {
                        (r.x + lp(&p.horizontal, w), r.y + lp(&p.vertical, h))
                    }
                    PosOrAuto::Auto => (r.x + w / 2.0, r.y + h / 2.0),
                };
                let reference = ((w * w + h * h) / 2.0).sqrt();
                let sides = [
                    (cx - r.x).abs(),
                    (r.right() - cx).abs(),
                    (cy - r.y).abs(),
                    (r.bottom() - cy).abs(),
                ];
                let corners = [
                    (cx - r.x).hypot(cy - r.y),
                    (r.right() - cx).hypot(cy - r.y),
                    (cx - r.x).hypot(r.bottom() - cy),
                    (r.right() - cx).hypot(r.bottom() - cy),
                ];
                let rad = match &c.radius {
                    Radius::Length(l) => lp(&l.0, reference),
                    Radius::ClosestSide => sides.iter().cloned().fold(f64::INFINITY, f64::min),
                    Radius::FarthestSide => sides.iter().cloned().fold(0.0, f64::max),
                    Radius::ClosestCorner => corners.iter().cloned().fold(f64::INFINITY, f64::min),
                    Radius::FarthestCorner => corners.iter().cloned().fold(0.0, f64::max),
                };
                Some(
                    json!({ "kind": "ellipse", "cx": num(cx), "cy": num(cy), "rx": num(rad), "ry": num(rad) }),
                )
            }
            BasicShape::Ellipse(e) => {
                let (cx, cy) = match &e.position {
                    PosOrAuto::Position(p) => {
                        (r.x + lp(&p.horizontal, w), r.y + lp(&p.vertical, h))
                    }
                    PosOrAuto::Auto => (r.x + w / 2.0, r.y + h / 2.0),
                };
                let axis = |rad: &Radius<style::values::computed::LengthPercentage>,
                            basis: f64,
                            near: f64,
                            far: f64| match rad {
                    Radius::Length(l) => lp(&l.0, basis),
                    Radius::ClosestSide | Radius::ClosestCorner => near.abs().min(far.abs()),
                    Radius::FarthestSide | Radius::FarthestCorner => near.abs().max(far.abs()),
                };
                let rx = axis(&e.semiaxis_x, w, cx - r.x, r.right() - cx);
                let ry = axis(&e.semiaxis_y, h, cy - r.y, r.bottom() - cy);
                Some(
                    json!({ "kind": "ellipse", "cx": num(cx), "cy": num(cy), "rx": num(rx), "ry": num(ry) }),
                )
            }
            BasicShape::Polygon(p) => {
                if p.fill == FillRule::Evenodd {
                    self.report(
                        node,
                        "clip-path",
                        "polygon(evenodd)",
                        "the even-odd fill rule is not drawn",
                    );
                    return None;
                }
                let pts: Vec<Value> = p
                    .coordinates
                    .iter()
                    .map(|c| json!([num(r.x + lp(&c.0, w)), num(r.y + lp(&c.1, h))]))
                    .collect();
                if pts.len() < 3 {
                    return Some(json!({ "kind": "polygon", "points": [[0, 0], [0, 0], [0, 0]] }));
                }
                Some(json!({ "kind": "polygon", "points": pts }))
            }
            BasicShape::PathOrShape(PathOrShape::Path(path)) => {
                if path.fill == FillRule::Evenodd {
                    self.report(
                        node,
                        "clip-path",
                        "path(evenodd)",
                        "the even-odd fill rule is not drawn",
                    );
                    return None;
                }
                let d = path.path.to_css_string();
                let d = d.trim().trim_matches('"').to_string();
                let Some(bez) = BezPath::from_svg(&d)
                    .ok()
                    .filter(|b| !b.elements().is_empty())
                else {
                    self.report(node, "clip-path", d, "a path that could not be read");
                    return None;
                };
                let mut moved = bez;
                moved.apply_affine(kurbo::Affine::translate((r.x, r.y)));
                Some(json!({ "kind": "path", "d": path_d(&moved) }))
            }
            BasicShape::PathOrShape(PathOrShape::Shape(_)) => {
                self.report(
                    node,
                    "clip-path",
                    "shape()",
                    "the shape() function is not drawn yet",
                );
                None
            }
        }
    }

    /// `mask-image`: the mask's layers drawn into a source group, returned as
    /// siblings (`sources`) for the masked group to take as its matte.
    pub fn mask(
        &mut self,
        node: &'a Node,
        style: &ComputedValues,
        geom: &BoxGeom,
        current: &AbsoluteColor,
        sources: &mut Vec<Value>,
    ) -> Option<String> {
        let svg = style.get_svg();
        let images = &svg.mask_image.0;
        if images.iter().all(|i| matches!(i, Image::None)) {
            return None;
        }
        let n = images.len();
        let pick = |len: usize, i: usize| i % len.max(1);
        let mut layers: Vec<Value> = Vec::new();
        let mut mode_name: Option<&'static str> = None;
        let id = self.layer_id(node, "mask");
        for i in (0..n).rev() {
            let image = &images[i];
            if matches!(image, Image::None) {
                continue;
            }
            let comp = &svg.mask_composite.0;
            if !comp.is_empty() && format!("{:?}", comp[pick(comp.len(), i)]) != "Add" {
                self.report(
                    node,
                    "mask-composite",
                    format!("{:?}", comp[pick(comp.len(), i)]),
                    "only add compositing of mask layers is drawn",
                );
            }
            let list_len = |l: usize| l.max(1);
            let _ = list_len;
            let sz = &svg.mask_size.0;
            let px = &svg.mask_position_x.0;
            let py = &svg.mask_position_y.0;
            let rp = &svg.mask_repeat.0;
            if sz.is_empty() || px.is_empty() || py.is_empty() || rp.is_empty() {
                continue;
            }
            let BackgroundRepeat(rx, ry) = rp[pick(rp.len(), i)];
            let origin = if svg.mask_origin.0.is_empty() {
                Region::Border
            } else {
                region_named(&format!(
                    "{:?}",
                    svg.mask_origin.0[pick(svg.mask_origin.0.len(), i)]
                ))
            };
            let clip = if svg.mask_clip.0.is_empty() {
                Region::Border
            } else {
                region_named(&format!(
                    "{:?}",
                    svg.mask_clip.0[pick(svg.mask_clip.0.len(), i)]
                ))
            };
            let spec = ImageLayerSpec {
                image,
                size: &sz[pick(sz.len(), i)],
                pos_x: &px[pick(px.len(), i)],
                pos_y: &py[pick(py.len(), i)],
                repeat: (rx.into(), ry.into()),
                origin,
                clip,
                index: i,
                property: "mask",
            };
            let mode = if svg.mask_mode.0.is_empty() {
                "MatchSource".to_string()
            } else {
                format!("{:?}", svg.mask_mode.0[pick(svg.mask_mode.0.len(), i)])
            };
            let this = if mode == "Luminance" {
                "luminance"
            } else {
                "alpha"
            };
            match mode_name {
                None => mode_name = Some(this),
                Some(m) if m != this => {
                    self.report(
                        node,
                        "mask-mode",
                        "mixed",
                        "mask layers with different modes are drawn with the first one's",
                    );
                }
                _ => {}
            }
            let lid = format!("{id}.{i}");
            if let Some(l) = self.image_layer(node, geom, current, &spec, &lid, true) {
                layers.push(l);
            }
        }
        // A mask whose images could not be drawn hides nothing (and was
        // reported).
        if layers.is_empty() {
            return None;
        }
        sources.push(
            Layer::new(&id, "group")
                .set("children", Value::Array(layers))
                .build(),
        );
        self.mask_modes
            .insert(id.clone(), mode_name.unwrap_or("alpha"));
        Some(id)
    }
}

#[allow(dead_code)]
fn unused() {
    let _ = rounded_rect_path;
    let _ = KEllipse::new((0.0, 0.0), (1.0, 1.0), 0.0).bounding_box();
}
