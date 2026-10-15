//! Canvas 2D: the commands a `CanvasRenderingContext2D` was given in a frame,
//! drawn into one layer with Vello (docs/SCENE.md, "canvas").
//!
//! The authoring side (`@kinetograph/scene`'s `createCanvasContext`) keeps the
//! context's state, so every command arrives with the state it is drawn in
//! already worked out: the transform, `globalAlpha`, `globalCompositeOperation`,
//! the paint, the stroke style. A path is SVG path data in the space it was
//! built in, and the command's `m` takes that space to the canvas. Only the
//! clip is a pair of commands (`clip`, `unclip`), since it outlives the
//! command that set it until the `restore` that undoes it.
//!
//! Nothing here reads anything but the commands, the fonts and the pictures
//! they name, so a canvas is a pure function of its commands.

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine as _;
use serde::Deserialize;
use vello::kurbo::{Affine, BezPath, Cap, Join, Rect, Shape, Stroke};
use vello::peniko::{self, Blob, Fill, ImageAlphaType, ImageData, ImageFormat};

use crate::color::Color;
use crate::error::{Error, Result};
use crate::resolve::{ResolvedGradient, ResolvedGradientGeometry};
use crate::scene::{Extend, TextAlign, Units};
use crate::text::TextEngine;

/// The commands of a canvas layer, shared between the scene and the frames
/// resolved from it.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(from = "Vec<CanvasOp>")]
pub struct CanvasOps(pub Arc<Vec<CanvasOp>>);

impl Default for CanvasOps {
    fn default() -> CanvasOps {
        CanvasOps(Arc::new(Vec::new()))
    }
}

impl From<Vec<CanvasOp>> for CanvasOps {
    fn from(ops: Vec<CanvasOp>) -> CanvasOps {
        CanvasOps(Arc::new(ops))
    }
}

/// `[a, b, c, d, e, f]`, as the canvas's `setTransform` and SVG's `matrix()`.
pub type Matrix = [f64; 6];

