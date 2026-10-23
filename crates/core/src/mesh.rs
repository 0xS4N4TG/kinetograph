//! Mesh gradients on the CPU: a grid of control points, each with a colour,
//! turned into triangles for `shaders/mesh.wgsl`.
//!
//! Between four neighbouring points the mesh is one bicubic Hermite patch.
//! Position and colour are interpolated by the same patch, as one six-number
//! value `[x, y, r, g, b, a]` (colours in sRGB, straight alpha, 0..1), so a
//! colour follows the surface as the points move. The patch needs a slope
//! along each axis and a twist (the slope of the slope) at its four corners.
//! They come from Catmull-Rom: the slope at a point is half the difference of
//! its two neighbours along that axis, and a one-sided difference at the
//! border, which makes the surface smooth across the cell edges (C1) and
//! reproduces a regular grid exactly. The twist is the same rule applied to
//! the slopes across the other axis.

use kurbo::{Affine, Point};

use crate::color::Color;

/// Quads per cell side. A cell is a bicubic patch, drawn as this many quads
/// each way, so its curvature shows and its colour is smooth.
pub const SUBDIVISIONS: usize = 16;

/// A mesh vertex as `shaders/mesh.wgsl` reads it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vertex {
    /// In texels of the (padded) texture the mesh is drawn into.
    pub position: [f32; 2],
    /// sRGB, straight alpha, each 0..=1.
    pub color: [f32; 4],
}

/// `[x, y, r, g, b, a]`.
type Node = [f64; 6];

/// Triangles (three vertices each, two per quad) covering the mesh of
/// `columns` x `rows` `points` (row-major, in layer space) with one colour per
/// point, taken to texels by `matrix`.
pub fn tessellate(
    columns: usize,
    rows: usize,
    points: &[[f64; 2]],
    colors: &[Color],
    matrix: Affine,
) -> Vec<Vertex> {
    assert!(
        columns >= 2 && rows >= 2,
        "a mesh has at least 2 x 2 points"
    );
    assert_eq!(points.len(), columns * rows, "one point per grid position");
    assert_eq!(colors.len(), points.len(), "one colour per point");
    let at = |i: usize, j: usize| j * columns + i;

    let nodes: Vec<Node> = points
        .iter()
        .zip(colors)
        .map(|(p, c)| {
            let channel = |v: u8| f64::from(v) / 255.0;
            [
                p[0],
                p[1],
                channel(c.r),
                channel(c.g),
                channel(c.b),
                channel(c.a),
            ]
        })
        .collect();
    let mut du = vec![[0.0; 6]; nodes.len()];
    let mut dv = vec![[0.0; 6]; nodes.len()];
    for j in 0..rows {
        for i in 0..columns {
            du[at(i, j)] = slope(|k| nodes[at(k, j)], i, columns);
            dv[at(i, j)] = slope(|k| nodes[at(i, k)], j, rows);
        }
    }
    let mut duv = vec![[0.0; 6]; nodes.len()];
    for j in 0..rows {
        for i in 0..columns {
            duv[at(i, j)] = slope(|k| du[at(i, k)], j, rows);
        }
    }

    // The Hermite basis at each of the grid's parameter values.
    let basis: Vec<Basis> = (0..=SUBDIVISIONS)
        .map(|k| Basis::at(k as f64 / SUBDIVISIONS as f64))
        .collect();
    let side = SUBDIVISIONS + 1;
    let mut vertices = Vec::with_capacity((columns - 1) * (rows - 1) * SUBDIVISIONS.pow(2) * 6);
    let mut grid = vec![
        Vertex {
            position: [0.0; 2],
            color: [0.0; 4]
        };
        side * side
    ];
    for j in 0..rows - 1 {
        for i in 0..columns - 1 {
            // The cell's corners in the order of the basis: (0, 0), (1, 0),
            // (0, 1), (1, 1).
            let corners = [at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1)];
            for (qy, bv) in basis.iter().enumerate() {
                for (qx, bu) in basis.iter().enumerate() {
                    let mut value = [0.0; 6];
                    for (c, &node) in corners.iter().enumerate() {
                        // Which end of the cell this corner is on, per axis.
                        let (a, b) = (c % 2, c / 2);
                        for (k, v) in value.iter_mut().enumerate() {
                            *v += bu.value[a] * bv.value[b] * nodes[node][k]
                                + bu.slope[a] * bv.value[b] * du[node][k]
                                + bu.value[a] * bv.slope[b] * dv[node][k]
                                + bu.slope[a] * bv.slope[b] * duv[node][k];
                        }
                    }
                    let p = matrix * Point::new(value[0], value[1]);
                    grid[qy * side + qx] = Vertex {
                        position: [p.x as f32, p.y as f32],
                        color: [value[2], value[3], value[4], value[5]]
                            .map(|c| c.clamp(0.0, 1.0) as f32),
                    };
                }
            }
            for qy in 0..SUBDIVISIONS {
                for qx in 0..SUBDIVISIONS {
                    let v00 = grid[qy * side + qx];
                    let v10 = grid[qy * side + qx + 1];
                    let v01 = grid[(qy + 1) * side + qx];
                    let v11 = grid[(qy + 1) * side + qx + 1];
                    vertices.extend([v00, v10, v01, v10, v11, v01]);
                }
            }
        }
    }
    vertices
}

