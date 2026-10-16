//! The 3D layer's pass: a `scene3d::draw::DrawScene` drawn with a depth buffer
//! (`shaders/scene3d.wgsl`) into a texture the size of the padded canvas.
//!
//! Meshes and textures are uploaded the first time they are drawn and kept
//! while the CPU side holds them (`Weak`), so a mesh that is built once (a
//! primitive, a model, a line of text) is uploaded once.

use std::collections::HashMap;
use std::sync::{Arc, Weak};

use glam::DMat3;
use vello::kurbo::Affine;
use vello::wgpu::util::TextureDataOrder;

use super::*;
use crate::scene3d::MAX_SHADOW_LIGHTS;
use crate::scene3d::draw::{DrawItem, DrawScene, Texture};
use crate::scene3d::mesh::{MeshData, VERTEX_BYTES, Vertex3};

/// Bytes of the per-draw block in `shaders/scene3d.wgsl`.
const DRAW_BYTES: u64 = 176;
const DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;

/// What the 3D pass keeps between frames.
pub(super) struct State {
    shader: wgpu::ShaderModule,
    frame_layout: wgpu::BindGroupLayout,
    draw_layout: wgpu::BindGroupLayout,
    texture_layout: wgpu::BindGroupLayout,
    pipeline_layout: wgpu::PipelineLayout,
    /// The shadow pass: depth only, from `shaders/scene3d_shadow.wgsl`.
    shadow_pipeline: wgpu::RenderPipeline,
    /// Its group 0: the light's matrix.
    shadow_layout: wgpu::BindGroupLayout,
    /// The shadow maps of the lights that cast shadows, by slot.
    shadow_maps: [Option<ShadowMap>; MAX_SHADOW_LIGHTS],
    /// Bound for the slots that hold no map: one texel, never read.
    empty_shadow: wgpu::TextureView,
    shadow_sampler: wgpu::Sampler,
    sampler: wgpu::Sampler,
    /// Opaque and blended pipelines, by samples per pixel.
    pipelines: HashMap<u32, (wgpu::RenderPipeline, wgpu::RenderPipeline)>,
    /// The multisampled colour and the depth, by samples per pixel, at the
    /// padded canvas's size.
    targets: HashMap<u32, Target>,
    meshes: HashMap<u64, GpuMesh>,
    textures: HashMap<u64, GpuTexture>,
    /// The bind group of items with no texture: one white texel.
    white: wgpu::BindGroup,
}

struct Target {
    size: [u32; 2],
    colour: Option<wgpu::TextureView>,
    depth: wgpu::TextureView,
}

struct GpuMesh {
    owner: Weak<MeshData>,
    vertices: wgpu::Buffer,
    indices: wgpu::Buffer,
    count: u32,
}

struct GpuTexture {
    owner: Weak<Texture>,
    group: wgpu::BindGroup,
}

struct ShadowMap {
    size: u32,
    view: wgpu::TextureView,
}

fn shadow_map_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Depth,
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    }
}

fn shadow_texture(device: &wgpu::Device, size: u32) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("scene3d shadow map"),
        size: wgpu::Extent3d {
            width: size,
            height: size,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: DEPTH_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
}

