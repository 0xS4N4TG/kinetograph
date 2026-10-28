//! WebGL layers (`crate::glsl`, packages/cli/skills/kinetograph/references/SCENE.md, "glsl"): the draws a page
//! recorded run on the device with the page's own shaders, into an Rgba8
//! target as a browser's drawing buffer is, and `shaders/glsl_blit.wgsl` then
//! places that on the canvas.
//!
//! What a framebuffer draws in is a second kind of target
//! (`GlslTexture::target`): colour (an Rgba8 texture with its mip levels, or a
//! colour renderbuffer), or a depth, stencil or depth-and-stencil buffer. An op
//! names the targets it draws into (`GlslDest`): the colour attachment of each
//! fragment output and the depth and stencil buffer. A later draw samples a
//! colour target like any texture, and a depth one as its depth (nearest).
//! GL's rows count up from the bottom and a texture's first row is its bottom
//! one, so a program that draws into a framebuffer is translated upside down
//! (`gl::translate`'s `flip_y`) and its viewport, scissor and winding are
//! turned to match; sampling then needs nothing. A frame starts with every
//! colour target transparent black and every depth buffer at 1 (its stencil
//! at 0), and the ops run in order, one render pass for each run of draws to
//! the same attachments.
//!
//! Programs, pipelines and textures are made the first time a draw needs them
//! and kept by what they are made from, so a frame that draws what the last
//! one did builds nothing. Everything the recording says is checked before
//! the pass is recorded: wgpu reports a bad draw when the command buffer is
//! finished, which is too late to say which call it was.

use std::borrow::Cow;
use std::collections::HashSet;
use std::path::Path;

use base64::Engine as _;
use kurbo::Point;

use super::*;
mod webgpu;

use crate::glsl::{
    self as gl, BlitAspect, GlslAttribute, GlslBlend, GlslBlit, GlslContent, GlslDraw, GlslMode,
    GlslOp, GlslSampler, GlslStencilFace, GlslTexture, GlslType, Stage, TargetFormat, Translated,
};

/// The bind group layout and shader modules of one program.
struct Program {
    translated: Translated,
    vertex: wgpu::ShaderModule,
    fragment: wgpu::ShaderModule,
    layout: wgpu::BindGroupLayout,
    pipeline_layout: wgpu::PipelineLayout,
}

/// A texture on the device, with whether `generateMipmap` gave it levels and
/// whether it is a depth buffer (sampled unfiltered).
struct Uploaded {
    view: wgpu::TextureView,
    mipmapped: bool,
    depth: bool,
}

/// The format of the drawing buffer and of every colour target.
const COLOR_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// The device format of a depth or stencil target: 32-bit float depth, as the
/// drawing buffer's depth has always been, and on Apple GPUs the same with 8
/// bits of stencil (`Depth24PlusStencil8` is `Depth32FloatStencil8` there).
fn ds_format(format: TargetFormat) -> wgpu::TextureFormat {
    match format {
        TargetFormat::Depth => wgpu::TextureFormat::Depth32Float,
        TargetFormat::Stencil => wgpu::TextureFormat::Stencil8,
        TargetFormat::DepthStencil => wgpu::TextureFormat::Depth24PlusStencil8,
    }
}

/// The key of the drawing buffer's depth and stencil buffer among a replay's
/// targets (no id of the recording has a NUL).
const CANVAS_DS: &str = "\0drawing buffer depth and stencil";

/// What draws go to: the drawing buffer, a group's child as a picture, or a
/// target of the recording.
struct Target {
    /// Of level 0.
    size: (u32, u32),
    /// The device format: Rgba8 for colour (the drawing buffer is Rgba16Float
    /// for an `rgba16float` WebGPU canvas), a depth or stencil one for `ds`.
    format: wgpu::TextureFormat,
    /// What draws sample: every level, and the depth of a depth-and-stencil
    /// buffer.
    view: wgpu::TextureView,
    /// What a pass draws into, by level.
    levels: Vec<wgpu::TextureView>,
    /// What a depth or stencil target holds; `None` for colour.
    ds: Option<TargetFormat>,
    _texture: wgpu::Texture,
}

impl Target {
    /// A colour texture of one level, of `format`.
    fn colour(texture: wgpu::Texture, size: (u32, u32), format: wgpu::TextureFormat) -> Target {
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        Target {
            size,
            format,
            levels: vec![view.clone()],
            view,
            ds: None,
            _texture: texture,
        }
    }

    fn level_size(&self, level: u32) -> (u32, u32) {
        ((self.size.0 >> level).max(1), (self.size.1 >> level).max(1))
    }
}

/// The colour attachment of one fragment output: a target's id (`None` for
/// the drawing buffer) and level.
type ColorSlot<'c> = Option<(Option<&'c str>, u32)>;

/// What an op needs of a pass: its colour attachments, the depth and stencil
/// buffer it uses (a key of the targets), and the colour, depth and stencil it
/// clears them to.
type OpPass<'c> = (
    Vec<ColorSlot<'c>>,
    Option<&'c str>,
    Option<[f64; 4]>,
    Option<f32>,
    Option<u32>,
);

/// The draws of a replay that go to one set of attachments, in order, and how
/// the pass starts.
struct Pass<'c> {
    colors: Vec<ColorSlot<'c>>,
    /// For each colour attachment: cleared to this colour first, or (`None`)
    /// drawn over what it holds.
    loads: Vec<Option<[f64; 4]>>,
    /// The depth and stencil buffer attached (a key of the targets), when an
    /// op of the pass tests or clears it.
    ds: Option<&'c str>,
    depth_clear: Option<f32>,
    stencil_clear: Option<u32>,
    draws: Vec<Prepared>,
}

