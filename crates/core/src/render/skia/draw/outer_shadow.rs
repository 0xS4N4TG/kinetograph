//! A blurred outer `box-shadow`, drawn as Chrome draws it: the border box clipped out, then the shadow's rounded
//! rectangle filled through a blur mask filter. No layer is saved; Graphite blurs an axis-aligned rounded rectangle in
//! closed form. A turned one it renders and blurs as a mask, so that is filled with `shadow_box.wgsl`'s closed form in a
//! runtime shader instead (`blur_shader`). The clip is the recorded path, not an analytic rounded rectangle: that one's
//! edge is not antialiased as the box's own fill is, and leaves a light seam at the box edge.
//!
//! The DOM paints the shadow (`crates/dom/src/paint/shadow.rs`, `outer_shadow`) as a path shape of one colour, blurred,
//! with a path clip that is a rectangle less the border box. Only that is drawn here; anything else (an inset shadow, a
//! gradient fill, another clip or effect) keeps the layered path in `draw_extras`.

use super::*;

/// The control points' distance along the tangent of a quarter-ellipse cubic, as a fraction of its radius.
const KAPPA: f64 = 0.552_284_749_8;
/// How far apart two coordinates may be and still be one: path data carries three decimals.
const EPS: f64 = 2e-3;

impl Translator {
    /// Draws `layer` if it is a blurred outer box shadow, and says whether it did.
    pub(super) fn outer_shadow(&mut self, canvas: &Canvas, layer: &ResolvedLayer, comp: Comp, scale: f64) -> bool {
        let [ResolvedEffect::Blur { radius }] = layer.effects.as_slice() else {
            return false;
        };
        let ResolvedKind::Shape { geometry: ResolvedGeometry::Path { d }, fill: Some(fill @ ResolvedPaint::Solid(_)), stroke: None, .. } =
            &layer.kind
        else {
            return false;
        };
        let Some(ResolvedClip::Path { d: clip, fill_rule }) = &layer.clip else {
            return false;
        };
        // As `effect_filter` decides whether to blur.
        if *radius < 1.0 || self.skip.iter().any(|k| k == "blur") {
            return false;
        }
        if comp.blend != SkBlend::SrcOver || layer.mask.is_some() || layer.matte.is_some() {
            return false;
        }
        let (Ok(shape), Ok(clip)) = (BezPath::from_svg(d), BezPath::from_svg(clip)) else {
            return false;
        };
        let Some([(shape, _)]) = rounded_rects::<1>(shape.elements()) else {
            return false;
        };
        // The clip is a rectangle less the box: the box turns the other way (or the rule is even-odd).
        let Some([(room, outward), (_, inward)]) = rounded_rects::<2>(clip.elements()) else {
            return false;
        };
        if !room.is_rect() || (*fill_rule != FillRule::EvenOdd && outward == inward) {
            return false;
        }
        // `draw_flat` restores the clip.
        self.apply_clip(canvas, layer);
        let mut p = Self::base_paint(comp);
        self.set_paint(canvas, &mut p, fill, None);
        let sigma = radius / scale.max(1e-6) as f32;
        let m = canvas.local_to_device_as_3x3();
        if !m.rect_stays_rect() && !m.has_perspective() && self.blur_shader(&mut p, &shape, sigma).is_some() {
            canvas.draw_rect(shape.rect().with_outset((REACH * sigma, REACH * sigma)), &p);
        } else {
            p.set_mask_filter(skia_safe::MaskFilter::blur(skia_safe::BlurStyle::Normal, sigma, true));
            canvas.draw_rrect(shape, &p);
        }
        self.stats.draws += 1;
        true
    }

