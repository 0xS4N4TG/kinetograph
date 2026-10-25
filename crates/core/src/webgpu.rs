//! WebGPU, native: the render passes a page submitted to its canvas, replayed on the shared wgpu device with the
//! page's own WGSL (packages/cli/skills/kinetograph/references/ENGINE.md, "WebGPU").
//!
//! The authoring side (`navigator.gpu` of `@kinetographdev/scene`) records what a frame drew as the `webgpu` part of
//! a `glsl` layer: modules, bind group layouts, pipelines (render and compute), buffer contents at the time of the
//! submit, buffers the GPU wrote, textures and samplers, bind groups and the steps (render and compute passes, texture
//! uploads and copies, buffer writes, copies and clears) in the order the page submitted them.
//! Nothing here reads anything but that, so the layer is a pure function of its recording. This file is the part that
//! needs no GPU: the recording's types, `check`, which reads each module with naga (and the workgroup size of each
//! compute entry point) so that a page's mistake is reported when the frame is painted, not found by the GPU, and
//! `validate`, which bounds-checks every size, offset, mip level and origin of the textures and buffers, every binding
//! and format, and every dispatch before anything is made. The drawing is in `compositor/glsl/webgpu.rs`.

use std::collections::BTreeMap;

use serde::Deserialize;

/// What a WebGPU canvas drew: every id below is a key of the table of its kind.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebGpuContent {
    /// WGSL, by id.
    #[serde(default)]
    pub modules: BTreeMap<String, String>,
    #[serde(default)]
    pub layouts: BTreeMap<String, Vec<BindingLayout>>,
    #[serde(default)]
    pub pipelines: BTreeMap<String, Pipeline>,
    /// Base64 bytes, by id: a buffer as it was when a pass that only reads it was submitted.
    #[serde(default)]
    pub buffers: BTreeMap<String, String>,
    /// Buffers the GPU writes (a storage binding a compute pass writes), by id. They start zeroed; the steps that wrote
    /// them (`WriteBuffer`, `CopyBuffer`, `ClearBuffer`, compute passes) make their contents, as for a texture.
    #[serde(default)]
    pub gpu_buffers: BTreeMap<String, GpuBuffer>,
    #[serde(default)]
    pub compute_pipelines: BTreeMap<String, ComputePipeline>,
    #[serde(default)]
    pub bind_groups: BTreeMap<String, BindGroup>,
    /// The textures the steps and the bind groups use, by id.
    #[serde(default)]
    pub textures: BTreeMap<String, Texture>,
    #[serde(default)]
    pub samplers: BTreeMap<String, SamplerDesc>,
    /// Base64 bytes of what is written into textures, by id.
    #[serde(default)]
    pub blobs: BTreeMap<String, String>,
    /// What the page submitted, in order: render passes (into the canvas or into a texture), uploads and copies.
    #[serde(default)]
    pub passes: Vec<Step>,
    /// Calls the page made that are not drawn.
    #[serde(default)]
    pub notes: Vec<String>,
    /// What the frame reads that earlier frames made (state a page carries): the frame is drawn, but it is not the same
    /// drawn alone, or by another worker, as in a sequence.
    #[serde(default)]
    pub impure: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingLayout {
    pub binding: u32,
    /// `GPUShaderStage` bits.
    pub visibility: u32,
    /// `uniform`, `storage`, `read-only-storage`, `texture`, `storage-texture` or `sampler`.
    #[serde(rename = "type")]
    pub ty: String,
    #[serde(default)]
    pub dynamic_offset: bool,
    /// Of a `texture`: `float` (the default), `unfilterable-float`, `sint` or `uint`.
    #[serde(default)]
    pub sample_type: Option<String>,
    /// Of a `sampler`: `filtering` (the default) or `non-filtering`.
    #[serde(default)]
    pub sampler_type: Option<String>,
    /// Of a `storage-texture`: `write-only` (the default), `read-only` or `read-write`.
    #[serde(default)]
    pub access: Option<String>,
    /// Of a `storage-texture`: the format the shader declares.
    #[serde(default)]
    pub format: Option<String>,
}

