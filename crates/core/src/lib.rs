//! Scene graph and GPU compositor for Kinetograph.

pub mod anim;
pub mod color;
pub mod compositor;
pub mod error;
pub mod render;
pub mod resolve;
pub mod scene;
pub mod text;

pub use error::{Error, Result};
pub use render::{Frame, Renderer, render_still};
pub use scene::Scene;