/// What the replay does, in order: a render pass, or pixels written into a
/// target (`texSubImage2D`).
enum Step<'c> {
    Pass(Pass<'c>),
    /// Bytes written over x, y, width, height of a target's level 0.
    Write(&'c str, [u32; 4], Vec<u8>),
    /// A texture copied over a target's level 0 at x, y: the texture, and the
    /// width and height copied.
    Copy(&'c str, wgpu::Texture, [u32; 4]),
    /// A depth target's depth as it is now, copied into the red channel of an
    /// R32Float texture for draws to sample (`glsl_depth_colour.wgsl`).
    DepthCopy(&'c str, wgpu::Texture),
}

struct Blit {
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
}

/// The passes of a depth and stencil `blitFramebuffer`, for one format.
struct DsCopy {
    depth_layout: wgpu::BindGroupLayout,
    stencil_layout: wgpu::BindGroupLayout,
    /// Writes the source's depth.
    depth: Option<wgpu::RenderPipeline>,
    /// Zeroes the stencil, then sets each bit the source has.
    zero: Option<wgpu::RenderPipeline>,
    bits: Vec<wgpu::RenderPipeline>,
}

#[derive(Default)]
pub(super) struct GlslGpu {
    programs: HashMap<String, Arc<Program>>,
    /// A program's bind group and pipeline layouts when some of its samplers
    /// read depth textures, by the program and which.
    layouts: HashMap<String, (wgpu::BindGroupLayout, wgpu::PipelineLayout)>,
    pipelines: HashMap<String, wgpu::RenderPipeline>,
    textures: HashMap<String, Arc<Uploaded>>,
    samplers: HashMap<String, wgpu::Sampler>,
    target: Option<Target>,
    blit: Option<Blit>,
    /// The pass behind `blitFramebuffer`.
    copy: Option<Blit>,
    /// The passes behind a depth and stencil `blitFramebuffer`, by format.
    ds_copies: HashMap<wgpu::TextureFormat, Arc<DsCopy>>,
    /// The passes that copy a depth texture for draws to sample: as red, and
    /// as luminance.
    depth_colour: Option<([wgpu::RenderPipeline; 2], wgpu::BindGroupLayout)>,
    /// The pass that turns a group's child into a texture, and the textures
    /// it writes, by the child's place among those a group samples.
    input: Option<Blit>,
    inputs: Vec<Option<Target>>,
    /// What a texture that is not complete samples as: opaque black.
    black: Option<Arc<Uploaded>>,
    /// The modules, layouts and pipelines of WebGPU layers.
    webgpu: webgpu::WebGpuCache,
}

/// What a group's child is called among the pictures a pass samples: the way the texture reads it is part of the name.
fn input_key(layer: &str, flip_y: bool, premultiply: bool) -> String {
    format!("{layer}\0{}{}", u8::from(flip_y), u8::from(premultiply))
}

/// The pictures of a group's children a replay reads, by `input_key`: the
/// view draws sample and the texture uploads copy.
type Inputs = HashMap<String, (wgpu::TextureView, wgpu::Texture)>;

fn render_error(what: impl std::fmt::Display) -> Error {
    Error::Render(format!("glsl: {what}"))
}

/// The most a drawing buffer can be across.
const MAX_BUFFER_SIDE: u32 = 8192;
/// How many uploaded textures are kept before the least recently made go.
const MAX_TEXTURES: usize = 64;
/// The most the target textures of one layer may hold together.
const MAX_TARGET_BYTES: u64 = 512 << 20;

impl Compositor {
    /// Runs the recording `content` into a `width` x `height` drawing buffer
    /// and places it on the canvas under `matrix` (layer space to texels of
    /// the padded canvas). `base_dir` is where a texture's `src` is read
    /// from.
    pub fn glsl(
        &mut self,
        content: &GlslContent,
        (width, height): (f64, f64),
        matrix: Affine,
        base_dir: &Path,
    ) -> Result<Tex> {
        self.glsl_group(content, (width, height), matrix, base_dir, &[])
    }

    /// `glsl`, for a group's pass: `layers` are the group's children, drawn
    /// on the canvas, by id, which the recording's `layer` textures name.
    /// They are read through `matrix`, so the box `(0, 0, width, height)` of
    /// the buffer is what they show there.
    pub fn glsl_group(
        &mut self,
        content: &GlslContent,
        (width, height): (f64, f64),
        matrix: Affine,
        base_dir: &Path,
        layers: &[(&str, &Tex)],
    ) -> Result<Tex> {
        let side = |v: f64| (v.round() as i64).clamp(0, i64::from(MAX_BUFFER_SIDE)) as u32;
        let size = (side(width), side(height));
        if size.0 == 0 || size.1 == 0 {
            return Ok(self.empty());
        }
        // A child is sampled once for each way the recording's textures read it: a texture uploaded with
        // `UNPACK_FLIP_Y_WEBGL` has its rows turned over, one with `UNPACK_PREMULTIPLY_ALPHA_WEBGL` has its
        // colour multiplied by its alpha.
        let mut inputs: Inputs = HashMap::new();
        let mut slots: HashMap<String, usize> = HashMap::new();
        let mut n = 0;
        for (id, tex) in layers {
            let mut ways: Vec<(bool, bool)> = Vec::new();
            let mut note = |layer: Option<&str>, way: (bool, bool)| {
                if layer == Some(*id) && !ways.contains(&way) {
                    ways.push(way);
                }
            };
            // A texture made from it, a picture laid over a texture, or one written into a target.
            for texture in content.textures.values() {
                note(
                    texture.layer.as_deref(),
                    (texture.flip_y, texture.premultiply),
                );
                for patch in &texture.patches {
                    note(patch.layer.as_deref(), (patch.flip_y, patch.premultiply));
                }
            }
            for op in &content.ops {
                if let GlslOp::Upload(u) = op {
                    note(u.layer.as_deref(), (u.flip_y, u.premultiply));
                }
            }
            // A WebGPU recording asks for a layer with `copyExternalImageToTexture`, and says how in the same two flags.
            if let Some(webgpu) = &content.webgpu {
                for step in &webgpu.passes {
                    if let crate::webgpu::Step::Upload(upload) = step
                        && matches!(&upload.source, crate::webgpu::Source::Layer(layer) if layer == id)
                    {
                        let way = (upload.flip_y, upload.premultiply);
                        if !ways.contains(&way) {
                            ways.push(way);
                        }
                    }
                }
            }
            for (flip, premultiply) in ways {
                let through = if flip {
                    matrix * Affine::new([1.0, 0.0, 0.0, -1.0, 0.0, f64::from(size.1)])
                } else {
                    matrix
                };
                let key = input_key(id, flip, premultiply);
                let view = self.glsl_input(n, tex, size, through, premultiply);
                let texture = self.glsl.inputs[n]
                    .as_ref()
                    .expect("made by glsl_input")
                    ._texture
                    .clone();
                inputs.insert(key.clone(), (view, texture));
                slots.insert(key, n);
                n += 1;
            }
        }
        if let Some(webgpu) = &content.webgpu {
            let textures = slots
                .iter()
                .filter_map(|(key, n)| {
                    Some((
                        key.clone(),
                        self.glsl.inputs.get(*n)?.as_ref()?._texture.clone(),
                    ))
                })
                .collect();
            self.webgpu_draw(content, webgpu, size, base_dir, &textures);
        } else {
            self.glsl_draw(content, size, base_dir, &inputs)?;
        }
        let rt = self.glsl.target.as_ref().expect("made by glsl_draw");
        let view = rt.view.clone();
        Ok(self.glsl_place(&view, (width, height), matrix, content))
    }

    /// The texture a group's child `n` is sampled as (`glsl_input.wgsl`): the
    /// child's pixels in a buffer-sized Rgba8 texture.
    fn glsl_input(
        &mut self,
        n: usize,
        tex: &Tex,
        size: (u32, u32),
        matrix: Affine,
        premultiply: bool,
    ) -> wgpu::TextureView {
        if self.glsl.input.is_none() {
            self.glsl.input = Some(self.glsl_blit(
                "glsl input",
                include_str!("../shaders/glsl_input.wgsl"),
                ("vs_input", "fs_input"),
                wgpu::TextureFormat::Rgba8Unorm,
            ));
        }
        while self.glsl.inputs.len() <= n {
            self.glsl.inputs.push(None);
        }
        if self.glsl.inputs[n].as_ref().is_none_or(|t| t.size != size) {
            let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("glsl group input"),
                size: wgpu::Extent3d {
                    width: size.0,
                    height: size.1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            });
            self.glsl.inputs[n] = Some(Target::colour(texture, size, COLOR_FORMAT));
        }
        let target = self.glsl.inputs[n].as_ref().expect("made above");
        let [a, b, c, d, e, f] = matrix.as_coeffs().map(|v| v as f32);
        let params: [f32; 16] = [
            a,
            b,
            c,
            d,
            e,
            f,
            0.0,
            0.0,
            tex.origin[0] as f32,
            tex.origin[1] as f32,
            tex.size[0] as f32,
            tex.size[1] as f32,
            if premultiply { 1.0 } else { 0.0 },
            0.0,
            0.0,
            0.0,
        ];
        let bytes: Vec<u8> = params.iter().flat_map(|v| v.to_le_bytes()).collect();
        let params_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("glsl input"),
                contents: &bytes,
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let input = self.glsl.input.as_ref().expect("made above");
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("glsl input"),
            layout: &input.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: params_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&tex.view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&input.sampler),
                },
            ],
        });
        let stamp = self.stamp("glsl input", &target.view);
        let mut encoder = self.encoder();
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("glsl input"),
            color_attachments: &[Some(clear_attachment(
                &target.view,
                wgpu::Color::TRANSPARENT,
            ))],
            timestamp_writes: pass_timer::writes(&stamp),
            ..Default::default()
        });
        pass.set_pipeline(&input.pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.draw(0..3, 0..1);
        drop(pass);
        drop(encoder);
        target.view.clone()
    }

    /// The drawing buffer, made when there is none of `size` and `format` (Rgba8 for WebGL and an 8-bit WebGPU canvas,
    /// Rgba16Float for an `rgba16float` one).
    fn drawing_buffer(&mut self, size: (u32, u32), format: wgpu::TextureFormat) {
        if self
            .glsl
            .target
            .as_ref()
            .is_none_or(|t| t.size != size || t.format != format)
        {
            let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("glsl drawing buffer"),
                size: wgpu::Extent3d {
                    width: size.0,
                    height: size.1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            self.glsl.target = Some(Target::colour(texture, size, format));
        }
    }

    /// Records the draws into the drawing buffer. `inputs` are the pictures
    /// of a group's children.
    fn glsl_draw(
        &mut self,
        content: &GlslContent,
        size: (u32, u32),
        base_dir: &Path,
        inputs: &Inputs,
    ) -> Result<()> {
        self.drawing_buffer(size, wgpu::TextureFormat::Rgba8Unorm);

        // Everything drawn to the drawing buffer before its last clear is gone
        // with it, unless a blit reads the drawing buffer in between. A
        // target's draws stay: later draws may sample them.
        // A clear of the colour alone leaves the depth and stencil buffers,
        // which the ops before it wrote and a later draw may test against; so
        // it ends them only when nothing drawn to the drawing buffer used them.
        let to_canvas = |op: &GlslOp| match op {
            GlslOp::Blit(b) => b.target.is_none(),
            GlslOp::Upload(_) => false,
            _ => op.dest().is_some_and(|d| !d.is_framebuffer()),
        };
        let wrote = |depth: bool| {
            content.ops.iter().any(|op| {
                to_canvas(op)
                    && match op {
                        GlslOp::Draw(d) => {
                            if depth {
                                d.depth.is_some()
                            } else {
                                d.stencil.is_some()
                            }
                        }
                        GlslOp::Blit(b) => b
                            .aspect
                            .is_some_and(|a| if depth { a.depth() } else { a.stencil() }),
                        _ => false,
                    }
            })
        };
        let (canvas_depth, canvas_stencil) = (wrote(true), wrote(false));
        let mut dead = vec![false; content.ops.len()];
        let mut cleared = false;
        for (i, op) in content.ops.iter().enumerate().rev() {
            let canvas = to_canvas(op);
            if canvas {
                dead[i] = cleared;
            }
            match op {
                GlslOp::Clear {
                    color,
                    depth,
                    stencil,
                    ..
                } if canvas => {
                    if color.is_some()
                        && (depth.is_some() || !canvas_depth)
                        && (stencil.is_some() || !canvas_stencil)
                    {
                        cleared = true;
                    }
                }
                // A blit that reads the drawing buffer keeps what was drawn before it.
                GlslOp::Blit(b) if b.src.is_none() && !dead[i] => cleared = false,
                _ => {}
            }
        }
        // What a target holds before its first pass.
        let blank = |target: Option<&str>| match target {
            None if !content.alpha => [0.0, 0.0, 0.0, 1.0],
            _ => [0.0; 4],
        };
        // The drawing buffer's depth and stencil buffer, as the context's attributes give it.
        let canvas_ds = match (content.depth, content.stencil) {
            (true, true) => Some(TargetFormat::DepthStencil),
            (true, false) => Some(TargetFormat::Depth),
            (false, true) => Some(TargetFormat::Stencil),
            (false, false) => None,
        };

        let mut buffers: HashMap<&str, (Vec<u8>, Option<wgpu::Buffer>)> = HashMap::new();
        let mut targets: HashMap<&str, Target> = HashMap::new();
        let mut steps: Vec<Step> = Vec::new();
        // The copies of depth targets draws sample, while what they hold is the target's.
        let mut depth_copies: HashMap<&str, wgpu::TextureView> = HashMap::new();
        let mut started: HashSet<(Option<&str>, u32)> = HashSet::new();
        for (i, op) in content.ops.iter().enumerate() {
            if dead[i] {
                continue;
            }
            if let GlslOp::Upload(u) = op {
                let t = self.glsl_target(&mut targets, content, &u.target, canvas_ds)?;
                if t.ds.is_some() {
                    return Err(render_error(
                        "a texSubImage2D writes a depth or stencil target",
                    ));
                }
                let size = t.size;
                steps.push(Self::glsl_upload(&u.target, u, size, base_dir, inputs)?);
                continue;
            }
            // The attachments of the pass the op needs, and what it clears.
            let (colors, ds, clear, depth_clear, stencil_clear): OpPass = match op {
                GlslOp::Clear {
                    color,
                    depth,
                    stencil,
                    ..
                } => {
                    let dest = op.dest().expect("a clear has a dest");
                    if dest.is_framebuffer()
                        && dest.depth_stencil.is_none()
                        && (depth.is_some() || stencil.is_some())
                    {
                        return Err(render_error(
                            "a clear of a framebuffer's depth or stencil names no depthStencil buffer",
                        ));
                    }
                    let ds_key = dest.depth_stencil.unwrap_or(CANVAS_DS);
                    (
                        if color.is_some() {
                            dest.colors()
                        } else {
                            Vec::new()
                        },
                        (depth.is_some() || stencil.is_some()).then_some(ds_key),
                        *color,
                        depth.map(|d| d.clamp(0.0, 1.0) as f32),
                        *stencil,
                    )
                }
                GlslOp::Draw(d) => {
                    let dest = d.dest();
                    let uses = d.depth.is_some() || d.stencil.is_some();
                    (
                        dest.colors(),
                        uses.then_some(dest.depth_stencil.unwrap_or(CANVAS_DS)),
                        None,
                        None,
                        None,
                    )
                }
                GlslOp::Blit(b) => match b.aspect {
                    None => (
                        vec![Some((b.target.as_deref(), b.level))],
                        None,
                        None,
                        None,
                        None,
                    ),
                    Some(_) => (
                        Vec::new(),
                        Some(b.target.as_deref().unwrap_or(CANVAS_DS)),
                        None,
                        None,
                        None,
                    ),
                },
                GlslOp::Upload(_) => unreachable!("handled above"),
            };
            if colors.iter().all(Option::is_none) && ds.is_none() {
                continue;
            }
            for (id, _) in colors.iter().flatten() {
                if let Some(id) = id {
                    self.glsl_target(&mut targets, content, id, canvas_ds)?;
                }
            }
            let ds_format = match ds {
                Some(key) => {
                    let t = self.glsl_target(&mut targets, content, key, canvas_ds)?;
                    Some(t.ds.ok_or_else(|| {
                        render_error(format!(
                            "the target {key:?} is not a depth or stencil buffer"
                        ))
                    })?)
                }
                None => None,
            };
            let is_clear = matches!(op, GlslOp::Clear { .. });
            let joins = !is_clear
                && matches!(steps.last(), Some(Step::Pass(p)) if p.colors == colors && p.ds == ds);
            // A depth texture the draw samples is copied as it is before the pass (a draw does not sample what it
            // draws in, so nothing in the pass changes it).
            if let GlslOp::Draw(draw) = op {
                for unit in draw.units.values() {
                    let id = unit.texture.as_str();
                    let Some(texture) = content
                        .textures
                        .get(id)
                        .filter(|t| t.target && t.format.is_some_and(TargetFormat::has_depth))
                    else {
                        continue;
                    };
                    if depth_copies.contains_key(id) || ds == Some(id) {
                        continue;
                    }
                    let size = self.glsl_target(&mut targets, content, id, canvas_ds)?.size;
                    let copy = self.device.create_texture(&wgpu::TextureDescriptor {
                        label: Some("glsl depth as colour"),
                        size: wgpu::Extent3d {
                            width: size.0,
                            height: size.1,
                            depth_or_array_layers: 1,
                        },
                        mip_level_count: 1,
                        sample_count: 1,
                        dimension: wgpu::TextureDimension::D2,
                        format: if texture.luminance {
                            wgpu::TextureFormat::Rgba32Float
                        } else {
                            wgpu::TextureFormat::R32Float
                        },
                        usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                            | wgpu::TextureUsages::TEXTURE_BINDING,
                        view_formats: &[],
                    });
                    depth_copies.insert(
                        id,
                        copy.create_view(&wgpu::TextureViewDescriptor::default()),
                    );
                    self.glsl_depth_colour_pipeline();
                    let at = if joins { steps.len() - 1 } else { steps.len() };
                    steps.insert(at, Step::DepthCopy(id, copy));
                }
            }
            // What an op draws in no longer holds what a copy of it does.
            if let Some(key) = ds {
                depth_copies.remove(key);
            }
            if !joins {
                let loads = colors
                    .iter()
                    .map(|slot| {
                        slot.and_then(|(id, level)| {
                            let first = started.insert((id, level));
                            clear.or_else(|| first.then(|| blank(id)))
                        })
                    })
                    .collect();
                steps.push(Step::Pass(Pass {
                    colors: colors.clone(),
                    loads,
                    ds,
                    depth_clear,
                    stencil_clear,
                    draws: Vec::new(),
                }));
            }
            let shape: Vec<bool> = colors.iter().map(Option::is_some).collect();
            let prepared = match op {
                GlslOp::Draw(draw) => self
                    .glsl_prepare(
                        content,
                        draw,
                        size,
                        (base_dir, inputs, &depth_copies),
                        &mut buffers,
                        &mut targets,
                        (&shape, ds_format),
                    )?
                    .into_iter()
                    .collect(),
                GlslOp::Blit(blit) if blit.aspect.is_none() => self
                    .glsl_copy(content, blit, size, &mut targets, canvas_ds)?
                    .into_iter()
                    .collect(),
                GlslOp::Blit(blit) => self.glsl_ds_copy(content, blit, &mut targets, canvas_ds)?,
                GlslOp::Clear { .. } | GlslOp::Upload(_) => Vec::new(),
            };
            if let Some(Step::Pass(p)) = steps.last_mut() {
                p.draws.extend(prepared);
            }
        }
        // The drawing buffer is cleared even when nothing is drawn to it.
        if started.insert((None, 0)) {
            steps.push(Step::Pass(Pass {
                colors: vec![Some((None, 0))],
                loads: vec![Some(blank(None))],
                ds: None,
                depth_clear: None,
                stencil_clear: None,
                draws: Vec::new(),
            }));
        }

        // A depth buffer starts at 1 and a stencil buffer at 0, as a browser's
        // new ones do, whether a pass or a sampler meets it first.
        for (key, t) in &targets {
            let Some(format) = t.ds else { continue };
            let stamp = self.stamp("glsl depth init", &t.levels[0]);
            let mut encoder = self.encoder();
            let pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some(if *key == CANVAS_DS {
                    "glsl depth init"
                } else {
                    "glsl target depth init"
                }),
                color_attachments: &[],
                depth_stencil_attachment: Some(ds_attachment(
                    &t.levels[0],
                    format,
                    Some(1.0),
                    Some(0),
                )),
                timestamp_writes: pass_timer::writes(&stamp),
                ..Default::default()
            });
            drop(pass);
        }

        let canvas = self.glsl.target.as_ref().expect("made above");
        for step in &steps {
            let pass = match step {
                Step::Write(id, [x, y, w, h], bytes) => {
                    // The passes before it run first: a queue write lands before whatever is
                    // submitted after it, so what is recorded is sent now.
                    self.submit();
                    self.queue.write_texture(
                        wgpu::TexelCopyTextureInfo {
                            texture: &targets[id]._texture,
                            mip_level: 0,
                            origin: wgpu::Origin3d { x: *x, y: *y, z: 0 },
                            aspect: wgpu::TextureAspect::All,
                        },
                        bytes,
                        wgpu::TexelCopyBufferLayout {
                            offset: 0,
                            bytes_per_row: Some(w * 4),
                            rows_per_image: Some(*h),
                        },
                        wgpu::Extent3d {
                            width: *w,
                            height: *h,
                            depth_or_array_layers: 1,
                        },
                    );
                    continue;
                }
                Step::Copy(id, from, [x, y, w, h]) => {
                    self.encoder().copy_texture_to_texture(
                        from.as_image_copy(),
                        wgpu::TexelCopyTextureInfo {
                            texture: &targets[id]._texture,
                            mip_level: 0,
                            origin: wgpu::Origin3d { x: *x, y: *y, z: 0 },
                            aspect: wgpu::TextureAspect::All,
                        },
                        wgpu::Extent3d {
                            width: *w,
                            height: *h,
                            depth_or_array_layers: 1,
                        },
                    );
                    continue;
                }
                Step::DepthCopy(id, copy) => {
                    self.glsl_depth_colour(&targets[id], copy);
                    continue;
                }
                Step::Pass(pass) => pass,
            };
            let view_of = |id: Option<&str>, level: u32| match id {
                None => &canvas.view,
                Some(id) => &targets[id].levels[level as usize],
            };
            let color_attachments: Vec<Option<wgpu::RenderPassColorAttachment>> = pass
                .colors
                .iter()
                .zip(&pass.loads)
                .map(|(slot, load)| {
                    slot.map(|(id, level)| wgpu::RenderPassColorAttachment {
                        view: view_of(id, level),
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: match load {
                                Some([r, g, b, a]) => wgpu::LoadOp::Clear(wgpu::Color {
                                    r: *r,
                                    g: *g,
                                    b: *b,
                                    a: *a,
                                }),
                                None => wgpu::LoadOp::Load,
                            },
                            store: wgpu::StoreOp::Store,
                        },
                    })
                })
                .collect();
            let depth_stencil_attachment = pass.ds.map(|key| {
                let t = &targets[key];
                ds_attachment(
                    &t.levels[0],
                    t.ds.expect("checked when the pass was made"),
                    pass.depth_clear,
                    pass.stencil_clear,
                )
            });
            let (name, stamp_view) = match pass.colors.iter().flatten().next() {
                Some((None, _)) => ("glsl", &canvas.view),
                Some((Some(id), level)) => ("glsl target", view_of(Some(id), *level)),
                None => (
                    "glsl depth",
                    &targets[pass.ds.expect("a pass has an attachment")].levels[0],
                ),
            };
            let stamp = self.stamp(name, stamp_view);
            let mut encoder = self.encoder();
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some(name),
                color_attachments: &color_attachments,
                depth_stencil_attachment,
                timestamp_writes: pass_timer::writes(&stamp),
                ..Default::default()
            });
            for p in &pass.draws {
                rpass.set_pipeline(&p.pipeline);
                rpass.set_bind_group(0, &p.bind_group, &[]);
                let [x, y, w, h] = p.viewport;
                rpass.set_viewport(x, y, w, h, p.depth_range.0, p.depth_range.1);
                let [sx, sy, sw, sh] = p.scissor;
                rpass.set_scissor_rect(sx, sy, sw, sh);
                rpass.set_blend_constant(p.blend_constant);
                if pass.ds.is_some() {
                    rpass.set_stencil_reference(p.stencil_reference);
                }
                for (slot, (buffer, offset)) in p.vertex_buffers.iter().enumerate() {
                    rpass.set_vertex_buffer(slot as u32, buffer.slice(*offset..));
                }
                match &p.indices {
                    Some((buffer, count)) => {
                        rpass.set_index_buffer(buffer.slice(..), wgpu::IndexFormat::Uint32);
                        rpass.draw_indexed(0..*count, 0, p.instances.0..p.instances.1);
                    }
                    None => rpass.draw(p.vertices.0..p.vertices.1, p.instances.0..p.instances.1),
                }
            }
        }
        Ok(())
    }

    /// The target `id` names (or the drawing buffer's depth and stencil
    /// buffer, `CANVAS_DS`), made the first time a pass or a sampler needs it
    /// (wgpu gives a colour one zeroes; a depth one is set to 1 before the
    /// passes). Its size is the recorded texture's, and the targets of a layer
    /// hold `MAX_TARGET_BYTES` together at most.
    fn glsl_target<'a, 'c>(
        &self,
        targets: &'a mut HashMap<&'c str, Target>,
        content: &'c GlslContent,
        id: &'c str,
        canvas_ds: Option<TargetFormat>,
    ) -> Result<&'a Target> {
        if !targets.contains_key(id) {
            let (width, height, ds, levels) = if id == CANVAS_DS {
                let format = canvas_ds.ok_or_else(|| {
                    render_error("an op uses the drawing buffer's depth or stencil buffer, which the context was made without")
                })?;
                let size = self.glsl.target.as_ref().expect("made by glsl_draw").size;
                (size.0, size.1, Some(format), 1)
            } else {
                let texture = content
                    .textures
                    .get(id)
                    .filter(|t| t.target)
                    .ok_or_else(|| {
                        render_error(format!(
                            "an op targets {id:?}, which is not a target texture of the recording"
                        ))
                    })?;
                (
                    texture.width,
                    texture.height,
                    texture.format,
                    texture.levels,
                )
            };
            let limit = self
                .device
                .limits()
                .max_texture_dimension_2d
                .min(MAX_BUFFER_SIDE);
            if width == 0 || height == 0 || width > limit || height > limit {
                return Err(render_error(format!(
                    "unsupported: a {width} x {height} render target; the sides are 1 to {limit}"
                )));
            }
            let most = width.max(height).ilog2() + 1;
            if levels == 0 || levels > most || (ds.is_some() && levels != 1) {
                return Err(render_error(format!(
                    "a {width} x {height} render target of {levels} levels; it has 1 to {most}"
                )));
            }
            let bytes = |(w, h): (u32, u32), levels: usize| {
                u64::from(w) * u64::from(h) * 4 * if levels > 1 { 2 } else { 1 }
            };
            let held: u64 = targets
                .values()
                .map(|t| bytes(t.size, t.levels.len()))
                .sum();
            if held + bytes((width, height), levels as usize) > MAX_TARGET_BYTES {
                return Err(render_error(format!(
                    "unsupported: the render targets hold more than {} MiB",
                    MAX_TARGET_BYTES >> 20
                )));
            }
            let format = ds.map_or(COLOR_FORMAT, ds_format);
            let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some(if ds.is_some() {
                    "glsl depth target"
                } else {
                    "glsl render target"
                }),
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: levels,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING
                    | if ds.is_some() {
                        wgpu::TextureUsages::empty()
                    } else {
                        wgpu::TextureUsages::COPY_DST
                    },
                view_formats: &[],
            });
            // A depth-and-stencil buffer is sampled for its depth.
            let view = texture.create_view(&wgpu::TextureViewDescriptor {
                aspect: match ds {
                    Some(TargetFormat::DepthStencil) => wgpu::TextureAspect::DepthOnly,
                    _ => wgpu::TextureAspect::All,
                },
                ..Default::default()
            });
            let level_views = (0..levels)
                .map(|level| {
                    texture.create_view(&wgpu::TextureViewDescriptor {
                        base_mip_level: level,
                        mip_level_count: Some(1),
                        ..Default::default()
                    })
                })
                .collect();
            targets.insert(
                id,
                Target {
                    size: (width, height),
                    format,
                    view,
                    levels: level_views,
                    ds,
                    _texture: texture,
                },
            );
        }
        Ok(&targets[id])
    }

    /// The size of what an op with these attachments draws into: every
    /// attachment of a pass is one size.
    fn glsl_dest_size(
        &self,
        targets: &HashMap<&str, Target>,
        colors: &[ColorSlot],
        ds: Option<&str>,
        canvas: (u32, u32),
    ) -> Result<(u32, u32)> {
        let mut sizes = colors.iter().flatten().map(|(id, level)| match id {
            None => canvas,
            Some(id) => targets[id].level_size(*level),
        });
        let ds_size = ds.map(|key| {
            if key == CANVAS_DS {
                canvas
            } else {
                targets[key].size
            }
        });
        let first = sizes
            .next()
            .or(ds_size)
            .ok_or_else(|| render_error("an op draws into nothing"))?;
        if sizes.chain(ds_size).any(|s| s != first) {
            return Err(render_error(
                "unsupported: a framebuffer whose attachments differ in size; give them one size",
            ));
        }
        Ok(first)
    }

    /// Everything one draw needs, or `None` if it draws nothing.
    /// `shape` says which outputs have a colour attachment in the pass, and
    /// `ds` what its depth and stencil buffer holds (none when the draw uses
    /// neither).
    #[allow(clippy::too_many_arguments)]
    fn glsl_prepare<'c>(
        &mut self,
        content: &'c GlslContent,
        draw: &'c GlslDraw,
        size: (u32, u32),
        (base_dir, inputs, depth_copies): (&Path, &Inputs, &HashMap<&str, wgpu::TextureView>),
        buffers: &mut HashMap<&'c str, (Vec<u8>, Option<wgpu::Buffer>)>,
        targets: &mut HashMap<&'c str, Target>,
        (shape, ds): (&[bool], Option<TargetFormat>),
    ) -> Result<Option<Prepared>> {
        let program_spec = content.programs.get(&draw.program).ok_or_else(|| {
            render_error(format!(
                "a draw names the program {:?}, which is not in the recording",
                draw.program
            ))
        })?;
        // A framebuffer is drawn upside down, so that its rows are GL's.
        let dest = draw.dest();
        let flip = dest.is_framebuffer();
        let colors = dest.colors();
        let ds_key = (draw.depth.is_some() || draw.stencil.is_some())
            .then(|| dest.depth_stencil.unwrap_or(CANVAS_DS));
        if flip && ds_key == Some(CANVAS_DS) {
            return Err(render_error(
                "a draw into a framebuffer tests depth or stencil, but names no depthStencil buffer",
            ));
        }
        let size = self.glsl_dest_size(targets, &colors, ds_key, size)?;
        let points = draw.mode == GlslMode::Points;
        let program = self.glsl_program(program_spec, flip, points)?;

        // State.
        let (viewport, scissor) = draw_rects(draw.viewport, draw.scissor, size, flip)?;
        let (vw, vh) = (viewport[2], viewport[3]);
        check_vertex_range(draw.first, draw.count)?;
        if vw == 0.0
            || vh == 0.0
            || scissor[2] == 0
            || scissor[3] == 0
            || draw.count == 0
            || draw.instances == 0
        {
            return Ok(None);
        }

        // Vertex data.
        let vertex = &program.translated.vertex;
        // Location, format, stride, the attribute's offset in the vertex and
        // how often it advances: a point is an instance of six vertices, so
        // its attributes advance for each instance.
        let step = if points {
            wgpu::VertexStepMode::Instance
        } else {
            wgpu::VertexStepMode::Vertex
        };
        let mut layouts: Vec<(u32, wgpu::VertexFormat, u64, u64, wgpu::VertexStepMode)> =
            Vec::new();
        let mut sources: Vec<(&str, u64, u64)> = Vec::new();
        // Buffer, stride, offset and element size of each, for gathering.
        let mut shapes: Vec<(&str, u64, u64, u64)> = Vec::new();
        let last = match &draw.indices {
            Some(indices) => {
                let max = self.glsl_max_index(content, indices, draw, buffers)?;
                u64::from(max) + 1
            }
            None => u64::from(draw.first) + u64::from(draw.count),
        };
        for (name, location, components) in &vertex.attributes {
            let a = draw.attributes.get(name).ok_or_else(|| {
                render_error(format!(
                    "unsupported: the attribute `{name}` has no data: it is read as a constant by \
                     WebGL, and only attributes with a buffer are drawn"
                ))
            })?;
            if a.divisor > 1 {
                return Err(render_error(format!(
                    "unsupported: vertexAttribDivisor({}) of the attribute `{name}`; 0 and 1 are \
                     drawn",
                    a.divisor
                )));
            }
            // An attribute with a divisor advances for each instance; a
            // point's attributes all do, as it is an instance itself.
            let per_instance = a.divisor == 1 && !points;
            let (format, element) = vertex_format(a, name, *components)?;
            let stride = if a.stride == 0 {
                element
            } else {
                u64::from(a.stride)
            };
            if stride % 4 != 0 || a.offset % 4 != 0 {
                return Err(render_error(format!(
                    "unsupported: the attribute `{name}` has a stride of {stride} bytes and an \
                     offset of {}; both must be multiples of 4",
                    a.offset
                )));
            }
            if element > stride {
                return Err(render_error(format!(
                    "the attribute `{name}` is wider than its stride"
                )));
            }
            let bytes = glsl_buffer(content, &a.buffer, buffers)?.len() as u64;
            let reads = if per_instance {
                u64::from(draw.instances)
            } else {
                last
            };
            let needs = u64::from(a.offset) + (reads - 1) * stride + element;
            if needs > bytes {
                return Err(render_error(format!(
                    "the draw reads {needs} bytes of the attribute `{name}`'s buffer, which holds {bytes} \
                     (WebGL refuses such a draw with INVALID_OPERATION)"
                )));
            }
            // The buffer is bound whole, with the offset in the attribute: wgpu
            // bounds every vertex by a whole stride from the binding's start,
            // so a binding moved by the offset would lose its last vertex.
            // Only an offset that does not fit in the stride moves the binding.
            let offset = u64::from(a.offset);
            let (in_vertex, bound_at) = if offset + element <= stride {
                (offset, 0)
            } else {
                (0, offset)
            };
            let step = if per_instance {
                wgpu::VertexStepMode::Instance
            } else {
                step
            };
            layouts.push((*location, format, stride, in_vertex, step));
            sources.push((&a.buffer, bound_at, stride));
            shapes.push((&a.buffer, stride, offset, element));
        }

        // The index list, expanded to triangles when the mode needs it.
        let mut index_list: Option<Vec<u32>> = None;
        if let Some(indices) = &draw.indices {
            let bytes = glsl_buffer(content, &indices.buffer, buffers)?;
            let list = read_indices(bytes, indices.ty, indices.offset, draw.count)?;
            index_list = Some(list);
        }
        // Points from an index list: each attribute is gathered in the order
        // of the list, one element for each point.
        let mut instances = (draw.first, draw.first + draw.count);
        let mut gathered: Vec<Option<Vec<u8>>> = vec![None; sources.len()];
        if points && let Some(list) = index_list.take() {
            for (k, (buffer, stride, offset, element)) in shapes.iter().enumerate() {
                let bytes = glsl_buffer(content, buffer, buffers)?;
                let mut out = Vec::with_capacity(list.len() * *element as usize);
                for index in &list {
                    let at = (offset + u64::from(*index) * stride) as usize;
                    out.extend_from_slice(&bytes[at..at + *element as usize]);
                }
                gathered[k] = Some(out);
                layouts[k].2 = *element;
                layouts[k].3 = 0;
                sources[k].1 = 0;
            }
            instances = (0, list.len() as u32);
        }
        if draw.mode == GlslMode::TriangleFan {
            let list = index_list
                .take()
                .unwrap_or_else(|| (draw.first..draw.first + draw.count).collect());
            let mut fan = Vec::new();
            for i in 1..list.len().saturating_sub(1) {
                fan.extend([list[0], list[i], list[i + 1]]);
            }
            index_list = Some(fan);
        }
        let topology = match draw.mode {
            GlslMode::Points | GlslMode::Triangles | GlslMode::TriangleFan => {
                wgpu::PrimitiveTopology::TriangleList
            }
            GlslMode::TriangleStrip => wgpu::PrimitiveTopology::TriangleStrip,
        };

        // Uniform blocks.
        let fbh = size.1 as f32;
        let vs_bytes =
            gl::uniform_bytes(vertex, &draw.uniforms, fbh, (vw, vh)).map_err(render_error)?;
        let fragment = &program.translated.fragment;
        let fs_bytes =
            gl::uniform_bytes(fragment, &draw.uniforms, fbh, (vw, vh)).map_err(render_error)?;

        // The textures the fragment shader samples, and which of them are depth buffers.
        let mut sampled = Vec::new();
        for binding in &program.translated.fragment.samplers {
            let unit = draw
                .uniforms
                .get(&binding.name)
                .and_then(|calls| calls.last())
                .and_then(|call| call.value.first())
                .map_or(0, |v| *v as i64);
            let texture = match draw.units.get(&unit.to_string()) {
                Some(state) => {
                    let texture = content.textures.get(&state.texture).ok_or_else(|| {
                        render_error(format!(
                            "the texture {:?} is not in the recording",
                            state.texture
                        ))
                    })?;
                    let uploaded = if texture.layer.is_some()
                        || texture.patches.iter().any(|p| p.layer.is_some())
                    {
                        self.glsl_composed(&state.texture, texture, base_dir, inputs)?
                    } else if texture.target {
                        let drawn_into = colors
                            .iter()
                            .flatten()
                            .any(|(id, _)| *id == Some(state.texture.as_str()))
                            || dest.depth_stencil == Some(state.texture.as_str());
                        if drawn_into {
                            return Err(render_error(format!(
                                "a draw samples the texture {:?} it renders to (WebGL refuses such a \
                                 draw with INVALID_OPERATION)",
                                state.texture
                            )));
                        }
                        let target = self.glsl_target(targets, content, &state.texture, None)?;
                        let view = match target.ds {
                            Some(_) => depth_copies
                                .get(state.texture.as_str())
                                .ok_or_else(|| {
                                    render_error(format!(
                                        "the texture {:?} is a stencil buffer, which no draw samples",
                                        state.texture
                                    ))
                                })?
                                .clone(),
                            None => target.view.clone(),
                        };
                        // Its levels are complete when they reach 1 x 1, or reach TEXTURE_MAX_LEVEL.
                        let levels = target.levels.len() as u32;
                        let full = target.size.0.max(target.size.1).ilog2() + 1;
                        Arc::new(Uploaded {
                            view,
                            mipmapped: levels > 1
                                && (levels == full || state.max_level.is_some_and(|m| m < levels)),
                            depth: target.ds.is_some(),
                        })
                    } else {
                        self.glsl_texture(&state.texture, texture, base_dir)?
                    };
                    Some((state, uploaded))
                }
                None => None,
            };
            sampled.push((binding.clone(), texture));
        }
        let depths: Vec<bool> = sampled
            .iter()
            .map(|(_, t)| t.as_ref().is_some_and(|(_, u)| u.depth))
            .collect();

        // Pipeline.
        let key = format!(
            "{:p}|{layouts:?}|{topology:?}|{}|{:?}|{:?}|{:?}|{:?}|{:?}|{shape:?}|{ds:?}|{:?}|{depths:?}",
            Arc::as_ptr(&program),
            index_list.is_some() && topology == wgpu::PrimitiveTopology::TriangleStrip,
            draw.blend.as_ref().map(blend_key),
            draw.color_mask,
            draw.cull,
            draw.depth.as_ref().map(|d| (&d.func, d.mask)),
            draw.polygon_offset
                .map(|o| (o.factor.to_bits(), o.units.to_bits())),
            draw.stencil
                .as_ref()
                .map(|s| (s.value_mask, s.write_mask, &s.front, &s.back)),
        );
        let (bind_group_layout, pipeline_layout) = self.glsl_layout(&program, &depths);
        let pipeline = match self.glsl.pipelines.get(&key) {
            Some(p) => p.clone(),
            None => {
                let p = self.glsl_pipeline(
                    &program,
                    &pipeline_layout,
                    &layouts,
                    (topology, index_list.is_some()),
                    draw,
                    (shape, ds),
                )?;
                self.glsl.pipelines.insert(key, p.clone());
                p
            }
        };

        // Bind group.
        let vs_buffer = (vertex.uniform_size > 0).then(|| {
            self.device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("glsl vertex uniforms"),
                    contents: &vs_bytes,
                    usage: wgpu::BufferUsages::UNIFORM,
                })
        });
        let fs_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("glsl fragment uniforms"),
                contents: &fs_bytes,
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let mut sampler_views = Vec::new();
        for (binding, texture) in sampled {
            let (view, sampler) = match texture {
                Some((state, uploaded)) => self.glsl_sampler(state, uploaded),
                None => {
                    let black = self.glsl_black();
                    let nearest = GlslSampler {
                        texture: String::new(),
                        min: "NEAREST".into(),
                        mag: "NEAREST".into(),
                        wrap_s: "CLAMP_TO_EDGE".into(),
                        wrap_t: "CLAMP_TO_EDGE".into(),
                        max_level: None,
                    };
                    (black.view.clone(), self.glsl_sampler_for(&nearest, false))
                }
            };
            sampler_views.push((binding.texture, view, binding.sampler, sampler));
        }
        let mut entries: Vec<wgpu::BindGroupEntry> = Vec::new();
        if let Some(b) = &vs_buffer {
            entries.push(wgpu::BindGroupEntry {
                binding: 0,
                resource: b.as_entire_binding(),
            });
        }
        entries.push(wgpu::BindGroupEntry {
            binding: 1,
            resource: fs_buffer.as_entire_binding(),
        });
        for (tb, view, sb, sampler) in &sampler_views {
            entries.push(wgpu::BindGroupEntry {
                binding: *tb,
                resource: wgpu::BindingResource::TextureView(view),
            });
            entries.push(wgpu::BindGroupEntry {
                binding: *sb,
                resource: wgpu::BindingResource::Sampler(sampler),
            });
        }
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("glsl"),
            layout: &bind_group_layout,
            entries: &entries,
        });

        // Vertex buffers: the recorded bytes, bound at each attribute's offset.
        let mut vertex_buffers = Vec::new();
        for ((buffer, offset, _), gathered) in sources.into_iter().zip(gathered) {
            if let Some(bytes) = gathered {
                let gpu = self
                    .device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("glsl gathered vertices"),
                        contents: &bytes,
                        usage: wgpu::BufferUsages::VERTEX,
                    });
                vertex_buffers.push((gpu, 0));
                continue;
            }
            let entry = buffers.get_mut(buffer).expect("read above");
            let gpu = entry.1.get_or_insert_with(|| {
                self.device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("glsl vertices"),
                        contents: &entry.0,
                        usage: wgpu::BufferUsages::VERTEX,
                    })
            });
            vertex_buffers.push((gpu.clone(), offset));
        }
        let indices = index_list.map(|list| {
            let count = list.len() as u32;
            let bytes: Vec<u8> = list.iter().flat_map(|i| i.to_le_bytes()).collect();
            let buffer = self
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("glsl indices"),
                    contents: &bytes,
                    usage: wgpu::BufferUsages::INDEX,
                });
            (buffer, count)
        });
        let blend_constant =
            draw.blend
                .as_ref()
                .map_or(wgpu::Color::TRANSPARENT, |b| wgpu::Color {
                    r: b.color[0],
                    g: b.color[1],
                    b: b.color[2],
                    a: b.color[3],
                });
        Ok(Some(Prepared {
            pipeline,
            bind_group,
            viewport,
            scissor,
            blend_constant,
            stencil_reference: draw.stencil.as_ref().map_or(0, |s| s.r#ref),
            depth_range: draw
                .depth
                .as_ref()
                .map_or((0.0, 1.0), |d| (d.near as f32, d.far as f32)),
            vertex_buffers,
            indices,
            // A point is a quad of six vertices.
            vertices: if points {
                (0, 6)
            } else {
                (draw.first, draw.first + draw.count)
            },
            instances: if points {
                instances
            } else {
                (0, draw.instances)
            },
        }))
    }

    /// The largest index a `drawElements` reads, to check the vertex data
    /// holds that many.
    fn glsl_max_index<'c>(
        &mut self,
        content: &'c GlslContent,
        indices: &'c gl::GlslIndices,
        draw: &GlslDraw,
        buffers: &mut HashMap<&'c str, (Vec<u8>, Option<wgpu::Buffer>)>,
    ) -> Result<u32> {
        let bytes = glsl_buffer(content, &indices.buffer, buffers)?;
        let list = read_indices(bytes, indices.ty, indices.offset, draw.count)?;
        Ok(list.into_iter().max().unwrap_or(0))
    }

    /// The program, translated and compiled the first time it is drawn.
    fn glsl_program(
        &mut self,
        spec: &gl::GlslProgram,
        flip_y: bool,
        points: bool,
    ) -> Result<Arc<Program>> {
        let key = format!(
            "{}\u{0}{}\u{0}{:?}\u{0}{flip_y}\u{0}{points}",
            spec.vertex, spec.fragment, spec.attributes
        );
        if let Some(p) = self.glsl.programs.get(&key) {
            return Ok(p.clone());
        }
        let translated = gl::translate(spec, flip_y, points).map_err(render_error)?;
        if !translated.vertex.samplers.is_empty() {
            return Err(render_error(
                "unsupported: a texture read in the vertex shader (vertex texture fetch)",
            ));
        }
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let module = |stage: &Stage, label| {
            self.device
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some(label),
                    source: wgpu::ShaderSource::Naga(Cow::Owned(stage.module.clone())),
                })
        };
        let vertex = module(&translated.vertex, "glsl vertex");
        let fragment = module(&translated.fragment, "glsl fragment");
        let mut entries = Vec::new();
        if translated.vertex.uniform_size > 0 {
            entries.push(uniform_entry(0, wgpu::ShaderStages::VERTEX));
        }
        entries.push(uniform_entry(1, wgpu::ShaderStages::FRAGMENT));
        for s in &translated.fragment.samplers {
            entries.push(wgpu::BindGroupLayoutEntry {
                binding: s.texture,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            });
            entries.push(wgpu::BindGroupLayoutEntry {
                binding: s.sampler,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            });
        }
        let layout = self
            .device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("glsl"),
                entries: &entries,
            });
        let pipeline_layout = self
            .device
            .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("glsl"),
                bind_group_layouts: &[Some(&layout)],
                immediate_size: 0,
            });
        if let Some(e) = pollster::block_on(scope.pop()) {
            return Err(render_error(format!("the shaders were not accepted: {e}")));
        }
        let program = Arc::new(Program {
            translated,
            vertex,
            fragment,
            layout,
            pipeline_layout,
        });
        self.glsl.programs.insert(key, program.clone());
        Ok(program)
    }

    /// The bind group and pipeline layouts of `program` when the samplers
    /// marked in `depths` read depth buffers: those take an unfilterable
    /// texture and a non-filtering sampler.
    fn glsl_layout(
        &mut self,
        program: &Arc<Program>,
        depths: &[bool],
    ) -> (wgpu::BindGroupLayout, wgpu::PipelineLayout) {
        if !depths.contains(&true) {
            return (program.layout.clone(), program.pipeline_layout.clone());
        }
        let key = format!("{:p}|{depths:?}", Arc::as_ptr(program));
        if let Some(l) = self.glsl.layouts.get(&key) {
            return l.clone();
        }
        let mut entries = Vec::new();
        if program.translated.vertex.uniform_size > 0 {
            entries.push(uniform_entry(0, wgpu::ShaderStages::VERTEX));
        }
        entries.push(uniform_entry(1, wgpu::ShaderStages::FRAGMENT));
        for (s, depth) in program.translated.fragment.samplers.iter().zip(depths) {
            entries.push(wgpu::BindGroupLayoutEntry {
                binding: s.texture,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: !depth },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            });
            entries.push(wgpu::BindGroupLayoutEntry {
                binding: s.sampler,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(if *depth {
                    wgpu::SamplerBindingType::NonFiltering
                } else {
                    wgpu::SamplerBindingType::Filtering
                }),
                count: None,
            });
        }
        let layout = self
            .device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("glsl depth sampling"),
                entries: &entries,
            });
        let pipeline_layout = self
            .device
            .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("glsl depth sampling"),
                bind_group_layouts: &[Some(&layout)],
                immediate_size: 0,
            });
        self.glsl
            .layouts
            .insert(key, (layout.clone(), pipeline_layout.clone()));
        (layout, pipeline_layout)
    }

    /// The pipeline of a draw into a pass whose outputs have a colour
    /// attachment where `shape` says, with a depth and stencil buffer that
    /// holds `ds` (none when the draw uses neither).
    fn glsl_pipeline(
        &self,
        program: &Program,
        pipeline_layout: &wgpu::PipelineLayout,
        layouts: &[(u32, wgpu::VertexFormat, u64, u64, wgpu::VertexStepMode)],
        (topology, indexed): (wgpu::PrimitiveTopology, bool),
        draw: &GlslDraw,
        (shape, ds): (&[bool], Option<TargetFormat>),
    ) -> Result<wgpu::RenderPipeline> {
        let attributes: Vec<[wgpu::VertexAttribute; 1]> = layouts
            .iter()
            .map(|(location, format, _, offset, _)| {
                [wgpu::VertexAttribute {
                    format: *format,
                    offset: *offset,
                    shader_location: *location,
                }]
            })
            .collect();
        let buffers: Vec<Option<wgpu::VertexBufferLayout>> = layouts
            .iter()
            .zip(&attributes)
            .map(|((_, _, stride, _, step_mode), attribute)| {
                Some(wgpu::VertexBufferLayout {
                    array_stride: *stride,
                    step_mode: *step_mode,
                    attributes: attribute,
                })
            })
            .collect();
        // Culling is for polygons: a point is not culled.
        let cull_mode = match draw.cull.as_ref().filter(|_| draw.mode != GlslMode::Points) {
            None => None,
            Some(c) => match c.face.as_str() {
                "FRONT" => Some(wgpu::Face::Front),
                "BACK" => Some(wgpu::Face::Back),
                other => {
                    return Err(render_error(format!(
                        "unsupported: cullFace({other}); culling both faces draws nothing"
                    )));
                }
            },
        };
        // A framebuffer is drawn upside down, which turns a winding around.
        let clockwise = draw.cull.as_ref().is_some_and(|c| c.front == "CW");
        let front_face = if clockwise != draw.dest().is_framebuffer() {
            wgpu::FrontFace::Cw
        } else {
            wgpu::FrontFace::Ccw
        };
        let mut mask = wgpu::ColorWrites::empty();
        for (on, bit) in draw.color_mask.iter().zip([
            wgpu::ColorWrites::RED,
            wgpu::ColorWrites::GREEN,
            wgpu::ColorWrites::BLUE,
            wgpu::ColorWrites::ALPHA,
        ]) {
            if *on {
                mask |= bit;
            }
        }
        let blend = draw.blend.as_ref().map(blend_state).transpose()?;
        let depth_stencil = ds
            .map(|format| -> Result<wgpu::DepthStencilState> {
                // Without the test the buffer is neither tested nor written.
                let depth = draw.depth.as_ref().filter(|_| format.has_depth());
                let (write, compare) = match depth {
                    Some(d) => (d.mask, compare_function(&d.func)?),
                    None => (false, wgpu::CompareFunction::Always),
                };
                // `polygonOffset(factor, units)` is `factor * slope + units * r`:
                // the slope scale and the constant bias of the pipeline.
                let (constant, slope_scale) = draw
                    .polygon_offset
                    .filter(|_| depth.is_some())
                    .map_or((0, 0.0), |o| (o.units as i32, o.factor as f32));
                let stencil = match draw.stencil.as_ref().filter(|_| format.has_stencil()) {
                    Some(s) => wgpu::StencilState {
                        front: stencil_face(&s.front)?,
                        back: stencil_face(&s.back)?,
                        read_mask: s.value_mask,
                        write_mask: s.write_mask,
                    },
                    None => wgpu::StencilState::default(),
                };
                Ok(wgpu::DepthStencilState {
                    format: ds_format(format),
                    depth_write_enabled: format.has_depth().then_some(write),
                    depth_compare: format.has_depth().then_some(compare),
                    stencil,
                    bias: wgpu::DepthBiasState {
                        constant,
                        slope_scale,
                        clamp: 0.0,
                    },
                })
            })
            .transpose()?;
        // Each output with an attachment; one the shader does not write is left alone.
        let outputs = &program.translated.fragment.outputs;
        let targets: Vec<Option<wgpu::ColorTargetState>> = shape
            .iter()
            .enumerate()
            .map(|(i, on)| {
                on.then(|| wgpu::ColorTargetState {
                    format: COLOR_FORMAT,
                    blend,
                    write_mask: if outputs.contains(&(i as u32)) {
                        mask
                    } else {
                        wgpu::ColorWrites::empty()
                    },
                })
            })
            .collect();
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let pipeline = self
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("glsl"),
                layout: Some(pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &program.vertex,
                    entry_point: Some("main"),
                    compilation_options: Default::default(),
                    buffers: &buffers,
                },
                fragment: Some(wgpu::FragmentState {
                    module: &program.fragment,
                    entry_point: Some("main"),
                    compilation_options: Default::default(),
                    targets: &targets,
                }),
                primitive: wgpu::PrimitiveState {
                    topology,
                    strip_index_format: (indexed
                        && topology == wgpu::PrimitiveTopology::TriangleStrip)
                        .then_some(wgpu::IndexFormat::Uint32),
                    front_face,
                    cull_mode,
                    ..Default::default()
                },
                depth_stencil,
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            });
        if let Some(e) = pollster::block_on(scope.pop()) {
            return Err(render_error(format!("the program cannot be drawn: {e}")));
        }
        Ok(pipeline)
    }

    /// The texture, uploaded the first time and kept by what it is made from.
    fn glsl_texture(
        &mut self,
        id: &str,
        texture: &GlslTexture,
        base_dir: &Path,
    ) -> Result<Arc<Uploaded>> {
        // An edited file is read again, also one a patch laid over the texture.
        let stamp_of = |src: Option<&str>| {
            src.filter(|s| !s.starts_with("data:"))
                .map(|s| file_stamp(&base_dir.join(s)))
                .unwrap_or_default()
        };
        let mut stamp = stamp_of(texture.src.as_deref());
        for patch in &texture.patches {
            stamp.push('|');
            stamp.push_str(&stamp_of(patch.src.as_deref()));
        }
        let key = format!(
            "{id}|{}|{}|{}|{stamp}",
            texture.flip_y, texture.premultiply, texture.mipmaps
        );
        if let Some(t) = self.glsl.textures.get(&key) {
            return Ok(t.clone());
        }
        let (mut rgba, width, height) =
            gl::decode_texture(texture, base_dir).map_err(render_error)?;
        gl::unpack(&mut rgba, width, texture.flip_y, texture.premultiply);
        // `texSubImage2D` of pictures over it, in order.
        for patch in &texture.patches {
            let (mut part, w, h) = gl::decode_picture(
                patch.src.as_deref(),
                patch.pixels.as_deref(),
                (patch.width, patch.height),
                base_dir,
            )
            .map_err(render_error)?;
            if (w, h) != (patch.width, patch.height)
                || patch.x.checked_add(w).is_none_or(|r| r > width)
                || patch.y.checked_add(h).is_none_or(|b| b > height)
            {
                return Err(render_error(format!(
                    "a texSubImage2D of {w} x {h} at ({}, {}) does not fit the {width} x {height} texture",
                    patch.x, patch.y
                )));
            }
            gl::unpack(&mut part, w, patch.flip_y, patch.premultiply);
            for row in 0..h as usize {
                let at = ((patch.y as usize + row) * width as usize + patch.x as usize) * 4;
                rgba[at..at + w as usize * 4]
                    .copy_from_slice(&part[row * w as usize * 4..(row + 1) * w as usize * 4]);
            }
        }
        let limit = self.device.limits().max_texture_dimension_2d;
        if width > limit || height > limit {
            return Err(render_error(format!(
                "unsupported: a {width} x {height} texture; the device holds {limit} across"
            )));
        }
        let levels = if texture.mipmaps {
            width.max(height).ilog2() + 1
        } else {
            1
        };
        let gpu = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("glsl texture"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: levels,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: COLOR_FORMAT,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let (mut w, mut h, mut level) = (width, height, rgba);
        for mip in 0..levels {
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &gpu,
                    mip_level: mip,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                &level,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(w * 4),
                    rows_per_image: Some(h),
                },
                wgpu::Extent3d {
                    width: w,
                    height: h,
                    depth_or_array_layers: 1,
                },
            );
            if mip + 1 < levels {
                (level, w, h) = gl::next_level(&level, w, h);
            }
        }
        if self.glsl.textures.len() >= MAX_TEXTURES {
            self.glsl.textures.clear();
        }
        let uploaded = Arc::new(Uploaded {
            view: gpu.create_view(&wgpu::TextureViewDescriptor::default()),
            mipmapped: levels > 1,
            depth: false,
        });
        self.glsl.textures.insert(key, uploaded.clone());
        Ok(uploaded)
    }

    /// A texture with a group's child in it: the child's picture itself, or
    /// (with patches) a texture made for this frame, the picture and the
    /// patches copied into it in order.
    fn glsl_composed(
        &mut self,
        id: &str,
        texture: &GlslTexture,
        base_dir: &Path,
        inputs: &Inputs,
    ) -> Result<Arc<Uploaded>> {
        let input = |layer: &str, flip_y: bool, premultiply: bool| {
            inputs
                .get(&input_key(layer, flip_y, premultiply))
                .ok_or_else(|| {
                    render_error(format!(
                        "the texture {id:?} reads the layer {layer:?}, which was not drawn"
                    ))
                })
        };
        if texture.patches.is_empty()
            && let Some(layer) = &texture.layer
        {
            return Ok(Arc::new(Uploaded {
                view: input(layer, texture.flip_y, texture.premultiply)?.0.clone(),
                mipmapped: false,
                depth: false,
            }));
        }
        if texture.mipmaps {
            return Err(render_error(
                "unsupported: generateMipmap of a texture with a layer's picture in it",
            ));
        }
        // Each part as a texture to copy from: a child's picture, or pixels put on the device.
        let part = |this: &Self,
                    layer: Option<&str>,
                    src: Option<&str>,
                    pixels: Option<&str>,
                    (flip_y, premultiply): (bool, bool),
                    size: (u32, u32)|
         -> Result<wgpu::Texture> {
            if let Some(layer) = layer {
                return Ok(input(layer, flip_y, premultiply)?.1.clone());
            }
            let (mut rgba, w, h) =
                gl::decode_picture(src, pixels, size, base_dir).map_err(render_error)?;
            gl::unpack(&mut rgba, w, flip_y, premultiply);
            Ok(this.device.create_texture_with_data(
                &this.queue,
                &wgpu::TextureDescriptor {
                    label: Some("glsl texture part"),
                    size: wgpu::Extent3d {
                        width: w,
                        height: h,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: COLOR_FORMAT,
                    usage: wgpu::TextureUsages::COPY_SRC,
                    view_formats: &[],
                },
                wgpu::util::TextureDataOrder::LayerMajor,
                &rgba,
            ))
        };
        let base = part(
            self,
            texture.layer.as_deref(),
            texture.src.as_deref(),
            texture.pixels.as_deref(),
            (texture.flip_y, texture.premultiply),
            (texture.width, texture.height),
        )?;
        let (width, height) = (base.width(), base.height());
        let gpu = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("glsl composed texture"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: COLOR_FORMAT,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let mut parts = vec![(base, 0, 0)];
        for p in &texture.patches {
            let t = part(
                self,
                p.layer.as_deref(),
                p.src.as_deref(),
                p.pixels.as_deref(),
                (p.flip_y, p.premultiply),
                (p.width, p.height),
            )?;
            parts.push((t, p.x, p.y));
        }
        let mut encoder = self.encoder();
        for (t, x, y) in &parts {
            // What fits: a child's picture is the drawing buffer's size.
            let w = t.width().min(width.saturating_sub(*x));
            let h = t.height().min(height.saturating_sub(*y));
            if w == 0 || h == 0 {
                continue;
            }
            encoder.copy_texture_to_texture(
                t.as_image_copy(),
                wgpu::TexelCopyTextureInfo {
                    texture: &gpu,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x: *x, y: *y, z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::Extent3d {
                    width: w,
                    height: h,
                    depth_or_array_layers: 1,
                },
            );
        }
        drop(encoder);
        Ok(Arc::new(Uploaded {
            view: gpu.create_view(&wgpu::TextureViewDescriptor::default()),
            mipmapped: false,
            depth: false,
        }))
    }

    fn glsl_black(&mut self) -> Arc<Uploaded> {
        if let Some(b) = &self.glsl.black {
            return b.clone();
        }
        let texture = self.device.create_texture_with_data(
            &self.queue,
            &wgpu::TextureDescriptor {
                label: Some("glsl incomplete texture"),
                size: wgpu::Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            &[0, 0, 0, 255],
        );
        let black = Arc::new(Uploaded {
            view: texture.create_view(&wgpu::TextureViewDescriptor::default()),
            mipmapped: false,
            depth: false,
        });
        self.glsl.black = Some(black.clone());
        black
    }

    /// The texture view and sampler for a unit's state. A texture whose
    /// minification filter reads mipmaps it does not have is incomplete, and a
    /// browser samples it as opaque black.
    fn glsl_sampler(
        &mut self,
        state: &GlslSampler,
        texture: Arc<Uploaded>,
    ) -> (wgpu::TextureView, wgpu::Sampler) {
        // A depth buffer is read texel for texel.
        if texture.depth {
            let nearest = GlslSampler {
                min: "NEAREST".into(),
                mag: "NEAREST".into(),
                ..state.clone()
            };
            let sampler = self.glsl_sampler_for(&nearest, false);
            return (texture.view.clone(), sampler);
        }
        let (_, _, wants_mips) = min_filter(&state.min);
        if wants_mips && !texture.mipmapped {
            let black = self.glsl_black();
            let sampler = self.glsl_sampler_for(state, false);
            return (black.view.clone(), sampler);
        }
        let sampler = self.glsl_sampler_for(state, texture.mipmapped);
        (texture.view.clone(), sampler)
    }

    fn glsl_sampler_for(&mut self, state: &GlslSampler, mipmapped: bool) -> wgpu::Sampler {
        let key = format!(
            "{}|{}|{}|{}|{mipmapped}|{:?}",
            state.min, state.mag, state.wrap_s, state.wrap_t, state.max_level
        );
        if let Some(s) = self.glsl.samplers.get(&key) {
            return s.clone();
        }
        let (min, mip, wants_mips) = min_filter(&state.min);
        let wrap = |w: &str| match w {
            "CLAMP_TO_EDGE" => wgpu::AddressMode::ClampToEdge,
            "MIRRORED_REPEAT" => wgpu::AddressMode::MirrorRepeat,
            _ => wgpu::AddressMode::Repeat,
        };
        let sampler = self.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("glsl sampler"),
            address_mode_u: wrap(&state.wrap_s),
            address_mode_v: wrap(&state.wrap_t),
            mag_filter: if state.mag == "NEAREST" {
                wgpu::FilterMode::Nearest
            } else {
                wgpu::FilterMode::Linear
            },
            min_filter: min,
            mipmap_filter: mip,
            lod_max_clamp: if wants_mips && mipmapped {
                state.max_level.map_or(32.0, |m| m as f32)
            } else {
                0.0
            },
            ..Default::default()
        });
        self.glsl.samplers.insert(key, sampler.clone());
        sampler
    }

    /// Draws the buffer's quad on a canvas-sized texture, converted to linear
    /// premultiplied light.
    fn glsl_place(
        &mut self,
        buffer: &wgpu::TextureView,
        (width, height): (f64, f64),
        matrix: Affine,
        content: &GlslContent,
    ) -> Tex {
        if self.glsl.blit.is_none() {
            self.glsl.blit = Some(self.glsl_blit(
                "glsl place",
                include_str!("../shaders/glsl_blit.wgsl"),
                ("vs_glsl", "fs_glsl"),
                LINEAR_FORMAT,
            ));
        }
        let corners = [
            (0.0, 0.0, 0.0, 0.0),
            (width, 0.0, 1.0, 0.0),
            (0.0, height, 0.0, 1.0),
            (width, height, 1.0, 1.0),
        ]
        .map(|(x, y, u, v)| {
            let p = matrix * Point::new(x, y);
            [p.x as f32, p.y as f32, u, v]
        });
        let mut params: Vec<f32> = corners.iter().flatten().copied().collect();
        params.extend([
            self.width as f32,
            self.height as f32,
            f32::from(u8::from(content.premultiplied_alpha)),
            f32::from(u8::from(!content.alpha)),
            f32::from(u8::from(
                content.webgpu.as_ref().is_some_and(|w| w.display_p3()),
            )),
            0.0,
            0.0,
            0.0,
        ]);
        let bytes: Vec<u8> = params.iter().flat_map(|f| f.to_le_bytes()).collect();

        let mut quad: Option<Rect> = None;
        for c in &corners {
            let p = Point::new(f64::from(c[0]), f64::from(c[1]));
            quad = Some(match quad {
                Some(r) => r.union_pt(p),
                None => Rect::from_points(p, p),
            });
        }
        let region = quad
            .and_then(|r| bounds::pixel_rect(r.inflate(1.0, 1.0)))
            .map_or(self.whole(), |r| r.intersect(self.whole()));

        let target = self.target_full(region);
        let params_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("glsl place"),
                contents: &bytes,
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let blit = self.glsl.blit.as_ref().expect("made above");
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("glsl place"),
            layout: &blit.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: params_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(buffer),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&blit.sampler),
                },
            ],
        });
        let stamp = self.stamp("glsl place", &target.view);
        let mut encoder = self.encoder();
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("glsl place"),
            color_attachments: &[Some(clear_attachment(
                &target.view,
                wgpu::Color::TRANSPARENT,
            ))],
            timestamp_writes: pass_timer::writes(&stamp),
            ..Default::default()
        });
        pass.set_pipeline(&blit.pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.draw(0..6, 0..1);
        drop(pass);
        drop(encoder);
        target
    }

    /// A `texSubImage2D` into the target `target` (of `size`): its pixels as
    /// the texture holds them (rows turned over, colour premultiplied, as the
    /// upload flags say), or a group's child copied in.
    fn glsl_upload<'c>(
        target: &'c str,
        upload: &gl::GlslUpload,
        size: (u32, u32),
        base_dir: &Path,
        inputs: &Inputs,
    ) -> Result<Step<'c>> {
        let (w, h) = (upload.width, upload.height);
        let fits = |at: u32, extent: u32, limit: u32| {
            at.checked_add(extent).is_some_and(|end| end <= limit)
        };
        if w == 0 || h == 0 || !fits(upload.x, w, size.0) || !fits(upload.y, h, size.1) {
            return Err(render_error(format!(
                "a texSubImage2D of {w} x {h} at ({}, {}) does not fit the {} x {} texture",
                upload.x, upload.y, size.0, size.1
            )));
        }
        if let Some(layer) = &upload.layer {
            let (_, texture) = inputs
                .get(&input_key(layer, upload.flip_y, upload.premultiply))
                .ok_or_else(|| {
                    render_error(format!(
                        "a texSubImage2D reads the layer {layer:?}, which was not drawn"
                    ))
                })?;
            // What the child's picture (the drawing buffer's size) has of the rectangle.
            let (cw, ch) = (w.min(texture.width()), h.min(texture.height()));
            return Ok(Step::Copy(
                target,
                texture.clone(),
                [upload.x, upload.y, cw, ch],
            ));
        }
        let (mut rgba, pw, ph) = gl::decode_picture(
            upload.src.as_deref(),
            upload.pixels.as_deref(),
            (w, h),
            base_dir,
        )
        .map_err(|e| render_error(format!("a texSubImage2D: {e}")))?;
        if (pw, ph) != (w, h) {
            return Err(render_error(format!(
                "a texSubImage2D of {w} x {h} names a picture of {pw} x {ph}"
            )));
        }
        gl::unpack(&mut rgba, w, upload.flip_y, upload.premultiply);
        Ok(Step::Write(target, [upload.x, upload.y, w, h], rgba))
    }

    /// The view and size of what a blit reads: a level of a target, or the
    /// drawing buffer.
    fn glsl_blit_source<'c>(
        &self,
        content: &'c GlslContent,
        targets: &mut HashMap<&'c str, Target>,
        id: Option<&'c str>,
        level: u32,
        size: (u32, u32),
    ) -> Result<(wgpu::TextureView, (u32, u32))> {
        Ok(match id {
            Some(id) => {
                let t = self.glsl_target(targets, content, id, None)?;
                let view = t.levels.get(level as usize).ok_or_else(|| {
                    render_error(format!(
                        "a blit reads level {level} of {id:?}, which it does not have"
                    ))
                })?;
                (view.clone(), t.level_size(level))
            }
            None => (
                self.glsl
                    .target
                    .as_ref()
                    .expect("made by glsl_draw")
                    .view
                    .clone(),
                size,
            ),
        })
    }

    /// `blitFramebuffer` of colour: the source rectangle stretched over the
    /// destination one by a pass of its own (`shaders/glsl_copy.wgsl`), as a
    /// draw that replaces what it covers. `None` when it covers nothing.
    fn glsl_copy<'c>(
        &mut self,
        content: &'c GlslContent,
        blit: &'c GlslBlit,
        size: (u32, u32),
        targets: &mut HashMap<&'c str, Target>,
        canvas_ds: Option<TargetFormat>,
    ) -> Result<Option<Prepared>> {
        if blit.src == blit.target && blit.src_level == blit.level {
            return Err(render_error(
                "blitFramebuffer reads and writes the same buffer (WebGL refuses it with \
                 INVALID_OPERATION)",
            ));
        }
        let (source, source_size) =
            self.glsl_blit_source(content, targets, blit.src.as_deref(), blit.src_level, size)?;
        let dst_size = match blit.target.as_deref() {
            Some(id) => self
                .glsl_target(targets, content, id, canvas_ds)?
                .level_size(blit.level),
            None => size,
        };
        if let Some(id) = blit.src.as_deref().or(blit.target.as_deref())
            && targets[id].ds.is_some()
        {
            return Err(render_error(
                "a colour blit names a depth or stencil buffer",
            ));
        }
        let Some((params, scissor)) = blit_geometry(blit, dst_size, source_size) else {
            return Ok(None);
        };
        let bytes: Vec<u8> = params.iter().flat_map(|v| v.to_le_bytes()).collect();
        if self.glsl.copy.is_none() {
            self.glsl.copy = Some(self.glsl_blit(
                "glsl copy",
                include_str!("../shaders/glsl_copy.wgsl"),
                ("vs_copy", "fs_copy"),
                COLOR_FORMAT,
            ));
        }
        let copy = self.glsl.copy.as_ref().expect("made above");
        let params_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("glsl copy"),
                contents: &bytes,
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("glsl copy"),
            layout: &copy.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: params_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&source),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&copy.sampler),
                },
            ],
        });
        Ok(Some(Prepared::copy(
            copy.pipeline.clone(),
            bind_group,
            dst_size,
            scissor,
            0,
        )))
    }

    /// `blitFramebuffer` of the depth and stencil buffers (`shaders/glsl_ds_copy.wgsl`): the depth written by one
    /// draw, the stencil zeroed by another and set a bit at a time by eight more.
    fn glsl_ds_copy<'c>(
        &mut self,
        content: &'c GlslContent,
        blit: &'c GlslBlit,
        targets: &mut HashMap<&'c str, Target>,
        canvas_ds: Option<TargetFormat>,
    ) -> Result<Vec<Prepared>> {
        let aspect = blit.aspect.unwrap_or(BlitAspect::DepthStencil);
        let src_key = blit.src.as_deref().unwrap_or(CANVAS_DS);
        let dst_key = blit.target.as_deref().unwrap_or(CANVAS_DS);
        if src_key == dst_key {
            return Err(render_error(
                "blitFramebuffer reads and writes the same depth and stencil buffer (WebGL refuses it \
                 with INVALID_OPERATION)",
            ));
        }
        let src = self.glsl_target(targets, content, src_key, canvas_ds)?;
        let (src_format, src_size) = (src.ds, src.size);
        let dst = self.glsl_target(targets, content, dst_key, canvas_ds)?;
        let (Some(format), Some(dst_format)) = (dst.ds, src_format) else {
            return Err(render_error(
                "a depth and stencil blit names a colour buffer",
            ));
        };
        if format != dst_format {
            return Err(render_error(
                "a depth and stencil blit between buffers of different formats (WebGL refuses it with \
                 INVALID_OPERATION)",
            ));
        }
        let dst_size = dst.size;
        let Some((params, scissor)) = blit_geometry(blit, dst_size, src_size) else {
            return Ok(Vec::new());
        };
        let copier = self.glsl_ds_copier(format);
        let src_texture = targets[src_key]._texture.clone();
        let params_with = |bit: u32| -> wgpu::Buffer {
            let mut p = params;
            p[6] = bit as f32;
            let bytes: Vec<u8> = p.iter().flat_map(|v| v.to_le_bytes()).collect();
            self.device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("glsl ds copy"),
                    contents: &bytes,
                    usage: wgpu::BufferUsages::UNIFORM,
                })
        };
        let mut out = Vec::new();
        if aspect.depth()
            && let Some(pipeline) = &copier.depth
        {
            let view = src_texture.create_view(&wgpu::TextureViewDescriptor {
                aspect: wgpu::TextureAspect::DepthOnly,
                ..Default::default()
            });
            let buffer = params_with(0);
            let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("glsl depth copy"),
                layout: &copier.depth_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&view),
                    },
                ],
            });
            out.push(Prepared::copy(
                pipeline.clone(),
                bind_group,
                dst_size,
                scissor,
                0,
            ));
        }
        if aspect.stencil()
            && let Some(zero) = &copier.zero
        {
            let view = src_texture.create_view(&wgpu::TextureViewDescriptor {
                aspect: wgpu::TextureAspect::StencilOnly,
                ..Default::default()
            });
            for bit in 0..=8u32 {
                let buffer = params_with(bit.saturating_sub(1));
                let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("glsl stencil copy"),
                    layout: &copier.stencil_layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: buffer.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: wgpu::BindingResource::TextureView(&view),
                        },
                    ],
                });
                // The first draw zeroes the stencil; each other sets one bit.
                let (pipeline, reference) = match bit {
                    0 => (zero.clone(), 0),
                    b => (copier.bits[(b - 1) as usize].clone(), 0xff),
                };
                out.push(Prepared::copy(
                    pipeline, bind_group, dst_size, scissor, reference,
                ));
            }
        }
        Ok(out)
    }

    /// The pipeline and layout of `glsl_depth_colour`, made the first time.
    fn glsl_depth_colour_pipeline(&mut self) {
        if self.glsl.depth_colour.is_none() {
            let shader = shader_module(
                &self.device,
                "glsl depth as colour",
                include_str!("../shaders/glsl_depth_colour.wgsl"),
            );
            let layout = self
                .device
                .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("glsl depth as colour"),
                    entries: &[wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Depth,
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    }],
                });
            let pipeline_layout =
                self.device
                    .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                        label: Some("glsl depth as colour"),
                        bind_group_layouts: &[Some(&layout)],
                        immediate_size: 0,
                    });
            let pipeline = |entry: &str, format: wgpu::TextureFormat| {
                self.device
                    .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                        label: Some("glsl depth as colour"),
                        layout: Some(&pipeline_layout),
                        vertex: wgpu::VertexState {
                            module: &shader,
                            entry_point: Some("vs_depth_colour"),
                            compilation_options: Default::default(),
                            buffers: &[],
                        },
                        fragment: Some(wgpu::FragmentState {
                            module: &shader,
                            entry_point: Some(entry),
                            compilation_options: Default::default(),
                            targets: &[Some(wgpu::ColorTargetState {
                                format,
                                blend: None,
                                write_mask: wgpu::ColorWrites::ALL,
                            })],
                        }),
                        primitive: wgpu::PrimitiveState::default(),
                        depth_stencil: None,
                        multisample: wgpu::MultisampleState::default(),
                        multiview_mask: None,
                        cache: None,
                    })
            };
            let pipelines = [
                pipeline("fs_depth_colour", wgpu::TextureFormat::R32Float),
                pipeline("fs_depth_luminance", wgpu::TextureFormat::Rgba32Float),
            ];
            self.glsl.depth_colour = Some((pipelines, layout));
        }
    }

    /// Copies the depth of `target` into the red channel of `copy`, an
    /// R32Float texture of its size.
    fn glsl_depth_colour(&self, target: &Target, copy: &wgpu::Texture) {
        let (pipelines, layout) = self
            .glsl
            .depth_colour
            .as_ref()
            .expect("made by glsl_depth_colour_pipeline");
        let pipeline = &pipelines[usize::from(copy.format() == wgpu::TextureFormat::Rgba32Float)];
        let depth = target._texture.create_view(&wgpu::TextureViewDescriptor {
            aspect: wgpu::TextureAspect::DepthOnly,
            ..Default::default()
        });
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("glsl depth as colour"),
            layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&depth),
            }],
        });
        let view = copy.create_view(&wgpu::TextureViewDescriptor::default());
        let stamp = self.stamp("glsl depth as colour", &view);
        let mut encoder = self.encoder();
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("glsl depth as colour"),
            color_attachments: &[Some(clear_attachment(&view, wgpu::Color::TRANSPARENT))],
            timestamp_writes: pass_timer::writes(&stamp),
            ..Default::default()
        });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.draw(0..3, 0..1);
    }

    /// The pipelines of a depth and stencil blit into a buffer of `format`.
    fn glsl_ds_copier(&mut self, format: TargetFormat) -> Arc<DsCopy> {
        let wgpu_format = ds_format(format);
        if let Some(c) = self.glsl.ds_copies.get(&wgpu_format) {
            return c.clone();
        }
        let shader = shader_module(
            &self.device,
            "glsl ds copy",
            include_str!("../shaders/glsl_ds_copy.wgsl"),
        );
        let layout_of = |binding: u32, sample_type: wgpu::TextureSampleType| {
            self.device
                .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("glsl ds copy"),
                    entries: &[
                        uniform_entry(0, wgpu::ShaderStages::VERTEX_FRAGMENT),
                        wgpu::BindGroupLayoutEntry {
                            binding,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Texture {
                                sample_type,
                                view_dimension: wgpu::TextureViewDimension::D2,
                                multisampled: false,
                            },
                            count: None,
                        },
                    ],
                })
        };
        let depth_layout = layout_of(1, wgpu::TextureSampleType::Depth);
        let stencil_layout = layout_of(2, wgpu::TextureSampleType::Uint);
        let pipeline = |layout: &wgpu::BindGroupLayout,
                        entry: &str,
                        depth_write: bool,
                        stencil: wgpu::StencilState| {
            let pipeline_layout =
                self.device
                    .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                        label: Some("glsl ds copy"),
                        bind_group_layouts: &[Some(layout)],
                        immediate_size: 0,
                    });
            self.device
                .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some("glsl ds copy"),
                    layout: Some(&pipeline_layout),
                    vertex: wgpu::VertexState {
                        module: &shader,
                        entry_point: Some("vs_copy"),
                        compilation_options: Default::default(),
                        buffers: &[],
                    },
                    fragment: Some(wgpu::FragmentState {
                        module: &shader,
                        entry_point: Some(entry),
                        compilation_options: Default::default(),
                        targets: &[],
                    }),
                    primitive: wgpu::PrimitiveState::default(),
                    depth_stencil: Some(wgpu::DepthStencilState {
                        format: wgpu_format,
                        depth_write_enabled: format.has_depth().then_some(depth_write),
                        depth_compare: format.has_depth().then_some(wgpu::CompareFunction::Always),
                        stencil,
                        bias: wgpu::DepthBiasState::default(),
                    }),
                    multisample: wgpu::MultisampleState::default(),
                    multiview_mask: None,
                    cache: None,
                })
        };
        // The reference replaces what the write mask lets through.
        let replace = |write_mask: u32| {
            let face = wgpu::StencilFaceState {
                compare: wgpu::CompareFunction::Always,
                fail_op: wgpu::StencilOperation::Keep,
                depth_fail_op: wgpu::StencilOperation::Keep,
                pass_op: wgpu::StencilOperation::Replace,
            };
            wgpu::StencilState {
                front: face,
                back: face,
                read_mask: 0xff,
                write_mask,
            }
        };
        let copier = Arc::new(DsCopy {
            depth: format.has_depth().then(|| {
                pipeline(
                    &depth_layout,
                    "fs_depth",
                    true,
                    wgpu::StencilState::default(),
                )
            }),
            zero: format
                .has_stencil()
                .then(|| pipeline(&stencil_layout, "fs_stencil_zero", false, replace(0xff))),
            bits: if format.has_stencil() {
                (0..8)
                    .map(|b| pipeline(&stencil_layout, "fs_stencil_bit", false, replace(1 << b)))
                    .collect()
            } else {
                Vec::new()
            },
            depth_layout,
            stencil_layout,
        });
        self.glsl.ds_copies.insert(wgpu_format, copier.clone());
        copier
    }

    /// The pipeline of a pass that draws one texture, read through a uniform
    /// block and a bilinear sampler, into a `format` target.
    fn glsl_blit(
        &self,
        label: &'static str,
        source: &str,
        (vertex, fragment): (&'static str, &'static str),
        format: wgpu::TextureFormat,
    ) -> Blit {
        let layout = self
            .device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some(label),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            });
        let pipeline_layout = self
            .device
            .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(label),
                bind_group_layouts: &[Some(&layout)],
                immediate_size: 0,
            });
        let shader = shader_module(&self.device, label, source);
        let pipeline = self
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some(vertex),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(fragment),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            });
        let sampler = self.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some(label),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        Blit {
            pipeline,
            layout,
            sampler,
        }
    }
}