/// A buffer the GPU writes: `size` bytes, zeroed until a step writes them.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuBuffer {
    pub size: u64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputePipeline {
    /// Ids of `WebGpuContent::layouts`; none for `layout: 'auto'`.
    pub layout: Option<Vec<String>>,
    pub module: String,
    pub entry_point: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VertexAttribute {
    pub format: String,
    pub offset: u64,
    pub location: u32,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VertexLayout {
    pub stride: u64,
    #[serde(default)]
    pub step_mode: Option<String>,
    #[serde(default)]
    pub attributes: Vec<VertexAttribute>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlendComponent {
    pub operation: Option<String>,
    pub src_factor: Option<String>,
    pub dst_factor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlendState {
    pub color: BlendComponent,
    pub alpha: BlendComponent,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub format: String,
    #[serde(default)]
    pub blend: Option<BlendState>,
    #[serde(default)]
    pub write_mask: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VertexState {
    pub module: String,
    pub entry_point: Option<String>,
    #[serde(default)]
    pub buffers: Vec<VertexLayout>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FragmentState {
    pub module: String,
    pub entry_point: Option<String>,
    #[serde(default)]
    pub targets: Vec<Option<Target>>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Primitive {
    pub topology: String,
    pub strip_index_format: Option<String>,
    pub front_face: String,
    pub cull_mode: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pipeline {
    /// Ids of `WebGpuContent::layouts`; none for `layout: 'auto'`.
    pub layout: Option<Vec<String>>,
    pub vertex: VertexState,
    pub fragment: Option<FragmentState>,
    pub primitive: Primitive,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindEntry {
    pub binding: u32,
    /// Exactly one of `buffer`, `texture` and `sampler`.
    #[serde(default)]
    pub buffer: Option<String>,
    #[serde(default)]
    pub offset: u64,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub texture: Option<TextureView>,
    /// An id of `WebGpuContent::samplers`.
    #[serde(default)]
    pub sampler: Option<String>,
}

/// A view of a texture: `mips` levels from `base_mip`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureView {
    pub id: String,
    #[serde(default)]
    pub base_mip: u32,
    #[serde(default = "one")]
    pub mips: u32,
}

fn one() -> u32 {
    1
}

/// A 2D texture. The recording never holds its contents: the steps that wrote it do.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Texture {
    pub width: u32,
    pub height: u32,
    #[serde(default = "one")]
    pub mips: u32,
    pub format: String,
}

/// A `GPUSamplerDescriptor` without the comparison (depth textures are not drawn).
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplerDesc {
    #[serde(default)]
    pub address_mode_u: Option<String>,
    #[serde(default)]
    pub address_mode_v: Option<String>,
    #[serde(default)]
    pub address_mode_w: Option<String>,
    #[serde(default)]
    pub mag_filter: Option<String>,
    #[serde(default)]
    pub min_filter: Option<String>,
    #[serde(default)]
    pub mipmap_filter: Option<String>,
    #[serde(default)]
    pub lod_min_clamp: Option<f64>,
    #[serde(default)]
    pub lod_max_clamp: Option<f64>,
    #[serde(default)]
    pub max_anisotropy: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindGroup {
    /// An id of `WebGpuContent::layouts`, or `auto:<pipeline>:<index>`.
    pub layout: String,
    #[serde(default)]
    pub entries: Vec<BindEntry>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "c", rename_all = "camelCase")]
pub enum Command {
    Pipeline {
        id: String,
    },
    Bind {
        index: u32,
        group: String,
        #[serde(default)]
        offsets: Vec<u32>,
    },
    Vertex {
        slot: u32,
        buffer: String,
        #[serde(default)]
        offset: u64,
        size: Option<u64>,
    },
    Index {
        buffer: String,
        format: String,
        #[serde(default)]
        offset: u64,
        size: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Draw {
        vertices: u32,
        instances: u32,
        first: u32,
        first_instance: u32,
    },
    #[serde(rename_all = "camelCase")]
    DrawIndexed {
        indices: u32,
        instances: u32,
        first: u32,
        base: i32,
        first_instance: u32,
    },
    #[serde(rename_all = "camelCase")]
    Viewport {
        x: f32,
        y: f32,
        width: f32,
        height: f32,
        min_depth: f32,
        max_depth: f32,
    },
    Scissor {
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    },
    Blend {
        color: [f64; 4],
    },
}

/// One mip level of a texture a render pass draws into.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PassTarget {
    pub texture: String,
    #[serde(default)]
    pub mip: u32,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pass {
    /// The texture drawn into; none is the canvas.
    #[serde(default)]
    pub target: Option<PassTarget>,
    /// The clear colour; none loads what the canvas (or the texture) holds.
    pub clear: Option<[f64; 4]>,
    #[serde(default)]
    pub commands: Vec<Command>,
}

/// Where the pixels of an upload come from. Pictures are decoded at replay, so a recording holds a path, not pixels.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    /// Bytes in the texture's own format, tightly packed (`writeTexture`, `copyBufferToTexture`): a blob id.
    Raw(String),
    /// Straight RGBA8 of `width` x `height` (an `ImageData`, a canvas): a blob id.
    Pixels { id: String, width: u32, height: u32 },
    /// A picture file relative to the scene, or a `data:` URL.
    Src(String),
    /// The frame of a video file `time` seconds after its first picture.
    Video { src: String, time: f64 },
    /// A child of the shader group the recording belongs to, drawn.
    Layer(String),
}

/// `writeTexture`, `copyBufferToTexture` and `copyExternalImageToTexture`: `width` x `height` texels of `source`
/// (from `sx`, `sy`) at `x`, `y` of mip level `mip`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Upload {
    pub texture: String,
    #[serde(default)]
    pub mip: u32,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub source: Source,
    #[serde(default)]
    pub sx: u32,
    #[serde(default)]
    pub sy: u32,
    /// Turn the picture over (rows from the bottom).
    #[serde(default)]
    pub flip_y: bool,
    /// Multiply the colour by the alpha.
    #[serde(default)]
    pub premultiply: bool,
}

/// A corner of a rectangle of a texture's mip level.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Corner {
    pub texture: String,
    #[serde(default)]
    pub mip: u32,
    pub x: u32,
    pub y: u32,
}

/// `copyTextureToTexture`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureCopy {
    pub from: Corner,
    pub to: Corner,
    pub width: u32,
    pub height: u32,
}

/// What a compute pass does: set a pipeline and bind groups, dispatch.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "c", rename_all = "camelCase")]
pub enum ComputeCommand {
    Pipeline {
        id: String,
    },
    Bind {
        index: u32,
        group: String,
        #[serde(default)]
        offsets: Vec<u32>,
    },
    Dispatch {
        x: u32,
        y: u32,
        z: u32,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputePass {
    #[serde(default)]
    pub commands: Vec<ComputeCommand>,
}

/// `queue.writeBuffer` (or a buffer to buffer copy from a buffer the GPU did not write) into a buffer the GPU writes:
/// `data` is a blob id.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferWrite {
    pub buffer: String,
    #[serde(default)]
    pub offset: u64,
    pub data: String,
}

/// `copyBufferToBuffer` between two buffers the GPU writes.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferCopy {
    pub from: String,
    #[serde(default)]
    pub from_offset: u64,
    pub to: String,
    #[serde(default)]
    pub to_offset: u64,
    pub size: u64,
}

/// `clearBuffer` of a buffer the GPU writes.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferClear {
    pub buffer: String,
    #[serde(default)]
    pub offset: u64,
    pub size: u64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "k", rename_all = "camelCase")]
pub enum Step {
    Render(Pass),
    Upload(Upload),
    Copy(TextureCopy),
    Compute(ComputePass),
    WriteBuffer(BufferWrite),
    CopyBuffer(BufferCopy),
    ClearBuffer(BufferClear),
}

/// What the device allows: the limits of the engine's own wgpu device (`compositor/glsl/webgpu.rs` reads them from it),
/// which are the WebGPU defaults unless the device was asked for more. The page side reports the same numbers as
/// `device.limits`.
#[derive(Clone, Debug, PartialEq)]
pub struct Limits {
    pub max_texture_dimension_2d: u32,
    pub max_bind_groups: u32,
    pub max_buffer_size: u64,
    pub max_uniform_buffer_binding_size: u64,
    pub max_storage_buffer_binding_size: u64,
    pub min_uniform_buffer_offset_alignment: u64,
    pub min_storage_buffer_offset_alignment: u64,
    pub max_storage_buffers_per_shader_stage: u32,
    pub max_storage_textures_per_shader_stage: u32,
    pub max_compute_workgroup_storage_size: u32,
    pub max_compute_invocations_per_workgroup: u32,
    pub max_compute_workgroup_size_x: u32,
    pub max_compute_workgroup_size_y: u32,
    pub max_compute_workgroup_size_z: u32,
    pub max_compute_workgroups_per_dimension: u32,
    /// Whether `float` texture bindings may hold 32-bit float formats (the `float32-filterable` feature).
    pub float32_filterable: bool,
}

impl Default for Limits {
    /// The WebGPU defaults.
    fn default() -> Self {
        Limits {
            max_texture_dimension_2d: 8192,
            max_bind_groups: 4,
            max_buffer_size: 256 << 20,
            max_uniform_buffer_binding_size: 65536,
            max_storage_buffer_binding_size: 128 << 20,
            min_uniform_buffer_offset_alignment: 256,
            min_storage_buffer_offset_alignment: 256,
            max_storage_buffers_per_shader_stage: 8,
            max_storage_textures_per_shader_stage: 4,
            max_compute_workgroup_storage_size: 16384,
            max_compute_invocations_per_workgroup: 256,
            max_compute_workgroup_size_x: 256,
            max_compute_workgroup_size_y: 256,
            max_compute_workgroup_size_z: 64,
            max_compute_workgroups_per_dimension: 65535,
            float32_filterable: false,
        }
    }
}

/// The limits of `device`, which the recording is checked against and the page side reports as `device.limits`.
pub fn device_limits(device: &wgpu::Device) -> Limits {
    let l = device.limits();
    Limits {
        max_texture_dimension_2d: l.max_texture_dimension_2d,
        max_bind_groups: l.max_bind_groups,
        max_buffer_size: l.max_buffer_size,
        max_uniform_buffer_binding_size: l.max_uniform_buffer_binding_size,
        max_storage_buffer_binding_size: l.max_storage_buffer_binding_size,
        min_uniform_buffer_offset_alignment: u64::from(l.min_uniform_buffer_offset_alignment),
        min_storage_buffer_offset_alignment: u64::from(l.min_storage_buffer_offset_alignment),
        max_storage_buffers_per_shader_stage: l.max_storage_buffers_per_shader_stage,
        max_storage_textures_per_shader_stage: l.max_storage_textures_per_shader_stage,
        max_compute_workgroup_storage_size: l.max_compute_workgroup_storage_size,
        max_compute_invocations_per_workgroup: l.max_compute_invocations_per_workgroup,
        max_compute_workgroup_size_x: l.max_compute_workgroup_size_x,
        max_compute_workgroup_size_y: l.max_compute_workgroup_size_y,
        max_compute_workgroup_size_z: l.max_compute_workgroup_size_z,
        max_compute_workgroups_per_dimension: l.max_compute_workgroups_per_dimension,
        float32_filterable: device.features().contains(wgpu::Features::FLOAT32_FILTERABLE),
    }
}

/// What `navigator.gpu` reports: the limits of the engine's device by their WebGPU names, and the WebGPU features it has
/// that the recorder draws.
pub fn device_info(device: &wgpu::Device) -> serde_json::Value {
    let l = device_limits(device);
    let w = device.limits();
    let mut features = Vec::new();
    if l.float32_filterable {
        features.push("float32-filterable");
    }
    serde_json::json!({
        "features": features,
        "limits": {
            "maxTextureDimension1D": w.max_texture_dimension_1d,
            "maxTextureDimension2D": w.max_texture_dimension_2d,
            "maxTextureDimension3D": w.max_texture_dimension_3d,
            "maxTextureArrayLayers": w.max_texture_array_layers,
            "maxBindGroups": w.max_bind_groups,
            "maxBindingsPerBindGroup": w.max_bindings_per_bind_group,
            "maxDynamicUniformBuffersPerPipelineLayout": w.max_dynamic_uniform_buffers_per_pipeline_layout,
            "maxDynamicStorageBuffersPerPipelineLayout": w.max_dynamic_storage_buffers_per_pipeline_layout,
            "maxSampledTexturesPerShaderStage": w.max_sampled_textures_per_shader_stage,
            "maxSamplersPerShaderStage": w.max_samplers_per_shader_stage,
            "maxStorageBuffersPerShaderStage": w.max_storage_buffers_per_shader_stage,
            "maxStorageTexturesPerShaderStage": w.max_storage_textures_per_shader_stage,
            "maxUniformBuffersPerShaderStage": w.max_uniform_buffers_per_shader_stage,
            "maxUniformBufferBindingSize": w.max_uniform_buffer_binding_size,
            "maxStorageBufferBindingSize": w.max_storage_buffer_binding_size,
            "minUniformBufferOffsetAlignment": w.min_uniform_buffer_offset_alignment,
            "minStorageBufferOffsetAlignment": w.min_storage_buffer_offset_alignment,
            "maxVertexBuffers": w.max_vertex_buffers,
            "maxBufferSize": w.max_buffer_size,
            "maxVertexAttributes": w.max_vertex_attributes,
            "maxVertexBufferArrayStride": w.max_vertex_buffer_array_stride,
            "maxColorAttachments": w.max_color_attachments,
            "maxColorAttachmentBytesPerSample": w.max_color_attachment_bytes_per_sample,
            "maxComputeWorkgroupStorageSize": w.max_compute_workgroup_storage_size,
            "maxComputeInvocationsPerWorkgroup": w.max_compute_invocations_per_workgroup,
            "maxComputeWorkgroupSizeX": w.max_compute_workgroup_size_x,
            "maxComputeWorkgroupSizeY": w.max_compute_workgroup_size_y,
            "maxComputeWorkgroupSizeZ": w.max_compute_workgroup_size_z,
            "maxComputeWorkgroupsPerDimension": w.max_compute_workgroups_per_dimension,
        },
    })
}

/// Reads every module of the recording with naga. Returns what is wrong with each, as `module id: message`, for the
/// painter to report; a layer with a module that is wrong draws nothing.
pub fn check(content: &WebGpuContent) -> Vec<String> {
    check_with(content, &Limits::default())
}

/// `check`, and the workgroup size of each compute entry point against `limits`.
pub fn check_with(content: &WebGpuContent, limits: &Limits) -> Vec<String> {
    let mut problems = Vec::new();
    let mut modules = BTreeMap::new();
    for (id, code) in &content.modules {
        match parse(code) {
            Ok(module) => {
                modules.insert(id.as_str(), module);
            }
            Err(message) => problems.push(format!("WGSL module {id}: {message}")),
        }
    }
    for (id, pipeline) in &content.compute_pipelines {
        let Some(module) = modules.get(pipeline.module.as_str()) else { continue };
        if let Err(message) = compute_entry(module, pipeline.entry_point.as_deref(), limits) {
            problems.push(format!("compute pipeline {id}: {message}"));
        }
    }
    problems
}

/// The compute entry point `name` names (or the only one a module has), with its workgroup size inside `limits`.
fn compute_entry(module: &naga::Module, name: Option<&str>, limits: &Limits) -> Result<(), String> {
    let entry = match name {
        Some(name) => module.entry_points.iter().find(|e| e.name == name).ok_or_else(|| format!("the module has no entry point {name}"))?,
        None => {
            let mut all = module.entry_points.iter();
            match (all.next(), all.next()) {
                (Some(only), None) => only,
                _ => return Err("the entry point is not named and the module does not have exactly one".into()),
            }
        }
    };
    if entry.stage != naga::ShaderStage::Compute {
        return Err(format!("the entry point {} is not a @compute function", entry.name));
    }
    let [x, y, z] = entry.workgroup_size;
    let (x, y, z) = (u64::from(x), u64::from(y), u64::from(z));
    if x > u64::from(limits.max_compute_workgroup_size_x) || y > u64::from(limits.max_compute_workgroup_size_y) || z > u64::from(limits.max_compute_workgroup_size_z) {
        return Err(format!(
            "workgroup_size({x}, {y}, {z}) is over the device's {} x {} x {} a side",
            limits.max_compute_workgroup_size_x, limits.max_compute_workgroup_size_y, limits.max_compute_workgroup_size_z
        ));
    }
    if x * y * z > u64::from(limits.max_compute_invocations_per_workgroup) {
        return Err(format!("workgroup_size({x}, {y}, {z}) is {} invocations; the device allows {}", x * y * z, limits.max_compute_invocations_per_workgroup));
    }
    Ok(())
}

/// A module read and validated.
pub fn parse(code: &str) -> Result<naga::Module, String> {
    let module = naga::front::wgsl::parse_str(code).map_err(|e| e.emit_to_string(code))?;
    naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    )
    .validate(&module)
    .map_err(|e| e.emit_to_string(code))?;
    Ok(module)
}

/// The most texture memory one frame's recording may ask for, all mip levels together.
pub const MAX_TEXTURE_BYTES: u64 = 512 << 20;
/// The most memory the buffers the GPU writes may hold together.
pub const MAX_GPU_BUFFER_BYTES: u64 = 1 << 30;
/// The most steps (passes, uploads, copies) a recording may hold.
pub const MAX_STEPS: usize = 4096;
/// The most dispatches, and the most workgroups all of them together launch, in one frame.
pub const MAX_DISPATCHES: usize = 4096;
pub const MAX_WORKGROUPS: u64 = 1 << 26;

/// How a texture of a format is read by a shader.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sample {
    /// Filterable float.
    Float,
    /// Float that is read without filtering (the 32-bit float formats).
    Unfilterable,
    Uint,
    Sint,
}

/// What a storage binding of a format may do (without optional features).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Storage {
    No,
    Write,
    ReadWrite,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FormatInfo {
    pub bytes: u64,
    pub sample: Sample,
    pub storage: Storage,
}

