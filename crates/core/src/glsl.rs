//! WebGL, native: the GLSL ES a page gives `gl.shaderSource` read by naga and
//! run on the shared wgpu device (packages/cli/skills/kinetograph-markup/references/SCENE.md, "glsl").
//!
//! The authoring side (`createWebGLContext` of `@kinetographdev/scene`, or
//! `<GlslShader>`) records what a frame did to the context as the layer's
//! `ops`: clears and draws, each draw carrying the program, the vertex data,
//! the uniforms, the textures and the state it ran with. Nothing here reads
//! anything but those and the picture files they name, so the layer is a pure
//! function of its recording.
//!
//! This file is the part that needs no GPU: the recording's types, and
//! `translate`, which turns one stage of GLSL ES (100 or 300 es) into a naga
//! module. naga reads Vulkan-flavoured desktop GLSL, so the source is first
//! rewritten to that (`rewrite`): `attribute`, `varying` and `in`/`out` get
//! locations, loose uniforms become one uniform block, a `sampler2D` becomes a
//! texture and a sampler, `gl_FragColor` an output, and `gl_FragCoord` is
//! turned so that y counts up from the bottom row, as GL's does. A program that
//! draws into a texture (a framebuffer's) is turned the other way up, so that
//! the texture holds GL's rows, bottom first. The drawing is in
//! `compositor/glsl.rs`.

use std::collections::BTreeMap;
use std::sync::Arc;

use naga::ShaderStage;
use naga::front::glsl::{Frontend, Options};
use serde::Deserialize;

use crate::error::{Error, Result};
use crate::glsl_cpp::Cpp;
use crate::glsl_samplers::{expand_sampler_arrays, finish as finish_samplers, lower_sampler_parameters};

// ---- the recording ----

/// What a `glsl` layer's context did, shared between the scene and the frames
/// resolved from it.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(from = "GlslContent")]
pub struct GlslRecording(pub Arc<GlslContent>);

impl Default for GlslRecording {
    fn default() -> GlslRecording {
        GlslRecording(Arc::new(GlslContent::default()))
    }
}

impl From<GlslContent> for GlslRecording {
    fn from(content: GlslContent) -> GlslRecording {
        GlslRecording(Arc::new(content))
    }
}

fn yes() -> bool {
    true
}

/// The programs, the data they draw from and the calls, in order.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlslContent {
    /// The context's `premultipliedAlpha` attribute: what it draws is read as
    /// premultiplied (the default) or straight colour.
    #[serde(default = "yes")]
    pub premultiplied_alpha: bool,
    /// The context's `alpha` attribute: `false` makes the drawing buffer
    /// opaque.
    #[serde(default = "yes")]
    pub alpha: bool,
    /// The context's `depth` attribute: whether the drawing buffer has a depth
    /// buffer.
    #[serde(default = "yes")]
    pub depth: bool,
    /// The context's `stencil` attribute: whether it has a stencil buffer.
    #[serde(default)]
    pub stencil: bool,
    /// The context's `antialias` attribute: the drawing buffer is multisampled (4 samples, as a browser's is), so the
    /// edges of what is drawn into it are partly covered.
    #[serde(default)]
    pub antialias: bool,
    /// By id.
    #[serde(default)]
    pub programs: BTreeMap<String, GlslProgram>,
    /// Base64 bytes, by id.
    #[serde(default)]
    pub buffers: BTreeMap<String, String>,
    #[serde(default)]
    pub textures: BTreeMap<String, GlslTexture>,
    #[serde(default)]
    pub ops: Vec<GlslOp>,
    /// What a WebGPU context drew (`crate::webgpu`); the fields above are empty then.
    #[serde(default)]
    pub webgpu: Option<crate::webgpu::WebGpuContent>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslProgram {
    pub vertex: String,
    pub fragment: String,
    /// The locations `bindAttribLocation` and the link gave the vertex
    /// shader's attributes.
    #[serde(default)]
    pub attributes: BTreeMap<String, u32>,
}

/// A texture's pixels: a picture file, or RGBA bytes. The sampling state is
/// the draw's (`GlslSampler`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslTexture {
    /// A picture file relative to the scene, or a `data:` URL; its pixels are
    /// straight RGBA8 as the decoder gives them.
    pub src: Option<String>,
    /// Base64 RGBA8, straight alpha, `width * height * 4` bytes.
    pub pixels: Option<String>,
    /// The `id` of a child of the group this recording belongs to
    /// (`GroupLayer::glsl`): the picture is that child, drawn, as the
    /// drawing buffer's size and place would show it.
    pub layer: Option<String>,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    /// `UNPACK_FLIP_Y_WEBGL` when the pixels were uploaded.
    #[serde(default)]
    pub flip_y: bool,
    /// `UNPACK_PREMULTIPLY_ALPHA_WEBGL` when they were uploaded.
    #[serde(default)]
    pub premultiply: bool,
    /// `generateMipmap` was called after the upload.
    #[serde(default)]
    pub mipmaps: bool,
    /// A render target (a framebuffer's texture or renderbuffer): `width` x
    /// `height`, empty, with no `src` or `pixels`. The ops that name it draw
    /// into it, and later draws sample what they left.
    #[serde(default)]
    pub target: bool,
    /// What a target holds: colour (RGBA8) without one.
    pub format: Option<TargetFormat>,
    /// An `SRGB8_ALPHA8` texture: the bytes are sRGB and a shader reads them as linear.
    #[serde(default)]
    pub srgb: bool,
    /// A colour target of a float format, which draws write and samplers read as floats (`EXT_color_buffer_float`).
    pub color_format: Option<ColorFormat>,
    /// The mip levels of a colour target; an op's `level` draws into one.
    #[serde(default = "one")]
    pub levels: u32,
    /// A depth texture of a WebGL 1 context, which samples it as (d, d, d,
    /// 1); WebGL 2 samples (d, 0, 0, 1).
    #[serde(default)]
    pub luminance: bool,
    /// `texSubImage2D` of pictures over parts of an uploaded texture, in order.
    #[serde(default)]
    pub patches: Vec<GlslPatch>,
    /// A 3D texture (`texImage3D`): the number of layers it is `width` x `height`; 0 for a 2D one. Its
    /// texels are `pixels` (RGBA8, `width * height * depth * 4` bytes, x fastest, then y, then z) or `floats`.
    #[serde(default)]
    pub depth: u32,
    /// With `depth`: a 2D array texture (`TEXTURE_2D_ARRAY`, read by a `sampler2DArray`) of `depth` layers, not a
    /// 3D texture.
    #[serde(default)]
    pub array: bool,
    /// A float texture, 2D or 3D (`R32F`, `RGBA16F`, ...): base64 little-endian `f32`s, four for each texel,
    /// kept as half floats, or in full with `float32`.
    pub floats: Option<String>,
    /// The floats are of a 32-bit format: they are kept in full, and a browser filters them with `NEAREST` only.
    #[serde(default)]
    pub float32: bool,
    /// A cube map (`TEXTURE_CUBE_MAP`): `width` x `width` faces, in GL's order (+X, -X, +Y, -Y, +Z, -Z), which
    /// are also the device's layers. With no `faces` the cube is incomplete and samples as opaque black.
    #[serde(default)]
    pub cube: bool,
    #[serde(default)]
    pub faces: Vec<GlslFace>,
}

/// One face of a cube map.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslFace {
    pub src: Option<String>,
    pub pixels: Option<String>,
    #[serde(default)]
    pub flip_y: bool,
    #[serde(default)]
    pub premultiply: bool,
}

/// The float formats a colour target can have.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
pub enum ColorFormat {
    R16F,
    RG16F,
    RGBA16F,
    R32F,
    RG32F,
    RGBA32F,
}

impl ColorFormat {
    pub fn device(self) -> wgpu::TextureFormat {
        use wgpu::TextureFormat as F;
        match self {
            ColorFormat::R16F => F::R16Float,
            ColorFormat::RG16F => F::Rg16Float,
            ColorFormat::RGBA16F => F::Rgba16Float,
            ColorFormat::R32F => F::R32Float,
            ColorFormat::RG32F => F::Rg32Float,
            ColorFormat::RGBA32F => F::Rgba32Float,
        }
    }

    /// 32-bit floats are read `NEAREST` only, as in a browser.
    pub fn is_32(self) -> bool {
        matches!(self, ColorFormat::R32F | ColorFormat::RG32F | ColorFormat::RGBA32F)
    }
}

/// What a depth or stencil target holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetFormat {
    Depth,
    Stencil,
    DepthStencil,
}

impl TargetFormat {
    pub fn has_depth(self) -> bool {
        matches!(self, TargetFormat::Depth | TargetFormat::DepthStencil)
    }
    pub fn has_stencil(self) -> bool {
        matches!(self, TargetFormat::Stencil | TargetFormat::DepthStencil)
    }
}

/// A picture laid over a rectangle of a texture (`texSubImage2D`). Its rows
/// count as the texture's: the first is GL's bottom one.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslPatch {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    /// One of these: a picture file (or `data:` URL), base64 RGBA8 (straight
    /// alpha), or a child of the shader group.
    pub src: Option<String>,
    pub pixels: Option<String>,
    pub layer: Option<String>,
    #[serde(default)]
    pub flip_y: bool,
    #[serde(default)]
    pub premultiply: bool,
}

/// A colour attachment an op draws into: a target and its mip level.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslOutput {
    pub target: String,
    #[serde(default)]
    pub level: u32,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum GlslOp {
    /// `clear` of the drawing buffer or of the target texture `target` names:
    /// its colour with this clear colour (`COLOR_BUFFER_BIT`), its depth
    /// buffer to this value (`DEPTH_BUFFER_BIT`), its stencil buffer
    /// (`STENCIL_BUFFER_BIT`), or several; where, as a draw says it.
    #[serde(rename_all = "camelCase")]
    Clear {
        color: Option<[f64; 4]>,
        depth: Option<f64>,
        stencil: Option<u32>,
        target: Option<String>,
        #[serde(default)]
        level: u32,
        outputs: Option<Vec<Option<GlslOutput>>>,
        depth_stencil: Option<String>,
    },
    Draw(Box<GlslDraw>),
    /// `blitFramebuffer`: a rectangle of one buffer copied over a rectangle of
    /// another.
    Blit(Box<GlslBlit>),
    /// `texSubImage2D` into a target texture: pixels written over a rectangle
    /// of what the ops before it left there.
    Upload(Box<GlslUpload>),
}

/// Where an op draws (the fields of a draw or a clear): the drawing buffer
/// when none is given, else a framebuffer's attachments. `target` (at
/// `level`) is output 0's colour attachment; `outputs` those of outputs 0 and
/// up when there are several (or none), `None` for NONE; `depth_stencil` the
/// framebuffer's depth or stencil buffer.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct GlslDest<'a> {
    pub target: Option<&'a str>,
    pub level: u32,
    pub outputs: Option<&'a [Option<GlslOutput>]>,
    pub depth_stencil: Option<&'a str>,
}

impl<'a> GlslDest<'a> {
    /// Whether the op goes to a framebuffer rather than the drawing buffer.
    pub fn is_framebuffer(&self) -> bool {
        self.target.is_some() || self.outputs.is_some() || self.depth_stencil.is_some()
    }

    /// The colour attachments of outputs 0 and up: the drawing buffer's one
    /// (`None` as the id) for the canvas.
    pub fn colors(&self) -> Vec<Option<(Option<&'a str>, u32)>> {
        match (self.outputs, self.target) {
            (Some(outputs), _) => outputs
                .iter()
                .map(|o| o.as_ref().map(|o| (Some(o.target.as_str()), o.level)))
                .collect(),
            (None, Some(target)) => vec![Some((Some(target), self.level))],
            (None, None) if self.depth_stencil.is_some() => Vec::new(),
            (None, None) => vec![Some((None, 0))],
        }
    }
}

impl GlslOp {
    /// Where a clear or a draw goes; `None` for the other ops.
    pub fn dest(&self) -> Option<GlslDest<'_>> {
        match self {
            GlslOp::Clear {
                target,
                level,
                outputs,
                depth_stencil,
                ..
            } => Some(GlslDest {
                target: target.as_deref(),
                level: *level,
                outputs: outputs.as_deref(),
                depth_stencil: depth_stencil.as_deref(),
            }),
            GlslOp::Draw(d) => Some(d.dest()),
            GlslOp::Blit(_) | GlslOp::Upload(_) => None,
        }
    }
}

/// `texSubImage2D(TEXTURE_2D, 0, x, y, ...)` of a texture a framebuffer
/// draws in. The rows count as the texture's do: the first is GL's bottom
/// one.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslUpload {
    /// The target texture written.
    pub target: String,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    /// One of these: base64 RGBA8 (straight alpha, `width * height * 4`
    /// bytes), a picture file, or a child of the shader group.
    pub pixels: Option<String>,
    pub src: Option<String>,
    pub layer: Option<String>,
    /// `UNPACK_FLIP_Y_WEBGL` was set.
    #[serde(default)]
    pub flip_y: bool,
    /// `UNPACK_PREMULTIPLY_ALPHA_WEBGL` was set.
    #[serde(default)]
    pub premultiply: bool,
}

/// `blitFramebuffer(from..., to..., mask, filter)` between the drawing buffer
/// and the targets: of colour, from the read buffer to one draw buffer; or,
/// with `aspect`, of the depth and stencil buffers, which `src` and `target`
/// then name.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslBlit {
    /// The target read; the drawing buffer without one.
    pub src: Option<String>,
    #[serde(default)]
    pub src_level: u32,
    /// The target written; the drawing buffer without one.
    pub target: Option<String>,
    #[serde(default)]
    pub level: u32,
    /// Depth and stencil instead of colour.
    pub aspect: Option<BlitAspect>,
    /// `x0, y0, x1, y1` of the source, y up from the bottom row. A reversed
    /// pair of corners mirrors.
    pub from: [i32; 4],
    /// The same for the destination.
    pub to: [i32; 4],
    /// `LINEAR` rather than `NEAREST`.
    #[serde(default)]
    pub linear: bool,
    /// `x, y, width, height` of the scissor test, if it was on.
    pub scissor: Option<[i32; 4]>,
}

/// What a depth-and-stencil blit copies.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BlitAspect {
    Depth,
    Stencil,
    DepthStencil,
}

