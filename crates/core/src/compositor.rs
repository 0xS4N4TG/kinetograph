//! Blends layer textures in linear light.
//!
//! Every intermediate image is a `Rgba16Float` texture holding linear,
//! premultiplied colour. It covers the canvas plus a margin on every side
//! (`Scene::margin`, 0 unless an effect paints outside its layer). The
//! passes live in `shaders/composite.wgsl`:
//!
//! - `to_linear`: Vello's sRGB-encoded Rgba8 output -> linear texture
//! - `blend`: backdrop + source + opacity + blend mode -> new texture
//! - `mask`: layer x the alpha or luminance of a Vello-drawn clip or gradient
//! - `matte`: layer x the alpha or luminance of another layer's texture
//! - `encode`: linear texture -> sRGB 8-bit, read back to the CPU
//!
//! `shaders/shadow.wgsl` holds the shadow effects' passes and
//! `shaders/color.wgsl` the colour filter pass; they share the bind group
//! layout, so their passes go through the same `run_pass`.
//!
//! Adding a blend mode: add a case to `blend_fn` in the shader and a
//! mapping in `mode_index`. Adding an effect: add a variant to
//! `scene::Effect` and `resolve::ResolvedEffect`, write its pass, and call it
//! from `apply_effects`.

use vello::wgpu::{self, util::DeviceExt};

use crate::blur::{self, Blur};
use crate::color::ColorMatrix;
use crate::error::{Error, Result};
use crate::resolve::{ResolvedEffect, ResolvedShadow};
use crate::scene::{BlendMode, MaskMode, MatteMode};

pub const LINEAR_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
const READBACK_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// A linear premultiplied texture the size of the canvas plus its margin.
pub struct Tex {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
}

pub struct Compositor {
    device: wgpu::Device,
    queue: wgpu::Queue,
    /// Size of every pooled texture: the canvas plus twice the margin.
    width: u32,
    height: u32,
    /// The canvas, which `read_rgba8` copies out of the middle of a texture.
    canvas: (u32, u32),
    margin: u32,
    layout: wgpu::BindGroupLayout,
    to_linear: wgpu::RenderPipeline,
    blend: wgpu::RenderPipeline,
    mask: wgpu::RenderPipeline,
    matte: wgpu::RenderPipeline,
    encode: wgpu::RenderPipeline,
    spread: wgpu::RenderPipeline,
    drop_shadow: wgpu::RenderPipeline,
    inset_shadow: wgpu::RenderPipeline,
    color: wgpu::RenderPipeline,
    blur: Blur,
    pool: Vec<Tex>,
}

