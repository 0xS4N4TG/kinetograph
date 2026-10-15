//! What makes an element a group: transform, opacity, filter, blend mode,
//! isolation, clip-path, mask; and the clip of `overflow`.

use blitz_dom::Node;
use serde_json::{Value, json};
use style::computed_values::backface_visibility::T as Backface;
use style::computed_values::transform_style::T as TransformStyle;
use style::values::computed::{Length, Perspective, Rotate, Scale, Translate};

use super::background::blend_name;
use super::deco::box_geom;
use super::geom::{BoxGeom, Region};
use super::mat::Mat4;
use super::util::{Layer, current_color, hex, lp, num, num4, resolve_color, shift};
use super::{Origin, Painter};

impl<'a> Painter<'a> {
    /// The group of a stacking context: its children (in its own frame, the
    /// origin at its border-box corner) wrapped in the element's transform,
    /// opacity, filter, blend mode, clip-path and mask. `at` is where the
    /// border box is in the parent's frame.
    pub fn context_group(&mut self, node: &'a Node, id: &str, at: Origin, children: Vec<Value>) -> Option<Value> {
        let style = node.primary_styles()?;
        let geom = box_geom(node, &style);
        let current = current_color(&style);
        let fx = style.get_effects();

        let mut group = Layer::new(id, "group");
        let mut children = children;

        // ---- transform ----
        let transform = self.transform_of(node, &style, &geom, at);
        if let Some(t) = transform.transform {
            group = group.set("transform", t);
        }
        if transform.preserve3d {
            group = group.set("preserve3d", json!(true));
        }
        if transform.backface_hidden {
            group = group.set("backfaceHidden", json!(true));
        }

        // ---- opacity, blend ----
        let mut opacity = f64::from(fx.opacity);
        let blend = blend_name(&format!("{:?}", fx.mix_blend_mode));

        // ---- filter ----
        let mut effects: Vec<Value> = Vec::new();
        for f in fx.filter.0.iter() {
            self.filter_effect(node, f, &current, &mut effects, &mut opacity);
        }
        if !effects.is_empty() {
            group = group.set("effects", Value::Array(effects));
        }

        // ---- clip-path ----
        if let Some(clip) = self.clip_path(node, &style, &geom) {
            group = group.set("clip", clip);
        }

        // ---- backdrop-filter ----
        self.backdrop_filter(node, &style, &mut group);

        // ---- opacity and blend go last ----
        if opacity < 1.0 {
            group = group.set("opacity", num4(opacity.max(0.0)));
        }
        if blend != "normal" {
            group = group.set("blendMode", json!(blend));
        }

        // ---- mask ----
        let mut sibling_sources: Vec<Value> = Vec::new();
        if let Some(matte_id) = self.mask(node, &style, &geom, &current, &mut sibling_sources) {
            group = group.set("matte", json!({ "layer": matte_id, "mode": "alpha" }));
        }

        group = group.set("children", Value::Array(std::mem::take(&mut children)));
        let mut group = group.build();
        if sibling_sources.is_empty() {
            return Some(group);
        }
        // The mask's sources are siblings of the masked group, in the same
        // frame, and move with the element: a wrapper carries the transform.
        let wrapper_id = format!("{id}.masked");
        let t = group.as_object_mut().and_then(|o| o.remove("transform"));
        let (o, b) = group
            .as_object_mut()
            .map(|o| (o.remove("opacity"), o.remove("blendMode")))
            .unwrap_or((None, None));
        let mut kids = sibling_sources;
        kids.push(group);
        let mut wrapper = Layer::new(&wrapper_id, "group").set("children", Value::Array(kids));
        if let Some(t) = t {
            wrapper = wrapper.set("transform", t);
        }
        if let Some(o) = o {
            wrapper = wrapper.set("opacity", o);
        }
        if let Some(b) = b {
            wrapper = wrapper.set("blendMode", b);
        }
        Some(wrapper.build())
    }

