//! The Rive runtime's renderer, as the commands of a `canvas` layer.
//!
//! Rive's C++ runtime animates an artboard and calls back with what to draw:
//! paths, paints, clips and pictures. `Recorder` answers those calls by writing
//! the matching canvas commands (docs/SCENE.md, "canvas"), so the Vello pass
//! that draws a canvas draws the artboard, and a Rive file needs no layer type
//! of its own. Nothing here keeps anything between frames but the pictures
//! decoded from the file, so a frame is a pure function of the file and the
//! time.

use std::fmt::Write as _;
use std::fs;
use std::path::{Path as FsPath, PathBuf};

use rive_rs::path::{Commands, FillRule, Verb};
use rive_rs::renderer::{
    self, BlendMode, BufferFlags, BufferType, Color, PaintStyle, StrokeCap, StrokeJoin,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// `[a, b, c, d, e, f]`: Rive's `Mat2D` and the canvas's `setTransform` order
/// their six numbers the same way.
type Matrix = [f32; 6];

const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `outer` applied after `inner`.
fn multiply(outer: &Matrix, inner: &Matrix) -> Matrix {
    let [a1, b1, c1, d1, e1, f1] = *outer;
    let [a2, b2, c2, d2, e2, f2] = *inner;
    [
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * e2 + c1 * f2 + e1,
        b1 * e2 + d1 * f2 + f1,
    ]
}

fn apply(m: &Matrix, x: f32, y: f32) -> (f32, f32) {
    (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}

#[derive(Clone, Copy, Debug)]
enum Segment {
    Move(f32, f32),
    Line(f32, f32),
    Cubic([f32; 6]),
    Close,
}

/// A Rive path: move, line, cubic and close, and how it is filled.
#[derive(Debug)]
pub struct Path {
    segments: Vec<Segment>,
    rule: FillRule,
}

impl Default for Path {
    fn default() -> Path {
        Path {
            segments: Vec::new(),
            rule: FillRule::NonZero,
        }
    }
}

impl Path {
    /// SVG path data for the commands.
    fn data(&self) -> String {
        let mut out = String::new();
        for segment in &self.segments {
            // Writing to a String does not fail.
            let _ = match *segment {
                Segment::Move(x, y) => write!(out, "M{x} {y}"),
                Segment::Line(x, y) => write!(out, "L{x} {y}"),
                Segment::Cubic([a, b, c, d, e, f]) => write!(out, "C{a} {b} {c} {d} {e} {f}"),
                Segment::Close => write!(out, "Z"),
            };
        }
        out
    }

    fn rule(&self) -> &'static str {
        match self.rule {
            FillRule::NonZero => "nonzero",
            FillRule::EvenOdd => "evenodd",
        }
    }
}

impl renderer::Path for Path {
    fn new(commands: &mut Commands, fill_rule: FillRule) -> Path {
        let mut path = Path {
            segments: Vec::new(),
            rule: fill_rule,
        };
        for (verb, points) in commands {
            path.segments.push(match verb {
                Verb::Move => Segment::Move(points[0].x, points[0].y),
                Verb::Line => Segment::Line(points[0].x, points[0].y),
                Verb::Cubic => Segment::Cubic([
                    points[0].x,
                    points[0].y,
                    points[1].x,
                    points[1].y,
                    points[2].x,
                    points[2].y,
                ]),
                Verb::Close => Segment::Close,
            });
        }
        path
    }

    fn reset(&mut self) {
        self.segments.clear();
    }

    fn extend(&mut self, from: &Path, transform: &[f32; 6]) {
        for segment in &from.segments {
            self.segments.push(match *segment {
                Segment::Move(x, y) => {
                    let (x, y) = apply(transform, x, y);
                    Segment::Move(x, y)
                }
                Segment::Line(x, y) => {
                    let (x, y) = apply(transform, x, y);
                    Segment::Line(x, y)
                }
                Segment::Cubic([a, b, c, d, e, f]) => {
                    let (a, b) = apply(transform, a, b);
                    let (c, d) = apply(transform, c, d);
                    let (e, f) = apply(transform, e, f);
                    Segment::Cubic([a, b, c, d, e, f])
                }
                Segment::Close => Segment::Close,
            });
        }
    }

    fn set_fill_rule(&mut self, fill_rule: FillRule) {
        self.rule = fill_rule;
    }

    fn move_to(&mut self, x: f32, y: f32) {
        self.segments.push(Segment::Move(x, y));
    }

    fn line_to(&mut self, x: f32, y: f32) {
        self.segments.push(Segment::Line(x, y));
    }

    fn cubic_to(&mut self, ox: f32, oy: f32, ix: f32, iy: f32, x: f32, y: f32) {
        self.segments.push(Segment::Cubic([ox, oy, ix, iy, x, y]));
    }

    fn close(&mut self) {
        self.segments.push(Segment::Close);
    }
}

fn css(color: Color) -> String {
    format!(
        "#{:02x}{:02x}{:02x}{:02x}",
        color.r, color.g, color.b, color.a
    )
}

fn stops(colors: &[Color], offsets: &[f32]) -> Value {
    Value::Array(
        colors
            .iter()
            .zip(offsets)
            .map(|(color, offset)| json!([offset, css(*color)]))
            .collect(),
    )
}

/// A gradient as the canvas's paint object.
#[derive(Debug)]
pub struct Gradient {
    paint: Value,
}

impl renderer::Gradient for Gradient {
    fn new_linear(
        sx: f32,
        sy: f32,
        ex: f32,
        ey: f32,
        colors: &[Color],
        offsets: &[f32],
    ) -> Gradient {
        Gradient {
            paint: json!({ "type": "linear", "x0": sx, "y0": sy, "x1": ex, "y1": ey, "stops": stops(colors, offsets) }),
        }
    }

    fn new_radial(cx: f32, cy: f32, radius: f32, colors: &[Color], offsets: &[f32]) -> Gradient {
        Gradient {
            paint: json!({
                "type": "radial", "x0": cx, "y0": cy, "r0": 0, "x1": cx, "y1": cy, "r1": radius,
                "stops": stops(colors, offsets),
            }),
        }
    }
}

#[derive(Debug)]
pub struct Paint {
    style: PaintStyle,
    /// The colour, or the gradient set after it: whichever was set last.
    source: Value,
    thickness: f32,
    join: StrokeJoin,
    cap: StrokeCap,
    blend: BlendMode,
}

impl Default for Paint {
    fn default() -> Paint {
        Paint {
            style: PaintStyle::Fill,
            source: json!({ "type": "color", "color": "#000000ff" }),
            thickness: 1.0,
            join: StrokeJoin::Miter,
            cap: StrokeCap::Butt,
            blend: BlendMode::SrcOver,
        }
    }
}

impl renderer::Paint for Paint {
    type Gradient = Gradient;

    fn set_style(&mut self, style: PaintStyle) {
        self.style = style;
    }

    fn set_color(&mut self, color: Color) {
        self.source = json!({ "type": "color", "color": css(color) });
    }

    fn set_thickness(&mut self, thickness: f32) {
        self.thickness = thickness;
    }

    fn set_join(&mut self, join: StrokeJoin) {
        self.join = join;
    }

    fn set_cap(&mut self, cap: StrokeCap) {
        self.cap = cap;
    }

    fn set_blend_mode(&mut self, blend_mode: BlendMode) {
        self.blend = blend_mode;
    }

    fn set_gradient(&mut self, gradient: &Gradient) {
        self.source = gradient.paint.clone();
    }

    fn invalidate_stroke(&mut self) {}
}

fn blend_name(mode: BlendMode) -> &'static str {
    match mode {
        BlendMode::SrcOver => "source-over",
        BlendMode::Screen => "screen",
        BlendMode::Overlay => "overlay",
        BlendMode::Darken => "darken",
        BlendMode::Lighten => "lighten",
        BlendMode::ColorDodge => "color-dodge",
        BlendMode::ColorBurn => "color-burn",
        BlendMode::HardLight => "hard-light",
        BlendMode::SoftLight => "soft-light",
        BlendMode::Difference => "difference",
        BlendMode::Exclusion => "exclusion",
        BlendMode::Multiply => "multiply",
        BlendMode::Hue => "hue",
        BlendMode::Saturation => "saturation",
        BlendMode::Color => "color",
        BlendMode::Luminosity => "luminosity",
    }
}

