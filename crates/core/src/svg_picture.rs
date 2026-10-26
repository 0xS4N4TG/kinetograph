//! SVG files drawn as pictures (`<img src="x.svg">`, `background-image: url(x.svg)`, an `image` layer or paint whose
//! `src` is an SVG file or `data:image/svg+xml` URL).
//!
//! An SVG has no pixels of its own, so it is painted (resvg, on the CPU) at the size it is drawn at, and is sharp at
//! any scale; the file's `width`, `height` and `viewBox` give only its natural size, which lays the picture out. A
//! file with neither is 300 x 150, as in a browser. As in a browser's `<img>`, the picture reads no other file, and
//! sets its text in none of the page's fonts (none are loaded here, so text is left out: `has_text` says so).

use std::path::Path;

use resvg::{tiny_skia, usvg};

/// Largest side, in pixels, an SVG picture is painted at.
pub const MAX_SIDE: f64 = 4096.0;

/// Whether `src` (a file name or a `data:` URL) is an SVG picture.
pub fn is_svg(src: &str) -> bool {
    if let Some(rest) = src.strip_prefix("data:") {
        return rest.trim_start().to_ascii_lowercase().starts_with("image/svg+xml");
    }
    let lower = src.to_ascii_lowercase();
    lower.ends_with(".svg") || lower.ends_with(".svgz")
}

fn options() -> usvg::Options<'static> {
    usvg::Options {
        // The size of a file that gives neither a size nor a viewBox: CSS's default object size.
        default_size: usvg::Size::from_wh(300.0, 150.0).expect("a positive size"),
        // A picture reads no other file.
        resources_dir: None,
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: usvg::ImageHrefResolver::default_data_resolver(),
            resolve_string: Box::new(|_, _| None),
        },
        ..usvg::Options::default()
    }
}

/// The file `src` names (relative to `base_dir`), or the bytes of a `data:` URL.
pub fn read(base_dir: &Path, src: &str) -> Result<Vec<u8>, String> {
    if src.starts_with("data:") {
        return crate::scene::data_uri_bytes(src).ok_or_else(|| "a malformed data: URL".to_string());
    }
    let path = base_dir.join(src);
    std::fs::read(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))
}

/// An SVG file, parsed.
#[derive(Debug)]
pub struct Picture {
    tree: usvg::Tree,
    text: bool,
}

impl Picture {
    pub fn parse(bytes: &[u8]) -> Result<Picture, String> {
        let bytes = with_default_size(bytes);
        let tree = usvg::Tree::from_data(&bytes, &options()).map_err(|e| format!("cannot read the SVG: {e}"))?;
        let text = bytes.windows(5).any(|w| w == b"<text");
        Ok(Picture { tree, text })
    }

    pub fn open(base_dir: &Path, src: &str) -> Result<Picture, String> {
        Picture::parse(&read(base_dir, src)?)
    }

    /// The natural size, in CSS pixels.
    pub fn size(&self) -> (f64, f64) {
        let s = self.tree.size();
        (f64::from(s.width()), f64::from(s.height()))
    }

    /// Whether the file has `<text>`, which is left out (no fonts are loaded).
    pub fn has_text(&self) -> bool {
        self.text
    }

    /// Paints the picture over a `width` x `height` pixel canvas (stretched to fill it), as straight-alpha RGBA.
    pub fn paint(&self, width: u32, height: u32) -> Option<Vec<u8>> {
        let mut pixmap = tiny_skia::Pixmap::new(width, height)?;
        let (nw, nh) = self.size();
        let scale = tiny_skia::Transform::from_scale(width as f32 / nw as f32, height as f32 / nh as f32);
        resvg::render(&self.tree, scale, &mut pixmap.as_mut());
        let mut rgba = pixmap.take();
        for px in rgba.chunks_exact_mut(4) {
            // tiny-skia keeps premultiplied alpha.
            let a = u32::from(px[3]);
            if a != 0 && a != 255 {
                for c in &mut px[..3] {
                    *c = ((u32::from(*c) * 255 + a / 2) / a).min(255) as u8;
                }
            }
        }
        Some(rgba)
    }
}

/// `bytes`, with `width="300"` and `height="150"` put on a root `<svg>` that has no `viewBox` and leaves them out (usvg
/// would size such a file to its content; CSS sizes it 300 x 150 and draws it unscaled).
fn with_default_size(bytes: &[u8]) -> std::borrow::Cow<'_, [u8]> {
    let text = if bytes.starts_with(&[0x1f, 0x8b]) {
        match usvg::decompress_svgz(bytes).ok().and_then(|b| String::from_utf8(b).ok()) {
            Some(t) => t,
            None => return bytes.into(),
        }
    } else {
        match std::str::from_utf8(bytes) {
            Ok(t) => t.to_string(),
            Err(_) => return bytes.into(),
        }
    };
    let options = usvg::roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() };
    let Ok(doc) = usvg::roxmltree::Document::parse_with_options(&text, options) else {
        return bytes.into();
    };
    let root = doc.root_element();
    if root.attribute("viewBox").is_some() || root.tag_name().name() != "svg" {
        return bytes.into();
    }
    let mut add = String::new();
    if root.attribute("width").is_none() {
        add.push_str(" width=\"300\"");
    }
    if root.attribute("height").is_none() {
        add.push_str(" height=\"150\"");
    }
    let start = root.range().start;
    if add.is_empty() || text.get(start..start + 4) != Some("<svg") {
        return bytes.into();
    }
    format!("{}{add}{}", &text[..start + 4], &text[start + 4..]).into_bytes().into()
}

