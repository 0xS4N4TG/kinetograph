//! A glsl layer's recording (`GlslContent`) replayed into an ANGLE ES 3.0 context (`angle.rs`) in place of the
//! hand-written replay (`compositor/glsl.rs`): the page's own GLSL goes to ANGLE untranslated, and the draws, state,
//! framebuffers and blits are GL calls. The result is the drawing buffer's RGBA8 rows, top row first.
//!
//! Every object is made for the frame and deleted after it, except programs, which are kept by their source (a
//! program is a pure function of it). Textures `layer`-sourced from a group, cube maps, 3D and array textures are
//! not replayed yet: they are an error, which the compositor shows as a failed layer.

use std::collections::HashMap;
use std::path::Path;

use base64::Engine as _;

use crate::angle::{self, Enum, Gl, Texels, gl};
use crate::glsl::{
    self as rec, GlslAttribute, GlslContent, GlslDraw, GlslMode, GlslOp, GlslTexture, GlslType,
    TargetFormat,
};

type R<T> = Result<T, String>;

/// A linked program and its active uniforms (name without `[0]`, size, GL type).
#[derive(Clone)]
struct Program {
    name: u32,
    uniforms: HashMap<String, (i32, Enum)>,
}

type ProgramKey = (String, String, Vec<(String, u32)>);

thread_local! {
    static PROGRAMS: std::cell::RefCell<HashMap<ProgramKey, Program>> = std::cell::RefCell::new(HashMap::new());
}

/// A texture or renderbuffer of the recording, or one face or layer of one: the GL name, whether it is a
/// renderbuffer, the depth or stencil format of a target, the texture target, and the face or layer.
#[derive(Clone, Copy)]
struct Handle {
    name: u32,
    renderbuffer: bool,
    ds: Option<TargetFormat>,
    target: Enum,
    layer: Option<u32>,
}

/// The enum a recorded name stands for.
fn named(name: &str) -> R<Enum> {
    Ok(match name {
        "ZERO" => 0,
        "ONE" => 1,
        "SRC_COLOR" => 0x300,
        "ONE_MINUS_SRC_COLOR" => 0x301,
        "SRC_ALPHA" => 0x302,
        "ONE_MINUS_SRC_ALPHA" => 0x303,
        "DST_ALPHA" => 0x304,
        "ONE_MINUS_DST_ALPHA" => 0x305,
        "DST_COLOR" => 0x306,
        "ONE_MINUS_DST_COLOR" => 0x307,
        "SRC_ALPHA_SATURATE" => 0x308,
        "CONSTANT_COLOR" => 0x8001,
        "ONE_MINUS_CONSTANT_COLOR" => 0x8002,
        "CONSTANT_ALPHA" => 0x8003,
        "ONE_MINUS_CONSTANT_ALPHA" => 0x8004,
        "FUNC_ADD" => 0x8006,
        "FUNC_SUBTRACT" => 0x800A,
        "FUNC_REVERSE_SUBTRACT" => 0x800B,
        "MIN" => 0x8007,
        "MAX" => 0x8008,
        "NEVER" => 0x200,
        "LESS" => 0x201,
        "EQUAL" => 0x202,
        "LEQUAL" => 0x203,
        "GREATER" => 0x204,
        "NOTEQUAL" => 0x205,
        "GEQUAL" => 0x206,
        "ALWAYS" => 0x207,
        "KEEP" => 0x1E00,
        "REPLACE" => 0x1E01,
        "INCR" => 0x1E02,
        "DECR" => 0x1E03,
        "INVERT" => 0x150A,
        "INCR_WRAP" => 0x8507,
        "DECR_WRAP" => 0x8508,
        "FRONT" => gl::FRONT,
        "BACK" => gl::BACK,
        "FRONT_AND_BACK" => gl::FRONT_AND_BACK,
        "CW" => 0x900,
        "CCW" => 0x901,
        "NEAREST" => 0x2600,
        "LINEAR" => 0x2601,
        "NEAREST_MIPMAP_NEAREST" => 0x2700,
        "LINEAR_MIPMAP_NEAREST" => 0x2701,
        "NEAREST_MIPMAP_LINEAR" => 0x2702,
        "LINEAR_MIPMAP_LINEAR" => 0x2703,
        "REPEAT" => 0x2901,
        "CLAMP_TO_EDGE" => 0x812F,
        "MIRRORED_REPEAT" => 0x8370,
        other => return Err(format!("unsupported: the GL name {other}")),
    })
}

/// The internal format, the data type and the bytes of float texels.
fn float_texels(t: &rec::Texels) -> (Enum, Enum, &[u8]) {
    match t {
        rec::Texels::Rgba8(b) => (gl::RGBA8, gl::UNSIGNED_BYTE, b),
        rec::Texels::Rgba16F(b) => (gl::RGBA16F, gl::HALF_FLOAT, b),
        rec::Texels::Rgba32F(b) => (gl::RGBA32F, gl::FLOAT, b),
    }
}

fn type_enum(ty: GlslType) -> Enum {
    match ty {
        GlslType::F32 => gl::FLOAT,
        GlslType::U8 => gl::UNSIGNED_BYTE,
        GlslType::I8 => gl::BYTE,
        GlslType::U16 => gl::UNSIGNED_SHORT,
        GlslType::I16 => gl::SHORT,
        GlslType::U32 => gl::UNSIGNED_INT,
        GlslType::I32 => gl::INT,
    }
}

fn color_internal(format: Option<rec::ColorFormat>) -> Enum {
    use rec::ColorFormat as F;
    match format {
        None => gl::RGBA8,
        Some(F::R16F) => gl::R16F,
        Some(F::RG16F) => gl::RG16F,
        Some(F::RGBA16F) => gl::RGBA16F,
        Some(F::R32F) => gl::R32F,
        Some(F::RG32F) => gl::RG32F,
        Some(F::RGBA32F) => gl::RGBA32F,
        Some(F::Srgb8Alpha8) => gl::SRGB8_ALPHA8,
        Some(F::R8) => gl::R8,
        Some(F::RG8) => gl::RG8,
    }
}

