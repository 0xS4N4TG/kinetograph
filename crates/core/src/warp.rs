//! The maths of 2.5D: moving a flat layer in 3D and looking at it through a
//! camera, as one 3x3 homography on the layer's texture.
//!
//! A layer's full 3D matrix is, rightmost first (CSS order, y down, z toward
//! the viewer)
//!
//! ```text
//! T(x, y, z) . Rx(rotateX) . Ry(rotateY) . Rz(rotation) . S(scale, scale, 1) . T(-anchorX, -anchorY, 0)
//! ```
//!
//! (With a transform origin `o`, in pixels, read `(x, y)` as `(x, y) + o` and
//! the anchor as `anchor + o`: the layer turns about its pivot.)
//!
//! It factors as `W . A`: `A` is the 2D matrix every layer has
//! (`ResolvedTransform::matrix`), and `W = T(x, y, z) . Rx . Ry . T(-x, -y, 0)`
//! moves the plane `A` leaves the layer in, turning it about its position. So
//! a layer is drawn flat, exactly as it always was, and then warped: a point
//! `u` of the flat texture (pixels of the padded canvas) lands on
//! `Proj . P . W . P^-1 . u`, where `P` is the flat matrix of the layer's
//! parent (with the margin offset) and `Proj` the camera. Restricted to the
//! plane `z = 0` that is a 3x3 homography `H`: columns 0, 1 and 3 of the 4x4
//! matrix and its x, y and w rows.
//!
//! The same warp serves `cornerPin`, whose homography comes from four point
//! pairs.

use glam::{DMat3, DMat4, DVec3};
use vello::kurbo::{Affine, Rect};

use crate::resolve::{ResolvedCamera, ResolvedTransform};

/// Below this a matrix is taken to collapse the plane to a line (a card seen
/// edge on, a layer scaled to nothing): there is nothing to draw.
const SINGULAR: f64 = 1e-12;

/// Depths closer than this many pixels are a tie when sorting (see
/// `sort_far_to_near`).
const DEPTH_STEP: f64 = 1.0 / 1024.0;

/// `W` for a layer, or `None` when it has no 3D transform of its own.
pub fn layer_world(t: &ResolvedTransform) -> Option<DMat4> {
    let css = t
        .matrix
        .filter(|m| !crate::scene::matrix_is_affine_2d(m));
    if t.rotate_x == 0.0 && t.rotate_y == 0.0 && t.z == 0.0 && css.is_none() {
        return None;
    }
    let pivot = DVec3::new(t.x + t.origin_x, t.y + t.origin_y, 0.0);
    // A `matrix3d()` that is not a 2D affine sits innermost, next to the
    // anchor, so conjugated by the layer's 2D turn and scale it is part of
    // `W`, which acts after them.
    let inner = css.map_or(DMat4::IDENTITY, |m| {
        let turn = DMat4::from_rotation_z(t.rotation.to_radians())
            * DMat4::from_scale(DVec3::new(t.scale, t.scale, 1.0));
        turn * DMat4::from_cols_array(&m) * turn.inverse()
    });
    Some(
        DMat4::from_translation(pivot + DVec3::new(0.0, 0.0, t.z))
            * DMat4::from_rotation_x(t.rotate_x.to_radians())
            * DMat4::from_rotation_y(t.rotate_y.to_radians())
            * inner
            * DMat4::from_translation(-pivot),
    )
}

/// A 2D matrix as a 3D one that leaves z alone (`S(scale, scale, 1)`, so a
/// group's `scale` does not scale the depth of what is inside it).
pub fn flat(a: Affine) -> DMat4 {
    let [a, b, c, d, e, f] = a.as_coeffs();
    DMat4::from_cols_array(&[
        a, b, 0.0, 0.0, //
        c, d, 0.0, 0.0, //
        0.0, 0.0, 1.0, 0.0, //
        e, f, 0.0, 1.0,
    ])
}

