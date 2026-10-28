//! The order in which the planes of a `preserve3d` group are painted, and
//! where they are cut: a BSP tree of the planes, walked back to front from
//! the eye, as Chrome orders the layers of a 3D rendering context. Planes
//! that cross are cut along the line where they meet, and each piece takes
//! its own place in the order, so either plane is in front where it is
//! nearer. Planes in one plane keep the order they are given in.
//!
//! A plane is a layer's flat space (`u`, `v`, the pixels of the padded
//! canvas its flat texture is drawn in) moved into 3D by a 4x4 matrix. A
//! piece is the plane cut by half planes of that flat space; a plane that
//! nothing crosses is one piece with no cuts. The cuts are lines across the
//! whole plane, not edges of its box, so the pieces of a plane always add up
//! to all of it: what the layer draws outside its box (a shadow, a glow) is
//! in one of them.

use glam::{DMat4, DVec3, DVec4};

/// Points nearer a plane than this many pixels are on it: planes that only
/// touch (the faces of a cube, along an edge) are not cut.
const ON_PLANE: f64 = 1e-3;

/// One layer's plane: `to_world` takes a point `(u, v, 0, 1)` of its flat
/// space to 3D (homogeneous, before the camera), and `corners` are the
/// corners of its box in the flat space, which decide what it crosses.
pub struct Plane {
    pub to_world: DMat4,
    pub corners: [[f64; 2]; 4],
}

/// A piece of plane `item` to paint: the part of its flat space where every
/// cut holds.
#[derive(Debug, Clone, PartialEq)]
pub struct Piece {
    pub item: usize,
    pub cuts: Vec<Cut>,
}

/// A half plane of a layer's flat space: `a u + b v + c >= 0` for `line`
/// `(a, b, c)`, or `> 0` when `strict`. A plane cut in two keeps the line in
/// one piece only (the piece in front of the cutting plane), so a point on it
/// is drawn once.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cut {
    pub line: DVec3,
    pub strict: bool,
}

/// The pieces of `planes`, back to front as seen from `eye` (homogeneous: a
/// point, or a direction with `w = 0` for a camera at infinity looking down
/// -z). Planes that are not planes in 3D (seen edge on, scaled to nothing)
/// draw nothing and come first, uncut.
pub fn paint_order(planes: &[Plane], eye: DVec4) -> Vec<Piece> {
    let mut out = Vec::with_capacity(planes.len());
    let mut polys = Vec::with_capacity(planes.len());
    let mut splitters = Vec::with_capacity(planes.len());
    for (item, plane) in planes.iter().enumerate() {
        let points: Vec<DVec3> = plane
            .corners
            .iter()
            .map(|&[u, v]| {
                let p = plane.to_world * DVec4::new(u, v, 0.0, 1.0);
                p.truncate() / p.w
            })
            .collect();
        match splitter(&points) {
            Some(s) if points.iter().all(|p| p.is_finite()) => {
                splitters.push(Some(s));
                polys.push(Poly {
                    item,
                    points,
                    cuts: Vec::new(),
                });
            }
            _ => {
                splitters.push(None);
                out.push(Piece {
                    item,
                    cuts: Vec::new(),
                });
            }
        }
    }
    let mut walked = Vec::with_capacity(polys.len());
    if let Some(tree) = build(polys, &splitters) {
        walk(&tree, eye, &mut walked);
    }
    // The cuts in each plane's flat space.
    out.extend(walked.into_iter().map(|(item, cuts)| {
        Piece {
            item,
            cuts: cuts
                .into_iter()
                .map(|(c, strict)| Cut {
                    line: flat_line(planes[item].to_world, c),
                    strict,
                })
                .collect(),
        }
    }));
    out
}

/// A plane in 3D: the points `p` with `n . p + d = 0`, `n` of length 1;
/// in front is where `n . p + d > 0`.
#[derive(Clone, Copy, Debug)]
struct Splitter {
    n: DVec3,
    d: f64,
}

impl Splitter {
    fn distance(&self, p: DVec3) -> f64 {
        self.n.dot(p) + self.d
    }
}

