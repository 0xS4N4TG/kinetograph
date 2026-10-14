//! The JSON scene graph. See docs/SCENE.md for the format.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use vello::kurbo::BezPath;

use crate::anim::Num;
use crate::color::Color;
use crate::error::{Error, Result};

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
    /// Bottom layer first.
    pub layers: Vec<Layer>,
    /// Directory that asset paths resolve against (the scene file's directory).
    #[serde(skip)]
    pub base_dir: PathBuf,
}

fn default_background() -> Color {
    Color::BLACK
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
    #[serde(flatten)]
    pub kind: LayerKind,
}

fn one() -> Num {
    Num::Const(1.0)
}

fn zero() -> Num {
    Num::Const(0.0)
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
    fn reach(&self) -> f64 {
        match self {
            // Not counted: blur only ever spreads the layer's own pixels, and
            // leaving it out keeps scenes that use nothing else at margin 0,
            // which is exactly the canvas-sized rendering they had before.
            Effect::Blur { .. } => 0.0,
            Effect::DropShadow(shadow) | Effect::InsetShadow(shadow) => shadow.reach(),
            // Colour filters change pixels in place.
            Effect::Saturate { .. }
            | Effect::Contrast { .. }
            | Effect::Brightness { .. }
            | Effect::Grayscale { .. }
            | Effect::Sepia { .. }
            | Effect::Invert { .. }
            | Effect::HueRotate { .. } => 0.0,
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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShapeLayer {
    pub shape: Geometry,
    pub fill: Option<Color>,
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
    pub color: Color,
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
        margin_for(max_reach(&self.layers), self.width, self.height)
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
            if let Some(clip) = &layer.clip {
                validate_clip(&layer.id, clip, &layer.kind)?;
            }
            if let Some(matte) = &layer.matte {
                validate_matte(layer, matte, layers)?;
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
                    if let Some(max_width) = &t.max_width {
                        non_negative("maxWidth", max_width)?;
                    }
                }
                LayerKind::Image(i) => {
                    non_negative("width", &i.width)?;
                    non_negative("height", &i.height)?;
                }
                LayerKind::Group(g) => self.validate_layers(&g.children, ids)?,
            }
        }
        Ok(())
    }
}

/// The largest reach of any layer in `layers`. Reaches add up along a
/// chain: each effect in a list works on what the ones before it painted,
/// and a group's effects on what its children painted.
fn max_reach(layers: &[Layer]) -> f64 {
    layers.iter().fold(0.0, |most, layer| {
        let children = match &layer.kind {
            LayerKind::Group(g) => max_reach(&g.children),
            _ => 0.0,
        };
        let own: f64 = layer.effects.iter().map(Effect::reach).sum();
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
}