/// The natural size of the SVG `src`.
pub fn natural_size(base_dir: &Path, src: &str) -> Result<(f64, f64), String> {
    Picture::open(base_dir, src).map(|p| p.size())
}

/// The pixel size to paint a picture of `natural` size at, when it is drawn `scale` layer units per natural pixel
/// (on each axis) under a transform that stretches at most `stretch`: every drawn pixel is a painted one. Cut down
/// to `MAX_SIDE` a side; `None` when nothing would be drawn.
pub fn pixels(natural: (f64, f64), scale: (f64, f64), stretch: f64) -> Option<(u32, u32)> {
    let (w, h) = (natural.0 * scale.0 * stretch, natural.1 * scale.1 * stretch);
    if !(w > 0.0 && h > 0.0 && w.is_finite() && h.is_finite()) {
        return None;
    }
    let down = (MAX_SIDE / w.max(h)).min(1.0);
    Some(((w * down).ceil().max(1.0) as u32, (h * down).ceil().max(1.0) as u32))
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECT: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" fill="#3366ff"/></svg>"##;

    #[test]
    fn knows_svg_sources() {
        assert!(is_svg("shape.svg") && is_svg("A/B.SVG") && is_svg("x.svgz"));
        assert!(is_svg("data:image/svg+xml;base64,AAAA") && is_svg("data:image/svg+xml,%3Csvg"));
        assert!(!is_svg("a.png") && !is_svg("data:image/png;base64,AAAA"));
    }

    #[test]
    fn natural_size_follows_width_height_and_view_box() {
        let size = |svg: &str| Picture::parse(svg.as_bytes()).unwrap().size();
        assert_eq!(size(RECT), (200.0, 100.0));
        // A viewBox alone gives the size.
        assert_eq!(size(r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"/>"#), (40.0, 20.0));
        // One side given: the other follows the viewBox's shape.
        assert_eq!(size(r#"<svg xmlns="http://www.w3.org/2000/svg" width="80" viewBox="0 0 40 20"/>"#), (80.0, 40.0));
        // Neither: 300 x 150.
        assert_eq!(size(r#"<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>"#), (300.0, 150.0));
    }

    #[test]
    fn paints_at_the_size_asked_for_not_the_natural_size() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="5" fill="#ff0000"/></svg>"##;
        let pic = Picture::parse(svg.as_bytes()).unwrap();
        let (w, h) = (400u32, 400u32);
        let rgba = pic.paint(w, h).unwrap();
        let px = |x: u32, y: u32| rgba[((y * w + x) * 4) as usize..][..4].to_vec();
        assert_eq!(px(200, 200), [255, 0, 0, 255]);
        assert_eq!(px(2, 2)[3], 0);
        // The circle's edge crosses the diagonal at 200 - 200/sqrt(2) = 58.6; at 400 px that edge is 1 px wide, where a
        // 10 px picture blown up would show 40 px blocks.
        assert_eq!(px(50, 50)[3], 0);
        assert_eq!(px(68, 68), [255, 0, 0, 255]);
    }

    #[test]
    fn paints_straight_alpha() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#3366ff" fill-opacity="0.5"/></svg>"##;
        let rgba = Picture::parse(svg.as_bytes()).unwrap().paint(2, 2).unwrap();
        assert!(rgba[3].abs_diff(128) <= 1);
        // Straight: the colour is still #3366ff (within rounding), not halved.
        assert!(rgba[0].abs_diff(0x33) <= 2 && rgba[1].abs_diff(0x66) <= 2 && rgba[2].abs_diff(0xff) <= 2, "{rgba:?}");
    }

    #[test]
    fn pixels_follow_the_drawn_size_and_are_capped() {
        // Drawn at 2x the natural size on a 1.5x transform: 3x the natural pixels.
        assert_eq!(pixels((200.0, 100.0), (2.0, 2.0), 1.5), Some((600, 300)));
        assert_eq!(pixels((200.0, 100.0), (0.0, 1.0), 1.0), None);
        assert_eq!(pixels((200.0, 100.0), (1000.0, 1000.0), 1.0), Some((4096, 2048)));
    }

    #[test]
    fn rejects_what_is_not_an_svg_and_flags_text() {
        assert!(Picture::parse(b"not svg").unwrap_err().contains("cannot read the SVG"));
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>hi</text></svg>"#;
        assert!(Picture::parse(svg.as_bytes()).unwrap().has_text());
        assert!(!Picture::parse(RECT.as_bytes()).unwrap().has_text());
    }

    #[test]
    fn reads_data_urls_and_files() {
        let url = format!("data:image/svg+xml;utf8,{}", RECT.replace('#', "%23"));
        assert_eq!(natural_size(Path::new("/nowhere"), &url).unwrap(), (200.0, 100.0));
        assert!(natural_size(Path::new("/nowhere"), "missing.svg").unwrap_err().contains("cannot read"));
    }
}
