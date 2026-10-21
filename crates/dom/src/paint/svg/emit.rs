//! A usvg tree as scene layers.
//!
//! usvg has resolved the shapes, `use`, gradients, markers, text and units;
//! what is left is mapping each node onto the scene's layers:
//!
//! - a path is a `shape` layer, its transform baked into the path data (so any
//!   matrix, skew included, works), with the stroke done by the scene when it
//!   can be (a plain colour under a uniform scale) and as an outline filled with
//!   the paint when it cannot (a gradient or pattern, a stretched matrix);
//! - a group that does something (opacity, blend, filter, clip, mask) is a
//!   `group` layer, and one that does nothing is dissolved into its children;
//! - a clip path is the scene's `clip` when it is one path, and otherwise a
//!   track matte, as is a mask (`srgbLuminance`, the luminance an SVG mask has);
//! - a pattern is its tile, drawn once in a group, repeated by a `feTile` and
//!   cut to the shape by a matte;
//! - a filter is the `filterGraph` of `filter.rs`, on the group made for it.

use std::collections::HashMap;

use blitz_dom::BaseDocument;
use kurbo::{Affine, BezPath, PathEl, Point, Shape};
use serde_json::{Map, Value, json};
use usvg::tiny_skia_path::PathSegment;

use super::filter;
use super::serialize::Note;

/// The state of one emission.
pub struct Emitter<'a> {
    pub doc: &'a BaseDocument,
    pub id: String,
    pub counter: usize,
    pub notes: Vec<Note>,
    /// Marker group id -> the `url(#id)`s of the filter it carries.
    pub filters: HashMap<String, Vec<String>>,
    pub viewport: [f64; 2],
    /// Clip path content is drawn in opaque white, as coverage.
    pub coverage: bool,
}

fn affine(t: usvg::Transform) -> Affine {
    Affine::new([t.sx, t.ky, t.kx, t.sy, t.tx, t.ty].map(f64::from))
}

