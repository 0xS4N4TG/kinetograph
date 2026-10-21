//! A scene evaluated at one frame: every animated number is a plain value.

use std::sync::Arc;

use vello::kurbo::{Affine, BezPath, Rect, Shape};

use crate::anim::Num;
use crate::canvas::CanvasOp;
use crate::color::{Color, ColorMatrix};
use crate::error::{Error, Result};
use crate::scene::{
    AlignContent, AlignItems, AlignSelf, BlendMode, Channel, Clip, DitherMode, DotOrder, DotShape,
    Effect, Extend, FillRule, Fit, FlexBasis, FlexDirection, FlexWrap, Geometry, GlyphRun,
    Gradient, GradientGeometry, HalftoneShape, ImageLayer, JustifyContent, Layer, LayerKind,
    Layout, LayoutItem, MAX_DITHER_LEVELS, MAX_SHADOW_SIZE, MIN_DITHER_LEVELS, MaskMode, MatteMode,
    NoiseChannels, Paint, Position, Scene, Shadow, ShapeLayer, Spacing, Stop, StrokeCap,
    StrokeJoin, TextAlign, Transform, Turbulence, TurbulenceKind, Units,
};
use crate::text::TextEngine;
use crate::turbulence::MAX_OCTAVES;
use crate::video::{Clip as VideoClip, MediaTime};
use crate::warp;

/// The time a scene is evaluated at.
///
/// `t` is where keyframes are read, in frames and possibly fractional (motion
/// blur samples between frames); `frame` is the whole output frame being
/// rendered. Seeded noise that changes from frame to frame hashes `frame`,
/// so the sub-frame samples of one output frame share a pattern instead of
/// averaging it away. A custom shader's `kg.frame` and `kg.time` come from
/// `t`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Clock {
    pub t: f64,
    pub frame: u32,
    pub fps: f64,
}

#[derive(Clone, Debug)]
pub struct ResolvedScene {
    pub width: u32,
    pub height: u32,
    pub frame: u32,
    pub background: Color,
    /// `None` draws 3D transforms without perspective.
    pub camera: Option<ResolvedCamera>,
    pub layers: Vec<ResolvedLayer>,
}

/// The camera at one frame, in canvas pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResolvedCamera {
    /// Above 0.
    pub perspective: f64,
    /// Where the eye looks at the canvas.
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedLayer {
    pub id: String,
    pub transform: ResolvedTransform,
    pub opacity: f32,
    pub blend_mode: BlendMode,
    pub effects: Vec<ResolvedEffect>,
    pub clip: Option<ResolvedClip>,
    pub mask: Option<ResolvedMask>,
    pub matte: Option<ResolvedMatte>,
    pub kind: ResolvedKind,
    /// How the layer takes part in its parent's flex layout. Already applied
    /// to `transform` (and to the transforms of the sub-frames) by the time
    /// the scene is resolved; kept for the layout of the layers around it.
    pub item: Option<ResolvedItem>,
    /// The layer's motion blur: one complete copy of it (and of its subtree)
    /// per sub-frame, in time order, each resolved at its own time. Empty
    /// when the layer has no motion blur or its shutter is shut. The fields
    /// above are for the frame itself; a layer with sub-frames is drawn from
    /// these copies instead, and they have no sub-frames of their own
    /// (motion blur inside a blurred layer is ignored).
    pub motion: Vec<ResolvedLayer>,
}

/// A character's own style at one frame (`scene::CharStyle`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResolvedChar {
    /// Offset in text-box pixels.
    pub x: f64,
    pub y: f64,
    /// About the character's centre.
    pub scale: f64,
    /// Degrees clockwise, about the character's centre.
    pub rotation: f64,
    /// 0..=1.
    pub opacity: f32,
    pub color: Option<Color>,
}

/// A group's flex layout at one frame (`scene::Layout`), in pixels.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedLayout {
    pub direction: FlexDirection,
    pub wrap: FlexWrap,
    pub justify_content: JustifyContent,
    pub align_items: AlignItems,
    pub align_content: AlignContent,
    /// Between rows, between columns; not negative.
    pub gap: (f64, f64),
    /// Top, right, bottom, left; not negative.
    pub padding: [f64; 4],
    /// The size the group asked for; `None` is from the content.
    pub width: Option<f64>,
    pub height: Option<f64>,
    /// The group's transform origin as fractions of the size, which its
    /// layout is yet to give (`ResolvedTransform::origin_x`).
    pub origin: (f64, f64),
}

/// A layer's `layoutItem` at one frame, in pixels.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedItem {
    /// Out of the flow: the layout leaves it where its transform puts it.
    pub absolute: bool,
    pub grow: f64,
    pub shrink: f64,
    /// `None` is `auto`.
    pub basis: Option<f64>,
    pub align_self: AlignSelf,
    /// Top, right, bottom, left.
    pub margin: [f64; 4],
    pub width: Option<f64>,
    pub height: Option<f64>,
}

/// The widest shutter, in frames.
pub const MAX_SHUTTER: f64 = 2.0;

/// The times of a motion blur's `samples` sub-frames around `t`: the shutter
/// is cut into equal slots, centred on `t`, and each sub-frame sits in the
/// middle of its slot.
pub fn motion_times(t: f64, samples: u32, shutter: f64) -> Vec<f64> {
    (0..samples)
        .map(|i| t + shutter * ((f64::from(i) + 0.5) / f64::from(samples) - 0.5))
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResolvedTransform {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub rotation: f64,
    pub anchor_x: f64,
    pub anchor_y: f64,
    /// Degrees; see `scene::Transform`.
    pub rotate_x: f64,
    pub rotate_y: f64,
    /// Pixels toward the viewer.
    pub z: f64,
    /// The point of the layer's box (`originX` and `originY` times its size,
    /// in layer pixels, 0 for a layer without a box) that the layer turns and
    /// scales about, added to the anchor.
    pub origin_x: f64,
    pub origin_y: f64,
    /// `scene::Transform::matrix`.
    pub matrix: Option<[f64; 16]>,
    /// `scene::Transform::backface_hidden`.
    pub backface_hidden: bool,
}

impl ResolvedTransform {
    /// Layer space to parent space: move the anchor to the origin, scale,
    /// rotate, then translate to (x, y).
    ///
    /// The origin moves the pivot of the turn and the scale to the anchor plus
    /// the origin, and puts the layer back so that nothing moves while it is
    /// not turned or scaled: the pivot lands where it is without them.
    pub fn matrix(&self) -> Affine {
        let css = self
            .matrix
            .filter(crate::scene::matrix_is_affine_2d)
            .map_or(Affine::IDENTITY, |m| {
                Affine::new([m[0], m[1], m[4], m[5], m[12], m[13]])
            });
        if self.origin_x != 0.0 || self.origin_y != 0.0 {
            return Affine::translate((self.x + self.origin_x, self.y + self.origin_y))
                * Affine::rotate(self.rotation.to_radians())
                * Affine::scale(self.scale)
                * css
                * Affine::translate((
                    -(self.anchor_x + self.origin_x),
                    -(self.anchor_y + self.origin_y),
                ));
        }
        Affine::translate((self.x, self.y))
            * Affine::rotate(self.rotation.to_radians())
            * Affine::scale(self.scale)
            * css
            * Affine::translate((-self.anchor_x, -self.anchor_y))
    }
}

/// One variant per entry in `scene::Effect`.
#[derive(Clone, Debug, PartialEq)]
pub enum ResolvedEffect {
    /// Standard deviation in pixels.
    Blur {
        radius: f32,
    },
    /// Standard deviation in pixels of the blur applied to the backdrop.
    BackdropBlur {
        radius: f32,
    },
    Glow(ResolvedGlow),
    /// The red channel is read `amount` pixels along `angle` degrees
    /// (clockwise from +x), the blue one the same distance the other way.
    ChromaticAberration {
        amount: f32,
        angle: f32,
    },
    /// Cast onto what is behind the layer.
    DropShadow(ResolvedShadow),
    /// Cast inside the layer's own shape.
    InsetShadow(ResolvedShadow),
    /// One or more consecutive colour filters (`saturate`, `contrast`,
    /// `brightness`, `grayscale`, `sepia`, `invert`, `hueRotate`) composed
    /// into a single matrix.
    ColorMatrix(ColorMatrix),
    GradientMap(ResolvedGradientMap),
    /// `src` is the key of the table `lut::load_luts` read; `amount` is
    /// clamped to 0..=1.
    Lut {
        src: String,
        amount: f32,
    },
    Grain(ResolvedGrain),
    Dither(ResolvedDither),
    Halftone(ResolvedHalftone),
    DotMatrix(ResolvedDotMatrix),
    Displace(ResolvedDisplace),
    CornerPin(ResolvedCornerPin),
    FilterGraph(Box<crate::filter::ResolvedFilterGraph>),
    Shader(ResolvedShader),
}

/// A corner pin at one frame: where each corner of the layer's box goes, in
/// layer space, or `None` to leave it where the box has it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResolvedCornerPin {
    /// Top left, top right, bottom right, bottom left.
    pub corners: [Option<[f64; 2]>; 4],
}

impl ResolvedCornerPin {
    /// The four points the box `b` is pinned to, in the same order.
    pub fn points(&self, b: Rect) -> [[f64; 2]; 4] {
        let mut points = warp::rect_corners(b);
        for (point, pin) in points.iter_mut().zip(self.corners) {
            if let Some(pin) = pin {
                *point = pin;
            }
        }
        points
    }
}

/// A displacement at one frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResolvedDisplace {
    /// Layer pixels; 0 leaves the layer alone.
    pub scale: f32,
    pub x_channel: Channel,
    pub y_channel: Channel,
    pub turbulence: ResolvedTurbulence,
}

/// `feTurbulence` at one frame, in layer space.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResolvedTurbulence {
    /// `fractalNoise` rather than `turbulence`.
    pub fractal: bool,
    /// Per axis, not negative.
    pub frequency: [f32; 2],
    /// 0..=`turbulence::MAX_OCTAVES`.
    pub octaves: u32,
    /// The scene's number truncated toward zero; `turbulence::setup_seed`
    /// brings it into the generator's range.
    pub seed: i64,
}

/// A dot-matrix reveal at one frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResolvedDotMatrix {
    /// Layer pixels per cell, above 0.
    pub size: f32,
    /// 0..=1.
    pub progress: f32,
    pub order: DotOrder,
    /// Degrees clockwise from +x; the direction of a sweep.
    pub angle: f32,
    /// 0..1, below 1.
    pub stagger: f32,
    /// 0 for a sweep, which has no randomness.
    pub seed: u32,
    pub shape: DotShape,
}

/// A halftone at one frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResolvedHalftone {
    /// Layer pixels per cell, above 0.
    pub size: f32,
    /// Degrees, clockwise.
    pub angle: f32,
    pub shape: HalftoneShape,
    /// Dots take this colour (its alpha scales their coverage) instead of the
    /// layer's.
    pub color: Option<Color>,
    pub invert: bool,
}

/// Smallest halftone or dot-matrix cell, in layer pixels: a cell much smaller
/// than a pixel is noise, and it keeps the shader's division sane.
pub const MIN_HALFTONE_SIZE: f64 = 0.01;

/// The largest stagger a dot matrix uses: its dots grow over `1 - stagger` of
/// the progress, so 1 itself is not allowed.
const MAX_STAGGER: f64 = 0.999;

/// A dither at one frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResolvedDither {
    pub mode: DitherMode,
    /// Whole, `MIN_DITHER_LEVELS..=MAX_DITHER_LEVELS`.
    pub levels: u32,
    /// Canvas pixels per cell, at least 1.
    pub size: f32,
    /// 0 for an ordered dither, which has no randomness.
    pub seed: u32,
    /// What a random pattern hashes with: the output frame, or 0 when it does
    /// not animate (and always 0 for an ordered dither).
    pub frame: u32,
}

/// Grain at one frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResolvedGrain {
    /// 0..=1.
    pub amount: f32,
    /// Canvas pixels, at least 1.
    pub size: f32,
    pub seed: u32,
    /// What the pattern hashes with: the output frame, or 0 when the grain
    /// does not animate. Motion blur's sub-frames share their frame's
    /// pattern (`Clock::frame`).
    pub frame: u32,
    pub monochrome: bool,
}

/// A gradient map at one frame.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedGradientMap {
    /// `MIN_GRADIENT_MAP_STOPS..=MAX_GRADIENT_MAP_STOPS` stops, offsets in
    /// 0..=1 and never decreasing.
    pub stops: Vec<(f64, Color)>,
    /// 0..=1: how much of the graded image replaces the original.
    pub amount: f32,
}

/// A custom shader at one frame.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedShader {
    /// The whole WGSL module (`shader::compose`), which is also the key of
    /// the compositor's pipeline for it.
    pub source: String,
    /// The uniforms' values, in the order of their sorted names.
    pub values: Vec<f32>,
    pub frame: f32,
    /// Seconds: `frame / fps`.
    pub time: f32,
}

/// A glow at one frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResolvedGlow {
    /// Standard deviation of the blur, 0..=`MAX_BLUR_RADIUS`.
    pub radius: f32,
    /// `None`: the halo has the layer's own colours.
    pub color: Option<Color>,
    /// 0..=`MAX_GLOW_INTENSITY`.
    pub intensity: f32,
}

/// A shadow at one frame, in canvas pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResolvedShadow {
    pub x: f32,
    pub y: f32,
    /// Standard deviation of the blur, 0..=`MAX_SHADOW_SIZE`.
    pub blur: f32,
    /// Growth of the shadow, -`MAX_SHADOW_SIZE`..=`MAX_SHADOW_SIZE`; negative
    /// shrinks it.
    pub spread: f32,
    pub color: Color,
}

