//! The Skia (Graphite on Metal) backend for 2D pages and compositing, chosen at run time with
//! `KINETOGRAPH_BACKEND=skia` (Vello is the default). Built with the `skia` cargo feature, on macOS only; otherwise
//! the variable warns once and Vello draws.
//!
//! Skia draws the frame's layers into one Rgba8 texture that wgpu owns (premultiplied, sRGB-encoded, as Vello's
//! output is), on the Metal device and command queue wgpu uses. The compositor then converts that texture to the
//! linear canvas and the readback runs as it always does. A layer Skia cannot draw (`draw::gaps`) is drawn by the
//! wgpu path into a texture, which Skia draws as an image.
//!
//! `KINETOGRAPH_SKIA_STATS=<dir>` appends one JSON line a frame (layers, fallbacks by reason, what was not drawn) to
//! `<dir>/skia-<pid>-<n>.jsonl`.

#[cfg(all(feature = "skia", target_os = "macos"))]
mod backend;
// skia-safe deprecates the gradient_shader module for `gradient`; the calls here are the ones that were measured.
#[cfg(all(feature = "skia", target_os = "macos"))]
#[allow(deprecated)]
mod draw;
#[cfg(all(feature = "skia", target_os = "macos"))]
pub(super) use backend::{SkiaBackend, init};

#[cfg(not(all(feature = "skia", target_os = "macos")))]
pub(super) use stub::{SkiaBackend, init};

#[cfg(not(all(feature = "skia", target_os = "macos")))]
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
                    "kinetograph: KINETOGRAPH_BACKEND=skia needs a build with the `skia` feature on macOS; drawing with Vello"
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
    }
}