    /// The clip of `overflow: hidden` (and `clip`, `scroll`, `auto`): the
    /// padding box with its rounded corners, in the frame where the border
    /// box is at `at`. `None` for an element that does not clip.
    pub fn overflow_clip(&mut self, node: &'a Node, at: Origin) -> Option<Value> {
        let style = node.primary_styles()?;
        let geom = box_geom(node, &style);
        let (rect, radii) = geom.region(Region::Padding);
        let rect = rect.translate(at.0, at.1);
        Some(self.region_clip(rect, radii, 0.0, 0.0))
    }
}

/// The layer-level results of an element's transform properties.
pub struct TransformFields {
    pub transform: Option<Value>,
    pub preserve3d: bool,
    pub backface_hidden: bool,
}

impl<'a> Painter<'a> {
    /// The layer `transform` object that puts an element's border box at
    /// `at` and applies `translate`, `rotate`, `scale` and `transform` about
    /// its `transform-origin`, with the `perspective` of its parent folded in.
    pub fn transform_of(&mut self, node: &'a Node, style: &style::properties::ComputedValues, geom: &BoxGeom, at: Origin) -> TransformFields {
        let b = style.get_box();
        let (w, h) = (geom.w, geom.h);
        let mut m = Mat4::IDENTITY;
        let mut any = false;

        // translate, rotate, scale, transform (CSS Transforms 2 §6).
        if let Translate::Translate(x, y, z) = &b.translate {
            m = m.mul(&Mat4::translate(lp(x, w), lp(y, h), f64::from(z.px())));
            any = true;
        }
        match &b.rotate {
            Rotate::None => {}
            Rotate::Rotate(a) => {
                m = m.mul(&Mat4::rotate3d(0.0, 0.0, 1.0, f64::from(a.radians())));
                any = true;
            }
            Rotate::Rotate3D(x, y, z, a) => {
                m = m.mul(&Mat4::rotate3d(f64::from(*x), f64::from(*y), f64::from(*z), f64::from(a.radians())));
                any = true;
            }
        }
        if let Scale::Scale(x, y, z) = &b.scale {
            m = m.mul(&Mat4::scale(f64::from(*x), f64::from(*y), f64::from(*z)));
            any = true;
        }
        if !b.transform.0.is_empty() {
            use style::values::computed::Length as L;
            let reference = euclid::Rect::new(
                euclid::Point2D::new(L::new(0.0), L::new(0.0)),
                euclid::Size2D::new(L::new(w as f32), L::new(h as f32)),
            );
            match b.transform.to_transform_3d_matrix_f64(Some(&reference)) {
                Ok((t, _is_3d)) => {
                    let arr = [
                        t.m11, t.m12, t.m13, t.m14, t.m21, t.m22, t.m23, t.m24, t.m31, t.m32, t.m33, t.m34,
                        t.m41, t.m42, t.m43, t.m44,
                    ];
                    m = m.mul(&Mat4(arr));
                    any = true;
                }
                Err(()) => {
                    self.report(node, "transform", "list", "a transform that cannot be turned into a matrix");
                }
            }
        }

        // The parent's perspective is part of this element's matrix.
        let persp = self.parent_perspective(node, at);
        let preserve3d = b.transform_style == TransformStyle::Preserve3d;
        let backface_hidden = b.backface_visibility == Backface::Hidden;

        if !any && persp.is_none() {
            return TransformFields {
                transform: (at.0 != 0.0 || at.1 != 0.0).then(|| json!({ "x": num(at.0), "y": num(at.1) })),
                preserve3d,
                backface_hidden,
            };
        }

        // About the transform origin.
        let o = &b.transform_origin;
        let ox = lp(&o.horizontal, w);
        let oy = lp(&o.vertical, h);
        let oz = f64::from(o.depth.px());
        // The layer turns about (x, y) itself (its anchor is the origin); only the
        // depth of the origin is left to do here.
        let mut m = m.about(0.0, 0.0, oz);
        let (x, y) = (at.0 + ox, at.1 + oy);
        if let Some(p) = persp {
            // `T(-pos) P T(pos) * M`: the perspective, in the parent's frame
            // about its own origin, applied after this element's matrix.
            let to_parent = Mat4::translate(x, y, 0.0);
            let from_parent = Mat4::translate(-x, -y, 0.0);
            m = from_parent.mul(&p).mul(&to_parent).mul(&m);
        }
        if m.is_identity() {
            return TransformFields {
                transform: (at.0 != 0.0 || at.1 != 0.0).then(|| json!({ "x": num(at.0), "y": num(at.1) })),
                preserve3d,
                backface_hidden,
            };
        }
        let mut t = json!({ "x": num(x), "y": num(y), "anchorX": num(ox), "anchorY": num(oy) });
        t["matrix"] = Value::Array(m.0.iter().map(|v| num4(*v)).collect());
        TransformFields {
            transform: Some(t),
            preserve3d,
            backface_hidden,
        }
    }

