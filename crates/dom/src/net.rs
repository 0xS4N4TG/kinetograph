//! Sub-resources of an island: images, `@font-face` files and linked
//! stylesheets. There is no network. A request is answered from a local file
//! (resolved against `baseDir`, then `publicDir`) or a `data:` URL, and
//! synchronously, so the bytes are in Blitz's queue before the next `resolve`
//! and intrinsic sizes are known at layout. Answering in the caller's thread
//! also keeps a frame a pure function of its request.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request};
use percent_encoding::percent_decode_str;
use url::Url;

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
}

impl LocalFiles {
    pub fn new(base_dir: &Path, public_dir: Option<&Path>) -> LocalFiles {
        LocalFiles {
            base_dir: base_dir.to_path_buf(),
            public_dir: public_dir.map(Path::to_path_buf),
            served: AtomicUsize::new(0),
            missing: Mutex::new(Vec::new()),
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

    fn miss(&self, what: String) {
        if let Ok(mut m) = self.missing.lock()
            && !m.contains(&what)
        {
            m.push(what);
        }
    }

    /// The file a `file:` URL names: the path itself if it exists, else the
    /// same path read as relative to `publicDir`, else to `baseDir`.
    fn find(&self, url: &Url) -> Option<PathBuf> {
        let path = url.to_file_path().ok()?;
        if path.is_file() {
            return Some(path);
        }
        // A URL like `/logo.png` (what staticFile and root-relative paths give)
        // or a relative one whose directory did not exist.
        let relative = path
            .strip_prefix(&self.base_dir)
            .map(Path::to_path_buf)
            .unwrap_or_else(|_| path.components().skip(1).collect());
        [self.public_dir.as_deref(), Some(self.base_dir.as_path())]
            .into_iter()
            .flatten()
            .map(|dir| dir.join(&relative))
            .find(|candidate| candidate.is_file())
    }

    fn read(&self, url: &Url) -> Result<Vec<u8>, String> {
        match url.scheme() {
            "file" => {
                let path = self
                    .find(url)
                    .ok_or_else(|| format!("{url}: no such file"))?;
                std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))
            }
            "data" => {
                let parsed = data_url::DataUrl::process(url.as_str())
                    .map_err(|e| format!("bad data URL: {e:?}"))?;
                let (body, _) = parsed
                    .decode_to_vec()
                    .map_err(|e| format!("bad data URL: {e:?}"))?;
                Ok(body)
            }
            scheme => Err(format!("{url}: {scheme} requests are not available")),
        }
    }
}

impl NetProvider for LocalFiles {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        match self.read(&request.url) {
            Ok(bytes) => {
                self.served.fetch_add(1, Ordering::SeqCst);
                handler.bytes(request.url.to_string(), Bytes::from(bytes));
            }
            Err(why) => self.miss(why),
        }
    }
}

/// `s` with `%xx` escapes decoded, for matching a URL path against names.
pub fn decode_path(s: &str) -> String {
    percent_decode_str(s).decode_utf8_lossy().into_owned()
}
