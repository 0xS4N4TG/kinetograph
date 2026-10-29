//! Sub-resources of an island: images, `@font-face` files and linked
//! stylesheets. There is no network. A request is answered from a local file
//! (resolved against `baseDir`, then `publicDir`) or a `data:` URL, and
//! synchronously, so intrinsic sizes are known at layout. Answering in the
//! caller's thread also keeps a frame a pure function of its request.
//!
//! Decoding a picture costs more than laying out the island that shows it, and
//! every frame builds a new document, so decoded images are kept between
//! documents (by path, size and modification time, so an edited file is read
//! again). Images go to the document through `BaseDocument::load_resource`
//! (see [`LocalFiles::take_deliveries`]); anything else (stylesheets, fonts)
//! goes through the request's handler as Blitz asked.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use blitz_dom::net::Resource;
use blitz_dom::node::SvgImageData;
use blitz_dom::util::ImageType;
use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request};
use url::Url;

/// A Windows drive path such as `D:\proj\logo.png` or `D:/proj/logo.png`. A URL
/// parser reads its drive letter as a one-letter scheme, so this is checked
/// before a string is taken for a URL.
pub fn drive_path(s: &str) -> Option<PathBuf> {
    let b = s.as_bytes();
    let is_drive =
        b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/');
    is_drive.then(|| PathBuf::from(s))
}

/// The `file:` URL a document's relative URLs resolve against: `base_dir` as a
/// directory.
pub fn base_url(base_dir: &Path) -> String {
    Url::from_directory_path(base_dir)
        .map(|u| u.to_string())
        .unwrap_or_else(|()| "file:///".to_string())
}

pub struct LocalFiles {
    base_dir: PathBuf,
    public_dir: Option<PathBuf>,
    served: AtomicUsize,
    missing: Mutex<Vec<String>>,
    deliveries: Mutex<Vec<(String, Resource)>>,
}

/// Where the bytes of a URL are, and what identifies them in the cache.
enum Source {
    File(PathBuf, u64, Option<SystemTime>),
    Data(Url),
}

impl LocalFiles {
    pub fn new(base_dir: &Path, public_dir: Option<&Path>) -> LocalFiles {
        LocalFiles {
            base_dir: base_dir.to_path_buf(),
            public_dir: public_dir.map(Path::to_path_buf),
            served: AtomicUsize::new(0),
            missing: Mutex::new(Vec::new()),
            deliveries: Mutex::new(Vec::new()),
        }
    }

    /// How many requests have been answered since the last call.
    pub fn take_served(&self) -> usize {
        self.served.swap(0, Ordering::SeqCst)
    }

    /// The URLs that could not be read, each with why, in request order.
    pub fn missing(&self) -> Vec<String> {
        self.missing.lock().map(|m| m.clone()).unwrap_or_default()
    }

    /// The images answered since the last call, as `(url, resource)`, to be
    /// handed to `BaseDocument::load_resource` with the URL as `resolved_url`.
    pub fn take_deliveries(&self) -> Vec<(String, Resource)> {
        self.deliveries
            .lock()
            .map(|mut d| std::mem::take(&mut *d))
            .unwrap_or_default()
    }

    fn miss(&self, what: String) {
        if let Ok(mut m) = self.missing.lock()
            && !m.contains(&what)
        {
            m.push(what);
        }
    }

    /// The file a `file:` URL names: the path itself if it exists, else the
    /// same path read as relative to `publicDir`, else to `baseDir`.
    fn find(&self, path: PathBuf) -> Option<PathBuf> {
        if path.is_file() {
            return Some(path);
        }
        // A URL like `/logo.png` (what staticFile and root-relative paths give)
        // or a relative one whose directory did not exist.
        let relative = path
            .strip_prefix(&self.base_dir)
            .map(Path::to_path_buf)
            .unwrap_or_else(|_| {
                // Keep the names only: on Windows a rooted path starts with a
                // drive prefix as well as the root.
                path.components()
                    .filter(|c| matches!(c, Component::Normal(_)))
                    .collect()
            });
        [self.public_dir.as_deref(), Some(self.base_dir.as_path())]
            .into_iter()
            .flatten()
            .map(|dir| dir.join(&relative))
            .find(|candidate| candidate.is_file())
    }

    fn source(&self, url: &Url) -> Result<Source, String> {
        let file = match url.scheme() {
            "file" => Some(url.to_file_path().ok()),
            "data" => None,
            // A Windows drive path, which the URL parser read as scheme `d`.
            _ => {
                drive_path(&percent_encoding::percent_decode_str(url.as_str()).decode_utf8_lossy())
                    .map(Some)
            }
        };
        match (url.scheme(), file) {
            (_, Some(path)) => {
                let path = path
                    .and_then(|path| self.find(path))
                    .ok_or_else(|| format!("{url}: no such file"))?;
                let meta =
                    std::fs::metadata(&path).map_err(|e| format!("{}: {e}", path.display()))?;
                Ok(Source::File(path, meta.len(), meta.modified().ok()))
            }
            ("data", None) => Ok(Source::Data(url.clone())),
            (scheme, None) => Err(format!("{url}: {scheme} requests are not available")),
        }
    }

