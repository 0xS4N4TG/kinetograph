//! Where a layer's pixels can be non-zero, as boxes of whole pixels.
//!
//! Every pass of the compositor draws one full-screen triangle, so by default
//! each of them runs over the whole padded canvas, however small the layer
//! is. A texture instead carries a [`PixelRect`] (`Tex::bounds`) outside which
//! it is exactly transparent, and a pass draws only the box that its result
//! can be non-zero in: the input's box grown by what the pass reads around
//! each pixel. The grown box has to contain every pixel the full pass would
//! have made non-zero, so everything outside it is left as the pass's clear
//! made it, which is what the full pass writes there. The boxes are therefore
//! conservative, and anything this module cannot bound it leaves to the
//! caller as the whole texture.
//!
//! These functions are pure maths on boxes; the compositor and the renderer
//! (`render.rs`) decide where each one applies.

use glam::{DMat3, DVec3};
use vello::kurbo::{Affine, Point, Rect};

/// Whole pixels of the padded canvas, half-open: the pixels `x0..x1` by
/// `y0..y1`. A box with no area is empty, whatever its numbers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PixelRect {
    pub x0: i32,
    pub y0: i32,
    pub x1: i32,
    pub y1: i32,
}

/// Coordinates are limited to this many pixels either side of the origin, so
/// that growing a box never overflows an `i32`.
const LIMIT: f64 = (1 << 28) as f64;

impl PixelRect {
    pub const EMPTY: PixelRect = PixelRect {
        x0: 0,
        y0: 0,
        x1: 0,
        y1: 0,
    };

    pub fn new(x0: i32, y0: i32, x1: i32, y1: i32) -> PixelRect {
        PixelRect { x0, y0, x1, y1 }
    }

    /// The pixels of a `width` x `height` texture.
    pub fn whole(width: u32, height: u32) -> PixelRect {
        PixelRect::new(0, 0, width as i32, height as i32)
    }

    pub fn is_empty(&self) -> bool {
        self.x1 <= self.x0 || self.y1 <= self.y0
    }

    pub fn width(&self) -> u32 {
        (self.x1 - self.x0).max(0) as u32
    }

    pub fn height(&self) -> u32 {
        (self.y1 - self.y0).max(0) as u32
    }

    /// Moves every side `dx` (left and right) and `dy` (top and bottom) pixels
    /// outwards; a negative amount shrinks. An empty box stays empty.
    pub fn grow(self, dx: i32, dy: i32) -> PixelRect {
        if self.is_empty() {
            return PixelRect::EMPTY;
        }
        PixelRect::new(self.x0 - dx, self.y0 - dy, self.x1 + dx, self.y1 + dy).normalised()
    }

    /// The smallest box holding both. An empty box adds nothing.
    pub fn union(self, other: PixelRect) -> PixelRect {
        match (self.is_empty(), other.is_empty()) {
            (true, _) => other.normalised(),
            (_, true) => self,
            _ => PixelRect::new(
                self.x0.min(other.x0),
                self.y0.min(other.y0),
                self.x1.max(other.x1),
                self.y1.max(other.y1),
            ),
        }
    }

    /// The pixels in both.
    pub fn intersect(self, other: PixelRect) -> PixelRect {
        PixelRect::new(
            self.x0.max(other.x0),
            self.y0.max(other.y0),
            self.x1.min(other.x1),
            self.y1.min(other.y1),
        )
        .normalised()
    }

    pub fn translate(self, dx: i32, dy: i32) -> PixelRect {
        if self.is_empty() {
            return PixelRect::EMPTY;
        }
        PixelRect::new(self.x0 + dx, self.y0 + dy, self.x1 + dx, self.y1 + dy)
    }

    /// `EMPTY` if there is no area, so that equal boxes compare equal.
    fn normalised(self) -> PixelRect {
        if self.is_empty() {
            PixelRect::EMPTY
        } else {
            self
        }
    }
}

/// The whole pixels `r` touches: its sides rounded outwards. `None` if a
/// side is not a number, which callers take to mean "anywhere". Sides beyond
/// `LIMIT` pixels are cut there, which is still more than any texture holds.
pub fn pixel_rect(r: Rect) -> Option<PixelRect> {
    if ![r.x0, r.y0, r.x1, r.y1].iter().all(|v| v.is_finite()) {
        return None;
    }
    let out = |v: f64, round: fn(f64) -> f64| round(v).clamp(-LIMIT, LIMIT) as i32;
    Some(
        PixelRect::new(
            out(r.x0.min(r.x1), f64::floor),
            out(r.y0.min(r.y1), f64::floor),
            out(r.x0.max(r.x1), f64::ceil),
            out(r.y0.max(r.y1), f64::ceil),
        )
        .normalised(),
    )
}

