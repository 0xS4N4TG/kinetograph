//! glTF 2.0 models (`.gltf` with its files, or `.glb`).
//!
//! What is read: the default scene's node tree with each node's transform, the
//! triangle meshes on the nodes, and each primitive's positions, normals
//! (flat ones when the file has none), first texture coordinates and indices;
//! materials' base colour factor and texture, metallic and roughness factors,
//! emissive factor, `doubleSided`, and `alphaMode` (`BLEND` is blended;
//! `OPAQUE` and `MASK` are drawn opaque). What is not: animations, skins,
//! morph targets, cameras, lights, other texture slots (normal, occlusion,
//! metallic-roughness, emissive), `KHR_*` extensions.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use glam::{DMat4, Mat4, Vec3};
use gltf::image::Format;
use gltf::material::AlphaMode;

use super::draw::{Material, Texture};
use super::mesh::{MeshData, Vertex3};
use crate::error::{Error, Result};

/// A model: its meshes, each placed by the node it hangs on.
pub struct Model {
    pub parts: Vec<ModelPart>,
}

pub struct ModelPart {
    pub mesh: Arc<MeshData>,
    /// The mesh's node in the model's space.
    pub local: DMat4,
    pub material: Material,
    pub texture: Option<Arc<Texture>>,
}

impl Model {
    pub fn open(base_dir: &Path, src: &str) -> Result<Model> {
        let path = base_dir.join(src);
        let (document, buffers, images) = gltf::import(&path)
            .map_err(|e| Error::Render(format!("cannot read model {}: {e}", path.display())))?;
        let fail = |msg: String| Error::Render(format!("model {}: {msg}", path.display()));
        let scene = document
            .default_scene()
            .or_else(|| document.scenes().next())
            .ok_or_else(|| fail("it has no scene".into()))?;
        let mut loader = Loader {
            buffers: &buffers,
            images: &images,
            meshes: HashMap::new(),
            textures: HashMap::new(),
            parts: Vec::new(),
        };
        for node in scene.nodes() {
            loader.node(&node, DMat4::IDENTITY).map_err(fail)?;
        }
        Ok(Model {
            parts: loader.parts,
        })
    }
}

struct Loader<'a> {
    buffers: &'a [gltf::buffer::Data],
    images: &'a [gltf::image::Data],
    /// Built meshes by (mesh, primitive), shared by the nodes that use them.
    meshes: HashMap<(usize, usize), Option<Arc<MeshData>>>,
    /// Textures by (image, whether alpha is kept).
    textures: HashMap<(usize, bool), Option<Arc<Texture>>>,
    parts: Vec<ModelPart>,
}

impl Loader<'_> {
    fn node(&mut self, node: &gltf::Node, parent: DMat4) -> std::result::Result<(), String> {
        let local = Mat4::from_cols_array_2d(&node.transform().matrix()).as_dmat4();
        let world = parent * local;
        if let Some(mesh) = node.mesh() {
            for primitive in mesh.primitives() {
                if primitive.mode() != gltf::mesh::Mode::Triangles {
                    continue;
                }
                let key = (mesh.index(), primitive.index());
                let built = match self.meshes.get(&key) {
                    Some(built) => built.clone(),
                    None => {
                        let built = self.primitive(&primitive)?.map(Arc::new);
                        self.meshes.insert(key, built.clone());
                        built
                    }
                };
                let Some(mesh) = built else { continue };
                let (material, texture) = self.material(&primitive.material());
                self.parts.push(ModelPart {
                    mesh,
                    local: world,
                    material,
                    texture,
                });
            }
        }
        for child in node.children() {
            self.node(&child, world)?;
        }
        Ok(())
    }

    fn primitive(
        &self,
        primitive: &gltf::Primitive,
    ) -> std::result::Result<Option<MeshData>, String> {
        let reader = primitive.reader(|b| self.buffers.get(b.index()).map(|d| &d.0[..]));
        let positions: Vec<[f32; 3]> = reader
            .read_positions()
            .ok_or("a mesh primitive has no positions")?
            .collect();
        let uvs: Option<Vec<[f32; 2]>> = reader.read_tex_coords(0).map(|t| t.into_f32().collect());
        let normals: Option<Vec<[f32; 3]>> = reader.read_normals().map(|n| n.collect());
        let indices: Vec<u32> = match reader.read_indices() {
            Some(i) => i.into_u32().collect(),
            None => (0..positions.len() as u32).collect(),
        };
        if indices.len() < 3 {
            return Ok(None);
        }
        if indices.iter().any(|&i| i as usize >= positions.len()) {
            return Err("a mesh index points past its vertices".into());
        }
        let uv = |i: usize| {
            uvs.as_ref()
                .and_then(|u| u.get(i))
                .copied()
                .unwrap_or([0.0; 2])
        };
        let vertex = |i: usize, normal: [f32; 3]| Vertex3 {
            position: positions[i],
            normal,
            uv: uv(i),
        };
        Ok(Some(match normals {
            Some(normals) if normals.len() == positions.len() => MeshData::new(
                (0..positions.len())
                    .map(|i| vertex(i, normals[i]))
                    .collect(),
                indices,
            ),
            // Flat normals: each triangle gets vertices of its own.
            _ => {
                let mut vertices = Vec::with_capacity(indices.len());
                for t in indices.as_chunks::<3>().0 {
                    let p = |k: usize| Vec3::from(positions[t[k] as usize]);
                    let n = (p(1) - p(0)).cross(p(2) - p(0)).normalize_or_zero();
                    for &i in t {
                        vertices.push(vertex(i as usize, n.to_array()));
                    }
                }
                let count = vertices.len() as u32;
                MeshData::new(vertices, (0..count).collect())
            }
        }))
    }

    fn material(&mut self, m: &gltf::Material) -> (Material, Option<Arc<Texture>>) {
        let pbr = m.pbr_metallic_roughness();
        let blend = m.alpha_mode() == AlphaMode::Blend;
        let mut color = pbr.base_color_factor();
        if !blend {
            color[3] = 1.0;
        }
        let texture = pbr
            .base_color_texture()
            .filter(|info| info.tex_coord() == 0)
            .and_then(|info| self.texture(info.texture().source().index(), blend));
        let material = Material {
            color,
            emissive: m.emissive_factor(),
            metallic: pbr.metallic_factor(),
            roughness: pbr.roughness_factor(),
            unlit: false,
            double_sided: m.double_sided(),
        };
        (material, texture)
    }

    fn texture(&mut self, index: usize, keep_alpha: bool) -> Option<Arc<Texture>> {
        if let Some(t) = self.textures.get(&(index, keep_alpha)) {
            return t.clone();
        }
        let built = self.images.get(index).and_then(|image| {
            let rgba = to_rgba8(image)?;
            let rgba = if keep_alpha {
                rgba
            } else {
                rgba.chunks(4)
                    .flat_map(|p| [p[0], p[1], p[2], 255])
                    .collect()
            };
            Some(Arc::new(Texture::new(image.width, image.height, rgba)))
        });
        self.textures.insert((index, keep_alpha), built.clone());
        built
    }
}