/// The texture formats that are drawn: the bytes of a texel, how a shader samples it, and the storage access it allows
/// (WebGPU's table; the optional formats and features are not offered).
pub fn format_info(format: &str) -> Option<FormatInfo> {
    use Sample::{Float, Sint, Uint, Unfilterable};
    use Storage::{No, ReadWrite, Write};
    let (bytes, sample, storage) = match format {
        "r8unorm" => (1, Float, No),
        "r8uint" => (1, Uint, No),
        "r8sint" => (1, Sint, No),
        "rg8unorm" => (2, Float, No),
        "rg8uint" => (2, Uint, No),
        "rg8sint" => (2, Sint, No),
        "rgba8unorm" => (4, Float, Write),
        "rgba8unorm-srgb" => (4, Float, No),
        "rgba8snorm" => (4, Float, Write),
        "rgba8uint" => (4, Uint, Write),
        "rgba8sint" => (4, Sint, Write),
        "bgra8unorm" | "bgra8unorm-srgb" => (4, Float, No),
        "rgb10a2unorm" => (4, Float, No),
        "r16uint" => (2, Uint, No),
        "r16sint" => (2, Sint, No),
        "r16float" => (2, Float, No),
        "rg16uint" => (4, Uint, No),
        "rg16sint" => (4, Sint, No),
        "rg16float" => (4, Float, No),
        "rgba16uint" => (8, Uint, Write),
        "rgba16sint" => (8, Sint, Write),
        "rgba16float" => (8, Float, Write),
        "r32uint" => (4, Uint, ReadWrite),
        "r32sint" => (4, Sint, ReadWrite),
        "r32float" => (4, Unfilterable, ReadWrite),
        "rg32uint" => (8, Uint, Write),
        "rg32sint" => (8, Sint, Write),
        "rg32float" => (8, Unfilterable, Write),
        "rgba32uint" => (16, Uint, Write),
        "rgba32sint" => (16, Sint, Write),
        "rgba32float" => (16, Unfilterable, Write),
        _ => return None,
    };
    Some(FormatInfo { bytes, sample, storage })
}

/// The formats a texture may have, for the error that names them.
pub const TEXTURE_FORMATS: &str = "r8unorm, r8uint, r8sint, rg8unorm, rg8uint, rg8sint, rgba8unorm, rgba8unorm-srgb, rgba8snorm, rgba8uint, rgba8sint, bgra8unorm, bgra8unorm-srgb, rgb10a2unorm, r16uint, r16sint, r16float, rg16uint, rg16sint, rg16float, rgba16uint, rgba16sint, rgba16float, r32uint, r32sint, r32float, rg32uint, rg32sint, rg32float, rgba32uint, rgba32sint and rgba32float";

/// The bytes of a texel of `format`, for the formats that are drawn.
pub fn texel_bytes(format: &str) -> Option<u64> {
    format_info(format).map(|f| f.bytes)
}

/// The formats a picture is uploaded into: 8-bit with four channels, which a picture's RGBA converts to directly.
pub fn is_picture_format(format: &str) -> bool {
    matches!(format, "rgba8unorm" | "rgba8unorm-srgb" | "bgra8unorm" | "bgra8unorm-srgb")
}

/// A format without `-srgb`: formats that differ only in that can be copied between.
fn linear_name(format: &str) -> &str {
    format.strip_suffix("-srgb").unwrap_or(format)
}

/// How many mip levels a texture of this size can have.
pub fn max_mips(width: u32, height: u32) -> u32 {
    32 - width.max(height).max(1).leading_zeros()
}

/// The size of mip level `level` (a side never drops below one).
pub fn mip_extent(texture: &Texture, level: u32) -> (u32, u32) {
    let shift = level.min(31);
    ((texture.width >> shift).max(1), (texture.height >> shift).max(1))
}

/// What a texture holds with all its levels, if it is a texture the device makes: a known format, sides from 1 to
/// `max_dim`, and a level count the size allows. Overflow is an error, not a wrap.
pub fn texture_bytes(texture: &Texture, max_dim: u32) -> Result<u64, String> {
    let bytes = texel_bytes(&texture.format).ok_or_else(|| format!("a texture of format {}; the formats drawn are {TEXTURE_FORMATS}", texture.format))?;
    if texture.width == 0 || texture.height == 0 || texture.width > max_dim || texture.height > max_dim {
        return Err(format!("a {} x {} texture; the sides run from 1 to {max_dim}", texture.width, texture.height));
    }
    let most = max_mips(texture.width, texture.height);
    if texture.mips == 0 || texture.mips > most {
        return Err(format!("{} mip levels for a {} x {} texture (at most {most})", texture.mips, texture.width, texture.height));
    }
    let mut total = 0u64;
    for level in 0..texture.mips {
        let (w, h) = mip_extent(texture, level);
        let level_bytes = u64::from(w)
            .checked_mul(u64::from(h))
            .and_then(|n| n.checked_mul(bytes))
            .ok_or("a texture's size overflows")?;
        total = total.checked_add(level_bytes).ok_or("a texture's size overflows")?;
    }
    Ok(total)
}

/// Whether the rectangle `x`, `y`, `width` x `height` lies inside a picture of `bounds`, without overflow.
pub fn rect_in(what: &str, bounds: (u32, u32), x: u32, y: u32, width: u32, height: u32) -> Result<(), String> {
    let right = x.checked_add(width).ok_or_else(|| format!("{what}: the rectangle's right edge overflows"))?;
    let bottom = y.checked_add(height).ok_or_else(|| format!("{what}: the rectangle's bottom edge overflows"))?;
    if right > bounds.0 || bottom > bounds.1 {
        return Err(format!("{what}: the rectangle {x},{y} {width} x {height} is outside the {} x {} it is in", bounds.0, bounds.1));
    }
    Ok(())
}

/// The bytes `width` x `height` texels of `texel` bytes take, tightly packed.
pub fn packed_len(width: u32, height: u32, texel: u64) -> Result<usize, String> {
    let n = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|n| n.checked_mul(texel))
        .ok_or("the size of an upload overflows")?;
    usize::try_from(n).map_err(|_| "the size of an upload overflows".to_string())
}

/// The bytes a base64 string decodes to, without decoding it.
pub fn base64_len(base64: &str) -> u64 {
    let padding = base64.bytes().rev().take_while(|b| *b == b'=').count().min(2) as u64;
    (base64.len() as u64 / 4 * 3).saturating_sub(padding)
}

fn texture_of<'a>(content: &'a WebGpuContent, id: &str) -> Result<&'a Texture, String> {
    content.textures.get(id).ok_or_else(|| format!("texture {id} is not in the recording"))
}

fn level_of(texture: &Texture, id: &str, level: u32) -> Result<(u32, u32), String> {
    if level >= texture.mips {
        return Err(format!("mip level {level} of the texture {id}, which has {}", texture.mips));
    }
    Ok(mip_extent(texture, level))
}

/// A view of the texture: its levels are the texture's.
fn view_of(content: &WebGpuContent, view: &TextureView) -> Result<(), String> {
    let texture = texture_of(content, &view.id)?;
    let end = view.base_mip.checked_add(view.mips).ok_or("a view's mip range overflows")?;
    if view.mips == 0 || end > texture.mips {
        return Err(format!("a view of the levels {}..{end} of the texture {}, which has {}", view.base_mip, view.id, texture.mips));
    }
    Ok(())
}

fn sampler_checks(id: &str, s: &SamplerDesc) -> Result<(), String> {
    for (what, mode) in [("addressModeU", &s.address_mode_u), ("addressModeV", &s.address_mode_v), ("addressModeW", &s.address_mode_w)] {
        if let Some(m) = mode
            && !matches!(m.as_str(), "clamp-to-edge" | "repeat" | "mirror-repeat")
        {
            return Err(format!("sampler {id}: {what} {m}"));
        }
    }
    for (what, filter) in [("magFilter", &s.mag_filter), ("minFilter", &s.min_filter), ("mipmapFilter", &s.mipmap_filter)] {
        if let Some(f) = filter
            && !matches!(f.as_str(), "nearest" | "linear")
        {
            return Err(format!("sampler {id}: {what} {f}"));
        }
    }
    let (min, max) = (s.lod_min_clamp.unwrap_or(0.0), s.lod_max_clamp.unwrap_or(32.0));
    if !(min.is_finite() && max.is_finite() && min >= 0.0 && min <= max) {
        return Err(format!("sampler {id}: lodMinClamp {min} and lodMaxClamp {max} are not a range from 0 up"));
    }
    let anisotropy = s.max_anisotropy.unwrap_or(1);
    if !(1..=16).contains(&anisotropy) {
        return Err(format!("sampler {id}: maxAnisotropy {anisotropy} is not from 1 to 16"));
    }
    if anisotropy > 1 && [&s.mag_filter, &s.min_filter, &s.mipmap_filter].iter().any(|f| f.as_deref() != Some("linear")) {
        return Err(format!("sampler {id}: maxAnisotropy above 1 needs linear magFilter, minFilter and mipmapFilter"));
    }
    Ok(())
}

/// `validate_with` the WebGPU default limits but for the texture side.
pub fn validate(content: &WebGpuContent, max_dim: u32) -> Result<(), String> {
    validate_with(content, &Limits { max_texture_dimension_2d: max_dim, ..Limits::default() })
}

/// What a bind group layout binding holds, for the checks of a group made with it.
fn layout_entry<'a>(content: &'a WebGpuContent, group: &BindGroup, binding: u32) -> Option<&'a BindingLayout> {
    content.layouts.get(&group.layout)?.iter().find(|l| l.binding == binding)
}

/// The length of a buffer of the recording, of either kind.
fn buffer_len(content: &WebGpuContent, id: &str) -> Option<u64> {
    content.gpu_buffers.get(id).map(|b| b.size).or_else(|| content.buffers.get(id).map(|b| base64_len(b)))
}

/// Checks every size, offset, level, origin, binding, format and dispatch of the recording, so that replaying it cannot
/// index outside a texture or a buffer or launch more work than the frame may. Returns the first thing that is wrong,
/// for the painter to report; a layer that fails draws nothing.
pub fn validate_with(content: &WebGpuContent, limits: &Limits) -> Result<(), String> {
    let max_dim = limits.max_texture_dimension_2d;
    if content.passes.len() > MAX_STEPS {
        return Err(format!("{} steps in a frame (at most {MAX_STEPS})", content.passes.len()));
    }
    let mut total = 0u64;
    for (id, texture) in &content.textures {
        let bytes = texture_bytes(texture, max_dim).map_err(|e| format!("texture {id}: {e}"))?;
        total = total.checked_add(bytes).ok_or("the textures together overflow")?;
    }
    if total > MAX_TEXTURE_BYTES {
        return Err(format!("the frame's textures hold {total} bytes, over the cap of {MAX_TEXTURE_BYTES}"));
    }
    let mut gpu_total = 0u64;
    for (id, buffer) in &content.gpu_buffers {
        if buffer.size == 0 || buffer.size > limits.max_buffer_size {
            return Err(format!("buffer {id}: {} bytes; a buffer holds 1 to {} bytes", buffer.size, limits.max_buffer_size));
        }
        gpu_total = gpu_total.checked_add(buffer.size).ok_or("the buffers together overflow")?;
    }
    if gpu_total > MAX_GPU_BUFFER_BYTES {
        return Err(format!("the frame's buffers hold {gpu_total} bytes, over the cap of {MAX_GPU_BUFFER_BYTES}"));
    }
    for (id, sampler) in &content.samplers {
        sampler_checks(id, sampler)?;
    }
    for (id, layout) in &content.layouts {
        layout_checks(id, layout, limits)?;
    }
    for (id, pipeline) in &content.compute_pipelines {
        if !content.modules.contains_key(&pipeline.module) {
            return Err(format!("compute pipeline {id}: module {} is not in the recording", pipeline.module));
        }
        for layout in pipeline.layout.iter().flatten() {
            if !content.layouts.contains_key(layout) {
                return Err(format!("compute pipeline {id}: bind group layout {layout} is not in the recording"));
            }
        }
        if pipeline.layout.as_ref().is_some_and(|l| l.len() as u32 > limits.max_bind_groups) {
            return Err(format!("compute pipeline {id}: more than {} bind group layouts", limits.max_bind_groups));
        }
    }
    for (id, group) in &content.bind_groups {
        group_checks(content, id, group, limits)?;
    }
    let (mut dispatches, mut workgroups) = (0usize, 0u64);
    for (n, step) in content.passes.iter().enumerate() {
        validate_step(content, step, limits, &mut dispatches, &mut workgroups).map_err(|e| format!("step {n}: {e}"))?;
    }
    Ok(())
}

