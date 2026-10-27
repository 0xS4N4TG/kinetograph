//! CSS Motion Path: `offset-path`, `offset-distance`, `offset-rotate`,
//! `offset-anchor` and `offset-position` (<https://drafts.fxtf.org/motion-1/>).
//!
//! The offset transform is a translation followed by a rotation, in the
//! element's own box. It sits in the transform chain after `translate`,
//! `rotate` and `scale` and before `transform` (`transform.rs`, `paint/effects.rs`).
//! As Chrome does it, the coordinates of a `path()` are relative to the
//! element's own position (its `left`/`top` shift it), while basic shapes and
//! `ray()` use the containing block's border box, so the element's layout
//! position is cancelled and its anchor lands on the path point.

use blitz_dom::Node;
use kurbo::{
    BezPath, Ellipse, ParamCurve, ParamCurveArclen, ParamCurveDeriv, PathEl, PathSeg, Point, Shape,
    Vec2,
};
use style::values::computed::basic_shape::BasicShape;
use style::values::computed::length::CSSPixelLength;
use style::values::computed::motion::OffsetPathFunction;
use style::values::computed::{LengthPercentage, OffsetPath, Position};
use style::values::generics::basic_shape::{
    GenericPathOrShapeFunction as PathOrShape, GenericShapeRadius as Radius,
};
use style::values::generics::motion::{OffsetPosition, RaySize};
use style::values::generics::position::GenericPositionOrAuto as PosOrAuto;
use style_traits::ToCss;

/// Arc length accuracy in CSS pixels.
const ACCURACY: f64 = 1e-3;

/// Where the offset transform puts an element: `anchor` (a point of the border
/// box) goes to `point`, with the box turned by `angle` radians (clockwise)
/// about it. `point` is relative to where the box would be without the offset.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Motion {
    pub anchor: (f64, f64),
    pub point: (f64, f64),
    pub angle: f64,
}

/// A path's segments with their lengths.
pub struct Measured {
    segs: Vec<PathSeg>,
    lens: Vec<f64>,
    pub total: f64,
    pub closed: bool,
}

impl Measured {
    pub fn new(path: &BezPath) -> Measured {
        let segs: Vec<PathSeg> = path.segments().collect();
        let lens: Vec<f64> = segs.iter().map(|s| s.arclen(ACCURACY)).collect();
        let total = lens.iter().sum();
        let closed = matches!(path.elements().last(), Some(PathEl::ClosePath));
        Measured {
            segs,
            lens,
            total,
            closed,
        }
    }

    /// The point `distance` along the path and the direction of travel there
    /// (radians, clockwise from +x). A closed path wraps; an open one clamps.
    pub fn at(&self, distance: f64) -> Option<(Point, f64)> {
        let last = self.segs.len().checked_sub(1)?;
        let d = if self.closed && self.total > 0.0 {
            distance.rem_euclid(self.total)
        } else {
            distance.clamp(0.0, self.total)
        };
        let mut rest = d;
        for (i, (seg, len)) in self.segs.iter().zip(&self.lens).enumerate() {
            if rest <= *len || i == last {
                let t = if *len > 0.0 {
                    seg.inv_arclen(rest.min(*len), ACCURACY)
                } else {
                    0.0
                };
                return Some((seg.eval(t), direction(seg, t)));
            }
            rest -= len;
        }
        None
    }
}

fn derivative(seg: &PathSeg, t: f64) -> Vec2 {
    match seg {
        PathSeg::Line(l) => l.p1 - l.p0,
        PathSeg::Quad(q) => q.deriv().eval(t).to_vec2(),
        PathSeg::Cubic(c) => c.deriv().eval(t).to_vec2(),
    }
}

/// The tangent angle at `t`; at a cusp (zero derivative) the chord of a
/// nearby stretch.
fn direction(seg: &PathSeg, t: f64) -> f64 {
    let d = derivative(seg, t);
    if d.hypot() > 1e-9 {
        return d.atan2();
    }
    let (a, b) = if t < 0.5 {
        (t, (t + 1e-3).min(1.0))
    } else {
        ((t - 1e-3).max(0.0), t)
    };
    (seg.eval(b) - seg.eval(a)).atan2()
}

