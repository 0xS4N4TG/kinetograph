//! SVG filter graphs: the `filterGraph` effect (docs/SCENE.md).
//!
//! A `<filter>` is a list of primitives (`feTurbulence`, `feGaussianBlur`, ...)
//! that read the layer (`SourceGraphic`, `SourceAlpha`) or each other's results
//! and make one image. This file holds the scene's spelling of it (the
//! attributes keep their SVG names), the check made when a scene loads, its
//! value at one frame (`ResolvedFilterGraph`, every animated number a plain one,
//! `<feDropShadow>` split into the primitives it is made of) and `plan`, which
//! turns the units and the defaults of the spec (the filter region, a primitive's
//! subregion) into rectangles in the layer's space. The passes that draw it are in
//! `compositor/filter_graph.rs`.
//!
//! Written from the W3C Filter Effects Module Level 1 and SVG 1.1.

use std::collections::HashMap;

use serde::Deserialize;
use kurbo::Rect;

use crate::anim::Num;
use crate::color::Color;
use crate::error::{Error, Result};
use crate::scene::{BaseFrequency, BlendMode, Channel, TurbulenceKind};
use crate::turbulence::MAX_OCTAVES;

/// Largest blur, morphology and convolution the passes take, in canvas
/// pixels or kernel entries; bigger values are clamped.
pub const MAX_STD_DEVIATION: f64 = 256.0;
pub const MAX_MORPHOLOGY_RADIUS: f64 = 64.0;
/// A `feConvolveMatrix` has at most this many entries per side.
pub const MAX_CONVOLVE_ORDER: i64 = 8;
/// A `feComponentTransfer` table has at most this many values.
pub const MAX_TABLE_VALUES: usize = 32;

// ---- The scene's spelling ----

/// What `units` mean: SVG's `userSpaceOnUse` (layer pixels) or
/// `objectBoundingBox` (fractions of the layer's box).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub enum FilterUnits {
    #[serde(rename = "userSpaceOnUse")]
    UserSpaceOnUse,
    #[serde(rename = "objectBoundingBox")]
    ObjectBoundingBox,
}

/// `color-interpolation-filters`. `auto` is `sRGB`, as a browser has it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub enum ColorSpace {
    #[serde(rename = "linearRGB")]
    LinearRgb,
    #[serde(rename = "sRGB", alias = "auto")]
    Srgb,
}

/// The `filterGraph` effect.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterGraph {
    /// The filter region: `x`, `y`, `width`, `height` in `filterUnits`. Left
    /// out, SVG's -10%, -10%, 120%, 120% of the layer's box.
    pub x: Option<Num>,
    pub y: Option<Num>,
    pub width: Option<Num>,
    pub height: Option<Num>,
    /// Default `objectBoundingBox`, as in SVG.
    pub filter_units: Option<FilterUnits>,
    /// Default `userSpaceOnUse`, as in SVG.
    pub primitive_units: Option<FilterUnits>,
    /// The colour space the primitives work in unless they say otherwise
    /// (default `linearRGB`).
    pub color_interpolation_filters: Option<ColorSpace>,
    /// The box of what the filter is on, `[x, y, width, height]` in layer
    /// space, for a layer that has none of its own (a group): the box that
    /// `objectBoundingBox` units and the default region are fractions of.
    pub bbox: Option<[f64; 4]>,
    pub primitives: Vec<FilterPrimitive>,
}

/// One primitive: the attributes every `fe*` element has, and its own.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterPrimitive {
    /// The primitive subregion, in `primitiveUnits`; each side left out
    /// defaults as SVG says (the union of the inputs' subregions, or the
    /// filter region).
    pub x: Option<Num>,
    pub y: Option<Num>,
    pub width: Option<Num>,
    pub height: Option<Num>,
    /// `SourceGraphic`, `SourceAlpha`, or the `result` of an earlier
    /// primitive. Left out: the previous primitive's result (the layer for
    /// the first). `BackgroundImage`, `BackgroundAlpha`, `FillPaint` and
    /// `StrokePaint` are empty images, as in Chrome.
    #[serde(rename = "in")]
    pub input: Option<String>,
    pub in2: Option<String>,
    pub result: Option<String>,
    pub color_interpolation_filters: Option<ColorSpace>,
    #[serde(flatten)]
    pub op: FilterOp,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "primitive")]