impl BlitAspect {
    pub fn depth(self) -> bool {
        matches!(self, BlitAspect::Depth | BlitAspect::DepthStencil)
    }
    pub fn stencil(self) -> bool {
        matches!(self, BlitAspect::Stencil | BlitAspect::DepthStencil)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GlslMode {
    /// Each vertex a square sprite of `gl_PointSize` pixels, with
    /// `gl_PointCoord` (drawn as two triangles for each point, one instance
    /// each).
    Points,
    Triangles,
    TriangleStrip,
    TriangleFan,
    /// One pixel wide, as lines are in WebGL.
    Lines,
    LineStrip,
    LineLoop,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
pub enum GlslType {
    #[serde(rename = "f32")]
    F32,
    #[serde(rename = "u8")]
    U8,
    #[serde(rename = "i8")]
    I8,
    #[serde(rename = "u16")]
    U16,
    #[serde(rename = "i16")]
    I16,
    #[serde(rename = "u32")]
    U32,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslAttribute {
    pub buffer: String,
    pub size: u32,
    #[serde(rename = "type")]
    pub ty: GlslType,
    #[serde(default)]
    pub normalized: bool,
    /// Bytes; 0 is tightly packed.
    #[serde(default)]
    pub stride: u32,
    #[serde(default)]
    pub offset: u32,
    /// `vertexAttribDivisor`: 0 advances for each vertex, 1 for each instance.
    #[serde(default)]
    pub divisor: u32,
    /// The attribute's array is disabled and it reads the current value (`vertexAttrib4f` and the like), the same for
    /// every vertex. `buffer` then only names the value (no entry of `buffers`), and `size` is 4 of `f32`.
    pub constant: Option<[f32; 4]>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslIndices {
    pub buffer: String,
    #[serde(rename = "type")]
    pub ty: GlslType,
    /// Bytes into the buffer.
    #[serde(default)]
    pub offset: u32,
}

/// One `uniform*` call: `kind` is `f` (`uniform1f`..`4fv`), `i` (`1i`..`4iv`)
/// or `m` (`uniformMatrix*`, column-major).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslUniform {
    pub kind: GlslUniformKind,
    pub value: Vec<f64>,
    /// The array element the first value goes to, for `name[i]`.
    #[serde(default)]
    pub index: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub enum GlslUniformKind {
    #[serde(rename = "f")]
    Float,
    #[serde(rename = "i")]
    Int,
    #[serde(rename = "m")]
    Matrix,
}

/// A texture unit's binding with the sampling state it had.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslSampler {
    pub texture: String,
    #[serde(default = "linear_min")]
    pub min: String,
    #[serde(default = "linear_mag")]
    pub mag: String,
    #[serde(default = "repeat")]
    pub wrap_s: String,
    #[serde(default = "repeat")]
    pub wrap_t: String,
    /// `TEXTURE_WRAP_R`, for a 3D texture.
    #[serde(default = "repeat")]
    pub wrap_r: String,
    /// `TEXTURE_MAX_LEVEL`, when it was set: the last level sampling reads.
    pub max_level: Option<u32>,
    /// `TEXTURE_COMPARE_MODE` was `COMPARE_REF_TO_TEXTURE`: a shadow sampler compares the depth with its reference by
    /// this function (`LEQUAL`, ...).
    pub compare: Option<String>,
}

fn linear_min() -> String {
    "NEAREST_MIPMAP_LINEAR".into()
}
fn linear_mag() -> String {
    "LINEAR".into()
}
fn repeat() -> String {
    "REPEAT".into()
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslBlend {
    pub src_rgb: String,
    pub dst_rgb: String,
    pub src_alpha: String,
    pub dst_alpha: String,
    pub eq_rgb: String,
    pub eq_alpha: String,
    #[serde(default)]
    pub color: [f64; 4],
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslCull {
    /// `FRONT`, `BACK` or `FRONT_AND_BACK`.
    pub face: String,
    /// `CCW` or `CW`: the winding of a front face.
    pub front: String,
}

/// The depth test of a draw: `depthFunc`, `depthMask` and `depthRange`. A draw
/// without it has the test off (and writes no depth).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslDepth {
    /// `NEVER`, `LESS`, `EQUAL`, `LEQUAL`, `GREATER`, `NOTEQUAL`, `GEQUAL` or
    /// `ALWAYS`.
    pub func: String,
    pub mask: bool,
    /// `depthRange(near, far)`, each within 0 to 1, near not above far.
    pub near: f64,
    pub far: f64,
}

/// One face's stencil test: `stencilFuncSeparate` and `stencilOpSeparate`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslStencilFace {
    /// A depth function's name.
    pub func: String,
    /// `KEEP`, `ZERO`, `REPLACE`, `INCR`, `DECR`, `INVERT`, `INCR_WRAP` or
    /// `DECR_WRAP`.
    pub fail: String,
    pub zfail: String,
    pub zpass: String,
}

/// The stencil test of a draw. WebGL refuses a draw whose faces differ in the
/// reference or the masks, so they are one for both, as in wgpu.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslStencil {
    pub r#ref: u32,
    pub value_mask: u32,
    pub write_mask: u32,
    pub front: GlslStencilFace,
    pub back: GlslStencilFace,
}

/// `polygonOffset(factor, units)` with `POLYGON_OFFSET_FILL` on.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslPolygonOffset {
    pub factor: f64,
    pub units: f64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslDraw {
    pub program: String,
    pub mode: GlslMode,
    pub first: u32,
    pub count: u32,
    /// `drawArraysInstanced` and `drawElementsInstanced`: how many instances.
    #[serde(default = "one")]
    pub instances: u32,
    /// `drawElements`: the vertices come from these indices.
    pub indices: Option<GlslIndices>,
    /// By the vertex shader's attribute names.
    #[serde(default)]
    pub attributes: BTreeMap<String, GlslAttribute>,
    /// By the uniform's name, as `getUniformLocation` was given it (without
    /// the `[i]`).
    #[serde(default)]
    pub uniforms: BTreeMap<String, Vec<GlslUniform>>,
    /// The texture units, by number.
    #[serde(default)]
    pub units: BTreeMap<String, GlslSampler>,
    /// `x, y, width, height`, y up from the bottom row.
    pub viewport: [i32; 4],
    pub scissor: Option<[i32; 4]>,
    pub blend: Option<GlslBlend>,
    #[serde(default = "all_true")]
    pub color_mask: [bool; 4],
    pub cull: Option<GlslCull>,
    /// The depth test, if it was on and the buffer drawn into has depth.
    pub depth: Option<GlslDepth>,
    pub polygon_offset: Option<GlslPolygonOffset>,
    /// The stencil test, if it was on and the buffer drawn into has stencil.
    pub stencil: Option<GlslStencil>,
    /// Where it draws (`GlslDest`).
    pub target: Option<String>,
    #[serde(default)]
    pub level: u32,
    pub outputs: Option<Vec<Option<GlslOutput>>>,
    pub depth_stencil: Option<String>,
}

impl GlslDraw {
    pub fn dest(&self) -> GlslDest<'_> {
        GlslDest {
            target: self.target.as_deref(),
            level: self.level,
            outputs: self.outputs.as_deref(),
            depth_stencil: self.depth_stencil.as_deref(),
        }
    }
}

fn one() -> u32 {
    1
}

fn all_true() -> [bool; 4] {
    [true; 4]
}

// ---- source rewriting ----

/// The largest point WebGL draws here (`ALIASED_POINT_SIZE_RANGE` is 1 to this):
/// a larger `gl_PointSize` is drawn at this. Chrome on Apple silicon (ANGLE on
/// Metal) reports the same range.
pub const MAX_POINT_SIZE: f32 = 511.0;

/// The colour outputs a fragment shader can have (`MAX_DRAW_BUFFERS`).
pub const MAX_DRAW_BUFFERS: u32 = 8;

/// The location a point's `gl_PointCoord` travels at: the last of the 16
/// a vertex stage can write.
const POINT_COORD_LOCATION: u32 = 15;

fn unsupported(what: impl std::fmt::Display) -> String {
    format!("unsupported: {what}")
}

/// A GLSL type a uniform or an attribute can have, with the locations it uses
/// as a varying.
fn type_locations(ty: &str) -> Option<u32> {
    Some(match ty {
        "float" | "int" | "uint" | "vec2" | "vec3" | "vec4" | "ivec2" | "ivec3" | "ivec4"
        | "uvec2" | "uvec3" | "uvec4" => 1,
        "mat2" | "mat2x2" => 2,
        "mat3" | "mat3x3" => 3,
        "mat4" | "mat4x4" => 4,
        _ => return None,
    })
}

/// The float components of an attribute type, or `None` for a type a vertex
/// buffer cannot feed.
fn float_components(ty: &str) -> Option<u32> {
    match ty {
        "float" => Some(1),
        "vec2" => Some(2),
        "vec3" => Some(3),
        "vec4" => Some(4),
        _ => None,
    }
}

fn is_builtin_type(ty: &str) -> bool {
    type_locations(ty).is_some()
        || matches!(
            ty,
            "bool" | "bvec2" | "bvec3" | "bvec4" | "mat2x3" | "mat2x4" | "mat3x2"
        )
        || matches!(ty, "mat3x4" | "mat4x2" | "mat4x3")
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Kind {
    Ident,
    Number,
    Punct,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Tok {
    pub(crate) kind: Kind,
    pub(crate) start: usize,
    pub(crate) end: usize,
}

/// `src` with its comments replaced by spaces (newlines kept, so lines hold).
fn strip_comments(src: &str) -> String {
    let b = src.as_bytes();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'/' && b.get(i + 1) == Some(&b'/') {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
        } else if b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
            i += 2;
            out.push(' ');
            while i < b.len() && !(b[i] == b'*' && b.get(i + 1) == Some(&b'/')) {
                if b[i] == b'\n' {
                    out.push('\n');
                }
                i += 1;
            }
            i += 2;
        } else {
            let ch = src[i..].chars().next().expect("in bounds");
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

pub(crate) fn tokenize(src: &str) -> Vec<Tok> {
    let b = src.as_bytes();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_whitespace() {
            i += 1;
        } else if c.is_ascii_alphabetic() || c == b'_' {
            let start = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                i += 1;
            }
            toks.push(Tok {
                kind: Kind::Ident,
                start,
                end: i,
            });
        } else if c.is_ascii_digit() || (c == b'.' && b.get(i + 1).is_some_and(u8::is_ascii_digit))
        {
            let start = i;
            while i < b.len() {
                let d = b[i];
                let exponent_sign = (d == b'+' || d == b'-')
                    && matches!(b[i - 1], b'e' | b'E')
                    && !src[start..i].starts_with("0x");
                if d.is_ascii_alphanumeric() || d == b'.' || d == b'_' || exponent_sign {
                    i += 1;
                } else {
                    break;
                }
            }
            toks.push(Tok {
                kind: Kind::Number,
                start,
                end: i,
            });
        } else {
            let len = src[i..].chars().next().map_or(1, char::len_utf8);
            toks.push(Tok {
                kind: Kind::Punct,
                start: i,
                end: i + len,
            });
            i += len;
        }
    }
    toks
}

/// The member a loose uniform becomes in the block.
#[derive(Clone, Debug, PartialEq)]
pub struct UniformDecl {
    pub name: String,
    pub ty: String,
    /// The array length as written, if it is an array.
    pub array: Option<String>,
}

#[derive(Clone, Debug)]
struct PackedArray {
    name: String,
    /// The element type: `float`, `vec2`, `int`, `ivec2`, `uint` or `uvec2`.
    ty: String,
    len: u32,
}

impl PackedArray {
    /// Elements in one `vec4`.
    fn per_vec4(&self) -> u32 {
        if self.ty.ends_with('2') { 2 } else { 4 }
    }

    /// The `vec4` type the elements travel in.
    fn carrier(&self) -> &'static str {
        match self.ty.as_bytes()[0] {
            b'i' => "ivec4",
            b'u' => "uvec4",
            b'f' | b'v' => "vec4",
            _ => unreachable!("a packed array is of floats, ints or uints"),
        }
    }
}

/// A varying by name, with the locations it takes and its type, shared by
/// the two stages of a program.
#[derive(Clone, Debug, Default)]
pub struct Varyings(pub BTreeMap<String, (u32, String)>);

/// What a sampler reads: a 2D texture, a 3D one (`sampler3D`), a cube map (`samplerCube`) or a 2D array
/// texture (`sampler2DArray`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SamplerDim {
    D2,
    D3,
    Cube,
    Array,
    /// The shadow samplers (`sampler2DShadow` and the like): they read a depth texture and compare it with the
    /// reference the lookup gives, and return how much passes (0 to 1).
    D2Shadow,
    CubeShadow,
    ArrayShadow,
}

impl SamplerDim {
    pub fn shadow(self) -> bool {
        matches!(self, SamplerDim::D2Shadow | SamplerDim::CubeShadow | SamplerDim::ArrayShadow)
    }

    /// The texture a sampler reads, shadow or not.
    pub fn base(self) -> SamplerDim {
        match self {
            SamplerDim::D2Shadow => SamplerDim::D2,
            SamplerDim::CubeShadow => SamplerDim::Cube,
            SamplerDim::ArrayShadow => SamplerDim::Array,
            other => other,
        }
    }
}

/// A sampler uniform of one stage, with the slot it holds in the program: the stages of a program
/// share their samplers, so a name binds at the same place in both.
#[derive(Clone, Debug)]
struct SamplerDecl {
    name: String,
    dim: SamplerDim,
    slot: u32,
}

#[derive(Debug)]
struct Rewritten {
    source: String,
    uniforms: Vec<UniformDecl>,
    /// The `sampler2D` and `sampler3D` uniforms this stage declares.
    samplers: Vec<SamplerDecl>,
    /// The `bool` uniforms: name, GLSL type.
    bools: Vec<(String, String)>,
    /// The `mat2` uniforms (naga cannot lay out a `matCx2` in a uniform
    /// block): name and array length, as a `vec4` each.
    mat2s: Vec<(String, Option<String>)>,
    /// Arrays of scalars and of two-component vectors, which the Metal
    /// backend lays out tighter than a uniform block's 16 bytes an element:
    /// they travel as `vec4`s.
    packed: Vec<PackedArray>,
    /// Attribute name, location, float components.
    attributes: Vec<(String, u32, Option<u32>)>,
    /// The `mat2`, `mat3` and `mat4` attributes: name, size and first location. Each is read as that many `vecN` columns.
    mat_attributes: Vec<(String, u32, u32)>,
    /// The varyings the fragment shader declares and the vertex shader does not write: an error if it reads one.
    unwritten: Vec<String>,
    /// The structs the shader defines, by name and text (on one line): they go ahead of the uniform block, which may use them.
    structs: Vec<(String, String)>,
    /// The varyings this stage declared, with their locations.
    varyings: Vec<(String, u32, String)>,
    /// The locations of the fragment shader's outputs.
    outputs: Vec<u32>,
    uses_frag_coord: bool,
    uses_point_coord: bool,
}

struct RewriteInput<'a> {
    src: &'a str,
    stage: ShaderStage,
    /// What the vertex stage wrote, for the fragment stage to read.
    varyings: &'a mut Varyings,
    /// The program draws into a texture, whose first row is GL's bottom one.
    flip_y: bool,
    /// The program draws points: each is a quad of six vertices, one instance.
    points: bool,
    /// The program's sampler uniforms by name, in slot order; the first stage to declare one adds it.
    slots: &'a mut Vec<(String, SamplerDim)>,
}

/// What a word of code is renamed by: the stage and how the program is drawn.
#[derive(Clone, Copy)]
struct Mode {
    fragment: bool,
    points: bool,
}

#[derive(Default)]
struct Declared {
    names: Vec<(String, Option<String>)>,
    flat: Vec<String>,
    location: Option<u32>,
}

const QUALIFIERS: &[&str] = &[
    "uniform",
    "attribute",
    "varying",
    "in",
    "out",
    "const",
    "flat",
    "smooth",
    "noperspective",
    "centroid",
    "highp",
    "mediump",
    "lowp",
    "invariant",
];

fn is_storage(word: &str) -> bool {
    matches!(word, "uniform" | "attribute" | "varying" | "in" | "out")
}