/// The box of the four corners of `r` after `m`.
pub fn transformed(m: Affine, r: Rect) -> Rect {
    let corners = [
        Point::new(r.x0, r.y0),
        Point::new(r.x1, r.y0),
        Point::new(r.x1, r.y1),
        Point::new(r.x0, r.y1),
    ]
    .map(|p| m * p);
    corners
        .iter()
        .skip(1)
        .fold(Rect::from_points(corners[0], corners[0]), |bbox, p| {
            bbox.union_pt(*p)
        })
}

/// How far `m` can lengthen a vector: its largest singular value. For the
/// rotations and uniform scales that layers are drawn under this is the
/// scale.
pub fn max_stretch(m: Affine) -> f64 {
    let [a, b, c, d, _, _] = m.as_coeffs();
    let frobenius = a * a + b * b + c * c + d * d;
    let det = a * d - b * c;
    // The singular values s1 >= s2 satisfy s1^2 + s2^2 = |m|^2 and
    // s1 * s2 = |det|.
    let root = (frobenius * frobenius - 4.0 * det * det).max(0.0).sqrt();
    ((frobenius + root) / 2.0).sqrt()
}

/// A pixel of the aberration pass reads the layer at `offset` pixels either
/// way, through a bilinear read that touches a pixel more on each side; so
/// its output is non-zero up to this many pixels (across, down) from the
/// input's box.
pub fn aberration_growth(offset: [f32; 2]) -> (i32, i32) {
    let along = |v: f32| (f64::from(v).abs().ceil().min(LIMIT) as i32) + 1;
    (along(offset[0]), along(offset[1]))
}

/// A displaced pixel reads the layer where `scale / 2` layer pixels along
/// each axis at most would put it (the noise is within 0..1, so the push is
/// within half the scale), which is `max_stretch` times as far in texels,
/// plus the pixel the bilinear read touches and one for rounding. `None` for
/// a matrix that is not finite.
pub fn displace_growth(scale: f32, m: Affine) -> Option<i32> {
    let reach = max_stretch(m) * f64::from(scale).abs() * std::f64::consts::FRAC_1_SQRT_2;
    reach
        .is_finite()
        .then(|| reach.ceil().min(LIMIT) as i32 + 2)
}

/// A halftone pixel shows the dot of its cell, which reads the layer at the
/// cell's centre: at most half a cell's diagonal away (`size` layer pixels a
/// side, `max_stretch` texels to the layer pixel), plus the same two pixels
/// as `displace_growth`. `None` for a matrix that is not finite.
pub fn halftone_growth(size: f32, m: Affine) -> Option<i32> {
    let reach = max_stretch(m) * f64::from(size).abs() * std::f64::consts::FRAC_1_SQRT_2;
    reach
        .is_finite()
        .then(|| reach.ceil().min(LIMIT) as i32 + 2)
}

/// The pixels a drop shadow can reach: the shadow alpha is read bilinearly
/// at the pixel moved back by the offset `(x, y)`, so it is non-zero up to a
/// pixel past the alpha's box `alpha` moved by the offset.
pub fn shadow_cast(alpha: PixelRect, x: f32, y: f32) -> PixelRect {
    if alpha.is_empty() {
        return PixelRect::EMPTY;
    }
    let (x, y) = (f64::from(x), f64::from(y));
    let moved = Rect::new(
        f64::from(alpha.x0) + x,
        f64::from(alpha.y0) + y,
        f64::from(alpha.x1) + x,
        f64::from(alpha.y1) + y,
    );
    pixel_rect(moved.inflate(1.0, 1.0)).unwrap_or(PixelRect::EMPTY)
}

/// The inverse of `shadow_cast`: the pixels of the shadow alpha that the
/// pixels `layer` read, for an inset shadow.
pub fn shadow_source(layer: PixelRect, x: f32, y: f32) -> PixelRect {
    shadow_cast(layer, -x, -y)
}

