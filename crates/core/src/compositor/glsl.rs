//! WebGL layers (`crate::glsl`, packages/cli/skills/kinetograph/references/SCENE.md, "glsl"): the draws a page
//! recorded run on the device with the page's own shaders, into an Rgba8
//! target as a browser's drawing buffer is, and `shaders/glsl_blit.wgsl` then
//! places that on the canvas.
//!
//! A framebuffer's texture is a second kind of target (`GlslTexture::target`):
//! a draw or clear that names one goes to it, and a later draw samples it like
//! any texture. GL's rows count up from the bottom and a texture's first row
//! is its bottom one, so a program that draws into a texture is translated
//! upside down (`gl::translate`'s `flip_y`) and its viewport, scissor and
//! winding are turned to match; sampling then needs nothing. A frame starts
//! with every target transparent black, and the ops run in order, one render
//! pass for each run of draws to the same target.
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
use crate::glsl::{
    self as gl, GlslAttribute, GlslBlend, GlslBlit, GlslContent, GlslDraw, GlslMode, GlslOp, GlslSampler,
    GlslTexture, GlslType, Stage, Translated,
};

/// The bind group layout and shader modules of one program.
struct Program {
    translated: Translated,
    vertex: wgpu::ShaderModule,
    fragment: wgpu::ShaderModule,
    layout: wgpu::BindGroupLayout,
    pipeline_layout: wgpu::PipelineLayout,
}

/// A texture on the device, with whether `generateMipmap` gave it levels.
struct Uploaded {
    view: wgpu::TextureView,
    mipmapped: bool,
}

/// What draws go to: the drawing buffer, or a framebuffer's texture.
struct Target {
    size: (u32, u32),
    view: wgpu::TextureView,
    // Kept alive with its view.
    _texture: wgpu::Texture,
}

/// The draws of a replay that go to one target, in order, and how the pass
/// starts: with a clear, or (`None`) from what the target holds.
struct Pass<'c> {
    /// The id of a target texture; the drawing buffer without one.
    target: Option<&'c str>,
    clear: Option<[f64; 4]>,
    draws: Vec<Prepared>,
    /// A `texSubImage2D` instead of draws: x, y, width, height and the bytes.
    upload: Option<([u32; 4], Vec<u8>)>,
}

struct Blit {
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
}

#[derive(Default)]
pub(super) struct GlslGpu {
    programs: HashMap<String, Arc<Program>>,
    pipelines: HashMap<String, wgpu::RenderPipeline>,
    textures: HashMap<String, Arc<Uploaded>>,
    samplers: HashMap<String, wgpu::Sampler>,
    target: Option<Target>,
    blit: Option<Blit>,
    /// The pass behind `blitFramebuffer`.
    copy: Option<Blit>,
    /// The pass that turns a group's child into a texture, and the textures
    /// it writes, by the child's place among those a group samples.
    input: Option<Blit>,
    inputs: Vec<Option<Target>>,
    /// What a texture that is not complete samples as: opaque black.
    black: Option<Arc<Uploaded>>,
}

