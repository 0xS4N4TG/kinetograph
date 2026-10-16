//! WebGL, native: the GLSL ES a page gives `gl.shaderSource` read by naga and
//! run on the shared wgpu device (docs/SCENE.md, "glsl").
//!
//! The authoring side (`createWebGLContext` of `@kinetograph/scene`, or
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
    /// A framebuffer's texture: `width` x `height`, transparent black, with no
    /// `src` or `pixels`. The ops that name it as their `target` draw into it,
    /// and later draws sample what they left.
    #[serde(default)]
    pub target: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum GlslOp {
    /// `clear(COLOR_BUFFER_BIT)` with this clear colour, of the drawing buffer
    /// or of the target texture `target` names.
    Clear {
        color: [f64; 4],
        target: Option<String>,
    },
    Draw(Box<GlslDraw>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GlslMode {
    Triangles,
    TriangleStrip,
    TriangleFan,
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

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlslDraw {
    pub program: String,
    pub mode: GlslMode,
    pub first: u32,
    pub count: u32,
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
    /// The target texture the draw renders to; the drawing buffer without
    /// one.
    pub target: Option<String>,
}

fn all_true() -> [bool; 4] {
    [true; 4]
}

// ---- source rewriting ----

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
enum Kind {
    Ident,
    Number,
    Punct,
}

#[derive(Clone, Copy, Debug)]
struct Tok {
    kind: Kind,
    start: usize,
    end: usize,
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

fn tokenize(src: &str) -> Vec<Tok> {
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

#[derive(Debug)]
struct Rewritten {
    source: String,
    uniforms: Vec<UniformDecl>,
    /// The `sampler2D` uniforms, in binding order.
    samplers: Vec<String>,
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
    /// The varyings this stage declared, with their locations.
    varyings: Vec<(String, u32, String)>,
    uses_frag_coord: bool,
}

struct RewriteInput<'a> {
    src: &'a str,
    stage: ShaderStage,
    attribute_locations: &'a BTreeMap<String, u32>,
    /// What the vertex stage wrote, for the fragment stage to read.
    varyings: &'a mut Varyings,
    /// The program draws into a texture, whose first row is GL's bottom one.
    flip_y: bool,
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
        attribute_locations,
        varyings,
        flip_y,
    } = input;
    let src = strip_comments(src);
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
        varyings: Vec::new(),
        uses_frag_coord: false,
    };
    let mut body = String::new();
    let mut depth = 0i32;
    let mut chunk = String::new();
    let mut next_attribute = 0u32;
    let mut next_varying = 0u32;
    let mut has_out = false;
    let mut uses_point_size = false;
    let mut declared_samplers: Vec<String> = Vec::new();

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
                    attribute_locations,
                    varyings,
                    next_attribute: &mut next_attribute,
                    next_varying: &mut next_varying,
                    has_out: &mut has_out,
                    uses_point_size: &mut uses_point_size,
                },
            )?;
            let name = directive.trim_start();
            if name.starts_with("version") || name.starts_with("extension") {
                // Removed, keeping the lines.
                body.push_str(&"\n".repeat(extra));
            } else {
                body.push_str(&rewrite_directive(
                    &text,
                    &declared_samplers,
                    fragment,
                    &mut r,
                ));
            }
            body.push('\n');
            index += extra + 1;
            continue;
        }
        chunk.push_str(line);
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
            attribute_locations,
            varyings,
            next_attribute: &mut next_attribute,
            next_varying: &mut next_varying,
            has_out: &mut has_out,
            uses_point_size: &mut uses_point_size,
        },
    )?;
    // The text ended with the newline added to its last line.
    if body.ends_with('\n') {
        body.pop();
    }

    // The prelude is one line of its own, so a line of the page's source is two
    // lines down in the rewritten text.
    let mut prelude = String::new();
    let mut members = String::new();
    if fragment {
        members.push_str("float _k_fbh; ");
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
    for (i, name) in r.samplers.iter().enumerate() {
        let b = 2 + 2 * i;
        prelude.push_str(&format!(
            "layout(set=0, binding={b}) uniform texture2D _k_t_{name}; \
             layout(set=0, binding={}) uniform sampler _k_s_{name}; ",
            b + 1
        ));
    }
    for (name, ty) in &r.bools {
        prelude.push_str(&format!("{ty} {name}; "));
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
    if uses_point_size {
        prelude.push_str("float _k_PointSize; ");
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
    wrapper.push_str("_k_main(); ");
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
    Ok(r)
}

struct Ctx<'a, 'b> {
    stage: ShaderStage,
    attribute_locations: &'a BTreeMap<String, u32>,
    varyings: &'b mut Varyings,
    next_attribute: &'b mut u32,
    next_varying: &'b mut u32,
    has_out: &'b mut bool,
    uses_point_size: &'b mut bool,
}

/// A directive other than `#version` and `#extension`: its words go through
/// the same renaming as code (`#define SAMPLE(uv) texture2D(tex, uv)`).
fn rewrite_directive(text: &str, samplers: &[String], fragment: bool, r: &mut Rewritten) -> String {
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
            fragment,
        ) {
            Some(new) => {
                if word == "gl_FragCoord" {
                    r.uses_frag_coord = true;
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
fn rename(word: &str, prev: Option<&str>, samplers: &[String], fragment: bool) -> Option<String> {
    if prev == Some(".") {
        return None;
    }
    Some(match word {
        "texture2D" => "texture".into(),
        "texture2DProj" => "textureProj".into(),
        "texture2DLod" | "texture2DLodEXT" => "textureLod".into(),
        "gl_FragColor" if fragment => "_k_FragColor".into(),
        "gl_FragCoord" if fragment => "_k_FragCoord()".into(),
        "gl_PointSize" => "_k_PointSize".into(),
        w if samplers.iter().any(|s| s == w) => format!("sampler2D(_k_t_{w}, _k_s_{w})"),
        _ => return None,
    })
}

fn flush_chunk(
    chunk: &mut String,
    body: &mut String,
    depth: &mut i32,
    r: &mut Rewritten,
    samplers: &mut Vec<String>,
    ctx: &mut Ctx<'_, '_>,
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
    samplers: &mut Vec<String>,
    ctx: &mut Ctx<'_, '_>,
) -> std::result::Result<String, String> {
    let fragment = ctx.stage == ShaderStage::Fragment;
    let toks = tokenize(text);
    let mut out = String::new();
    let mut last = 0usize;
    let mut i = 0usize;
    // Copies the tokens in `from..to` as code, renamed.
    let code = |out: &mut String,
                last: &mut usize,
                from: usize,
                to: usize,
                r: &mut Rewritten,
                ctx: &mut Ctx<'_, '_>,
                samplers: &[String]| {
        let mut k = from;
        while k < to {
            let t = &toks[k];
            out.push_str(&text[*last..t.start]);
            *last = t.end;
            let w = word(text, t);
            let prev = k.checked_sub(1).map(|p| word(text, &toks[p]));
            if t.kind == Kind::Ident {
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
                if let Some(new) = rename(w, prev, samplers, fragment) {
                    if w == "gl_FragCoord" {
                        r.uses_frag_coord = true;
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
    samplers: &mut Vec<String>,
    ctx: &mut Ctx<'_, '_>,
) -> std::result::Result<Option<String>, String> {
    let fragment = ctx.stage == ShaderStage::Fragment;
    let w = |k: usize| word(text, &stmt[k]);
    if stmt.is_empty() {
        return Ok(None);
    }
    if w(0) == "precision" {
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
                } else {
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
            array = Some(n);
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
                if ty == "sampler2D" {
                    if array.is_some() {
                        return Err(unsupported(format!("`{name}`: an array of samplers")));
                    }
                    r.samplers.push(name.clone());
                    samplers.push(name);
                } else if ty.contains("sampler") {
                    return Err(unsupported(format!(
                        "`{name}`: a `{ty}` uniform; only `sampler2D` textures are available"
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
                            "`{name}`: the length of an array of mat2 must be a number, got `{n}`"
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
                            "`{name}`: the length of an array uniform must be a number, got `{n}`"
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
                } else {
                    return Err(unsupported(format!(
                        "`{name}`: a uniform of type `{ty}` (structs are not available)"
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
                let at = declared
                    .location
                    .or_else(|| ctx.attribute_locations.get(&name).copied())
                    .unwrap_or_else(|| {
                        // The first location nothing was bound to.
                        let mut l = *ctx.next_attribute;
                        while ctx.attribute_locations.values().any(|v| *v == l)
                            || r.attributes.iter().any(|a| a.1 == l)
                        {
                            l += 1;
                        }
                        l
                    });
                *ctx.next_attribute = at + taken;
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
                            "`{name}`: the array length `{n}` of a varying must be a number"
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
                            return Err(format!(
                                "the fragment shader reads the varying `{name}`, which the vertex shader does not write"
                            ));
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
            // A fragment output: one colour attachment.
            for (name, array) in declared.names {
                if array.is_some() {
                    return Err(unsupported(format!("`{name}`: an array output")));
                }
                let at = declared.location.unwrap_or(0);
                if at != 0 {
                    return Err(unsupported(
                        "several colour outputs (only location 0 is drawn)",
                    ));
                }
                *ctx.has_out = true;
                text_out.push_str(&format!("layout(location=0) out {ty} {name}; "));
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

/// A texture the fragment shader samples and the bindings of its texture and
/// its sampler.
#[derive(Clone, Debug, PartialEq)]
pub struct SamplerBinding {
    pub name: String,
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
    pub uses_frag_coord: bool,
    /// The offset of the drawing buffer's height (the fragment stage's).
    pub fbh_offset: Option<u32>,
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
        naga::valid::Capabilities::empty(),
    )
    .validate(&module)
    .map_err(|e| format!("{label}: {}", e.as_inner()))?;

    // The uniform block, by the binding the prelude gave it.
    let block_binding = u32::from(stage == ShaderStage::Fragment);
    let mut uniforms = Vec::new();
    let mut uniform_size = 0;
    let mut samplers: Vec<SamplerBinding> = r
        .samplers
        .iter()
        .enumerate()
        .map(|(i, name)| SamplerBinding {
            name: name.clone(),
            texture: 2 + 2 * i as u32,
            sampler: 3 + 2 * i as u32,
        })
        .collect();
    let mut fbh_offset = None;
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
            let member = member_of(&module, &name, m.offset, m.ty)?;
            if name == "_k_fbh" {
                fbh_offset = Some(m.offset);
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
    Ok(Stage {
        module,
        stage,
        uniforms,
        uniform_size,
        samplers,
        attributes: r.attributes,
        uses_frag_coord: r.uses_frag_coord,
        fbh_offset,
    })
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
/// texture rather than the drawing buffer (`compositor/glsl.rs`).
pub fn translate(program: &GlslProgram, flip_y: bool) -> std::result::Result<Translated, String> {
    let mut varyings = Varyings::default();
    let vr = rewrite(RewriteInput {
        src: &program.vertex,
        stage: ShaderStage::Vertex,
        attribute_locations: &program.attributes,
        varyings: &mut varyings,
        flip_y,
    })?;
    let fr = rewrite(RewriteInput {
        src: &program.fragment,
        stage: ShaderStage::Fragment,
        attribute_locations: &BTreeMap::new(),
        varyings: &mut varyings,
        flip_y,
    })?;
    Ok(Translated {
        vertex: parse_stage(ShaderStage::Vertex, vr)?,
        fragment: parse_stage(ShaderStage::Fragment, fr)?,
    })
}

/// The bytes of a stage's uniform block after `calls`, the uniform calls of a
/// draw (`fbh` is the drawing buffer's height, for `gl_FragCoord`). What no
/// call set is zero, as GL's default.
pub fn uniform_bytes(
    stage: &Stage,
    calls: &BTreeMap<String, Vec<GlslUniform>>,
    fbh: f32,
) -> std::result::Result<Vec<u8>, String> {
    let size = (stage.uniform_size.max(16) as usize).div_ceil(16) * 16;
    let mut bytes = vec![0u8; size];
    if let Some(at) = stage.fbh_offset {
        put(&mut bytes, at as usize, &fbh.to_le_bytes());
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
    use base64::Engine as _;
    match (&texture.src, &texture.pixels) {
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
            let (w, h) = (texture.width, texture.height);
            if w == 0 || h == 0 || bytes.len() != w as usize * h as usize * 4 {
                return Err(format!(
                    "a texture of {w} x {h} needs {} bytes of RGBA, got {}",
                    w as usize * h as usize * 4,
                    bytes.len()
                ));
            }
            Ok((bytes, w, h))
        }
        _ => Err("a texture has either a src or pixels".into()),
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
        translate(program, false)
            .map_err(|e| Error::Scene(format!("layer {layer_id:?}: glsl program {id:?}: {e}")))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A program as the drawing buffer's.
    fn translate(program: &GlslProgram) -> std::result::Result<Translated, String> {
        super::translate(program, false)
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
        let bytes = uniform_bytes(&t.fragment, &calls, 64.0).unwrap();
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
            uniform_bytes(&t.fragment, &calls, 1.0)
        };
        let e = try_one("c", call(GlslUniformKind::Int, &[1.0, 2.0, 3.0], 0)).unwrap_err();
        assert!(e.contains("wrong kind"), "{e}");
        let e = try_one("w", call(GlslUniformKind::Float, &[1.0, 2.0, 3.0], 0)).unwrap_err();
        assert!(e.contains("2 element"), "{e}");
        let e = try_one("c", call(GlslUniformKind::Float, &[1.0, 2.0], 0)).unwrap_err();
        assert!(e.contains("multiple of 3"), "{e}");
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
            let t = super::translate(&p, flip_y).unwrap();
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
            "precision mediump float;\nuniform samplerCube c;\nvoid main() { gl_FragColor = vec4(1.0); }",
        ))
        .unwrap_err();
        assert!(
            e.contains("unsupported") && e.contains("samplerCube"),
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
