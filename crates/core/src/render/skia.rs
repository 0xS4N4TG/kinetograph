//! The Skia (Graphite) backend: it draws every 2D layer and composites the frame. Graphite runs on Metal on macOS
//! (`metal.rs`) and on Vulkan on Linux and Windows (`vulkan.rs`). If Skia cannot start on the GPU (no Metal or Vulkan
//! device on wgpu's adapter, a driver Graphite cannot draw to) or `KINETOGRAPH_SKIA_CPU=1` is set, the same draw code
//! runs on Skia's CPU backend: raster surfaces whose pixels are uploaded to the wgpu textures the GPU path draws into,
//! and the layers the wgpu path draws, which Skia samples, are read back to the CPU first (`backend.rs`).
//!
//! Skia draws the frame's layers into one texture that wgpu owns, on the device and queue wgpu uses: for
//! a scene that blends in linear light (`blendSpace`) Rgba16Float in linear light, else Rgba8 holding sRGB-encoded
//! values (premultiplied). The compositor then copies or converts that texture to the
//! linear canvas and the readback runs as it always does. A layer Skia cannot draw (`draw::gaps`) is drawn by the
//! wgpu path into a texture, which Skia draws as an image.
//!
//! `KINETOGRAPH_SKIA_STATS=<dir>` appends one JSON line a frame (layers, fallbacks by reason, what was not drawn) to
//! `<dir>/skia-<pid>-<n>.jsonl`.

/// What a wgpu texture handed to Skia is for.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    /// Skia draws into it (a frame's canvas); wgpu samples it afterwards.
    Target,
    /// Skia only samples it (a layer the wgpu path drew).
    Sampled,
}

#[cfg(target_os = "macos")]
mod metal;
#[cfg(target_os = "macos")]
use metal as native;
#[cfg(not(target_os = "macos"))]
mod vulkan;
#[cfg(not(target_os = "macos"))]
use vulkan as native;

/// A texture the compositor or Skia may draw into: `device.create_texture(desc)`, plus whatever the GPU API Skia runs on
/// requires of a texture it draws to (`native::Native::create_texture`).
pub(crate) fn create_texture(device: &wgpu::Device, desc: &wgpu::TextureDescriptor<'_>) -> wgpu::Texture {
    native::Native::create_texture(device, desc)
}

mod backend;
// skia-safe deprecates the gradient_shader module for `gradient`; the calls here are the ones that were measured.
#[allow(deprecated)]
mod draw;
pub(super) use backend::{Inner, RasterOp, SkiaBackend, init};
