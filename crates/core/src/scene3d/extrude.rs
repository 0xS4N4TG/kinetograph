//! Extruded type and SVG paths: outlines turned into a prism.
//!
//! The outline's contours are flattened to polygons. The front and back caps
//! are the polygons' fill, triangulated by lyon (honouring the fill rule, so
//! holes stay holes); the walls are one quad per polygon edge. Walls are
//! smooth where neighbouring edges bend by less than `CREASE` (a curve) and
//! hard where they bend more (a corner). The prism is `depth` thick along z,
//! centred on z = 0, and the outline's y axis points up.

use glam::{Vec2, Vec3};
use kurbo::{BezPath, PathEl, Shape};
use lyon_tessellation::geom::point;
use lyon_tessellation::path::Path;
use lyon_tessellation::{
    BuffersBuilder, FillOptions, FillRule as LyonRule, FillTessellator, FillVertex, VertexBuffers,
};
use skrifa::instance::{LocationRef, NormalizedCoord, Size};
use skrifa::outline::{DrawSettings, OutlinePen};
use skrifa::{FontRef, GlyphId, MetadataProvider};

use super::mesh::{MeshData, Vertex3};
use super::{ExtrudeSpec, TextSpec};
use crate::error::{Error, Result};
use crate::scene::FillRule;
use crate::text::TextEngine;

/// Neighbouring wall edges that bend by less than this (the cosine of the
/// angle) share a normal.
const CREASE: f32 = 0.766; // 40 degrees

/// The em size the text is laid out at before it is scaled to the spec's.
const LAYOUT_SIZE: f32 = 100.0;

/// A polygon: the points in order, not repeating the first at the end.
type Contour = Vec<Vec2>;

/// The extruded mesh of `spec`'s text.
pub fn text(spec: &TextSpec, engine: &mut TextEngine) -> Result<MeshData> {
    let laid = engine.layout(
        &spec.text,
        &spec.font,
        LAYOUT_SIZE,
        spec.line_height.map(|l| l as f32),
        None,
        spec.align,
    );
    // The block of text is centred on the origin, however its lines are
    // aligned within it.
    let (centre_x, centre_y) = (laid.width / 2.0, laid.height / 2.0);
    let scale = spec.size as f32 / LAYOUT_SIZE;
    let mut mesh = Builder::default();
    for run in &laid.runs {
        let font = FontRef::from_index(run.font.data.as_ref(), run.font.index)
            .map_err(|e| Error::Render(format!("text3d: cannot read the font: {e}")))?;
        let coords: Vec<NormalizedCoord> = run
            .coords
            .iter()
            .map(|&c| NormalizedCoord::from_bits(c))
            .collect();
        let glyphs = font.outline_glyphs();
        for g in &run.glyphs {
            let Some(outline) = glyphs.get(GlyphId::new(g.id)) else {
                continue;
            };
            let mut pen = PathPen::default();
            outline
                .draw(
                    DrawSettings::unhinted(Size::new(run.font_size), LocationRef::new(&coords)),
                    &mut pen,
                )
                .map_err(|e| Error::Render(format!("text3d: cannot draw a glyph: {e}")))?;
            // Layout space has y down from the line box's top; glyph space
            // has y up from the baseline.
            let place = |p: Vec2| {
                Vec2::new(
                    (g.x + p.x - centre_x) * scale,
                    (g.y - p.y - centre_y) * -scale,
                )
            };
            let contours = flatten(&pen.path, 0.05)
                .into_iter()
                .map(|c| c.into_iter().map(place).collect())
                .collect::<Vec<Contour>>();
            let size = f32::max(laid.width, laid.height) * scale;
            mesh.prism(
                &contours,
                FillRule::NonZero,
                spec.depth as f32,
                size,
                spec.bevel.as_ref(),
            );
        }
    }
    Ok(mesh.finish())
}