/// A picture of the file, decoded once when the file is read.
#[derive(Debug)]
pub struct Image {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

impl renderer::Image for Image {
    fn decode(data: &[u8]) -> Option<Image> {
        let decoded = image::load_from_memory(data).ok()?.to_rgba8();
        Some(Image {
            width: decoded.width(),
            height: decoded.height(),
            rgba: decoded.into_raw(),
        })
    }
}

impl Image {
    /// A PNG of the picture in `dir`, named by its pixels: a canvas names its
    /// pictures by file, so a picture drawn many times (the triangles of a
    /// mesh) is one file and not one copy in every command.
    fn file(&self, dir: &FsPath) -> Result<PathBuf, String> {
        let mut hash = Sha256::new();
        hash.update(self.width.to_le_bytes());
        hash.update(self.height.to_le_bytes());
        hash.update(&self.rgba);
        let name: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        let path = dir.join(format!("{name}.png"));
        if !path.exists() {
            fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            let mut png = Vec::new();
            image::write_buffer_with_format(
                &mut std::io::Cursor::new(&mut png),
                &self.rgba,
                self.width,
                self.height,
                image::ColorType::Rgba8,
                image::ImageFormat::Png,
            )
            .map_err(|e| e.to_string())?;
            // Written under a name of its own and renamed, so a reader never
            // sees half a file and concurrent writers agree.
            let temporary = dir.join(format!("{name}.{}.tmp", std::process::id()));
            fs::write(&temporary, png).map_err(|e| format!("{}: {e}", temporary.display()))?;
            fs::rename(&temporary, &path).map_err(|e| format!("{}: {e}", path.display()))?;
        }
        Ok(path)
    }
}

#[derive(Debug)]
pub struct Buffer {
    bytes: Vec<u8>,
}

impl Buffer {
    fn f32_pairs(&self) -> Vec<[f32; 2]> {
        self.bytes
            .as_chunks::<8>()
            .0
            .iter()
            .map(|c| {
                [
                    f32::from_ne_bytes([c[0], c[1], c[2], c[3]]),
                    f32::from_ne_bytes([c[4], c[5], c[6], c[7]]),
                ]
            })
            .collect()
    }