/// The plane through a polygon (Newell's normal), if it is one.
fn splitter(points: &[DVec3]) -> Option<Splitter> {
    let mut n = DVec3::ZERO;
    for (i, a) in points.iter().enumerate() {
        let b = points[(i + 1) % points.len()];
        n += DVec3::new(
            (a.y - b.y) * (a.z + b.z),
            (a.z - b.z) * (a.x + b.x),
            (a.x - b.x) * (a.y + b.y),
        );
    }
    let len = n.length();
    // (Not `len <= 1e-9`: a NaN length is no plane either.)
    if len.is_nan() || len <= 1e-9 {
        return None;
    }
    let n = n / len;
    let centre = points.iter().copied().sum::<DVec3>() / points.len() as f64;
    Some(Splitter {
        n,
        d: -n.dot(centre),
    })
}

/// A piece in 3D while the tree is built: its points, and the cuts made so
/// far as 4D planes (`(n, d)` scaled by the side kept: `n . p + d >= 0`, or
/// `> 0` when strict).
struct Poly {
    item: usize,
    points: Vec<DVec3>,
    cuts: Vec<(DVec4, bool)>,
}

struct Node {
    splitter: Splitter,
    /// The polygons in the node's plane, in the order given.
    on: Vec<Poly>,
    front: Option<Box<Node>>,
    back: Option<Box<Node>>,
}

fn build(mut polys: Vec<Poly>, splitters: &[Option<Splitter>]) -> Option<Box<Node>> {
    if polys.is_empty() {
        return None;
    }
    let root = polys.remove(0);
    let s = splitters[root.item].expect("a plane with a splitter");
    let (mut on, mut front, mut back) = (vec![root], Vec::new(), Vec::new());
    for poly in polys {
        let dist: Vec<f64> = poly.points.iter().map(|p| s.distance(*p)).collect();
        let ahead = dist.iter().any(|d| *d > ON_PLANE);
        let behind = dist.iter().any(|d| *d < -ON_PLANE);
        match (ahead, behind) {
            (false, false) => on.push(poly),
            (true, false) => front.push(poly),
            (false, true) => back.push(poly),
            (true, true) => {
                let (f, b) = split(poly, &dist, s);
                front.extend(f);
                back.extend(b);
            }
        }
    }
    Some(Box::new(Node {
        splitter: s,
        on,
        front: build(front, splitters),
        back: build(back, splitters),
    }))
}

/// `poly` cut by `s` into the part in front and the part behind (`dist`: its
/// points' distances from `s`). A part too thin to be a polygon is dropped.
fn split(poly: Poly, dist: &[f64], s: Splitter) -> (Option<Poly>, Option<Poly>) {
    let n = poly.points.len();
    let (mut f, mut b) = (Vec::with_capacity(n + 1), Vec::with_capacity(n + 1));
    for i in 0..n {
        let j = (i + 1) % n;
        let (p, q) = (poly.points[i], poly.points[j]);
        let (dp, dq) = (dist[i], dist[j]);
        if dp >= -ON_PLANE {
            f.push(p);
        }
        if dp <= ON_PLANE {
            b.push(p);
        }
        if (dp > ON_PLANE && dq < -ON_PLANE) || (dp < -ON_PLANE && dq > ON_PLANE) {
            let x = p + (q - p) * (dp / (dp - dq));
            f.push(x);
            b.push(x);
        }
    }
    let plane = DVec4::new(s.n.x, s.n.y, s.n.z, s.d);
    let part = |points: Vec<DVec3>, side: f64| {
        (points.len() >= 3).then(|| {
            let mut cuts = poly.cuts.clone();
            cuts.push((plane * side, side < 0.0));
            Poly {
                item: poly.item,
                points,
                cuts,
            }
        })
    };
    (part(f, 1.0), part(b, -1.0))
}

/// Back to front from `eye`: the side of each node's plane away from the eye,
/// the node's own polygons, then the side towards it. Each polygon's item
/// and its cuts in 3D.
fn walk(node: &Node, eye: DVec4, out: &mut Vec<(usize, Vec<(DVec4, bool)>)>) {
    let s = node.splitter;
    let eye_in_front = s.n.dot(eye.truncate()) + s.d * eye.w >= 0.0;
    let (far, near) = if eye_in_front {
        (&node.back, &node.front)
    } else {
        (&node.front, &node.back)
    };
    if let Some(far) = far {
        walk(far, eye, out);
    }
    out.extend(node.on.iter().map(|p| (p.item, p.cuts.clone())));
    if let Some(near) = near {
        walk(near, eye, out);
    }
}