/// The most vertices (or indices) one draw may read: a triangle fan is
/// expanded to a list three times as long, so this also bounds memory.
const MAX_DRAW_VERTICES: u32 = 1 << 22;

/// Rejects a draw whose `first + count` overflows or reads too many vertices.
fn check_vertex_range(first: u32, count: u32) -> Result<()> {
    if first.checked_add(count).is_none() || count > MAX_DRAW_VERTICES {
        return Err(render_error(format!(
            "the draw of {count} vertices from {first} is out of range (at most {MAX_DRAW_VERTICES} \
             vertices a draw)"
        )));
    }
    Ok(())
}

/// The viewport (x, y from the top, width, height) and the scissor rectangle
/// (x, y from the top, width, height; the whole buffer without one) of a
/// draw into a buffer of `size`. Done in `i64`, so no sum can overflow, and
/// a negative size or a viewport outside the buffer is an error. GL's y
/// counts up from the bottom row; `flip` is for a texture, drawn upside down,
/// whose rows count that way already.
fn draw_rects(
    viewport: [i32; 4],
    scissor: Option<[i32; 4]>,
    size: (u32, u32),
    flip: bool,
) -> Result<([f32; 4], [u32; 4])> {
    let (w, h) = (i64::from(size.0), i64::from(size.1));
    let [vx, vy, vw, vh] = viewport.map(i64::from);
    if vw < 0 || vh < 0 {
        return Err(render_error("the viewport has a negative size"));
    }
    if vx < 0 || vy < 0 || vx + vw > w || vy + vh > h {
        return Err(render_error(format!(
            "unsupported: the viewport ({vx}, {vy}, {vw}, {vh}) reaches outside the {w} x {h} \
             buffer it draws into (call viewport after binding a framebuffer)"
        )));
    }
    let top_of = |y: i64, height: i64| if flip { y } else { h - y - height };
    let viewport = [vx as f32, top_of(vy, vh) as f32, vw as f32, vh as f32];
    let scissor = match scissor {
        Some(rect) => {
            let [sx, sy, sw, sh] = rect.map(i64::from);
            if sw < 0 || sh < 0 {
                return Err(render_error("the scissor box has a negative size"));
            }
            let x0 = sx.clamp(0, w);
            let x1 = (sx + sw).clamp(0, w);
            let top = top_of(sy, sh).clamp(0, h);
            let bottom = (top_of(sy, sh) + sh).clamp(0, h);
            if x1 < x0 || bottom < top {
                return Err(render_error("the scissor box is inverted"));
            }
            [
                x0 as u32,
                top as u32,
                (x1 - x0) as u32,
                (bottom - top) as u32,
            ]
        }
        None => [0, 0, size.0, size.1],
    };
    Ok((viewport, scissor))
}