pub enum FilterOp {
    #[serde(rename = "feTurbulence", rename_all = "camelCase")]
    Turbulence {
        #[serde(rename = "type")]
        kind: Option<TurbulenceKind>,
        base_frequency: Option<BaseFrequency>,
        num_octaves: Option<i64>,
        seed: Option<f64>,
        /// `stitchTiles="stitch"`.
        stitch_tiles: Option<bool>,
    },
    #[serde(rename = "feDisplacementMap", rename_all = "camelCase")]
    DisplacementMap {
        scale: Option<Num>,
        x_channel_selector: Option<Channel>,
        y_channel_selector: Option<Channel>,
    },
    #[serde(rename = "feGaussianBlur", rename_all = "camelCase")]
    GaussianBlur {
        std_deviation: Option<BaseFrequency>,
    },
    #[serde(rename = "feColorMatrix", rename_all = "camelCase")]
    ColorMatrix {
        #[serde(rename = "type")]
        kind: Option<ColorMatrixKind>,
        values: Option<Vec<Num>>,
    },
    #[serde(rename = "feOffset")]
    Offset { dx: Option<Num>, dy: Option<Num> },
    #[serde(rename = "feFlood", rename_all = "camelCase")]
    Flood {
        flood_color: Option<Color>,
        flood_opacity: Option<Num>,
    },
    #[serde(rename = "feComposite")]
    Composite {
        operator: Option<CompositeOperator>,
        k1: Option<Num>,
        k2: Option<Num>,
        k3: Option<Num>,
        k4: Option<Num>,
    },
    #[serde(rename = "feBlend")]
    Blend { mode: Option<FeBlendMode> },
    /// `nodes` are the `in` of each `feMergeNode`.
    #[serde(rename = "feMerge")]
    Merge { nodes: Vec<String> },
    #[serde(rename = "feComponentTransfer", rename_all = "camelCase")]
    ComponentTransfer {
        func_r: Option<TransferFunction>,
        func_g: Option<TransferFunction>,
        func_b: Option<TransferFunction>,
        func_a: Option<TransferFunction>,
    },
    #[serde(rename = "feDropShadow", rename_all = "camelCase")]
    DropShadow {
        dx: Option<Num>,
        dy: Option<Num>,
        std_deviation: Option<BaseFrequency>,
        flood_color: Option<Color>,
        flood_opacity: Option<Num>,
    },
    #[serde(rename = "feMorphology")]
    Morphology {
        operator: Option<MorphologyOperator>,
        radius: Option<BaseFrequency>,
    },
    #[serde(rename = "feTile")]
    Tile {},
    #[serde(rename = "feConvolveMatrix", rename_all = "camelCase")]
    ConvolveMatrix {
        /// A whole number, or `[x, y]`.
        order: Option<BaseFrequency>,
        kernel_matrix: Vec<Num>,
        divisor: Option<Num>,
        bias: Option<Num>,
        target_x: Option<i64>,
        target_y: Option<i64>,
        edge_mode: Option<EdgeMode>,
        preserve_alpha: Option<bool>,
    },
    #[serde(rename = "feDiffuseLighting", rename_all = "camelCase")]
    DiffuseLighting {
        surface_scale: Option<Num>,
        diffuse_constant: Option<Num>,
        lighting_color: Option<Color>,
        light: Light,
    },
    #[serde(rename = "feSpecularLighting", rename_all = "camelCase")]
    SpecularLighting {
        surface_scale: Option<Num>,
        specular_constant: Option<Num>,
        specular_exponent: Option<Num>,
        lighting_color: Option<Color>,
        light: Light,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ColorMatrixKind {
    Matrix,
    Saturate,
    HueRotate,
    LuminanceToAlpha,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompositeOperator {
    Over,
    In,
    Out,
    Atop,
    Xor,
    Arithmetic,
}

/// `feBlend`'s `mode`: the 16 modes, spelled as CSS spells them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub enum FeBlendMode {
    #[serde(rename = "normal")]
    Normal,
    #[serde(rename = "multiply")]
    Multiply,
    #[serde(rename = "screen")]
    Screen,
    #[serde(rename = "overlay")]
    Overlay,
    #[serde(rename = "darken")]
    Darken,
    #[serde(rename = "lighten")]
    Lighten,
    #[serde(rename = "color-dodge")]
    ColorDodge,
    #[serde(rename = "color-burn")]
    ColorBurn,
    #[serde(rename = "hard-light")]
    HardLight,
    #[serde(rename = "soft-light")]
    SoftLight,
    #[serde(rename = "difference")]
    Difference,
    #[serde(rename = "exclusion")]
    Exclusion,
    #[serde(rename = "hue")]
    Hue,
    #[serde(rename = "saturation")]
    Saturation,
    #[serde(rename = "color")]
    Color,
    #[serde(rename = "luminosity")]
    Luminosity,
}

impl From<FeBlendMode> for BlendMode {
    fn from(mode: FeBlendMode) -> BlendMode {
        match mode {
            FeBlendMode::Normal => BlendMode::Normal,
            FeBlendMode::Multiply => BlendMode::Multiply,
            FeBlendMode::Screen => BlendMode::Screen,
            FeBlendMode::Overlay => BlendMode::Overlay,
            FeBlendMode::Darken => BlendMode::Darken,
            FeBlendMode::Lighten => BlendMode::Lighten,
            FeBlendMode::ColorDodge => BlendMode::ColorDodge,
            FeBlendMode::ColorBurn => BlendMode::ColorBurn,
            FeBlendMode::HardLight => BlendMode::HardLight,
            FeBlendMode::SoftLight => BlendMode::SoftLight,
            FeBlendMode::Difference => BlendMode::Difference,
            FeBlendMode::Exclusion => BlendMode::Exclusion,
            FeBlendMode::Hue => BlendMode::Hue,
            FeBlendMode::Saturation => BlendMode::Saturation,
            FeBlendMode::Color => BlendMode::Color,
            FeBlendMode::Luminosity => BlendMode::Luminosity,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MorphologyOperator {
    Erode,
    Dilate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EdgeMode {
    Duplicate,
    Wrap,
    None,
}

/// One of `feFuncR`, `feFuncG`, `feFuncB`, `feFuncA`.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TransferFunction {
    Identity,
    #[serde(rename_all = "camelCase")]
    Table {
        table_values: Vec<Num>,
    },
    #[serde(rename_all = "camelCase")]
    Discrete {
        table_values: Vec<Num>,
    },
    Linear {
        slope: Option<Num>,
        intercept: Option<Num>,
    },
    Gamma {
        amplitude: Option<Num>,
        exponent: Option<Num>,
        offset: Option<Num>,
    },
}

/// The light of a lighting primitive. Positions are in `primitiveUnits`.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Light {
    /// `feDistantLight`: `azimuth` and `elevation` in degrees.
    Distant {
        azimuth: Option<Num>,
        elevation: Option<Num>,
    },
    /// `fePointLight`.
    Point {
        x: Option<Num>,
        y: Option<Num>,
        z: Option<Num>,
    },
    /// `feSpotLight`.
    #[serde(rename_all = "camelCase")]
    Spot {
        x: Option<Num>,
        y: Option<Num>,
        z: Option<Num>,
        points_at_x: Option<Num>,
        points_at_y: Option<Num>,
        points_at_z: Option<Num>,
        specular_exponent: Option<Num>,
        limiting_cone_angle: Option<Num>,
    },
}

impl FilterGraph {
    /// Whether the graph needs the layer's box to place itself: the region
    /// or the primitives are in `objectBoundingBox` units, or the region is
    /// left to default.
    pub fn needs_box(&self) -> bool {
        self.bbox.is_none()
            && (self.filter_units != Some(FilterUnits::UserSpaceOnUse)
                || self.x.is_none()
                || self.y.is_none()
                || self.width.is_none()
                || self.height.is_none()
                || self.primitive_units == Some(FilterUnits::ObjectBoundingBox))
    }

    /// How far past the layer's own pixels the graph can paint, in layer
    /// units times `layer_scale` (the product of the scales of the layer and
    /// its ancestors), at the largest keyframes: what offsets, displacements,
    /// morphology and convolution push, and the blurs on top of them. A graph
    /// that only blurs counts nothing, like the `blur` effect, which keeps its
    /// scenes at margin 0.
    pub fn reach(&self, layer_scale: f64) -> f64 {
        let big = |n: &Num| n.max().abs().max(n.min().abs());
        let pair = |p: &BaseFrequency| big(&p.x).max(big(&p.y));
        let (mut push, mut blur) = (0.0, 0.0);
        for primitive in &self.primitives {
            match &primitive.op {
                FilterOp::GaussianBlur { std_deviation } => {
                    blur += 3.0
                        * std_deviation
                            .as_ref()
                            .map_or(0.0, pair)
                            .min(MAX_STD_DEVIATION);
                }
                FilterOp::Offset { dx, dy } => {
                    push += dx
                        .as_ref()
                        .map_or(0.0, big)
                        .max(dy.as_ref().map_or(0.0, big));
                }
                FilterOp::DropShadow {
                    dx,
                    dy,
                    std_deviation,
                    ..
                } => {
                    push += dx
                        .as_ref()
                        .map_or(0.0, big)
                        .max(dy.as_ref().map_or(0.0, big));
                    blur += 3.0
                        * std_deviation
                            .as_ref()
                            .map_or(0.0, pair)
                            .min(MAX_STD_DEVIATION);
                }
                FilterOp::DisplacementMap { scale, .. } => {
                    push += scale.as_ref().map_or(0.0, big) / 2.0;
                }
                FilterOp::Morphology {
                    operator: Some(MorphologyOperator::Dilate),
                    radius,
                } => push += radius.as_ref().map_or(0.0, pair).min(MAX_MORPHOLOGY_RADIUS),
                FilterOp::ConvolveMatrix { order, .. } => {
                    push += order
                        .as_ref()
                        .map_or(3.0, pair)
                        .min(MAX_CONVOLVE_ORDER as f64);
                }
                _ => {}
            }
        }
        // Blurs count only beside something that moves pixels.
        (push + if push > 0.0 { blur } else { 0.0 }) * layer_scale
    }

    /// The load-time checks: an error naming `layer`.
    pub fn validate(&self, layer: &str, has_box: bool) -> Result<()> {
        let bad = |msg: String| Err(Error::Scene(format!("layer {layer:?}: filterGraph {msg}")));
        if !has_box && self.needs_box() {
            return bad(
                "on a group without a layout needs filterUnits \"userSpaceOnUse\" with x, y, \
                 width and height, and primitives in userSpaceOnUse: the group has no box to \
                 measure fractions or the default region from"
                    .into(),
            );
        }
        if self.width.as_ref().is_some_and(|w| w.min() < 0.0)
            || self.height.as_ref().is_some_and(|h| h.min() < 0.0)
        {
            return bad("region width and height must not be negative".into());
        }
        let mut names: Vec<&str> = Vec::new();
        for (i, p) in self.primitives.iter().enumerate() {
            let what = |msg: &str| format!("primitive {i} ({}) {msg}", p.op.name());
            if p.width.as_ref().is_some_and(|w| w.min() < 0.0)
                || p.height.as_ref().is_some_and(|h| h.min() < 0.0)
            {
                return bad(what("has a negative width or height"));
            }
            for input in [&p.input, &p.in2].into_iter().flatten() {
                if !is_standard(input) && !names.contains(&input.as_str()) {
                    // Named results can only look back; the reference is
                    // treated as the previous result, like a browser does.
                }
            }
            if let Some(r) = &p.result {
                names.push(r);
            }
            match &p.op {
                FilterOp::Turbulence {
                    base_frequency,
                    num_octaves,
                    ..
                } => {
                    if let Some(f) = base_frequency
                        && (f.x.min() < 0.0 || f.y.min() < 0.0)
                    {
                        return bad(what("baseFrequency must not be negative"));
                    }
                    if let Some(n) = num_octaves
                        && !(0..=i64::from(MAX_OCTAVES)).contains(n)
                    {
                        return bad(what(&format!(
                            "numOctaves must be a whole number from 0 to {MAX_OCTAVES}, got {n}"
                        )));
                    }
                }
                FilterOp::GaussianBlur {
                    std_deviation: Some(s),
                } if s.x.min() < 0.0 || s.y.min() < 0.0 => {
                    return bad(what("stdDeviation must not be negative"));
                }
                FilterOp::DropShadow {
                    std_deviation: Some(s),
                    ..
                } if s.x.min() < 0.0 || s.y.min() < 0.0 => {
                    return bad(what("stdDeviation must not be negative"));
                }
                FilterOp::Morphology {
                    radius: Some(r), ..
                } if r.x.min() < 0.0 || r.y.min() < 0.0 => {
                    return bad(what("radius must not be negative"));
                }
                FilterOp::ColorMatrix { kind, values } => {
                    let n = values.as_ref().map_or(0, Vec::len);
                    let want = match kind.unwrap_or(ColorMatrixKind::Matrix) {
                        ColorMatrixKind::Matrix => Some(20),
                        ColorMatrixKind::Saturate | ColorMatrixKind::HueRotate => Some(1),
                        ColorMatrixKind::LuminanceToAlpha => None,
                    };
                    if let Some(want) = want
                        && n != want
                        && !(n == 0 && want == 1)
                    {
                        return bad(what(&format!("values needs {want} numbers, got {n}")));
                    }
                }
                FilterOp::ComponentTransfer {
                    func_r,
                    func_g,
                    func_b,
                    func_a,
                } => {
                    for f in [func_r, func_g, func_b, func_a].into_iter().flatten() {
                        if let TransferFunction::Table { table_values }
                        | TransferFunction::Discrete { table_values } = f
                            && table_values.len() > MAX_TABLE_VALUES
                        {
                            return bad(what(&format!(
                                "tableValues has {} values, at most {MAX_TABLE_VALUES} are supported",
                                table_values.len()
                            )));
                        }
                    }
                }
                FilterOp::ConvolveMatrix {
                    order,
                    kernel_matrix,
                    divisor,
                    target_x,
                    target_y,
                    ..
                } => {
                    let (ox, oy) = order_of(order.as_ref());
                    if ox < 1 || oy < 1 || ox > MAX_CONVOLVE_ORDER || oy > MAX_CONVOLVE_ORDER {
                        return bad(what(&format!(
                            "order must be a whole number from 1 to {MAX_CONVOLVE_ORDER}"
                        )));
                    }
                    if kernel_matrix.len() as i64 != ox * oy {
                        return bad(what(&format!(
                            "kernelMatrix needs order x order = {} numbers, got {}",
                            ox * oy,
                            kernel_matrix.len()
                        )));
                    }
                    if divisor
                        .as_ref()
                        .is_some_and(|d| d.min() <= 0.0 && d.max() >= 0.0)
                    {
                        return bad(what("divisor must not be 0"));
                    }
                    let tx = target_x.unwrap_or(ox / 2);
                    let ty = target_y.unwrap_or(oy / 2);
                    if !(0..ox).contains(&tx) || !(0..oy).contains(&ty) {
                        return bad(what("targetX and targetY must be inside the kernel"));
                    }
                }
                FilterOp::SpecularLighting {
                    specular_exponent: Some(e),
                    ..
                } if e.min() < 1.0 || e.max() > 128.0 => {
                    return bad(what("specularExponent must be from 1 to 128"));
                }
                _ => {}
            }
        }
        Ok(())
    }
}

impl FilterOp {
    /// The element's name.
    pub fn name(&self) -> &'static str {
        match self {
            FilterOp::Turbulence { .. } => "feTurbulence",
            FilterOp::DisplacementMap { .. } => "feDisplacementMap",
            FilterOp::GaussianBlur { .. } => "feGaussianBlur",
            FilterOp::ColorMatrix { .. } => "feColorMatrix",
            FilterOp::Offset { .. } => "feOffset",
            FilterOp::Flood { .. } => "feFlood",
            FilterOp::Composite { .. } => "feComposite",
            FilterOp::Blend { .. } => "feBlend",
            FilterOp::Merge { .. } => "feMerge",
            FilterOp::ComponentTransfer { .. } => "feComponentTransfer",
            FilterOp::DropShadow { .. } => "feDropShadow",
            FilterOp::Morphology { .. } => "feMorphology",
            FilterOp::Tile { .. } => "feTile",
            FilterOp::ConvolveMatrix { .. } => "feConvolveMatrix",
            FilterOp::DiffuseLighting { .. } => "feDiffuseLighting",
            FilterOp::SpecularLighting { .. } => "feSpecularLighting",
        }
    }
}

fn is_standard(name: &str) -> bool {
    matches!(
        name,
        "SourceGraphic"
            | "SourceAlpha"
            | "BackgroundImage"
            | "BackgroundAlpha"
            | "FillPaint"
            | "StrokePaint"
    )
}

/// `order` as two whole numbers (default 3).
fn order_of(order: Option<&BaseFrequency>) -> (i64, i64) {
    match order {
        Some(o) => (o.x.min().round() as i64, o.y.min().round() as i64),
        None => (3, 3),
    }
}

// ---- The graph at one frame ----

/// Where a primitive reads from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeInput {
    /// `SourceGraphic`: the layer, clipped to the filter region.
    Source,
    /// `SourceAlpha`: black with the layer's alpha.
    SourceAlpha,
    /// The result of the primitive at this index (always an earlier one).
    Node(usize),
    /// A transparent image.
    Empty,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CompositeOp {
    Over,
    In,
    Out,
    Atop,
    Xor,
    Arithmetic,
}

/// A `feFunc*`, resolved. `kind`: 0 identity, 1 table, 2 discrete, 3 linear,
/// 4 gamma.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedTransfer {
    pub kind: u32,
    pub table: Vec<f32>,
    /// linear: slope, intercept. gamma: amplitude, exponent, offset.
    pub p: [f32; 3],
}

impl ResolvedTransfer {
    pub const IDENTITY: ResolvedTransfer = ResolvedTransfer {
        kind: 0,
        table: Vec::new(),
        p: [0.0; 3],
    };
}

/// A light source with its numbers resolved, in `primitiveUnits`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ResolvedLight {
    Distant {
        azimuth: f32,
        elevation: f32,
    },
    Point {
        position: [f32; 3],
    },
    Spot {
        position: [f32; 3],
        points_at: [f32; 3],
        exponent: f32,
        /// The cone's half-angle in degrees, or `None` for no limit.
        cone: Option<f32>,
    },
}

/// What a primitive does, with the numbers of one frame. Lengths are in
/// `primitiveUnits` until `plan` turns them into layer units.
#[derive(Clone, Debug, PartialEq)]
pub enum FeOp {
    Turbulence {
        fractal: bool,
        frequency: [f32; 2],
        octaves: u32,
        seed: i64,
        stitch: bool,
    },
    DisplacementMap {
        scale: f32,
        x_channel: u32,
        y_channel: u32,
    },
    GaussianBlur {
        std: [f32; 2],
    },
    /// Straight values: `rows[i]` is output channel i's four coefficients
    /// and its offset.
    ColorMatrix {
        rows: [[f32; 5]; 4],
    },
    Offset {
        dx: f32,
        dy: f32,
    },
    /// Straight sRGB colour; the alpha includes `flood-opacity`.
    Flood {
        color: [f32; 4],
    },
    Composite {
        operator: CompositeOp,
        k: [f32; 4],
    },
    Blend {
        mode: BlendMode,
    },
    /// Draws the inputs in order, the first at the bottom.
    Merge,
    /// R, G, B, A.
    ComponentTransfer {
        funcs: [ResolvedTransfer; 4],
    },
    Morphology {
        dilate: bool,
        radius: [f32; 2],
    },
    Tile,
    ConvolveMatrix {
        order: [u32; 2],
        kernel: Vec<f32>,
        divisor: f32,
        bias: f32,
        target: [i32; 2],
        edge: EdgeMode,
        preserve_alpha: bool,
    },
    Lighting {
        specular: bool,
        surface_scale: f32,
        /// `diffuseConstant` or `specularConstant`.
        constant: f32,
        exponent: f32,
        /// Straight sRGB.
        color: [f32; 3],
        light: ResolvedLight,
    },
}

/// One primitive at one frame.
#[derive(Clone, Debug, PartialEq)]
pub struct FeNode {
    pub op: FeOp,
    /// One input, two (`feComposite`, `feBlend`, `feDisplacementMap`), or
    /// any number (`feMerge`).
    pub inputs: Vec<FeInput>,
    /// x, y, width, height in `primitiveUnits`, each if given.
    pub sub: [Option<f64>; 4],
    /// Works in linearRGB rather than sRGB.
    pub linear: bool,
}

/// The `filterGraph` at one frame.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedFilterGraph {
    /// x, y, width, height in `region_bbox` units, each if given.
    pub region: [Option<f64>; 4],
    /// The region is in fractions of the layer's box.
    pub region_bbox: bool,
    /// Lengths and subregions of the primitives are in fractions of the
    /// layer's box.
    pub prim_bbox: bool,
    /// The box given with the graph (`FilterGraph::bbox`), which is used
    /// instead of the layer's own.
    pub bbox: Option<Rect>,
    pub nodes: Vec<FeNode>,
}

