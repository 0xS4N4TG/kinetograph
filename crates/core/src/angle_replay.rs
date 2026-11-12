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

/// An active uniform of a linked program: where it is (of its first element), how many elements, and its GL type.
#[derive(Clone, Copy)]
struct UniformInfo {
    location: i32,
    size: i32,
    ty: Enum,
}

/// A linked program with what the draws look up in it, found once when it was linked (or the first time they are asked
/// for): its active uniforms by name (without `[0]`), its active attributes (location and GL type), the locations of
/// array elements past the first, and its uniform block indices.
struct Program {
    name: u32,
    uniforms: HashMap<String, UniformInfo>,
    attribs: HashMap<String, (i32, Enum)>,
    indexed: std::cell::RefCell<HashMap<(String, u32), i32>>,
    blocks: std::cell::RefCell<HashMap<String, Option<u32>>>,
}

/// A program belongs to the context it was linked in: a hash of the vertex source, the fragment source and the attribute
/// locations (computed once for each program a frame uses), and the context's extensions.
type ProgramKey = (u64, angle::Extensions);

/// How many programs a thread keeps for one context before the cache starts over.
const MAX_PROGRAMS: usize = 256;

thread_local! {
    /// A program that failed to compile or link is kept as its error, so it is not tried again on every frame.
    static CACHES: std::cell::RefCell<HashMap<angle::Extensions, Cache>> = std::cell::RefCell::new(HashMap::new());
    static PROGRAMS: std::cell::RefCell<HashMap<ProgramKey, R<std::rc::Rc<Program>>>> = std::cell::RefCell::new(HashMap::new());
}

/// What a context keeps from frame to frame: the buffers and the uploaded textures by what they are made from (the same key
/// the hand-written replay uses: the recording's id, the upload flags, and the stamp of the picture files), with an
/// estimate of the bytes of each, and the textures whose green and blue read red. Objects the frame makes (targets,
/// framebuffers, samplers) are not kept.
#[derive(Default)]
struct Cache {
    buffers: HashMap<String, (u32, usize)>,
    textures: HashMap<String, (Handle, usize)>,
    swizzled: std::collections::HashSet<u32>,
}

impl Cache {
    fn bytes(&self) -> usize {
        self.buffers.values().map(|b| b.1).sum::<usize>()
            + self.textures.values().map(|t| t.1).sum::<usize>()
    }
}

/// The most a context keeps (bytes, as estimated) before it starts over, and the most objects.
const MAX_CACHE_BYTES: usize = 512 << 20;
const MAX_CACHE_OBJECTS: usize = 512;

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
    ext: angle::Extensions,
    buffers: HashMap<&'a str, u32>,
    textures: HashMap<&'a str, Handle>,
    /// The targets a framebuffer draws a cube face or an array or 3D layer into, as the recorder lists them under
    /// the cube or array texture (`targets`): the target's id, to the texture's id and the face or layer.
    parts: HashMap<&'a str, (&'a str, u32)>,
    samplers: Vec<u32>,
    /// The programs of the recording this frame has looked up, by id.
    frame_programs: std::cell::RefCell<HashMap<String, R<std::rc::Rc<Program>>>>,
    /// The programs whose uniforms went back to 0 for this frame.
    zeroed: std::collections::HashSet<u32>,
    /// The generic attributes a draw gave a current value, to put back before the next draw.
    const_attrs: u32,
    /// The GL names of the textures and buffers of the context's cache this frame uses: they are not deleted with the frame.
    kept: std::collections::HashSet<u32>,
    framebuffers: Vec<u32>,
    /// The framebuffers this frame made, by the attachments they hold, so a run of draws into one set of targets binds one.
    by_attachments: HashMap<String, u32>,
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
    let draws = || {
        content.ops.iter().filter_map(|op| match op {
            GlslOp::Draw(d) => Some(d),
            _ => None,
        })
    };
    let ext = angle::Extensions {
        float_linear: draws().any(|d| d.float_linear),
        float_blend: draws().any(|d| d.float_blend),
    };
    angle::with(ext, |gl| run(gl, content, size, base_dir, ext))?
}

