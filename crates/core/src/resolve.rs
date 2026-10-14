//! A scene evaluated at one frame: every animated number is a plain value.

use vello::kurbo::Affine;

use crate::color::{Color, ColorMatrix};
use crate::error::{Error, Result};
use crate::scene::{
    BlendMode, Clip, Effect, Extend, Geometry, Gradient, GradientGeometry, Layer, LayerKind,
    MAX_SHADOW_SIZE, MaskMode, MatteMode, Paint, Scene, Shadow, Stop, Transform,
};

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
    pub layers: Vec<ResolvedLayer>,
}

#[derive(Clone, Debug)]
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
}

#[derive(Clone, Copy, Debug)]
pub struct ResolvedTransform {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub rotation: f64,
    pub anchor_x: f64,
    pub anchor_y: f64,
}

impl ResolvedTransform {
    /// Layer space to parent space: move the anchor to the origin, scale,
    /// rotate, then translate to (x, y).
    pub fn matrix(&self) -> Affine {
        Affine::translate((self.x, self.y))
            * Affine::rotate(self.rotation.to_radians())
            * Affine::scale(self.scale)
            * Affine::translate((-self.anchor_x, -self.anchor_y))
    }
}

/// One variant per entry in `scene::Effect`.
#[derive(Clone, Debug)]
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
    Shader(ResolvedShader),
}

/// A gradient map at one frame.
#[derive(Clone, Debug)]
pub struct ResolvedGradientMap {
    /// `MIN_GRADIENT_MAP_STOPS..=MAX_GRADIENT_MAP_STOPS` stops, offsets in
    /// 0..=1 and never decreasing.
    pub stops: Vec<(f64, Color)>,
    /// 0..=1: how much of the graded image replaces the original.
    pub amount: f32,
}

/// A custom shader at one frame.
#[derive(Clone, Debug)]
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
#[derive(Clone, Copy, Debug)]
pub struct ResolvedGlow {
    /// Standard deviation of the blur, 0..=`MAX_BLUR_RADIUS`.
    pub radius: f32,
    /// `None`: the halo has the layer's own colours.
    pub color: Option<Color>,
    /// 0..=`MAX_GLOW_INTENSITY`.
    pub intensity: f32,
}

/// A shadow at one frame, in canvas pixels.
#[derive(Clone, Copy, Debug)]
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
#[derive(Clone, Debug)]
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

#[derive(Clone, Debug)]
pub struct ResolvedMask {
    pub gradient: ResolvedGradient,
    pub mode: MaskMode,
}

#[derive(Clone, Debug)]
pub struct ResolvedMatte {
    /// The id of a sibling layer.
    pub layer: String,
    pub mode: MatteMode,
}

/// What a shape's fill or a text's colour paints with, at one frame.
#[derive(Clone, Debug)]
pub enum ResolvedPaint {
    Solid(Color),
    Gradient(ResolvedGradient),
}

/// A gradient at one frame, in the space of whatever it paints.
#[derive(Clone, Debug)]
pub struct ResolvedGradient {
    pub geometry: ResolvedGradientGeometry,
    /// At least 2 stops, offsets in 0..=1 and never decreasing.
    pub stops: Vec<(f64, Color)>,
    pub extend: Extend,
}

#[derive(Clone, Copy, Debug)]
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
    /// `angle` in degrees clockwise from 12 o'clock.
    Conic {
        cx: f64,
        cy: f64,
        angle: f64,
    },
}

/// Largest blur radius; bigger values are clamped.
pub const MAX_BLUR_RADIUS: f64 = 128.0;

/// Largest glow intensity; bigger values are clamped.
pub const MAX_GLOW_INTENSITY: f64 = 4.0;

#[derive(Clone, Debug)]
pub enum ResolvedKind {
    Shape {
        geometry: ResolvedGeometry,
        fill: Option<ResolvedPaint>,
        stroke: Option<(Color, f64)>,
    },
    Text {
        text: String,
        font: String,
        size: f32,
        color: ResolvedPaint,
        /// Multiple of the font size.
        line_height: Option<f32>,
        max_width: Option<f32>,
    },
    Image {
        src: String,
        width: f64,
        height: f64,
    },
    Group {
        children: Vec<ResolvedLayer>,
    },
}

#[derive(Clone, Debug)]
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
    pub fn resolve(&self, frame: u32) -> Result<ResolvedScene> {
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
        Ok(ResolvedScene {
            width: self.width,
            height: self.height,
            frame,
            background: self.background,
            layers: self
                .layers
                .iter()
                .map(|l| resolve_layer(l, clock))
                .collect(),
        })
    }
}

fn resolve_layer(layer: &Layer, clock: Clock) -> ResolvedLayer {
    let f = clock.t;
    let kind = match &layer.kind {
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
        },
        LayerKind::Text(t) => ResolvedKind::Text {
            text: t.text.clone(),
            font: t.font.clone(),
            size: t.size.at(f) as f32,
            color: resolve_paint(&t.color, f),
            line_height: t.line_height.as_ref().map(|n| n.at(f) as f32),
            max_width: t.max_width.as_ref().map(|n| n.at(f) as f32),
        },
        LayerKind::Image(i) => ResolvedKind::Image {
            src: i.src.clone(),
            width: i.width.at(f),
            height: i.height.at(f),
        },
        LayerKind::Group(g) => ResolvedKind::Group {
            children: g.children.iter().map(|c| resolve_layer(c, clock)).collect(),
        },
    };
    ResolvedLayer {
        id: layer.id.clone(),
        transform: resolve_transform(&layer.transform, f),
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
    }
}

fn resolve_paint(paint: &Paint, f: f64) -> ResolvedPaint {
    match paint {
        Paint::Solid(color) => ResolvedPaint::Solid(*color),
        Paint::Gradient(g) => ResolvedPaint::Gradient(resolve_gradient(g, f)),
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
        GradientGeometry::Radial { cx, cy, r } => ResolvedGradientGeometry::Radial {
            cx: cx.at(f),
            cy: cy.at(f),
            r: r.at(f).max(0.0),
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
    }
}

/// Resolves a layer's effects, composing each run of colour filters into one
/// matrix so it takes a single pass.
fn resolve_effects(effects: &[Effect], clock: Clock) -> Vec<ResolvedEffect> {
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
            radius: radius.at(f).clamp(0.0, MAX_BLUR_RADIUS) as f32,
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
        Effect::Shader(s) => ResolvedEffect::Shader(ResolvedShader {
            source: crate::shader::compose(&s.code, &s.names()),
            values: s.uniforms.values().map(|n| n.at(f) as f32).collect(),
            frame: f as f32,
            time: (f / clock.fps) as f32,
        }),
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
            ResolvedKind::Group { children } if children.len() == 1
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
        let layer = resolve_layer(&scene.layers[0], clock);
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
        assert_eq!(resolve_layer(&scene.layers[0], whole).transform.x, 40.0);
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
}
