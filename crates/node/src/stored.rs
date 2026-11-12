//! `putCanvasPixels` and `releaseCanvasPixels`: the read-back of a GPU canvas handed over as bytes (`kinetograph_core::stored_pixels`),
//! so that it does not cross as base64 inside the JSON the scene is made of.

use napi::bindgen_prelude::Buffer;

use crate::error::{Result, invalid};
use kinetograph_core::stored_pixels::{self, StoredAlpha, StoredPicture};

/// Keeps `bytes` (rows of `row_bytes`, RGBA8 or BGRA8) as version `version` of the canvas `key`; `alpha` is `opaque`, `premultiplied`
/// or `straight`. One copy of the bytes is made: the buffer is the caller's again when the call returns. False, and nothing kept, when
/// the newest version of `key` is the same picture.
pub fn put(
    key: &str,
    version: f64,
    width: u32,
    height: u32,
    row_bytes: u32,
    bgra: bool,
    alpha: &str,
    bytes: &Buffer,
) -> Result<bool> {
    let alpha = match alpha {
        "opaque" => StoredAlpha::Opaque,
        "premultiplied" => StoredAlpha::Premul,
        "straight" => StoredAlpha::Unpremul,
        other => return Err(invalid(format!("putCanvasPixels: alpha is opaque, premultiplied or straight, not {other:?}"))),
    };
    let picture = StoredPicture { width, height, row_bytes: row_bytes as usize, bgra, alpha, bytes: bytes.to_vec() };
    stored_pixels::put(key, version as u64, picture).map_err(|e| invalid(format!("putCanvasPixels: {e}")))
}

pub fn release(key: &str) {
    stored_pixels::release(key);
}
