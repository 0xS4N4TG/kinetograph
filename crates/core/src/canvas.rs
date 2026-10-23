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
//!
//! Vello has no blur, so a command with a shadow or a `filter` is drawn alone
//! on a transparent canvas, run through the compositor's blur and colour
//! passes, and comes back to the scene as a picture (`Effects`), composited
//! where the command stands in the list with its alpha, blend mode and clip.

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine as _;
use serde::Deserialize;
use vello::kurbo::{Affine, BezPath, Cap, Join, Rect, Shape, Stroke};
use vello::peniko::{self, Blob, Fill, ImageAlphaType, ImageData, ImageFormat};

use crate::anim::Num;
use crate::color::Color;
use crate::error::{Error, Result};
use crate::resolve::{
    Clock, ResolvedEffect, ResolvedGradient, ResolvedGradientGeometry, ResolvedShadow,
    resolve_effects,
};
use crate::scene::{Effect, Extend, MAX_SHADOW_SIZE, Shadow, TextAlign, Units};
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
    /// The shadow, when `shadowColor` and the rest make one show.
    #[serde(default)]
    pub shadow: Option<CanvasShadow>,
    /// `filter`, the functions in order.
    #[serde(default)]
    pub filter: Vec<FilterFn>,
}

impl DrawState {
    fn matrix(&self) -> Affine {
        Affine::new(self.m)
    }

    /// Whether the command is drawn alone first and run through GPU passes.
    pub(crate) fn has_effects(&self) -> bool {
        self.shadow.is_some() || !self.filter.is_empty()
    }

    /// The state a shadow's and a filter's source is drawn in: the same
    /// matrix, and none of what the picture is composited with afterwards.
    fn bare(&self) -> DrawState {
        DrawState {
            m: self.m,
            a: 1.0,
            blend: CanvasBlend::SourceOver,
            shadow: None,
            filter: Vec::new(),
        }
    }
}

/// `shadowColor`, `shadowBlur`, `shadowOffsetX` and `shadowOffsetY`, in canvas
/// pixels (the transform changes none of them).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct CanvasShadow {
    pub color: Color,
    /// `shadowBlur`; the blur's standard deviation is half of it.
    #[serde(default)]
    pub blur: f64,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
}

impl CanvasShadow {
    /// The shadow in the pixels the passes work in; `to_device` takes the
    /// canvas's pixels to those.
    fn resolved(&self, to_device: Affine) -> ResolvedShadow {
        let (x, y) = device_offset(to_device, self.x, self.y);
        ResolvedShadow {
            x: x as f32,
            y: y as f32,
            blur: device_length(to_device, self.blur / 2.0).clamp(0.0, MAX_SHADOW_SIZE) as f32,
            spread: 0.0,
            color: self.color,
        }
    }
}

/// A blur's length in the canvas's pixels, in the pixels the passes work in:
/// a layer that is scaled (CSS stretching a canvas) scales it, a turn does not
/// change it.
fn device_length(to_device: Affine, length: f64) -> f64 {
    length * to_device.determinant().abs().sqrt()
}

/// A shadow's offset in the canvas's pixels, in the pixels the passes work in:
/// it turns and scales with the layer.
fn device_offset(to_device: Affine, x: f64, y: f64) -> (f64, f64) {
    let [a, b, c, d, _, _] = to_device.as_coeffs();
    (a * x + c * y, b * x + d * y)
}

/// One function of a `filter` list, named as the scene's effects of the same
/// names are (`blur` takes the standard deviation, as the CSS `blur()` does).
/// `opacity()` is not here: the context multiplies it into the command's `a`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FilterFn {
    Blur {
        radius: f64,
    },
    Brightness {
        amount: f64,
    },
    Contrast {
        amount: f64,
    },
    Grayscale {
        amount: f64,
    },
    /// Degrees.
    HueRotate {
        angle: f64,
    },
    Invert {
        amount: f64,
    },
    Saturate {
        amount: f64,
    },
    Sepia {
        amount: f64,
    },
    DropShadow {
        x: f64,
        y: f64,
        /// The standard deviation.
        #[serde(default)]
        blur: f64,
        color: Color,
    },
}

