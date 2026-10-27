//! Scene graph and GPU compositor for Kinetograph.

pub mod anim;
pub mod blur;
pub mod bounds;
pub mod box_shadow;
pub mod cache;
pub mod datamosh;
pub mod canvas;
pub mod color;
pub mod compositor;
pub mod dom_layout;
pub mod error;
pub mod fallback_fonts;
pub mod filter;
pub mod gif;
pub mod glsl;
pub mod grade;
#[cfg(test)]
mod hash;
pub mod inspect;
mod layout;
pub mod lottie;
pub mod lut;
pub mod mesh;
pub mod pass_timer;
pub mod picture_read;
pub mod pool;
pub mod profile;
pub mod render;
pub mod resolve;
pub mod reuse;
pub mod scene;
pub mod scene_keys;
pub mod scene3d;
pub mod shader;
pub mod svg_picture;
pub mod text;
pub mod turbulence;
pub mod uniforms;
pub mod video;
pub mod warp;
pub mod webgpu;

#[cfg(test)]
mod tests;

pub use error::{Error, Result};
pub use render::{Frame, PendingFrame, Renderer, Timings, render_still, webgpu_device_info};
pub use scene::Scene;
