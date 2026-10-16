//! From a resolved scene to the draw list the compositor renders: the camera
//! matrix, the lights, and one item per mesh with its world matrix and
//! material, opaque ones in document order and translucent ones after them,
//! farthest first.
//!
//! The meshes of text and extruded paths are built on the CPU here, from the
//! scene's fonts, and kept by their spec; glTF models and textures are read
//! when the renderer reads the scene's other files and held by `src`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use glam::{DMat4, DVec3, DVec4, Mat3, Mat4, Vec3};

use super::environment::Environment;
use super::mesh::{MeshData, primitive};
use super::model::Model;
use super::{
    Content3d, MAX_LIGHTS, Resolved3d, ResolvedCamera3d, ResolvedLight3d, ResolvedMaterial3d,
    Shadow3d,
};
use crate::error::{Error, Result};
use crate::text::TextEngine;

/// An image file as a texture: straight-alpha sRGB, 8 bits a channel.
#[derive(Debug)]
pub struct Texture {
    /// What the compositor keys its GPU copy by (`MeshData::id`).
    pub id: u64,
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    /// Whether any texel is not opaque.
    pub translucent: bool,
}

impl Texture {
    pub fn new(width: u32, height: u32, rgba: Vec<u8>) -> Texture {
        assert_eq!(rgba.len(), (width * height * 4) as usize);
        Texture {
            id: super::mesh::next_id(),
            width,
            height,
            translucent: rgba.chunks(4).any(|p| p[3] != 255),
            rgba,
        }
    }

    pub fn open(base_dir: &Path, src: &str) -> Result<Texture> {
        let path = base_dir.join(src);
        let image = image::open(&path)
            .map_err(|e| Error::Render(format!("cannot read texture {}: {e}", path.display())))?
            .to_rgba8();
        Ok(Texture::new(
            image.width(),
            image.height(),
            image.into_raw(),
        ))
    }

    /// The mip chain, level 0 first, each level the box-filtered average of
    /// 2x2 texels of the one before, averaged in linear light.
    pub fn mips(&self) -> Vec<(u32, u32, Vec<u8>)> {
        let to_linear = |v: u8| {
            let v = f32::from(v) / 255.0;
            if v <= 0.04045 {
                v / 12.92
            } else {
                ((v + 0.055) / 1.055).powf(2.4)
            }
        };
        let to_srgb = |v: f32| {
            let v = if v <= 0.003_130_8 {
                v * 12.92
            } else {
                1.055 * v.powf(1.0 / 2.4) - 0.055
            };
            (v * 255.0).round().clamp(0.0, 255.0) as u8
        };
        let mut levels = vec![(self.width, self.height, self.rgba.clone())];
        while let Some((w, h, data)) = levels.last() {
            if *w == 1 && *h == 1 {
                break;
            }
            let (nw, nh) = ((w / 2).max(1), (h / 2).max(1));
            let mut next = Vec::with_capacity((nw * nh * 4) as usize);
            for y in 0..nh {
                for x in 0..nw {
                    let mut sum = [0.0_f32; 4];
                    let mut count = 0.0;
                    for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                        let (sx, sy) = ((2 * x + dx).min(w - 1), (2 * y + dy).min(h - 1));
                        let i = ((sy * w + sx) * 4) as usize;
                        for c in 0..3 {
                            sum[c] += to_linear(data[i + c]);
                        }
                        sum[3] += f32::from(data[i + 3]) / 255.0;
                        count += 1.0;
                    }
                    next.extend([
                        to_srgb(sum[0] / count),
                        to_srgb(sum[1] / count),
                        to_srgb(sum[2] / count),
                        (sum[3] / count * 255.0).round() as u8,
                    ]);
                }
            }
            levels.push((nw, nh, next));
        }
        levels
    }
}

/// A material as the shader reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct Material {
    /// Linear light, straight alpha.
    pub color: [f32; 4],
    pub emissive: [f32; 3],
    pub metallic: f32,
    pub roughness: f32,
    pub unlit: bool,
    pub double_sided: bool,
}

impl From<&ResolvedMaterial3d> for Material {
    fn from(m: &ResolvedMaterial3d) -> Material {
        Material {
            color: m.color.map(|c| c as f32),
            emissive: m.emissive.map(|c| c as f32),
            metallic: m.metallic as f32,
            roughness: m.roughness as f32,
            unlit: m.unlit,
            double_sided: m.double_sided,
        }
    }
}