fn px(v: &LengthPercentage, basis: f64) -> f64 {
    f64::from(v.resolve(CSSPixelLength::new(basis as f32)).px())
}

fn place(p: &Position, w: f64, h: f64) -> (f64, f64) {
    (px(&p.horizontal, w), px(&p.vertical, h))
}

/// The outline of a basic shape in a `w` x `h` reference box.
fn shape_path(shape: &BasicShape, w: f64, h: f64) -> Option<BezPath> {
    match shape {
        BasicShape::Rect(inset) => {
            let (t, r, b, l) = (
                px(&inset.rect.0, h),
                px(&inset.rect.1, w),
                px(&inset.rect.2, h),
                px(&inset.rect.3, w),
            );
            let (x1, y1) = (w - r, h - b);
            // Starts at the left end of the top edge, clockwise. Rounded
            // corners are not followed.
            let mut p = BezPath::new();
            p.move_to((l, t));
            p.line_to((x1, t));
            p.line_to((x1, y1));
            p.line_to((l, y1));
            p.close_path();
            Some(p)
        }
        BasicShape::Circle(c) => {
            let (cx, cy) = match &c.position {
                PosOrAuto::Position(p) => place(p, w, h),
                PosOrAuto::Auto => (w / 2.0, h / 2.0),
            };
            let sides = [cx, w - cx, cy, h - cy].map(f64::abs);
            let corners = [
                cx.hypot(cy),
                (w - cx).hypot(cy),
                cx.hypot(h - cy),
                (w - cx).hypot(h - cy),
            ];
            let min = |a: &[f64]| a.iter().copied().fold(f64::INFINITY, f64::min);
            let max = |a: &[f64]| a.iter().copied().fold(0.0, f64::max);
            let r = match &c.radius {
                Radius::Length(l) => px(&l.0, ((w * w + h * h) / 2.0).sqrt()),
                Radius::ClosestSide => min(&sides),
                Radius::FarthestSide => max(&sides),
                Radius::ClosestCorner => min(&corners),
                Radius::FarthestCorner => max(&corners),
            };
            Some(Ellipse::new((cx, cy), (r, r), 0.0).to_path(0.01))
        }
        BasicShape::Ellipse(e) => {
            let (cx, cy) = match &e.position {
                PosOrAuto::Position(p) => place(p, w, h),
                PosOrAuto::Auto => (w / 2.0, h / 2.0),
            };
            let axis = |rad: &Radius<LengthPercentage>, basis: f64, near: f64, far: f64| match rad {
                Radius::Length(l) => px(&l.0, basis),
                Radius::ClosestSide | Radius::ClosestCorner => near.abs().min(far.abs()),
                Radius::FarthestSide | Radius::FarthestCorner => near.abs().max(far.abs()),
            };
            let rx = axis(&e.semiaxis_x, w, cx, w - cx);
            let ry = axis(&e.semiaxis_y, h, cy, h - cy);
            Some(Ellipse::new((cx, cy), (rx, ry), 0.0).to_path(0.01))
        }
        BasicShape::Polygon(poly) => {
            let mut p = BezPath::new();
            for (i, c) in poly.coordinates.iter().enumerate() {
                let pt = (px(&c.0, w), px(&c.1, h));
                if i == 0 {
                    p.move_to(pt);
                } else {
                    p.line_to(pt);
                }
            }
            p.close_path();
            (!poly.coordinates.is_empty()).then_some(p)
        }
        BasicShape::PathOrShape(PathOrShape::Path(path)) => {
            let d = path.path.to_css_string();
            let bez = BezPath::from_svg(d.trim().trim_matches('"')).ok()?;
            (!bez.elements().is_empty()).then_some(bez)
        }
        BasicShape::PathOrShape(PathOrShape::Shape(_)) => None,
    }
}

