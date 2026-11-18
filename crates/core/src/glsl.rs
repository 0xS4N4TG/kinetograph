//! WebGL's recording: what a frame did to the context, as the scene carries it (packages/cli/skills/kinetograph-markup/references/SCENE.md, "glsl").
//!
//! The authoring side (`createWebGLContext` of `@kinetographdev/scene`, or `<GlslShader>`) records what a frame did to
//! the context as the layer's `ops`: clears and draws, each draw carrying the program, the vertex data, the uniforms,
//! the textures and the state it ran with. Nothing here reads anything but those and the picture files they name, so the
//! layer is a pure function of its recording. This file is the part that needs no GPU: the recording's types and the
//! decoding of the pictures and texel bytes in it. ANGLE replays it (`angle_replay.rs`); the drawing buffer is placed
//! on the canvas by `compositor/glsl.rs`.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::Deserialize;

pub use crate::glsl_blocks::{GlslBlock, GlslBlockMember, GlslBlockRange};

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
    /// The uniform blocks of the two shaders in GL's block order, laid out as std140 by the recorder.
    #[serde(default)]
    pub blocks: Vec<GlslBlock>,
}

/// The picture of a video file at a time: what a `<video>` shows (`texImage2D` of one). The renderer decodes it with
/// the video decoder, so a frame is a function of the file and the time alone.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslVideo {
    /// The video file relative to the scene.
    pub src: String,
    /// Seconds after the file's first picture.
    pub time: f64,
}

/// A texture's pixels: a picture file, or RGBA bytes. The sampling state is
/// the draw's (`GlslSampler`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslTexture {
    /// A picture file relative to the scene, or a `data:` URL; its pixels are
    /// straight RGBA8 as the decoder gives them.
    pub src: Option<String>,
    /// Instead of `src` or `pixels`: a video's picture at a time.
    #[serde(default)]
    pub video: Option<GlslVideo>,
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
    /// An `SRGB8_ALPHA8` texture (2D, or the faces of a cube map): the bytes are sRGB and a shader reads them as linear.
    #[serde(default)]
    pub srgb: bool,
    /// A colour target of a float format, which draws write and samplers read as floats (`EXT_color_buffer_float`).
    pub color_format: Option<ColorFormat>,
    /// The mip levels of a colour target; an op's `level` draws into one.
    #[serde(default = "one")]
    pub levels: u32,
    /// The samples of a target (`renderbufferStorageMultisample`): 1, or 4 for a multisampled one, which a
    /// colour `blit` resolves and a depth and stencil one reads the first sample of.
    #[serde(default = "one")]
    pub samples: u32,
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
    /// With `cube`, in place of `faces`: the six targets (colour, or depth for a shadow sampler) framebuffers drew the
    /// faces in, in GL's order (`framebufferTexture2D` of `TEXTURE_CUBE_MAP_POSITIVE_X` and the others). Square, of one
    /// format and level count. With `depth` (an array or 3D texture), in place of texels: one colour target of `width` x
    /// `height` per layer, in order (`framebufferTextureLayer`).
    #[serde(default)]
    pub targets: Vec<String>,
    /// The texture as raw GL calls, in order, in place of `src`, `pixels`, `floats`, `faces` and `patches` (which
    /// are then absent): integer and compressed formats, parts of mip levels and the like. `cube`, `depth` and
    /// `array` give the target the texture is of. 
    #[serde(default)]
    pub calls: Vec<GlslTexCall>,
}

/// One face of a cube map.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslFace {
    pub src: Option<String>,
    pub pixels: Option<String>,
    /// Instead of `src` or `pixels`: float texels (`RGBA16F`, `RGBA32F`, ...), as `GlslTexture::floats`. Every
    /// face of a cube map has them, or none does.
    pub floats: Option<String>,
    #[serde(default)]
    pub float32: bool,
    #[serde(default)]
    pub flip_y: bool,
    #[serde(default)]
    pub premultiply: bool,
}