impl FilterGraph {
    /// The graph at frame `f`.
    pub fn resolve(&self, f: f64) -> ResolvedFilterGraph {
        let at = |n: &Option<Num>| n.as_ref().map(|n| n.at(f));
        let default_linear = self.color_interpolation_filters != Some(ColorSpace::Srgb);
        let mut nodes: Vec<FeNode> = Vec::with_capacity(self.primitives.len());
        let mut names: HashMap<&str, usize> = HashMap::new();
        for p in &self.primitives {
            let find = |name: &Option<String>| -> FeInput {
                match name.as_deref() {
                    // No `in`: the last result, or the layer for the first.
                    None | Some("") => nodes
                        .len()
                        .checked_sub(1)
                        .map_or(FeInput::Source, FeInput::Node),
                    Some("SourceGraphic") => FeInput::Source,
                    Some("SourceAlpha") => FeInput::SourceAlpha,
                    Some("BackgroundImage" | "BackgroundAlpha" | "FillPaint" | "StrokePaint") => {
                        FeInput::Empty
                    }
                    Some(other) => match names.get(other) {
                        Some(&i) => FeInput::Node(i),
                        // A name nothing has made yet is as if `in` were left out.
                        None => nodes
                            .len()
                            .checked_sub(1)
                            .map_or(FeInput::Source, FeInput::Node),
                    },
                }
            };
            let linear = match p.color_interpolation_filters {
                Some(ColorSpace::LinearRgb) => true,
                Some(ColorSpace::Srgb) => false,
                None => default_linear,
            };
            let sub = [at(&p.x), at(&p.y), at(&p.width), at(&p.height)];
            let first = find(&p.input);
            let node = |op: FeOp, inputs: Vec<FeInput>| FeNode {
                op,
                inputs,
                sub,
                linear,
            };
            let pair = |s: &Option<BaseFrequency>| -> [f32; 2] {
                s.as_ref()
                    .map_or([0.0, 0.0], |s| [s.x.at(f) as f32, s.y.at(f) as f32])
            };
            match &p.op {
                FilterOp::Turbulence {
                    kind,
                    base_frequency,
                    num_octaves,
                    seed,
                    stitch_tiles,
                } => {
                    let frequency = base_frequency.as_ref().map_or([0.0, 0.0], |b| {
                        [b.x.at(f).max(0.0) as f32, b.y.at(f).max(0.0) as f32]
                    });
                    nodes.push(node(
                        FeOp::Turbulence {
                            fractal: *kind == Some(TurbulenceKind::FractalNoise),
                            frequency,
                            octaves: num_octaves.unwrap_or(1).clamp(0, i64::from(MAX_OCTAVES))
                                as u32,
                            seed: seed.unwrap_or(0.0) as i64,
                            stitch: stitch_tiles.unwrap_or(false),
                        },
                        vec![],
                    ));
                }
                FilterOp::DisplacementMap {
                    scale,
                    x_channel_selector,
                    y_channel_selector,
                } => {
                    let second = find(&p.in2);
                    nodes.push(node(
                        FeOp::DisplacementMap {
                            scale: at(scale).unwrap_or(0.0) as f32,
                            x_channel: x_channel_selector.unwrap_or(Channel::A).index(),
                            y_channel: y_channel_selector.unwrap_or(Channel::A).index(),
                        },
                        vec![first, second],
                    ));
                }
                FilterOp::GaussianBlur { std_deviation } => {
                    nodes.push(node(
                        FeOp::GaussianBlur {
                            std: pair(std_deviation)
                                .map(|v| v.clamp(0.0, MAX_STD_DEVIATION as f32)),
                        },
                        vec![first],
                    ));
                }
                FilterOp::ColorMatrix { kind, values } => {
                    let v: Vec<f64> = values
                        .as_ref()
                        .map(|v| v.iter().map(|n| n.at(f)).collect())
                        .unwrap_or_default();
                    nodes.push(node(
                        FeOp::ColorMatrix {
                            rows: color_matrix_rows(kind.unwrap_or(ColorMatrixKind::Matrix), &v),
                        },
                        vec![first],
                    ));
                }
                FilterOp::Offset { dx, dy } => {
                    nodes.push(node(
                        FeOp::Offset {
                            dx: at(dx).unwrap_or(0.0) as f32,
                            dy: at(dy).unwrap_or(0.0) as f32,
                        },
                        vec![first],
                    ));
                }
                FilterOp::Flood {
                    flood_color,
                    flood_opacity,
                } => {
                    nodes.push(node(
                        FeOp::Flood {
                            color: flood(flood_color, at(flood_opacity)),
                        },
                        vec![],
                    ));
                }
                FilterOp::Composite {
                    operator,
                    k1,
                    k2,
                    k3,
                    k4,
                } => {
                    let second = find(&p.in2);
                    let operator = match operator.unwrap_or(CompositeOperator::Over) {
                        CompositeOperator::Over => CompositeOp::Over,
                        CompositeOperator::In => CompositeOp::In,
                        CompositeOperator::Out => CompositeOp::Out,
                        CompositeOperator::Atop => CompositeOp::Atop,
                        CompositeOperator::Xor => CompositeOp::Xor,
                        CompositeOperator::Arithmetic => CompositeOp::Arithmetic,
                    };
                    nodes.push(node(
                        FeOp::Composite {
                            operator,
                            k: [k1, k2, k3, k4].map(|k| at(k).unwrap_or(0.0) as f32),
                        },
                        vec![first, second],
                    ));
                }
                FilterOp::Blend { mode } => {
                    let second = find(&p.in2);
                    nodes.push(node(
                        FeOp::Blend {
                            mode: mode.map_or(BlendMode::Normal, BlendMode::from),
                        },
                        vec![first, second],
                    ));
                }
                FilterOp::Merge { nodes: merge } => {
                    let inputs = merge.iter().map(|n| find(&Some(n.clone()))).collect();
                    nodes.push(node(FeOp::Merge, inputs));
                }
                FilterOp::ComponentTransfer {
                    func_r,
                    func_g,
                    func_b,
                    func_a,
                } => {
                    let func = |g: &Option<TransferFunction>| {
                        g.as_ref()
                            .map_or(ResolvedTransfer::IDENTITY, |g| transfer(g, f))
                    };
                    nodes.push(node(
                        FeOp::ComponentTransfer {
                            funcs: [func(func_r), func(func_g), func(func_b), func(func_a)],
                        },
                        vec![first],
                    ));
                }
                FilterOp::DropShadow {
                    dx,
                    dy,
                    std_deviation,
                    flood_color,
                    flood_opacity,
                } => {
                    // Blur the alpha, move it, colour it, and put the layer on
                    // top: the primitives the spec says it is.
                    let base = nodes.len();
                    let whole = FeNode {
                        op: FeOp::Tile, // replaced below
                        inputs: vec![],
                        sub: [None; 4],
                        linear,
                    };
                    nodes.push(FeNode {
                        op: FeOp::GaussianBlur {
                            std: pair(std_deviation)
                                .map(|v| v.clamp(0.0, MAX_STD_DEVIATION as f32)),
                        },
                        inputs: vec![if matches!(first, FeInput::Source) {
                            FeInput::SourceAlpha
                        } else {
                            first
                        }],
                        ..whole.clone()
                    });
                    nodes.push(FeNode {
                        op: FeOp::Offset {
                            dx: at(dx).unwrap_or(2.0) as f32,
                            dy: at(dy).unwrap_or(2.0) as f32,
                        },
                        inputs: vec![FeInput::Node(base)],
                        ..whole.clone()
                    });
                    nodes.push(FeNode {
                        op: FeOp::Flood {
                            color: flood(flood_color, at(flood_opacity)),
                        },
                        inputs: vec![],
                        ..whole.clone()
                    });
                    nodes.push(FeNode {
                        op: FeOp::Composite {
                            operator: CompositeOp::In,
                            k: [0.0; 4],
                        },
                        inputs: vec![FeInput::Node(base + 2), FeInput::Node(base + 1)],
                        ..whole.clone()
                    });
                    nodes.push(FeNode {
                        op: FeOp::Merge,
                        inputs: vec![FeInput::Node(base + 3), first],
                        sub,
                        linear,
                    });
                }
                FilterOp::Morphology { operator, radius } => {
                    nodes.push(node(
                        FeOp::Morphology {
                            dilate: *operator == Some(MorphologyOperator::Dilate),
                            radius: pair(radius).map(|v| v.max(0.0)),
                        },
                        vec![first],
                    ));
                }
                FilterOp::Tile {} => nodes.push(node(FeOp::Tile, vec![first])),
                FilterOp::ConvolveMatrix {
                    order,
                    kernel_matrix,
                    divisor,
                    bias,
                    target_x,
                    target_y,
                    edge_mode,
                    preserve_alpha,
                } => {
                    let (ox, oy) = order_of(order.as_ref());
                    let (ox, oy) = (
                        ox.clamp(1, MAX_CONVOLVE_ORDER),
                        oy.clamp(1, MAX_CONVOLVE_ORDER),
                    );
                    let kernel: Vec<f32> = kernel_matrix.iter().map(|k| k.at(f) as f32).collect();
                    let sum: f32 = kernel.iter().sum();
                    let divisor =
                        at(divisor)
                            .map(|d| d as f32)
                            .unwrap_or(if sum == 0.0 { 1.0 } else { sum });
                    nodes.push(node(
                        FeOp::ConvolveMatrix {
                            order: [ox as u32, oy as u32],
                            kernel,
                            divisor: if divisor == 0.0 { 1.0 } else { divisor },
                            bias: at(bias).unwrap_or(0.0) as f32,
                            target: [
                                target_x.unwrap_or(ox / 2) as i32,
                                target_y.unwrap_or(oy / 2) as i32,
                            ],
                            edge: edge_mode.unwrap_or(EdgeMode::Duplicate),
                            preserve_alpha: preserve_alpha.unwrap_or(false),
                        },
                        vec![first],
                    ));
                }
                FilterOp::DiffuseLighting {
                    surface_scale,
                    diffuse_constant,
                    lighting_color,
                    light,
                } => {
                    nodes.push(node(
                        FeOp::Lighting {
                            specular: false,
                            surface_scale: at(surface_scale).unwrap_or(1.0) as f32,
                            constant: at(diffuse_constant).unwrap_or(1.0).max(0.0) as f32,
                            exponent: 1.0,
                            color: lighting(lighting_color),
                            light: resolve_light(light, f),
                        },
                        vec![first],
                    ));
                }
                FilterOp::SpecularLighting {
                    surface_scale,
                    specular_constant,
                    specular_exponent,
                    lighting_color,
                    light,
                } => {
                    nodes.push(node(
                        FeOp::Lighting {
                            specular: true,
                            surface_scale: at(surface_scale).unwrap_or(1.0) as f32,
                            constant: at(specular_constant).unwrap_or(1.0).max(0.0) as f32,
                            exponent: at(specular_exponent).unwrap_or(1.0).clamp(1.0, 128.0) as f32,
                            color: lighting(lighting_color),
                            light: resolve_light(light, f),
                        },
                        vec![first],
                    ));
                }
            }
            if let Some(name) = &p.result {
                names.insert(name, nodes.len() - 1);
            }
        }
        ResolvedFilterGraph {
            region: [at(&self.x), at(&self.y), at(&self.width), at(&self.height)],
            region_bbox: self.filter_units != Some(FilterUnits::UserSpaceOnUse),
            prim_bbox: self.primitive_units == Some(FilterUnits::ObjectBoundingBox),
            bbox: self.bbox.map(|[x, y, w, h]| Rect::new(x, y, x + w, y + h)),
            nodes,
        }
    }
}

