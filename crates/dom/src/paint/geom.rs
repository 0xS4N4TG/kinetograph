//! Boxes, corner radii and the paths they make.

use kurbo::{BezPath, Rect as KRect, Shape};

/// A rectangle by its top-left corner and size, in CSS pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub const fn new(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, w, h }
    }

    pub fn right(&self) -> f64 {
        self.x + self.w
    }

    pub fn bottom(&self) -> f64 {
        self.y + self.h
    }

    pub fn is_empty(&self) -> bool {
        !(self.w > 0.0 && self.h > 0.0)
    }

    pub fn translate(&self, dx: f64, dy: f64) -> Rect {
        Rect::new(self.x + dx, self.y + dy, self.w, self.h)
    }

    /// Grown by `d` on every side (shrunk when negative; never below zero size).
    pub fn inflate(&self, d: f64) -> Rect {
        Rect::new(
            self.x - d,
            self.y - d,
            (self.w + 2.0 * d).max(0.0),
            (self.h + 2.0 * d).max(0.0),
        )
    }

    /// Moved in by `top`, `right`, `bottom`, `left`.
    pub fn inset(&self, top: f64, right: f64, bottom: f64, left: f64) -> Rect {
        Rect::new(
            self.x + left,
            self.y + top,
            (self.w - left - right).max(0.0),
            (self.h - top - bottom).max(0.0),
        )
    }

    pub fn intersect(&self, o: &Rect) -> Rect {
        let x = self.x.max(o.x);
        let y = self.y.max(o.y);
        Rect::new(
            x,
            y,
            (self.right().min(o.right()) - x).max(0.0),
            (self.bottom().min(o.bottom()) - y).max(0.0),
        )
    }

    pub fn union(&self, o: &Rect) -> Rect {
        let x = self.x.min(o.x);
        let y = self.y.min(o.y);
        Rect::new(
            x,
            y,
            self.right().max(o.right()) - x,
            self.bottom().max(o.bottom()) - y,
        )
    }

    pub fn contains_rect(&self, o: &Rect) -> bool {
        o.x >= self.x - 1e-6
            && o.y >= self.y - 1e-6
            && o.right() <= self.right() + 1e-6
            && o.bottom() <= self.bottom() + 1e-6
    }

    pub fn to_kurbo(&self) -> KRect {
        KRect::new(self.x, self.y, self.right(), self.bottom())
    }
}

/// Corner radii as (horizontal, vertical) pairs: top-left, top-right,
/// bottom-right, bottom-left.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Radii {
    pub tl: (f64, f64),
    pub tr: (f64, f64),
    pub br: (f64, f64),
    pub bl: (f64, f64),
}

impl Radii {
    pub const ZERO: Radii = Radii {
        tl: (0.0, 0.0),
        tr: (0.0, 0.0),
        br: (0.0, 0.0),
        bl: (0.0, 0.0),
    };

    pub fn is_zero(&self) -> bool {
        [self.tl, self.tr, self.br, self.bl]
            .iter()
            .all(|r| r.0 <= 0.0 || r.1 <= 0.0)
    }

    /// Radii that are all the same circle.
    pub fn uniform_circle(&self) -> Option<f64> {
        let r = self.tl;
        ([self.tr, self.br, self.bl].iter().all(|c| *c == r) && r.0 == r.1 && r.0 > 0.0)
            .then_some(r.0)
    }

    /// CSS's "overlapping curves" rule: if the radii of two neighbouring
    /// corners add up to more than the side between them, all radii shrink by
    /// the same factor.
    pub fn fitted(mut self, w: f64, h: f64) -> Radii {
        let sums = [
            (self.tl.0 + self.tr.0, w),
            (self.bl.0 + self.br.0, w),
            (self.tl.1 + self.bl.1, h),
            (self.tr.1 + self.br.1, h),
        ];
        let mut f: f64 = 1.0;
        for (sum, side) in sums {
            if sum > side && sum > 0.0 {
                f = f.min(side / sum);
            }
        }
        if f < 1.0 {
            for r in [&mut self.tl, &mut self.tr, &mut self.br, &mut self.bl] {
                r.0 *= f;
                r.1 *= f;
            }
        }
        self
    }

