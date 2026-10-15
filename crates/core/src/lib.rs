//! Scene graph and GPU compositor for Kinetograph.

pub mod anim;
pub mod blur;
pub mod bounds;
pub mod box_shadow;
pub mod cache;
pub mod color;
pub mod compositor;
pub mod error;
#[cfg(test)]
mod hash;
pub mod inspect;
mod layout;
pub mod lottie;
pub mod lut;
pub mod mesh;
pub mod pass_timer;
pub mod pool;
pub mod render;
pub mod resolve;
pub mod scene;
pub mod shader;
pub mod text;
pub mod turbulence;
pub mod uniforms;
pub mod warp;

#[cfg(test)]
mod tests;

pub use error::{Error, Result};
pub use render::{Frame, PendingFrame, Renderer, Timings, render_still};
pub use scene::Scene;