/// A bind group layout: known binding types, formats a storage texture may have, and the bindings of a stage counted.
fn layout_checks(id: &str, layout: &[BindingLayout], limits: &Limits) -> Result<(), String> {
    let (mut buffers, mut textures) = ([0u32; 3], [0u32; 3]);
    for (n, e) in layout.iter().enumerate() {
        if layout[..n].iter().any(|o| o.binding == e.binding) {
            return Err(format!("layout {id}: binding {} twice", e.binding));
        }
        if e.visibility == 0 || e.visibility > 7 {
            return Err(format!("layout {id}: binding {} is visible to stages {} (the bits are 1, 2 and 4)", e.binding, e.visibility));
        }
        match e.ty.as_str() {
            "uniform" | "read-only-storage" | "sampler" | "texture" => {}
            "storage" => {
                if e.visibility & 1 != 0 {
                    return Err(format!("layout {id}: binding {} is a read-write storage buffer visible to the vertex stage", e.binding));
                }
            }
            "storage-texture" => {
                let format = e.format.as_deref().ok_or_else(|| format!("layout {id}: binding {} is a storage texture without a format", e.binding))?;
                let info = format_info(format).ok_or_else(|| format!("layout {id}: binding {} is a storage texture of format {format}", e.binding))?;
                let access = e.access.as_deref().unwrap_or("write-only");
                match (access, info.storage) {
                    (_, Storage::No) => return Err(format!("layout {id}: binding {}: {format} cannot be a storage texture", e.binding)),
                    ("write-only", _) | ("read-only" | "read-write", Storage::ReadWrite) => {}
                    ("read-only" | "read-write", _) => return Err(format!("layout {id}: binding {}: {format} is a {access} storage texture only with an optional feature (r32float, r32uint and r32sint are not)", e.binding)),
                    (other, _) => return Err(format!("layout {id}: binding {}: storage texture access {other}", e.binding)),
                }
                if e.visibility & 1 != 0 {
                    return Err(format!("layout {id}: binding {} is a storage texture visible to the vertex stage", e.binding));
                }
            }
            other => return Err(format!("layout {id}: binding {} has the type {other}", e.binding)),
        }
        for (stage, bit) in [1u32, 2, 4].into_iter().enumerate() {
            if e.visibility & bit != 0 {
                if matches!(e.ty.as_str(), "storage" | "read-only-storage") {
                    buffers[stage] += 1;
                }
                if e.ty == "storage-texture" {
                    textures[stage] += 1;
                }
            }
        }
    }
    if buffers.iter().any(|n| *n > limits.max_storage_buffers_per_shader_stage) {
        return Err(format!("layout {id}: more than {} storage buffers in a stage", limits.max_storage_buffers_per_shader_stage));
    }
    if textures.iter().any(|n| *n > limits.max_storage_textures_per_shader_stage) {
        return Err(format!("layout {id}: more than {} storage textures in a stage", limits.max_storage_textures_per_shader_stage));
    }
    Ok(())
}

/// A bind group: each entry names one resource that exists and is in range, and, when the layout is the page's own,
/// is what the layout says the binding holds.
fn group_checks(content: &WebGpuContent, id: &str, group: &BindGroup, limits: &Limits) -> Result<(), String> {
    for entry in &group.entries {
        let kinds = usize::from(entry.buffer.is_some()) + usize::from(entry.texture.is_some()) + usize::from(entry.sampler.is_some());
        if kinds != 1 {
            return Err(format!("bind group {id}: binding {} must name one of a buffer, a texture and a sampler", entry.binding));
        }
        if let Some(view) = &entry.texture {
            view_of(content, view).map_err(|e| format!("bind group {id}: {e}"))?;
        }
        if let Some(sampler) = &entry.sampler
            && !content.samplers.contains_key(sampler)
        {
            return Err(format!("bind group {id}: sampler {sampler} is not in the recording"));
        }
        let layout = layout_entry(content, group, entry.binding);
        if let Some(buffer) = &entry.buffer {
            let length = buffer_len(content, buffer).ok_or_else(|| format!("bind group {id}: buffer {buffer} is not in the recording"))?;
            let end = entry.offset.checked_add(entry.size).ok_or_else(|| format!("bind group {id}: a buffer range overflows"))?;
            if entry.size == 0 || end > length {
                return Err(format!("bind group {id}: binding {} names the bytes {}..{end} of a buffer of {length}", entry.binding, entry.offset));
            }
            match layout.map(|l| l.ty.as_str()) {
                Some("uniform") => {
                    if entry.size > limits.max_uniform_buffer_binding_size {
                        return Err(format!("bind group {id}: a uniform binding of {} bytes; the device allows {}", entry.size, limits.max_uniform_buffer_binding_size));
                    }
                    if entry.offset % limits.min_uniform_buffer_offset_alignment != 0 {
                        return Err(format!("bind group {id}: the offset {} of a uniform binding is not a multiple of {}", entry.offset, limits.min_uniform_buffer_offset_alignment));
                    }
                }
                Some("storage" | "read-only-storage") => {
                    if entry.size > limits.max_storage_buffer_binding_size {
                        return Err(format!("bind group {id}: a storage binding of {} bytes; the device allows {}", entry.size, limits.max_storage_buffer_binding_size));
                    }
                    if entry.offset % limits.min_storage_buffer_offset_alignment != 0 {
                        return Err(format!("bind group {id}: the offset {} of a storage binding is not a multiple of {}", entry.offset, limits.min_storage_buffer_offset_alignment));
                    }
                }
                Some(other) => return Err(format!("bind group {id}: binding {} holds a buffer and the layout says {other}", entry.binding)),
                None => {}
            }
        }
        if let (Some(view), Some(l)) = (&entry.texture, layout) {
            let texture = texture_of(content, &view.id)?;
            let info = format_info(&texture.format).ok_or_else(|| format!("bind group {id}: a texture of format {}", texture.format))?;
            match l.ty.as_str() {
                "texture" => {
                    let wanted = l.sample_type.as_deref().unwrap_or("float");
                    let ok = match wanted {
                        "float" => info.sample == Sample::Float || (info.sample == Sample::Unfilterable && limits.float32_filterable),
                        "unfilterable-float" => matches!(info.sample, Sample::Float | Sample::Unfilterable),
                        "uint" => info.sample == Sample::Uint,
                        "sint" => info.sample == Sample::Sint,
                        other => return Err(format!("bind group {id}: texture sample type {other}")),
                    };
                    if !ok {
                        return Err(format!(
                            "bind group {id}: binding {} samples a {} texture as {wanted}{}",
                            entry.binding,
                            texture.format,
                            if info.sample == Sample::Unfilterable { " (a 32-bit float texture is read as unfilterable-float, with a non-filtering sampler)" } else { "" }
                        ));
                    }
                }
                "storage-texture" => {
                    if view.mips != 1 {
                        return Err(format!("bind group {id}: binding {} is a storage texture and its view has {} levels; it takes one", entry.binding, view.mips));
                    }
                    if l.format.as_deref() != Some(texture.format.as_str()) {
                        return Err(format!("bind group {id}: binding {} is a storage texture of {} in the layout and the view is of a {} texture", entry.binding, l.format.as_deref().unwrap_or("?"), texture.format));
                    }
                }
                other => return Err(format!("bind group {id}: binding {} holds a texture and the layout says {other}", entry.binding)),
            }
        }
        if entry.sampler.is_some()
            && let Some(l) = layout
            && l.ty != "sampler"
        {
            return Err(format!("bind group {id}: binding {} holds a sampler and the layout says {}", entry.binding, l.ty));
        }
    }
    if let Some(layout) = content.layouts.get(&group.layout) {
        for l in layout {
            if !group.entries.iter().any(|e| e.binding == l.binding) {
                return Err(format!("bind group {id}: the layout has a binding {} and the group does not", l.binding));
            }
        }
    }
    Ok(())
}

fn validate_step(content: &WebGpuContent, step: &Step, limits: &Limits, dispatches: &mut usize, workgroups: &mut u64) -> Result<(), String> {
    match step {
        Step::Render(pass) => {
            if let Some(target) = &pass.target {
                let texture = texture_of(content, &target.texture)?;
                level_of(texture, &target.texture, target.mip)?;
            }
            if let Some(clear) = pass.clear
                && !clear.iter().all(|c| c.is_finite())
            {
                return Err("the clear colour is not finite".into());
            }
            for command in &pass.commands {
                if let Command::Bind { index, group, .. } = command {
                    bind_checks(content, *index, group, limits)?;
                }
            }
        }
        Step::Compute(pass) => {
            let mut pipeline = false;
            for command in &pass.commands {
                match command {
                    ComputeCommand::Pipeline { id } => {
                        if !content.compute_pipelines.contains_key(id) {
                            return Err(format!("compute pipeline {id} is not in the recording"));
                        }
                        pipeline = true;
                    }
                    ComputeCommand::Bind { index, group, .. } => bind_checks(content, *index, group, limits)?,
                    ComputeCommand::Dispatch { x, y, z } => {
                        if !pipeline {
                            return Err("dispatchWorkgroups before setPipeline".into());
                        }
                        let max = limits.max_compute_workgroups_per_dimension;
                        if *x > max || *y > max || *z > max {
                            return Err(format!("dispatchWorkgroups({x}, {y}, {z}): a dimension is over the device's {max}"));
                        }
                        *dispatches += 1;
                        *workgroups = workgroups.saturating_add(u64::from(*x) * u64::from(*y) * u64::from(*z));
                        if *dispatches > MAX_DISPATCHES {
                            return Err(format!("more than {MAX_DISPATCHES} dispatches in a frame"));
                        }
                        if *workgroups > MAX_WORKGROUPS {
                            return Err(format!("the frame's dispatches launch more than {MAX_WORKGROUPS} workgroups"));
                        }
                    }
                }
            }
        }
        Step::WriteBuffer(w) => {
            let buffer = content.gpu_buffers.get(&w.buffer).ok_or_else(|| format!("buffer {} is not one the GPU writes", w.buffer))?;
            let blob = content.blobs.get(&w.data).ok_or_else(|| format!("data {} is not in the recording", w.data))?;
            let length = base64_len(blob);
            let end = w.offset.checked_add(length).ok_or("a buffer write overflows")?;
            if end > buffer.size {
                return Err(format!("a write of the bytes {}..{end} into the buffer {} of {} bytes", w.offset, w.buffer, buffer.size));
            }
            if w.offset % 4 != 0 || !length.is_multiple_of(4) {
                return Err("a buffer write of an offset or a size that is not a multiple of 4".into());
            }
        }
        Step::CopyBuffer(c) => {
            let from = content.gpu_buffers.get(&c.from).ok_or_else(|| format!("buffer {} is not one the GPU writes", c.from))?;
            let to = content.gpu_buffers.get(&c.to).ok_or_else(|| format!("buffer {} is not one the GPU writes", c.to))?;
            let (from_end, to_end) = (c.from_offset.checked_add(c.size), c.to_offset.checked_add(c.size));
            if from_end.is_none_or(|e| e > from.size) || to_end.is_none_or(|e| e > to.size) {
                return Err(format!("a buffer copy of {} bytes outside a buffer", c.size));
            }
            if c.from_offset % 4 != 0 || c.to_offset % 4 != 0 || c.size % 4 != 0 {
                return Err("a buffer copy of an offset or a size that is not a multiple of 4".into());
            }
            if c.from == c.to && c.from_offset < c.to_offset + c.size && c.to_offset < c.from_offset + c.size {
                return Err("a buffer copy within one buffer whose ranges overlap".into());
            }
        }
        Step::ClearBuffer(c) => {
            let buffer = content.gpu_buffers.get(&c.buffer).ok_or_else(|| format!("buffer {} is not one the GPU writes", c.buffer))?;
            if c.offset.checked_add(c.size).is_none_or(|e| e > buffer.size) {
                return Err(format!("clearBuffer of {} bytes from {} in the buffer {} of {} bytes", c.size, c.offset, c.buffer, buffer.size));
            }
            if c.offset % 4 != 0 || c.size % 4 != 0 {
                return Err("clearBuffer of an offset or a size that is not a multiple of 4".into());
            }
        }
        Step::Upload(u) => {
            let texture = texture_of(content, &u.texture)?;
            let extent = level_of(texture, &u.texture, u.mip)?;
            rect_in("an upload", extent, u.x, u.y, u.width, u.height)?;
            let texel = texel_bytes(&texture.format).ok_or_else(|| format!("a texture of format {}", texture.format))?;
            match &u.source {
                Source::Raw(blob) => {
                    if !content.blobs.contains_key(blob) {
                        return Err(format!("data {blob} is not in the recording"));
                    }
                    packed_len(u.width, u.height, texel)?;
                }
                Source::Pixels { id, width, height } => {
                    if !content.blobs.contains_key(id) {
                        return Err(format!("pixels {id} are not in the recording"));
                    }
                    packed_len(*width, *height, 4)?;
                    rect_in("a picture", (*width, *height), u.sx, u.sy, u.width, u.height)?;
                }
                Source::Src(_) | Source::Video { .. } | Source::Layer(_) => {}
            }
            if !matches!(u.source, Source::Raw(_)) && !is_picture_format(&texture.format) {
                return Err(format!(
                    "a picture uploaded into a texture of format {}; pictures go into rgba8unorm, rgba8unorm-srgb, bgra8unorm and bgra8unorm-srgb",
                    texture.format
                ));
            }
            if let Source::Video { time, .. } = &u.source
                && !(time.is_finite() && *time >= 0.0)
            {
                return Err(format!("a video frame at {time} seconds"));
            }
        }
        Step::Copy(c) => {
            let from = texture_of(content, &c.from.texture)?;
            let to = texture_of(content, &c.to.texture)?;
            let from_extent = level_of(from, &c.from.texture, c.from.mip)?;
            let to_extent = level_of(to, &c.to.texture, c.to.mip)?;
            rect_in("a copy's source", from_extent, c.from.x, c.from.y, c.width, c.height)?;
            rect_in("a copy's destination", to_extent, c.to.x, c.to.y, c.width, c.height)?;
            if linear_name(&from.format) != linear_name(&to.format) {
                return Err(format!("a copy from {} to {}; the formats must be the same, or differ only in -srgb", from.format, to.format));
            }
            if c.from.texture == c.to.texture && c.from.mip == c.to.mip {
                return Err("a copy within one level of one texture".into());
            }
        }
    }
    Ok(())
}