/// What a group's child is called among the pictures a pass samples: the way the texture reads it is part of the name.
fn input_key(layer: &str, flip_y: bool, premultiply: bool) -> String {
    format!("{layer}\0{}{}", u8::from(flip_y), u8::from(premultiply))
}

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
        let mut inputs = HashMap::new();
        let mut n = 0;
        for (id, tex) in layers {
            let mut ways: Vec<(bool, bool)> = Vec::new();
            for texture in content.textures.values() {
                let way = (texture.flip_y, texture.premultiply);
                if texture.layer.as_deref() == Some(*id) && !ways.contains(&way) {
                    ways.push(way);
                }
            }
            for (flip, premultiply) in ways {
                let through = if flip {
                    matrix * Affine::new([1.0, 0.0, 0.0, -1.0, 0.0, f64::from(size.1)])
                } else {
                    matrix
                };
                inputs.insert(
                    input_key(id, flip, premultiply),
                    self.glsl_input(n, tex, size, through, premultiply),
                );
                n += 1;
            }
        }
        self.glsl_draw(content, size, base_dir, &inputs)?;
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
            self.glsl.inputs[n] = Some(Target {
                size,
                view: texture.create_view(&wgpu::TextureViewDescriptor::default()),
                _texture: texture,
            });
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

    /// Records the draws into the drawing buffer. `inputs` are the views of
    /// a group's children, by id.
    fn glsl_draw(
        &mut self,
        content: &GlslContent,
        size: (u32, u32),
        base_dir: &Path,
        inputs: &HashMap<String, wgpu::TextureView>,
    ) -> Result<()> {
        if self.glsl.target.as_ref().is_none_or(|t| t.size != size) {
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
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            self.glsl.target = Some(Target {
                size,
                view: texture.create_view(&wgpu::TextureViewDescriptor::default()),
                _texture: texture,
            });
        }

        // Everything drawn to the drawing buffer before its last clear is gone
        // with it, unless a blit reads the drawing buffer in between. A
        // target's draws stay: later draws may sample them.
        let mut dead = vec![false; content.ops.len()];
        let mut cleared = false;
        for (i, op) in content.ops.iter().enumerate().rev() {
            match op {
                GlslOp::Clear { target: None, .. } => {
                    dead[i] = cleared;
                    cleared = true;
                }
                GlslOp::Draw(d) if d.target.is_none() => dead[i] = cleared,
                GlslOp::Blit(b) => {
                    if b.target.is_none() {
                        dead[i] = cleared;
                    }
                    if b.src.is_none() && !dead[i] {
                        cleared = false;
                    }
                }
                _ => {}
            }
        }
        // What a target holds before its first pass.
        let blank = |target: Option<&str>| match target {
            None if !content.alpha => [0.0, 0.0, 0.0, 1.0],
            _ => [0.0; 4],
        };

        let mut buffers: HashMap<&str, (Vec<u8>, Option<wgpu::Buffer>)> = HashMap::new();
        let mut targets: HashMap<&str, Target> = HashMap::new();
        let mut passes: Vec<Pass> = Vec::new();
        let mut started: HashSet<Option<&str>> = HashSet::new();
        for (i, op) in content.ops.iter().enumerate() {
            let (target, clear) = match op {
                GlslOp::Clear { color, target } => (target.as_deref(), Some(*color)),
                GlslOp::Draw(d) => (d.target.as_deref(), None),
                GlslOp::Blit(b) => (b.target.as_deref(), None),
                GlslOp::Upload(u) => (Some(u.target.as_str()), None),
            };
            if dead[i] {
                continue;
            }
            if let Some(id) = target {
                self.glsl_target(&mut targets, content, id)?;
            }
            let upload = match op {
                GlslOp::Upload(u) => Some(Self::glsl_upload(u, self.glsl_target(&mut targets, content, &u.target)?.size)?),
                _ => None,
            };
            if clear.is_some()
                || upload.is_some()
                || passes
                    .last()
                    .is_none_or(|p| p.target != target || p.upload.is_some())
            {
                let first = started.insert(target);
                passes.push(Pass {
                    target,
                    clear: clear.or_else(|| first.then(|| blank(target))),
                    draws: Vec::new(),
                    upload,
                });
            }
            let prepared = match op {
                GlslOp::Draw(draw) => self.glsl_prepare(
                    content,
                    draw,
                    size,
                    (base_dir, inputs),
                    &mut buffers,
                    &mut targets,
                )?,
                GlslOp::Blit(blit) => self.glsl_copy(content, blit, size, &mut targets)?,
                GlslOp::Clear { .. } | GlslOp::Upload(_) => None,
            };
            if let Some(p) = prepared {
                passes.last_mut().expect("pushed above").draws.push(p);
            }
        }
        // The drawing buffer is cleared even when nothing is drawn to it.
        if started.insert(None) {
            passes.push(Pass {
                target: None,
                clear: Some(blank(None)),
                draws: Vec::new(),
                upload: None,
            });
        }

        let canvas = self.glsl.target.as_ref().expect("made above");
        for pass in &passes {
            if let Some(([x, y, w, h], bytes)) = &pass.upload {
                let id = pass.target.expect("an upload names its target");
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
            let (view, name) = match pass.target {
                None => (&canvas.view, "glsl"),
                Some(id) => (&targets[id].view, "glsl target"),
            };
            let stamp = self.stamp(name, view);
            let mut encoder = self.encoder();
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some(name),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: match pass.clear {
                            Some([r, g, b, a]) => wgpu::LoadOp::Clear(wgpu::Color { r, g, b, a }),
                            None => wgpu::LoadOp::Load,
                        },
                        store: wgpu::StoreOp::Store,
                    },
                })],
                timestamp_writes: pass_timer::writes(&stamp),
                ..Default::default()
            });
            for p in &pass.draws {
                rpass.set_pipeline(&p.pipeline);
                rpass.set_bind_group(0, &p.bind_group, &[]);
                let [x, y, w, h] = p.viewport;
                rpass.set_viewport(x, y, w, h, 0.0, 1.0);
                let [sx, sy, sw, sh] = p.scissor;
                rpass.set_scissor_rect(sx, sy, sw, sh);
                rpass.set_blend_constant(p.blend_constant);
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

    /// The target texture `id` names, made the first time a pass or a sampler
    /// needs it (wgpu gives it zeroes). Its size is the recorded texture's,
    /// and the targets of a layer hold `MAX_TARGET_BYTES` together at most.
    fn glsl_target<'a, 'c>(
        &self,
        targets: &'a mut HashMap<&'c str, Target>,
        content: &'c GlslContent,
        id: &'c str,
    ) -> Result<&'a Target> {
        if !targets.contains_key(id) {
            let texture = content
                .textures
                .get(id)
                .filter(|t| t.target)
                .ok_or_else(|| {
                    render_error(format!(
                        "an op targets {id:?}, which is not a target texture of the recording"
                    ))
                })?;
            let (width, height) = (texture.width, texture.height);
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
            let held: u64 = targets
                .values()
                .map(|t| u64::from(t.size.0) * u64::from(t.size.1) * 4)
                .sum();
            if held + u64::from(width) * u64::from(height) * 4 > MAX_TARGET_BYTES {
                return Err(render_error(format!(
                    "unsupported: the render targets hold more than {} MiB",
                    MAX_TARGET_BYTES >> 20
                )));
            }
            let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("glsl render target"),
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            targets.insert(
                id,
                Target {
                    size: (width, height),
                    view: texture.create_view(&wgpu::TextureViewDescriptor::default()),
                    _texture: texture,
                },
            );
        }
        Ok(&targets[id])
    }

    /// Everything one draw needs, or `None` if it draws nothing.
    fn glsl_prepare<'c>(
        &mut self,
        content: &'c GlslContent,
        draw: &'c GlslDraw,
        size: (u32, u32),
        (base_dir, inputs): (&Path, &HashMap<String, wgpu::TextureView>),
        buffers: &mut HashMap<&'c str, (Vec<u8>, Option<wgpu::Buffer>)>,
        targets: &mut HashMap<&'c str, Target>,
    ) -> Result<Option<Prepared>> {
        let program_spec = content.programs.get(&draw.program).ok_or_else(|| {
            render_error(format!(
                "a draw names the program {:?}, which is not in the recording",
                draw.program
            ))
        })?;
        // A texture is drawn upside down, so that its rows are GL's.
        let flip = draw.target.is_some();
        let size = match draw.target.as_deref() {
            Some(id) => self.glsl_target(targets, content, id)?.size,
            None => size,
        };
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

        // Pipeline.
        let key = format!(
            "{:p}|{layouts:?}|{topology:?}|{}|{:?}|{:?}|{:?}",
            Arc::as_ptr(&program),
            index_list.is_some() && topology == wgpu::PrimitiveTopology::TriangleStrip,
            draw.blend.as_ref().map(blend_key),
            draw.color_mask,
            draw.cull,
        );
        let pipeline = match self.glsl.pipelines.get(&key) {
            Some(p) => p.clone(),
            None => {
                let p =
                    self.glsl_pipeline(&program, &layouts, topology, index_list.is_some(), draw)?;
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
        for binding in &fragment.samplers {
            let unit = draw
                .uniforms
                .get(&binding.name)
                .and_then(|calls| calls.last())
                .and_then(|call| call.value.first())
                .map_or(0, |v| *v as i64);
            let (view, sampler) = match draw.units.get(&unit.to_string()) {
                Some(state) => {
                    let texture = content.textures.get(&state.texture).ok_or_else(|| {
                        render_error(format!(
                            "the texture {:?} is not in the recording",
                            state.texture
                        ))
                    })?;
                    let uploaded = if let Some(layer) = &texture.layer {
                        Arc::new(Uploaded {
                            view: inputs
                                .get(&input_key(layer, texture.flip_y, texture.premultiply))
                                .ok_or_else(|| {
                                    render_error(format!(
                                        "the texture {:?} is the layer {layer:?}, which was not drawn",
                                        state.texture
                                    ))
                                })?
                                .clone(),
                            mipmapped: false,
                        })
                    } else if texture.target {
                        if draw.target.as_deref() == Some(state.texture.as_str()) {
                            return Err(render_error(format!(
                                "a draw samples the texture {:?} it renders to (WebGL refuses such a \
                                 draw with INVALID_OPERATION)",
                                state.texture
                            )));
                        }
                        let target = self.glsl_target(targets, content, &state.texture)?;
                        Arc::new(Uploaded {
                            view: target.view.clone(),
                            mipmapped: false,
                        })
                    } else {
                        self.glsl_texture(&state.texture, texture, base_dir)?
                    };
                    self.glsl_sampler(state, uploaded)
                }
                None => {
                    let black = self.glsl_black();
                    let nearest = GlslSampler {
                        texture: String::new(),
                        min: "NEAREST".into(),
                        mag: "NEAREST".into(),
                        wrap_s: "CLAMP_TO_EDGE".into(),
                        wrap_t: "CLAMP_TO_EDGE".into(),
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
            layout: &program.layout,
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

    fn glsl_pipeline(
        &self,
        program: &Program,
        layouts: &[(u32, wgpu::VertexFormat, u64, u64, wgpu::VertexStepMode)],
        topology: wgpu::PrimitiveTopology,
        indexed: bool,
        draw: &GlslDraw,
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
        // A texture is drawn upside down, which turns a winding around.
        let clockwise = draw.cull.as_ref().is_some_and(|c| c.front == "CW");
        let front_face = if clockwise != draw.target.is_some() {
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
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let pipeline = self
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("glsl"),
                layout: Some(&program.pipeline_layout),
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
                    targets: &[Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        blend,
                        write_mask: mask,
                    })],
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
                depth_stencil: None,
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
        let stamp = texture
            .src
            .as_deref()
            .filter(|s| !s.starts_with("data:"))
            .map(|s| file_stamp(&base_dir.join(s)))
            .unwrap_or_default();
        let key = format!(
            "{id}|{}|{}|{}|{stamp}",
            texture.flip_y, texture.premultiply, texture.mipmaps
        );
        if let Some(t) = self.glsl.textures.get(&key) {
            return Ok(t.clone());
        }
        let (mut rgba, width, height) =
            gl::decode_texture(texture, base_dir).map_err(render_error)?;
        if texture.flip_y {
            let row = width as usize * 4;
            let rows: Vec<&[u8]> = rgba.chunks(row).collect();
            rgba = rows.iter().rev().flat_map(|r| r.iter().copied()).collect();
        }
        if texture.premultiply {
            let (pixels, _) = rgba.as_chunks_mut::<4>();
            for px in pixels {
                let a = u32::from(px[3]);
                for c in &mut px[..3] {
                    *c = ((u32::from(*c) * a + 127) / 255) as u8;
                }
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
            format: wgpu::TextureFormat::Rgba8Unorm,
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
        });
        self.glsl.textures.insert(key, uploaded.clone());
        Ok(uploaded)
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
            "{}|{}|{}|{}|{mipmapped}",
            state.min, state.mag, state.wrap_s, state.wrap_t
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
            lod_max_clamp: if wants_mips && mipmapped { 32.0 } else { 0.0 },
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

    /// The pixels of a `texSubImage2D` as the texture holds them (rows turned
    /// over, colour premultiplied, as the upload flags say), with where they
    /// go. `size` is the target's.
    fn glsl_upload(upload: &gl::GlslUpload, size: (u32, u32)) -> Result<([u32; 4], Vec<u8>)> {
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
        let mut rgba = base64::engine::general_purpose::STANDARD
            .decode(&upload.pixels)
            .map_err(|e| render_error(format!("a texSubImage2D's pixels are not base64: {e}")))?;
        if rgba.len() != w as usize * h as usize * 4 {
            return Err(render_error(format!(
                "a texSubImage2D of {w} x {h} needs {} bytes of RGBA, got {}",
                w as usize * h as usize * 4,
                rgba.len()
            )));
        }
        if upload.flip_y {
            let row = w as usize * 4;
            rgba = rgba.chunks(row).rev().flatten().copied().collect();
        }
        if upload.premultiply {
            let (pixels, _) = rgba.as_chunks_mut::<4>();
            for px in pixels {
                let a = u32::from(px[3]);
                for c in &mut px[..3] {
                    *c = ((u32::from(*c) * a + 127) / 255) as u8;
                }
            }
        }
        Ok(([upload.x, upload.y, w, h], rgba))
    }

    /// `blitFramebuffer`: the source rectangle stretched over the destination
    /// one by a pass of its own (`shaders/glsl_copy.wgsl`), as a draw that
    /// replaces what it covers. `None` when it covers nothing.
    fn glsl_copy<'c>(
        &mut self,
        content: &'c GlslContent,
        blit: &'c GlslBlit,
        size: (u32, u32),
        targets: &mut HashMap<&'c str, Target>,
    ) -> Result<Option<Prepared>> {
        if blit.src == blit.target {
            return Err(render_error(
                "blitFramebuffer reads and writes the same buffer (WebGL refuses it with \
                 INVALID_OPERATION)",
            ));
        }
        let (source, source_size) = match blit.src.as_deref() {
            Some(id) => {
                let t = self.glsl_target(targets, content, id)?;
                (t.view.clone(), t.size)
            }
            None => (
                self.glsl.target.as_ref().expect("made by glsl_draw").view.clone(),
                size,
            ),
        };
        let dst_size = match blit.target.as_deref() {
            Some(id) => self.glsl_target(targets, content, id)?.size,
            None => size,
        };
        let top_down = blit.target.is_none();
        let [dx0, dy0, dx1, dy1] = blit.to.map(i64::from);
        let [sx0, sy0, sx1, sy1] = blit.from.map(i64::from);
        if dx0 == dx1 || dy0 == dy1 || sx0 == sx1 || sy0 == sy1 {
            return Ok(None);
        }
        // The destination's box, cut by the buffer and the scissor, in rows
        // from the top.
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
            return Ok(None);
        }
        let (top, bottom) = if top_down { (h - y1, h - y0) } else { (y0, y1) };
        let src_top_down = blit.src.is_none();
        let params: [f32; 16] = [
            dst_size.1 as f32,
            f32::from(u8::from(top_down)),
            source_size.0 as f32,
            source_size.1 as f32,
            f32::from(u8::from(src_top_down)),
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
        let bytes: Vec<u8> = params.iter().flat_map(|v| v.to_le_bytes()).collect();
        if self.glsl.copy.is_none() {
            self.glsl.copy = Some(self.glsl_blit(
                "glsl copy",
                include_str!("../shaders/glsl_copy.wgsl"),
                ("vs_copy", "fs_copy"),
                wgpu::TextureFormat::Rgba8Unorm,
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
        Ok(Some(Prepared {
            pipeline: copy.pipeline.clone(),
            bind_group,
            viewport: [0.0, 0.0, dst_size.0 as f32, dst_size.1 as f32],
            scissor: [x0 as u32, top as u32, (x1 - x0) as u32, (bottom - top) as u32],
            blend_constant: wgpu::Color::TRANSPARENT,
            vertex_buffers: Vec::new(),
            indices: None,
            vertices: (0, 3),
            instances: (0, 1),
        }))
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
    /// Buffer and the byte offset to bind it at, in slot order.
    vertex_buffers: Vec<(wgpu::Buffer, u64)>,
    indices: Option<(wgpu::Buffer, u32)>,
    vertices: (u32, u32),
    instances: (u32, u32),
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
