//! Scene graph and GPU compositor for Kinetograph.

pub mod anim;
pub mod color;
pub mod error;
pub mod resolve;
pub mod scene;

pub use error::{Error, Result};
pub use scene::Scene;