/// The Catmull-Rom slope at index `i` of `n` values: half the difference of
/// the neighbours, or the difference to the one neighbour at an end.
fn slope(value: impl Fn(usize) -> Node, i: usize, n: usize) -> Node {
    let (before, after, scale) = match i {
        0 => (0, 1, 1.0),
        _ if i == n - 1 => (n - 2, n - 1, 1.0),
        _ => (i - 1, i + 1, 0.5),
    };
    let (before, after) = (value(before), value(after));
    std::array::from_fn(|k| (after[k] - before[k]) * scale)
}

/// The cubic Hermite basis along one axis of a cell at parameter `t`, by end
/// (0 or 1): what multiplies the value there and what multiplies the slope.
struct Basis {
    value: [f64; 2],
    slope: [f64; 2],
}

impl Basis {
    fn at(t: f64) -> Basis {
        let (t2, t3) = (t * t, t * t * t);
        Basis {
            value: [2.0 * t3 - 3.0 * t2 + 1.0, -2.0 * t3 + 3.0 * t2],
            slope: [t3 - 2.0 * t2 + t, t3 - t2],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUADS: usize = SUBDIVISIONS * SUBDIVISIONS;

    fn color(r: u8, g: u8, b: u8, a: u8) -> Color {
        Color { r, g, b, a }
    }

    /// A `columns` x `rows` mesh spanning `width` x `height`, regular.
    fn regular(columns: usize, rows: usize, width: f64, height: f64) -> Vec<[f64; 2]> {
        (0..rows)
            .flat_map(|j| {
                (0..columns).map(move |i| {
                    [
                        width * i as f64 / (columns - 1) as f64,
                        height * j as f64 / (rows - 1) as f64,
                    ]
                })
            })
            .collect()
    }

    /// The vertex that starts quad `(qx, qy)` of cell number `cell`.
    fn quad_corner(vertices: &[Vertex], cell: usize, qx: usize, qy: usize) -> Vertex {
        vertices[(cell * QUADS + qy * SUBDIVISIONS + qx) * 6]
    }

    fn near(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-4
    }

    #[test]
    fn a_mesh_has_two_triangles_for_each_of_sixteen_by_sixteen_quads_per_cell() {
        let colors = vec![color(0, 0, 0, 255); 12];
        let vertices = tessellate(4, 3, &regular(4, 3, 30.0, 20.0), &colors, Affine::IDENTITY);
        assert_eq!(vertices.len(), 3 * 2 * 16 * 16 * 6);
    }

    #[test]
    fn the_mesh_reaches_every_point_with_its_colour() {
        // A skewed 3 x 3 mesh with a different colour at each point.
        let points = [
            [5.0, 3.0],
            [40.0, 8.0],
            [90.0, 0.0],
            [0.0, 45.0],
            [50.0, 50.0],
            [95.0, 40.0],
            [8.0, 100.0],
            [45.0, 90.0],
            [100.0, 105.0],
        ];
        let colors: Vec<Color> = (0..9u8)
            .map(|k| color(k * 30, 255 - k * 20, k * 7, 128 + k * 10))
            .collect();
        let matrix = Affine::translate((7.0, 11.0)) * Affine::scale(2.0);
        let vertices = tessellate(3, 3, &points, &colors, matrix);
        for (n, (p, c)) in points.iter().zip(&colors).enumerate() {
            let want_position = matrix * Point::new(p[0], p[1]);
            let want_color = [c.r, c.g, c.b, c.a].map(|v| f32::from(v) / 255.0);
            let found = vertices.iter().any(|v| {
                near(v.position[0], want_position.x as f32)
                    && near(v.position[1], want_position.y as f32)
                    && v.color.iter().zip(want_color).all(|(a, b)| near(*a, b))
            });
            assert!(found, "point {n} {p:?} is not on the surface");
        }
    }

    #[test]
    fn each_cell_starts_and_ends_on_its_corner_points() {
        let points = regular(3, 3, 100.0, 100.0);
        let colors: Vec<Color> = (0..9u8).map(|k| color(k * 25, 0, 0, 255)).collect();
        let vertices = tessellate(3, 3, &points, &colors, Affine::IDENTITY);
        // Cell 3 is the lower right one: points (1, 1) to (2, 2).
        let first = quad_corner(&vertices, 3, 0, 0);
        assert_eq!(first.position, [50.0, 50.0]);
        assert!(near(first.color[0], 4.0 * 25.0 / 255.0));
        // The last triangle's last-but-one vertex is the cell's far corner.
        let last = vertices[vertices.len() - 2];
        assert_eq!(last.position, [100.0, 100.0]);
        assert!(near(last.color[0], 8.0 * 25.0 / 255.0));
    }

    #[test]
    fn a_regular_grid_of_one_colour_is_flat() {
        let colors = vec![color(200, 100, 50, 255); 12];
        let vertices = tessellate(4, 3, &regular(4, 3, 90.0, 60.0), &colors, Affine::IDENTITY);
        let want = [200.0 / 255.0, 100.0 / 255.0, 50.0 / 255.0, 1.0];
        assert!(
            vertices
                .iter()
                .all(|v| v.color.iter().zip(want).all(|(a, b)| near(*a, b)))
        );
        // The triangles tile the box exactly: no gaps and no overlap.
        let area: f64 = vertices
            .chunks(3)
            .map(|t| {
                let [a, b, c] = [t[0], t[1], t[2]].map(|v| v.position.map(f64::from));
                ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])).abs() / 2.0
            })
            .sum();
        assert!((area - 90.0 * 60.0).abs() < 1e-2, "area {area}");
        // And every vertex is inside it, on the regular grid of quads.
        assert!(vertices.iter().all(|v| {
            (0.0..=90.0).contains(&v.position[0]) && (0.0..=60.0).contains(&v.position[1])
        }));
        let quad = quad_corner(&vertices, 0, 5, 7);
        assert!(near(quad.position[0], 30.0 * 5.0 / 16.0));
        assert!(near(quad.position[1], 30.0 * 7.0 / 16.0));
    }

    #[test]
    fn an_uneven_row_gets_catmull_rom_slopes() {
        // One-sided slope 10 at the left end, (40 - 0) / 2 = 20 in the middle.
        let points = [
            [0.0, 0.0],
            [10.0, 0.0],
            [40.0, 0.0],
            [0.0, 10.0],
            [10.0, 10.0],
            [40.0, 10.0],
        ];
        let colors = vec![color(0, 0, 0, 255); 6];
        let vertices = tessellate(3, 2, &points, &colors, Affine::IDENTITY);
        // Half way along the first cell's top edge: 10 * 1/8 + 10 * 1/2 +
        // 20 * (-1/8) = 3.75.
        let mid = quad_corner(&vertices, 0, 8, 0);
        assert!(near(mid.position[0], 3.75), "{:?}", mid.position);
        assert!(near(mid.position[1], 0.0));
    }

    #[test]
    fn the_surface_is_continuous_across_cell_edges() {
        let points = [
            [0.0, 0.0],
            [30.0, 5.0],
            [100.0, -10.0],
            [-5.0, 40.0],
            [45.0, 55.0],
            [95.0, 35.0],
            [10.0, 90.0],
            [60.0, 100.0],
            [105.0, 80.0],
        ];
        let colors: Vec<Color> = (0..9u8)
            .map(|k| color(k * 30, 255 - k * 30, 0, 255))
            .collect();
        let vertices = tessellate(3, 3, &points, &colors, Affine::IDENTITY);
        // Where cell 0 ends (its right edge, qx = 16) and cell 1 begins
        // (qx = 0), at every quad row: the same point and colour.
        for qy in 0..SUBDIVISIONS {
            let right_of_first = vertices[(qy * SUBDIVISIONS + SUBDIVISIONS - 1) * 6 + 1];
            let left_of_second = quad_corner(&vertices, 1, 0, qy);
            for k in 0..2 {
                assert!(near(right_of_first.position[k], left_of_second.position[k]));
            }
            for k in 0..4 {
                assert!(near(right_of_first.color[k], left_of_second.color[k]));
            }
        }
    }

    #[test]
    fn colours_overshoot_is_clamped() {
        // 255, 0, 0, 255 along the row: Catmull-Rom dips below 0 between the
        // two zeros.
        let colors: Vec<Color> = [255, 0, 0, 255, 255, 0, 0, 255]
            .iter()
            .map(|&r| color(r, 0, 0, 255))
            .collect();
        let vertices = tessellate(4, 2, &regular(4, 2, 30.0, 10.0), &colors, Affine::IDENTITY);
        assert!(
            vertices
                .iter()
                .all(|v| v.color.iter().all(|c| (0.0..=1.0).contains(c)))
        );
        // The middle of the dip is clamped to 0.
        assert_eq!(quad_corner(&vertices, 1, 8, 0).color[0], 0.0);
    }

    #[test]
    fn the_matrix_moves_the_triangles() {
        let colors = vec![color(0, 0, 0, 255); 4];
        let points = regular(2, 2, 10.0, 10.0);
        let plain = tessellate(2, 2, &points, &colors, Affine::IDENTITY);
        let moved = tessellate(2, 2, &points, &colors, Affine::translate((3.0, 4.0)));
        for (a, b) in plain.iter().zip(&moved) {
            assert!(near(a.position[0] + 3.0, b.position[0]));
            assert!(near(a.position[1] + 4.0, b.position[1]));
        }
    }
}
