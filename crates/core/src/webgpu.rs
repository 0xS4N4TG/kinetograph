//! WebGPU, native: the render passes a page submitted to its canvas, replayed on the shared wgpu device with the
//! page's own WGSL (packages/cli/skills/kinetograph/references/ENGINE.md, "WebGPU").
//!
//! The authoring side (`navigator.gpu` of `@kinetographdev/scene`) records what a frame drew as the `webgpu` part of
//! a `glsl` layer: modules, bind group layouts, pipelines, buffer contents at the time of the submit, textures and
//! samplers, bind groups and the steps (render passes, texture uploads and copies) in the order the page submitted them.
//! Nothing here reads anything but that, so the layer is a pure function of its recording. This file is the part that
//! needs no GPU: the recording's types, `check`, which reads each module with naga so that a page's mistake is reported
//! when the frame is painted, not found by the GPU, and `validate`, which bounds-checks every size, offset, mip level and
//! origin of the textures before anything is made. The drawing is in `compositor/glsl/webgpu.rs`.

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
    /// Base64 bytes, by id.
    #[serde(default)]
    pub buffers: BTreeMap<String, String>,
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
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingLayout {
    pub binding: u32,
    /// `GPUShaderStage` bits.
    pub visibility: u32,
    /// `uniform`, `storage`, `read-only-storage`, `texture` or `sampler`.
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

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "k", rename_all = "camelCase")]
pub enum Step {
    Render(Pass),
    Upload(Upload),
    Copy(TextureCopy),
}

/// Reads every module of the recording with naga. Returns what is wrong with each, as `module id: message`, for the
/// painter to report; a layer with a module that is wrong draws nothing.
pub fn check(content: &WebGpuContent) -> Vec<String> {
    let mut problems = Vec::new();
    for (id, code) in &content.modules {
        if let Err(message) = parse(code) {
            problems.push(format!("WGSL module {id}: {message}"));
        }
    }
    problems
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
/// The most steps (passes, uploads, copies) a recording may hold.
pub const MAX_STEPS: usize = 4096;

/// The bytes of a texel of `format`, for the formats that are drawn.
pub fn texel_bytes(format: &str) -> Option<u64> {
    match format {
        "r8unorm" => Some(1),
        "rg8unorm" => Some(2),
        "rgba8unorm" | "rgba8unorm-srgb" | "bgra8unorm" | "bgra8unorm-srgb" => Some(4),
        "rgba16float" => Some(8),
        _ => None,
    }
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
    let bytes = texel_bytes(&texture.format).ok_or_else(|| {
        format!(
            "a texture of format {}; the formats drawn are r8unorm, rg8unorm, rgba8unorm, rgba8unorm-srgb, bgra8unorm, bgra8unorm-srgb and rgba16float",
            texture.format
        )
    })?;
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

/// Checks every size, offset, level and origin of the recording's textures, samplers, uploads, copies and bind
/// entries, so that replaying it cannot index outside a texture. Returns the first thing that is wrong, for the painter
/// to report; a layer that fails draws nothing. `max_dim` is how many texels a texture may be across.
pub fn validate(content: &WebGpuContent, max_dim: u32) -> Result<(), String> {
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
    for (id, sampler) in &content.samplers {
        sampler_checks(id, sampler)?;
    }
    for (id, group) in &content.bind_groups {
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
        }
    }
    for (n, step) in content.passes.iter().enumerate() {
        validate_step(content, step).map_err(|e| format!("step {n}: {e}"))?;
    }
    Ok(())
}

fn validate_step(content: &WebGpuContent, step: &Step) -> Result<(), String> {
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
}
