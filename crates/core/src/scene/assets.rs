//! Asset helpers: `data:` URLs and image headers.

use std::path::Path;

/// The bytes of a `data:` URL (`data:image/png;base64,...` or percent-encoded
/// text), decoded in memory: a picture that needs no file.
pub(crate) fn data_uri_bytes(src: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    let rest = src.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    if meta.ends_with(";base64") {
        let clean: Vec<u8> = percent_decode(data)
            .into_iter()
            .filter(|b| !b.is_ascii_whitespace())
            .collect();
        base64::engine::general_purpose::STANDARD.decode(clean).ok()
    } else {
        Some(percent_decode(data))
    }
}

fn percent_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let (Some(h), Some(l)) = (
                (b[i + 1] as char).to_digit(16),
                (b[i + 2] as char).to_digit(16),
            )
        {
            out.push((h * 16 + l) as u8);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    out
}

/// The pixel size of the image `src` (a file relative to `base_dir`, or a
/// `data:` URL), from its header. An SVG picture has no pixels: its natural
/// size (`svg_picture`), rounded up.
pub(crate) fn image_dimensions(
    base_dir: &Path,
    src: &str,
) -> std::result::Result<(u32, u32), String> {
    if crate::svg_picture::is_svg(src) {
        let (w, h) = crate::svg_picture::natural_size(base_dir, src)?;
        return Ok((w.ceil().max(1.0) as u32, h.ceil().max(1.0) as u32));
    }
    if let Some(bytes) = data_uri_bytes(src) {
        return image::ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|e| e.to_string())?
            .into_dimensions()
            .map_err(|e| e.to_string());
    }
    image::image_dimensions(base_dir.join(src)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod data_uri_tests {
    use super::*;

    // A 1x1 PNG.
    const PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    #[test]
    fn a_data_uri_is_decoded_in_memory() {
        let bytes = data_uri_bytes(PNG).unwrap();
        assert_eq!(&bytes[1..4], b"PNG");
        assert_eq!(
            image_dimensions(Path::new("/nowhere"), PNG).unwrap(),
            (1, 1)
        );
        assert!(data_uri_bytes("tile.png").is_none());
        assert_eq!(data_uri_bytes("data:text/plain,a%20b").unwrap(), b"a b");
    }

    #[test]
    fn a_webp_is_read_and_decoded() {
        use base64::Engine as _;
        let mut webp = Vec::new();
        image::codecs::webp::WebPEncoder::new_lossless(&mut webp)
            .encode(
                &[10, 200, 30, 255].repeat(6),
                3,
                2,
                image::ExtendedColorType::Rgba8,
            )
            .unwrap();
        let url = format!(
            "data:image/webp;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&webp)
        );
        assert_eq!(
            image_dimensions(Path::new("/nowhere"), &url).unwrap(),
            (3, 2)
        );
        let decoded = image::load_from_memory(&data_uri_bytes(&url).unwrap()).unwrap();
        assert_eq!(decoded.to_rgba8().get_pixel(2, 1).0, [10, 200, 30, 255]);
    }
}