fn fmt(v: f64, out: &mut String) {
    let s = format!("{v:.3}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    out.push_str(if s == "-0" || s.is_empty() { "0" } else { s });
}

/// The path as SVG path data, through `m`.
fn path_data(path: &usvg::tiny_skia_path::Path, m: Affine) -> String {
    let mut out = String::new();
    let point = |p: usvg::tiny_skia_path::Point, out: &mut String| {
        let q = m * Point::new(f64::from(p.x), f64::from(p.y));
        out.push(' ');
        fmt(q.x, out);
        out.push(' ');
        fmt(q.y, out);
    };
    for seg in path.segments() {
        match seg {
            PathSegment::MoveTo(p) => {
                out.push('M');
                point(p, &mut out);
            }
            PathSegment::LineTo(p) => {
                out.push('L');
                point(p, &mut out);
            }
            PathSegment::QuadTo(a, p) => {
                out.push('Q');
                point(a, &mut out);
                point(p, &mut out);
            }
            PathSegment::CubicTo(a, b, p) => {
                out.push('C');
                point(a, &mut out);
                point(b, &mut out);
                point(p, &mut out);
            }
            PathSegment::Close => out.push('Z'),
        }
        out.push(' ');
    }
    out.trim_end().to_string()
}

fn bez(path: &usvg::tiny_skia_path::Path) -> BezPath {
    let mut b = BezPath::new();
    let p = |p: usvg::tiny_skia_path::Point| Point::new(f64::from(p.x), f64::from(p.y));
    for seg in path.segments() {
        match seg {
            PathSegment::MoveTo(a) => b.move_to(p(a)),
            PathSegment::LineTo(a) => b.line_to(p(a)),
            PathSegment::QuadTo(a, c) => b.quad_to(p(a), p(c)),
            PathSegment::CubicTo(a, c, d) => b.curve_to(p(a), p(c), p(d)),
            PathSegment::Close => b.close_path(),
        }
    }
    b
}

fn bez_data(path: &BezPath) -> String {
    let mut out = String::new();
    let pt = |p: Point, out: &mut String| {
        out.push(' ');
        fmt(p.x, out);
        out.push(' ');
        fmt(p.y, out);
    };
    for el in path.elements() {
        match *el {
            PathEl::MoveTo(p) => {
                out.push('M');
                pt(p, &mut out);
            }
            PathEl::LineTo(p) => {
                out.push('L');
                pt(p, &mut out);
            }
            PathEl::QuadTo(a, p) => {
                out.push('Q');
                pt(a, &mut out);
                pt(p, &mut out);
            }
            PathEl::CurveTo(a, b, p) => {
                out.push('C');
                pt(a, &mut out);
                pt(b, &mut out);
                pt(p, &mut out);
            }
            PathEl::ClosePath => out.push('Z'),
        }
        out.push(' ');
    }
    out.trim_end().to_string()
}

/// `m` as a rotation, a uniform scale and a move, if it is one.
fn similarity(m: Affine) -> Option<(f64, f64)> {
    let [a, b, c, d, _, _] = m.as_coeffs();
    let s = a.hypot(b);
    let tolerance = 1e-6 * s.max(1.0);
    ((a - d).abs() < tolerance && (b + c).abs() < tolerance && s > 1e-9)
        .then(|| (s, b.atan2(a).to_degrees()))
}

fn transform_json(m: Affine) -> Option<Value> {
    let (s, rotation) = similarity(m)?;
    let [_, _, _, _, e, f] = m.as_coeffs();
    let mut t = Map::new();
    if e != 0.0 || f != 0.0 {
        t.insert("x".into(), json!(e));
        t.insert("y".into(), json!(f));
    }
    if rotation.abs() > 1e-9 {
        t.insert("rotation".into(), json!(rotation));
    }
    if (s - 1.0).abs() > 1e-9 {
        t.insert("scale".into(), json!(s));
    }
    Some(Value::Object(t))
}

fn hex(c: usvg::Color, alpha: f32) -> String {
    format!(
        "#{:02x}{:02x}{:02x}{:02x}",
        c.red,
        c.green,
        c.blue,
        (alpha.clamp(0.0, 1.0) * 255.0).round() as u8
    )
}

fn blend_mode(mode: usvg::BlendMode) -> &'static str {
    use usvg::BlendMode::*;
    match mode {
        Normal => "normal",
        Multiply => "multiply",
        Screen => "screen",
        Overlay => "overlay",
        Darken => "darken",
        Lighten => "lighten",
        ColorDodge => "colorDodge",
        ColorBurn => "colorBurn",
        HardLight => "hardLight",
        SoftLight => "softLight",
        Difference => "difference",
        Exclusion => "exclusion",
        Hue => "hue",
        Saturation => "saturation",
        Color => "color",
        Luminosity => "luminosity",
    }
}

fn rect_polygon(x: f64, y: f64, w: f64, h: f64, m: Affine) -> Value {
    let pts: Vec<Value> = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
        .iter()
        .map(|&(px, py)| {
            let p = m * Point::new(px, py);
            json!([p.x, p.y])
        })
        .collect();
    json!({"kind": "polygon", "points": pts})
}

/// The Rust paint of a usvg paint: what a fill or a stroke can be.
enum Paint<'p> {
    Color(String),
    Gradient(Value),
    Pattern(&'p usvg::Pattern, f32),
}

