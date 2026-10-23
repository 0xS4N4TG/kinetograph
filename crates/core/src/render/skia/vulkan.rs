//! The Vulkan side of the Skia backend (Linux and Windows): Graphite on the VkInstance, VkPhysicalDevice, VkDevice and
//! VkQueue that wgpu made, and wgpu textures as Graphite backend textures.
//!
//! Untested at run time (no Linux or Windows machine yet); it is written to compile for both and to follow the Metal
//! recipe (`metal.rs`, `S/skia/stage1.md`) where Vulkan allows.
//!
//! # Queue and ordering
//!
//! Skia and wgpu submit to the one VkQueue, in this order each frame: wgpu (the fallback layers, then the touches
//! below) -> Skia's recording -> wgpu (the compositor's passes). Command buffers on one queue start in submission
//! order, and a pipeline barrier's first scope covers every earlier command in that order, so each side's barriers
//! order its work after the other's. Nothing waits on a fence or semaphore here, and nothing depends on timing: the
//! only CPU wait is the bounded frames-in-flight poll in `backend.rs`. `wgpu` may call `vkQueueSubmit` only from the
//! thread that renders (the napi addon locks the renderer), which is also the only thread Skia submits from: VkQueue
//! needs external synchronisation, and this is it.
//!
//! # Image layouts
//!
//! Vulkan has no implicit layouts. wgpu keeps its own record of each texture's last use and emits a barrier from that
//! use's layout to the next one's; Skia keeps its own record of each wrapped image's layout (the one given when it is
//! wrapped, then whatever its commands leave). A barrier whose old layout is not the real one is invalid, and on some
//! GPUs (AMD's compression, for one) corrupts pixels. So, each hand-off:
//!
//! * Target (Skia draws, wgpu then samples). Before every frame's Skia recording wgpu runs an empty load/store render
//!   pass on it (`Native::before_skia`). That makes wgpu's record, and the image, `COLOR_ATTACHMENT_OPTIMAL`, from
//!   whatever the compositor's last read left (`SHADER_READ_ONLY_OPTIMAL`). The texture is wrapped once, in that
//!   layout, and Skia draws into it and leaves it there: Skia's record stays `COLOR_ATTACHMENT_OPTIMAL` and so matches
//!   what the touch leaves next frame. When the compositor then samples it, wgpu's own barrier moves it to
//!   `SHADER_READ_ONLY_OPTIMAL` from `COLOR_ATTACHMENT_OPTIMAL`, which is what it really is. The first frame is the
//!   same: the creation-time clear in `backend.rs` leaves it `COLOR_ATTACHMENT_OPTIMAL`.
//! * Fallback textures (the wgpu path drew a layer, Skia samples it). Before the recording wgpu runs a pass that binds
//!   each one as a sampled texture (`Native::before_skia`), so wgpu's record and the image are
//!   `SHADER_READ_ONLY_OPTIMAL`. The image is wrapped for that frame in that layout, and Skia only reads it, so it
//!   emits no layout change and wgpu's record stays true. The compositor's later write to the recycled texture is then
//!   an ordinary `SHADER_READ_ONLY_OPTIMAL` -> `COLOR_ATTACHMENT_OPTIMAL` barrier whose first scope includes Skia's
//!   reads (they came earlier in the queue).
//!
//! Both ends use the one queue family (wgpu's), exclusive sharing, so there are no queue family ownership transfers.
//! The `TRANSFER_SRC` and `TRANSFER_DST` usage that a target claims (it has `COPY_SRC | COPY_DST` on the wgpu side too)
//! lets Graphite copy out of or into it should a blend need that; Graphite does not leave a copy's layout changed
//! after its recording.
//!
//! # What is left to Skia
//!
//! Skia is given no `VkPhysicalDeviceFeatures`, so it assumes no optional feature is enabled, whatever wgpu enabled: it
//! draws the same on every device and never relies on a feature wgpu did not turn on. It is given the extension lists
//! wgpu enabled and an API version capped at the lower of the instance's and the device's.

use std::ffi::c_void;
use std::mem::MaybeUninit;

use ash::vk::{self, Handle};
use skia_safe::gpu::{self, graphite, vk as skvk};
use vello::wgpu;
use wgpu::hal::api::Vulkan;

use super::Role;
use crate::compositor::Tex;

unsafe extern "C" {
    /// `vk_shim.cpp`: constructs a `BackendTexture` for a VkImage in `out`.
    fn kg_vk_backend_texture(
        out: *mut c_void,
        width: i32,
        height: i32,
        format: u32,
        usage: u32,
        layout: u32,
        queue_family_index: u32,
        image: u64,
    );
}

/// What `before_skia` draws with: a pass over a 1x1 target that binds a texture as a sampled one and draws nothing.
pub(super) struct Native {
    layout: wgpu::BindGroupLayout,
    pipeline: wgpu::RenderPipeline,
    sink: wgpu::TextureView,
}