impl State {
    fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> State {
        let shader = shader_module(device, "scene3d", include_str!("../shaders/scene3d.wgsl"));
        let uniform = |binding, visibility, dynamic, size: u64| wgpu::BindGroupLayoutEntry {
            binding,
            visibility,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: dynamic,
                min_binding_size: wgpu::BufferSize::new(size),
            },
            count: None,
        };
        let both = wgpu::ShaderStages::VERTEX_FRAGMENT;
        let frame_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("scene3d frame"),
            entries: &[
                uniform(0, both, false, FRAME_BYTES),
                shadow_map_entry(1),
                shadow_map_entry(2),
                shadow_map_entry(3),
                shadow_map_entry(4),
                wgpu::BindGroupLayoutEntry {
                    binding: 5,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Comparison),
                    count: None,
                },
            ],
        });
        let shadow_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("scene3d shadow"),
            entries: &[uniform(0, wgpu::ShaderStages::VERTEX, false, 64)],
        });
        let draw_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("scene3d draw"),
            entries: &[uniform(0, both, true, DRAW_BYTES)],
        });
        let texture_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("scene3d texture"),
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
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("scene3d"),
            bind_group_layouts: &[
                Some(&frame_layout),
                Some(&draw_layout),
                Some(&texture_layout),
            ],
            immediate_size: 0,
        });
        let shadow_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("scene3d shadow"),
                bind_group_layouts: &[Some(&shadow_layout), Some(&draw_layout)],
                immediate_size: 0,
            });
        let shadow_shader = shader_module(
            device,
            "scene3d shadow",
            include_str!("../shaders/scene3d_shadow.wgsl"),
        );
        let shadow_attributes = wgpu::vertex_attr_array![0 => Float32x3];
        let shadow_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("scene3d shadow"),
            layout: Some(&shadow_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shadow_shader,
                entry_point: Some("vs_shadow"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: VERTEX_BYTES,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &shadow_attributes,
                })],
            },
            fragment: None,
            // Both faces cast: a closed mesh's back faces are the deeper
            // ones, and the biases keep the near ones from shading
            // themselves.
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DEPTH_FORMAT,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::Less),
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        let shadow_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("scene3d shadow"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            compare: Some(wgpu::CompareFunction::LessEqual),
            ..Default::default()
        });
        let empty_shadow = shadow_texture(device, 1).create_view(&Default::default());
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("scene3d"),
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::Repeat,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });
        let white = upload_texture(
            device,
            queue,
            &texture_layout,
            &sampler,
            &Texture::new(1, 1, vec![255; 4]),
        );
        State {
            shader,
            frame_layout,
            draw_layout,
            texture_layout,
            pipeline_layout,
            shadow_pipeline,
            shadow_layout,
            shadow_maps: Default::default(),
            empty_shadow,
            shadow_sampler,
            sampler,
            pipelines: HashMap::new(),
            targets: HashMap::new(),
            meshes: HashMap::new(),
            textures: HashMap::new(),
            white,
        }
    }

    fn pipelines(
        &mut self,
        device: &wgpu::Device,
        samples: u32,
    ) -> &(wgpu::RenderPipeline, wgpu::RenderPipeline) {
        self.pipelines.entry(samples).or_insert_with(|| {
            let attributes =
                wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2];
            let make = |blend: bool| {
                device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some(if blend {
                        "scene3d blended"
                    } else {
                        "scene3d opaque"
                    }),
                    layout: Some(&self.pipeline_layout),
                    vertex: wgpu::VertexState {
                        module: &self.shader,
                        entry_point: Some("vs_main"),
                        compilation_options: Default::default(),
                        buffers: &[Some(wgpu::VertexBufferLayout {
                            array_stride: VERTEX_BYTES,
                            step_mode: wgpu::VertexStepMode::Vertex,
                            attributes: &attributes,
                        })],
                    },
                    fragment: Some(wgpu::FragmentState {
                        module: &self.shader,
                        entry_point: Some("fs_main"),
                        compilation_options: Default::default(),
                        targets: &[Some(wgpu::ColorTargetState {
                            format: LINEAR_FORMAT,
                            blend: blend.then_some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                            write_mask: wgpu::ColorWrites::ALL,
                        })],
                    }),
                    // Back faces are discarded in the shader, which can tell
                    // them apart from front faces when the picture is
                    // mirrored.
                    primitive: wgpu::PrimitiveState::default(),
                    depth_stencil: Some(wgpu::DepthStencilState {
                        format: DEPTH_FORMAT,
                        depth_write_enabled: Some(!blend),
                        depth_compare: Some(wgpu::CompareFunction::Less),
                        stencil: Default::default(),
                        bias: Default::default(),
                    }),
                    multisample: wgpu::MultisampleState {
                        count: samples,
                        mask: !0,
                        alpha_to_coverage_enabled: false,
                    },
                    multiview_mask: None,
                    cache: None,
                })
            };
            (make(false), make(true))
        })
    }

    fn target(&mut self, device: &wgpu::Device, samples: u32, size: [u32; 2]) -> &Target {
        let stale = self.targets.get(&samples).is_none_or(|t| t.size != size);
        if stale {
            let extent = wgpu::Extent3d {
                width: size[0],
                height: size[1],
                depth_or_array_layers: 1,
            };
            let make = |format, label| {
                device
                    .create_texture(&wgpu::TextureDescriptor {
                        label: Some(label),
                        size: extent,
                        mip_level_count: 1,
                        sample_count: samples,
                        dimension: wgpu::TextureDimension::D2,
                        format,
                        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                        view_formats: &[],
                    })
                    .create_view(&wgpu::TextureViewDescriptor::default())
            };
            self.targets.insert(
                samples,
                Target {
                    size,
                    colour: (samples > 1).then(|| make(LINEAR_FORMAT, "scene3d samples")),
                    depth: make(DEPTH_FORMAT, "scene3d depth"),
                },
            );
        }
        &self.targets[&samples]
    }

    /// Makes the shadow maps `scene` needs, one a slot, and frees the others.
    fn shadow_maps(&mut self, device: &wgpu::Device, scene: &DrawScene) {
        let mut wanted = [None; MAX_SHADOW_LIGHTS];
        for (slot, shadow) in scene.shadows() {
            wanted[slot] = Some(shadow.map_size);
        }
        for (held, wanted) in self.shadow_maps.iter_mut().zip(wanted) {
            if held.as_ref().map(|m| m.size) != wanted {
                *held = wanted.map(|size| ShadowMap {
                    size,
                    view: shadow_texture(device, size).create_view(&Default::default()),
                });
            }
        }
    }

    /// Uploads what `scene` draws that is not on the GPU yet, and forgets
    /// what the CPU side has let go of.
    fn upload(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, scene: &DrawScene) {
        self.meshes.retain(|_, m| m.owner.strong_count() > 0);
        self.textures.retain(|_, t| t.owner.strong_count() > 0);
        for item in &scene.items {
            let mesh = &item.mesh;
            self.meshes.entry(mesh.id).or_insert_with(|| GpuMesh {
                owner: Arc::downgrade(mesh),
                vertices: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("scene3d vertices"),
                    contents: &Vertex3::bytes(&mesh.vertices),
                    usage: wgpu::BufferUsages::VERTEX,
                }),
                indices: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("scene3d indices"),
                    contents: &mesh
                        .indices
                        .iter()
                        .flat_map(|i| i.to_le_bytes())
                        .collect::<Vec<_>>(),
                    usage: wgpu::BufferUsages::INDEX,
                }),
                count: mesh.indices.len() as u32,
            });
            if let Some(texture) = &item.texture {
                self.textures
                    .entry(texture.id)
                    .or_insert_with(|| GpuTexture {
                        owner: Arc::downgrade(texture),
                        group: upload_texture(
                            device,
                            queue,
                            &self.texture_layout,
                            &self.sampler,
                            texture,
                        ),
                    });
            }
        }
    }
}

