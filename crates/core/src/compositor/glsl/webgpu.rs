//! WebGPU layers (`crate::webgpu`): the passes a page submitted to its canvas run on the device with the page's own
//! WGSL, into the same Rgba8 drawing buffer a WebGL layer draws into (`glsl_place` then puts it on the canvas).
//!
//! The recording is replayed in a command buffer of its own, submitted inside a validation error scope, so a page's
//! mistake (a module naga refuses, a bind group that does not fit its layout, a draw wgpu rejects) is a warning on
//! stderr and a transparent layer, never a panic. The command buffer before it is submitted first: the drawing buffer is
//! shared by every glsl layer, and the place pass that reads it for an earlier layer is already recorded.
//!
//! Modules, bind group layouts and pipelines are kept by their ids, which the page side makes from their content; the
//! buffers are made again for each frame from the bytes the recording holds.

use std::num::NonZeroU64;

use super::*;
use crate::webgpu::{self as wg, Command, WebGpuContent};

/// Most pipelines, modules and layouts kept before the cache starts over.
const MAX_CACHED: usize = 128;
/// The most passes, commands and vertices a recording may ask for.
const MAX_PASSES: usize = 256;
const MAX_COMMANDS: usize = 1 << 16;
const MAX_VERTICES: u32 = 1 << 24;

#[derive(Default)]
pub(super) struct WebGpuCache {
    modules: HashMap<String, wgpu::ShaderModule>,
    layouts: HashMap<String, wgpu::BindGroupLayout>,
    pipelines: HashMap<String, wgpu::RenderPipeline>,
    warned: HashSet<String>,
}

type Fail<T> = std::result::Result<T, String>;

