//! The JSON scene graph. See docs/SCENE.md for the format.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use vello::kurbo::BezPath;

use crate::anim::Num;
use crate::color::Color;
use crate::error::{Error, Result};
use crate::resolve::MAX_BLUR_RADIUS;
use crate::turbulence::MAX_OCTAVES;

/// Largest canvas side; wgpu's default texture limit.
pub const MAX_SIDE: u32 = 8192;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration_in_frames: u32,
    #[serde(default = "default_background")]
    pub background: Color,
    /// Font family name -> font file path.
    #[serde(default)]
    pub fonts: BTreeMap<String, String>,
    /// The viewpoint that layers with a 3D transform are drawn from. Without
    /// one, 3D transforms are orthographic: no perspective.
    pub camera: Option<Camera>,
    /// Bottom layer first.
    pub layers: Vec<Layer>,
    /// Directory that asset paths resolve against (the scene file's directory).
    #[serde(skip)]
    pub base_dir: PathBuf,
}

fn default_background() -> Color {
    Color::BLACK
}

/// CSS's `perspective` and `perspective-origin`, for the whole scene.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Camera {
    /// Distance from the eye to the canvas plane, in canvas pixels, above 0.
    /// A point `z` pixels toward the viewer is magnified by
    /// `perspective / (perspective - z)`.
    pub perspective: Num,
    /// Where the eye looks at the canvas, in canvas pixels. Omitted: the
    /// middle of the canvas.
    pub x: Option<Num>,
    pub y: Option<Num>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    pub id: String,
    #[serde(default)]
    pub transform: Transform,
    #[serde(default = "one")]
    pub opacity: Num,
    #[serde(default)]
    pub blend_mode: BlendMode,
    #[serde(default)]
    pub effects: Vec<Effect>,
    /// Cuts the layer to a shape, after its effects.
    pub clip: Option<Clip>,
    /// Fades the layer by a gradient, after the clip.
    pub mask: Option<Mask>,
    /// Cuts the layer by a sibling layer's pixels, after the mask.
    pub matte: Option<Matte>,
    /// Averages the layer over the time the shutter is open, so what moves
    /// smears. A group blurs its whole subtree.
    pub motion_blur: Option<MotionBlur>,
    #[serde(flatten)]
    pub kind: LayerKind,
}

/// Fewest and most sub-frames a layer's motion blur averages.
pub const MIN_MOTION_SAMPLES: i64 = 2;
pub const MAX_MOTION_SAMPLES: i64 = 64;

/// A layer's motion blur: `samples` copies of it, spread over `shutter`
/// frames centred on the frame, each evaluated at its own time and averaged.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionBlur {
    /// Whole, `MIN_MOTION_SAMPLES..=MAX_MOTION_SAMPLES`; not animated.
    #[serde(default = "default_motion_samples")]
    pub samples: i64,
    /// How long the shutter is open, in frames; 0.5 is a 180 degree shutter.
    /// Clamped to 0..=2 when resolved; 0 is no blur.
    #[serde(default = "half")]
    pub shutter: Num,
}

fn default_motion_samples() -> i64 {
    8
}

fn half() -> Num {
    Num::Const(0.5)
}

fn one() -> Num {
    Num::Const(1.0)
}

fn zero() -> Num {
    Num::Const(0.0)
}

fn two() -> Num {
    Num::Const(2.0)
}

fn eight() -> Num {
    Num::Const(8.0)
}

fn twelve() -> Num {
    Num::Const(12.0)
}

fn forty_five() -> Num {
    Num::Const(45.0)
}

fn stagger_default() -> Num {
    Num::Const(0.6)
}

fn three() -> u32 {
    3
}

fn yes() -> bool {
    true
}