impl Emitter<'_> {
    fn next_id(&mut self) -> String {
        self.counter += 1;
        format!("{}.{}", self.id, self.counter)
    }

    fn unsupported(&mut self, element: &str, property: &str, value: &str, reason: &str) {
        self.notes.push(Note {
            element: element.to_string(),
            property: Some(property.to_string()),
            value: Some(value.to_string()),
            reason: reason.to_string(),
        });
    }

    // ---- groups ----

    /// The layers of a node's children, in paint order, in the space `base`
    /// takes the children's to the enclosing layer's.
    pub fn children(&mut self, g: &usvg::Group, base: Affine) -> Vec<Value> {
        let mut out = Vec::new();
        for node in g.children() {
            match node {
                usvg::Node::Group(child) => out.extend(self.group(child, base)),
                usvg::Node::Path(p) => out.extend(self.path(p, base)),
                usvg::Node::Image(i) => out.extend(self.image(i, base)),
                usvg::Node::Text(t) => out.extend(self.group(t.flattened(), base)),
            }
        }
        out
    }

    /// A group: dissolved into its children if it does nothing, a `group`
    /// layer (or a few) if it does.
    pub fn group(&mut self, g: &usvg::Group, base: Affine) -> Vec<Value> {
        let m = base * affine(g.transform());
        let filter_urls = self.filters.get(g.id()).cloned();
        let opacity = g.opacity().get();
        let blend = g.blend_mode();
        let isolate_matters = g.isolate() && contains_blend(g);
        let needs = opacity < 1.0
            || blend != usvg::BlendMode::Normal
            || g.clip_path().is_some()
            || g.mask().is_some()
            || filter_urls.is_some()
            || isolate_matters;
        if !needs {
            return self.children(g, m);
        }
        // The group's own space: a rotation and uniform scale go on the layer,
        // anything else is baked into what is inside.
        let (layer_transform, child_base) = match transform_json(m) {
            Some(t) => (t, Affine::IDENTITY),
            None => (Value::Null, m),
        };
        let children = self.children(g, child_base);
        let mut t = json!({"id": self.next_id(), "type": "group", "children": children});
        if !layer_transform.is_null() && layer_transform != json!({}) {
            t["transform"] = layer_transform.clone();
        }
        if let Some(urls) = filter_urls {
            let bb = g.bounding_box();
            let bbox = [bb.x(), bb.y(), bb.width(), bb.height()].map(f64::from);
            let mut effects = Vec::new();
            for url in &urls {
                if let Some(e) =
                    filter::effect(self.doc, url, Some(bbox), self.viewport, &mut self.notes)
                {
                    effects.push(e);
                }
            }
            if !effects.is_empty() && layer_transform.is_null() {
                self.unsupported(
                    "g",
                    "filter",
                    &format!("url(#{})", urls.join(", ")),
                    "a filter on an element that is skewed or mirrored is drawn unturned",
                );
            }
            if !effects.is_empty() {
                t["effects"] = Value::Array(effects);
            }
        }
        // Mattes: each one wraps what is cut in a group with its source.
        let mut mattes: Vec<(Value, &str)> = Vec::new();
        if let Some(cp) = g.clip_path() {
            match self.clip(cp, child_base, &layer_transform) {
                Clip::Path(d) => t["clip"] = json!({"kind": "path", "d": d}),
                Clip::Matte(source) => mattes.push((source, "alpha")),
                Clip::Nothing => {
                    // An empty clip path keeps nothing.
                    return Vec::new();
                }
            }
        }
        if let Some(mask) = g.mask() {
            let mode = match mask.kind() {
                usvg::MaskType::Luminance => "srgbLuminance",
                usvg::MaskType::Alpha => "alpha",
            };
            let source = self.mask_source(mask, child_base, &layer_transform);
            mattes.push((source, mode));
        }
        let mut current = t;
        for (source, mode) in mattes {
            current["matte"] = json!({"layer": source["id"], "mode": mode});
            current = json!({"id": self.next_id(), "type": "group", "children": [current, source]});
        }
        if opacity < 1.0 {
            current["opacity"] = json!(opacity);
        }
        if blend != usvg::BlendMode::Normal {
            current["blendMode"] = json!(blend_mode(blend));
        }
        vec![current]
    }

    /// A group layer for matte source content: `layer_transform` is the target
    /// layer's, so the source sits where the target does.
    fn source_group(&mut self, children: Vec<Value>, layer_transform: &Value) -> Value {
        let mut s = json!({"id": self.next_id(), "type": "group", "children": children});
        if !layer_transform.is_null() && *layer_transform != json!({}) {
            s["transform"] = layer_transform.clone();
        }
        s
    }

    fn clip(&mut self, cp: &usvg::ClipPath, base: Affine, layer_transform: &Value) -> Clip {
        let inner = base * affine(cp.transform());
        // One plain path, nothing nested: the scene's own clip.
        if cp.clip_path().is_none()
            && let [usvg::Node::Path(p)] = cp.root().children()
            && cp.root().transform().is_identity()
            && p.fill()
                .is_some_and(|f| f.rule() == usvg::FillRule::NonZero)
            && p.is_visible()
        {
            return Clip::Path(path_data(p.data(), inner * affine(cp.root().transform())));
        }
        let was = std::mem::replace(&mut self.coverage, true);
        let children = self.group(cp.root(), inner);
        self.coverage = was;
        if children.is_empty() {
            return Clip::Nothing;
        }
        let mut source = self.source_group(children, layer_transform);
        // A clip path that is itself clipped.
        if let Some(outer) = cp.clip_path() {
            match self.clip(outer, base, layer_transform) {
                Clip::Path(d) => source["clip"] = json!({"kind": "path", "d": d}),
                Clip::Matte(s) => {
                    let sid = s["id"].clone();
                    source["matte"] = json!({"layer": sid, "mode": "alpha"});
                    source =
                        json!({"id": self.next_id(), "type": "group", "children": [source, s]});
                }
                Clip::Nothing => return Clip::Nothing,
            }
        }
        Clip::Matte(source)
    }

    fn mask_source(&mut self, mask: &usvg::Mask, base: Affine, layer_transform: &Value) -> Value {
        let children = self.children(mask.root(), base);
        let mut source = self.source_group(children, layer_transform);
        let r = mask.rect();
        source["clip"] = rect_polygon(
            f64::from(r.x()),
            f64::from(r.y()),
            f64::from(r.width()),
            f64::from(r.height()),
            base,
        );
        // A mask on the mask.
        if let Some(outer) = mask.mask() {
            let mode = match outer.kind() {
                usvg::MaskType::Luminance => "srgbLuminance",
                usvg::MaskType::Alpha => "alpha",
            };
            let s = self.mask_source(outer, base, layer_transform);
            source["matte"] = json!({"layer": s["id"], "mode": mode});
            source = json!({"id": self.next_id(), "type": "group", "children": [source, s]});
        }
        source
    }

    // ---- paths ----

    fn paint<'p>(&mut self, paint: &'p usvg::Paint, opacity: f32, m: Affine) -> Paint<'p> {
        match paint {
            usvg::Paint::Color(c) => Paint::Color(hex(*c, opacity)),
            usvg::Paint::LinearGradient(g) => {
                let mut v = json!({
                    "type": "linear",
                    "x0": g.x1(), "y0": g.y1(), "x1": g.x2(), "y1": g.y2(),
                });
                self.gradient_common(&mut v, g, opacity, m);
                Paint::Gradient(v)
            }
            usvg::Paint::RadialGradient(g) => {
                let mut v = json!({
                    "type": "radial",
                    "cx": g.cx(), "cy": g.cy(), "r": g.r().get(),
                });
                if g.fx() != g.cx() || g.fy() != g.cy() || g.fr().get() != 0.0 {
                    v["fx"] = json!(g.fx());
                    v["fy"] = json!(g.fy());
                    v["fr"] = json!(g.fr().get());
                }
                self.gradient_common(&mut v, g, opacity, m);
                Paint::Gradient(v)
            }
            usvg::Paint::Pattern(p) => Paint::Pattern(p, opacity),
        }
    }

    fn gradient_common(&mut self, v: &mut Value, g: &usvg::BaseGradient, opacity: f32, m: Affine) {
        let stops: Vec<Value> = g
            .stops()
            .iter()
            .map(|s| json!({"offset": s.offset().get(), "color": hex(s.color(), s.opacity().get() * opacity)}))
            .collect();
        v["stops"] = Value::Array(stops);
        v["extend"] = json!(match g.spread_method() {
            usvg::SpreadMethod::Pad => "pad",
            usvg::SpreadMethod::Reflect => "reflect",
            usvg::SpreadMethod::Repeat => "repeat",
        });
        // The gradient's space to the layer's: its own matrix, then the path's.
        let total = m * affine(g.transform());
        v["transform"] = json!(total.as_coeffs());
    }

    pub fn path(&mut self, p: &usvg::Path, base: Affine) -> Vec<Value> {
        if !p.is_visible() {
            return Vec::new();
        }
        let m = base;
        let d = path_data(p.data(), m);
        let rule = match p.fill().map(|f| f.rule()) {
            Some(usvg::FillRule::EvenOdd) => "evenodd",
            _ => "nonzero",
        };
        if self.coverage {
            // Clip content: only what the fill covers, in white.
            if p.fill().is_none() {
                return Vec::new();
            }
            return vec![json!({
                "id": self.next_id(), "type": "shape", "shape": {"kind": "path", "d": d},
                "fill": "#ffffffff", "fillRule": rule,
            })];
        }
        let fill = p
            .fill()
            .map(|f| (self.paint(f.paint(), f.opacity().get(), m), f));
        let stroke = p.stroke();
        let stroke_first = p.paint_order() == usvg::PaintOrder::StrokeAndFill;

        // The stroke the scene can draw: a colour under a uniform scale.
        let native_stroke = stroke.and_then(|s| {
            let (scale, _) = similarity(m)?;
            let usvg::Paint::Color(c) = s.paint() else {
                return None;
            };
            let mut v = json!({
                "color": hex(*c, s.opacity().get()),
                "width": f64::from(s.width().get()) * scale,
                "cap": match s.linecap() {
                    usvg::LineCap::Butt => "butt",
                    usvg::LineCap::Round => "round",
                    usvg::LineCap::Square => "square",
                },
                "join": match s.linejoin() {
                    usvg::LineJoin::Miter | usvg::LineJoin::MiterClip => "miter",
                    usvg::LineJoin::Round => "round",
                    usvg::LineJoin::Bevel => "bevel",
                },
                "miterLimit": s.miterlimit().get(),
            });
            if let Some(dash) = s.dasharray() {
                v["dashArray"] = json!(
                    dash.iter()
                        .map(|d| f64::from(*d) * scale)
                        .collect::<Vec<_>>()
                );
                v["dashOffset"] = json!(f64::from(s.dashoffset()) * scale);
            }
            Some(v)
        });

        let mut layers = Vec::new();
        let fill_layers = |this: &mut Self, out: &mut Vec<Value>| {
            if let Some((paint, _)) = &fill {
                out.extend(this.filled(&d, rule, paint, m));
            }
        };
        let stroke_layers = |this: &mut Self, out: &mut Vec<Value>| {
            let Some(s) = stroke else {
                return;
            };
            if let Some(v) = &native_stroke {
                out.push(json!({
                    "id": this.next_id(), "type": "shape", "shape": {"kind": "path", "d": d},
                    "stroke": v,
                }));
                return;
            }
            // An outline, filled with the paint.
            let outline = stroke_outline(p.data(), s, m);
            let mut outline = outline;
            outline.apply_affine(m);
            let od = bez_data(&outline);
            let paint = this.paint(s.paint(), s.opacity().get(), m);
            out.extend(this.filled(&od, "nonzero", &paint, m));
        };
        // Fill and a native stroke in one layer, as the scene draws them (the
        // stroke over the fill).
        if let (Some((Paint::Color(_) | Paint::Gradient(_), _)), Some(v), false) =
            (&fill, &native_stroke, stroke_first)
        {
            let (paint, _) = fill.as_ref().expect("checked");
            let mut layer = json!({
                "id": self.next_id(), "type": "shape", "shape": {"kind": "path", "d": d},
                "stroke": v, "fillRule": rule,
            });
            layer["fill"] = match paint {
                Paint::Color(c) => json!(c),
                Paint::Gradient(g) => g.clone(),
                Paint::Pattern(..) => unreachable!(),
            };
            return vec![layer];
        }
        if stroke_first {
            stroke_layers(self, &mut layers);
            fill_layers(self, &mut layers);
        } else {
            fill_layers(self, &mut layers);
            stroke_layers(self, &mut layers);
        }
        layers
    }

    /// A filled path with `paint`.
    fn filled(&mut self, d: &str, rule: &str, paint: &Paint, m: Affine) -> Vec<Value> {
        match paint {
            Paint::Color(c) => vec![json!({
                "id": self.next_id(), "type": "shape", "shape": {"kind": "path", "d": d},
                "fill": c, "fillRule": rule,
            })],
            Paint::Gradient(g) => vec![json!({
                "id": self.next_id(), "type": "shape", "shape": {"kind": "path", "d": d},
                "fill": g, "fillRule": rule,
            })],
            Paint::Pattern(p, opacity) => self.pattern(d, rule, p, *opacity, m),
        }
    }

    /// A pattern filling the path `d` (already in the layer's space, through
    /// `m`): the tile once, repeated, cut to the path.
    fn pattern(
        &mut self,
        d: &str,
        rule: &str,
        p: &usvg::Pattern,
        opacity: f32,
        m: Affine,
    ) -> Vec<Value> {
        let rect = p.rect();
        let tile_space = m
            * affine(p.transform())
            * Affine::translate((f64::from(rect.x()), f64::from(rect.y())));
        let Some(t) = transform_json(tile_space) else {
            self.unsupported(
                "pattern",
                "patternTransform",
                "",
                "a pattern that is skewed or mirrored is not drawn",
            );
            return Vec::new();
        };
        let was = std::mem::replace(&mut self.coverage, false);
        let content = self.children(p.root(), Affine::IDENTITY);
        self.coverage = was;
        // How far the path reaches in the tile's space, which is the region the
        // repeated tile has to cover.
        let reach = match (BezPath::from_svg(d), tile_space.inverse().as_coeffs()) {
            (Ok(path), inv) if inv.iter().all(|v| v.is_finite()) => {
                let b = path.bounding_box();
                let r = Affine::new(inv).transform_rect_bbox(b);
                Some(r)
            }
            _ => None,
        };
        let Some(r) = reach else {
            return Vec::new();
        };
        let (w, h) = (f64::from(rect.width()), f64::from(rect.height()));
        // The region holds the tile as well, which the repeat reads from.
        let r = r.union(kurbo::Rect::new(0.0, 0.0, w, h));
        let sid = self.next_id();
        let source = json!({
            "id": sid, "type": "shape", "shape": {"kind": "path", "d": d},
            "fill": "#ffffffff", "fillRule": rule,
        });
        let mut tiled = json!({
            "id": self.next_id(), "type": "group", "children": content,
            "effects": [{
                "type": "filterGraph", "filterUnits": "userSpaceOnUse",
                "x": r.x0.floor() - 1.0, "y": r.y0.floor() - 1.0,
                "width": r.width().ceil() + 2.0, "height": r.height().ceil() + 2.0,
                "primitives": [
                    {"primitive": "feOffset", "dx": 0, "dy": 0, "x": 0, "y": 0, "width": w, "height": h},
                    {"primitive": "feTile"}
                ]
            }],
            "matte": {"layer": sid, "mode": "alpha"},
        });
        if !t.as_object().is_some_and(Map::is_empty) {
            tiled["transform"] = t;
        }
        let mut wrapper =
            json!({"id": self.next_id(), "type": "group", "children": [tiled, source]});
        if opacity < 1.0 {
            wrapper["opacity"] = json!(opacity);
        }
        vec![wrapper]
    }

    // ---- images ----

    pub fn image(&mut self, img: &usvg::Image, base: Affine) -> Vec<Value> {
        if !img.is_visible() {
            return Vec::new();
        }
        let size = img.size();
        let (ext, bytes) = match img.kind() {
            usvg::ImageKind::PNG(b) => ("png", b.clone()),
            usvg::ImageKind::JPEG(b) => ("jpg", b.clone()),
            usvg::ImageKind::SVG(tree) => {
                // A nested SVG is its own tree.
                return self.group(tree.root(), base);
            }
            usvg::ImageKind::GIF(_) => {
                self.unsupported("image", "href", "", "a GIF in an SVG <image> is not drawn");
                return Vec::new();
            }
            usvg::ImageKind::WEBP(b) => ("webp", b.clone()),
        };
        let Some(t) = transform_json(base) else {
            self.unsupported(
                "image",
                "transform",
                "",
                "an image that is skewed or mirrored is not drawn",
            );
            return Vec::new();
        };
        // In memory: the scene decodes a data: URL, so no file is written.
        let src = super::assets::data_url(ext, &bytes);
        let mut layer = json!({
            "id": self.next_id(), "type": "image", "src": src,
            "width": size.width(), "height": size.height(),
        });
        if !t.as_object().is_some_and(Map::is_empty) {
            layer["transform"] = t;
        }
        vec![layer]
    }
}