/// The extruded mesh of `spec`'s path.
pub fn path(spec: &ExtrudeSpec) -> Result<MeshData> {
    let path = BezPath::from_svg(&spec.path)
        .map_err(|e| Error::Render(format!("extrude: not SVG path data: {e}")))?;
    let bounds = path.bounding_box();
    let longest = bounds.width().max(bounds.height());
    if !(longest.is_finite() && longest > 0.0) {
        return Err(Error::Render("extrude: the path has no extent".into()));
    }
    let scale = spec.size as f32 / longest as f32;
    let centre = Vec2::new(
        ((bounds.x0 + bounds.x1) / 2.0) as f32,
        ((bounds.y0 + bounds.y1) / 2.0) as f32,
    );
    let contours = flatten(&path, longest * 0.0005)
        .into_iter()
        .map(|c| {
            c.into_iter()
                .map(|p| Vec2::new(p.x - centre.x, centre.y - p.y) * scale)
                .collect()
        })
        .collect::<Vec<Contour>>();
    let mut mesh = Builder::default();
    mesh.prism(
        &contours,
        spec.fill_rule,
        spec.depth as f32,
        spec.size as f32,
        spec.bevel.as_ref(),
    );
    Ok(mesh.finish())
}

/// Collects a glyph's outline as a `BezPath`.
#[derive(Default)]
struct PathPen {
    path: BezPath,
}

impl OutlinePen for PathPen {
    fn move_to(&mut self, x: f32, y: f32) {
        self.path.move_to((f64::from(x), f64::from(y)));
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.path.line_to((f64::from(x), f64::from(y)));
    }
    fn quad_to(&mut self, cx: f32, cy: f32, x: f32, y: f32) {
        self.path
            .quad_to((f64::from(cx), f64::from(cy)), (f64::from(x), f64::from(y)));
    }
    fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
        self.path.curve_to(
            (f64::from(cx0), f64::from(cy0)),
            (f64::from(cx1), f64::from(cy1)),
            (f64::from(x), f64::from(y)),
        );
    }
    fn close(&mut self) {
        self.path.close_path();
    }
}

/// The path's subpaths as polygons, curves cut into lines that stay within
/// `tolerance` of them. Every subpath is closed, as a fill closes it.
fn flatten(path: &BezPath, tolerance: f64) -> Vec<Contour> {
    let mut contours = Vec::new();
    let mut current: Contour = Vec::new();
    kurbo::flatten(path.elements().iter().copied(), tolerance, |el| match el {
        PathEl::MoveTo(p) => {
            if current.len() >= 3 {
                contours.push(std::mem::take(&mut current));
            }
            current.clear();
            current.push(Vec2::new(p.x as f32, p.y as f32));
        }
        PathEl::LineTo(p) => current.push(Vec2::new(p.x as f32, p.y as f32)),
        PathEl::ClosePath => {
            if current.len() >= 3 {
                contours.push(std::mem::take(&mut current));
            }
            current.clear();
        }
        _ => unreachable!("flatten emits lines"),
    });
    if current.len() >= 3 {
        contours.push(current);
    }
    contours
}

#[derive(Default)]
struct Builder {
    vertices: Vec<Vertex3>,
    indices: Vec<u32>,
}

impl Builder {
    fn finish(self) -> MeshData {
        MeshData::new(self.vertices, self.indices)
    }