/// A draw, ready to record.
struct Prepared {
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    /// x, y (from the top), width, height.
    viewport: [f32; 4],
    scissor: [u32; 4],
    blend_constant: wgpu::Color,
    stencil_reference: u32,
    /// `depthRange`: where clip depth -1 and 1 land.
    depth_range: (f32, f32),
    /// Buffer and the byte offset to bind it at, in slot order.
    vertex_buffers: Vec<(wgpu::Buffer, u64)>,
    indices: Option<(wgpu::Buffer, u32)>,
    vertices: (u32, u32),
    instances: (u32, u32),
}

impl Prepared {
    /// A copy's draw: one triangle over a buffer of `size`, cut to `scissor`.
    fn copy(
        pipeline: wgpu::RenderPipeline,
        bind_group: wgpu::BindGroup,
        size: (u32, u32),
        scissor: [u32; 4],
        stencil_reference: u32,
    ) -> Prepared {
        Prepared {
            pipeline,
            bind_group,
            viewport: [0.0, 0.0, size.0 as f32, size.1 as f32],
            scissor,
            blend_constant: wgpu::Color::TRANSPARENT,
            stencil_reference,
            depth_range: (0.0, 1.0),
            vertex_buffers: Vec::new(),
            indices: None,
            vertices: (0, 3),
            instances: (0, 1),
        }
    }
}

