//! The data of a resolved scene: every animated value a plain number.

use super::*;

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
    /// Stretch along the layer's own axes, multiplied with `scale` (`scene::Transform::scale_x`).
    pub scale_x: f64,
    pub scale_y: f64,
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

impl Default for ResolvedTransform {
    /// The transform that moves nothing.
    fn default() -> Self {
        ResolvedTransform {
            x: 0.0,
            y: 0.0,
            scale: 1.0,
            scale_x: 1.0,
            scale_y: 1.0,
            rotation: 0.0,
            anchor_x: 0.0,
            anchor_y: 0.0,
            rotate_x: 0.0,
            rotate_y: 0.0,
            z: 0.0,
            origin_x: 0.0,
            origin_y: 0.0,
            matrix: None,
            backface_hidden: false,
        }
    }
}

impl ResolvedTransform {
    /// Layer space to parent space: move the anchor to the origin, scale
    /// (`scale` times `scale_x` across, `scale` times `scale_y` down), rotate,
    /// then translate to (x, y).
    ///
    /// The origin moves the pivot of the turn and the scale to the anchor plus
    /// the origin, and puts the layer back so that nothing moves while it is
    /// not turned or scaled: the pivot lands where it is without them.
    pub fn matrix(&self) -> Affine {
        let stretch = Affine::scale_non_uniform(self.scale * self.scale_x, self.scale * self.scale_y);
        let css = self
            .matrix
            .filter(crate::scene::matrix_is_affine_2d)
            .map_or(Affine::IDENTITY, |m| {
                Affine::new([m[0], m[1], m[4], m[5], m[12], m[13]])
            });
        if self.origin_x != 0.0 || self.origin_y != 0.0 {
            return Affine::translate((self.x + self.origin_x, self.y + self.origin_y))
                * Affine::rotate(self.rotation.to_radians())
                * stretch
                * css
                * Affine::translate((
                    -(self.anchor_x + self.origin_x),
                    -(self.anchor_y + self.origin_y),
                ));
        }
        Affine::translate((self.x, self.y))
            * Affine::rotate(self.rotation.to_radians())
            * stretch
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
    /// Standard deviation in pixels of the blur applied to the backdrop;
    /// `mirror`: only the backdrop inside the layer's box, mirrored past its
    /// edges (`scene::BackdropEdge::Mirror`).
    BackdropBlur {
        radius: f32,
        mirror: bool,
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
        interpolation: LutInterpolation,
    },
    Grain(ResolvedGrain),
    Dither(ResolvedDither),
    Halftone(ResolvedHalftone),
    DotMatrix(ResolvedDotMatrix),
    Displace(ResolvedDisplace),
    CornerPin(ResolvedCornerPin),
    FilterGraph(Box<crate::filter::ResolvedFilterGraph>),
    ColorGrade(Box<crate::grade::ResolvedColorGrade>),
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
pub(super) const MAX_STAGGER: f64 = 0.999;

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
    /// Standard deviation of the blur, 0..=`MAX_BLUR_RADIUS`.
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
        fill_rule: FillRule,
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
        fill_rule: FillRule,
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
    pub(super) fn resolve(shape: &ShapeLayer, f: f64) -> ShapeStyle {
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

/// A text's stroke at one frame.
#[derive(Clone, Debug, PartialEq)]
pub struct TextStroke {
    pub color: Color,
    pub width: f64,
    pub join: StrokeJoin,
    pub miter_limit: f64,
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
    /// The gap between copies along a direction that repeats.
    pub space_x: f64,
    pub space_y: f64,
    pub sampling: Sampling,
}

/// `scene::Tile` at one frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResolvedTile {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub space_x: f64,
    pub space_y: f64,
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
    /// Stops blend without premultiplying alpha (`Gradient::unpremultiplied`).
    pub unpremultiplied: bool,
    /// Painted in one tile, repeated (`Gradient::tile`).
    pub tile: Option<ResolvedTile>,
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

/// Largest radius of a blur (the `blur`, `backdropBlur` and `glow` effects, a
/// shadow's blur); bigger values are clamped. Only to keep the numbers of a
/// blur's textures in range: a blur this wide spreads anything on a canvas of
/// at most `MAX_SIDE` pixels to much less than a level, and no texture of a
/// blur is larger than `MAX_SIDE` at any radius (`blur.rs`).
pub const MAX_BLUR_RADIUS: f64 = 16384.0;

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
        /// The outline of each glyph, and how it is drawn.
        stroke: Option<TextStroke>,
        paint_order: TextPaintOrder,
    },
    Image {
        src: String,
        /// The box the picture is fitted to.
        width: f64,
        height: f64,
        fit: Fit,
        sampling: Sampling,
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
        /// `GroupLayer::canvas`: commands drawn in the box `(0, 0, width,
        /// height)`, whose `layer` sources are the children.
        canvas: Option<(f64, f64, Arc<Vec<CanvasOp>>)>,
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
        /// Datamosh: set on a frame inside the layer's window, where the
        /// picture is the held one moved by the clip's motion (`datamosh.rs`).
        mosh: Option<ResolvedMosh>,
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