impl Compositor {
    /// `width` x `height` is the canvas; textures are `margin` pixels larger
    /// on every side.
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        width: u32,
        height: u32,
        margin: u32,
    ) -> Compositor {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("composite"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/composite.wgsl").into()),
        });
        let shadow_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("shadow"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/shadow.wgsl").into()),
        });
        let color_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("color"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/color.wgsl").into()),
        });
        let texture_entry = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("composite"),
            entries: &[
                texture_entry(0),
                texture_entry(1),
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("composite"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = |shader: &wgpu::ShaderModule, entry: &str, format| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(entry),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: shader,
                    entry_point: Some("vs"),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: shader,
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
        Compositor {
            device: device.clone(),
            queue: queue.clone(),
            width: width + 2 * margin,
            height: height + 2 * margin,
            canvas: (width, height),
            margin,
            to_linear: pipeline(&shader, "fs_to_linear", LINEAR_FORMAT),
            blend: pipeline(&shader, "fs_blend", LINEAR_FORMAT),
            mask: pipeline(&shader, "fs_mask", LINEAR_FORMAT),
            matte: pipeline(&shader, "fs_matte", LINEAR_FORMAT),
            encode: pipeline(&shader, "fs_encode", READBACK_FORMAT),
            spread: pipeline(&shadow_shader, "fs_spread", LINEAR_FORMAT),
            drop_shadow: pipeline(&shadow_shader, "fs_drop", LINEAR_FORMAT),
            inset_shadow: pipeline(&shadow_shader, "fs_inset", LINEAR_FORMAT),
            color: pipeline(&color_shader, "fs_color", LINEAR_FORMAT),
            blur: Blur::new(device),
            layout,
            pool: Vec::new(),
        }
    }

    /// A texture with undefined contents, from the pool when possible.
    pub fn acquire(&mut self) -> Tex {
        self.pool
            .pop()
            .unwrap_or_else(|| new_texture(&self.device, self.width, self.height))
    }

    pub fn release(&mut self, tex: Tex) {
        self.pool.push(tex);
    }

    /// A texture filled with `color` (linear, premultiplied).
    pub fn filled(&mut self, color: [f64; 4]) -> Tex {
        let tex = self.acquire();
        let mut encoder = self.device.create_command_encoder(&Default::default());
        encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("clear"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &tex.view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color {
                        r: color[0],
                        g: color[1],
                        b: color[2],
                        a: color[3],
                    }),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        self.queue.submit([encoder.finish()]);
        tex
    }

    /// Converts a Vello output texture (Rgba8, sRGB-encoded, straight alpha)
    /// to a linear premultiplied texture.
    pub fn from_srgb8(&mut self, vello_output: &wgpu::TextureView) -> Tex {
        let target = self.acquire();
        self.pass(
            &self.to_linear,
            vello_output,
            vello_output,
            0.0,
            0,
            &target.view,
        );
        target
    }

    /// Composites `src` over `dst` with the layer's opacity and blend mode.
    /// Both inputs go back to the pool; the result is a new texture.
    pub fn blend(&mut self, dst: Tex, src: Tex, opacity: f32, mode: BlendMode) -> Tex {
        let mode = mode_index(mode);
        let target = self.acquire();
        self.pass(
            &self.blend,
            &dst.view,
            &src.view,
            opacity,
            mode,
            &target.view,
        );
        self.release(dst);
        self.release(src);
        target
    }

    /// Multiplies `src` by the alpha or luminance of a Vello output texture
    /// (Rgba8): a clip shape drawn in opaque white, or a gradient. `src`
    /// goes back to the pool; the result is a new texture.
    pub fn mask(&mut self, src: Tex, vello_output: &wgpu::TextureView, mode: MaskMode) -> Tex {
        let mode = match mode {
            MaskMode::Alpha => 0,
            MaskMode::Luminance => 2,
        };
        let target = self.acquire();
        self.pass(&self.mask, &src.view, vello_output, 0.0, mode, &target.view);
        self.release(src);
        target
    }

    /// Multiplies `src` by what the matte source `matte` keeps, after
    /// scaling the matte by `matte_opacity`. Both inputs go back to the pool;
    /// the result is a new texture.
    pub fn matte(&mut self, src: Tex, matte: Tex, matte_opacity: f32, mode: MatteMode) -> Tex {
        let mode = match mode {
            MatteMode::Alpha => 0,
            MatteMode::AlphaInverted => 1,
            MatteMode::Luminance => 2,
            MatteMode::LuminanceInverted => 3,
        };
        let target = self.acquire();
        self.pass(
            &self.matte,
            &src.view,
            &matte.view,
            matte_opacity,
            mode,
            &target.view,
        );
        self.release(src);
        self.release(matte);
        target
    }

    /// Runs a layer's effects, in order, on its own texture before it is
    /// blended. Each effect should read `src`, draw into a texture from
    /// `acquire`, release `src` and return the new one.
    pub fn apply_effects(&mut self, mut src: Tex, effects: &[ResolvedEffect]) -> Tex {
        for effect in effects {
            match *effect {
                ResolvedEffect::Blur { radius } if radius >= blur::MIN_RADIUS => {
                    let dst = self.acquire();
                    self.blur.run(
                        &self.device,
                        &self.queue,
                        &src.view,
                        &dst.view,
                        (self.width, self.height),
                        radius,
                    );
                    self.release(src);
                    src = dst;
                }
                ResolvedEffect::Blur { .. } => {}
                ResolvedEffect::DropShadow(shadow) => src = self.shadow(src, &shadow, false),
                ResolvedEffect::InsetShadow(shadow) => src = self.shadow(src, &shadow, true),
                ResolvedEffect::ColorMatrix(matrix) if matrix == ColorMatrix::IDENTITY => {}
                ResolvedEffect::ColorMatrix(matrix) => src = self.color_matrix(src, &matrix),
            }
        }
        src
    }

    /// Runs a colour filter over `src` in one pass. `src` goes back to the
    /// pool; the result is a new texture.
    fn color_matrix(&mut self, src: Tex, matrix: &ColorMatrix) -> Tex {
        let target = self.acquire();
        self.run_pass(
            &self.color,
            &src.view,
            &src.view,
            &floats(&matrix_values(matrix)),
            &target.view,
        );
        self.release(src);
        target
    }

    /// Adds a drop shadow under `src`, or an inset shadow over it. `src`
    /// goes back to the pool; the result is a new texture.
    ///
    /// Both are built from the layer's alpha: grown by the spread, blurred,
    /// then shifted by the offset and tinted in the last pass. An inset
    /// shadow comes from the alpha inverted, so the spread there shrinks the
    /// layer's opaque area instead of growing it.
    fn shadow(&mut self, src: Tex, shadow: &ResolvedShadow, inset: bool) -> Tex {
        let spread = if inset { -shadow.spread } else { shadow.spread };
        let alpha = self.shadow_alpha(&src, spread, shadow.blur, inset);
        let [r, g, b, a] = shadow.color.linear_premultiplied();
        let params = floats(&[
            0.0, 0.0, 0.0, 0.0, shadow.x, shadow.y, 0.0, 0.0, r as f32, g as f32, b as f32,
            a as f32,
        ]);
        let target = self.acquire();
        let pipeline = if inset {
            &self.inset_shadow
        } else {
            &self.drop_shadow
        };
        // With no spread, inversion or blur the shadow is just `src`'s alpha.
        let alpha_view = alpha.as_ref().map_or(&src.view, |t| &t.view);
        self.run_pass(pipeline, &src.view, alpha_view, &params, &target.view);
        if let Some(alpha) = alpha {
            self.release(alpha);
        }
        self.release(src);
        target
    }

    /// The alpha of `src` grown by `spread` pixels (shrunk when negative),
    /// inverted if asked, then blurred, in the alpha channel of a new
    /// texture. `None` when none of that changes anything: the alpha of
    /// `src` itself is what is wanted.
    fn shadow_alpha(&mut self, src: &Tex, spread: f32, blur: f32, invert: bool) -> Option<Tex> {
        let blurred = blur >= blur::MIN_RADIUS;
        let mut current: Option<Tex> = None;
        if spread != 0.0 {
            let horizontal = self.acquire();
            self.spread_pass(&src.view, spread, [1.0, 0.0], false, &horizontal.view);
            current = Some(horizontal);
        }
        if spread != 0.0 || invert {
            let target = self.acquire();
            let input = current.as_ref().map_or(&src.view, |t| &t.view);
            self.spread_pass(input, spread, [0.0, 1.0], invert, &target.view);
            if let Some(done) = current.replace(target) {
                self.release(done);
            }
        }
        if blurred {
            let target = self.acquire();
            let input = current.as_ref().map_or(&src.view, |t| &t.view);
            let size = (self.width, self.height);
            self.blur
                .run(&self.device, &self.queue, input, &target.view, size, blur);
            if let Some(done) = current.replace(target) {
                self.release(done);
            }
        }
        current
    }

    /// One axis of the spread filter (see `shaders/shadow.wgsl`).
    fn spread_pass(
        &self,
        input: &wgpu::TextureView,
        spread: f32,
        axis: [f32; 2],
        invert: bool,
        target: &wgpu::TextureView,
    ) {
        let params = floats(&[
            spread,
            axis[0],
            axis[1],
            f32::from(u8::from(invert)),
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
        ]);
        self.run_pass(&self.spread, input, input, &params, target);
    }

    /// Encodes a linear texture to sRGB and reads it back as tightly packed
    /// RGBA8 with straight alpha.
    pub fn read_rgba8(&mut self, image: &Tex) -> Result<Vec<u8>> {
        let (canvas_width, canvas_height) = self.canvas;
        let target = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("readback"),
            size: wgpu::Extent3d {
                width: self.width,
                height: self.height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: READBACK_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());
        self.pass(&self.encode, &image.view, &image.view, 0.0, 0, &target_view);

        let row_bytes = canvas_width * 4;
        let padded_row = row_bytes.next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: u64::from(padded_row) * u64::from(canvas_height),
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        // Only the canvas, which sits in the middle of the margin.
        let mut source = target.as_image_copy();
        source.origin = wgpu::Origin3d {
            x: self.margin,
            y: self.margin,
            z: 0,
        };
        encoder.copy_texture_to_buffer(
            source,
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_row),
                    rows_per_image: Some(canvas_height),
                },
            },
            wgpu::Extent3d {
                width: canvas_width,
                height: canvas_height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit([encoder.finish()]);

        let (tx, rx) = std::sync::mpsc::channel();
        buffer.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|e| Error::Render(format!("GPU poll failed: {e}")))?;
        rx.recv()
            .map_err(|e| Error::Render(format!("readback channel closed: {e}")))?
            .map_err(|e| Error::Render(format!("readback map failed: {e}")))?;

        let mapped = buffer
            .slice(..)
            .get_mapped_range()
            .map_err(|e| Error::Render(format!("readback range failed: {e}")))?;
        let mut pixels = Vec::with_capacity((row_bytes * canvas_height) as usize);
        for row in mapped.chunks(padded_row as usize) {
            pixels.extend_from_slice(&row[..row_bytes as usize]);
        }
        drop(mapped);
        buffer.unmap();
        Ok(pixels)
    }

    /// One full-screen pass over `target` with `a` and `b` as inputs.
    fn pass(
        &self,
        pipeline: &wgpu::RenderPipeline,
        a: &wgpu::TextureView,
        b: &wgpu::TextureView,
        opacity: f32,
        mode: u32,
        target: &wgpu::TextureView,
    ) {
        let mut bytes = [0u8; 16];
        bytes[0..4].copy_from_slice(&opacity.to_le_bytes());
        bytes[4..8].copy_from_slice(&mode.to_le_bytes());
        self.run_pass(pipeline, a, b, &bytes, target);
    }

    /// Like `pass`, with the shader's whole uniform block given as bytes.
    fn run_pass(
        &self,
        pipeline: &wgpu::RenderPipeline,
        a: &wgpu::TextureView,
        b: &wgpu::TextureView,
        params: &[u8],
        target: &wgpu::TextureView,
    ) {
        let uniform = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("params"),
                contents: params,
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("composite"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(a),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(b),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: uniform.as_entire_binding(),
                },
            ],
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("composite"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
        self.queue.submit([encoder.finish()]);
    }
}