    /// Adds the prism of `contours` filled by `rule`, `depth` thick, with
    /// `bevel` round its edges. `size` scales the texture coordinates of the
    /// caps.
    fn prism(
        &mut self,
        contours: &[Contour],
        rule: FillRule,
        depth: f32,
        size: f32,
        bevel: Option<&Bevel>,
    ) {
        let contours: Vec<Contour> = contours.iter().filter_map(|c| clean(c)).collect();
        if contours.is_empty() {
            return;
        }
        // Whether each contour's inside is empty: it is inside an odd number
        // of the other contours (a hole, or an island's hole).
        let holes: Vec<bool> = contours
            .iter()
            .enumerate()
            .map(|(i, contour)| {
                contours
                    .iter()
                    .enumerate()
                    .filter(|(j, other)| *j != i && contains(other, contour[0]))
                    .count()
                    % 2
                    == 1
            })
            .collect();
        let half = depth / 2.0;
        let Some(bevel) = bevel else {
            self.caps(&contours, rule, half, size);
            for (contour, hole) in contours.iter().zip(&holes) {
                let normals = edge_normals(contour, *hole);
                self.band(
                    [contour, contour],
                    [-half, half],
                    &normals,
                    [1.0, 0.0],
                    [0.0, 1.0],
                );
            }
            return;
        };
        // The profile of the edge, from the cap to the wall: a quarter of an
        // ellipse `size` out and `thickness` down, cut into `segments`.
        let steps: Vec<(f32, f32)> = (0..=bevel.segments)
            .map(|k| {
                let angle = k as f32 / bevel.segments as f32 * std::f32::consts::FRAC_PI_2;
                (
                    bevel.offset + bevel.size * angle.sin(),
                    half + bevel.thickness * angle.cos(),
                )
            })
            .collect();
        let caps: Vec<Contour> = contours
            .iter()
            .zip(&holes)
            .map(|(c, hole)| grown(c, *hole, bevel.offset))
            .collect();
        self.caps(&caps, rule, half + bevel.thickness, size);
        for (contour, hole) in contours.iter().zip(&holes) {
            let normals = edge_normals(contour, *hole);
            let rings: Vec<Contour> = steps
                .iter()
                .map(|(out, _)| grown(contour, *hole, *out))
                .collect();
            let wall = &rings[rings.len() - 1];
            self.band(
                [wall, wall],
                [-half, half],
                &normals,
                [1.0, 0.0],
                [0.0, 1.0],
            );
            for k in 0..steps.len() - 1 {
                // From the wall's side of the band to the cap's.
                let (s0, z0) = steps[k + 1];
                let (s1, z1) = steps[k];
                // The band's normal across the profile: out and toward the cap.
                let tilt = Vec2::new(z1 - z0, s0 - s1).normalize_or(Vec2::X);
                let v = [0.0, 1.0];
                self.band(
                    [&rings[k + 1], &rings[k]],
                    [z0, z1],
                    &normals,
                    [tilt.x, tilt.y],
                    v,
                );
                self.band(
                    [&rings[k + 1], &rings[k]],
                    [-z0, -z1],
                    &normals,
                    [tilt.x, -tilt.y],
                    v,
                );
            }
        }
    }

    fn caps(&mut self, contours: &[Contour], rule: FillRule, half: f32, size: f32) {
        let mut builder = Path::builder();
        for contour in contours {
            builder.begin(point(contour[0].x, contour[0].y));
            for p in &contour[1..] {
                builder.line_to(point(p.x, p.y));
            }
            builder.end(true);
        }
        let path = builder.build();
        let mut buffers: VertexBuffers<Vec2, u32> = VertexBuffers::new();
        let options = FillOptions::default().with_fill_rule(match rule {
            FillRule::NonZero => LyonRule::NonZero,
            FillRule::EvenOdd => LyonRule::EvenOdd,
        });
        let tessellated = FillTessellator::new().tessellate_path(
            &path,
            &options,
            &mut BuffersBuilder::new(&mut buffers, |v: FillVertex| {
                let p = v.position();
                Vec2::new(p.x, p.y)
            }),
        );
        if tessellated.is_err() {
            return;
        }
        let uv = |p: Vec2| [p.x / size + 0.5, 0.5 - p.y / size];
        for (z, normal) in [(half, Vec3::Z), (-half, Vec3::NEG_Z)] {
            let base = self.vertices.len() as u32;
            for p in &buffers.vertices {
                self.vertices.push(Vertex3 {
                    position: [p.x, p.y, z],
                    normal: normal.to_array(),
                    uv: uv(*p),
                });
            }
            for t in buffers.indices.chunks(3) {
                let corner = |k: usize| buffers.vertices[t[k] as usize];
                let area = (corner(1) - corner(0)).perp_dot(corner(2) - corner(0));
                // Counter-clockwise seen from the side the cap faces: the
                // front as the points are, the back mirrored.
                let flip = (area < 0.0) == (z > 0.0);
                let order = if flip { [0, 2, 1] } else { [0, 1, 2] };
                self.indices.extend(order.map(|k| base + t[k]));
            }
        }
    }