impl Compositor {
    /// Draws the recording into the drawing buffer of `size`. A recording that cannot be drawn leaves it empty.
    pub(super) fn webgpu_draw(&mut self, content: &GlslContent, recording: &WebGpuContent, size: (u32, u32)) {
        self.drawing_buffer(size);
        // The earlier layers' passes read the drawing buffer; they run before this one overwrites it.
        self.submit();
        let initial = if content.alpha { [0.0; 4] } else { [0.0, 0.0, 0.0, 1.0] };
        let drawn = self.webgpu_replay(recording, initial);
        if let Err(message) = drawn {
            self.webgpu_warn(&message);
            // Whatever a half-run left is not the picture.
            let target = self.glsl.target.as_ref().expect("made above");
            let mut encoder = self.device.create_command_encoder(&Default::default());
            drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("webgpu empty"),
                color_attachments: &[Some(clear_attachment(
                    &target.view,
                    wgpu::Color {
                        r: initial[0],
                        g: initial[1],
                        b: initial[2],
                        a: initial[3],
                    },
                ))],
                ..Default::default()
            }));
            self.queue.submit([encoder.finish()]);
        }
    }

    fn webgpu_warn(&mut self, message: &str) {
        if self.glsl.webgpu.warned.insert(message.to_string()) {
            eprintln!("kinetograph: webgpu: {message}");
        }
    }

    fn webgpu_replay(&mut self, recording: &WebGpuContent, initial: [f64; 4]) -> Fail<()> {
        let problems = wg::check(recording);
        if let Some(first) = problems.first() {
            return Err(first.clone());
        }
        if recording.passes.len() > MAX_PASSES {
            return Err(format!("{} render passes in a frame (at most {MAX_PASSES})", recording.passes.len()));
        }
        if recording.passes.iter().map(|p| p.commands.len()).sum::<usize>() > MAX_COMMANDS {
            return Err(format!("more than {MAX_COMMANDS} commands in a frame"));
        }
        if self.glsl.webgpu.pipelines.len() > MAX_CACHED || self.glsl.webgpu.modules.len() > MAX_CACHED {
            self.glsl.webgpu.pipelines.clear();
            self.glsl.webgpu.modules.clear();
            self.glsl.webgpu.layouts.clear();
        }
        let device = self.device.clone();
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let built = self.webgpu_encode(recording, initial);
        let error = pollster::block_on(scope.pop());
        // The scope above held the pipelines' creation; the command buffer is checked in its own.
        let encoded = built?;
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        self.queue.submit([encoded]);
        let submit_error = pollster::block_on(scope.pop());
        if let Some(e) = error.or(submit_error) {
            return Err(format!("the passes were not accepted: {e}"));
        }
        Ok(())
    }

    /// The pipelines and the command buffer of the recording.
    fn webgpu_encode(&mut self, recording: &WebGpuContent, initial: [f64; 4]) -> Fail<wgpu::CommandBuffer> {
        let device = self.device.clone();
        // Buffers, from the bytes of the recording.
        let mut buffers: HashMap<&str, wgpu::Buffer> = HashMap::new();
        for (id, base64) in &recording.buffers {
            let mut bytes = base64::engine::general_purpose::STANDARD
                .decode(base64)
                .map_err(|e| format!("buffer {id}: {e}"))?;
            while bytes.len() < 4 || bytes.len() % 4 != 0 {
                bytes.push(0);
            }
            buffers.insert(
                id,
                device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("webgpu buffer"),
                    contents: &bytes,
                    usage: wgpu::BufferUsages::UNIFORM
                        | wgpu::BufferUsages::STORAGE
                        | wgpu::BufferUsages::VERTEX
                        | wgpu::BufferUsages::INDEX
                        | wgpu::BufferUsages::COPY_DST,
                }),
            );
        }
        // Pipelines that some pass sets.
        let mut pipelines: HashMap<&str, wgpu::RenderPipeline> = HashMap::new();
        for pass in &recording.passes {
            for command in &pass.commands {
                if let Command::Pipeline { id } = command
                    && !pipelines.contains_key(id.as_str())
                {
                    let pipeline = self.webgpu_pipeline(recording, id)?;
                    pipelines.insert(id, pipeline);
                }
            }
        }
        // Bind groups, as the passes bind them.
        let mut groups: HashMap<&str, wgpu::BindGroup> = HashMap::new();
        for pass in &recording.passes {
            for command in &pass.commands {
                if let Command::Bind { group, .. } = command
                    && !groups.contains_key(group.as_str())
                {
                    let made = self.webgpu_bind_group(recording, group, &buffers, &pipelines)?;
                    groups.insert(group, made);
                }
            }
        }

        let target = self.glsl.target.as_ref().expect("made by webgpu_draw");
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("webgpu"),
        });
        drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("webgpu start"),
            color_attachments: &[Some(clear_attachment(&target.view, color(initial)))],
            ..Default::default()
        }));
        for pass in &recording.passes {
            let load = match pass.clear {
                Some(c) => wgpu::LoadOp::Clear(color(c)),
                None => wgpu::LoadOp::Load,
            };
            let mut rp = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("webgpu"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target.view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            let mut has_pipeline = false;
            let mut index_size: Option<u64> = None;
            for command in &pass.commands {
                match command {
                    Command::Pipeline { id } => {
                        rp.set_pipeline(&pipelines[id.as_str()]);
                        has_pipeline = true;
                    }
                    Command::Bind { index, group, offsets } => {
                        rp.set_bind_group(*index, &groups[group.as_str()], offsets);
                    }
                    Command::Vertex { slot, buffer, offset, size } => {
                        let b = buffer_of(&buffers, buffer)?;
                        rp.set_vertex_buffer(*slot, slice(b, *offset, *size, 4)?);
                    }
                    Command::Index { buffer, format, offset, size } => {
                        let b = buffer_of(&buffers, buffer)?;
                        let format = match format.as_str() {
                            "uint16" => wgpu::IndexFormat::Uint16,
                            "uint32" => wgpu::IndexFormat::Uint32,
                            other => return Err(format!("index format {other}")),
                        };
                        index_size = Some(if format == wgpu::IndexFormat::Uint16 { 2 } else { 4 });
                        rp.set_index_buffer(slice(b, *offset, *size, index_size.unwrap_or(4))?, format);
                    }
                    Command::Draw { vertices, instances, first, first_instance } => {
                        if !has_pipeline {
                            return Err("draw before setPipeline".into());
                        }
                        check_count(*vertices, *instances)?;
                        rp.draw(*first..first.saturating_add(*vertices), *first_instance..first_instance.saturating_add(*instances));
                    }
                    Command::DrawIndexed { indices, instances, first, base, first_instance } => {
                        if !has_pipeline || index_size.is_none() {
                            return Err("drawIndexed before setPipeline and setIndexBuffer".into());
                        }
                        check_count(*indices, *instances)?;
                        rp.draw_indexed(*first..first.saturating_add(*indices), *base, *first_instance..first_instance.saturating_add(*instances));
                    }
                    Command::Viewport { x, y, width, height, min_depth, max_depth } => {
                        rp.set_viewport(*x, *y, *width, *height, *min_depth, *max_depth);
                    }
                    Command::Scissor { x, y, width, height } => {
                        rp.set_scissor_rect(*x, *y, *width, *height);
                    }
                    Command::Blend { color: c } => rp.set_blend_constant(color(*c)),
                }
            }
        }
        Ok(encoder.finish())
    }

    fn webgpu_module(&mut self, recording: &WebGpuContent, id: &str) -> Fail<wgpu::ShaderModule> {
        let code = recording.modules.get(id).ok_or_else(|| format!("module {id} is not in the recording"))?;
        if let Some(m) = self.glsl.webgpu.modules.get(code) {
            return Ok(m.clone());
        }
        let module = self.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("webgpu"),
            source: wgpu::ShaderSource::Wgsl(Cow::Owned(code.clone())),
        });
        self.glsl.webgpu.modules.insert(code.clone(), module.clone());
        Ok(module)
    }

    fn webgpu_layout(&mut self, recording: &WebGpuContent, id: &str) -> Fail<wgpu::BindGroupLayout> {
        if let Some(l) = self.glsl.webgpu.layouts.get(id) {
            return Ok(l.clone());
        }
        let entries = recording.layouts.get(id).ok_or_else(|| format!("bind group layout {id} is not in the recording"))?;
        let mut made = Vec::with_capacity(entries.len());
        for e in entries {
            let mut visibility = wgpu::ShaderStages::empty();
            if e.visibility & 1 != 0 {
                visibility |= wgpu::ShaderStages::VERTEX;
            }
            if e.visibility & 2 != 0 {
                visibility |= wgpu::ShaderStages::FRAGMENT;
            }
            if e.visibility & 4 != 0 {
                visibility |= wgpu::ShaderStages::COMPUTE;
            }
            let ty = match e.ty.as_str() {
                "uniform" => wgpu::BufferBindingType::Uniform,
                "storage" => wgpu::BufferBindingType::Storage { read_only: false },
                "read-only-storage" => wgpu::BufferBindingType::Storage { read_only: true },
                other => return Err(format!("binding type {other}")),
            };
            made.push(wgpu::BindGroupLayoutEntry {
                binding: e.binding,
                visibility,
                ty: wgpu::BindingType::Buffer {
                    ty,
                    has_dynamic_offset: e.dynamic_offset,
                    min_binding_size: None,
                },
                count: None,
            });
        }
        let layout = self.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("webgpu"),
            entries: &made,
        });
        self.glsl.webgpu.layouts.insert(id.to_string(), layout.clone());
        Ok(layout)
    }

    fn webgpu_pipeline(&mut self, recording: &WebGpuContent, id: &str) -> Fail<wgpu::RenderPipeline> {
        if let Some(p) = self.glsl.webgpu.pipelines.get(id) {
            return Ok(p.clone());
        }
        let spec = recording.pipelines.get(id).ok_or_else(|| format!("pipeline {id} is not in the recording"))?;
        let vertex = self.webgpu_module(recording, &spec.vertex.module)?;
        let fragment = match &spec.fragment {
            Some(f) => Some(self.webgpu_module(recording, &f.module)?),
            None => None,
        };
        let layout = match &spec.layout {
            Some(ids) => {
                let layouts: Vec<wgpu::BindGroupLayout> = ids
                    .iter()
                    .map(|l| self.webgpu_layout(recording, l))
                    .collect::<Fail<_>>()?;
                let refs: Vec<Option<&wgpu::BindGroupLayout>> = layouts.iter().map(Some).collect();
                Some(self.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("webgpu"),
                    bind_group_layouts: &refs,
                    immediate_size: 0,
                }))
            }
            None => None,
        };
        let mut attributes: Vec<Vec<wgpu::VertexAttribute>> = Vec::new();
        for b in &spec.vertex.buffers {
            attributes.push(
                b.attributes
                    .iter()
                    .map(|a| {
                        Ok(wgpu::VertexAttribute {
                            format: vertex_format(&a.format)?,
                            offset: a.offset,
                            shader_location: a.location,
                        })
                    })
                    .collect::<Fail<_>>()?,
            );
        }
        let buffers: Vec<Option<wgpu::VertexBufferLayout>> = spec
            .vertex
            .buffers
            .iter()
            .zip(&attributes)
            .map(|(b, attributes)| {
                Some(wgpu::VertexBufferLayout {
                    array_stride: b.stride,
                    step_mode: if b.step_mode.as_deref() == Some("instance") {
                        wgpu::VertexStepMode::Instance
                    } else {
                        wgpu::VertexStepMode::Vertex
                    },
                    attributes,
                })
            })
            .collect();
        let mut targets = Vec::new();
        if let Some(f) = &spec.fragment {
            for t in &f.targets {
                targets.push(match t {
                    None => None,
                    Some(t) => Some(wgpu::ColorTargetState {
                        // The drawing buffer is Rgba8: a bgra8 canvas holds the same colours.
                        format: match t.format.as_str() {
                            "rgba8unorm" | "bgra8unorm" | "rgba8unorm-srgb" | "bgra8unorm-srgb" => wgpu::TextureFormat::Rgba8Unorm,
                            other => return Err(format!("a render target of format {other}; the canvas is drawn as rgba8unorm")),
                        },
                        blend: t.blend.as_ref().map(blend_state).transpose()?,
                        write_mask: wgpu::ColorWrites::from_bits_truncate(t.write_mask.unwrap_or(15)),
                    }),
                });
            }
        }
        let p = &spec.primitive;
        let topology = match p.topology.as_str() {
            "point-list" => wgpu::PrimitiveTopology::PointList,
            "line-list" => wgpu::PrimitiveTopology::LineList,
            "line-strip" => wgpu::PrimitiveTopology::LineStrip,
            "triangle-list" => wgpu::PrimitiveTopology::TriangleList,
            "triangle-strip" => wgpu::PrimitiveTopology::TriangleStrip,
            other => return Err(format!("topology {other}")),
        };
        let pipeline = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("webgpu"),
            layout: layout.as_ref(),
            vertex: wgpu::VertexState {
                module: &vertex,
                entry_point: spec.vertex.entry_point.as_deref(),
                compilation_options: Default::default(),
                buffers: &buffers,
            },
            fragment: match (&spec.fragment, &fragment) {
                (Some(f), Some(module)) => Some(wgpu::FragmentState {
                    module,
                    entry_point: f.entry_point.as_deref(),
                    compilation_options: Default::default(),
                    targets: &targets,
                }),
                _ => None,
            },
            primitive: wgpu::PrimitiveState {
                topology,
                strip_index_format: match p.strip_index_format.as_deref() {
                    Some("uint16") => Some(wgpu::IndexFormat::Uint16),
                    Some("uint32") => Some(wgpu::IndexFormat::Uint32),
                    _ => None,
                },
                front_face: if p.front_face == "cw" { wgpu::FrontFace::Cw } else { wgpu::FrontFace::Ccw },
                cull_mode: match p.cull_mode.as_str() {
                    "front" => Some(wgpu::Face::Front),
                    "back" => Some(wgpu::Face::Back),
                    _ => None,
                },
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        self.glsl.webgpu.pipelines.insert(id.to_string(), pipeline.clone());
        Ok(pipeline)
    }

    fn webgpu_bind_group(
        &mut self,
        recording: &WebGpuContent,
        id: &str,
        buffers: &HashMap<&str, wgpu::Buffer>,
        pipelines: &HashMap<&str, wgpu::RenderPipeline>,
    ) -> Fail<wgpu::BindGroup> {
        let spec = recording.bind_groups.get(id).ok_or_else(|| format!("bind group {id} is not in the recording"))?;
        let layout = if let Some(rest) = spec.layout.strip_prefix("auto:") {
            let (pipeline, index) = rest.rsplit_once(':').ok_or("a malformed automatic layout")?;
            let index: u32 = index.parse().map_err(|_| "a malformed automatic layout")?;
            match pipelines.get(pipeline) {
                Some(p) => p.get_bind_group_layout(index),
                None => return Err(format!("the bind group {id} uses the layout of a pipeline no pass sets")),
            }
        } else {
            self.webgpu_layout(recording, &spec.layout)?
        };
        let mut entries = Vec::with_capacity(spec.entries.len());
        for e in &spec.entries {
            let buffer = buffer_of(buffers, &e.buffer)?;
            entries.push(wgpu::BindGroupEntry {
                binding: e.binding,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer,
                    offset: e.offset,
                    size: NonZeroU64::new(e.size),
                }),
            });
        }
        Ok(self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("webgpu"),
            layout: &layout,
            entries: &entries,
        }))
    }
}

