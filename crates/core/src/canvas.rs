//! Canvas 2D: the commands a `CanvasRenderingContext2D` was given in a frame,
//! drawn into one layer with Skia (`render/skia/draw/canvas2d.rs`; packages/cli/skills/kinetograph/references/SCENE.md, "canvas").
//!
//! The authoring side (`@kinetographdev/scene`'s `createCanvasContext`) keeps the
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
//! A command with a shadow or a `filter` is drawn by Skia's image filters, composited
//! where the command stands in the list with its alpha, blend mode and clip.

use std::sync::Arc;

use base64::Engine as _;
use serde::Deserialize;
use kurbo::{Affine, BezPath};
use peniko::{Blob, ImageAlphaType, ImageData, ImageFormat};

use crate::anim::Num;
use crate::color::Color;
use crate::resolve::{Clock, ResolvedEffect, resolve_effects};
use crate::scene::{Effect, Shadow};

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

    /// Whether the command is drawn alone first and run through GPU passes.
    pub(crate) fn has_effects(&self) -> bool {
        self.shadow.is_some() || !self.filter.is_empty()
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
    /// `url(#id)`, not found: the painter of a page (`crates/dom`) turns one
    /// that names an SVG `<filter>` of the document into `graph`. The rest of
    /// the list is drawn without it, and it is reported.
    Url {
        url: String,
    },
    /// An SVG `<filter>` (`crate::filter`), in the canvas's pixels: what a
    /// `url()` names.
    Graph {
        #[serde(deserialize_with = "graph_of")]
        graph: Box<crate::filter::ResolvedFilterGraph>,
    },
}

/// A `filterGraph` effect's spelling, checked as a scene's is, at its only
/// moment (its numbers are constants).
fn graph_of<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Box<crate::filter::ResolvedFilterGraph>, D::Error> {
    let graph = crate::filter::FilterGraph::deserialize(d)?;
    graph
        .validate("canvas", true)
        .map_err(serde::de::Error::custom)?;
    Ok(Box::new(graph.resolve(0.0)))
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

impl FilterFn {
    /// The scene effect that runs the function, with its lengths in the
    /// pixels the passes work in (`to_device` takes the canvas's to those);
    /// `None` for a `url()` and a filter graph.
    fn effect(&self, to_device: Affine) -> Option<Effect> {
        let num = Num::Const;
        Some(match *self {
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
            FilterFn::Url { .. } | FilterFn::Graph { .. } => return None,
        })
    }
}

/// The passes a `filter` list runs: the ones a layer's `blur`, colour filters
/// and `dropShadow` effects run, colour filters in a row merged into one.
/// A filter graph runs where it stands in the list; a `url()` not found is
/// left out.
pub(crate) fn filter_effects(filter: &[FilterFn], to_device: Affine) -> Vec<ResolvedEffect> {
    // The numbers are constants, so any moment gives the same passes.
    let clock = Clock {
        t: 0.0,
        frame: 0,
        fps: 30.0,
    };
    let mut out = Vec::new();
    let mut run: Vec<Effect> = Vec::new();
    for f in filter {
        match (f.effect(to_device), f) {
            (Some(effect), _) => run.push(effect),
            (None, FilterFn::Graph { graph }) => {
                out.extend(resolve_effects(&std::mem::take(&mut run), clock));
                out.push(ResolvedEffect::FilterGraph(graph.clone()));
            }
            (None, _) => {}
        }
    }
    out.extend(resolve_effects(&run, clock));
    out
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
    /// A picture of a video file: the one a `<video>` shows, or a `<Video>` clip shows at a scene frame, at `time`
    /// seconds after the file's first picture (SCENE.md "video", rule 5; `end` is where the clip ends, the stream's end
    /// when omitted). The file is opened on first use.
    Video {
        src: String,
        time: f64,
        end: Option<f64>,
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
        CanvasSource::Pixels { .. } | CanvasSource::Layer { .. } | CanvasSource::Video { .. } => {}
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
            CanvasSource::Video { .. } => {}
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

/// Whether any command draws a picture: a picture of a source or a pattern, or
/// what a shadow or a filter made.
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
            serde_json::from_str::<CanvasBlend>(&format!("\"{name}\""))
                .unwrap_or_else(|e| panic!("{name}: {e}"));
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

    const SHADOWED: &str = r##"{"op": "fill", "path": "M0 0H4V4Z", "paint": {"type": "color", "color": "#fff"},
        "shadow": {"color": "#00000080", "blur": 12, "x": 3, "y": -2}}"##;

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
    fn an_svg_filter_runs_where_it_stands_in_the_list_and_a_url_not_found_is_left_out() {
        let parsed = ops(
            r##"[{"op": "fill", "path": "M0 0H4V4Z", "paint": {"type": "color", "color": "#fff"},
                  "filter": [{"type": "blur", "radius": 1}, {"type": "url", "url": "url(#gone)"},
                             {"type": "graph", "graph": {"primitives": [{"primitive": "feGaussianBlur", "stdDeviation": 2}]}},
                             {"type": "invert", "amount": 1}]}]"##,
        );
        let effects = filter_effects(&parsed[0].state().unwrap().filter, Affine::IDENTITY);
        assert!(matches!(
            effects[..],
            [
                ResolvedEffect::Blur { radius: 1.0 },
                ResolvedEffect::FilterGraph(_),
                ResolvedEffect::ColorMatrix(_),
            ]
        ));
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