    /// Gives `p` a shader that is `shape` blurred by a Gaussian of `sigma` (in its own units), in closed form and in
    /// `p`'s colour, if the shape is a rectangle, a rounded rectangle with one circular radius, or an ellipse at most
    /// `MAX_ELLIPSE_ASPECT` long. Graphite blurs those in closed form only when they are axis-aligned; turned, it
    /// renders and blurs a mask.
    fn blur_shader(&mut self, p: &mut Paint, shape: &RRect, sigma: f32) -> Option<()> {
        let r = shape.rect();
        let half = (r.width() / 2.0, r.height() / 2.0);
        let corner = shape.simple_radii();
        let (radius, ellipse) = if shape.is_rect() {
            (0.0, 0.0)
        } else if shape.is_oval() && half.0.max(half.1) <= MAX_ELLIPSE_ASPECT * half.0.min(half.1) {
            (0.0, 1.0)
        } else if shape.is_simple() && (corner.x - corner.y).abs() <= EPS as f32 {
            (corner.x, 0.0)
        } else {
            return None;
        };
        let fx = self.runtime("rrectBlur", RRECT_BLUR)?;
        let c = p.color4f();
        let mut b = skia_safe::runtime_effect::RuntimeShaderBuilder::new(fx);
        b.set_uniform_float("shape", &[r.center_x(), r.center_y(), half.0, half.1]).ok()?;
        b.set_uniform_float("misc", &[radius, sigma, ellipse, 0.0]).ok()?;
        b.set_uniform_float("color", &[c.r, c.g, c.b, c.a]).ok()?;
        let shader = b.make_shader(&Matrix::default())?;
        // The colour is the shader's; the paint's alpha would apply twice.
        p.set_alpha_f(1.0);
        p.set_shader(shader);
        Some(())
    }
}

/// How far the shadow is drawn either side of the shape, in standard deviations; as `REACH` in `box_shadow.rs`.
const REACH: f32 = 4.0;
/// The longest an ellipse may be as a multiple of its shortest axis; as in `box_shadow.rs`.
const MAX_ELLIPSE_ASPECT: f32 = 4.0;

/// `shadow_box.wgsl`'s blurred shape, as a paint shader in the shape's own units: `shape` is the centre and half size,
/// `misc` the corner radius, the standard deviation and 1 for an ellipse, `color` the unpremultiplied colour. See
/// `box_shadow.rs` for the maths.
const RRECT_BLUR: &str = "uniform float4 shape; uniform float4 misc; layout(color) uniform float4 color;
    float erfa(float x) { float a = abs(x); float t = 1.0 / (1.0 + 0.3275911 * a);
      float poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
      float r = 1.0 - poly * exp(-a * a); return x >= 0.0 ? r : -r; }
    float mass(float a, float b) { return 0.5 * (erfa(b * 0.70710678) - erfa(a * 0.70710678)); }
    float arc(float2 q, float sigma, float centre, float radius, float base, float amplitude, float t0, float t1) {
      if (t1 <= t0) { return 0.0; }
      float phi0 = asin(clamp((t0 - centre) / radius, -1.0, 1.0)); float phi1 = asin(clamp((t1 - centre) / radius, -1.0, 1.0));
      float delta = (phi1 - phi0) / 12.0; float weights = 0.0; float sum = 0.0;
      for (int i = 0; i < 12; i++) {
        float phi = phi0 + delta * (float(i) + 0.5); float z = (centre + radius * sin(phi) - q.y) / sigma;
        float w = exp(-0.5 * z * z) * cos(phi); float c = base + amplitude * cos(phi);
        weights += w; sum += w * mass((-c - q.x) / sigma, (c - q.x) / sigma); }
      if (weights <= 0.0) { return 0.0; }
      return mass((t0 - q.y) / sigma, (t1 - q.y) / sigma) * sum / weights; }
    half4 main(float2 xy) {
      float sigma = max(misc.y, 0.001); float radius = misc.x; bool ellipse = misc.z > 0.5;
      float2 q = abs(xy - shape.xy); float2 hs = shape.zw;
      bool turn = ellipse ? q.y / (hs.y * hs.y) > q.x / (hs.x * hs.x) : q.y - (hs.y - radius) > q.x - (hs.x - radius);
      if (turn) { q = q.yx; hs = hs.yx; }
      float lo = q.y - 4.0 * sigma; float hi = q.y + 4.0 * sigma; float v = 0.0;
      if (ellipse) { v = arc(q, sigma, 0.0, hs.y, 0.0, hs.x, max(lo, -hs.y), min(hi, hs.y)); } else {
        float straight = hs.y - radius; float mid0 = max(lo, -straight); float mid1 = min(hi, straight);
        if (mid1 > mid0) { v = mass((-hs.x - q.x) / sigma, (hs.x - q.x) / sigma) * mass((mid0 - q.y) / sigma, (mid1 - q.y) / sigma); }
        if (radius > 0.0) { float base = hs.x - radius;
          v += arc(q, sigma, straight, radius, base, radius, max(lo, straight), min(hi, hs.y));
          float2 m = float2(q.x, -q.y);
          v += arc(m, sigma, straight, radius, base, radius, max(m.y - 4.0 * sigma, straight), min(m.y + 4.0 * sigma, hs.y)); } }
      float a = color.a * v; return half4(half3(color.rgb * a), half(a)); }";

