//! glTF 2.0 models (`.gltf` with its files, or `.glb`).
//!
//! What is read: the node tree with each node's transform; the triangle meshes
//! on the nodes of the default scene, with each primitive's positions, normals
//! (flat ones when the file has none), first texture coordinates and indices;
//! materials' base colour factor and texture, normal, metallic-roughness,
//! occlusion (with its `strength`) and emissive textures, metallic and
//! roughness factors, emissive factor, `doubleSided`, and `alphaMode` (`BLEND`
//! is blended; `OPAQUE` and `MASK` are drawn opaque); animations of node
//! translation, rotation, scale and morph weights (`LINEAR`, `STEP` and
//! `CUBICSPLINE`); morph targets' position and normal displacements; skins
//! with up to four joints a vertex.
//!
//! What is not is listed in `Model::unsupported`, one entry for each kind of
//! thing: texture coordinate sets above 0, primitives that are not lists
//! of triangles, more than four joints a vertex, scenes other than the
//! default, and every glTF extension.
//!
//! A model is posed by time: `pose` evaluates a clip at a time (or no clip:
//! the nodes as the file has them), and `placed` gives each part's mesh in
//! that pose, deformed by its morph targets and skin.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use glam::{DMat4, DQuat, DVec3, Mat4, Vec3};
use gltf::animation::Interpolation;
use gltf::animation::util::ReadOutputs;
use gltf::image::Format;
use gltf::material::AlphaMode;

use super::draw::{Maps, Material, Texture};
use super::mesh::{MeshData, Vertex3};
use crate::error::{Error, Result};

/// A model: its meshes, the node tree they hang on, and the animations that
/// move the nodes.
pub struct Model {
    pub parts: Vec<ModelPart>,
    nodes: Vec<Node>,
    /// The nodes with their parents before them.
    order: Vec<usize>,
    skins: Vec<Skin>,
    pub animations: Vec<Animation>,
    /// What the file uses that is not read.
    pub unsupported: Vec<Unsupported>,
}

/// A feature of a model file that is not read, and what that costs.
#[derive(Clone, Debug, PartialEq)]
pub struct Unsupported {
    pub feature: String,
    pub reason: String,
}

pub struct ModelPart {
    /// The mesh as the file has it: without morph targets or a skin applied.
    pub mesh: Arc<MeshData>,
    /// The node the mesh hangs on.
    pub node: usize,
    pub material: Material,
    pub texture: Option<Arc<Texture>>,
    pub maps: Maps,
    deform: Option<Deform>,
}

/// What moves a part's vertices after the nodes have: morph targets and a skin.
struct Deform {
    data: Arc<DeformData>,
    /// The skin, an index into `Model::skins`.
    skin: Option<usize>,
}

/// What a part's mesh is deformed with that does not change with the pose:
/// its morph targets, then the four joints of a skin that move each vertex.
/// The GPU deforms the mesh (`shaders/scene3d_deform.wgsl`) each frame from
/// these and a `PoseDeform`.
pub struct DeformData {
    /// What the compositor keys its GPU copy by.
    pub id: u64,
    pub vertex_count: usize,
    pub target_count: usize,
    /// For each target, then each vertex: the displacement of the position
    /// (xyz) and of the normal (xyz), to add times the target's weight.
    pub targets: Vec<[f32; 6]>,
    /// Each vertex's four joints (indices into the skin's) and their weights,
    /// which sum to 1; empty without a skin.
    pub joints: Vec<[u32; 4]>,
    pub weights: Vec<[f32; 4]>,
    /// The file has no normals: the mesh has flat ones, each triangle with
    /// vertices of its own, made again from the deformed positions.
    pub flat: bool,
    /// The box of the rest positions.
    rest_box: (Vec3, Vec3),
    /// For each target, the most it moves a vertex along each axis.
    reach: Vec<Vec3>,
    /// For each joint, the box of the rest positions it moves.
    joint_boxes: Vec<Option<(Vec3, Vec3)>>,
}

/// A deformed part in one pose: what the GPU deforms its rest mesh with.
pub struct PoseDeform {
    pub data: Arc<DeformData>,
    /// One for each morph target.
    pub weights: Vec<f32>,
    /// Each joint of the skin in the model's space, times its inverse bind
    /// matrix; empty when the part has no skin.
    pub joints: Vec<Mat4>,
    /// A box the deformed vertices are inside, in the space `Placed::local`
    /// is applied to.
    pub bounds: (Vec3, Vec3),
}

struct Skin {
    /// Node indices.
    joints: Vec<usize>,
    inverse_bind: Vec<DMat4>,
}

struct Node {
    parent: Option<usize>,
    translation: DVec3,
    rotation: DQuat,
    scale: DVec3,
    /// The morph weights the node's mesh starts with.
    weights: Vec<f32>,
}

/// The nodes of a model at one time: where each is, and its morph weights.
pub struct Pose {
    world: Vec<DMat4>,
    weights: Vec<Vec<f32>>,
}

/// A part in a pose: its mesh as the file has it, what deforms it in the
/// pose, and the matrix that puts it in the model's space.
pub struct Placed<'a> {
    pub part: &'a ModelPart,
    pub mesh: Arc<MeshData>,
    pub deform: Option<PoseDeform>,
    pub local: DMat4,
}

impl Model {
    pub fn open(base_dir: &Path, src: &str) -> Result<Model> {
        let path = base_dir.join(src);
        let (document, buffers, images) = gltf::import(&path)
            .map_err(|e| Error::Render(format!("cannot read model {}: {e}", path.display())))?;
        Model::build(&path, &document, &buffers, &images)
    }

    /// What `open` would list in `unsupported`, without decoding the
    /// pictures: the notes come from the glTF's JSON and buffers alone.
    pub fn unsupported_features(base_dir: &Path, src: &str) -> Result<Vec<Unsupported>> {
        let path = base_dir.join(src);
        let unreadable =
            |e: gltf::Error| Error::Render(format!("cannot read model {}: {e}", path.display()));
        let gltf::Gltf { document, blob } = gltf::Gltf::open(&path).map_err(unreadable)?;
        let buffers = gltf::import_buffers(&document, path.parent(), blob).map_err(unreadable)?;
        Ok(Model::build(&path, &document, &buffers, &[])?.unsupported)
    }

    fn build(
        path: &Path,
        document: &gltf::Document,
        buffers: &[gltf::buffer::Data],
        images: &[gltf::image::Data],
    ) -> Result<Model> {
        let fail = |msg: String| Error::Render(format!("model {}: {msg}", path.display()));
        let scene = document
            .default_scene()
            .or_else(|| document.scenes().next())
            .ok_or_else(|| fail("it has no scene".into()))?;
        let mut loader = Loader {
            buffers,
            images,
            meshes: HashMap::new(),
            textures: HashMap::new(),
            materials: HashSet::new(),
            parts: Vec::new(),
            unsupported: Vec::new(),
        };
        if document.scenes().len() > 1 {
            loader.note("scenes", "only the default scene is read");
        }
        for extension in document.extensions_used() {
            loader.note(extension, "this glTF extension is not read");
        }
        let nodes = loader.nodes(document);
        let skins = loader.skins(document).map_err(fail)?;
        for node in scene.nodes() {
            loader.node(&node).map_err(fail)?;
        }
        let animations = loader.animations(document, nodes.len()).map_err(fail)?;
        let order = order(&nodes);
        Ok(Model {
            parts: loader.parts,
            nodes,
            order,
            skins,
            animations,
            unsupported: loader.unsupported,
        })
    }