/// A clip in layer space. Counterpart of `scene::Clip`.
#[derive(Clone, Debug, PartialEq)]
pub enum ResolvedClip {
    Polygon {
        points: Vec<(f64, f64)>,
    },
    Inset {
        top: f64,
        right: f64,
        bottom: f64,
        left: f64,
        radius: f64,
    },
    Ellipse {
        cx: f64,
        cy: f64,
        rx: f64,
        ry: f64,
    },
    Path {
        d: String,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedMask {
    pub gradient: ResolvedGradient,
    pub mode: MaskMode,
}

/// A group's GLSL pass at one frame: the recording drawn into a `width` x
/// `height` buffer whose `layer` textures are the group's children.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedGlsl {
    pub width: f64,
    pub height: f64,
    pub recording: crate::glsl::GlslRecording,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedMatte {
    /// The id of a sibling layer.
    pub layer: String,
    pub mode: MatteMode,
}

/// How a shape is filled and stroked, beyond its colours and the stroke's
/// width, at one frame.
#[derive(Clone, Debug, PartialEq)]
pub struct ShapeStyle {
    pub fill_rule: FillRule,
    pub cap: StrokeCap,
    pub join: StrokeJoin,
    pub miter_limit: f64,
    /// Dash lengths and gaps, alternating; empty for a solid line.
    pub dash: Vec<f64>,
    pub dash_offset: f64,
}

impl Default for ShapeStyle {
    fn default() -> ShapeStyle {
        ShapeStyle {
            fill_rule: FillRule::NonZero,
            cap: StrokeCap::Butt,
            join: StrokeJoin::Round,
            miter_limit: 4.0,
            dash: Vec::new(),
            dash_offset: 0.0,
        }
    }
}

impl ShapeStyle {
    fn resolve(shape: &ShapeLayer, f: f64) -> ShapeStyle {
        let mut style = ShapeStyle {
            fill_rule: shape.fill_rule,
            ..ShapeStyle::default()
        };
        if let Some(stroke) = &shape.stroke {
            style.cap = stroke.cap;
            style.join = stroke.join;
            style.miter_limit = stroke
                .miter_limit
                .as_ref()
                .map_or(4.0, |n| n.at(f))
                .max(1.0);
            let dash: Vec<f64> = stroke.dash_array.iter().map(|n| n.at(f)).collect();
            // A pattern that is empty, has a negative or no length is a solid
            // line, as in SVG.
            if dash.iter().all(|d| d.is_finite() && *d >= 0.0) && dash.iter().sum::<f64>() > 0.0 {
                style.dash = dash;
                style.dash_offset = stroke.dash_offset.as_ref().map_or(0.0, |n| n.at(f));
            }
        }
        style
    }
}

/// What a shape's fill or a text's colour paints with, at one frame.
#[derive(Clone, Debug, PartialEq)]
pub enum ResolvedPaint {
    Solid(Color),
    Gradient(ResolvedGradient),
    Image(ResolvedImagePaint),
}

/// `scene::ImagePaint` at one frame.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedImagePaint {
    pub src: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub repeat_x: bool,
    pub repeat_y: bool,
}

/// A gradient at one frame, in the space of whatever it paints.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedGradient {
    pub geometry: ResolvedGradientGeometry,
    /// At least 2 stops, offsets in 0..=1 and never decreasing.
    pub stops: Vec<(f64, Color)>,
    pub extend: Extend,
    /// Whether the coordinates are pixels of the painted layer or fractions
    /// of its box.
    pub units: Units,
    /// Takes the gradient's space (after `units`) to the painted layer's
    /// (`Gradient::transform`).
    pub transform: Affine,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ResolvedGradientGeometry {
    Linear {
        x0: f64,
        y0: f64,
        x1: f64,
        y1: f64,
    },
    Radial {
        cx: f64,
        cy: f64,
        r: f64,
    },
    /// A radial gradient that starts on the focal circle (`fx`, `fy`, `fr`).
    FocalRadial {
        cx: f64,
        cy: f64,
        r: f64,
        fx: f64,
        fy: f64,
        fr: f64,
    },
    /// `angle` in degrees clockwise from 12 o'clock.
    Conic {
        cx: f64,
        cy: f64,
        angle: f64,
    },
}

/// Largest radius of the backdrop blur and the glow; bigger values are clamped.
pub const MAX_BLUR_RADIUS: f64 = 128.0;

/// Largest radius of the `blur` effect; bigger values are clamped. The blur works on
/// a copy of the layer `3 * radius` larger on every side (shrunk by levels), so this
/// bounds its memory too.
pub const MAX_LAYER_BLUR_RADIUS: f64 = 512.0;

/// Largest glow intensity; bigger values are clamped.
pub const MAX_GLOW_INTENSITY: f64 = 4.0;

#[derive(Clone, Debug, PartialEq)]
pub enum ResolvedKind {
    Shape {
        geometry: ResolvedGeometry,
        fill: Option<ResolvedPaint>,
        stroke: Option<(Color, f64)>,
        /// The fill rule and how the stroke is drawn.
        style: ShapeStyle,
    },
    Text {
        text: String,
        font: String,
        size: f32,
        color: ResolvedPaint,
        /// Multiple of the font size.
        line_height: Option<f32>,
        max_width: Option<f32>,
        align: TextAlign,
        /// One entry per code point of `text` that has one: its own style, or
        /// `None` for a character drawn as the layer is.
        chars: Vec<Option<ResolvedChar>>,
        /// Glyphs positioned by someone else; when there are any, the fields
        /// above that shape text are not used (`scene::TextLayer::runs`).
        runs: Vec<GlyphRun>,
        /// The box of a layer with `runs`.
        box_size: (f32, f32),
    },
    Image {
        src: String,
        /// The box the picture is fitted to.
        width: f64,
        height: f64,
        fit: Fit,
    },
    Group {
        children: Vec<ResolvedLayer>,
        /// The children are drawn straight into the parent, depth sorted.
        preserve3d: bool,
        /// `GroupLayer::pass_through`.
        pass_through: bool,
        /// The flex layout the children were placed by.
        layout: Option<ResolvedLayout>,
        /// With a `layout`: the size it gave the group, whose box is
        /// `(0, 0, width, height)`.
        size: Option<(f64, f64)>,
        /// `GroupLayer::glsl`: a GLSL pass in the box `(0, 0, width,
        /// height)` over the children, which are its textures.
        glsl: Option<ResolvedGlsl>,
    },
    /// A Lottie animation fitted into the box `(0, 0, width, height)`.
    Lottie {
        src: String,
        width: f64,
        height: f64,
        /// Seconds into the animation.
        time: f64,
        looped: bool,
    },
    /// A video's picture fitted into the box `(0, 0, width, height)` like an
    /// image.
    Video {
        src: String,
        width: f64,
        height: f64,
        fit: Fit,
        /// The time in the file and the picture it picks.
        time: MediaTime,
    },
    /// A GIF's picture fitted into the box `(0, 0, width, height)` like an
    /// image.
    Gif {
        src: String,
        width: f64,
        height: f64,
        fit: Fit,
        /// Seconds into the animation.
        time: f64,
        looped: bool,
    },
    /// What a Canvas 2D context drew, in the box `(0, 0, width, height)`.
    Canvas {
        width: f64,
        height: f64,
        ops: Arc<Vec<CanvasOp>>,
    },
    /// What a WebGL context drew, in the box `(0, 0, width, height)`.
    Glsl {
        width: f64,
        height: f64,
        recording: crate::glsl::GlslRecording,
    },
    /// A 3D scene drawn into the box `(0, 0, width, height)`.
    Scene3d {
        width: f64,
        height: f64,
        scene: Arc<crate::scene3d::Resolved3d>,
    },
    /// A grid of coloured points; the box `(0, 0, width, height)` in layer
    /// space is where the points are when none are given.
    MeshGradient {
        width: f64,
        height: f64,
        columns: usize,
        rows: usize,
        /// Row-major, in layer space.
        points: Vec<[f64; 2]>,
        colors: Vec<Color>,
    },
    /// The noise over the box `(0, 0, width, height)` in layer space.
    Noise {
        width: f64,
        height: f64,
        turbulence: ResolvedTurbulence,
        channels: NoiseChannels,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum ResolvedGeometry {
    Rect {
        width: f64,
        height: f64,
    },
    RoundedRect {
        width: f64,
        height: f64,
        radius: f64,
    },
    Ellipse {
        width: f64,
        height: f64,
    },
    Path {
        d: String,
    },
}

impl Scene {
    /// Evaluates every animated value at `frame`. Errors if the frame is
    /// outside `0..durationInFrames`.
    ///
    /// Text is measured only where a resolved value depends on it (a text
    /// layer's transform origin), with a text engine built for the call from
    /// the scene's fonts. A caller that has an engine, as the renderer does,
    /// passes it to `resolve_with_text` instead.
    pub fn resolve(&self, frame: u32) -> Result<ResolvedScene> {
        self.resolve_with(frame, TextHandle::Lazy(None))
    }

    /// Like `resolve`, measuring text with `text`, whose fonts must be the
    /// scene's (`TextEngine::new(&scene.fonts, &scene.base_dir)`).
    pub fn resolve_with_text(&self, frame: u32, text: &mut TextEngine) -> Result<ResolvedScene> {
        self.resolve_with(frame, TextHandle::Given(text))
    }

    fn resolve_with(&self, frame: u32, text: TextHandle) -> Result<ResolvedScene> {
        if frame >= self.duration_in_frames {
            return Err(Error::FrameOutOfRange {
                frame,
                duration: self.duration_in_frames,
            });
        }
        let clock = Clock {
            t: f64::from(frame),
            frame,
            fps: self.fps,
        };
        let mut resolver = Resolver { scene: self, text };
        let mut layers = Vec::with_capacity(self.layers.len());
        for layer in &self.layers {
            layers.push(resolver.layer(layer, clock, true)?);
        }
        resolver.lay_out(&mut layers)?;
        Ok(ResolvedScene {
            width: self.width,
            height: self.height,
            frame,
            background: self.background,
            camera: self.camera.as_ref().map(|c| ResolvedCamera {
                perspective: c.perspective.at(clock.t),
                x: c.x
                    .as_ref()
                    .map_or(f64::from(self.width) / 2.0, |n| n.at(clock.t)),
                y: c.y
                    .as_ref()
                    .map_or(f64::from(self.height) / 2.0, |n| n.at(clock.t)),
            }),
            layers,
        })
    }
}

/// The text engine a resolve measures with.
enum TextHandle<'a> {
    Given(&'a mut TextEngine),
    /// Built when first needed, from the scene's fonts.
    Lazy(Option<Box<TextEngine>>),
}

/// Evaluates the layers of one scene.
pub(crate) struct Resolver<'a> {
    pub(crate) scene: &'a Scene,
    text: TextHandle<'a>,
}

impl Resolver<'_> {
    pub(crate) fn engine(&mut self) -> Result<&mut TextEngine> {
        match &mut self.text {
            TextHandle::Given(engine) => Ok(engine),
            TextHandle::Lazy(slot) => {
                if slot.is_none() {
                    *slot = Some(Box::new(TextEngine::new(
                        &self.scene.fonts,
                        &self.scene.base_dir,
                    )?));
                }
                Ok(&mut **slot.as_mut().expect("just built"))
            }
        }
    }

    /// The box of a resolved leaf layer in layer space (`docs/SCENE.md`,
    /// "Clip paths"), or `None` for a layer without one.
    pub(crate) fn layer_box(&mut self, kind: &ResolvedKind) -> Result<Option<Rect>> {
        Ok(match kind {
            ResolvedKind::Shape { geometry, .. } => Some(match geometry {
                ResolvedGeometry::Rect { width, height }
                | ResolvedGeometry::RoundedRect { width, height, .. }
                | ResolvedGeometry::Ellipse { width, height } => {
                    Rect::new(0.0, 0.0, *width, *height)
                }
                ResolvedGeometry::Path { d } => BezPath::from_svg(d)
                    .map_err(|e| Error::Scene(format!("bad SVG path {d:?}: {e}")))?
                    .bounding_box(),
            }),
            ResolvedKind::Text {
                text,
                font,
                size,
                line_height,
                max_width,
                align,
                runs,
                box_size,
                ..
            } => {
                let laid_out = self.engine()?.layout_layer(
                    text,
                    font,
                    *size,
                    *line_height,
                    *max_width,
                    *align,
                    runs,
                    *box_size,
                );
                let (width, height) = laid_out.box_size(*max_width);
                Some(Rect::new(0.0, 0.0, width, height))
            }
            ResolvedKind::Image { width, height, .. }
            | ResolvedKind::Lottie { width, height, .. }
            | ResolvedKind::Video { width, height, .. }
            | ResolvedKind::Gif { width, height, .. }
            | ResolvedKind::Noise { width, height, .. }
            | ResolvedKind::Canvas { width, height, .. }
            | ResolvedKind::Glsl { width, height, .. }
            | ResolvedKind::Scene3d { width, height, .. }
            | ResolvedKind::MeshGradient { width, height, .. } => {
                Some(Rect::new(0.0, 0.0, *width, *height))
            }
            ResolvedKind::Group { size, .. } => size.map(|(w, h)| Rect::new(0.0, 0.0, w, h)),
        })
    }

    /// The width and height of an image whose layer leaves a side out: the
    /// file's size, which the scene read when it loaded.
    fn natural_size(&self, layer: &Layer, src: &str) -> Result<(f64, f64)> {
        self.scene.asset_sizes.get(src).copied().ok_or_else(|| {
            Error::Render(format!(
                "layer {:?}: the size of {src:?} was not read when the scene loaded",
                layer.id
            ))
        })
    }

