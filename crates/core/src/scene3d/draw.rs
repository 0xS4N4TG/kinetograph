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

use glam::{DMat4, DVec4, Mat3, Mat4, Vec3};

use super::mesh::{MeshData, primitive};
use super::model::Model;
use super::{
    Content3d, MAX_LIGHTS, Resolved3d, ResolvedCamera3d, ResolvedLight3d, ResolvedMaterial3d,
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
}

/// The camera as a view matrix and a projection matrix for a layer box of
/// aspect `aspect`. Clip space is wgpu's: x and y in -w..w, y up, z in 0..w.
pub fn view_projection(c: &ResolvedCamera3d, aspect: f64) -> (DMat4, DMat4) {
    let forward = (c.target - c.position).normalize();
    let side = forward.cross(c.up).normalize();
    let up = side.cross(forward);
    let view = DMat4::from_cols(
        DVec4::new(side.x, up.x, -forward.x, 0.0),
        DVec4::new(side.y, up.y, -forward.y, 0.0),
        DVec4::new(side.z, up.z, -forward.z, 0.0),
        DVec4::new(
            -side.dot(c.position),
            -up.dot(c.position),
            forward.dot(c.position),
            1.0,
        ),
    );
    let depth = c.near - c.far;
    let projection = if c.orthographic {
        let (h, w) = (c.lens / 2.0, c.lens / 2.0 * aspect);
        DMat4::from_cols(
            DVec4::new(1.0 / w, 0.0, 0.0, 0.0),
            DVec4::new(0.0, 1.0 / h, 0.0, 0.0),
            DVec4::new(0.0, 0.0, 1.0 / depth, 0.0),
            DVec4::new(0.0, 0.0, c.near / depth, 1.0),
        )
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

    pub fn is_empty(&self) -> bool {
        self.models.is_empty() && self.textures.is_empty()
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
        for light in &scene.lights {
            match light {
                ResolvedLight3d::Ambient { color } => {
                    for (sum, c) in ambient.iter_mut().zip(color) {
                        *sum += *c as f32;
                    }
                }
                ResolvedLight3d::Directional { direction, color } => lights.push(Light {
                    vector: (-*direction).as_vec3().to_array(),
                    point: false,
                    color: color.map(|c| c as f32),
                    range: 0.0,
                }),
                ResolvedLight3d::Point {
                    position,
                    color,
                    range,
                } => lights.push(Light {
                    vector: position.as_vec3().to_array(),
                    point: true,
                    color: color.map(|c| c as f32),
                    range: *range as f32,
                }),
            }
        }
        lights.truncate(MAX_LIGHTS);

        // (item, view-space depth of the middle of its mesh)
        let mut opaque = Vec::new();
        let mut translucent = Vec::new();
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
                let depth = (view * world).transform_point3(mesh.centre().as_dvec3()).z;
                let item = DrawItem {
                    mesh,
                    model,
                    mirrored: linear.determinant() < 0.0,
                    normal: linear.inverse().transpose(),
                    material,
                    texture,
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
                Content3d::Model { src } => {
                    let model = self.models.get(src).cloned().ok_or_else(|| {
                        Error::Render(format!("layer {layer:?}: model {src:?} was not loaded"))
                    })?;
                    for part in &model.parts {
                        match own {
                            Some(m) => add(
                                part.mesh.clone(),
                                &part.local,
                                m.into(),
                                own_texture.clone(),
                            ),
                            None => add(
                                part.mesh.clone(),
                                &part.local,
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
        // Farthest first: the most negative view-space z.
        translucent.sort_by(|a, b| a.1.total_cmp(&b.1));
        let opaque_count = opaque.len();
        let items = opaque
            .into_iter()
            .chain(translucent)
            .map(|(item, _)| item)
            .collect();
        Ok(DrawScene {
            size,
            msaa: scene.msaa,
            view_proj: (projection * view).as_mat4(),
            eye: scene.camera.position.as_vec3(),
            ambient,
            lights,
            items,
            opaque: opaque_count,
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
}
