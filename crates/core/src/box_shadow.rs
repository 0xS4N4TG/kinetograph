//! The drop shadow of a rectangle, a rounded rectangle or an ellipse, in
//! closed form.
//!
//! A shadow is the layer's alpha, blurred by a Gaussian of standard deviation
//! `blur`, shifted by the offset and tinted. For these shapes, filled with one
//! colour, the blurred alpha has a formula, so `shaders/shadow_box.wgsl`
//! works it out for each pixel in the one pass that composites the layer over
//! it, and nothing is blurred: the layer's alpha is not copied out, spread,
//! shrunk and enlarged again. The shape itself is still the layer's raster,
//! so its edge is exactly what it was.
//!
//! - A rectangle blurred is the product of two erf differences, one per axis.
//! - A rounded rectangle and an ellipse are blurred by summing the rows of
//!   the shape: along the axis that crosses the boundary near the pixel, each
//!   row is a Gaussian weight times an erf difference along the other.
//!   Straight sides are exact. The corners and the ellipse are summed by
//!   sampling the arc (`SAMPLES` points, spaced by angle), with the weights
//!   scaled to the exact mass the Gaussian has over the arc's rows. That is an
//!   approximation, within two thousandths of full alpha (`tests`) for the
//!   shapes it accepts.
//!
//! The same conventions as the blurred shadow: `blur` is the standard
//! deviation in canvas pixels (so `blur / scale` in the layer's own units),
//! the offset is in canvas pixels and not turned with the layer, and the
//! shadow's alpha is the fill's alpha times the blurred shape's.
//!
//! The blurred shadow gets a spread by growing the raster's alpha with a
//! square window along the canvas axes. That is the shape grown by the spread
//! on every side only for a rectangle or rounded rectangle whose sides run
//! along the canvas axes, so only those get a spread here; with a spread, a
//! shape that is turned, or an ellipse, keeps the blurred path.

use vello::kurbo::{Affine, Rect};

use crate::blur::MIN_RADIUS;
use crate::bounds::{self, PixelRect};
use crate::resolve::{
    ResolvedEffect, ResolvedGeometry, ResolvedKind, ResolvedLayer, ResolvedPaint,
};

/// How far the shadow is drawn, and the sum over a shape's rows reaches,
/// either side of a point, in standard deviations. Past it the Gaussian has
/// less than 4e-5 of its mass. `REACH` in the shader.
pub const REACH: f64 = 4.0;

/// The longest an ellipse may be, as a multiple of its shortest axis. The
/// sum over the rows follows the boundary of a long thin ellipse badly where
/// it runs along the rows.
const MAX_ELLIPSE_ASPECT: f64 = 4.0;

/// A shadow drawn in closed form (`plan`), and what the pass needs of it.
#[derive(Clone, Debug, PartialEq)]
pub struct BoxShadow {
    /// The canvas position of the shape's centre, with the offset added.
    centre: [f64; 2],
    /// The canvas-to-layer matrix without its translation: `[a, b, c, d]`
    /// with `x' = a x + b y` and `y' = c x + d y`.
    inverse: [f64; 4],
    /// Half the shape's width and height in layer units, spread included.
    half: [f64; 2],
    /// The corner radius, in layer units. 0 for a rectangle.
    radius: f64,
    ellipse: bool,
    /// Standard deviation of the blur in layer units.
    sigma: f64,
    /// How opaque the fill is, 0..=1.
    alpha: f64,
    /// Linear premultiplied shadow colour.
    color: [f32; 4],
    /// The pixels the shadow can be non-zero in.
    extent: PixelRect,
}

