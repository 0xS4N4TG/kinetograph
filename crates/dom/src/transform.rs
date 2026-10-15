//! CSS transforms of an element as 4x4 matrices (CSS Transforms 2): the
//! `translate`, `rotate`, `scale` and `transform` properties about
//! `transform-origin`, and the `perspective` an element gives its children.
//! Blitz resolves only the 2D subset; readback and the painter need the rest
//! (`rotateX`, `perspective()`, `skew` chains, `translateZ`).
//!
//! Matrices are euclid's `Transform3D<f64>`, which composes row-vector style:
//! `a.then(&b)` applies `a` first. Coordinates are CSS pixels.

use blitz_dom::Node;
use euclid::default::{Rect as EuclidRect, Transform3D};
use style::values::computed::Rotate;
use style::values::computed::length::CSSPixelLength;
use style::values::generics::transform::{Scale, Translate};

pub type Matrix = Transform3D<f64>;

/// `Some(m)` unless `m` is the identity.
fn non_identity(m: Matrix) -> Option<Matrix> {
    (m != Matrix::identity()).then_some(m)
}

fn length_box(width: f32, height: f32) -> EuclidRect<CSSPixelLength> {
    EuclidRect::new(
        euclid::default::Point2D::new(CSSPixelLength::new(0.0), CSSPixelLength::new(0.0)),
        euclid::default::Size2D::new(CSSPixelLength::new(width), CSSPixelLength::new(height)),
    )
}

/// The matrix of `node`'s `translate`, `rotate`, `scale` and `transform`,
/// about its `transform-origin`, mapping the border box's own coordinates (the
/// top-left corner is the origin) to where they paint. `None` for no transform.
/// `size` is the border box in CSS pixels, the reference box for percentages.
pub fn local_transform(node: &Node, size: (f32, f32)) -> Option<Matrix> {
    let styles = node.primary_styles()?;
    let b = styles.get_box();
    let reference = length_box(size.0, size.1);

    let translate = match &b.translate {
        Translate::None => None,
        Translate::Translate(x, y, z) => Some(Matrix::translation(
            f64::from(x.resolve(CSSPixelLength::new(size.0)).px()),
            f64::from(y.resolve(CSSPixelLength::new(size.1)).px()),
            f64::from(z.px()),
        )),
    };
    let rotate = match &b.rotate {
        Rotate::None => None,
        Rotate::Rotate(angle) => Some(Matrix::rotation(
            0.0,
            0.0,
            1.0,
            euclid::Angle::radians(angle.radians64()),
        )),
        Rotate::Rotate3D(x, y, z, angle) => {
            let (x, y, z) = (f64::from(*x), f64::from(*y), f64::from(*z));
            // A direction that cannot be normalised rotates nothing.
            (x * x + y * y + z * z > 1e-12)
                .then(|| Matrix::rotation(x, y, z, euclid::Angle::radians(angle.radians64())))
        }
    };
    let scale = match &b.scale {
        Scale::None => None,
        Scale::Scale(x, y, z) => Some(Matrix::scale(f64::from(*x), f64::from(*y), f64::from(*z))),
    };
    let transform = if b.transform.0.is_empty() {
        None
    } else {
        b.transform
            .to_transform_3d_matrix_f64(Some(&reference))
            .ok()
            .map(|(m, _)| m)
    };

    if translate.is_none() && rotate.is_none() && scale.is_none() && transform.is_none() {
        return None;
    }
    // origin · translate · rotate · scale · transform · origin⁻¹, the point
    // going through the right-most first.
    let origin = &b.transform_origin;
    let (ox, oy, oz) = (
        f64::from(origin.horizontal.resolve(CSSPixelLength::new(size.0)).px()),
        f64::from(origin.vertical.resolve(CSSPixelLength::new(size.1)).px()),
        f64::from(origin.depth.px()),
    );
    let mut m = Matrix::translation(-ox, -oy, -oz);
    for step in [transform, scale, rotate, translate].into_iter().flatten() {
        m = m.then(&step);
    }
    non_identity(m.then(&Matrix::translation(ox, oy, oz)))
}

/// The matrix `node`'s `perspective` applies to its children, in `node`'s
/// own coordinates (the perspective origin is relative to its border box).
pub fn perspective_matrix(node: &Node, size: (f32, f32)) -> Option<Matrix> {
    use style::values::generics::box_::GenericPerspective;
    let styles = node.primary_styles()?;
    let b = styles.get_box();
    let d = match &b.perspective {
        GenericPerspective::None => return None,
        GenericPerspective::Length(l) => f64::from(l.0.px()),
    };
    if !d.is_finite() || d <= 0.0 {
        return None;
    }
    let origin = &b.perspective_origin;
    let ox = f64::from(origin.horizontal.resolve(CSSPixelLength::new(size.0)).px());
    let oy = f64::from(origin.vertical.resolve(CSSPixelLength::new(size.1)).px());
    // translate(o) · perspective(d) · translate(-o), the point going right to left.
    Some(
        Matrix::translation(-ox, -oy, 0.0)
            .then(&Matrix::perspective(d.max(1.0)))
            .then(&Matrix::translation(ox, oy, 0.0)),
    )
}

/// Whether `node` keeps its children's 3D positions (`transform-style:
/// preserve-3d`); otherwise they are flattened into its plane.
pub fn preserves_3d(node: &Node) -> bool {
    use style::computed_values::transform_style::T as TransformStyle;
    node.primary_styles()
        .is_some_and(|s| s.get_box().transform_style == TransformStyle::Preserve3d)
}

/// `m` with its z dropped on the way in and out: what a flat (non
/// `preserve-3d`) parent does to the 3D transforms of its children.
pub fn flatten(m: &Matrix) -> Matrix {
    let mut f = *m;
    f.m13 = 0.0;
    f.m23 = 0.0;
    f.m43 = 0.0;
    f.m31 = 0.0;
    f.m32 = 0.0;
    f.m34 = 0.0;
    f.m33 = 1.0;
    f
}

/// The axis-aligned bounding box of the rectangle `(0, 0, w, h)` under `m`,
/// after the perspective divide. Corners behind the viewer (w <= 0) are left
/// out. `None` when none is in front.
pub fn bounding_box(m: &Matrix, w: f64, h: f64) -> Option<(f64, f64, f64, f64)> {
    let mut min = (f64::INFINITY, f64::INFINITY);
    let mut max = (f64::NEG_INFINITY, f64::NEG_INFINITY);
    let mut any = false;
    for (x, y) in [(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)] {
        let p = m.transform_point3d_homogeneous(euclid::default::Point3D::new(x, y, 0.0));
        if p.w <= 1e-9 {
            continue;
        }
        let (px, py) = (p.x / p.w, p.y / p.w);
        min = (min.0.min(px), min.1.min(py));
        max = (max.0.max(px), max.1.max(py));
        any = true;
    }
    any.then(|| (min.0, min.1, max.0 - min.0, max.1 - min.1))
}