enum Clip {
    Path(String),
    Matte(Value),
    Nothing,
}

/// The outline of a stroke, in the path's own space.
fn stroke_outline(path: &usvg::tiny_skia_path::Path, s: &usvg::Stroke, m: Affine) -> BezPath {
    let mut stroke = kurbo::Stroke::new(f64::from(s.width().get()))
        .with_caps(match s.linecap() {
            usvg::LineCap::Butt => kurbo::Cap::Butt,
            usvg::LineCap::Round => kurbo::Cap::Round,
            usvg::LineCap::Square => kurbo::Cap::Square,
        })
        .with_join(match s.linejoin() {
            usvg::LineJoin::Miter | usvg::LineJoin::MiterClip => kurbo::Join::Miter,
            usvg::LineJoin::Round => kurbo::Join::Round,
            usvg::LineJoin::Bevel => kurbo::Join::Bevel,
        })
        .with_miter_limit(f64::from(s.miterlimit().get()));
    if let Some(dash) = s.dasharray() {
        stroke = stroke.with_dashes(
            f64::from(s.dashoffset()),
            dash.iter().map(|d| f64::from(*d)),
        );
    }
    // Fine enough that a pixel is not off, whatever the matrix scales by.
    let scale = m.determinant().abs().sqrt().max(1e-6);
    kurbo::stroke(
        bez(path),
        &stroke,
        &kurbo::StrokeOpts::default(),
        0.05 / scale,
    )
}