impl BoxShadow {
    /// The closed form of `layer`'s first effect if that is a drop shadow it
    /// covers, drawn under `matrix` (layer space to padded texture pixels).
    /// `None` leaves the shadow to the blurred path. It covers:
    ///
    /// - a shape that is a `rect`, `roundedRect` or `ellipse` (an ellipse
    ///   at most `MAX_ELLIPSE_ASPECT` times as long as it is wide, or the
    ///   other way round), filled with one colour and with no stroke: the
    ///   shape is then the layer, so the shadow is made of its alpha alone.
    ///   This needs the shadow to be the first effect, whose input is the
    ///   shape and nothing an earlier effect changed;
    /// - drawn under a rotation and a uniform scale, which turn a Gaussian
    ///   into one of the same shape and keep the shape a rectangle or an
    ///   ellipse in the layer's own units. A shear or a stretch does not;
    /// - with a blur of at least `blur::MIN_RADIUS`; below that the blurred
    ///   path does not blur at all, so there is no blur to replace;
    /// - with no spread, or a spread on a rectangle or rounded rectangle
    ///   whose sides run along the canvas axes, that does not shrink the
    ///   shape to nothing or below its corner radius (see the module).
    pub fn plan(layer: &ResolvedLayer, matrix: Affine) -> Option<BoxShadow> {
        let ResolvedEffect::DropShadow(shadow) = layer.effects.first()? else {
            return None;
        };
        let ResolvedKind::Shape {
            geometry,
            fill: Some(ResolvedPaint::Solid(fill)),
            stroke: None,
            ..
        } = &layer.kind
        else {
            return None;
        };
        let (width, height, radius, ellipse) = match *geometry {
            ResolvedGeometry::Rect { width, height } => (width, height, 0.0, false),
            ResolvedGeometry::RoundedRect {
                width,
                height,
                radius,
            } => (width, height, radius, false),
            ResolvedGeometry::Ellipse { width, height } => (width, height, 0.0, true),
            ResolvedGeometry::Path { .. } => return None,
        };
        if !(width > 0.0 && height > 0.0 && width.is_finite() && height.is_finite()) {
            return None;
        }
        if ellipse && width.max(height) > MAX_ELLIPSE_ASPECT * width.min(height) {
            return None;
        }
        if shadow.blur.is_nan()
            || shadow.blur < MIN_RADIUS
            || ![shadow.x, shadow.y, shadow.spread]
                .iter()
                .all(|v| v.is_finite())
        {
            return None;
        }

        let coeffs = matrix.as_coeffs();
        if !coeffs.iter().all(|v| v.is_finite()) {
            return None;
        }
        let [a, b, c, d, _, _] = coeffs;
        let det = a * d - b * c;
        let scale = det.abs().sqrt();
        // Both columns of the linear part as long as each other, and at right
        // angles: a rotation and a uniform scale (and maybe a flip).
        let norm = a * a + b * b + c * c + d * d;
        let similar = (a * a + b * b - c * c - d * d).abs() <= 1e-6 * norm
            && (a * c + b * d).abs() <= 1e-6 * norm;
        if !(scale > 1e-6 && similar) {
            return None;
        }

        // As kurbo limits it when the path is made.
        let radius = radius.abs().min(width.min(height) / 2.0);
        let mut half = [width / 2.0, height / 2.0];
        let spread = f64::from(shadow.spread);
        if spread != 0.0 {
            let along_axes = (b.abs() <= 1e-9 * scale && c.abs() <= 1e-9 * scale)
                || (a.abs() <= 1e-9 * scale && d.abs() <= 1e-9 * scale);
            if ellipse || !along_axes {
                return None;
            }
            let grow = spread / scale;
            half = [half[0] + grow, half[1] + grow];
            // A shrunk corner is a smaller arc of the same circle only while
            // it still fits in the shape.
            if !(half[0] > 0.0 && half[1] > 0.0 && radius <= half[0].min(half[1])) {
                return None;
            }
        }

        let offset = [f64::from(shadow.x), f64::from(shadow.y)];
        let middle = matrix * vello::kurbo::Point::new(width / 2.0, height / 2.0);
        let centre = [middle.x + offset[0], middle.y + offset[1]];
        // The linear part's inverse.
        let inverse = [d / det, -c / det, -b / det, a / det];
        let sigma_px = f64::from(shadow.blur);

        // The shape's box through the matrix, moved by the offset and grown
        // by the reach of the Gaussian and a pixel.
        let local = Rect::new(
            width / 2.0 - half[0],
            height / 2.0 - half[1],
            width / 2.0 + half[0],
            height / 2.0 + half[1],
        );
        let cast =
            bounds::transformed(matrix, local) + vello::kurbo::Vec2::new(offset[0], offset[1]);
        let reach = REACH * sigma_px + 1.0;
        let extent = bounds::pixel_rect(cast.inflate(reach, reach))?;

        let values = [
            centre[0], centre[1], inverse[0], inverse[1], inverse[2], inverse[3],
        ];
        if !values.iter().all(|v| v.is_finite()) {
            return None;
        }
        let [red, green, blue, opacity] = shadow.color.linear_premultiplied();
        Some(BoxShadow {
            centre,
            inverse,
            half,
            radius,
            ellipse,
            sigma: sigma_px / scale,
            alpha: f64::from(fill.a) / 255.0,
            color: [red as f32, green as f32, blue as f32, opacity as f32],
            extent,
        })
    }