/// The formats other than RGBA8 a colour target can have: floats, sRGB (written and blended as linear, kept
/// encoded), and the 8-bit red and red-green ones.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
pub enum ColorFormat {
    R16F,
    RG16F,
    RGBA16F,
    R32F,
    RG32F,
    RGBA32F,
    #[serde(rename = "SRGB8_ALPHA8")]
    Srgb8Alpha8,
    R8,
    RG8,
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
            ColorFormat::Srgb8Alpha8 => F::Rgba8UnormSrgb,
            ColorFormat::R8 => F::R8Unorm,
            ColorFormat::RG8 => F::Rg8Unorm,
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
    /// Or a video's picture at a time.
    #[serde(default)]
    pub video: Option<GlslVideo>,
    #[serde(default)]
    pub flip_y: bool,
    #[serde(default)]
    pub premultiply: bool,
}

/// What a raw texture call does (`GlslTexCall`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GlslTexOp {
    /// `texImage2D` or `texImage3D`.
    Image,
    /// `texSubImage2D` or `texSubImage3D`.
    Sub,
    /// `texStorage2D` or `texStorage3D`.
    Storage,
    /// `compressedTexImage2D` or `compressedTexImage3D`.
    Compressed,
    /// `compressedTexSubImage2D` or `compressedTexSubImage3D`.
    CompressedSub,
    /// `generateMipmap`.
    Mipmap,
}

/// One texture call the recorder carries as the page made it (`GlslTexture::calls`): GL's own enums and the bytes
/// the call reads, with the pixel-store state already applied to them. ANGLE replays it as it is.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslTexCall {
    pub op: GlslTexOp,
    /// `TEXTURE_2D`, a cube face (`TEXTURE_CUBE_MAP_POSITIVE_X` and the others), `TEXTURE_3D` or `TEXTURE_2D_ARRAY`.
    pub target: u32,
    #[serde(default)]
    pub level: u32,
    /// The internal format of `Image`, `Storage` and `Compressed`.
    #[serde(default)]
    pub internal: u32,
    /// The format and data type the bytes are in (`Image`, `Sub`); `format` is the internal format of a
    /// `CompressedSub`.
    #[serde(default)]
    pub format: u32,
    #[serde(default, rename = "type")]
    pub ty: u32,
    /// `Storage`: the mip levels.
    #[serde(default)]
    pub levels: u32,
    #[serde(default)]
    pub x: u32,
    #[serde(default)]
    pub y: u32,
    #[serde(default)]
    pub z: u32,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    /// The layers or depth of a 3D or array texture; 0 for a 2D one.
    #[serde(default)]
    pub depth: u32,
    /// Base64 bytes of exactly the texels the call reads, tightly packed (a null upload has none).
    pub data: Option<String>,
    /// Instead of `data`, a picture as the page gave it: a picture file (or `data:` URL), base64 RGBA8, or a child of
    /// the shader group. It is uploaded as RGBA, UNSIGNED_BYTE.
    pub src: Option<String>,
    pub pixels: Option<String>,
    pub layer: Option<String>,
    /// `UNPACK_FLIP_Y_WEBGL` and `UNPACK_PREMULTIPLY_ALPHA_WEBGL` for a picture.
    #[serde(default)]
    pub flip_y: bool,
    #[serde(default)]
    pub premultiply: bool,
    /// The picture's own size, for the window (a picture file is decoded here; its size is the page's).
    #[serde(default)]
    pub picture_width: u32,
    #[serde(default)]
    pub picture_height: u32,
    /// A picture's window: `UNPACK_SKIP_PIXELS` and `UNPACK_SKIP_ROWS`.
    #[serde(default)]
    pub skip_pixels: u32,
    #[serde(default)]
    pub skip_rows: u32,
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
        /// The colour mask the clear went through (`colorMask`), when some channel was off.
        color_mask: Option<[bool; 4]>,
        /// The stencil write mask the clear went through, when it was not all ones.
        stencil_mask: Option<u32>,
        /// `x, y, width, height` of the scissor test, if it was on and the clear is not drawn as a quad.
        scissor: Option<[i32; 4]>,
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
    /// What a clear leaves of the buffer unwritten: a colour or stencil mask, or a scissor box. Only ANGLE replays one.
    pub fn clear_is_partial(&self) -> bool {
        matches!(self, GlslOp::Clear { color_mask, stencil_mask, scissor, .. }
            if color_mask.is_some() || stencil_mask.is_some() || scissor.is_some())
    }

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
    /// `HALF_FLOAT`: IEEE half floats.
    #[serde(rename = "f16")]
    F16,
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
    #[serde(rename = "i32")]
    I32,
}

