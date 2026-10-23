//! The Skia (Graphite) backend: it draws every 2D layer and composites the frame. Graphite runs on Metal on macOS
//! (`metal.rs`) and on Vulkan on Linux and Windows (`vulkan.rs`). If Skia cannot start on the GPU, the renderer fails
//! with an error that says so; there is no other backend.
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

mod backend;
// skia-safe deprecates the gradient_shader module for `gradient`; the calls here are the ones that were measured.
#[allow(deprecated)]
mod draw;
pub(super) use backend::{Inner, RasterOp, SkiaBackend, init};