    fn u16s(&self) -> Vec<u16> {
        self.bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_ne_bytes([c[0], c[1]]))
            .collect()
    }
}

impl renderer::Buffer for Buffer {
    fn new(_type: BufferType, _flags: BufferFlags, len_in_bytes: usize) -> Buffer {
        Buffer {
            bytes: vec![0; len_in_bytes],
        }
    }

    fn map(&mut self) -> &mut [u8] {
        &mut self.bytes
    }

    fn unmap(&mut self) {}
}

/// How much a mesh triangle grows about its centre so that neighbours overlap:
/// two anti-aliased edges that meet leave a seam of background otherwise.
const MESH_OVERLAP: f32 = 1.03;

/// The canvas commands of one frame.
pub struct Recorder {
    pub(crate) commands: Vec<Value>,
    matrix: Matrix,
    /// The matrix and the number of open clips of each `state_push`.
    saved: Vec<(Matrix, usize)>,
    clips: usize,
    /// Where pictures are written for the commands to name.
    pictures: PathBuf,
    /// The first picture that could not be written; the frame is not drawn.
    pub(crate) failure: Option<String>,
}

impl Recorder {
    pub(crate) fn new(pictures: PathBuf) -> Recorder {
        Recorder {
            commands: Vec::new(),
            matrix: IDENTITY,
            saved: Vec::new(),
            clips: 0,
            pictures,
            failure: None,
        }
    }

    fn picture(&mut self, image: &Image) -> Option<String> {
        match image.file(&self.pictures) {
            Ok(path) => Some(path.to_string_lossy().into_owned()),
            Err(error) => {
                self.failure.get_or_insert(error);
                None
            }
        }
    }
}

impl renderer::Renderer for Recorder {
    type Buffer = Buffer;
    type Path = Path;
    type Paint = Paint;
    type Gradient = Gradient;
    type Image = Image;

    fn state_push(&mut self) {
        self.saved.push((self.matrix, self.clips));
        self.clips = 0;
    }

    fn state_pop(&mut self) {
        for _ in 0..self.clips {
            self.commands.push(json!({ "op": "unclip" }));
        }
        if let Some((matrix, clips)) = self.saved.pop() {
            self.matrix = matrix;
            self.clips = clips;
        }
    }

    fn transform(&mut self, transform: &[f32; 6]) {
        self.matrix = multiply(&self.matrix, transform);
    }

    fn set_clip(&mut self, path: &Path) {
        self.commands.push(json!({
            "op": "clip", "path": path.data(), "rule": path.rule(), "m": self.matrix,
        }));
        self.clips += 1;
    }

    fn draw_path(&mut self, path: &Path, paint: &Paint) {
        let mut command = match paint.style {
            PaintStyle::Fill => json!({ "op": "fill", "path": path.data(), "rule": path.rule() }),
            PaintStyle::Stroke => json!({
                "op": "stroke", "path": path.data(), "width": paint.thickness,
                "cap": match paint.cap {
                    StrokeCap::Butt => "butt",
                    StrokeCap::Round => "round",
                    StrokeCap::Square => "square",
                },
                "join": match paint.join {
                    StrokeJoin::Miter => "miter",
                    StrokeJoin::Round => "round",
                    StrokeJoin::Bevel => "bevel",
                },
            }),
        };
        command["paint"] = paint.source.clone();
        command["m"] = json!(self.matrix);
        if paint.blend != BlendMode::SrcOver {
            command["blend"] = json!(blend_name(paint.blend));
        }
        self.commands.push(command);
    }