/// The parameters of `glsl_copy.wgsl` (and `glsl_ds_copy.wgsl`) for a blit
/// into a buffer of `dst_size` from one of `source_size`, and the scissor box
/// (rows from the top) of what it covers: the destination's box, cut by the
/// buffer and the scissor. `None` when it covers nothing.
fn blit_geometry(
    blit: &GlslBlit,
    dst_size: (u32, u32),
    source_size: (u32, u32),
) -> Option<([f32; 16], [u32; 4])> {
    let top_down = blit.target.is_none();
    let [dx0, dy0, dx1, dy1] = blit.to.map(i64::from);
    let [sx0, sy0, sx1, sy1] = blit.from.map(i64::from);
    if dx0 == dx1 || dy0 == dy1 || sx0 == sx1 || sy0 == sy1 {
        return None;
    }
    let (w, h) = (i64::from(dst_size.0), i64::from(dst_size.1));
    let (mut x0, mut x1) = (dx0.min(dx1).clamp(0, w), dx0.max(dx1).clamp(0, w));
    let (mut y0, mut y1) = (dy0.min(dy1).clamp(0, h), dy0.max(dy1).clamp(0, h));
    if let Some([sx, sy, sw, sh]) = blit.scissor.map(|r| r.map(i64::from)) {
        x0 = x0.max(sx);
        x1 = x1.min(sx + sw);
        y0 = y0.max(sy);
        y1 = y1.min(sy + sh);
    }
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    let (top, bottom) = if top_down { (h - y1, h - y0) } else { (y0, y1) };
    let params: [f32; 16] = [
        dst_size.1 as f32,
        f32::from(u8::from(top_down)),
        source_size.0 as f32,
        source_size.1 as f32,
        f32::from(u8::from(blit.src.is_none())),
        f32::from(u8::from(blit.linear)),
        0.0,
        0.0,
        dx0 as f32,
        dy0 as f32,
        dx1 as f32,
        dy1 as f32,
        sx0 as f32,
        sy0 as f32,
        sx1 as f32,
        sy1 as f32,
    ];
    Some((
        params,
        [
            x0 as u32,
            top as u32,
            (x1 - x0) as u32,
            (bottom - top) as u32,
        ],
    ))
}