    fn read(&self, source: &Source) -> Result<Vec<u8>, String> {
        match source {
            Source::File(path, ..) => {
                std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
            }
            Source::Data(url) => {
                let parsed = data_url::DataUrl::process(url.as_str())
                    .map_err(|e| format!("bad data URL: {e:?}"))?;
                let (body, _) = parsed
                    .decode_to_vec()
                    .map_err(|e| format!("bad data URL: {e:?}"))?;
                Ok(body)
            }
        }
    }
}

impl NetProvider for LocalFiles {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        let url = request.url.to_string();
        let source = match self.source(&request.url) {
            Ok(source) => source,
            Err(why) => return self.miss(why),
        };
        self.served.fetch_add(1, Ordering::SeqCst);

        let key = CacheKey::of(&source);
        if let Some(hit) = images().get(&key) {
            return self.deliver(url, hit);
        }
        let bytes = match self.read(&source) {
            Ok(bytes) => bytes,
            Err(why) => return self.miss(why),
        };
        match decode_image(&bytes) {
            Some(image) => {
                let image = images().put(key, image);
                self.deliver(url, image);
            }
            // A stylesheet, a font: Blitz's handler decodes it.
            None => handler.bytes(url, Bytes::from(bytes)),
        }
    }
}

impl LocalFiles {
    fn deliver(&self, url: String, image: Arc<Decoded>) {
        let resource = match &*image {
            Decoded::Raster {
                width,
                height,
                rgba,
            } => Resource::Image(ImageType::Image, *width, *height, rgba.clone()),
            Decoded::Svg(svg) => Resource::Svg(ImageType::Image, svg.clone()),
        };
        if let Ok(mut d) = self.deliveries.lock() {
            d.push((url, resource));
        }
    }
}

// ---- decoded images, kept between documents ----

enum Decoded {
    Raster {
        width: u32,
        height: u32,
        rgba: Arc<Vec<u8>>,
    },
    Svg(SvgImageData),
}

#[derive(Clone, PartialEq, Eq, Hash)]
enum CacheKey {
    File(PathBuf, u64, Option<SystemTime>),
    Data(u64),
}

impl CacheKey {
    fn of(source: &Source) -> CacheKey {
        match source {
            Source::File(path, len, modified) => CacheKey::File(path.clone(), *len, *modified),
            Source::Data(url) => {
                let mut h = std::collections::hash_map::DefaultHasher::new();
                url.as_str().hash(&mut h);
                CacheKey::Data(h.finish())
            }
        }
    }
}

/// Decoded pixels kept at most this many bytes; past it the cache starts over.
const CACHE_BUDGET: usize = 512 * 1024 * 1024;

#[derive(Default)]
struct ImageCache {
    entries: HashMap<CacheKey, Arc<Decoded>>,
    bytes: usize,
}

struct Images(Mutex<ImageCache>);

fn images() -> &'static Images {
    static CACHE: OnceLock<Images> = OnceLock::new();
    CACHE.get_or_init(|| Images(Mutex::default()))
}

impl Images {
    fn get(&self, key: &CacheKey) -> Option<Arc<Decoded>> {
        self.0.lock().ok()?.entries.get(key).cloned()
    }

    fn put(&self, key: CacheKey, image: Decoded) -> Arc<Decoded> {
        let image = Arc::new(image);
        if let Ok(mut cache) = self.0.lock() {
            let size = match &*image {
                Decoded::Raster { rgba, .. } => rgba.len(),
                Decoded::Svg(_) => 64 * 1024,
            };
            if cache.bytes + size > CACHE_BUDGET {
                cache.entries.clear();
                cache.bytes = 0;
            }
            cache.bytes += size;
            cache.entries.insert(key, image.clone());
        }
        image
    }
}

/// A raster picture or an SVG document, decoded as Blitz would; `None` for
/// anything else (or a file that does not decode, which Blitz's handler then
/// reports).
fn decode_image(bytes: &[u8]) -> Option<Decoded> {
    if image::guess_format(bytes).is_ok() {
        let decoded = image::ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()
            .ok()?
            .decode()
            .ok()?;
        let (width, height) = (decoded.width(), decoded.height());
        return Some(Decoded::Raster {
            width,
            height,
            rgba: Arc::new(decoded.into_rgba8().into_raw()),
        });
    }
    let head = &bytes[..bytes.len().min(4096)];
    let looks_like_svg =
        head.starts_with(&[0x1f, 0x8b]) || String::from_utf8_lossy(head).contains("<svg");
    if looks_like_svg {
        // No system fonts: text in an SVG image uses what the project registered
        // (nothing yet) or is left out, the same on every machine.
        let options = usvg::Options::default();
        return SvgImageData::from_data(bytes, &options)
            .ok()
            .map(Decoded::Svg);
    }
    None
}