/// A `setBindGroup`: a slot the device has, and a group the recording holds.
fn bind_checks(content: &WebGpuContent, index: u32, group: &str, limits: &Limits) -> Result<(), String> {
    if index >= limits.max_bind_groups {
        return Err(format!("setBindGroup({index}): the device has {} bind groups", limits.max_bind_groups));
    }
    if !content.bind_groups.contains_key(group) {
        return Err(format!("bind group {group} is not in the recording"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRIANGLE: &str = "@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { \
        let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3)); return vec4f(p[i], 0, 1); } \
        @fragment fn fs() -> @location(0) vec4f { return vec4f(1, 0, 0, 1); }";

    #[test]
    fn a_valid_module_passes_and_a_broken_one_is_named() {
        let mut content = WebGpuContent::default();
        content.modules.insert("mgood".into(), TRIANGLE.into());
        assert!(check(&content).is_empty());
        content.modules.insert("mbad".into(), "fn x( { }".into());
        let problems = check(&content);
        assert_eq!(problems.len(), 1);
        assert!(problems[0].starts_with("WGSL module mbad:"), "{problems:?}");
    }

    #[test]
    fn the_recording_parses_from_the_page_side_json() {
        let json = r#"{"modules":{"m1":"x"},"layouts":{"l1":[{"binding":0,"visibility":7,"type":"uniform"}]},
            "pipelines":{"p1":{"layout":["l1"],"vertex":{"module":"m1","buffers":[]},
            "fragment":{"module":"m1","targets":[{"format":"rgba8unorm"}]},
            "primitive":{"topology":"triangle-list","frontFace":"ccw","cullMode":"none"}}},
            "buffers":{"b1":"AAAA"},"bindGroups":{"g1":{"layout":"l1","entries":[{"binding":0,"buffer":"b1","offset":0,"size":3}]}},
            "passes":[{"k":"render","clear":[0,0,0,0],"commands":[{"c":"pipeline","id":"p1"},{"c":"bind","index":0,"group":"g1"},
            {"c":"draw","vertices":3,"instances":1,"first":0,"firstInstance":0}]}]}"#;
        let content: WebGpuContent = serde_json::from_str(json).unwrap();
        let Step::Render(pass) = &content.passes[0] else {
            panic!("not a render pass");
        };
        assert_eq!(pass.commands.len(), 3);
        assert!(pass.target.is_none());
    }

    fn texture(width: u32, height: u32, mips: u32, format: &str) -> Texture {
        Texture {
            width,
            height,
            mips,
            format: format.into(),
        }
    }

    /// A recording with one 8 x 4 rgba8unorm texture of three levels `t`, and a blob `d` for it.
    fn recording() -> WebGpuContent {
        let mut c = WebGpuContent::default();
        c.textures.insert("t".into(), texture(8, 4, 3, "rgba8unorm"));
        c.textures.insert("u".into(), texture(8, 4, 1, "rgba8unorm-srgb"));
        c.blobs.insert("d".into(), String::new());
        c
    }

    fn upload(texture: &str, mip: u32, x: u32, y: u32, w: u32, h: u32, source: Source) -> Step {
        Step::Upload(Upload {
            texture: texture.into(),
            mip,
            x,
            y,
            width: w,
            height: h,
            source,
            sx: 0,
            sy: 0,
            flip_y: false,
            premultiply: false,
        })
    }

    fn refused(step: Step, why: &str) {
        let mut c = recording();
        c.passes.push(step);
        let e = validate(&c, 8192).unwrap_err();
        assert!(e.contains(why), "{e:?} should say {why:?}");
    }

    #[test]
    fn a_texture_is_checked_for_format_size_levels_and_overflow() {
        assert_eq!(texture_bytes(&texture(8, 4, 3, "rgba8unorm"), 8192), Ok(8 * 4 * 4 + 4 * 2 * 4 + 2 * 4));
        assert_eq!(texture_bytes(&texture(1, 1, 1, "r8unorm"), 8192), Ok(1));
        assert!(texture_bytes(&texture(8, 4, 1, "depth24plus"), 8192).unwrap_err().contains("format depth24plus"));
        assert!(texture_bytes(&texture(0, 4, 1, "rgba8unorm"), 8192).unwrap_err().contains("sides"));
        assert!(texture_bytes(&texture(8, 8193, 1, "rgba8unorm"), 8192).unwrap_err().contains("sides"));
        assert!(texture_bytes(&texture(8, 4, 0, "rgba8unorm"), 8192).unwrap_err().contains("mip levels"));
        // 8 across has the levels 8, 4, 2, 1.
        assert!(texture_bytes(&texture(8, 4, 4, "rgba8unorm"), 8192).is_ok());
        assert!(texture_bytes(&texture(8, 4, 5, "rgba8unorm"), 8192).unwrap_err().contains("at most 4"));
        assert_eq!(mip_extent(&texture(8, 4, 4, "rgba8unorm"), 3), (1, 1));
        assert_eq!(mip_extent(&texture(8, 4, 4, "rgba8unorm"), 40), (1, 1));
    }

    #[test]
    fn the_frames_textures_are_capped() {
        let mut c = WebGpuContent::default();
        // Each is 8192 x 8192 x 4 = 256 MiB: two fit the cap of 512 MiB only without their levels.
        c.textures.insert("a".into(), texture(8192, 8192, 1, "rgba8unorm"));
        c.textures.insert("b".into(), texture(8192, 8192, 1, "rgba8unorm"));
        assert!(validate(&c, 8192).is_ok());
        c.textures.insert("c".into(), texture(8192, 8192, 1, "rgba8unorm"));
        assert!(validate(&c, 8192).unwrap_err().contains("over the cap"));
    }

    #[test]
    fn a_rectangle_is_checked_without_overflow() {
        assert!(rect_in("r", (8, 4), 0, 0, 8, 4).is_ok());
        assert!(rect_in("r", (8, 4), 7, 3, 1, 1).is_ok());
        assert!(rect_in("r", (8, 4), 7, 0, 2, 1).unwrap_err().contains("outside"));
        assert!(rect_in("r", (8, 4), 0, 3, 1, 2).unwrap_err().contains("outside"));
        assert!(rect_in("r", (8, 4), u32::MAX, 0, 2, 1).unwrap_err().contains("overflows"));
        assert!(rect_in("r", (8, 4), 0, u32::MAX, 1, 2).unwrap_err().contains("overflows"));
        assert_eq!(packed_len(8, 4, 4), Ok(128));
        assert!(packed_len(u32::MAX, u32::MAX, u64::MAX).unwrap_err().contains("overflows"));
    }

    #[test]
    fn an_upload_outside_its_level_or_to_a_missing_level_is_refused() {
        let raw = || Source::Raw("d".into());
        let mut c = recording();
        c.passes.push(upload("t", 0, 0, 0, 8, 4, raw()));
        c.passes.push(upload("t", 2, 1, 0, 1, 1, raw()));
        assert!(validate(&c, 8192).is_ok());
        refused(upload("t", 3, 0, 0, 1, 1, raw()), "mip level 3");
        refused(upload("t", 1, 0, 0, 5, 1, raw()), "outside");
        refused(upload("t", 0, 4, 0, 5, 1, raw()), "outside");
        refused(upload("t", 0, 0, 3, 1, 2, raw()), "outside");
        refused(upload("t", 0, u32::MAX, 0, 2, 1, raw()), "overflows");
        refused(upload("missing", 0, 0, 0, 1, 1, raw()), "texture missing");
        refused(upload("t", 0, 0, 0, 1, 1, Source::Raw("nope".into())), "data nope");
    }

    #[test]
    fn a_picture_needs_a_picture_format_and_a_crop_inside_it() {
        let pixels = |w, h| Source::Pixels { id: "d".into(), width: w, height: h };
        let mut c = recording();
        c.passes.push(upload("u", 0, 0, 0, 4, 4, pixels(4, 4)));
        c.passes.push(upload("u", 0, 0, 0, 1, 1, Source::Src("a.png".into())));
        assert!(validate(&c, 8192).is_ok());
        c.textures.insert("r".into(), texture(4, 4, 1, "r8unorm"));
        let mut r = c.clone();
        r.passes.push(upload("r", 0, 0, 0, 1, 1, Source::Src("a.png".into())));
        assert!(validate(&r, 8192).unwrap_err().contains("pictures go into"));
        // The crop starts at sx, sy of the picture and must stay in it.
        let mut cropped = recording();
        let Step::Upload(mut u) = upload("u", 0, 0, 0, 3, 3, pixels(4, 4)) else { unreachable!() };
        u.sx = 2;
        cropped.passes.push(Step::Upload(u));
        assert!(validate(&cropped, 8192).unwrap_err().contains("a picture"));
        refused(upload("u", 0, 0, 0, 1, 1, Source::Pixels { id: "nope".into(), width: 1, height: 1 }), "pixels nope");
        refused(upload("u", 0, 0, 0, 1, 1, Source::Video { src: "v.mp4".into(), time: -1.0 }), "video frame");
        refused(upload("u", 0, 0, 0, 1, 1, Source::Video { src: "v.mp4".into(), time: f64::NAN }), "video frame");
    }

    fn copy(from: (&str, u32, u32, u32), to: (&str, u32, u32, u32), w: u32, h: u32) -> Step {
        let corner = |c: (&str, u32, u32, u32)| Corner {
            texture: c.0.into(),
            mip: c.1,
            x: c.2,
            y: c.3,
        };
        Step::Copy(TextureCopy {
            from: corner(from),
            to: corner(to),
            width: w,
            height: h,
        })
    }

    #[test]
    fn a_copy_is_checked_at_both_ends() {
        let mut c = recording();
        // Levels of one texture, and two textures that differ only in -srgb.
        c.passes.push(copy(("t", 0, 0, 0), ("t", 1, 0, 0), 4, 2));
        c.passes.push(copy(("t", 0, 0, 0), ("u", 0, 0, 0), 8, 4));
        assert!(validate(&c, 8192).is_ok());
        refused(copy(("t", 0, 0, 0), ("u", 0, 1, 0), 8, 4), "destination");
        refused(copy(("t", 0, 1, 0), ("u", 0, 0, 0), 8, 4), "source");
        refused(copy(("t", 5, 0, 0), ("u", 0, 0, 0), 1, 1), "mip level 5");
        refused(copy(("t", 0, 0, 0), ("u", 1, 0, 0), 1, 1), "mip level 1");
        refused(copy(("t", 0, u32::MAX, 0), ("u", 0, 0, 0), 2, 1), "overflows");
        refused(copy(("t", 0, 0, 0), ("t", 0, 0, 0), 1, 1), "within one level");
    }

    #[test]
    fn a_copy_between_formats_that_are_not_alike_is_refused() {
        let mut c = recording();
        c.textures.insert("b".into(), texture(8, 4, 1, "bgra8unorm"));
        c.passes.push(copy(("t", 0, 0, 0), ("b", 0, 0, 0), 1, 1));
        assert!(validate(&c, 8192).unwrap_err().contains("must be the same"));
    }

    #[test]
    fn a_pass_target_and_a_bound_view_name_levels_that_exist() {
        let mut c = recording();
        c.passes.push(Step::Render(Pass {
            target: Some(PassTarget { texture: "t".into(), mip: 2 }),
            clear: Some([0.0; 4]),
            commands: Vec::new(),
        }));
        assert!(validate(&c, 8192).is_ok());
        refused(
            Step::Render(Pass {
                target: Some(PassTarget { texture: "t".into(), mip: 3 }),
                clear: None,
                commands: Vec::new(),
            }),
            "mip level 3",
        );
        refused(
            Step::Render(Pass {
                target: Some(PassTarget { texture: "gone".into(), mip: 0 }),
                clear: None,
                commands: Vec::new(),
            }),
            "texture gone",
        );
        refused(
            Step::Render(Pass {
                target: None,
                clear: Some([f64::NAN, 0.0, 0.0, 0.0]),
                commands: Vec::new(),
            }),
            "not finite",
        );
        let group = |texture: Option<TextureView>, sampler: Option<&str>, buffer: Option<&str>| BindGroup {
            layout: "auto:p:0".into(),
            entries: vec![BindEntry {
                binding: 0,
                buffer: buffer.map(String::from),
                offset: 0,
                size: 0,
                texture,
                sampler: sampler.map(String::from),
            }],
        };
        let view = |base_mip, mips| Some(TextureView { id: "t".into(), base_mip, mips });
        let mut ok = recording();
        ok.samplers.insert("s".into(), SamplerDesc::default());
        ok.bind_groups.insert("g".into(), group(view(1, 2), None, None));
        ok.bind_groups.insert("h".into(), group(None, Some("s"), None));
        assert!(validate(&ok, 8192).is_ok());
        for (g, why) in [
            (group(view(2, 2), None, None), "levels 2..4"),
            (group(view(0, 0), None, None), "levels 0..0"),
            (group(view(u32::MAX, 2), None, None), "overflows"),
            (group(None, Some("nope"), None), "sampler nope"),
            (group(None, None, None), "one of a buffer"),
            (group(view(0, 1), Some("s"), None), "one of a buffer"),
            (group(Some(TextureView { id: "gone".into(), base_mip: 0, mips: 1 }), None, None), "texture gone"),
        ] {
            let mut bad = ok.clone();
            bad.bind_groups.insert("x".into(), g);
            let e = validate(&bad, 8192).unwrap_err();
            assert!(e.contains(why), "{e:?} should say {why:?}");
        }
    }

    #[test]
    fn a_sampler_is_checked() {
        let with = |f: fn(&mut SamplerDesc)| {
            let mut s = SamplerDesc::default();
            f(&mut s);
            sampler_checks("s", &s)
        };
        assert!(with(|_| {}).is_ok());
        assert!(with(|s| s.address_mode_u = Some("wrap".into())).unwrap_err().contains("addressModeU"));
        assert!(with(|s| s.mag_filter = Some("cubic".into())).unwrap_err().contains("magFilter"));
        assert!(with(|s| s.lod_min_clamp = Some(-1.0)).unwrap_err().contains("lodMinClamp"));
        assert!(with(|s| s.lod_max_clamp = Some(f64::INFINITY)).unwrap_err().contains("lodMaxClamp"));
        assert!(with(|s| {
            s.lod_min_clamp = Some(4.0);
            s.lod_max_clamp = Some(2.0);
        })
        .is_err());
        assert!(with(|s| s.max_anisotropy = Some(0)).unwrap_err().contains("maxAnisotropy"));
        assert!(with(|s| s.max_anisotropy = Some(17)).unwrap_err().contains("maxAnisotropy"));
        assert!(with(|s| s.max_anisotropy = Some(4)).unwrap_err().contains("linear"));
        assert!(with(|s| {
            s.max_anisotropy = Some(4);
            s.mag_filter = Some("linear".into());
            s.min_filter = Some("linear".into());
            s.mipmap_filter = Some("linear".into());
        })
        .is_ok());
    }

    #[test]
    fn too_many_steps_are_refused() {
        let mut c = recording();
        for _ in 0..=MAX_STEPS {
            c.passes.push(Step::Render(Pass { target: None, clear: None, commands: Vec::new() }));
        }
        assert!(validate(&c, 8192).unwrap_err().contains("steps in a frame"));
    }

    #[test]
    fn the_steps_parse_from_the_page_side_json() {
        let json = r#"{"textures":{"t":{"width":2,"height":2,"mips":1,"format":"rgba8unorm"}},
            "samplers":{"s":{"magFilter":"nearest","addressModeU":"repeat"}},"blobs":{"d":"AAAAAAAAAAAAAAAAAAAAAA=="},
            "bindGroups":{"g":{"layout":"auto:p:0","entries":[{"binding":0,"texture":{"id":"t","baseMip":0,"mips":1}},{"binding":1,"sampler":"s"}]}},
            "passes":[
              {"k":"upload","texture":"t","x":0,"y":0,"width":2,"height":2,"source":{"raw":"d"}},
              {"k":"upload","texture":"t","x":0,"y":0,"width":1,"height":1,"source":{"src":"a.png"},"flipY":true,"premultiply":true},
              {"k":"upload","texture":"t","x":0,"y":0,"width":1,"height":1,"source":{"video":{"src":"v.mp4","time":0.5}}},
              {"k":"upload","texture":"t","x":0,"y":0,"width":1,"height":1,"source":{"layer":"child"}},
              {"k":"copy","from":{"texture":"t","x":0,"y":0},"to":{"texture":"t","mip":0,"x":1,"y":1},"width":1,"height":1},
              {"k":"render","target":{"texture":"t"},"clear":null,"commands":[]}]}"#;
        let c: WebGpuContent = serde_json::from_str(json).unwrap();
        assert_eq!(c.passes.len(), 6);
        assert!(matches!(&c.passes[2], Step::Upload(Upload { source: Source::Video { time, .. }, .. }) if *time == 0.5));
        assert!(matches!(&c.passes[1], Step::Upload(Upload { flip_y: true, premultiply: true, .. })));
        assert_eq!(c.bind_groups["g"].entries[0].texture.as_ref().unwrap().mips, 1);
        // `copy` of one texture to a level that is not its own passes; the one that is its own does not.
        assert!(validate(&c, 8192).is_err());
    }

    // ---- compute: pipelines, storage resources, dispatches ----

    const COMPUTE: &str = "@group(0) @binding(0) var out: texture_storage_2d<rgba8unorm, write>; \
        @compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) { textureStore(out, id.xy, vec4f(1)); } \
        @compute @workgroup_size(16, 16, 1) fn big() {}";

    /// A recording with a compute pipeline `cp` (explicit layout `l`: a write-only rgba8unorm storage texture at 0), a bind
    /// group `g` over the 8 x 4 texture `t`, and a buffer the GPU writes `B1` of 64 bytes.
    fn compute_recording() -> WebGpuContent {
        let mut c = recording();
        c.modules.insert("m".into(), COMPUTE.into());
        c.layouts.insert(
            "l".into(),
            vec![BindingLayout {
                binding: 0,
                visibility: 4,
                ty: "storage-texture".into(),
                dynamic_offset: false,
                sample_type: None,
                sampler_type: None,
                access: None,
                format: Some("rgba8unorm".into()),
            }],
        );
        c.compute_pipelines.insert(
            "cp".into(),
            ComputePipeline {
                layout: Some(vec!["l".into()]),
                module: "m".into(),
                entry_point: Some("main".into()),
            },
        );
        c.bind_groups.insert(
            "g".into(),
            BindGroup {
                layout: "l".into(),
                entries: vec![BindEntry {
                    binding: 0,
                    buffer: None,
                    offset: 0,
                    size: 0,
                    texture: Some(TextureView { id: "t".into(), base_mip: 0, mips: 1 }),
                    sampler: None,
                }],
            },
        );
        c.gpu_buffers.insert("B1".into(), GpuBuffer { size: 64 });
        c
    }

    fn dispatch(x: u32, y: u32, z: u32) -> ComputeCommand {
        ComputeCommand::Dispatch { x, y, z }
    }

    fn pass(commands: Vec<ComputeCommand>) -> Step {
        Step::Compute(ComputePass { commands })
    }

    fn set_up() -> Vec<ComputeCommand> {
        vec![
            ComputeCommand::Pipeline { id: "cp".into() },
            ComputeCommand::Bind { index: 0, group: "g".into(), offsets: vec![] },
        ]
    }

    fn refused_in(mut c: WebGpuContent, step: Step, why: &str) {
        c.passes.push(step);
        let e = validate(&c, 8192).unwrap_err();
        assert!(e.contains(why), "{e:?} should say {why:?}");
    }

    #[test]
    fn a_compute_recording_parses_and_a_good_one_validates() {
        let json = r#"{"modules":{"m":"x"},
            "layouts":{"l":[{"binding":0,"visibility":4,"type":"storage-texture","access":"read-write","format":"r32float"},
                            {"binding":1,"visibility":4,"type":"storage"}]},
            "computePipelines":{"cp":{"layout":["l"],"module":"m","entryPoint":"main"},"ca":{"module":"m"}},
            "gpuBuffers":{"B1":{"size":16}},
            "passes":[
              {"k":"writeBuffer","buffer":"B1","offset":0,"data":"d"},
              {"k":"copyBuffer","from":"B1","fromOffset":0,"to":"B1","toOffset":8,"size":8},
              {"k":"clearBuffer","buffer":"B1","offset":0,"size":16},
              {"k":"compute","commands":[{"c":"pipeline","id":"cp"},{"c":"bind","index":0,"group":"g","offsets":[256]},{"c":"dispatch","x":4,"y":2,"z":1}]}],
            "impure":["state"]}"#;
        let c: WebGpuContent = serde_json::from_str(json).unwrap();
        assert_eq!(c.compute_pipelines["cp"].layout.as_deref(), Some(&["l".to_string()][..]));
        assert_eq!(c.compute_pipelines["ca"].layout, None);
        assert_eq!(c.layouts["l"][0].access.as_deref(), Some("read-write"));
        assert_eq!(c.gpu_buffers["B1"].size, 16);
        assert!(matches!(&c.passes[3], Step::Compute(p) if p.commands.len() == 3));
        assert!(matches!(&c.passes[2], Step::ClearBuffer(b) if b.size == 16));
        assert_eq!(c.impure, ["state"]);

        let mut ok = compute_recording();
        let mut commands = set_up();
        commands.push(dispatch(1, 1, 1));
        commands.push(dispatch(4096, 4096, 1));
        ok.passes.push(pass(commands));
        ok.blobs.insert("d".into(), "AAAAAAAAAAAAAAAAAAAAAA==".into());
        ok.passes.push(Step::WriteBuffer(BufferWrite { buffer: "B1".into(), offset: 8, data: "d".into() }));
        ok.passes.push(Step::ClearBuffer(BufferClear { buffer: "B1".into(), offset: 0, size: 64 }));
        ok.passes.push(Step::CopyBuffer(BufferCopy { from: "B1".into(), from_offset: 0, to: "B1".into(), to_offset: 32, size: 32 }));
        assert!(validate(&ok, 8192).is_ok(), "{:?}", validate(&ok, 8192));
    }

    #[test]
    fn a_dispatch_is_checked_against_the_pipeline_the_group_and_the_limits() {
        let mut no_pipeline = vec![ComputeCommand::Bind { index: 0, group: "g".into(), offsets: vec![] }];
        no_pipeline.push(dispatch(1, 1, 1));
        refused_in(compute_recording(), pass(no_pipeline), "before setPipeline");
        let with = |extra: ComputeCommand| {
            let mut commands = set_up();
            commands.push(extra);
            pass(commands)
        };
        refused_in(compute_recording(), with(dispatch(65536, 1, 1)), "over the device's 65535");
        refused_in(compute_recording(), with(dispatch(1, 1, 70000)), "over the device's 65535");
        refused_in(compute_recording(), pass(vec![ComputeCommand::Pipeline { id: "nope".into() }]), "compute pipeline nope");
        refused_in(
            compute_recording(),
            pass(vec![ComputeCommand::Pipeline { id: "cp".into() }, ComputeCommand::Bind { index: 0, group: "nope".into(), offsets: vec![] }]),
            "bind group nope",
        );
        refused_in(
            compute_recording(),
            pass(vec![ComputeCommand::Pipeline { id: "cp".into() }, ComputeCommand::Bind { index: 4, group: "g".into(), offsets: vec![] }]),
            "has 4 bind groups",
        );
    }

    #[test]
    fn dispatch_counts_and_total_workgroups_are_capped_per_frame() {
        let mut c = compute_recording();
        let mut commands = set_up();
        for _ in 0..=MAX_DISPATCHES {
            commands.push(dispatch(1, 1, 1));
        }
        c.passes.push(pass(commands));
        assert!(validate(&c, 8192).unwrap_err().contains("dispatches in a frame"));
        // 65535 x 65535 is 4.29e9 workgroups: over the cap of 2^26 on its own.
        let mut commands = set_up();
        commands.push(dispatch(65535, 65535, 1));
        let mut c = compute_recording();
        c.passes.push(pass(commands));
        assert!(validate(&c, 8192).unwrap_err().contains("more than 67108864 workgroups"));
        // The total counts all passes together: 4 x 2^24 is the cap, a fifth is over it.
        let mut c = compute_recording();
        for n in 0..5 {
            let mut commands = set_up();
            commands.push(dispatch(4096, 4096, 1));
            c.passes.push(pass(commands));
            assert_eq!(validate(&c, 8192).is_ok(), n < 4, "after {} passes", n + 1);
        }
    }

    #[test]
    fn a_layout_is_checked_for_storage_formats_access_stages_and_counts() {
        let entry = |binding: u32, visibility: u32, ty: &str, access: Option<&str>, format: Option<&str>| BindingLayout {
            binding,
            visibility,
            ty: ty.into(),
            dynamic_offset: false,
            sample_type: None,
            sampler_type: None,
            access: access.map(String::from),
            format: format.map(String::from),
        };
        let layout_err = |entries: Vec<BindingLayout>| {
            let mut c = WebGpuContent::default();
            c.layouts.insert("l".into(), entries);
            validate(&c, 8192).unwrap_err()
        };
        let ok = |entries: Vec<BindingLayout>| {
            let mut c = WebGpuContent::default();
            c.layouts.insert("l".into(), entries);
            validate(&c, 8192)
        };
        assert!(ok(vec![entry(0, 4, "storage-texture", None, Some("rgba32float"))]).is_ok());
        assert!(ok(vec![entry(0, 4, "storage-texture", Some("read-write"), Some("r32float"))]).is_ok());
        assert!(ok(vec![entry(0, 4, "storage-texture", Some("read-only"), Some("r32uint"))]).is_ok());
        assert!(layout_err(vec![entry(0, 4, "storage-texture", None, None)]).contains("without a format"));
        assert!(layout_err(vec![entry(0, 4, "storage-texture", None, Some("depth24plus"))]).contains("format depth24plus"));
        assert!(layout_err(vec![entry(0, 4, "storage-texture", None, Some("rgba8unorm-srgb"))]).contains("cannot be a storage texture"));
        assert!(layout_err(vec![entry(0, 4, "storage-texture", None, Some("r8unorm"))]).contains("cannot be a storage texture"));
        assert!(layout_err(vec![entry(0, 4, "storage-texture", Some("read-write"), Some("rgba8unorm"))]).contains("optional feature"));
        assert!(layout_err(vec![entry(0, 4, "storage-texture", Some("read-only"), Some("rgba16float"))]).contains("optional feature"));
        assert!(layout_err(vec![entry(0, 4, "storage-texture", Some("sideways"), Some("rgba8unorm"))]).contains("access sideways"));
        assert!(layout_err(vec![entry(0, 5, "storage-texture", None, Some("rgba8unorm"))]).contains("vertex stage"));
        assert!(layout_err(vec![entry(0, 3, "storage", None, None)]).contains("vertex stage"));
        assert!(layout_err(vec![entry(0, 4, "storage", None, None), entry(0, 4, "uniform", None, None)]).contains("twice"));
        assert!(layout_err(vec![entry(0, 0, "uniform", None, None)]).contains("visible to stages"));
        assert!(layout_err(vec![entry(0, 8, "uniform", None, None)]).contains("visible to stages"));
        assert!(layout_err(vec![entry(0, 4, "mystery", None, None)]).contains("type mystery"));
        // The device has 8 storage buffers and 4 storage textures to a stage.
        let buffers = |n: u32| (0..n).map(|i| entry(i, 4, "read-only-storage", None, None)).collect::<Vec<_>>();
        assert!(ok(buffers(8)).is_ok());
        assert!(layout_err(buffers(9)).contains("more than 8 storage buffers"));
        let images = |n: u32| (0..n).map(|i| entry(i, 4, "storage-texture", None, Some("rgba8unorm"))).collect::<Vec<_>>();
        assert!(ok(images(4)).is_ok());
        assert!(layout_err(images(5)).contains("more than 4 storage textures"));
        // Another stage's bindings are not counted against this one.
        let mut mixed = images(4);
        mixed.extend((4..8).map(|i| entry(i, 2, "texture", None, None)));
        assert!(ok(mixed).is_ok());
    }

    fn group_with(layout_entry: BindingLayout, entry: BindEntry) -> WebGpuContent {
        let mut c = recording();
        c.textures.insert("f".into(), texture(8, 4, 1, "rgba32float"));
        c.textures.insert("u".into(), texture(8, 4, 1, "rgba8uint"));
        c.textures.insert("t1".into(), texture(8, 4, 1, "rgba8unorm"));
        c.samplers.insert("s".into(), SamplerDesc::default());
        c.gpu_buffers.insert("B1".into(), GpuBuffer { size: 1024 });
        c.buffers.insert("b".into(), "A".repeat(88));
        c.layouts.insert("l".into(), vec![layout_entry]);
        c.bind_groups.insert("g".into(), BindGroup { layout: "l".into(), entries: vec![entry] });
        c
    }

    fn texture_binding(sample: Option<&str>) -> BindingLayout {
        BindingLayout {
            binding: 0,
            visibility: 6,
            ty: "texture".into(),
            dynamic_offset: false,
            sample_type: sample.map(String::from),
            sampler_type: None,
            access: None,
            format: None,
        }
    }

    fn view(id: &str, mips: u32) -> BindEntry {
        BindEntry {
            binding: 0,
            buffer: None,
            offset: 0,
            size: 0,
            texture: Some(TextureView { id: id.into(), base_mip: 0, mips }),
            sampler: None,
        }
    }

    #[test]
    fn a_texture_binding_is_read_as_its_format_allows() {
        // A 32-bit float texture is unfilterable-float, or float only on a device that filters it.
        let with = |sample: Option<&str>, id: &str, filterable: bool| {
            validate_with(&group_with(texture_binding(sample), view(id, 1)), &Limits { float32_filterable: filterable, ..Limits::default() })
        };
        assert!(with(Some("unfilterable-float"), "f", false).is_ok());
        assert!(with(Some("unfilterable-float"), "t1", false).is_ok());
        assert!(with(None, "t1", false).is_ok());
        let e = with(None, "f", false).unwrap_err();
        assert!(e.contains("rgba32float texture as float") && e.contains("unfilterable-float"), "{e}");
        assert!(with(None, "f", true).is_ok());
        assert!(with(Some("uint"), "u", false).is_ok());
        assert!(with(Some("sint"), "u", false).unwrap_err().contains("as sint"));
        assert!(with(Some("uint"), "t1", false).unwrap_err().contains("as uint"));
        assert!(with(Some("unfilterable-float"), "u", false).unwrap_err().contains("as unfilterable-float"));
    }

    #[test]
    fn a_storage_texture_binding_takes_one_level_of_the_format_the_layout_names() {
        let layout = |format: &str| BindingLayout {
            binding: 0,
            visibility: 4,
            ty: "storage-texture".into(),
            dynamic_offset: false,
            sample_type: None,
            sampler_type: None,
            access: None,
            format: Some(format.into()),
        };
        assert!(validate(&group_with(layout("rgba8unorm"), view("t1", 1)), 8192).is_ok());
        assert!(validate(&group_with(layout("rgba32float"), view("f", 1)), 8192).is_ok());
        let e = validate(&group_with(layout("rgba8unorm"), view("f", 1)), 8192).unwrap_err();
        assert!(e.contains("storage texture of rgba8unorm") && e.contains("rgba32float"), "{e}");
        let mut mips = group_with(layout("rgba8unorm"), view("t", 2));
        mips.textures.insert("t".into(), texture(8, 4, 3, "rgba8unorm"));
        assert!(validate(&mips, 8192).unwrap_err().contains("takes one"));
        assert!(validate(&group_with(layout("rgba8unorm"), view("gone", 1)), 8192).unwrap_err().contains("texture gone"));
    }

    #[test]
    fn a_buffer_binding_is_in_range_aligned_and_within_the_limits() {
        let layout = |ty: &str| BindingLayout {
            binding: 0,
            visibility: 6,
            ty: ty.into(),
            dynamic_offset: false,
            sample_type: None,
            sampler_type: None,
            access: None,
            format: None,
        };
        let bind = |buffer: &str, offset: u64, size: u64| BindEntry {
            binding: 0,
            buffer: Some(buffer.into()),
            offset,
            size,
            texture: None,
            sampler: None,
        };
        let check = |ty: &str, entry: BindEntry| validate(&group_with(layout(ty), entry), 8192);
        assert!(check("storage", bind("B1", 256, 768)).is_ok());
        assert!(check("uniform", bind("b", 0, 64)).is_ok());
        assert!(check("storage", bind("B1", 0, 1025)).unwrap_err().contains("of a buffer of 1024"));
        assert!(check("storage", bind("B1", 1024, 4)).unwrap_err().contains("of a buffer of 1024"));
        assert!(check("storage", bind("B1", 0, 0)).unwrap_err().contains("of a buffer of 1024"));
        assert!(check("storage", bind("B1", u64::MAX, 2)).unwrap_err().contains("overflows"));
        assert!(check("storage", bind("B1", 4, 64)).unwrap_err().contains("not a multiple of 256"));
        assert!(check("uniform", bind("b", 16, 16)).unwrap_err().contains("not a multiple of 256"));
        assert!(check("storage", bind("nope", 0, 4)).unwrap_err().contains("buffer nope"));
        assert!(check("uniform", bind("b", 0, 89)).unwrap_err().contains("of a buffer of 66"));
        assert!(check("sampler", bind("B1", 0, 4)).unwrap_err().contains("the layout says sampler"));
        // A binding over the device's size.
        let mut big = group_with(layout("storage"), bind("B1", 0, 128 << 20));
        big.gpu_buffers.insert("B1".into(), GpuBuffer { size: 256 << 20 });
        assert!(validate(&big, 8192).is_ok());
        big.bind_groups.get_mut("g").unwrap().entries[0].size = (128 << 20) + 4;
        assert!(validate(&big, 8192).unwrap_err().contains("the device allows"));
        let mut uniform = group_with(layout("uniform"), bind("B1", 0, 65537));
        uniform.gpu_buffers.insert("B1".into(), GpuBuffer { size: 1 << 20 });
        assert!(validate(&uniform, 8192).unwrap_err().contains("a uniform binding of 65537"));
        // The group has a binding for each the layout names.
        let mut missing = group_with(layout("storage"), bind("B1", 0, 4));
        missing.bind_groups.get_mut("g").unwrap().entries[0].binding = 3;
        assert!(validate(&missing, 8192).unwrap_err().contains("the layout has a binding 0"));
        // A sampler where the layout wants a texture.
        let sampler = BindEntry { binding: 0, buffer: None, offset: 0, size: 0, texture: None, sampler: Some("s".into()) };
        assert!(check_group_err(texture_binding(None), sampler).contains("holds a sampler"));
        assert!(check_group_err(layout("storage"), view("t1", 1)).contains("holds a texture and the layout says storage"));
    }

    fn check_group_err(layout: BindingLayout, entry: BindEntry) -> String {
        validate(&group_with(layout, entry), 8192).unwrap_err()
    }

    #[test]
    fn buffer_steps_are_checked_for_range_alignment_and_overlap() {
        let mut c = compute_recording();
        c.blobs.insert("d8".into(), "AAAAAAAAAAA=".into()); // 8 bytes
        c.blobs.insert("d7".into(), "AAAAAAAAAA==".into()); // 7 bytes
        let write = |buffer: &str, offset: u64, data: &str| Step::WriteBuffer(BufferWrite { buffer: buffer.into(), offset, data: data.into() });
        let copy = |from: &str, from_offset: u64, to: &str, to_offset: u64, size: u64| {
            Step::CopyBuffer(BufferCopy { from: from.into(), from_offset, to: to.into(), to_offset, size })
        };
        let clear = |offset: u64, size: u64| Step::ClearBuffer(BufferClear { buffer: "B1".into(), offset, size });
        c.gpu_buffers.insert("B2".into(), GpuBuffer { size: 32 });
        for ok in [write("B1", 56, "d8"), copy("B1", 0, "B2", 0, 32), copy("B1", 0, "B1", 32, 32), clear(0, 64), clear(60, 4)] {
            let mut good = c.clone();
            good.passes.push(ok.clone());
            assert!(validate(&good, 8192).is_ok(), "{ok:?}: {:?}", validate(&good, 8192));
        }
        refused_in(c.clone(), write("B1", 60, "d8"), "into the buffer B1 of 64");
        refused_in(c.clone(), write("B1", 2, "d8"), "multiple of 4");
        refused_in(c.clone(), write("B1", 0, "d7"), "multiple of 4");
        refused_in(c.clone(), write("B1", 0, "nope"), "data nope");
        refused_in(c.clone(), write("B9", 0, "d8"), "buffer B9");
        refused_in(c.clone(), write("B1", u64::MAX - 3, "d8"), "overflows");
        refused_in(c.clone(), copy("B1", 0, "B2", 0, 36), "outside a buffer");
        refused_in(c.clone(), copy("B1", 60, "B2", 0, 8), "outside a buffer");
        refused_in(c.clone(), copy("B1", 0, "B2", 2, 4), "multiple of 4");
        refused_in(c.clone(), copy("B1", 0, "B1", 16, 32), "overlap");
        refused_in(c.clone(), copy("B1", 0, "B2", 0, u64::MAX), "outside a buffer");
        refused_in(c.clone(), copy("B9", 0, "B2", 0, 4), "buffer B9");
        refused_in(c.clone(), clear(60, 8), "clearBuffer of 8 bytes from 60");
        refused_in(c.clone(), clear(2, 4), "multiple of 4");
        refused_in(c.clone(), clear(u64::MAX, 8), "clearBuffer");
    }

    #[test]
    fn the_buffers_the_gpu_writes_are_capped() {
        let mut c = WebGpuContent::default();
        c.gpu_buffers.insert("B1".into(), GpuBuffer { size: 0 });
        assert!(validate(&c, 8192).unwrap_err().contains("1 to"));
        c.gpu_buffers.insert("B1".into(), GpuBuffer { size: (256 << 20) + 4 });
        assert!(validate(&c, 8192).unwrap_err().contains("a buffer holds"));
        // 4 x 256 MiB is the cap of 1 GiB; a fifth is over it.
        for n in 0..5 {
            c.gpu_buffers.insert(format!("B{n}"), GpuBuffer { size: 256 << 20 });
        }
        assert!(validate(&c, 8192).unwrap_err().contains("over the cap"));
        c.gpu_buffers.remove("B4");
        assert!(validate(&c, 8192).is_ok());
    }

    #[test]
    fn a_compute_pipeline_names_a_module_and_layouts_that_exist() {
        let mut c = compute_recording();
        c.compute_pipelines.get_mut("cp").unwrap().module = "gone".into();
        assert!(validate(&c, 8192).unwrap_err().contains("module gone"));
        let mut c = compute_recording();
        c.compute_pipelines.get_mut("cp").unwrap().layout = Some(vec!["gone".into()]);
        assert!(validate(&c, 8192).unwrap_err().contains("layout gone"));
        let mut c = compute_recording();
        c.compute_pipelines.get_mut("cp").unwrap().layout = Some(vec!["l".into(); 5]);
        assert!(validate(&c, 8192).unwrap_err().contains("more than 4 bind group layouts"));
    }

    #[test]
    fn a_compute_entry_point_is_checked_for_stage_name_and_workgroup_size() {
        let with = |entry: Option<&str>, limits: &Limits| {
            let mut c = compute_recording();
            c.compute_pipelines.get_mut("cp").unwrap().entry_point = entry.map(String::from);
            check_with(&c, limits)
        };
        let defaults = Limits::default();
        assert!(with(Some("main"), &defaults).is_empty());
        assert!(with(Some("big"), &defaults).is_empty());
        // Two entry points and none named.
        assert!(with(None, &defaults)[0].contains("does not have exactly one"));
        assert!(with(Some("missing"), &defaults)[0].contains("no entry point missing"));
        // 8 x 8 = 64 invocations against a device that allows 32, 8 across, 256 for z.
        let small = Limits { max_compute_invocations_per_workgroup: 32, ..Limits::default() };
        assert!(with(Some("main"), &small)[0].contains("64 invocations; the device allows 32"));
        let narrow = Limits { max_compute_workgroup_size_y: 4, ..Limits::default() };
        assert!(with(Some("main"), &narrow)[0].contains("a side"));
        let mut render = compute_recording();
        render.modules.insert("m".into(), TRIANGLE.into());
        render.compute_pipelines.get_mut("cp").unwrap().entry_point = Some("fs".into());
        assert!(check_with(&render, &defaults)[0].contains("not a @compute function"));
        // A module that is not WGSL is the module's problem; the pipeline is not judged on it.
        let mut broken = compute_recording();
        broken.modules.insert("m".into(), "fn x( {".into());
        let problems = check_with(&broken, &defaults);
        assert_eq!(problems.len(), 1);
        assert!(problems[0].starts_with("WGSL module m:"));
    }

    #[test]
    fn the_formats_say_how_they_are_sampled_and_stored() {
        let info = |f: &str| format_info(f).unwrap();
        assert_eq!(info("rgba32float"), FormatInfo { bytes: 16, sample: Sample::Unfilterable, storage: Storage::Write });
        assert_eq!(info("r32float").storage, Storage::ReadWrite);
        assert_eq!(info("rgba16float").bytes, 8);
        assert_eq!(info("rgba8unorm-srgb").storage, Storage::No);
        assert_eq!(info("rgba8uint").sample, Sample::Uint);
        assert_eq!(info("rg32sint").sample, Sample::Sint);
        assert!(format_info("depth24plus").is_none());
        assert!(format_info("bc1-rgba-unorm").is_none());
        assert_eq!(texel_bytes("rgba32uint"), Some(16));
        assert_eq!(texture_bytes(&texture(4, 4, 1, "rgba32float"), 8192), Ok(256));
        for name in TEXTURE_FORMATS.replace(" and ", ", ").split(", ") {
            assert!(format_info(name).is_some(), "{name}");
        }
    }

    #[test]
    fn the_length_of_base64_is_counted_without_decoding_it() {
        assert_eq!(base64_len(""), 0);
        assert_eq!(base64_len("AAAA"), 3);
        assert_eq!(base64_len("AAA="), 2);
        assert_eq!(base64_len("AA=="), 1);
        assert_eq!(base64_len("AAAAAAAAAAA="), 8);
    }

    #[test]
    fn a_render_pass_binds_groups_the_recording_holds() {
        let mut c = compute_recording();
        let bind = |index: u32, group: &str| {
            Step::Render(Pass {
                target: None,
                clear: None,
                commands: vec![Command::Bind { index, group: group.into(), offsets: vec![] }],
            })
        };
        refused_in(c.clone(), bind(0, "nope"), "bind group nope");
        refused_in(c.clone(), bind(9, "g"), "has 4 bind groups");
        c.passes.push(bind(0, "g"));
        assert!(validate(&c, 8192).is_ok());
    }
}