    fn draw_image(&mut self, image: &Image, blend_mode: BlendMode, opacity: f32) {
        let Some(src) = self.picture(image) else {
            return;
        };
        self.commands.push(json!({
            "op": "image", "source": { "kind": "src", "src": src },
            "dx": 0, "dy": 0, "dw": image.width, "dh": image.height,
            "m": self.matrix, "a": opacity, "blend": blend_name(blend_mode),
        }));
    }

    fn draw_image_mesh(
        &mut self,
        image: &Image,
        vertices: &Buffer,
        uvs: &Buffer,
        indices: &Buffer,
        blend_mode: BlendMode,
        opacity: f32,
    ) {
        let Some(src) = self.picture(image) else {
            return;
        };
        let (vertices, uvs) = (vertices.f32_pairs(), uvs.f32_pairs());
        let (width, height) = (image.width as f32, image.height as f32);
        for triangle in indices.u16s().as_chunks::<3>().0 {
            let corners = [
                triangle[0] as usize,
                triangle[1] as usize,
                triangle[2] as usize,
            ];
            if corners
                .iter()
                .any(|&i| i >= vertices.len() || i >= uvs.len())
            {
                continue;
            }
            // The picture is drawn in its own pixels: the matrix takes them
            // to the triangle on the canvas, so a plain image pattern fills
            // the triangle given in the picture's pixels.
            let from = corners.map(|i| (uvs[i][0] * width, uvs[i][1] * height));
            let to = corners.map(|i| (vertices[i][0], vertices[i][1]));
            let Some(map) = triangle_map(from, to) else {
                continue;
            };
            let centre = (
                (from[0].0 + from[1].0 + from[2].0) / 3.0,
                (from[0].1 + from[1].1 + from[2].1) / 3.0,
            );
            let grown = from.map(|(x, y)| {
                (
                    centre.0 + (x - centre.0) * MESH_OVERLAP,
                    centre.1 + (y - centre.1) * MESH_OVERLAP,
                )
            });
            let path = format!(
                "M{} {}L{} {}L{} {}Z",
                grown[0].0, grown[0].1, grown[1].0, grown[1].1, grown[2].0, grown[2].1
            );
            self.commands.push(json!({
                "op": "fill", "path": path,
                "paint": { "type": "pattern", "source": { "kind": "src", "src": src }, "repeatX": false, "repeatY": false },
                "m": multiply(&self.matrix, &map), "a": opacity, "blend": blend_name(blend_mode),
            }));
        }
    }
}

/// The affine map that takes the triangle `from` to the triangle `to`, corner
/// for corner; `None` for a triangle with no area.
fn triangle_map(from: [(f32, f32); 3], to: [(f32, f32); 3]) -> Option<Matrix> {
    let [(x0, y0), (x1, y1), (x2, y2)] = from;
    let [(u0, v0), (u1, v1), (u2, v2)] = to;
    let det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if det.abs() < f32::EPSILON {
        return None;
    }
    // Solve [a c; b d] * (x, y) + (e, f) = (u, v) at the three corners.
    let a = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / det;
    let c = ((u2 - u0) * (x1 - x0) - (u1 - u0) * (x2 - x0)) / det;
    let b = ((v1 - v0) * (y2 - y0) - (v2 - v0) * (y1 - y0)) / det;
    let d = ((v2 - v0) * (x1 - x0) - (v1 - v0) * (x2 - x0)) / det;
    let e = u0 - a * x0 - c * y0;
    let f = v0 - b * x0 - d * y0;
    Some([a, b, c, d, e, f])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_matrix_product_applies_the_inner_one_first() {
        let scale = [2.0, 0.0, 0.0, 2.0, 0.0, 0.0];
        let shift = [1.0, 0.0, 0.0, 1.0, 10.0, 0.0];
        assert_eq!(apply(&multiply(&scale, &shift), 1.0, 1.0), (22.0, 2.0));
        assert_eq!(apply(&multiply(&shift, &scale), 1.0, 1.0), (12.0, 2.0));
    }

    #[test]
    fn a_triangle_map_takes_each_corner_to_its_corner() {
        let from = [(0.0, 0.0), (10.0, 0.0), (0.0, 10.0)];
        let to = [(5.0, 5.0), (25.0, 5.0), (5.0, 15.0)];
        let map = triangle_map(from, to).unwrap();
        for (a, b) in from.iter().zip(&to) {
            let (x, y) = apply(&map, a.0, a.1);
            assert!((x - b.0).abs() < 1e-4 && (y - b.1).abs() < 1e-4);
        }
        assert!(triangle_map([(0.0, 0.0); 3], to).is_none());
    }
}