fn ds_internal(ds: TargetFormat) -> Enum {
    match ds {
        TargetFormat::Depth => gl::DEPTH_COMPONENT24,
        TargetFormat::Stencil => gl::STENCIL_INDEX8,
        TargetFormat::DepthStencil => gl::DEPTH24_STENCIL8,
    }
}

fn ds_attachment(ds: TargetFormat) -> Enum {
    match ds {
        TargetFormat::Depth => gl::DEPTH_ATTACHMENT,
        TargetFormat::Stencil => gl::STENCIL_ATTACHMENT,
        TargetFormat::DepthStencil => gl::DEPTH_STENCIL_ATTACHMENT,
    }
}

struct Replay<'a> {
    gl: &'a Gl,
    content: &'a GlslContent,
    base_dir: &'a Path,
    size: (u32, u32),
    buffers: HashMap<&'a str, u32>,
    textures: HashMap<&'a str, Handle>,
    /// The targets a framebuffer draws a cube face or an array or 3D layer into, as the recorder lists them under
    /// the cube or array texture (`targets`): the target's id, to the texture's id and the face or layer.
    parts: HashMap<&'a str, (&'a str, u32)>,
    samplers: Vec<u32>,
    framebuffers: Vec<u32>,
    vao: u32,
    canvas: Canvas,
}

/// The drawing buffer: colour, depth and stencil renderbuffers, multisampled when the context asked for `antialias`.
struct Canvas {
    fbo: u32,
    resolve: u32,
    renderbuffers: Vec<u32>,
    samples: i32,
}

fn multisampled(content: &GlslContent) -> bool {
    // The hand-written replay's rule: a blit that writes the drawing buffer or copies its depth makes it single sample.
    content.antialias
        && !content
            .ops
            .iter()
            .any(|op| matches!(op, GlslOp::Blit(b) if b.target.is_none() || (b.aspect.is_some() && b.src.is_none())))
}

/// Runs `content` into a `size` drawing buffer; RGBA8 rows, top first.
pub fn replay(content: &GlslContent, size: (u32, u32), base_dir: &Path) -> R<Vec<u8>> {
    if content.webgpu.is_some() {
        return Err("unsupported: a WebGPU recording is not replayed by ANGLE".into());
    }
    angle::with(|gl| run(gl, content, size, base_dir))?
}

fn run(gl_: &Gl, content: &GlslContent, size: (u32, u32), base_dir: &Path) -> R<Vec<u8>> {
    // A context made with WebGL compatibility keeps its extensions off until asked.
    for ext in [
        "GL_EXT_color_buffer_float",
        "GL_EXT_float_blend",
        "GL_OES_texture_float_linear",
    ] {
        gl_.request_extension(ext);
    }
    gl_.pixel_storei(0xCF5, 1); // UNPACK_ALIGNMENT
    let mut replay = Replay {
        gl: gl_,
        content,
        base_dir,
        size,
        buffers: HashMap::new(),
        textures: HashMap::new(),
        parts: content
            .textures
            .iter()
            .filter(|(_, t)| t.cube || t.depth > 0)
            .flat_map(|(id, t)| {
                t.targets
                    .iter()
                    .enumerate()
                    .map(move |(i, f)| (f.as_str(), (id.as_str(), i as u32)))
            })
            .collect(),
        samplers: Vec::new(),
        framebuffers: Vec::new(),
        vao: gl_.gen_vertex_array(),
        canvas: Canvas {
            fbo: 0,
            resolve: 0,
            renderbuffers: Vec::new(),
            samples: 0,
        },
    };
    let out = replay.go();
    replay.release();
    out
}

impl<'a> Replay<'a> {
    fn go(&mut self) -> R<Vec<u8>> {
        let gl_ = self.gl;
        self.make_canvas();
        gl_.bind_vertex_array(self.vao);
        let debug = std::env::var_os("KINETOGRAPH_ANGLE_DEBUG").is_some();
        for (i, op) in self.content.ops.iter().enumerate() {
            match op {
                GlslOp::Clear { .. } => self.clear(op)?,
                GlslOp::Draw(d) => self.draw(d)?,
                GlslOp::Blit(b) => self.blit(b)?,
                GlslOp::Upload(u) => self.upload(u)?,
            }
            // `KINETOGRAPH_ANGLE_DUMP=<op>:<path>`: the colour attachment the op wrote, as a PPM, for finding which
            // op goes wrong.
            if let Some((n, path)) = std::env::var("KINETOGRAPH_ANGLE_DUMP").ok().and_then(|v| {
                v.split_once(':')
                    .map(|(n, p)| (n.parse::<usize>().ok(), p.to_string()))
            }) && n == Some(i)
            {
                let fbo = match op.dest() {
                    Some(d) if d.is_framebuffer() => self.framebuffers.last().copied().unwrap_or(0),
                    _ => self.canvas.fbo,
                };
                let (w, h) = (self.size.0 as i32, self.size.1 as i32);
                gl_.bind_framebuffer(gl::READ_FRAMEBUFFER, fbo);
                gl_.read_buffer(gl::COLOR_ATTACHMENT0);
                let mut px = vec![0u8; (w * h * 4) as usize];
                gl_.read_pixels((w, h), &mut px);
                let mut ppm = format!("P6\n{w} {h}\n255\n").into_bytes();
                ppm.extend(px.chunks(4).flat_map(|p| [p[0], p[1], p[2]]));
                let _ = std::fs::write(path, ppm);
            }
            if debug {
                let e = gl_.get_error();
                if e != 0 {
                    eprintln!("angle: op {i}: GL error 0x{e:x}");
                }
            }
        }
        // Resolve a multisampled drawing buffer, then read it from the bottom row up and turn it over.
        let (w, h) = (self.size.0 as i32, self.size.1 as i32);
        let read = if self.canvas.samples > 0 {
            gl_.bind_framebuffer(gl::READ_FRAMEBUFFER, self.canvas.fbo);
            gl_.bind_framebuffer(gl::DRAW_FRAMEBUFFER, self.canvas.resolve);
            gl_.disable(gl::SCISSOR_TEST);
            gl_.color_mask(1, 1, 1, 1);
            gl_.blit_framebuffer(0, 0, w, h, 0, 0, w, h, gl::COLOR_BUFFER_BIT, gl::NEAREST);
            self.canvas.resolve
        } else {
            self.canvas.fbo
        };
        gl_.bind_framebuffer(gl::READ_FRAMEBUFFER, read);
        gl_.read_buffer(gl::COLOR_ATTACHMENT0);
        let mut bottom_up = vec![0u8; (w * h * 4) as usize];
        gl_.read_pixels((w, h), &mut bottom_up);
        let row = (w * 4) as usize;
        Ok(bottom_up.chunks(row).rev().flatten().copied().collect())
    }