pub struct DrawItem {
    pub mesh: Arc<MeshData>,
    pub model: Mat4,
    /// The model matrix mirrors (a negative scale), which turns the faces
    /// inside out as seen on screen.
    pub mirrored: bool,
    /// The inverse transpose of the model matrix's 3x3 part.
    pub normal: Mat3,
    pub material: Material,
    pub texture: Option<Arc<Texture>>,
    pub cast_shadow: bool,
    pub receive_shadow: bool,
}

impl DrawItem {
    fn translucent(&self) -> bool {
        self.material.color[3] < 1.0 || self.texture.as_ref().is_some_and(|t| t.translucent)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Light {
    /// A direction (toward the light) or a position.
    pub vector: [f32; 3],
    pub point: bool,
    pub color: [f32; 3],
    pub range: f32,
    /// A directional light's shadow map; `None` when it casts none, or when
    /// no object does.
    pub shadow: Option<Shadow>,
}

/// A directional light's shadow map: an orthographic view along the light
/// that fits the objects that cast shadows.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shadow {
    /// World space to the map's clip space: x and y in -1..1, depth in 0..1.
    pub view_proj: Mat4,
    /// Texels along each side.
    pub map_size: u32,
    /// In depth units: subtracted from a surface's depth before the compare.
    pub bias: f32,
    /// In world units: how far a surface is moved along its normal (times
    /// the sine of its angle to the light) before the lookup.
    pub normal_bias: f32,
    /// Half the filter's width, in texels.
    pub radius: f32,
}

impl Shadow {
    /// The map of a light travelling along `forward`, fitted to the world
    /// space `corners` of the casters' boxes (`None` when there are none).
    fn fit(forward: DVec3, config: &Shadow3d, corners: &[DVec3]) -> Option<Shadow> {
        let extent = |points: Vec<DVec3>| {
            let first = *points.first()?;
            Some(
                points
                    .iter()
                    .fold((first, first), |(lo, hi), p| (lo.min(*p), hi.max(*p))),
            )
        };
        let (lo, hi) = extent(corners.to_vec())?;
        let up = if forward.y.abs() < 0.99 {
            DVec3::Y
        } else {
            DVec3::Z
        };
        let view = look((lo + hi) / 2.0, forward, up);
        let (lo, hi) = extent(corners.iter().map(|p| view.transform_point3(*p)).collect())?;
        // A square map, with a margin of the filter's reach plus two texels
        // so that the filter never reads past the casters.
        let map = f64::from(config.map_size);
        let margin = config.radius.ceil() + 2.0;
        let half = ((hi.x - lo.x).max(hi.y - lo.y) / 2.0).max(1e-6) * map / (map - 2.0 * margin);
        let (cx, cy) = ((lo.x + hi.x) / 2.0, (lo.y + hi.y) / 2.0);
        let texel = 2.0 * half / map;
        // View space looks down -z: depth is -z. The pad keeps the casters
        // inside the depth range after the biases.
        let pad = (config.bias + config.normal_bias + 2.0) * texel;
        let (near, far) = (-hi.z - pad, -lo.z + pad);
        // Centre the view on the casters' box, then project.
        let centred = DMat4::from_translation(DVec3::new(-cx, -cy, 0.0)) * view;
        Some(Shadow {
            view_proj: (orthographic(half, half, near, far) * centred).as_mat4(),
            map_size: config.map_size,
            bias: (config.bias * texel / (far - near)) as f32,
            normal_bias: (config.normal_bias * texel) as f32,
            radius: config.radius as f32,
        })
    }
}

pub struct DrawScene {
    /// The layer's box, in layer pixels.
    pub size: (f64, f64),
    pub msaa: u32,
    /// World to clip space.
    pub view_proj: Mat4,
    pub eye: Vec3,
    pub ambient: [f32; 3],
    /// Directional and point lights, at most `MAX_LIGHTS`.
    pub lights: Vec<Light>,
    /// Opaque items, then translucent ones farthest first; the first
    /// `opaque` are the opaque ones.
    pub items: Vec<DrawItem>,
    pub opaque: usize,
    pub environment: Option<EnvironmentDraw>,
}

/// The environment map as the pass reads it.
pub struct EnvironmentDraw {
    pub map: Arc<Environment>,
    /// What the lighting from the map is multiplied by.
    pub intensity: f32,
    /// World directions to the map's: the picture's turn, undone.
    pub rotation: Mat3,
    /// Drawn behind the objects when there is one.
    pub background: Option<Background>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Background {
    pub intensity: f32,
    /// 0 to 1.
    pub blur: f32,
}

impl DrawScene {
    /// The shadow maps of the lights, with their slots: the n-th light that
    /// has a map gets slot n.
    pub fn shadows(&self) -> impl Iterator<Item = (usize, &Shadow)> {
        self.lights
            .iter()
            .filter_map(|l| l.shadow.as_ref())
            .enumerate()
    }
}

/// The view matrix of an eye at `eye` looking along the unit vector
/// `forward`, with `up` pointing up on screen.
fn look(eye: DVec3, forward: DVec3, up: DVec3) -> DMat4 {
    let side = forward.cross(up).normalize();
    let up = side.cross(forward);
    DMat4::from_cols(
        DVec4::new(side.x, up.x, -forward.x, 0.0),
        DVec4::new(side.y, up.y, -forward.y, 0.0),
        DVec4::new(side.z, up.z, -forward.z, 0.0),
        DVec4::new(-side.dot(eye), -up.dot(eye), forward.dot(eye), 1.0),
    )
}

/// The orthographic projection of a view `half_width` and `half_height`
/// around the axis, with depth 0 at `near` and 1 at `far`.
fn orthographic(half_width: f64, half_height: f64, near: f64, far: f64) -> DMat4 {
    let depth = near - far;
    DMat4::from_cols(
        DVec4::new(1.0 / half_width, 0.0, 0.0, 0.0),
        DVec4::new(0.0, 1.0 / half_height, 0.0, 0.0),
        DVec4::new(0.0, 0.0, 1.0 / depth, 0.0),
        DVec4::new(0.0, 0.0, near / depth, 1.0),
    )
}

/// The camera as a view matrix and a projection matrix for a layer box of
/// aspect `aspect`. Clip space is wgpu's: x and y in -w..w, y up, z in 0..w.
pub fn view_projection(c: &ResolvedCamera3d, aspect: f64) -> (DMat4, DMat4) {
    let view = look(c.position, (c.target - c.position).normalize(), c.up);
    let depth = c.near - c.far;
    let projection = if c.orthographic {
        orthographic(c.lens / 2.0 * aspect, c.lens / 2.0, c.near, c.far)
    } else {
        let f = 1.0 / (c.lens.to_radians() / 2.0).tan();
        DMat4::from_cols(
            DVec4::new(f / aspect, 0.0, 0.0, 0.0),
            DVec4::new(0.0, f, 0.0, 0.0),
            DVec4::new(0.0, 0.0, c.far / depth, -1.0),
            DVec4::new(0.0, 0.0, c.near * c.far / depth, 0.0),
        )
    };
    (view, projection)
}

/// What the renderer holds for 3D layers besides what the compositor does.
#[derive(Default)]
pub struct Assets3d {
    models: HashMap<String, Arc<Model>>,
    textures: HashMap<String, Arc<Texture>>,
    environments: HashMap<String, Arc<Environment>>,
    /// The meshes of primitives, text and paths, by the spec's `Debug` text.
    meshes: HashMap<String, Arc<MeshData>>,
}

impl Assets3d {
    pub fn insert_model(&mut self, src: String, model: Model) {
        self.models.insert(src, Arc::new(model));
    }