fn flood(color: &Option<Color>, opacity: Option<f64>) -> [f32; 4] {
    let c = color.unwrap_or(Color::BLACK);
    [
        f32::from(c.r) / 255.0,
        f32::from(c.g) / 255.0,
        f32::from(c.b) / 255.0,
        (f32::from(c.a) / 255.0) * opacity.unwrap_or(1.0).clamp(0.0, 1.0) as f32,
    ]
}

fn lighting(color: &Option<Color>) -> [f32; 3] {
    let c = color.unwrap_or(Color {
        r: 255,
        g: 255,
        b: 255,
        a: 255,
    });
    [
        f32::from(c.r) / 255.0,
        f32::from(c.g) / 255.0,
        f32::from(c.b) / 255.0,
    ]
}

fn resolve_light(light: &Light, f: f64) -> ResolvedLight {
    let at = |n: &Option<Num>| n.as_ref().map_or(0.0, |n| n.at(f)) as f32;
    match light {
        Light::Distant { azimuth, elevation } => ResolvedLight::Distant {
            azimuth: at(azimuth),
            elevation: at(elevation),
        },
        Light::Point { x, y, z } => ResolvedLight::Point {
            position: [at(x), at(y), at(z)],
        },
        Light::Spot {
            x,
            y,
            z,
            points_at_x,
            points_at_y,
            points_at_z,
            specular_exponent,
            limiting_cone_angle,
        } => ResolvedLight::Spot {
            position: [at(x), at(y), at(z)],
            points_at: [at(points_at_x), at(points_at_y), at(points_at_z)],
            exponent: specular_exponent
                .as_ref()
                .map_or(1.0, |n| n.at(f) as f32)
                .max(1e-3),
            cone: limiting_cone_angle.as_ref().map(|n| (n.at(f) as f32).abs()),
        },
    }
}