fn color(c: [f64; 4]) -> wgpu::Color {
    wgpu::Color {
        r: c[0],
        g: c[1],
        b: c[2],
        a: c[3],
    }
}

fn buffer_of<'a>(buffers: &'a HashMap<&str, wgpu::Buffer>, id: &str) -> Fail<&'a wgpu::Buffer> {
    buffers.get(id).ok_or_else(|| format!("buffer {id} is not in the recording"))
}

/// A range of a buffer to bind. wgpu panics on an empty slice, so it is refused here, with offsets that are not
/// aligned (`align`: 4 for a vertex buffer, the index size for an index buffer).
fn slice(buffer: &wgpu::Buffer, offset: u64, size: Option<u64>, align: u64) -> Fail<wgpu::BufferSlice<'_>> {
    let end = checked_range(buffer.size(), offset, size, align)?;
    Ok(buffer.slice(offset..end))
}

/// The end of the range `offset` and `size` name in a buffer of `length` bytes, if it is a range wgpu accepts.
fn checked_range(length: u64, offset: u64, size: Option<u64>, align: u64) -> Fail<u64> {
    if offset % align != 0 {
        return Err(format!("the offset {offset} of a bound buffer is not a multiple of {align}"));
    }
    let end = match size {
        Some(s) => offset.checked_add(s).ok_or("a buffer range overflows")?,
        None => length,
    };
    if offset >= end {
        return Err(format!("the range {offset}..{end} of a bound buffer is empty"));
    }
    if end > length {
        return Err(format!("the range {offset}..{end} is outside a buffer of {length} bytes"));
    }
    Ok(end)
}