    pub fn insert_texture(&mut self, src: String, texture: Texture) {
        self.textures.insert(src, Arc::new(texture));
    }

    pub fn insert_environment(&mut self, src: String, environment: Environment) {
        self.environments.insert(src, Arc::new(environment));
    }

    pub fn is_empty(&self) -> bool {
        self.models.is_empty() && self.textures.is_empty() && self.environments.is_empty()
    }

    /// Forgets the meshes built from fonts: they are out of date when a
    /// font changes.
    pub fn forget_text(&mut self) {
        self.meshes
            .retain(|key, _| !key.starts_with("Text(") && !key.starts_with("Extrude("));
    }

    fn mesh(&mut self, content: &Content3d, text: &mut TextEngine) -> Result<Arc<MeshData>> {
        let key = format!("{content:?}");
        if let Some(mesh) = self.meshes.get(&key) {
            return Ok(mesh.clone());
        }
        let mesh = match content {
            Content3d::Primitive(g) => primitive(g),
            Content3d::Text(spec) => super::extrude::text(spec, text)?,
            Content3d::Extrude(spec) => super::extrude::path(spec)?,
            Content3d::Model { .. } => unreachable!("models are not built from a spec"),
        };
        let mesh = Arc::new(mesh);
        self.meshes.insert(key, mesh.clone());
        Ok(mesh)
    }