fn uniform_entry(binding: u32, visibility: wgpu::ShaderStages) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

/// The bytes of a recorded buffer, decoded the first time a draw reads it.
fn glsl_buffer<'a, 'c>(
    content: &'c GlslContent,
    id: &'c str,
    buffers: &'a mut HashMap<&'c str, (Vec<u8>, Option<wgpu::Buffer>)>,
) -> Result<&'a [u8]> {
    if !buffers.contains_key(id) {
        let encoded = content
            .buffers
            .get(id)
            .ok_or_else(|| render_error(format!("the buffer {id:?} is not in the recording")))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|e| render_error(format!("the buffer {id:?} is not base64: {e}")))?;
        buffers.insert(id, (bytes, None));
    }
    Ok(&buffers[id].0)
}

fn read_indices(bytes: &[u8], ty: GlslType, offset: u32, count: u32) -> Result<Vec<u32>> {
    let width = match ty {
        GlslType::U8 => 1,
        GlslType::U16 => 2,
        GlslType::U32 => 4,
        other => {
            return Err(render_error(format!(
                "unsupported: indices of type {other:?}; use UNSIGNED_BYTE, UNSIGNED_SHORT or UNSIGNED_INT"
            )));
        }
    };
    let start = offset as usize;
    let end = start + count as usize * width;
    let slice = bytes.get(start..end).ok_or_else(|| {
        render_error(format!(
            "the draw reads indices up to byte {end}, but the index buffer holds {}",
            bytes.len()
        ))
    })?;
    Ok(slice
        .chunks_exact(width)
        .map(|c| match width {
            1 => u32::from(c[0]),
            2 => u32::from(u16::from_le_bytes([c[0], c[1]])),
            _ => u32::from_le_bytes([c[0], c[1], c[2], c[3]]),
        })
        .collect())
}