    /// The clip `clip` at `time` seconds, as an index into `animations` and a
    /// time inside it: wrapped into the clip when `looping`, held at its ends
    /// when not.
    pub fn playback(
        &self,
        clip: &ClipRef,
        time: f64,
        looping: bool,
    ) -> std::result::Result<(usize, f64), String> {
        let index = match clip {
            ClipRef::Index(i) => ((*i as usize) < self.animations.len()).then_some(*i as usize),
            ClipRef::Name(name) => self
                .animations
                .iter()
                .position(|a| a.name.as_deref() == Some(name)),
        };
        let Some(index) = index else {
            let have: Vec<String> = self
                .animations
                .iter()
                .enumerate()
                .map(|(i, a)| a.name.clone().unwrap_or_else(|| format!("#{i}")))
                .collect();
            return Err(format!(
                "has no animation {}; it has {}",
                match clip {
                    ClipRef::Index(i) => i.to_string(),
                    ClipRef::Name(name) => format!("{name:?}"),
                },
                if have.is_empty() {
                    "none".to_string()
                } else {
                    have.join(", ")
                }
            ));
        };
        let duration = self.animations[index].duration;
        let time = match (duration > 0.0 && time.is_finite(), looping) {
            (false, _) => 0.0,
            (true, true) => time.rem_euclid(duration),
            (true, false) => time.clamp(0.0, duration),
        };
        Ok((index, time))
    }

    /// The nodes with the clip `at` (an index and a time in seconds) applied,
    /// or as the file has them.
    pub fn pose(&self, at: Option<(usize, f64)>) -> Pose {
        let mut local: Vec<(DVec3, DQuat, DVec3)> = self
            .nodes
            .iter()
            .map(|n| (n.translation, n.rotation, n.scale))
            .collect();
        let mut weights: Vec<Vec<f32>> = self.nodes.iter().map(|n| n.weights.clone()).collect();
        if let Some((clip, time)) = at {
            for channel in &self.animations[clip].channels {
                let v = channel.sample(time);
                let node = channel.node;
                match channel.target {
                    Target::Translation => local[node].0 = DVec3::new(v[0], v[1], v[2]),
                    Target::Rotation => {
                        local[node].1 = DQuat::from_xyzw(v[0], v[1], v[2], v[3]).normalize();
                    }
                    Target::Scale => local[node].2 = DVec3::new(v[0], v[1], v[2]),
                    Target::Weights => weights[node] = v.iter().map(|w| *w as f32).collect(),
                }
            }
        }
        let mut world = vec![DMat4::IDENTITY; self.nodes.len()];
        for &i in &self.order {
            let (t, r, s) = local[i];
            let own = DMat4::from_scale_rotation_translation(s, r, t);
            world[i] = match self.nodes[i].parent {
                Some(p) => world[p] * own,
                None => own,
            };
        }
        Pose { world, weights }
    }

    /// The parts in `pose`: each with its mesh as the file has it and, for a
    /// part with morph targets or a skin, what deforms it in the pose (the
    /// GPU does, when it is drawn).
    pub fn placed(&self, pose: &Pose) -> Vec<Placed<'_>> {
        self.parts
            .iter()
            .map(|part| {
                let Some(deform) = &part.deform else {
                    return Placed {
                        part,
                        mesh: part.mesh.clone(),
                        deform: None,
                        local: pose.world[part.node],
                    };
                };
                let data = &deform.data;
                let mut weights = pose.weights[part.node].clone();
                weights.resize(data.target_count, 0.0);
                let joints: Vec<Mat4> = deform.skin.map_or_else(Vec::new, |skin| {
                    let skin = &self.skins[skin];
                    skin.joints
                        .iter()
                        .zip(&skin.inverse_bind)
                        .map(|(joint, inverse_bind)| (pose.world[*joint] * *inverse_bind).as_mat4())
                        .collect()
                });
                let bounds = data.bounds(&weights, &joints);
                // A skin's joints put the vertices in the model's space; the
                // mesh node's own transform does not apply to them.
                let local = if deform.skin.is_some() {
                    DMat4::IDENTITY
                } else {
                    pose.world[part.node]
                };
                Placed {
                    part,
                    mesh: part.mesh.clone(),
                    deform: Some(PoseDeform {
                        data: data.clone(),
                        weights,
                        joints,
                        bounds,
                    }),
                    local,
                }
            })
            .collect()
    }
}

impl DeformData {
    /// A box the vertices are inside once moved by the targets at `weights`
    /// and the skin's `joints` (none: no skin). A vertex a joint moves is in
    /// that joint's box; the targets move it at most their reach; and a skin
    /// moves it to a blend (weights that sum to 1) of where its joints take
    /// it, which is inside the box of where they take their boxes.
    fn bounds(&self, weights: &[f32], joints: &[Mat4]) -> (Vec3, Vec3) {
        let reach: Vec3 = self
            .reach
            .iter()
            .zip(weights)
            .map(|(r, w)| *r * w.abs())
            .sum();
        let grow = |(lo, hi): (Vec3, Vec3)| (lo - reach, hi + reach);
        if joints.is_empty() || self.joints.is_empty() {
            return grow(self.rest_box);
        }
        let mut out: Option<(Vec3, Vec3)> = None;
        for (joint, b) in joints.iter().zip(&self.joint_boxes) {
            let Some((lo, hi)) = b.map(grow) else {
                continue;
            };
            for i in 0..8 {
                let pick = |bit: usize, a: f32, b: f32| if i & bit == 0 { a } else { b };
                let p = joint.transform_point3(Vec3::new(
                    pick(1, lo.x, hi.x),
                    pick(2, lo.y, hi.y),
                    pick(4, lo.z, hi.z),
                ));
                out = Some(out.map_or((p, p), |(lo, hi)| (lo.min(p), hi.max(p))));
            }
        }
        out.unwrap_or_else(|| grow(self.rest_box))
    }
}

/// What the GPU makes of `mesh` in the pose `deform`, on the CPU: the same
/// sums as `shaders/scene3d_deform.wgsl`, for the tests to check it by.
#[cfg(test)]
pub(crate) fn deform_on_cpu(mesh: &MeshData, deform: &PoseDeform) -> MeshData {
    let data = &deform.data;
    let n = data.vertex_count;
    let mut vertices = mesh.vertices.clone();
    for (t, weight) in deform.weights.iter().enumerate() {
        if *weight == 0.0 {
            continue;
        }
        for (i, v) in vertices.iter_mut().enumerate() {
            let d = data.targets[t * n + i];
            v.position =
                (Vec3::from(v.position) + Vec3::new(d[0], d[1], d[2]) * *weight).to_array();
            v.normal = (Vec3::from(v.normal) + Vec3::new(d[3], d[4], d[5]) * *weight).to_array();
        }
    }
    if !deform.joints.is_empty() && !data.joints.is_empty() {
        for (i, v) in vertices.iter_mut().enumerate() {
            let mut blended = Mat4::ZERO;
            for (joint, weight) in data.joints[i].iter().zip(&data.weights[i]) {
                if *weight > 0.0 {
                    blended += deform.joints[*joint as usize] * *weight;
                }
            }
            v.position = blended.transform_point3(Vec3::from(v.position)).to_array();
            v.normal = (glam::Mat3::from_mat4(blended) * Vec3::from(v.normal)).to_array();
        }
    }
    for v in &mut vertices {
        v.normal = Vec3::from(v.normal).normalize_or_zero().to_array();
    }
    if data.flat {
        // Each triangle has vertices of its own, so each gets its
        // triangle's normal.
        for t in mesh.indices.as_chunks::<3>().0 {
            let p = |k: usize| Vec3::from(vertices[t[k] as usize].position);
            let normal = (p(1) - p(0)).cross(p(2) - p(0)).normalize_or_zero();
            for &i in t {
                vertices[i as usize].normal = normal.to_array();
            }
        }
    }
    MeshData::new(vertices, mesh.indices.clone())
}

