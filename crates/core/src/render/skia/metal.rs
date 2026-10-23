//! The Metal side of the Skia backend (macOS): Graphite on the MTLDevice and MTLCommandQueue wgpu uses, and wgpu
//! textures as Graphite backend textures.
//!
//! Metal needs no hand-off bookkeeping: one serial command queue holds wgpu's commands and Skia's, in commit order, and
//! a texture has no layout. `Native::before_skia` therefore does nothing.

use std::ffi::c_void;

use skia_safe::gpu::graphite;
use wgpu::hal::api::Metal;

use super::Role;
use crate::compositor::Tex;

pub(super) struct Native;

fn mtl_ptr<T: ?Sized>(r: &T) -> *mut c_void {
    r as *const T as *const c_void as *mut c_void
}

impl Native {
    /// A Graphite context on `device`'s Metal device and `queue`'s command queue.
    pub(super) fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Option<(Native, graphite::Context)> {
        // SAFETY: the raw device and queue stay alive as long as the wgpu ones, which the renderer holds.
        let (dev, q) = unsafe {
            let d = device.as_hal::<Metal>()?;
            let q = queue.as_hal::<Metal>()?;
            (mtl_ptr(&**d.raw_device()), mtl_ptr(q.as_raw()))
        };
        let backend = unsafe { graphite::mtl::BackendContext::new(dev, q) };
        let ctx = graphite::mtl::context_factory::make_metal(&backend, None)?;
        Some((Native, ctx))
    }

    /// `device.create_texture(desc)`: Metal needs nothing more of a texture Skia draws to.
    pub(crate) fn create_texture(device: &wgpu::Device, desc: &wgpu::TextureDescriptor<'_>) -> wgpu::Texture {
        device.create_texture(desc)
    }

    /// What the textures Skia draws to are created with.
    pub(super) fn target_usage() -> wgpu::TextureUsages {
        wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING
    }

    pub(super) fn backend_texture(_: &wgpu::Device, texture: &wgpu::Texture, size: (u32, u32), _: Role) -> Option<graphite::BackendTexture> {
        let ptr = unsafe { texture.as_hal::<Metal>().map(|h| mtl_ptr(h.raw_handle())) }?;
        Some(unsafe { graphite::mtl::backend_textures::make_metal((size.0 as i32, size.1 as i32), ptr) })
    }

    pub(super) fn before_skia(&mut self, _: &wgpu::Device, _: &wgpu::Queue, _: &wgpu::TextureView, _: &[&Tex]) {}
}