/// Bytes of the per-frame block: two matrices, the eye, the ambient light,
/// `MAX_LIGHTS` lights of three vectors and `MAX_SHADOW_LIGHTS` shadows of a
/// matrix and a vector.
const FRAME_BYTES: u64 =
    64 * 2 + 16 * 2 + (crate::scene3d::MAX_LIGHTS as u64) * 48 + (MAX_SHADOW_LIGHTS as u64) * 80;

fn upload_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    layout: &wgpu::BindGroupLayout,
    sampler: &wgpu::Sampler,
    texture: &Texture,
) -> wgpu::BindGroup {
    let mips = texture.mips();
    let data: Vec<u8> = mips
        .iter()
        .flat_map(|(_, _, level)| level.iter().copied())
        .collect();
    let gpu = device.create_texture_with_data(
        queue,
        &wgpu::TextureDescriptor {
            label: Some("scene3d texture"),
            size: wgpu::Extent3d {
                width: texture.width,
                height: texture.height,
                depth_or_array_layers: 1,
            },
            mip_level_count: mips.len() as u32,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        },
        TextureDataOrder::LayerMajor,
        &data,
    );
    let view = gpu.create_view(&wgpu::TextureViewDescriptor::default());
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("scene3d texture"),
        layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::Sampler(sampler),
            },
        ],
    })
}

