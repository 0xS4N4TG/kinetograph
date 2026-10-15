//! Scene graph and GPU compositor for Kinetograph.

pub mod anim;
pub mod blur;
pub mod bounds;
pub mod box_shadow;
pub mod cache;
pub mod color;
pub mod compositor;
pub mod dom_layout;
pub mod error;
pub mod gif;
#[cfg(test)]
mod hash;
pub mod inspect;
mod layout;
pub mod lottie;
pub mod lut;
pub mod mesh;
pub mod pool;
pub mod render;
pub mod resolve;
pub mod scene;
pub mod shader;
pub mod text;
pub mod turbulence;
pub mod uniforms;
pub mod video;
pub mod warp;

#[cfg(test)]
mod tests;

pub use error::{Error, Result};
pub use render::{Frame, PendingFrame, Renderer, Timings, render_still};
pub use scene::Scene;