/// The sampler uniforms named in `declared` are replaced everywhere else by
/// the combined constructor naga reads.
fn rewrite(input: RewriteInput<'_>) -> std::result::Result<Rewritten, String> {
    let RewriteInput {
        src,
        stage,
        varyings,
        flip_y,
        points,
        slots,
    } = input;
    let src = lower_sampler_parameters(&expand_sampler_arrays(&blank_qualifiers(&strip_comments(src))));
    let fragment = stage == ShaderStage::Fragment;

    // Directive lines are set apart: removed, or rewritten as code. Code
    // between them is one chunk each, tokenised on its own, and the depth of
    // braces carries over.
    let mut r = Rewritten {
        source: String::new(),
        uniforms: Vec::new(),
        samplers: Vec::new(),
        bools: Vec::new(),
        mat2s: Vec::new(),
        packed: Vec::new(),
        attributes: Vec::new(),
        mat_attributes: Vec::new(),
        unwritten: Vec::new(),
        structs: Vec::new(),
        varyings: Vec::new(),
        outputs: Vec::new(),
        uses_frag_coord: false,
        uses_point_coord: false,
    };
    let mut body = String::new();
    let mut depth = 0i32;
    let mut chunk = String::new();
    let mut next_attribute = 0u32;
    let mut next_varying = 0u32;
    let mut has_out = false;
    let mut uses_point_size = false;
    let mut declared_samplers: Vec<(String, SamplerDim)> = Vec::new();
    let mut defines = Cpp::new();

    // First pass over the whole text to learn the sampler names, so that a
    // use can precede nothing (declarations come first in GLSL) but a
    // directive can mention one.
    let lines: Vec<&str> = src.split('\n').collect();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let trimmed = line.trim_start();
        if let Some(directive) = trimmed.strip_prefix('#') {
            // A directive with its continuation lines.
            let mut text = line.to_string();
            let mut extra = 0;
            while text.trim_end().ends_with('\\') && index + extra + 1 < lines.len() {
                extra += 1;
                text.push('\n');
                text.push_str(lines[index + extra]);
            }
            flush_chunk(
                &mut chunk,
                &mut body,
                &mut depth,
                &mut r,
                &mut declared_samplers,
                &mut Ctx {
                    stage,
                    varyings,
                    next_attribute: &mut next_attribute,
                    next_varying: &mut next_varying,
                    has_out: &mut has_out,
                    uses_point_size: &mut uses_point_size,
                    points,
                    slots,
                    defines: &defines,
                },
            )?;
            let name = directive.trim_start();
            defines.directive(name)?;
            if name.starts_with("version") || name.starts_with("extension") {
                // Removed, keeping the lines.
                body.push_str(&"\n".repeat(extra));
            } else {
                body.push_str(&rewrite_directive(
                    &text,
                    &declared_samplers,
                    Mode { fragment, points },
                    &mut r,
                ));
            }
            body.push('\n');
            index += extra + 1;
            continue;
        }
        // What a conditional leaves out is not read for declarations (naga drops it as well).
        if defines.active() {
            chunk.push_str(line);
        }
        chunk.push('\n');
        index += 1;
    }
    flush_chunk(
        &mut chunk,
        &mut body,
        &mut depth,
        &mut r,
        &mut declared_samplers,
        &mut Ctx {
            stage,
            varyings,
            next_attribute: &mut next_attribute,
            next_varying: &mut next_varying,
            has_out: &mut has_out,
            uses_point_size: &mut uses_point_size,
            points,
            slots,
            defines: &defines,
        },
    )?;
    // The text ended with the newline added to its last line.
    if body.ends_with('\n') {
        body.pop();
    }
    if let Some(name) = r.unwritten.iter().find(|n| mentions(&body, n)) {
        return Err(format!(
            "the fragment shader reads the varying `{name}`, which the vertex shader does not write"
        ));
    }

    // The prelude is one line of its own, so a line of the page's source is two
    // lines down in the rewritten text.
    let mut prelude = String::new();
    for (_, text) in &r.structs {
        prelude.push_str(text);
    }
    prelude.push_str(&builtin_helpers(&body));
    let mut members = String::new();
    if fragment {
        members.push_str("float _k_fbh; ");
    } else if points {
        // The viewport's size in pixels, which a point's size is in.
        members.push_str("vec2 _k_vp; ");
    }
    for u in &r.uniforms {
        members.push_str(&u.ty);
        members.push(' ');
        members.push_str(&u.name);
        if let Some(n) = &u.array {
            members.push('[');
            members.push_str(n);
            members.push(']');
        }
        members.push_str("; ");
    }
    let hidden = |name: &str| format!("_k_b_{name}");
    for (name, ty) in &r.bools {
        let int_ty = ty.replacen("bvec", "ivec", 1).replacen("bool", "int", 1);
        members.push_str(&format!("{int_ty} {}; ", hidden(name)));
    }
    for (name, array) in &r.mat2s {
        let suffix = array.as_ref().map(|n| format!("[{n}]")).unwrap_or_default();
        members.push_str(&format!("vec4 _k_m2_{name}{suffix}; "));
    }
    for a in &r.packed {
        members.push_str(&format!(
            "{} _k_a_{}[{}]; ",
            a.carrier(),
            a.name,
            a.len.div_ceil(a.per_vec4())
        ));
    }
    if !members.is_empty() {
        let binding = u32::from(fragment);
        prelude.push_str(&format!(
            "layout(set=0, binding={binding}) uniform _KU {{ {members}}}; "
        ));
    }
    for SamplerDecl { name, dim, slot } in &r.samplers {
        let b = 2 + 2 * slot;
        let texture = match dim.base() {
            SamplerDim::D2 => "texture2D",
            SamplerDim::D3 => "texture3D",
            SamplerDim::Cube => "textureCube",
            _ => "texture2DArray",
        };
        let sampler = if dim.shadow() { "samplerShadow" } else { "sampler" };
        prelude.push_str(&format!(
            "layout(set=0, binding={b}) uniform {texture} _k_t_{name}; \
             layout(set=0, binding={}) uniform {sampler} _k_s_{name}; ",
            b + 1
        ));
    }
    for (name, ty) in &r.bools {
        prelude.push_str(&format!("{ty} {name}; "));
    }
    for (name, n, at) in &r.mat_attributes {
        for column in 0..*n {
            prelude.push_str(&format!(
                "layout(location={}) in vec{n} _k_m_{name}_{column}; ",
                at + column
            ));
        }
        prelude.push_str(&format!("mat{n} {name}; "));
    }
    for (name, array) in &r.mat2s {
        let suffix = array.as_ref().map(|n| format!("[{n}]")).unwrap_or_default();
        prelude.push_str(&format!("mat2 {name}{suffix}; "));
    }
    for a in &r.packed {
        prelude.push_str(&format!("{} {}[{}]; ", a.ty, a.name, a.len));
    }
    if fragment {
        if !has_out {
            prelude.push_str("layout(location=0) out vec4 _k_FragColor; ");
        }
        // wgpu counts rows from the top. GL's y counts up from the bottom row,
        // which a texture's rows (stored the other way up) already do.
        let y = if flip_y {
            "gl_FragCoord.y"
        } else {
            "_k_fbh - gl_FragCoord.y"
        };
        prelude.push_str(&format!(
            "vec4 _k_FragCoord() {{ return vec4(gl_FragCoord.x, {y}, gl_FragCoord.z, \
             gl_FragCoord.w); }} "
        ));
    }
    if uses_point_size || (points && !fragment) {
        prelude.push_str("float _k_PointSize; ");
    }
    if points && !fragment {
        prelude.push_str(&format!(
            "layout(location={POINT_COORD_LOCATION}) out vec2 _k_PointCoord; "
        ));
    }
    if fragment && r.uses_point_coord {
        if points {
            prelude.push_str(&format!(
                "layout(location={POINT_COORD_LOCATION}) in vec2 _k_PointCoord; "
            ));
        } else {
            // Not a point: undefined in GL, zero here.
            prelude.push_str("vec2 _k_PointCoord; ");
        }
    }

    // `main` is renamed and wrapped.
    let mut wrapper = String::from("\nvoid main() { ");
    for (name, ty) in &r.bools {
        if ty == "bool" {
            wrapper.push_str(&format!("{name} = ({} != 0); ", hidden(name)));
        } else {
            let n = &ty[4..];
            wrapper.push_str(&format!(
                "{name} = notEqual({}, ivec{n}(0)); ",
                hidden(name)
            ));
        }
    }
    for (name, array) in &r.mat2s {
        match array {
            None => wrapper.push_str(&format!(
                "{name} = mat2(_k_m2_{name}.xy, _k_m2_{name}.zw); "
            )),
            Some(n) => wrapper.push_str(&format!(
                "for (int _k_i = 0; _k_i < {n}; _k_i++) {{ {name}[_k_i] = \
                 mat2(_k_m2_{name}[_k_i].xy, _k_m2_{name}[_k_i].zw); }} "
            )),
        }
    }
    for a in &r.packed {
        let (name, len) = (&a.name, a.len);
        let from = if a.per_vec4() == 4 {
            format!("_k_a_{name}[_k_i / 4][_k_i % 4]")
        } else {
            format!("((_k_i % 2 == 0) ? _k_a_{name}[_k_i / 2].xy : _k_a_{name}[_k_i / 2].zw)")
        };
        wrapper.push_str(&format!(
            "for (int _k_i = 0; _k_i < {len}; _k_i++) {{ {name}[_k_i] = {from}; }} "
        ));
    }
    // A matrix attribute is made of its columns, which are the vertex inputs.
    for (name, n, _) in &r.mat_attributes {
        let columns: Vec<String> = (0..*n).map(|c| format!("_k_m_{name}_{c}")).collect();
        wrapper.push_str(&format!("{name} = mat{n}({}); ", columns.join(", ")));
    }
    if points && !fragment {
        wrapper.push_str("_k_PointSize = 1.0; ");
    }
    wrapper.push_str("_k_main(); ");
    if points && !fragment {
        // Corner `c` of the sprite's two triangles, then the sprite: `gl_PointSize`
        // pixels across, centred on the point. GL clips a point by its centre.
        wrapper.push_str(&format!(
            "int _k_c = int(gl_VertexIndex) % 6; \
             vec2 _k_q = vec2((_k_c == 1 || _k_c == 4 || _k_c == 5) ? 1.0 : -1.0, \
             (_k_c >= 2 && _k_c != 4) ? 1.0 : -1.0); \
             float _k_s = clamp(_k_PointSize, 1.0, {MAX_POINT_SIZE:?}); \
             bool _k_in = abs(gl_Position.x) <= gl_Position.w && abs(gl_Position.y) <= gl_Position.w \
             && abs(gl_Position.z) <= gl_Position.w; \
             gl_Position.xy += _k_q * _k_s / _k_vp * gl_Position.w; \
             if (!_k_in) {{ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }} \
             _k_PointCoord = vec2(_k_q.x * 0.5 + 0.5, 0.5 - _k_q.y * 0.5); "
        ));
    }
    if !fragment {
        // GL's clip space is -w..w deep, wgpu's 0..w.
        wrapper.push_str("gl_Position.z = (gl_Position.z + gl_Position.w) * 0.5; ");
        // A texture's first row is GL's bottom one, wgpu's top.
        if flip_y {
            wrapper.push_str("gl_Position.y = -gl_Position.y; ");
        }
    }
    wrapper.push('}');

    r.source = format!("#version 450\n{prelude}\n{body}{wrapper}\n");
    finish_samplers(&mut r.source);
    Ok(r)
}

struct Ctx<'b> {
    stage: ShaderStage,
    varyings: &'b mut Varyings,
    next_attribute: &'b mut u32,
    next_varying: &'b mut u32,
    has_out: &'b mut bool,
    uses_point_size: &'b mut bool,
    points: bool,
    slots: &'b mut Vec<(String, SamplerDim)>,
    /// The macros defined so far, for the length of an array.
    defines: &'b Cpp,
}

/// What naga does not read and the engine has no use for, blanked so no line or column moves: the precision
/// qualifiers (everything is computed at full precision; naga takes them only in some places), and the `const` of
/// `const in float x`, a read-only parameter, which naga does not take with `in`.
fn blank_qualifiers(code: &str) -> String {
    let word = |c: char| c.is_alphanumeric() || c == '_';
    let mut precise = code.to_string();
    for qualifier in ["highp", "mediump", "lowp"] {
        for (at, _) in code.match_indices(qualifier) {
            let alone = !code[..at].chars().next_back().is_some_and(word)
                && !code[at + qualifier.len()..].chars().next().is_some_and(word);
            if alone {
                precise.replace_range(at..at + qualifier.len(), &" ".repeat(qualifier.len()));
            }
        }
    }
    let code = precise.as_str();
    let mut out = code.to_string();
    for (at, _) in code.match_indices("const") {
        let after = &code[at + 5..];
        let rest = after.trim_start();
        let spaced = after.len() > rest.len();
        let is_word = !code[..at].chars().next_back().is_some_and(word);
        if is_word && spaced && rest.starts_with("in") && !rest[2..].chars().next().is_some_and(word) {
            out.replace_range(at..at + 5, "     ");
        }
    }
    out
}

/// The built-in functions of GLSL ES 3.00 that naga's GLSL front end does not have, written in GLSL, for those `body`
/// calls (renamed `_k_name`).
fn builtin_helpers(body: &str) -> String {
    let mut out = String::new();
    if mentions(body, "_k_modf") {
        for ty in ["float", "vec2", "vec3", "vec4"] {
            out.push_str(&format!("{ty} _k_modf({ty} x, out {ty} i) {{ i = trunc(x); return x - i; }} "));
        }
    }
    if mentions(body, "_k_matrixCompMult") {
        for (columns, rows) in [(2, 2), (3, 3), (4, 4), (2, 3), (2, 4), (3, 2), (3, 4), (4, 2), (4, 3)] {
            let ty = if columns == rows { format!("mat{columns}") } else { format!("mat{columns}x{rows}") };
            let products: Vec<String> = (0..columns).map(|c| format!("a[{c}] * b[{c}]")).collect();
            out.push_str(&format!("{ty} _k_matrixCompMult({ty} a, {ty} b) {{ return {ty}({}); }} ", products.join(", ")));
        }
    }
    out
}

/// Whether `name` appears in `code` as a word.
fn mentions(code: &str, name: &str) -> bool {
    let word = |c: char| c.is_alphanumeric() || c == '_';
    code.match_indices(name).any(|(at, _)| {
        !code[..at].chars().next_back().is_some_and(word)
            && !code[at + name.len()..].chars().next().is_some_and(word)
    })
}

/// The call that reads level 0 in place of the sampling function `word`, if it is one a vertex
/// shader cannot use as it is.
fn implicit_lod(word: &str) -> Option<&'static str> {
    match word {
        "texture" | "texture2D" | "textureCube" => Some("textureLod"),
        "textureProj" | "texture2DProj" => Some("textureProjLod"),
        _ => None,
    }
}

/// A directive other than `#version` and `#extension`: its words go through
/// the same renaming as code (`#define SAMPLE(uv) texture2D(tex, uv)`).
fn rewrite_directive(
    text: &str,
    samplers: &[(String, SamplerDim)],
    mode: Mode,
    r: &mut Rewritten,
) -> String {
    let toks = tokenize(text);
    let mut out = String::new();
    let mut last = 0;
    for (i, t) in toks.iter().enumerate() {
        out.push_str(&text[last..t.start]);
        last = t.end;
        let word = &text[t.start..t.end];
        // The directive's own name stays.
        if i == 1 && toks[0].kind == Kind::Punct {
            out.push_str(word);
            continue;
        }
        match rename(
            word,
            toks.get(i.wrapping_sub(1)).map(|p| &text[p.start..p.end]),
            samplers,
            mode,
        ) {
            Some(new) => {
                if word == "gl_FragCoord" {
                    r.uses_frag_coord = true;
                }
                if word == "gl_PointCoord" {
                    r.uses_point_coord = true;
                }
                out.push_str(&new);
            }
            None => out.push_str(word),
        }
    }
    out.push_str(&text[last..]);
    out
}

