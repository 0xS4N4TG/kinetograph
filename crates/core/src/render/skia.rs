//! The Skia (Graphite) backend for 2D pages and compositing, chosen at run time with `KINETOGRAPH_BACKEND=skia`
//! (Vello is the default). Built with the `skia` cargo feature: Graphite runs on Metal on macOS (`metal.rs`) and on
//! Vulkan on Linux and Windows (`vulkan.rs`); without the feature the variable warns once and Vello draws.
//!
//! Skia draws the frame's layers into one texture that wgpu owns, on the device and queue wgpu uses: for
//! a scene that blends in linear light (`blendSpace`) Rgba16Float in linear light, else Rgba8 holding sRGB-encoded
//! values (premultiplied, as Vello's output is). The compositor then copies or converts that texture to the
//! linear canvas and the readback runs as it always does. A layer Skia cannot draw (`draw::gaps`) is drawn by the
//! wgpu path into a texture, which Skia draws as an image.
//!
//! `KINETOGRAPH_SKIA_STATS=<dir>` appends one JSON line a frame (layers, fallbacks by reason, what was not drawn) to
//! `<dir>/skia-<pid>-<n>.jsonl`.

/// What a wgpu texture handed to Skia is for.
#[cfg(feature = "skia")]
#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    /// Skia draws into it (a frame's canvas); wgpu samples it afterwards.
    Target,
    /// Skia only samples it (a layer the wgpu path drew).
    Sampled,
}

#[cfg(all(feature = "skia", target_os = "macos"))]
mod metal;
#[cfg(all(feature = "skia", target_os = "macos"))]
use metal as native;
#[cfg(all(feature = "skia", not(target_os = "macos")))]
mod vulkan;
#[cfg(all(feature = "skia", not(target_os = "macos")))]
use vulkan as native;

#[cfg(feature = "skia")]
mod backend;
// skia-safe deprecates the gradient_shader module for `gradient`; the calls here are the ones that were measured.
#[cfg(feature = "skia")]
#[allow(deprecated)]
mod draw;
#[cfg(feature = "skia")]
pub(super) use backend::{SkiaBackend, init};

#[cfg(not(feature = "skia"))]
pub(super) use stub::{SkiaBackend, init};

#[cfg(not(feature = "skia"))]
mod stub {
    use super::super::{Renderer, wgpu};
    use crate::compositor::Readback;
    use crate::compositor::Tex;
    use crate::error::Result;
    use crate::resolve::ResolvedScene;
    use crate::scene::Scene;

    pub(in super::super) enum SkiaBackend {}

    pub(in super::super) fn init(_: &wgpu::Device, _: &wgpu::Queue, _: &Scene) -> Option<SkiaBackend> {
        if std::env::var("KINETOGRAPH_BACKEND").is_ok_and(|v| v.eq_ignore_ascii_case("skia")) {
            static ONCE: std::sync::Once = std::sync::Once::new();
            ONCE.call_once(|| {
                eprintln!(
                    "kinetograph: KINETOGRAPH_BACKEND=skia needs a build with the `skia` feature; drawing with Vello"
                )
            });
        }
        None
    }

    impl Renderer {
        pub(in super::super) fn skia_canvas(&mut self, _: &ResolvedScene) -> Result<Tex> {
            unreachable!("no Skia backend in this build")
        }

        pub(in super::super) fn skia_submitted(&mut self, _: &Readback) {}

        pub(in super::super) fn skia_started(&mut self, _: u32) {}

        pub(in super::super) fn skia_finished(&mut self, _: &[u8]) {}
    }
}