/// Whether keyframe times are all finite and never fall (a NaN fails both).
fn rising(times: &[f32]) -> bool {
    times.iter().all(|t| t.is_finite()) && times.windows(2).all(|w| w[1] >= w[0])
}

/// A per-vertex attribute of the file in the order of the mesh's vertices:
/// as it is, or, for flat shading (each triangle has vertices of its own, one
/// for each index), spread through `indices`.
fn per_vertex<T: Copy>(values: Vec<T>, indices: &[u32], flat: bool) -> Vec<T> {
    if flat {
        indices.iter().map(|&i| values[i as usize]).collect()
    } else {
        values
    }
}

/// The nodes with every parent before its children.
fn order(nodes: &[Node]) -> Vec<usize> {
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
    let mut order = Vec::with_capacity(nodes.len());
    for (i, node) in nodes.iter().enumerate() {
        match node.parent {
            Some(p) => children[p].push(i),
            None => order.push(i),
        }
    }
    let mut at = 0;
    while at < order.len() {
        let next = order[at];
        order.extend(&children[next]);
        at += 1;
    }
    order
}

// ---- animation ----

/// A clip as a scene file names it: by position in the file, or by name.
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(untagged)]
pub enum ClipRef {
    Index(u32),
    Name(String),
}

pub struct Animation {
    pub name: Option<String>,
    /// Seconds: the time of the last keyframe of any channel.
    pub duration: f64,
    channels: Vec<Channel>,
}

#[derive(Clone, Copy, PartialEq)]
enum Target {
    Translation,
    Rotation,
    Scale,
    Weights,
}

/// One property of one node, keyed in time.
struct Channel {
    node: usize,
    target: Target,
    interpolation: Interpolation,
    /// Seconds, rising.
    times: Vec<f32>,
    /// What the keyframes hold: `width` numbers a keyframe, or three times
    /// that (in-tangent, value, out-tangent) for `CUBICSPLINE`.
    values: Vec<f32>,
    /// Numbers a value: 3 for a translation or scale, 4 for a rotation (a
    /// quaternion, x y z w), one a morph target for weights.
    width: usize,
}

impl Channel {
    /// The value at `time` seconds: held before the first keyframe and after
    /// the last, and between two keyframes as the interpolation says.
    fn sample(&self, time: f64) -> Vec<f64> {
        let cubic = self.interpolation == Interpolation::CubicSpline;
        let width = self.width;
        let numbers = |from: usize| -> &[f32] { &self.values[from..from + width] };
        // The value of keyframe `k` (the middle one of a cubic spline's three).
        let value = |k: usize| {
            numbers(if cubic {
                (3 * k + 1) * width
            } else {
                k * width
            })
        };
        let widen = |v: &[f32]| -> Vec<f64> { v.iter().map(|x| f64::from(*x)).collect() };
        let at = |k: usize| f64::from(self.times[k]);
        let last = self.times.len() - 1;
        // Not a time at all: the first keyframe, as for a time before it.
        if !time.is_finite() || time <= at(0) {
            return widen(value(0));
        }
        if time >= at(last) {
            return widen(value(last));
        }
        // The first keyframe after `time`; the one before it is at or before.
        // (Clamped, so that nothing a file holds can index past its keys.)
        let next = self
            .times
            .partition_point(|&k| f64::from(k) <= time)
            .clamp(1, last);
        let prev = next - 1;
        let dt = at(next) - at(prev);
        if dt <= 0.0 {
            return widen(value(next));
        }
        let s = (time - at(prev)) / dt;
        let (a, b) = (widen(value(prev)), widen(value(next)));
        let mut out = match self.interpolation {
            Interpolation::Step => a,
            Interpolation::Linear if self.target == Target::Rotation => {
                let q = |v: &[f64]| DQuat::from_xyzw(v[0], v[1], v[2], v[3]);
                q(&a).slerp(q(&b), s).to_array().to_vec()
            }
            Interpolation::Linear => a.iter().zip(&b).map(|(a, b)| a + (b - a) * s).collect(),
            Interpolation::CubicSpline => {
                // Hermite: the value and out-tangent of `prev`, the
                // in-tangent and value of `next`.
                let out_tangent = widen(numbers((3 * prev + 2) * width));
                let in_tangent = widen(numbers(3 * next * width));
                let (s2, s3) = (s * s, s * s * s);
                (0..width)
                    .map(|i| {
                        (2.0 * s3 - 3.0 * s2 + 1.0) * a[i]
                            + (s3 - 2.0 * s2 + s) * dt * out_tangent[i]
                            + (-2.0 * s3 + 3.0 * s2) * b[i]
                            + (s3 - s2) * dt * in_tangent[i]
                    })
                    .collect()
            }
        };
        if self.target == Target::Rotation {
            let q = DQuat::from_xyzw(out[0], out[1], out[2], out[3]).normalize();
            out = q.to_array().to_vec();
        }
        out
    }
}

// ---- loading ----

/// What a primitive comes to: the mesh and what can deform it.
struct Built {
    mesh: Arc<MeshData>,
    /// Its morph targets and the joints that move it, if it has either.
    deform: Option<Arc<DeformData>>,
}

impl DeformData {
    fn new(
        mesh: &MeshData,
        targets: Vec<[f32; 6]>,
        target_count: usize,
        joints: Vec<[u32; 4]>,
        weights: Vec<[f32; 4]>,
        flat: bool,
    ) -> DeformData {
        let vertex_count = mesh.vertices.len();
        let rest_box = mesh.bounds().unwrap_or((Vec3::ZERO, Vec3::ZERO));
        let reach = targets
            .chunks(vertex_count.max(1))
            .take(target_count)
            .map(|target| {
                target
                    .iter()
                    .fold(Vec3::ZERO, |m, d| m.max(Vec3::new(d[0], d[1], d[2]).abs()))
            })
            .collect();
        let mut joint_boxes: Vec<Option<(Vec3, Vec3)>> = Vec::new();
        for (v, (js, ws)) in mesh.vertices.iter().zip(joints.iter().zip(&weights)) {
            let p = Vec3::from(v.position);
            for (j, w) in js.iter().zip(ws) {
                if *w <= 0.0 {
                    continue;
                }
                let j = *j as usize;
                if joint_boxes.len() <= j {
                    joint_boxes.resize(j + 1, None);
                }
                joint_boxes[j] =
                    Some(joint_boxes[j].map_or((p, p), |(lo, hi)| (lo.min(p), hi.max(p))));
            }
        }
        DeformData {
            id: super::mesh::next_id(),
            vertex_count,
            target_count,
            targets,
            joints,
            weights,
            flat,
            rest_box,
            reach,
            joint_boxes,
        }
    }
}

struct Loader<'a> {
    buffers: &'a [gltf::buffer::Data],
    images: &'a [gltf::image::Data],
    /// Built meshes by (mesh, primitive), shared by the nodes that use them.
    meshes: HashMap<(usize, usize), Option<Arc<Built>>>,
    /// Textures by (image, whether alpha is kept).
    textures: HashMap<(usize, bool), Option<Arc<Texture>>>,
    /// Materials already looked at for what they use that is not read.
    materials: HashSet<Option<usize>>,
    parts: Vec<ModelPart>,
    unsupported: Vec<Unsupported>,
}