/// What a word of code becomes, if it is renamed.
fn rename(
    word: &str,
    prev: Option<&str>,
    samplers: &[(String, SamplerDim)],
    mode: Mode,
) -> Option<String> {
    let Mode { fragment, points } = mode;
    if prev == Some(".") {
        return None;
    }
    Some(match word {
        "texture2D" => "texture".into(),
        "texture2DProj" => "textureProj".into(),
        "textureCube" => "texture".into(),
        // naga's GLSL front end lacks these; `builtin_helpers` defines them.
        "modf" => "_k_modf".into(),
        "matrixCompMult" => "_k_matrixCompMult".into(),
        "texture2DLod" | "texture2DLodEXT" | "textureCubeLod" | "textureCubeLodEXT" => {
            "textureLod".into()
        }
        "gl_FragColor" if fragment => "_k_FragColor".into(),
        "gl_FragCoord" if fragment => "_k_FragCoord()".into(),
        "gl_PointSize" => "_k_PointSize".into(),
        // wgpu's `vertex_index` counts from the draw's `first`, as GL's does,
        // and is the index itself in an indexed draw.
        // A point is an instance of six vertices: its index is the instance's.
        "gl_VertexID" if !fragment && points => "int(gl_InstanceIndex)".into(),
        "gl_VertexID" if !fragment => "int(gl_VertexIndex)".into(),
        "gl_InstanceID" if !fragment && points => "0".into(),
        "gl_InstanceID" if !fragment => "int(gl_InstanceIndex)".into(),
        "gl_PointCoord" if fragment => "_k_PointCoord".into(),
        w => match samplers.iter().find(|(name, _)| name == w) {
            Some((_, SamplerDim::D2)) => format!("sampler2D(_k_t_{w}, _k_s_{w})"),
            Some((_, SamplerDim::D3)) => format!("sampler3D(_k_t_{w}, _k_s_{w})"),
            Some((_, SamplerDim::Cube)) => format!("samplerCube(_k_t_{w}, _k_s_{w})"),
            Some((_, SamplerDim::Array)) => format!("sampler2DArray(_k_t_{w}, _k_s_{w})"),
            Some((_, SamplerDim::D2Shadow)) => format!("sampler2DShadow(_k_t_{w}, _k_s_{w})"),
            Some((_, SamplerDim::CubeShadow)) => format!("samplerCubeShadow(_k_t_{w}, _k_s_{w})"),
            Some((_, SamplerDim::ArrayShadow)) => format!("sampler2DArrayShadow(_k_t_{w}, _k_s_{w})"),
            None => return None,
        },
    })
}

fn flush_chunk(
    chunk: &mut String,
    body: &mut String,
    depth: &mut i32,
    r: &mut Rewritten,
    samplers: &mut Vec<(String, SamplerDim)>,
    ctx: &mut Ctx<'_>,
) -> std::result::Result<(), String> {
    if chunk.is_empty() {
        return Ok(());
    }
    let text = std::mem::take(chunk);
    let out = rewrite_chunk(&text, depth, r, samplers, ctx)?;
    body.push_str(&out);
    Ok(())
}

fn word<'a>(text: &'a str, t: &Tok) -> &'a str {
    &text[t.start..t.end]
}