/// The picture as straight-alpha RGBA8, `None` for a format with no colour.
fn to_rgba8(image: &gltf::image::Data) -> Option<Vec<u8>> {
    let p = &image.pixels;
    let eight =
        |step: usize, f: &dyn Fn(&[u8]) -> [u8; 4]| p.chunks_exact(step).flat_map(f).collect();
    // A 16-bit channel's high byte is its second: the data is little-endian.
    Some(match image.format {
        Format::R8G8B8A8 => p.clone(),
        Format::R8G8B8 => eight(3, &|c| [c[0], c[1], c[2], 255]),
        Format::R8G8 => eight(2, &|c| [c[0], c[0], c[0], c[1]]),
        Format::R8 => eight(1, &|c| [c[0], c[0], c[0], 255]),
        Format::R16G16B16A16 => eight(8, &|c| [c[1], c[3], c[5], c[7]]),
        Format::R16G16B16 => eight(6, &|c| [c[1], c[3], c[5], 255]),
        Format::R16G16 => eight(4, &|c| [c[1], c[1], c[1], c[3]]),
        Format::R16 => eight(2, &|c| [c[1], c[1], c[1], 255]),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gem() -> Model {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scenes/media");
        Model::open(&dir, "gem.glb").expect("the test model loads")
    }

    #[test]
    fn the_test_model_has_two_materials_and_a_textured_one() {
        let model = gem();
        assert_eq!(model.parts.len(), 2);
        let colours: Vec<_> = model.parts.iter().map(|p| p.material.color).collect();
        assert_ne!(colours[0], colours[1]);
        assert!(model.parts.iter().any(|p| p.texture.is_some()));
        assert!(model.parts.iter().any(|p| p.material.metallic > 0.5));
    }

    #[test]
    fn nodes_place_their_meshes() {
        let model = gem();
        // The node tree moves the second part up; the first stays put.
        let ys: Vec<f64> = model.parts.iter().map(|p| p.local.w_axis.y).collect();
        assert!(
            ys.iter().any(|&y| y.abs() < 1e-9) && ys.iter().any(|&y| y > 0.1),
            "{ys:?}"
        );
    }

    #[test]
    fn meshes_have_unit_normals_and_in_range_indices() {
        for part in gem().parts {
            let m = &part.mesh;
            assert!(m.indices.iter().all(|&i| (i as usize) < m.vertices.len()));
            for v in &m.vertices {
                assert!((Vec3::from(v.normal).length() - 1.0).abs() < 1e-4);
            }
        }
    }

    #[test]
    fn faces_wind_counter_clockwise_seen_from_outside() {
        for part in gem().parts {
            let m = &part.mesh;
            for t in m.indices.chunks(3) {
                let v = |i: u32| Vec3::from(m.vertices[i as usize].position);
                let n = (v(t[1]) - v(t[0])).cross(v(t[2]) - v(t[0]));
                assert!(n.dot(Vec3::from(m.vertices[t[0] as usize].normal)) > 0.0);
            }
        }
    }

    #[test]
    fn a_models_texture_keeps_its_pixels() {
        let model = gem();
        let textured = model.parts.iter().find_map(|p| p.texture.as_ref()).unwrap();
        assert_eq!((textured.width, textured.height), (8, 8));
        // The checkerboard's first 2x2 block is orange, the next cream.
        assert_eq!(&textured.rgba[..4], &[240, 90, 60, 255]);
        assert_eq!(&textured.rgba[8..12], &[250, 240, 220, 255]);
    }

    #[test]
    fn a_missing_file_is_an_error_naming_it() {
        let err = Model::open(Path::new("/nonexistent"), "x.glb")
            .err()
            .unwrap();
        assert!(err.to_string().contains("x.glb"), "{err}");
    }
}