    /// A band of quads between two rings of the same contour, `rings[0]` at
    /// `z[0]` and `rings[1]` at `z[1]`, whose `normals` are its edges' (see
    /// `edge_normals`). `tilt` is the band's normal across it: how much of it
    /// is the edge's outward normal and how much +z (a wall is `[1, 0]`);
    /// `v` is the texture coordinate at each ring.
    fn band(
        &mut self,
        rings: [&[Vec2]; 2],
        z: [f32; 2],
        normals: &[Vec2],
        tilt: [f32; 2],
        v: [f32; 2],
    ) {
        let n = normals.len();
        let at_vertex = |own: Vec2, other: Vec2| {
            if own.dot(other) > CREASE {
                (own + other).normalize_or_zero()
            } else {
                own
            }
        };
        let normal = |across: Vec2| {
            if tilt == [1.0, 0.0] {
                Vec3::new(across.x, across.y, 0.0)
            } else {
                Vec3::new(across.x * tilt[0], across.y * tilt[0], tilt[1]).normalize_or_zero()
            }
        };
        let [low, high] = rings;
        let mut length = 0.0;
        for i in 0..n {
            let j = (i + 1) % n;
            let edge = normals[i];
            let na = normal(at_vertex(edge, normals[(i + n - 1) % n]));
            let nb = normal(at_vertex(edge, normals[j]));
            let span = (low[j] - low[i]).length();
            let base = self.vertices.len() as u32;
            let corners = [
                (low[i], z[0], na, length, v[0]),
                (low[j], z[0], nb, length + span, v[0]),
                (high[j], z[1], nb, length + span, v[1]),
                (high[i], z[1], na, length, v[1]),
            ];
            for (p, z, normal, u, v) in corners {
                self.vertices.push(Vertex3 {
                    position: [p.x, p.y, z],
                    normal: normal.to_array(),
                    uv: [u, v],
                });
            }
            // Counter-clockwise seen from outside: the order a-low, b-low,
            // b-high turns towards the edge's outward normal when the
            // polygon runs the way the material is on its left.
            let (p, q, r) = (
                Vec3::new(low[i].x, low[i].y, z[0]),
                Vec3::new(low[j].x, low[j].y, z[0]),
                Vec3::new(high[j].x, high[j].y, z[1]),
            );
            let facing = (q - p).cross(r - p).dot(normal(edge));
            if facing >= 0.0 {
                self.indices
                    .extend([base, base + 1, base + 2, base, base + 2, base + 3]);
            } else {
                self.indices
                    .extend([base, base + 2, base + 1, base, base + 3, base + 2]);
            }
            length += span;
        }
    }
}

/// How a prism's edges are rounded: as three.js's `ExtrudeGeometry` does,
/// the caps stand `thickness` beyond the walls on each side and the walls
/// `size` beyond the outline (`offset` moves both); the edge between them is
/// a quarter of an ellipse cut into `segments` flat bands.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bevel {
    pub thickness: f32,
    pub size: f32,
    pub offset: f32,
    pub segments: u32,
}

/// The normal of each edge `i -> i + 1` of `contour`, facing away from the
/// material; `hole` says the material is outside the polygon.
fn edge_normals(contour: &[Vec2], hole: bool) -> Vec<Vec2> {
    let n = contour.len();
    let ccw = area(contour) > 0.0;
    (0..n)
        .map(|i| {
            let d = (contour[(i + 1) % n] - contour[i]).normalize_or_zero();
            // The right-hand side is outside a counter-clockwise polygon.
            let outward = if ccw {
                Vec2::new(d.y, -d.x)
            } else {
                Vec2::new(-d.y, d.x)
            };
            if hole { -outward } else { outward }
        })
        .collect()
}

/// A sharp corner's point moves at most this many times the distance when a
/// contour grows (as SVG's default `miter-limit`), so it does not spike.
const MITER_LIMIT: f32 = 4.0;

/// `contour` grown by `by` away from its material (shrunk when `by` is
/// negative): each edge moves `by` along its normal, and each point to where
/// its two edges meet, so the edges keep their directions.
fn grown(contour: &[Vec2], hole: bool, by: f32) -> Contour {
    if by == 0.0 {
        return contour.to_vec();
    }
    let normals = edge_normals(contour, hole);
    let n = contour.len();
    (0..n)
        .map(|i| {
            let (before, after) = (normals[(i + n - 1) % n], normals[i]);
            let mid = (before + after).normalize_or(after);
            // The miter: the distance along `mid` that moves both edges by `by`.
            let reach = (1.0 / mid.dot(after).max(1.0 / MITER_LIMIT)).min(MITER_LIMIT);
            contour[i] + mid * by * reach
        })
        .collect()
}