/// Whether `a` can be inverted.
pub fn invertible(a: Affine) -> bool {
    a.determinant().abs() > SINGULAR
}

/// The camera as a matrix on pixels of the padded canvas: CSS's `perspective`
/// about its origin, with the origin moved in by the `margin`. A point is
/// divided by `w = 1 - z / perspective` afterwards. No camera is the identity:
/// orthographic.
pub fn projection(camera: Option<&ResolvedCamera>, margin: u32) -> DMat4 {
    let Some(camera) = camera else {
        return DMat4::IDENTITY;
    };
    let origin = DVec3::new(
        camera.x + f64::from(margin),
        camera.y + f64::from(margin),
        0.0,
    );
    let mut perspective = DMat4::IDENTITY;
    perspective.z_axis.w = -1.0 / camera.perspective;
    DMat4::from_translation(origin) * perspective * DMat4::from_translation(-origin)
}

/// The homography `H` that takes a point of a layer's flat texture to its
/// place on the padded canvas, for the layer `world` (the `W` of the layer,
/// or the accumulated one inside a `preserve3d` group) in a parent whose flat
/// matrix is `parent`. `None` if the plane is seen edge on (or `parent`
/// collapses it): nothing to draw.
pub fn plane_homography(projection: DMat4, parent: Affine, world: DMat4) -> Option<DMat3> {
    if !invertible(parent) {
        return None;
    }
    let m = projection * flat(parent) * world * flat(parent.inverse());
    let h = DMat3::from_cols(
        DVec3::new(m.x_axis.x, m.x_axis.y, m.x_axis.w),
        DVec3::new(m.y_axis.x, m.y_axis.y, m.y_axis.w),
        DVec3::new(m.w_axis.x, m.w_axis.y, m.w_axis.w),
    );
    (h.determinant().abs() > SINGULAR).then_some(h)
}

/// Whether warping by `h` would change nothing.
pub fn is_identity(h: &DMat3) -> bool {
    h.abs_diff_eq(DMat3::IDENTITY, 1e-9)
}

/// `W_G . A_G . W_C . A_G^-1` generalised: the world matrix of a child whose
/// parent in a `preserve3d` group has world `parent_world` and flat matrix
/// `parent_flat` (both relative to the outermost such group's parent), when the
/// child's own `W` is `child`. The child's flat matrix is `parent_flat` times
/// its own `A`.
pub fn child_world(parent_world: DMat4, parent_flat: Affine, child: DMat4) -> DMat4 {
    parent_world * flat(parent_flat) * child * flat(parent_flat.inverse())
}

/// The depth of `point` (in the plane of space 0, flat coordinates) after the
/// layer is moved by `world`: the z that decides painter's order.
pub fn depth(world: &DMat4, point: (f64, f64)) -> f64 {
    world.transform_point3(DVec3::new(point.0, point.1, 0.0)).z
}

/// Sorts `items` farthest first (smallest z first), keeping document order
/// among ties. Depths are compared in steps of 1/1024 pixel, so layers a
/// rotation leaves at the same depth up to rounding error stay in document
/// order instead of swapping on the last bit.
pub fn sort_far_to_near<T>(items: &mut [T], z: impl Fn(&T) -> f64) {
    // `sort_by_key` is stable. Whole steps, so that a depth rounded to -0.0
    // ties with 0.0 (`total_cmp` on floats would put it first).
    items.sort_by_key(|item| (z(item) / DEPTH_STEP).round() as i64);
}

/// The corners of `b` as `cornerPin` lists them: top left, top right, bottom
/// right, bottom left.
pub fn rect_corners(b: Rect) -> [[f64; 2]; 4] {
    [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]]
}