impl Loader<'_> {
    /// Records that the file uses `feature`, which is not read, once.
    fn note(&mut self, feature: &str, reason: &str) {
        if !self.unsupported.iter().any(|u| u.feature == feature) {
            self.unsupported.push(Unsupported {
                feature: feature.to_string(),
                reason: reason.to_string(),
            });
        }
    }

    fn nodes(&self, document: &gltf::Document) -> Vec<Node> {
        let mut nodes: Vec<Node> = document
            .nodes()
            .map(|node| {
                let (t, r, s) = node.transform().decomposed();
                let targets = node.mesh().map_or(0, |m| {
                    m.primitives().next().map_or(0, |p| p.morph_targets().len())
                });
                // The node's weights, else its mesh's, else none moved.
                let weights = node
                    .weights()
                    .or_else(|| node.mesh().and_then(|m| m.weights()))
                    .map_or_else(|| vec![0.0; targets], <[f32]>::to_vec);
                Node {
                    parent: None,
                    translation: Vec3::from(t).as_dvec3(),
                    rotation: DQuat::from_xyzw(
                        f64::from(r[0]),
                        f64::from(r[1]),
                        f64::from(r[2]),
                        f64::from(r[3]),
                    )
                    .normalize(),
                    scale: Vec3::from(s).as_dvec3(),
                    weights,
                }
            })
            .collect();
        for node in document.nodes() {
            for child in node.children() {
                nodes[child.index()].parent = Some(node.index());
            }
        }
        nodes
    }

    fn skins(&self, document: &gltf::Document) -> std::result::Result<Vec<Skin>, String> {
        document
            .skins()
            .map(|skin| {
                let joints: Vec<usize> = skin.joints().map(|j| j.index()).collect();
                let reader = skin.reader(|b| self.buffers.get(b.index()).map(|d| &d.0[..]));
                let inverse_bind: Vec<DMat4> = match reader.read_inverse_bind_matrices() {
                    Some(matrices) => matrices
                        .map(|m| Mat4::from_cols_array_2d(&m).as_dmat4())
                        .collect(),
                    None => vec![DMat4::IDENTITY; joints.len()],
                };
                if inverse_bind.len() != joints.len() {
                    return Err(format!(
                        "a skin has {} joints and {} inverse bind matrices",
                        joints.len(),
                        inverse_bind.len()
                    ));
                }
                Ok(Skin {
                    joints,
                    inverse_bind,
                })
            })
            .collect()
    }

    fn node(&mut self, node: &gltf::Node) -> std::result::Result<(), String> {
        if let Some(mesh) = node.mesh() {
            for primitive in mesh.primitives() {
                if primitive.mode() != gltf::mesh::Mode::Triangles {
                    self.note(
                        &format!("{:?} primitives", primitive.mode()),
                        "only lists of triangles are drawn",
                    );
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
                let Some(built) = built else { continue };
                let (material, texture, maps) = self.material(&primitive.material());
                let data = built.deform.as_ref();
                let skin = match (node.skin(), data.filter(|d| !d.joints.is_empty())) {
                    (Some(skin), Some(data)) => {
                        let joints = skin.joints().count();
                        let stray = data.joints.iter().zip(&data.weights).any(|(js, ws)| {
                            js.iter()
                                .zip(ws)
                                .any(|(j, w)| *w > 0.0 && *j as usize >= joints)
                        });
                        if stray {
                            return Err(
                                "a vertex is moved by a joint its skin does not have".into()
                            );
                        }
                        Some(skin.index())
                    }
                    _ => None,
                };
                let deform = data
                    .filter(|d| d.target_count > 0 || skin.is_some())
                    .map(|data| Deform {
                        data: data.clone(),
                        skin,
                    });
                self.parts.push(ModelPart {
                    mesh: built.mesh.clone(),
                    node: node.index(),
                    material,
                    texture,
                    maps,
                    deform,
                });
            }
        }
        for child in node.children() {
            self.node(&child)?;
        }
        Ok(())
    }

    fn primitive(
        &mut self,
        primitive: &gltf::Primitive,
    ) -> std::result::Result<Option<Built>, String> {
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
        let count = positions.len();
        let normals = normals.filter(|n| n.len() == count);
        let flat = normals.is_none();

        let uv = |i: usize| {
            uvs.as_ref()
                .and_then(|u| u.get(i))
                .copied()
                .unwrap_or([0.0; 2])
        };
        let mesh = match &normals {
            Some(normals) => MeshData::new(
                (0..count)
                    .map(|i| Vertex3 {
                        position: positions[i],
                        normal: normals[i],
                        uv: uv(i),
                    })
                    .collect(),
                indices.clone(),
            ),
            // Flat normals: each triangle gets vertices of its own.
            None => {
                let mut vertices = Vec::with_capacity(indices.len());
                for t in indices.as_chunks::<3>().0 {
                    let p = |k: usize| Vec3::from(positions[t[k] as usize]);
                    let n = (p(1) - p(0)).cross(p(2) - p(0)).normalize_or_zero();
                    for &i in t {
                        vertices.push(Vertex3 {
                            position: positions[i as usize],
                            normal: n.to_array(),
                            uv: uv(i as usize),
                        });
                    }
                }
                let n = vertices.len() as u32;
                MeshData::new(vertices, (0..n).collect())
            }
        };

        // Target-major: each target's displacements of every vertex of the mesh.
        let mut targets: Vec<[f32; 6]> = Vec::new();
        let mut target_count = 0;
        for (target_positions, target_normals, _) in reader.read_morph_targets() {
            let positions: Vec<[f32; 3]> = match target_positions {
                Some(p) => p.collect(),
                None => vec![[0.0; 3]; count],
            };
            let normals: Option<Vec<[f32; 3]>> = target_normals.map(|n| n.collect());
            if positions.len() != count || normals.as_ref().is_some_and(|n| n.len() != count) {
                return Err("a morph target does not have a displacement for every vertex".into());
            }
            let positions = per_vertex(positions, &indices, flat);
            // Flat normals are made again from the positions.
            let normals = normals
                .filter(|_| !flat)
                .map(|n| per_vertex(n, &indices, flat));
            targets.extend(positions.iter().enumerate().map(|(i, p)| {
                let n = normals.as_ref().map_or([0.0; 3], |n| n[i]);
                [p[0], p[1], p[2], n[0], n[1], n[2]]
            }));
            target_count += 1;
        }

        let influences = match (reader.read_joints(0), reader.read_weights(0)) {
            (Some(joints), Some(weights)) => {
                let joints: Vec<[u16; 4]> = joints.into_u16().collect();
                let mut weights: Vec<[f32; 4]> = weights.into_f32().collect();
                if joints.len() != count || weights.len() != count {
                    return Err("a skin's joints and weights do not cover every vertex".into());
                }
                for w in &mut weights {
                    // The weights are to sum to 1; make sure.
                    let sum: f32 = w.iter().sum();
                    if sum > 0.0 {
                        w.iter_mut().for_each(|x| *x /= sum);
                    }
                }
                Some((
                    per_vertex(joints, &indices, flat)
                        .into_iter()
                        .map(|j| j.map(u32::from))
                        .collect::<Vec<_>>(),
                    per_vertex(weights, &indices, flat),
                ))
            }
            _ => None,
        };
        if reader.read_joints(1).is_some() {
            self.note(
                "more than 4 joints a vertex",
                "only the 4 strongest-listed (JOINTS_0) move a vertex",
            );
        }
        let deform = (target_count > 0 || influences.is_some()).then(|| {
            let (joints, weights) = influences.unwrap_or_default();
            Arc::new(DeformData::new(
                &mesh,
                targets,
                target_count,
                joints,
                weights,
                flat,
            ))
        });
        Ok(Some(Built {
            mesh: Arc::new(mesh),
            deform,
        }))
    }

    fn material(&mut self, m: &gltf::Material) -> (Material, Option<Arc<Texture>>, Maps) {
        let pbr = m.pbr_metallic_roughness();
        let blend = m.alpha_mode() == AlphaMode::Blend;
        if self.materials.insert(m.index()) {
            if m.alpha_mode() == AlphaMode::Mask {
                self.note("alphaMode MASK", "the material is drawn opaque");
            }
            if pbr
                .base_color_texture()
                .is_some_and(|info| info.tex_coord() != 0)
                || m.normal_texture().is_some_and(|info| info.tex_coord() != 0)
                || pbr
                    .metallic_roughness_texture()
                    .is_some_and(|info| info.tex_coord() != 0)
                || m.occlusion_texture()
                    .is_some_and(|info| info.tex_coord() != 0)
                || m.emissive_texture()
                    .is_some_and(|info| info.tex_coord() != 0)
            {
                self.note(
                    "texture coordinate sets above 0",
                    "the textures that use them are not drawn",
                );
            }
        }
        let mut color = pbr.base_color_factor();
        if !blend {
            color[3] = 1.0;
        }
        let texture = pbr
            .base_color_texture()
            .filter(|info| info.tex_coord() == 0)
            .and_then(|info| self.texture(info.texture().source().index(), blend));
        let normal = m.normal_texture().filter(|info| info.tex_coord() == 0);
        let occlusion = m.occlusion_texture().filter(|info| info.tex_coord() == 0);
        let material = Material {
            color,
            emissive: m.emissive_factor(),
            metallic: pbr.metallic_factor(),
            roughness: pbr.roughness_factor(),
            unlit: false,
            double_sided: m.double_sided(),
            normal_scale: normal.as_ref().map_or(1.0, |n| n.scale()),
            occlusion_strength: occlusion.as_ref().map_or(1.0, |o| o.strength()),
        };
        let maps = Maps {
            normal: normal.and_then(|n| self.texture(n.texture().source().index(), false)),
            metallic_roughness: pbr
                .metallic_roughness_texture()
                .filter(|info| info.tex_coord() == 0)
                .and_then(|info| self.texture(info.texture().source().index(), false)),
            occlusion: occlusion.and_then(|o| self.texture(o.texture().source().index(), false)),
            emissive: m
                .emissive_texture()
                .filter(|info| info.tex_coord() == 0)
                .and_then(|info| self.texture(info.texture().source().index(), false)),
        };
        (material, texture, maps)
    }

    fn texture(&mut self, index: usize, keep_alpha: bool) -> Option<Arc<Texture>> {
        if let Some(t) = self.textures.get(&(index, keep_alpha)) {
            return t.clone();
        }
        let built = self.images.get(index).and_then(|image| {
            let mut rgba = to_rgba8(image)?;
            if !keep_alpha {
                for pixel in rgba.as_chunks_mut::<4>().0 {
                    pixel[3] = 255;
                }
            }
            Some(Arc::new(Texture::new(image.width, image.height, rgba)))
        });
        self.textures.insert((index, keep_alpha), built.clone());
        built
    }

    fn animations(
        &self,
        document: &gltf::Document,
        node_count: usize,
    ) -> std::result::Result<Vec<Animation>, String> {
        document
            .animations()
            .map(|animation| {
                let name = animation.name().map(str::to_string);
                let label = || {
                    name.clone()
                        .unwrap_or_else(|| format!("#{}", animation.index()))
                };
                let mut channels = Vec::new();
                for channel in animation.channels() {
                    let reader = channel.reader(|b| self.buffers.get(b.index()).map(|d| &d.0[..]));
                    let times: Vec<f32> = reader
                        .read_inputs()
                        .ok_or_else(|| format!("animation {}: a channel has no times", label()))?
                        .collect();
                    let outputs = reader
                        .read_outputs()
                        .ok_or_else(|| format!("animation {}: a channel has no values", label()))?;
                    let (target, width, values): (Target, usize, Vec<f32>) = match outputs {
                        ReadOutputs::Translations(t) => {
                            (Target::Translation, 3, t.flatten().collect())
                        }
                        ReadOutputs::Rotations(r) => {
                            (Target::Rotation, 4, r.into_f32().flatten().collect())
                        }
                        ReadOutputs::Scales(s) => (Target::Scale, 3, s.flatten().collect()),
                        ReadOutputs::MorphTargetWeights(w) => {
                            (Target::Weights, 0, w.into_f32().collect())
                        }
                    };
                    let interpolation = channel.sampler().interpolation();
                    if times.is_empty() {
                        continue;
                    }
                    if !rising(&times) {
                        return Err(format!(
                            "animation {}: keyframe times are not finite and rising",
                            label()
                        ));
                    }
                    let per_key = if interpolation == Interpolation::CubicSpline {
                        3
                    } else {
                        1
                    };
                    // Weights have as many numbers a keyframe as the mesh has
                    // morph targets.
                    let width = if target == Target::Weights {
                        values.len() / (times.len() * per_key)
                    } else {
                        width
                    };
                    if width == 0 || values.len() != times.len() * per_key * width {
                        return Err(format!(
                            "animation {}: a channel's values do not match its times",
                            label()
                        ));
                    }
                    let node = channel.target().node().index();
                    if node >= node_count {
                        return Err(format!("animation {}: a channel targets no node", label()));
                    }
                    channels.push(Channel {
                        node,
                        target,
                        interpolation,
                        times,
                        values,
                        width,
                    });
                }
                let duration = channels
                    .iter()
                    .filter_map(|c| c.times.last())
                    .fold(0.0_f64, |d, t| d.max(f64::from(*t)));
                Ok(Animation {
                    name,
                    duration,
                    channels,
                })
            })
            .collect()
    }
}