/// The layer's 2D matrix as a clip-space matrix, applied after the camera:
/// the layer box (`size`, in layer pixels) to the texels of a padded canvas
/// `texture` pixels across, `matrix` between. x and y of the result are
/// `m[0] . (x, y, z, w)` and `m[1] . (...)`; z and w pass through.
pub(super) fn placement(size: (f64, f64), matrix: Affine, texture: (u32, u32)) -> glam::Mat4 {
    let [a, b, c, d, e, f] = matrix.as_coeffs();
    let (w, h) = size;
    let (tw, th) = (f64::from(texture.0), f64::from(texture.1));
    // Clip space (y up) to layer pixels (y down), the layer's matrix, then
    // texels to clip space.
    let to_pixels =
        DMat3::from_cols_array(&[w / 2.0, 0.0, 0.0, 0.0, -h / 2.0, 0.0, w / 2.0, h / 2.0, 1.0]);
    let layer = DMat3::from_cols_array(&[a, b, 0.0, c, d, 0.0, e, f, 1.0]);
    let to_clip =
        DMat3::from_cols_array(&[2.0 / tw, 0.0, 0.0, 0.0, -2.0 / th, 0.0, -1.0, 1.0, 1.0]);
    let p = to_clip * layer * to_pixels;
    // Rows of `p` act on (x, y, w); the 4x4 acts on (x, y, z, w).
    glam::Mat4::from_cols_array(&[
        p.x_axis.x as f32,
        p.x_axis.y as f32,
        0.0,
        0.0,
        p.y_axis.x as f32,
        p.y_axis.y as f32,
        0.0,
        0.0,
        0.0,
        0.0,
        1.0,
        0.0,
        p.z_axis.x as f32,
        p.z_axis.y as f32,
        0.0,
        1.0,
    ])
}

fn push(out: &mut Vec<u8>, values: &[f32]) {
    out.extend(values.iter().flat_map(|v| v.to_le_bytes()));
}

fn push_mat4(out: &mut Vec<u8>, m: &glam::Mat4) {
    push(out, &m.to_cols_array());
}

fn frame_bytes(scene: &DrawScene, place: &glam::Mat4, mirrored: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(FRAME_BYTES as usize);
    push_mat4(&mut out, &scene.view_proj);
    push_mat4(&mut out, place);
    push(
        &mut out,
        &[
            scene.eye.x,
            scene.eye.y,
            scene.eye.z,
            f32::from(u8::from(mirrored)),
        ],
    );
    push(
        &mut out,
        &[
            scene.ambient[0],
            scene.ambient[1],
            scene.ambient[2],
            scene.lights.len() as f32,
        ],
    );
    let mut next_slot = 0;
    for i in 0..crate::scene3d::MAX_LIGHTS {
        match scene.lights.get(i) {
            Some(l) => {
                push(
                    &mut out,
                    &[
                        l.vector[0],
                        l.vector[1],
                        l.vector[2],
                        f32::from(u8::from(l.point)),
                    ],
                );
                push(&mut out, &[l.color[0], l.color[1], l.color[2], l.range]);
                // The slot of its shadow map, as `DrawScene::shadows` counts.
                let slot = l.shadow.map_or(-1.0, |_| {
                    next_slot += 1;
                    (next_slot - 1) as f32
                });
                push(&mut out, &[slot, 0.0, 0.0, 0.0]);
            }
            None => push(
                &mut out,
                &[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0],
            ),
        }
    }
    for slot in 0..MAX_SHADOW_LIGHTS {
        match scene.shadows().find(|(s, _)| *s == slot) {
            Some((_, shadow)) => {
                push_mat4(&mut out, &shadow.view_proj);
                push(
                    &mut out,
                    &[
                        shadow.bias,
                        shadow.normal_bias,
                        shadow.radius,
                        1.0 / shadow.map_size as f32,
                    ],
                );
            }
            None => push(&mut out, &[0.0; 20]),
        }
    }
    debug_assert_eq!(out.len() as u64, FRAME_BYTES);
    out
}

fn draw_bytes(item: &DrawItem) -> Vec<u8> {
    let mut out = Vec::with_capacity(DRAW_BYTES as usize);
    push_mat4(&mut out, &item.model);
    let n = item.normal.to_cols_array_2d();
    for col in n {
        push(&mut out, &[col[0], col[1], col[2], 0.0]);
    }
    push(&mut out, &[0.0, 0.0, 0.0, 1.0]);
    let m = &item.material;
    push(&mut out, &m.color);
    push(
        &mut out,
        &[m.emissive[0], m.emissive[1], m.emissive[2], 0.0],
    );
    let flags = u8::from(m.unlit)
        | (u8::from(m.double_sided) << 1)
        | (u8::from(item.mirrored) << 2)
        | (u8::from(item.receive_shadow) << 3);
    push(&mut out, &[m.metallic, m.roughness, f32::from(flags), 0.0]);
    debug_assert_eq!(out.len() as u64, DRAW_BYTES);
    out
}

