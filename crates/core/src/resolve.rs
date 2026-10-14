//! A scene evaluated at one frame: every animated number is a plain value.

use vello::kurbo::Affine;

use crate::color::Color;
use crate::error::{Error, Result};
use crate::scene::{BlendMode, Effect, Geometry, Layer, LayerKind, Scene, Transform};

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
pub enum ResolvedEffect {}

#[derive(Clone, Debug)]
pub enum ResolvedKind {
    Shape {
        geometry: ResolvedGeometry,
        fill: Option<Color>,
        stroke: Option<(Color, f64)>,
    },
    Text {
        text: String,
        font: String,
        size: f32,
        color: Color,
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
        let f = f64::from(frame);
        Ok(ResolvedScene {
            width: self.width,
            height: self.height,
            frame,
            background: self.background,
            layers: self.layers.iter().map(|l| resolve_layer(l, f)).collect(),
        })
    }
}

fn resolve_layer(layer: &Layer, f: f64) -> ResolvedLayer {
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
            fill: s.fill,
            stroke: s.stroke.as_ref().map(|st| (st.color, st.width.at(f))),
        },
        LayerKind::Text(t) => ResolvedKind::Text {
            text: t.text.clone(),
            font: t.font.clone(),
            size: t.size.at(f) as f32,
            color: t.color,
            line_height: t.line_height.as_ref().map(|n| n.at(f) as f32),
            max_width: t.max_width.as_ref().map(|n| n.at(f) as f32),
        },
        LayerKind::Image(i) => ResolvedKind::Image {
            src: i.src.clone(),
            width: i.width.at(f),
            height: i.height.at(f),
        },
        LayerKind::Group(g) => ResolvedKind::Group {
            children: g.children.iter().map(|c| resolve_layer(c, f)).collect(),
        },
    };
    ResolvedLayer {
        id: layer.id.clone(),
        transform: resolve_transform(&layer.transform, f),
        opacity: layer.opacity.at(f).clamp(0.0, 1.0) as f32,
        blend_mode: layer.blend_mode,
        effects: layer.effects.iter().map(resolve_effect).collect(),
        kind,
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

fn resolve_effect(effect: &Effect) -> ResolvedEffect {
    match *effect {}
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
}