    /// The matrix of the `perspective` of `node`'s parent element, in the
    /// parent's frame (the parent is the stacking context `node` is painted
    /// in, so its border box is the frame's origin), if it has one.
    fn parent_perspective(&mut self, node: &'a Node, _at: Origin) -> Option<Mat4> {
        let parent = self.node(node.parent?);
        let ps = parent.primary_styles()?;
        let pb = ps.get_box();
        let Perspective::Length(d) = pb.perspective else {
            return None;
        };
        let d = f64::from(d.0.px());
        if d <= 0.0 {
            return None;
        }
        let pg = box_geom(parent, &ps);
        let po = &pb.perspective_origin;
        let (px, py) = (lp(&po.horizontal, pg.w), lp(&po.vertical, pg.h));
        Some(
            Mat4::translate(px, py, 0.0)
                .mul(&Mat4::perspective(d))
                .mul(&Mat4::translate(-px, -py, 0.0)),
        )
    }

    pub fn backdrop_filter(&mut self, node: &'a Node, style: &style::properties::ComputedValues, group: &mut Layer) {
        let _ = (node, style, group);
    }

    pub fn clip_path(&mut self, node: &'a Node, style: &style::properties::ComputedValues, geom: &BoxGeom) -> Option<Value> {
        let _ = (node, style, geom);
        None
    }

    pub fn mask(
        &mut self,
        node: &'a Node,
        style: &style::properties::ComputedValues,
        geom: &BoxGeom,
        current: &style::color::AbsoluteColor,
        sources: &mut Vec<Value>,
    ) -> Option<String> {
        let _ = (node, style, geom, current, sources);
        None
    }

    pub fn filter_effect(
        &mut self,
        node: &'a Node,
        f: &style::values::computed::Filter,
        current: &style::color::AbsoluteColor,
        out: &mut Vec<Value>,
        opacity: &mut f64,
    ) {
        use style::values::generics::effects::Filter as F;
        match f {
            F::Blur(r) => out.push(json!({ "type": "blur", "radius": num(f64::from(r.0.px())) })),
            F::Brightness(a) => out.push(json!({ "type": "brightness", "amount": num4(f64::from(a.0)) })),
            F::Contrast(a) => out.push(json!({ "type": "contrast", "amount": num4(f64::from(a.0)) })),
            F::Grayscale(a) => out.push(json!({ "type": "grayscale", "amount": num4(f64::from(a.0)) })),
            F::Invert(a) => out.push(json!({ "type": "invert", "amount": num4(f64::from(a.0)) })),
            F::Saturate(a) => out.push(json!({ "type": "saturate", "amount": num4(f64::from(a.0)) })),
            F::Sepia(a) => out.push(json!({ "type": "sepia", "amount": num4(f64::from(a.0)) })),
            F::HueRotate(a) => out.push(json!({ "type": "hueRotate", "angle": num4(f64::from(a.degrees())) })),
            F::Opacity(a) => *opacity *= f64::from(a.0),
            F::DropShadow(s) => {
                let color = resolve_color(&s.color, current);
                out.push(json!({
                    "type": "dropShadow",
                    "x": num(f64::from(s.horizontal.px())), "y": num(f64::from(s.vertical.px())),
                    "blur": num(f64::from(s.blur.0.px()) / 2.0), "color": hex(&color),
                }));
            }
            F::Url(_) => self.report(node, "filter", "url()", "an SVG filter reference is drawn by the filter graph (not connected yet)"),
        }
    }
}

#[allow(dead_code)]
fn unused(_: &mut Value) {
    shift(&mut Value::Null, 0.0, 0.0);
}