fn rewrite_chunk(
    text: &str,
    depth: &mut i32,
    r: &mut Rewritten,
    samplers: &mut Vec<(String, SamplerDim)>,
    ctx: &mut Ctx<'_>,
) -> std::result::Result<String, String> {
    let fragment = ctx.stage == ShaderStage::Fragment;
    let toks = tokenize(text);
    // A vertex shader has no derivatives: its `texture` calls read level 0, so each gets the argument
    // naga wants. `lod_close` holds the tokens of the `)` that close such calls.
    let mut lod_close = std::collections::HashSet::new();
    if !fragment {
        for (k, t) in toks.iter().enumerate() {
            if t.kind == Kind::Ident
                && implicit_lod(word(text, t)).is_some()
                && toks.get(k + 1).map(|t| word(text, t)) == Some("(")
                && k.checked_sub(1).map(|p| word(text, &toks[p])) != Some(".")
            {
                let mut depth = 0;
                for (m, t) in toks.iter().enumerate().skip(k + 1) {
                    match word(text, t) {
                        "(" => depth += 1,
                        ")" => {
                            depth -= 1;
                            if depth == 0 {
                                lod_close.insert(m);
                                break;
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    let mut out = String::new();
    let mut last = 0usize;
    let mut i = 0usize;
    // Copies the tokens in `from..to` as code, renamed.
    let code = |out: &mut String,
                last: &mut usize,
                from: usize,
                to: usize,
                r: &mut Rewritten,
                ctx: &mut Ctx<'_>,
                samplers: &[(String, SamplerDim)]| {
        let mut k = from;
        while k < to {
            let t = &toks[k];
            out.push_str(&text[*last..t.start]);
            if lod_close.contains(&k) {
                out.push_str(", 0.0");
            }
            *last = t.end;
            let w = word(text, t);
            let prev = k.checked_sub(1).map(|p| word(text, &toks[p]));
            if t.kind == Kind::Ident {
                if !fragment
                    && prev != Some(".")
                    && toks.get(k + 1).map(|t| word(text, t)) == Some("(")
                    && let Some(lod) = implicit_lod(w)
                {
                    out.push_str(lod);
                    k += 1;
                    continue;
                }
                if w == "gl_FragData" {
                    // `gl_FragData[0]`.
                    if toks.get(k + 1).map(|t| word(text, t)) == Some("[")
                        && toks.get(k + 2).map(|t| word(text, t)) == Some("0")
                        && toks.get(k + 3).map(|t| word(text, t)) == Some("]")
                    {
                        out.push_str("_k_FragColor");
                        *last = toks[k + 3].end;
                        k += 4;
                        continue;
                    }
                    out.push_str(w);
                    k += 1;
                    continue;
                }
                if w == "main"
                    && prev == Some("void")
                    && toks.get(k + 1).map(|t| word(text, t)) == Some("(")
                {
                    out.push_str("_k_main");
                    k += 1;
                    continue;
                }
                if let Some(new) = rename(
                    w,
                    prev,
                    samplers,
                    Mode {
                        fragment,
                        points: ctx.points,
                    },
                ) {
                    if w == "gl_FragCoord" {
                        r.uses_frag_coord = true;
                    }
                    if w == "gl_PointCoord" {
                        r.uses_point_coord = true;
                    }
                    if w == "gl_PointSize" {
                        *ctx.uses_point_size = true;
                    }
                    out.push_str(&new);
                    k += 1;
                    continue;
                }
            }
            out.push_str(w);
            k += 1;
        }
    };

    while i < toks.len() {
        if *depth > 0 {
            // Inside a function body (or a struct): code up to the brace
            // that closes it.
            let t = &toks[i];
            match word(text, t) {
                "{" => *depth += 1,
                "}" => *depth -= 1,
                _ => {}
            }
            code(&mut out, &mut last, i, i + 1, r, ctx, samplers);
            i += 1;
            continue;
        }
        // A statement at global scope.
        let start = i;
        let mut j = i;
        let mut paren = 0i32;
        let mut has_paren = false;
        let mut has_brace = false;
        let mut end_kind = None;
        while j < toks.len() {
            match word(text, &toks[j]) {
                "(" => {
                    paren += 1;
                    has_paren = true;
                }
                ")" => paren -= 1,
                ";" if paren == 0 => {
                    end_kind = Some(';');
                    break;
                }
                "{" if paren == 0 => {
                    if has_paren {
                        end_kind = Some('{');
                        break;
                    }
                    // A struct or a block: skip its body.
                    has_brace = true;
                    let mut d = 0;
                    while j < toks.len() {
                        match word(text, &toks[j]) {
                            "{" => d += 1,
                            "}" => {
                                d -= 1;
                                if d == 0 {
                                    break;
                                }
                            }
                            _ => {}
                        }
                        j += 1;
                    }
                }
                _ => {}
            }
            j += 1;
        }
        match end_kind {
            Some('{') => {
                // A function: its head as code, then the body at depth 1.
                code(&mut out, &mut last, start, j + 1, r, ctx, samplers);
                *depth = 1;
                i = j + 1;
            }
            Some(';') => {
                let stmt = &toks[start..j];
                // The declaration is rebuilt or dropped, else it is code.
                match declaration(text, stmt, has_brace, r, samplers, ctx)? {
                    Some(replacement) => {
                        out.push_str(&text[last..toks[start].start]);
                        out.push_str(&replacement);
                        // Keep the lines the statement spanned.
                        let spanned = text[toks[start].start..toks[j].end].matches('\n').count();
                        out.push_str(&"\n".repeat(spanned));
                        last = toks[j].end;
                    }
                    None => code(&mut out, &mut last, start, j + 1, r, ctx, samplers),
                }
                i = j + 1;
            }
            _ => {
                // An unterminated statement: let naga report it.
                code(&mut out, &mut last, start, toks.len(), r, ctx, samplers);
                i = toks.len();
            }
        }
    }
    out.push_str(&text[last..]);
    Ok(out)
}

/// Reads the global declaration `stmt` (without its `;`). `Some(text)` is what
/// replaces it; `None` leaves it as code.
fn declaration(
    text: &str,
    stmt: &[Tok],
    has_body: bool,
    r: &mut Rewritten,
    samplers: &mut Vec<(String, SamplerDim)>,
    ctx: &mut Ctx<'_>,
) -> std::result::Result<Option<String>, String> {
    let fragment = ctx.stage == ShaderStage::Fragment;
    let w = |k: usize| word(text, &stmt[k]);
    if stmt.is_empty() {
        return Ok(None);
    }
    if w(0) == "precision" {
        return Ok(Some(String::new()));
    }
    if w(0) == "struct" && has_body {
        // Moved ahead of the uniform block, which may hold one; the lines it spanned stay.
        let name = stmt.get(1).map(|_| w(1).to_string()).unwrap_or_default();
        let close = stmt.iter().rposition(|t| word(text, t) == "}");
        let Some(close) = close.filter(|c| c + 1 == stmt.len()) else {
            return Err(unsupported(format!(
                "`struct {name}` declared together with a variable; declare the struct, then the variable"
            )));
        };
        let source = text[stmt[0].start..stmt[close].end].replace('\n', " ");
        r.structs.push((name, format!("{source}; ")));
        return Ok(Some(String::new()));
    }
    // Qualifiers.
    let mut k = 0;
    let mut storage: Option<&str> = None;
    let mut interpolation: Vec<&str> = Vec::new();
    let mut location: Option<u32> = None;
    while k < stmt.len() {
        let s = w(k);
        if s == "layout" {
            let mut d = 0;
            let mut inner = String::new();
            while k < stmt.len() {
                let t = w(k);
                if t == "(" {
                    d += 1;
                } else if t == ")" {
                    d -= 1;
                    if d == 0 {
                        k += 1;
                        break;
                    }
                } else if d > 0 {
                    inner.push_str(t);
                }
                k += 1;
            }
            if let Some(v) = inner
                .split(',')
                .find_map(|p| p.strip_prefix("location="))
                .and_then(|v| v.parse().ok())
            {
                location = Some(v);
            }
            continue;
        }
        if stmt[k].kind != Kind::Ident || !QUALIFIERS.contains(&s) {
            break;
        }
        if is_storage(s) {
            storage = Some(s);
        } else if matches!(s, "flat" | "smooth" | "noperspective" | "centroid") {
            interpolation.push(s);
        } else if s == "const" {
            return Ok(None);
        }
        k += 1;
    }
    let Some(storage) = storage else {
        return Ok(None);
    };
    if has_body {
        return Err(unsupported(format!(
            "an interface block with `{storage}`; declare the variables one by one"
        )));
    }
    let Some(ty_tok) = stmt.get(k) else {
        return Err(format!("`{storage}` needs a type"));
    };
    let ty = word(text, ty_tok).to_string();
    k += 1;
    // Declarators.
    let mut declared = Declared {
        location,
        flat: interpolation.iter().map(|s| s.to_string()).collect(),
        names: Vec::new(),
    };
    while k < stmt.len() {
        if stmt[k].kind != Kind::Ident {
            return Err(format!(
                "unexpected `{}` in a `{storage}` declaration",
                w(k)
            ));
        }
        let name = w(k).to_string();
        k += 1;
        let mut array = None;
        if k < stmt.len() && w(k) == "[" {
            let mut n = String::new();
            k += 1;
            while k < stmt.len() && w(k) != "]" {
                n.push_str(w(k));
                k += 1;
            }
            k += 1;
            array = Some(ctx.defines.length(&n));
        }
        if k < stmt.len() && w(k) == "=" {
            return Err(format!(
                "`{name}`: a `{storage}` variable has no initialiser"
            ));
        }
        let after = name.clone();
        declared.names.push((name, array));
        if k < stmt.len() {
            if w(k) != "," {
                return Err(format!("unexpected `{}` after `{after}`", w(k)));
            }
            k += 1;
        }
    }
    if declared.names.is_empty() {
        return Err(format!("`{storage}` declares nothing"));
    }

    let mut text_out = String::new();
    match storage {
        "uniform" => {
            for (name, array) in declared.names {
                if matches!(
                    ty.as_str(),
                    "sampler2D"
                        | "sampler3D"
                        | "samplerCube"
                        | "sampler2DArray"
                        | "sampler2DShadow"
                        | "samplerCubeShadow"
                        | "sampler2DArrayShadow"
                ) {
                    if array.is_some() {
                        return Err(unsupported(format!("`{name}`: an array of samplers")));
                    }
                    let dim = match ty.as_str() {
                        "sampler2D" => SamplerDim::D2,
                        "sampler3D" => SamplerDim::D3,
                        "sampler2DArray" => SamplerDim::Array,
                        "sampler2DShadow" => SamplerDim::D2Shadow,
                        "samplerCubeShadow" => SamplerDim::CubeShadow,
                        "sampler2DArrayShadow" => SamplerDim::ArrayShadow,
                        _ => SamplerDim::Cube,
                    };
                    let slot = match ctx.slots.iter().position(|(n, _)| *n == name) {
                        Some(slot) if ctx.slots[slot].1 == dim => slot,
                        Some(_) => {
                            return Err(format!(
                                "the sampler `{name}` is not of the same type in both shaders"
                            ));
                        }
                        None => {
                            ctx.slots.push((name.clone(), dim));
                            ctx.slots.len() - 1
                        }
                    };
                    r.samplers.push(SamplerDecl {
                        name: name.clone(),
                        dim,
                        slot: slot as u32,
                    });
                    samplers.push((name, dim));
                } else if ty.contains("sampler") {
                    return Err(unsupported(format!(
                        "`{name}`: a `{ty}` uniform; only `sampler2D`, `sampler3D`, `samplerCube`, `sampler2DArray` and the shadow samplers of the first, third and fourth are available"
                    )));
                } else if ty.starts_with('b') && is_builtin_type(&ty) {
                    if array.is_some() {
                        return Err(unsupported(format!("`{name}`: an array of `{ty}`")));
                    }
                    r.bools.push((name, ty.clone()));
                } else if ty == "mat2" || ty == "mat2x2" {
                    if let Some(n) = &array
                        && n.parse::<u32>().is_err()
                    {
                        return Err(unsupported(format!(
                            "`{name}`: the length of an array of mat2 must be a number, or a macro defined as one, got `{n}`"
                        )));
                    }
                    r.mat2s.push((name, array));
                } else if let Some(n) = array.as_ref().filter(|_| {
                    matches!(
                        ty.as_str(),
                        "float" | "vec2" | "int" | "ivec2" | "uint" | "uvec2"
                    )
                }) {
                    let len = n.parse::<u32>().ok().filter(|l| *l > 0).ok_or_else(|| {
                        unsupported(format!(
                            "`{name}`: the length of an array uniform must be a number, or a macro defined as one, got `{n}`"
                        ))
                    })?;
                    r.packed.push(PackedArray {
                        name,
                        ty: ty.clone(),
                        len,
                    });
                } else if is_builtin_type(&ty) {
                    r.uniforms.push(UniformDecl {
                        name,
                        ty: ty.clone(),
                        array,
                    });
                } else if let Some((_, definition)) = r.structs.iter().find(|(n, _)| *n == ty) {
                    check_uniform_struct(&name, &ty, definition, &r.structs)?;
                    r.uniforms.push(UniformDecl {
                        name,
                        ty: ty.clone(),
                        array,
                    });
                } else {
                    return Err(unsupported(format!(
                        "`{name}`: a uniform of type `{ty}` (not a type or a struct this shader defines)"
                    )));
                }
            }
        }
        "attribute" | "in" if !fragment => {
            for (name, array) in declared.names {
                if array.is_some() {
                    return Err(unsupported(format!("`{name}`: an array attribute")));
                }
                let taken = type_locations(&ty)
                    .ok_or_else(|| unsupported(format!("`{name}`: an attribute of type `{ty}`")))?;
                // Draws name their attributes, so the location is only a slot: the live attributes take the lowest
                // free ones (a page's own locations count all it declared, which a conditional may leave out, and
                // the device holds 16).
                let at = declared.location.unwrap_or_else(|| {
                    let mut l = 0;
                    while r.attributes.iter().any(|a| a.1 >= l && a.1 < l + taken) {
                        l += 1;
                    }
                    l
                });
                *ctx.next_attribute = at + taken;
                if let Some(n) = ty.strip_prefix("mat").and_then(|n| n.chars().next()?.to_digit(10)) {
                    // A matrix cannot be a vertex input: its columns are, at consecutive locations, and the
                    // matrix is made of them at the start of `main`.
                    for column in 0..n {
                        r.attributes.push((format!("{name}[{column}]"), at + column, Some(n)));
                    }
                    r.mat_attributes.push((name.clone(), n, at));
                    continue;
                }
                r.attributes.push((name.clone(), at, float_components(&ty)));
                text_out.push_str(&format!("layout(location={at}) in {ty} {name}; "));
            }
        }
        "varying" | "in" | "out" if !(storage == "out" && fragment) => {
            // A varying: out of the vertex stage, in to the fragment stage.
            let outgoing = !fragment;
            let dir = if outgoing { "out" } else { "in" };
            for (name, array) in declared.names {
                let per = type_locations(&ty)
                    .ok_or_else(|| unsupported(format!("`{name}`: a varying of type `{ty}`")))?;
                let count = match &array {
                    Some(n) => n.parse::<u32>().map_err(|_| {
                        unsupported(format!(
                            "`{name}`: the array length `{n}` of a varying must be a number, or a macro defined as one"
                        ))
                    })?,
                    None => 1,
                };
                let at = if outgoing {
                    let at = declared.location.unwrap_or(*ctx.next_varying);
                    *ctx.next_varying = at + per * count;
                    ctx.varyings.0.insert(name.clone(), (at, ty.clone()));
                    at
                } else {
                    match ctx.varyings.0.get(&name) {
                        Some((at, vty)) if *vty == ty => *at,
                        Some((_, vty)) => {
                            return Err(format!(
                                "the varying `{name}` is a `{ty}` in the fragment shader and a `{vty}` in the vertex shader"
                            ));
                        }
                        None => {
                            // GL links a fragment shader that declares such a varying and never reads it.
                            r.unwritten.push(name);
                            continue;
                        }
                    }
                };
                r.varyings.push((name.clone(), at, ty.clone()));
                let interp = declared.flat.join(" ");
                let suffix = array.map(|n| format!("[{n}]")).unwrap_or_default();
                text_out.push_str(&format!(
                    "layout(location={at}) {interp} {dir} {ty} {name}{suffix}; "
                ));
            }
        }
        "out" => {
            // A fragment output: the colour attachment `drawBuffers` maps its
            // location to.
            for (name, array) in declared.names {
                if array.is_some() {
                    return Err(unsupported(format!("`{name}`: an array output")));
                }
                let at = declared.location.unwrap_or(0);
                if at >= MAX_DRAW_BUFFERS {
                    return Err(unsupported(format!(
                        "`{name}`: an output at location {at} (there are {MAX_DRAW_BUFFERS} draw buffers)"
                    )));
                }
                if r.outputs.contains(&at) {
                    return Err(format!("two outputs at location {at}"));
                }
                r.outputs.push(at);
                *ctx.has_out = true;
                text_out.push_str(&format!("layout(location={at}) out {ty} {name}; "));
            }
        }
        _ => {
            return Err(unsupported(format!(
                "`{storage}` in a {} shader",
                if fragment { "fragment" } else { "vertex" }
            )));
        }
    }
    Ok(Some(text_out))
}

// ---- reflection ----

/// The shape of a uniform block member, with where it sits.
#[derive(Clone, Debug, PartialEq)]
pub struct UniformMember {
    pub name: String,
    pub offset: u32,
    pub scalar: ScalarKind,
    /// Components of one element: 1 for a scalar, `n` for a vector, and
    /// `columns * rows` for a matrix.
    pub components: u32,
    /// Matrix columns and the rows of each (`columns` is 1 otherwise).
    pub columns: u32,
    pub rows: u32,
    /// Array length and element stride in bytes, for an array.
    pub array: Option<(u32, u32)>,
    pub is_bool: bool,
    /// A `mat2`, kept as four floats in a `vec4`, column-major.
    pub is_mat2: bool,
    /// An array of scalars (1) or of two-component vectors (2), kept in
    /// `vec4`s: how many components an element has.
    pub packed: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScalarKind {
    Float,
    Sint,
    Uint,
}

/// The texture unit a sampler reads: the last value a call gave its uniform, or for the element of an array of
/// samplers (`_k_sa_name_3`, see `glsl_samplers.rs`) the value the calls gave that element of the array.
pub fn sampler_unit(calls: &BTreeMap<String, Vec<GlslUniform>>, name: &str) -> i64 {
    let element = name
        .strip_prefix("_k_sa_")
        .and_then(|rest| rest.rsplit_once('_'))
        .and_then(|(array, k)| Some((array, k.parse::<usize>().ok()?)));
    if let Some((array, k)) = element {
        let mut unit = 0;
        for call in calls.get(array).into_iter().flatten() {
            let first = call.index as usize;
            if k >= first && k - first < call.value.len() {
                unit = call.value[k - first] as i64;
            }
        }
        return unit;
    }
    calls
        .get(name)
        .and_then(|calls| calls.last())
        .and_then(|call| call.value.first())
        .map_or(0, |v| *v as i64)
}

/// A texture a stage samples and the bindings of its texture and its sampler,
/// which are the same in both stages of a program.
#[derive(Clone, Debug, PartialEq)]
pub struct SamplerBinding {
    pub name: String,
    pub dim: SamplerDim,
    pub texture: u32,
    pub sampler: u32,
}

/// One stage, translated.
pub struct Stage {
    pub module: naga::Module,
    pub stage: ShaderStage,
    pub uniforms: Vec<UniformMember>,
    /// The bytes the uniform block takes (0 when it has none).
    pub uniform_size: u32,
    pub samplers: Vec<SamplerBinding>,
    /// Attribute name, location, float components.
    pub attributes: Vec<(String, u32, Option<u32>)>,
    /// The locations the fragment shader writes colour at (empty for the
    /// vertex stage).
    pub outputs: Vec<u32>,
    pub uses_frag_coord: bool,
    /// The offset of the drawing buffer's height (the fragment stage's).
    pub fbh_offset: Option<u32>,
    /// The offset of the viewport's width and height (the vertex stage of a
    /// program that draws points).
    pub vp_offset: Option<u32>,
}

impl std::fmt::Debug for Stage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Stage")
            .field("stage", &self.stage)
            .field("uniforms", &self.uniforms)
            .field("samplers", &self.samplers)
            .field("attributes", &self.attributes)
            .finish_non_exhaustive()
    }
}

/// A program's two stages.
#[derive(Debug)]
pub struct Translated {
    pub vertex: Stage,
    pub fragment: Stage,
    /// The samplers either stage reads, in binding order, with the stages that read each.
    pub samplers: Vec<(SamplerBinding, SamplerStages)>,
}

/// Which stages of a program read a sampler.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SamplerStages {
    pub vertex: bool,
    pub fragment: bool,
}

/// Reads `rewritten` with naga, checks it, and works out its interface.
fn parse_stage(stage: ShaderStage, r: Rewritten) -> std::result::Result<Stage, String> {
    let label = if stage == ShaderStage::Vertex {
        "vertex shader"
    } else {
        "fragment shader"
    };
    let mut frontend = Frontend::default();
    let module = frontend
        .parse(&Options::from(stage), &r.source)
        .map_err(|e| {
            // The version and the prelude take two lines.
            let mut msg = format!("{label}:");
            for err in &e.errors {
                let at = err.meta.location(&r.source);
                msg.push_str(&format!(
                    " {}:{}: {};",
                    at.line_number.saturating_sub(2).max(1),
                    at.line_position,
                    err.kind
                ));
            }
            msg
        })?;
    naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        // packHalf2x16 and unpackHalf2x16 are WGSL's pack2x16float and unpack2x16float.
        naga::valid::Capabilities::SHADER_FLOAT16_IN_FLOAT32,
    )
    .validate(&module)
    .map_err(|e| {
        // The cause is in the chain of sources: the top message says only which function is invalid.
        let mut message = format!("{label}: {}", e.as_inner());
        let mut cause = std::error::Error::source(e.as_inner());
        while let Some(c) = cause {
            message.push_str(&format!(": {c}"));
            cause = c.source();
        }
        message
    })?;

    // The uniform block, by the binding the prelude gave it.
    let block_binding = u32::from(stage == ShaderStage::Fragment);
    let mut uniforms = Vec::new();
    let mut uniform_size = 0;
    let mut samplers: Vec<SamplerBinding> = r
        .samplers
        .iter()
        .map(|d| SamplerBinding {
            name: d.name.clone(),
            dim: d.dim,
            texture: 2 + 2 * d.slot,
            sampler: 3 + 2 * d.slot,
        })
        .collect();
    let mut fbh_offset = None;
    let mut vp_offset = None;
    for (_, gv) in module.global_variables.iter() {
        let Some(binding) = &gv.binding else { continue };
        if gv.space != naga::AddressSpace::Uniform || binding.binding != block_binding {
            continue;
        }
        let naga::TypeInner::Struct { members, span } = &module.types[gv.ty].inner else {
            continue;
        };
        uniform_size = *span;
        for m in members {
            let Some(name) = m.name.clone() else { continue };
            if is_struct_uniform(&module, m.ty) {
                struct_leaves(&module, &name, m.offset, m.ty, &mut uniforms)?;
                continue;
            }
            let member = member_of(&module, &name, m.offset, m.ty)?;
            if name == "_k_fbh" {
                fbh_offset = Some(m.offset);
            } else if name == "_k_vp" {
                vp_offset = Some(m.offset);
            } else if let Some(real) = name.strip_prefix("_k_b_") {
                let mut member = member;
                member.name = real.to_string();
                member.is_bool = true;
                uniforms.push(member);
            } else if let Some(real) = name.strip_prefix("_k_a_") {
                let packed = r
                    .packed
                    .iter()
                    .find(|a| a.name == real)
                    .ok_or_else(|| format!("{label}: lost the array `{real}`"))?;
                let mut member = member;
                member.name = real.to_string();
                member.packed = Some(if packed.ty.ends_with('2') { 2 } else { 1 });
                member.array = Some((packed.len, 16));
                member.components = member.packed.expect("set above");
                member.columns = 1;
                member.rows = member.components;
                uniforms.push(member);
            } else if let Some(real) = name.strip_prefix("_k_m2_") {
                let mut member = member;
                member.name = real.to_string();
                member.is_mat2 = true;
                uniforms.push(member);
            } else {
                uniforms.push(member);
            }
        }
    }
    samplers.retain(|s| {
        module
            .global_variables
            .iter()
            .any(|(_, gv)| gv.binding.as_ref().is_some_and(|b| b.binding == s.texture))
    });
    let outputs = match stage {
        ShaderStage::Fragment if r.outputs.is_empty() => vec![0],
        _ => r.outputs,
    };
    Ok(Stage {
        module,
        stage,
        uniforms,
        uniform_size,
        samplers,
        outputs,
        attributes: r.attributes,
        uses_frag_coord: r.uses_frag_coord,
        fbh_offset,
        vp_offset,
    })
}

/// A struct uniform's fields are numbers, vectors and matrices (or structs of them), which have a layout a
/// uniform block can hold: no booleans, `mat2` (naga lays it out differently) or samplers.
fn check_uniform_struct(
    uniform: &str,
    ty: &str,
    definition: &str,
    structs: &[(String, String)],
) -> std::result::Result<(), String> {
    let body = definition
        .split_once('{')
        .and_then(|(_, rest)| rest.rsplit_once('}'))
        .map_or("", |(inside, _)| inside);
    for field in body.split(';').map(str::trim).filter(|f| !f.is_empty()) {
        let field_type = field
            .split_whitespace()
            .find(|w| !matches!(*w, "highp" | "mediump" | "lowp"))
            .unwrap_or("");
        let known_struct = structs.iter().any(|(n, _)| n == field_type);
        if !known_struct
            && (!is_builtin_type(field_type)
                || field_type.starts_with('b')
                || matches!(field_type, "mat2" | "mat2x2" | "mat2x3" | "mat2x4" | "mat3x2" | "mat4x2"))
        {
            return Err(unsupported(format!(
                "`{uniform}`: the field `{field}` of the uniform struct `{ty}` has a type that is not a float, int, uint, vector, `mat3` or `mat4`"
            )));
        }
    }
    Ok(())
}

/// The leaves of a struct uniform, or of an array of them, named as WebGL names them
/// (`lights[1].color`).
fn struct_leaves(
    module: &naga::Module,
    name: &str,
    offset: u32,
    ty: naga::Handle<naga::Type>,
    out: &mut Vec<UniformMember>,
) -> std::result::Result<(), String> {
    use naga::TypeInner as T;
    match &module.types[ty].inner {
        T::Array {
            base,
            size: naga::ArraySize::Constant(n),
            stride,
        } if matches!(module.types[*base].inner, T::Struct { .. }) => {
            for i in 0..n.get() {
                struct_leaves(module, &format!("{name}[{i}]"), offset + i * stride, *base, out)?;
            }
        }
        T::Struct { members, .. } => {
            for m in members {
                let field = m.name.clone().unwrap_or_default();
                struct_leaves(module, &format!("{name}.{field}"), offset + m.offset, m.ty, out)?;
            }
        }
        _ => out.push(member_of(module, name, offset, ty)?),
    }
    Ok(())
}

/// Whether a block member is a struct, or an array of them.
fn is_struct_uniform(module: &naga::Module, ty: naga::Handle<naga::Type>) -> bool {
    use naga::TypeInner as T;
    match &module.types[ty].inner {
        T::Struct { .. } => true,
        T::Array { base, .. } => matches!(module.types[*base].inner, T::Struct { .. }),
        _ => false,
    }
}

fn member_of(
    module: &naga::Module,
    name: &str,
    offset: u32,
    ty: naga::Handle<naga::Type>,
) -> std::result::Result<UniformMember, String> {
    use naga::TypeInner as T;
    let scalar_kind = |s: &naga::Scalar| match s.kind {
        naga::ScalarKind::Float => Ok(ScalarKind::Float),
        naga::ScalarKind::Sint => Ok(ScalarKind::Sint),
        naga::ScalarKind::Uint => Ok(ScalarKind::Uint),
        _ => Err(unsupported(format!("the uniform `{name}`'s type"))),
    };
    let (inner, array) = match &module.types[ty].inner {
        T::Array {
            base,
            size: naga::ArraySize::Constant(n),
            stride,
        } => (&module.types[*base].inner, Some((n.get(), *stride))),
        other => (other, None),
    };
    let (scalar, columns, rows) = match inner {
        T::Scalar(s) => (scalar_kind(s)?, 1, 1),
        T::Vector { size, scalar } => (scalar_kind(scalar)?, 1, *size as u32),
        T::Matrix {
            columns,
            rows,
            scalar,
        } => (scalar_kind(scalar)?, *columns as u32, *rows as u32),
        _ => return Err(unsupported(format!("the uniform `{name}`'s type"))),
    };
    Ok(UniformMember {
        name: name.to_string(),
        offset,
        scalar,
        components: columns * rows,
        columns,
        rows,
        array,
        is_bool: false,
        is_mat2: false,
        packed: None,
    })
}

/// Translates one program: both stages, with the vertex outputs and the
/// fragment inputs matched by name. `flip_y` is for a program that draws into a
/// texture rather than the drawing buffer (`compositor/glsl.rs`); `points` for
/// one drawn as points.
pub fn translate(
    program: &GlslProgram,
    flip_y: bool,
    points: bool,
) -> std::result::Result<Translated, String> {
    let mut varyings = Varyings::default();
    let mut slots = Vec::new();
    let vr = rewrite(RewriteInput {
        src: &program.vertex,
        stage: ShaderStage::Vertex,
        varyings: &mut varyings,
        flip_y,
        points,
        slots: &mut slots,
    })?;
    let fr = rewrite(RewriteInput {
        src: &program.fragment,
        stage: ShaderStage::Fragment,
        varyings: &mut varyings,
        flip_y,
        points,
        slots: &mut slots,
    })?;
    let vertex = parse_stage(ShaderStage::Vertex, vr)?;
    let fragment = parse_stage(ShaderStage::Fragment, fr)?;
    let mut samplers: Vec<(SamplerBinding, SamplerStages)> = Vec::new();
    for (stage, is_vertex) in [(&vertex, true), (&fragment, false)] {
        for s in &stage.samplers {
            match samplers.iter_mut().find(|(b, _)| b.texture == s.texture) {
                Some((_, stages)) => {
                    stages.vertex |= is_vertex;
                    stages.fragment |= !is_vertex;
                }
                None => samplers.push((
                    s.clone(),
                    SamplerStages {
                        vertex: is_vertex,
                        fragment: !is_vertex,
                    },
                )),
            }
        }
    }
    samplers.sort_by_key(|(b, _)| b.texture);
    Ok(Translated {
        vertex,
        fragment,
        samplers,
    })
}

/// The bytes of a stage's uniform block after `calls`, the uniform calls of a
/// draw (`fbh` is the drawing buffer's height, for `gl_FragCoord`, and
/// `viewport` the viewport's size, for the size of a point). What no call set
/// is zero, as GL's default.
pub fn uniform_bytes(
    stage: &Stage,
    calls: &BTreeMap<String, Vec<GlslUniform>>,
    fbh: f32,
    viewport: (f32, f32),
) -> std::result::Result<Vec<u8>, String> {
    let size = (stage.uniform_size.max(16) as usize).div_ceil(16) * 16;
    let mut bytes = vec![0u8; size];
    if let Some(at) = stage.fbh_offset {
        put(&mut bytes, at as usize, &fbh.to_le_bytes());
    }
    if let Some(at) = stage.vp_offset {
        put(&mut bytes, at as usize, &viewport.0.to_le_bytes());
        put(&mut bytes, at as usize + 4, &viewport.1.to_le_bytes());
    }
    for member in &stage.uniforms {
        for call in calls.get(&member.name).into_iter().flatten() {
            write_member(&mut bytes, member, call)?;
        }
    }
    Ok(bytes)
}

fn put(bytes: &mut [u8], at: usize, value: &[u8]) {
    bytes[at..at + value.len()].copy_from_slice(value);
}

fn write_member(
    bytes: &mut [u8],
    member: &UniformMember,
    call: &GlslUniform,
) -> std::result::Result<(), String> {
    let name = &member.name;
    let ok = match (call.kind, member.scalar, member.is_bool) {
        (GlslUniformKind::Matrix, _, _) if member.is_mat2 => true,
        (_, _, _) if member.is_mat2 => false,
        (GlslUniformKind::Matrix, ScalarKind::Float, _) => member.columns > 1,
        (GlslUniformKind::Matrix, _, _) => false,
        (GlslUniformKind::Float, ScalarKind::Float, _) => member.columns == 1,
        (GlslUniformKind::Float, _, is_bool) => is_bool,
        (GlslUniformKind::Int, ScalarKind::Float, _) => false,
        (GlslUniformKind::Int, _, _) => true,
    };
    if !ok {
        return Err(format!(
            "the uniform `{name}` was set with a call of the wrong kind for its type (WebGL \
             ignores that call with INVALID_OPERATION)"
        ));
    }
    let per = member.components as usize;
    if call.value.is_empty() || !call.value.len().is_multiple_of(per) {
        return Err(format!(
            "the uniform `{name}` needs a multiple of {per} values, got {}",
            call.value.len()
        ));
    }
    let length = member.array.map_or(1, |(n, _)| n as usize);
    let first = call.index as usize;
    let count = call.value.len() / per;
    if first + count > length {
        return Err(format!(
            "the uniform `{name}` has {length} element(s), but values for elements {first} to {} were set",
            first + count - 1
        ));
    }
    let stride = member.array.map_or(0, |(_, s)| s as usize);
    // Matrix columns of two rows are 8 bytes apart, of three or four 16.
    let column_stride = if member.rows == 2 { 8 } else { 16 };
    for e in 0..count {
        if let Some(width) = member.packed {
            // Elements share `vec4`s: four scalars or two pairs.
            let index = first + e;
            let per_vec4 = 4 / width as usize;
            let slot = member.offset as usize
                + (index / per_vec4) * 16
                + (index % per_vec4) * width as usize * 4;
            for r in 0..width as usize {
                let v = call.value[e * per + r];
                let word: [u8; 4] = match member.scalar {
                    ScalarKind::Float => (v as f32).to_le_bytes(),
                    ScalarKind::Sint => (v as i32).to_le_bytes(),
                    ScalarKind::Uint => (v as u32).to_le_bytes(),
                };
                put(bytes, slot + r * 4, &word);
            }
            continue;
        }
        let base = member.offset as usize + (first + e) * stride;
        for c in 0..member.columns as usize {
            for r in 0..member.rows as usize {
                let v = call.value[e * per + c * member.rows as usize + r];
                let at = base + c * column_stride + r * 4;
                let word: [u8; 4] = match member.scalar {
                    _ if member.is_bool => i32::from(v != 0.0).to_le_bytes(),
                    ScalarKind::Float => (v as f32).to_le_bytes(),
                    ScalarKind::Sint => (v as i32).to_le_bytes(),
                    ScalarKind::Uint => (v as u32).to_le_bytes(),
                };
                put(bytes, at, &word);
            }
        }
    }
    Ok(())
}

/// A texture's straight RGBA8 pixels and size: decoded from its picture, or
/// the bytes it was given.
pub fn decode_texture(
    texture: &GlslTexture,
    base_dir: &std::path::Path,
) -> std::result::Result<(Vec<u8>, u32, u32), String> {
    if texture.src.is_none() && texture.pixels.is_none() {
        return Err("a texture has either a src or pixels (or, in a group, a layer)".into());
    }
    decode_picture(
        texture.src.as_deref(),
        texture.pixels.as_deref(),
        (texture.width, texture.height),
        base_dir,
    )
}

/// The straight RGBA8 pixels and size of a picture file (or `data:` URL)
/// `src`, or of the base64 bytes `pixels` of a picture of `size`.
pub fn decode_picture(
    src: Option<&str>,
    pixels: Option<&str>,
    (w, h): (u32, u32),
    base_dir: &std::path::Path,
) -> std::result::Result<(Vec<u8>, u32, u32), String> {
    use base64::Engine as _;
    match (src, pixels) {
        (Some(src), None) => {
            let decoded = if let Some(bytes) = crate::scene::data_uri_bytes(src) {
                image::load_from_memory(&bytes)
                    .map_err(|e| format!("cannot decode a data: texture: {e}"))?
            } else {
                let path = base_dir.join(src);
                image::open(&path)
                    .map_err(|e| format!("cannot decode the texture {}: {e}", path.display()))?
            }
            .to_rgba8();
            let (w, h) = decoded.dimensions();
            Ok((decoded.into_raw(), w, h))
        }
        (None, Some(pixels)) => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(pixels)
                .map_err(|e| format!("a texture's pixels are not base64: {e}"))?;
            if w == 0 || h == 0 || bytes.len() != w as usize * h as usize * 4 {
                return Err(format!(
                    "a texture of {w} x {h} needs {} bytes of RGBA, got {}",
                    w as usize * h as usize * 4,
                    bytes.len()
                ));
            }
            Ok((bytes, w, h))
        }
        _ => Err("a picture has either a src or pixels".into()),
    }
}

/// The six faces of a cube map as RGBA8 (unpacked as each was uploaded), and the side they share. An
/// incomplete cube (no faces) is `None`: it samples as opaque black.
pub fn decode_cube(
    texture: &GlslTexture,
    base_dir: &std::path::Path,
) -> std::result::Result<Option<(Vec<Vec<u8>>, u32)>, String> {
    if texture.faces.is_empty() {
        return Ok(None);
    }
    if texture.faces.len() != 6 {
        return Err(format!(
            "a cube map has six faces, got {}",
            texture.faces.len()
        ));
    }
    let side = texture.width;
    let mut faces = Vec::with_capacity(6);
    for (i, face) in texture.faces.iter().enumerate() {
        let (mut rgba, w, h) = decode_picture(
            face.src.as_deref(),
            face.pixels.as_deref(),
            (side, side),
            base_dir,
        )
        .map_err(|e| format!("cube map face {i}: {e}"))?;
        if w != side || h != side || side == 0 {
            return Err(format!(
                "cube map face {i} is {w} x {h}; the faces must be {side} x {side}"
            ));
        }
        unpack(&mut rgba, w, face.flip_y, face.premultiply);
        faces.push(rgba);
    }
    Ok(Some((faces, side)))
}

/// The texels of a float or 3D texture, as the device holds them.
#[derive(Debug, PartialEq)]
pub enum Texels {
    /// RGBA8, four bytes a texel.
    Rgba8(Vec<u8>),
    /// RGBA16F, eight bytes a texel (little-endian half floats).
    Rgba16F(Vec<u8>),
    /// RGBA32F, sixteen bytes a texel (little-endian floats).
    Rgba32F(Vec<u8>),
}

/// The texels of a texture with `floats` or a 3D texture: its `pixels`, or its `floats` rounded to half
/// floats (kept in full with `float32`), as `texImage2D` and `texImage3D` of a float format do.
pub fn decode_texels(texture: &GlslTexture) -> std::result::Result<Texels, String> {
    use base64::Engine as _;
    let (w, h, d) = (
        texture.width as usize,
        texture.height as usize,
        (texture.depth as usize).max(1),
    );
    if w == 0 || h == 0 {
        return Err(format!("a texture of {w} x {h} x {d} has no texels"));
    }
    let texels = w * h * d;
    let decode = |data: &str| {
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| format!("a 3D texture's texels are not base64: {e}"))
    };
    match (&texture.pixels, &texture.floats) {
        (Some(pixels), None) => {
            let bytes = decode(pixels)?;
            if bytes.len() != texels * 4 {
                return Err(format!(
                    "a texture of {w} x {h} x {d} needs {} bytes of RGBA, got {}",
                    texels * 4,
                    bytes.len()
                ));
            }
            Ok(Texels::Rgba8(bytes))
        }
        (None, Some(floats)) => {
            let bytes = decode(floats)?;
            if bytes.len() != texels * 16 {
                return Err(format!(
                    "a texture of {w} x {h} x {d} needs {} bytes of RGBA floats, got {}",
                    texels * 16,
                    bytes.len()
                ));
            }
            if texture.float32 {
                return Ok(Texels::Rgba32F(bytes));
            }
            let halves = bytes
                .chunks_exact(4)
                .flat_map(|f| {
                    let v = f32::from_le_bytes([f[0], f[1], f[2], f[3]]);
                    f32_to_f16(v).to_le_bytes()
                })
                .collect();
            Ok(Texels::Rgba16F(halves))
        }
        _ => Err("a texture has either pixels or floats".into()),
    }
}

/// `value` as an IEEE half float, rounded to nearest even; too large a value is infinite.
pub fn f32_to_f16(value: f32) -> u16 {
    let bits = value.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exp = ((bits >> 23) & 0xff) as i32;
    let man = bits & 0x7f_ffff;
    if exp == 0xff {
        return sign | 0x7c00 | if man != 0 { 0x200 } else { 0 };
    }
    let e = exp - 127 + 15;
    if e >= 0x1f {
        return sign | 0x7c00;
    }
    if e <= 0 {
        // A subnormal half, or zero.
        if e < -10 {
            return sign;
        }
        let m = man | 0x80_0000;
        let shift = (14 - e) as u32;
        let mut half = (m >> shift) as u16;
        let rest = m & ((1 << shift) - 1);
        let middle = 1 << (shift - 1);
        if rest > middle || (rest == middle && half & 1 == 1) {
            half += 1;
        }
        return sign | half;
    }
    let mut half = ((e as u32) << 10) | (man >> 13);
    let rest = man & 0x1fff;
    if rest > 0x1000 || (rest == 0x1000 && half & 1 == 1) {
        // A carry into the exponent is the right next value, up to infinity.
        half += 1;
    }
    sign | half as u16
}

/// Straight RGBA8 rows of `width` as an upload with these flags leaves them:
/// turned over (`UNPACK_FLIP_Y_WEBGL`), and colour times alpha
/// (`UNPACK_PREMULTIPLY_ALPHA_WEBGL`).
pub fn unpack(rgba: &mut Vec<u8>, width: u32, flip_y: bool, premultiply: bool) {
    if flip_y && width > 0 {
        let row = width as usize * 4;
        *rgba = rgba.chunks(row).rev().flatten().copied().collect();
    }
    if premultiply {
        let (pixels, _) = rgba.as_chunks_mut::<4>();
        for px in pixels {
            let a = u32::from(px[3]);
            for c in &mut px[..3] {
                *c = ((u32::from(*c) * a + 127) / 255) as u8;
            }
        }
    }
}

/// The next mip level: 2 x 2 blocks averaged (a side of one stays one).
pub fn next_level(rgba: &[u8], width: u32, height: u32) -> (Vec<u8>, u32, u32) {
    let (nw, nh) = ((width / 2).max(1), (height / 2).max(1));
    let mut out = Vec::with_capacity(nw as usize * nh as usize * 4);
    for y in 0..nh {
        for x in 0..nw {
            let mut sum = [0u32; 4];
            for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                let sx = (x * 2 + dx).min(width - 1) as usize;
                let sy = (y * 2 + dy).min(height - 1) as usize;
                let at = (sy * width as usize + sx) * 4;
                for c in 0..4 {
                    sum[c] += u32::from(rgba[at + c]);
                }
            }
            out.extend(sum.map(|v| ((v + 2) / 4) as u8));
        }
    }
    (out, nw, nh)
}

/// Translates every program of a layer, so that a scene with a shader naga
/// cannot read fails when it loads.
pub fn validate(layer_id: &str, content: &GlslContent) -> Result<()> {
    for (id, program) in &content.programs {
        translate(program, false, false)
            .map_err(|e| Error::Scene(format!("layer {layer_id:?}: glsl program {id:?}: {e}")))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A program as the drawing buffer's.
    fn translate(program: &GlslProgram) -> std::result::Result<Translated, String> {
        super::translate(program, false, false)
    }

    fn program(vertex: &str, fragment: &str) -> GlslProgram {
        GlslProgram {
            vertex: vertex.into(),
            fragment: fragment.into(),
            attributes: BTreeMap::new(),
        }
    }

    const QUAD_ES1: &str = "attribute vec2 a_pos; varying vec2 v_uv;\n\
        void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }";

    fn call(kind: GlslUniformKind, value: &[f64], index: u32) -> GlslUniform {
        GlslUniform {
            kind,
            value: value.to_vec(),
            index,
        }
    }

    fn word(bytes: &[u8], at: usize) -> f32 {
        f32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
    }

    #[test]
    fn arrays_of_scalars_and_pairs_travel_in_vec4s() {
        let t = translate(&program(
            QUAD_ES1,
            "precision mediump float; varying vec2 v_uv; uniform float w[5]; uniform vec2 p[3]; \
             uniform mat2 m; \
             void main() { gl_FragColor = vec4(w[4] + p[2].y + m[1][1]); }",
        ))
        .unwrap();
        let at = |n: &str| {
            t.fragment
                .uniforms
                .iter()
                .find(|u| u.name == n)
                .unwrap()
                .offset as usize
        };
        let mut calls = BTreeMap::new();
        calls.insert(
            "w".to_string(),
            vec![call(GlslUniformKind::Float, &[1.0, 2.0, 3.0, 4.0, 5.0], 0)],
        );
        calls.insert(
            "p".to_string(),
            vec![call(GlslUniformKind::Float, &[7.0, 8.0], 2)],
        );
        calls.insert(
            "m".to_string(),
            vec![call(GlslUniformKind::Matrix, &[1.0, 2.0, 3.0, 4.0], 0)],
        );
        let bytes = uniform_bytes(&t.fragment, &calls, 64.0, (1.0, 1.0)).unwrap();
        // Four floats to a vec4, then the fifth in the next.
        assert_eq!(word(&bytes, at("w") + 12), 4.0);
        assert_eq!(word(&bytes, at("w") + 16), 5.0);
        // Two pairs to a vec4: the third pair starts the second.
        assert_eq!(word(&bytes, at("p") + 16), 7.0);
        assert_eq!(word(&bytes, at("p") + 20), 8.0);
        assert_eq!(word(&bytes, at("m") + 8), 3.0);
        // The buffer height is the first word of the block.
        assert_eq!(word(&bytes, 0), 64.0);
    }

    #[test]
    fn a_call_of_the_wrong_kind_or_size_is_refused() {
        let t = translate(&program(
            QUAD_ES1,
            "precision mediump float; varying vec2 v_uv; uniform float w[2]; uniform vec3 c; \
             void main() { gl_FragColor = vec4(w[1] + c.x); }",
        ))
        .unwrap();
        let try_one = |name: &str, c: GlslUniform| {
            let mut calls = BTreeMap::new();
            calls.insert(name.to_string(), vec![c]);
            uniform_bytes(&t.fragment, &calls, 1.0, (1.0, 1.0))
        };
        let e = try_one("c", call(GlslUniformKind::Int, &[1.0, 2.0, 3.0], 0)).unwrap_err();
        assert!(e.contains("wrong kind"), "{e}");
        let e = try_one("w", call(GlslUniformKind::Float, &[1.0, 2.0, 3.0], 0)).unwrap_err();
        assert!(e.contains("2 element"), "{e}");
        let e = try_one("c", call(GlslUniformKind::Float, &[1.0, 2.0], 0)).unwrap_err();
        assert!(e.contains("multiple of 3"), "{e}");
    }

    #[test]
    fn a_program_drawn_as_points_gets_the_viewport_and_a_point_coord() {
        let p = program(
            "attribute vec2 a_pos; void main() { gl_PointSize = 8.0; \
             gl_Position = vec4(a_pos, 0.0, 1.0); }",
            "precision mediump float; void main() { gl_FragColor = vec4(gl_PointCoord, 0.0, 1.0); }",
        );
        let t = super::translate(&p, false, true).unwrap();
        assert!(t.vertex.vp_offset.is_some());
        assert!(t.vertex.uniform_size > 0);
        // As triangles the same shaders are valid, and gl_PointCoord is zero.
        let t = super::translate(&p, false, false).unwrap();
        assert!(t.vertex.vp_offset.is_none());
    }

    #[test]
    fn es1_gradient_translates() {
        let t = translate(&program(
            QUAD_ES1,
            "precision mediump float;\nvarying vec2 v_uv;\nuniform float u_time;\n\
             void main() { gl_FragColor = vec4(v_uv, 0.5 + 0.5 * sin(u_time), 1.0); }",
        ))
        .unwrap();
        assert_eq!(t.vertex.attributes, vec![("a_pos".into(), 0, Some(2))]);
        let names: Vec<_> = t
            .fragment
            .uniforms
            .iter()
            .map(|u| u.name.as_str())
            .collect();
        assert_eq!(names, ["u_time"]);
    }

    #[test]
    fn es3_shader_translates() {
        let t = translate(&program(
            "#version 300 es\nin vec2 a_pos;\nout vec2 v_uv;\n\
             void main() { v_uv = a_pos; gl_Position = vec4(a_pos, 0.0, 1.0); }",
            "#version 300 es\nprecision highp float;\nin vec2 v_uv;\nuniform vec2 u_res;\n\
             uniform sampler2D u_tex;\nout vec4 outColor;\n\
             void main() { outColor = texture(u_tex, gl_FragCoord.xy / u_res) + vec4(v_uv, 0.0, 1.0); }",
        ))
        .unwrap();
        assert_eq!(t.fragment.samplers.len(), 1);
        assert!(t.fragment.uses_frag_coord);
        assert!(t.fragment.fbh_offset.is_some());
    }

    #[test]
    fn a_program_that_draws_into_a_texture_translates_upside_down() {
        let p = program(
            QUAD_ES1,
            "precision mediump float; varying vec2 v_uv; \
             void main() { gl_FragColor = vec4(gl_FragCoord.xy / 8.0, v_uv); }",
        );
        for flip_y in [false, true] {
            let t = super::translate(&p, flip_y, false).unwrap();
            assert!(t.fragment.uses_frag_coord, "{flip_y}");
        }
    }

    #[test]
    fn uniform_arrays_matrices_and_bools_have_members() {
        let t = translate(&program(
            QUAD_ES1,
            "precision mediump float;\nvarying vec2 v_uv;\n\
             uniform float u_w[4]; uniform vec3 u_c[2]; uniform mat3 u_m; uniform bool u_on;\n\
             uniform ivec2 u_n;\n\
             void main() { float s = u_w[u_n.x] + u_c[1].y + u_m[1][1]; \
             if (u_on) { s += 1.0; } gl_FragColor = vec4(vec3(s), 1.0); }",
        ))
        .unwrap();
        let find = |n: &str| {
            t.fragment
                .uniforms
                .iter()
                .find(|u| u.name == n)
                .unwrap_or_else(|| panic!("no member {n}: {:?}", t.fragment.uniforms))
        };
        assert_eq!(find("u_w").array.map(|a| a.0), Some(4));
        assert_eq!(find("u_c").array.map(|a| a.0), Some(2));
        assert_eq!(find("u_m").columns, 3);
        assert!(find("u_on").is_bool);
        assert_eq!(find("u_n").rows, 2);
    }

    #[test]
    fn errors_name_the_line_of_the_source() {
        let e = translate(&program(
            QUAD_ES1,
            "precision mediump float;\nvoid main() {\n  gl_FragColor = vec4(nope);\n}",
        ))
        .unwrap_err();
        assert!(e.starts_with("fragment shader: 3:"), "{e}");
    }

    #[test]
    fn what_naga_or_the_engine_lacks_is_called_unsupported() {
        let e = translate(&program(
            QUAD_ES1,
            "precision mediump float;\nuniform isampler2D c;\nvoid main() { gl_FragColor = vec4(1.0); }",
        ))
        .unwrap_err();
        assert!(
            e.contains("unsupported") && e.contains("isampler2D"),
            "{e}"
        );
        let e = translate(&program(
            QUAD_ES1,
            "precision mediump float;\nvarying vec3 v_missing;\nvoid main() { gl_FragColor = vec4(v_missing, 1.0); }",
        ))
        .unwrap_err();
        assert!(e.contains("v_missing"), "{e}");
    }

    #[test]
    fn a_vertex_shader_reads_textures_at_level_zero_and_shares_the_binding_with_the_fragment_shader() {
        let t = translate(&program(
            "#version 300 es\nin vec2 a_pos; uniform sampler2D u_tex; uniform sampler2D u_height; out vec2 v_uv;\n\
             void main() {\n  float h = texture(u_height, a_pos).r + texture2D(u_tex, a_pos * 0.5).g\n\
                 + texelFetch(u_tex, ivec2(1, 0), 0).b + float(textureSize(u_tex, 0).x);\n\
               v_uv = a_pos; gl_Position = vec4(a_pos, h, 1.0); }",
            "#version 300 es\nprecision highp float; in vec2 v_uv; uniform sampler2D u_tex; out vec4 o;\n\
             void main() { o = texture(u_tex, v_uv); }",
        ))
        .unwrap();
        assert_eq!(t.vertex.samplers.len(), 2);
        // `u_tex` binds where it does in the fragment shader, and both stages read it.
        let vertex_tex = t.vertex.samplers.iter().find(|s| s.name == "u_tex").unwrap();
        assert_eq!(t.fragment.samplers.len(), 1);
        assert_eq!(&t.fragment.samplers[0], vertex_tex);
        assert_eq!(t.samplers.len(), 2);
        let (_, stages) = t.samplers.iter().find(|(b, _)| b.name == "u_tex").unwrap();
        assert!(stages.vertex && stages.fragment);
        let (_, stages) = t.samplers.iter().find(|(b, _)| b.name == "u_height").unwrap();
        assert!(stages.vertex && !stages.fragment);
    }

    #[test]
    fn a_fragment_sampler_declared_first_in_the_vertex_shader_does_not_move() {
        // The fragment shader declares `b` then `a`; the vertex shader only `a`.
        let t = translate(&program(
            "#version 300 es\nin vec2 p; uniform sampler2D a;\n\
             void main() { gl_Position = vec4(p, texture(a, p).x, 1.0); }",
            "#version 300 es\nprecision highp float; uniform sampler2D b; uniform sampler2D a; out vec4 o;\n\
             void main() { o = texture(b, vec2(0.5)) + texture(a, vec2(0.5)); }",
        ))
        .unwrap();
        let at = |stage: &Stage, n: &str| stage.samplers.iter().find(|s| s.name == n).unwrap().clone();
        assert_eq!(at(&t.vertex, "a"), at(&t.fragment, "a"));
        assert_ne!(at(&t.fragment, "a").texture, at(&t.fragment, "b").texture);
    }

    #[test]
    fn a_sampler_of_another_type_in_the_other_stage_is_refused() {
        let e = translate(&program(
            "#version 300 es\nin vec2 p; uniform sampler2D a;\n\
             void main() { gl_Position = vec4(p, texture(a, p).x, 1.0); }",
            "#version 300 es\nprecision highp float; uniform sampler3D a; out vec4 o;\n\
             void main() { o = texture(a, vec3(0.5)); }",
        ))
        .unwrap_err();
        assert!(e.contains("not of the same type"), "{e}");
    }

    #[test]
    fn a_sampler_3d_reads_with_texel_fetch_and_texture() {
        let t = translate(&program(
            "#version 300 es\nin vec2 a_pos; out vec2 v_uv;\n\
             void main() { v_uv = a_pos; gl_Position = vec4(a_pos, 0.0, 1.0); }",
            "#version 300 es\nprecision highp float; precision highp sampler3D;\n\
             in vec2 v_uv; uniform sampler3D u_lut; uniform int u_size; out vec4 o;\n\
             void main() { o = texelFetch(u_lut, ivec3(1, 0, 0), 0) + texture(u_lut, vec3(v_uv, 0.5))\n\
                 + vec4(float(textureSize(u_lut, 0).z)); }",
        ))
        .unwrap();
        assert_eq!(t.fragment.samplers.len(), 1);
        assert_eq!(t.fragment.samplers[0].dim, SamplerDim::D3);
    }

    #[test]
    fn a_sampler_2d_array_reads_with_texel_fetch_and_texture() {
        let t = translate(&program(
            "#version 300 es\nin vec2 a_pos; uniform sampler2DArray u_layers; out vec4 v_c;\n\
             void main() { v_c = texelFetch(u_layers, ivec3(0, 0, 1), 0); gl_Position = vec4(a_pos, 0.0, 1.0); }",
            "#version 300 es\nprecision highp float; precision highp sampler2DArray;\n\
             in vec4 v_c; uniform sampler2DArray u_layers; out vec4 o;\n\
             void main() { o = v_c + texture(u_layers, vec3(0.5, 0.5, 2.0))\n\
                 + vec4(float(textureSize(u_layers, 0).z)); }",
        ))
        .unwrap();
        assert_eq!(t.fragment.samplers.len(), 1);
        assert_eq!(t.fragment.samplers[0].dim, SamplerDim::Array);
        assert_eq!(t.vertex.samplers[0].dim, SamplerDim::Array);
    }

    /// The members of the uniform block a program's vertex shader makes: name to array length.
    fn vertex_uniform_arrays(vertex: &str) -> std::result::Result<Vec<(String, Option<u32>)>, String> {
        let t = translate(&program(
            vertex,
            "#version 300 es\nprecision highp float; out vec4 o; void main() { o = vec4(1.0); }",
        ))?;
        Ok(t.vertex.uniforms.iter().map(|u| (u.name.clone(), u.array.map(|a| a.0))).collect())
    }

    #[test]
    fn an_array_length_may_be_a_macro_defined_as_a_number() {
        let found = vertex_uniform_arrays(
            "#version 300 es\nin vec2 p;\n#define MORPHTARGETS_COUNT 3\n#define LIGHTS (MORPHTARGETS_COUNT)\n\
             uniform float morphTargetInfluences[ MORPHTARGETS_COUNT ]; uniform vec4 planes[LIGHTS];\n\
             void main() { gl_Position = vec4(p, morphTargetInfluences[2] + planes[1].x, 1.0); }",
        )
        .unwrap();
        let length = |n: &str| found.iter().find(|u| u.0 == n).unwrap().1;
        assert_eq!(length("morphTargetInfluences"), Some(3));
        assert_eq!(length("planes"), Some(3));
    }

    #[test]
    fn an_array_length_macro_that_is_not_defined_where_it_is_read_is_refused() {
        for defines in [
            "#ifdef FAST\n#define N 2\n#endif\n",
            "#define N 2\n#undef N\n",
            "#define N(x) 2\n",
            "",
        ] {
            let e = vertex_uniform_arrays(&format!(
                "#version 300 es\nin vec2 p;\n{defines}uniform float w[N];\n\
                 void main() {{ gl_Position = vec4(p, w[0], 1.0); }}"
            ))
            .unwrap_err();
            assert!(e.contains("must be a number") && e.contains('N'), "{defines:?}: {e}");
        }
    }

    #[test]
    fn an_array_length_macro_defined_in_a_live_conditional_is_read() {
        let found = vertex_uniform_arrays(
            "#version 300 es\nin vec2 p;\n#define FAST 1\n#if defined( FAST ) && ! defined( SLOW )\n#define N 2\n#else\n\
             #define N 9\n#endif\nuniform float w[N * 2];\n\
             void main() { gl_Position = vec4(p, w[0], 1.0); }",
        )
        .unwrap();
        assert_eq!(found.iter().find(|u| u.0 == "w").unwrap().1, Some(4));
    }

    #[test]
    fn a_declaration_in_a_branch_that_is_left_out_is_not_read() {
        // three.js declares `morphTargetInfluences[ MORPHTARGETS_COUNT ]` under `USE_MORPHTARGETS`, with the macro
        // defined only when that is.
        let found = vertex_uniform_arrays(
            "#version 300 es\nin vec2 p;\n#ifdef USE_MORPHTARGETS\nuniform float morphTargetInfluences[ MORPHTARGETS_COUNT ];\n\
             #endif\n#if 0 > 0\nuniform float never;\n#endif\nuniform float kept;\n\
             void main() { gl_Position = vec4(p, kept, 1.0); }",
        )
        .unwrap();
        assert_eq!(found.iter().map(|u| u.0.as_str()).collect::<Vec<_>>(), ["kept"]);
    }

    #[test]
    fn a_matrix_attribute_is_read_where_its_branch_is_kept_only() {
        let t = translate(&program(
            "#version 300 es\nin vec2 p;\n#ifdef USE_INSTANCING\nin mat4 instanceMatrix;\n#endif\n\
             void main() { gl_Position = vec4(p, 0.0, 1.0); }",
            "#version 300 es\nprecision highp float; out vec4 o; void main() { o = vec4(1.0); }",
        ))
        .unwrap();
        assert!(t.vertex.attributes.iter().all(|a| !a.0.starts_with("instanceMatrix")));
        let t = translate(&program(
            "#version 300 es\nin vec2 p;\n#define USE_INSTANCING\n#ifdef USE_INSTANCING\nin mat4 instanceMatrix;\n#endif\n\
             void main() { gl_Position = instanceMatrix * vec4(p, 0.0, 1.0); }",
            "#version 300 es\nprecision highp float; out vec4 o; void main() { o = vec4(1.0); }",
        ))
        .unwrap();
        assert!(t.vertex.attributes.iter().any(|a| a.0 == "instanceMatrix[3]"));
    }

    #[test]
    fn a_varying_the_fragment_shader_declares_and_never_reads_needs_no_vertex_output() {
        translate(&program(
            QUAD_ES1,
            "precision mediump float;\nvarying vec3 vNormal;\nvoid main() { gl_FragColor = vec4(1.0); }",
        ))
        .unwrap();
    }

    #[test]
    fn attributes_take_the_lowest_free_locations_whatever_the_page_bound() {
        let mut p = program(
            "#version 300 es\n#ifdef GONE\nin vec3 a;\nin vec3 b;\n#endif\nin vec2 c;\nin mat4 d;\n\
             void main() { gl_Position = d * vec4(c, 0.0, 1.0); }",
            "#version 300 es\nprecision highp float; out vec4 o; void main() { o = vec4(1.0); }",
        );
        p.attributes = BTreeMap::from([("c".to_string(), 24), ("d".to_string(), 28)]);
        let t = translate(&p).unwrap();
        let at = |n: &str| t.vertex.attributes.iter().find(|a| a.0 == n).unwrap().1;
        assert_eq!((at("c"), at("d[0]"), at("d[3]")), (0, 1, 4));
    }

    #[test]
    fn a_const_in_parameter_is_read_as_in() {
        translate(&program(
            "#version 300 es\nin vec2 p;\nfloat pow2( const in float x ) { return x * x; }\n\
             vec3 twice(const\n in vec3 v, const in float k) { return v * k; }\n\
             void main() { gl_Position = vec4(twice(vec3(p, 0.0), pow2(2.0)), 1.0); }",
            "#version 300 es\nprecision highp float; out vec4 o; void main() { o = vec4(1.0); }",
        ))
        .unwrap();
    }

    #[test]
    fn a_struct_uniform_array_has_a_member_for_each_field_of_each_element() {
        let t = translate(&program(
            QUAD_ES1,
            "precision mediump float;\nstruct Light {\n  vec3 color;\n  float distance;\n  vec2 size;\n};\n\
             uniform Light lights[2];\nuniform Light one;\n\
             void main() { gl_FragColor = vec4(lights[1].color * one.distance, lights[0].size.x); }",
        ))
        .unwrap();
        let names: Vec<&str> = t.fragment.uniforms.iter().map(|u| u.name.as_str()).collect();
        for want in ["lights[0].color", "lights[1].distance", "lights[1].size", "one.color", "one.size"] {
            assert!(names.contains(&want), "{want} in {names:?}");
        }
        let at = |n: &str| t.fragment.uniforms.iter().find(|u| u.name == n).unwrap().offset;
        // Two elements of one struct are one struct size apart, which is a multiple of 16.
        assert!(at("lights[1].color") > at("lights[0].color"));
        assert_eq!((at("lights[1].color") - at("lights[0].color")) % 16, 0);
        assert_eq!(at("lights[0].distance"), at("lights[0].color") + 12);
    }

    #[test]
    fn a_struct_uniform_with_a_field_the_block_cannot_hold_is_refused() {
        for field in ["bool on;", "mat2 m;", "sampler2D t;"] {
            let e = translate(&program(
                QUAD_ES1,
                &format!(
                    "precision mediump float;\nstruct S {{ vec3 c; {field} }};\nuniform S s;\n\
                     void main() {{ gl_FragColor = vec4(s.c, 1.0); }}"
                ),
            ))
            .unwrap_err();
            assert!(e.contains("unsupported") && e.contains("uniform struct `S`"), "{field}: {e}");
        }
        let e = translate(&program(
            QUAD_ES1,
            "precision mediump float;\nstruct S { vec3 c; } s;\nvoid main() { gl_FragColor = vec4(s.c, 1.0); }",
        ))
        .unwrap_err();
        assert!(e.contains("declared together with a variable"), "{e}");
    }

    const QUAD_ES1_3: &str = "#version 300 es\nin vec2 a_pos; out vec2 v_uv; void main() { v_uv = a_pos; gl_Position = vec4(a_pos, 0.0, 1.0); }";

    /// A fragment shader of GLSL ES 3.00 with `body` after its declarations, translated.
    fn es3_fragment(body: &str) -> std::result::Result<Translated, String> {
        translate(&program(
            QUAD_ES1_3,
            &format!(
                "#version 300 es\nprecision highp float; uniform sampler2D t; uniform sampler2D t2; uniform samplerCube tc; \
                 in vec2 v_uv; out vec4 o;\n{body}"
            ),
        ))
    }

    #[test]
    fn precision_qualifiers_may_stand_anywhere() {
        for body in [
            "float f(in highp vec3 a, lowp float b) { return a.x + b; } void main() { o = vec4(f(vec3(1.0), 2.0)); }",
            "highp float f(const in mediump float a) { return a; } void main() { o = vec4(f(1.0)); }",
            "void main() { highp float x = 1.0; mediump vec3 v = vec3(x); lowp int i = 1; o = vec4(v, float(i)); }",
            "struct S { highp float a; lowp vec2 b; }; void main() { S s = S(1.0, vec2(1.0)); o = vec4(s.a, s.b, 1.0); }",
            "void main() { for (highp int i = 0; i < 2; i++) { o = vec4(1.0); } }",
            "precision mediump int; void main() { o = vec4(1.0); }",
        ] {
            es3_fragment(body).unwrap_or_else(|e| panic!("{body}: {e}"));
        }
        // An identifier that only contains the word is not it.
        es3_fragment("void main() { float highp_scale = 1.0; o = vec4(highp_scale); }").unwrap();
    }

    #[test]
    fn a_sampler_may_be_a_function_parameter() {
        for body in [
            "vec4 g(sampler2D s, vec2 uv) { return texture(s, uv); } void main() { o = g(t, v_uv); }",
            "vec4 g(in highp sampler2D s, vec2 uv) { return texture(s, uv) + textureLod(s, uv, 0.0); } void main() { o = g(t2, v_uv); }",
            // Passed on, and two of them, and a different type.
            "vec4 g(sampler2D a, sampler2D b, vec2 uv) { return texture(a, uv) * texture(b, uv); } \
             vec4 h(sampler2D s, vec2 uv) { return g(s, t2, uv); } void main() { o = h(t, v_uv); }",
            "vec4 c(samplerCube s, vec3 d) { return texture(s, d); } void main() { o = c(tc, vec3(v_uv, 1.0)); }",
            // A prototype first, and the sampler used with texelFetch and textureSize.
            "vec4 g(sampler2D s, ivec2 p); void main() { o = g(t, ivec2(1)); } \
             vec4 g(sampler2D s, ivec2 p) { return texelFetch(s, p, 0) * float(textureSize(s, 0).x); }",
        ] {
            let t = es3_fragment(body).unwrap_or_else(|e| panic!("{body}: {e}"));
            assert!(!t.fragment.samplers.is_empty(), "{body}");
        }
    }

    #[test]
    fn shadow_samplers_compare_a_reference_with_the_depth() {
        let t = es3_fragment(
            "uniform sampler2DShadow sm; uniform samplerCubeShadow cm; uniform sampler2DArrayShadow am;\n\
             void main() { o = vec4(texture(sm, vec3(v_uv, 0.5)), texture(cm, vec4(v_uv, 0.5, 0.5)), \
                 texture(am, vec4(v_uv, 0.0, 0.5)), textureLod(sm, vec3(v_uv, 0.5), 0.0)); }",
        )
        .unwrap();
        let dims: Vec<SamplerDim> = t.fragment.samplers.iter().map(|s| s.dim).collect();
        for want in [SamplerDim::D2Shadow, SamplerDim::CubeShadow, SamplerDim::ArrayShadow] {
            assert!(dims.contains(&want), "{want:?} in {dims:?}");
        }
    }

    #[test]
    fn an_array_of_samplers_read_by_numbers_is_separate_samplers() {
        let t = es3_fragment(
            "uniform sampler2DShadow maps[2]; uniform sampler2D none[0];\n\
             float lookup(sampler2DShadow m, vec3 c) { return texture(m, c); }\n\
             void main() { o = vec4(lookup(maps[1], vec3(v_uv, 0.5)), texture(maps[0], vec3(v_uv, 0.5)), 0.0, 1.0); }",
        )
        .unwrap();
        let names: Vec<&str> = t.fragment.samplers.iter().map(|s| s.name.as_str()).collect();
        assert!(!names.iter().any(|n| n.starts_with("none")), "{names:?}");
        assert!(names.contains(&"_k_sa_maps_0") && names.contains(&"_k_sa_maps_1"), "{names:?}");
    }

    #[test]
    fn the_unit_of_an_element_of_an_array_of_samplers_comes_from_the_calls_of_the_array() {
        let calls = |index: u32, units: &[f64]| GlslUniform {
            kind: GlslUniformKind::Int,
            value: units.to_vec(),
            index,
        };
        let uniforms = BTreeMap::from([("maps".to_string(), vec![calls(0, &[4.0, 5.0]), calls(1, &[7.0])])]);
        assert_eq!(sampler_unit(&uniforms, "_k_sa_maps_0"), 4);
        assert_eq!(sampler_unit(&uniforms, "_k_sa_maps_1"), 7);
        assert_eq!(sampler_unit(&uniforms, "_k_sa_maps_2"), 0);
        let plain = BTreeMap::from([("t".to_string(), vec![calls(0, &[3.0])])]);
        assert_eq!(sampler_unit(&plain, "t"), 3);
    }

    #[test]
    fn modf_and_matrix_comp_mult_are_made_of_other_functions() {
        for body in [
            "void main() { float ip; float f = modf(1.5, ip); o = vec4(f, ip, 0.0, 1.0); }",
            "void main() { vec3 ip; vec3 f = modf(vec3(1.5), ip); o = vec4(f + ip, 1.0); }",
            "void main() { vec2 ip; o = vec4(modf(v_uv, ip), ip); }",
            "void main() { mat3 m = matrixCompMult(mat3(2.0), mat3(3.0)); mat2 n = matrixCompMult(mat2(1.0), mat2(2.0)); o = vec4(m[0][0], n[1][1], 0.0, 1.0); }",
            "void main() { mat4 m = matrixCompMult(mat4(2.0), mat4(3.0)); mat2x3 a = matrixCompMult(mat2x3(1.0), mat2x3(2.0)); o = vec4(m[0][0], a[0][0], 0.0, 1.0); }",
        ] {
            es3_fragment(body).unwrap_or_else(|e| panic!("{body}: {e}"));
        }
    }

    #[test]
    fn half_floats_round_to_nearest_even() {
        for (value, half) in [
            (0.0f32, 0x0000u16),
            (-0.0, 0x8000),
            (1.0, 0x3c00),
            (0.5, 0x3800),
            (-2.0, 0xc000),
            (65504.0, 0x7bff),
            (65520.0, 0x7c00),
            (f32::INFINITY, 0x7c00),
            (f32::NEG_INFINITY, 0xfc00),
            // The smallest subnormal, and what is below half of it.
            (5.960_464_5e-8, 0x0001),
            (1.0e-9, 0x0000),
            // 1 + 2^-11 is halfway between two halves: the even one, 1.
            (1.000_488_3, 0x3c00),
            // 1 + 3 * 2^-11 is halfway as well: the even one, 1 + 2^-9.
            (1.001_464_8, 0x3c02),
        ] {
            assert_eq!(f32_to_f16(value), half, "{value}");
        }
        assert_eq!(f32_to_f16(f32::NAN) & 0x7c00, 0x7c00);
        assert_ne!(f32_to_f16(f32::NAN) & 0x3ff, 0);
    }

    #[test]
    fn a_3d_texture_decodes_its_pixels_or_its_floats() {
        use base64::Engine as _;
        let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
        let texture = |pixels: Option<String>, floats: Option<String>| GlslTexture {
            src: None,
            pixels,
            layer: None,
            width: 2,
            height: 1,
            flip_y: false,
            premultiply: false,
            mipmaps: false,
            target: false,
            format: None,
            levels: 1,
            luminance: false,
            patches: Vec::new(),
            depth: 2,
            array: false,
            color_format: None,
            srgb: false,
            floats,
            float32: false,
            cube: false,
            faces: Vec::new(),
        };
        let rgba8 = decode_texels(&texture(Some(b64(&[7; 16])), None)).unwrap();
        assert_eq!(rgba8, Texels::Rgba8(vec![7; 16]));
        let floats: Vec<u8> = (0..16).flat_map(|_| 1.0f32.to_le_bytes()).collect();
        let Texels::Rgba16F(halves) = decode_texels(&texture(None, Some(b64(&floats)))).unwrap()
        else {
            panic!("half floats");
        };
        assert_eq!(halves.len(), 32);
        assert_eq!(&halves[..2], &0x3c00u16.to_le_bytes());
        // A 2D texture of 32-bit floats is kept in full.
        let mut full = texture(None, Some(b64(&floats[..32])));
        (full.depth, full.float32) = (0, true);
        assert_eq!(decode_texels(&full).unwrap(), Texels::Rgba32F(floats[..32].to_vec()));
        let e = decode_texels(&texture(Some(b64(&[0; 15])), None)).unwrap_err();
        assert!(e.contains("needs 16 bytes"), "{e}");
    }

    #[test]
    fn macros_loops_and_functions_survive() {
        translate(&program(
            QUAD_ES1,
            "#ifdef GL_ES\nprecision highp float;\n#endif\n#define PI 3.14159\n\
             varying vec2 v_uv; uniform sampler2D tex;\n\
             #define S(uv) texture2D(tex, uv)\n\
             float f(float x) { return x * x; }\n\
             void main() {\n  vec4 c = vec4(0.0);\n  for (int i = 0; i < 4; i++) { c += S(v_uv + float(i) * 0.01); }\n\
             gl_FragColor = c * f(PI);\n}",
        ))
        .unwrap();
    }
}