fn black() -> Color {
    Color::BLACK
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LayerKind {
    Shape(ShapeLayer),
    Text(TextLayer),
    Image(ImageLayer),
    Group(GroupLayer),
    Noise(NoiseLayer),
    MeshGradient(MeshGradientLayer),
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Transform {
    pub x: Num,
    pub y: Num,
    pub scale: Num,
    /// Degrees, clockwise.
    pub rotation: Num,
    pub anchor_x: Num,
    pub anchor_y: Num,
    /// Degrees. Turns the layer about the horizontal axis through its
    /// position, as CSS's `rotateX`: positive tips the top away.
    pub rotate_x: Num,
    /// Degrees. Turns the layer about the vertical axis through its
    /// position, as CSS's `rotateY`: positive swings the right edge away.
    pub rotate_y: Num,
    /// Pixels toward the viewer, as CSS's `translateZ`. Moves nothing on
    /// screen without a camera, but still orders a `preserve3d` group.
    pub z: Num,
}

impl Transform {
    /// Whether the layer is moved in 3D at any keyframe.
    pub fn is_3d(&self) -> bool {
        [&self.rotate_x, &self.rotate_y, &self.z]
            .iter()
            .any(|n| n.min() != 0.0 || n.max() != 0.0)
    }
}

impl Default for Transform {
    fn default() -> Self {
        Transform {
            x: Num::Const(0.0),
            y: Num::Const(0.0),
            scale: Num::Const(1.0),
            rotation: Num::Const(0.0),
            anchor_x: Num::Const(0.0),
            anchor_y: Num::Const(0.0),
            rotate_x: Num::Const(0.0),
            rotate_y: Num::Const(0.0),
            z: Num::Const(0.0),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BlendMode {
    #[default]
    Normal,
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
}

/// Per-layer effects. Each one added here gets a matching variant in
/// `resolve::ResolvedEffect` and a pass in the compositor.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Effect {
    /// Gaussian-like blur; `radius` is roughly the standard deviation in
    /// pixels.
    Blur { radius: Num },
    /// Frosted glass: what is behind the layer, blurred, shows through the
    /// layer's shape. `radius` is like `blur`'s.
    BackdropBlur { radius: Num },
    /// A halo: the layer blurred, drawn under itself. `radius` is like
    /// `blur`'s. `color` replaces the halo's colours (its alpha scales the
    /// halo); `intensity` scales it, 0..4.
    Glow {
        radius: Num,
        color: Option<Color>,
        #[serde(default = "one")]
        intensity: Num,
    },
    /// Splits the colour channels apart: red is read `amount` pixels along
    /// `angle` (degrees, clockwise from the +x axis, so 90 is down) and blue
    /// the same distance the other way. Negative `amount` swaps them.
    ChromaticAberration {
        amount: Num,
        #[serde(default = "zero")]
        angle: Num,
    },
    /// The layer's shadow, cast onto what is behind it.
    DropShadow(Shadow),
    /// A shadow cast inside the layer's own shape.
    InsetShadow(Shadow),
    /// The colour filters below follow CSS. A run of them in a row becomes
    /// one pass. `amount` is 1 when omitted, which is no change for
    /// `saturate`, `contrast` and `brightness` and the full effect for the
    /// others.
    Saturate {
        #[serde(default = "one")]
        amount: Num,
    },
    Contrast {
        #[serde(default = "one")]
        amount: Num,
    },
    Brightness {
        #[serde(default = "one")]
        amount: Num,
    },
    Grayscale {
        #[serde(default = "one")]
        amount: Num,
    },
    Sepia {
        #[serde(default = "one")]
        amount: Num,
    },
    Invert {
        #[serde(default = "one")]
        amount: Num,
    },
    /// Turns the hue by `angle` degrees.
    HueRotate {
        #[serde(default = "zero")]
        angle: Num,
    },
    /// Maps each pixel's luminance through colour stops (the thermal look).
    /// `amount` cross-fades from the original (0) to the graded image (1).
    GradientMap {
        /// `MIN_GRADIENT_MAP_STOPS..=MAX_GRADIENT_MAP_STOPS`, offsets in 0..=1.
        stops: Vec<Stop>,
        #[serde(default = "one")]
        amount: Num,
    },
    /// Applies a `.cube` 3D colour lookup table (path relative to the scene
    /// file) to the sRGB colours; `amount` cross-fades from the original (0)
    /// to the graded image (1).
    Lut {
        src: String,
        #[serde(default = "one")]
        amount: Num,
    },
    /// Film grain: seeded zero-mean noise added to the sRGB colour, fixed to
    /// the canvas.
    Grain {
        /// Strength, 0..1: the noise spans plus and minus this much of the
        /// 0..1 colour range.
        amount: Num,
        /// Grain cell size in canvas pixels, at least 1.
        #[serde(default = "one")]
        size: Num,
        /// Which pattern, 0..=u32::MAX; checked when the scene loads.
        seed: i64,
        /// A new pattern each frame.
        #[serde(default = "yes")]
        animate: bool,
        /// One noise value for r, g and b; false is per channel.
        #[serde(default = "yes")]
        monochrome: bool,
    },
    /// Quantises each sRGB channel to a few levels, with an ordered Bayer
    /// pattern or seeded noise choosing between the two nearest.
    Dither {
        #[serde(default)]
        mode: DitherMode,
        /// Levels per channel, 2..=256 (rounded).
        #[serde(default = "two")]
        levels: Num,
        /// Canvas pixels per dither cell, at least 1.
        #[serde(default = "one")]
        size: Num,
        /// Required for `random`, 0..=u32::MAX; ignored by `ordered`.
        seed: Option<i64>,
        /// A new random pattern each output frame (`random` only).
        #[serde(default)]
        animate: bool,
    },
    /// Replaces the layer with a halftone screen in layer space: a rotated
    /// grid of dots whose area follows the layer's brightness.
    Halftone {
        /// Cell width in layer pixels, above 0.
        #[serde(default = "eight")]
        size: Num,
        /// Degrees, clockwise.
        #[serde(default = "forty_five")]
        angle: Num,
        #[serde(default)]
        shape: HalftoneShape,
        /// Dot colour; the sampled layer colour when absent.
        color: Option<Color>,
        /// Dark areas get the big dots instead of light ones.
        #[serde(default)]
        invert: bool,
    },
    /// Reveals the layer through a layer-space grid of dots that grow from
    /// nothing (progress 0) to solid (progress 1), each starting after its own
    /// delay.
    DotMatrix {
        /// Cell width in layer pixels, above 0.
        #[serde(default = "twelve")]
        size: Num,
        /// 0 shows nothing, 1 shows the layer; clamped to 0..=1.
        progress: Num,
        #[serde(default)]
        order: DotOrder,
        /// For `sweep`: the direction the reveal travels, degrees clockwise
        /// from +x (0 is left to right).
        #[serde(default = "zero")]
        angle: Num,
        /// How much of the progress range is spent on delays, 0 up to (not
        /// including) 1.
        #[serde(default = "stagger_default")]
        stagger: Num,
        /// Which delays, 0..=u32::MAX; required for `random`, ignored by
        /// `sweep`.
        seed: Option<i64>,
        #[serde(default)]
        shape: DotShape,
    },
    /// SVG's `feTurbulence` -> `feDisplacementMap`: pulls each pixel from
    /// somewhere else on the layer, as far as turbulence noise says.
    Displace {
        /// Layer pixels: a pixel is read from up to half of this away, in
        /// each direction (the noise channel's 0..1 less a half, times it).
        scale: Num,
        /// Which noise channel moves a pixel across (default `R`).
        #[serde(default = "red", rename = "xChannelSelector")]
        x_channel_selector: Channel,
        /// Which moves it down (default `G`).
        #[serde(default = "green", rename = "yChannelSelector")]
        y_channel_selector: Channel,
        turbulence: Turbulence,
    },
    /// Pins the layer's four box corners to four points, warping it into a
    /// quadrilateral with perspective. A corner left out stays where it is.
    #[serde(rename_all = "camelCase")]
    CornerPin {
        top_left: Option<[Num; 2]>,
        top_right: Option<[Num; 2]>,
        bottom_right: Option<[Num; 2]>,
        bottom_left: Option<[Num; 2]>,
    },
    /// The user's own fragment shader.
    Shader(ShaderEffect),
}

/// One channel of a noise image.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Channel {
    R,
    G,
    B,
    A,
}

impl Channel {
    /// The channel's number in the noise tables.
    pub fn index(self) -> u32 {
        match self {
            Channel::R => 0,
            Channel::G => 1,
            Channel::B => 2,
            Channel::A => 3,
        }
    }
}

fn red() -> Channel {
    Channel::R
}

fn green() -> Channel {
    Channel::G
}

/// The attributes of SVG's `feTurbulence` (without `stitchTiles`), named as
/// SVG names them. See `turbulence.rs`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turbulence {
    #[serde(rename = "type")]
    pub kind: TurbulenceKind,
    /// Cycles per layer pixel, one number or `[x, y]`; not negative.
    pub base_frequency: BaseFrequency,
    /// Octaves of noise, 0..=`turbulence::MAX_OCTAVES`.
    #[serde(default = "one_octave")]
    pub num_octaves: i64,
    /// Truncated toward zero, then SVG's `setup_seed`.
    pub seed: f64,
}

fn one_octave() -> i64 {
    1
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TurbulenceKind {
    /// Signed noise centred on a middle grey: (sum + 1) / 2.
    FractalNoise,
    /// The sum of the noise's absolute values: dark with bright veins.
    Turbulence,
}

/// A noise frequency per axis. The JSON is a number (both axes) or `[x, y]`
/// (each a number or keyframes); a list of keyframe objects is one number.
#[derive(Clone, Debug)]
pub struct BaseFrequency {
    pub x: Num,
    pub y: Num,
}

impl<'de> Deserialize<'de> for BaseFrequency {
    // Read by hand: `[0.04, 0.08]` and a keyframe list are both arrays.
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        use serde::de::Error as _;
        let value = serde_json::Value::deserialize(d)?;
        let num = |v: serde_json::Value| {
            serde_json::from_value::<Num>(v)
                .map_err(|e| D::Error::custom(format!("bad baseFrequency: {e}")))
        };
        match value {
            serde_json::Value::Array(items)
                if !items.is_empty() && items.iter().all(|v| !v.is_object()) =>
            {
                let [x, y]: [serde_json::Value; 2] = items.try_into().map_err(|_| {
                    D::Error::custom(
                        "baseFrequency takes one number or [x, y], or a list of keyframes",
                    )
                })?;
                Ok(BaseFrequency {
                    x: num(x)?,
                    y: num(y)?,
                })
            }
            other => {
                let n = num(other)?;
                Ok(BaseFrequency { x: n.clone(), y: n })
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DotOrder {
    /// A random delay per cell, from the seed.
    #[default]
    Random,
    /// The delay follows the cell's position along `angle` across the
    /// layer's box.
    Sweep,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DotShape {
    #[default]
    Circle,
    Square,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HalftoneShape {
    #[default]
    Circle,
    Square,
    /// Parallel lines, thicker where the layer is brighter.
    Line,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DitherMode {
    /// An 8x8 Bayer threshold matrix.
    #[default]
    Ordered,
    /// A seeded white-noise threshold.
    Random,
}

/// Fewest and most levels per channel a `dither` takes.
pub const MIN_DITHER_LEVELS: f64 = 2.0;
pub const MAX_DITHER_LEVELS: f64 = 256.0;

/// Fewest and most stops a `gradientMap` takes; the shader's uniform block
/// holds 16.
pub const MIN_GRADIENT_MAP_STOPS: usize = 2;
pub const MAX_GRADIENT_MAP_STOPS: usize = 16;

/// Fewest and most points a `meshGradient` has along each axis.
pub const MIN_MESH_POINTS: u32 = 2;
pub const MAX_MESH_POINTS: u32 = 8;

/// The fields of `shader`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShaderEffect {
    /// WGSL defining `fn effect(px: vec2<f32>) -> vec4<f32>`; see
    /// `shader::compose` for what surrounds it.
    pub code: String,
    /// Named values the code reads as `u.<name>`. Sorted by name, which is
    /// the order they are packed in.
    #[serde(default)]
    pub uniforms: BTreeMap<String, Num>,
    /// How far past the layer the shader paints, in canvas pixels; counted
    /// in the margin.
    #[serde(default = "zero")]
    pub padding: Num,
}

impl ShaderEffect {
    /// The uniform names in packing order.
    pub fn names(&self) -> Vec<&str> {
        self.uniforms.keys().map(String::as_str).collect()
    }
}

/// The fields of `dropShadow` and `insetShadow`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shadow {
    /// Offset in canvas pixels.
    #[serde(default = "zero")]
    pub x: Num,
    #[serde(default = "zero")]
    pub y: Num,
    /// Blur radius, like the `blur` effect's.
    #[serde(default = "zero")]
    pub blur: Num,
    /// Grows the shadow (shrinks it when negative), in pixels.
    #[serde(default = "zero")]
    pub spread: Num,
    #[serde(default = "black")]
    pub color: Color,
}

impl Shadow {
    /// Offset, spread and about three blur radii, at the largest keyframes.
    /// A negative spread counts too: shrinking reads the pixels around a
    /// point just as growing does, and a layer cut off at the texture edge
    /// would shrink from there.
    fn reach(&self) -> f64 {
        let largest = |n: &Num| n.max().abs().max(n.min().abs());
        let offset = largest(&self.x).max(largest(&self.y));
        let spread = largest(&self.spread).min(MAX_SHADOW_SIZE);
        let blur = self.blur.max().clamp(0.0, MAX_SHADOW_SIZE);
        offset + spread + 3.0 * blur
    }
}

/// Largest shadow blur and spread, in pixels; bigger values are clamped.
pub const MAX_SHADOW_SIZE: f64 = 128.0;

impl Effect {
    /// How far past the layer's own pixels the effect can paint, in pixels,
    /// at its largest keyframes. Sets the scene's margin (`Scene::margin`).
    /// `layer_scale` is the largest product of the `scale` of the layer and
    /// its ancestors: only effects that measure in layer units use it.
    fn reach(&self, layer_scale: f64) -> f64 {
        match self {
            // Not counted: blur only ever spreads the layer's own pixels, and
            // leaving it out keeps scenes that use nothing else at margin 0,
            // which is exactly the canvas-sized rendering they had before.
            Effect::Blur { .. } => 0.0,
            // A backdrop blur reads the canvas around the layer, so a layer at
            // the canvas edge blurs in what lies beyond it. A glow paints
            // about three radii past the layer.
            Effect::BackdropBlur { radius } | Effect::Glow { radius, .. } => {
                3.0 * radius.max().clamp(0.0, MAX_BLUR_RADIUS)
            }
            Effect::DropShadow(shadow) | Effect::InsetShadow(shadow) => shadow.reach(),
            // Channels are shifted by up to `amount`, in either direction.
            Effect::ChromaticAberration { amount, .. } => {
                amount.max().abs().max(amount.min().abs())
            }
            // Colour filters change pixels in place.
            Effect::Saturate { .. }
            | Effect::Contrast { .. }
            | Effect::Brightness { .. }
            | Effect::Grayscale { .. }
            | Effect::Sepia { .. }
            | Effect::Invert { .. }
            | Effect::HueRotate { .. } => 0.0,
            // Recolours pixels in place.
            Effect::GradientMap { .. }
            | Effect::Lut { .. }
            | Effect::Grain { .. }
            | Effect::Dither { .. } => 0.0,
            // Dots stay inside their cells, which only sample the layer.
            Effect::Halftone { .. } | Effect::DotMatrix { .. } => 0.0,
            // A pixel is read from up to half of `scale` layer units away.
            Effect::Displace { scale, .. } => {
                scale.max().abs().max(scale.min().abs()) / 2.0 * layer_scale
            }
            // Warps what is in the texture, which paints nothing new.
            Effect::CornerPin { .. } => 0.0,
            // Whatever the shader declares it paints.
            Effect::Shader(shader) => shader.padding.max().max(0.0),
        }
    }
}

/// A shape the layer is cut to, in the layer's own coordinates, so it moves
/// with the layer's transform. Pixels outside it become transparent; the edge
/// is anti-aliased.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Clip {
    /// Non-zero fill rule.
    Polygon {
        points: Vec<[Num; 2]>,
    },
    /// The layer's own box (a shape's or image's width x height, the text
    /// layout box, a path's bounding box), shrunk by the four distances, with
    /// rounded corners.
    Inset {
        #[serde(default = "zero")]
        top: Num,
        #[serde(default = "zero")]
        right: Num,
        #[serde(default = "zero")]
        bottom: Num,
        #[serde(default = "zero")]
        left: Num,
        #[serde(default = "zero")]
        radius: Num,
    },
    Ellipse {
        cx: Num,
        cy: Num,
        rx: Num,
        ry: Num,
    },
    /// SVG path data, non-zero fill rule.
    Path {
        d: String,
    },
}

/// Multiplies the layer by a gradient. The gradient is in the layer's own
/// coordinates and fills the whole plane (see `Gradient::extend`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mask {
    pub gradient: Gradient,
    #[serde(default)]
    pub mode: MaskMode,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MaskMode {
    /// Keep the layer where the gradient is opaque.
    #[default]
    Alpha,
    /// Keep the layer where the gradient is light: Rec. 709 luminance of the
    /// linear-light colour, times its alpha.
    Luminance,
}

/// Multiplies the layer by another layer's rendered pixels. The source is not
/// drawn on its own.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Matte {
    /// The id of a layer in the same `layers` or `children` list.
    pub layer: String,
    #[serde(default)]
    pub mode: MatteMode,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MatteMode {
    /// Keep the layer where the source is opaque.
    #[default]
    Alpha,
    /// Keep the layer where the source is transparent.
    AlphaInverted,
    /// Keep the layer where the source is light (see `MaskMode::Luminance`).
    Luminance,
    /// Keep the layer where the source is dark or transparent.
    LuminanceInverted,
}

/// Colour stops along a line, around a point or around an angle. All
/// coordinates are in the space of whatever the gradient paints.
#[derive(Clone, Debug, Deserialize)]
pub struct Gradient {
    #[serde(flatten)]
    pub geometry: GradientGeometry,
    /// At least 2, offsets in 0..=1.
    pub stops: Vec<Stop>,
    #[serde(default)]
    pub extend: Extend,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GradientGeometry {
    /// Offset 0 is at (x0, y0), offset 1 at (x1, y1).
    Linear { x0: Num, y0: Num, x1: Num, y1: Num },
    /// Offset 1 is at distance `r` from the centre.
    Radial { cx: Num, cy: Num, r: Num },
    /// Offset 0 is `angle` degrees clockwise from 12 o'clock (as in CSS);
    /// offset 1 is a full turn later.
    Conic {
        cx: Num,
        cy: Num,
        #[serde(default = "zero")]
        angle: Num,
    },
}

/// A colour at an offset along the gradient. Colours are interpolated in
/// sRGB with premultiplied alpha, like CSS.
#[derive(Clone, Debug, Deserialize)]
pub struct Stop {
    pub offset: Num,
    pub color: Color,
}

/// What a gradient does outside the first and last stop.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Extend {
    /// Hold the end colours.
    #[default]
    Pad,
    /// Repeat the span from the first to the last stop, like CSS
    /// `repeating-*-gradient`.
    Repeat,
    /// Like `Repeat`, but every second span runs backwards.
    Reflect,
}

/// What a shape's `fill` or a text layer's `color` paints with: a colour
/// string or a gradient object.
#[derive(Clone, Debug)]
pub enum Paint {
    Solid(Color),
    Gradient(Gradient),
}

impl<'de> Deserialize<'de> for Paint {
    // Read by hand: an untagged enum would only say "did not match any
    // variant", and not what was wrong with the colour or the gradient.
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Paint, D::Error> {
        use serde::de::Error as _;
        let value = serde_json::Value::deserialize(d)?;
        match value {
            serde_json::Value::String(s) => {
                Color::parse(&s).map(Paint::Solid).map_err(D::Error::custom)
            }
            serde_json::Value::Object(_) => Gradient::deserialize(value)
                .map(Paint::Gradient)
                .map_err(|e| D::Error::custom(format!("bad gradient: {e}"))),
            other => Err(D::Error::custom(format!(
                "expected a colour string like \"#f6c177\" or a gradient object, got {other}"
            ))),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShapeLayer {
    pub shape: Geometry,
    /// A colour or a gradient, in the layer's own coordinates.
    pub fill: Option<Paint>,
    pub stroke: Option<Stroke>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Geometry {
    Rect {
        width: Num,
        height: Num,
    },
    RoundedRect {
        width: Num,
        height: Num,
        radius: Num,
    },
    Ellipse {
        width: Num,
        height: Num,
    },
    /// SVG path data in layer space.
    Path {
        d: String,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stroke {
    pub color: Color,
    pub width: Num,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLayer {
    pub text: String,
    /// A key of the scene's `fonts` map.
    pub font: String,
    pub size: Num,
    /// A colour or a gradient; a gradient's coordinates are in the text box.
    pub color: Paint,
    /// Multiple of the font size. Omitted: the font's own line height.
    pub line_height: Option<Num>,
    /// Wrap width in pixels. Omitted: no wrapping.
    pub max_width: Option<Num>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageLayer {
    pub src: String,
    pub width: Num,
    pub height: Num,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupLayer {
    pub children: Vec<Layer>,
    /// CSS's `transform-style: preserve-3d`: the children are drawn straight
    /// into the group's parent, in their own 3D positions, sorted by depth.
    #[serde(default)]
    pub preserve3d: bool,
}

/// The raw `feTurbulence` image over a box at the layer's origin.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseLayer {
    pub width: Num,
    pub height: Num,
    pub turbulence: Turbulence,
    #[serde(default)]
    pub channels: NoiseChannels,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoiseChannels {
    /// The four channels as red, green, blue and alpha, as SVG draws a
    /// feTurbulence.
    #[default]
    Rgba,
    /// The red channel as grey, fully opaque.
    Gray,
}

/// A grid of colour control points over a box at the layer's origin, blended
/// smoothly between the points.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshGradientLayer {
    pub width: Num,
    pub height: Num,
    /// Points per row, `MIN_MESH_POINTS..=MAX_MESH_POINTS`.
    #[serde(default = "three")]
    pub columns: u32,
    /// Points per column, `MIN_MESH_POINTS..=MAX_MESH_POINTS`.
    #[serde(default = "three")]
    pub rows: u32,
    /// Row-major positions in layer pixels. Omitted: a regular grid over the
    /// box.
    pub points: Option<Vec<[Num; 2]>>,
    /// One per point, row-major.
    pub colors: Vec<Color>,
}

impl Scene {
    pub fn load(path: &Path) -> Result<Scene> {
        let json = std::fs::read_to_string(path).map_err(|source| Error::Io {
            path: path.to_path_buf(),
            source,
        })?;
        let base_dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
        Scene::from_json(&json, base_dir)
    }

    pub fn from_json(json: &str, base_dir: PathBuf) -> Result<Scene> {
        let mut scene: Scene =
            serde_json::from_str(json).map_err(|e| Error::Scene(e.to_string()))?;
        scene.base_dir = base_dir;
        scene.validate()?;
        Ok(scene)
    }

    /// Pixels of room kept on every side of the canvas while rendering, so
    /// that effects which paint outside a layer (a shadow, a glow) are not
    /// cut off at the canvas edge and layers that hang off the canvas still
    /// feed them. It is the largest `reach` of the effects on any layer
    /// (see `max_reach`), at any keyframe, rounded up, and limited so the
    /// padded canvas still fits
    /// in `MAX_SIDE`. A scene with no such effect has margin 0.
    pub fn margin(&self) -> u32 {
        margin_for(max_reach(&self.layers, 1.0), self.width, self.height)
    }

    /// The WGSL module of every distinct custom shader in the scene, in the
    /// order they are first used (`shader::compose`). The compositor builds
    /// one pipeline per entry when the renderer is created.
    pub fn shader_sources(&self) -> Vec<String> {
        let mut sources = Vec::new();
        collect_shader_sources(&self.layers, &mut sources);
        sources
    }

    fn validate(&self) -> Result<()> {
        let bad = |msg: String| Err(Error::Scene(msg));
        if self.width == 0 || self.height == 0 || self.width > MAX_SIDE || self.height > MAX_SIDE {
            return bad(format!(
                "width and height must be 1..={MAX_SIDE}, got {}x{}",
                self.width, self.height
            ));
        }
        if !(self.fps.is_finite() && self.fps > 0.0) {
            return bad(format!("fps must be positive, got {}", self.fps));
        }
        if self.duration_in_frames == 0 {
            return bad("durationInFrames must be at least 1".into());
        }
        if let Some(camera) = &self.camera
            && camera.perspective.min() <= 0.0
        {
            return bad("camera perspective must be greater than 0".into());
        }
        let mut ids = HashSet::new();
        self.validate_layers(&self.layers, &mut ids)
    }

    fn validate_layers<'a>(&self, layers: &'a [Layer], ids: &mut HashSet<&'a str>) -> Result<()> {
        for layer in layers {
            if !ids.insert(&layer.id) {
                return Err(Error::Scene(format!("duplicate layer id {:?}", layer.id)));
            }
            let non_negative = |what: &str, n: &Num| {
                if n.min() < 0.0 {
                    return Err(Error::Scene(format!(
                        "layer {:?}: {what} must not be negative",
                        layer.id
                    )));
                }
                Ok(())
            };
            for effect in &layer.effects {
                match effect {
                    Effect::Shader(shader) => {
                        non_negative("shader padding", &shader.padding)?;
                        crate::shader::validate(&layer.id, &shader.code, &shader.names())?;
                    }
                    Effect::GradientMap { stops, .. } => validate_gradient_map(&layer.id, stops)?,
                    Effect::Grain { size, seed, .. } => {
                        validate_seed(&layer.id, "grain", *seed)?;
                        if size.min() < 1.0 {
                            return Err(Error::Scene(format!(
                                "layer {:?}: grain size must be at least 1 canvas pixel",
                                layer.id
                            )));
                        }
                    }
                    Effect::Dither {
                        mode,
                        levels,
                        size,
                        seed,
                        ..
                    } => validate_dither(&layer.id, *mode, levels, size, *seed)?,
                    Effect::Halftone { size, .. } => {
                        if size.min() <= 0.0 {
                            return Err(Error::Scene(format!(
                                "layer {:?}: halftone size must be greater than 0",
                                layer.id
                            )));
                        }
                    }
                    Effect::DotMatrix {
                        size,
                        stagger,
                        order,
                        seed,
                        ..
                    } => validate_dot_matrix(&layer.id, &layer.kind, size, stagger, *order, *seed)?,
                    Effect::Displace { turbulence, .. } => {
                        validate_turbulence(&layer.id, "displace", turbulence)?;
                    }
                    Effect::CornerPin { .. } if matches!(layer.kind, LayerKind::Group(_)) => {
                        return Err(Error::Scene(format!(
                            "layer {:?}: cornerPin needs a box, and a group has none; pin a \
                             layer inside it, or put the group's children in a layer that has one",
                            layer.id
                        )));
                    }
                    Effect::Lut { src, .. } if src.trim().is_empty() => {
                        return Err(Error::Scene(format!(
                            "layer {:?}: lut needs a src, the path of a .cube file",
                            layer.id
                        )));
                    }
                    _ => {}
                }
            }
            if let Some(clip) = &layer.clip {
                validate_clip(&layer.id, clip, &layer.kind)?;
            }
            if let Some(matte) = &layer.matte {
                validate_matte(layer, matte, layers)?;
            }
            if let Some(blur) = &layer.motion_blur
                && !(MIN_MOTION_SAMPLES..=MAX_MOTION_SAMPLES).contains(&blur.samples)
            {
                return Err(Error::Scene(format!(
                    "layer {:?}: motionBlur samples must be a whole number from \
                     {MIN_MOTION_SAMPLES} to {MAX_MOTION_SAMPLES}, got {}",
                    layer.id, blur.samples
                )));
            }
            if let Some(mask) = &layer.mask {
                validate_gradient(&layer.id, "mask gradient", &mask.gradient)?;
            }
            match &layer.kind {
                LayerKind::Shape(s) => {
                    match &s.shape {
                        Geometry::Rect { width, height }
                        | Geometry::RoundedRect { width, height, .. }
                        | Geometry::Ellipse { width, height } => {
                            non_negative("width", width)?;
                            non_negative("height", height)?;
                        }
                        Geometry::Path { d } => {
                            BezPath::from_svg(d).map_err(|e| {
                                Error::Scene(format!(
                                    "layer {:?}: bad SVG path {d:?}: {e}",
                                    layer.id
                                ))
                            })?;
                        }
                    }
                    if let Some(Paint::Gradient(g)) = &s.fill {
                        validate_gradient(&layer.id, "fill gradient", g)?;
                    }
                    if let Some(stroke) = &s.stroke {
                        non_negative("stroke width", &stroke.width)?;
                    }
                }
                LayerKind::Text(t) => {
                    if !self.fonts.contains_key(&t.font) {
                        return Err(Error::Scene(format!(
                            "layer {:?} uses font {:?}, which is not in \"fonts\"",
                            layer.id, t.font
                        )));
                    }
                    if t.size.min() <= 0.0 {
                        return Err(Error::Scene(format!(
                            "layer {:?}: text size must be positive",
                            layer.id
                        )));
                    }
                    if let Paint::Gradient(g) = &t.color {
                        validate_gradient(&layer.id, "color gradient", g)?;
                    }
                    if let Some(max_width) = &t.max_width {
                        non_negative("maxWidth", max_width)?;
                    }
                }
                LayerKind::Image(i) => {
                    non_negative("width", &i.width)?;
                    non_negative("height", &i.height)?;
                }
                LayerKind::Group(g) => {
                    if g.preserve3d {
                        validate_preserve3d(layer, layers)?;
                        if let Some(child) = g.children.iter().find(|c| c.motion_blur.is_some()) {
                            return Err(Error::Scene(format!(
                                "layer {:?}: motionBlur is not supported on the children of a \
                                 preserve3d group, which are drawn straight into its parent; \
                                 put the preserve3d group inside another group and give that one \
                                 the motionBlur",
                                child.id
                            )));
                        }
                    }
                    self.validate_layers(&g.children, ids)?;
                }
                LayerKind::Noise(n) => {
                    non_negative("width", &n.width)?;
                    non_negative("height", &n.height)?;
                    validate_turbulence(&layer.id, "noise", &n.turbulence)?;
                }
                LayerKind::MeshGradient(m) => {
                    non_negative("width", &m.width)?;
                    non_negative("height", &m.height)?;
                    validate_mesh_gradient(&layer.id, m)?;
                }
            }
        }
        Ok(())
    }
}

fn collect_shader_sources(layers: &[Layer], sources: &mut Vec<String>) {
    for layer in layers {
        for effect in &layer.effects {
            if let Effect::Shader(shader) = effect {
                let source = crate::shader::compose(&shader.code, &shader.names());
                if !sources.contains(&source) {
                    sources.push(source);
                }
            }
        }
        if let LayerKind::Group(g) = &layer.kind {
            collect_shader_sources(&g.children, sources);
        }
    }
}

/// The largest reach of any layer in `layers`. Reaches add up along a
/// chain: each effect in a list works on what the ones before it painted,
/// and a group's effects on what its children painted. `scale` is the
/// largest product of the enclosing groups' `scale` (1 for the scene's own
/// layers), which turns an effect's layer units into pixels.
fn max_reach(layers: &[Layer], scale: f64) -> f64 {
    layers.iter().fold(0.0, |most, layer| {
        let t = &layer.transform.scale;
        let scale = scale * t.max().abs().max(t.min().abs());
        let children = match &layer.kind {
            LayerKind::Group(g) => max_reach(&g.children, scale),
            _ => 0.0,
        };
        let own: f64 = layer.effects.iter().map(|e| e.reach(scale)).sum();
        most.max(children + own)
    })
}

/// `reach` rounded up to whole pixels, limited so a `width` x `height` canvas
/// plus the margin on both sides stays within `MAX_SIDE`.
fn margin_for(reach: f64, width: u32, height: u32) -> u32 {
    let room = (MAX_SIDE - width.max(height)) / 2;
    (reach.ceil() as u32).min(room)
}

fn validate_clip(id: &str, clip: &Clip, kind: &LayerKind) -> Result<()> {
    let bad = |msg: String| Err(Error::Scene(format!("layer {id:?}: clip {msg}")));
    match clip {
        Clip::Polygon { points } => {
            if points.len() < 3 {
                return bad(format!(
                    "polygon needs at least 3 points, got {}",
                    points.len()
                ));
            }
        }
        Clip::Inset { radius, .. } => {
            if matches!(kind, LayerKind::Group(_)) {
                return bad(
                    "inset needs a box, and a group has none; use a polygon or path clip".into(),
                );
            }
            if radius.min() < 0.0 {
                return bad("inset radius must not be negative".into());
            }
        }
        Clip::Ellipse { rx, ry, .. } => {
            if rx.min() < 0.0 || ry.min() < 0.0 {
                return bad("ellipse rx and ry must not be negative".into());
            }
        }
        Clip::Path { d } => {
            BezPath::from_svg(d).map_err(|e| {
                Error::Scene(format!("layer {id:?}: clip has a bad SVG path {d:?}: {e}"))
            })?;
        }
    }
    Ok(())
}

fn validate_matte(layer: &Layer, matte: &Matte, siblings: &[Layer]) -> Result<()> {
    let bad = |msg: String| Err(Error::Scene(format!("layer {:?}: matte {msg}", layer.id)));
    if matte.layer == layer.id {
        return bad("source cannot be the layer itself".into());
    }
    let Some(source) = siblings.iter().find(|l| l.id == matte.layer) else {
        return bad(format!(
            "source {:?} is not a sibling: it must be in the same layers or children list",
            matte.layer
        ));
    };
    if source.matte.is_some() {
        return bad(format!("source {:?} has a matte of its own", source.id));
    }
    if source.transform.is_3d() {
        return bad(format!(
            "source {:?} has a 3D transform (rotateX, rotateY or z); the matte moves with the \
             layer it cuts, so put them on that layer instead",
            source.id
        ));
    }
    Ok(())
}

/// A `preserve3d` group has no buffer of its own, so it has nowhere to run
/// effects, a clip, a mask or a matte, or to blend as a whole.
fn validate_preserve3d(group: &Layer, siblings: &[Layer]) -> Result<()> {
    let bad = |msg: &str| {
        Err(Error::Scene(format!(
            "layer {:?}: a preserve3d group {msg}; put the group inside another group and \
             give that one what it needs",
            group.id
        )))
    };
    if group.motion_blur.is_some() {
        return bad("cannot have motionBlur");
    }
    if !group.effects.is_empty() {
        return bad("cannot have effects");
    }
    if group.clip.is_some() {
        return bad("cannot have a clip");
    }
    if group.mask.is_some() {
        return bad("cannot have a mask");
    }
    if group.matte.is_some() {
        return bad("cannot have a matte");
    }
    if group.blend_mode != BlendMode::Normal {
        return bad("must use the normal blendMode");
    }
    if siblings
        .iter()
        .any(|l| l.matte.as_ref().is_some_and(|m| m.layer == group.id))
    {
        return bad("cannot be a matte source");
    }
    Ok(())
}

/// A seed is a whole number that fits a `u32`, so that a pattern is the same
/// on every machine and the hash input is exact.
fn validate_seed(id: &str, what: &str, seed: i64) -> Result<()> {
    if u32::try_from(seed).is_err() {
        return Err(Error::Scene(format!(
            "layer {id:?}: {what} seed must be a whole number from 0 to {}, got {seed}",
            u32::MAX
        )));
    }
    Ok(())
}

fn validate_dither(
    id: &str,
    mode: DitherMode,
    levels: &Num,
    size: &Num,
    seed: Option<i64>,
) -> Result<()> {
    let bad = |msg: String| Err(Error::Scene(format!("layer {id:?}: dither {msg}")));
    if levels.min() < MIN_DITHER_LEVELS || levels.max() > MAX_DITHER_LEVELS {
        return bad(format!(
            "levels must be between {MIN_DITHER_LEVELS} and {MAX_DITHER_LEVELS}"
        ));
    }
    if size.min() < 1.0 {
        return bad("size must be at least 1 canvas pixel".into());
    }
    match (mode, seed) {
        (DitherMode::Random, None) => bad("mode \"random\" needs a seed".into()),
        (_, Some(seed)) => validate_seed(id, "dither", seed),
        _ => Ok(()),
    }
}

fn validate_dot_matrix(
    id: &str,
    kind: &LayerKind,
    size: &Num,
    stagger: &Num,
    order: DotOrder,
    seed: Option<i64>,
) -> Result<()> {
    let bad = |msg: String| Err(Error::Scene(format!("layer {id:?}: dotMatrix {msg}")));
    if size.min() <= 0.0 {
        return bad("size must be greater than 0".into());
    }
    if stagger.min() < 0.0 || stagger.max() >= 1.0 {
        return bad("stagger must be at least 0 and below 1".into());
    }
    match (order, seed) {
        (DotOrder::Random, None) => return bad("order \"random\" needs a seed".into()),
        (_, Some(seed)) => validate_seed(id, "dotMatrix", seed)?,
        _ => {}
    }
    if order == DotOrder::Sweep && matches!(kind, LayerKind::Group(_)) {
        return bad(
            "order \"sweep\" needs a box, and a group has none; use order \"random\"".into(),
        );
    }
    Ok(())
}

fn validate_turbulence(id: &str, what: &str, t: &Turbulence) -> Result<()> {
    let bad = |msg: String| {
        Err(Error::Scene(format!(
            "layer {id:?}: {what} turbulence {msg}"
        )))
    };
    if t.base_frequency.x.min() < 0.0 || t.base_frequency.y.min() < 0.0 {
        return bad("baseFrequency must not be negative".into());
    }
    if !(0..=i64::from(MAX_OCTAVES)).contains(&t.num_octaves) {
        return bad(format!(
            "numOctaves must be a whole number from 0 to {MAX_OCTAVES}, got {}",
            t.num_octaves
        ));
    }
    Ok(())
}

fn validate_gradient_map(id: &str, stops: &[Stop]) -> Result<()> {
    let bad = |msg: String| Err(Error::Scene(format!("layer {id:?}: gradientMap {msg}")));
    if !(MIN_GRADIENT_MAP_STOPS..=MAX_GRADIENT_MAP_STOPS).contains(&stops.len()) {
        return bad(format!(
            "needs {MIN_GRADIENT_MAP_STOPS} to {MAX_GRADIENT_MAP_STOPS} stops, got {}",
            stops.len()
        ));
    }
    if stops
        .iter()
        .any(|s| s.offset.min() < 0.0 || s.offset.max() > 1.0)
    {
        return bad("stop offsets must be between 0 and 1".into());
    }
    Ok(())
}

fn validate_mesh_gradient(id: &str, mesh: &MeshGradientLayer) -> Result<()> {
    let bad = |msg: String| Err(Error::Scene(format!("layer {id:?}: meshGradient {msg}")));
    for (what, n) in [("columns", mesh.columns), ("rows", mesh.rows)] {
        if !(MIN_MESH_POINTS..=MAX_MESH_POINTS).contains(&n) {
            return bad(format!(
                "{what} must be a whole number from {MIN_MESH_POINTS} to {MAX_MESH_POINTS}, got {n}"
            ));
        }
    }
    let count = (mesh.columns * mesh.rows) as usize;
    if mesh.colors.len() != count {
        return bad(format!(
            "needs {count} colors (columns x rows), got {}",
            mesh.colors.len()
        ));
    }
    if let Some(points) = &mesh.points
        && points.len() != count
    {
        return bad(format!(
            "needs {count} points (columns x rows), got {}",
            points.len()
        ));
    }
    Ok(())
}

fn validate_gradient(id: &str, what: &str, g: &Gradient) -> Result<()> {
    let bad = |msg: &str| Err(Error::Scene(format!("layer {id:?}: {what} {msg}")));
    if g.stops.len() < 2 {
        return bad("needs at least 2 stops");
    }
    if g.stops
        .iter()
        .any(|s| s.offset.min() < 0.0 || s.offset.max() > 1.0)
    {
        return bad("stop offsets must be between 0 and 1");
    }
    if let GradientGeometry::Radial { r, .. } = &g.geometry
        && r.min() < 0.0
    {
        return bad("radius must not be negative");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scene with a 100 x 50 rect and an empty group, with `extra` spliced
    /// into the rect's fields.
    fn scene_with(extra: &str) -> Result<Scene> {
        let json = format!(
            r##"{{"width": 200, "height": 100, "fps": 30, "durationInFrames": 10,
                "fonts": {{"DM Sans": "f.ttf"}},
                "layers": [
                  {{"id": "box", "type": "shape", {extra}
                    "shape": {{"kind": "rect", "width": 100, "height": 50}}, "fill": "#fff"}},
                  {{"id": "grp", "type": "group", "children": []}}
                ]}}"##
        );
        Scene::from_json(&json, PathBuf::new())
    }

    fn error(extra: &str) -> String {
        scene_with(extra).unwrap_err().to_string()
    }

    #[test]
    fn parses_every_clip_kind() {
        for clip in [
            r#""clip": {"kind": "polygon", "points": [[0,0],[50,0],[[{"frame":0,"value":0},{"frame":9,"value":50}],40]]},"#,
            r#""clip": {"kind": "inset", "top": 4, "radius": 8},"#,
            r#""clip": {"kind": "ellipse", "cx": 50, "cy": 25, "rx": 40, "ry": 20},"#,
            r#""clip": {"kind": "path", "d": "M0 0 L50 0 L25 40 Z"},"#,
        ] {
            let scene = scene_with(clip).unwrap_or_else(|e| panic!("{clip}: {e}"));
            assert!(scene.layers[0].clip.is_some(), "{clip}");
        }
    }

    #[test]
    fn inset_sides_default_to_zero() {
        let scene = scene_with(r#""clip": {"kind": "inset"},"#).unwrap();
        let Some(Clip::Inset { top, radius, .. }) = &scene.layers[0].clip else {
            panic!("not an inset clip");
        };
        assert_eq!((top.at(0.0), radius.at(0.0)), (0.0, 0.0));
    }

    #[test]
    fn rejects_bad_clips_naming_the_layer() {
        let cases = [
            (
                r#""clip": {"kind": "polygon", "points": [[0,0],[1,1]]},"#,
                "at least 3 points",
            ),
            (
                r#""clip": {"kind": "path", "d": "M0 0 Q bogus"},"#,
                "bad SVG path",
            ),
            (
                r#""clip": {"kind": "ellipse", "cx": 0, "cy": 0, "rx": -1, "ry": 2},"#,
                "must not be negative",
            ),
            (
                r#""clip": {"kind": "inset", "radius": [{"frame":0,"value":4},{"frame":5,"value":-1}]},"#,
                "must not be negative",
            ),
            (r#""clip": {"kind": "star"},"#, "star"),
        ];
        for (clip, want) in cases {
            let msg = error(clip);
            assert!(msg.contains(want), "{clip}: {msg}");
        }
        assert!(error(r#""clip": {"kind": "polygon", "points": []},"#).contains("\"box\""));
    }

    #[test]
    fn inset_clip_on_a_group_is_an_error() {
        let json = r#"{"width": 20, "height": 20, "fps": 30, "durationInFrames": 1,
            "layers": [{"id": "g", "type": "group", "children": [],
                        "clip": {"kind": "inset", "top": 2}}]}"#;
        let msg = Scene::from_json(json, PathBuf::new())
            .unwrap_err()
            .to_string();
        assert!(
            msg.contains("\"g\"") && msg.contains("polygon or path"),
            "{msg}"
        );
    }

    #[test]
    fn parses_gradients_and_masks() {
        let mask = |gradient: &str, mode: &str| {
            scene_with(&format!(r##""mask": {{"gradient": {gradient}{mode}}},"##))
        };
        let stops = r##""stops": [{"offset": 0, "color": "#fff"}, {"offset": [{"frame": 0, "value": 0.5}, {"frame": 9, "value": 1}], "color": "#0000"}]"##;
        for gradient in [
            format!(r#"{{"type": "linear", "x0": 0, "y0": 0, "x1": 100, "y1": 0, {stops}}}"#),
            format!(
                r#"{{"type": "radial", "cx": 50, "cy": 25, "r": 40, "extend": "repeat", {stops}}}"#
            ),
            format!(r#"{{"type": "conic", "cx": 50, "cy": 25, "extend": "reflect", {stops}}}"#),
        ] {
            let scene = mask(&gradient, "").unwrap_or_else(|e| panic!("{gradient}: {e}"));
            let mask = scene.layers[0].mask.as_ref().unwrap();
            assert_eq!(mask.mode, MaskMode::Alpha);
        }
        let g = format!(r#"{{"type": "conic", "cx": 0, "cy": 0, {stops}}}"#);
        let scene = mask(&g, r#", "mode": "luminance""#).unwrap();
        assert_eq!(
            scene.layers[0].mask.as_ref().unwrap().mode,
            MaskMode::Luminance
        );
    }

    #[test]
    fn rejects_bad_gradients_naming_the_layer() {
        let two = r##""stops": [{"offset": 0, "color": "#fff"}, {"offset": 1, "color": "#000"}]"##;
        let cases = [
            (
                r##"{"type": "linear", "x0": 0, "y0": 0, "x1": 1, "y1": 0, "stops": [{"offset": 0, "color": "#fff"}]}"##.to_string(),
                "at least 2 stops",
            ),
            (
                r##"{"type": "linear", "x0": 0, "y0": 0, "x1": 1, "y1": 0, "stops": [{"offset": 0, "color": "#fff"}, {"offset": 1.5, "color": "#000"}]}"##.to_string(),
                "between 0 and 1",
            ),
            (
                format!(r#"{{"type": "radial", "cx": 0, "cy": 0, "r": -3, {two}}}"#),
                "radius must not be negative",
            ),
            (
                format!(r#"{{"type": "spiral", "cx": 0, "cy": 0, {two}}}"#),
                "spiral",
            ),
            (
                format!(r#"{{"type": "conic", "cx": 0, "cy": 0, "extend": "wrap", {two}}}"#),
                "wrap",
            ),
        ];
        for (gradient, want) in cases {
            let msg = error(&format!(r#""mask": {{"gradient": {gradient}}},"#));
            assert!(msg.contains(want), "{gradient}: {msg}");
        }
        let msg = error(&format!(
            r#""mask": {{"gradient": {{"type": "conic", "cx": 0, "cy": 0, {two}}}, "mode": "alphaInverted"}},"#
        ));
        assert!(msg.contains("alphaInverted"), "{msg}");
        let msg =
            error(r#""mask": {"gradient": {"type": "conic", "cx": 0, "cy": 0, "stops": []}},"#);
        assert!(msg.contains("\"box\"") && msg.contains("2 stops"), "{msg}");
    }

    #[test]
    fn parses_mattes_and_checks_the_source() {
        // "grp" is the empty group beside "box" in `scene_with`.
        let scene = scene_with(r#""matte": {"layer": "grp"},"#).unwrap();
        let matte = scene.layers[0].matte.as_ref().unwrap();
        assert_eq!(
            (matte.layer.as_str(), matte.mode),
            ("grp", MatteMode::Alpha)
        );
        for (name, mode) in [
            ("alpha", MatteMode::Alpha),
            ("alphaInverted", MatteMode::AlphaInverted),
            ("luminance", MatteMode::Luminance),
            ("luminanceInverted", MatteMode::LuminanceInverted),
        ] {
            let scene = scene_with(&format!(
                r#""matte": {{"layer": "grp", "mode": "{name}"}},"#
            ))
            .unwrap();
            assert_eq!(scene.layers[0].matte.as_ref().unwrap().mode, mode);
        }

        let cases = [
            (r#""matte": {"layer": "box"},"#, "the layer itself"),
            (
                r#""matte": {"layer": "nope"},"#,
                "\"nope\" is not a sibling",
            ),
        ];
        for (matte, want) in cases {
            let msg = error(matte);
            assert!(
                msg.contains(want) && msg.contains("\"box\""),
                "{matte}: {msg}"
            );
        }
    }

    #[test]
    fn matte_sources_must_be_siblings_without_mattes() {
        let parse = |layers: &str| {
            let json = format!(
                r#"{{"width": 20, "height": 20, "fps": 30, "durationInFrames": 1, "layers": {layers}}}"#
            );
            Scene::from_json(&json, PathBuf::new()).map_err(|e| e.to_string())
        };
        let group = |id: &str, extra: &str, children: &str| {
            format!(r#"{{"id": "{id}", "type": "group", {extra} "children": [{children}]}}"#)
        };
        // A source inside a group is not a sibling of a top-level layer.
        let inner = group("inner", "", "");
        let outer = group("outer", "", &inner);
        let user = group("user", r#""matte": {"layer": "inner"},"#, "");
        let msg = parse(&format!("[{outer}, {user}]")).unwrap_err();
        assert!(msg.contains("not a sibling"), "{msg}");
        // Siblings inside a group are fine, in either order.
        let a = group("a", r#""matte": {"layer": "b"},"#, "");
        let b = group("b", "", "");
        parse(&format!("[{}]", group("g", "", &format!("{a}, {b}")))).unwrap();
        parse(&format!("[{b}, {a}]")).unwrap();
        // A source may not have a matte itself.
        let c = group("c", r#""matte": {"layer": "a"},"#, "");
        let msg = parse(&format!("[{a}, {b}, {c}]")).unwrap_err();
        assert!(
            msg.contains("matte of its own") && msg.contains("\"c\""),
            "{msg}"
        );
        // Several layers can share one source.
        let d = group("d", r#""matte": {"layer": "b"},"#, "");
        parse(&format!("[{a}, {b}, {d}]")).unwrap();
    }

    fn effects_of(effects: &str) -> Scene {
        scene_with(&format!(r#""effects": {effects},"#)).unwrap()
    }

    #[test]
    fn parses_shadows_with_defaults() {
        let scene = effects_of(r#"[{"type": "dropShadow"}, {"type": "insetShadow"}]"#);
        for effect in &scene.layers[0].effects {
            let (Effect::DropShadow(s) | Effect::InsetShadow(s)) = effect else {
                panic!("not a shadow: {effect:?}");
            };
            let zeros = [&s.x, &s.y, &s.blur, &s.spread].map(|n| n.at(0.0));
            assert_eq!(zeros, [0.0; 4]);
            assert_eq!(s.color, Color::BLACK);
        }
        assert!(matches!(scene.layers[0].effects[1], Effect::InsetShadow(_)));
    }

    #[test]
    fn parses_shadow_fields_and_keyframes() {
        let scene = effects_of(
            r##"[{"type": "dropShadow", "x": 2, "y": [{"frame": 0, "value": 4}, {"frame": 9, "value": 12}],
                 "blur": 6, "spread": -1.5, "color": "#11223380"}]"##,
        );
        let Effect::DropShadow(s) = &scene.layers[0].effects[0] else {
            panic!("not a drop shadow");
        };
        assert_eq!(
            (s.x.at(0.0), s.y.at(4.5), s.blur.at(0.0), s.spread.at(0.0)),
            (2.0, 8.0, 6.0, -1.5)
        );
        assert_eq!(s.color, Color::parse("#11223380").unwrap());
    }

    #[test]
    fn rejects_bad_shadow_fields() {
        for (effects, want) in [
            (
                r#"[{"type": "dropShadow", "blur": "wide"}]"#,
                "did not match",
            ),
            (r#"[{"type": "insetShadow", "color": "red"}]"#, "red"),
            (r#"[{"type": "innerGlow"}]"#, "innerGlow"),
        ] {
            let msg = error(&format!(r#""effects": {effects},"#));
            assert!(msg.contains(want), "{effects}: {msg}");
        }
    }

    #[test]
    fn margin_covers_the_largest_shadow_reach() {
        // Offset 30 (the larger axis, at its extreme keyframe) + spread 2 +
        // 3 x blur 5.
        let scene = effects_of(
            r#"[{"type": "dropShadow", "x": 10, "y": [{"frame": 0, "value": -30}, {"frame": 9, "value": 5}],
                 "blur": 5, "spread": 2}]"#,
        );
        assert_eq!(scene.margin(), 47);
        // A negative spread reads as far as a positive one; blur and spread
        // are limited to 128 as they are when drawn.
        let scene = effects_of(
            r#"[{"type": "insetShadow", "y": 4, "blur": [{"frame": 0, "value": 1}, {"frame": 9, "value": 1000}],
                 "spread": -20}]"#,
        );
        assert_eq!(scene.margin(), 4 + 20 + 3 * 128);
        let scene = effects_of(r#"[{"type": "dropShadow", "spread": -900}]"#);
        assert_eq!(scene.margin(), 128);
        // Shadows in one list add up: the second is cast by the first too.
        let scene = effects_of(
            r#"[{"type": "dropShadow", "x": 7}, {"type": "blur", "radius": 50},
                {"type": "insetShadow", "y": -5}]"#,
        );
        assert_eq!(scene.margin(), 12);
        // The largest reach over layers wins. A group's own reach adds to
        // its children's, and blur adds nothing.
        let json = r#"{"width": 200, "height": 100, "fps": 30, "durationInFrames": 10,
            "layers": [
              {"id": "a", "type": "group", "effects": [{"type": "dropShadow", "blur": 2}],
               "children": [
                 {"id": "b", "type": "group", "children": [
                   {"id": "c", "type": "group", "children": [],
                    "effects": [{"type": "blur", "radius": 99}, {"type": "dropShadow", "x": 20}]}]}]},
              {"id": "d", "type": "group", "children": [],
               "effects": [{"type": "dropShadow", "y": -10}]}]}"#;
        let scene = Scene::from_json(json, PathBuf::new()).unwrap();
        assert_eq!(scene.margin(), 6 + 20);
    }

    #[test]
    fn parses_colour_filters_with_defaults() {
        let scene = effects_of(
            r#"[{"type": "saturate"}, {"type": "contrast"}, {"type": "brightness"},
                {"type": "grayscale"}, {"type": "sepia"}, {"type": "invert"},
                {"type": "hueRotate"}]"#,
        );
        let effects = &scene.layers[0].effects;
        assert_eq!(effects.len(), 7);
        for effect in &effects[..6] {
            let (Effect::Saturate { amount }
            | Effect::Contrast { amount }
            | Effect::Brightness { amount }
            | Effect::Grayscale { amount }
            | Effect::Sepia { amount }
            | Effect::Invert { amount }) = effect
            else {
                panic!("not an amount filter: {effect:?}");
            };
            assert_eq!(amount.at(0.0), 1.0);
        }
        assert!(matches!(&effects[6], Effect::HueRotate { angle } if angle.at(0.0) == 0.0));
    }

    #[test]
    fn parses_colour_filter_keyframes() {
        let scene = effects_of(
            r#"[{"type": "hueRotate", "angle": [{"frame": 0, "value": 0}, {"frame": 9, "value": 90}]},
                {"type": "saturate", "amount": 0.5}]"#,
        );
        let Effect::HueRotate { angle } = &scene.layers[0].effects[0] else {
            panic!("not a hue rotate");
        };
        assert_eq!(angle.at(4.5), 45.0);
        assert!(
            matches!(&scene.layers[0].effects[1], Effect::Saturate { amount } if amount.at(0.0) == 0.5)
        );
        let msg = error(r#""effects": [{"type": "sepia", "amount": "lots"}],"#);
        assert!(msg.contains("did not match"), "{msg}");
    }

    #[test]
    fn backdrop_blur_parses_and_counts_three_radii_in_the_margin() {
        let scene = effects_of(
            r#"[{"type": "backdropBlur", "radius": [{"frame": 0, "value": 4}, {"frame": 9, "value": 10}]}]"#,
        );
        assert!(
            matches!(&scene.layers[0].effects[0], Effect::BackdropBlur { radius } if radius.at(9.0) == 10.0)
        );
        assert_eq!(scene.margin(), 30);
        // The radius is limited to 128 as it is when drawn.
        let scene = effects_of(r#"[{"type": "backdropBlur", "radius": 1000}]"#);
        assert_eq!(scene.margin(), 384);
        // It adds to a shadow on the same layer.
        let scene = effects_of(
            r#"[{"type": "backdropBlur", "radius": 5}, {"type": "dropShadow", "y": 4}]"#,
        );
        assert_eq!(scene.margin(), 19);
        let msg = error(r#""effects": [{"type": "backdropBlur"}],"#);
        assert!(msg.contains("radius"), "{msg}");
    }

    #[test]
    fn parses_glow_with_defaults_and_counts_three_radii() {
        let scene = effects_of(
            r##"[{"type": "glow", "radius": 8},
                {"type": "glow", "radius": [{"frame": 0, "value": 2}, {"frame": 9, "value": 16}],
                 "color": "#ffcc6680", "intensity": 2}]"##,
        );
        let effects = &scene.layers[0].effects;
        let Effect::Glow {
            color, intensity, ..
        } = &effects[0]
        else {
            panic!("not a glow");
        };
        assert!(color.is_none() && intensity.at(0.0) == 1.0);
        let Effect::Glow {
            radius,
            color,
            intensity,
        } = &effects[1]
        else {
            panic!("not a glow");
        };
        assert_eq!(radius.at(9.0), 16.0);
        assert_eq!(*color, Some(Color::parse("#ffcc6680").unwrap()));
        assert_eq!(intensity.at(0.0), 2.0);
        // 3 x 8, then 3 x 16 on top of it.
        assert_eq!(scene.margin(), 24 + 48);
        let msg = error(r#""effects": [{"type": "glow"}],"#);
        assert!(msg.contains("radius"), "{msg}");
        let msg = error(r#""effects": [{"type": "glow", "radius": 4, "color": "gold"}],"#);
        assert!(msg.contains("gold"), "{msg}");
    }

    #[test]
    fn parses_chromatic_aberration_and_counts_the_amount_in_the_margin() {
        let scene = effects_of(
            r#"[{"type": "chromaticAberration", "amount": [{"frame": 0, "value": -9}, {"frame": 9, "value": 4}],
                 "angle": 45}, {"type": "chromaticAberration", "amount": 2}]"#,
        );
        let Effect::ChromaticAberration { amount, angle } = &scene.layers[0].effects[0] else {
            panic!("not an aberration");
        };
        assert_eq!((amount.at(0.0), angle.at(0.0)), (-9.0, 45.0));
        let Effect::ChromaticAberration { angle, .. } = &scene.layers[0].effects[1] else {
            panic!("not an aberration");
        };
        assert_eq!(angle.at(0.0), 0.0);
        // The larger side of -9..4, plus the second effect's 2.
        assert_eq!(scene.margin(), 11);
        let msg = error(r#""effects": [{"type": "chromaticAberration"}],"#);
        assert!(msg.contains("amount"), "{msg}");
    }

    #[test]
    fn parses_a_gradient_map_with_a_default_amount() {
        let scene = effects_of(
            r##"[{"type": "gradientMap", "stops": [{"offset": 0, "color": "#000"},
                  {"offset": [{"frame": 0, "value": 0.4}, {"frame": 9, "value": 0.8}], "color": "#ff000080"},
                  {"offset": 1, "color": "#fff"}]},
                {"type": "gradientMap", "amount": [{"frame": 0, "value": 0}, {"frame": 9, "value": 1}],
                 "stops": [{"offset": 0, "color": "#000"}, {"offset": 1, "color": "#fff"}]}]"##,
        );
        let effects = &scene.layers[0].effects;
        let Effect::GradientMap { stops, amount } = &effects[0] else {
            panic!("not a gradient map");
        };
        assert_eq!(stops.len(), 3);
        assert_eq!(stops[1].offset.at(9.0), 0.8);
        assert_eq!(stops[1].color, Color::parse("#ff000080").unwrap());
        assert_eq!(amount.at(0.0), 1.0);
        let Effect::GradientMap { amount, .. } = &effects[1] else {
            panic!("not a gradient map");
        };
        assert_eq!(amount.at(4.5), 0.5);
        // It recolours in place: no margin.
        assert_eq!(scene.margin(), 0);
    }

    #[test]
    fn rejects_bad_gradient_maps_naming_the_layer() {
        let stops = |n: u32| {
            let last = f64::from(n.max(2) - 1);
            let stops: Vec<String> = (0..n)
                .map(|i| {
                    format!(
                        r##"{{"offset": {}, "color": "#fff"}}"##,
                        f64::from(i) / last
                    )
                })
                .collect();
            format!(r#""stops": [{}]"#, stops.join(","))
        };
        let gradient_map = |fields: &str| {
            scene_with(&format!(
                r#""effects": [{{"type": "gradientMap", {fields}}}],"#
            ))
        };
        // 16 stops is the most.
        assert!(gradient_map(&stops(16)).is_ok());
        let cases = [
            (stops(1), "2 to 16 stops, got 1"),
            (stops(0), "2 to 16 stops, got 0"),
            (stops(17), "2 to 16 stops, got 17"),
            (
                r##""stops": [{"offset": 0, "color": "#000"}, {"offset": 1.2, "color": "#fff"}]"##
                    .to_string(),
                "between 0 and 1",
            ),
            (
                r##""stops": [{"offset": [{"frame": 0, "value": -0.1}, {"frame": 9, "value": 0.5}], "color": "#000"},
                    {"offset": 1, "color": "#fff"}]"##
                    .to_string(),
                "between 0 and 1",
            ),
        ];
        for (fields, want) in cases {
            let msg = gradient_map(&fields).unwrap_err().to_string();
            assert!(
                msg.contains("layer \"box\"") && msg.contains("gradientMap") && msg.contains(want),
                "{fields}: {msg}"
            );
        }
        // A missing field is the JSON parser's complaint, with no layer.
        let msg = gradient_map(r#""amount": 1"#).unwrap_err().to_string();
        assert!(msg.contains("stops"), "{msg}");
    }

    #[test]
    fn parses_a_lut_with_a_default_amount() {
        let scene = effects_of(
            r#"[{"type": "lut", "src": "looks/thermal.cube"},
                {"type": "lut", "src": "b.cube", "amount": [{"frame": 0, "value": 0}, {"frame": 9, "value": 1}]}]"#,
        );
        let Effect::Lut { src, amount } = &scene.layers[0].effects[0] else {
            panic!("not a lut");
        };
        assert_eq!((src.as_str(), amount.at(0.0)), ("looks/thermal.cube", 1.0));
        assert!(
            matches!(&scene.layers[0].effects[1], Effect::Lut { amount, .. } if amount.at(4.5) == 0.5)
        );
        assert_eq!(scene.margin(), 0);
        // The file is read when the renderer is built, not when the scene
        // loads (like an image), so a missing file is not an error here.
        let msg = error(r#""effects": [{"type": "lut"}],"#);
        assert!(msg.contains("src"), "{msg}");
        let msg = error(r#""effects": [{"type": "lut", "src": " "}],"#);
        assert!(
            msg.contains("layer \"box\"") && msg.contains(".cube"),
            "{msg}"
        );
    }

    #[test]
    fn parses_grain_with_defaults() {
        let scene = effects_of(
            r#"[{"type": "grain", "amount": 0.15, "seed": 7},
                {"type": "grain", "amount": [{"frame": 0, "value": 0}, {"frame": 9, "value": 0.5}],
                 "size": [{"frame": 0, "value": 1}, {"frame": 9, "value": 4}], "seed": 0,
                 "animate": false, "monochrome": false}]"#,
        );
        let Effect::Grain {
            amount,
            size,
            seed,
            animate,
            monochrome,
        } = &scene.layers[0].effects[0]
        else {
            panic!("not grain");
        };
        assert_eq!((amount.at(0.0), size.at(0.0), *seed), (0.15, 1.0, 7));
        assert!(*animate && *monochrome);
        let Effect::Grain {
            amount,
            size,
            animate,
            monochrome,
            ..
        } = &scene.layers[0].effects[1]
        else {
            panic!("not grain");
        };
        assert_eq!((amount.at(9.0), size.at(9.0)), (0.5, 4.0));
        assert!(!*animate && !*monochrome);
        // The grain is on the pixels, not past them.
        assert_eq!(scene.margin(), 0);
    }

    #[test]
    fn rejects_bad_grain_naming_the_layer() {
        let grain = |fields: &str| {
            scene_with(&format!(r#""effects": [{{"type": "grain", {fields}}}],"#))
                .unwrap_err()
                .to_string()
        };
        for (fields, want) in [
            (
                r#""amount": 0.1, "seed": -1"#,
                "seed must be a whole number",
            ),
            (r#""amount": 0.1, "seed": 4294967296"#, "got 4294967296"),
            (
                r#""amount": 0.1, "seed": 1, "size": [{"frame": 0, "value": 3}, {"frame": 5, "value": 0.5}]"#,
                "size must be at least 1",
            ),
        ] {
            let msg = grain(fields);
            assert!(
                msg.contains("layer \"box\"") && msg.contains(want),
                "{fields}: {msg}"
            );
        }
        // The seed is required, and must be an integer, so the JSON parser
        // rejects these (without a layer id).
        assert!(grain(r#""amount": 0.1"#).contains("seed"));
        assert!(grain(r#""seed": 3"#).contains("amount"));
        assert!(grain(r#""amount": 0.1, "seed": 1.5"#).contains("invalid type"));
        // The largest seed is fine.
        assert!(
            scene_with(r#""effects": [{"type": "grain", "amount": 0.1, "seed": 4294967295}],"#)
                .is_ok()
        );
    }

    #[test]
    fn parses_dither_with_defaults() {
        let scene = effects_of(
            r#"[{"type": "dither"},
                {"type": "dither", "mode": "random", "seed": 3, "animate": true,
                 "levels": [{"frame": 0, "value": 2}, {"frame": 9, "value": 16}],
                 "size": [{"frame": 0, "value": 1}, {"frame": 9, "value": 4}]}]"#,
        );
        let Effect::Dither {
            mode,
            levels,
            size,
            seed,
            animate,
        } = &scene.layers[0].effects[0]
        else {
            panic!("not a dither");
        };
        assert_eq!(*mode, DitherMode::Ordered);
        assert_eq!(
            (levels.at(0.0), size.at(0.0), *seed, *animate),
            (2.0, 1.0, None, false)
        );
        let Effect::Dither {
            mode,
            levels,
            size,
            seed,
            animate,
        } = &scene.layers[0].effects[1]
        else {
            panic!("not a dither");
        };
        assert_eq!(*mode, DitherMode::Random);
        assert_eq!(
            (levels.at(9.0), size.at(9.0), *seed, *animate),
            (16.0, 4.0, Some(3), true)
        );
        assert_eq!(scene.margin(), 0);
        // An ordered dither may carry a seed; it is ignored.
        assert!(scene_with(r#""effects": [{"type": "dither", "seed": 5}],"#).is_ok());
    }

    #[test]
    fn rejects_bad_dither_naming_the_layer() {
        let dither = |fields: &str| {
            scene_with(&format!(r#""effects": [{{"type": "dither", {fields}}}],"#))
                .unwrap_err()
                .to_string()
        };
        for (fields, want) in [
            (r#""mode": "random""#, "needs a seed"),
            (
                r#""mode": "random", "seed": -2"#,
                "seed must be a whole number",
            ),
            (r#""seed": 4294967296"#, "seed must be a whole number"),
            (r#""levels": 1"#, "levels must be between 2 and 256"),
            (r#""levels": 257"#, "levels must be between 2 and 256"),
            (
                r#""levels": [{"frame": 0, "value": 8}, {"frame": 9, "value": 300}]"#,
                "levels must be between 2 and 256",
            ),
            (r#""size": 0.5"#, "size must be at least 1"),
        ] {
            let msg = dither(fields);
            assert!(
                msg.contains("layer \"box\"") && msg.contains(want),
                "{fields}: {msg}"
            );
        }
        // The largest legal values.
        assert!(
            scene_with(r#""effects": [{"type": "dither", "levels": 256, "mode": "random", "seed": 4294967295}],"#)
                .is_ok()
        );
        // An unknown mode is the JSON parser's complaint.
        let msg = dither(r#""mode": "bayer""#);
        assert!(msg.contains("bayer"), "{msg}");
    }

    #[test]
    fn parses_halftone_with_defaults() {
        let scene = effects_of(
            r##"[{"type": "halftone"},
                {"type": "halftone", "shape": "line", "color": "#ff000080", "invert": true,
                 "size": [{"frame": 0, "value": 4}, {"frame": 9, "value": 12}], "angle": 15}]"##,
        );
        let Effect::Halftone {
            size,
            angle,
            shape,
            color,
            invert,
        } = &scene.layers[0].effects[0]
        else {
            panic!("not a halftone");
        };
        assert_eq!((size.at(0.0), angle.at(0.0)), (8.0, 45.0));
        assert_eq!(
            (*shape, *color, *invert),
            (HalftoneShape::Circle, None, false)
        );
        let Effect::Halftone {
            size,
            angle,
            shape,
            color,
            invert,
        } = &scene.layers[0].effects[1]
        else {
            panic!("not a halftone");
        };
        assert_eq!((size.at(9.0), angle.at(0.0)), (12.0, 15.0));
        assert_eq!(*shape, HalftoneShape::Line);
        assert_eq!(color.map(|c| (c.r, c.a)), Some((255, 128)));
        assert!(*invert);
        // The dots stay in their cells.
        assert_eq!(scene.margin(), 0);
        // `null` is the same as leaving the colour out.
        assert!(scene_with(r#""effects": [{"type": "halftone", "color": null}],"#).is_ok());
        // A halftone of a group has nothing special to measure.
        assert!(
            Scene::from_json(
                r#"{"width": 20, "height": 20, "fps": 30, "durationInFrames": 1, "layers": [
                    {"id": "g", "type": "group", "children": [], "effects": [{"type": "halftone"}]}]}"#,
                PathBuf::new()
            )
            .is_ok()
        );
    }

    #[test]
    fn rejects_bad_halftone_naming_the_layer() {
        let halftone = |fields: &str| {
            scene_with(&format!(
                r#""effects": [{{"type": "halftone", {fields}}}],"#
            ))
            .unwrap_err()
            .to_string()
        };
        for fields in [
            r#""size": 0"#,
            r#""size": -3"#,
            r#""size": [{"frame": 0, "value": 8}, {"frame": 9, "value": 0}]"#,
        ] {
            let msg = halftone(fields);
            assert!(
                msg.contains("layer \"box\"")
                    && msg.contains("halftone size must be greater than 0"),
                "{fields}: {msg}"
            );
        }
        // An unknown shape is the JSON parser's complaint.
        let msg = halftone(r#""shape": "star""#);
        assert!(msg.contains("star"), "{msg}");
    }

    #[test]
    fn parses_dot_matrix_with_defaults() {
        let scene = effects_of(
            r#"[{"type": "dotMatrix", "progress": 0.5, "seed": 1},
                {"type": "dotMatrix", "order": "sweep", "shape": "square", "angle": 90, "stagger": 0.2,
                 "size": 6, "progress": [{"frame": 0, "value": 0}, {"frame": 9, "value": 1}]}]"#,
        );
        let Effect::DotMatrix {
            size,
            progress,
            order,
            angle,
            stagger,
            seed,
            shape,
        } = &scene.layers[0].effects[0]
        else {
            panic!("not a dot matrix");
        };
        assert_eq!(
            (
                size.at(0.0),
                progress.at(0.0),
                angle.at(0.0),
                stagger.at(0.0)
            ),
            (12.0, 0.5, 0.0, 0.6)
        );
        assert_eq!(
            (*order, *seed, *shape),
            (DotOrder::Random, Some(1), DotShape::Circle)
        );
        let Effect::DotMatrix {
            size,
            progress,
            order,
            angle,
            stagger,
            seed,
            shape,
        } = &scene.layers[0].effects[1]
        else {
            panic!("not a dot matrix");
        };
        assert_eq!(
            (
                size.at(0.0),
                progress.at(9.0),
                angle.at(0.0),
                stagger.at(0.0)
            ),
            (6.0, 1.0, 90.0, 0.2)
        );
        assert_eq!(
            (*order, *seed, *shape),
            (DotOrder::Sweep, None, DotShape::Square)
        );
        assert_eq!(scene.margin(), 0);
        // A random reveal works on a group; a sweep ignores a seed.
        let group = |effect: &str| {
            Scene::from_json(
                &format!(
                    r#"{{"width": 20, "height": 20, "fps": 30, "durationInFrames": 1, "layers": [
                        {{"id": "g", "type": "group", "children": [], "effects": [{effect}]}}]}}"#
                ),
                PathBuf::new(),
            )
        };
        assert!(group(r#"{"type": "dotMatrix", "progress": 1, "seed": 2}"#).is_ok());
        assert!(
            scene_with(
                r#""effects": [{"type": "dotMatrix", "progress": 1, "order": "sweep", "seed": 5}],"#
            )
            .is_ok()
        );
        // `progress` is the point of the effect, so it has no default.
        let msg = scene_with(r#""effects": [{"type": "dotMatrix", "seed": 2}],"#)
            .unwrap_err()
            .to_string();
        assert!(msg.contains("progress"), "{msg}");
    }

    #[test]
    fn rejects_bad_dot_matrix_naming_the_layer() {
        let dots = |fields: &str| {
            scene_with(&format!(
                r#""effects": [{{"type": "dotMatrix", "progress": 1, {fields}}}],"#
            ))
            .unwrap_err()
            .to_string()
        };
        for (fields, want) in [
            (r#""size": 0, "seed": 1"#, "size must be greater than 0"),
            (r#""size": -4, "seed": 1"#, "size must be greater than 0"),
            (
                r#""seed": 1, "stagger": 1"#,
                "stagger must be at least 0 and below 1",
            ),
            (
                r#""seed": 1, "stagger": -0.1"#,
                "stagger must be at least 0 and below 1",
            ),
            (
                r#""seed": 1, "stagger": [{"frame": 0, "value": 0.5}, {"frame": 9, "value": 1.5}]"#,
                "stagger must be at least 0 and below 1",
            ),
            (r#""order": "random""#, "needs a seed"),
            (r#""seed": -1"#, "seed must be a whole number"),
            (r#""seed": 4294967296"#, "seed must be a whole number"),
        ] {
            let msg = dots(fields);
            assert!(
                msg.contains("layer \"box\"") && msg.contains(want),
                "{fields}: {msg}"
            );
        }
        // The largest legal values.
        assert!(
            scene_with(r#""effects": [{"type": "dotMatrix", "progress": 1, "seed": 4294967295, "stagger": 0.999}],"#)
                .is_ok()
        );
        // A sweep needs the layer's box, which a group does not have.
        let msg = Scene::from_json(
            r#"{"width": 20, "height": 20, "fps": 30, "durationInFrames": 1, "layers": [
                {"id": "g", "type": "group", "children": [],
                 "effects": [{"type": "dotMatrix", "progress": 1, "order": "sweep"}]}]}"#,
            PathBuf::new(),
        )
        .unwrap_err()
        .to_string();
        assert!(
            msg.contains("layer \"g\"") && msg.contains("sweep") && msg.contains("group"),
            "{msg}"
        );
        // An unknown order or shape is the JSON parser's complaint.
        assert!(dots(r#""order": "spiral""#).contains("spiral"));
        assert!(dots(r#""seed": 1, "shape": "line""#).contains("line"));
    }

    const TORN: &str =
        r#"{"type": "fractalNoise", "baseFrequency": 0.04, "numOctaves": 4, "seed": 7}"#;

    #[test]
    fn parses_displace_with_defaults() {
        let scene = effects_of(&format!(
            r#"[{{"type": "displace", "scale": 10, "turbulence": {TORN}}},
                {{"type": "displace", "scale": [{{"frame": 0, "value": 0}}, {{"frame": 9, "value": 12}}],
                  "xChannelSelector": "B", "yChannelSelector": "A",
                  "turbulence": {{"type": "turbulence", "baseFrequency": [0.02, 0.08], "seed": -3.7}}}}]"#
        ));
        let Effect::Displace {
            scale,
            x_channel_selector,
            y_channel_selector,
            turbulence,
        } = &scene.layers[0].effects[0]
        else {
            panic!("not a displacement");
        };
        // SVG's default channel would be A for both; these are R and G.
        assert_eq!(
            (scale.at(0.0), *x_channel_selector, *y_channel_selector),
            (10.0, Channel::R, Channel::G)
        );
        assert_eq!(turbulence.kind, TurbulenceKind::FractalNoise);
        assert_eq!(
            (
                turbulence.base_frequency.x.at(0.0),
                turbulence.base_frequency.y.at(0.0),
                turbulence.num_octaves,
                turbulence.seed
            ),
            (0.04, 0.04, 4, 7.0)
        );
        let Effect::Displace {
            scale,
            x_channel_selector,
            y_channel_selector,
            turbulence,
        } = &scene.layers[0].effects[1]
        else {
            panic!("not a displacement");
        };
        assert_eq!(scale.at(9.0), 12.0);
        assert_eq!(
            (*x_channel_selector, *y_channel_selector),
            (Channel::B, Channel::A)
        );
        assert_eq!(turbulence.kind, TurbulenceKind::Turbulence);
        // A pair is one frequency per axis; numOctaves defaults to 1 as in SVG.
        assert_eq!(
            (
                turbulence.base_frequency.x.at(0.0),
                turbulence.base_frequency.y.at(0.0),
                turbulence.num_octaves,
                turbulence.seed
            ),
            (0.02, 0.08, 1, -3.7)
        );
    }

    #[test]
    fn base_frequency_is_a_number_a_pair_or_keyframes() {
        let frequency = |json: &str| {
            let t = format!(r#"{{"type": "fractalNoise", "baseFrequency": {json}, "seed": 1}}"#);
            let scene = effects_of(&format!(
                r#"[{{"type": "displace", "scale": 1, "turbulence": {t}}}]"#
            ));
            let Effect::Displace { turbulence, .. } = &scene.layers[0].effects[0] else {
                panic!("not a displacement");
            };
            let f = &turbulence.base_frequency;
            ((f.x.at(0.0), f.x.at(9.0)), (f.y.at(0.0), f.y.at(9.0)))
        };
        assert_eq!(frequency("0.05"), ((0.05, 0.05), (0.05, 0.05)));
        assert_eq!(frequency("[0.1, 0.2]"), ((0.1, 0.1), (0.2, 0.2)));
        // Keyframes on one number: both axes.
        assert_eq!(
            frequency(r#"[{"frame": 0, "value": 0.1}, {"frame": 9, "value": 0.3}]"#),
            ((0.1, 0.3), (0.1, 0.3))
        );
        // A pair of keyframe lists animates the axes apart.
        assert_eq!(
            frequency(r#"[[{"frame": 0, "value": 0.1}, {"frame": 9, "value": 0.3}], 0.5]"#),
            ((0.1, 0.3), (0.5, 0.5))
        );
    }

    #[test]
    fn rejects_bad_turbulence_naming_the_layer() {
        let displace = |turbulence: &str| {
            scene_with(&format!(
                r#""effects": [{{"type": "displace", "scale": 5, "turbulence": {turbulence}}}],"#
            ))
            .unwrap_err()
            .to_string()
        };
        let t = |fields: &str| format!(r#"{{"type": "fractalNoise", "seed": 1, {fields}}}"#);
        for (turbulence, want) in [
            (
                t(r#""baseFrequency": -0.1"#),
                "baseFrequency must not be negative",
            ),
            (
                t(r#""baseFrequency": [0.1, -0.1]"#),
                "baseFrequency must not be negative",
            ),
            (
                t(r#""baseFrequency": [{"frame": 0, "value": 0.1}, {"frame": 9, "value": -1}]"#),
                "baseFrequency must not be negative",
            ),
            (
                t(r#""baseFrequency": 0.1, "numOctaves": 11"#),
                "numOctaves must be a whole number from 0 to 10, got 11",
            ),
            (
                t(r#""baseFrequency": 0.1, "numOctaves": -1"#),
                "numOctaves must be a whole number from 0 to 10, got -1",
            ),
        ] {
            let msg = displace(&turbulence);
            assert!(
                msg.contains("layer \"box\"") && msg.contains("displace") && msg.contains(want),
                "{turbulence}: {msg}"
            );
        }
        // These are the JSON parser's complaints: no layer, but a clear one.
        assert!(displace(&t(r#""baseFrequency": [0.1, 0.2, 0.3]"#)).contains("[x, y]"));
        assert!(displace(&t(r#""baseFrequency": []"#)).contains("keyframe list is empty"));
        assert!(displace(&t(r#""baseFrequency": "high""#)).contains("baseFrequency"));
        assert!(displace(&t(r#""baseFrequency": 0.1, "numOctaves": 2.5"#)).contains("2.5"));
        assert!(displace(r#"{"type": "fractalNoise", "baseFrequency": 0.1}"#).contains("seed"));
        assert!(displace(r#"{"baseFrequency": 0.1, "seed": 1}"#).contains("type"));
        assert!(
            displace(r#"{"type": "perlin", "baseFrequency": 0.1, "seed": 1}"#).contains("perlin")
        );
        let msg = scene_with(
            r#""effects": [{"type": "displace", "scale": 5, "xChannelSelector": "X", "turbulence":
                {"type": "fractalNoise", "baseFrequency": 0.1, "seed": 1}}],"#,
        )
        .unwrap_err()
        .to_string();
        assert!(msg.contains("X"), "{msg}");
        // The largest legal values.
        assert!(
            scene_with(
                r#""effects": [{"type": "displace", "scale": 5, "turbulence":
                    {"type": "turbulence", "baseFrequency": 0, "numOctaves": 10, "seed": 1e30}}],"#
            )
            .is_ok()
        );
    }

    #[test]
    fn displace_counts_half_its_scale_times_the_layers_scale_in_the_margin() {
        let displace = |scale: &str| {
            format!(r#"{{"type": "displace", "scale": {scale}, "turbulence": {TORN}}}"#)
        };
        // Plain layer: half the largest |scale| at any keyframe, rounded up.
        let scene = effects_of(&format!("[{}]", displace("10")));
        assert_eq!(scene.margin(), 5);
        let scene = effects_of(&format!(
            "[{}]",
            displace(r#"[{"frame": 0, "value": -30}, {"frame": 9, "value": 9}]"#)
        ));
        assert_eq!(scene.margin(), 15);
        let scene = effects_of(&format!("[{}]", displace("9")));
        assert_eq!(scene.margin(), 5);

        // The layer's own scale multiplies it, at its largest keyframe and
        // whichever way it faces; other effects ignore the scale.
        let with_scale = |transform: &str, effects: &str| {
            let json = format!(
                r#"{{"width": 200, "height": 100, "fps": 30, "durationInFrames": 10, "layers": [
                    {{"id": "a", "type": "shape", "shape": {{"kind": "rect", "width": 9, "height": 9}},
                      "transform": {transform}, "effects": {effects}}}]}}"#
            );
            Scene::from_json(&json, PathBuf::new()).unwrap().margin()
        };
        assert_eq!(
            with_scale(r#"{"scale": 3}"#, &format!("[{}]", displace("10"))),
            15
        );
        assert_eq!(
            with_scale(r#"{"scale": -3}"#, &format!("[{}]", displace("10"))),
            15
        );
        assert_eq!(
            with_scale(
                r#"{"scale": [{"frame": 0, "value": 0.5}, {"frame": 9, "value": 4}]}"#,
                &format!("[{}]", displace("10"))
            ),
            20
        );
        assert_eq!(
            with_scale(r#"{"scale": 3}"#, r#"[{"type": "dropShadow", "x": 10}]"#),
            10
        );
        // Reaches add up along the list; the shadow after the displacement
        // casts the displaced layer, and neither is scaled by the other.
        assert_eq!(
            with_scale(
                r#"{"scale": 2}"#,
                &format!(r#"[{}, {{"type": "dropShadow", "x": 10}}]"#, displace("10"))
            ),
            20
        );

        // Ancestors' scales multiply in: the group's 2 and the child's 3
        // make 6, and the group's own displacement uses its 2 (and its
        // ancestors') but not the child's.
        let json = format!(
            r#"{{"width": 200, "height": 100, "fps": 30, "durationInFrames": 10, "layers": [
                {{"id": "outer", "type": "group", "transform": {{"scale": 2}},
                  "effects": [{outer}],
                  "children": [
                    {{"id": "inner", "type": "group", "transform": {{"scale": 5}}, "children": [
                      {{"id": "leaf", "type": "group", "transform": {{"scale": 3}}, "children": [],
                        "effects": [{leaf}]}}]}}]}}]}}"#,
            outer = displace("4"),
            leaf = displace("10"),
        );
        // leaf: 10 / 2 * (2 * 5 * 3) = 150; outer adds 4 / 2 * 2 = 4.
        let scene = Scene::from_json(&json, PathBuf::new()).unwrap();
        assert_eq!(scene.margin(), 154);

        // A scale of 0 reaches nothing.
        assert_eq!(effects_of(&format!("[{}]", displace("0"))).margin(), 0);
    }

    fn noise_scene(fields: &str) -> Result<Scene> {
        Scene::from_json(
            &format!(
                r#"{{"width": 200, "height": 100, "fps": 30, "durationInFrames": 10, "layers": [
                    {{"id": "n", "type": "noise", {fields}}}]}}"#
            ),
            PathBuf::new(),
        )
    }

    #[test]
    fn parses_noise_layers_with_defaults() {
        let scene = noise_scene(
            r#""width": 120, "height": [{"frame": 0, "value": 10}, {"frame": 9, "value": 40}],
               "turbulence": {"type": "turbulence", "baseFrequency": 0.1, "numOctaves": 2, "seed": 3}"#,
        )
        .unwrap();
        let LayerKind::Noise(noise) = &scene.layers[0].kind else {
            panic!("not a noise layer");
        };
        assert_eq!((noise.width.at(0.0), noise.height.at(9.0)), (120.0, 40.0));
        assert_eq!(noise.channels, NoiseChannels::Rgba);
        assert_eq!(noise.turbulence.kind, TurbulenceKind::Turbulence);
        assert_eq!(noise.turbulence.num_octaves, 2);
        // It paints inside its box and nothing else.
        assert_eq!(scene.margin(), 0);
        let gray = noise_scene(
            r#""width": 1, "height": 1, "channels": "gray",
               "turbulence": {"type": "fractalNoise", "baseFrequency": [0.1, 0.2], "seed": 0}"#,
        )
        .unwrap();
        let LayerKind::Noise(noise) = &gray.layers[0].kind else {
            panic!("not a noise layer");
        };
        assert_eq!(noise.channels, NoiseChannels::Gray);
    }

    #[test]
    fn rejects_bad_noise_layers_naming_the_layer() {
        let turbulence =
            r#""turbulence": {"type": "fractalNoise", "baseFrequency": 0.1, "seed": 1}"#;
        for (fields, want) in [
            (
                format!(r#""width": -1, "height": 5, {turbulence}"#),
                "width must not be negative",
            ),
            (
                format!(
                    r#""width": 5, "height": [{{"frame": 0, "value": 1}}, {{"frame": 9, "value": -2}}], {turbulence}"#
                ),
                "height must not be negative",
            ),
            (
                r#""width": 5, "height": 5, "turbulence": {"type": "fractalNoise", "baseFrequency": -1, "seed": 1}"#
                    .to_string(),
                "noise turbulence baseFrequency must not be negative",
            ),
            (
                r#""width": 5, "height": 5, "turbulence": {"type": "fractalNoise", "baseFrequency": 1, "numOctaves": 11, "seed": 1}"#
                    .to_string(),
                "noise turbulence numOctaves must be a whole number from 0 to 10",
            ),
        ] {
            let msg = noise_scene(&fields).unwrap_err().to_string();
            assert!(
                msg.contains("layer \"n\"") && msg.contains(want),
                "{fields}: {msg}"
            );
        }
        // The JSON parser's complaints.
        let msg = noise_scene(&format!(
            r#""width": 5, "height": 5, "channels": "rg", {turbulence}"#
        ))
        .unwrap_err()
        .to_string();
        assert!(msg.contains("rg"), "{msg}");
        let msg = noise_scene(r#""width": 5, "height": 5"#)
            .unwrap_err()
            .to_string();
        assert!(msg.contains("turbulence"), "{msg}");
    }

    fn mesh_scene(fields: &str) -> Result<Scene> {
        Scene::from_json(
            &format!(
                r##"{{"width": 200, "height": 100, "fps": 30, "durationInFrames": 10, "layers": [
                    {{"id": "m", "type": "meshGradient", {fields}}}]}}"##
            ),
            PathBuf::new(),
        )
    }

    #[test]
    fn parses_mesh_gradients_with_defaults() {
        let scene = mesh_scene(
            r##""width": 120, "height": 60,
               "colors": ["#f00", "#0f0", "#00f", "#ff0", "#0ff", "#f0f", "#000", "#fff", "#888"]"##,
        )
        .unwrap();
        let LayerKind::MeshGradient(mesh) = &scene.layers[0].kind else {
            panic!("not a mesh gradient layer");
        };
        assert_eq!((mesh.columns, mesh.rows), (3, 3));
        assert!(mesh.points.is_none());
        assert_eq!(mesh.colors.len(), 9);
        // It paints inside its box and nothing else.
        assert_eq!(scene.margin(), 0);
        let animated = mesh_scene(
            r##""width": 120, "height": 60, "columns": 2, "rows": 3,
               "points": [[0, 0], [[{"frame": 0, "value": 100}, {"frame": 9, "value": 120}], 0],
                          [0, 30], [120, 30], [0, 60], [120, 60]],
               "colors": ["#f00", "#0f0", "#00f", "#ff0", "#0ff", "#f0f"]"##,
        )
        .unwrap();
        let LayerKind::MeshGradient(mesh) = &animated.layers[0].kind else {
            panic!("not a mesh gradient layer");
        };
        let points = mesh.points.as_ref().unwrap();
        assert_eq!(points.len(), 6);
        assert_eq!(points[1][0].at(9.0), 120.0);
    }

    #[test]
    fn rejects_bad_mesh_gradients_naming_the_layer() {
        let colors = |n: usize| format!(r##""colors": [{}]"##, vec![r##""#fff""##; n].join(", "));
        for (fields, want) in [
            (
                format!(r#""width": -1, "height": 5, {}"#, colors(9)),
                "width must not be negative",
            ),
            (
                format!(r#""width": 5, "height": 5, "columns": 1, {}"#, colors(3)),
                "columns must be a whole number from 2 to 8, got 1",
            ),
            (
                format!(r#""width": 5, "height": 5, "rows": 9, {}"#, colors(27)),
                "rows must be a whole number from 2 to 8, got 9",
            ),
            (
                format!(r#""width": 5, "height": 5, {}"#, colors(8)),
                "needs 9 colors (columns x rows), got 8",
            ),
            (
                format!(
                    r#""width": 5, "height": 5, "columns": 2, "rows": 2, "points": [[0, 0], [1, 0], [0, 1]], {}"#,
                    colors(4)
                ),
                "needs 4 points (columns x rows), got 3",
            ),
        ] {
            let msg = mesh_scene(&fields).unwrap_err().to_string();
            assert!(
                msg.contains("layer \"m\"") && msg.contains(want),
                "{fields}: {msg}"
            );
        }
        // The JSON parser's complaints.
        let msg = mesh_scene(r#""width": 5, "height": 5"#)
            .unwrap_err()
            .to_string();
        assert!(msg.contains("colors"), "{msg}");
        let msg = mesh_scene(&format!(
            r#""width": 5, "height": 5, "columns": 2.5, {}"#,
            colors(9)
        ))
        .unwrap_err()
        .to_string();
        assert!(msg.contains("2.5"), "{msg}");
    }

    const SHADER: &str =
        r#"fn effect(px: vec2<f32>) -> vec4<f32> {\n  return layer(px) * u.strength;\n}"#;

    #[test]
    fn parses_a_shader_and_counts_its_padding_in_the_margin() {
        let scene = effects_of(&format!(
            r#"[{{"type": "shader", "code": "{SHADER}", "padding": [{{"frame": 0, "value": 3}}, {{"frame": 9, "value": 20}}],
                 "uniforms": {{"strength": 0.5, "angle": [{{"frame": 0, "value": 0}}, {{"frame": 9, "value": 1}}]}}}},
                {{"type": "shader", "code": "fn effect(px: vec2<f32>) -> vec4<f32> {{ return layer(px); }}"}}]"#
        ));
        let Effect::Shader(shader) = &scene.layers[0].effects[0] else {
            panic!("not a shader");
        };
        // Uniforms are sorted by name, whatever order the JSON gave.
        assert_eq!(shader.names(), ["angle", "strength"]);
        assert_eq!(shader.padding.at(9.0), 20.0);
        let Effect::Shader(plain) = &scene.layers[0].effects[1] else {
            panic!("not a shader");
        };
        assert!(plain.uniforms.is_empty());
        assert_eq!(plain.padding.at(0.0), 0.0);
        // Padding adds up along the list like any other reach.
        assert_eq!(scene.margin(), 20);
        // Two shaders with the same code and uniforms share a pipeline.
        let twice = effects_of(&format!(
            r#"[{{"type": "shader", "code": "{SHADER}", "uniforms": {{"strength": 1}}}},
                {{"type": "shader", "code": "{SHADER}", "uniforms": {{"strength": 2}}}}]"#
        ));
        assert_eq!(twice.shader_sources().len(), 1);
        assert_eq!(scene.shader_sources().len(), 2);
    }

    #[test]
    fn shader_sources_include_those_in_groups() {
        let json = format!(
            r#"{{"width": 100, "height": 100, "fps": 30, "durationInFrames": 10,
                "layers": [{{"id": "g", "type": "group", "children": [
                  {{"id": "c", "type": "group", "children": [], "effects": [
                    {{"type": "shader", "code": "{SHADER}", "uniforms": {{"strength": 1}}}}]}}]}}]}}"#
        );
        let scene = Scene::from_json(&json, PathBuf::new()).unwrap();
        assert_eq!(scene.shader_sources().len(), 1);
        assert!(scene.shader_sources()[0].contains(r"u.strength"));
    }

    #[test]
    fn bad_shaders_fail_at_load_naming_the_layer() {
        let shader = |code: &str, rest: &str| {
            error(&format!(
                r#""effects": [{{"type": "shader", "code": "{code}"{rest}}}],"#
            ))
        };
        let msg = shader(SHADER, "");
        assert!(
            msg.contains("layer \"box\"") && msg.contains("shader code 2:"),
            "{msg}"
        );
        let msg = shader(
            r"fn effect(px: vec2<f32>) -> vec4<f32> {\n  return vec4<f32>(1.0, 0.0;\n}",
            "",
        );
        assert!(
            msg.contains("layer \"box\"") && msg.contains("shader code 2:"),
            "{msg}"
        );
        let msg = shader(r"fn other() {}", "");
        assert!(
            msg.contains("layer \"box\"") && msg.contains("fn effect"),
            "{msg}"
        );
        let msg = shader(
            r"fn effect(px: f32) -> vec4<f32> { return vec4<f32>(0.0); }",
            "",
        );
        assert!(
            msg.contains("layer \"box\"") && msg.contains("wrong signature"),
            "{msg}"
        );
        let good = r"fn effect(px: vec2<f32>) -> vec4<f32> { return layer(px); }";
        let msg = shader(good, r#", "uniforms": {"not a name": 1}"#);
        assert!(
            msg.contains("layer \"box\"") && msg.contains("uniform name"),
            "{msg}"
        );
        let msg = shader(
            good,
            r#", "padding": [{"frame": 0, "value": -1}, {"frame": 9, "value": 4}]"#,
        );
        assert!(
            msg.contains("layer \"box\"") && msg.contains("padding"),
            "{msg}"
        );
        let msg = error(r#""effects": [{"type": "shader"}],"#);
        assert!(msg.contains("code"), "{msg}");
    }

    #[test]
    fn colour_filters_add_no_margin() {
        let scene = effects_of(
            r#"[{"type": "saturate", "amount": 9}, {"type": "hueRotate", "angle": 720},
                {"type": "contrast", "amount": 1000}]"#,
        );
        assert_eq!(scene.margin(), 0);
    }

    #[test]
    fn margin_is_zero_without_reaching_effects() {
        let scene = scene_with(r#""effects": [{"type": "blur", "radius": 90}],"#).unwrap();
        assert_eq!(scene.margin(), 0);
        assert_eq!(scene_with("").unwrap().margin(), 0);
    }

    #[test]
    fn margin_is_rounded_up_and_limited_to_the_max_side() {
        assert_eq!(margin_for(0.0, 100, 100), 0);
        assert_eq!(margin_for(12.2, 100, 100), 13);
        assert_eq!(margin_for(12.0, 100, 100), 12);
        // The longer side decides how much room is left.
        assert_eq!(margin_for(1e9, 100, 200), (MAX_SIDE - 200) / 2);
        assert_eq!(margin_for(1e9, 8000, 100), 96);
        assert_eq!(margin_for(50.0, MAX_SIDE, 10), 0);
    }

    const TWO_STOPS: &str =
        r##""stops": [{"offset": 0, "color": "#f00"}, {"offset": 1, "color": "#00f"}]"##;

    /// A scene with a text layer whose `color` is `color` (JSON).
    fn text_scene(color: &str) -> Result<Scene> {
        let json = format!(
            r##"{{"width": 200, "height": 100, "fps": 30, "durationInFrames": 10,
                "fonts": {{"DM Sans": "f.ttf"}},
                "layers": [{{"id": "words", "type": "text", "text": "hi", "font": "DM Sans",
                             "size": 20, "color": {color}}}]}}"##
        );
        Scene::from_json(&json, PathBuf::new())
    }

    fn fill_scene(fill: &str) -> Result<Scene> {
        let json = format!(
            r##"{{"width": 200, "height": 100, "fps": 30, "durationInFrames": 10,
                "layers": [{{"id": "box", "type": "shape",
                  "shape": {{"kind": "rect", "width": 100, "height": 50}}, "fill": {fill}}}]}}"##
        );
        Scene::from_json(&json, PathBuf::new())
    }

    #[test]
    fn fill_and_text_colour_take_a_colour_or_a_gradient() {
        let gradients = [
            format!(r#"{{"type": "linear", "x0": 0, "y0": 0, "x1": 100, "y1": 0, {TWO_STOPS}}}"#),
            format!(
                r#"{{"type": "radial", "cx": 5, "cy": 5, "r": 40, "extend": "repeat", {TWO_STOPS}}}"#
            ),
            format!(r#"{{"type": "conic", "cx": 5, "cy": 5, "angle": 90, {TWO_STOPS}}}"#),
        ];
        let scene = fill_scene(r##""#336699""##).unwrap();
        let LayerKind::Shape(shape) = &scene.layers[0].kind else {
            panic!("not a shape");
        };
        assert!(
            matches!(shape.fill, Some(Paint::Solid(c)) if c == Color::parse("#336699").unwrap())
        );
        for g in &gradients {
            let scene = fill_scene(g).unwrap_or_else(|e| panic!("{g}: {e}"));
            let LayerKind::Shape(shape) = &scene.layers[0].kind else {
                panic!("not a shape");
            };
            assert!(matches!(shape.fill, Some(Paint::Gradient(_))), "{g}");
            let scene = text_scene(g).unwrap_or_else(|e| panic!("{g}: {e}"));
            let LayerKind::Text(text) = &scene.layers[0].kind else {
                panic!("not text");
            };
            assert!(matches!(text.color, Paint::Gradient(_)), "{g}");
        }
        let scene = fill_scene("null").unwrap();
        assert!(matches!(
            &scene.layers[0].kind,
            LayerKind::Shape(ShapeLayer { fill: None, .. })
        ));
    }

    #[test]
    fn rejects_bad_paints_with_a_clear_message() {
        let cases = [
            ("42".to_string(), "colour string"),
            ("[1, 2]".to_string(), "colour string"),
            (r##""#12""##.to_string(), "3, 4, 6 or 8 hex digits"),
            (
                format!(r#"{{"type": "spiral", {TWO_STOPS}}}"#),
                "bad gradient",
            ),
            (r#"{"type": "linear", "x0": 0}"#.to_string(), "bad gradient"),
        ];
        for (paint, want) in cases {
            let msg = fill_scene(&paint).unwrap_err().to_string();
            assert!(msg.contains(want), "{paint}: {msg}");
            let msg = text_scene(&paint).unwrap_err().to_string();
            assert!(msg.contains(want), "{paint}: {msg}");
        }
    }

    #[test]
    fn rejects_bad_fill_gradients_naming_the_layer() {
        let one = r##""stops": [{"offset": 0, "color": "#fff"}]"##;
        let g = format!(r#"{{"type": "linear", "x0": 0, "y0": 0, "x1": 1, "y1": 0, {one}}}"#);
        let msg = fill_scene(&g).unwrap_err().to_string();
        assert!(
            msg.contains("\"box\"") && msg.contains("fill gradient") && msg.contains("2 stops"),
            "{msg}"
        );
        let g = format!(r#"{{"type": "radial", "cx": 0, "cy": 0, "r": -1, {TWO_STOPS}}}"#);
        let msg = text_scene(&g).unwrap_err().to_string();
        assert!(
            msg.contains("\"words\"") && msg.contains("color gradient") && msg.contains("radius"),
            "{msg}"
        );
    }

    /// A scene with the given top-level `camera` entry (or none).
    fn camera_scene(camera: &str) -> Result<Scene> {
        let json = format!(
            r##"{{"width": 200, "height": 100, "fps": 30, "durationInFrames": 10, {camera}
                "layers": [{{"id": "card", "type": "shape",
                  "transform": {{"rotateX": 20, "rotateY": [{{"frame": 0, "value": 0}}, {{"frame": 9, "value": 45}}], "z": -30}},
                  "shape": {{"kind": "rect", "width": 100, "height": 50}}, "fill": "#fff"}}]}}"##
        );
        Scene::from_json(&json, PathBuf::new())
    }

    #[test]
    fn parses_3d_transforms_with_zero_defaults() {
        let scene = camera_scene("").unwrap();
        let t = &scene.layers[0].transform;
        assert_eq!(t.rotate_x.at(0.0), 20.0);
        assert_eq!(t.rotate_y.at(9.0), 45.0);
        assert_eq!(t.z.at(0.0), -30.0);
        assert!(t.is_3d());
        assert!(scene.camera.is_none());
        // A layer that names none of them is flat, and so is one that names
        // them as zero.
        let scene = scene_with("").unwrap();
        assert!(!scene.layers[0].transform.is_3d());
        let scene = scene_with(r#""transform": {"rotateX": 0, "z": [{"frame": 0, "value": 0}, {"frame": 5, "value": 0}]},"#)
            .unwrap();
        assert!(!scene.layers[0].transform.is_3d());
        let scene = scene_with(
            r#""transform": {"z": [{"frame": 0, "value": 0}, {"frame": 5, "value": 8}]},"#,
        )
        .unwrap();
        assert!(scene.layers[0].transform.is_3d());
    }

    #[test]
    fn parses_a_camera_whose_origin_defaults_to_the_middle() {
        let scene = camera_scene(r#""camera": {"perspective": 800},"#).unwrap();
        let camera = scene.camera.unwrap();
        assert_eq!(camera.perspective.at(0.0), 800.0);
        assert!(camera.x.is_none() && camera.y.is_none());
        let scene = camera_scene(
            r#""camera": {"perspective": [{"frame": 0, "value": 900}, {"frame": 9, "value": 400}], "x": 20, "y": 90},"#,
        )
        .unwrap();
        let camera = scene.camera.unwrap();
        assert_eq!(camera.perspective.at(9.0), 400.0);
        assert_eq!(camera.x.unwrap().at(0.0), 20.0);
    }

    #[test]
    fn rejects_a_camera_without_a_positive_perspective() {
        for camera in [
            r#""camera": {"perspective": 0},"#,
            r#""camera": {"perspective": -50},"#,
            r#""camera": {"perspective": [{"frame": 0, "value": 500}, {"frame": 5, "value": 0}]},"#,
        ] {
            let msg = camera_scene(camera).unwrap_err().to_string();
            assert!(
                msg.contains("perspective must be greater than 0"),
                "{camera}: {msg}"
            );
        }
        // The perspective is required.
        assert!(camera_scene(r#""camera": {"x": 3},"#).is_err());
    }

    #[test]
    fn a_matte_source_cannot_be_turned_in_3d() {
        let parse = |source_transform: &str| {
            let json = format!(
                r#"{{"width": 20, "height": 20, "fps": 30, "durationInFrames": 1, "layers": [
                  {{"id": "photo", "type": "group", "children": [], "matte": {{"layer": "cut"}}}},
                  {{"id": "cut", "type": "group", "children": [], "transform": {source_transform}}}]}}"#
            );
            Scene::from_json(&json, PathBuf::new()).map_err(|e| e.to_string())
        };
        assert!(parse(r#"{"x": 4, "rotation": 30}"#).is_ok());
        for transform in [r#"{"rotateX": 10}"#, r#"{"rotateY": 10}"#, r#"{"z": 5}"#] {
            let msg = parse(transform).unwrap_err();
            assert!(
                msg.contains("\"photo\"")
                    && msg.contains("\"cut\"")
                    && msg.contains("3D transform"),
                "{transform}: {msg}"
            );
        }
    }

    /// A scene whose first layer is a `preserve3d` group with `extra` fields
    /// spliced in, beside a plain shape that the group can matte or be mattes
    /// by.
    fn group_scene(extra: &str) -> std::result::Result<Scene, String> {
        let json = format!(
            r##"{{"width": 20, "height": 20, "fps": 30, "durationInFrames": 1, "layers": [
              {{"id": "stack", "type": "group", "preserve3d": true, {extra}
                "children": [{{"id": "card", "type": "shape", "transform": {{"z": 10}},
                  "shape": {{"kind": "rect", "width": 5, "height": 5}}, "fill": "#fff"}}]}},
              {{"id": "other", "type": "shape", "matte": {{"layer": "stack"}},
                "shape": {{"kind": "rect", "width": 5, "height": 5}}, "fill": "#fff"}}]}}"##
        );
        Scene::from_json(&json, PathBuf::new()).map_err(|e| e.to_string())
    }

    #[test]
    fn preserve3d_defaults_to_off_and_parses() {
        let json = r#"{"width": 20, "height": 20, "fps": 30, "durationInFrames": 1, "layers": [
            {"id": "plain", "type": "group", "children": []},
            {"id": "deep", "type": "group", "preserve3d": true, "children": []}]}"#;
        let scene = Scene::from_json(json, PathBuf::new()).unwrap();
        let flags: Vec<_> = scene
            .layers
            .iter()
            .map(|l| matches!(&l.kind, LayerKind::Group(g) if g.preserve3d))
            .collect();
        assert_eq!(flags, [false, true]);
    }

    #[test]
    fn rejects_what_a_preserve3d_group_cannot_do_naming_the_layer() {
        // The group is also a matte source here (the shape's matte), so the
        // plain cases have to drop that.
        let parse = |extra: &str| {
            let json = format!(
                r##"{{"width": 20, "height": 20, "fps": 30, "durationInFrames": 1, "layers": [
                  {{"id": "stack", "type": "group", "preserve3d": true, {extra} "children": []}},
                  {{"id": "other", "type": "group", "children": []}}]}}"##
            );
            Scene::from_json(&json, PathBuf::new()).map_err(|e| e.to_string())
        };
        assert!(parse(r#""transform": {"rotateY": 30},"#).is_ok());
        assert!(parse(r#""opacity": 0.5,"#).is_ok());
        let cases = [
            (r#""effects": [{"type": "blur", "radius": 2}],"#, "effects"),
            (
                r#""clip": {"kind": "ellipse", "cx": 0, "cy": 0, "rx": 5, "ry": 5},"#,
                "clip",
            ),
            (
                r##""mask": {"gradient": {"type": "linear", "x0": 0, "y0": 0, "x1": 1, "y1": 0,
                    "stops": [{"offset": 0, "color": "#fff"}, {"offset": 1, "color": "#000"}]}},"##,
                "mask",
            ),
            (r#""matte": {"layer": "other"},"#, "matte"),
            (r#""blendMode": "multiply","#, "blendMode"),
        ];
        for (extra, want) in cases {
            let msg = parse(extra).unwrap_err();
            assert!(
                msg.contains("\"stack\"") && msg.contains("preserve3d") && msg.contains(want),
                "{extra}: {msg}"
            );
        }
    }

    #[test]
    fn a_preserve3d_group_cannot_be_a_matte_source() {
        let msg = group_scene("").unwrap_err();
        assert!(
            msg.contains("\"stack\"") && msg.contains("matte source"),
            "{msg}"
        );
    }

    #[test]
    fn preserve3d_children_may_use_mattes_and_3d_among_themselves() {
        let json = r##"{"width": 20, "height": 20, "fps": 30, "durationInFrames": 1, "layers": [
          {"id": "stack", "type": "group", "preserve3d": true, "children": [
            {"id": "photo", "type": "group", "children": [], "transform": {"z": 5, "rotateY": 20},
             "matte": {"layer": "cut"}},
            {"id": "cut", "type": "group", "children": []},
            {"id": "inner", "type": "group", "preserve3d": true, "opacity": 0.5,
             "transform": {"rotateX": 30}, "children": []}]}]}"##;
        Scene::from_json(json, PathBuf::new()).unwrap();
    }

    #[test]
    fn parses_a_corner_pin_with_corners_left_out() {
        let scene = scene_with(
            r#""effects": [{"type": "cornerPin", "topRight": [90, [{"frame": 0, "value": 4}, {"frame": 9, "value": 20}]],
                            "bottomLeft": [-5, 60]}],"#,
        )
        .unwrap();
        let Effect::CornerPin {
            top_left,
            top_right,
            bottom_right,
            bottom_left,
        } = &scene.layers[0].effects[0]
        else {
            panic!("not a corner pin");
        };
        assert!(top_left.is_none() && bottom_right.is_none());
        let [x, y] = top_right.as_ref().unwrap();
        assert_eq!((x.at(0.0), y.at(9.0)), (90.0, 20.0));
        assert_eq!(bottom_left.as_ref().unwrap()[0].at(0.0), -5.0);
        // None of them is allowed too: it pins nothing.
        scene_with(r#""effects": [{"type": "cornerPin"}],"#).unwrap();
    }

    #[test]
    fn a_corner_pin_needs_a_box_and_adds_no_margin() {
        let msg = Scene::from_json(
            r#"{"width": 20, "height": 20, "fps": 30, "durationInFrames": 1, "layers": [
                {"id": "g", "type": "group", "children": [],
                 "effects": [{"type": "cornerPin", "topLeft": [1, 1]}]}]}"#,
            PathBuf::new(),
        )
        .unwrap_err()
        .to_string();
        assert!(
            msg.contains("\"g\"") && msg.contains("cornerPin") && msg.contains("group has none"),
            "{msg}"
        );
        // A pin far outside the box still counts nothing: it only moves
        // what the texture holds.
        let scene =
            scene_with(r#""effects": [{"type": "cornerPin", "topLeft": [-900, -900]}],"#).unwrap();
        assert_eq!(scene.margin(), 0);
    }

    #[test]
    fn parses_motion_blur_with_defaults() {
        assert!(scene_with("").unwrap().layers[0].motion_blur.is_none());
        let scene = scene_with(r#""motionBlur": {},"#).unwrap();
        let blur = scene.layers[0].motion_blur.as_ref().unwrap();
        assert_eq!((blur.samples, blur.shutter.at(0.0)), (8, 0.5));
        let scene = scene_with(
            r#""motionBlur": {"samples": 24, "shutter": [{"frame": 0, "value": 0}, {"frame": 9, "value": 1}]},"#,
        )
        .unwrap();
        let blur = scene.layers[0].motion_blur.as_ref().unwrap();
        assert_eq!((blur.samples, blur.shutter.at(9.0)), (24, 1.0));
        // A blurred layer needs no margin.
        assert_eq!(scene.margin(), 0);
    }

    #[test]
    fn rejects_motion_blur_samples_out_of_range_naming_the_layer() {
        for samples in ["1", "0", "65", "-3"] {
            let json = format!(r#""motionBlur": {{"samples": {samples}}},"#);
            let msg = error(&json);
            assert!(
                msg.contains("motionBlur") && msg.contains("\"box\""),
                "{samples}: {msg}"
            );
        }
        for samples in ["2", "64"] {
            scene_with(&format!(r#""motionBlur": {{"samples": {samples}}},"#)).unwrap();
        }
    }

    #[test]
    fn preserve3d_groups_and_their_children_cannot_be_motion_blurred() {
        let blur = r#""motionBlur": {"samples": 4},"#;
        let msg = group_scene(blur).unwrap_err();
        assert!(
            msg.contains("\"stack\"") && msg.contains("motionBlur"),
            "{msg}"
        );
        let json = r##"{"width": 20, "height": 20, "fps": 30, "durationInFrames": 1, "layers": [
          {"id": "stack", "type": "group", "preserve3d": true, "children": [
            {"id": "card", "type": "group", "children": [], "motionBlur": {}}]}]}"##;
        let msg = Scene::from_json(json, PathBuf::new())
            .unwrap_err()
            .to_string();
        assert!(
            msg.contains("\"card\"") && msg.contains("preserve3d"),
            "{msg}"
        );
        // A group around the whole stack is the way to blur it.
        let json = r##"{"width": 20, "height": 20, "fps": 30, "durationInFrames": 1, "layers": [
          {"id": "outer", "type": "group", "motionBlur": {}, "children": [
            {"id": "stack", "type": "group", "preserve3d": true, "children": [
              {"id": "card", "type": "group", "children": [
                {"id": "inner", "type": "group", "children": [], "motionBlur": {}}]}]}]}]}"##;
        Scene::from_json(json, PathBuf::new()).unwrap();
    }
}