/// A linear texture of any size that can be drawn to and read.
pub(crate) fn new_texture(device: &wgpu::Device, width: u32, height: u32) -> Tex {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("layer"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: LINEAR_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    Tex { texture, view }
}

/// Little-endian bytes of a uniform block made of `f32`s.
fn floats(values: &[f32]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// A colour matrix as `shaders/color.wgsl` reads it: the four rows of
/// coefficients, then the four offsets.
fn matrix_values(matrix: &ColorMatrix) -> [f32; 20] {
    let mut values = [0.0; 20];
    for (i, row) in matrix.0.iter().enumerate() {
        for (j, value) in row[..4].iter().enumerate() {
            values[i * 4 + j] = *value as f32;
        }
        values[16 + i] = row[4] as f32;
    }
    values
}

/// The number the shader's `blend_fn` switches on.
fn mode_index(mode: BlendMode) -> u32 {
    match mode {
        BlendMode::Normal => 0,
        BlendMode::Multiply => 1,
        BlendMode::Screen => 2,
        BlendMode::Overlay => 3,
        BlendMode::Darken => 4,
        BlendMode::Lighten => 5,
        BlendMode::ColorDodge => 6,
        BlendMode::ColorBurn => 7,
        BlendMode::HardLight => 8,
        BlendMode::SoftLight => 9,
        BlendMode::Difference => 10,
        BlendMode::Exclusion => 11,
        BlendMode::Hue => 12,
        BlendMode::Saturation => 13,
        BlendMode::Color => 14,
        BlendMode::Luminosity => 15,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matrix_values_put_coefficients_first_and_offsets_last() {
        let values = matrix_values(&ColorMatrix::invert(1.0));
        assert_eq!(
            values,
            [
                -1.0, 0.0, 0.0, 0.0, //
                0.0, -1.0, 0.0, 0.0, //
                0.0, 0.0, -1.0, 0.0, //
                0.0, 0.0, 0.0, 1.0, //
                1.0, 1.0, 1.0, 0.0,
            ]
        );
    }
}