fn run(
    gl_: &Gl,
    content: &GlslContent,
    size: (u32, u32),
    base_dir: &Path,
    ext: angle::Extensions,
) -> R<Vec<u8>> {
    // The program cache of this context starts over when it has grown past its bound.
    PROGRAMS.with(|programs| {
        let mut programs = programs.borrow_mut();
        if programs.keys().filter(|k| k.1 == ext).count() > MAX_PROGRAMS {
            programs.retain(|key, program| {
                if key.1 != ext {
                    return true;
                }
                if let Ok(program) = program {
                    gl_.delete_program(program.name);
                }
                false
            });
        }
    });
    // The kept buffers and textures start over when they have grown past their bound.
    CACHES.with(|caches| {
        let mut caches = caches.borrow_mut();
        let Some(cache) = caches.get_mut(&ext) else {
            return;
        };
        if cache.bytes() > MAX_CACHE_BYTES
            || cache.buffers.len() + cache.textures.len() > MAX_CACHE_OBJECTS
        {
            for (name, _) in cache.buffers.values() {
                gl_.delete_buffer(*name);
            }
            let mut names: Vec<u32> = cache.textures.values().map(|(h, _)| h.name).collect();
            names.sort_unstable();
            names.dedup();
            for name in names {
                gl_.delete_texture(name);
            }
            *cache = Cache::default();
        }
    });
    gl_.pixel_storei(0xCF5, 1); // UNPACK_ALIGNMENT
    gl_.enable(0x92E0); // DEBUG_OUTPUT: the log names the rule a failed call broke
    let mut replay = Replay {
        gl: gl_,
        content,
        base_dir,
        size,
        ext,
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
        frame_programs: std::cell::RefCell::new(HashMap::new()),
        zeroed: std::collections::HashSet::new(),
        // A frame starts with every current attribute value at the default, as a context just made has them.
        const_attrs: u32::MAX,
        kept: std::collections::HashSet::new(),
        framebuffers: Vec::new(),
        by_attachments: HashMap::new(),
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
        let settings = angle::settings();
        // The clock is read only when the timing variable asks for it: a frame is a function of the recording.
        let started = settings.time.then(std::time::Instant::now);
        for (i, op) in self.content.ops.iter().enumerate() {
            let what = || match op {
                GlslOp::Clear { .. } => format!("op {i} (clear)"),
                GlslOp::Draw(d) => format!("op {i} (draw, program {})", d.program),
                GlslOp::Blit(_) => format!("op {i} (blit)"),
                GlslOp::Upload(_) => format!("op {i} (texSubImage2D)"),
            };
            match op {
                GlslOp::Clear { .. } => self.clear(op),
                GlslOp::Draw(d) => self.draw(d),
                GlslOp::Blit(b) => self.blit(b),
                GlslOp::Upload(u) => self.upload(u),
            }
            .map_err(|e| format!("{}: {e}", what()))?;
            // A call ANGLE rejects draws nothing: say so, with the op, instead of leaving a picture that is quietly wrong.
            let errors = self.drain_errors();
            if !errors.is_empty() {
                return Err(format!("{}: {errors}", what()));
            }
            // `KINETOGRAPH_ANGLE_DUMP=<op>:<path>`: the colour attachment the op wrote, as a PPM, for finding which
            // op goes wrong.
            if let Some((n, path)) = &settings.dump
                && *n == i
            {
                let fbo = match op.dest() {
                    Some(d) if d.is_framebuffer() => self.framebuffers.last().copied().unwrap_or(0),
                    _ => self.canvas.fbo,
                };
                let (w, h) = (self.size.0 as i32, self.size.1 as i32);
                gl_.bind_framebuffer(gl::READ_FRAMEBUFFER, fbo);
                gl_.read_buffer(gl::COLOR_ATTACHMENT0);
                let mut px = vec![0u8; (w * h * 4) as usize];
                gl_.read_pixels((w, h), &mut px)?;
                let mut ppm = format!("P6\n{w} {h}\n255\n").into_bytes();
                ppm.extend(px.chunks(4).flat_map(|p| [p[0], p[1], p[2]]));
                let _ = std::fs::write(path, ppm);
            }
        }
        if settings.time {
            gl_.finish();
        }
        let ops_done = started.map(|t| t.elapsed());
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
        gl_.read_pixels((w, h), &mut bottom_up)?;
        let read_done = started.map(|t| t.elapsed());
        let row = (w * 4) as usize;
        let flipped = bottom_up.chunks(row).rev().flatten().copied().collect();
        if let (Some(started), Some(ops_done), Some(read_done)) = (started, ops_done, read_done) {
            let end = started.elapsed();
            eprintln!(
                "angle-time: ops+finish {:.2} ms, resolve+readback {:.2} ms, flip {:.2} ms",
                ops_done.as_secs_f64() * 1e3,
                (read_done - ops_done).as_secs_f64() * 1e3,
                (end - read_done).as_secs_f64() * 1e3
            );
        }
        Ok(flipped)
    }

    /// Every GL error pending, as text with the messages ANGLE logged for them (empty when there is none).
    fn drain_errors(&self) -> String {
        let mut codes = Vec::new();
        loop {
            let e = self.gl.get_error();
            if e == 0 || codes.len() >= 8 {
                break;
            }
            codes.push(format!("0x{e:x}"));
        }
        if codes.is_empty() {
            return String::new();
        }
        let mut text = format!("GL error {}", codes.join(", "));
        for m in self.gl.debug_messages() {
            text.push_str(&format!("; {m}"));
        }
        text
    }

    /// An error when the framebuffer bound to `binding` cannot be drawn into or read.
    fn complete(&self, binding: Enum, what: &str) -> R<()> {
        let status = self.gl.check_framebuffer_status(binding);
        if status == gl::FRAMEBUFFER_COMPLETE {
            Ok(())
        } else {
            Err(format!(
                "{what} framebuffer is incomplete (status 0x{status:x})"
            ))
        }
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
        // A face or a layer shares its texture's name: each name once.
        let mut names: Vec<(u32, bool)> = self
            .textures
            .values()
            .map(|t| (t.name, t.renderbuffer))
            .collect();
        names.retain(|(name, renderbuffer)| *renderbuffer || !self.kept.contains(name));
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
        // The id is the recorder's name, not a promise about the bytes (another scene may reuse it): the text is hashed.
        let key = {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            b64.hash(&mut h);
            format!("{id}|{:x}", h.finish())
        };
        let ext = self.ext;
        if let Some((name, _)) = CACHES.with(|c| {
            c.borrow()
                .get(&ext)
                .and_then(|c| c.buffers.get(&key).copied())
        }) {
            self.kept.insert(name);
            self.buffers.insert(id, name);
            return Ok(name);
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("buffer {id}: {e}"))?;
        let name = self.gl.gen_buffer();
        self.gl.bind_buffer(gl::ARRAY_BUFFER, name);
        self.gl.buffer_data(gl::ARRAY_BUFFER, &bytes);
        CACHES.with(|c| {
            c.borrow_mut()
                .entry(ext)
                .or_default()
                .buffers
                .insert(key, (name, bytes.len()));
        });
        self.kept.insert(name);
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
            // A texture uploaded from the recording is kept by what it is made from; a render target is the frame's.
            let key = (!spec.target && spec.targets.is_empty() && spec.layer.is_none())
                .then(|| self.texture_key(id, spec));
            let ext = self.ext;
            let cached = key.as_ref().and_then(|k| {
                CACHES.with(|c| {
                    c.borrow()
                        .get(&ext)
                        .and_then(|c| c.textures.get(k).map(|t| t.0))
                })
            });
            match (cached, key) {
                (Some(handle), _) => {
                    self.kept.insert(handle.name);
                    handle
                }
                (None, Some(key)) => {
                    let handle = self.make_texture(spec)?;
                    let bytes = (spec.width as usize
                        * spec.height as usize
                        * (spec.depth as usize).max(1)
                        * 16)
                        .max(4);
                    CACHES.with(|c| {
                        c.borrow_mut()
                            .entry(ext)
                            .or_default()
                            .textures
                            .insert(key, (handle, bytes))
                    });
                    self.kept.insert(handle.name);
                    handle
                }
                (None, None) => self.make_texture(spec)?,
            }
        };
        self.textures.insert(id, handle);
        Ok(handle)
    }

    /// The key a kept texture goes by: its id and upload flags, and a hash of what it is made from. The id is the
    /// recorder's name for it, not a promise about its content (two scenes in one process may reuse one), so the content
    /// is hashed: the pixel or float text and `data:` sources themselves, and for a picture file its canonical path under
    /// the scene's folder and its stamp (size and modification time), so a file that changes is a new texture.
    fn texture_key(&self, id: &str, t: &GlslTexture) -> String {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        let mut source =
            |h: &mut std::collections::hash_map::DefaultHasher, src: Option<&str>| match src {
                Some(s) if s.starts_with("data:") => s.hash(h),
                Some(s) => {
                    let path = self.base_dir.join(s);
                    std::fs::canonicalize(&path).unwrap_or(path.clone()).hash(h);
                    file_stamp(&path).hash(h);
                }
                None => 0u8.hash(h),
            };
        (t.width, t.height, t.depth, t.array, t.cube, t.float32).hash(&mut h);
        t.pixels.hash(&mut h);
        t.floats.hash(&mut h);
        source(&mut h, t.src.as_deref());
        for patch in &t.patches {
            (
                patch.x,
                patch.y,
                patch.width,
                patch.height,
                patch.flip_y,
                patch.premultiply,
            )
                .hash(&mut h);
            patch.pixels.hash(&mut h);
            source(&mut h, patch.src.as_deref());
        }
        for face in &t.faces {
            (face.flip_y, face.premultiply, face.float32).hash(&mut h);
            face.pixels.hash(&mut h);
            face.floats.hash(&mut h);
            source(&mut h, face.src.as_deref());
        }
        format!(
            "{id}|{}|{}|{}|{}|{:x}",
            t.flip_y,
            t.premultiply,
            t.mipmaps,
            t.srgb,
            h.finish()
        )
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
                // One sample is asked for as 0: GL gives a request for 1 the smallest multisample count it has, which
                // is not a single-sample buffer and makes the framebuffer incomplete.
                let samples = if t.samples > 1 { t.samples as i32 } else { 0 };
                gl_.renderbuffer_storage_multisample(gl::RENDERBUFFER, samples, internal, w, h);
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
                    )?;
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
                    )?;
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
            )?;
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
            )?;
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
            )?;
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
                )?;
            }
        }
        if t.mipmaps {
            gl_.generate_mipmap(gl::TEXTURE_2D);
        }
        Ok(whole(name, gl::TEXTURE_2D, None))
    }

    fn program(&self, id: &str) -> R<std::rc::Rc<Program>> {
        if let Some(p) = self.frame_programs.borrow().get(id) {
            return p.clone();
        }
        let spec = self
            .content
            .programs
            .get(id)
            .ok_or_else(|| format!("no program {id}"))?;
        let mut attrs: Vec<(&String, &u32)> = spec.attributes.iter().collect();
        attrs.sort();
        // The sources are hashed once for the frame, not cloned and hashed for every draw.
        let key = {
            use std::hash::{Hash, Hasher};
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            (&spec.vertex, &spec.fragment, &attrs).hash(&mut hasher);
            (hasher.finish(), self.ext)
        };
        let cached = PROGRAMS.with(|p| p.borrow().get(&key).cloned());
        let built = match cached {
            Some(p) => p,
            None => {
                let attrs: Vec<(String, u32)> =
                    attrs.iter().map(|(k, v)| ((*k).clone(), **v)).collect();
                let built = self.link_program(spec, &attrs).map(std::rc::Rc::new);
                PROGRAMS.with(|p| p.borrow_mut().insert(key, built.clone()));
                built
            }
        };
        self.frame_programs
            .borrow_mut()
            .insert(id.to_string(), built.clone());
        built
    }

    /// Compiles and links a program, deleting what it made when a step fails.
    fn link_program(&self, spec: &rec::GlslProgram, attrs: &[(String, u32)]) -> R<Program> {
        let gl_ = self.gl;
        let vs = gl_
            .compile(gl::VERTEX_SHADER, &spec.vertex)
            .map_err(|e| format!("vertex shader: {e}"))?;
        let fs = match gl_.compile(gl::FRAGMENT_SHADER, &spec.fragment) {
            Ok(fs) => fs,
            Err(e) => {
                gl_.delete_shader(vs);
                return Err(format!("fragment shader: {e}"));
            }
        };
        let name = gl_.create_program();
        gl_.attach_shader(name, vs);
        gl_.attach_shader(name, fs);
        for (attr, index) in attrs {
            gl_.bind_attrib_location(name, *index, attr);
        }
        let linked = gl_.link(name);
        gl_.delete_shader(vs);
        gl_.delete_shader(fs);
        if let Err(e) = linked {
            gl_.delete_program(name);
            return Err(format!("link: {e}"));
        }
        let uniforms = gl_
            .active_uniforms(name)
            .into_iter()
            .map(|u| {
                let location = gl_.uniform_location(name, &u.name);
                (
                    u.name.strip_suffix("[0]").unwrap_or(&u.name).to_string(),
                    UniformInfo {
                        location,
                        size: u.size,
                        ty: u.ty,
                    },
                )
            })
            .collect();
        let attribs = gl_
            .active_attribs(name)
            .into_iter()
            .map(|a| (a.name, (a.location, a.ty)))
            .collect();
        Ok(Program {
            name,
            uniforms,
            attribs,
            indexed: std::cell::RefCell::new(HashMap::new()),
            blocks: std::cell::RefCell::new(HashMap::new()),
        })
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
        let key = format!("{:?}|{:?}", dest.colors(), dest.depth_stencil);
        if let Some(&fbo) = self.by_attachments.get(&key) {
            gl_.bind_framebuffer(gl::FRAMEBUFFER, fbo);
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
        self.complete(gl::FRAMEBUFFER, "the destination")?;
        self.by_attachments.insert(key, fbo);
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
        )?;
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
            let key = format!("blit|{id}|{level}|{aspect:?}");
            if let Some(&fbo) = self.by_attachments.get(&key) {
                sides[side] = fbo;
                continue;
            }
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
            self.by_attachments.insert(key, fbo);
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
        self.complete(gl::READ_FRAMEBUFFER, "the blit's read")?;
        self.complete(gl::DRAW_FRAMEBUFFER, "the blit's draw")?;
        gl_.blit_framebuffer(x0, y0, x1, y1, u0, v0, u1, v1, mask, filter);
        Ok(())
    }

    fn draw(&mut self, d: &'a GlslDraw) -> R<()> {
        let gl_ = self.gl;
        let program = self.program(&d.program)?;
        let dest = d.dest();
        self.bind_dest(&dest)?;
        gl_.use_program(program.name);
        if self.zeroed.insert(program.name) {
            zero_uniforms(gl_, &program)?;
        }

        // Vertex input.
        for i in 0..16 {
            gl_.disable_vertex_attrib_array(i);
            gl_.vertex_attrib_divisor(i, 0);
            // The current value of an attribute without an array is context state: back to the default before a draw
            // that does not set it.
            if self.const_attrs & (1 << i) != 0 {
                gl_.vertex_attrib4f(i, 0.0, 0.0, 0.0, 1.0);
            }
        }
        self.const_attrs = 0;
        for (name, a) in &d.attributes {
            // The recorder names the columns of a `mat2`, `mat3` or `mat4` attribute `name[0]`, `name[1]`, ...; GL
            // gives the matrix one name and as many consecutive locations.
            let (base, column) = match name.strip_suffix(']').and_then(|n| n.split_once('[')) {
                Some((base, i)) => (base, i.parse::<i32>().unwrap_or(0)),
                None => (name.as_str(), 0),
            };
            // An attribute the shader does not use has no location, which GL allows.
            let Some(&(loc, _)) = program.attribs.get(base) else {
                continue;
            };
            self.attribute((loc + column) as u32, a)?;
        }
        // Uniforms.
        for (name, calls) in &d.uniforms {
            for call in calls {
                set_uniform(gl_, &program, name, call)?;
            }
        }
        for (slot, (block, range)) in d.blocks.iter().enumerate() {
            let index = *program
                .blocks
                .borrow_mut()
                .entry(block.clone())
                .or_insert_with(|| gl_.uniform_block_index(program.name, block));
            let Some(index) = index else {
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
        // Textures.
        // Every texture is made before any is bound: making one binds it to the active unit, which would take the unit
        // of an earlier texture of this loop (a shadow sampler then met a colour texture).
        let mut units: Vec<(u32, &'a rec::GlslSampler, Handle)> = Vec::new();
        for (unit, s) in &d.units {
            let unit = unit.parse().map_err(|_| format!("texture unit {unit}"))?;
            units.push((unit, s, self.texture(&s.texture)?));
        }
        for (unit, s, h) in units {
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
            // The compare mode is texture state too: the draw-time check of a shadow sampler may read it from there.
            match &s.compare {
                Some(f) => {
                    gl_.tex_parameteri(
                        h.target,
                        gl::TEXTURE_COMPARE_MODE,
                        gl::COMPARE_REF_TO_TEXTURE,
                    );
                    gl_.tex_parameteri(h.target, gl::TEXTURE_COMPARE_FUNC, named(f)? as i32);
                }
                None => gl_.tex_parameteri(h.target, gl::TEXTURE_COMPARE_MODE, 0),
            }
            gl_.tex_parameteri(h.target, gl::TEXTURE_BASE_LEVEL, s.base_level as i32);
            // A WebGL 1 depth texture reads as (d, d, d, 1), a WebGL 2 one as (d, 0, 0, 1): for the first, green and blue
            // read the red channel. Set only when it is wanted or has to be undone: ANGLE's Metal backend reads a depth
            // texture differently once any swizzle is set, even the identity.
            let luminance = self
                .content
                .textures
                .get(s.texture.as_str())
                .is_some_and(|t| t.luminance);
            let was = CACHES.with(|c| {
                c.borrow()
                    .get(&self.ext)
                    .is_some_and(|c| c.swizzled.contains(&h.name))
            });
            if luminance != was {
                let (green, blue) = if luminance {
                    (gl::RED, gl::RED)
                } else {
                    (0x1904, 0x1905)
                };
                gl_.tex_parameteri(h.target, gl::TEXTURE_SWIZZLE_G, green as i32);
                gl_.tex_parameteri(h.target, gl::TEXTURE_SWIZZLE_B, blue as i32);
                CACHES.with(|c| {
                    let mut caches = c.borrow_mut();
                    let swizzled = &mut caches.entry(self.ext).or_default().swizzled;
                    if luminance {
                        swizzled.insert(h.name);
                    } else {
                        swizzled.remove(&h.name);
                    }
                });
            }
            // The texture keeps what an earlier draw set: no `maxLevel` is the GL default, 1000.
            gl_.tex_parameteri(
                h.target,
                gl::TEXTURE_MAX_LEVEL,
                s.max_level.map_or(1000, |m| m as i32),
            );
        }

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
            None => {
                gl_.disable(gl::CULL_FACE);
                // `gl_FrontFacing` follows the winding even when nothing is culled.
                gl_.front_face(if d.front_face.as_deref() == Some("CW") {
                    0x900
                } else {
                    0x901
                });
            }
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
                // The recording keeps the range only with the test on; the default is what a draw without it had.
                gl_.depth_rangef(0.0, 1.0);
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

    fn attribute(&mut self, loc: u32, a: &'a GlslAttribute) -> R<()> {
        let gl_ = self.gl;
        if let Some(v) = a.constant {
            gl_.vertex_attrib4f(loc, v[0], v[1], v[2], v[3]);
            self.const_attrs |= 1 << loc;
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
fn set_uniform(gl_: &Gl, program: &Program, name: &str, call: &rec::GlslUniform) -> R<()> {
    let Some(info) = program.uniforms.get(name) else {
        // Not active: the shader does not use it (a driver drops it), which GL allows.
        return Ok(());
    };
    let location = if call.index == 0 {
        info.location
    } else {
        *program
            .indexed
            .borrow_mut()
            .entry((name.to_string(), call.index))
            .or_insert_with(|| {
                gl_.uniform_location(program.name, &format!("{name}[{}]", call.index))
            })
    };
    if location < 0 {
        return Ok(());
    }
    write_uniform(gl_, location, info.ty, &call.value, name)
}

/// The GL uniform types (`glGetActiveUniform`), by their names in the ES 3.0 headers.
mod utype {
    use crate::angle::Enum;
    pub const FLOAT: Enum = 0x1406;
    pub const FLOAT_VEC2: Enum = 0x8B50;
    pub const FLOAT_VEC3: Enum = 0x8B51;
    pub const FLOAT_VEC4: Enum = 0x8B52;
    pub const INT: Enum = 0x1404;
    pub const INT_VEC2: Enum = 0x8B53;
    pub const INT_VEC3: Enum = 0x8B54;
    pub const INT_VEC4: Enum = 0x8B55;
    pub const BOOL: Enum = 0x8B56;
    pub const BOOL_VEC2: Enum = 0x8B57;
    pub const BOOL_VEC3: Enum = 0x8B58;
    pub const BOOL_VEC4: Enum = 0x8B59;
    pub const FLOAT_MAT2: Enum = 0x8B5A;
    pub const FLOAT_MAT3: Enum = 0x8B5B;
    pub const FLOAT_MAT4: Enum = 0x8B5C;
    pub const FLOAT_MAT2X3: Enum = 0x8B65;
    pub const FLOAT_MAT2X4: Enum = 0x8B66;
    pub const FLOAT_MAT3X2: Enum = 0x8B67;
    pub const FLOAT_MAT3X4: Enum = 0x8B68;
    pub const FLOAT_MAT4X2: Enum = 0x8B69;
    pub const FLOAT_MAT4X3: Enum = 0x8B6A;
    pub const UNSIGNED_INT: Enum = 0x1405;
    pub const UNSIGNED_INT_VEC2: Enum = 0x8DC6;
    pub const UNSIGNED_INT_VEC3: Enum = 0x8DC7;
    pub const UNSIGNED_INT_VEC4: Enum = 0x8DC8;
}

/// How a uniform of one GL type is written: the function and the numbers one element takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UniformKind {
    Float(usize),
    Int(usize),
    Uint(usize),
    /// `which` indexes `uniform_matrix` (2, 3, 4, 2x3, 2x4, 3x2, 3x4, 4x2, 4x3), `floats` is the element.
    Matrix {
        which: usize,
        floats: usize,
    },
    /// A sampler of any dimension: the texture unit, as an int.
    Sampler,
}

impl UniformKind {
    fn width(self) -> usize {
        match self {
            UniformKind::Float(n) | UniformKind::Int(n) | UniformKind::Uint(n) => n,
            UniformKind::Matrix { floats, .. } => floats,
            UniformKind::Sampler => 1,
        }
    }
}

fn uniform_kind(ty: Enum) -> Option<UniformKind> {
    use UniformKind as K;
    use utype::*;
    Some(match ty {
        FLOAT => K::Float(1),
        FLOAT_VEC2 => K::Float(2),
        FLOAT_VEC3 => K::Float(3),
        FLOAT_VEC4 => K::Float(4),
        INT | BOOL => K::Int(1),
        INT_VEC2 | BOOL_VEC2 => K::Int(2),
        INT_VEC3 | BOOL_VEC3 => K::Int(3),
        INT_VEC4 | BOOL_VEC4 => K::Int(4),
        UNSIGNED_INT => K::Uint(1),
        UNSIGNED_INT_VEC2 => K::Uint(2),
        UNSIGNED_INT_VEC3 => K::Uint(3),
        UNSIGNED_INT_VEC4 => K::Uint(4),
        FLOAT_MAT2 => K::Matrix {
            which: 0,
            floats: 4,
        },
        FLOAT_MAT3 => K::Matrix {
            which: 1,
            floats: 9,
        },
        FLOAT_MAT4 => K::Matrix {
            which: 2,
            floats: 16,
        },
        FLOAT_MAT2X3 => K::Matrix {
            which: 3,
            floats: 6,
        },
        FLOAT_MAT2X4 => K::Matrix {
            which: 4,
            floats: 8,
        },
        FLOAT_MAT3X2 => K::Matrix {
            which: 5,
            floats: 6,
        },
        FLOAT_MAT3X4 => K::Matrix {
            which: 6,
            floats: 12,
        },
        FLOAT_MAT4X2 => K::Matrix {
            which: 7,
            floats: 8,
        },
        FLOAT_MAT4X3 => K::Matrix {
            which: 8,
            floats: 12,
        },
        // SAMPLER_2D .. SAMPLER_2D_SHADOW; SAMPLER_2D_ARRAY, its shadow and SAMPLER_CUBE_SHADOW (0x8DC2 and 0x8DC3 are
        // 1D arrays, which ES has not); the int and unsigned int samplers. The unsigned int vectors (0x8DC6 to 0x8DC8)
        // sit between them and are not samplers.
        0x8B5E..=0x8B62 | 0x8DC1 | 0x8DC4 | 0x8DC5 | 0x8DC9..=0x8DD7 => K::Sampler,
        _ => return None,
    })
}

/// A program is cached across frames and pages, and its uniforms keep their values: before a frame's calls, every active
/// uniform goes back to 0 (a sampler to unit 0), as in a program that has just linked.
fn zero_uniforms(gl_: &Gl, program: &Program) -> R<()> {
    for (name, info) in &program.uniforms {
        let Some(kind) = uniform_kind(info.ty) else {
            return Err(format!(
                "unsupported: uniform {name} of GL type 0x{:x}",
                info.ty
            ));
        };
        if info.location >= 0 {
            let zeros = vec![0.0; kind.width() * info.size.max(1) as usize];
            write_uniform(gl_, info.location, info.ty, &zeros, name)?;
        }
    }
    Ok(())
}

fn write_uniform(gl_: &Gl, location: i32, ty: Enum, value: &[f64], name: &str) -> R<()> {
    let f: Vec<f32> = value.iter().map(|v| *v as f32).collect();
    let i: Vec<i32> = value.iter().map(|v| *v as i32).collect();
    let u: Vec<u32> = value.iter().map(|v| *v as u32).collect();
    match uniform_kind(ty) {
        Some(UniformKind::Float(n)) => gl_.uniform_f(location, n, &f),
        Some(UniformKind::Int(n)) => gl_.uniform_i(location, n, &i),
        Some(UniformKind::Uint(n)) => gl_.uniform_u(location, n, &u),
        Some(UniformKind::Matrix { which, floats }) => {
            gl_.uniform_matrix(location, which, floats, &f)
        }
        Some(UniformKind::Sampler) => gl_.uniform_i(location, 1, &i),
        None => return Err(format!("unsupported: uniform {name} of GL type 0x{ty:x}")),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{UniformKind as K, uniform_kind, utype::*};

    /// Every uniform type of ES 3.0 against its enum value in the headers (an unnamed one is a sampler or not a uniform).
    #[test]
    fn uniform_types_give_their_component_counts() {
        let table = [
            (FLOAT, K::Float(1)),
            (FLOAT_VEC2, K::Float(2)),
            (FLOAT_VEC3, K::Float(3)),
            (FLOAT_VEC4, K::Float(4)),
            (INT, K::Int(1)),
            (INT_VEC2, K::Int(2)),
            (INT_VEC3, K::Int(3)),
            (INT_VEC4, K::Int(4)),
            (BOOL, K::Int(1)),
            (BOOL_VEC2, K::Int(2)),
            (BOOL_VEC3, K::Int(3)),
            (BOOL_VEC4, K::Int(4)),
            (UNSIGNED_INT, K::Uint(1)),
            (UNSIGNED_INT_VEC2, K::Uint(2)),
            (UNSIGNED_INT_VEC3, K::Uint(3)),
            (UNSIGNED_INT_VEC4, K::Uint(4)),
            (
                FLOAT_MAT2,
                K::Matrix {
                    which: 0,
                    floats: 4,
                },
            ),
            (
                FLOAT_MAT3,
                K::Matrix {
                    which: 1,
                    floats: 9,
                },
            ),
            (
                FLOAT_MAT4,
                K::Matrix {
                    which: 2,
                    floats: 16,
                },
            ),
            (
                FLOAT_MAT2X3,
                K::Matrix {
                    which: 3,
                    floats: 6,
                },
            ),
            (
                FLOAT_MAT2X4,
                K::Matrix {
                    which: 4,
                    floats: 8,
                },
            ),
            (
                FLOAT_MAT3X2,
                K::Matrix {
                    which: 5,
                    floats: 6,
                },
            ),
            (
                FLOAT_MAT3X4,
                K::Matrix {
                    which: 6,
                    floats: 12,
                },
            ),
            (
                FLOAT_MAT4X2,
                K::Matrix {
                    which: 7,
                    floats: 8,
                },
            ),
            (
                FLOAT_MAT4X3,
                K::Matrix {
                    which: 8,
                    floats: 12,
                },
            ),
        ];
        for (ty, kind) in table {
            assert_eq!(uniform_kind(ty), Some(kind), "type 0x{ty:x}");
        }
        // The samplers (SAMPLER_2D, _3D, _CUBE, _2D_SHADOW, _2D_ARRAY, _2D_ARRAY_SHADOW, _CUBE_SHADOW, the int and unsigned
        // int ones) read a unit, and the unsigned int vectors between them are not samplers.
        for ty in [
            0x8B5E, 0x8B5F, 0x8B60, 0x8B62, 0x8DC1, 0x8DC4, 0x8DC5, 0x8DCA, 0x8DCB, 0x8DCC, 0x8DCF,
            0x8DD2, 0x8DD3, 0x8DD4, 0x8DD7,
        ] {
            assert_eq!(uniform_kind(ty), Some(K::Sampler), "sampler 0x{ty:x}");
        }
        assert_eq!(uniform_kind(0x8DC6).map(K::width), Some(2));
        assert_eq!(uniform_kind(0x8DC7).map(K::width), Some(3));
        assert_eq!(uniform_kind(0x8DC8).map(K::width), Some(4));
        assert_eq!(uniform_kind(0x8DC2), None);
        assert_eq!(uniform_kind(0x1400), None);
    }
}

/// The size and modification time of a file, for the key of a texture made from it; empty when it cannot be read.
fn file_stamp(path: &Path) -> String {
    std::fs::metadata(path)
        .map(|m| {
            let t = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos());
            format!("{}:{t}", m.len())
        })
        .unwrap_or_default()
}