    /// `blur` is whether a motion blur on `layer` or below counts; a
    /// sub-frame's copy is resolved without it.
    fn layer(&mut self, layer: &Layer, clock: Clock, blur: bool) -> Result<ResolvedLayer> {
        let f = clock.t;
        let motion = match &layer.motion_blur {
            Some(mb) if blur => {
                let shutter = mb.shutter.at(f).clamp(0.0, MAX_SHUTTER);
                // A shut shutter is exactly the layer without motion blur.
                if shutter > 0.0 {
                    // Checked when the scene loaded.
                    let mut subs = Vec::new();
                    for (i, t) in motion_times(f, mb.samples as u32, shutter)
                        .into_iter()
                        .enumerate()
                    {
                        // The authoring layer's own copy for this sub-frame,
                        // when it gave them.
                        let source = mb
                            .frames
                            .as_ref()
                            .and_then(|frames| frames.get(i))
                            .unwrap_or(layer);
                        let mut sub = self.layer(source, Clock { t, ..clock }, false)?;
                        sub.id.clone_from(&layer.id);
                        subs.push(sub);
                    }
                    subs
                } else {
                    Vec::new()
                }
            }
            _ => Vec::new(),
        };
        // The frame's own children are not drawn when the layer has sub-frames.
        let blur = blur && motion.is_empty();
        let kind = self.kind(layer, clock, blur)?;
        let transform = self.transform(&layer.transform, f, &kind)?;
        Ok(ResolvedLayer {
            id: layer.id.clone(),
            transform,
            opacity: layer.opacity.at(f).clamp(0.0, 1.0) as f32,
            blend_mode: layer.blend_mode,
            effects: resolve_effects(&layer.effects, clock),
            clip: layer.clip.as_ref().map(|c| resolve_clip(c, f)),
            mask: layer.mask.as_ref().map(|m| ResolvedMask {
                gradient: resolve_gradient(&m.gradient, f),
                mode: m.mode,
            }),
            matte: layer.matte.as_ref().map(|m| ResolvedMatte {
                layer: m.layer.clone(),
                mode: m.mode,
            }),
            kind,
            item: layer.layout_item.as_ref().map(|i| resolve_item(i, f)),
            motion,
        })
    }

    /// The transform at time `f`. Its origin, a fraction of the layer's box,
    /// is turned into pixels from the box's top-left corner here (a path's box
    /// need not start at 0, 0). The box is only worked out when an origin is
    /// given, animated or not zero, since measuring text costs a layout; an
    /// origin left at 0, 0 keeps the pivot at the anchor.
    fn transform(
        &mut self,
        t: &Transform,
        f: f64,
        kind: &ResolvedKind,
    ) -> Result<ResolvedTransform> {
        let mut resolved = resolve_transform(t, f);
        let given = |n: &Num| !matches!(n, Num::Const(v) if *v == 0.0);
        if (given(&t.origin_x) || given(&t.origin_y))
            && let Some(b) = self.layer_box(kind)?
        {
            resolved.origin_x = b.x0 + t.origin_x.at(f) * b.width();
            resolved.origin_y = b.y0 + t.origin_y.at(f) * b.height();
        }
        Ok(resolved)
    }

    fn kind(&mut self, layer: &Layer, clock: Clock, blur: bool) -> Result<ResolvedKind> {
        let f = clock.t;
        Ok(match &layer.kind {
            LayerKind::Shape(s) => ResolvedKind::Shape {
                geometry: match &s.shape {
                    Geometry::Rect { width, height } => ResolvedGeometry::Rect {
                        width: width.at(f),
                        height: height.at(f),
                    },
                    Geometry::RoundedRect {
                        width,
                        height,
                        radius,
                    } => ResolvedGeometry::RoundedRect {
                        width: width.at(f),
                        height: height.at(f),
                        radius: radius.at(f),
                    },
                    Geometry::Ellipse { width, height } => ResolvedGeometry::Ellipse {
                        width: width.at(f),
                        height: height.at(f),
                    },
                    Geometry::Path { d } => ResolvedGeometry::Path { d: d.clone() },
                },
                fill: s.fill.as_ref().map(|p| resolve_paint(p, f)),
                stroke: s.stroke.as_ref().map(|st| (st.color, st.width.at(f))),
                style: ShapeStyle::resolve(s, f),
            },
            LayerKind::Text(t) => ResolvedKind::Text {
                text: t.text.clone(),
                font: t.font.clone(),
                size: t.size.at(f) as f32,
                color: resolve_paint(&t.color, f),
                line_height: t.line_height.as_ref().map(|n| n.at(f) as f32),
                max_width: t.max_width.as_ref().map(|n| n.at(f) as f32),
                align: t.align,
                chars: t
                    .chars
                    .iter()
                    .map(|c| {
                        c.as_ref().map(|c| ResolvedChar {
                            x: c.x.at(f),
                            y: c.y.at(f),
                            scale: c.scale.at(f),
                            rotation: c.rotation.at(f),
                            opacity: c.opacity.at(f).clamp(0.0, 1.0) as f32,
                            color: c.color,
                        })
                    })
                    .collect(),
                runs: t.runs.clone(),
                box_size: (
                    t.box_width.as_ref().map_or(0.0, |n| n.at(f) as f32),
                    t.box_height.as_ref().map_or(0.0, |n| n.at(f) as f32),
                ),
            },
            LayerKind::Image(i) => {
                let (width, height) = self.image_size(layer, i, f)?;
                ResolvedKind::Image {
                    src: i.src.clone(),
                    width,
                    height,
                    fit: i.fit,
                }
            }
            LayerKind::Group(g) => ResolvedKind::Group {
                layout: g
                    .layout
                    .as_ref()
                    .map(|l| resolve_layout(l, &layer.transform, f)),
                size: None,
                children: {
                    let mut children = Vec::with_capacity(g.children.len());
                    for child in &g.children {
                        children.push(self.layer(child, clock, blur)?);
                    }
                    children
                },
                preserve3d: g.preserve3d,
                pass_through: g.pass_through,
                glsl: g.glsl.as_ref().map(|glsl| ResolvedGlsl {
                    width: glsl.width.at(f),
                    height: glsl.height.at(f),
                    recording: glsl.recording.clone(),
                }),
            },
            LayerKind::Lottie(l) => {
                let (width, height) = self.box_size(layer, &l.src, &l.width, &l.height, f)?;
                ResolvedKind::Lottie {
                    src: l.src.clone(),
                    width,
                    height,
                    time: l.time.as_ref().map_or(clock.t / clock.fps, |n| n.at(f)),
                    looped: l.looped,
                }
            }
            LayerKind::Video(v) => {
                let (width, height) = self.box_size(layer, &v.src, &v.width, &v.height, f)?;
                let info = self.scene.videos.get(&v.src).ok_or_else(|| {
                    Error::Render(format!(
                        "layer {:?}: the container of {:?} was not read when the scene loaded",
                        layer.id, v.src
                    ))
                })?;
                // The scene frame the clip's clock reads: the frame being
                // rendered, sub-frames at their own times.
                let frame = v.frame.as_ref().map_or(clock.t, |n| n.at(f));
                let clip = VideoClip::from(v);
                let seconds = clip.source_time(frame, clock.fps, info.duration);
                ResolvedKind::Video {
                    src: v.src.clone(),
                    width,
                    height,
                    fit: v.fit,
                    time: info.media_time(seconds, clip.end(clock.fps, info.duration)),
                }
            }
            LayerKind::Gif(g) => {
                let (width, height) = self.box_size(layer, &g.src, &g.width, &g.height, f)?;
                ResolvedKind::Gif {
                    src: g.src.clone(),
                    width,
                    height,
                    fit: g.fit,
                    time: g.time.as_ref().map_or(clock.t / clock.fps, |n| n.at(f)),
                    looped: g.looped,
                }
            }
            LayerKind::MeshGradient(m) => {
                let (width, height) = (m.width.at(f), m.height.at(f));
                let (columns, rows) = (m.columns as usize, m.rows as usize);
                ResolvedKind::MeshGradient {
                    width,
                    height,
                    columns,
                    rows,
                    points: match &m.points {
                        Some(points) => points.iter().map(|[x, y]| [x.at(f), y.at(f)]).collect(),
                        // Evenly spaced over the box, a row at a time.
                        None => (0..rows)
                            .flat_map(|j| {
                                (0..columns).map(move |i| {
                                    [
                                        width * i as f64 / (columns - 1) as f64,
                                        height * j as f64 / (rows - 1) as f64,
                                    ]
                                })
                            })
                            .collect(),
                    },
                    colors: m.colors.clone(),
                }
            }
            LayerKind::Canvas(c) => ResolvedKind::Canvas {
                width: c.width.at(f),
                height: c.height.at(f),
                ops: c.commands.0.clone(),
            },
            LayerKind::Glsl(g) => ResolvedKind::Glsl {
                width: g.width.at(f),
                height: g.height.at(f),
                recording: g.recording.clone(),
            },
            LayerKind::Scene3d(s) => ResolvedKind::Scene3d {
                width: s.width.at(f),
                height: s.height.at(f),
                scene: Arc::new(s.resolve(&layer.id, f, clock.t / clock.fps)?),
            },
            LayerKind::Noise(n) => ResolvedKind::Noise {
                width: n.width.at(f),
                height: n.height.at(f),
                turbulence: resolve_turbulence(&n.turbulence, f),
                channels: n.channels,
            },
        })
    }

    /// The box of an image at time `f`: the sides it gives, and for one it
    /// leaves out the file's size (both left out), or the size that keeps the
    /// file's aspect ratio (one left out).
    fn image_size(&self, layer: &Layer, image: &ImageLayer, f: f64) -> Result<(f64, f64)> {
        self.box_size(layer, &image.src, &image.width, &image.height, f)
    }