/// The homography that takes the corners of the box `b` (as `rect_corners`
/// lists them) to the points `to`, in the plane of `b`. The sign is chosen so
/// that `w` is positive in the middle of the box, which is what the warp
/// pass reads as "in front". `None` if the box or the quadrilateral has no
/// area.
pub fn corner_pin_homography(b: Rect, to: [[f64; 2]; 4]) -> Option<DMat3> {
    let from = unit_square_to_quad(rect_corners(b))?;
    let h = unit_square_to_quad(to)? * from.inverse();
    if h.determinant().abs() <= SINGULAR {
        return None;
    }
    let middle = h * DVec3::new(b.center().x, b.center().y, 1.0);
    match middle.z {
        w if w > 0.0 => Some(h),
        w if w < 0.0 => Some(-h),
        _ => None,
    }
}

/// `m * h * m^-1`: the homography `h`, written in a layer's own space, moved
/// to the texels the layer matrix `m` takes that space to. `None` if `m`
/// cannot be inverted.
pub fn in_texels(m: Affine, h: DMat3) -> Option<DMat3> {
    if !invertible(m) {
        return None;
    }
    let [a, b, c, d, e, f] = m.as_coeffs();
    let m = DMat3::from_cols(
        DVec3::new(a, b, 0.0),
        DVec3::new(c, d, 0.0),
        DVec3::new(e, f, 1.0),
    );
    Some(m * h * m.inverse())
}

