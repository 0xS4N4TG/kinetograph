//! The maps image-based lighting reads, made from an environment picture
//! (`scene3d::environment::Environment`) on the GPU with `shaders/environment.wgsl`.
//! The 3D pass makes them the first time it draws a scene that names the
//! picture and keeps them (`compositor/scene3d.rs`).
//!
//! Two cube maps of 16-bit floats come out:
//!
//! - the specular map, the picture at its own resolution at level 0, and at
//!   each level below it blurred by the GGX lobe of one roughness, which grows
//!   from 0 at level 0 to 1 at the last: a surface of roughness `r` reads it
//!   at level `r * max_lod`, and a blurred background reads it too;
//! - the diffuse map, small, the picture's cosine-weighted average around
//!   each direction.
//!
//! The roughness-dependent part of the specular term needs no table: the
//! shader uses an analytic fit of it.

use wgpu::util::{DeviceExt, TextureDataOrder};

use super::{LINEAR_FORMAT, shader_module};
use crate::scene3d::environment::Environment;

/// Texels along a side of the diffuse map, which has no detail to keep.
const DIFFUSE_SIZE: u32 = 32;
/// Samples a texel of the diffuse and specular maps is made of.
const DIFFUSE_SAMPLES: f32 = 512.0;
const SPECULAR_SAMPLES: f32 = 192.0;
/// Bytes of the shader's `Params`.
const PARAMS_BYTES: u64 = 32;

/// What one pass of `environment.wgsl` is told (its `Params`).
struct Params {
    face: u32,
    /// Texels along a side of the face drawn.
    size: u32,
    roughness: f32,
    /// The level of the sky that `fs_downsample` reads.
    read_level: u32,
    /// Texels along a side of the sky at level 0.
    sky_size: u32,
    samples: f32,
}

impl Params {
    fn bytes(&self) -> Vec<u8> {
        let values = [
            self.face as f32,
            self.size as f32,
            self.roughness,
            self.read_level as f32,
            self.sky_size as f32,
            self.samples,
            0.0,
            0.0,
        ];
        values.map(f32::to_le_bytes).concat()
    }
}

pub(super) struct Baked {
    /// A cube view of every level.
    pub specular: wgpu::TextureView,
    pub diffuse: wgpu::TextureView,
    /// The last level of the specular map: the level of roughness 1.
    pub max_lod: f32,
}

/// The pipelines that make the maps; the same for every environment.
pub(super) struct Baker {
    params_layout: wgpu::BindGroupLayout,
    equirect_layout: wgpu::BindGroupLayout,
    cube_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    equirect: wgpu::RenderPipeline,
    downsample: wgpu::RenderPipeline,
    irradiance: wgpu::RenderPipeline,
    prefilter: wgpu::RenderPipeline,
}

fn texture_entry(dimension: wgpu::TextureViewDimension) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding: 0,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: dimension,
            multisampled: false,
        },
        count: None,
    }
}