    fn make_canvas(&mut self) {
        let gl_ = self.gl;
        let (w, h) = (self.size.0 as i32, self.size.1 as i32);
        let samples = if multisampled(self.content) { 4 } else { 0 };
        let colour = |fbo: u32, samples: i32, renderbuffers: &mut Vec<u32>| {
            gl_.bind_framebuffer(gl::FRAMEBUFFER, fbo);
            let rb = gl_.gen_renderbuffer();
            gl_.bind_renderbuffer(gl::RENDERBUFFER, rb);
            gl_.renderbuffer_storage_multisample(gl::RENDERBUFFER, samples, gl::RGBA8, w, h);
            gl_.framebuffer_renderbuffer(
                gl::FRAMEBUFFER,
                gl::COLOR_ATTACHMENT0,
                gl::RENDERBUFFER,
                rb,
            );
            renderbuffers.push(rb);
        };
        let mut renderbuffers = Vec::new();
        let fbo = gl_.gen_framebuffer();
        colour(fbo, samples, &mut renderbuffers);
        let ds = match (self.content.depth, self.content.stencil) {
            (true, true) => Some(TargetFormat::DepthStencil),
            (true, false) => Some(TargetFormat::Depth),
            (false, true) => Some(TargetFormat::Stencil),
            (false, false) => None,
        };
        if let Some(ds) = ds {
            let rb = gl_.gen_renderbuffer();
            gl_.bind_renderbuffer(gl::RENDERBUFFER, rb);
            gl_.renderbuffer_storage_multisample(gl::RENDERBUFFER, samples, ds_internal(ds), w, h);
            gl_.framebuffer_renderbuffer(gl::FRAMEBUFFER, ds_attachment(ds), gl::RENDERBUFFER, rb);
            renderbuffers.push(rb);
        }
        let mut resolve = 0;
        if samples > 0 {
            resolve = gl_.gen_framebuffer();
            colour(resolve, 0, &mut renderbuffers);
        }
        self.canvas = Canvas {
            fbo,
            resolve,
            renderbuffers,
            samples,
        };
        // A drawing buffer starts transparent black, opaque black when the context has no alpha.
        gl_.bind_framebuffer(gl::FRAMEBUFFER, fbo);
        gl_.disable(gl::SCISSOR_TEST);
        gl_.color_mask(1, 1, 1, 1);
        gl_.depth_mask(1);
        gl_.stencil_mask_separate(gl::FRONT_AND_BACK, 0xFFFF_FFFF);
        gl_.clear_color(0.0, 0.0, 0.0, if self.content.alpha { 0.0 } else { 1.0 });
        gl_.clear_depthf(1.0);
        gl_.clear_stencil(0);
        gl_.clear(gl::COLOR_BUFFER_BIT | gl::DEPTH_BUFFER_BIT | gl::STENCIL_BUFFER_BIT);
    }

    fn release(&mut self) {
        let gl_ = self.gl;
        gl_.bind_framebuffer(gl::FRAMEBUFFER, 0);
        for b in self.buffers.values() {
            gl_.delete_buffer(*b);
        }
        // A face or a layer shares its texture's name: each name once.
        let mut names: Vec<(u32, bool)> = self
            .textures
            .values()
            .map(|t| (t.name, t.renderbuffer))
            .collect();
        names.sort_unstable();
        names.dedup();
        for (name, renderbuffer) in names {
            if renderbuffer {
                gl_.delete_renderbuffer(name);
            } else {
                gl_.delete_texture(name);
            }
        }
        for s in &self.samplers {
            gl_.delete_sampler(*s);
        }
        for f in &self.framebuffers {
            gl_.delete_framebuffer(*f);
        }
        for r in &self.canvas.renderbuffers {
            gl_.delete_renderbuffer(*r);
        }
        gl_.delete_framebuffer(self.canvas.fbo);
        if self.canvas.resolve != 0 {
            gl_.delete_framebuffer(self.canvas.resolve);
        }
        gl_.delete_vertex_array(self.vao);
    }

    // ---- resources ----