#[cfg(test)]
mod tests {
    use super::checked_range;

    #[test]
    fn an_empty_misaligned_or_outside_range_is_refused_not_a_panic() {
        assert_eq!(checked_range(64, 0, None, 4), Ok(64));
        assert_eq!(checked_range(64, 16, Some(16), 4), Ok(32));
        assert!(checked_range(64, 64, None, 4).unwrap_err().contains("empty"));
        assert!(checked_range(64, 8, Some(0), 4).unwrap_err().contains("empty"));
        assert!(checked_range(64, 2, Some(8), 4).unwrap_err().contains("multiple of 4"));
        assert!(checked_range(64, 2, Some(8), 2).is_ok());
        assert!(checked_range(64, 1, Some(8), 2).unwrap_err().contains("multiple of 2"));
        assert!(checked_range(64, 60, Some(8), 4).unwrap_err().contains("outside"));
        assert!(checked_range(64, 8, Some(u64::MAX), 4).unwrap_err().contains("overflows"));
    }
}

fn check_count(vertices: u32, instances: u32) -> Fail<()> {
    if vertices > MAX_VERTICES || instances > MAX_VERTICES || u64::from(vertices) * u64::from(instances) > u64::from(MAX_VERTICES) {
        return Err(format!("a draw of {vertices} vertices and {instances} instances is too large"));
    }
    Ok(())
}