fn transfer(func: &TransferFunction, f: f64) -> ResolvedTransfer {
    let at = |n: &Option<Num>, default: f64| n.as_ref().map_or(default, |n| n.at(f)) as f32;
    let table = |values: &[Num]| values.iter().map(|n| n.at(f) as f32).collect::<Vec<_>>();
    match func {
        TransferFunction::Identity => ResolvedTransfer::IDENTITY,
        TransferFunction::Table { table_values } if table_values.is_empty() => {
            ResolvedTransfer::IDENTITY
        }
        TransferFunction::Table { table_values } => ResolvedTransfer {
            kind: 1,
            table: table(table_values),
            p: [0.0; 3],
        },
        TransferFunction::Discrete { table_values } if table_values.is_empty() => {
            ResolvedTransfer::IDENTITY
        }
        TransferFunction::Discrete { table_values } => ResolvedTransfer {
            kind: 2,
            table: table(table_values),
            p: [0.0; 3],
        },
        TransferFunction::Linear { slope, intercept } => ResolvedTransfer {
            kind: 3,
            table: Vec::new(),
            p: [at(slope, 1.0), at(intercept, 0.0), 0.0],
        },
        TransferFunction::Gamma {
            amplitude,
            exponent,
            offset,
        } => ResolvedTransfer {
            kind: 4,
            table: Vec::new(),
            p: [at(amplitude, 1.0), at(exponent, 1.0), at(offset, 0.0)],
        },
    }
}