    fn buffer(&mut self, id: &'a str) -> R<u32> {
        if let Some(b) = self.buffers.get(id) {
            return Ok(*b);
        }
        let b64 = self
            .content
            .buffers
            .get(id)
            .ok_or_else(|| format!("no buffer {id}"))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("buffer {id}: {e}"))?;
        let name = self.gl.gen_buffer();
        self.gl.bind_buffer(gl::ARRAY_BUFFER, name);
        self.gl.buffer_data(gl::ARRAY_BUFFER, &bytes);
        self.buffers.insert(id, name);
        Ok(name)
    }

    fn texture(&mut self, id: &'a str) -> R<Handle> {
        if let Some(h) = self.textures.get(id) {
            return Ok(*h);
        }
        let handle = if let Some(&(parent, layer)) = self.parts.get(id) {
            // A face or a layer: the texture that holds it is made first, from its first target's format.
            let whole = self.texture(parent)?;
            let spec = self
                .content
                .textures
                .get(id)
                .ok_or_else(|| format!("no texture {id}"))?;
            Handle {
                ds: spec.format,
                layer: Some(layer),
                ..whole
            }
        } else {
            let spec = self
                .content
                .textures
                .get(id)
                .ok_or_else(|| format!("no texture {id}"))?;
            self.make_texture(spec)?
        };
        self.textures.insert(id, handle);
        Ok(handle)
    }

    /// The internal format of a render target's spec.
    fn target_internal(t: &GlslTexture) -> Enum {
        t.format
            .map_or_else(|| color_internal(t.color_format), ds_internal)
    }

    fn make_texture(&self, t: &GlslTexture) -> R<Handle> {
        let gl_ = self.gl;
        if t.layer.is_some() {
            return Err(
                "unsupported: a group layer as a texture is not replayed by ANGLE yet".into(),
            );
        }
        let whole = |name, target, ds| Handle {
            name,
            renderbuffer: false,
            ds,
            target,
            layer: None,
        };
        let (w, h) = (t.width as i32, t.height as i32);
        if t.target {
            // A render target. Multisampled and stencil-only ones are renderbuffers (not samplable), the rest textures.
            let internal = Self::target_internal(t);
            if t.samples > 1 || t.format == Some(TargetFormat::Stencil) {
                let name = gl_.gen_renderbuffer();
                gl_.bind_renderbuffer(gl::RENDERBUFFER, name);
                gl_.renderbuffer_storage_multisample(
                    gl::RENDERBUFFER,
                    t.samples.max(1) as i32,
                    internal,
                    w,
                    h,
                );
                return Ok(Handle {
                    renderbuffer: true,
                    ..whole(name, gl::TEXTURE_2D, t.format)
                });
            }
            let name = gl_.gen_texture();
            gl_.bind_texture(gl::TEXTURE_2D, name);
            gl_.tex_storage_2d(gl::TEXTURE_2D, t.levels.max(1) as i32, internal, w, h);
            return Ok(whole(name, gl::TEXTURE_2D, t.format));
        }
        let first_target = |t: &GlslTexture| {
            t.targets
                .first()
                .and_then(|id| self.content.textures.get(id.as_str()))
                .ok_or_else(|| "a cube, array or 3D texture lists no targets".to_string())
        };
        if t.cube {
            let name = gl_.gen_texture();
            gl_.bind_texture(gl::TEXTURE_CUBE_MAP, name);
            if !t.targets.is_empty() {
                let f = first_target(t)?;
                gl_.tex_storage_2d(
                    gl::TEXTURE_CUBE_MAP,
                    f.levels.max(1) as i32,
                    Self::target_internal(f),
                    f.width as i32,
                    f.height as i32,
                );
                return Ok(whole(name, gl::TEXTURE_CUBE_MAP, f.format));
            }
            // No faces: an incomplete cube map, which samples as opaque black.
            if t.faces.is_empty() {
                return Ok(whole(name, gl::TEXTURE_CUBE_MAP, None));
            }
            if let Some((faces, side)) = rec::decode_cube_floats(t)? {
                for (i, texels) in faces.iter().enumerate() {
                    let (internal, ty, bytes) = float_texels(texels);
                    gl_.tex_image_2d(
                        gl::TEXTURE_CUBE_MAP_POSITIVE_X + i as u32,
                        0,
                        internal,
                        (side as i32, side as i32),
                        Some(Texels {
                            format: gl::RGBA,
                            ty,
                            bytes,
                        }),
                    );
                }
            } else if let Some((faces, side)) = rec::decode_cube(t, self.base_dir)? {
                for (i, rgba) in faces.iter().enumerate() {
                    gl_.tex_image_2d(
                        gl::TEXTURE_CUBE_MAP_POSITIVE_X + i as u32,
                        0,
                        if t.srgb { gl::SRGB8_ALPHA8 } else { gl::RGBA8 },
                        (side as i32, side as i32),
                        Some(Texels {
                            format: gl::RGBA,
                            ty: gl::UNSIGNED_BYTE,
                            bytes: rgba,
                        }),
                    );
                }
            }
            if t.mipmaps {
                gl_.generate_mipmap(gl::TEXTURE_CUBE_MAP);
            }
            return Ok(whole(name, gl::TEXTURE_CUBE_MAP, None));
        }
        if t.depth > 0 {
            let target = if t.array {
                gl::TEXTURE_2D_ARRAY
            } else {
                gl::TEXTURE_3D
            };
            let name = gl_.gen_texture();
            gl_.bind_texture(target, name);
            if !t.targets.is_empty() {
                let f = first_target(t)?;
                gl_.tex_storage_3d(
                    target,
                    f.levels.max(1) as i32,
                    Self::target_internal(f),
                    w,
                    h,
                    t.depth as i32,
                );
                return Ok(whole(name, target, f.format));
            }
            let (internal, ty, bytes) = match &rec::decode_texels(t)? {
                rec::Texels::Rgba8(b) => (gl::RGBA8, gl::UNSIGNED_BYTE, b.clone()),
                other => {
                    let (i, ty, b) = float_texels(other);
                    (i, ty, b.to_vec())
                }
            };
            gl_.tex_image_3d(
                target,
                internal,
                (w, h, t.depth as i32),
                Texels {
                    format: gl::RGBA,
                    ty,
                    bytes: &bytes,
                },
            );
            if t.mipmaps {
                gl_.generate_mipmap(target);
            }
            return Ok(whole(name, target, None));
        }
        let name = gl_.gen_texture();
        gl_.bind_texture(gl::TEXTURE_2D, name);
        if t.floats.is_some() {
            let texels = rec::decode_texels(t)?;
            let (internal, ty, bytes) = float_texels(&texels);
            gl_.tex_image_2d(
                gl::TEXTURE_2D,
                0,
                internal,
                (w, h),
                Some(Texels {
                    format: gl::RGBA,
                    ty,
                    bytes,
                }),
            );
        } else {
            let (mut rgba, w, h) = rec::decode_texture(t, self.base_dir)?;
            rec::unpack(&mut rgba, w, t.flip_y, t.premultiply);
            gl_.tex_image_2d(
                gl::TEXTURE_2D,
                0,
                if t.srgb { gl::SRGB8_ALPHA8 } else { gl::RGBA8 },
                (w as i32, h as i32),
                Some(Texels {
                    format: gl::RGBA,
                    ty: gl::UNSIGNED_BYTE,
                    bytes: &rgba,
                }),
            );
            for p in &t.patches {
                if p.layer.is_some() {
                    return Err("unsupported: a group layer patch".into());
                }
                let (mut px, pw, ph) = rec::decode_picture(
                    p.src.as_deref(),
                    p.pixels.as_deref(),
                    (p.width, p.height),
                    self.base_dir,
                )?;
                rec::unpack(&mut px, pw, p.flip_y, p.premultiply);
                gl_.tex_sub_image_2d(
                    0,
                    (p.x as i32, p.y as i32, pw as i32, ph as i32),
                    Texels {
                        format: gl::RGBA,
                        ty: gl::UNSIGNED_BYTE,
                        bytes: &px,
                    },
                );
            }
        }
        if t.mipmaps {
            gl_.generate_mipmap(gl::TEXTURE_2D);
        }
        Ok(whole(name, gl::TEXTURE_2D, None))
    }

    fn program(&self, id: &str) -> R<Program> {
        let spec = self
            .content
            .programs
            .get(id)
            .ok_or_else(|| format!("no program {id}"))?;
        let mut attrs: Vec<(String, u32)> = spec
            .attributes
            .iter()
            .map(|(k, v)| (k.clone(), *v))
            .collect();
        attrs.sort();
        let key = (spec.vertex.clone(), spec.fragment.clone(), attrs.clone());
        if let Some(p) = PROGRAMS.with(|p| p.borrow().get(&key).cloned()) {
            return Ok(p);
        }
        let gl_ = self.gl;
        let vs = gl_
            .compile(gl::VERTEX_SHADER, &spec.vertex)
            .map_err(|e| format!("vertex shader: {e}"))?;
        let fs = gl_
            .compile(gl::FRAGMENT_SHADER, &spec.fragment)
            .map_err(|e| format!("fragment shader: {e}"))?;
        let name = gl_.create_program();
        gl_.attach_shader(name, vs);
        gl_.attach_shader(name, fs);
        for (attr, index) in &attrs {
            gl_.bind_attrib_location(name, *index, attr);
        }
        gl_.link(name).map_err(|e| format!("link: {e}"))?;
        gl_.delete_shader(vs);
        gl_.delete_shader(fs);
        let uniforms = gl_
            .active_uniforms(name)
            .into_iter()
            .map(|u| {
                (
                    u.name.strip_suffix("[0]").unwrap_or(&u.name).to_string(),
                    (u.size, u.ty),
                )
            })
            .collect();
        let program = Program { name, uniforms };
        PROGRAMS.with(|p| p.borrow_mut().insert(key, program.clone()));
        Ok(program)
    }

    // ---- framebuffers ----

    /// Binds the framebuffer an op draws into and sets its draw buffers.
    fn bind_dest(&mut self, dest: &rec::GlslDest<'a>) -> R<()> {
        let gl_ = self.gl;
        if !dest.is_framebuffer() {
            gl_.bind_framebuffer(gl::FRAMEBUFFER, self.canvas.fbo);
            gl_.draw_buffers(&[gl::COLOR_ATTACHMENT0]);
            return Ok(());
        }
        let fbo = gl_.gen_framebuffer();
        self.framebuffers.push(fbo);
        gl_.bind_framebuffer(gl::FRAMEBUFFER, fbo);
        let mut draw = Vec::new();
        for (i, slot) in dest.colors().into_iter().enumerate() {
            let point = gl::COLOR_ATTACHMENT0 + i as u32;
            match slot {
                Some((Some(id), level)) => {
                    let h = self.texture(id)?;
                    self.attach(point, h, level);
                    draw.push(point);
                }
                _ => draw.push(gl::NONE),
            }
        }
        if let Some(id) = dest.depth_stencil {
            let h = self.texture(id)?;
            let ds =
                h.ds.ok_or_else(|| format!("{id} is not a depth or stencil buffer"))?;
            self.attach(ds_attachment(ds), h, 0);
        }
        gl_.draw_buffers(&draw);
        Ok(())
    }

    fn attach(&self, point: Enum, h: Handle, level: u32) {
        let gl_ = self.gl;
        match (h.renderbuffer, h.target, h.layer) {
            (true, ..) => {
                gl_.framebuffer_renderbuffer(gl::FRAMEBUFFER, point, gl::RENDERBUFFER, h.name)
            }
            (_, gl::TEXTURE_CUBE_MAP, Some(face)) => gl_.framebuffer_texture_2d(
                gl::FRAMEBUFFER,
                point,
                gl::TEXTURE_CUBE_MAP_POSITIVE_X + face,
                h.name,
                level as i32,
            ),
            (_, gl::TEXTURE_3D | gl::TEXTURE_2D_ARRAY, Some(layer)) => gl_
                .framebuffer_texture_layer(
                    gl::FRAMEBUFFER,
                    point,
                    h.name,
                    level as i32,
                    layer as i32,
                ),
            _ => gl_.framebuffer_texture_2d(
                gl::FRAMEBUFFER,
                point,
                gl::TEXTURE_2D,
                h.name,
                level as i32,
            ),
        }
    }

    // ---- ops ----

    fn full_masks(&self) {
        let gl_ = self.gl;
        gl_.disable(gl::SCISSOR_TEST);
        gl_.color_mask(1, 1, 1, 1);
        gl_.depth_mask(1);
        gl_.stencil_mask_separate(gl::FRONT_AND_BACK, 0xFFFF_FFFF);
    }

    fn clear(&mut self, op: &'a GlslOp) -> R<()> {
        let GlslOp::Clear {
            color,
            depth,
            stencil,
            ..
        } = op
        else {
            return Ok(());
        };
        let dest = op.dest().expect("a clear has a destination");
        self.bind_dest(&dest)?;
        self.full_masks();
        let mut mask = 0;
        if let Some(c) = color {
            self.gl
                .clear_color(c[0] as f32, c[1] as f32, c[2] as f32, c[3] as f32);
            mask |= gl::COLOR_BUFFER_BIT;
        }
        if let Some(d) = depth {
            self.gl.clear_depthf(*d as f32);
            mask |= gl::DEPTH_BUFFER_BIT;
        }
        if let Some(s) = stencil {
            self.gl.clear_stencil(*s as i32);
            mask |= gl::STENCIL_BUFFER_BIT;
        }
        self.gl.clear(mask);
        Ok(())
    }

    fn upload(&mut self, u: &'a rec::GlslUpload) -> R<()> {
        if u.layer.is_some() {
            return Err("unsupported: an upload of a group layer".into());
        }
        let (mut px, w, h) = rec::decode_picture(
            u.src.as_deref(),
            u.pixels.as_deref(),
            (u.width, u.height),
            self.base_dir,
        )?;
        rec::unpack(&mut px, w, u.flip_y, u.premultiply);
        let target = self.texture(&u.target)?;
        self.gl.bind_texture(gl::TEXTURE_2D, target.name);
        self.gl.tex_sub_image_2d(
            0,
            (u.x as i32, u.y as i32, w as i32, h as i32),
            Texels {
                format: gl::RGBA,
                ty: gl::UNSIGNED_BYTE,
                bytes: &px,
            },
        );
        Ok(())
    }

    fn blit(&mut self, b: &'a rec::GlslBlit) -> R<()> {
        let gl_ = self.gl;
        let aspect = b.aspect;
        // One framebuffer for each side that is a target; the drawing buffer's own for the other.
        let mut sides = [self.canvas.fbo; 2];
        for (side, (id, level)) in [
            (b.src.as_deref(), b.src_level),
            (b.target.as_deref(), b.level),
        ]
        .into_iter()
        .enumerate()
        {
            let Some(id) = id else { continue };
            let fbo = gl_.gen_framebuffer();
            self.framebuffers.push(fbo);
            gl_.bind_framebuffer(gl::FRAMEBUFFER, fbo);
            let h = self.texture(id)?;
            match aspect {
                None => {
                    self.attach(gl::COLOR_ATTACHMENT0, h, level);
                    gl_.draw_buffers(&[gl::COLOR_ATTACHMENT0]);
                }
                Some(_) => {
                    let ds =
                        h.ds.ok_or_else(|| format!("{id} is not a depth or stencil buffer"))?;
                    self.attach(ds_attachment(ds), h, 0);
                    gl_.draw_buffers(&[gl::NONE]);
                }
            }
            sides[side] = fbo;
        }
        gl_.bind_framebuffer(gl::READ_FRAMEBUFFER, sides[0]);
        gl_.bind_framebuffer(gl::DRAW_FRAMEBUFFER, sides[1]);
        let mask = match aspect {
            None => gl::COLOR_BUFFER_BIT,
            Some(a) => {
                (if a.depth() { gl::DEPTH_BUFFER_BIT } else { 0 })
                    | (if a.stencil() {
                        gl::STENCIL_BUFFER_BIT
                    } else {
                        0
                    })
            }
        };
        if aspect.is_none() {
            gl_.read_buffer(gl::COLOR_ATTACHMENT0);
        }
        match b.scissor {
            Some([x, y, w, h]) => {
                gl_.enable(gl::SCISSOR_TEST);
                gl_.scissor(x, y, w, h);
            }
            None => gl_.disable(gl::SCISSOR_TEST),
        }
        gl_.color_mask(1, 1, 1, 1);
        gl_.depth_mask(1);
        gl_.stencil_mask_separate(gl::FRONT_AND_BACK, 0xFFFF_FFFF);
        let filter = if b.linear { 0x2601 } else { gl::NEAREST };
        let [x0, y0, x1, y1] = b.from;
        let [u0, v0, u1, v1] = b.to;
        gl_.blit_framebuffer(x0, y0, x1, y1, u0, v0, u1, v1, mask, filter);
        Ok(())
    }

    fn draw(&mut self, d: &'a GlslDraw) -> R<()> {
        let gl_ = self.gl;
        let program = self.program(&d.program)?;
        let dest = d.dest();
        self.bind_dest(&dest)?;
        gl_.use_program(program.name);

        // Vertex input.
        for i in 0..16 {
            gl_.disable_vertex_attrib_array(i);
            gl_.vertex_attrib_divisor(i, 0);
        }
        for (name, a) in &d.attributes {
            // The recorder names the columns of a `mat2`, `mat3` or `mat4` attribute `name[0]`, `name[1]`, ...; GL
            // gives the matrix one name and as many consecutive locations.
            let (base, column) = match name.strip_suffix(']').and_then(|n| n.split_once('[')) {
                Some((base, i)) => (base, i.parse::<i32>().unwrap_or(0)),
                None => (name.as_str(), 0),
            };
            let loc = gl_.attrib_location(program.name, base);
            if loc < 0 {
                continue;
            }
            self.attribute((loc + column) as u32, a)?;
        }
        self.check("vertex input");
        // Uniforms.
        for (name, calls) in &d.uniforms {
            for call in calls {
                set_uniform(gl_, &program, name, call);
            }
        }
        for (slot, (block, range)) in d.blocks.iter().enumerate() {
            let Some(index) = gl_.uniform_block_index(program.name, block) else {
                continue;
            };
            let buffer = self.buffer(&range.buffer)?;
            gl_.uniform_block_binding(program.name, index, slot as u32);
            gl_.bind_buffer_range(
                gl::UNIFORM_BUFFER,
                slot as u32,
                buffer,
                range.offset as isize,
                range.size as isize,
            );
        }
        self.check("uniforms and blocks");
        // Textures.
        let mut units: Vec<(u32, &'a rec::GlslSampler)> = Vec::new();
        for (unit, s) in &d.units {
            units.push((unit.parse().map_err(|_| format!("texture unit {unit}"))?, s));
        }
        for (unit, s) in units {
            let h = self.texture(&s.texture)?;
            // The recording keeps the sampling state with the unit, not the texture (one texture, bound twice with
            // two filters, is one id), which is what a GL sampler object holds.
            let sampler = gl_.gen_sampler();
            self.samplers.push(sampler);
            for (name, v) in [
                (gl::TEXTURE_MIN_FILTER, named(&s.min)?),
                (gl::TEXTURE_MAG_FILTER, named(&s.mag)?),
                (gl::TEXTURE_WRAP_S, named(&s.wrap_s)?),
                (gl::TEXTURE_WRAP_T, named(&s.wrap_t)?),
                (gl::TEXTURE_WRAP_R, named(&s.wrap_r)?),
            ] {
                gl_.sampler_parameteri(sampler, name, v as i32);
            }
            if let Some(f) = &s.compare {
                gl_.sampler_parameteri(
                    sampler,
                    gl::TEXTURE_COMPARE_MODE,
                    gl::COMPARE_REF_TO_TEXTURE,
                );
                gl_.sampler_parameteri(sampler, gl::TEXTURE_COMPARE_FUNC, named(f)? as i32);
            }
            gl_.active_texture(gl::TEXTURE0 + unit);
            gl_.bind_texture(h.target, h.name);
            gl_.bind_sampler(unit, sampler);
            gl_.tex_parameteri(h.target, gl::TEXTURE_BASE_LEVEL, s.base_level as i32);
            if let Some(m) = s.max_level {
                gl_.tex_parameteri(h.target, gl::TEXTURE_MAX_LEVEL, m as i32);
            }
        }

        self.check("textures");
        // State.
        gl_.viewport(d.viewport[0], d.viewport[1], d.viewport[2], d.viewport[3]);
        match d.scissor {
            Some([x, y, w, h]) => {
                gl_.enable(gl::SCISSOR_TEST);
                gl_.scissor(x, y, w, h);
            }
            None => gl_.disable(gl::SCISSOR_TEST),
        }
        toggle(gl_, gl::SAMPLE_ALPHA_TO_COVERAGE, d.alpha_to_coverage);
        match &d.blend {
            Some(b) => {
                gl_.enable(gl::BLEND);
                gl_.blend_func_separate(
                    named(&b.src_rgb)?,
                    named(&b.dst_rgb)?,
                    named(&b.src_alpha)?,
                    named(&b.dst_alpha)?,
                );
                gl_.blend_equation_separate(named(&b.eq_rgb)?, named(&b.eq_alpha)?);
                gl_.blend_color(
                    b.color[0] as f32,
                    b.color[1] as f32,
                    b.color[2] as f32,
                    b.color[3] as f32,
                );
            }
            None => gl_.disable(gl::BLEND),
        }
        let m = d.color_mask;
        gl_.color_mask(
            u8::from(m[0]),
            u8::from(m[1]),
            u8::from(m[2]),
            u8::from(m[3]),
        );
        match &d.cull {
            Some(c) => {
                gl_.enable(gl::CULL_FACE);
                gl_.cull_face(named(&c.face)?);
                gl_.front_face(named(&c.front)?);
            }
            None => gl_.disable(gl::CULL_FACE),
        }
        match &d.depth {
            Some(z) => {
                gl_.enable(gl::DEPTH_TEST);
                gl_.depth_func(named(&z.func)?);
                gl_.depth_mask(u8::from(z.mask));
                gl_.depth_rangef(z.near as f32, z.far as f32);
            }
            None => {
                gl_.disable(gl::DEPTH_TEST);
                gl_.depth_mask(0);
            }
        }
        match &d.polygon_offset {
            Some(p) => {
                gl_.enable(gl::POLYGON_OFFSET_FILL);
                gl_.polygon_offset(p.factor as f32, p.units as f32);
            }
            None => gl_.disable(gl::POLYGON_OFFSET_FILL),
        }
        match &d.stencil {
            Some(s) => {
                gl_.enable(gl::STENCIL_TEST);
                for (face, f) in [(gl::FRONT, &s.front), (gl::BACK, &s.back)] {
                    gl_.stencil_func_separate(face, named(&f.func)?, s.r#ref as i32, s.value_mask);
                    gl_.stencil_op_separate(
                        face,
                        named(&f.fail)?,
                        named(&f.zfail)?,
                        named(&f.zpass)?,
                    );
                    gl_.stencil_mask_separate(face, s.write_mask);
                }
            }
            None => gl_.disable(gl::STENCIL_TEST),
        }

        self.check("state");
        // Draw.
        let mode = match d.mode {
            GlslMode::Points => gl::POINTS,
            GlslMode::Triangles => gl::TRIANGLES,
            GlslMode::TriangleStrip => gl::TRIANGLE_STRIP,
            GlslMode::TriangleFan => gl::TRIANGLE_FAN,
            GlslMode::Lines => gl::LINES,
            GlslMode::LineStrip => gl::LINE_STRIP,
            GlslMode::LineLoop => gl::LINE_LOOP,
        };
        match &d.indices {
            Some(ix) => {
                let buffer = self.buffer(&ix.buffer)?;
                gl_.bind_buffer(gl::ELEMENT_ARRAY_BUFFER, buffer);
                let ty = type_enum(ix.ty);
                let offset = ix.offset as usize + d.first as usize * ix.ty.size() as usize;
                if d.instances > 1 {
                    gl_.draw_elements_instanced(
                        mode,
                        d.count as i32,
                        ty,
                        offset,
                        d.instances as i32,
                    );
                } else {
                    gl_.draw_elements(mode, d.count as i32, ty, offset);
                }
            }
            None if d.instances > 1 => {
                gl_.draw_arrays_instanced(mode, d.first as i32, d.count as i32, d.instances as i32)
            }
            None => gl_.draw_arrays(mode, d.first as i32, d.count as i32),
        }
        Ok(())
    }

    /// With `KINETOGRAPH_ANGLE_DEBUG`, reports the GL error a stage of a draw left.
    fn check(&self, stage: &str) {
        if std::env::var_os("KINETOGRAPH_ANGLE_DEBUG").is_some() {
            let e = self.gl.get_error();
            if e != 0 {
                eprintln!("angle: GL error 0x{e:x} after {stage}");
            }
        }
    }

    fn attribute(&mut self, loc: u32, a: &'a GlslAttribute) -> R<()> {
        let gl_ = self.gl;
        if let Some(v) = a.constant {
            gl_.vertex_attrib4f(loc, v[0], v[1], v[2], v[3]);
            return Ok(());
        }
        let buffer = self.buffer(&a.buffer)?;
        gl_.bind_buffer(gl::ARRAY_BUFFER, buffer);
        gl_.enable_vertex_attrib_array(loc);
        let ty = type_enum(a.ty);
        if a.integer {
            gl_.vertex_attrib_ipointer(loc, a.size as i32, ty, a.stride as i32, a.offset as usize);
        } else {
            gl_.vertex_attrib_pointer(
                loc,
                a.size as i32,
                ty,
                a.normalized,
                a.stride as i32,
                a.offset as usize,
            );
        }
        gl_.vertex_attrib_divisor(loc, a.divisor);
        Ok(())
    }
}

fn toggle(gl_: &Gl, cap: Enum, on: bool) {
    if on {
        gl_.enable(cap);
    } else {
        gl_.disable(cap);
    }
}

/// One `uniform*` call: the GL type of the uniform says how many components and which function.
fn set_uniform(gl_: &Gl, program: &Program, name: &str, call: &rec::GlslUniform) {
    let Some(&(_, ty)) = program.uniforms.get(name) else {
        return;
    };
    let location = {
        let indexed = format!("{name}[{}]", call.index);
        let direct =
            gl_.uniform_location(program.name, if call.index == 0 { name } else { &indexed });
        if direct >= 0 || call.index != 0 {
            direct
        } else {
            gl_.uniform_location(program.name, &format!("{name}[0]"))
        }
    };
    if location < 0 {
        return;
    }
    let f: Vec<f32> = call.value.iter().map(|v| *v as f32).collect();
    let i: Vec<i32> = call.value.iter().map(|v| *v as i32).collect();
    let u: Vec<u32> = call.value.iter().map(|v| *v as u32).collect();
    match ty {
        0x1406 => gl_.uniform_f(location, 1, &f),
        0x8B50 => gl_.uniform_f(location, 2, &f),
        0x8B51 => gl_.uniform_f(location, 3, &f),
        0x8B52 => gl_.uniform_f(location, 4, &f),
        0x1404 | 0x8B56 => gl_.uniform_i(location, 1, &i),
        0x8B53 | 0x8B57 => gl_.uniform_i(location, 2, &i),
        0x8B54 | 0x8B58 => gl_.uniform_i(location, 3, &i),
        0x8B55 | 0x8B59 => gl_.uniform_i(location, 4, &i),
        0x1405 => gl_.uniform_u(location, 1, &u),
        0x8DC6 => gl_.uniform_u(location, 2, &u),
        0x8DC7 => gl_.uniform_u(location, 3, &u),
        0x8DC8 => gl_.uniform_u(location, 4, &u),
        0x8B5A => gl_.uniform_matrix(location, 0, 4, &f),
        0x8B5B => gl_.uniform_matrix(location, 1, 9, &f),
        0x8B5C => gl_.uniform_matrix(location, 2, 16, &f),
        0x8B65 => gl_.uniform_matrix(location, 3, 6, &f),
        0x8B66 => gl_.uniform_matrix(location, 4, 8, &f),
        0x8B67 => gl_.uniform_matrix(location, 5, 6, &f),
        0x8B68 => gl_.uniform_matrix(location, 6, 12, &f),
        0x8B69 => gl_.uniform_matrix(location, 7, 8, &f),
        0x8B6A => gl_.uniform_matrix(location, 8, 12, &f),
        // Samplers: the texture unit.
        0x8B5E..=0x8B62 | 0x8DC1..=0x8DD7 => gl_.uniform_i(location, 1, &i),
        _ => {}
    }
}