/// The wgpu format of an attribute's data and its size in bytes, if the
/// shader reads floats of this many components.
fn vertex_format(
    a: &GlslAttribute,
    name: &str,
    components: Option<u32>,
) -> Result<(wgpu::VertexFormat, u64)> {
    use wgpu::VertexFormat as F;
    if components.is_none() {
        return Err(render_error(format!(
            "unsupported: the attribute `{name}` is not a float or a float vector"
        )));
    }
    let n = a.size;
    let format = match (a.ty, a.normalized, n) {
        (GlslType::F32, _, 1) => F::Float32,
        (GlslType::F32, _, 2) => F::Float32x2,
        (GlslType::F32, _, 3) => F::Float32x3,
        (GlslType::F32, _, 4) => F::Float32x4,
        (GlslType::U8, true, 2) => F::Unorm8x2,
        (GlslType::U8, true, 4) => F::Unorm8x4,
        (GlslType::I8, true, 2) => F::Snorm8x2,
        (GlslType::I8, true, 4) => F::Snorm8x4,
        (GlslType::U16, true, 2) => F::Unorm16x2,
        (GlslType::U16, true, 4) => F::Unorm16x4,
        (GlslType::I16, true, 2) => F::Snorm16x2,
        (GlslType::I16, true, 4) => F::Snorm16x4,
        _ => {
            return Err(render_error(format!(
                "unsupported: the attribute `{name}` is {n} {:?} value(s), normalized: {}; use FLOAT, \
                 or a normalized byte or short with 2 or 4 components",
                a.ty, a.normalized
            )));
        }
    };
    Ok((format, format.size()))
}

