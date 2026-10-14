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
    #[serde(flatten)]
    pub kind: LayerKind,
}

fn one() -> Num {
    Num::Const(1.0)
}

fn zero() -> Num {
    Num::Const(0.0)
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
}