/// One pixel of a format as straight-alpha RGBA8.
type Convert = fn(&[u8]) -> [u8; 4];

/// The picture as straight-alpha RGBA8, `None` for a format with no colour.
fn to_rgba8(image: &gltf::image::Data) -> Option<Vec<u8>> {
    let p = &image.pixels;
    if image.format == Format::R8G8B8A8 {
        return Some(p.clone());
    }
    // A 16-bit channel's high byte is its second: the data is little-endian.
    let (step, to_rgba): (usize, Convert) = match image.format {
        Format::R8G8B8 => (3, |c| [c[0], c[1], c[2], 255]),
        Format::R8G8 => (2, |c| [c[0], c[0], c[0], c[1]]),
        Format::R8 => (1, |c| [c[0], c[0], c[0], 255]),
        Format::R16G16B16A16 => (8, |c| [c[1], c[3], c[5], c[7]]),
        Format::R16G16B16 => (6, |c| [c[1], c[3], c[5], 255]),
        Format::R16G16 => (4, |c| [c[1], c[1], c[1], c[3]]),
        Format::R16 => (2, |c| [c[1], c[1], c[1], 255]),
        _ => return None,
    };
    let mut out = vec![0u8; p.len() / step * 4];
    for (src, dst) in p.chunks_exact(step).zip(out.as_chunks_mut::<4>().0) {
        *dst = to_rgba(src);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picture(format: Format, pixels: &[u8]) -> gltf::image::Data {
        gltf::image::Data {
            pixels: pixels.to_vec(),
            format,
            width: 2,
            height: 1,
        }
    }

    #[test]
    fn pictures_convert_to_rgba8_by_format() {
        let cases: [(Format, &[u8], [u8; 8]); 8] = [
            (
                Format::R8G8B8A8,
                &[1, 2, 3, 4, 5, 6, 7, 8],
                [1, 2, 3, 4, 5, 6, 7, 8],
            ),
            (
                Format::R8G8B8,
                &[1, 2, 3, 4, 5, 6],
                [1, 2, 3, 255, 4, 5, 6, 255],
            ),
            (Format::R8G8, &[1, 2, 3, 4], [1, 1, 1, 2, 3, 3, 3, 4]),
            (Format::R8, &[1, 2], [1, 1, 1, 255, 2, 2, 2, 255]),
            (
                Format::R16G16B16A16,
                &[0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8],
                [1, 2, 3, 4, 5, 6, 7, 8],
            ),
            (
                Format::R16G16B16,
                &[0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6],
                [1, 2, 3, 255, 4, 5, 6, 255],
            ),
            (
                Format::R16G16,
                &[0, 1, 0, 2, 0, 3, 0, 4],
                [1, 1, 1, 2, 3, 3, 3, 4],
            ),
            (Format::R16, &[0, 1, 0, 2], [1, 1, 1, 255, 2, 2, 2, 255]),
        ];
        for (format, pixels, want) in cases {
            assert_eq!(
                to_rgba8(&picture(format, pixels)).unwrap(),
                want,
                "{format:?}"
            );
        }
        assert!(to_rgba8(&picture(Format::R32G32B32FLOAT, &[0; 24])).is_none());
    }

    #[test]
    fn the_notes_need_no_pictures() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scenes/media");
        for name in ["gem.glb", "unsupported.glb"] {
            let full: Vec<_> = Model::open(&dir, name)
                .unwrap()
                .unsupported
                .into_iter()
                .map(|u| (u.feature, u.reason))
                .collect();
            let light: Vec<_> = Model::unsupported_features(&dir, name)
                .unwrap()
                .into_iter()
                .map(|u| (u.feature, u.reason))
                .collect();
            assert_eq!(light, full, "{name}");
        }
    }

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
        let pose = model.pose(None);
        let ys: Vec<f64> = model
            .parts
            .iter()
            .map(|p| pose.world[p.node].w_axis.y)
            .collect();
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

    fn open(name: &str) -> Model {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scenes/media");
        Model::open(&dir, name).unwrap_or_else(|e| panic!("{name}: {e}"))
    }

    fn near(a: DVec3, b: DVec3) {
        assert!((a - b).length() < 1e-6, "{a:?} is not {b:?}");
    }

    /// The parts in `pose` with their meshes deformed on the CPU, as the GPU
    /// deforms them.
    fn placed_on_cpu<'a>(model: &'a Model, pose: &Pose) -> Vec<Placed<'a>> {
        model
            .placed(pose)
            .into_iter()
            .map(|mut p| {
                if let Some(deform) = &p.deform {
                    p.mesh = Arc::new(deform_on_cpu(&p.mesh, deform));
                }
                p
            })
            .collect()
    }

    fn position(m: &Placed, vertex: usize) -> Vec3 {
        Vec3::from(m.mesh.vertices[vertex].position)
    }

    fn near32(a: Vec3, b: Vec3) {
        assert!((a - b).length() < 1e-5, "{a:?} is not {b:?}");
    }

    #[test]
    fn clips_are_listed_with_their_names_and_lengths() {
        let model = open("animated.glb");
        let clips: Vec<_> = model
            .animations
            .iter()
            .map(|a| (a.name.as_deref().unwrap(), a.duration))
            .collect();
        assert_eq!(clips, [("move", 1.0), ("spin", 2.0)]);
        assert!(gem().animations.is_empty());
    }

    #[test]
    fn a_clip_is_found_by_name_or_position_and_its_time_wraps_or_holds() {
        let model = open("animated.glb");
        let name = |n: &str| ClipRef::Name(n.into());
        assert_eq!(model.playback(&name("move"), 0.25, true), Ok((0, 0.25)));
        assert_eq!(model.playback(&ClipRef::Index(1), 0.5, true), Ok((1, 0.5)));
        // 2.25 s into a 1 s clip: a quarter into its third round, or held at its end.
        assert_eq!(model.playback(&name("move"), 2.25, true), Ok((0, 0.25)));
        assert_eq!(model.playback(&name("move"), 2.25, false), Ok((0, 1.0)));
        // Before the start, wrapped from the end or held at the start.
        assert_eq!(model.playback(&name("move"), -0.25, true), Ok((0, 0.75)));
        assert_eq!(model.playback(&name("move"), -0.25, false), Ok((0, 0.0)));
        let err = model.playback(&name("run"), 0.0, true).unwrap_err();
        assert!(
            err.contains("\"run\"") && err.contains("move, spin"),
            "{err}"
        );
        assert!(model.playback(&ClipRef::Index(2), 0.0, true).is_err());
        let err = gem().playback(&name("x"), 0.0, true).unwrap_err();
        assert!(err.contains("it has none"), "{err}");
    }

    #[test]
    fn linear_and_step_channels_move_the_node_they_target() {
        let model = open("animated.glb");
        let mover = |t: f64| model.pose(Some((0, t))).world[0];
        // The file's own pose, with no clip: where the node is.
        near(
            model.pose(None).world[0].transform_point3(DVec3::X),
            DVec3::X,
        );
        // 0.25 s in: a quarter of the way along x and of the turn (22.5 degrees
        // about y, which takes +x to (cos, 0, -sin)); the STEP scale is still 1.
        let a = 22.5_f64.to_radians();
        near(
            mover(0.25).transform_point3(DVec3::X),
            DVec3::new(0.5 + a.cos(), 0.0, -a.sin()),
        );
        // At 0.5 s the STEP has jumped to 2: x is stretched before the turn.
        let a = 45.0_f64.to_radians();
        near(
            mover(0.5).transform_point3(DVec3::X),
            DVec3::new(1.0 + 2.0 * a.cos(), 0.0, -2.0 * a.sin()),
        );
        // Past the end the last keyframe holds.
        near(
            mover(5.0).transform_point3(DVec3::ZERO),
            DVec3::new(2.0, 0.0, 0.0),
        );
    }

    #[test]
    fn keyframe_times_must_be_finite_and_rising() {
        assert!(rising(&[0.0, 0.5, 0.5, 1.0]));
        assert!(!rising(&[0.0, f32::NAN, 1.0]));
        assert!(!rising(&[f32::NAN]));
        assert!(!rising(&[0.0, f32::INFINITY]));
        assert!(!rising(&[0.0, 1.0, 0.5]));
    }

    #[test]
    fn a_time_that_is_not_a_number_or_a_malformed_sequence_never_panics() {
        let channel = |times: Vec<f32>| Channel {
            node: 0,
            target: Target::Translation,
            interpolation: Interpolation::Linear,
            values: (0..times.len() * 3).map(|i| i as f32).collect(),
            times,
            width: 3,
        };
        let sound = channel(vec![0.0, 1.0]);
        for time in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let v = sound.sample(time);
            assert_eq!(v.len(), 3);
            assert!(v.iter().all(|x| x.is_finite()), "{time}: {v:?}");
        }
        // Keys a NaN spoils (the loader refuses them) still cannot index out of range.
        for times in [
            vec![0.0, f32::NAN, 1.0],
            vec![f32::NAN, f32::NAN],
            vec![1.0, 0.0, 0.5],
        ] {
            let bad = channel(times);
            for time in [-1.0, 0.0, 0.25, 0.5, 2.0, f64::NAN] {
                assert_eq!(bad.sample(time).len(), 3);
            }
        }
        // A model's playback also turns such a time into the clip's start.
        let model = open("animated.glb");
        let name = ClipRef::Name("move".into());
        assert_eq!(model.playback(&name, f64::NAN, true), Ok((0, 0.0)));
        assert_eq!(model.playback(&name, f64::INFINITY, false), Ok((0, 0.0)));
    }

    #[test]
    fn a_cubic_spline_follows_its_tangents() {
        let model = open("animated.glb");
        let at = |t: f64| model.pose(Some((0, t))).world[1].transform_point3(DVec3::ZERO);
        near(at(0.0), DVec3::new(0.0, 2.0, 0.0));
        near(at(1.0), DVec3::new(1.0, 2.0, 0.0));
        // Hermite at the middle: half of each value plus an eighth of the
        // out-tangent (2 a second, over 1 s) is 0.5 + 0.25.
        near(at(0.5), DVec3::new(0.75, 2.0, 0.0));
        // The tangent leaves faster than a line would: ahead of it early on.
        assert!(at(0.25).x > 0.25);
    }

    #[test]
    fn a_morph_target_moves_vertices_by_its_weight() {
        let model = open("morph.glb");
        let top_right = |m: &[Placed]| position(&m[0], 2);
        // No clip: the mesh's own weight, 0.5.
        let rest = placed_on_cpu(&model, &model.pose(None));
        near32(top_right(&rest), Vec3::new(1.0, 1.0, 0.0));
        // The clip drives the weight from 0 to 1; the bottom corners never move.
        for (t, x) in [(0.0, 0.5), (0.5, 1.0), (1.0, 1.5)] {
            let posed = placed_on_cpu(&model, &model.pose(Some((0, t))));
            near32(top_right(&posed), Vec3::new(x, 1.0, 0.0));
            near32(position(&posed[0], 0), Vec3::new(-0.5, 0.0, 0.0));
        }
        // The file's own mesh is untouched, and is what is drawn, the GPU
        // moving its vertices.
        assert_eq!(model.parts[0].mesh.vertices[2].position, [0.5, 1.0, 0.0]);
        let placed = model.placed(&model.pose(None));
        assert!(Arc::ptr_eq(&placed[0].mesh, &model.parts[0].mesh));
        assert_eq!(placed[0].deform.as_ref().unwrap().weights, [0.5]);
    }

    /// Every vertex `placed_on_cpu` makes is inside the box `placed` gives.
    fn inside_bounds(model: &Model, pose: &Pose) {
        for (gpu, cpu) in model.placed(pose).iter().zip(placed_on_cpu(model, pose)) {
            let Some(deform) = &gpu.deform else { continue };
            let (lo, hi) = deform.bounds;
            for v in &cpu.mesh.vertices {
                let p = Vec3::from(v.position);
                assert!(
                    p.cmpge(lo - 1e-5).all() && p.cmple(hi + 1e-5).all(),
                    "{p} is outside {lo}..{hi}"
                );
            }
        }
    }

    #[test]
    fn a_deformed_parts_box_holds_its_vertices_in_every_pose() {
        for name in ["morph.glb", "skin.glb"] {
            let model = open(name);
            inside_bounds(&model, &model.pose(None));
            for t in [0.0, 0.25, 0.5, 0.75, 1.0] {
                inside_bounds(&model, &model.pose(Some((0, t))));
            }
        }
        let model = khronos("SimpleSkin.gltf");
        for t in [0.0, 1.0, 2.5, 4.0] {
            inside_bounds(&model, &model.pose(Some((0, t))));
        }
    }

    #[test]
    fn a_mesh_with_no_normals_gets_flat_ones_after_it_morphs() {
        let model = open("morph.glb");
        let flat = &placed_on_cpu(&model, &model.pose(None))[1];
        // The corner (0, 1, 0) is lifted to (0, 1, 1): the triangle leans.
        let n = Vec3::from(flat.mesh.vertices[0].normal);
        near32(n, Vec3::new(0.0, -1.0, 1.0).normalize());
        assert!(flat.mesh.vertices.iter().all(|v| v.normal == n.to_array()));
        // At weight 0 it is the flat triangle the file describes.
        let mut pose = model.pose(None);
        pose.weights[model.parts[1].node] = vec![0.0];
        let flat = &placed_on_cpu(&model, &pose)[1];
        near32(Vec3::from(flat.mesh.vertices[2].normal), Vec3::Z);
    }

    #[test]
    fn a_skin_bends_the_mesh_with_its_joints() {
        let model = open("skin.glb");
        let skinned = |t: Option<f64>| {
            let pose = model.pose(t.map(|t| (0, t)));
            placed_on_cpu(&model, &pose)
        };
        // Vertices are (x, y) = (-0.25, 0), (0.25, 0), (-0.25, 1), (0.25, 1),
        // (-0.25, 2), (0.25, 2); the upper joint turns 90 degrees about z at y = 1.
        let rest = skinned(None);
        for (i, v) in model.parts[0].mesh.vertices.iter().enumerate() {
            near32(position(&rest[0], i), Vec3::from(v.position));
        }
        // Skinned vertices are in the model's space: the mesh node's own
        // transform does not apply to them.
        assert_eq!(rest[0].local, DMat4::IDENTITY);
        let bent = skinned(Some(1.0));
        // The lower joint's vertices stay; the upper joint's go left.
        near32(position(&bent[0], 0), Vec3::new(-0.25, 0.0, 0.0));
        near32(position(&bent[0], 4), Vec3::new(-1.0, 0.75, 0.0));
        near32(position(&bent[0], 5), Vec3::new(-1.0, 1.25, 0.0));
        // Half and half: the mean of where each joint puts (0.25, 1).
        near32(position(&bent[0], 3), Vec3::new(0.125, 1.125, 0.0));
        // Halfway through the turn, 45 degrees.
        let half = skinned(Some(0.5));
        let c = 45.0_f32.to_radians();
        near32(
            position(&half[0], 5),
            Vec3::new(
                0.25 * c.cos() - c.sin(),
                1.0 + 0.25 * c.sin() + c.cos(),
                0.0,
            ),
        );
    }

    #[test]
    fn what_a_file_uses_that_is_not_read_is_reported_once_each() {
        let model = open("unsupported.glb");
        let features: Vec<&str> = model
            .unsupported
            .iter()
            .map(|u| u.feature.as_str())
            .collect();
        for feature in [
            "KHR_materials_clearcoat",
            "texture coordinate sets above 0",
            "alphaMode MASK",
            "Points primitives",
        ] {
            assert_eq!(
                features.iter().filter(|f| **f == feature).count(),
                1,
                "{features:?}"
            );
        }
        assert_eq!(features.len(), 4, "{features:?}");
        // What can be drawn still is: the triangle.
        assert_eq!(model.parts.len(), 1);
        // The files that use nothing the loader skips say nothing.
        for name in [
            "gem.glb",
            "animated.glb",
            "morph.glb",
            "skin.glb",
            "maps.glb",
            "occlusion.glb",
        ] {
            assert!(open(name).unsupported.is_empty(), "{name}");
        }
    }

    #[test]
    fn occlusion_and_emissive_textures_are_read_with_their_strength() {
        let model = open("occlusion.glb");
        let parts = &model.parts;
        assert_eq!(parts.len(), 4);
        let occlusion = parts[0].maps.occlusion.as_ref().expect("an occlusion map");
        // The map is data: its red (0) is kept as it is.
        assert_eq!(&occlusion.rgba[..4], &[0, 255, 255, 255]);
        assert_eq!(parts[0].material.occlusion_strength, 1.0);
        assert_eq!(parts[1].material.occlusion_strength, 0.5);
        // The two quads share the picture.
        assert!(Arc::ptr_eq(
            occlusion,
            parts[1].maps.occlusion.as_ref().unwrap()
        ));
        let emissive = parts[2].maps.emissive.as_ref().expect("an emissive map");
        assert_eq!(&emissive.rgba[..4], &[255, 0, 0, 255]);
        assert_eq!(parts[2].material.emissive, [1.0; 3]);
        let plain = &parts[3];
        assert!(plain.maps.occlusion.is_none() && plain.maps.emissive.is_none());
        assert_eq!(plain.material.occlusion_strength, 1.0);
    }

    #[test]
    fn a_missing_file_is_an_error_naming_it() {
        let err = Model::open(Path::new("/nonexistent"), "x.glb")
            .err()
            .unwrap();
        assert!(err.to_string().contains("x.glb"), "{err}");
    }

    // The Khronos samples (CC0, tests/scenes/media/khronos/README.md) are files
    // made by other tools: what they hold checks the reading, not our own files.

    fn khronos(name: &str) -> Model {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scenes/media/khronos");
        Model::open(&dir, name).unwrap_or_else(|e| panic!("{name}: {e}"))
    }

    #[test]
    fn the_interpolation_test_clips_move_each_node_as_their_interpolation_says() {
        let model = khronos("InterpolationTest.glb");
        assert!(model.unsupported.is_empty());
        let clip = |name: &str| {
            model
                .animations
                .iter()
                .position(|a| a.name.as_deref() == Some(name))
                .unwrap_or_else(|| panic!("no clip {name}"))
        };
        // The node a clip moves and where it has put it at `t`.
        let placed = |name: &str, t: f64| {
            let node = model.animations[clip(name)].channels[0].node;
            model.pose(Some((clip(name), t))).world[node]
        };
        // Linear translation: the keys are (-3.4, 6.8) and (-3.4, 10.8), half a second apart.
        let y = |name: &str, t: f64| placed(name, t).w_axis.y;
        assert!((y("Linear Translation", 0.25) - 8.8).abs() < 1e-5);
        assert!((y("Linear Translation", 0.5) - 10.8).abs() < 1e-5);
        // Step translation holds the key until the next one is reached.
        assert!((y("Step Translation", 0.49) - 6.8).abs() < 1e-5);
        assert!((y("Step Translation", 0.5) - 10.8).abs() < 1e-5);
        // Linear rotation is a slerp: a quarter of a second is half of the
        // 45 degrees about z (clockwise) of the first half second.
        let (_, rotation, _) = placed("Linear Rotation", 0.25).to_scale_rotation_translation();
        let half = (22.5_f64.to_radians() / 2.0).sin_cos();
        assert!(
            rotation.abs_diff_eq(DQuat::from_xyzw(0.0, 0.0, -half.0, half.1), 1e-6),
            "{rotation:?}"
        );
        // A cubic spline passes through its keys, whatever its tangents.
        for name in [
            "CubicSpline Translation",
            "CubicSpline Scale",
            "CubicSpline Rotation",
        ] {
            let channel = &model.animations[clip(name)].channels[0];
            for (k, time) in channel.times.iter().enumerate() {
                let got = channel.sample(f64::from(*time));
                let at_key =
                    &channel.values[(3 * k + 1) * channel.width..(3 * k + 2) * channel.width];
                for (g, w) in got.iter().zip(at_key) {
                    assert!(
                        (g - f64::from(*w)).abs() < 1e-5,
                        "{name} key {k}: {got:?} {at_key:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn the_animated_morph_cube_follows_its_weights() {
        let model = khronos("AnimatedMorphCube.glb");
        assert_eq!(model.animations.len(), 1);
        assert_eq!(model.animations[0].name.as_deref(), Some("Square"));
        assert!((model.animations[0].duration - 4.2).abs() < 1e-3);
        let base = &model.parts[0].mesh.vertices;
        // At 0 both weights are 0: the mesh as the file has it.
        let posed = placed_on_cpu(&model, &model.pose(Some((0, 0.0))));
        assert!(
            posed[0]
                .mesh
                .vertices
                .iter()
                .zip(base)
                .all(|(a, b)| a.position == b.position)
        );
        // At 1.5 s the first target is at nearly full weight (0.98877).
        let pose = model.pose(Some((0, 1.5)));
        let weight = pose.weights[0][0];
        assert!(
            (weight - 0.98877).abs() < 1e-4 && pose.weights[0][1] == 0.0,
            "{:?}",
            pose.weights
        );
        let posed = placed_on_cpu(&model, &pose);
        let data = &model.parts[0].deform.as_ref().unwrap().data;
        for (i, v) in posed[0].mesh.vertices.iter().enumerate() {
            let d = data.targets[i];
            let want = Vec3::from(base[i].position) + Vec3::new(d[0], d[1], d[2]) * weight;
            near32(Vec3::from(v.position), want);
            assert!((Vec3::from(v.normal).length() - 1.0).abs() < 1e-4);
        }
        assert!(
            posed[0]
                .mesh
                .vertices
                .iter()
                .zip(base)
                .any(|(a, b)| a.position != b.position)
        );
    }

    #[test]
    fn the_simple_skin_bends_at_its_joint() {
        let model = khronos("SimpleSkin.gltf");
        assert!((model.animations[0].duration - 5.5).abs() < 1e-6);
        // 1 s in, the upper joint (at y = 1) has turned 90 degrees about z.
        let bent = placed_on_cpu(&model, &model.pose(Some((0, 1.0))));
        // The file has no normals, so each triangle has vertices of its own:
        // vertices are found by where the file puts them.
        let rest = &model.parts[0].mesh.vertices;
        let moved = |from: Vec3, to: Vec3| {
            let found: Vec<_> = (0..rest.len())
                .filter(|&i| Vec3::from(rest[i].position) == from)
                .collect();
            assert!(!found.is_empty(), "{from:?}");
            for i in found {
                near32(position(&bent[0], i), to);
            }
        };
        // The lowest vertices follow the lower joint only.
        moved(Vec3::new(-0.5, 0.0, 0.0), Vec3::new(-0.5, 0.0, 0.0));
        // The top ones follow the upper joint only: they turn about (0, 1).
        moved(Vec3::new(-0.5, 2.0, 0.0), Vec3::new(-1.0, 0.5, 0.0));
        moved(Vec3::new(0.5, 2.0, 0.0), Vec3::new(-1.0, 1.5, 0.0));
        // The middle one, at (-0.5, 1), is half and half: the mean of where each joint puts it.
        moved(Vec3::new(-0.5, 1.0, 0.0), Vec3::new(-0.25, 0.75, 0.0));
        // The clip is back at its start pose at 5.5 s, where the skin is the file's own.
        let home = placed_on_cpu(&model, &model.pose(Some((0, 5.5))));
        for (i, w) in model.parts[0].mesh.vertices.iter().enumerate() {
            near32(position(&home[0], i), Vec3::from(w.position));
        }
    }
}
