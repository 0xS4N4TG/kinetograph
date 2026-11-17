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

/// Writes the clip's `fillRule` when it is even-odd (the scene's default is non-zero).
fn set_even_odd(clip: &mut Value, rule: FillRule) {
    if rule == FillRule::Evenodd {
        clip["fillRule"] = json!("evenodd");
    }
}

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
                let (rect, _) = self.reference_box(node, geom, b);
                self.shape_clip(node, shape, rect)
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
        // `region_named` knows padding and content; ElementDependent and the
        // rest are the border box.
        geom.region(region_named(&name))
    }

    fn shape_clip(&mut self, node: &Node, shape: &BasicShape, r: Rect) -> Option<Value> {
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
                let pts: Vec<Value> = p
                    .coordinates
                    .iter()
                    .map(|c| json!([num(r.x + lp(&c.0, w)), num(r.y + lp(&c.1, h))]))
                    .collect();
                if pts.len() < 3 {
                    return Some(json!({ "kind": "polygon", "points": [[0, 0], [0, 0], [0, 0]] }));
                }
                let mut clip = json!({ "kind": "polygon", "points": pts });
                set_even_odd(&mut clip, p.fill);
                Some(clip)
            }
            BasicShape::PathOrShape(PathOrShape::Path(path)) => {
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
                let mut clip = json!({ "kind": "path", "d": path_d(&moved) });
                set_even_odd(&mut clip, path.fill);
                Some(clip)
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
            let op = if comp.is_empty() {
                "Add".to_string()
            } else {
                format!("{:?}", comp[pick(comp.len(), i)])
            };
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
            if let Some(mut l) = self.image_layer(node, geom, current, &spec, &lid, true) {
                if super::util::nearest_sampling(style) {
                    super::util::mark_nearest(&mut l);
                }
                // The bottom layer has nothing under it to combine with.
                if op == "Add" || layers.is_empty() {
                    layers.push(l);
                } else if this == "alpha" {
                    layers = composite_mask_layer(&op, layers, l, &lid);
                } else {
                    self.report(
                        node,
                        "mask-composite",
                        op,
                        "only add compositing is drawn for a mask in luminance mode",
                    );
                    layers.push(l);
                }
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

/// `source`, a mask layer, combined with the layers `below` it by the `mask-composite` operator `op` (alpha masks):
/// `Subtract` keeps the source where the layers below are not, `Intersect` where they are too, and `Exclude`
/// where only one of the two is. A layer that is the source of a matte is not drawn itself, so what is read twice is
/// there twice, under other ids.
fn composite_mask_layer(op: &str, below: Vec<Value>, source: Value, id: &str) -> Vec<Value> {
    let dest = |suffix: &str| {
        let kids: Vec<Value> = below.iter().map(|l| with_id_suffix(l, suffix)).collect();
        super::util::group(&format!("{id}.dest{suffix}"), kids).build()
    };
    let matted = |mut layer: Value, by: &str, mode: &str| {
        layer["matte"] = json!({ "layer": by, "mode": mode });
        layer
    };
    match op {
        "Intersect" => vec![dest(""), matted(source, &format!("{id}.dest"), "alpha")],
        "Subtract" => vec![dest(""), matted(source, &format!("{id}.dest"), "alphaInverted")],
        // Exclude: the source outside the layers below, and those outside the source.
        _ => {
            let source_copy = with_id_suffix(&source, ".copy");
            let copy_id = source_copy["id"].as_str().unwrap_or_default().to_string();
            let outside = matted(dest(".b"), &copy_id, "alphaInverted");
            vec![
                dest(".a"),
                matted(source, &format!("{id}.dest.a"), "alphaInverted"),
                source_copy,
                outside,
            ]
        }
    }
}

/// `layer` with `suffix` added to its id and to the id of its matte source, and in what it holds.
fn with_id_suffix(layer: &Value, suffix: &str) -> Value {
    let mut layer = layer.clone();
    fn walk(v: &mut Value, suffix: &str) {
        if let Some(id) = v.get("id").and_then(Value::as_str).map(str::to_string) {
            v["id"] = json!(format!("{id}{suffix}"));
        }
        if let Some(m) = v.get("matte").and_then(|m| m["layer"].as_str()).map(str::to_string) {
            v["matte"]["layer"] = json!(format!("{m}{suffix}"));
        }
        if let Some(kids) = v.get_mut("children").and_then(Value::as_array_mut) {
            for k in kids {
                walk(k, suffix);
            }
        }
    }
    walk(&mut layer, suffix);
    layer
}

#[allow(dead_code)]
fn unused() {
    let _ = rounded_rect_path;
    let _ = KEllipse::new((0.0, 0.0), (1.0, 1.0), 0.0).bounding_box();
}