    /// The pixels the shadow can be non-zero in, outside the layer's own.
    pub fn extent(&self) -> PixelRect {
        self.extent
    }

    /// The pass's `Params` (see `shaders/shadow_box.wgsl`).
    pub fn uniform(&self) -> [f32; 20] {
        let f = |v: f64| v as f32;
        [
            f(self.centre[0]),
            f(self.centre[1]),
            0.0,
            0.0,
            f(self.inverse[0]),
            f(self.inverse[1]),
            f(self.inverse[2]),
            f(self.inverse[3]),
            f(self.half[0]),
            f(self.half[1]),
            f(self.radius),
            f(self.sigma),
            if self.ellipse { 1.0 } else { 0.0 },
            f(self.alpha),
            0.0,
            0.0,
            self.color[0],
            self.color[1],
            self.color[2],
            self.color[3],
        ]
    }
}

#[cfg(test)]
mod tests {
    use std::f64::consts::{PI, SQRT_2};

    use super::*;
    use crate::Scene;

    // --- The shader, in Rust. ---------------------------------------------

    const SAMPLES: usize = 12;

    /// The coefficients of `erf` in `shaders/shadow_box.wgsl`: nine digits,
    /// which the GPU rounds to single precision as `as f32` does.
    const ERF_POLYNOMIAL: [f64; 5] = [
        0.254829592,
        -0.284496736,
        1.421413741,
        -1.453152027,
        1.061405429,
    ];