/// The homography from the unit square to the quadrilateral whose corners
/// are `q`, in the order (0,0), (1,0), (1,1), (0,1) (Heckbert's closed form).
/// `None` if the quadrilateral has no area.
fn unit_square_to_quad(q: [[f64; 2]; 4]) -> Option<DMat3> {
    let [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
    let (sx, sy) = (x0 - x1 + x2 - x3, y0 - y1 + y2 - y3);
    let m = if sx == 0.0 && sy == 0.0 {
        // A parallelogram: an affine map.
        DMat3::from_cols(
            DVec3::new(x1 - x0, y1 - y0, 0.0),
            DVec3::new(x2 - x1, y2 - y1, 0.0),
            DVec3::new(x0, y0, 1.0),
        )
    } else {
        let (dx1, dx2, dy1, dy2) = (x1 - x2, x3 - x2, y1 - y2, y3 - y2);
        let det = dx1 * dy2 - dx2 * dy1;
        if det == 0.0 {
            return None;
        }
        let g = (sx * dy2 - dx2 * sy) / det;
        let h = (dx1 * sy - sx * dy1) / det;
        DMat3::from_cols(
            DVec3::new(x1 - x0 + g * x1, y1 - y0 + g * y1, g),
            DVec3::new(x3 - x0 + h * x3, y3 - y0 + h * y3, h),
            DVec3::new(x0, y0, 1.0),
        )
    };
    (m.determinant().abs() > SINGULAR).then_some(m)
}

/// A layer's whole 3D matrix straight from the formula in the module docs, to
/// check the factored forms against.
#[cfg(test)]
pub(crate) fn full_matrix(t: &ResolvedTransform) -> DMat4 {
    DMat4::from_translation(DVec3::new(t.x + t.origin_x, t.y + t.origin_y, t.z))
        * DMat4::from_rotation_x(t.rotate_x.to_radians())
        * DMat4::from_rotation_y(t.rotate_y.to_radians())
        * DMat4::from_rotation_z(t.rotation.to_radians())
        * DMat4::from_scale(DVec3::new(t.scale, t.scale, 1.0))
        * DMat4::from_translation(DVec3::new(
            -(t.anchor_x + t.origin_x),
            -(t.anchor_y + t.origin_y),
            0.0,
        ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::DVec4;

    fn transform(
        (x, y): (f64, f64),
        rotation: f64,
        scale: f64,
        anchor: (f64, f64),
        (rx, ry, z): (f64, f64, f64),
    ) -> ResolvedTransform {
        ResolvedTransform {
            x,
            y,
            scale,
            rotation,
            anchor_x: anchor.0,
            anchor_y: anchor.1,
            rotate_x: rx,
            rotate_y: ry,
            z,
            origin_x: 0.0,
            origin_y: 0.0,
            matrix: None,
        }
    }

    fn near(a: DMat4, b: DMat4) -> bool {
        a.abs_diff_eq(b, 1e-9)
    }

    #[test]
    fn world_times_the_flat_matrix_is_the_full_3d_matrix() {
        let t = transform((120.0, 80.0), 25.0, 1.5, (30.0, 40.0), (35.0, -50.0, 60.0));
        let w = layer_world(&t).expect("a 3D layer has a world matrix");
        assert!(near(w * flat(t.matrix()), full_matrix(&t)));
        // Each field alone.
        for angles in [(40.0, 0.0, 0.0), (0.0, -70.0, 0.0), (0.0, 0.0, 25.0)] {
            let t = transform((10.0, 20.0), -15.0, 0.5, (5.0, 6.0), angles);
            let w = layer_world(&t).unwrap();
            assert!(near(w * flat(t.matrix()), full_matrix(&t)), "{angles:?}");
        }
    }

    #[test]
    fn the_factorisation_holds_with_a_transform_origin() {
        let mut t = transform((120.0, 80.0), 25.0, 1.5, (30.0, 40.0), (35.0, -50.0, 60.0));
        t.origin_x = 45.0;
        t.origin_y = 20.0;
        let w = layer_world(&t).expect("a 3D layer has a world matrix");
        assert!(near(w * flat(t.matrix()), full_matrix(&t)));
        // The pivot lands at (x, y) + origin whatever the layer does: it
        // neither turns in 3D out of its place nor moves with the scale.
        let pivot = DVec3::new(165.0, 100.0, 0.0);
        let anchor_to_pivot = t.matrix() * vello::kurbo::Point::new(75.0, 60.0);
        assert!((anchor_to_pivot.x - pivot.x).abs() < 1e-9);
        assert!((anchor_to_pivot.y - pivot.y).abs() < 1e-9);
        let moved = w.transform_point3(pivot);
        assert!((moved - DVec3::new(165.0, 100.0, 60.0)).length() < 1e-9);
    }

    #[test]
    fn a_layer_with_no_3d_fields_has_no_world_matrix() {
        let t = transform((120.0, 80.0), 25.0, 1.5, (30.0, 40.0), (0.0, 0.0, 0.0));
        assert!(layer_world(&t).is_none());
    }

    #[test]
    fn the_world_matrix_follows_css_rotations() {
        // Pivot at the origin so the points are easy.
        let at = |angles: (f64, f64, f64), p: [f64; 3]| {
            let t = transform((0.0, 0.0), 0.0, 1.0, (0.0, 0.0), angles);
            layer_world(&t)
                .unwrap()
                .transform_point3(DVec3::from_array(p))
        };
        let close = |a: DVec3, b: [f64; 3]| a.abs_diff_eq(DVec3::from_array(b), 1e-9);
        // rotateX(90): the bottom (y > 0) comes toward the viewer.
        assert!(close(
            at((90.0, 0.0, 0.0), [0.0, 10.0, 0.0]),
            [0.0, 0.0, 10.0]
        ));
        // rotateY(90): the right edge (x > 0) goes away.
        assert!(close(
            at((0.0, 90.0, 0.0), [10.0, 0.0, 0.0]),
            [0.0, 0.0, -10.0]
        ));
        // z is toward the viewer.
        assert!(close(
            at((0.0, 0.0, 25.0), [3.0, 4.0, 0.0]),
            [3.0, 4.0, 25.0]
        ));
        // The layer's position does not move when it turns.
        let t = transform((70.0, 30.0), 0.0, 1.0, (0.0, 0.0), (33.0, 44.0, 0.0));
        let p = layer_world(&t)
            .unwrap()
            .transform_point3(DVec3::new(70.0, 30.0, 0.0));
        assert!(p.abs_diff_eq(DVec3::new(70.0, 30.0, 0.0), 1e-9));
    }

    #[test]
    fn the_factorisation_holds_inside_a_parent() {
        // The homography for a child of a scaled, turned parent is the 3x3
        // restriction of Proj . P . W . P^-1 on the plane, which acts on the
        // flat texture of the child: check it against the full chain applied
        // to a point of the plane.
        let camera = ResolvedCamera {
            perspective: 600.0,
            x: 200.0,
            y: 120.0,
        };
        let proj = projection(Some(&camera), 16);
        let parent = Affine::translate((16.0, 16.0))
            * Affine::translate((50.0, 20.0))
            * Affine::rotate(0.4)
            * Affine::scale(1.3);
        let t = transform((90.0, 60.0), 12.0, 1.0, (10.0, 10.0), (30.0, -25.0, 40.0));
        let w = layer_world(&t).unwrap();
        let h = plane_homography(proj, parent, w).expect("not edge on");
        for u in [(0.0, 0.0), (120.0, 40.0), (333.0, 211.0)] {
            // The long way: into parent space, up, through W, back, project.
            let p = parent.inverse() * vello::kurbo::Point::new(u.0, u.1);
            let moved = w.transform_point3(DVec3::new(p.x, p.y, 0.0));
            let back = parent * vello::kurbo::Point::new(moved.x, moved.y);
            let z = moved.z;
            let lifted = proj * DVec4::new(back.x, back.y, z, 1.0);
            let want = (lifted.x / lifted.w, lifted.y / lifted.w);
            // Parent space z is not scaled by the parent: only x and y are.
            let got = h * DVec3::new(u.0, u.1, 1.0);
            let got = (got.x / got.z, got.y / got.z);
            assert!(
                (got.0 - want.0).abs() < 1e-6 && (got.1 - want.1).abs() < 1e-6,
                "{u:?}: {got:?} vs {want:?}"
            );
        }
    }

    #[test]
    fn no_3d_means_the_identity_homography() {
        let parent = Affine::translate((5.0, 7.0)) * Affine::rotate(0.7) * Affine::scale(2.0);
        let camera = ResolvedCamera {
            perspective: 500.0,
            x: 10.0,
            y: 20.0,
        };
        for proj in [DMat4::IDENTITY, projection(Some(&camera), 3)] {
            let h = plane_homography(proj, parent, DMat4::IDENTITY).unwrap();
            assert!(is_identity(&h), "{h:?}");
        }
    }

    #[test]
    fn a_pure_z_move_scales_about_the_camera_origin() {
        let camera = ResolvedCamera {
            perspective: 400.0,
            x: 100.0,
            y: 50.0,
        };
        // Margin 10: the origin sits at (110, 60) in the padded canvas.
        let proj = projection(Some(&camera), 10);
        let t = transform((200.0, 100.0), 0.0, 1.0, (0.0, 0.0), (0.0, 0.0, 100.0));
        let w = layer_world(&t).unwrap();
        let h = plane_homography(proj, Affine::translate((10.0, 10.0)), w).unwrap();
        // 100 px toward the viewer at perspective 400 magnifies by 400 / 300.
        let k = 400.0 / 300.0;
        let at = |p: (f64, f64)| {
            let q = h * DVec3::new(p.0, p.1, 1.0);
            (q.x / q.z, q.y / q.z)
        };
        let (x, y) = at((210.0, 110.0)); // layer position in the padded canvas
        assert!((x - (110.0 + (210.0 - 110.0) * k)).abs() < 1e-9);
        assert!((y - (60.0 + (110.0 - 60.0) * k)).abs() < 1e-9);
        // The camera origin does not move.
        let (x, y) = at((110.0, 60.0));
        assert!((x - 110.0).abs() < 1e-9 && (y - 60.0).abs() < 1e-9);
    }

    #[test]
    fn without_a_camera_a_rotation_only_foreshortens() {
        let t = transform((100.0, 50.0), 0.0, 1.0, (0.0, 0.0), (0.0, 60.0, 0.0));
        let h =
            plane_homography(DMat4::IDENTITY, Affine::IDENTITY, layer_world(&t).unwrap()).unwrap();
        let q = h * DVec3::new(160.0, 80.0, 1.0);
        // 60 px right of the pivot becomes 60 cos(60 deg) = 30, with w = 1.
        assert!((q.z - 1.0).abs() < 1e-12);
        assert!((q.x - 130.0).abs() < 1e-9 && (q.y - 80.0).abs() < 1e-9);
    }

    #[test]
    fn a_plane_turned_edge_on_cannot_be_drawn() {
        let t = transform((100.0, 50.0), 0.0, 1.0, (0.0, 0.0), (0.0, 90.0, 0.0));
        let w = layer_world(&t).unwrap();
        assert!(plane_homography(DMat4::IDENTITY, Affine::IDENTITY, w).is_none());
        // And a parent scaled to nothing.
        let t = transform((100.0, 50.0), 0.0, 1.0, (0.0, 0.0), (10.0, 0.0, 0.0));
        let w = layer_world(&t).unwrap();
        assert!(plane_homography(DMat4::IDENTITY, Affine::scale(0.0), w).is_none());
        // With a camera the same turn is edge on only when the plane runs
        // through the eye; off to the side it is seen as a sliver.
        let camera = ResolvedCamera {
            perspective: 500.0,
            x: 100.0,
            y: 50.0,
        };
        let proj = projection(Some(&camera), 0);
        for (x, drawn) in [(100.0, false), (160.0, true)] {
            let t = transform((x, 50.0), 0.0, 1.0, (0.0, 0.0), (0.0, 90.0, 0.0));
            let h = plane_homography(proj, Affine::IDENTITY, layer_world(&t).unwrap());
            assert_eq!(h.is_some(), drawn, "x = {x}");
        }
    }

    #[test]
    fn points_behind_the_eye_have_negative_w() {
        let camera = ResolvedCamera {
            perspective: 300.0,
            x: 0.0,
            y: 0.0,
        };
        let proj = projection(Some(&camera), 0);
        // w = 1 - z / 300: in front of the eye while z < 300.
        let w_of = |z: f64| (proj * DVec4::new(10.0, 10.0, z, 1.0)).w;
        assert!((w_of(0.0) - 1.0).abs() < 1e-12);
        assert!(w_of(299.0) > 0.0);
        assert!(w_of(300.0).abs() < 1e-12);
        assert!(w_of(450.0) < 0.0);

        // A tilted plane that reaches past the eye: its far end has w < 0,
        // which the shader treats as not there (q.z, the reciprocal of w,
        // is not positive).
        let t = transform((0.0, 0.0), 0.0, 1.0, (0.0, 0.0), (-60.0, 0.0, 250.0));
        let h = plane_homography(proj, Affine::IDENTITY, layer_world(&t).unwrap()).unwrap();
        let w_at = |y: f64| (h * DVec3::new(0.0, y, 1.0)).z;
        // rotateX(-60): the top (y < 0) comes toward the viewer, z =
        // 250 - y sin(60 deg), which is 337 at y = -100, past the eye at 300;
        // the bottom goes back to 163.
        assert!(w_at(100.0) > 0.0);
        assert!(w_at(-100.0) < 0.0, "{}", w_at(-100.0));
        // The inverse mapping of a screen point agrees: the plane point it
        // finds has q.z = 1 / w.
        let inv = h.inverse();
        let q = inv * DVec3::new(0.0, -40.0, 1.0);
        let plane_y = q.y / q.z;
        assert!((q.z - 1.0 / w_at(plane_y)).abs() < 1e-9 * q.z.abs().max(1.0));
    }

    #[test]
    fn child_worlds_compose_like_nested_matrices() {
        // A preserve3d group at (100, 80), turned about y, holds a card at
        // (30, 10) with z = 20. The card's full matrix in the parent of the
        // group is M_G . M_C; its world matrix times its flat matrix must
        // equal that.
        let g = transform((100.0, 80.0), 15.0, 1.2, (0.0, 0.0), (0.0, 40.0, 0.0));
        let c = transform((30.0, 10.0), -5.0, 1.0, (4.0, 3.0), (20.0, 0.0, 20.0));
        let (wg, wc) = (layer_world(&g).unwrap(), layer_world(&c).unwrap());
        let world = child_world(wg, g.matrix(), wc);
        let flat_c = g.matrix() * c.matrix();
        assert!(near(
            world * flat(flat_c),
            full_matrix(&g) * full_matrix(&c)
        ));
        // A child with no 3D of its own keeps the group's world.
        let plain = transform((30.0, 10.0), 0.0, 1.0, (0.0, 0.0), (0.0, 0.0, 0.0));
        assert!(layer_world(&plain).is_none());
        let both = child_world(wg, g.matrix(), DMat4::IDENTITY);
        assert!(near(both, wg));
        assert!(near(
            both * flat(g.matrix() * plain.matrix()),
            full_matrix(&g) * full_matrix(&plain)
        ));
    }

    #[test]
    fn depth_is_the_z_of_a_point_after_the_world_matrix() {
        let t = transform((0.0, 0.0), 0.0, 1.0, (0.0, 0.0), (0.0, 90.0, 30.0));
        let w = layer_world(&t).unwrap();
        // rotateY(90) sends x = 10 to z = -10, then z = 30 adds 30.
        assert!((depth(&w, (10.0, 0.0)) - 20.0).abs() < 1e-9);
        assert!((depth(&DMat4::IDENTITY, (10.0, 5.0))).abs() < 1e-12);
    }

    #[test]
    fn sorting_is_far_to_near_and_stable() {
        let mut items = [
            ("near", 50.0),
            ("far", -80.0),
            ("a", 10.0),
            ("b", 10.0),
            ("mid", 0.0),
            ("c", 10.0),
        ];
        sort_far_to_near(&mut items, |i| i.1);
        let order: Vec<_> = items.iter().map(|i| i.0).collect();
        assert_eq!(order, ["far", "mid", "a", "b", "c", "near"]);
        // Depths that differ by rounding error stay in document order.
        let mut items = [("x", 1.0 + 1e-13), ("y", 1.0), ("z", 1.0 - 1e-13)];
        sort_far_to_near(&mut items, |i| i.1);
        let order: Vec<_> = items.iter().map(|i| i.0).collect();
        assert_eq!(order, ["x", "y", "z"]);
        // Also around 0, where the error has either sign.
        let mut items = [("x", 1e-13), ("y", 0.0), ("z", -1e-13)];
        sort_far_to_near(&mut items, |i| i.1);
        let order: Vec<_> = items.iter().map(|i| i.0).collect();
        assert_eq!(order, ["x", "y", "z"]);
        // Already sorted input is untouched.
        let mut items = [1, 2, 3];
        sort_far_to_near(&mut items, |i| f64::from(*i));
        assert_eq!(items, [1, 2, 3]);
    }

    fn apply(h: &DMat3, p: [f64; 2]) -> [f64; 2] {
        let q = *h * DVec3::new(p[0], p[1], 1.0);
        [q.x / q.z, q.y / q.z]
    }

    fn close(a: [f64; 2], b: [f64; 2]) -> bool {
        (a[0] - b[0]).abs() < 1e-8 && (a[1] - b[1]).abs() < 1e-8
    }

    #[test]
    fn a_homography_maps_the_box_corners_to_the_pins() {
        let b = Rect::new(10.0, 20.0, 210.0, 120.0);
        let to = [[30.0, 10.0], [190.0, 40.0], [230.0, 150.0], [0.0, 110.0]];
        let h = corner_pin_homography(b, to).expect("a real quadrilateral");
        for (from, want) in rect_corners(b).into_iter().zip(to) {
            assert!(close(apply(&h, from), want), "{from:?}");
        }
        // The middle of the box lands where the diagonals of the quad cross.
        let ([ax, ay], [cx, cy], [bx, by], [dx, dy]) = (to[0], to[2], to[1], to[3]);
        let t = ((bx - ax) * (dy - by) - (by - ay) * (dx - bx))
            / ((cx - ax) * (dy - by) - (cy - ay) * (dx - bx));
        let crossing = [ax + t * (cx - ax), ay + t * (cy - ay)];
        assert!(close(apply(&h, [110.0, 70.0]), crossing));
        // A straight line stays straight: the midpoint of an edge maps onto
        // the line between its pinned ends.
        let m = apply(&h, [110.0, 20.0]);
        let (p, q) = (to[0], to[1]);
        let cross = (q[0] - p[0]) * (m[1] - p[1]) - (q[1] - p[1]) * (m[0] - p[0]);
        assert!(cross.abs() < 1e-6, "{cross}");
        // The warp pass wants a positive w in front.
        assert!((h * DVec3::new(110.0, 70.0, 1.0)).z > 0.0);
    }

    #[test]
    fn pinning_to_the_corners_is_the_identity() {
        let b = Rect::new(0.0, 0.0, 150.0, 90.0);
        let h = corner_pin_homography(b, rect_corners(b)).unwrap();
        assert!(h.abs_diff_eq(DMat3::IDENTITY, 1e-9), "{h:?}");
    }

    #[test]
    fn a_parallelogram_pin_is_an_affine_map() {
        let b = Rect::new(0.0, 0.0, 100.0, 50.0);
        // Sheared right by 20 at the bottom.
        let to = [[0.0, 0.0], [100.0, 0.0], [120.0, 50.0], [20.0, 50.0]];
        let h = corner_pin_homography(b, to).unwrap();
        assert!(close(apply(&h, [50.0, 25.0]), [60.0, 25.0]));
        let q = h * DVec3::new(3.0, 4.0, 1.0);
        assert!((q.z - 1.0).abs() < 1e-12);
    }

    #[test]
    fn degenerate_pins_are_refused() {
        let b = Rect::new(0.0, 0.0, 100.0, 50.0);
        // All four on a line.
        let line = [[0.0, 0.0], [10.0, 10.0], [20.0, 20.0], [30.0, 30.0]];
        assert!(corner_pin_homography(b, line).is_none());
        // All on a point.
        let point = [[5.0, 5.0]; 4];
        assert!(corner_pin_homography(b, point).is_none());
        // A box with no width.
        let thin = Rect::new(0.0, 0.0, 0.0, 50.0);
        assert!(corner_pin_homography(thin, rect_corners(b)).is_none());
    }

    #[test]
    fn pins_are_moved_into_texels_by_the_layer_matrix() {
        let b = Rect::new(0.0, 0.0, 100.0, 50.0);
        let to = [[10.0, 5.0], [90.0, 0.0], [100.0, 50.0], [0.0, 40.0]];
        let local = corner_pin_homography(b, to).unwrap();
        let m = Affine::translate((40.0, 30.0)) * Affine::rotate(0.5) * Affine::scale(1.5);
        let h = in_texels(m, local).unwrap();
        for (from, want) in rect_corners(b).into_iter().zip(to) {
            let p = m * vello::kurbo::Point::new(from[0], from[1]);
            let w = m * vello::kurbo::Point::new(want[0], want[1]);
            assert!(close(apply(&h, [p.x, p.y]), [w.x, w.y]), "{from:?}");
        }
        assert!(in_texels(Affine::scale(0.0), local).is_none());
    }
}
