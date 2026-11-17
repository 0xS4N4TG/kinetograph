//! `putCanvasPixels` and `releaseCanvasPixels`: the read-back of a GPU canvas handed over as bytes (`kinetograph_core::stored_pixels`),
//! so that it does not cross as base64 inside the JSON the scene is made of.

use napi::bindgen_prelude::Buffer;

use crate::error::{Result, invalid};
use kinetograph_core::stored_pixels::{self, StoredAlpha};

/// Keeps `bytes` (rows of `row_bytes`, RGBA8 or BGRA8) as version `version` of the canvas `key`; `alpha` is `opaque`, `premultiplied`
/// or `straight`. The bytes are compared with the newest version as they are, and copied only when they are a new picture: the buffer is
/// the caller's again when the call returns. False, and nothing kept, when the newest version of `key` is the same picture.
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
    stored_pixels::put_rows(key, version as u64, width, height, row_bytes as usize, bgra, alpha, bytes).map_err(|e| invalid(format!("putCanvasPixels: {e}")))
}

/// The rows of version `version` of the canvas `key` as they were put, or none when that version is gone.
pub fn pixels(key: &str, version: f64) -> Option<Buffer> {
    stored_pixels::get(key, version as u64).map(|p| Buffer::from(p.bytes.clone()))
}

pub fn release(key: &str) {
    stored_pixels::release(key);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PreviewOptions, Renderer};
    use kinetograph_core::stored_pixels::StoredPicture;

    /// A scene with one canvas layer that draws version `version` of the picture `key`.
    fn naming(key: &str, version: u64) -> String {
        format!(
            r##"{{"width": 8, "height": 8, "fps": 30, "durationInFrames": 1, "background": "#000000",
                "layers": [{{"id": "c", "type": "canvas", "width": 8, "height": 8, "commands": [{{"op": "image",
                  "source": {{"kind": "stored", "key": "{key}", "version": {version}}},
                  "sx": 0, "sy": 0, "sw": 8, "sh": 8, "dx": 0, "dy": 0, "dw": 8, "dh": 8, "smooth": false}}]}}]}}"##
        )
    }

    fn put_picture(key: &str, version: u64) {
        let bytes: Vec<u8> = (0..8 * 8 * 4).map(|i| if i % 4 == 3 { 255 } else { (version * 8) as u8 }).collect();
        let picture = StoredPicture { width: 8, height: 8, row_bytes: 32, bgra: false, alpha: StoredAlpha::Opaque, bytes };
        assert_eq!(stored_pixels::put(key, version, picture), Ok(true));
    }

    /// `still`, `preview` and `rgba` load a scene each, in the order the host put the pictures it names: the pictures before it are let go,
    /// as the frame threads let them go. A host that exports an image sequence or scrubs a preview put a picture per frame.
    #[test]
    fn stills_previews_and_rgba_frames_do_not_keep_every_picture_put() {
        let key = "node-test-stills";
        let mut renderer = Renderer::new(None).unwrap();
        let mut seen = Vec::new();
        for version in 1..=24u64 {
            put_picture(key, version);
            let scene = naming(key, version);
            renderer.still(scene.clone(), 0.0, None).unwrap();
            renderer.preview(scene.clone(), 0.0, Some(PreviewOptions::default()), None).unwrap();
            seen.push(renderer.rgba(scene, 0.0, None).unwrap().data.to_vec());
            assert!(stored_pixels::versions(key) <= 2, "{} versions kept after {version} frames", stored_pixels::versions(key));
        }
        // The pictures were drawn (each frame holds its own version), not dropped before they were.
        assert!(seen.windows(2).all(|pair| pair[0] != pair[1]));
        stored_pixels::release(key);
    }

    /// The host reads a picture it put back: the bytes as they were put (what a canvas drawn into another reads).
    #[test]
    fn a_picture_put_can_be_read_back_as_put() {
        let key = "node-test-read-back";
        let bytes: Vec<u8> = (0..8 * 8 * 4).map(|i| (i % 251) as u8).collect();
        assert!(stored_pixels::put_rows(key, 1, 8, 8, 32, false, StoredAlpha::Premul, &bytes).unwrap());
        assert_eq!(pixels(key, 1.0).unwrap().to_vec(), bytes);
        assert!(pixels(key, 2.0).is_none());
        stored_pixels::release(key);
        assert!(pixels(key, 1.0).is_none());
    }
}
