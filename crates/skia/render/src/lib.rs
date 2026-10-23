//! RN-Skia's scene tree drawn with Skia's CPU rasteriser.
//!
//! `@kinetograph/core/skia` (docs/AUTHORING.md §7.7) turns the JSX of
//! `@shopify/react-native-skia` into a tree of nodes with their props, and this
//! crate draws that tree into an RGBA picture with `skia-safe`, as RN-Skia's own
//! renderer does: the paint a node is drawn with is the paint of its group with
//! the node's own props laid over it, and a node's shader, filter and path
//! effect children go onto that paint. The raster backend is deterministic: the
//! same tree gives the same pixels on any machine, with no GPU.

mod assets;
mod compound;
mod declare;
mod draw;
mod enums;
mod paths;
mod render;
mod text;
mod value;

use std::fmt;

pub use assets::Assets;
pub use compound::svg_size;
pub use declare::{EffectInfo, compile_effect};
pub use paths::path_call;
pub use render::render;
pub use text::{FontMetrics, TextMeasure, measure_text};
pub use value::Props;

#[derive(Debug)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

/// Something in the tree that is not drawn.
#[derive(Debug, Clone, PartialEq)]
pub struct Unsupported {
    /// The node's type, `"Atlas"`.
    pub element: String,
    pub property: Option<String>,
    pub reason: String,
}

/// A picture: straight-alpha RGBA8, `width * height * 4` bytes, and what was
/// left out.
pub struct Output {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    pub unsupported: Vec<Unsupported>,
}
