//! Gaussian blur on the GPU (`shaders/blur.wgsl`).
//!
//! The layer is copied into the middle of a transparent texture that is
//! `3 * radius` larger on every side, so the blur fades out past the layer's
//! edge instead of smearing the border pixels. That texture is shrunk `n`
//! times by a `[1 3 3 1] / 8` filter, blurred by a separable Gaussian, and
//! enlarged back by bilinear upsampling; the last upsample writes the
//! original canvas-sized region.
//!
//! `plan` picks the largest `n` that leaves the Gaussian at least
//! `MIN_SIGMA` texels wide, so the coarse grid is invisible. Shadows, which
//! are soft and faint, ask for `SHADOW_MIN_SIGMA` instead and get one more
//! level. Both the shrink
//! and the enlarge keep the centre of mass, and the Gaussian is smooth at that
//! scale, so a blurred layer tracks its position to a small fraction of a
//! pixel (`tests/blur.rs` sweeps it). The two resampling filters add
//! `(4^n - 1) / 2` pixels squared of variance, which `plan` subtracts.

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
    gauss: wgpu::RenderPipeline,
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
            gauss: pipeline("fs_gauss"),
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
        size: (u32, u32),
        radius: f32,
    ) {
        self.run_with(device, queue, src, dst, size, radius, MIN_SIGMA);
    }

    /// `run` for a shadow: the Gaussian may be as narrow as
    /// `SHADOW_MIN_SIGMA` texels, so the pyramid has one more level and
    /// every pass below the top works on a quarter of the pixels.
    pub fn run_shadow(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        src: &wgpu::TextureView,
        dst: &wgpu::TextureView,
        size: (u32, u32),
        radius: f32,
    ) {
        self.run_with(device, queue, src, dst, size, radius, SHADOW_MIN_SIGMA);
    }

    #[allow(clippy::too_many_arguments)]
    fn run_with(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        src: &wgpu::TextureView,
        dst: &wgpu::TextureView,
        (width, height): (u32, u32),
        radius: f32,
        min_sigma: f32,
    ) {
        let (levels, sigma) = plan(radius, min_sigma);
        let step = 1u32 << levels;
        let pad = (3.0 * radius).ceil() as u32;
        // Rounded up so every level is exactly half the size of the last.
        let padded = (
            (width + 2 * pad).next_multiple_of(step),
            (height + 2 * pad).next_multiple_of(step),
        );

        // chain[k] is the padded image shrunk 2^k times; `spare` takes the
        // horizontal Gaussian pass at the smallest size.
        let chain: Vec<_> = (0..=levels)
            .map(|k| new_texture(device, padded.0 >> k, padded.1 >> k))
            .collect();
        let spare = new_texture(device, padded.0 >> levels, padded.1 >> levels);
        let size = |k: u32| [(padded.0 >> k) as f32, (padded.1 >> k) as f32];
        let origin = pad as f32;

        let mut encoder = device.create_command_encoder(&Default::default());
        let mut draw = |pipeline, input, target, params| {
            self.draw(device, &mut encoder, pipeline, input, target, params);
        };
        let [w0, h0] = size(0);
        draw(
            &self.pad,
            src,
            &chain[0].view,
            [0.0, origin, origin, 0.0, w0, h0, 0.0, 0.0],
        );
        for k in 1..=levels {
            let [w, h] = size(k);
            let input = &chain[k as usize - 1].view;
            let params = [0.0, 0.0, 0.0, 0.0, w, h, 0.0, 0.0];
            draw(&self.down, input, &chain[k as usize].view, params);
        }
        // At level 0 the vertical pass is the one that writes `dst`.
        let (last, shift) = if levels == 0 {
            (dst, origin)
        } else {
            (&chain[levels as usize].view, 0.0)
        };
        let [w, h] = size(levels);
        let horizontal = [sigma, 0.0, 0.0, 0.0, w, h, 1.0, 0.0];
        draw(
            &self.gauss,
            &chain[levels as usize].view,
            &spare.view,
            horizontal,
        );
        let vertical = [sigma, shift, shift, 0.0, w, h, 0.0, 1.0];
        draw(&self.gauss, &spare.view, last, vertical);
        for k in (1..=levels).rev() {
            let [w, h] = size(k - 1);
            let input = &chain[k as usize].view;
            if k == 1 {
                draw(
                    &self.up,
                    input,
                    dst,
                    [0.0, origin, origin, 0.0, w, h, 0.0, 0.0],
                );
            } else {
                let params = [0.0, 0.0, 0.0, 0.0, w, h, 0.0, 0.0];
                draw(&self.up, input, &chain[k as usize - 1].view, params);
            }
        }
        queue.submit([encoder.finish()]);
    }

    /// One full-screen pass. `params` fills the shader's `Params`.
    fn draw(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        pipeline: &wgpu::RenderPipeline,
        input: &wgpu::TextureView,
        target: &wgpu::TextureView,
        params: [f32; 8],
    ) {
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

/// Smallest Gaussian width, in texels, that hides the coarse grid.
const MIN_SIGMA: f32 = 4.0;

/// Smallest Gaussian width for a shadow. A shadow is soft and at most as
/// strong as its colour, so it can sit on a coarser grid than a blurred
/// layer: from radius 4 on it has one more level than `MIN_SIGMA` gives.
const SHADOW_MIN_SIGMA: f32 = 2.0;

/// Number of down/up levels and the Gaussian's sigma (in texels of the
/// smallest level) for a radius, keeping the sigma at least `min_sigma`.
fn plan(radius: f32, min_sigma: f32) -> (u32, f32) {
    let mut levels = 0;
    while radius / (2u32 << levels) as f32 >= min_sigma {
        levels += 1;
    }
    let scale = 4f32.powi(levels as i32);
    let resampling = (scale - 1.0) / 2.0;
    (levels, ((radius * radius - resampling) / scale).sqrt())
}

#[cfg(test)]
mod tests {
    use super::{MIN_SIGMA, SHADOW_MIN_SIGMA, plan};

    #[test]
    fn gaussian_stays_wide_enough() {
        for radius in [1.0, 2.0, 7.9, 8.0, 12.0, 44.0, 64.0, 127.0, 128.0] {
            let (levels, sigma) = plan(radius, MIN_SIGMA);
            let narrowest = if levels == 0 { 1.0 } else { MIN_SIGMA - 0.1 };
            assert!(sigma >= narrowest, "radius {radius}: {sigma}");
            assert!(sigma < 2.0 * MIN_SIGMA, "radius {radius}: {sigma}");
        }
    }

    #[test]
    fn a_shadow_gets_one_more_level_from_radius_4() {
        for radius in [1.0, 2.0, 3.9] {
            let (levels, _) = plan(radius, SHADOW_MIN_SIGMA);
            assert_eq!(levels, plan(radius, MIN_SIGMA).0, "radius {radius}");
        }
        for radius in [4.0, 6.0, 7.9, 8.0, 12.0, 44.0, 64.0, 127.0, 128.0] {
            let (levels, sigma) = plan(radius, SHADOW_MIN_SIGMA);
            assert_eq!(levels, plan(radius, MIN_SIGMA).0 + 1, "radius {radius}");
            assert!(sigma >= SHADOW_MIN_SIGMA - 0.2, "radius {radius}: {sigma}");
            assert!(sigma < 2.0 * SHADOW_MIN_SIGMA, "radius {radius}: {sigma}");
        }
    }
}