fn identity() -> Matrix {
    [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
}

fn one() -> f32 {
    1.0
}

fn yes() -> bool {
    true
}

fn ten() -> f64 {
    10.0
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum CanvasOp {
    Fill(FillOp),
    Stroke(StrokeOp),
    Text(TextOp),
    Image(ImageOp),
    /// Intersects the clip with a path until the matching `unclip`.
    Clip(ClipOp),
    Unclip,
}

/// What every drawing command is drawn with.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct DrawState {
    /// Takes the space of the command's path (or text, or image) to the
    /// canvas.
    #[serde(default = "identity")]
    pub m: Matrix,
    /// `globalAlpha`.
    #[serde(default = "one")]
    pub a: f32,
    /// `globalCompositeOperation`.
    #[serde(default)]
    pub blend: CanvasBlend,
}

impl DrawState {
    fn matrix(&self) -> Affine {
        Affine::new(self.m)
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FillOp {
    pub path: String,
    #[serde(default)]
    pub rule: CanvasRule,
    pub paint: CanvasPaint,
    #[serde(flatten)]
    pub state: DrawState,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct StrokeOp {
    pub path: String,
    pub paint: CanvasPaint,
    #[serde(flatten)]
    pub line: LineStyle,
    #[serde(flatten)]
    pub state: DrawState,
}

/// `lineWidth` and the rest of a stroke's style.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineStyle {
    #[serde(default = "one_f64")]
    pub width: f64,
    #[serde(default)]
    pub cap: CanvasCap,
    #[serde(default)]
    pub join: CanvasJoin,
    #[serde(default = "ten")]
    pub miter_limit: f64,
    #[serde(default)]
    pub dash: Vec<f64>,
    #[serde(default)]
    pub dash_offset: f64,
}

fn one_f64() -> f64 {
    1.0
}

impl LineStyle {
    fn stroke(&self) -> Stroke {
        let cap = match self.cap {
            CanvasCap::Butt => Cap::Butt,
            CanvasCap::Round => Cap::Round,
            CanvasCap::Square => Cap::Square,
        };
        let join = match self.join {
            CanvasJoin::Miter => Join::Miter,
            CanvasJoin::Round => Join::Round,
            CanvasJoin::Bevel => Join::Bevel,
        };
        let stroke = Stroke::new(self.width)
            .with_caps(cap)
            .with_join(join)
            .with_miter_limit(self.miter_limit);
        if self.dash.is_empty() {
            stroke
        } else {
            stroke.with_dashes(self.dash_offset, self.dash.iter().copied())
        }
    }

    /// How far a stroke with this style reaches from its path.
    fn reach(&self) -> f64 {
        let miter = if self.join == CanvasJoin::Miter {
            self.miter_limit.max(1.0)
        } else {
            1.0
        };
        self.width * miter.max(std::f64::consts::SQRT_2) / 2.0 + 1.0
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ClipOp {
    pub path: String,
    #[serde(default)]
    pub rule: CanvasRule,
    #[serde(default = "identity")]
    pub m: Matrix,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextOp {
    pub text: String,
    /// The family, as the scene's `fonts` names it.
    pub font: String,
    /// Pixels.
    pub size: f32,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub align: CanvasTextAlign,
    #[serde(default)]
    pub baseline: CanvasBaseline,
    /// With a line style the glyph outlines are stroked, else filled.
    pub line: Option<LineStyle>,
    pub paint: CanvasPaint,
    /// `maxWidth` of `fillText`: wider text is squeezed to it.
    pub max_width: Option<f64>,
    #[serde(flatten)]
    pub state: DrawState,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageOp {
    pub source: CanvasSource,
    /// The part of the source drawn; omitted: all of it.
    pub sx: Option<f64>,
    pub sy: Option<f64>,
    pub sw: Option<f64>,
    pub sh: Option<f64>,
    /// Where it goes.
    pub dx: f64,
    pub dy: f64,
    pub dw: f64,
    pub dh: f64,
    /// `imageSmoothingEnabled`.
    #[serde(default = "yes")]
    pub smooth: bool,
    #[serde(flatten)]
    pub state: DrawState,
}

/// What `drawImage` and `createPattern` take.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CanvasSource {
    /// A picture file of the scene, by its `src` (`Renderer::images`).
    Src { src: String },
    /// RGBA pixels, straight alpha, base64: an `ImageData`.
    Pixels {
        width: u32,
        height: u32,
        data: String,
    },
    /// Another canvas, drawn at its commands' size.
    Canvas {
        width: f64,
        height: f64,
        commands: Vec<CanvasOp>,
    },
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CanvasPaint {
    Color {
        color: Color,
    },
    /// Coordinates are in the space of the command's `m`.
    Linear {
        x0: f64,
        y0: f64,
        x1: f64,
        y1: f64,
        stops: Vec<(f64, Color)>,
    },
    Radial {
        x0: f64,
        y0: f64,
        r0: f64,
        x1: f64,
        y1: f64,
        r1: f64,
        stops: Vec<(f64, Color)>,
    },
    /// `angle` in radians, clockwise from 3 o'clock.
    Conic {
        x: f64,
        y: f64,
        angle: f64,
        stops: Vec<(f64, Color)>,
    },
    Pattern {
        source: CanvasSource,
        #[serde(default = "yes")]
        repeat_x: bool,
        #[serde(default = "yes")]
        repeat_y: bool,
    },
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CanvasRule {
    #[default]
    NonZero,
    EvenOdd,
}

impl CanvasRule {
    fn fill(self) -> Fill {
        match self {
            CanvasRule::NonZero => Fill::NonZero,
            CanvasRule::EvenOdd => Fill::EvenOdd,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CanvasCap {
    #[default]
    Butt,
    Round,
    Square,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CanvasJoin {
    #[default]
    Miter,
    Round,
    Bevel,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CanvasTextAlign {
    #[default]
    Start,
    End,
    Left,
    Right,
    Center,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CanvasBaseline {
    Top,
    Hanging,
    Middle,
    #[default]
    Alphabetic,
    Ideographic,
    Bottom,
}

/// `globalCompositeOperation`, and `clear` for `clearRect`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CanvasBlend {
    #[default]
    SourceOver,
    SourceIn,
    SourceOut,
    SourceAtop,
    DestinationOver,
    DestinationIn,
    DestinationOut,
    DestinationAtop,
    Lighter,
    Copy,
    Xor,
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    ColorDodge,
    ColorBurn,
    HardLight,
    SoftLight,
    Difference,
    Exclusion,
    Hue,
    Saturation,
    Color,
    Luminosity,
    Clear,
}

impl CanvasBlend {
    /// The Vello blend mode, `None` for plain source-over.
    fn mode(self) -> Option<peniko::BlendMode> {
        use peniko::{Compose, Mix};
        let (mix, compose) = match self {
            CanvasBlend::SourceOver => return None,
            CanvasBlend::SourceIn => (Mix::Normal, Compose::SrcIn),
            CanvasBlend::SourceOut => (Mix::Normal, Compose::SrcOut),
            CanvasBlend::SourceAtop => (Mix::Normal, Compose::SrcAtop),
            CanvasBlend::DestinationOver => (Mix::Normal, Compose::DestOver),
            CanvasBlend::DestinationIn => (Mix::Normal, Compose::DestIn),
            CanvasBlend::DestinationOut => (Mix::Normal, Compose::DestOut),
            CanvasBlend::DestinationAtop => (Mix::Normal, Compose::DestAtop),
            CanvasBlend::Lighter => (Mix::Normal, Compose::PlusLighter),
            CanvasBlend::Copy => (Mix::Normal, Compose::Copy),
            CanvasBlend::Xor => (Mix::Normal, Compose::Xor),
            CanvasBlend::Multiply => (Mix::Multiply, Compose::SrcOver),
            CanvasBlend::Screen => (Mix::Screen, Compose::SrcOver),
            CanvasBlend::Overlay => (Mix::Overlay, Compose::SrcOver),
            CanvasBlend::Darken => (Mix::Darken, Compose::SrcOver),
            CanvasBlend::Lighten => (Mix::Lighten, Compose::SrcOver),
            CanvasBlend::ColorDodge => (Mix::ColorDodge, Compose::SrcOver),
            CanvasBlend::ColorBurn => (Mix::ColorBurn, Compose::SrcOver),
            CanvasBlend::HardLight => (Mix::HardLight, Compose::SrcOver),
            CanvasBlend::SoftLight => (Mix::SoftLight, Compose::SrcOver),
            CanvasBlend::Difference => (Mix::Difference, Compose::SrcOver),
            CanvasBlend::Exclusion => (Mix::Exclusion, Compose::SrcOver),
            CanvasBlend::Hue => (Mix::Hue, Compose::SrcOver),
            CanvasBlend::Saturation => (Mix::Saturation, Compose::SrcOver),
            CanvasBlend::Color => (Mix::Color, Compose::SrcOver),
            CanvasBlend::Luminosity => (Mix::Luminosity, Compose::SrcOver),
            CanvasBlend::Clear => (Mix::Normal, Compose::Clear),
        };
        Some(peniko::BlendMode::new(mix, compose))
    }

    /// Whether the operation also changes pixels the shape does not cover
    /// (`source-in` clears them), so it is applied over the whole canvas.
    fn reaches_whole_canvas(self) -> bool {
        matches!(
            self,
            CanvasBlend::SourceIn
                | CanvasBlend::SourceOut
                | CanvasBlend::DestinationIn
                | CanvasBlend::DestinationAtop
                | CanvasBlend::Copy
        )
    }
}

/// What is wrong with the first path or block of pixels in `ops` (or in the
/// canvases inside them) that cannot be read, for a scene to refuse when it
/// loads; `None` when all can.
pub fn bad_path(ops: &[CanvasOp]) -> Option<String> {
    for op in ops {
        let path = match op {
            CanvasOp::Fill(f) => Some(&f.path),
            CanvasOp::Stroke(s) => Some(&s.path),
            CanvasOp::Clip(c) => Some(&c.path),
            CanvasOp::Image(ImageOp {
                source: CanvasSource::Canvas { commands, .. },
                ..
            }) => {
                if let Some(bad) = bad_path(commands) {
                    return Some(bad);
                }
                None
            }
            _ => None,
        };
        if let Some(d) = path
            && let Err(e) = BezPath::from_svg(d)
        {
            return Some(format!("bad path {d:?}: {e}"));
        }
        if let CanvasOp::Image(ImageOp {
            source:
                CanvasSource::Pixels {
                    width,
                    height,
                    data,
                },
            ..
        }) = op
            && let Err(e) = pixels(*width, *height, data)
        {
            return Some(e);
        }
    }
    None
}

/// Every picture file the commands name, in order of use (`Renderer::images`
/// holds them), also inside the canvases they draw.
pub fn sources(ops: &[CanvasOp], out: &mut Vec<String>) {
    let source = |s: &CanvasSource, out: &mut Vec<String>| match s {
        CanvasSource::Src { src } => out.push(src.clone()),
        CanvasSource::Canvas { commands, .. } => sources(commands, out),
        CanvasSource::Pixels { .. } => {}
    };
    for op in ops {
        match op {
            CanvasOp::Image(i) => source(&i.source, out),
            CanvasOp::Fill(FillOp { paint, .. })
            | CanvasOp::Stroke(StrokeOp { paint, .. })
            | CanvasOp::Text(TextOp { paint, .. }) => {
                if let CanvasPaint::Pattern { source: s, .. } = paint {
                    source(s, out);
                }
            }
            _ => {}
        }
    }
}

/// Whether any command draws a picture, which picks Vello's image renderer.
pub fn draws_pictures(ops: &[CanvasOp]) -> bool {
    ops.iter().any(|op| match op {
        CanvasOp::Image(_) => true,
        CanvasOp::Fill(FillOp { paint, .. })
        | CanvasOp::Stroke(StrokeOp { paint, .. })
        | CanvasOp::Text(TextOp { paint, .. }) => matches!(paint, CanvasPaint::Pattern { .. }),
        _ => false,
    })
}

/// An `ImageData` of straight-alpha RGBA8 pixels from base64.
fn pixels(width: u32, height: u32, data: &str) -> std::result::Result<ImageData, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("canvas pixels are not base64: {e}"))?;
    if bytes.len() as u64 != u64::from(width) * u64::from(height) * 4 {
        return Err(format!(
            "canvas pixels: {width}x{height} needs {} bytes, got {}",
            u64::from(width) * u64::from(height) * 4,
            bytes.len()
        ));
    }
    Ok(ImageData {
        data: Blob::from(bytes),
        format: ImageFormat::Rgba8,
        alpha_type: ImageAlphaType::Alpha,
        width,
        height,
    })
}

/// What drawing a canvas needs besides its commands.
pub struct Drawing<'a> {
    pub text: &'a mut TextEngine,
    /// The scene's pictures by `src`.
    pub images: &'a HashMap<String, ImageData>,
}

/// Adds the canvas `(0, 0, width, height)` drawn with `ops` to `scene` under
/// `matrix`; whatever the commands draw outside the box is cut off.
pub fn encode(
    scene: &mut vello::Scene,
    drawing: &mut Drawing,
    (width, height): (f64, f64),
    ops: &[CanvasOp],
    matrix: Affine,
) -> Result<()> {
    let bounds = Rect::new(0.0, 0.0, width, height);
    scene.push_clip_layer(Fill::NonZero, matrix, &bounds);
    let mut open = 0_usize;
    for op in ops {
        match op {
            CanvasOp::Fill(f) => {
                let path = parse(&f.path)?;
                let m = matrix * f.state.matrix();
                let (brush, brush_transform) = brush(&f.paint, f.state.a, drawing.images)?;
                blended(scene, f.state.blend, matrix, bounds, m, &path, 1.0, |s| {
                    s.fill(f.rule.fill(), m, &brush, brush_transform, &path);
                });
            }
            CanvasOp::Stroke(st) => {
                let path = parse(&st.path)?;
                let m = matrix * st.state.matrix();
                let (brush, brush_transform) = brush(&st.paint, st.state.a, drawing.images)?;
                let stroke = st.line.stroke();
                blended(
                    scene,
                    st.state.blend,
                    matrix,
                    bounds,
                    m,
                    &path,
                    st.line.reach(),
                    |s| s.stroke(&stroke, m, &brush, brush_transform, &path),
                );
            }
            CanvasOp::Clip(c) => {
                let path = parse(&c.path)?;
                scene.push_clip_layer(c.rule.fill(), matrix * Affine::new(c.m), &path);
                open += 1;
            }
            CanvasOp::Unclip => {
                if open > 0 {
                    scene.pop_layer();
                    open -= 1;
                }
            }
            CanvasOp::Text(t) => text(scene, drawing, t, matrix, bounds)?,
            CanvasOp::Image(i) => image(scene, drawing, i, matrix, bounds)?,
        }
    }
    for _ in 0..open {
        scene.pop_layer();
    }
    scene.pop_layer();
    Ok(())
}

fn parse(d: &str) -> Result<BezPath> {
    BezPath::from_svg(d).map_err(|e| Error::Scene(format!("canvas: bad path {d:?}: {e}")))
}

/// Runs `draw`, inside a layer with the blend mode `blend` when it is not
/// source-over. `path` (under `m`) and `reach` are what `draw` can touch; an
/// operation that changes pixels outside of that is given the whole canvas.
#[allow(clippy::too_many_arguments)]
fn blended(
    scene: &mut vello::Scene,
    blend: CanvasBlend,
    canvas_matrix: Affine,
    canvas: Rect,
    m: Affine,
    path: &BezPath,
    reach: f64,
    draw: impl FnOnce(&mut vello::Scene),
) {
    let Some(mode) = blend.mode() else {
        draw(scene);
        return;
    };
    if blend.reaches_whole_canvas() {
        scene.push_layer(Fill::NonZero, mode, 1.0, canvas_matrix, &canvas);
    } else {
        // Only the shape's own pixels change; its box, grown by the stroke.
        let touched = path.bounding_box().inflate(reach, reach);
        scene.push_layer(Fill::NonZero, mode, 1.0, m, &touched);
    }
    draw(scene);
    scene.pop_layer();
}

/// A paint as a Vello brush, with `alpha` (`globalAlpha`) applied, and the
/// transform the brush wants.
fn brush(
    paint: &CanvasPaint,
    alpha: f32,
    images: &HashMap<String, ImageData>,
) -> Result<(peniko::Brush, Option<Affine>)> {
    let gradient = |geometry, stops: &[(f64, Color)]| {
        if stops.is_empty() {
            return (peniko::Brush::Solid(peniko::Color::TRANSPARENT), None);
        }
        let g = ResolvedGradient {
            geometry,
            stops: stops.to_vec(),
            extend: Extend::Pad,
            units: Units::User,
            transform: Affine::IDENTITY,
        };
        let (brush, turn) = crate::render::gradient_brush(&g);
        (brush.multiply_alpha(alpha), Some(turn))
    };
    Ok(match paint {
        CanvasPaint::Color { color } => (
            peniko::Brush::Solid(crate::render::to_peniko(*color)).multiply_alpha(alpha),
            None,
        ),
        CanvasPaint::Linear {
            x0,
            y0,
            x1,
            y1,
            stops,
        } => gradient(
            ResolvedGradientGeometry::Linear {
                x0: *x0,
                y0: *y0,
                x1: *x1,
                y1: *y1,
            },
            stops,
        ),
        CanvasPaint::Radial {
            x0,
            y0,
            r0,
            x1,
            y1,
            r1,
            stops,
        } => gradient(
            ResolvedGradientGeometry::FocalRadial {
                cx: *x1,
                cy: *y1,
                r: *r1,
                fx: *x0,
                fy: *y0,
                fr: *r0,
            },
            stops,
        ),
        CanvasPaint::Conic { x, y, angle, stops } => gradient(
            ResolvedGradientGeometry::Conic {
                cx: *x,
                cy: *y,
                // The scene's conic angle runs from 12 o'clock.
                angle: angle.to_degrees() + 90.0,
            },
            stops,
        ),
        CanvasPaint::Pattern {
            source,
            repeat_x,
            repeat_y,
        } => {
            let Some(image) = picture(source, images)? else {
                return Ok((peniko::Brush::Solid(peniko::Color::TRANSPARENT), None));
            };
            let extend = |repeat: bool| {
                if repeat {
                    peniko::Extend::Repeat
                } else {
                    peniko::Extend::Pad
                }
            };
            let brush = peniko::Brush::Image(peniko::ImageBrush {
                image,
                sampler: peniko::ImageSampler {
                    x_extend: extend(*repeat_x),
                    y_extend: extend(*repeat_y),
                    ..Default::default()
                },
            });
            (brush.multiply_alpha(alpha), None)
        }
    })
}

/// The pixels behind a picture source; `None` for a canvas, which is drawn
/// rather than sampled.
fn picture(
    source: &CanvasSource,
    images: &HashMap<String, ImageData>,
) -> Result<Option<ImageData>> {
    match source {
        CanvasSource::Src { src } => images
            .get(src)
            .cloned()
            .map(Some)
            .ok_or_else(|| Error::Render(format!("canvas: the picture {src:?} was not loaded"))),
        CanvasSource::Pixels {
            width,
            height,
            data,
        } => pixels(*width, *height, data)
            .map(Some)
            .map_err(Error::Scene),
        CanvasSource::Canvas { .. } => Ok(None),
    }
}

fn image(
    scene: &mut vello::Scene,
    drawing: &mut Drawing,
    op: &ImageOp,
    canvas_matrix: Affine,
    canvas: Rect,
) -> Result<()> {
    let m = canvas_matrix * op.state.matrix();
    let dest = Rect::new(op.dx, op.dy, op.dx + op.dw, op.dy + op.dh);
    let (natural_w, natural_h) = match &op.source {
        CanvasSource::Src { src } => match drawing.images.get(src) {
            Some(i) => (f64::from(i.width), f64::from(i.height)),
            None => {
                return Err(Error::Render(format!(
                    "canvas: the picture {src:?} was not loaded"
                )));
            }
        },
        CanvasSource::Pixels { width, height, .. } => (f64::from(*width), f64::from(*height)),
        CanvasSource::Canvas { width, height, .. } => (*width, *height),
    };
    let (sx, sy) = (op.sx.unwrap_or(0.0), op.sy.unwrap_or(0.0));
    let (sw, sh) = (op.sw.unwrap_or(natural_w), op.sh.unwrap_or(natural_h));
    if !(sw > 0.0 && sh > 0.0 && op.dw != 0.0 && op.dh != 0.0 && natural_w > 0.0 && natural_h > 0.0)
    {
        return Ok(());
    }
    // The source rectangle onto the destination one. A negative `dw` or `dh`
    // flips, as the canvas does.
    let to_dest = Affine::translate((op.dx, op.dy))
        * Affine::scale_non_uniform(op.dw / sw, op.dh / sh)
        * Affine::translate((-sx, -sy));
    let dest = dest.abs();
    let state = &op.state;
    let Some(mode) = state.blend.mode() else {
        scene.push_clip_layer(Fill::NonZero, m, &dest);
        draw_source(scene, drawing, &op.source, m * to_dest, op, state.a)?;
        scene.pop_layer();
        return Ok(());
    };
    if state.blend.reaches_whole_canvas() {
        scene.push_layer(Fill::NonZero, mode, 1.0, canvas_matrix, &canvas);
        scene.push_clip_layer(Fill::NonZero, m, &dest);
    } else {
        scene.push_layer(Fill::NonZero, mode, 1.0, m, &dest);
    }
    draw_source(scene, drawing, &op.source, m * to_dest, op, state.a)?;
    if state.blend.reaches_whole_canvas() {
        scene.pop_layer();
    }
    scene.pop_layer();
    Ok(())
}

/// Draws a whole source at its natural size under `matrix`.
fn draw_source(
    scene: &mut vello::Scene,
    drawing: &mut Drawing,
    source: &CanvasSource,
    matrix: Affine,
    op: &ImageOp,
    alpha: f32,
) -> Result<()> {
    if let CanvasSource::Canvas {
        width,
        height,
        commands,
    } = source
    {
        // A canvas drawn into another is composited as a whole, so its own
        // commands are drawn in a layer that takes the alpha.
        let bounds = Rect::new(0.0, 0.0, *width, *height);
        scene.push_layer(
            Fill::NonZero,
            peniko::BlendMode::new(peniko::Mix::Normal, peniko::Compose::SrcOver),
            alpha,
            matrix,
            &bounds,
        );
        encode(scene, drawing, (*width, *height), commands, matrix)?;
        scene.pop_layer();
        return Ok(());
    }
    let Some(image) = picture(source, drawing.images)? else {
        return Ok(());
    };
    let quality = if op.smooth {
        peniko::ImageQuality::Medium
    } else {
        peniko::ImageQuality::Low
    };
    let rect = Rect::new(0.0, 0.0, f64::from(image.width), f64::from(image.height));
    let brush = peniko::Brush::Image(peniko::ImageBrush {
        image,
        sampler: peniko::ImageSampler {
            quality,
            ..Default::default()
        },
    })
    .multiply_alpha(alpha);
    scene.fill(Fill::NonZero, matrix, &brush, None, &rect);
    Ok(())
}

fn text(
    scene: &mut vello::Scene,
    drawing: &mut Drawing,
    op: &TextOp,
    canvas_matrix: Affine,
    canvas: Rect,
) -> Result<()> {
    if op.text.is_empty() || !(op.size > 0.0) {
        return Ok(());
    }
    let laid = drawing
        .text
        .layout(&op.text, &op.font, op.size, None, None, TextAlign::Left);
    let Some(line) = laid.lines.first() else {
        return Ok(());
    };
    let width = f64::from(laid.width);
    // `maxWidth` squeezes wider text to fit, as the canvas does.
    let squeeze = match op.max_width {
        Some(max) if max > 0.0 && width > max => max / width,
        Some(max) if max <= 0.0 => return Ok(()),
        _ => 1.0,
    };
    let left = match op.align {
        CanvasTextAlign::Start | CanvasTextAlign::Left => 0.0,
        CanvasTextAlign::Center => -width / 2.0,
        CanvasTextAlign::End | CanvasTextAlign::Right => -width,
    };
    let (ascent, descent) = (f64::from(line.ascent), f64::from(line.descent));
    // Where the alphabetic baseline sits relative to the point the text is
    // placed at, going by the em box (ascent above the baseline, descent
    // below).
    let down = match op.baseline {
        CanvasBaseline::Alphabetic => 0.0,
        CanvasBaseline::Top => ascent,
        CanvasBaseline::Hanging => ascent * 0.8,
        CanvasBaseline::Middle => (ascent - descent) / 2.0,
        CanvasBaseline::Ideographic | CanvasBaseline::Bottom => -descent,
    };
    // Glyph positions are from the top of the line box.
    let origin = Affine::translate((op.x, op.y + down))
        * Affine::scale_non_uniform(squeeze, 1.0)
        * Affine::translate((left, -f64::from(line.baseline)));
    let m = canvas_matrix * op.state.matrix() * origin;
    let (brush, brush_transform) = brush(&op.paint, op.state.a, drawing.images)?;
    let stroke = op.line.as_ref().map(LineStyle::stroke);
    let reach = op.line.as_ref().map_or(0.0, LineStyle::reach);
    let touched = Rect::new(0.0, 0.0, width, f64::from(laid.height)).inflate(reach, reach);
    let mode = op.state.blend.mode();
    match mode {
        Some(mode) if op.state.blend.reaches_whole_canvas() => {
            scene.push_layer(Fill::NonZero, mode, 1.0, canvas_matrix, &canvas);
        }
        Some(mode) => scene.push_layer(Fill::NonZero, mode, 1.0, m, &touched),
        None => {}
    }
    for run in &laid.runs {
        let glyphs = run.glyphs.iter().map(|g| vello::Glyph {
            id: g.id,
            x: g.x,
            y: g.y,
        });
        let draw = scene
            .draw_glyphs(&run.font)
            .transform(m)
            .glyph_transform(
                (run.skew != 0.0)
                    .then(|| Affine::skew(f64::from(run.skew).to_radians().tan(), 0.0)),
            )
            .normalized_coords(&run.coords)
            .brush_transform(brush_transform)
            .font_size(run.font_size)
            .hint(false)
            .brush(&brush);
        match &stroke {
            Some(stroke) => draw.draw(stroke, glyphs),
            None => draw.draw(Fill::NonZero, glyphs),
        }
    }
    if mode.is_some() {
        scene.pop_layer();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ops(json: &str) -> Vec<CanvasOp> {
        serde_json::from_str(json).expect("commands parse")
    }

    #[test]
    fn a_fill_takes_its_state_from_the_command() {
        let parsed = ops(
            r##"[{"op": "fill", "path": "M0 0H10V10Z", "paint": {"type": "color", "color": "#ff0000"},
                 "m": [2, 0, 0, 2, 5, 5], "a": 0.5, "blend": "multiply", "rule": "evenodd"}]"##,
        );
        let CanvasOp::Fill(f) = &parsed[0] else {
            panic!("not a fill");
        };
        assert_eq!(f.state.m, [2.0, 0.0, 0.0, 2.0, 5.0, 5.0]);
        assert_eq!(f.state.a, 0.5);
        assert_eq!(f.state.blend, CanvasBlend::Multiply);
        assert_eq!(f.rule, CanvasRule::EvenOdd);
    }

    #[test]
    fn omitted_state_is_the_canvas_default() {
        let parsed = ops(
            r##"[{"op": "stroke", "path": "M0 0L5 5", "paint": {"type": "color", "color": "#fff"}}]"##,
        );
        let CanvasOp::Stroke(s) = &parsed[0] else {
            panic!("not a stroke");
        };
        assert_eq!(s.state.m, identity());
        assert_eq!(s.state.a, 1.0);
        assert_eq!(s.state.blend, CanvasBlend::SourceOver);
        assert_eq!(s.line.width, 1.0);
        assert_eq!(s.line.miter_limit, 10.0);
        assert_eq!(s.line.cap, CanvasCap::Butt);
    }

    #[test]
    fn every_composite_operation_the_canvas_has_parses() {
        for name in [
            "source-over",
            "source-in",
            "source-out",
            "source-atop",
            "destination-over",
            "destination-in",
            "destination-out",
            "destination-atop",
            "lighter",
            "copy",
            "xor",
            "multiply",
            "screen",
            "overlay",
            "darken",
            "lighten",
            "color-dodge",
            "color-burn",
            "hard-light",
            "soft-light",
            "difference",
            "exclusion",
            "hue",
            "saturation",
            "color",
            "luminosity",
        ] {
            let blend: CanvasBlend = serde_json::from_str(&format!("\"{name}\""))
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(blend.mode().is_none(), name == "source-over", "{name}");
        }
    }

    #[test]
    fn bad_paths_and_pixels_are_found_before_a_frame_is_drawn() {
        let good = ops(r##"[{"op": "clip", "path": "M0 0H5V5Z"}]"##);
        assert_eq!(bad_path(&good), None);
        let bad = ops(
            r##"[{"op": "fill", "path": "M0 0 Q", "paint": {"type": "color", "color": "#000"}}]"##,
        );
        assert!(bad_path(&bad).unwrap().contains("bad path"));
        let short = ops(
            r##"[{"op": "image", "source": {"kind": "pixels", "width": 2, "height": 2, "data": "AAAA"},
                 "dx": 0, "dy": 0, "dw": 2, "dh": 2}]"##,
        );
        assert!(bad_path(&short).unwrap().contains("needs 16 bytes"));
    }

    #[test]
    fn sources_lists_pictures_inside_canvases_and_patterns() {
        let parsed = ops(
            r##"[{"op": "image", "source": {"kind": "src", "src": "a.png"}, "dx": 0, "dy": 0, "dw": 1, "dh": 1},
                {"op": "image", "source": {"kind": "canvas", "width": 4, "height": 4, "commands": [
                  {"op": "image", "source": {"kind": "src", "src": "b.png"}, "dx": 0, "dy": 0, "dw": 1, "dh": 1}]},
                 "dx": 0, "dy": 0, "dw": 4, "dh": 4},
                {"op": "fill", "path": "M0 0H4V4Z",
                 "paint": {"type": "pattern", "source": {"kind": "src", "src": "c.png"}}}]"##,
        );
        let mut found = Vec::new();
        sources(&parsed, &mut found);
        assert_eq!(found, ["a.png", "b.png", "c.png"]);
        assert!(draws_pictures(&parsed));
        assert!(!draws_pictures(&ops(r#"[{"op": "unclip"}]"#)));
    }

    #[test]
    fn the_line_style_reaches_as_far_as_a_miter_join_does() {
        let line = |join: &str| -> LineStyle {
            serde_json::from_str(&format!(
                r#"{{"width": 10, "join": "{join}", "miterLimit": 4}}"#
            ))
            .unwrap()
        };
        assert!(line("round").reach() < line("miter").reach());
    }
}