impl FilterFn {
    /// The scene effect that runs the function, with its lengths in the
    /// pixels the passes work in (`to_device` takes the canvas's to those).
    fn effect(&self, to_device: Affine) -> Effect {
        let num = Num::Const;
        match *self {
            FilterFn::Blur { radius } => Effect::Blur {
                radius: num(device_length(to_device, radius)),
            },
            FilterFn::Brightness { amount } => Effect::Brightness {
                amount: num(amount),
            },
            FilterFn::Contrast { amount } => Effect::Contrast {
                amount: num(amount),
            },
            FilterFn::Grayscale { amount } => Effect::Grayscale {
                amount: num(amount),
            },
            FilterFn::HueRotate { angle } => Effect::HueRotate { angle: num(angle) },
            FilterFn::Invert { amount } => Effect::Invert {
                amount: num(amount),
            },
            FilterFn::Saturate { amount } => Effect::Saturate {
                amount: num(amount),
            },
            FilterFn::Sepia { amount } => Effect::Sepia {
                amount: num(amount),
            },
            FilterFn::DropShadow { x, y, blur, color } => {
                let (x, y) = device_offset(to_device, x, y);
                Effect::DropShadow(Shadow {
                    x: num(x),
                    y: num(y),
                    blur: num(device_length(to_device, blur)),
                    spread: num(0.0),
                    color,
                })
            }
        }
    }
}

/// The passes a `filter` list runs: the ones a layer's `blur`, colour filters
/// and `dropShadow` effects run, colour filters in a row merged into one.
pub(crate) fn filter_effects(filter: &[FilterFn], to_device: Affine) -> Vec<ResolvedEffect> {
    let effects: Vec<Effect> = filter.iter().map(|f| f.effect(to_device)).collect();
    // The numbers are constants, so any moment gives the same passes.
    let clock = Clock {
        t: 0.0,
        frame: 0,
        fps: 30.0,
    };
    resolve_effects(&effects, clock)
}