    /// The radii of the edge `top`, `right`, `bottom`, `left` inside the outer
    /// edge: each reduced by the distance to the side it touches. A corner
    /// with nothing left on either axis is square.
    pub fn inner(&self, top: f64, right: f64, bottom: f64, left: f64) -> Radii {
        let c = |r: (f64, f64), dx: f64, dy: f64| {
            let (h, v) = ((r.0 - dx).max(0.0), (r.1 - dy).max(0.0));
            if h > 0.0 && v > 0.0 { (h, v) } else { (0.0, 0.0) }
        };
        Radii {
            tl: c(self.tl, left, top),
            tr: c(self.tr, right, top),
            br: c(self.br, right, bottom),
            bl: c(self.bl, left, bottom),
        }
    }

    /// The radii of a shadow's shape grown by `spread` (shrunk when
    /// negative), with CSS's softening for sharp corners.
    pub fn spread(&self, spread: f64) -> Radii {
        let c = |r: (f64, f64)| {
            let f = |r: f64| {
                if r <= 0.0 {
                    0.0
                } else if spread >= 0.0 {
                    let ratio = if spread > 0.0 { r / spread } else { 1.0 };
                    let k = if ratio < 1.0 {
                        1.0 + (ratio - 1.0).powi(3)
                    } else {
                        1.0
                    };
                    (r + spread * k).max(0.0)
                } else {
                    (r + spread).max(0.0)
                }
            };
            let (h, v) = (f(r.0), f(r.1));
            if h > 0.0 && v > 0.0 { (h, v) } else { (0.0, 0.0) }
        };
        Radii {
            tl: c(self.tl),
            tr: c(self.tr),
            br: c(self.br),
            bl: c(self.bl),
        }
    }
}

/// The distance a cubic Bézier control point sits from the end of a quarter
/// ellipse arc, as a fraction of the radius.
const KAPPA: f64 = 0.552_284_749_830_793_4;

/// The path of `rect` with rounded corners, clockwise from the top-left.
pub fn rounded_rect_path(rect: Rect, radii: Radii) -> BezPath {
    let radii = radii.fitted(rect.w, rect.h);
    let mut p = BezPath::new();
    let (x0, y0, x1, y1) = (rect.x, rect.y, rect.right(), rect.bottom());
    let sq = |r: (f64, f64)| r.0 <= 0.0 || r.1 <= 0.0;
    let (tl, tr, br, bl) = (radii.tl, radii.tr, radii.br, radii.bl);
    p.move_to((x0 + if sq(tl) { 0.0 } else { tl.0 }, y0));
    // Top edge and top-right corner.
    p.line_to((x1 - if sq(tr) { 0.0 } else { tr.0 }, y0));
    if !sq(tr) {
        p.curve_to(
            (x1 - tr.0 * (1.0 - KAPPA), y0),
            (x1, y0 + tr.1 * (1.0 - KAPPA)),
            (x1, y0 + tr.1),
        );
    }
    // Right edge and bottom-right corner.
    p.line_to((x1, y1 - if sq(br) { 0.0 } else { br.1 }));
    if !sq(br) {
        p.curve_to(
            (x1, y1 - br.1 * (1.0 - KAPPA)),
            (x1 - br.0 * (1.0 - KAPPA), y1),
            (x1 - br.0, y1),
        );
    }
    // Bottom edge and bottom-left corner.
    p.line_to((x0 + if sq(bl) { 0.0 } else { bl.0 }, y1));
    if !sq(bl) {
        p.curve_to(
            (x0 + bl.0 * (1.0 - KAPPA), y1),
            (x0, y1 - bl.1 * (1.0 - KAPPA)),
            (x0, y1 - bl.1),
        );
    }
    // Left edge and top-left corner.
    p.line_to((x0, y0 + if sq(tl) { 0.0 } else { tl.1 }));
    if !sq(tl) {
        p.curve_to(
            (x0, y0 + tl.1 * (1.0 - KAPPA)),
            (x0 + tl.0 * (1.0 - KAPPA), y0),
            (x0 + tl.0, y0),
        );
    }
    p.close_path();
    p
}

/// The same outline, wound the other way round, so that under the non-zero
/// rule it cuts a hole in a clockwise path that contains it.
pub fn rounded_rect_path_reversed(rect: Rect, radii: Radii) -> BezPath {
    rounded_rect_path(rect, radii).reverse_subpaths()
}

