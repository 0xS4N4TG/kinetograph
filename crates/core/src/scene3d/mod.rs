//! The `scene3d` layer: a 3D scene (camera, lights, meshes, models, extruded
//! type) drawn by our own renderer on the compositor's wgpu device
//! (`docs/SCENE.md`, "scene3d"; the choice of renderer is in `docs/HANDOFF.md`
//! §8, "3D layer").
//!
//! This module holds what the scene file says (`Scene3dLayer`) and what it
//! comes to at one frame (`Resolved3d`: every animated value evaluated, the
//! object tree flattened to world matrices). `mesh` builds the geometry,
//! `draw` turns a resolved scene into the draw list the compositor renders
//! (`compositor/scene3d.rs`, `shaders/scene3d.wgsl`).
//!
//! Space: right-handed, +y up, the camera looks down its own -z, as glTF and
//! three.js. Rotations are degrees, Euler angles applied in XYZ order as
//! three.js does (the matrix is `T * Rx * Ry * Rz * S`).

pub mod draw;
pub mod environment;
pub mod extrude;
pub mod mesh;
pub mod model;

use std::sync::Arc;

use glam::{DMat4, DQuat, DVec3, EulerRot};
use serde::Deserialize;
use vello::kurbo::BezPath;

use crate::anim::Num;
use crate::color::Color;
use crate::error::{Error, Result};
use crate::scene::{FillRule, TextAlign};
use model::ClipRef;

/// The most lights a scene has, ambient ones included.
pub const MAX_LIGHTS: usize = 8;
/// The most directional lights that cast shadows.
pub const MAX_SHADOW_LIGHTS: usize = 4;
/// The largest side of a shadow map, in texels.
pub const MAX_SHADOW_MAP: u32 = 4096;
/// The most segments a round primitive is cut into.
pub const MAX_SEGMENTS: u32 = 256;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scene3dLayer {
    /// The box in layer pixels, animatable and not negative. The camera's
    /// aspect ratio is its width over its height.
    pub width: Num,
    pub height: Num,
    /// Samples per pixel: 1 (none) or 4.
    #[serde(default = "default_msaa")]
    pub msaa: u32,
    #[serde(default)]
    pub camera: Camera3d,
    /// At most `MAX_LIGHTS`. A scene with none is lit by nothing and draws
    /// black meshes (but for emissive and unlit ones).
    #[serde(default)]
    pub lights: Vec<Light3d>,
    /// The surroundings, as light for every lit surface and, if asked, as
    /// the picture behind the objects.
    pub environment: Option<Environment3d>,
    /// Drawn in this order when opaque; see `docs/SCENE.md` for transparency.
    #[serde(default)]
    pub objects: Vec<Object3d>,
}

fn default_msaa() -> u32 {
    4
}

/// Three animatable numbers.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Vec3N(pub [Num; 3]);

impl Vec3N {
    fn new(x: f64, y: f64, z: f64) -> Vec3N {
        Vec3N([Num::Const(x), Num::Const(y), Num::Const(z)])
    }

