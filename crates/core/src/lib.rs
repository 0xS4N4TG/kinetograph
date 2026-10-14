//! Scene graph and GPU compositor for Kinetograph.

pub mod anim;
pub mod blur;
pub mod color;
pub mod compositor;
pub mod error;
pub mod render;
pub mod resolve;
pub mod scene;
pub mod text;

#[cfg(test)]
mod tests;

pub use error::{Error, Result};
pub use render::{Frame, Renderer, Timings, render_still};
pub use scene::Scene;