impl GlslType {
    /// The bytes of one value.
    pub fn size(self) -> u64 {
        match self {
            GlslType::U8 | GlslType::I8 => 1,
            GlslType::U16 | GlslType::I16 | GlslType::F16 => 2,
            GlslType::F32 | GlslType::U32 | GlslType::I32 => 4,
        }
    }
}

/// What a vertex shader input is, with its components: the value a draw must feed it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttrKind {
    Float(u32),
    Int(u32),
    Uint(u32),
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
    /// `vertexAttribIPointer`: the shader reads the values as integers (`ivecN`, `uvecN`, `int`, `uint`); else as
    /// floats, an integer type converted (or with `normalized`, scaled to 0..1, or -1..1 if signed).
    #[serde(default)]
    pub integer: bool,
    /// Bytes; 0 is tightly packed.
    #[serde(default)]
    pub stride: u32,
    #[serde(default)]
    pub offset: u32,
    /// `vertexAttribDivisor`: 0 advances for each vertex, 1 for each instance, `n` for each `n` instances.
    #[serde(default)]
    pub divisor: u32,
    /// The attribute's array is disabled and it reads the current value (`vertexAttrib4f` and the like), the same for
    /// every vertex. `buffer` then only names the value (no entry of `buffers`), and `size` is 4 of `f32`.
    pub constant: Option<[f32; 4]>,
    /// As `constant`, for an integer input (`vertexAttribI4i`, `vertexAttribI4ui`): the four values the disabled array
    /// reads as `ivec4` or `uvec4`. ANGLE replays it.
    pub int_constant: Option<GlslIntConstant>,
}

/// The current value of an integer vertex attribute.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslIntConstant {
    /// `vertexAttribI4ui`: the values are unsigned.
    #[serde(default)]
    pub unsigned: bool,
    pub value: [i64; 4],
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
    /// The values; a `null` is a NaN (JSON has none).
    #[serde(deserialize_with = "numbers_or_nan")]
    pub value: Vec<f64>,
    /// The array element the first value goes to, for `name[i]`.
    #[serde(default)]
    pub index: u32,
}