    fn at(&self, f: f64) -> DVec3 {
        DVec3::new(self.0[0].at(f), self.0[1].at(f), self.0[2].at(f))
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CameraKind {
    #[default]
    Perspective,
    Orthographic,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Camera3d {
    #[serde(rename = "type")]
    pub kind: CameraKind,
    /// Perspective: the vertical field of view in degrees, in (0, 180).
    pub fov: Num,
    /// Orthographic: the world height the view shows, above 0. The width
    /// follows the aspect ratio.
    pub height: Num,
    pub near: Num,
    pub far: Num,
    pub position: Vec3N,
    /// The point the camera looks at.
    pub target: Vec3N,
    /// Which way is up on screen; not animated.
    pub up: [f64; 3],
}

impl Default for Camera3d {
    fn default() -> Camera3d {
        Camera3d {
            kind: CameraKind::Perspective,
            fov: Num::Const(45.0),
            height: Num::Const(4.0),
            near: Num::Const(0.1),
            far: Num::Const(100.0),
            position: Vec3N::new(0.0, 0.0, 5.0),
            target: Vec3N::new(0.0, 0.0, 0.0),
            up: [0.0, 1.0, 0.0],
        }
    }
}

fn white() -> Color {
    Color {
        r: 255,
        g: 255,
        b: 255,
        a: 255,
    }
}

fn one() -> Num {
    Num::Const(1.0)
}

fn zero() -> Num {
    Num::Const(0.0)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Light3d {
    /// Light from everywhere, the same on every surface.
    Ambient {
        #[serde(default = "white")]
        color: Color,
        #[serde(default = "one")]
        intensity: Num,
    },
    /// Parallel light: `direction` is the way it travels. With `cast_shadow`
    /// the objects that cast shadows (`Shadowing3d`) shade the ones that
    /// receive them, through a shadow map set by `shadow`.
    #[serde(rename_all = "camelCase")]
    Directional {
        #[serde(default = "default_direction")]
        direction: Vec3N,
        #[serde(default = "white")]
        color: Color,
        #[serde(default = "one")]
        intensity: Num,
        #[serde(default)]
        cast_shadow: bool,
        #[serde(default)]
        shadow: Shadow3d,
    },
    /// Light from a point, falling off with the square of the distance.
    /// `range` above 0 fades it to nothing at that distance.
    #[serde(rename_all = "camelCase")]
    Point {
        position: Vec3N,
        #[serde(default = "white")]
        color: Color,
        #[serde(default = "one")]
        intensity: Num,
        #[serde(default = "zero")]
        range: Num,
    },
}

/// Image-based lighting: an equirectangular picture of the surroundings, read
/// as light arriving from every direction. Its centre is toward +x and its
/// top is +y, as three.js reads it. It adds to the lights: a lit surface
/// shows the picture's blurred average (diffuse) and, the smoother and more
/// metallic it is, a sharper reflection of it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment3d {
    /// A Radiance `.hdr` (linear light, any brightness), or a `.png` or
    /// `.jpg` (sRGB, no brighter than white), relative to the scene.
    pub src: String,
    /// What the lighting from the picture is multiplied by.
    #[serde(default = "one")]
    pub intensity: Num,
    /// Degrees the picture is turned about y, counter-clockwise seen from
    /// above.
    #[serde(default = "zero")]
    pub rotation: Num,
    /// Draw the picture behind the objects, which makes the layer opaque
    /// over its box.
    #[serde(default)]
    pub background: bool,
    /// What the background is multiplied by.
    #[serde(default = "one")]
    pub background_intensity: Num,
    /// 0 to 1: how blurred the background is, from the picture as it is to
    /// the average of its surroundings.
    #[serde(default = "zero")]
    pub background_blur: Num,
}

fn default_direction() -> Vec3N {
    Vec3N::new(-1.0, -1.0, -1.0)
}

/// How a directional light's shadow map is made. The map covers the objects
/// that cast shadows, so a texel is a fixed fraction of the scene's size.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Shadow3d {
    /// Texels along each side of the square map.
    pub map_size: u32,
    /// How far, in texels, a surface is moved toward the light before its
    /// depth is compared: hides the stripes a surface casts on itself.
    pub bias: f64,
    /// How far, in texels, a surface is moved along its normal, more the
    /// more it faces away from the light: the same fix on slopes.
    pub normal_bias: f64,
    /// Half the width, in texels, of the soft edge (a 3 x 3 filter).
    pub radius: f64,
}

impl Default for Shadow3d {
    fn default() -> Shadow3d {
        Shadow3d {
            map_size: 2048,
            bias: 1.0,
            normal_bias: 1.5,
            radius: 1.0,
        }
    }
}

/// Which objects cast and receive shadows. Neither by default.
#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Shadowing3d {
    pub cast_shadow: bool,
    pub receive_shadow: bool,
}

/// Placement of an object in its parent: `position`, `rotation` (degrees) and
/// `scale`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Placement3d {
    pub position: Vec3N,
    pub rotation: Vec3N,
    pub scale: Scale3d,
    /// An object that is not visible, and its children, are not drawn.
    pub visible: bool,
}