/// `contour` without repeated points (and its closing point); `None` if
/// fewer than three are left or it encloses nothing.
fn clean(contour: &[Vec2]) -> Option<Contour> {
    let mut out: Contour = Vec::with_capacity(contour.len());
    for &p in contour {
        if out.last().is_none_or(|q| q.distance_squared(p) > 1e-12) {
            out.push(p);
        }
    }
    while out.len() > 1 && out[0].distance_squared(out[out.len() - 1]) <= 1e-12 {
        out.pop();
    }
    (out.len() >= 3 && area(&out).abs() > 1e-10).then_some(out)
}

/// The signed area: positive when the points run counter-clockwise (y up).
fn area(contour: &[Vec2]) -> f32 {
    let n = contour.len();
    (0..n)
        .map(|i| contour[i].perp_dot(contour[(i + 1) % n]))
        .sum::<f32>()
        / 2.0
}

/// Whether `p` is inside the polygon, by the even-odd rule.
fn contains(polygon: &[Vec2], p: Vec2) -> bool {
    let n = polygon.len();
    let mut inside = false;
    for i in 0..n {
        let (a, b) = (polygon[i], polygon[(i + 1) % n]);
        if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
            inside = !inside;
        }
    }
    inside
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(path: &str, rule: FillRule) -> ExtrudeSpec {
        ExtrudeSpec {
            path: path.into(),
            size: 2.0,
            depth: 1.0,
            fill_rule: rule,
            bevel: None,
        }
    }

    /// Every triangle faces the way its vertices' normals say.
    fn assert_wound_outwards(mesh: &MeshData) {
        for t in mesh.indices.chunks(3) {
            let v = |i: u32| Vec3::from(mesh.vertices[i as usize].position);
            let n = (v(t[1]) - v(t[0])).cross(v(t[2]) - v(t[0]));
            let want: Vec3 = t
                .iter()
                .map(|&i| Vec3::from(mesh.vertices[i as usize].normal))
                .sum();
            assert!(n.dot(want) > 0.0, "triangle {t:?} faces the wrong way");
        }
    }

    #[test]
    fn a_square_is_a_box() {
        let mesh = path(&spec("M0 0H10V10H0Z", FillRule::NonZero)).unwrap();
        let (lo, hi) = mesh.bounds().unwrap();
        assert!((lo - Vec3::new(-1.0, -1.0, -0.5)).length() < 1e-5, "{lo:?}");
        assert!((hi - Vec3::new(1.0, 1.0, 0.5)).length() < 1e-5, "{hi:?}");
        // Two caps of two triangles, four walls of two.
        assert_eq!(mesh.indices.len() / 3, 4 + 8);
        assert_wound_outwards(&mesh);
    }

    #[test]
    fn the_path_is_upright_and_centred() {
        // An arrow tip at the top of the SVG box (y = 0) ends up at +y.
        let mesh = path(&spec("M5 0L10 10H0Z", FillRule::NonZero)).unwrap();
        let top = mesh
            .vertices
            .iter()
            .max_by(|a, b| a.position[1].total_cmp(&b.position[1]))
            .unwrap();
        assert!(top.position[0].abs() < 1e-5, "the tip is over the middle");
        assert!((top.position[1] - 1.0).abs() < 1e-5);
    }

    #[test]
    fn holes_stay_holes_and_face_inwards() {
        // A square ring: outer 0..10, inner 3..7 in the opposite direction.
        let ring = "M0 0H10V10H0Z M3 3V7H7V3Z";
        let mesh = path(&spec(ring, FillRule::NonZero)).unwrap();
        assert_wound_outwards(&mesh);
        // No cap triangle covers the hole's middle (the origin).
        let covers = |z: f32| {
            mesh.indices.chunks(3).any(|t| {
                let p = |i: u32| mesh.vertices[i as usize].position;
                t.iter().all(|&i| (p(i)[2] - z).abs() < 1e-6)
                    && contains(
                        &t.iter()
                            .map(|&i| Vec2::new(p(i)[0], p(i)[1]))
                            .collect::<Vec<_>>(),
                        Vec2::ZERO,
                    )
            })
        };
        assert!(!covers(0.5) && !covers(-0.5));
        // 4 outer walls + 4 inner ones, and caps of 8 triangles each.
        assert_eq!(mesh.indices.len() / 3, 32);
    }

    #[test]
    fn even_odd_cuts_a_hole_out_of_same_direction_contours() {
        let same = "M0 0H10V10H0Z M3 3H7V7H3Z";
        let nonzero = path(&spec(same, FillRule::NonZero)).unwrap();
        let evenodd = path(&spec(same, FillRule::EvenOdd)).unwrap();
        // The area of the front cap, in world units (the 10 unit path is 2).
        let front_area = |m: &MeshData| -> f32 {
            m.indices
                .chunks(3)
                .filter(|t| t.iter().all(|&i| mesh_z(m, i) > 0.0))
                .map(|t| {
                    let p = |k: usize| {
                        let v = m.vertices[t[k] as usize].position;
                        Vec2::new(v[0], v[1])
                    };
                    (p(1) - p(0)).perp_dot(p(2) - p(0)).abs() / 2.0
                })
                .sum()
        };
        // Filled solid: the inner square is just inside the outer one.
        assert!((front_area(&nonzero) - 4.0).abs() < 1e-4);
        // With a hole: 100 - 16 path units squared, times 0.2 squared.
        assert!((front_area(&evenodd) - 3.36).abs() < 1e-4);
        assert_wound_outwards(&evenodd);
    }

    fn mesh_z(m: &MeshData, i: u32) -> f32 {
        m.vertices[i as usize].position[2]
    }

    #[test]
    fn curves_get_smooth_walls_and_corners_hard_ones() {
        // A circle (four cubic arcs): wall normals are radial.
        let k = 0.5523;
        let circle = format!(
            "M10 0 C10 {a} {a} 10 0 10 C-{a} 10 -10 {a} -10 0 C-10 -{a} -{a} -10 0 -10 C{a} -10 10 -{a} 10 0Z",
            a = 10.0 * k
        );
        let mesh = path(&spec(&circle, FillRule::NonZero)).unwrap();
        assert_wound_outwards(&mesh);
        for v in mesh.vertices.iter().filter(|v| v.normal[2] == 0.0) {
            let radial = Vec2::new(v.position[0], v.position[1]).normalize();
            let n = Vec2::new(v.normal[0], v.normal[1]);
            assert!(radial.dot(n) > 0.99, "{:?} vs {:?}", v.position, v.normal);
        }
        // A square keeps its corners sharp: every wall normal is an axis.
        let mesh = path(&spec("M0 0H10V10H0Z", FillRule::NonZero)).unwrap();
        for v in mesh.vertices.iter().filter(|v| v.normal[2] == 0.0) {
            assert!(v.normal[0].abs() == 1.0 || v.normal[1].abs() == 1.0);
        }
    }

    fn engine() -> TextEngine {
        let fonts = std::collections::BTreeMap::from([(
            "DM Sans".to_string(),
            "assets/fonts/DMSans-Medium.ttf".to_string(),
        )]);
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        TextEngine::new(&fonts, &root).unwrap()
    }

    fn text_spec(text: &str, align: crate::scene::TextAlign) -> TextSpec {
        TextSpec {
            text: text.into(),
            font: "DM Sans".into(),
            size: 1.0,
            depth: 0.2,
            align,
            line_height: None,
            bevel: None,
        }
    }

    #[test]
    fn text_is_a_prism_per_glyph_centred_on_the_origin() {
        use crate::scene::TextAlign;
        let mut engine = engine();
        let mesh = text(&text_spec("HO", TextAlign::Center), &mut engine).unwrap();
        assert_wound_outwards(&mesh);
        let (lo, hi) = mesh.bounds().unwrap();
        assert!((lo.z + 0.1).abs() < 1e-5 && (hi.z - 0.1).abs() < 1e-5);
        // Centred on the line box, so the middle of the letters is near 0.
        assert!(((lo.x + hi.x) / 2.0).abs() < 0.1, "{lo:?} {hi:?}");
        assert!(((lo.y + hi.y) / 2.0).abs() < 0.2, "{lo:?} {hi:?}");
        // Cap height is a bit under 0.75 em; letters stand up (+y).
        assert!(hi.y > 0.0 && lo.y < 0.0 && (hi.y - lo.y) > 0.5 && (hi.y - lo.y) < 0.9);
        // The O has a hole, so more triangles than a letter without one.
        let h = text(&text_spec("H", TextAlign::Center), &mut engine).unwrap();
        let o = text(&text_spec("O", TextAlign::Center), &mut engine).unwrap();
        assert!(h.indices.len() + o.indices.len() == mesh.indices.len());
        // The hole's wall faces inwards: the O has normals pointing at its
        // middle as well as away from it.
        let (olo, ohi) = o.bounds().unwrap();
        let middle = glam::Vec2::new((olo.x + ohi.x) / 2.0, (olo.y + ohi.y) / 2.0);
        let facing = |inwards: bool| {
            o.vertices.iter().any(|v| {
                let to_middle = middle - glam::Vec2::new(v.position[0], v.position[1]);
                v.normal[2] == 0.0
                    && (to_middle.dot(glam::Vec2::new(v.normal[0], v.normal[1])) > 0.0) == inwards
            })
        };
        assert!(facing(true) && facing(false));
    }

    #[test]
    fn text_scales_with_size_and_is_the_same_each_time() {
        use crate::scene::TextAlign;
        let mut engine = engine();
        let one = text(&text_spec("Rg", TextAlign::Left), &mut engine).unwrap();
        let mut big = text_spec("Rg", TextAlign::Left);
        big.size = 2.0;
        let two = text(&big, &mut engine).unwrap();
        assert_eq!(one.vertices.len(), two.vertices.len());
        for (a, b) in one.vertices.iter().zip(&two.vertices) {
            assert!((a.position[0] * 2.0 - b.position[0]).abs() < 1e-4);
            assert!((a.position[1] * 2.0 - b.position[1]).abs() < 1e-4);
        }
        let again = text(&text_spec("Rg", TextAlign::Left), &mut engine).unwrap();
        assert_eq!(one.vertices, again.vertices);
        assert_eq!(one.indices, again.indices);
    }

    #[test]
    fn a_space_is_an_empty_mesh() {
        use crate::scene::TextAlign;
        let mesh = text(&text_spec(" ", TextAlign::Center), &mut engine()).unwrap();
        assert!(mesh.vertices.is_empty());
    }

    #[test]
    fn a_path_with_no_extent_is_an_error() {
        assert!(path(&spec("M5 5L5 5", FillRule::NonZero)).is_err());
    }

    fn bevelled(path_data: &str, bevel: Bevel) -> MeshData {
        let mut s = spec(path_data, FillRule::NonZero);
        s.bevel = Some(bevel);
        path(&s).unwrap()
    }

    const BEVEL: Bevel = Bevel {
        thickness: 0.2,
        size: 0.1,
        offset: 0.0,
        segments: 3,
    };

    #[test]
    fn a_bevel_adds_its_thickness_to_the_caps_and_its_size_to_the_walls() {
        // The 2 x 2 x 1 box of `a_square_is_a_box`, bevelled as three.js's
        // ExtrudeGeometry is: 0.2 more each side in z, 0.1 out at the walls.
        let mesh = bevelled("M0 0H10V10H0Z", BEVEL);
        let (lo, hi) = mesh.bounds().unwrap();
        assert!((lo - Vec3::new(-1.1, -1.1, -0.7)).length() < 1e-5, "{lo:?}");
        assert!((hi - Vec3::new(1.1, 1.1, 0.7)).length() < 1e-5, "{hi:?}");
        assert_wound_outwards(&mesh);
        // The caps are the outline as it is, at the full depth.
        let front: Vec<_> = mesh
            .vertices
            .iter()
            .filter(|v| v.normal == [0.0, 0.0, 1.0])
            .collect();
        assert!(!front.is_empty());
        for v in &front {
            assert!((v.position[2] - 0.7).abs() < 1e-6);
            assert!(v.position[0].abs() <= 1.0 + 1e-5 && v.position[1].abs() <= 1.0 + 1e-5);
        }
        // Caps of 2, walls of 4 x 2, and 3 bands of 4 x 2 on each side.
        assert_eq!(mesh.indices.len() / 3, 4 + 8 + 2 * 3 * 8);
        // The walls stand 0.1 out, between z = -0.5 and 0.5.
        for v in mesh.vertices.iter().filter(|v| v.normal[2] == 0.0) {
            assert!(v.position[2].abs() <= 0.5 + 1e-6, "{v:?}");
            let out = v.position[0].abs().max(v.position[1].abs());
            assert!((out - 1.1).abs() < 1e-5, "{v:?}");
        }
    }

    #[test]
    fn a_bevels_bands_turn_from_the_cap_to_the_wall() {
        let mesh = bevelled("M0 0H10V10H0Z", BEVEL);
        // The bands' normals lean between +z and the wall's: the one nearest
        // the front cap leans most toward +z.
        let leaning: Vec<f32> = mesh
            .vertices
            .iter()
            .filter(|v| v.normal[2] > 0.0 && v.normal[2] < 1.0)
            .map(|v| v.normal[2])
            .collect();
        assert!(!leaning.is_empty());
        assert!(leaning.iter().any(|z| *z > 0.8) && leaning.iter().any(|z| *z < 0.5));
        for v in &mesh.vertices {
            assert!((Vec3::from(v.normal).length() - 1.0).abs() < 1e-5, "{v:?}");
        }
    }

    #[test]
    fn a_bevel_offset_moves_the_caps_and_holes_shrink() {
        let ring = "M0 0H10V10H0Z M3 3V7H7V3Z";
        let mesh = bevelled(
            ring,
            Bevel {
                offset: 0.05,
                ..BEVEL
            },
        );
        assert_wound_outwards(&mesh);
        let (lo, hi) = mesh.bounds().unwrap();
        // 1 + 0.05 + 0.1 out, the outline being 2 across.
        assert!((hi.x - 1.15).abs() < 1e-5 && (lo.x + 1.15).abs() < 1e-5);
        // The hole (0.4 a side from the middle) closes in as the material grows:
        // its wall is 0.4 - 0.15 from the middle.
        let inner = mesh
            .vertices
            .iter()
            .filter(|v| v.normal[2] == 0.0)
            .map(|v| v.position[0].abs().max(v.position[1].abs()))
            .fold(f32::MAX, f32::min);
        assert!((inner - 0.25).abs() < 1e-5, "{inner}");
    }

    #[test]
    fn a_sharp_corner_grows_no_further_than_the_miter_limit() {
        // A thin spike: its tip moves at most 4 times the distance.
        let contour = vec![
            Vec2::new(0.0, 0.0),
            Vec2::new(10.0, 0.5),
            Vec2::new(0.0, 1.0),
        ];
        let tip = grown(&contour, false, 0.1);
        assert!((tip[1] - contour[1]).length() <= 0.4 + 1e-5);
        // A right angle moves its corner the diagonal of the distance.
        let square = vec![Vec2::ZERO, Vec2::X, Vec2::ONE, Vec2::Y];
        let out = grown(&square, false, 0.1);
        assert!((out[0] - Vec2::splat(-0.1)).length() < 1e-6, "{:?}", out[0]);
    }

    #[test]
    fn bevelled_text_is_wound_outwards_and_bigger() {
        use crate::scene::TextAlign;
        let mut engine = engine();
        // Letters with no concave curve tighter than the bevel: where one is,
        // the grown outline folds over itself, as it does in three.js.
        let plain = text(&text_spec("OD", TextAlign::Center), &mut engine).unwrap();
        let mut spec = text_spec("OD", TextAlign::Center);
        spec.bevel = Some(Bevel {
            thickness: 0.02,
            size: 0.01,
            offset: 0.0,
            segments: 2,
        });
        let mesh = text(&spec, &mut engine).unwrap();
        assert_wound_outwards(&mesh);
        let ((lo, hi), (plo, phi)) = (mesh.bounds().unwrap(), plain.bounds().unwrap());
        assert!((hi.z - 0.12).abs() < 1e-5 && (lo.z + 0.12).abs() < 1e-5);
        assert!((hi.x - phi.x - 0.01).abs() < 2e-3 && (plo.x - lo.x - 0.01).abs() < 2e-3);
    }
}