/// The 4x5 matrix of a `feColorMatrix`. A `values` of the wrong length is
/// the identity, as in a browser.
fn color_matrix_rows(kind: ColorMatrixKind, v: &[f64]) -> [[f32; 5]; 4] {
    use crate::color::ColorMatrix;
    let from = |m: ColorMatrix| m.0.map(|row| row.map(|x| x as f32));
    match kind {
        ColorMatrixKind::Matrix if v.len() == 20 => {
            let mut rows = [[0.0f32; 5]; 4];
            for (i, row) in rows.iter_mut().enumerate() {
                for (j, x) in row.iter_mut().enumerate() {
                    *x = v[i * 5 + j] as f32;
                }
            }
            rows
        }
        ColorMatrixKind::Matrix => from(ColorMatrix::IDENTITY),
        // SVG defines `saturate` for any number, below 0 too.
        ColorMatrixKind::Saturate => {
            svg_saturate(v.first().copied().unwrap_or(1.0)).map(|r| r.map(|x| x as f32))
        }
        ColorMatrixKind::HueRotate => {
            from(ColorMatrix::hue_rotate(v.first().copied().unwrap_or(0.0)))
        }
        ColorMatrixKind::LuminanceToAlpha => [
            [0.0; 5],
            [0.0; 5],
            [0.0; 5],
            [0.2125, 0.7154, 0.0721, 0.0, 0.0],
        ],
    }
}

/// `saturate` for any `s`, as the SVG spec writes it.
fn svg_saturate(s: f64) -> [[f64; 5]; 4] {
    [
        [
            0.213 + 0.787 * s,
            0.715 - 0.715 * s,
            0.072 - 0.072 * s,
            0.0,
            0.0,
        ],
        [
            0.213 - 0.213 * s,
            0.715 + 0.285 * s,
            0.072 - 0.072 * s,
            0.0,
            0.0,
        ],
        [
            0.213 - 0.213 * s,
            0.715 - 0.715 * s,
            0.072 + 0.928 * s,
            0.0,
            0.0,
        ],
        [0.0, 0.0, 0.0, 1.0, 0.0],
    ]
}

// ---- Rectangles ----

/// A primitive at one frame with its rectangles in layer space.
#[derive(Clone, Debug, PartialEq)]
pub struct PlanNode {
    pub op: FeOp,
    pub inputs: Vec<FeInput>,
    /// The primitive subregion, cut to the filter region.
    pub sub: Rect,
    pub linear: bool,
}

/// The graph with its units turned into layer units.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub region: Rect,
    pub nodes: Vec<PlanNode>,
}

impl ResolvedFilterGraph {
    pub fn needs_box(&self) -> bool {
        self.bbox.is_none()
            && (self.region_bbox || self.prim_bbox || self.region.iter().any(Option::is_none))
    }

