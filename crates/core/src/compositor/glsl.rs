//! WebGL layers (`crate::glsl`, packages/cli/skills/kinetograph-markup/references/SCENE.md, "glsl"): ANGLE replays the
//! recording a page made (`crate::angle_replay`) and its RGBA8 rows are written into a drawing buffer, which
//! `shaders/glsl_blit.wgsl` then places on the canvas. A group's children, which the recording's `layer` textures name,
//! are drawn as pictures first (`glsl_input`) and read back for ANGLE to upload.

use std::borrow::Cow;
use std::collections::HashSet;
use std::path::Path;

use base64::Engine as _;
use kurbo::Point;

use super::*;
mod webgpu;

use crate::angle_replay::file_stamp;
use crate::glsl::{self as gl, GlslContent, GlslOp};

/// The format of the drawing buffer and of every colour target.
const COLOR_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// What draws go to: the drawing buffer, or a group's child as a picture.
struct Target {
    /// Of level 0.
    size: (u32, u32),
    /// The device format: Rgba8 (the drawing buffer is Rgba16Float for an `rgba16float` WebGPU canvas).
    format: wgpu::TextureFormat,
    /// What draws sample.
    view: wgpu::TextureView,
    _texture: wgpu::Texture,
}

impl Target {
    /// A colour texture of one level, of `format`.
    fn colour(texture: wgpu::Texture, size: (u32, u32), format: wgpu::TextureFormat) -> Target {
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        Target {
            size,
            format,
            view,
            _texture: texture,
        }
    }
}

struct Blit {
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
}

#[derive(Default)]
pub(super) struct GlslGpu {
    target: Option<Target>,
    blit: Option<Blit>,
    /// The pass that turns a group's child into a texture, and the textures
    /// it writes, by the child's place among those a group samples.
    input: Option<Blit>,
    inputs: Vec<Option<Target>>,
    /// The modules, layouts and pipelines of WebGPU layers.
    webgpu: webgpu::WebGpuCache,
}

// What a group's child is called among the pictures a pass samples: the way the texture reads it is part of the name.
use crate::angle_replay::layer_key as input_key;

/// The pictures of a group's children a replay reads, by `input_key`: the
/// view draws sample and the texture uploads copy.
type Inputs = HashMap<String, (wgpu::TextureView, wgpu::Texture)>;

fn render_error(what: impl std::fmt::Display) -> Error {
    Error::Render(format!("glsl: {what}"))
}

/// The most a drawing buffer can be across.
const MAX_BUFFER_SIDE: u32 = 8192;
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
                for call in &texture.calls {
                    note(call.layer.as_deref(), (call.flip_y, call.premultiply));
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

    /// The pipeline of a pass that draws one texture, read through a uniform
    /// block and a bilinear sampler, into a `format` target.
    fn glsl_blit(
        &self,
        label: &'static str,
        source: &str,
        (vertex, fragment): (&'static str, &'static str),
        format: wgpu::TextureFormat,
        filterable: bool,
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
                            sample_type: wgpu::TextureSampleType::Float { filterable },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(if filterable {
                            wgpu::SamplerBindingType::Filtering
                        } else {
                            wgpu::SamplerBindingType::NonFiltering
                        }),
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
        let filter = if filterable {
            wgpu::FilterMode::Linear
        } else {
            wgpu::FilterMode::Nearest
        };
        let sampler = self.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some(label),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: filter,
            min_filter: filter,
            ..Default::default()
        });
        Blit {
            pipeline,
            layout,
            sampler,
        }
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
                true,
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
                    | wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            self.glsl.target = Some(Target::colour(texture, size, format));
        }
    }

    /// The RGBA8 rows of `texture` (of `size`), read back now.
    fn read_input(&self, texture: &wgpu::Texture, (w, h): (u32, u32)) -> Result<Vec<u8>> {
        // What the passes recorded for the texture goes first.
        self.submit();
        let row = w * 4;
        let padded = row.next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("glsl group input readback"),
            size: u64::from(padded) * u64::from(h),
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded),
                    rows_per_image: Some(h),
                },
            },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        let submission = self.queue.submit([encoder.finish()]);
        let (tx, rx) = std::sync::mpsc::channel();
        buffer.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        self.device
            .poll(wgpu::PollType::Wait { submission_index: Some(submission), timeout: None })
            .map_err(|e| render_error(format!("GPU poll failed: {e}")))?;
        rx.recv()
            .map_err(|e| render_error(format!("readback channel closed: {e}")))?
            .map_err(|e| render_error(format!("readback map failed: {e}")))?;
        let mapped = buffer
            .slice(..)
            .get_mapped_range()
            .map_err(|e| render_error(format!("readback range failed: {e}")))?;
        let mut rgba = Vec::with_capacity(row as usize * h as usize);
        for rows in mapped.chunks(padded as usize) {
            rgba.extend_from_slice(&rows[..row as usize]);
        }
        drop(mapped);
        buffer.unmap();
        Ok(rgba)
    }

    /// Draws the recording: it is replayed into an ANGLE context, and
    /// its RGBA8 rows are written into the drawing buffer the rest of the compositor places on the canvas.
    fn glsl_draw(
        &mut self,
        content: &GlslContent,
        size: (u32, u32),
        base_dir: &Path,
        inputs: &Inputs,
    ) -> Result<()> {
        self.drawing_buffer(size, wgpu::TextureFormat::Rgba8Unorm);
        // The children the group's textures read, as the bytes ANGLE uploads: each is the picture `glsl_input` drew
        // (turned over and premultiplied as its upload asks), read back now.
        let layers = inputs
            .iter()
            .map(|(key, (_, texture))| Ok((key.clone(), self.read_input(texture, size)?)))
            .collect::<Result<crate::angle_replay::Layers>>()?;
        let rgba = crate::angle_replay::replay(content, size, base_dir, &layers).map_err(render_error)?;
        let started = crate::angle::settings().time.then(std::time::Instant::now);
        let target = self.glsl.target.as_ref().expect("made above");
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &target._texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &rgba,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(size.0 * 4),
                rows_per_image: Some(size.1),
            },
            wgpu::Extent3d {
                width: size.0,
                height: size.1,
                depth_or_array_layers: 1,
            },
        );
        if let Some(started) = started {
            eprintln!(
                "angle-time: wgpu upload (queued) {:.2} ms",
                started.elapsed().as_secs_f64() * 1e3
            );
        }
        Ok(())
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
                true,
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
}