impl Default for Placement3d {
    fn default() -> Placement3d {
        Placement3d {
            position: Vec3N::new(0.0, 0.0, 0.0),
            rotation: Vec3N::new(0.0, 0.0, 0.0),
            scale: Scale3d::Uniform(one()),
            visible: true,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum Scale3d {
    Uniform(Num),
    PerAxis(Vec3N),
}

impl Placement3d {
    fn matrix(&self, f: f64) -> DMat4 {
        let scale = match &self.scale {
            Scale3d::Uniform(s) => DVec3::splat(s.at(f)),
            Scale3d::PerAxis(s) => s.at(f),
        };
        let r = self.rotation.at(f);
        let rotation = DQuat::from_euler(
            EulerRot::XYZ,
            r.x.to_radians(),
            r.y.to_radians(),
            r.z.to_radians(),
        );
        DMat4::from_scale_rotation_translation(scale, rotation, self.position.at(f))
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Object3d {
    /// A primitive.
    Mesh {
        #[serde(default)]
        id: String,
        geometry: Geometry3d,
        #[serde(default)]
        material: Material3d,
        #[serde(flatten)]
        placement: Placement3d,
        #[serde(flatten)]
        shadowing: Shadowing3d,
    },
    /// A glTF or GLB file. `material`, when given, replaces the file's own
    /// materials. With an `animation` (a clip's name or its position in the
    /// file) the model is posed by the clip at `time` seconds; the default
    /// time is the scene's own, `frame / fps`. A `looping` clip starts again
    /// at its end; one that does not holds its last pose.
    Model {
        #[serde(default)]
        id: String,
        src: String,
        material: Option<Material3d>,
        animation: Option<ClipRef>,
        time: Option<Num>,
        #[serde(rename = "loop", default = "yes")]
        looping: bool,
        #[serde(flatten)]
        placement: Placement3d,
        #[serde(flatten)]
        shadowing: Shadowing3d,
    },
    /// Text from one of the scene's fonts, extruded.
    #[serde(rename_all = "camelCase")]
    Text {
        #[serde(default)]
        id: String,
        text: String,
        font: String,
        /// The em size in world units.
        #[serde(default = "default_text_size")]
        size: f64,
        /// How far the letters extrude along z, centred on the origin.
        #[serde(default = "default_depth")]
        depth: f64,
        #[serde(default = "center")]
        align: TextAlign,
        /// A multiple of `size`.
        line_height: Option<f64>,
        #[serde(default)]
        material: Material3d,
        #[serde(flatten)]
        placement: Placement3d,
        #[serde(flatten)]
        shadowing: Shadowing3d,
    },
    /// An SVG path, extruded.
    #[serde(rename_all = "camelCase")]
    Extrude {
        #[serde(default)]
        id: String,
        /// SVG path data. Its y axis points down, as SVG's does; it comes out
        /// upright, centred on the origin.
        path: String,
        /// The longer side of the path's box, in world units.
        #[serde(default = "default_extrude_size")]
        size: f64,
        #[serde(default = "default_depth")]
        depth: f64,
        #[serde(default)]
        fill_rule: FillRule,
        #[serde(default)]
        material: Material3d,
        #[serde(flatten)]
        placement: Placement3d,
        #[serde(flatten)]
        shadowing: Shadowing3d,
    },
    /// Objects that move together.
    Group {
        #[serde(default)]
        id: String,
        #[serde(default)]
        children: Vec<Object3d>,
        #[serde(flatten)]
        placement: Placement3d,
    },
}

fn default_text_size() -> f64 {
    1.0
}

fn default_extrude_size() -> f64 {
    1.0
}

fn default_depth() -> f64 {
    0.2
}

fn center() -> TextAlign {
    TextAlign::Center
}

/// The shapes a `mesh` is made of. Sizes are not animated: animate the
/// object's `scale` instead.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Geometry3d {
    Box {
        #[serde(default = "unit")]
        width: f64,
        #[serde(default = "unit")]
        height: f64,
        #[serde(default = "unit")]
        depth: f64,
    },
    Sphere {
        #[serde(default = "half")]
        radius: f64,
        /// Segments around the equator.
        #[serde(default = "segments32")]
        segments: u32,
        /// Rings from pole to pole.
        #[serde(default = "segments16")]
        rings: u32,
    },
    /// In the xy plane, facing +z.
    Plane {
        #[serde(default = "unit")]
        width: f64,
        #[serde(default = "unit")]
        height: f64,
    },
    /// Along y. A top radius of 0 makes a cone.
    #[serde(rename_all = "camelCase")]
    Cylinder {
        #[serde(default = "half")]
        radius_top: f64,
        #[serde(default = "half")]
        radius_bottom: f64,
        #[serde(default = "unit")]
        height: f64,
        #[serde(default = "segments32")]
        segments: u32,
        #[serde(default = "yes")]
        capped: bool,
    },
    /// Around the z axis, in the xy plane.
    #[serde(rename_all = "camelCase")]
    Torus {
        /// From the centre to the middle of the tube.
        #[serde(default = "half")]
        radius: f64,
        /// The tube's radius.
        #[serde(default = "tube")]
        tube: f64,
        /// Segments around the tube.
        #[serde(default = "segments16")]
        tube_segments: u32,
        /// Segments around the ring.
        #[serde(default = "segments48")]
        ring_segments: u32,
    },
}

fn unit() -> f64 {
    1.0
}

fn half() -> f64 {
    0.5
}

fn tube() -> f64 {
    0.2
}

fn yes() -> bool {
    true
}

fn segments16() -> u32 {
    16
}

fn segments32() -> u32 {
    32
}

fn segments48() -> u32 {
    48
}

/// Metallic-roughness shading, lean: no normal, occlusion or
/// metallic-roughness maps.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Material3d {
    /// The base colour; its alpha multiplies `opacity`.
    pub color: Color,
    /// An image file the base colour is read from, multiplied by `color`.
    pub texture: Option<String>,
    pub metallic: Num,
    pub roughness: Num,
    pub emissive: Color,
    pub emissive_intensity: Num,
    /// 0 to 1. Below 1 (or a translucent colour or texture) the object is
    /// drawn after the opaque ones, farthest first, without writing depth.
    pub opacity: Num,
    /// Draws the base colour and emission only, with no lights.
    pub unlit: bool,
    /// Draws the back faces too, lit as the front.
    pub double_sided: bool,
}

impl Default for Material3d {
    fn default() -> Material3d {
        Material3d {
            color: white(),
            texture: None,
            metallic: Num::Const(0.0),
            roughness: Num::Const(0.5),
            emissive: Color::BLACK,
            emissive_intensity: Num::Const(1.0),
            opacity: Num::Const(1.0),
            unlit: false,
            double_sided: false,
        }
    }
}

// ---- resolved ----

/// A scene at one frame.
#[derive(Clone, Debug, PartialEq)]
pub struct Resolved3d {
    pub msaa: u32,
    pub camera: ResolvedCamera3d,
    pub lights: Vec<ResolvedLight3d>,
    pub environment: Option<ResolvedEnvironment3d>,
    /// Every drawable object, flattened, in document order.
    pub objects: Vec<ResolvedObject3d>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedCamera3d {
    pub orthographic: bool,
    /// Degrees (perspective) or world height (orthographic).
    pub lens: f64,
    pub near: f64,
    pub far: f64,
    pub position: DVec3,
    pub target: DVec3,
    pub up: DVec3,
}

/// A light's colour is linear light times its intensity.
#[derive(Clone, Debug, PartialEq)]
pub enum ResolvedLight3d {
    Ambient {
        color: [f64; 3],
    },
    Directional {
        /// Unit length: the way the light travels.
        direction: DVec3,
        color: [f64; 3],
        /// `None`: it casts no shadows.
        shadow: Option<Shadow3d>,
    },
    Point {
        position: DVec3,
        color: [f64; 3],
        range: f64,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedEnvironment3d {
    pub src: String,
    pub intensity: f64,
    /// Radians about y.
    pub rotation: f64,
    pub background: Option<ResolvedBackground3d>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResolvedBackground3d {
    pub intensity: f64,
    /// 0 to 1.
    pub blur: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedObject3d {
    pub id: String,
    pub world: DMat4,
    pub content: Content3d,
    /// `None`: a model's own materials.
    pub material: Option<ResolvedMaterial3d>,
    pub shadowing: Shadowing3d,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Content3d {
    Primitive(Geometry3d),
    Model {
        src: String,
        animation: Option<Playback>,
    },
    Text(TextSpec),
    Extrude(ExtrudeSpec),
}

/// A clip playing at one moment.
#[derive(Clone, Debug, PartialEq)]
pub struct Playback {
    pub clip: ClipRef,
    /// Seconds into the clip.
    pub time: f64,
    pub looping: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TextSpec {
    pub text: String,
    pub font: String,
    pub size: f64,
    pub depth: f64,
    pub align: TextAlign,
    pub line_height: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ExtrudeSpec {
    pub path: String,
    pub size: f64,
    pub depth: f64,
    pub fill_rule: FillRule,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedMaterial3d {
    /// Linear light, straight alpha (alpha is `color` alpha times `opacity`).
    pub color: [f64; 4],
    pub texture: Option<String>,
    pub metallic: f64,
    pub roughness: f64,
    /// Linear light, already times the intensity.
    pub emissive: [f64; 3],
    pub unlit: bool,
    pub double_sided: bool,
}

/// An sRGB colour as linear light and straight alpha.
pub fn linear(c: Color) -> [f64; 4] {
    let lin = |v: u8| {
        let v = f64::from(v) / 255.0;
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    };
    [lin(c.r), lin(c.g), lin(c.b), f64::from(c.a) / 255.0]
}

fn scaled(c: Color, intensity: f64) -> [f64; 3] {
    let [r, g, b, _] = linear(c);
    [r * intensity, g * intensity, b * intensity]
}

impl Material3d {
    fn resolve(&self, f: f64) -> ResolvedMaterial3d {
        let mut color = linear(self.color);
        color[3] *= self.opacity.at(f).clamp(0.0, 1.0);
        ResolvedMaterial3d {
            color,
            texture: self.texture.clone(),
            metallic: self.metallic.at(f).clamp(0.0, 1.0),
            roughness: self.roughness.at(f).clamp(0.0, 1.0),
            emissive: scaled(self.emissive, self.emissive_intensity.at(f).max(0.0)),
            unlit: self.unlit,
            double_sided: self.double_sided,
        }
    }
}

impl Scene3dLayer {
    /// Checks everything the file alone can tell: the numbers' ranges, the
    /// fonts and the path data. Files named (models, textures) are checked
    /// when the renderer reads them.
    pub fn validate(&self, layer: &str, fonts: &dyn Fn(&str) -> bool) -> Result<()> {
        let bad = |msg: String| Err(Error::Scene(format!("layer {layer:?}: scene3d {msg}")));
        for (what, side) in [("width", &self.width), ("height", &self.height)] {
            if side.min() < 0.0 {
                return bad(format!("{what} must not be negative"));
            }
        }
        if !matches!(self.msaa, 1 | 4) {
            return bad(format!("msaa must be 1 or 4, got {}", self.msaa));
        }
        if self.lights.len() > MAX_LIGHTS {
            return bad(format!(
                "has {} lights; at most {MAX_LIGHTS} are drawn",
                self.lights.len()
            ));
        }
        let mut casters = 0;
        for light in &self.lights {
            if let Light3d::Directional {
                cast_shadow: true,
                shadow,
                ..
            } = light
            {
                casters += 1;
                if !(64..=MAX_SHADOW_MAP).contains(&shadow.map_size) {
                    return bad(format!(
                        "shadow mapSize must be 64 to {MAX_SHADOW_MAP}, got {}",
                        shadow.map_size
                    ));
                }
                for (what, v) in [
                    ("bias", shadow.bias),
                    ("normalBias", shadow.normal_bias),
                    ("radius", shadow.radius),
                ] {
                    if !(v.is_finite() && v >= 0.0) {
                        return bad(format!("shadow {what} must be 0 or more, got {v}"));
                    }
                }
            }
        }
        if casters > MAX_SHADOW_LIGHTS {
            return bad(format!(
                "has {casters} lights that cast shadows; at most {MAX_SHADOW_LIGHTS} do"
            ));
        }
        let cam = &self.camera;
        if cam.near.min() <= 0.0 {
            return bad("camera near must be above 0".into());
        }
        if cam.far.min() <= cam.near.max() {
            return bad("camera far must be above near".into());
        }
        match cam.kind {
            CameraKind::Perspective if cam.fov.min() <= 0.0 || cam.fov.max() >= 180.0 => {
                return bad("camera fov must be between 0 and 180 degrees".into());
            }
            CameraKind::Orthographic if cam.height.min() <= 0.0 => {
                return bad("orthographic camera height must be above 0".into());
            }
            _ => {}
        }
        if DVec3::from(cam.up).length() < 1e-9 {
            return bad("camera up must not be (0, 0, 0)".into());
        }
        if let Some(environment) = &self.environment
            && environment.src.trim().is_empty()
        {
            return bad("environment needs a src, the path of a .hdr, .png or .jpg picture".into());
        }
        validate_objects(layer, &self.objects, fonts)
    }

    /// The scene at frame `f`, which is `seconds` into the scene (what a
    /// model's clip is at when it is given no time of its own).
    pub fn resolve(&self, layer: &str, f: f64, seconds: f64) -> Result<Resolved3d> {
        let cam = &self.camera;
        let camera = ResolvedCamera3d {
            orthographic: cam.kind == CameraKind::Orthographic,
            lens: match cam.kind {
                CameraKind::Perspective => cam.fov.at(f),
                CameraKind::Orthographic => cam.height.at(f),
            },
            near: cam.near.at(f),
            far: cam.far.at(f),
            position: cam.position.at(f),
            target: cam.target.at(f),
            up: DVec3::from(cam.up).normalize(),
        };
        let forward = camera.target - camera.position;
        if forward.length() < 1e-9 {
            return Err(Error::Scene(format!(
                "layer {layer:?}: scene3d camera position and target are the same point at frame {f}"
            )));
        }
        if forward.normalize().cross(camera.up).length() < 1e-6 {
            return Err(Error::Scene(format!(
                "layer {layer:?}: scene3d camera looks along its up vector at frame {f}; \
                 give it another up"
            )));
        }
        let lights = self
            .lights
            .iter()
            .map(|light| match light {
                Light3d::Ambient { color, intensity } => ResolvedLight3d::Ambient {
                    color: scaled(*color, intensity.at(f).max(0.0)),
                },
                Light3d::Directional {
                    direction,
                    color,
                    intensity,
                    cast_shadow,
                    shadow,
                } => ResolvedLight3d::Directional {
                    direction: direction.at(f).try_normalize().unwrap_or(DVec3::NEG_Y),
                    color: scaled(*color, intensity.at(f).max(0.0)),
                    shadow: cast_shadow.then_some(*shadow),
                },
                Light3d::Point {
                    position,
                    color,
                    intensity,
                    range,
                } => ResolvedLight3d::Point {
                    position: position.at(f),
                    color: scaled(*color, intensity.at(f).max(0.0)),
                    range: range.at(f).max(0.0),
                },
            })
            .collect();
        let environment = self.environment.as_ref().map(|e| ResolvedEnvironment3d {
            src: e.src.clone(),
            intensity: e.intensity.at(f).max(0.0),
            rotation: e.rotation.at(f).to_radians(),
            background: e.background.then(|| ResolvedBackground3d {
                intensity: e.background_intensity.at(f).max(0.0),
                blur: e.background_blur.at(f).clamp(0.0, 1.0),
            }),
        });
        let mut objects = Vec::new();
        flatten(&self.objects, DMat4::IDENTITY, f, seconds, &mut objects);
        Ok(Resolved3d {
            msaa: self.msaa,
            camera,
            lights,
            environment,
            objects,
        })
    }

    /// The files the scene names.
    pub fn sources(&self) -> Sources3d {
        let mut sources = Sources3d::default();
        sources
            .environments
            .extend(self.environment.as_ref().map(|e| e.src.clone()));
        collect_sources(&self.objects, &mut sources);
        sources
    }
}

/// The files a 3D scene names, relative to the scene.
#[derive(Debug, Default, PartialEq)]
pub struct Sources3d {
    pub models: Vec<String>,
    pub textures: Vec<String>,
    pub environments: Vec<String>,
}

fn collect_sources(objects: &[Object3d], sources: &mut Sources3d) {
    for object in objects {
        let material = match object {
            Object3d::Mesh { material, .. }
            | Object3d::Text { material, .. }
            | Object3d::Extrude { material, .. } => Some(material),
            Object3d::Model { material, .. } => material.as_ref(),
            Object3d::Group { .. } => None,
        };
        sources
            .textures
            .extend(material.and_then(|m| m.texture.clone()));
    }
    for object in objects {
        match object {
            Object3d::Model { src, .. } => sources.models.push(src.clone()),
            Object3d::Group { children, .. } => collect_sources(children, sources),
            _ => {}
        }
    }
}

fn validate_objects(layer: &str, objects: &[Object3d], fonts: &dyn Fn(&str) -> bool) -> Result<()> {
    let bad = |msg: String| Err(Error::Scene(format!("layer {layer:?}: scene3d {msg}")));
    for object in objects {
        match object {
            Object3d::Mesh { geometry, .. } => {
                if let Some(problem) = geometry_problem(geometry) {
                    return bad(format!("mesh: {problem}"));
                }
            }
            Object3d::Model { src, .. } if src.trim().is_empty() => {
                return bad("model needs a src, the path of a .gltf or .glb file".into());
            }
            Object3d::Text {
                font,
                size,
                depth,
                line_height,
                ..
            } => {
                if !fonts(font) {
                    return bad(format!(
                        "text uses font {font:?}, which is not in \"fonts\""
                    ));
                }
                if !(size.is_finite() && *size > 0.0 && depth.is_finite() && *depth > 0.0) {
                    return bad("text size and depth must be above 0".into());
                }
                if line_height.is_some_and(|l| !(l.is_finite() && l > 0.0)) {
                    return bad("text lineHeight must be above 0".into());
                }
            }
            Object3d::Extrude {
                path, size, depth, ..
            } => {
                if let Err(e) = BezPath::from_svg(path) {
                    return bad(format!("extrude path is not SVG path data: {e}"));
                }
                if !(size.is_finite() && *size > 0.0 && depth.is_finite() && *depth > 0.0) {
                    return bad("extrude size and depth must be above 0".into());
                }
            }
            Object3d::Group { children, .. } => validate_objects(layer, children, fonts)?,
            Object3d::Model { .. } => {}
        }
        let material = match object {
            Object3d::Mesh { material, .. }
            | Object3d::Text { material, .. }
            | Object3d::Extrude { material, .. } => Some(material),
            Object3d::Model { material, .. } => material.as_ref(),
            Object3d::Group { .. } => None,
        };
        if let Some(texture) = material.and_then(|m| m.texture.as_ref())
            && texture.trim().is_empty()
        {
            return bad("material texture needs a path".into());
        }
    }
    Ok(())
}

fn geometry_problem(g: &Geometry3d) -> Option<String> {
    let positive = |what: &str, v: f64| {
        (!(v.is_finite() && v > 0.0)).then(|| format!("{what} must be above 0, got {v}"))
    };
    let segments = |what: &str, v: u32, least: u32| {
        (!(least..=MAX_SEGMENTS).contains(&v))
            .then(|| format!("{what} must be {least} to {MAX_SEGMENTS}, got {v}"))
    };
    match *g {
        Geometry3d::Box {
            width,
            height,
            depth,
        } => positive("width", width)
            .or_else(|| positive("height", height))
            .or_else(|| positive("depth", depth)),
        Geometry3d::Sphere {
            radius,
            segments: s,
            rings,
        } => positive("radius", radius)
            .or_else(|| segments("segments", s, 3))
            .or_else(|| segments("rings", rings, 2)),
        Geometry3d::Plane { width, height } => {
            positive("width", width).or_else(|| positive("height", height))
        }
        Geometry3d::Cylinder {
            radius_top,
            radius_bottom,
            height,
            segments: s,
            ..
        } => {
            if !(radius_top.is_finite() && radius_top >= 0.0) {
                Some(format!("radiusTop must be 0 or more, got {radius_top}"))
            } else if !(radius_bottom.is_finite() && radius_bottom >= 0.0) {
                Some(format!(
                    "radiusBottom must be 0 or more, got {radius_bottom}"
                ))
            } else if radius_top == 0.0 && radius_bottom == 0.0 {
                Some("a cylinder needs a radius".into())
            } else {
                positive("height", height).or_else(|| segments("segments", s, 3))
            }
        }
        Geometry3d::Torus {
            radius,
            tube,
            tube_segments,
            ring_segments,
        } => positive("radius", radius)
            .or_else(|| positive("tube", tube))
            .or_else(|| segments("tubeSegments", tube_segments, 3))
            .or_else(|| segments("ringSegments", ring_segments, 3)),
    }
}

fn flatten(
    objects: &[Object3d],
    parent: DMat4,
    f: f64,
    seconds: f64,
    out: &mut Vec<ResolvedObject3d>,
) {
    for object in objects {
        let (id, placement) = match object {
            Object3d::Mesh { id, placement, .. }
            | Object3d::Model { id, placement, .. }
            | Object3d::Text { id, placement, .. }
            | Object3d::Extrude { id, placement, .. }
            | Object3d::Group { id, placement, .. } => (id, placement),
        };
        if !placement.visible {
            continue;
        }
        let world = parent * placement.matrix(f);
        let mut push =
            |content: Content3d, material: Option<ResolvedMaterial3d>, shadowing: Shadowing3d| {
                out.push(ResolvedObject3d {
                    id: id.clone(),
                    world,
                    content,
                    material,
                    shadowing,
                });
            };
        match object {
            Object3d::Mesh {
                geometry,
                material,
                shadowing,
                ..
            } => push(
                Content3d::Primitive(geometry.clone()),
                Some(material.resolve(f)),
                *shadowing,
            ),
            Object3d::Model {
                src,
                material,
                animation,
                time,
                looping,
                shadowing,
                ..
            } => push(
                Content3d::Model {
                    src: src.clone(),
                    animation: animation.as_ref().map(|clip| Playback {
                        clip: clip.clone(),
                        time: time.as_ref().map_or(seconds, |t| t.at(f)),
                        looping: *looping,
                    }),
                },
                material.as_ref().map(|m| m.resolve(f)),
                *shadowing,
            ),
            Object3d::Text {
                text,
                font,
                size,
                depth,
                align,
                line_height,
                material,
                shadowing,
                ..
            } => push(
                Content3d::Text(TextSpec {
                    text: text.clone(),
                    font: font.clone(),
                    size: *size,
                    depth: *depth,
                    align: *align,
                    line_height: *line_height,
                }),
                Some(material.resolve(f)),
                *shadowing,
            ),
            Object3d::Extrude {
                path,
                size,
                depth,
                fill_rule,
                material,
                shadowing,
                ..
            } => push(
                Content3d::Extrude(ExtrudeSpec {
                    path: path.clone(),
                    size: *size,
                    depth: *depth,
                    fill_rule: *fill_rule,
                }),
                Some(material.resolve(f)),
                *shadowing,
            ),
            Object3d::Group { children, .. } => flatten(children, world, f, seconds, out),
        }
    }
}

/// A resolved scene shared between a layer's sub-frames.
pub type SharedScene3d = Arc<Resolved3d>;

#[cfg(test)]
mod tests {
    use super::*;

    fn layer(json: &str) -> Scene3dLayer {
        serde_json::from_str(json).expect("scene3d parses")
    }

    fn has_font(_: &str) -> bool {
        true
    }

    #[test]
    fn an_empty_scene_has_the_defaults() {
        let l = layer(r#"{"width": 100, "height": 50}"#);
        l.validate("s", &has_font).unwrap();
        assert_eq!(l.msaa, 4);
        assert_eq!(l.camera.kind, CameraKind::Perspective);
        let r = l.resolve("s", 0.0, 0.0).unwrap();
        assert_eq!(r.camera.position, DVec3::new(0.0, 0.0, 5.0));
        assert_eq!(r.camera.lens, 45.0);
        assert!(r.objects.is_empty() && r.lights.is_empty());
    }

    #[test]
    fn transforms_animate_and_nest() {
        let l = layer(
            r#"{"width": 10, "height": 10, "objects": [
              {"type": "group", "position": [1, 0, 0], "scale": 2, "children": [
                {"id": "b", "type": "mesh", "geometry": {"kind": "box"},
                 "position": [[{"frame": 0, "value": 0}, {"frame": 10, "value": 4}], 0, 0]}
              ]}
            ]}"#,
        );
        let at = |f| l.resolve("s", f, f / 30.0).unwrap().objects[0].world;
        // The child is at x = 2 at frame 5, in a group at x = 1 scaled by 2.
        let p = at(5.0).transform_point3(DVec3::ZERO);
        assert!((p - DVec3::new(5.0, 0.0, 0.0)).length() < 1e-12, "{p:?}");
        let p = at(0.0).transform_point3(DVec3::ZERO);
        assert!((p - DVec3::new(1.0, 0.0, 0.0)).length() < 1e-12, "{p:?}");
    }

    #[test]
    fn rotation_is_xyz_euler_degrees() {
        let l = layer(
            r#"{"width": 10, "height": 10, "objects": [
              {"type": "mesh", "geometry": {"kind": "box"}, "rotation": [0, 90, 0]}]}"#,
        );
        let world = l.resolve("s", 0.0, 0.0).unwrap().objects[0].world;
        // +90 degrees about y takes +x to -z (right-handed).
        let p = world.transform_vector3(DVec3::X);
        assert!((p - DVec3::NEG_Z).length() < 1e-12, "{p:?}");
    }

    #[test]
    fn invisible_objects_and_their_children_are_dropped() {
        let l = layer(
            r#"{"width": 10, "height": 10, "objects": [
              {"type": "group", "visible": false, "children": [
                {"type": "mesh", "geometry": {"kind": "sphere"}}]},
              {"type": "mesh", "geometry": {"kind": "plane"}}]}"#,
        );
        assert_eq!(l.resolve("s", 0.0, 0.0).unwrap().objects.len(), 1);
    }

    #[test]
    fn lights_carry_linear_colour_times_intensity() {
        let l = layer(
            r##"{"width": 10, "height": 10, "lights": [
              {"type": "ambient", "color": "#808080", "intensity": 2},
              {"type": "directional", "direction": [0, -2, 0]},
              {"type": "point", "position": [0, 1, 0], "intensity": 10, "range": 8}]}"##,
        );
        let r = l.resolve("s", 0.0, 0.0).unwrap();
        let ResolvedLight3d::Ambient { color } = r.lights[0] else {
            panic!("not ambient");
        };
        // sRGB 0x80 is 0.2158605 in linear light.
        assert!((color[0] - 2.0 * 0.2158605).abs() < 1e-6);
        let ResolvedLight3d::Directional { direction, .. } = r.lights[1] else {
            panic!("not directional");
        };
        assert_eq!(direction, DVec3::NEG_Y);
        let ResolvedLight3d::Point { color, range, .. } = r.lights[2] else {
            panic!("not a point light");
        };
        assert_eq!((color, range), ([10.0; 3], 8.0));
    }

    #[test]
    fn shadow_settings_reach_the_resolved_scene() {
        let l = layer(
            r#"{"width": 10, "height": 10,
                "lights": [{"type": "directional", "castShadow": true, "shadow": {"mapSize": 512, "bias": 2}},
                           {"type": "directional"}],
                "objects": [{"type": "mesh", "geometry": {"kind": "box"}, "castShadow": true},
                            {"type": "mesh", "geometry": {"kind": "box"}, "receiveShadow": true},
                            {"type": "mesh", "geometry": {"kind": "box"}}]}"#,
        );
        l.validate("s", &has_font).unwrap();
        let r = l.resolve("s", 0.0, 0.0).unwrap();
        let ResolvedLight3d::Directional { shadow, .. } = &r.lights[0] else {
            panic!("not directional");
        };
        let shadow = shadow.expect("the first light casts");
        // The rest of the settings keep their defaults.
        assert_eq!((shadow.map_size, shadow.bias), (512, 2.0));
        assert_eq!(shadow.normal_bias, Shadow3d::default().normal_bias);
        let ResolvedLight3d::Directional { shadow, .. } = &r.lights[1] else {
            panic!("not directional");
        };
        assert!(shadow.is_none());
        let flags: Vec<_> = r.objects.iter().map(|o| o.shadowing).collect();
        assert_eq!(
            flags,
            [
                Shadowing3d {
                    cast_shadow: true,
                    receive_shadow: false
                },
                Shadowing3d {
                    cast_shadow: false,
                    receive_shadow: true
                },
                Shadowing3d::default()
            ]
        );
    }

    #[test]
    fn a_models_clip_is_played_at_its_time_or_the_scenes() {
        let l = layer(
            r#"{"width": 10, "height": 10, "objects": [
                {"type": "model", "src": "a.glb", "animation": "Walk",
                 "time": [{"frame": 0, "value": 0}, {"frame": 30, "value": 3}], "loop": false},
                {"type": "model", "src": "a.glb", "animation": 2},
                {"type": "model", "src": "a.glb"}]}"#,
        );
        l.validate("s", &has_font).unwrap();
        // Frame 15, which is 0.4 s into the scene.
        let r = l.resolve("s", 15.0, 0.4).unwrap();
        let playback = |i: usize| match &r.objects[i].content {
            Content3d::Model { animation, .. } => animation.clone(),
            other => panic!("{other:?}"),
        };
        assert_eq!(
            playback(0),
            Some(Playback {
                clip: ClipRef::Name("Walk".into()),
                time: 1.5,
                looping: false
            })
        );
        // Without a time the scene's own: and a clip loops unless told not to.
        assert_eq!(
            playback(1),
            Some(Playback {
                clip: ClipRef::Index(2),
                time: 0.4,
                looping: true
            })
        );
        assert_eq!(playback(2), None);
    }

    #[test]
    fn material_opacity_multiplies_the_colour_alpha() {
        let l = layer(
            r##"{"width": 10, "height": 10, "objects": [
              {"type": "mesh", "geometry": {"kind": "box"},
               "material": {"color": "#ffffff80", "opacity": 0.5, "roughness": 3, "emissive": "#ff0000",
                            "emissiveIntensity": 2}}]}"##,
        );
        let m = l.resolve("s", 0.0, 0.0).unwrap().objects[0]
            .material
            .clone()
            .unwrap();
        assert!((m.color[3] - 0.5 * 128.0 / 255.0).abs() < 1e-9);
        assert_eq!(m.roughness, 1.0, "clamped");
        assert_eq!(m.emissive, [2.0, 0.0, 0.0]);
    }