/// SVG path data with three decimals, for scene `path` shapes and clips.
pub fn path_d(path: &BezPath) -> String {
    use kurbo::PathEl::*;
    let mut s = String::new();
    let n = |v: f64| -> String {
        let r = (v * 1000.0).round() / 1000.0;
        if r == 0.0 {
            "0".to_string()
        } else {
            format!("{r}")
        }
    };
    for el in path.elements() {
        if !s.is_empty() {
            s.push(' ');
        }
        match el {
            MoveTo(p) => s.push_str(&format!("M{} {}", n(p.x), n(p.y))),
            LineTo(p) => s.push_str(&format!("L{} {}", n(p.x), n(p.y))),
            QuadTo(a, b) => s.push_str(&format!("Q{} {} {} {}", n(a.x), n(a.y), n(b.x), n(b.y))),
            CurveTo(a, b, c) => s.push_str(&format!(
                "C{} {} {} {} {} {}",
                n(a.x),
                n(a.y),
                n(b.x),
                n(b.y),
                n(c.x),
                n(c.y)
            )),
            ClosePath => s.push('Z'),
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounded_rect_bounds_and_area() {
        let r = Rect::new(10.0, 20.0, 100.0, 50.0);
        let p = rounded_rect_path(r, Radii { tl: (10.0, 10.0), tr: (10.0, 10.0), br: (10.0, 10.0), bl: (10.0, 10.0) });
        let b = p.bounding_box();
        assert!((b.x0 - 10.0).abs() < 1e-9 && (b.x1 - 110.0).abs() < 1e-9);
        // 100x50 less the four corner cutouts (a square minus a quarter circle each).
        let area = p.area().abs();
        let want = 5000.0 - 4.0 * (100.0 - std::f64::consts::PI * 100.0 / 4.0);
        assert!((area - want).abs() < 1.0, "{area} vs {want}");
    }

    #[test]
    fn overlapping_radii_scale_down() {
        let r = Radii { tl: (60.0, 60.0), tr: (60.0, 60.0), br: (0.0, 0.0), bl: (0.0, 0.0) };
        let f = r.fitted(100.0, 100.0);
        assert!((f.tl.0 - 50.0).abs() < 1e-9);
    }

    #[test]
    fn reversed_path_has_opposite_area_sign() {
        let r = Rect::new(0.0, 0.0, 40.0, 30.0);
        let a = rounded_rect_path(r, Radii::ZERO).area();
        let b = rounded_rect_path_reversed(r, Radii::ZERO).area();
        assert!((a + b).abs() < 1e-9, "{a} {b}");
    }
}

/// The three boxes of an element that backgrounds, clips and masks refer to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Region {
    Border,
    Padding,
    Content,
}

/// An element's box in its own space: the border box at the origin, its
/// border and padding widths, and its outer corner radii.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BoxGeom {
    pub w: f64,
    pub h: f64,
    /// top, right, bottom, left
    pub border: [f64; 4],
    pub padding: [f64; 4],
    pub radii: Radii,
}

impl BoxGeom {
    pub fn border_box(&self) -> Rect {
        Rect::new(0.0, 0.0, self.w, self.h)
    }

    pub fn padding_box(&self) -> Rect {
        let [t, r, b, l] = self.border;
        self.border_box().inset(t, r, b, l)
    }

    pub fn content_box(&self) -> Rect {
        let [t, r, b, l] = self.border;
        let [pt, pr, pb, pl] = self.padding;
        self.border_box().inset(t + pt, r + pr, b + pb, l + pl)
    }

    /// A region and the radii of its edge.
    pub fn region(&self, which: Region) -> (Rect, Radii) {
        let [t, r, b, l] = self.border;
        match which {
            Region::Border => (self.border_box(), self.radii),
            Region::Padding => (self.padding_box(), self.radii.inner(t, r, b, l)),
            Region::Content => {
                let [pt, pr, pb, pl] = self.padding;
                (
                    self.content_box(),
                    self.radii.inner(t + pt, r + pr, b + pb, l + pl),
                )
            }
        }
    }

    pub fn has_border(&self) -> bool {
        self.border.iter().any(|w| *w > 0.0)
    }
}
