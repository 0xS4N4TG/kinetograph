//! Gaussian-like blur by dual Kawase filtering (`shaders/blur.wgsl`).
//!
//! The layer is copied into the middle of a transparent texture that is
//! `3 * radius` larger on every side, so the blur fades out past the layer's
//! edge instead of smearing the border pixels. That texture is downsampled
//! `n` times and upsampled back; the last upsample writes the original
//! canvas-sized region.
//!
//! With `n` levels and tap offset `o` (in texels), the chain spreads a point
//! by `sigma^2 = S * (11/6 * o^2 + 1)` pixels squared, where
//! `S = (4^n - 1) / 3`. The `11/6 * o^2` part is the tap spread. The `1`
//! comes from the bilinear filtering and was confirmed by measurement
//! (`tests/blur.rs`). `plan` takes the largest `n` whose `S` does not exceed
//! `radius^2` and solves for `o`, so the radius is continuous and can be
//! keyframed. The filter is not shift invariant: small details can drift by
//! a fraction of a texel of the coarsest level.

use vello::wgpu::{self, util::DeviceExt};

use crate::compositor::{LINEAR_FORMAT, new_texture};

/// Blurs below this many pixels are skipped: the smallest chain already
/// spreads by about one pixel.
pub const MIN_RADIUS: f32 = 1.0;

pub struct Blur {
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    pad: wgpu::RenderPipeline,
    down: wgpu::RenderPipeline,
    up: wgpu::RenderPipeline,
}

impl Blur {
    pub fn new(device: &wgpu::Device) -> Blur {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("blur"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/blur.wgsl").into()),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("blur"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
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
            label: Some("blur"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = |entry: &str| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(entry),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs"),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(entry),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: LINEAR_FORMAT,
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
        Blur {
            sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            }),
            pad: pipeline("fs_pad"),
            down: pipeline("fs_down"),
            up: pipeline("fs_up"),
            layout,
        }
    }

    /// Blurs `src` into `dst`, both `width` x `height` linear textures.
    pub fn run(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        src: &wgpu::TextureView,
        dst: &wgpu::TextureView,
        (width, height): (u32, u32),
        radius: f32,
    ) {
        let (levels, offset) = plan(radius);
        let step = 1u32 << levels;
        let pad = (3.0 * radius).ceil() as u32;
        // Rounded up so every level is exactly half the size of the last.
        let padded = (
            (width + 2 * pad).next_multiple_of(step),
            (height + 2 * pad).next_multiple_of(step),
        );

        // chain[k] is the padded image shrunk 2^k times.
        let chain: Vec<_> = (0..=levels)
            .map(|k| new_texture(device, padded.0 >> k, padded.1 >> k))
            .collect();
        let size = |k: u32| [(padded.0 >> k) as f32, (padded.1 >> k) as f32];
        let origin = pad as f32;

        let mut encoder = device.create_command_encoder(&Default::default());
        let mut draw = |pipeline, input: &wgpu::TextureView, target, offset, origin, size| {
            self.draw(
                device,
                &mut encoder,
                pipeline,
                input,
                target,
                offset,
                origin,
                size,
            );
        };
        draw(&self.pad, src, &chain[0].view, 0.0, origin, size(0));
        for k in 1..=levels {
            let input = &chain[k as usize - 1].view;
            draw(
                &self.down,
                input,
                &chain[k as usize].view,
                offset,
                0.0,
                size(k),
            );
        }
        for k in (2..=levels).rev() {
            let input = &chain[k as usize].view;
            draw(
                &self.up,
                input,
                &chain[k as usize - 1].view,
                offset,
                0.0,
                size(k - 1),
            );
        }
        draw(&self.up, &chain[1].view, dst, offset, origin, size(0));
        queue.submit([encoder.finish()]);
    }

    /// One full-screen pass. `origin` and `size` fill the shader's params.
    #[allow(clippy::too_many_arguments)]
    fn draw(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        pipeline: &wgpu::RenderPipeline,
        input: &wgpu::TextureView,
        target: &wgpu::TextureView,
        offset: f32,
        origin: f32,
        size: [f32; 2],
    ) {
        let params: [f32; 8] = [offset, origin, origin, 0.0, size[0], size[1], 0.0, 0.0];
        let bytes: Vec<u8> = params.iter().flat_map(|v| v.to_le_bytes()).collect();
        let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("blur params"),
            contents: &bytes,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("blur"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(input),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: uniform.as_entire_binding(),
                },
            ],
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("blur"),
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
}

/// Number of down/up levels and the tap offset (in texels) for a radius.
fn plan(radius: f32) -> (u32, f32) {
    let spread = |levels: u32| (4f32.powi(levels as i32) - 1.0) / 3.0;
    let mut levels = 1;
    while spread(levels + 1) <= radius * radius {
        levels += 1;
    }
    let offset_squared = (radius * radius / spread(levels) - 1.0) * 6.0 / 11.0;
    (levels, offset_squared.sqrt())
}

#[cfg(test)]
mod tests {
    use super::plan;

    #[test]
    fn offset_stays_small() {
        for radius in [1.0, 1.35, 2.0, 2.3, 3.0, 12.0, 64.0, 128.0] {
            let (levels, offset) = plan(radius);
            assert!(levels >= 1);
            assert!((0.0..=1.3).contains(&offset), "radius {radius}: {offset}");
        }
    }
}
