//! Finding the files behind CSS `url()`s and `<img src>`, and their sizes.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use style::url::ComputedUrl;

use super::Painter;

/// What a picture URL turned out to be.
pub enum Source {
    /// A raster picture the scene can draw: the file's path and its size.
    Raster { path: String, w: f64, h: f64 },
    /// Something the scene cannot draw (an SVG picture, a remote URL), and why.
    Unsupported(String),
}

impl<'a> Painter<'a> {
    /// A relative reference against the request's directories: the project
    /// first, then `public/`.
    pub fn resolve_relative(&self, s: &str) -> Option<PathBuf> {
        let s = s.trim();
        if s.is_empty() {
            return None;
        }
        let p = Path::new(s);
        if p.is_absolute() && p.exists() {
            return Some(p.to_path_buf());
        }
        let rel = s.trim_start_matches("./").trim_start_matches('/');
        let base = Path::new(&self.req.base_dir);
        let c = base.join(rel);
        if c.exists() {
            return Some(c);
        }
        if let Some(public) = &self.req.public_dir {
            let c = Path::new(public).join(rel);
            if c.exists() {
                return Some(c);
            }
        }
        None
    }

    /// The file a computed `url()` names.
    pub fn source_of_url(&self, url: &ComputedUrl) -> Source {
        match url {
            ComputedUrl::Valid(u) => self.source_of(u.as_str()),
            ComputedUrl::Invalid(s) => self.source_of(s),
        }
    }

    /// The file a URL or path string names.
    pub fn source_of(&self, s: &str) -> Source {
        if let Some(rest) = s.strip_prefix("data:") {
            return self.data_source(rest);
        }
        let path = if let Ok(u) = url::Url::parse(s) {
            match u.scheme() {
                "file" => u.to_file_path().ok(),
                "http" | "https" => {
                    return Source::Unsupported(format!(
                        "{s} is a remote picture; a render reads no network"
                    ));
                }
                _ => None,
            }
        } else {
            self.resolve_relative(&percent_decode(s))
        };
        let Some(path) = path.filter(|p| p.is_file()) else {
            return Source::Unsupported(format!("the picture {s} is not a file the project has"));
        };
        let lower = path.to_string_lossy().to_lowercase();
        if lower.ends_with(".svg") || lower.ends_with(".svgz") {
            return Source::Unsupported("an SVG picture is not drawn yet".to_string());
        }
        match image::image_dimensions(&path) {
            Ok((w, h)) => Source::Raster {
                path: path.to_string_lossy().into_owned(),
                w: f64::from(w),
                h: f64::from(h),
            },
            Err(e) => Source::Unsupported(format!("cannot read {}: {e}", path.display())),
        }
    }

    /// A `data:` URL: the scene decodes it from memory (no file is written),
    /// so the layer's `src` is the URL itself.
    fn data_source(&self, rest: &str) -> Source {
        let Some((meta, data)) = rest.split_once(',') else {
            return Source::Unsupported("a malformed data: URL".to_string());
        };
        let is_base64 = meta.ends_with(";base64");
        let mime = meta.split(';').next().unwrap_or("");
        match mime {
            "image/png" | "image/jpeg" | "image/jpg" | "image/gif" => {}
            "image/svg+xml" => {
                return Source::Unsupported("an SVG picture is not drawn yet".to_string());
            }
            other => {
                return Source::Unsupported(format!("the picture type {other:?} is not drawn"));
            }
        }
        let bytes = if is_base64 {
            let clean: String = percent_decode(data)
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect();
            match base64::engine::general_purpose::STANDARD.decode(clean.as_bytes()) {
                Ok(b) => b,
                Err(e) => return Source::Unsupported(format!("a data: URL with bad base64: {e}")),
            }
        } else {
            percent_encoding::percent_decode_str(data).collect()
        };
        let size = image::ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()
            .ok()
            .and_then(|r| r.into_dimensions().ok());
        match size {
            Some((w, h)) => Source::Raster {
                path: format!("data:{rest}"),
                w: f64::from(w),
                h: f64::from(h),
            },
            None => Source::Unsupported("cannot read a data: picture".to_string()),
        }
    }
}

fn percent_decode(s: &str) -> String {
    percent_encoding::percent_decode_str(s)
        .decode_utf8_lossy()
        .into_owned()
}