impl Compositor {
    /// Draws `scene` into a new texture the size of the padded canvas, the
    /// layer box mapped to it by `matrix` (layer pixels to texels). Only
    /// `bounds`, the box's image on the canvas, can be non-zero afterwards.
    pub fn scene3d(&mut self, scene: &DrawScene, matrix: Affine, bounds: PixelRect) -> Tex {
        let mut target = self.target_full(bounds);
        let place = placement(scene.size, matrix, (self.width, self.height));
        let mirrored = matrix.determinant() < 0.0;
        let mut state = self
            .scene3d
            .take()
            .unwrap_or_else(|| State::new(&self.device, &self.queue));
        state.upload(&self.device, &self.queue, scene);
        state.shadow_maps(&self.device, scene);
        state.pipelines(&self.device, scene.msaa);
        state.target(&self.device, scene.msaa, [self.width, self.height]);

        let frame = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("scene3d frame"),
                contents: &frame_bytes(scene, &place, mirrored),
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let shadow_view = |slot: usize| {
            state.shadow_maps[slot]
                .as_ref()
                .map_or(&state.empty_shadow, |m| &m.view)
        };
        let frame_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("scene3d frame"),
            layout: &state.frame_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: frame.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(shadow_view(0)),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(shadow_view(1)),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(shadow_view(2)),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::TextureView(shadow_view(3)),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: wgpu::BindingResource::Sampler(&state.shadow_sampler),
                },
            ],
        });
        // One block per item at dynamic offsets.
        let align = u64::from(self.device.limits().min_uniform_buffer_offset_alignment);
        let stride = DRAW_BYTES.div_ceil(align) * align;
        let mut blocks = vec![0_u8; stride as usize * scene.items.len().max(1)];
        for (i, item) in scene.items.iter().enumerate() {
            let at = i * stride as usize;
            blocks[at..at + DRAW_BYTES as usize].copy_from_slice(&draw_bytes(item));
        }
        let draws = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("scene3d draws"),
                contents: &blocks,
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let draw_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("scene3d draw"),
            layout: &state.draw_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: &draws,
                    offset: 0,
                    size: wgpu::BufferSize::new(DRAW_BYTES),
                }),
            }],
        });

        // The shadow maps first: each a depth-only pass over the casters,
        // with the draw blocks of the main pass.
        let light_views: Vec<_> = scene
            .shadows()
            .map(|(_, shadow)| {
                let buffer = self
                    .device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("scene3d light"),
                        contents: &shadow
                            .view_proj
                            .to_cols_array()
                            .map(f32::to_le_bytes)
                            .concat(),
                        usage: wgpu::BufferUsages::UNIFORM,
                    });
                self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("scene3d light"),
                    layout: &state.shadow_layout,
                    entries: &[wgpu::BindGroupEntry {
                        binding: 0,
                        resource: buffer.as_entire_binding(),
                    }],
                })
            })
            .collect();
        {
            let mut encoder = self.encoder();
            for (slot, light_view) in light_views.iter().enumerate() {
                let map = state.shadow_maps[slot]
                    .as_ref()
                    .expect("made by shadow_maps");
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("scene3d shadow"),
                    color_attachments: &[],
                    depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                        view: &map.view,
                        depth_ops: Some(wgpu::Operations {
                            load: wgpu::LoadOp::Clear(1.0),
                            store: wgpu::StoreOp::Store,
                        }),
                        stencil_ops: None,
                    }),
                    ..Default::default()
                });
                pass.set_pipeline(&state.shadow_pipeline);
                pass.set_bind_group(0, light_view, &[]);
                for (i, item) in scene
                    .items
                    .iter()
                    .enumerate()
                    .filter(|(_, i)| i.cast_shadow)
                {
                    let mesh = &state.meshes[&item.mesh.id];
                    pass.set_bind_group(1, &draw_group, &[(i as u64 * stride) as u32]);
                    pass.set_vertex_buffer(0, mesh.vertices.slice(..));
                    pass.set_index_buffer(mesh.indices.slice(..), wgpu::IndexFormat::Uint32);
                    pass.draw_indexed(0..mesh.count, 0, 0..1);
                }
            }
        }

        {
            let (opaque, blended) = &state.pipelines[&scene.msaa];
            let attachments = &state.targets[&scene.msaa];
            let stamp = self.stamp("scene3d", &target.view);
            let mut encoder = self.encoder();
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("scene3d"),
                color_attachments: &[Some(match &attachments.colour {
                    Some(samples) => wgpu::RenderPassColorAttachment {
                        view: samples,
                        depth_slice: None,
                        resolve_target: Some(&target.view),
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            // Only the resolved image is wanted.
                            store: wgpu::StoreOp::Discard,
                        },
                    },
                    None => wgpu::RenderPassColorAttachment {
                        view: &target.view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            store: wgpu::StoreOp::Store,
                        },
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &attachments.depth,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Discard,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: pass_timer::writes(&stamp),
                ..Default::default()
            });
            pass.set_bind_group(0, &frame_group, &[]);
            for (i, item) in scene.items.iter().enumerate() {
                pass.set_pipeline(if i < scene.opaque { opaque } else { blended });
                let mesh = &state.meshes[&item.mesh.id];
                let texture = item
                    .texture
                    .as_ref()
                    .map_or(&state.white, |t| &state.textures[&t.id].group);
                pass.set_bind_group(1, &draw_group, &[(i as u64 * stride) as u32]);
                pass.set_bind_group(2, texture, &[]);
                pass.set_vertex_buffer(0, mesh.vertices.slice(..));
                pass.set_index_buffer(mesh.indices.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..mesh.count, 0, 0..1);
            }
        }
        self.scene3d = Some(state);
        target.bounds = bounds.intersect(self.whole());
        target
    }

    /// Drops the 3D pass's targets, which are the size of the canvas.
    pub(super) fn forget_scene3d_targets(&mut self) {
        if let Some(state) = &mut self.scene3d {
            state.targets.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Clip space (x, y) of a point after `placement`, at w = 1.
    fn through(m: &glam::Mat4, x: f32, y: f32) -> (f32, f32) {
        let p = *m * glam::Vec4::new(x, y, 0.5, 1.0);
        (p.x / p.w, p.y / p.w)
    }

    #[test]
    fn an_identity_layer_fills_the_canvas_it_is_as_big_as() {
        let m = placement((100.0, 50.0), Affine::IDENTITY, (100, 50));
        assert_eq!(through(&m, -1.0, 1.0), (-1.0, 1.0));
        assert_eq!(through(&m, 1.0, -1.0), (1.0, -1.0));
        let p = m * glam::Vec4::new(0.0, 0.0, 0.25, 2.0);
        assert_eq!((p.z, p.w), (0.25, 2.0), "depth and w pass through");
    }

    #[test]
    fn the_layer_matrix_moves_the_box() {
        // A 50x50 layer at (50, 0) in a 100x100 canvas covers the right top.
        let m = placement((50.0, 50.0), Affine::translate((50.0, 0.0)), (100, 100));
        let (x0, y0) = through(&m, -1.0, 1.0);
        let (x1, y1) = through(&m, 1.0, -1.0);
        assert!(
            (x0 - 0.0).abs() < 1e-6 && (y0 - 1.0).abs() < 1e-6,
            "{x0} {y0}"
        );
        assert!(
            (x1 - 1.0).abs() < 1e-6 && (y1 - 0.0).abs() < 1e-6,
            "{x1} {y1}"
        );
        // Scale 2 about the origin.
        let m = placement((50.0, 50.0), Affine::scale(2.0), (100, 100));
        assert!((through(&m, 1.0, -1.0).0 - 1.0).abs() < 1e-6);
    }

    #[test]
    fn frame_and_draw_blocks_have_the_sizes_the_shader_declares() {
        let scene = DrawScene {
            size: (10.0, 10.0),
            msaa: 4,
            view_proj: glam::Mat4::IDENTITY,
            eye: glam::Vec3::ZERO,
            ambient: [0.0; 3],
            lights: Vec::new(),
            items: Vec::new(),
            opaque: 0,
        };
        assert_eq!(
            frame_bytes(&scene, &glam::Mat4::IDENTITY, false).len() as u64,
            FRAME_BYTES
        );
    }
}
