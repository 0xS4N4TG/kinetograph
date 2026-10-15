//! The Chrome fallback's addon calls (docs/COMPAT.md §6.2): `videoFrame`, a
//! video layer's picture decoded on the CPU, and the encoding of frames that
//! were drawn elsewhere (`VideoWriter.pushRgba`). Stream 3.

use std::path::Path;

use crate::RgbaFrame;
use crate::error::{Code, Result, error};

/// The picture a video layer shows `time` seconds after the stream's first picture.
pub fn video_frame(_path: &Path, _time: f64) -> Result<RgbaFrame> {
    Err(error(
        Code::Render,
        "not implemented: videoFrame (docs/COMPAT.md §6.2)",
    ))
}
