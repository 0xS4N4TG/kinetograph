//! `Renderer.preview` (docs/AUTHORING.md §11.2): a rendered frame scaled down
//! by a box filter and encoded as JPEG or PNG for the studio. Stream 3.

use crate::error::{Code, Result, error};
use crate::{PreviewImage, PreviewOptions};

/// `rgba` is a full-size straight-alpha sRGB frame, `width * height * 4` bytes.
pub fn preview(
    _rgba: &[u8],
    _width: u32,
    _height: u32,
    _options: &PreviewOptions,
) -> Result<PreviewImage> {
    Err(error(
        Code::Render,
        "not implemented: preview (docs/AUTHORING.md §11.2)",
    ))
}