/// The line of a layer's flat space where the cut `(n, d)` (`n . p + d >= 0`
/// kept) meets its plane, `to_world` taking the flat space to 3D. A point
/// `(u, v)` lands at `X = to_world (u, v, 0, 1)` (homogeneous, `w > 0` in
/// front of the eye), so the sign of `n . X.xyz + d X.w` is the side, and it
/// is linear in `(u, v, 1)`. Scaled so that `(a, b)` has length 1.
fn flat_line(to_world: DMat4, cut: DVec4) -> DVec3 {
    let l = DVec3::new(
        cut.dot(to_world.x_axis),
        cut.dot(to_world.y_axis),
        cut.dot(to_world.w_axis),
    );
    let len = l.truncate().length();
    if len > 0.0 { l / len } else { l }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORTHO: DVec4 = DVec4::new(0.0, 0.0, 1.0, 0.0);

    /// A 100 x 100 plane moved by `m`.
    fn plane(m: DMat4) -> Plane {
        Plane {
            to_world: m,
            corners: [[0.0, 0.0], [100.0, 0.0], [100.0, 100.0], [0.0, 100.0]],
        }
    }

    /// Turned `deg` about the vertical line u = 50, then moved `z` towards the eye.
    fn turned(deg: f64, z: f64) -> DMat4 {
        DMat4::from_translation(DVec3::new(50.0, 0.0, z))
            * DMat4::from_rotation_y(deg.to_radians())
            * DMat4::from_translation(DVec3::new(-50.0, 0.0, 0.0))
    }

    fn items(pieces: &[Piece]) -> Vec<usize> {
        pieces.iter().map(|p| p.item).collect()
    }

    #[test]
    fn parallel_planes_go_far_to_near_whatever_the_order_given() {
        let planes = [
            plane(turned(0.0, 40.0)),
            plane(turned(0.0, -50.0)),
            plane(turned(0.0, 0.0)),
        ];
        let pieces = paint_order(&planes, ORTHO);
        assert_eq!(items(&pieces), [1, 2, 0]);
        assert!(pieces.iter().all(|p| p.cuts.is_empty()));
        // Seen from behind (a camera at z = -1000), the other way round.
        let pieces = paint_order(&planes, DVec4::new(50.0, 50.0, -1000.0, 1.0));
        assert_eq!(items(&pieces), [0, 2, 1]);
    }

    #[test]
    fn planes_in_one_plane_keep_the_order_given() {
        let planes = [
            plane(turned(30.0, 0.0)),
            plane(turned(30.0, 0.0) * DMat4::from_translation(DVec3::new(20.0, 10.0, 0.0))),
            plane(turned(30.0, 0.0) * DMat4::from_translation(DVec3::new(-20.0, 5.0, 0.0))),
        ];
        assert_eq!(items(&paint_order(&planes, ORTHO)), [0, 1, 2]);
    }

    #[test]
    fn crossing_planes_are_cut_where_they_meet() {
        // The second plane stands through the middle of the first.
        let planes = [plane(turned(0.0, 0.0)), plane(turned(90.0, 0.0))];
        let pieces = paint_order(&planes, ORTHO);
        assert_eq!(items(&pieces), [1, 0, 1]);
        assert!(pieces[1].cuts.is_empty());
        let line = |p: &Piece| p.cuts.iter().map(|c| c.line).collect::<Vec<_>>();
        let (back, front) = (&line(&pieces[0]), &line(&pieces[2]));
        // The line itself is in the piece in front only.
        assert!(!pieces[2].cuts[0].strict && pieces[0].cuts[0].strict);
        assert_eq!((back.len(), front.len()), (1, 1));
        // The line u = 50 of the turned plane, each piece keeping one side.
        for cut in [back[0], front[0]] {
            assert!(
                cut.y.abs() < 1e-9 && (cut.x * 50.0 + cut.z).abs() < 1e-9,
                "{cut:?}"
            );
        }
        assert!((back[0] + front[0]).length() < 1e-9);
        // The piece behind is the half that a quarter turn about y sends
        // back: u > 50 goes to z < 0.
        let side = |c: DVec3, u: f64| c.x * u + c.z;
        assert!(side(back[0], 90.0) > 0.0 && side(front[0], 10.0) > 0.0);
    }

    #[test]
    fn planes_that_only_touch_are_not_cut() {
        // Two faces of a cube, meeting along an edge.
        let front = DMat4::from_translation(DVec3::new(0.0, 0.0, 50.0));
        let side = DMat4::from_translation(DVec3::new(100.0, 0.0, 50.0))
            * DMat4::from_rotation_y(90f64.to_radians());
        let pieces = paint_order(&[plane(side), plane(front)], ORTHO);
        assert_eq!(pieces.len(), 2);
        assert!(pieces.iter().all(|p| p.cuts.is_empty()));
    }

    #[test]
    fn a_plane_seen_edge_on_in_3d_comes_first_uncut() {
        let flat = DMat4::from_scale(DVec3::new(1.0, 0.0, 1.0));
        let pieces = paint_order(&[plane(turned(0.0, 10.0)), plane(flat)], ORTHO);
        assert_eq!(items(&pieces), [1, 0]);
    }

    /// The pieces of each plane hold every point of it exactly once, points
    /// on a cut included (`Cut::strict`).
    fn each_point_once(planes: &[Plane], pieces: &[Piece], us: &[f64]) {
        let keeps = |c: &Cut, u: f64, v: f64| {
            let d = c.line.dot(DVec3::new(u, v, 1.0));
            if c.strict { d > 0.0 } else { d >= 0.0 }
        };
        for item in 0..planes.len() {
            for &u in us {
                for v in [0.0, 50.0, 100.0] {
                    let n = pieces
                        .iter()
                        .filter(|p| p.item == item && p.cuts.iter().all(|c| keeps(c, u, v)))
                        .count();
                    assert_eq!(n, 1, "plane {item} at ({u}, {v}) is in {n} pieces");
                }
            }
        }
    }

    /// A star of 20 cards turned about one vertical axis: they meet only
    /// along it, so none is cut more than once.
    #[test]
    fn a_star_of_cards_meets_along_its_axis() {
        let planes: Vec<Plane> = (0..20)
            .map(|i| plane(turned(f64::from(i) * 9.0, 0.0)))
            .collect();
        let pieces = paint_order(&planes, DVec4::new(50.0, 50.0, 900.0, 1.0));
        assert!(pieces.iter().all(|p| p.cuts.len() <= 1));
        each_point_once(
            &planes,
            &pieces,
            &[0.0, 25.0, 49.999, 50.0, 50.001, 75.0, 100.0],
        );
    }

    /// A card lying flat, crossed by 20 standing cards side by side: its
    /// pieces collect a cut from each card on their way down the tree, more
    /// than a warp takes at once.
    #[test]
    fn a_comb_of_cards_cuts_one_plane_many_times() {
        let flat = DMat4::from_translation(DVec3::new(0.0, 50.0, -50.0))
            * DMat4::from_rotation_x(90f64.to_radians());
        let mut planes: Vec<Plane> = (0..20)
            .map(|i| {
                let dx = f64::from(i) * 5.0 - 47.5;
                plane(DMat4::from_translation(DVec3::new(dx, 0.0, 0.0)) * turned(90.0, 0.0))
            })
            .collect();
        planes.push(plane(flat));
        let pieces = paint_order(&planes, DVec4::new(50.0, -300.0, 900.0, 1.0));
        let most = pieces.iter().map(|p| p.cuts.len()).max().unwrap();
        assert!(most > 16, "{most} cuts at most");
        // The flat card is cut where each standing one crosses it, u = 2.5 + 5 i.
        let us: Vec<f64> = (0..=40).map(|k| f64::from(k) * 2.5).collect();
        each_point_once(&planes, &pieces, &us);
    }
}