    /// `erf` in `shaders/shadow_box.wgsl`, in single precision as the GPU
    /// runs it.
    fn erf_shader(x: f32) -> f32 {
        let [a1, a2, a3, a4, a5] = ERF_POLYNOMIAL.map(|v| v as f32);
        let a = x.abs();
        let t = 1.0 / (1.0 + 0.3275911 * a);
        let poly = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))));
        let r = 1.0 - poly * (-a * a).exp();
        if x >= 0.0 { r } else { -r }
    }

    fn erf(x: f64) -> f64 {
        f64::from(erf_shader(x as f32))
    }

    fn mass(a: f64, b: f64) -> f64 {
        0.5 * (erf(b / SQRT_2) - erf(a / SQRT_2))
    }

    #[allow(clippy::too_many_arguments)]
    fn arc(
        q: [f64; 2],
        sigma: f64,
        centre: f64,
        radius: f64,
        base: f64,
        amplitude: f64,
        t0: f64,
        t1: f64,
    ) -> f64 {
        if t1 <= t0 {
            return 0.0;
        }
        let phi0 = ((t0 - centre) / radius).clamp(-1.0, 1.0).asin();
        let phi1 = ((t1 - centre) / radius).clamp(-1.0, 1.0).asin();
        let delta = (phi1 - phi0) / SAMPLES as f64;
        let (mut weights, mut sum) = (0.0, 0.0);
        for i in 0..SAMPLES {
            let phi = phi0 + delta * (i as f64 + 0.5);
            let z = (centre + radius * phi.sin() - q[1]) / sigma;
            let w = (-0.5 * z * z).exp() * phi.cos();
            let c = base + amplitude * phi.cos();
            weights += w;
            sum += w * mass((-c - q[0]) / sigma, (c - q[0]) / sigma);
        }
        if weights <= 0.0 {
            return 0.0;
        }
        mass((t0 - q[1]) / sigma, (t1 - q[1]) / sigma) * sum / weights
    }

    /// `blurred` in the shader: the shape `(half, radius, ellipse)` blurred
    /// by `sigma`, at `rel` from its centre.
    fn blurred(half: [f64; 2], radius: f64, ellipse: bool, sigma: f64, rel: [f64; 2]) -> f64 {
        let mut q = [rel[0].abs(), rel[1].abs()];
        let mut half = half;
        let turn = if ellipse {
            q[1] / (half[1] * half[1]) > q[0] / (half[0] * half[0])
        } else {
            q[1] - (half[1] - radius) > q[0] - (half[0] - radius)
        };
        if turn {
            q = [q[1], q[0]];
            half = [half[1], half[0]];
        }
        let lo = q[1] - REACH * sigma;
        let hi = q[1] + REACH * sigma;
        if ellipse {
            return arc(
                q,
                sigma,
                0.0,
                half[1],
                0.0,
                half[0],
                lo.max(-half[1]),
                hi.min(half[1]),
            );
        }
        let straight = half[1] - radius;
        let mut result = 0.0;
        let (mid0, mid1) = (lo.max(-straight), hi.min(straight));
        if mid1 > mid0 {
            result = mass((-half[0] - q[0]) / sigma, (half[0] - q[0]) / sigma)
                * mass((mid0 - q[1]) / sigma, (mid1 - q[1]) / sigma);
        }
        if radius > 0.0 {
            let base = half[0] - radius;
            result += arc(
                q,
                sigma,
                straight,
                radius,
                base,
                radius,
                lo.max(straight),
                hi.min(half[1]),
            );
            let mirrored = [q[0], -q[1]];
            result += arc(
                mirrored,
                sigma,
                straight,
                radius,
                base,
                radius,
                (mirrored[1] - REACH * sigma).max(straight),
                (mirrored[1] + REACH * sigma).min(half[1]),
            );
        }
        result
    }

    // --- The reference. ---------------------------------------------------

    /// The error function by Simpson's rule on its integral.
    fn erf_reference(x: f64) -> f64 {
        let n = 4000;
        let h = x / n as f64;
        let f = |t: f64| (-t * t).exp();
        let mut sum = f(0.0) + f(x);
        for i in 1..n {
            sum += f(h * i as f64) * if i % 2 == 1 { 4.0 } else { 2.0 };
        }
        2.0 / PI.sqrt() * sum * h / 3.0
    }

    /// The row half width of a shape at height `t` from its centre.
    fn row_half_width(half: [f64; 2], radius: f64, ellipse: bool, t: f64) -> f64 {
        if ellipse {
            let u = t / half[1];
            half[0] * (1.0 - u * u).max(0.0).sqrt()
        } else {
            let d = (t.abs() - (half[1] - radius)).max(0.0);
            half[0] - radius + (radius * radius - d * d).max(0.0).sqrt()
        }
    }

    /// The blurred shape at `rel`, by summing the rows two thousand at a
    /// time, evenly in height, where the shader takes a dozen to an arc.
    fn reference(half: [f64; 2], radius: f64, ellipse: bool, sigma: f64, rel: [f64; 2]) -> f64 {
        let lo = (rel[1] - 7.0 * sigma).max(-half[1]);
        let hi = (rel[1] + 7.0 * sigma).min(half[1]);
        if hi <= lo {
            return 0.0;
        }
        let n = 2000;
        let step = (hi - lo) / n as f64;
        let mut sum = 0.0;
        for i in 0..n {
            let t = lo + step * (i as f64 + 0.5);
            let z = (t - rel[1]) / sigma;
            let g = (-0.5 * z * z).exp() / (sigma * (2.0 * PI).sqrt());
            let c = row_half_width(half, radius, ellipse, t);
            sum += g * mass((-c - rel[0]) / sigma, (c - rel[0]) / sigma) * step;
        }
        sum
    }

    #[test]
    fn the_erf_the_shader_uses_is_within_a_millionth() {
        let mut worst: f64 = 0.0;
        for i in -80..=80 {
            let x = f64::from(i) / 10.0;
            worst = worst.max((f64::from(erf_shader(x as f32)) - erf_reference(x)).abs());
        }
        // Single precision is 6e-8 of 1, and the polynomial 1.5e-7.
        assert!(worst < 5e-7, "worst error {worst}");
        assert!(erf_shader(0.0).abs() < 1e-7);
        assert_eq!(erf_shader(9.0), 1.0);
        assert_eq!(erf_shader(-9.0), -1.0);
    }

    #[test]
    fn a_rectangle_blurred_is_the_product_of_two_erf_differences() {
        // Its corner is a quarter, its edge's middle a half, and far inside it
        // is 1, each to the 6e-5 of the Gaussian that is past the reach.
        let rect = [30.0, 20.0];
        let at = |x: f64, y: f64| blurred(rect, 0.0, false, 4.0, [x, y]);
        assert!((at(30.0, 20.0) - 0.25).abs() < 1e-4);
        assert!((at(30.0, 0.0) - 0.5).abs() < 1e-4);
        assert!((at(0.0, 20.0) - 0.5).abs() < 1e-4);
        assert!((at(0.0, 0.0) - 1.0).abs() < 1e-4);
        assert!(at(60.0, 0.0) < 1e-4);
        // And it agrees with a sum that is not special-cased.
        for (x, y) in [(26.0, 3.0), (35.0, 22.0), (10.0, 17.0)] {
            let exact = reference(rect, 0.0, false, 4.0, [x, y]);
            assert!((at(x, y) - exact).abs() < 1e-4, "{x} {y}");
        }
    }

    /// The most the shader's sum is off the fine one, over a grid around the
    /// shape.
    fn worst_error(half: [f64; 2], radius: f64, ellipse: bool, sigma: f64) -> f64 {
        let mut worst: f64 = 0.0;
        let steps = 8;
        for ix in 0..=steps {
            for iy in 0..=steps {
                let rel = [
                    f64::from(ix) / f64::from(steps) * (half[0] + 2.5 * sigma),
                    f64::from(iy) / f64::from(steps) * (half[1] + 2.5 * sigma),
                ];
                let exact = reference(half, radius, ellipse, sigma, rel);
                let sum = blurred(half, radius, ellipse, sigma, rel);
                worst = worst.max((exact - sum).abs());
            }
        }
        worst
    }

    #[test]
    fn rounded_rectangles_are_within_two_thousandths_of_the_blur() {
        // (half width, half height, radius): a card, a big card, a pill, a
        // thin pill, a nearly square one, a circle made of one, a tall pill.
        let shapes = [
            ([60.0, 40.0], 16.0),
            ([200.0, 150.0], 40.0),
            ([100.0, 30.0], 30.0),
            ([200.0, 10.0], 10.0),
            ([50.0, 50.0], 4.0),
            ([50.0, 50.0], 50.0),
            ([20.0, 150.0], 20.0),
            ([400.0, 250.0], 120.0),
        ];
        for (half, radius) in shapes {
            for sigma in [1.0, 4.0, 10.0, 40.0] {
                let error = worst_error(half, radius, false, sigma);
                assert!(
                    error < 0.002,
                    "{half:?} radius {radius} sigma {sigma}: {error}"
                );
            }
        }
    }

    #[test]
    fn ellipses_up_to_four_to_one_are_within_two_thousandths_of_the_blur() {
        let shapes = [
            [40.0, 40.0],
            [150.0, 50.0],
            [300.0, 200.0],
            [200.0, 50.0],
            [50.0, 200.0],
            [100.0, 30.0],
        ];
        for half in shapes {
            for sigma in [1.0, 4.0, 10.0, 20.0, 40.0] {
                let error = worst_error(half, 0.0, true, sigma);
                assert!(error < 0.002, "{half:?} sigma {sigma}: {error}");
            }
        }
    }

    #[test]
    fn the_shadow_is_symmetric_and_a_big_shape_is_solid_inside() {
        let half = [200.0, 150.0];
        let at = |x: f64, y: f64| blurred(half, 40.0, false, 8.0, [x, y]);
        assert!((at(30.0, 20.0) - at(-30.0, 20.0)).abs() < 1e-9);
        assert!((at(30.0, 20.0) - at(30.0, -20.0)).abs() < 1e-9);
        assert!((at(0.0, 0.0) - 1.0).abs() < 1e-4);
        // Half way up a straight side it is a half.
        assert!((at(200.0, 0.0) - 0.5).abs() < 1e-3);
        let ellipse = |x: f64, y: f64| blurred([300.0, 200.0], 0.0, true, 8.0, [x, y]);
        assert!((ellipse(0.0, 0.0) - 1.0).abs() < 1e-3);
        // The tip of an ellipse is curved away from the blur's reach, so a
        // little under a half.
        assert!(ellipse(300.0, 0.0) > 0.44 && ellipse(300.0, 0.0) < 0.5);
    }

    #[test]
    fn the_shadow_is_nothing_past_the_extent() {
        // The extent is the shape's box and REACH deviations: what is past it
        // holds less than 1e-4 of the shape, for every shape.
        for (half, radius, ellipse) in [
            ([60.0, 40.0], 0.0, false),
            ([60.0, 40.0], 16.0, false),
            ([60.0, 40.0], 0.0, true),
        ] {
            for sigma in [1.0, 6.0, 25.0] {
                for rel in [
                    [half[0] + REACH * sigma, 0.0],
                    [0.0, half[1] + REACH * sigma],
                    [half[0] + REACH * sigma, half[1] + REACH * sigma],
                ] {
                    let value = blurred(half, radius, ellipse, sigma, rel);
                    assert!(value < 1e-4, "{half:?} {radius} {ellipse} {sigma}: {value}");
                }
            }
        }
    }

    // --- Which shadows get it. ---------------------------------------------

    fn layer(json: &str) -> ResolvedLayer {
        let scene = format!(
            r##"{{"width": 400, "height": 300, "fps": 30, "durationInFrames": 1,
                "layers": [{json}]}}"##
        );
        let scene = Scene::from_json(&scene, std::path::PathBuf::new()).unwrap();
        scene.resolve(0).unwrap().layers.remove(0)
    }

    fn shape(geometry: &str, rest: &str) -> ResolvedLayer {
        layer(&format!(
            r##"{{"id": "s", "type": "shape", "shape": {geometry}, "fill": "#cc3355"{rest}}}"##
        ))
    }

    const SHADOW: &str =
        r##", "effects": [{"type": "dropShadow", "y": 8, "blur": 6, "color": "#00000080"}]"##;
    const RECT: &str = r#"{"kind": "rect", "width": 120, "height": 80}"#;

    fn plan(layer: &ResolvedLayer) -> Option<BoxShadow> {
        BoxShadow::plan(layer, Affine::translate((50.0, 40.0)))
    }

    #[test]
    fn a_solid_shape_with_a_blurred_first_shadow_is_drawn_in_closed_form() {
        for geometry in [
            RECT,
            r#"{"kind": "roundedRect", "width": 120, "height": 80, "radius": 12}"#,
            r#"{"kind": "ellipse", "width": 120, "height": 80}"#,
        ] {
            assert!(plan(&shape(geometry, SHADOW)).is_some(), "{geometry}");
        }
    }

    #[test]
    fn the_parameters_are_the_shapes_in_layer_units_and_the_shadow_in_pixels() {
        let rounded = r#"{"kind": "roundedRect", "width": 120, "height": 80, "radius": 500}"#;
        let layer = shape(
            rounded,
            r##", "effects": [{"type": "dropShadow", "x": 3, "y": 8, "blur": 6, "color": "#ff000080"}]"##,
        );
        // A scale of 2 and a move: the layer's own units are twice the pixels.
        let matrix = Affine::translate((50.0, 40.0)) * Affine::scale(2.0);
        let shadow = BoxShadow::plan(&layer, matrix).unwrap();
        let u = shadow.uniform();
        // The centre of the box (60, 40) is at (170, 120), then the offset.
        assert_eq!((u[0], u[1]), (173.0, 128.0));
        // Pixels back to layer units: half.
        assert_eq!((u[4], u[5], u[6], u[7]), (0.5, 0.0, 0.0, 0.5));
        // Half the box, the radius cut to half the shorter side, the blur in
        // layer units, not an ellipse, the fill's alpha.
        assert_eq!((u[8], u[9], u[10], u[11]), (60.0, 40.0, 40.0, 3.0));
        assert_eq!((u[12], u[13]), (0.0, 1.0));
        // Premultiplied linear: red at half alpha.
        let half_alpha = (128.0f64 / 255.0) as f32;
        assert_eq!(
            (u[16], u[17], u[18], u[19]),
            (half_alpha, 0.0, 0.0, half_alpha)
        );

        let translucent = layer_with_fill("#cc335540");
        let u = plan(&translucent).unwrap().uniform();
        assert!((u[13] - 64.0 / 255.0).abs() < 1e-7);
    }

    fn layer_with_fill(fill: &str) -> ResolvedLayer {
        layer(&format!(
            r##"{{"id": "s", "type": "shape", "shape": {RECT}, "fill": "{fill}"{SHADOW}}}"##
        ))
    }

    #[test]
    fn a_turned_layer_keeps_its_offset_in_pixels_and_gets_the_inverse_turn() {
        let layer = shape(RECT, SHADOW);
        let matrix = Affine::rotate(90f64.to_radians());
        let u = BoxShadow::plan(&layer, matrix).unwrap().uniform();
        // Rotating by 90 degrees takes (x, y) to (-y, x): the box's centre
        // (60, 40) to (-40, 60), and the offset (0, 8) is added as it is.
        assert!((u[0] - -40.0).abs() < 1e-5 && (u[1] - 68.0).abs() < 1e-5);
        // Its inverse takes (x, y) back to (y, -x).
        assert!(u[4].abs() < 1e-6 && (u[5] - 1.0).abs() < 1e-6);
        assert!((u[6] - -1.0).abs() < 1e-6 && u[7].abs() < 1e-6);
    }

    #[test]
    fn what_the_blurred_path_does_better_or_the_same_is_left_to_it() {
        // A path, a stroke, a gradient, no fill.
        assert!(
            plan(&shape(
                r#"{"kind": "path", "d": "M0 0 L10 0 L10 10 Z"}"#,
                SHADOW
            ))
            .is_none()
        );
        let stroked = format!(r##", "stroke": {{"color": "#000000", "width": 4}}{SHADOW}"##);
        assert!(plan(&shape(RECT, &stroked)).is_none());
        let gradient = layer(&format!(
            r##"{{"id": "s", "type": "shape", "shape": {RECT}, "fill": {{"type": "linear",
               "x0": 0, "y0": 0, "x1": 100, "y1": 0,
               "stops": [{{"offset": 0, "color": "#ff0000"}}, {{"offset": 1, "color": "#0000ff"}}]}}{SHADOW}}}"##
        ));
        assert!(plan(&gradient).is_none());
        // Not a shape, or an inset shadow, or the shadow not first.
        assert!(
            plan(&layer(&format!(
                r#"{{"id": "g", "type": "group", "children": []{SHADOW}}}"#
            )))
            .is_none()
        );
        let inset = r#", "effects": [{"type": "insetShadow", "blur": 6}]"#;
        assert!(plan(&shape(RECT, inset)).is_none());
        let second = r#", "effects": [{"type": "saturate", "amount": 0.5}, {"type": "dropShadow", "blur": 6}]"#;
        assert!(plan(&shape(RECT, second)).is_none());
        assert!(plan(&shape(RECT, "")).is_none());
        // A blur below the minimum is not blurred by the blurred path either.
        let hard = r#", "effects": [{"type": "dropShadow", "y": 8, "blur": 0.5}]"#;
        assert!(plan(&shape(RECT, hard)).is_none());
        let just_blurred = r#", "effects": [{"type": "dropShadow", "y": 8, "blur": 1}]"#;
        assert!(plan(&shape(RECT, just_blurred)).is_some());
        // An ellipse more than four to one.
        let long = r#"{"kind": "ellipse", "width": 400, "height": 90}"#;
        assert!(plan(&shape(long, SHADOW)).is_none());
        let four = r#"{"kind": "ellipse", "width": 360, "height": 90}"#;
        assert!(plan(&shape(four, SHADOW)).is_some());
        // Nothing to draw.
        assert!(
            plan(&shape(
                r#"{"kind": "rect", "width": 0, "height": 80}"#,
                SHADOW
            ))
            .is_none()
        );
    }

    #[test]
    fn only_a_rotation_and_a_uniform_scale_keep_the_shape() {
        let layer = shape(RECT, SHADOW);
        let draw = |m: Affine| BoxShadow::plan(&layer, m);
        assert!(draw(Affine::rotate(0.3) * Affine::scale(1.7)).is_some());
        assert!(draw(Affine::scale(-1.0)).is_some());
        assert!(draw(Affine::scale_non_uniform(2.0, 1.0)).is_none());
        assert!(draw(Affine::skew(0.2, 0.0)).is_none());
        assert!(draw(Affine::scale(0.0)).is_none());
        assert!(draw(Affine::new([f64::NAN, 0.0, 0.0, 1.0, 0.0, 0.0])).is_none());
    }

    #[test]
    fn a_spread_is_taken_only_where_the_square_window_grows_the_shape_the_same_way() {
        let spread = |s: f64| {
            format!(r##", "effects": [{{"type": "dropShadow", "blur": 6, "spread": {s}}}]"##)
        };
        let rounded = r#"{"kind": "roundedRect", "width": 120, "height": 80, "radius": 12}"#;
        let ellipse = r#"{"kind": "ellipse", "width": 120, "height": 80}"#;
        let flat = Affine::translate((50.0, 40.0));
        // Along the axes (turned a quarter too), a rectangle and a rounded
        // rectangle grow by the spread on every side.
        let grown = BoxShadow::plan(&shape(RECT, &spread(5.0)), flat).unwrap();
        assert_eq!(grown.half, [65.0, 45.0]);
        let u = BoxShadow::plan(&shape(rounded, &spread(5.0)), Affine::scale(2.0) * flat)
            .unwrap()
            .uniform();
        // 2.5 layer units either side at scale 2.
        assert_eq!((u[8], u[9], u[10]), (62.5, 42.5, 12.0));
        assert!(BoxShadow::plan(&shape(rounded, &spread(5.0)), Affine::rotate(PI / 2.0)).is_some());
        // Shrinking works while the corner arc still fits.
        let shrunk = BoxShadow::plan(&shape(rounded, &spread(-20.0)), flat).unwrap();
        assert_eq!(shrunk.half, [40.0, 20.0]);
        assert!(BoxShadow::plan(&shape(rounded, &spread(-30.0)), flat).is_none());
        assert!(BoxShadow::plan(&shape(RECT, &spread(-60.0)), flat).is_none());
        // Turned another way, or an ellipse, the blurred path keeps it.
        assert!(BoxShadow::plan(&shape(RECT, &spread(5.0)), Affine::rotate(0.3)).is_none());
        assert!(BoxShadow::plan(&shape(ellipse, &spread(5.0)), flat).is_none());
        // With none, any turn does.
        assert!(BoxShadow::plan(&shape(RECT, &spread(0.0)), Affine::rotate(0.3)).is_some());
        assert!(BoxShadow::plan(&shape(ellipse, &spread(0.0)), flat).is_some());
    }

    #[test]
    fn the_uniform_and_the_constants_are_those_of_the_shader() {
        let wgsl = include_str!("shaders/shadow_box.wgsl");
        // `Params`: five vec4s, in the order `uniform` fills them.
        let body = wgsl
            .split("struct Params {")
            .nth(1)
            .and_then(|rest| rest.split('}').next())
            .unwrap();
        let fields: Vec<_> = body
            .lines()
            .map(str::trim)
            .filter_map(|line| line.strip_suffix(": vec4<f32>,"))
            .collect();
        assert_eq!(fields, ["centre", "inverse", "shape", "misc", "color"]);
        let shadow = plan(&shape(RECT, SHADOW)).unwrap();
        assert_eq!(shadow.uniform().len(), 4 * fields.len());
        // The two numbers the shader and this module must agree on.
        assert!(wgsl.contains(&format!("const REACH: f32 = {REACH:?};")));
        assert!(wgsl.contains(&format!("const SAMPLES: i32 = {SAMPLES};")));
    }

    #[test]
    fn the_extent_is_the_shapes_box_moved_by_the_offset_and_grown_by_the_reach() {
        let layer = shape(RECT, SHADOW);
        let shadow = plan(&layer).unwrap();
        // The box is (50, 40) to (170, 120); moved down by 8; the reach is
        // 4 * 6 + 1 = 25.
        assert_eq!(shadow.extent(), PixelRect::new(25, 23, 195, 153));
        // Turned, it is the box of the turned box.
        let turned = BoxShadow::plan(&layer, Affine::rotate(PI / 2.0)).unwrap();
        // (0, 0)-(120, 80) turns to (-80, 0)-(0, 120); moved down by 8 and
        // grown by 25. The turn leaves a rounding error of 1e-14 in a
        // coordinate, which may cost a pixel on a side.
        let e = turned.extent();
        assert!(e.x0 == -105 && e.y0 == -17 && e.y1 == 153 && (25..=26).contains(&e.x1));
    }
}