    fn texture(&self, layer: &str, src: &str) -> Result<Arc<Texture>> {
        self.textures.get(src).cloned().ok_or_else(|| {
            Error::Render(format!("layer {layer:?}: texture {src:?} was not loaded"))
        })
    }

    /// The draw list of `scene` for a layer box of `size`.
    pub fn draw_scene(
        &mut self,
        layer: &str,
        scene: &Resolved3d,
        size: (f64, f64),
        text: &mut TextEngine,
    ) -> Result<DrawScene> {
        let (view, projection) = view_projection(&scene.camera, size.0 / size.1);
        let mut ambient = [0.0_f32; 3];
        let mut lights = Vec::new();
        // The lights that cast shadows: their index in `lights`, the way
        // they travel and their settings.
        let mut shadow_lights = Vec::new();
        for light in &scene.lights {
            match light {
                ResolvedLight3d::Ambient { color } => {
                    for (sum, c) in ambient.iter_mut().zip(color) {
                        *sum += *c as f32;
                    }
                }
                ResolvedLight3d::Directional {
                    direction,
                    color,
                    shadow,
                } => {
                    if let Some(config) = shadow {
                        shadow_lights.push((lights.len(), *direction, *config));
                    }
                    lights.push(Light {
                        vector: (-*direction).as_vec3().to_array(),
                        point: false,
                        color: color.map(|c| c as f32),
                        range: 0.0,
                        shadow: None,
                    });
                }
                ResolvedLight3d::Point {
                    position,
                    color,
                    range,
                } => lights.push(Light {
                    vector: position.as_vec3().to_array(),
                    point: true,
                    color: color.map(|c| c as f32),
                    range: *range as f32,
                    shadow: None,
                }),
            }
        }
        lights.truncate(MAX_LIGHTS);

        // (item, view-space depth of the middle of its mesh)
        let mut opaque = Vec::new();
        let mut translucent = Vec::new();
        // The corners, in world space, of the boxes of what casts shadows.
        let mut casters = Vec::new();
        for object in &scene.objects {
            let mut add = |mesh: Arc<MeshData>,
                           local: &DMat4,
                           material: Material,
                           texture: Option<Arc<Texture>>| {
                let world = object.world * *local;
                let model = world.as_mat4();
                let linear = Mat3::from_mat4(model);
                // A flattened object has no normals to speak of.
                if linear.determinant().abs() < 1e-12 {
                    return;
                }
                let bounds = mesh.bounds();
                let centre = bounds.map_or(Vec3::ZERO, |(lo, hi)| (lo + hi) / 2.0);
                let depth = (view * world).transform_point3(centre.as_dvec3()).z;
                if let (true, Some((lo, hi))) = (object.shadowing.cast_shadow, bounds) {
                    casters.extend((0..8).map(|i| {
                        let pick =
                            |bit, a: f32, b: f32| f64::from(if i & bit == 0 { a } else { b });
                        world.transform_point3(DVec3::new(
                            pick(1, lo.x, hi.x),
                            pick(2, lo.y, hi.y),
                            pick(4, lo.z, hi.z),
                        ))
                    }));
                }
                let item = DrawItem {
                    mesh,
                    model,
                    mirrored: linear.determinant() < 0.0,
                    normal: linear.inverse().transpose(),
                    material,
                    texture,
                    cast_shadow: object.shadowing.cast_shadow,
                    receive_shadow: object.shadowing.receive_shadow,
                };
                if item.translucent() {
                    translucent.push((item, depth));
                } else {
                    opaque.push((item, depth));
                }
            };
            let own = object.material.as_ref();
            let own_texture = own
                .and_then(|m| m.texture.as_deref())
                .map(|src| self.texture(layer, src))
                .transpose()?;
            match &object.content {
                Content3d::Model { src, animation } => {
                    let model = self.models.get(src).cloned().ok_or_else(|| {
                        Error::Render(format!("layer {layer:?}: model {src:?} was not loaded"))
                    })?;
                    let at = animation
                        .as_ref()
                        .map(|a| model.playback(&a.clip, a.time, a.looping))
                        .transpose()
                        .map_err(|msg| {
                            Error::Render(format!("layer {layer:?}: model {src:?} {msg}"))
                        })?;
                    let pose = model.pose(at);
                    for placed in model.placed(&pose, at.is_none()) {
                        let part = placed.part;
                        match own {
                            Some(m) => {
                                add(placed.mesh, &placed.local, m.into(), own_texture.clone())
                            }
                            None => add(
                                placed.mesh,
                                &placed.local,
                                part.material.clone(),
                                part.texture.clone(),
                            ),
                        }
                    }
                }
                content => {
                    let mesh = self.mesh(content, text)?;
                    let material = own
                        .map(Material::from)
                        .unwrap_or_else(|| unreachable!("every object but a model has a material"));
                    add(mesh, &DMat4::IDENTITY, material, own_texture);
                }
            }
        }
        for (index, direction, config) in shadow_lights {
            if let Some(light) = lights.get_mut(index) {
                light.shadow = Shadow::fit(direction, &config, &casters);
            }
        }
        // Farthest first: the most negative view-space z.
        translucent.sort_by(|a, b| a.1.total_cmp(&b.1));
        let opaque_count = opaque.len();
        let items = opaque
            .into_iter()
            .chain(translucent)
            .map(|(item, _)| item)
            .collect();
        let environment = scene
            .environment
            .as_ref()
            .map(|e| {
                let map = self.environments.get(&e.src).cloned().ok_or_else(|| {
                    Error::Render(format!(
                        "layer {layer:?}: environment {:?} was not loaded",
                        e.src
                    ))
                })?;
                Ok(EnvironmentDraw {
                    map,
                    intensity: e.intensity as f32,
                    rotation: Mat3::from_rotation_y(-e.rotation as f32),
                    background: e.background.map(|b| Background {
                        intensity: b.intensity as f32,
                        blur: b.blur as f32,
                    }),
                })
            })
            .transpose()?;
        Ok(DrawScene {
            size,
            msaa: scene.msaa,
            view_proj: (projection * view).as_mat4(),
            eye: scene.camera.position.as_vec3(),
            ambient,
            lights,
            items,
            opaque: opaque_count,
            environment,
        })
    }
}

#[cfg(test)]
mod tests {
    use glam::DVec3;