/// Whether anything under `g` blends with a mode other than normal.
fn contains_blend(g: &usvg::Group) -> bool {
    g.children().iter().any(|n| match n {
        usvg::Node::Group(c) => c.blend_mode() != usvg::BlendMode::Normal || contains_blend(c),
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rotation_and_uniform_scale_is_a_layer_transform() {
        let m = Affine::translate((10.0, 20.0)) * Affine::rotate(0.5) * Affine::scale(2.0);
        let t = transform_json(m).unwrap();
        assert!((t["scale"].as_f64().unwrap() - 2.0).abs() < 1e-9);
        assert!((t["rotation"].as_f64().unwrap() - 0.5f64.to_degrees()).abs() < 1e-9);
        assert_eq!(t["x"], json!(10.0));
        assert!(transform_json(Affine::scale_non_uniform(1.0, 2.0)).is_none());
        assert!(transform_json(Affine::scale_non_uniform(-1.0, 1.0)).is_none());
        assert_eq!(transform_json(Affine::IDENTITY).unwrap(), json!({}));
    }

    #[test]
    fn numbers_are_short() {
        let mut s = String::new();
        fmt(12.0, &mut s);
        s.push(' ');
        fmt(0.12345, &mut s);
        s.push(' ');
        fmt(-0.0001, &mut s);
        assert_eq!(s, "12 0.123 0");
    }
}