fn factor(name: Option<&str>) -> Fail<wgpu::BlendFactor> {
    Ok(match name.unwrap_or("one") {
        "zero" => wgpu::BlendFactor::Zero,
        "one" => wgpu::BlendFactor::One,
        "src" => wgpu::BlendFactor::Src,
        "one-minus-src" => wgpu::BlendFactor::OneMinusSrc,
        "src-alpha" => wgpu::BlendFactor::SrcAlpha,
        "one-minus-src-alpha" => wgpu::BlendFactor::OneMinusSrcAlpha,
        "dst" => wgpu::BlendFactor::Dst,
        "one-minus-dst" => wgpu::BlendFactor::OneMinusDst,
        "dst-alpha" => wgpu::BlendFactor::DstAlpha,
        "one-minus-dst-alpha" => wgpu::BlendFactor::OneMinusDstAlpha,
        "src-alpha-saturated" => wgpu::BlendFactor::SrcAlphaSaturated,
        "constant" => wgpu::BlendFactor::Constant,
        "one-minus-constant" => wgpu::BlendFactor::OneMinusConstant,
        other => return Err(format!("blend factor {other}")),
    })
}

fn component(c: &wg::BlendComponent) -> Fail<wgpu::BlendComponent> {
    Ok(wgpu::BlendComponent {
        src_factor: factor(c.src_factor.as_deref())?,
        dst_factor: match c.dst_factor.as_deref() {
            None => wgpu::BlendFactor::Zero,
            other => factor(other)?,
        },
        operation: match c.operation.as_deref().unwrap_or("add") {
            "add" => wgpu::BlendOperation::Add,
            "subtract" => wgpu::BlendOperation::Subtract,
            "reverse-subtract" => wgpu::BlendOperation::ReverseSubtract,
            "min" => wgpu::BlendOperation::Min,
            "max" => wgpu::BlendOperation::Max,
            other => return Err(format!("blend operation {other}")),
        },
    })
}