    use super::*;

    fn camera(orthographic: bool) -> ResolvedCamera3d {
        ResolvedCamera3d {
            orthographic,
            lens: if orthographic { 4.0 } else { 90.0 },
            near: 1.0,
            far: 11.0,
            position: DVec3::new(0.0, 0.0, 5.0),
            target: DVec3::ZERO,
            up: DVec3::Y,
        }
    }

    fn ndc(c: &ResolvedCamera3d, aspect: f64, p: DVec3) -> DVec3 {
        let (v, pr) = view_projection(c, aspect);
        let clip = pr * v * p.extend(1.0);
        clip.truncate() / clip.w
    }

    #[test]
    fn a_perspective_camera_maps_the_frustum_to_wgpu_clip_space() {
        let c = camera(false);
        // 90 degrees: at distance 5 the view is 5 high each way from the axis.
        let top = ndc(&c, 1.0, DVec3::new(0.0, 5.0, 0.0));
        assert!(
            (top - DVec3::new(0.0, 1.0, top.z)).length() < 1e-12,
            "{top:?}"
        );
        let right = ndc(&c, 2.0, DVec3::new(5.0, 0.0, 0.0));
        assert!(
            (right.x - 0.5).abs() < 1e-12,
            "wider boxes see more sideways"
        );
        // Depth is 0 on the near plane and 1 on the far plane.
        assert!(ndc(&c, 1.0, DVec3::new(0.0, 0.0, 4.0)).z.abs() < 1e-12);
        assert!((ndc(&c, 1.0, DVec3::new(0.0, 0.0, -6.0)).z - 1.0).abs() < 1e-12);
        // Things to the camera's right are on the right, whatever the up.
        assert!(ndc(&c, 1.0, DVec3::new(1.0, 0.0, 0.0)).x > 0.0);
    }

    #[test]
    fn an_orthographic_camera_does_not_shrink_with_distance() {
        let c = camera(true);
        let near = ndc(&c, 1.0, DVec3::new(1.0, 1.0, 3.0));
        let far = ndc(&c, 1.0, DVec3::new(1.0, 1.0, -3.0));
        assert!((near.x - 0.5).abs() < 1e-12 && (near.y - 0.5).abs() < 1e-12);
        assert!((far.x - 0.5).abs() < 1e-12 && (far.y - 0.5).abs() < 1e-12);
        assert!(near.z < far.z);
        assert!(ndc(&c, 1.0, DVec3::new(0.0, 0.0, 4.0)).z.abs() < 1e-12);
        assert!((ndc(&c, 1.0, DVec3::new(0.0, 0.0, -6.0)).z - 1.0).abs() < 1e-12);
    }