impl Native {
    /// A Graphite context on `device`'s Vulkan device and `queue`'s queue.
    pub(super) fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Option<(Native, graphite::Context)> {
        // SAFETY: the raw handles stay alive as long as the wgpu device and queue, which the renderer holds, and the
        // Graphite context is dropped before them (`SkiaBackend` is a field of the renderer, which owns both).
        let ctx = unsafe {
            let d = device.as_hal::<Vulkan>()?;
            let q = queue.as_hal::<Vulkan>()?;
            let shared = d.shared_instance();
            let entry = shared.entry();
            let instance = shared.raw_instance();
            let physical = d.raw_physical_device();
            let properties = instance.get_physical_device_properties(physical);
            // Skia asks for the functions of every version it is allowed to use; the loader gives a device only the
            // ones up to the version the instance was made for.
            let api = shared.instance_api_version().min(properties.api_version);
            let instance_extensions: Vec<&str> = shared.extensions().iter().filter_map(|e| e.to_str().ok()).collect();
            let device_extensions: Vec<&str> = d.enabled_device_extensions().iter().filter_map(|e| e.to_str().ok()).collect();
            let resolver = |of: gpu::vk::GetProcOf| -> *const c_void {
                match of {
                    gpu::vk::GetProcOf::Instance(inst, name) => entry
                        .get_instance_proc_addr(vk::Instance::from_raw(inst as u64), name)
                        .map_or(std::ptr::null(), |f| f as *const c_void),
                    gpu::vk::GetProcOf::Device(dev, name) => instance
                        .get_device_proc_addr(vk::Device::from_raw(dev as u64), name)
                        .map_or(std::ptr::null(), |f| f as *const c_void),
                }
            };
            let backend = skvk::BackendContext::new_builder(
                instance.handle().as_raw() as skvk::Instance,
                physical.as_raw() as skvk::PhysicalDevice,
                d.raw_device().handle().as_raw() as skvk::Device,
                (q.as_raw().as_raw() as skvk::Queue, d.queue_family_index() as usize),
                &resolver,
                Some(skvk::Version::from(api)),
            )
            .with_extensions(&instance_extensions, &device_extensions)
            .build();
            // Skia resolves every function it needs here, so `resolver` and `backend` are not needed after.
            graphite::vk::context_factory::make_vulkan(&backend, None)?
        };
        Some((Native::touch(device), ctx))
    }

    fn touch(device: &wgpu::Device) -> Native {
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("skia touch"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            }],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("skia touch"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        // One triangle with all three corners in the same place: no pixel is covered, so nothing is written.
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("skia touch"),
            source: wgpu::ShaderSource::Wgsl(
                "@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }\n\
                 @fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(0.0); }"
                    .into(),
            ),
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("skia touch"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState { module: &shader, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
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
        let sink = device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("skia touch sink"),
                size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            })
            .create_view(&wgpu::TextureViewDescriptor::default());
        Native { layout, pipeline, sink }
    }

    /// What the textures Skia draws to are created with: copies too, so Graphite can copy from or to one.
    pub(super) fn target_usage() -> wgpu::TextureUsages {
        wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::COPY_DST
    }

    /// `texture` as a Graphite backend texture, told the layout the module comment gives for `role`.
    pub(super) fn backend_texture(
        device: &wgpu::Device,
        texture: &wgpu::Texture,
        size: (u32, u32),
        role: Role,
    ) -> Option<graphite::BackendTexture> {
        let format = match texture.format() {
            wgpu::TextureFormat::Rgba8Unorm => vk::Format::R8G8B8A8_UNORM,
            wgpu::TextureFormat::Rgba16Float => vk::Format::R16G16B16A16_SFLOAT,
            _ => return None,
        };
        // What the image really has is a superset: wgpu made it from the usages the texture was created with.
        let (usage, layout) = match role {
            Role::Target => (
                vk::ImageUsageFlags::COLOR_ATTACHMENT
                    | vk::ImageUsageFlags::SAMPLED
                    | vk::ImageUsageFlags::TRANSFER_SRC
                    | vk::ImageUsageFlags::TRANSFER_DST,
                vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL,
            ),
            Role::Sampled => (vk::ImageUsageFlags::SAMPLED, vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL),
        };
        // SAFETY: the image is owned by `texture`, which the caller keeps alive for as long as Skia uses the backend
        // texture. The shim writes a `BackendTexture` into the memory, which `assume_init` then owns.
        unsafe {
            let family = device.as_hal::<Vulkan>()?.queue_family_index();
            let image = texture.as_hal::<Vulkan>()?.raw_handle();
            let mut out = MaybeUninit::<graphite::BackendTexture>::uninit();
            kg_vk_backend_texture(
                out.as_mut_ptr().cast(),
                size.0 as i32,
                size.1 as i32,
                format.as_raw() as u32,
                usage.as_raw(),
                layout.as_raw() as u32,
                family,
                image.as_raw(),
            );
            let bt = out.assume_init();
            bt.is_valid().then_some(bt)
        }
    }

    /// Puts every image Skia is about to use in the layout `backend_texture` told Skia it is in, and wgpu's record of it
    /// in the same, as the module comment says. `target` is this frame's canvas texture and `held` the fallback
    /// textures Skia samples; it runs after the compositor's pending commands (they wrote `held`) and before Skia's
    /// recording is inserted.
    pub(super) fn before_skia(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, target: &wgpu::TextureView, held: &[&Tex]) {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("skia touch") });
        drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("skia target to attachment"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        }));
        for tex in held {
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("skia touch"),
                layout: &self.layout,
                entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&tex.view) }],
            });
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("skia fallback to sampled"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.sink,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Discard },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.draw(0..3, 0..1);
        }
        queue.submit([encoder.finish()]);
    }
}