fn blend_state(b: &wg::BlendState) -> Fail<wgpu::BlendState> {
    Ok(wgpu::BlendState {
        color: component(&b.color)?,
        alpha: component(&b.alpha)?,
    })
}

fn vertex_format(name: &str) -> Fail<wgpu::VertexFormat> {
    use wgpu::VertexFormat as F;
    Ok(match name {
        "uint8x2" => F::Uint8x2,
        "uint8x4" => F::Uint8x4,
        "sint8x2" => F::Sint8x2,
        "sint8x4" => F::Sint8x4,
        "unorm8x2" => F::Unorm8x2,
        "unorm8x4" => F::Unorm8x4,
        "snorm8x2" => F::Snorm8x2,
        "snorm8x4" => F::Snorm8x4,
        "uint16x2" => F::Uint16x2,
        "uint16x4" => F::Uint16x4,
        "sint16x2" => F::Sint16x2,
        "sint16x4" => F::Sint16x4,
        "unorm16x2" => F::Unorm16x2,
        "unorm16x4" => F::Unorm16x4,
        "snorm16x2" => F::Snorm16x2,
        "snorm16x4" => F::Snorm16x4,
        "float16x2" => F::Float16x2,
        "float16x4" => F::Float16x4,
        "float32" => F::Float32,
        "float32x2" => F::Float32x2,
        "float32x3" => F::Float32x3,
        "float32x4" => F::Float32x4,
        "uint32" => F::Uint32,
        "uint32x2" => F::Uint32x2,
        "uint32x3" => F::Uint32x3,
        "uint32x4" => F::Uint32x4,
        "sint32" => F::Sint32,
        "sint32x2" => F::Sint32x2,
        "sint32x3" => F::Sint32x3,
        "sint32x4" => F::Sint32x4,
        other => return Err(format!("vertex format {other}")),
    })
}
