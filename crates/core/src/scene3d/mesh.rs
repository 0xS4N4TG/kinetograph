//! Triangle meshes for the 3D layer, and the primitives that make them.
//!
//! Every mesh is counter-clockwise seen from outside, with unit normals and
//! texture coordinates `(u, v)` that run from the top left, as images do.

use std::f32::consts::{PI, TAU};
use std::sync::atomic::{AtomicU64, Ordering};

use glam::Vec3;

use super::Geometry3d;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vertex3 {
    pub position: [f32; 3],
    pub normal: [f32; 3],
    pub uv: [f32; 2],
}

/// Bytes of a `Vertex3` on the GPU.
pub const VERTEX_BYTES: u64 = 32;

impl Vertex3 {
    pub fn bytes(vertices: &[Vertex3]) -> Vec<u8> {
        let mut out = Vec::with_capacity(vertices.len() * VERTEX_BYTES as usize);
        for v in vertices {
            for f in v.position.iter().chain(&v.normal).chain(&v.uv) {
                out.extend_from_slice(&f.to_le_bytes());
            }
        }
        out
    }
}

/// A mesh on the CPU. The `id` is what the compositor keys its GPU copy by;
/// it never reaches a pixel.
#[derive(Debug)]
pub struct MeshData {
    pub id: u64,
    pub vertices: Vec<Vertex3>,
    pub indices: Vec<u32>,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub fn next_id() -> u64 {
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

impl MeshData {
    pub fn new(vertices: Vec<Vertex3>, indices: Vec<u32>) -> MeshData {
        debug_assert!(indices.len().is_multiple_of(3));
        debug_assert!(indices.iter().all(|&i| (i as usize) < vertices.len()));
        MeshData {
            id: next_id(),
            vertices,
            indices,
        }
    }

    /// The box of the vertices, `None` for a mesh with none.
    pub fn bounds(&self) -> Option<(Vec3, Vec3)> {
        let mut it = self.vertices.iter().map(|v| Vec3::from(v.position));
        let first = it.next()?;
        Some(it.fold((first, first), |(lo, hi), p| (lo.min(p), hi.max(p))))
    }

    /// The middle of `bounds`, the point a transparent object is sorted by.
    pub fn centre(&self) -> Vec3 {
        self.bounds().map_or(Vec3::ZERO, |(lo, hi)| (lo + hi) / 2.0)
    }
}

/// The mesh of a primitive.
pub fn primitive(g: &Geometry3d) -> MeshData {
    match *g {
        Geometry3d::Box {
            width,
            height,
            depth,
        } => cuboid(width as f32, height as f32, depth as f32),
        Geometry3d::Sphere {
            radius,
            segments,
            rings,
        } => sphere(radius as f32, segments, rings),
        Geometry3d::Plane { width, height } => plane(width as f32, height as f32),
        Geometry3d::Cylinder {
            radius_top,
            radius_bottom,
            height,
            segments,
            capped,
        } => cylinder(
            radius_top as f32,
            radius_bottom as f32,
            height as f32,
            segments,
            capped,
        ),
        Geometry3d::Torus {
            radius,
            tube,
            tube_segments,
            ring_segments,
        } => torus(radius as f32, tube as f32, tube_segments, ring_segments),
    }
}

fn vertex(p: Vec3, n: Vec3, u: f32, v: f32) -> Vertex3 {
    Vertex3 {
        position: p.to_array(),
        normal: n.to_array(),
        uv: [u, v],
    }
}

/// Appends a quad `a b c d` (counter-clockwise) as two triangles, with the
/// four corners' uvs running over the unit square from `a`.
fn quad(vertices: &mut Vec<Vertex3>, indices: &mut Vec<u32>, corners: [Vec3; 4], n: Vec3) {
    let base = vertices.len() as u32;
    let uvs = [[0.0, 1.0], [1.0, 1.0], [1.0, 0.0], [0.0, 0.0]];
    for (p, uv) in corners.into_iter().zip(uvs) {
        vertices.push(vertex(p, n, uv[0], uv[1]));
    }
    indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
}

fn cuboid(w: f32, h: f32, d: f32) -> MeshData {
    let (x, y, z) = (w / 2.0, h / 2.0, d / 2.0);
    let p = Vec3::new;
    let (mut vertices, mut indices) = (Vec::new(), Vec::new());
    let faces = [
        // +z, -z, +x, -x, +y, -y; corners counter-clockwise from outside,
        // starting at the bottom left as the face is seen.
        (
            [p(-x, -y, z), p(x, -y, z), p(x, y, z), p(-x, y, z)],
            Vec3::Z,
        ),
        (
            [p(x, -y, -z), p(-x, -y, -z), p(-x, y, -z), p(x, y, -z)],
            Vec3::NEG_Z,
        ),
        (
            [p(x, -y, z), p(x, -y, -z), p(x, y, -z), p(x, y, z)],
            Vec3::X,
        ),
        (
            [p(-x, -y, -z), p(-x, -y, z), p(-x, y, z), p(-x, y, -z)],
            Vec3::NEG_X,
        ),
        (
            [p(-x, y, z), p(x, y, z), p(x, y, -z), p(-x, y, -z)],
            Vec3::Y,
        ),
        (
            [p(-x, -y, -z), p(x, -y, -z), p(x, -y, z), p(-x, -y, z)],
            Vec3::NEG_Y,
        ),
    ];
    for (corners, normal) in faces {
        quad(&mut vertices, &mut indices, corners, normal);
    }
    MeshData::new(vertices, indices)
}

fn plane(w: f32, h: f32) -> MeshData {
    let (x, y) = (w / 2.0, h / 2.0);
    let (mut vertices, mut indices) = (Vec::new(), Vec::new());
    quad(
        &mut vertices,
        &mut indices,
        [
            Vec3::new(-x, -y, 0.0),
            Vec3::new(x, -y, 0.0),
            Vec3::new(x, y, 0.0),
            Vec3::new(-x, y, 0.0),
        ],
        Vec3::Z,
    );
    MeshData::new(vertices, indices)
}

fn sphere(radius: f32, segments: u32, rings: u32) -> MeshData {
    let mut vertices = Vec::new();
    for j in 0..=rings {
        let v = j as f32 / rings as f32;
        let phi = v * PI;
        for i in 0..=segments {
            let u = i as f32 / segments as f32;
            let theta = u * TAU;
            // theta runs from +x towards -z, so that the faces wind
            // counter-clockwise seen from outside.
            let n = Vec3::new(phi.sin() * theta.cos(), phi.cos(), -phi.sin() * theta.sin());
            vertices.push(vertex(n * radius, n, u, v));
        }
    }
    let mut indices = Vec::new();
    let row = segments + 1;
    for j in 0..rings {
        for i in 0..segments {
            let (a, b) = (j * row + i, (j + 1) * row + i);
            // The pole rows collapse to a point: skip their empty triangle.
            if j != 0 {
                indices.extend([a, b, a + 1]);
            }
            if j != rings - 1 {
                indices.extend([a + 1, b, b + 1]);
            }
        }
    }
    MeshData::new(vertices, indices)
}

fn cylinder(top: f32, bottom: f32, height: f32, segments: u32, capped: bool) -> MeshData {
    let (mut vertices, mut indices) = (Vec::new(), Vec::new());
    let half = height / 2.0;
    // The side's normal leans by the slope of its wall.
    let slope = (bottom - top) / height;
    for ring in 0..2 {
        let (radius, y, v) = if ring == 0 {
            (top, half, 0.0)
        } else {
            (bottom, -half, 1.0)
        };
        for i in 0..=segments {
            let u = i as f32 / segments as f32;
            let theta = u * TAU;
            let (s, c) = theta.sin_cos();
            let n = Vec3::new(s, slope, c).normalize();
            vertices.push(vertex(Vec3::new(radius * s, y, radius * c), n, u, v));
        }
    }
    let row = segments + 1;
    for i in 0..segments {
        let (t, b) = (i, row + i);
        // A radius of 0 collapses a ring: drop the empty triangle.
        if top > 0.0 {
            indices.extend([t, b, t + 1]);
        }
        if bottom > 0.0 {
            indices.extend([t + 1, b, b + 1]);
        }
    }
    if capped {
        for (radius, y, n) in [(top, half, Vec3::Y), (bottom, -half, Vec3::NEG_Y)] {
            if radius <= 0.0 {
                continue;
            }
            let centre = vertices.len() as u32;
            vertices.push(vertex(Vec3::new(0.0, y, 0.0), n, 0.5, 0.5));
            for i in 0..=segments {
                let theta = i as f32 / segments as f32 * TAU;
                let (s, c) = theta.sin_cos();
                vertices.push(vertex(
                    Vec3::new(radius * s, y, radius * c),
                    n,
                    0.5 + 0.5 * s,
                    0.5 + 0.5 * c,
                ));
            }
            for i in 0..segments {
                let (a, b) = (centre + 1 + i, centre + 2 + i);
                if n.y > 0.0 {
                    indices.extend([centre, a, b]);
                } else {
                    indices.extend([centre, b, a]);
                }
            }
        }
    }
    MeshData::new(vertices, indices)
}

fn torus(radius: f32, tube: f32, tube_segments: u32, ring_segments: u32) -> MeshData {
    let mut vertices = Vec::new();
    for j in 0..=tube_segments {
        let v = j as f32 / tube_segments as f32;
        let phi = v * TAU;
        for i in 0..=ring_segments {
            let u = i as f32 / ring_segments as f32;
            let theta = u * TAU;
            let centre = Vec3::new(radius * theta.cos(), radius * theta.sin(), 0.0);
            let p = Vec3::new(
                (radius + tube * phi.cos()) * theta.cos(),
                (radius + tube * phi.cos()) * theta.sin(),
                tube * phi.sin(),
            );
            vertices.push(vertex(p, (p - centre).normalize(), u, v));
        }
    }
    let mut indices = Vec::new();
    let row = ring_segments + 1;
    for j in 0..tube_segments {
        for i in 0..ring_segments {
            let (a, b) = (j * row + i, (j + 1) * row + i);
            indices.extend([a, a + 1, b, a + 1, b + 1, b]);
        }
    }
    MeshData::new(vertices, indices)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all() -> Vec<(&'static str, Geometry3d)> {
        let g = |json: &str| serde_json::from_str::<Geometry3d>(json).unwrap();
        vec![
            (
                "box",
                g(r#"{"kind": "box", "width": 2, "height": 1, "depth": 3}"#),
            ),
            ("sphere", g(r#"{"kind": "sphere", "radius": 1.5}"#)),
            ("plane", g(r#"{"kind": "plane", "width": 2, "height": 4}"#)),
            (
                "cylinder",
                g(r#"{"kind": "cylinder", "radiusTop": 0.5, "radiusBottom": 1}"#),
            ),
            (
                "cone",
                g(r#"{"kind": "cylinder", "radiusTop": 0, "radiusBottom": 1}"#),
            ),
            (
                "open cylinder",
                g(r#"{"kind": "cylinder", "capped": false}"#),
            ),
            ("torus", g(r#"{"kind": "torus", "radius": 1, "tube": 0.3}"#)),
        ]
    }

    #[test]
    fn faces_wind_counter_clockwise_seen_from_outside() {
        for (name, geometry) in all() {
            let mesh = primitive(&geometry);
            assert!(!mesh.indices.is_empty(), "{name}");
            for t in mesh.indices.chunks(3) {
                let v = |i: u32| Vec3::from(mesh.vertices[i as usize].position);
                let n = (v(t[1]) - v(t[0])).cross(v(t[2]) - v(t[0]));
                let want: Vec3 = t
                    .iter()
                    .map(|&i| Vec3::from(mesh.vertices[i as usize].normal))
                    .sum();
                assert!(n.length() > 1e-9, "{name}: a degenerate triangle {t:?}");
                assert!(n.dot(want) > 0.0, "{name}: triangle {t:?} faces inwards");
            }
        }
    }

    #[test]
    fn normals_are_unit_length() {
        for (name, geometry) in all() {
            for v in &primitive(&geometry).vertices {
                let len = Vec3::from(v.normal).length();
                assert!((len - 1.0).abs() < 1e-5, "{name}: {len}");
            }
        }
    }

    #[test]
    fn sizes_match_the_parameters() {
        let size = |g: &Geometry3d| {
            let (lo, hi) = primitive(g).bounds().unwrap();
            (hi - lo).to_array()
        };
        let near = |a: [f32; 3], b: [f32; 3]| a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-5);
        let all = all();
        assert!(near(size(&all[0].1), [2.0, 1.0, 3.0]));
        assert!(near(size(&all[1].1), [3.0, 3.0, 3.0]));
        assert!(near(size(&all[2].1), [2.0, 4.0, 0.0]));
        assert!(near(size(&all[3].1), [2.0, 1.0, 2.0]));
        // The torus: the ring's diameter plus the tube's, and the tube's.
        assert!(near(size(&all[6].1), [2.6, 2.6, 0.6]));
    }

    #[test]
    fn a_closed_surface_has_each_edge_twice() {
        use std::collections::HashMap;
        // Compare positions, not indices: seams duplicate vertices.
        let key = |p: [f32; 3]| p.map(|c| (c * 1e4).round() as i64);
        for (name, geometry) in all() {
            if matches!(name, "plane" | "open cylinder") {
                continue;
            }
            let mesh = primitive(&geometry);
            let mut edges: HashMap<([i64; 3], [i64; 3]), i32> = HashMap::new();
            for t in mesh.indices.chunks(3) {
                for k in 0..3 {
                    let a = key(mesh.vertices[t[k] as usize].position);
                    let b = key(mesh.vertices[t[(k + 1) % 3] as usize].position);
                    // A directed edge, and its opposite cancels it.
                    *edges.entry((a, b)).or_default() += 1;
                    *edges.entry((b, a)).or_default() -= 1;
                }
            }
            assert!(
                edges.values().all(|&n| n == 0),
                "{name}: an edge is not shared by two triangles that agree on the winding"
            );
        }
    }

    #[test]
    fn uvs_stay_in_the_unit_square() {
        for (name, geometry) in all() {
            for v in &primitive(&geometry).vertices {
                assert!(
                    v.uv.iter().all(|c| (-1e-6..=1.0 + 1e-6).contains(c)),
                    "{name}: {:?}",
                    v.uv
                );
            }
        }
    }
}