impl CanvasOp {
    /// The state of a command that draws; `None` for a clip.
    pub(crate) fn state(&self) -> Option<&DrawState> {
        match self {
            CanvasOp::Fill(FillOp { state, .. })
            | CanvasOp::Stroke(StrokeOp { state, .. })
            | CanvasOp::Text(TextOp { state, .. })
            | CanvasOp::Image(ImageOp { state, .. }) => Some(state),
            CanvasOp::Clip(_) | CanvasOp::Unclip => None,
        }
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
    #[serde(default)]
    pub letter_spacing: f64,
    #[serde(default)]
    pub word_spacing: f64,
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
    /// The picture of a child of a canvas pass (`GroupLayer::canvas`), by id:
    /// the child as a browser would hold it for a canvas it was drawn on.
    Layer { id: String },
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
    #[serde(rename_all = "camelCase")]
    Pattern {
        source: CanvasSource,
        #[serde(default = "yes", alias = "repeat_x")]
        repeat_x: bool,
        #[serde(default = "yes", alias = "repeat_y")]
        repeat_y: bool,
        #[serde(default)]
        m: Option<[f64; 6]>,
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
    pub(crate) fn reaches_whole_canvas(self) -> bool {
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
        CanvasSource::Pixels { .. } | CanvasSource::Layer { .. } => {}
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

/// The key a canvas pass's picture of the child `id` has among `Drawing::images`; no `src` can be it.
pub fn layer_key(id: &str) -> String {
    format!("\0layer:{id}")
}

/// The ids of the children of a canvas pass that `ops` draw, also inside the canvases they draw.
pub fn layer_sources(ops: &[CanvasOp]) -> Vec<String> {
    fn source(s: &CanvasSource, out: &mut Vec<String>) {
        match s {
            CanvasSource::Layer { id } => out.push(id.clone()),
            CanvasSource::Canvas { commands, .. } => out.extend(layer_sources(commands)),
            CanvasSource::Src { .. } | CanvasSource::Pixels { .. } => {}
        }
    }
    let mut out = Vec::new();
    for op in ops {
        match op {
            CanvasOp::Image(i) => source(&i.source, &mut out),
            CanvasOp::Fill(FillOp { paint, .. })
            | CanvasOp::Stroke(StrokeOp { paint, .. })
            | CanvasOp::Text(TextOp { paint, .. }) => {
                if let CanvasPaint::Pattern { source: s, .. } = paint {
                    source(s, &mut out);
                }
            }
            _ => {}
        }
    }
    out
}

/// Whether any command draws a picture, which picks Vello's image renderer: a
/// picture of a source or a pattern, or what a shadow or a filter made
/// (`Effects`).
pub fn draws_pictures(ops: &[CanvasOp]) -> bool {
    ops.iter().any(|op| match op {
        CanvasOp::Image(_) => true,
        CanvasOp::Fill(FillOp { paint, .. })
        | CanvasOp::Stroke(StrokeOp { paint, .. })
        | CanvasOp::Text(TextOp { paint, .. }) => {
            matches!(paint, CanvasPaint::Pattern { .. })
                || op.state().is_some_and(DrawState::has_effects)
        }
        _ => false,
    })
}

/// Whether any command, or any in the canvases they draw, has a shadow or a
/// filter. Those canvases are drawn alone (`Effects` run between their
/// commands), not on a page with other layers.
pub fn has_effects(ops: &[CanvasOp]) -> bool {
    ops.iter().any(|op| {
        op.state().is_some_and(DrawState::has_effects)
            || matches!(op, CanvasOp::Image(ImageOp { source: CanvasSource::Canvas { commands, .. }, .. }) if has_effects(commands))
    })
}

/// An `ImageData` of straight-alpha RGBA8 pixels from base64.
pub(crate) fn pixels(width: u32, height: u32, data: &str) -> std::result::Result<ImageData, String> {
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
    /// Runs the GPU passes of shadows and filters. Without it they are not
    /// drawn.
    pub effects: Option<&'a mut dyn Effects>,
}

/// The GPU passes behind shadows and filters, which the renderer owns.
pub trait Effects {
    /// Draws `alone` (one command, in the pixels `encode` draws in) on a
    /// transparent canvas, runs `filter` over it, and gives back the pictures
    /// of the result and of the shadow it casts. `bounds` is where the
    /// command can touch, `pictures` whether it needs Vello's image renderer.
    fn run(
        &mut self,
        alone: &vello::Scene,
        pictures: bool,
        bounds: Rect,
        filter: &[ResolvedEffect],
        shadow: Option<&ResolvedShadow>,
    ) -> Result<Rendered>;
}

/// What `Effects::run` made.
#[derive(Default)]
pub struct Rendered {
    /// The command with its `filter` applied; none when the filter was empty
    /// (the command is then drawn as it is) or left nothing.
    pub shape: Option<Placed>,
    /// The shadow it casts, if it has one.
    pub shadow: Option<Placed>,
}

/// A picture of straight-alpha sRGB pixels and the pixel of the scene its top
/// left corner lies on.
pub struct Placed {
    pub image: ImageData,
    pub at: (f64, f64),
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
        match (op, op.state()) {
            (CanvasOp::Clip(c), _) => {
                let path = parse(&c.path)?;
                scene.push_clip_layer(c.rule.fill(), matrix * Affine::new(c.m), &path);
                open += 1;
            }
            (CanvasOp::Unclip, _) => {
                if open > 0 {
                    scene.pop_layer();
                    open -= 1;
                }
            }
            (_, Some(state)) if state.has_effects() && drawing.effects.is_some() => {
                draw_with_effects(scene, drawing, op, state, matrix, bounds)?;
            }
            (_, Some(state)) => {
                draw(scene, drawing, op, state, matrix, bounds)?;
            }
            (_, None) => unreachable!("a command that is not a clip has a state"),
        }
    }
    for _ in 0..open {
        scene.pop_layer();
    }
    scene.pop_layer();
    Ok(())
}

/// Draws the fill, stroke, text or image `op` under `state` (the command's, or
/// a bare one) and returns the box of the pixels it can touch.
fn draw(
    scene: &mut vello::Scene,
    drawing: &mut Drawing,
    op: &CanvasOp,
    state: &DrawState,
    matrix: Affine,
    canvas: Rect,
) -> Result<Rect> {
    match op {
        CanvasOp::Fill(f) => {
            let path = parse(&f.path)?;
            let m = matrix * state.matrix();
            let touched = m.transform_rect_bbox(path.bounding_box().inflate(1.0, 1.0));
            if let CanvasPaint::Pattern {
                source:
                    CanvasSource::Canvas {
                        width,
                        height,
                        commands,
                    },
                repeat_x,
                repeat_y,
                m: pattern_m,
            } = &f.paint
            {
                fill_canvas_pattern(
                    scene,
                    drawing,
                    f.rule.fill(),
                    &path,
                    state,
                    matrix,
                    canvas,
                    m,
                    (*width, *height),
                    commands,
                    (*repeat_x, *repeat_y),
                    pattern_m.map_or(Affine::IDENTITY, Affine::new),
                )?;
                return Ok(touched);
            }
            let (brush, brush_transform) = brush(&f.paint, state.a, drawing.images)?;
            blended(scene, state.blend, matrix, canvas, m, &path, 1.0, |s| {
                s.fill(f.rule.fill(), m, &brush, brush_transform, &path);
            });
            Ok(touched)
        }
        CanvasOp::Stroke(st) => {
            let path = parse(&st.path)?;
            let m = matrix * state.matrix();
            let (brush, brush_transform) = brush(&st.paint, state.a, drawing.images)?;
            let stroke = st.line.stroke();
            let reach = st.line.reach();
            blended(scene, state.blend, matrix, canvas, m, &path, reach, |s| {
                s.stroke(&stroke, m, &brush, brush_transform, &path);
            });
            Ok(m.transform_rect_bbox(path.bounding_box().inflate(reach, reach)))
        }
        CanvasOp::Text(t) => text(scene, drawing, t, state, matrix, canvas),
        CanvasOp::Image(i) => image(scene, drawing, i, state, matrix, canvas),
        CanvasOp::Clip(_) | CanvasOp::Unclip => unreachable!("clips are not drawn"),
    }
}

/// Draws `op` as `draw` does, but through `drawing.effects`: alone first, run
/// through the filter and the shadow's blur, then the shadow and the result
/// composited, each with the command's alpha and blend mode.
fn draw_with_effects(
    scene: &mut vello::Scene,
    drawing: &mut Drawing,
    op: &CanvasOp,
    state: &DrawState,
    matrix: Affine,
    canvas: Rect,
) -> Result<()> {
    let mut alone = vello::Scene::new();
    let bounds = draw(&mut alone, drawing, op, &state.bare(), matrix, canvas)?;
    let filter = filter_effects(&state.filter, matrix);
    let shadow = state.shadow.as_ref().map(|s| s.resolved(matrix));
    let pictures = draws_pictures(std::slice::from_ref(op));
    let effects = drawing
        .effects
        .as_mut()
        .expect("the caller checked for effects");
    let rendered = effects.run(&alone, pictures, bounds, &filter, shadow.as_ref())?;
    if let Some(shadow) = &rendered.shadow {
        place(scene, state, matrix, canvas, shadow);
    }
    if state.filter.is_empty() {
        draw(scene, drawing, op, state, matrix, canvas)?;
    } else if let Some(shape) = &rendered.shape {
        place(scene, state, matrix, canvas, shape);
    }
    Ok(())
}

/// Composites a picture a shadow or a filter made, with the alpha and blend
/// mode of `state`.
fn place(
    scene: &mut vello::Scene,
    state: &DrawState,
    canvas_matrix: Affine,
    canvas: Rect,
    placed: &Placed,
) {
    let size = (
        f64::from(placed.image.width),
        f64::from(placed.image.height),
    );
    let rect = Rect::from_origin_size((0.0, 0.0), size);
    let at = Affine::translate(placed.at);
    // Whole pixels on whole pixels: no sampling filter would change them.
    let brush = peniko::Brush::Image(peniko::ImageBrush {
        image: placed.image.clone(),
        sampler: peniko::ImageSampler {
            quality: peniko::ImageQuality::Low,
            ..Default::default()
        },
    })
    .multiply_alpha(state.a);
    let path = Rect::from_origin_size(placed.at, size).into_path(0.1);
    blended(
        scene,
        state.blend,
        canvas_matrix,
        canvas,
        Affine::IDENTITY,
        &path,
        0.0,
        |s| s.fill(Fill::NonZero, at, &brush, None, &rect),
    );
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
            m,
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
            (brush.multiply_alpha(alpha), m.map(Affine::new))
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
        CanvasSource::Layer { id } => images
            .get(&layer_key(id))
            .cloned()
            .map(Some)
            .ok_or_else(|| {
                Error::Render(format!(
                    "canvas: the layer {id:?} is not a picture here (only a canvas pass draws its children)"
                ))
            }),
        CanvasSource::Canvas { .. } => Ok(None),
    }
}

fn image(
    scene: &mut vello::Scene,
    drawing: &mut Drawing,
    op: &ImageOp,
    state: &DrawState,
    canvas_matrix: Affine,
    canvas: Rect,
) -> Result<Rect> {
    let m = canvas_matrix * state.matrix();
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
        CanvasSource::Layer { id } => match drawing.images.get(&layer_key(id)) {
            Some(i) => (f64::from(i.width), f64::from(i.height)),
            None => {
                return Err(Error::Render(format!(
                    "canvas: the layer {id:?} is not a picture here (only a canvas pass draws its children)"
                )));
            }
        },
        CanvasSource::Canvas { width, height, .. } => (*width, *height),
    };
    let (sx, sy) = (op.sx.unwrap_or(0.0), op.sy.unwrap_or(0.0));
    let (sw, sh) = (op.sw.unwrap_or(natural_w), op.sh.unwrap_or(natural_h));
    if !(sw > 0.0 && sh > 0.0 && op.dw != 0.0 && op.dh != 0.0 && natural_w > 0.0 && natural_h > 0.0)
    {
        return Ok(Rect::ZERO);
    }
    // The source rectangle onto the destination one. A negative `dw` or `dh`
    // flips, as the canvas does.
    let to_dest = Affine::translate((op.dx, op.dy))
        * Affine::scale_non_uniform(op.dw / sw, op.dh / sh)
        * Affine::translate((-sx, -sy));
    let dest = dest.abs();
    let touched = m.transform_rect_bbox(dest.inflate(1.0, 1.0));
    let Some(mode) = state.blend.mode() else {
        scene.push_clip_layer(Fill::NonZero, m, &dest);
        draw_source(scene, drawing, &op.source, m * to_dest, op, state.a)?;
        scene.pop_layer();
        return Ok(touched);
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
    Ok(touched)
}

/// Draws a fill whose paint is a pattern of another canvas: clips to `path`
/// and draws one tile per `(i, j)` covering the path's box in tile space.
#[allow(clippy::too_many_arguments)]
fn fill_canvas_pattern(
    scene: &mut vello::Scene,
    drawing: &mut Drawing,
    rule: Fill,
    path: &BezPath,
    state: &DrawState,
    canvas_matrix: Affine,
    canvas: Rect,
    m: Affine,
    (width, height): (f64, f64),
    commands: &[CanvasOp],
    (repeat_x, repeat_y): (bool, bool),
    pattern_m: Affine,
) -> Result<()> {
    if !(width > 0.0 && height > 0.0 && width.is_finite() && height.is_finite()) {
        return Ok(());
    }
    let base = m * pattern_m;
    let det = base.determinant();
    if det == 0.0 || !det.is_finite() {
        return Ok(());
    }
    let path_bbox = m.transform_rect_bbox(path.bounding_box());
    let tile_bbox = base.inverse().transform_rect_bbox(path_bbox);
    let xs = if repeat_x {
        (tile_bbox.x0 / width).floor() as i64..(tile_bbox.x1 / width).ceil() as i64
    } else {
        0..1
    };
    let ys = if repeat_y {
        (tile_bbox.y0 / height).floor() as i64..(tile_bbox.y1 / height).ceil() as i64
    } else {
        0..1
    };
    let nx = i128::from((xs.end - xs.start).max(0));
    let ny = i128::from((ys.end - ys.start).max(0));
    let tiles = nx * ny;
    if tiles > 10_000 {
        return Err(Error::Render(format!(
            "canvas: a pattern of a canvas would need {tiles} tiles; at most 10000"
        )));
    }
    let mut err = Ok(());
    blended(
        scene,
        state.blend,
        canvas_matrix,
        canvas,
        m,
        path,
        1.0,
        |s| {
            s.push_clip_layer(rule, m, path);
            'tiles: for j in ys {
                for i in xs.clone() {
                    let tile = base * Affine::translate((i as f64 * width, j as f64 * height));
                    if let Err(e) =
                        draw_canvas(s, drawing, (width, height), commands, tile, state.a)
                    {
                        err = Err(e);
                        break 'tiles;
                    }
                }
            }
            s.pop_layer();
        },
    );
    err
}

fn draw_canvas(
    scene: &mut vello::Scene,
    drawing: &mut Drawing,
    (width, height): (f64, f64),
    commands: &[CanvasOp],
    matrix: Affine,
    alpha: f32,
) -> Result<()> {
    // A canvas drawn into another is composited as a whole, so its own
    // commands are drawn in a layer that takes the alpha.
    let bounds = Rect::new(0.0, 0.0, width, height);
    scene.push_layer(
        Fill::NonZero,
        peniko::BlendMode::new(peniko::Mix::Normal, peniko::Compose::SrcOver),
        alpha,
        matrix,
        &bounds,
    );
    encode(scene, drawing, (width, height), commands, matrix)?;
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
        return draw_canvas(scene, drawing, (*width, *height), commands, matrix, alpha);
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
    state: &DrawState,
    canvas_matrix: Affine,
    canvas: Rect,
) -> Result<Rect> {
    if op.text.is_empty() || op.size.is_nan() || op.size <= 0.0 {
        return Ok(Rect::ZERO);
    }
    let laid = drawing
        .text
        .layout(&op.text, &op.font, op.size, None, None, TextAlign::Left);
    let Some(line) = laid.lines.first() else {
        return Ok(Rect::ZERO);
    };
    let spaced = op.letter_spacing != 0.0 || op.word_spacing != 0.0;
    let mut spaces_before = Vec::new();
    let width = if spaced {
        let mut spaces = 0_u32;
        for c in op.text.chars() {
            spaces_before.push(spaces);
            if c == ' ' {
                spaces += 1;
            }
        }
        spaces_before.push(spaces);
        let chars = (spaces_before.len() - 1) as f64;
        (f64::from(laid.width) + op.letter_spacing * chars + op.word_spacing * f64::from(spaces))
            .max(0.0)
    } else {
        f64::from(laid.width)
    };
    // `maxWidth` squeezes wider text to fit, as the canvas does.
    let squeeze = match op.max_width {
        Some(max) if max > 0.0 && width > max => max / width,
        Some(max) if max <= 0.0 => return Ok(Rect::ZERO),
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
    let m = canvas_matrix * state.matrix() * origin;
    let (brush, brush_transform) = brush(&op.paint, state.a, drawing.images)?;
    let stroke = op.line.as_ref().map(LineStyle::stroke);
    let reach = op.line.as_ref().map_or(0.0, LineStyle::reach);
    let mut touched = Rect::new(
        0.0,
        0.0,
        width.max(f64::from(laid.width)),
        f64::from(laid.height),
    );
    if spaced {
        for g in laid.runs.iter().flat_map(|r| &r.glyphs) {
            let k = g.char_index as usize;
            let w = spaces_before.get(k).copied().unwrap_or(0);
            let gx =
                f64::from(g.x) + op.letter_spacing * (k as f64) + op.word_spacing * f64::from(w);
            touched = touched
                .union_pt((gx, f64::from(g.y)))
                .union_pt((gx + f64::from(g.advance), f64::from(g.y)));
        }
    }
    let touched = touched.inflate(reach, reach);
    let mode = state.blend.mode();
    match mode {
        Some(mode) if state.blend.reaches_whole_canvas() => {
            scene.push_layer(Fill::NonZero, mode, 1.0, canvas_matrix, &canvas);
        }
        Some(mode) => scene.push_layer(Fill::NonZero, mode, 1.0, m, &touched),
        None => {}
    }
    for run in &laid.runs {
        let glyphs = run.glyphs.iter().map(|g| {
            let x = if spaced {
                let k = g.char_index as usize;
                let w = spaces_before.get(k).copied().unwrap_or(0);
                (f64::from(g.x) + op.letter_spacing * (k as f64) + op.word_spacing * f64::from(w))
                    as f32
            } else {
                g.x
            };
            vello::Glyph {
                id: g.id,
                x,
                y: g.y,
            }
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
    // Ink may reach past the line box by about a font size (`text_bounds`).
    let em = f64::from(op.size);
    Ok(m.transform_rect_bbox(touched.inflate(em, em)))
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
    fn text_spacing_and_pattern_matrix_deserialize_with_defaults() {
        let parsed = ops(
            r##"[{"op": "text", "text": "a b", "font": "DM Sans", "size": 12, "x": 0, "y": 0,
                  "letterSpacing": 2.5, "wordSpacing": -1.0,
                  "paint": {"type": "pattern",
                            "source": {"kind": "src", "src": "a.png"},
                            "m": [2, 0, 0, 2, 1, 3]}},
                {"op": "text", "text": "a b", "font": "DM Sans", "size": 12, "x": 0, "y": 0,
                  "paint": {"type": "pattern", "source": {"kind": "src", "src": "a.png"}}}]"##,
        );
        let CanvasOp::Text(t0) = &parsed[0] else {
            panic!("not text");
        };
        assert_eq!(t0.letter_spacing, 2.5);
        assert_eq!(t0.word_spacing, -1.0);
        assert!(matches!(
            t0.paint,
            CanvasPaint::Pattern {
                m: Some([2.0, 0.0, 0.0, 2.0, 1.0, 3.0]),
                ..
            }
        ));
        let CanvasOp::Text(t1) = &parsed[1] else {
            panic!("not text");
        };
        assert_eq!(t1.letter_spacing, 0.0);
        assert_eq!(t1.word_spacing, 0.0);
        assert!(matches!(t1.paint, CanvasPaint::Pattern { m: None, .. }));
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

    const SHADOWED: &str = r##"{"op": "fill", "path": "M0 0H4V4Z", "paint": {"type": "color", "color": "#fff"},
        "shadow": {"color": "#00000080", "blur": 12, "x": 3, "y": -2}}"##;

    #[test]
    fn a_shadow_blurs_with_half_its_blur_as_the_deviation() {
        let parsed = ops(&format!("[{SHADOWED}]"));
        let shadow = parsed[0].state().unwrap().shadow.as_ref().unwrap();
        let resolved = shadow.resolved(Affine::IDENTITY);
        assert_eq!((resolved.x, resolved.y, resolved.blur), (3.0, -2.0, 6.0));
        // The layer's scale and turn reach it: doubled, then a quarter turn.
        let scaled = shadow.resolved(Affine::scale(2.0));
        assert_eq!((scaled.x, scaled.y, scaled.blur), (6.0, -4.0, 12.0));
        let turned = shadow.resolved(Affine::rotate(std::f64::consts::FRAC_PI_2));
        assert!((turned.x - 2.0).abs() < 1e-5 && (turned.y - 3.0).abs() < 1e-5);
        assert!((turned.blur - 6.0).abs() < 1e-5);
        assert_eq!(resolved.spread, 0.0);
        assert_eq!(resolved.color, Color::parse("#00000080").unwrap());
        // A blur past the limit is held to it.
        let huge = CanvasShadow {
            blur: 10_000.0,
            ..shadow.clone()
        };
        assert_eq!(huge.resolved(Affine::IDENTITY).blur, MAX_SHADOW_SIZE as f32);
    }

    #[test]
    fn a_filter_list_runs_the_scenes_passes_and_merges_colour_filters() {
        let parsed = ops(
            r##"[{"op": "fill", "path": "M0 0H4V4Z", "paint": {"type": "color", "color": "#fff"},
                  "filter": [{"type": "brightness", "amount": 2}, {"type": "invert", "amount": 1},
                             {"type": "blur", "radius": 3},
                             {"type": "hueRotate", "angle": 90}, {"type": "sepia", "amount": 0.5},
                             {"type": "dropShadow", "x": 1, "y": 2, "blur": 4, "color": "#f00"}]}]"##,
        );
        let filter = &parsed[0].state().unwrap().filter;
        let effects = filter_effects(filter, Affine::IDENTITY);
        assert!(matches!(
            effects[..],
            [
                ResolvedEffect::ColorMatrix(_),
                ResolvedEffect::Blur { radius: 3.0 },
                ResolvedEffect::ColorMatrix(_),
                ResolvedEffect::DropShadow(_),
            ]
        ));
        let (ResolvedEffect::ColorMatrix(first), ResolvedEffect::DropShadow(shadow)) =
            (&effects[0], &effects[3])
        else {
            unreachable!();
        };
        assert_eq!(
            *first,
            crate::color::ColorMatrix::brightness(2.0)
                .then(&crate::color::ColorMatrix::invert(1.0))
        );
        assert_eq!((shadow.x, shadow.y, shadow.blur), (1.0, 2.0, 4.0));
        // A layer scaled by 2 doubles the lengths of the blur and the drop shadow.
        let effects = filter_effects(filter, Affine::scale(2.0));
        assert!(matches!(effects[1], ResolvedEffect::Blur { radius: 6.0 }));
        let ResolvedEffect::DropShadow(shadow) = &effects[3] else {
            unreachable!();
        };
        assert_eq!((shadow.x, shadow.y, shadow.blur), (2.0, 4.0, 8.0));
    }

    #[test]
    fn only_commands_with_a_shadow_or_a_filter_need_the_effects() {
        let plain = ops(
            r##"[{"op": "fill", "path": "M0 0H4V4Z", "paint": {"type": "color", "color": "#fff"}},
                {"op": "clip", "path": "M0 0H4V4Z"}, {"op": "unclip"}]"##,
        );
        assert!(!has_effects(&plain) && !draws_pictures(&plain));
        let shadowed = ops(&format!("[{SHADOWED}]"));
        assert!(has_effects(&shadowed) && draws_pictures(&shadowed));
        let filtered = ops(
            r##"[{"op": "stroke", "path": "M0 0L4 4", "paint": {"type": "color", "color": "#fff"},
                  "filter": [{"type": "blur", "radius": 1}]}]"##,
        );
        assert!(has_effects(&filtered) && draws_pictures(&filtered));
        // Inside a canvas another draws.
        let nested = ops(&format!(
            r##"[{{"op": "image", "source": {{"kind": "canvas", "width": 4, "height": 4,
                  "commands": [{SHADOWED}]}}, "dx": 0, "dy": 0, "dw": 4, "dh": 4}}]"##
        ));
        assert!(has_effects(&nested));
    }
}