/// The box that the homography `h` (texels of a layer's texture to pixels of
/// the canvas, with the third component the depth divisor) puts the pixels
/// `from` in, which the warp pass fills. The pass reads bilinearly, so a
/// pixel next to `from` counts too. `None` if any corner is at or behind the
/// eye plane (the divisor is not positive), where the image is not a box.
pub fn warped(h: DMat3, from: PixelRect) -> Option<PixelRect> {
    if from.is_empty() {
        return Some(PixelRect::EMPTY);
    }
    let from = from.grow(1, 1);
    let corners = [
        (from.x0, from.y0),
        (from.x1, from.y0),
        (from.x1, from.y1),
        (from.x0, from.y1),
    ];
    let mut image: Option<Rect> = None;
    for (x, y) in corners {
        let v = h * DVec3::new(f64::from(x), f64::from(y), 1.0);
        if v.z.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
            return None;
        }
        let p = Point::new(v.x / v.z, v.y / v.z);
        image = Some(match image {
            Some(r) => r.union_pt(p),
            None => Rect::from_points(p, p),
        });
    }
    // A pixel on either side of the image, for the pixel centres and
    // rounding.
    pixel_rect(image?.inflate(1.0, 1.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boxes_round_outwards_and_empty_ones_are_alike() {
        let r = pixel_rect(Rect::new(1.2, -0.5, 3.0, 4.01)).unwrap();
        assert_eq!(r, PixelRect::new(1, -1, 3, 5));
        // A box that is exactly on pixel edges stays as it is.
        assert_eq!(
            pixel_rect(Rect::new(2.0, 3.0, 5.0, 9.0)).unwrap(),
            PixelRect::new(2, 3, 5, 9)
        );
        // Sides given the wrong way round are put right.
        assert_eq!(
            pixel_rect(Rect::new(5.0, 9.0, 2.0, 3.0)).unwrap(),
            PixelRect::new(2, 3, 5, 9)
        );
        // No area: one empty value, so that boxes compare equal.
        assert_eq!(
            pixel_rect(Rect::new(4.0, 4.0, 4.0, 4.0)).unwrap(),
            PixelRect::EMPTY
        );
        assert!(PixelRect::new(7, 7, 3, 9).is_empty());
        assert_eq!(PixelRect::new(7, 7, 3, 9).width(), 0);
        // Not a number: anywhere.
        assert_eq!(pixel_rect(Rect::new(f64::NAN, 0.0, 1.0, 1.0)), None);
        assert_eq!(pixel_rect(Rect::new(0.0, 0.0, f64::INFINITY, 1.0)), None);
        // Huge but finite: cut, not wrapped.
        let huge = pixel_rect(Rect::new(-1e300, 0.0, 1e300, 1.0)).unwrap();
        assert_eq!((huge.x0, huge.x1), (-(1 << 28), 1 << 28));
        assert_eq!(huge.grow(4096, 4096).x0, -(1 << 28) - 4096);
    }

    #[test]
    fn boxes_grow_join_and_meet() {
        let a = PixelRect::new(10, 20, 30, 40);
        assert_eq!(a.grow(2, 3), PixelRect::new(8, 17, 32, 43));
        assert_eq!(a.grow(-5, 0), PixelRect::new(15, 20, 25, 40));
        // Shrunk to nothing.
        assert_eq!(a.grow(-10, 0), PixelRect::EMPTY);
        assert_eq!(PixelRect::EMPTY.grow(5, 5), PixelRect::EMPTY);

        let b = PixelRect::new(25, 0, 50, 25);
        assert_eq!(a.union(b), PixelRect::new(10, 0, 50, 40));
        assert_eq!(a.intersect(b), PixelRect::new(25, 20, 30, 25));
        // Boxes that only touch share no pixel.
        assert_eq!(
            a.intersect(PixelRect::new(30, 20, 40, 40)),
            PixelRect::EMPTY
        );
        // An empty box adds nothing to a union.
        assert_eq!(a.union(PixelRect::EMPTY), a);
        assert_eq!(PixelRect::EMPTY.union(a), a);
        assert_eq!(PixelRect::new(9, 9, 2, 2).union(a), a);
        assert_eq!(a.intersect(PixelRect::EMPTY), PixelRect::EMPTY);
        assert_eq!(a.translate(-10, 5), PixelRect::new(0, 25, 20, 45));
        let whole = PixelRect::whole(100, 50);
        assert_eq!(
            PixelRect::new(-5, -5, 120, 20).intersect(whole),
            PixelRect::new(0, 0, 100, 20)
        );
    }

    #[test]
    fn a_rotated_box_is_bounded_by_its_corners() {
        let r = Rect::new(0.0, 0.0, 10.0, 4.0);
        let quarter =
            Affine::translate((100.0, 50.0)) * Affine::rotate(std::f64::consts::FRAC_PI_2);
        let b = transformed(quarter, r);
        assert!(
            (b.x0 - 96.0).abs() < 1e-9 && (b.x1 - 100.0).abs() < 1e-9,
            "{b:?}"
        );
        assert!(
            (b.y0 - 50.0).abs() < 1e-9 && (b.y1 - 60.0).abs() < 1e-9,
            "{b:?}"
        );
        // Mirrored: the same box, however the corners come out.
        let mirror = Affine::scale_non_uniform(-1.0, 1.0);
        assert_eq!(transformed(mirror, r), Rect::new(-10.0, 0.0, 0.0, 4.0));
    }

    #[test]
    fn the_stretch_of_a_similarity_is_its_scale() {
        let m = Affine::translate((5.0, 9.0)) * Affine::rotate(0.7) * Affine::scale(2.5);
        assert!((max_stretch(m) - 2.5).abs() < 1e-12);
        assert!((max_stretch(Affine::IDENTITY) - 1.0).abs() < 1e-12);
        // Non-uniform: the longer axis.
        assert!((max_stretch(Affine::scale_non_uniform(3.0, 0.5)) - 3.0).abs() < 1e-12);
        assert_eq!(max_stretch(Affine::scale(0.0)), 0.0);
        // A shear is longer than either axis.
        let shear = Affine::new([1.0, 0.0, 1.0, 1.0, 0.0, 0.0]);
        assert!(max_stretch(shear) > 1.61 && max_stretch(shear) < 1.62);
    }

    #[test]
    fn effects_reach_as_far_as_the_pass_reads() {
        // Red is read 3.5 px to the right and 0 down: 4 px and a bilinear
        // pixel across, one pixel down.
        assert_eq!(aberration_growth([3.5, 0.0]), (5, 1));
        assert_eq!(aberration_growth([-4.0, -0.2]), (5, 2));

        let m = Affine::rotate(0.3) * Affine::scale(2.0);
        // Half the scale along each axis is scale / sqrt 2 away: 10 * 2 *
        // 0.7071 = 14.14, then two more.
        assert_eq!(displace_growth(10.0, m), Some(17));
        assert_eq!(displace_growth(-10.0, m), Some(17));
        assert_eq!(displace_growth(0.0, m), Some(2));
        // 8 * 3 * 0.7071 = 16.97.
        assert_eq!(halftone_growth(8.0, Affine::scale(3.0)), Some(19));
        assert_eq!(displace_growth(f32::NAN, m), None);
        assert_eq!(halftone_growth(4.0, Affine::scale(f64::NAN)), None);
    }

    #[test]
    fn a_shadow_is_cast_by_the_offset_and_a_bilinear_pixel() {
        let alpha = PixelRect::new(10, 10, 20, 20);
        // No offset: a pixel more on every side, for the bilinear read.
        assert_eq!(shadow_cast(alpha, 0.0, 0.0), PixelRect::new(9, 9, 21, 21));
        // Offset by (5, -3.5): the pixel at 10 + 5 reads texels 14 and 15.
        assert_eq!(shadow_cast(alpha, 5.0, -3.5), PixelRect::new(14, 5, 26, 18));
        assert_eq!(shadow_cast(PixelRect::EMPTY, 5.0, 5.0), PixelRect::EMPTY);

        // The pixels the shadow alpha is read at, the other way round.
        let layer = PixelRect::new(100, 100, 120, 110);
        let source = shadow_source(layer, 5.0, 2.5);
        assert_eq!(source, PixelRect::new(94, 96, 116, 109));
        // Every texel the bilinear read of a layer pixel touches is inside.
        for x in 100..120 {
            for y in 100..110 {
                let (ox, oy) = (5.0_f64, 2.5_f64);
                let tx = (f64::from(x) - ox).floor() as i32;
                let ty = (f64::from(y) - oy).floor() as i32;
                for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                    let (px, py) = (tx + dx, ty + dy);
                    assert!(
                        px >= source.x0 && px < source.x1 && py >= source.y0 && py < source.y1,
                        "({x}, {y}) reads ({px}, {py}), outside {source:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_warp_lands_in_the_box_of_its_corners_or_nowhere_in_particular() {
        // A shift by (30, 40) with no perspective.
        let shift = DMat3::from_cols(
            DVec3::new(1.0, 0.0, 0.0),
            DVec3::new(0.0, 1.0, 0.0),
            DVec3::new(30.0, 40.0, 1.0),
        );
        // The box grows by a pixel before the warp and by a pixel after it.
        let b = warped(shift, PixelRect::new(0, 0, 10, 10)).unwrap();
        assert_eq!(b, PixelRect::new(28, 38, 42, 52));
        assert_eq!(warped(shift, PixelRect::EMPTY), Some(PixelRect::EMPTY));

        // A divisor that goes to zero or below across the box: not bounded.
        let eye = DMat3::from_cols(
            DVec3::new(1.0, 0.0, 0.0),
            DVec3::new(0.0, 1.0, -0.1),
            DVec3::new(0.0, 0.0, 1.0),
        );
        // w = 1 - 0.1 * y: positive up to y = 10, not at 12 (a grown corner).
        assert!(warped(eye, PixelRect::new(0, 0, 8, 8)).is_some());
        assert_eq!(warped(eye, PixelRect::new(0, 0, 8, 10)), None);
        // A mirror (negative determinant, w still 1) is a box.
        let mirror = DMat3::from_cols(
            DVec3::new(-1.0, 0.0, 0.0),
            DVec3::new(0.0, 1.0, 0.0),
            DVec3::new(100.0, 0.0, 1.0),
        );
        assert_eq!(
            warped(mirror, PixelRect::new(0, 0, 10, 10)).unwrap(),
            PixelRect::new(88, -2, 102, 12)
        );
    }
}