impl Baker {
    pub fn new(device: &wgpu::Device) -> Baker {
        let layout = |label, entries: &[wgpu::BindGroupLayoutEntry]| {
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some(label),
                entries,
            })
        };
        let params_layout = layout(
            "environment params",
            &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(PARAMS_BYTES),
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        );
        let equirect_layout = layout(
            "environment picture",
            &[texture_entry(wgpu::TextureViewDimension::D2)],
        );
        let cube_layout = layout(
            "environment sky",
            &[texture_entry(wgpu::TextureViewDimension::Cube)],
        );
        // The picture wraps around horizontally and stops at the poles.
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("environment"),
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });
        let shader = shader_module(
            device,
            "environment",
            include_str!("../shaders/environment.wgsl"),
        );
        let pipeline_layout = |source: Option<&wgpu::BindGroupLayout>, group: usize| {
            let mut groups = vec![Some(&params_layout), None, None];
            groups[group] = source;
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("environment"),
                bind_group_layouts: &groups,
                immediate_size: 0,
            })
        };
        let equirect_pipeline_layout = pipeline_layout(Some(&equirect_layout), 1);
        let cube_pipeline_layout = pipeline_layout(Some(&cube_layout), 2);
        let pipeline = |entry, layout: &wgpu::PipelineLayout| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(entry),
                layout: Some(layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_fullscreen"),
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
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        Baker {
            equirect: pipeline("fs_equirect", &equirect_pipeline_layout),
            downsample: pipeline("fs_downsample", &cube_pipeline_layout),
            irradiance: pipeline("fs_irradiance", &cube_pipeline_layout),
            prefilter: pipeline("fs_prefilter", &cube_pipeline_layout),
            params_layout,
            equirect_layout,
            cube_layout,
            sampler,
        }
    }

    /// Records the passes that make `environment`'s maps into `encoder`.
    pub fn bake(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        environment: &Environment,
    ) -> Baked {
        let picture = device.create_texture_with_data(
            queue,
            &wgpu::TextureDescriptor {
                label: Some("environment picture"),
                size: wgpu::Extent3d {
                    width: environment.width,
                    height: environment.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: LINEAR_FORMAT,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            },
            TextureDataOrder::LayerMajor,
            &environment.texels,
        );
        let picture = self.group(
            device,
            &self.equirect_layout,
            &picture.create_view(&Default::default()),
        );
        // A cube face a quarter of the picture's width is about one texel
        // for one, around the horizon.
        let size = (environment.width / 4).next_power_of_two().clamp(16, 1024);
        let sky_levels = size.ilog2() + 1;
        // Down to 8 texels a side.
        let specular_levels = size.ilog2() - 2;
        let sky = cube(device, "environment sky", size, sky_levels);
        let specular = cube(device, "environment specular", size, specular_levels);
        let diffuse = cube(device, "environment diffuse", DIFFUSE_SIZE, 1);

        // The sky: the picture, then its mip chain, which the filtered
        // sampling of the other maps reads.
        let params = |face, face_size, roughness, read_level, samples| Params {
            face,
            size: face_size,
            roughness,
            read_level,
            sky_size: size,
            samples,
        };
        for face in 0..6 {
            let params = params(face, size, 0.0, 0, 0.0);
            for target in [&sky, &specular] {
                let target = face_view(target, 0, face);
                self.draw(
                    device,
                    encoder,
                    &self.equirect,
                    (1, &picture),
                    &params,
                    &target,
                );
            }
        }
        for level in 1..sky_levels {
            let above = self.group(
                device,
                &self.cube_layout,
                &sky.create_view(&cube_view(level - 1, 1)),
            );
            for face in 0..6 {
                let params = params(face, size >> level, 0.0, level - 1, 0.0);
                let target = face_view(&sky, level, face);
                self.draw(
                    device,
                    encoder,
                    &self.downsample,
                    (2, &above),
                    &params,
                    &target,
                );
            }
        }

        let sky_all = self.group(
            device,
            &self.cube_layout,
            &sky.create_view(&cube_view(0, sky_levels)),
        );
        for level in 1..specular_levels {
            let roughness = level as f32 / (specular_levels - 1) as f32;
            for face in 0..6 {
                let params = params(face, size >> level, roughness, 0, SPECULAR_SAMPLES);
                let target = face_view(&specular, level, face);
                self.draw(
                    device,
                    encoder,
                    &self.prefilter,
                    (2, &sky_all),
                    &params,
                    &target,
                );
            }
        }
        for face in 0..6 {
            let params = params(face, DIFFUSE_SIZE, 0.0, 0, DIFFUSE_SAMPLES);
            let target = face_view(&diffuse, 0, face);
            self.draw(
                device,
                encoder,
                &self.irradiance,
                (2, &sky_all),
                &params,
                &target,
            );
        }
        Baked {
            specular: specular.create_view(&cube_view(0, specular_levels)),
            diffuse: diffuse.create_view(&cube_view(0, 1)),
            max_lod: (specular_levels - 1) as f32,
        }
    }

    fn group(
        &self,
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        view: &wgpu::TextureView,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("environment"),
            layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(view),
            }],
        })
    }

    /// Draws one face of one level: `reads` is the group index and the bind
    /// group of the texture `pipeline` reads.
    fn draw(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        pipeline: &wgpu::RenderPipeline,
        reads: (u32, &wgpu::BindGroup),
        params: &Params,
        target: &wgpu::TextureView,
    ) {
        let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("environment params"),
            contents: &params.bytes(),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let params = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("environment params"),
            layout: &self.params_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("environment"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &params, &[]);
        pass.set_bind_group(reads.0, reads.1, &[]);
        pass.draw(0..3, 0..1);
    }
}

/// A cube map: six layers, `levels` mip levels.
fn cube(device: &wgpu::Device, label: &str, size: u32, levels: u32) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width: size,
            height: size,
            depth_or_array_layers: 6,
        },
        mip_level_count: levels,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: LINEAR_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
}

/// The view that reads `levels` levels of a cube from `first`.
fn cube_view(first: u32, levels: u32) -> wgpu::TextureViewDescriptor<'static> {
    wgpu::TextureViewDescriptor {
        dimension: Some(wgpu::TextureViewDimension::Cube),
        base_mip_level: first,
        mip_level_count: Some(levels),
        ..Default::default()
    }
}

/// The view that draws into one face of one level.
fn face_view(cube: &wgpu::Texture, level: u32, face: u32) -> wgpu::TextureView {
    cube.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(wgpu::TextureViewDimension::D2),
        base_mip_level: level,
        mip_level_count: Some(1),
        base_array_layer: face,
        array_layer_count: Some(1),
        ..Default::default()
    })
}

/// A cube map of one black texel, bound where a scene has no environment.
pub(super) fn empty_cube(device: &wgpu::Device, queue: &wgpu::Queue) -> wgpu::TextureView {
    device
        .create_texture_with_data(
            queue,
            &wgpu::TextureDescriptor {
                label: Some("environment empty"),
                size: wgpu::Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 6,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: LINEAR_FORMAT,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            },
            TextureDataOrder::LayerMajor,
            &[0; 6 * 8],
        )
        .create_view(&cube_view(0, 1))
}