    #[test]
    fn mips_halve_down_to_one_texel_and_average_in_linear_light() {
        // A 2x2 of black and white averages to sRGB 188 (linear 0.5), not 128.
        let t = Texture::new(
            2,
            2,
            vec![
                0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255,
            ],
        );
        let mips = t.mips();
        assert_eq!(mips.len(), 2);
        assert_eq!((mips[1].0, mips[1].1), (1, 1));
        assert!(
            (i32::from(mips[1].2[0]) - 188).abs() <= 1,
            "{:?}",
            mips[1].2
        );
        assert_eq!(mips[1].2[3], 255);
        let wide = Texture::new(4, 1, vec![255; 16]);
        let sizes: Vec<_> = wide.mips().iter().map(|m| (m.0, m.1)).collect();
        assert_eq!(sizes, [(4, 1), (2, 1), (1, 1)]);
    }

    #[test]
    fn translucent_textures_are_noticed() {
        assert!(!Texture::new(1, 1, vec![1, 2, 3, 255]).translucent);
        assert!(Texture::new(1, 1, vec![1, 2, 3, 254]).translucent);
    }

    /// The corners of the box `lo` to `hi`.
    fn corners(lo: DVec3, hi: DVec3) -> Vec<DVec3> {
        (0..8)
            .map(|i| {
                let pick = |bit, a: f64, b: f64| if i & bit == 0 { a } else { b };
                DVec3::new(
                    pick(1, lo.x, hi.x),
                    pick(2, lo.y, hi.y),
                    pick(4, lo.z, hi.z),
                )
            })
            .collect()
    }

    #[test]
    fn a_shadow_map_fits_the_casters_with_a_margin() {
        let casters = corners(DVec3::new(-1.0, 0.0, -1.0), DVec3::new(1.0, 2.0, 1.0));
        let config = Shadow3d::default();
        let forward = DVec3::new(1.0, -1.0, 0.0).normalize();
        let shadow = Shadow::fit(forward, &config, &casters).unwrap();
        let (mut lo, mut hi) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
        for p in &casters {
            let clip = shadow.view_proj.project_point3(p.as_vec3());
            lo = lo.min(clip);
            hi = hi.max(clip);
        }
        // Inside the map on x and y, with the room the filter's margin
        // asks for (3 texels of 2048: more than 0.2% a side), and inside
        // the depth range.
        assert!(
            lo.x > -1.0 && lo.y > -1.0 && hi.x < 1.0 && hi.y < 1.0,
            "{lo} {hi}"
        );
        assert!(
            lo.min_element() < -0.99 || hi.max_element() > 0.99,
            "{lo} {hi}"
        );
        assert!(lo.z > 0.0 && hi.z < 1.0, "{lo} {hi}");
        // A point on the light's side of a caster has a smaller depth.
        let toward_light = |p: DVec3| shadow.view_proj.project_point3(p.as_vec3()).z;
        let at = DVec3::new(0.0, 1.0, 0.0);
        assert!(toward_light(at - forward) < toward_light(at));
        assert!(Shadow::fit(forward, &config, &[]).is_none());
    }

    #[test]
    fn a_light_straight_down_gets_a_map_too() {
        let casters = corners(DVec3::splat(-1.0), DVec3::splat(1.0));
        let shadow = Shadow::fit(DVec3::NEG_Y, &Shadow3d::default(), &casters).unwrap();
        let clip = shadow.view_proj.project_point3(Vec3::ZERO);
        assert!(clip.x.abs() < 1e-6 && clip.y.abs() < 1e-6, "{clip}");
    }

    #[test]
    fn biases_are_in_texels_of_the_fitted_map() {
        let small = corners(DVec3::splat(-1.0), DVec3::splat(1.0));
        let big = corners(DVec3::splat(-10.0), DVec3::splat(10.0));
        let config = Shadow3d::default();
        let a = Shadow::fit(DVec3::NEG_Y, &config, &small).unwrap();
        let b = Shadow::fit(DVec3::NEG_Y, &config, &big).unwrap();
        // Ten times the scene, ten times the world size of a texel.
        assert!((b.normal_bias / a.normal_bias - 10.0).abs() < 1e-3);
        assert!(
            (b.bias - a.bias).abs() < 1e-6,
            "depth is a fraction of the range"
        );
    }
}