fn min_filter(name: &str) -> (wgpu::FilterMode, wgpu::MipmapFilterMode, bool) {
    use wgpu::FilterMode::{Linear, Nearest};
    match name {
        "NEAREST" => (Nearest, wgpu::MipmapFilterMode::Nearest, false),
        "LINEAR" => (Linear, wgpu::MipmapFilterMode::Nearest, false),
        "NEAREST_MIPMAP_NEAREST" => (Nearest, wgpu::MipmapFilterMode::Nearest, true),
        "LINEAR_MIPMAP_NEAREST" => (Linear, wgpu::MipmapFilterMode::Nearest, true),
        "NEAREST_MIPMAP_LINEAR" => (Nearest, wgpu::MipmapFilterMode::Linear, true),
        _ => (Linear, wgpu::MipmapFilterMode::Linear, true),
    }
}

fn compare_function(name: &str) -> Result<wgpu::CompareFunction> {
    Ok(match name {
        "NEVER" => wgpu::CompareFunction::Never,
        "LESS" => wgpu::CompareFunction::Less,
        "EQUAL" => wgpu::CompareFunction::Equal,
        "LEQUAL" => wgpu::CompareFunction::LessEqual,
        "GREATER" => wgpu::CompareFunction::Greater,
        "NOTEQUAL" => wgpu::CompareFunction::NotEqual,
        "GEQUAL" => wgpu::CompareFunction::GreaterEqual,
        "ALWAYS" => wgpu::CompareFunction::Always,
        other => {
            return Err(render_error(format!(
                "depthFunc({other}) is not a depth function"
            )));
        }
    })
}

/// One face of a stencil test as wgpu takes it.
fn stencil_face(face: &GlslStencilFace) -> Result<wgpu::StencilFaceState> {
    let op = |name: &str| -> Result<wgpu::StencilOperation> {
        Ok(match name {
            "KEEP" => wgpu::StencilOperation::Keep,
            "ZERO" => wgpu::StencilOperation::Zero,
            "REPLACE" => wgpu::StencilOperation::Replace,
            "INCR" => wgpu::StencilOperation::IncrementClamp,
            "DECR" => wgpu::StencilOperation::DecrementClamp,
            "INVERT" => wgpu::StencilOperation::Invert,
            "INCR_WRAP" => wgpu::StencilOperation::IncrementWrap,
            "DECR_WRAP" => wgpu::StencilOperation::DecrementWrap,
            other => {
                return Err(render_error(format!(
                    "stencilOp({other}) is not a stencil operation"
                )));
            }
        })
    };
    Ok(wgpu::StencilFaceState {
        compare: compare_function(&face.func)?,
        fail_op: op(&face.fail)?,
        depth_fail_op: op(&face.zfail)?,
        pass_op: op(&face.zpass)?,
    })
}

/// The depth and stencil attachment of a pass over `view`, which holds
/// `format`: each aspect it has cleared to the value given, or loaded.
fn ds_attachment(
    view: &wgpu::TextureView,
    format: TargetFormat,
    depth_clear: Option<f32>,
    stencil_clear: Option<u32>,
) -> wgpu::RenderPassDepthStencilAttachment<'_> {
    wgpu::RenderPassDepthStencilAttachment {
        view,
        depth_ops: format.has_depth().then(|| wgpu::Operations {
            load: depth_clear.map_or(wgpu::LoadOp::Load, wgpu::LoadOp::Clear),
            store: wgpu::StoreOp::Store,
        }),
        stencil_ops: format.has_stencil().then(|| wgpu::Operations {
            load: stencil_clear.map_or(wgpu::LoadOp::Load, wgpu::LoadOp::Clear),
            store: wgpu::StoreOp::Store,
        }),
    }
}

fn blend_key(b: &GlslBlend) -> String {
    format!(
        "{}{}{}{}{}{}",
        b.src_rgb, b.dst_rgb, b.src_alpha, b.dst_alpha, b.eq_rgb, b.eq_alpha
    )
}

fn blend_state(b: &GlslBlend) -> Result<wgpu::BlendState> {
    use wgpu::BlendFactor as F;
    let factor = |name: &str, color: bool| -> Result<F> {
        Ok(match name {
            "ZERO" => F::Zero,
            "ONE" => F::One,
            "SRC_COLOR" => F::Src,
            "ONE_MINUS_SRC_COLOR" => F::OneMinusSrc,
            "DST_COLOR" => F::Dst,
            "ONE_MINUS_DST_COLOR" => F::OneMinusDst,
            "SRC_ALPHA" => F::SrcAlpha,
            "ONE_MINUS_SRC_ALPHA" => F::OneMinusSrcAlpha,
            "DST_ALPHA" => F::DstAlpha,
            "ONE_MINUS_DST_ALPHA" => F::OneMinusDstAlpha,
            "SRC_ALPHA_SATURATE" => F::SrcAlphaSaturated,
            "CONSTANT_COLOR" if color => F::Constant,
            "ONE_MINUS_CONSTANT_COLOR" if color => F::OneMinusConstant,
            "CONSTANT_ALPHA" if !color => F::Constant,
            "ONE_MINUS_CONSTANT_ALPHA" if !color => F::OneMinusConstant,
            other => {
                return Err(render_error(format!(
                    "unsupported: blend factor {other} here (CONSTANT_ALPHA works only for the alpha \
                     channel, CONSTANT_COLOR only for colour)"
                )));
            }
        })
    };
    let op = |name: &str| -> Result<wgpu::BlendOperation> {
        Ok(match name {
            "FUNC_ADD" => wgpu::BlendOperation::Add,
            "FUNC_SUBTRACT" => wgpu::BlendOperation::Subtract,
            "FUNC_REVERSE_SUBTRACT" => wgpu::BlendOperation::ReverseSubtract,
            "MIN" => wgpu::BlendOperation::Min,
            "MAX" => wgpu::BlendOperation::Max,
            other => return Err(render_error(format!("unsupported: blend equation {other}"))),
        })
    };
    let component = |src: &str, dst: &str, eq: &str, color: bool| -> Result<wgpu::BlendComponent> {
        let operation = op(eq)?;
        // MIN and MAX ignore the factors in GL; wgpu wants them One.
        if matches!(
            operation,
            wgpu::BlendOperation::Min | wgpu::BlendOperation::Max
        ) {
            return Ok(wgpu::BlendComponent {
                src_factor: F::One,
                dst_factor: F::One,
                operation,
            });
        }
        Ok(wgpu::BlendComponent {
            src_factor: factor(src, color)?,
            dst_factor: factor(dst, color)?,
            operation,
        })
    };
    Ok(wgpu::BlendState {
        color: component(&b.src_rgb, &b.dst_rgb, &b.eq_rgb, true)?,
        alpha: component(&b.src_alpha, &b.dst_alpha, &b.eq_alpha, false)?,
    })
}

/// A file's size and modification time, so that an edited picture is
/// uploaded again.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rectangles_are_checked_without_overflow() {
        let size = (16, 16);
        for flip in [false, true] {
            assert!(draw_rects([0, 0, 16, 16], None, size, flip).is_ok());
            for bad in [
                [0, 0, -1, 4],
                [i32::MAX, 0, i32::MAX, 4],
                [0, i32::MIN, 4, 4],
            ] {
                assert!(draw_rects(bad, None, size, flip).is_err(), "{bad:?}");
            }
            for bad in [[0, 0, -1, 4], [0, 0, 4, -1]] {
                assert!(
                    draw_rects([0, 0, 16, 16], Some(bad), size, flip).is_err(),
                    "{bad:?}"
                );
            }
            // Huge scissors are clamped, not wrapped.
            let (_, s) = draw_rects(
                [0, 0, 16, 16],
                Some([i32::MAX, i32::MAX, i32::MAX, i32::MAX]),
                size,
                flip,
            )
            .unwrap();
            assert_eq!(s[2] * s[3], 0);
            let (_, s) = draw_rects(
                [0, 0, 16, 16],
                Some([i32::MIN, i32::MIN, i32::MAX, i32::MAX]),
                size,
                flip,
            )
            .unwrap();
            assert!(s[2] <= 16 && s[3] <= 16);
        }
    }

    #[test]
    fn a_texture_counts_rows_from_gls_bottom() {
        let size = (16, 16);
        // The drawing buffer's rows count from the top, GL's from the bottom.
        let (v, s) = draw_rects([0, 0, 16, 8], Some([0, 0, 16, 8]), size, false).unwrap();
        assert_eq!((v[1], s[1]), (8.0, 8));
        // A texture's first row is GL's bottom one.
        let (v, s) = draw_rects([0, 2, 16, 8], Some([0, 3, 16, 4]), size, true).unwrap();
        assert_eq!((v[1], s[1], s[3]), (2.0, 3, 4));
    }

    #[test]
    fn a_draw_that_overflows_or_is_huge_is_refused() {
        assert!(check_vertex_range(0, 6).is_ok());
        assert!(check_vertex_range(u32::MAX, 1).is_err());
        assert!(check_vertex_range(0, MAX_DRAW_VERTICES + 1).is_err());
    }
}
