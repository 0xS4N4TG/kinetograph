//! Pictures a host hands over as bytes, not as text: the read-back of a GPU canvas (a WebGPU or WebGL canvas drawn by a
//! library outside this process's renderer). The host `put`s a picture under a canvas's key and a version, the commands
//! name it as `CanvasSource::Stored { key, version }`, and the painter takes the bytes from here, so a picture of
//! megabytes never becomes base64 inside the JSON that scenes, islands and requests are made of.
//!
//! The store is the process's: the render threads of one process share it, so keys must not repeat across them (the host
//! puts its thread in the key). A scene holds what it names from the moment it is loaded (`Held`), and a frame is drawn
//! some frames after the host made it (the writer's queue), so the store drops a version only when a scene loaded by a
//! consumer that loads in the host's order (`begin_scene`, `end_scene`) names a newer one of the same key.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

/// How the bytes' alpha is meant, so that the painter takes them as they are.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoredAlpha {
    /// The alpha byte is ignored (an opaque canvas).
    Opaque,
    Premul,
    Unpremul,
}

/// A picture: rows of `row_bytes` (at least `width * 4`), RGBA8, or BGRA8 when `bgra`.
#[derive(Debug)]
pub struct StoredPicture {
    pub width: u32,
    pub height: u32,
    pub row_bytes: usize,
    pub bgra: bool,
    pub alpha: StoredAlpha,
    pub bytes: Vec<u8>,
}

impl StoredPicture {
    /// Row `y`'s pixels (without the padding at the end of a row).
    fn row(&self, y: usize) -> &[u8] {
        &self.bytes[y * self.row_bytes..y * self.row_bytes + self.width as usize * 4]
    }
}

/// What a scene's `Stored` source holds once the scene is loaded: the picture itself, so that the store may let go of it.
#[derive(Clone, Default)]
pub struct Held(pub Option<Arc<StoredPicture>>);

impl std::fmt::Debug for Held {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if self.0.is_some() { "Held" } else { "Held(none)" })
    }
}

impl PartialEq for Held {
    fn eq(&self, other: &Self) -> bool {
        match (&self.0, &other.0) {
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            (None, None) => true,
            _ => false,
        }
    }
}

type Table = HashMap<(String, u64), Arc<StoredPicture>>;

static STORE: LazyLock<Mutex<Table>> = LazyLock::new(|| Mutex::new(HashMap::new()));

thread_local! {
    /// The `(key, version)` of the sources the scenes loaded since `begin_scene` hold, while one is being loaded.
    static LOADED: RefCell<Option<Vec<(String, u64)>>> = const { RefCell::new(None) };
}

fn table() -> std::sync::MutexGuard<'static, Table> {
    STORE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Keeps `picture` as version `version` of `key`, after checking that its bytes hold its rows. `Ok(false)` and nothing kept when
/// the newest version of `key` is the same picture (the same size, layout and pixels): the host keeps using that one, which
/// the painter has already made an image of.
pub fn put(key: &str, version: u64, picture: StoredPicture) -> Result<bool, String> {
    let (width, height) = (picture.width as usize, picture.height as usize);
    if width == 0 || height == 0 || picture.row_bytes < width * 4 || picture.bytes.len() < picture.row_bytes * (height - 1) + width * 4 {
        return Err(format!(
            "stored pixels {width}x{height}: {} bytes of rows of {} do not hold the picture",
            picture.bytes.len(),
            picture.row_bytes
        ));
    }
    let mut table = table();
    let newest = table.iter().filter(|((k, _), _)| k == key).max_by_key(|((_, v), _)| *v).map(|(_, p)| p);
    if let Some(old) = newest
        && (old.width, old.height, old.bgra, old.alpha) == (picture.width, picture.height, picture.bgra, picture.alpha)
        && (0..height).all(|y| old.row(y) == picture.row(y))
    {
        return Ok(false);
    }
    table.insert((key.to_string(), version), Arc::new(picture));
    Ok(true)
}

/// Version `version` of `key`, for a scene that names it: kept in the scene, and noted for `end_scene`.
pub fn hold(key: &str, version: u64) -> Held {
    LOADED.with(|l| {
        if let Some(list) = l.borrow_mut().as_mut() {
            list.push((key.to_string(), version));
        }
    });
    Held(table().get(&(key.to_string(), version)).cloned())
}

/// Starts noting the pictures the scene about to be loaded on this thread names.
pub fn begin_scene() {
    LOADED.with(|l| *l.borrow_mut() = Some(Vec::new()));
}

/// The scene is loaded: the versions of each key it named are the oldest the host's order can still ask for, so the
/// versions before them are dropped (a scene that names none drops nothing).
pub fn end_scene() {
    let Some(named) = LOADED.with(|l| l.borrow_mut().take()) else { return };
    let mut oldest: HashMap<&str, u64> = HashMap::new();
    for (key, version) in &named {
        let at = oldest.entry(key).or_insert(*version);
        *at = (*at).min(*version);
    }
    if !oldest.is_empty() {
        table().retain(|(k, v), _| oldest.get(k.as_str()).is_none_or(|min| v >= min));
    }
}

/// How many versions of `key` the store holds (what a host that renders many frames in a row must see stay small).
pub fn versions(key: &str) -> usize {
    table().keys().filter(|(k, _)| k == key).count()
}

/// Forgets every version of `key` (a canvas that is gone).
pub fn release(key: &str) {
    table().retain(|(k, _), _| k != key);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picture(width: u32, height: u32, fill: u8) -> StoredPicture {
        StoredPicture { width, height, row_bytes: width as usize * 4, bgra: false, alpha: StoredAlpha::Opaque, bytes: vec![fill; (width * height * 4) as usize] }
    }

    #[test]
    fn the_same_picture_is_not_kept_twice() {
        assert_eq!(put("t-a", 1, picture(2, 2, 7)), Ok(true));
        assert_eq!(put("t-a", 2, picture(2, 2, 7)), Ok(false));
        assert_eq!(put("t-a", 2, picture(2, 2, 8)), Ok(true));
        release("t-a");
    }

    #[test]
    fn a_scene_loaded_in_order_lets_go_of_what_is_older_than_what_it_names() {
        for v in 1..=3 {
            put("t-b", v, picture(2, 2, v as u8)).unwrap();
        }
        begin_scene();
        let held = hold("t-b", 2);
        end_scene();
        assert!(held.0.is_some());
        let alive = |v| table().contains_key(&("t-b".to_string(), v));
        assert!(!alive(1) && alive(2) && alive(3), "version 1 is older than the oldest the scene names");
        // Loading outside `begin_scene` and `end_scene` drops nothing.
        let _ = hold("t-b", 3);
        assert!(alive(2));
        release("t-b");
        assert!(held.0.is_some(), "a scene keeps its picture when the store lets it go");
    }

    #[test]
    fn bytes_that_do_not_hold_the_rows_are_refused() {
        let mut short = picture(4, 4, 0);
        short.bytes.truncate(10);
        assert!(put("t-c", 1, short).is_err());
        let mut padded = picture(3, 2, 0);
        padded.row_bytes = 16;
        padded.bytes = vec![0; 16 + 12];
        assert_eq!(put("t-c", 1, padded), Ok(true));
        release("t-c");
    }
}
