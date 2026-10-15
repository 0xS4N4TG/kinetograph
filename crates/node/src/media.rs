//! `probeMedia` and `decodeAudio` (docs/AUTHORING.md §11.2): CPU-only reads of
//! video and GIF files through FFmpeg and the `image` crate. Stream 1.

use std::path::Path;

use crate::error::{Code, Result, error};
use crate::{AudioPcm, MediaInfo};

pub fn probe_media(_path: &Path) -> Result<MediaInfo> {
    Err(error(
        Code::Render,
        "not implemented: probeMedia (docs/AUTHORING.md §11.2)",
    ))
}

pub fn decode_audio(_path: &Path, _sample_rate: u32) -> Result<Option<AudioPcm>> {
    Err(error(
        Code::Render,
        "not implemented: decodeAudio (docs/AUTHORING.md §11.2)",
    ))
}
