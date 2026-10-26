//! Which font file a Parley run was shaped with.
//!
//! The scene draws glyph runs from font files; Blitz's layouts hold the fonts'
//! bytes. A run's font is matched to a file in `IslandRequest::fonts` by
//! its bytes (once per font, remembered by the bytes' identity), or by a
//! path the front half registered with `register_font_path`.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use parley::FontData;

use super::Painter;

fn registered() -> &'static Mutex<HashMap<u64, String>> {
    static REGISTERED: OnceLock<Mutex<HashMap<u64, String>>> = OnceLock::new();
    REGISTERED.get_or_init(Default::default)
}

/// Tells the painter that the font whose data blob has id `blob_id` came from
/// `path` (the front half calls this when it registers a font file, so no
/// bytes need comparing).
pub fn register_font_path(blob_id: u64, path: impl Into<String>) {
    registered().lock().unwrap().insert(blob_id, path.into());
}

type Matches = Mutex<HashMap<(u64, usize), Option<String>>>;

fn matched() -> &'static Matches {
    static MATCHED: OnceLock<Matches> = OnceLock::new();
    MATCHED.get_or_init(Default::default)
}

impl<'a> Painter<'a> {
    /// The path of the file `font` was read from, if the request lists it.
    pub fn font_path(&self, font: &FontData) -> Option<String> {
        let blob_id = font.data.id();
        // A bundled fallback font has no file: the glyph run names it `builtin:<name>`.
        if let Some(builtin) = kinetograph_core::fallback_fonts::name_of_blob(blob_id) {
            return Some(builtin);
        }
        if let Some(p) = registered().lock().unwrap().get(&blob_id) {
            return Some(p.clone());
        }
        // Same bytes as one of the request's files? (Also keyed by the number
        // of files, so a longer list is looked at again.)
        let key = (blob_id, self.req.fonts.len());
        if let Some(found) = matched().lock().unwrap().get(&key) {
            return found.clone();
        }
        let bytes = font.data.data();
        let mut found = None;
        for path in self.req.fonts.values() {
            let Ok(file) = std::fs::read(path) else {
                continue;
            };
            let file = blitz_dom::decode_font_bytes(&file);
            if file.as_ref() == bytes {
                found = Some(path.clone());
                break;
            }
        }
        matched().lock().unwrap().insert(key, found.clone());
        found
    }
}