    /// The box of a layer with a file behind it: see `image_size`.
    fn box_size(
        &self,
        layer: &Layer,
        src: &str,
        width: &Option<Num>,
        height: &Option<Num>,
        f: f64,
    ) -> Result<(f64, f64)> {
        let (width, height) = (
            width.as_ref().map(|n| n.at(f)),
            height.as_ref().map(|n| n.at(f)),
        );
        if let (Some(width), Some(height)) = (width, height) {
            return Ok((width, height));
        }
        let (natural_width, natural_height) = self.natural_size(layer, src)?;
        Ok(match (width, height) {
            (Some(width), None) => (width, width * natural_height / natural_width),
            (None, Some(height)) => (height * natural_width / natural_height, height),
            _ => (natural_width, natural_height),
        })
    }
}

fn resolve_paint(paint: &Paint, f: f64) -> ResolvedPaint {
    match paint {
        Paint::Solid(color) => ResolvedPaint::Solid(*color),
        Paint::Gradient(g) => ResolvedPaint::Gradient(resolve_gradient(g, f)),
        Paint::Image(i) => ResolvedPaint::Image(ResolvedImagePaint {
            src: i.src.clone(),
            x: i.x.at(f),
            y: i.y.at(f),
            width: i.width.at(f).max(0.0),
            height: i.height.at(f).max(0.0),
            repeat_x: i.repeat_x,
            repeat_y: i.repeat_y,
        }),
    }
}

/// Four lengths from a `Spacing` of one or four numbers: top, right,
/// bottom, left. Not negative unless `signed`.
fn edges(spacing: &Option<Spacing>, f: f64, signed: bool) -> [f64; 4] {
    let at = |n: &Num| if signed { n.at(f) } else { n.at(f).max(0.0) };
    match spacing.as_ref().map(|s| &s.0[..]) {
        Some([all]) => [at(all); 4],
        // Checked when the scene loaded.
        Some([top, right, bottom, left]) => [at(top), at(right), at(bottom), at(left)],
        _ => [0.0; 4],
    }
}

fn resolve_layout(l: &Layout, t: &Transform, f: f64) -> ResolvedLayout {
    ResolvedLayout {
        direction: l.flex_direction,
        wrap: l.flex_wrap,
        justify_content: l.justify_content,
        align_items: l.align_items,
        align_content: l.align_content,
        gap: match l.gap.as_ref().map(|s| &s.0[..]) {
            Some([both]) => (both.at(f).max(0.0), both.at(f).max(0.0)),
            // [row, column]
            Some([row, column]) => (row.at(f).max(0.0), column.at(f).max(0.0)),
            _ => (0.0, 0.0),
        },
        padding: edges(&l.padding, f, false),
        width: l.width.as_ref().map(|n| n.at(f).max(0.0)),
        height: l.height.as_ref().map(|n| n.at(f).max(0.0)),
        origin: (t.origin_x.at(f), t.origin_y.at(f)),
    }
}

fn resolve_item(i: &LayoutItem, f: f64) -> ResolvedItem {
    ResolvedItem {
        absolute: i.position == Position::Absolute,
        grow: i.flex_grow.as_ref().map_or(0.0, |n| n.at(f).max(0.0)),
        shrink: i.flex_shrink.as_ref().map_or(1.0, |n| n.at(f).max(0.0)),
        basis: match &i.flex_basis {
            Some(FlexBasis::Length(n)) => Some(n.at(f).max(0.0)),
            _ => None,
        },
        align_self: i.align_self,
        margin: edges(&i.margin, f, true),
        width: i.width.as_ref().map(|n| n.at(f).max(0.0)),
        height: i.height.as_ref().map(|n| n.at(f).max(0.0)),
    }
}

pub(crate) fn resolve_gradient(g: &Gradient, f: f64) -> ResolvedGradient {
    let geometry = match &g.geometry {
        GradientGeometry::Linear { x0, y0, x1, y1 } => ResolvedGradientGeometry::Linear {
            x0: x0.at(f),
            y0: y0.at(f),
            x1: x1.at(f),
            y1: y1.at(f),
        },
        GradientGeometry::Radial {
            cx,
            cy,
            r,
            fx: None,
            fy: None,
            fr: None,
        } => ResolvedGradientGeometry::Radial {
            cx: cx.at(f),
            cy: cy.at(f),
            r: r.at(f).max(0.0),
        },
        GradientGeometry::Radial {
            cx,
            cy,
            r,
            fx,
            fy,
            fr,
        } => ResolvedGradientGeometry::FocalRadial {
            cx: cx.at(f),
            cy: cy.at(f),
            r: r.at(f).max(0.0),
            fx: fx.as_ref().map_or_else(|| cx.at(f), |n| n.at(f)),
            fy: fy.as_ref().map_or_else(|| cy.at(f), |n| n.at(f)),
            fr: fr.as_ref().map_or(0.0, |n| n.at(f).max(0.0)),
        },
        GradientGeometry::Conic { cx, cy, angle } => ResolvedGradientGeometry::Conic {
            cx: cx.at(f),
            cy: cy.at(f),
            angle: angle.at(f),
        },
    };
    ResolvedGradient {
        geometry,
        stops: resolve_stops(&g.stops, f),
        extend: g.extend,
        units: g.units,
        transform: g.transform.map_or(Affine::IDENTITY, Affine::new),
    }
}

/// Stops that go backwards are held at the largest offset so far, as in CSS.
fn resolve_stops(stops: &[Stop], f: f64) -> Vec<(f64, Color)> {
    let mut highest = 0.0_f64;
    stops
        .iter()
        .map(|s| {
            highest = highest.max(s.offset.at(f).clamp(0.0, 1.0));
            (highest, s.color)
        })
        .collect()
}

fn resolve_clip(clip: &Clip, f: f64) -> ResolvedClip {
    match clip {
        Clip::Polygon { points } => ResolvedClip::Polygon {
            points: points.iter().map(|[x, y]| (x.at(f), y.at(f))).collect(),
        },
        Clip::Inset {
            top,
            right,
            bottom,
            left,
            radius,
        } => ResolvedClip::Inset {
            top: top.at(f),
            right: right.at(f),
            bottom: bottom.at(f),
            left: left.at(f),
            radius: radius.at(f).max(0.0),
        },
        Clip::Ellipse { cx, cy, rx, ry } => ResolvedClip::Ellipse {
            cx: cx.at(f),
            cy: cy.at(f),
            rx: rx.at(f).max(0.0),
            ry: ry.at(f).max(0.0),
        },
        Clip::Path { d } => ResolvedClip::Path { d: d.clone() },
    }
}

fn resolve_transform(t: &Transform, f: f64) -> ResolvedTransform {
    ResolvedTransform {
        x: t.x.at(f),
        y: t.y.at(f),
        scale: t.scale.at(f),
        rotation: t.rotation.at(f),
        anchor_x: t.anchor_x.at(f),
        anchor_y: t.anchor_y.at(f),
        rotate_x: t.rotate_x.at(f),
        rotate_y: t.rotate_y.at(f),
        z: t.z.at(f),
        origin_x: 0.0,
        origin_y: 0.0,
        matrix: t.matrix,
        backface_hidden: t.backface_hidden,
    }
}

/// Resolves a layer's effects, composing each run of colour filters into one
/// matrix so it takes a single pass.
pub(crate) fn resolve_effects(effects: &[Effect], clock: Clock) -> Vec<ResolvedEffect> {
    let mut out: Vec<ResolvedEffect> = Vec::with_capacity(effects.len());
    for effect in effects {
        let resolved = resolve_effect(effect, clock);
        match (&resolved, out.last_mut()) {
            (ResolvedEffect::ColorMatrix(next), Some(ResolvedEffect::ColorMatrix(prev))) => {
                *prev = prev.then(next);
            }
            _ => out.push(resolved),
        }
    }
    out
}

fn resolve_effect(effect: &Effect, clock: Clock) -> ResolvedEffect {
    let f = clock.t;
    match effect {
        Effect::Blur { radius } => ResolvedEffect::Blur {
            radius: radius.at(f).clamp(0.0, MAX_LAYER_BLUR_RADIUS) as f32,
        },
        Effect::BackdropBlur { radius } => ResolvedEffect::BackdropBlur {
            radius: radius.at(f).clamp(0.0, MAX_BLUR_RADIUS) as f32,
        },
        Effect::Glow {
            radius,
            color,
            intensity,
        } => ResolvedEffect::Glow(ResolvedGlow {
            radius: radius.at(f).clamp(0.0, MAX_BLUR_RADIUS) as f32,
            color: *color,
            intensity: intensity.at(f).clamp(0.0, MAX_GLOW_INTENSITY) as f32,
        }),
        Effect::ChromaticAberration { amount, angle } => ResolvedEffect::ChromaticAberration {
            amount: amount.at(f) as f32,
            angle: angle.at(f) as f32,
        },
        Effect::DropShadow(s) => ResolvedEffect::DropShadow(resolve_shadow(s, f)),
        Effect::InsetShadow(s) => ResolvedEffect::InsetShadow(resolve_shadow(s, f)),
        Effect::Saturate { amount } => {
            ResolvedEffect::ColorMatrix(ColorMatrix::saturate(amount.at(f)))
        }
        Effect::Contrast { amount } => {
            ResolvedEffect::ColorMatrix(ColorMatrix::contrast(amount.at(f)))
        }
        Effect::Brightness { amount } => {
            ResolvedEffect::ColorMatrix(ColorMatrix::brightness(amount.at(f)))
        }
        Effect::Grayscale { amount } => {
            ResolvedEffect::ColorMatrix(ColorMatrix::grayscale(amount.at(f)))
        }
        Effect::Sepia { amount } => ResolvedEffect::ColorMatrix(ColorMatrix::sepia(amount.at(f))),
        Effect::Invert { amount } => ResolvedEffect::ColorMatrix(ColorMatrix::invert(amount.at(f))),
        Effect::HueRotate { angle } => {
            ResolvedEffect::ColorMatrix(ColorMatrix::hue_rotate(angle.at(f)))
        }
        Effect::GradientMap { stops, amount } => ResolvedEffect::GradientMap(ResolvedGradientMap {
            stops: resolve_stops(stops, f),
            amount: amount.at(f).clamp(0.0, 1.0) as f32,
        }),
        Effect::Lut { src, amount } => ResolvedEffect::Lut {
            src: src.clone(),
            amount: amount.at(f).clamp(0.0, 1.0) as f32,
        },
        Effect::Grain {
            amount,
            size,
            seed,
            animate,
            monochrome,
        } => ResolvedEffect::Grain(ResolvedGrain {
            amount: amount.at(f).clamp(0.0, 1.0) as f32,
            size: size.at(f).max(1.0) as f32,
            // Checked when the scene loaded.
            seed: u32::try_from(*seed).unwrap_or_default(),
            frame: if *animate { clock.frame } else { 0 },
            monochrome: *monochrome,
        }),
        Effect::Dither {
            mode,
            levels,
            size,
            seed,
            animate,
        } => ResolvedEffect::Dither(ResolvedDither {
            mode: *mode,
            levels: levels
                .at(f)
                .round()
                .clamp(MIN_DITHER_LEVELS, MAX_DITHER_LEVELS) as u32,
            size: size.at(f).max(1.0) as f32,
            // Checked when the scene loaded; an ordered dither ignores it.
            seed: match mode {
                DitherMode::Random => seed.and_then(|s| u32::try_from(s).ok()).unwrap_or_default(),
                DitherMode::Ordered => 0,
            },
            frame: if *animate && *mode == DitherMode::Random {
                clock.frame
            } else {
                0
            },
        }),
        Effect::Halftone {
            size,
            angle,
            shape,
            color,
            invert,
        } => ResolvedEffect::Halftone(ResolvedHalftone {
            size: size.at(f).max(MIN_HALFTONE_SIZE) as f32,
            angle: angle.at(f) as f32,
            shape: *shape,
            color: *color,
            invert: *invert,
        }),
        Effect::DotMatrix {
            size,
            progress,
            order,
            angle,
            stagger,
            seed,
            shape,
        } => ResolvedEffect::DotMatrix(ResolvedDotMatrix {
            size: size.at(f).max(MIN_HALFTONE_SIZE) as f32,
            progress: progress.at(f).clamp(0.0, 1.0) as f32,
            order: *order,
            angle: angle.at(f) as f32,
            // Below 1 when the scene loaded; an interpolated value stays
            // between its keyframes.
            stagger: stagger.at(f).clamp(0.0, MAX_STAGGER) as f32,
            // Checked when the scene loaded; a sweep ignores it.
            seed: match order {
                DotOrder::Random => seed.and_then(|s| u32::try_from(s).ok()).unwrap_or_default(),
                DotOrder::Sweep => 0,
            },
            shape: *shape,
        }),
        Effect::Displace {
            scale,
            x_channel_selector,
            y_channel_selector,
            turbulence,
        } => ResolvedEffect::Displace(ResolvedDisplace {
            scale: scale.at(f) as f32,
            x_channel: *x_channel_selector,
            y_channel: *y_channel_selector,
            turbulence: resolve_turbulence(turbulence, f),
        }),
        Effect::CornerPin {
            top_left,
            top_right,
            bottom_right,
            bottom_left,
        } => ResolvedEffect::CornerPin(ResolvedCornerPin {
            corners: [top_left, top_right, bottom_right, bottom_left]
                .map(|c| c.as_ref().map(|[x, y]| [x.at(f), y.at(f)])),
        }),
        Effect::FilterGraph(g) => ResolvedEffect::FilterGraph(Box::new(g.resolve(f))),
        Effect::Shader(s) => ResolvedEffect::Shader(ResolvedShader {
            source: crate::shader::compose(&s.code, &s.names()),
            values: s.uniforms.values().map(|n| n.at(f) as f32).collect(),
            frame: f as f32,
            time: (f / clock.fps) as f32,
        }),
    }
}

fn resolve_turbulence(t: &Turbulence, f: f64) -> ResolvedTurbulence {
    ResolvedTurbulence {
        fractal: t.kind == TurbulenceKind::FractalNoise,
        frequency: [
            t.base_frequency.x.at(f).max(0.0) as f32,
            t.base_frequency.y.at(f).max(0.0) as f32,
        ],
        // Checked when the scene loaded.
        octaves: t.num_octaves.clamp(0, i64::from(MAX_OCTAVES)) as u32,
        seed: t.seed as i64,
    }
}

fn resolve_shadow(s: &Shadow, f: f64) -> ResolvedShadow {
    ResolvedShadow {
        x: s.x.at(f) as f32,
        y: s.y.at(f) as f32,
        blur: s.blur.at(f).clamp(0.0, MAX_SHADOW_SIZE) as f32,
        spread: s.spread.at(f).clamp(-MAX_SHADOW_SIZE, MAX_SHADOW_SIZE) as f32,
        color: s.color,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const SCENE: &str = r##"{
        "width": 320, "height": 180, "fps": 30, "durationInFrames": 10,
        "fonts": {"DM Sans": "f.ttf"},
        "layers": [
            {"id": "box", "type": "shape",
             "shape": {"kind": "rect", "width": 100, "height": 50},
             "fill": "#ff0000",
             "transform": {"x": [{"frame": 0, "value": 0}, {"frame": 10, "value": 100}],
                           "rotation": 90, "anchorX": 50, "anchorY": 25},
             "opacity": [{"frame": 0, "value": 0}, {"frame": 10, "value": 1}]},
            {"id": "g", "type": "group", "blendMode": "multiply", "children": [
                {"id": "t", "type": "text", "text": "hi", "font": "DM Sans",
                 "size": 40, "color": "#fff"}]}
        ]
    }"##;

    /// The scene's first layer at `clock`, which may be between frames.
    fn resolve_first(scene: &Scene, clock: Clock) -> ResolvedLayer {
        Resolver {
            scene,
            text: TextHandle::Lazy(None),
        }
        .layer(&scene.layers[0], clock, true)
        .unwrap()
    }

    fn scene() -> Scene {
        Scene::from_json(SCENE, PathBuf::new()).unwrap()
    }

    #[test]
    fn resolves_keyframes_at_frame() {
        let r = scene().resolve(5).unwrap();
        let box_layer = &r.layers[0];
        assert_eq!(box_layer.transform.x, 50.0);
        assert_eq!(box_layer.transform.scale, 1.0);
        assert!((box_layer.opacity - 0.5).abs() < 1e-6);
        assert_eq!(r.layers[1].blend_mode, BlendMode::Multiply);
        assert!(matches!(
            &r.layers[1].kind,
            ResolvedKind::Group { children, .. } if children.len() == 1
        ));
    }

    #[test]
    fn matrix_rotates_around_anchor() {
        let r = scene().resolve(0).unwrap();
        let m = r.layers[0].transform.matrix();
        // The anchor (50, 25) lands on (x, y) = (0, 0); the rect's origin
        // rotated 90 degrees clockwise about it lands at (25, -50).
        let anchor = m * vello::kurbo::Point::new(50.0, 25.0);
        assert!(anchor.x.abs() < 1e-9 && anchor.y.abs() < 1e-9);
        let origin = m * vello::kurbo::Point::new(0.0, 0.0);
        assert!((origin.x - 25.0).abs() < 1e-9 && (origin.y + 50.0).abs() < 1e-9);
    }

    #[test]
    fn out_of_range_frame_errors() {
        let s = scene();
        assert!(s.resolve(9).is_ok());
        assert!(matches!(
            s.resolve(10),
            Err(Error::FrameOutOfRange {
                frame: 10,
                duration: 10
            })
        ));
    }

    #[test]
    fn rejects_inconsistent_scenes() {
        let parse = |json: &str| Scene::from_json(json, PathBuf::new());
        let missing_font = SCENE.replace("\"font\": \"DM Sans\"", "\"font\": \"Nope\"");
        assert!(parse(&missing_font).is_err());
        let zero_size = SCENE.replace("\"width\": 320", "\"width\": 0");
        assert!(parse(&zero_size).is_err());
        let dup = SCENE.replace("\"id\": \"t\"", "\"id\": \"box\"");
        assert!(parse(&dup).is_err());
        let bad_type = SCENE.replace("\"type\": \"group\"", "\"type\": \"video\"");
        assert!(parse(&bad_type).is_err());
    }

    #[test]
    fn rejects_bad_geometry_and_text_sizes() {
        let parse = |json: &str| Scene::from_json(json, PathBuf::new());
        let negative_rect = SCENE.replace("\"width\": 100", "\"width\": -4");
        assert!(parse(&negative_rect).is_err());
        let zero_text = SCENE.replace("\"size\": 40", "\"size\": 0");
        assert!(parse(&zero_text).is_err());
        let bad_path = SCENE.replace(
            "\"kind\": \"rect\"",
            "\"kind\": \"path\", \"d\": \"M0 0 Q bogus\"",
        );
        assert!(parse(&bad_path).is_err());
    }

    #[test]
    fn resolves_animated_clips() {
        let json = r##"{
            "width": 100, "height": 100, "fps": 30, "durationInFrames": 11,
            "layers": [{"id": "a", "type": "shape",
              "shape": {"kind": "rect", "width": 50, "height": 50}, "fill": "#fff",
              "clip": {"kind": "polygon",
                       "points": [[0, 0], [[{"frame": 0, "value": 10}, {"frame": 10, "value": 30}], 0], [0, 40]]}},
              {"id": "b", "type": "shape",
              "shape": {"kind": "rect", "width": 50, "height": 50}, "fill": "#fff",
              "clip": {"kind": "ellipse", "cx": 5, "cy": 5, "rx": [{"frame": 0, "value": 0}, {"frame": 10, "value": 8}], "ry": 4}}]
        }"##;
        let r = Scene::from_json(json, PathBuf::new())
            .unwrap()
            .resolve(5)
            .unwrap();
        let Some(ResolvedClip::Polygon { points }) = &r.layers[0].clip else {
            panic!("not a polygon");
        };
        assert_eq!(points, &[(0.0, 0.0), (20.0, 0.0), (0.0, 40.0)]);
        assert!(matches!(
            &r.layers[1].clip,
            Some(ResolvedClip::Ellipse { rx, ry, .. }) if *rx == 4.0 && *ry == 4.0
        ));
    }