    /// The rectangles and lengths in layer units. `layer_box` is the layer's
    /// box in layer space, if it has one; `None` is returned if a unit or a
    /// default needs it and there is none.
    pub fn plan(&self, layer_box: Option<Rect>) -> Option<Plan> {
        let layer_box = self.bbox.or(layer_box);
        let need = |b: Option<Rect>| -> Option<Rect> { b };
        let region = if self.region_bbox {
            let b = need(layer_box)?;
            let r = [
                self.region[0].unwrap_or(-0.1),
                self.region[1].unwrap_or(-0.1),
                self.region[2].unwrap_or(1.2),
                self.region[3].unwrap_or(1.2),
            ];
            let (x, y) = (b.x0 + r[0] * b.width(), b.y0 + r[1] * b.height());
            Rect::new(
                x,
                y,
                x + r[2].max(0.0) * b.width(),
                y + r[3].max(0.0) * b.height(),
            )
        } else {
            // User units; a side left out defaults to -10% / 120% of the box.
            let d = layer_box.map(|b| {
                [
                    b.x0 - 0.1 * b.width(),
                    b.y0 - 0.1 * b.height(),
                    1.2 * b.width(),
                    1.2 * b.height(),
                ]
            });
            let side = |i: usize| self.region[i].or_else(|| d.map(|d| d[i]));
            let (x, y, w, h) = (side(0)?, side(1)?, side(2)?, side(3)?);
            Rect::new(x, y, x + w.max(0.0), y + h.max(0.0))
        };
        // primitiveUnits: lengths and subregions scale by the box.
        let bbox = if self.prim_bbox {
            Some(need(layer_box)?)
        } else {
            None
        };
        let (sx, sy, sd) = bbox.map_or((1.0, 1.0, 1.0), |b| {
            (
                b.width(),
                b.height(),
                ((b.width() * b.width() + b.height() * b.height()) / 2.0).sqrt(),
            )
        });
        let mut nodes: Vec<PlanNode> = Vec::with_capacity(self.nodes.len());
        for node in &self.nodes {
            let sub_of = |input: &FeInput, nodes: &[PlanNode]| match input {
                FeInput::Node(i) => nodes[*i].sub,
                _ => region,
            };
            // The default: where the inputs are, or the whole region if one is
            // the layer itself or there is none.
            let standard = node.inputs.is_empty()
                || node.inputs.iter().any(|i| !matches!(i, FeInput::Node(_)))
                || matches!(node.op, FeOp::Tile);
            let default = if standard {
                region
            } else {
                node.inputs
                    .iter()
                    .map(|i| sub_of(i, &nodes))
                    .reduce(|a, b| a.union(b))
                    .unwrap_or(region)
            };
            let given = |i: usize| node.sub[i];
            let mut sub = default;
            let (x0, y0) = (
                given(0).map_or(default.x0, |v| bbox.map_or(v, |b| b.x0 + v * b.width())),
                given(1).map_or(default.y0, |v| bbox.map_or(v, |b| b.y0 + v * b.height())),
            );
            let w = given(2).map_or(default.width(), |v| v * sx);
            let h = given(3).map_or(default.height(), |v| v * sy);
            if node.sub.iter().any(Option::is_some) {
                sub = Rect::new(x0, y0, x0 + w.max(0.0), y0 + h.max(0.0));
                // A side left out keeps the default's edge, not its size.
                if given(0).is_none() && given(2).is_some() {
                    sub.x1 = sub.x0 + w.max(0.0);
                }
                if given(0).is_some() && given(2).is_none() {
                    sub.x1 = default.x1.max(sub.x0);
                }
                if given(1).is_none() && given(3).is_some() {
                    sub.y1 = sub.y0 + h.max(0.0);
                }
                if given(1).is_some() && given(3).is_none() {
                    sub.y1 = default.y1.max(sub.y0);
                }
            }
            let sub = sub.intersect(region);
            let sub = if sub.x1 < sub.x0 || sub.y1 < sub.y0 {
                Rect::ZERO
            } else {
                sub
            };
            let scale = |op: &FeOp| -> FeOp {
                let mut op = op.clone();
                match &mut op {
                    FeOp::GaussianBlur { std } => {
                        std[0] *= sx as f32;
                        std[1] *= sy as f32;
                    }
                    FeOp::Offset { dx, dy } => {
                        *dx *= sx as f32;
                        *dy *= sy as f32;
                    }
                    FeOp::Morphology { radius, .. } => {
                        radius[0] *= sx as f32;
                        radius[1] *= sy as f32;
                    }
                    FeOp::DisplacementMap { scale, .. } => *scale *= sd as f32,
                    FeOp::Lighting { light, .. } => {
                        if let Some(b) = bbox {
                            let place = |p: &mut [f32; 3]| {
                                p[0] = (b.x0 + f64::from(p[0]) * b.width()) as f32;
                                p[1] = (b.y0 + f64::from(p[1]) * b.height()) as f32;
                                p[2] *= sd as f32;
                            };
                            match light {
                                ResolvedLight::Distant { .. } => {}
                                ResolvedLight::Point { position } => place(position),
                                ResolvedLight::Spot {
                                    position,
                                    points_at,
                                    ..
                                } => {
                                    place(position);
                                    place(points_at);
                                }
                            }
                        }
                    }
                    _ => {}
                }
                op
            };
            nodes.push(PlanNode {
                op: scale(&node.op),
                inputs: node.inputs.clone(),
                sub,
                linear: node.linear,
            });
        }
        Some(Plan { region, nodes })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph(json: &str) -> FilterGraph {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn a_filter_is_spelled_as_svg_spells_it() {
        let g = graph(
            r##"{"type": "filterGraph", "filterUnits": "userSpaceOnUse", "x": -10, "y": -10,
                 "width": 120, "height": 120,
                 "primitives": [
                   {"primitive": "feTurbulence", "type": "fractalNoise", "baseFrequency": [0.04, 0.08],
                    "numOctaves": 4, "seed": 7, "result": "noise"},
                   {"primitive": "feDisplacementMap", "in": "SourceGraphic", "in2": "noise",
                    "scale": 10, "xChannelSelector": "R", "yChannelSelector": "G"}]}"##,
        );
        assert_eq!(g.primitives.len(), 2);
        assert!(g.validate("l", true).is_ok());
        let r = g.resolve(0.0);
        assert!(!r.region_bbox && !r.prim_bbox);
        assert_eq!(
            r.region,
            [Some(-10.0), Some(-10.0), Some(120.0), Some(120.0)]
        );
        assert_eq!(r.nodes.len(), 2);
        assert_eq!(r.nodes[1].inputs, vec![FeInput::Source, FeInput::Node(0)]);
        assert!(matches!(
            r.nodes[1].op,
            FeOp::DisplacementMap { scale, x_channel: 0, y_channel: 1 } if scale == 10.0
        ));
        assert!(matches!(
            r.nodes[0].op,
            FeOp::Turbulence { fractal: true, octaves: 4, seed: 7, stitch: false, frequency: [a, b] }
                if a == 0.04 && b == 0.08
        ));
    }

    #[test]
    fn inputs_default_to_the_previous_result() {
        let g = graph(
            r##"{"primitives": [
                   {"primitive": "feGaussianBlur", "stdDeviation": 3},
                   {"primitive": "feOffset", "dx": 4, "dy": 5, "result": "off"},
                   {"primitive": "feMerge", "nodes": ["off", "SourceGraphic", "gone"]},
                   {"primitive": "feColorMatrix", "in": "BackgroundImage", "type": "saturate", "values": [0]}]}"##,
        );
        let r = g.resolve(0.0);
        assert_eq!(r.nodes[0].inputs, vec![FeInput::Source]);
        assert_eq!(r.nodes[1].inputs, vec![FeInput::Node(0)]);
        // `gone` was never made: it reads the previous result, the offset.
        assert_eq!(
            r.nodes[2].inputs,
            vec![FeInput::Node(1), FeInput::Source, FeInput::Node(1)]
        );
        assert_eq!(r.nodes[3].inputs, vec![FeInput::Empty]);
    }

    #[test]
    fn numbers_animate() {
        let g = graph(
            r##"{"primitives": [{"primitive": "feGaussianBlur",
                 "stdDeviation": [{"frame": 0, "value": 0}, {"frame": 10, "value": 8}]}]}"##,
        );
        let at = |f| match g.resolve(f).nodes[0].op {
            FeOp::GaussianBlur { std } => std,
            _ => unreachable!(),
        };
        assert_eq!(at(5.0), [4.0, 4.0]);
        // A pair gives each axis its own.
        let g =
            graph(r##"{"primitives": [{"primitive": "feGaussianBlur", "stdDeviation": [3, 0]}]}"##);
        assert!(matches!(
            g.resolve(0.0).nodes[0].op,
            FeOp::GaussianBlur { std: [3.0, 0.0] }
        ));
    }

    #[test]
    fn a_drop_shadow_is_five_primitives() {
        let g = graph(
            r##"{"primitives": [{"primitive": "feDropShadow", "dx": 3, "dy": 4, "stdDeviation": 2,
                 "floodColor": "#ff0000", "floodOpacity": 0.5, "result": "s"},
                 {"primitive": "feOffset", "in": "s", "dx": 1}]}"##,
        );
        let r = g.resolve(0.0);
        assert_eq!(r.nodes.len(), 6);
        assert!(matches!(
            r.nodes[0].op,
            FeOp::GaussianBlur { std: [2.0, 2.0] }
        ));
        assert_eq!(r.nodes[0].inputs, vec![FeInput::SourceAlpha]);
        assert!(matches!(r.nodes[4].op, FeOp::Merge));
        assert_eq!(r.nodes[4].inputs, vec![FeInput::Node(3), FeInput::Source]);
        // `s` names the merge.
        assert_eq!(r.nodes[5].inputs, vec![FeInput::Node(4)]);
        assert!(matches!(r.nodes[2].op, FeOp::Flood { color } if color == [1.0, 0.0, 0.0, 0.5]));
    }

    #[test]
    fn the_default_region_is_ten_percent_beyond_the_box() {
        let g = graph(r##"{"primitives": [{"primitive": "feOffset", "dx": 1}]}"##);
        let r = g.resolve(0.0);
        assert!(r.needs_box());
        let plan = r.plan(Some(Rect::new(10.0, 20.0, 110.0, 70.0))).unwrap();
        assert_eq!(plan.region, Rect::new(0.0, 15.0, 120.0, 75.0));
        assert_eq!(plan.nodes[0].sub, plan.region);
        assert!(r.plan(None).is_none());
    }

    #[test]
    fn subregions_default_to_the_inputs_and_cut_to_the_region() {
        let g = graph(
            r##"{"filterUnits": "userSpaceOnUse", "x": 0, "y": 0, "width": 100, "height": 100,
                 "primitives": [
                   {"primitive": "feFlood", "x": 10, "y": 20, "width": 30, "height": 40, "result": "a"},
                   {"primitive": "feOffset", "in": "a", "dx": 5},
                   {"primitive": "feFlood", "x": 90, "width": 50, "result": "wide"},
                   {"primitive": "feTile", "in": "a"}]}"##,
        );
        let plan = g.resolve(0.0).plan(None).unwrap();
        assert_eq!(plan.nodes[0].sub, Rect::new(10.0, 20.0, 40.0, 60.0));
        // The offset has the flood as its only input: its subregion.
        assert_eq!(plan.nodes[1].sub, Rect::new(10.0, 20.0, 40.0, 60.0));
        // x and width given, y and height from the default (the region).
        assert_eq!(plan.nodes[2].sub, Rect::new(90.0, 0.0, 100.0, 100.0));
        // A tile fills the region.
        assert_eq!(plan.nodes[3].sub, Rect::new(0.0, 0.0, 100.0, 100.0));
    }

    #[test]
    fn object_bounding_box_units_scale_by_the_box() {
        let g = graph(
            r##"{"filterUnits": "objectBoundingBox", "x": 0, "y": 0, "width": 1, "height": 1,
                 "primitiveUnits": "objectBoundingBox",
                 "primitives": [{"primitive": "feOffset", "dx": 0.1, "dy": 0.5},
                                {"primitive": "feGaussianBlur", "stdDeviation": [0.1, 0.2],
                                 "x": 0.5, "width": 0.25}]}"##,
        );
        let plan = g
            .resolve(0.0)
            .plan(Some(Rect::new(0.0, 0.0, 200.0, 100.0)))
            .unwrap();
        assert_eq!(plan.region, Rect::new(0.0, 0.0, 200.0, 100.0));
        assert!(matches!(plan.nodes[0].op, FeOp::Offset { dx, dy } if dx == 20.0 && dy == 50.0));
        assert!(matches!(plan.nodes[1].op, FeOp::GaussianBlur { std } if std == [20.0, 20.0]));
        assert_eq!(plan.nodes[1].sub, Rect::new(100.0, 0.0, 150.0, 100.0));
    }

    #[test]
    fn reach_counts_what_moves_pixels() {
        let reach = |json: &str| graph(json).reach(1.0);
        // Only blurring keeps the margin at 0.
        assert_eq!(
            reach(r##"{"primitives": [{"primitive": "feGaussianBlur", "stdDeviation": 5}]}"##),
            0.0
        );
        let r = reach(
            r##"{"primitives": [{"primitive": "feTurbulence", "baseFrequency": 0.1},
                {"primitive": "feDisplacementMap", "scale": 20}]}"##,
        );
        assert_eq!(r, 10.0);
        let r = reach(
            r##"{"primitives": [{"primitive": "feOffset", "dx": 4, "dy": -9},
                {"primitive": "feGaussianBlur", "stdDeviation": [2, 1]}]}"##,
        );
        assert_eq!(r, 9.0 + 6.0);
    }

    #[test]
    fn bad_graphs_are_rejected_naming_the_layer() {
        let bad = |json: &str, has_box: bool| {
            graph(json)
                .validate("card", has_box)
                .unwrap_err()
                .to_string()
        };
        assert!(
            bad(
                r##"{"primitives": [{"primitive": "feGaussianBlur", "stdDeviation": -1}]}"##,
                true
            )
            .contains("card")
        );
        assert!(
            bad(
                r##"{"primitives": [{"primitive": "feTurbulence", "numOctaves": 11}]}"##,
                true
            )
            .contains("numOctaves")
        );
        assert!(
            bad(
                r##"{"primitives": [{"primitive": "feColorMatrix", "values": [1, 2]}]}"##,
                true
            )
            .contains("values")
        );
        assert!(
            bad(
                r##"{"primitives": [{"primitive": "feConvolveMatrix", "order": 3, "kernelMatrix": [1, 2]}]}"##,
                true
            )
            .contains("kernelMatrix")
        );
        // A group without a box needs explicit user-space numbers.
        assert!(bad(r##"{"primitives": []}"##, false).contains("group"));
        assert!(
            graph(
                r##"{"filterUnits": "userSpaceOnUse", "x": 0, "y": 0, "width": 9, "height": 9, "primitives": []}"##
            )
            .validate("g", false)
            .is_ok()
        );
    }

    #[test]
    fn colour_matrices_follow_the_spec() {
        let r = color_matrix_rows(ColorMatrixKind::LuminanceToAlpha, &[]);
        assert_eq!(r[3], [0.2125, 0.7154, 0.0721, 0.0, 0.0]);
        let id = color_matrix_rows(ColorMatrixKind::Matrix, &[1.0]);
        assert_eq!(id[0], [1.0, 0.0, 0.0, 0.0, 0.0]);
        let s0 = color_matrix_rows(ColorMatrixKind::Saturate, &[0.0]);
        assert!((s0[0][0] - 0.213).abs() < 1e-6 && (s0[0][1] - 0.715).abs() < 1e-6);
        let neg = color_matrix_rows(ColorMatrixKind::Saturate, &[-1.0]);
        assert!((neg[0][0] - (0.213 - 0.787)).abs() < 1e-6);
    }

    #[test]
    fn colour_spaces_follow_the_graph_and_the_primitive() {
        let g = graph(
            r##"{"colorInterpolationFilters": "sRGB", "primitives": [
                 {"primitive": "feOffset"},
                 {"primitive": "feOffset", "colorInterpolationFilters": "linearRGB"}]}"##,
        );
        let r = g.resolve(0.0);
        assert!(!r.nodes[0].linear && r.nodes[1].linear);
    }
}