/// The path's `N` subpaths as rounded rectangles, each with whether it turns clockwise (in y-down space), or `None` if
/// there are not `N` or one is not a rounded rectangle.
fn rounded_rects<const N: usize>(els: &[PathEl]) -> Option<[(RRect, bool); N]> {
    let mut out = [(RRect::default(), false); N];
    let mut rest = els;
    for slot in &mut out {
        let end = rest.iter().position(|e| matches!(e, PathEl::ClosePath))?;
        *slot = rounded_rect(&rest[..=end])?;
        rest = &rest[end + 1..];
    }
    rest.is_empty().then_some(out)
}

/// One closed subpath as a rounded rectangle: straight sides along its bounds, and at each corner either the corner
/// itself or one quarter-ellipse cubic. Anything else is `None`.
fn rounded_rect(els: &[PathEl]) -> Option<(RRect, bool)> {
    let [PathEl::MoveTo(start), body @ .., PathEl::ClosePath] = els else {
        return None;
    };
    if body.len() > 8 {
        return None;
    }
    let ends: Vec<kurbo::Point> = std::iter::once(*start).chain(body.iter().filter_map(PathEl::end_point)).collect();
    let (mut l, mut t, mut r, mut b) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in &ends {
        (l, t, r, b) = (l.min(p.x), t.min(p.y), r.max(p.x), b.max(p.y));
    }
    if !(r - l > EPS && b - t > EPS) {
        return None;
    }
    let near = |a: f64, b: f64| (a - b).abs() <= EPS;
    let corners = [(l, t), (r, t), (r, b), (l, b)];
    let corner_at = |p: kurbo::Point| corners.iter().position(|&(x, y)| near(p.x, x) && near(p.y, y));
    let side = |a: kurbo::Point, q: kurbo::Point| {
        (near(a.x, q.x) && (near(q.x, l) || near(q.x, r))) || (near(a.y, q.y) && (near(q.y, t) || near(q.y, b)))
    };
    let mut radii: [Option<(f64, f64)>; 4] = [None; 4];
    let mut cur = *start;
    for el in body {
        match *el {
            PathEl::LineTo(q) if side(cur, q) => cur = q,
            PathEl::CurveTo(c1, c2, q) => {
                // The corner the arc turns about: the bounds' corner level with one end and in line with the other.
                let k = [kurbo::Point::new(q.x, cur.y), kurbo::Point::new(cur.x, q.y)].into_iter().find(|&k| corner_at(k).is_some())?;
                let i = corner_at(k)?;
                let (rx, ry) = ((k.x - cur.x).abs() + (k.x - q.x).abs(), (k.y - cur.y).abs() + (k.y - q.y).abs());
                let tol = EPS + 1e-3 * rx.max(ry);
                let on = |c: kurbo::Point, from: kurbo::Point| c.distance(from + (k - from) * KAPPA) <= tol;
                if rx <= EPS || ry <= EPS || radii[i].is_some() || !on(c1, cur) || !on(c2, q) {
                    return None;
                }
                radii[i] = Some((rx, ry));
                cur = q;
            }
            _ => return None,
        }
    }
    if !(cur.distance(*start) <= EPS || side(cur, *start)) {
        return None;
    }
    let mut v = [skia_safe::Vector::default(); 4];
    for (i, slot) in v.iter_mut().enumerate() {
        let (rx, ry) = match radii[i] {
            Some(r) => r,
            // A square corner is on the path.
            None if ends.iter().any(|&p| corner_at(p) == Some(i)) => (0.0, 0.0),
            None => return None,
        };
        *slot = skia_safe::Vector::new(rx as f32, ry as f32);
    }
    // Twice the signed area of the polygon through the ends; positive turns clockwise with y down.
    let area: f64 = ends.iter().zip(ends.iter().cycle().skip(1)).map(|(a, q)| a.x * q.y - q.x * a.y).sum();
    let rect = Rect::new(l as f32, t as f32, r as f32, b as f32);
    Some((RRect::new_rect_radii(rect, &v), area > 0.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_dom_shadow_paths() {
        // The shape and clip `outer_shadow` writes for a 100x60 box with 12/0/12/4 radii, offset (4, 6) and spread 3.
        let shape = BezPath::from_svg(
            "M16 3 L107 3 L107 54 C107 62.284 100.284 69 92 69 L8 69 C4.134 69 1 65.866 1 62 L1 18 C1 9.716 7.716 3 16 3 Z",
        )
        .unwrap();
        let Some([(rr, _)]) = rounded_rects::<1>(shape.elements()) else { panic!("not read") };
        assert_eq!(*rr.rect(), Rect::new(1.0, 3.0, 107.0, 69.0));
        let br = rr.radii(skia_safe::rrect::Corner::LowerRight);
        assert!((br.x - 15.0).abs() < 1e-3 && (br.y - 15.0).abs() < 1e-3);

        let clip = BezPath::from_svg(
            "M-30 -30 L140 -30 L140 110 L-30 110 L-30 -30 Z M12 0 C5.373 0 0 5.373 0 12 L0 56 C0 58.209 1.791 60 4 60 L88 60 C94.627 60 100 54.627 100 48 L100 0 Z",
        )
        .unwrap();
        let [(room, a), (hole, b)] = rounded_rects::<2>(clip.elements()).expect("clip not read");
        assert!(room.is_rect() && a != b);
        assert_eq!(*hole.rect(), Rect::new(0.0, 0.0, 100.0, 60.0));
        let tl = hole.radii(skia_safe::rrect::Corner::UpperLeft);
        assert!((tl.x - 12.0).abs() < 1e-3 && (tl.y - 12.0).abs() < 1e-3);
        assert_eq!(hole.radii(skia_safe::rrect::Corner::UpperRight), skia_safe::Vector::new(0.0, 0.0));
    }

    #[test]
    fn leaves_other_paths() {
        // An inset shadow's ring: two subpaths where one is wanted.
        let ring = BezPath::from_svg("M0 0 L10 0 L10 10 L0 10 Z M2 2 L2 8 L8 8 L8 2 Z").unwrap();
        assert!(rounded_rects::<1>(ring.elements()).is_none());
        // A triangle, and a curve that is not a quarter ellipse.
        for d in ["M0 0 L10 0 L10 10 Z", "M0 0 L10 0 C12 0 10 10 10 10 L0 10 Z"] {
            assert!(rounded_rects::<1>(BezPath::from_svg(d).unwrap().elements()).is_none(), "{d}");
        }
    }
}