    #[test]
    fn resolves_shadows_with_clamped_blur_and_spread() {
        let json = r##"{
            "width": 100, "height": 100, "fps": 30, "durationInFrames": 11,
            "layers": [{"id": "a", "type": "shape",
              "shape": {"kind": "rect", "width": 50, "height": 50}, "fill": "#fff",
              "effects": [
                {"type": "dropShadow", "x": [{"frame": 0, "value": 0}, {"frame": 10, "value": 10}],
                 "y": -3, "blur": [{"frame": 0, "value": 0}, {"frame": 10, "value": 400}],
                 "spread": -500, "color": "#ff000080"},
                {"type": "insetShadow", "blur": -4, "spread": 2.5}]}]
        }"##;
        let scene = Scene::from_json(json, PathBuf::new()).unwrap();
        let effects = scene.resolve(5).unwrap().layers[0].effects.clone();
        let ResolvedEffect::DropShadow(drop) = effects[0] else {
            panic!("not a drop shadow");
        };
        assert_eq!((drop.x, drop.y), (5.0, -3.0));
        assert_eq!((drop.blur, drop.spread), (128.0, -128.0));
        assert_eq!(drop.color, crate::color::Color::parse("#ff000080").unwrap());
        let ResolvedEffect::InsetShadow(inset) = effects[1] else {
            panic!("not an inset shadow");
        };
        assert_eq!((inset.blur, inset.spread), (0.0, 2.5));
    }

    /// The resolved effects of a one-layer scene at `frame`.
    fn effects_at(effects: &str, frame: u32) -> Vec<ResolvedEffect> {
        let json = format!(
            r##"{{"width": 100, "height": 100, "fps": 30, "durationInFrames": 11,
              "layers": [{{"id": "a", "type": "shape",
                "shape": {{"kind": "rect", "width": 50, "height": 50}}, "fill": "#fff",
                "effects": {effects}}}]}}"##
        );
        let scene = Scene::from_json(&json, PathBuf::new()).unwrap();
        scene.resolve(frame).unwrap().layers[0].effects.clone()
    }

    #[test]
    fn backdrop_blur_resolves_and_clamps_its_radius() {
        let effects = effects_at(
            r#"[{"type": "backdropBlur", "radius": [{"frame": 0, "value": 0}, {"frame": 10, "value": 400}]}]"#,
            5,
        );
        assert!(
            matches!(effects[..], [ResolvedEffect::BackdropBlur { radius }] if radius == 128.0)
        );
        let effects = effects_at(r#"[{"type": "backdropBlur", "radius": -3}]"#, 0);
        assert!(matches!(effects[..], [ResolvedEffect::BackdropBlur { radius }] if radius == 0.0));
    }

    #[test]
    fn glow_resolves_and_clamps() {
        let effects = effects_at(
            r##"[{"type": "glow", "radius": [{"frame": 0, "value": 0}, {"frame": 10, "value": 300}],
                  "intensity": [{"frame": 0, "value": 0}, {"frame": 10, "value": 20}], "color": "#ff0000"},
                 {"type": "glow", "radius": -1, "intensity": -2}]"##,
            5,
        );
        let ResolvedEffect::Glow(first) = effects[0] else {
            panic!("not a glow");
        };
        assert_eq!((first.radius, first.intensity), (128.0, 4.0));
        assert_eq!(first.color, Some(Color::parse("#ff0000").unwrap()));
        let ResolvedEffect::Glow(second) = effects[1] else {
            panic!("not a glow");
        };
        assert_eq!((second.radius, second.intensity), (0.0, 0.0));
        assert_eq!(second.color, None);
    }

    #[test]
    fn chromatic_aberration_resolves_keyframes() {
        let effects = effects_at(
            r#"[{"type": "chromaticAberration",
                 "amount": [{"frame": 0, "value": 0}, {"frame": 10, "value": 8}],
                 "angle": [{"frame": 0, "value": 0}, {"frame": 10, "value": 90}]}]"#,
            5,
        );
        assert!(matches!(
            effects[..],
            [ResolvedEffect::ChromaticAberration { amount, angle }] if amount == 4.0 && angle == 45.0
        ));
    }

    #[test]
    fn shader_resolves_uniforms_in_name_order_and_the_clock() {
        let code = r"fn effect(px: vec2<f32>) -> vec4<f32> { return layer(px) * u.a + u.z; }";
        let effects = effects_at(
            &format!(
                r#"[{{"type": "shader", "code": "{code}", "uniforms": {{"z": 2,
                    "a": [{{"frame": 0, "value": 0}}, {{"frame": 10, "value": 1}}]}}}}]"#
            ),
            3,
        );
        let [ResolvedEffect::Shader(shader)] = &effects[..] else {
            panic!("not a shader");
        };
        // `a` is first although the scene listed `z` first.
        assert_eq!(shader.values, [0.3, 2.0]);
        assert_eq!(shader.frame, 3.0);
        // The scene runs at 30 fps.
        assert_eq!(shader.time, 0.1);
        assert!(shader.source.contains(code));
        assert!(shader.source.starts_with("struct U { a: f32, z: f32 }"));
    }

    #[test]
    fn keyframes_and_the_shader_clock_follow_t_not_the_frame() {
        let json = r##"{
            "width": 100, "height": 100, "fps": 25, "durationInFrames": 11,
            "layers": [{"id": "a", "type": "shape",
              "shape": {"kind": "rect", "width": 50, "height": 50}, "fill": "#fff",
              "transform": {"x": [{"frame": 0, "value": 0}, {"frame": 10, "value": 100}]},
              "effects": [{"type": "shader",
                "code": "fn effect(px: vec2<f32>) -> vec4<f32> { return layer(px); }"}]}]
        }"##;
        let scene = Scene::from_json(json, PathBuf::new()).unwrap();
        // Half a frame past frame 2, as a motion blur sub-frame would be.
        let clock = Clock {
            t: 2.5,
            frame: 2,
            fps: scene.fps,
        };
        let layer = resolve_first(&scene, clock);
        assert_eq!(layer.transform.x, 25.0);
        let [ResolvedEffect::Shader(shader)] = &layer.effects[..] else {
            panic!("not a shader");
        };
        assert_eq!((shader.frame, shader.time), (2.5, 0.1));
        // A whole frame resolves exactly as `Scene::resolve` does.
        let whole = Clock {
            t: 4.0,
            frame: 4,
            fps: scene.fps,
        };
        assert_eq!(resolve_first(&scene, whole).transform.x, 40.0);
        assert_eq!(scene.resolve(4).unwrap().layers[0].transform.x, 40.0);
    }

    #[test]
    fn gradient_map_resolves_stops_and_clamps_the_amount() {
        let effects = effects_at(
            r##"[{"type": "gradientMap",
                  "amount": [{"frame": 0, "value": -1}, {"frame": 10, "value": 3}],
                  "stops": [{"offset": 0.5, "color": "#000"},
                            {"offset": [{"frame": 0, "value": 1}, {"frame": 10, "value": 0}], "color": "#f00"},
                            {"offset": 1, "color": "#ffffff80"}]}]"##,
            5,
        );
        let [ResolvedEffect::GradientMap(map)] = &effects[..] else {
            panic!("not a gradient map");
        };
        // The second offset is 0.5 at frame 5; the first holds 0.5 and the
        // last is 1.
        let offsets: Vec<f64> = map.stops.iter().map(|s| s.0).collect();
        assert_eq!(offsets, [0.5, 0.5, 1.0]);
        assert_eq!(map.stops[2].1, Color::parse("#ffffff80").unwrap());
        // The amount at frame 5 of -1..3 is 1.0 after clamping.
        assert_eq!(map.amount, 1.0);
        let effects = effects_at(
            r##"[{"type": "gradientMap", "amount": [{"frame": 0, "value": -1}, {"frame": 10, "value": 3}],
                  "stops": [{"offset": 0, "color": "#000"}, {"offset": 1, "color": "#fff"}]}]"##,
            1,
        );
        let [ResolvedEffect::GradientMap(map)] = &effects[..] else {
            panic!("not a gradient map");
        };
        assert_eq!(map.amount, 0.0);
    }

    #[test]
    fn lut_resolves_its_amount() {
        let effects = effects_at(
            r#"[{"type": "lut", "src": "a.cube", "amount": [{"frame": 0, "value": 2}, {"frame": 10, "value": -2}]},
                {"type": "lut", "src": "b.cube"}]"#,
            5,
        );
        assert!(matches!(
            &effects[0],
            ResolvedEffect::Lut { src, amount } if src == "a.cube" && *amount == 0.0
        ));
        assert!(matches!(&effects[1], ResolvedEffect::Lut { amount, .. } if *amount == 1.0));
        let effects = effects_at(
            r#"[{"type": "lut", "src": "a.cube", "amount": [{"frame": 0, "value": 0}, {"frame": 10, "value": 1}]}]"#,
            2,
        );
        assert!(matches!(&effects[0], ResolvedEffect::Lut { amount, .. } if *amount == 0.2));
    }

    #[test]
    fn grain_resolves_and_animates_by_the_output_frame() {
        let json = r##"{
            "width": 100, "height": 100, "fps": 30, "durationInFrames": 11,
            "layers": [{"id": "a", "type": "shape",
              "shape": {"kind": "rect", "width": 50, "height": 50}, "fill": "#fff",
              "effects": [
                {"type": "grain", "amount": [{"frame": 0, "value": 0}, {"frame": 10, "value": 2}],
                 "size": [{"frame": 0, "value": 1}, {"frame": 10, "value": 5}], "seed": 9},
                {"type": "grain", "amount": 0.2, "seed": 9, "animate": false, "monochrome": false}]}]
        }"##;
        let scene = Scene::from_json(json, PathBuf::new()).unwrap();
        let grain = |clock: Clock| {
            let layer = resolve_first(&scene, clock);
            let [ResolvedEffect::Grain(a), ResolvedEffect::Grain(b)] = layer.effects[..] else {
                panic!("not two grains");
            };
            (a, b)
        };
        // A sub-frame between frames 4 and 5 reads keyframes at 4.5 but
        // hashes the output frame, 4.
        let (a, b) = grain(Clock {
            t: 4.5,
            frame: 4,
            fps: 30.0,
        });
        assert!((a.amount - 0.9).abs() < 1e-6 && (a.size - 2.8).abs() < 1e-6);
        assert_eq!((a.seed, a.frame, a.monochrome), (9, 4, true));
        // Not animated: always frame 0, and per-channel noise.
        assert_eq!(
            b,
            ResolvedGrain {
                amount: 0.2,
                size: 1.0,
                seed: 9,
                frame: 0,
                monochrome: false
            }
        );
        // The amount is clamped to 1 once the keyframes pass it.
        let (a, _) = grain(Clock {
            t: 9.0,
            frame: 9,
            fps: 30.0,
        });
        assert_eq!(a.amount, 1.0);
    }

    impl ResolvedEffect {
        fn dither(self) -> ResolvedDither {
            let ResolvedEffect::Dither(d) = self else {
                panic!("not a dither: {self:?}");
            };
            d
        }
    }

    #[test]
    fn dither_rounds_levels_and_animates_only_when_random() {
        let effects = effects_at(
            r#"[{"type": "dither", "levels": [{"frame": 0, "value": 2}, {"frame": 10, "value": 9}],
                 "size": [{"frame": 0, "value": 1}, {"frame": 10, "value": 5}], "seed": 8, "animate": true},
                {"type": "dither", "mode": "random", "seed": 8, "animate": true},
                {"type": "dither", "mode": "random", "seed": 8}]"#,
            3,
        );
        // Ordered: levels 2 + 7 * 0.3 = 4.1 rounds to 4; the seed and the
        // animate flag mean nothing.
        assert_eq!(
            effects[0].clone().dither(),
            ResolvedDither {
                mode: DitherMode::Ordered,
                levels: 4,
                size: 2.2,
                seed: 0,
                frame: 0
            }
        );
        // The frame here is the scene's own: `effects_at` renders frame 3.
        assert_eq!(
            effects[1].clone().dither(),
            ResolvedDither {
                mode: DitherMode::Random,
                levels: 2,
                size: 1.0,
                seed: 8,
                frame: 3
            }
        );
        assert_eq!(effects[2].clone().dither().frame, 0);
    }

    impl ResolvedEffect {
        fn halftone(self) -> ResolvedHalftone {
            let ResolvedEffect::Halftone(h) = self else {
                panic!("not a halftone: {self:?}");
            };
            h
        }
    }

    #[test]
    fn halftone_resolves_animated_size_and_angle() {
        let effects = effects_at(
            r##"[{"type": "halftone", "size": [{"frame": 0, "value": 4}, {"frame": 10, "value": 14}],
                 "angle": [{"frame": 0, "value": 0}, {"frame": 10, "value": 90}],
                 "shape": "square", "color": "#10203040", "invert": true},
                {"type": "halftone"}]"##,
            5,
        );
        assert_eq!(
            effects[0].clone().halftone(),
            ResolvedHalftone {
                size: 9.0,
                angle: 45.0,
                shape: HalftoneShape::Square,
                color: Some(Color {
                    r: 0x10,
                    g: 0x20,
                    b: 0x30,
                    a: 0x40
                }),
                invert: true,
            }
        );
        assert_eq!(
            effects[1].clone().halftone(),
            ResolvedHalftone {
                size: 8.0,
                angle: 45.0,
                shape: HalftoneShape::Circle,
                color: None,
                invert: false,
            }
        );
    }

    #[test]
    fn dot_matrix_clamps_progress_and_ignores_the_seed_of_a_sweep() {
        let effects = effects_at(
            r#"[{"type": "dotMatrix", "seed": 6, "size": 10,
                 "progress": [{"frame": 0, "value": -0.5}, {"frame": 10, "value": 1.5}]},
                {"type": "dotMatrix", "order": "sweep", "seed": 6, "shape": "square", "angle": 30,
                 "stagger": [{"frame": 0, "value": 0}, {"frame": 10, "value": 0.5}],
                 "progress": 0.25}]"#,
            5,
        );
        let dm = |e: &ResolvedEffect| {
            let ResolvedEffect::DotMatrix(d) = e else {
                panic!("not a dot matrix: {e:?}");
            };
            *d
        };
        assert_eq!(
            dm(&effects[0]),
            ResolvedDotMatrix {
                size: 10.0,
                progress: 0.5,
                order: DotOrder::Random,
                angle: 0.0,
                stagger: 0.6,
                seed: 6,
                shape: DotShape::Circle,
            }
        );
        assert_eq!(
            dm(&effects[1]),
            ResolvedDotMatrix {
                size: 12.0,
                progress: 0.25,
                order: DotOrder::Sweep,
                angle: 30.0,
                stagger: 0.25,
                seed: 0,
                shape: DotShape::Square,
            }
        );
        // Outside the keyframes progress is clamped to 0..=1.
        let late = effects_at(
            r#"[{"type": "dotMatrix", "seed": 6,
                 "progress": [{"frame": 0, "value": -0.5}, {"frame": 10, "value": 1.5}]}]"#,
            10,
        );
        assert_eq!(dm(&late[0]).progress, 1.0);
        let early = effects_at(
            r#"[{"type": "dotMatrix", "seed": 6,
                 "progress": [{"frame": 0, "value": -0.5}, {"frame": 10, "value": 1.5}]}]"#,
            0,
        );
        assert_eq!(dm(&early[0]).progress, 0.0);
    }

    #[test]
    fn displace_resolves_its_scale_and_turbulence_per_frame() {
        let effects = effects_at(
            r#"[{"type": "displace", "xChannelSelector": "B",
                 "scale": [{"frame": 0, "value": 0}, {"frame": 10, "value": -20}],
                 "turbulence": {"type": "turbulence", "numOctaves": 3, "seed": -4.9,
                   "baseFrequency": [[{"frame": 0, "value": 0.02}, {"frame": 10, "value": 0.06}], 0.5]}},
                {"type": "displace", "scale": 3,
                 "turbulence": {"type": "fractalNoise", "baseFrequency": 0.04, "seed": 7.99}}]"#,
            5,
        );
        let displace = |e: &ResolvedEffect| {
            let ResolvedEffect::Displace(d) = e else {
                panic!("not a displacement: {e:?}");
            };
            *d
        };
        assert_eq!(
            displace(&effects[0]),
            ResolvedDisplace {
                scale: -10.0,
                x_channel: Channel::B,
                y_channel: Channel::G,
                turbulence: ResolvedTurbulence {
                    fractal: false,
                    frequency: [0.04, 0.5],
                    octaves: 3,
                    // Truncated toward zero, not rounded or floored.
                    seed: -4,
                },
            }
        );
        assert_eq!(
            displace(&effects[1]),
            ResolvedDisplace {
                scale: 3.0,
                x_channel: Channel::R,
                y_channel: Channel::G,
                turbulence: ResolvedTurbulence {
                    fractal: true,
                    frequency: [0.04, 0.04],
                    octaves: 1,
                    seed: 7,
                },
            }
        );
    }

    #[test]
    fn noise_layers_resolve_their_box_and_turbulence() {
        let json = r#"{"width": 100, "height": 100, "fps": 30, "durationInFrames": 11,
            "layers": [{"id": "n", "type": "noise", "channels": "gray",
              "width": [{"frame": 0, "value": 0}, {"frame": 10, "value": 80}], "height": 30,
              "turbulence": {"type": "fractalNoise", "numOctaves": 2, "seed": 11,
                "baseFrequency": [{"frame": 0, "value": 0.1}, {"frame": 10, "value": 0.3}]}}]}"#;
        let scene = Scene::from_json(json, PathBuf::new()).unwrap();
        let resolved = scene.resolve(5).unwrap();
        let ResolvedKind::Noise {
            width,
            height,
            turbulence,
            channels,
        } = &resolved.layers[0].kind
        else {
            panic!("not a noise layer");
        };
        assert_eq!(
            (*width, *height, *channels),
            (40.0, 30.0, NoiseChannels::Gray)
        );
        assert_eq!(
            *turbulence,
            ResolvedTurbulence {
                fractal: true,
                frequency: [0.2, 0.2],
                octaves: 2,
                seed: 11,
            }
        );
    }

    #[test]
    fn mesh_gradients_default_to_a_regular_grid_over_the_box() {
        let json = r##"{"width": 100, "height": 100, "fps": 30, "durationInFrames": 11,
            "layers": [{"id": "m", "type": "meshGradient", "columns": 3, "rows": 2,
              "width": [{"frame": 0, "value": 0}, {"frame": 10, "value": 80}], "height": 30,
              "colors": ["#f00", "#0f0", "#00f", "#ff0", "#0ff", "#f0f"]}]}"##;
        let scene = Scene::from_json(json, PathBuf::new()).unwrap();
        let resolved = scene.resolve(5).unwrap();
        let ResolvedKind::MeshGradient {
            width,
            height,
            columns,
            rows,
            points,
            colors,
        } = &resolved.layers[0].kind
        else {
            panic!("not a mesh gradient layer");
        };
        assert_eq!((*width, *height, *columns, *rows), (40.0, 30.0, 3, 2));
        assert_eq!(
            *points,
            [
                [0.0, 0.0],
                [20.0, 0.0],
                [40.0, 0.0],
                [0.0, 30.0],
                [20.0, 30.0],
                [40.0, 30.0]
            ]
        );
        assert_eq!(colors.len(), 6);
    }

    #[test]
    fn mesh_gradient_points_are_keyframed() {
        let json = r##"{"width": 100, "height": 100, "fps": 30, "durationInFrames": 11,
            "layers": [{"id": "m", "type": "meshGradient", "columns": 2, "rows": 2,
              "width": 50, "height": 50,
              "points": [[0, 0], [[{"frame": 0, "value": 50}, {"frame": 10, "value": 90}], 5],
                         [0, 50], [50, 50]],
              "colors": ["#f00", "#0f0", "#00f", "#ff0"]}]}"##;
        let scene = Scene::from_json(json, PathBuf::new()).unwrap();
        let at = |frame| match &scene.resolve(frame).unwrap().layers[0].kind {
            ResolvedKind::MeshGradient { points, .. } => points.clone(),
            _ => panic!("not a mesh gradient layer"),
        };
        assert_eq!(at(0)[1], [50.0, 5.0]);
        assert_eq!(at(5)[1], [70.0, 5.0]);
        assert_eq!(at(10)[3], [50.0, 50.0]);
    }

    #[test]
    fn a_run_of_colour_filters_becomes_one_matrix() {
        let effects = effects_at(
            r#"[{"type": "brightness", "amount": 2}, {"type": "invert"},
                {"type": "blur", "radius": 3},
                {"type": "grayscale", "amount": 0}, {"type": "hueRotate", "angle": 0}]"#,
            0,
        );
        assert_eq!(effects.len(), 3);
        // Brightness, then invert: 1 - 2c.
        let ResolvedEffect::ColorMatrix(first) = effects[0] else {
            panic!("not a matrix");
        };
        let want = ColorMatrix::brightness(2.0).then(&ColorMatrix::invert(1.0));
        assert_eq!(first, want);
        assert!(matches!(effects[1], ResolvedEffect::Blur { radius } if radius == 3.0));
        // The second run is two neutral filters: still the identity.
        let ResolvedEffect::ColorMatrix(second) = effects[2] else {
            panic!("not a matrix");
        };
        for (row, want) in second.0.iter().zip(ColorMatrix::IDENTITY.0) {
            assert!(row.iter().zip(want).all(|(a, b)| (a - b).abs() < 1e-12));
        }
    }

    #[test]
    fn colour_filters_resolve_keyframes_and_clamp() {
        let effects = effects_at(
            r#"[{"type": "sepia", "amount": [{"frame": 0, "value": 0}, {"frame": 10, "value": 4}]}]"#,
            10,
        );
        // Sepia is clamped to 1 at the last keyframe.
        assert!(
            matches!(effects[..], [ResolvedEffect::ColorMatrix(m)] if m == ColorMatrix::sepia(1.0))
        );
        let effects = effects_at(
            r#"[{"type": "sepia", "amount": [{"frame": 0, "value": 0}, {"frame": 10, "value": 1}]}]"#,
            5,
        );
        assert!(
            matches!(effects[..], [ResolvedEffect::ColorMatrix(m)] if m == ColorMatrix::sepia(0.5))
        );
    }

    #[test]
    fn gradient_stops_never_go_backwards() {
        let json = r##"{
            "width": 100, "height": 100, "fps": 30, "durationInFrames": 11,
            "layers": [{"id": "a", "type": "shape",
              "shape": {"kind": "rect", "width": 50, "height": 50}, "fill": "#fff",
              "mask": {"gradient": {"type": "linear", "x0": 0, "y0": 0,
                         "x1": [{"frame": 0, "value": 0}, {"frame": 10, "value": 100}], "y1": 0,
                         "stops": [{"offset": 0.6, "color": "#fff"},
                                   {"offset": [{"frame": 0, "value": 1}, {"frame": 10, "value": 0}], "color": "#000"},
                                   {"offset": 0.7, "color": "#f00"}]}}}]
        }"##;
        let scene = Scene::from_json(json, PathBuf::new()).unwrap();
        let g = &scene.resolve(5).unwrap().layers[0]
            .mask
            .clone()
            .unwrap()
            .gradient;
        let offsets: Vec<f64> = g.stops.iter().map(|s| s.0).collect();
        assert_eq!(offsets, [0.6, 0.6, 0.7]);
        assert!(matches!(
            g.geometry,
            ResolvedGradientGeometry::Linear { x1, .. } if x1 == 50.0
        ));
    }

    #[test]
    fn fills_and_text_colours_resolve_per_frame() {
        let json = r##"{
            "width": 100, "height": 100, "fps": 30, "durationInFrames": 11,
            "fonts": {"F": "f.ttf"},
            "layers": [
              {"id": "a", "type": "shape",
               "shape": {"kind": "rect", "width": 50, "height": 50},
               "fill": {"type": "radial", "cx": 0, "cy": 0,
                        "r": [{"frame": 0, "value": 0}, {"frame": 10, "value": 100}],
                        "extend": "repeat",
                        "stops": [{"offset": 0, "color": "#fff"}, {"offset": 1, "color": "#000"}]}},
              {"id": "b", "type": "shape",
               "shape": {"kind": "rect", "width": 50, "height": 50}, "fill": "#f00"},
              {"id": "t", "type": "text", "text": "x", "font": "F", "size": 10, "color": "#0f0"}]
        }"##;
        let scene = Scene::from_json(json, PathBuf::new()).unwrap();
        let layers = scene.resolve(5).unwrap().layers;
        let ResolvedKind::Shape { fill, .. } = &layers[0].kind else {
            panic!("not a shape");
        };
        let Some(ResolvedPaint::Gradient(g)) = fill else {
            panic!("fill is not a gradient");
        };
        assert!(matches!(g.geometry, ResolvedGradientGeometry::Radial { r, .. } if r == 50.0));
        assert_eq!(g.extend, Extend::Repeat);
        let ResolvedKind::Shape { fill, .. } = &layers[1].kind else {
            panic!("not a shape");
        };
        assert!(
            matches!(fill, Some(ResolvedPaint::Solid(c)) if *c == Color::parse("#f00").unwrap())
        );
        let ResolvedKind::Text { color, .. } = &layers[2].kind else {
            panic!("not text");
        };
        assert!(matches!(color, ResolvedPaint::Solid(c) if *c == Color::parse("#0f0").unwrap()));
    }

    #[test]
    fn resolves_3d_transforms_per_frame() {
        let json = r##"{"width": 100, "height": 100, "fps": 30, "durationInFrames": 11,
            "layers": [{"id": "card", "type": "shape", "fill": "#fff",
              "shape": {"kind": "rect", "width": 40, "height": 20},
              "transform": {"rotateX": [{"frame": 0, "value": 0}, {"frame": 10, "value": 60}],
                            "rotateY": -25, "z": [{"frame": 0, "value": 100}, {"frame": 10, "value": 0}]}}]}"##;
        let scene = Scene::from_json(json, PathBuf::new()).unwrap();
        let t = scene.resolve(5).unwrap().layers[0].transform;
        assert_eq!((t.rotate_x, t.rotate_y, t.z), (30.0, -25.0, 50.0));
        // The flat matrix is what it always was.
        assert_eq!(t.matrix(), vello::kurbo::Affine::IDENTITY);
    }

    #[test]
    fn the_camera_defaults_to_the_middle_of_the_canvas_and_is_keyframed() {
        let json = |camera: &str| {
            format!(
                r#"{{"width": 300, "height": 120, "fps": 30, "durationInFrames": 11,
                    "camera": {camera}, "layers": []}}"#
            )
        };
        let scene = Scene::from_json(&json(r#"{"perspective": 700}"#), PathBuf::new()).unwrap();
        assert_eq!(
            scene.resolve(3).unwrap().camera,
            Some(ResolvedCamera {
                perspective: 700.0,
                x: 150.0,
                y: 60.0
            })
        );
        let animated = json(
            r#"{"perspective": [{"frame": 0, "value": 1000}, {"frame": 10, "value": 500}],
                "x": [{"frame": 0, "value": 0}, {"frame": 10, "value": 100}], "y": 30}"#,
        );
        let scene = Scene::from_json(&animated, PathBuf::new()).unwrap();
        assert_eq!(
            scene.resolve(5).unwrap().camera,
            Some(ResolvedCamera {
                perspective: 750.0,
                x: 50.0,
                y: 30.0
            })
        );
        let none = json("null");
        assert!(
            Scene::from_json(&none, PathBuf::new())
                .unwrap()
                .resolve(0)
                .unwrap()
                .camera
                .is_none()
        );
    }

    #[test]
    fn resolves_the_preserve3d_flag() {
        let json = r#"{"width": 50, "height": 50, "fps": 30, "durationInFrames": 1, "layers": [
            {"id": "flat", "type": "group", "children": []},
            {"id": "deep", "type": "group", "preserve3d": true, "children": []}]}"#;
        let scene = Scene::from_json(json, PathBuf::new()).unwrap();
        let flags: Vec<_> = scene
            .resolve(0)
            .unwrap()
            .layers
            .iter()
            .map(|l| {
                matches!(
                    l.kind,
                    ResolvedKind::Group {
                        preserve3d: true,
                        ..
                    }
                )
            })
            .collect();
        assert_eq!(flags, [false, true]);
    }

    #[test]
    fn corner_pins_resolve_keyframes_and_default_to_the_box() {
        let effects = effects_at(
            r#"[{"type": "cornerPin", "topRight": [[{"frame": 0, "value": 100}, {"frame": 10, "value": 60}], 0],
                 "bottomLeft": [10, [{"frame": 0, "value": 50}, {"frame": 10, "value": 30}]]}]"#,
            5,
        );
        let ResolvedEffect::CornerPin(pin) = effects[0] else {
            panic!("not a corner pin");
        };
        assert_eq!(
            pin.corners,
            [None, Some([80.0, 0.0]), None, Some([10.0, 40.0])]
        );
        // The corners left out are the box's own.
        let b = Rect::new(0.0, 0.0, 100.0, 50.0);
        assert_eq!(
            pin.points(b),
            [[0.0, 0.0], [80.0, 0.0], [100.0, 50.0], [10.0, 40.0]]
        );
        let none = effects_at(r#"[{"type": "cornerPin"}]"#, 0);
        let ResolvedEffect::CornerPin(pin) = none[0] else {
            panic!("not a corner pin");
        };
        assert_eq!(pin.points(b), warp::rect_corners(b));
    }

    #[test]
    fn sub_frame_times_are_centred_on_the_frame() {
        // Equal slots of the shutter, each sampled in the middle.
        assert_eq!(motion_times(10.0, 2, 1.0), [9.75, 10.25]);
        assert_eq!(motion_times(10.0, 4, 2.0), [9.25, 9.75, 10.25, 10.75]);
        // Whatever the count, the samples average to the frame.
        for samples in [2, 3, 8, 64] {
            let times = motion_times(7.0, samples, 0.5);
            assert_eq!(times.len(), samples as usize);
            let mean = times.iter().sum::<f64>() / f64::from(samples);
            assert!((mean - 7.0).abs() < 1e-12, "{samples}: {mean}");
            assert!(times.windows(2).all(|w| w[0] < w[1]));
            assert!(times[0] > 6.75 && times[times.len() - 1] < 7.25);
        }
    }

    fn blur_scene(blur: &str) -> Scene {
        let json = format!(
            r##"{{"width": 100, "height": 50, "fps": 30, "durationInFrames": 20,
                "layers": [
                  {{"id": "a", "type": "shape", {blur}
                    "shape": {{"kind": "rect", "width": 10, "height": 10}}, "fill": "#fff",
                    "transform": {{"x": [{{"frame": 0, "value": 0}}, {{"frame": 10, "value": 100}}]}},
                    "opacity": [{{"frame": 5, "value": 1}}, {{"frame": 15, "value": 0}}]}}]}}"##
        );
        Scene::from_json(&json, PathBuf::new()).unwrap()
    }

    #[test]
    fn sub_frames_are_resolved_at_their_own_times() {
        let scene = blur_scene(r#""motionBlur": {"samples": 4, "shutter": 2},"#);
        let resolved = scene.resolve(5).unwrap();
        let layer = &resolved.layers[0];
        // The frame itself stays at frame 5.
        assert_eq!((layer.transform.x, layer.opacity), (50.0, 1.0));
        let xs: Vec<f64> = layer.motion.iter().map(|m| m.transform.x).collect();
        let want = [4.25, 4.75, 5.25, 5.75].map(|t| t * 10.0);
        assert!(
            xs.iter().zip(want).all(|(a, b)| (a - b).abs() < 1e-9),
            "{xs:?}"
        );
        // The fade starts at frame 5, so the earlier sub-frames are still
        // fully opaque and the later ones less.
        let opacities: Vec<f32> = layer.motion.iter().map(|m| m.opacity).collect();
        assert_eq!(opacities[..2], [1.0, 1.0]);
        assert!(opacities[2] < 1.0 && opacities[3] < opacities[2]);
        // A copy has no sub-frames of its own.
        assert!(layer.motion.iter().all(|m| m.motion.is_empty()));
    }

    #[test]
    fn a_shut_shutter_or_no_motion_blur_has_no_sub_frames() {
        for blur in [
            "",
            r#""motionBlur": {"samples": 8, "shutter": 0},"#,
            r#""motionBlur": {"samples": 8, "shutter": -1},"#,
        ] {
            let resolved = blur_scene(blur).resolve(5).unwrap();
            assert!(resolved.layers[0].motion.is_empty(), "{blur}");
        }
    }

    #[test]
    fn the_shutter_is_clamped_and_animatable() {
        let blur = r#""motionBlur": {"samples": 2, "shutter": [{"frame": 0, "value": 0}, {"frame": 10, "value": 5}]},"#;
        let scene = blur_scene(blur);
        // Frame 10: a shutter of 5 frames is cut to 2.
        let layer = &scene.resolve(10).unwrap().layers[0];
        let xs: Vec<f64> = layer.motion.iter().map(|m| m.transform.x).collect();
        assert_eq!(xs, [95.0, 100.0]);
        // Frame 0: the shutter has not opened yet.
        assert!(scene.resolve(0).unwrap().layers[0].motion.is_empty());
        // Frame 5: half way, 2.5 clamped to 2 as well.
        assert_eq!(scene.resolve(5).unwrap().layers[0].motion.len(), 2);
    }

    #[test]
    fn motion_blur_inside_a_blurred_group_is_ignored() {
        let json = r##"{"width": 100, "height": 50, "fps": 30, "durationInFrames": 20, "layers": [
          {"id": "g", "type": "group", "motionBlur": {"samples": 3, "shutter": 1}, "children": [
            {"id": "c", "type": "group", "motionBlur": {"samples": 5, "shutter": 1},
             "children": []}]},
          {"id": "g0", "type": "group", "motionBlur": {"shutter": 0}, "children": [
            {"id": "c0", "type": "group", "motionBlur": {"samples": 5}, "children": []}]}]}"##;
        let resolved = Scene::from_json(json, PathBuf::new())
            .unwrap()
            .resolve(3)
            .unwrap();
        let children = |l: &ResolvedLayer| match &l.kind {
            ResolvedKind::Group { children, .. } => children.clone(),
            _ => panic!("not a group"),
        };
        let g = &resolved.layers[0];
        assert_eq!(g.motion.len(), 3);
        assert!(children(g)[0].motion.is_empty());
        for sub in &g.motion {
            assert!(children(sub)[0].motion.is_empty());
        }
        // A parent whose shutter is shut does not stop its children's.
        assert_eq!(children(&resolved.layers[1])[0].motion.len(), 5);
    }

    #[test]
    fn motion_blur_frames_stand_in_for_the_layer_at_each_sub_frame() {
        // The layer itself moves with t, the copies are at x = 1000 and 2000
        // and are told apart by their opacity: each sub-frame is the copy
        // resolved at its own time, with the original's id.
        let json = r##"{"width": 100, "height": 50, "fps": 30, "durationInFrames": 20, "layers": [
          {"id": "a", "type": "shape", "shape": {"kind": "rect", "width": 4, "height": 4},
           "fill": "#fff",
           "transform": {"x": [{"frame": 0, "value": 0}, {"frame": 10, "value": 100}]},
           "motionBlur": {"samples": 2, "shutter": 1, "frames": [
             {"id": "copy0", "type": "shape", "shape": {"kind": "rect", "width": 4, "height": 4},
              "fill": "#fff", "opacity": 0.25,
              "transform": {"x": [{"frame": 0, "value": 1000}, {"frame": 10, "value": 1100}]}},
             {"id": "copy1", "type": "shape", "shape": {"kind": "rect", "width": 4, "height": 4},
              "fill": "#fff", "opacity": 0.5,
              "transform": {"x": [{"frame": 0, "value": 2000}, {"frame": 10, "value": 2100}]}}]}}]}"##;
        let scene = Scene::from_json(json, PathBuf::new()).unwrap();
        let layer = &scene.resolve(5).unwrap().layers[0];
        // The sub-frames sit at t = 4.75 and 5.25.
        let xs: Vec<f64> = layer.motion.iter().map(|m| m.transform.x).collect();
        assert_eq!(xs, [1047.5, 2052.5]);
        assert_eq!(
            layer.motion.iter().map(|m| m.opacity).collect::<Vec<_>>(),
            [0.25, 0.5]
        );
        assert!(layer.motion.iter().all(|m| m.id == "a"));
        // The frame itself is the layer's own.
        assert_eq!(layer.transform.x, 50.0);
        // Without frames the layer is its own sub-frames.
        let plain = json.replace(r#""frames": ["#, r#""unused": ["#);
        let scene = Scene::from_json(&plain, PathBuf::new()).unwrap();
        let layer = &scene.resolve(5).unwrap().layers[0];
        let xs: Vec<f64> = layer.motion.iter().map(|m| m.transform.x).collect();
        assert_eq!(xs, [47.5, 52.5]);
    }

    fn examples() -> PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples")
    }

    /// The box of the image layer `pic` (720 x 540 on disk) at frame 0.
    fn image_box(sides: &str) -> (f64, f64) {
        let json = format!(
            r##"{{"width": 100, "height": 100, "fps": 30, "durationInFrames": 11, "layers": [
              {{"id": "pic", "type": "image", "src": "card-art.png", {sides}}}]}}"##
        );
        let scene = Scene::from_json(&json, examples()).unwrap();
        match &scene.resolve(5).unwrap().layers[0].kind {
            ResolvedKind::Image { width, height, .. } => (*width, *height),
            _ => panic!("not an image"),
        }
    }

    #[test]
    fn an_image_without_sides_is_the_files_size_and_keeps_its_aspect_ratio() {
        assert_eq!(image_box(r#""fit": "fill""#), (720.0, 540.0));
        // 720 x 540 is 4:3.
        assert_eq!(image_box(r#""width": 400"#), (400.0, 300.0));
        assert_eq!(image_box(r#""height": 270"#), (360.0, 270.0));
        // Animated: frame 5 is half way.
        assert_eq!(
            image_box(r#""width": [{"frame": 0, "value": 100}, {"frame": 10, "value": 500}]"#),
            (300.0, 225.0)
        );
        // Both given: the box as given, whatever the file's shape.
        assert_eq!(image_box(r#""width": 10, "height": 90"#), (10.0, 90.0));
    }

    #[test]
    fn gradient_units_and_fit_are_carried_to_the_resolved_layer() {
        let json = r##"{"width": 100, "height": 100, "fps": 30, "durationInFrames": 2, "layers": [
          {"id": "s", "type": "shape", "shape": {"kind": "rect", "width": 40, "height": 20},
           "fill": {"type": "linear", "x0": 0, "y0": 0, "x1": 1, "y1": 0, "units": "box",
                    "stops": [{"offset": 0, "color": "#fff"}, {"offset": 1, "color": "#000"}]},
           "mask": {"gradient": {"type": "radial", "cx": 0.5, "cy": 0.5, "r": 0.5,
                    "stops": [{"offset": 0, "color": "#fff"}, {"offset": 1, "color": "#000"}]}}},
          {"id": "i", "type": "image", "src": "x.png", "width": 4, "height": 4, "fit": "cover"}]}"##;
        let layers = Scene::from_json(json, PathBuf::new())
            .unwrap()
            .resolve(0)
            .unwrap()
            .layers;
        let ResolvedKind::Shape {
            fill: Some(ResolvedPaint::Gradient(fill)),
            ..
        } = &layers[0].kind
        else {
            panic!("not a gradient fill");
        };
        assert_eq!(fill.units, Units::Box);
        assert_eq!(layers[0].mask.as_ref().unwrap().gradient.units, Units::User);
        assert!(matches!(
            &layers[1].kind,
            ResolvedKind::Image {
                fit: Fit::Cover,
                ..
            }
        ));
    }

    /// A scene with the DM Sans font of the repository, whose paths resolve
    /// from the workspace root.
    fn scene_with_font(layers: &str) -> Scene {
        let json = format!(
            r##"{{"width": 400, "height": 300, "fps": 30, "durationInFrames": 11,
                "fonts": {{"DM Sans": "assets/fonts/DMSans-Medium.ttf"}}, "layers": {layers}}}"##
        );
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        Scene::from_json(&json, root).unwrap()
    }

    #[test]
    fn the_origin_is_a_fraction_of_the_box_and_moves_nothing_at_rest() {
        let scene = scene_with_font(
            r##"[
              {"id": "r", "type": "shape", "shape": {"kind": "rect", "width": 100, "height": 40},
               "fill": "#fff", "transform": {"x": 50, "y": 60, "originX": 0.5, "originY": [{"frame": 0, "value": 0}, {"frame": 10, "value": 1}]}},
              {"id": "p", "type": "shape", "shape": {"kind": "path", "d": "M20 10 L60 10 L40 50 Z"},
               "fill": "#fff", "transform": {"originX": 1, "originY": 0.5}},
              {"id": "t", "type": "text", "text": "Hi", "font": "DM Sans", "size": 40,
               "color": "#fff", "transform": {"originX": 0.5}},
              {"id": "g", "type": "group", "children": [], "transform": {"originX": 0.5}},
              {"id": "z", "type": "shape", "shape": {"kind": "rect", "width": 100, "height": 40},
               "fill": "#fff"}
            ]"##,
        );
        let layers = scene.resolve(5).unwrap().layers;
        // 100 x 40: half the width, and the animated fraction 0.5 of 40.
        let t = &layers[0].transform;
        assert_eq!((t.origin_x, t.origin_y), (50.0, 20.0));
        // A path's box is its bounding box, 40 x 40 from (20, 10): the
        // origin is the middle of its right side, not measured from 0, 0.
        let t = &layers[1].transform;
        assert_eq!((t.origin_x, t.origin_y), (60.0, 30.0));
        // Text: half the laid-out width.
        let mut engine = TextEngine::new(&scene.fonts, &scene.base_dir).unwrap();
        let width = f64::from(
            engine
                .layout("Hi", "DM Sans", 40.0, None, None, TextAlign::Left)
                .width,
        );
        assert!((layers[2].transform.origin_x - width / 2.0).abs() < 1e-3);
        // A group has no box: the origin is ignored. So is none at all.
        assert_eq!(layers[3].transform.origin_x, 0.0);
        assert_eq!(layers[4].transform.origin_x, 0.0);
        // Turning about the pivot leaves it where it is, and without any
        // turn the layer is where it would be without an origin.
        let mut rect = layers[0].transform;
        let pivot = rect.matrix() * vello::kurbo::Point::new(50.0, 20.0);
        assert!(pivot.distance(vello::kurbo::Point::new(100.0, 80.0)) < 1e-9);
        rect.rotation = 70.0;
        rect.scale = 2.0;
        let turned = rect.matrix() * vello::kurbo::Point::new(50.0, 20.0);
        assert!(turned.distance(pivot) < 1e-9);
        rect.rotation = 0.0;
        rect.scale = 1.0;
        let corner = rect.matrix() * vello::kurbo::Point::new(0.0, 0.0);
        assert!(corner.distance(vello::kurbo::Point::new(50.0, 60.0)) < 1e-9);
        // The same answers through an engine the caller owns.
        let again = scene.resolve_with_text(5, &mut engine).unwrap().layers;
        assert_eq!(again, layers);
    }

    #[test]
    fn character_styles_are_resolved_per_frame_and_opacity_is_clamped() {
        let scene = scene_with_font(
            r##"[{"id": "t", "type": "text", "text": "abc", "font": "DM Sans", "size": 20,
                  "color": "#fff", "chars": [
                    null,
                    {"x": [{"frame": 0, "value": 0}, {"frame": 10, "value": 20}],
                     "scale": 2, "rotation": 90, "opacity": [{"frame": 0, "value": -1}, {"frame": 10, "value": 3}],
                     "color": "#ff0000"}]},
                 {"id": "u", "type": "text", "text": "abc", "font": "DM Sans", "size": 20,
                  "color": "#fff"}]"##,
        );
        let layers = scene.resolve(5).unwrap().layers;
        let chars = |l: &ResolvedLayer| match &l.kind {
            ResolvedKind::Text { chars, .. } => chars.clone(),
            _ => panic!("not text"),
        };
        let styled = chars(&layers[0]);
        assert_eq!(styled.len(), 2);
        assert!(styled[0].is_none());
        let c = styled[1].unwrap();
        assert_eq!((c.x, c.y, c.scale, c.rotation), (10.0, 0.0, 2.0, 90.0));
        assert_eq!(c.opacity, 1.0);
        assert_eq!(c.color, Some(Color::parse("#ff0000").unwrap()));
        // At frame 0 the opacity is -1 and clamps to 0.
        let first = chars(&scene.resolve(0).unwrap().layers[0]);
        assert_eq!(first[1].unwrap().opacity, 0.0);
        // A layer without chars has none, so it resolves as before.
        assert!(chars(&layers[1]).is_empty());
    }

    /// The resolved lottie layer `anim` of a 30 fps scene with `layer`'s
    /// fields, at `frame`.
    fn lottie_at(layer: &str, frame: u32) -> ResolvedKind {
        let json = format!(
            r##"{{"width": 100, "height": 100, "fps": 30, "durationInFrames": 30, "layers": [
              {{"id": "anim", "type": "lottie", "src": "burst.json", {layer}}}]}}"##
        );
        let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scenes/anims");
        let scene = Scene::from_json(&json, base).unwrap();
        scene.resolve(frame).unwrap().layers.remove(0).kind
    }

    #[test]
    fn a_lottie_box_is_the_animations_size_or_keeps_its_aspect_ratio() {
        let boxed = |layer: &str| match lottie_at(layer, 0) {
            ResolvedKind::Lottie { width, height, .. } => (width, height),
            _ => panic!("not a lottie layer"),
        };
        // burst.json is 120 x 120.
        assert_eq!(boxed(r#""loop": false"#), (120.0, 120.0));
        assert_eq!(boxed(r#""width": 60"#), (60.0, 60.0));
        assert_eq!(boxed(r#""height": 30"#), (30.0, 30.0));
        assert_eq!(boxed(r#""width": 60, "height": 20"#), (60.0, 20.0));
    }

    #[test]
    fn a_lottie_time_follows_the_frame_unless_given() {
        let time = |layer: &str, frame: u32| match lottie_at(layer, frame) {
            ResolvedKind::Lottie { time, looped, .. } => (time, looped),
            _ => panic!("not a lottie layer"),
        };
        assert_eq!(time(r#""loop": true"#, 15), (0.5, true));
        assert_eq!(time(r#""width": 1, "height": 1"#, 0), (0.0, false));
        assert_eq!(time(r#""time": 1.25"#, 15), (1.25, false));
        let keyed = r#""time": [{"frame": 0, "value": 0}, {"frame": 30, "value": 3}]"#;
        assert_eq!(time(keyed, 15), (1.5, false));
        // A sub-frame is at its own time.
        let json = r##"{"width": 100, "height": 100, "fps": 30, "durationInFrames": 30, "layers": [
          {"id": "a", "type": "lottie", "src": "x.json", "width": 5, "height": 5,
           "motionBlur": {"samples": 2, "shutter": 1}}]}"##;
        let layers = Scene::from_json(json, std::path::PathBuf::new())
            .unwrap()
            .resolve(15)
            .unwrap()
            .layers;
        let times: Vec<f64> = layers[0]
            .motion
            .iter()
            .map(|m| match &m.kind {
                ResolvedKind::Lottie { time, .. } => *time,
                _ => panic!("not a lottie layer"),
            })
            .collect();
        assert_eq!(times, [(15.0 - 0.25) / 30.0, (15.0 + 0.25) / 30.0]);
    }

    /// A 24 fps, 60 frame scene with video layer `clip` (clip.mp4, 2 s, a
    /// picture every 512 ticks of 1/12288 s) and `layer`'s fields.
    fn video_scene(layer: &str) -> Scene {
        let json = format!(
            r##"{{"width": 100, "height": 100, "fps": 24, "durationInFrames": 60, "layers": [
              {{"id": "clip", "type": "video", "src": "clip.mp4", {layer}}}]}}"##
        );
        let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scenes/media");
        Scene::from_json(&json, base).unwrap()
    }

    fn video_at(scene: &Scene, frame: u32) -> (f64, i64) {
        match &scene.resolve(frame).unwrap().layers[0].kind {
            ResolvedKind::Video { time, .. } => (time.seconds, time.ts),
            _ => panic!("not a video layer"),
        }
    }

    #[test]
    fn a_video_box_is_the_streams_size_or_keeps_its_aspect_ratio() {
        let boxed = |layer: &str| match video_scene(layer).resolve(0).unwrap().layers.remove(0).kind
        {
            ResolvedKind::Video {
                width, height, fit, ..
            } => (width, height, fit),
            _ => panic!("not a video layer"),
        };
        // clip.mp4 is 64 x 36.
        assert_eq!(boxed(r#""loop": false"#), (64.0, 36.0, Fit::Fill));
        assert_eq!(boxed(r#""width": 32"#), (32.0, 18.0, Fit::Fill));
        assert_eq!(boxed(r#""height": 72"#), (128.0, 72.0, Fit::Fill));
        assert_eq!(
            boxed(r#""width": 10, "height": 20, "fit": "cover""#),
            (10.0, 20.0, Fit::Cover)
        );
    }

    #[test]
    fn a_video_shows_the_picture_its_frame_picks() {
        // At the clip's own 24 fps, frame n is picture n (512 ticks each).
        let scene = video_scene(r#""loop": false"#);
        assert_eq!(video_at(&scene, 0), (0.0, 0));
        assert_eq!(video_at(&scene, 12), (0.5, 12 * 512));
        // The file ends at 2 s (24576 ticks): frame 48 and later ask for the
        // last tick before the end, which is in the last picture.
        assert_eq!(video_at(&scene, 48).1, 24575);
        assert_eq!(video_at(&scene, 59), (2.0, 24575));
        // `from`, `trimBefore` and `playbackRate` move and speed the clip.
        let scene = video_scene(r#""from": 10, "trimBefore": 6, "playbackRate": 2"#);
        assert_eq!(video_at(&scene, 5), (0.25, 6 * 512));
        assert_eq!(video_at(&scene, 10), (0.25, 6 * 512));
        assert_eq!(video_at(&scene, 11), ((6.0 + 2.0) / 24.0, 8 * 512));
        // A looped, trimmed clip: file frames 12 to 36, 24 frames long.
        let scene = video_scene(r#""trimBefore": 12, "trimAfter": 36, "loop": true"#);
        assert_eq!(video_at(&scene, 0).1, 12 * 512);
        assert_eq!(video_at(&scene, 23).1, 35 * 512);
        assert_eq!(video_at(&scene, 24).1, 12 * 512);
        // Not looped, it holds the last tick before `trimAfter` (1.5 s).
        let scene = video_scene(r#""trimBefore": 12, "trimAfter": 36"#);
        assert_eq!(video_at(&scene, 40).1, 18431);
        // A time between pictures is its own tick; the decoder picks the
        // picture at or before it.
        let scene = video_scene(r#""playbackRate": 0.5"#);
        assert_eq!(video_at(&scene, 3), (1.5 / 24.0, 768));
        // `frame` holds or moves the clip's clock apart from the scene's.
        let scene = video_scene(r#""frame": 20"#);
        assert_eq!(video_at(&scene, 0).1, 20 * 512);
        assert_eq!(video_at(&scene, 50).1, 20 * 512);
        let scene =
            video_scene(r#""frame": [{"frame": 0, "value": 0}, {"frame": 10, "value": 30}]"#);
        assert_eq!(video_at(&scene, 5).1, 15 * 512);
    }

    #[test]
    fn a_video_sub_frame_is_at_its_own_time() {
        let scene = video_scene(r#""motionBlur": {"samples": 2, "shutter": 1}"#);
        let layers = scene.resolve(24).unwrap().layers;
        let times: Vec<f64> = layers[0]
            .motion
            .iter()
            .map(|m| match &m.kind {
                ResolvedKind::Video { time, .. } => time.seconds,
                _ => panic!("not a video layer"),
            })
            .collect();
        assert_eq!(times, [(24.0 - 0.25) / 24.0, (24.0 + 0.25) / 24.0]);
    }

    #[test]
    fn a_gif_time_follows_the_frame_unless_given() {
        let gif_at = |layer: &str, frame: u32| {
            let json = format!(
                r##"{{"width": 100, "height": 100, "fps": 24, "durationInFrames": 60, "layers": [
                  {{"id": "g", "type": "gif", "src": "spinner.gif", {layer}}}]}}"##
            );
            let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scenes/media");
            let scene = Scene::from_json(&json, base).unwrap();
            match scene.resolve(frame).unwrap().layers.remove(0).kind {
                ResolvedKind::Gif {
                    time,
                    looped,
                    width,
                    height,
                    ..
                } => (time, looped, width, height),
                _ => panic!("not a gif layer"),
            }
        };
        assert_eq!(gif_at(r#""loop": false"#, 12), (0.5, false, 32.0, 24.0));
        assert_eq!(gif_at(r#""height": 48"#, 0), (0.0, true, 64.0, 48.0));
        assert_eq!(gif_at(r#""time": 1.25"#, 12).0, 1.25);
    }

    #[test]
    fn text_align_is_resolved() {
        let scene = scene_with_font(
            r##"[{"id": "t", "type": "text", "text": "a", "font": "DM Sans", "size": 20,
                  "color": "#fff", "align": "center"},
                 {"id": "u", "type": "text", "text": "a", "font": "DM Sans", "size": 20,
                  "color": "#fff"}]"##,
        );
        let layers = scene.resolve(0).unwrap().layers;
        let align = |l: &ResolvedLayer| match &l.kind {
            ResolvedKind::Text { align, .. } => *align,
            _ => panic!("not text"),
        };
        assert_eq!(align(&layers[0]), TextAlign::Center);
        assert_eq!(align(&layers[1]), TextAlign::Left);
    }
}