    #[test]
    fn bad_scenes_name_the_layer_and_the_problem() {
        let err = |json: &str| {
            layer(json)
                .validate("hero", &|f| f == "Sans")
                .expect_err("invalid")
                .to_string()
        };
        assert!(err(r#"{"width": 1, "height": 1, "msaa": 3}"#).contains("msaa must be 1 or 4"));
        assert!(err(r#"{"width": -1, "height": 1}"#).contains("width must not be negative"));
        assert!(err(r#"{"width": 1, "height": 1, "camera": {"fov": 180}}"#).contains("fov"));
        assert!(
            err(r#"{"width": 1, "height": 1, "camera": {"near": 5, "far": 2}}"#)
                .contains("far must be above near")
        );
        let nine = format!(
            r#"{{"width": 1, "height": 1, "lights": [{}]}}"#,
            [r#"{"type": "ambient"}"#; 9].join(",")
        );
        assert!(err(&nine).contains("9 lights"));
        assert!(
            err(r#"{"width": 1, "height": 1, "objects": [{"type": "mesh", "geometry": {"kind": "sphere", "segments": 2}}]}"#)
                .contains("segments must be 3 to 256")
        );
        assert!(
            err(r#"{"width": 1, "height": 1, "objects": [{"type": "text", "text": "A", "font": "Serif"}]}"#)
                .contains("font \"Serif\"")
        );
        assert!(
            err(
                r#"{"width": 1, "height": 1, "objects": [{"type": "extrude", "path": "M 0 0 L"}]}"#
            )
            .contains("SVG path data")
        );
    }

    #[test]
    fn a_degenerate_camera_is_an_error_at_that_frame() {
        let l = layer(
            r#"{"width": 1, "height": 1, "camera": {"position": [0, 5, 0], "target": [0, 0, 0]}}"#,
        );
        let e = l.resolve("hero", 3.0, 0.1).unwrap_err().to_string();
        assert!(e.contains("up vector"), "{e}");
        let l = layer(
            r#"{"width": 1, "height": 1, "camera": {"position": [1, 1, 1], "target": [1, 1, 1]}}"#,
        );
        assert!(
            l.resolve("hero", 0.0, 0.0)
                .unwrap_err()
                .to_string()
                .contains("same point")
        );
    }

    #[test]
    fn sources_lists_models_and_textures_through_groups() {
        let l = layer(
            r#"{"width": 1, "height": 1, "objects": [
              {"type": "group", "children": [{"type": "model", "src": "a.glb"}]},
              {"type": "mesh", "geometry": {"kind": "box"}, "material": {"texture": "t.png"}}]}"#,
        );
        assert_eq!(
            l.sources(),
            Sources3d {
                models: vec!["a.glb".into()],
                textures: vec!["t.png".into()],
                environments: vec![],
            }
        );
    }
}