fn numbers_or_nan<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Vec<f64>, D::Error> {
    let values = Vec::<Option<f64>>::deserialize(deserializer)?;
    Ok(values.into_iter().map(|v| v.unwrap_or(f64::NAN)).collect())
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
    /// `TEXTURE_BASE_LEVEL`: the first level sampling reads (`textureSize` and `texelFetch` count from it).
    #[serde(default)]
    pub base_level: u32,
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
    /// The bytes of the program's uniform blocks, by block name.
    #[serde(default)]
    pub blocks: BTreeMap<String, GlslBlockRange>,
    /// The texture units, by number.
    #[serde(default)]
    pub units: BTreeMap<String, GlslSampler>,
    /// `x, y, width, height`, y up from the bottom row.
    pub viewport: [i32; 4],
    pub scissor: Option<[i32; 4]>,
    /// `SAMPLE_ALPHA_TO_COVERAGE` was on: it takes effect in a multisampled buffer only.
    #[serde(default)]
    pub alpha_to_coverage: bool,
    /// `OES_texture_float_linear` was enabled: a 32-bit float texture may be read with a linear filter.
    #[serde(default)]
    pub float_linear: bool,
    /// `EXT_float_blend` was enabled.
    #[serde(default)]
    pub float_blend: bool,
    /// `frontFace(CW)` was in effect, which `gl_FrontFacing` follows even with no culling (`cull` has it too when culling).
    pub front_face: Option<String>,
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

/// A texture's straight RGBA8 pixels and size: decoded from its picture, or
/// the bytes it was given.
pub fn decode_texture(
    texture: &GlslTexture,
    base_dir: &std::path::Path,
) -> std::result::Result<(Vec<u8>, u32, u32), String> {
    if let Some(video) = &texture.video {
        return decode_video(video, base_dir);
    }
    if texture.src.is_none() && texture.pixels.is_none() {
        return Err("a texture has either a src, pixels or a video (or, in a group, a layer)".into());
    }
    decode_picture(
        texture.src.as_deref(),
        texture.pixels.as_deref(),
        (texture.width, texture.height),
        base_dir,
    )
}

/// The straight RGBA8 pixels and size of a video's picture at a time, from the video decoder.
pub fn decode_video(
    video: &GlslVideo,
    base_dir: &std::path::Path,
) -> std::result::Result<(Vec<u8>, u32, u32), String> {
    crate::picture_read::video_picture(base_dir, &video.src, video.time)
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
    if texture.faces.iter().any(|f| f.floats.is_some()) {
        return Err("decode_cube_floats reads a cube map of floats".into());
    }
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

/// The six faces of a cube map of floats, as the device holds them (all half floats, or all 32-bit), and the side they
/// share; `None` for a cube map of pictures or pixels (`decode_cube`).
#[allow(clippy::type_complexity)]
pub fn decode_cube_floats(
    texture: &GlslTexture,
) -> std::result::Result<Option<(Vec<Texels>, u32)>, String> {
    if texture.faces.len() != 6 || texture.faces.iter().all(|f| f.floats.is_none()) {
        return Ok(None);
    }
    let side = texture.width;
    if texture.faces.iter().any(|f| f.floats.is_none() || f.float32 != texture.faces[0].float32) {
        return Err("the faces of a cube map are all floats of one precision, or none".into());
    }
    let mut faces = Vec::with_capacity(6);
    for (i, face) in texture.faces.iter().enumerate() {
        let texels = texels_of(side as usize, side as usize, 1, None, face.floats.as_deref(), face.float32)
            .map_err(|e| format!("cube map face {i}: {e}"))?;
        faces.push(texels);
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
    texels_of(
        texture.width as usize,
        texture.height as usize,
        (texture.depth as usize).max(1),
        texture.pixels.as_deref(),
        texture.floats.as_deref(),
        texture.float32,
    )
}

/// `decode_texels` of `w` x `h` x `d` texels given as base64 `pixels` or `floats`.
fn texels_of(
    w: usize,
    h: usize,
    d: usize,
    pixels: Option<&str>,
    floats: Option<&str>,
    float32: bool,
) -> std::result::Result<Texels, String> {
    use base64::Engine as _;
    if w == 0 || h == 0 {
        return Err(format!("a texture of {w} x {h} x {d} has no texels"));
    }
    // The sizes come from a recording: a product that does not fit is an error, not a wrapped length.
    let too_big = || format!("a texture of {w} x {h} x {d} is too large");
    let texels = w
        .checked_mul(h)
        .and_then(|n| n.checked_mul(d))
        .filter(|n| n.checked_mul(16).is_some())
        .ok_or_else(too_big)?;
    let decode = |data: &str| {
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| format!("a 3D texture's texels are not base64: {e}"))
    };
    match (pixels, floats) {
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
            if float32 {
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

/// The bytes of base64 text.
pub fn decode_base64(text: &str) -> std::result::Result<Vec<u8>, String> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|e| format!("texture data is not base64: {e}"))
}

/// The `(w, h)` window at `(x, y)` of the RGBA8 picture of `(pw, ph)`; an error when it reaches outside the picture.
pub fn crop(
    rgba: &[u8],
    (pw, ph): (u32, u32),
    (x, y): (u32, u32),
    (w, h): (u32, u32),
) -> std::result::Result<Vec<u8>, String> {
    let outside =
        || format!("a window of {w} x {h} at {x}, {y} is outside a picture of {pw} x {ph}");
    if x.checked_add(w).is_none_or(|e| e > pw) || y.checked_add(h).is_none_or(|e| e > ph) {
        return Err(outside());
    }
    if rgba.len() != pw as usize * ph as usize * 4 {
        return Err(format!("a picture of {pw} x {ph} has {} bytes", rgba.len()));
    }
    let mut out = Vec::with_capacity(w as usize * h as usize * 4);
    for row in y..y + h {
        let from = (row as usize * pw as usize + x as usize) * 4;
        out.extend_from_slice(&rgba[from..from + w as usize * 4]);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

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
            video: None,
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
            samples: 1,
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
            targets: Vec::new(),
            calls: Vec::new(),
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
}