/// What `offset-path` of `node` is not drawn, as `(value, reason)`.
pub fn unsupported(node: &Node) -> Option<(String, &'static str)> {
    let styles = node.primary_styles()?;
    match &styles.get_box().offset_path {
        OffsetPath::OffsetPath { path, .. } => match &**path {
            OffsetPathFunction::Url(_) => Some((
                "url()".into(),
                "an offset path from an SVG element is not followed",
            )),
            OffsetPathFunction::Shape(BasicShape::PathOrShape(PathOrShape::Shape(_))) => Some((
                "shape()".into(),
                "the shape() function is not followed as an offset path",
            )),
            _ => None,
        },
        OffsetPath::CoordBox(_) => Some((
            "<coord-box>".into(),
            "an offset path of only a box is not followed",
        )),
        OffsetPath::None => None,
    }
}

/// Distances in `ray()` for a percentage `offset-distance`.
fn ray_length(size: RaySize, start: (f64, f64), dir: (f64, f64), w: f64, h: f64) -> f64 {
    let (x, y) = start;
    let sides = [x, w - x, y, h - y].map(f64::abs);
    let corners = [
        x.hypot(y),
        (w - x).hypot(y),
        x.hypot(h - y),
        (w - x).hypot(h - y),
    ];
    match size {
        RaySize::ClosestSide => sides.iter().copied().fold(f64::INFINITY, f64::min),
        RaySize::FarthestSide => sides.iter().copied().fold(0.0, f64::max),
        RaySize::ClosestCorner => corners.iter().copied().fold(f64::INFINITY, f64::min),
        RaySize::FarthestCorner => corners.iter().copied().fold(0.0, f64::max),
        RaySize::Sides => {
            // Along the ray to the box's edge.
            let tx = if dir.0 > 1e-12 {
                (w - x) / dir.0
            } else if dir.0 < -1e-12 {
                -x / dir.0
            } else {
                f64::INFINITY
            };
            let ty = if dir.1 > 1e-12 {
                (h - y) / dir.1
            } else if dir.1 < -1e-12 {
                -y / dir.1
            } else {
                f64::INFINITY
            };
            let t = tx.min(ty);
            if t.is_finite() { t.max(0.0) } else { 0.0 }
        }
    }
}

/// The motion of `node` (border box `size`), or `None` without an `offset-path`
/// this module follows.
pub fn motion(node: &Node, size: (f32, f32)) -> Option<Motion> {
    let styles = node.primary_styles()?;
    let b = styles.get_box();
    let OffsetPath::OffsetPath { path, .. } = &b.offset_path else {
        return None;
    };
    let (bw, bh) = (f64::from(size.0), f64::from(size.1));
    let loc = node.unrounded_layout().location;
    let loc = (f64::from(loc.x), f64::from(loc.y));
    let (w, h) = node
        .containing_block()
        .map(|id| node.with(id).unrounded_layout().size)
        .map(|s| (f64::from(s.width), f64::from(s.height)))
        .unwrap_or((0.0, 0.0));

    let anchor = match &b.offset_anchor {
        PosOrAuto::Position(p) => place(p, bw, bh),
        PosOrAuto::Auto => place(
            &Position {
                horizontal: b.transform_origin.horizontal.clone(),
                vertical: b.transform_origin.vertical.clone(),
            },
            bw,
            bh,
        ),
    };
    // `offset-position` is where a ray starts when it names no origin.
    let position = match &b.offset_position {
        OffsetPosition::Normal => None,
        OffsetPosition::Auto => Some(loc),
        OffsetPosition::Position(p) => Some(place(p, w, h)),
    };

    let (point, tangent) = match &**path {
        OffsetPathFunction::Ray(ray) => {
            let start = match &ray.position {
                PosOrAuto::Position(p) => place(p, w, h),
                PosOrAuto::Auto => position.unwrap_or((w / 2.0, h / 2.0)),
            };
            let bearing = f64::from(ray.angle.radians());
            // 0deg points up, positive turns clockwise.
            let dir = (bearing.sin(), -bearing.cos());
            let length = ray_length(ray.size, start, dir, w, h);
            let d = px(&b.offset_distance, length);
            (
                (start.0 + dir.0 * d, start.1 + dir.1 * d),
                bearing - std::f64::consts::FRAC_PI_2,
            )
        }
        OffsetPathFunction::Shape(shape) => {
            let m = Measured::new(&shape_path(shape, w, h)?);
            let d = px(&b.offset_distance, m.total);
            let (p, a) = m.at(d)?;
            ((p.x, p.y), a)
        }
        OffsetPathFunction::Url(_) => return None,
    };

    let rotate = &b.offset_rotate;
    let angle = if rotate.auto {
        tangent + f64::from(rotate.angle.radians())
    } else {
        f64::from(rotate.angle.radians())
    };
    // Chrome measures `path()` from the element's own position, and every other
    // path from the containing block's, so only those cancel the layout position.
    let own = matches!(
        &**path,
        OffsetPathFunction::Shape(BasicShape::PathOrShape(PathOrShape::Path(_)))
    );
    let from = if own { (0.0, 0.0) } else { loc };
    Some(Motion {
        anchor,
        point: (point.0 - from.0, point.1 - from.1),
        angle,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn near(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-3, "{a} vs {b}");
    }

    #[test]
    fn line_path_points_and_direction() {
        let m = Measured::new(&BezPath::from_svg("M 10 20 L 110 20 L 110 120").unwrap());
        near(m.total, 200.0);
        assert!(!m.closed);
        let (p, a) = m.at(50.0).unwrap();
        near(p.x, 60.0);
        near(p.y, 20.0);
        near(a, 0.0);
        let (p, a) = m.at(150.0).unwrap();
        near(p.x, 110.0);
        near(p.y, 70.0);
        near(a, std::f64::consts::FRAC_PI_2);
        // An open path clamps.
        let (p, _) = m.at(500.0).unwrap();
        near(p.x, 110.0);
        near(p.y, 120.0);
        let (p, _) = m.at(-5.0).unwrap();
        near(p.x, 10.0);
    }

    #[test]
    fn closed_path_wraps() {
        let m = Measured::new(&BezPath::from_svg("M 0 0 L 100 0 L 100 100 L 0 100 Z").unwrap());
        assert!(m.closed);
        near(m.total, 400.0);
        let (p, a) = m.at(450.0).unwrap();
        near(p.x, 50.0);
        near(p.y, 0.0);
        near(a, 0.0);
        // The closing edge heads back up.
        let (p, a) = m.at(350.0).unwrap();
        near(p.x, 0.0);
        near(p.y, 50.0);
        near(a, -std::f64::consts::FRAC_PI_2);
    }

    #[test]
    fn curve_path_is_measured_by_arc_length() {
        // A quarter circle of radius 100 as one cubic.
        let k = 0.5522847498 * 100.0;
        let mut p = BezPath::new();
        p.move_to((100.0, 0.0));
        p.curve_to((100.0, k), (k, 100.0), (0.0, 100.0));
        let m = Measured::new(&p);
        near(m.total / (std::f64::consts::PI * 50.0), 1.0);
        let (pt, a) = m.at(m.total / 2.0).unwrap();
        let s = 100.0 * std::f64::consts::FRAC_1_SQRT_2;
        assert!((pt.x - s).abs() < 0.5 && (pt.y - s).abs() < 0.5, "{pt:?}");
        assert!((a - 3.0 * std::f64::consts::FRAC_PI_4).abs() < 0.01, "{a}");
    }

    #[test]
    fn ray_sides_reaches_the_edge() {
        // Straight up from (50, 50) in a 100 x 100 box.
        near(
            ray_length(RaySize::Sides, (50.0, 50.0), (0.0, -1.0), 100.0, 100.0),
            50.0,
        );
        near(
            ray_length(RaySize::Sides, (50.0, 50.0), (1.0, 0.0), 100.0, 100.0),
            50.0,
        );
        near(
            ray_length(RaySize::FarthestCorner, (0.0, 0.0), (1.0, 0.0), 30.0, 40.0),
            50.0,
        );
    }
}
