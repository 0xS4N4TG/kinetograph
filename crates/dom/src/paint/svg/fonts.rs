//! The fonts usvg lays out SVG text with: the project's own, never the
//! system's, so a frame is the same on every machine.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock};

use usvg::fontdb::{self, Database, Language};

/// The font database for a request's fonts (`fontKey` -> file, the key being
/// `family:weight:style`), built once per distinct set. Each font is
/// registered under the family name of its key as well as the one in its own
/// tables, and the generic families (`sans-serif`, ...) resolve to the first.
pub fn database(fonts: &BTreeMap<String, String>) -> Arc<Database> {
    type Cache = Mutex<HashMap<BTreeMap<String, String>, Arc<Database>>>;
    static CACHE: OnceLock<Cache> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut cache = cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(db) = cache.get(fonts) {
        return db.clone();
    }
    let db = Arc::new(build(fonts));
    cache.insert(fonts.clone(), db.clone());
    db
}

fn build(fonts: &BTreeMap<String, String>) -> Database {
    let mut db = Database::new();
    let mut first: Option<String> = None;
    for (key, path) in fonts {
        let before: Vec<fontdb::ID> = db.faces().map(|f| f.id).collect();
        if db.load_font_file(path).is_err() {
            continue;
        }
        let added: Vec<fontdb::FaceInfo> = db
            .faces()
            .filter(|f| !before.contains(&f.id))
            .cloned()
            .collect();
        let mut parts = key.rsplitn(3, ':');
        let (style, weight, family) = (parts.next(), parts.next(), parts.next());
        let Some(family) = family else {
            continue;
        };
        first.get_or_insert_with(|| family.to_string());
        for mut info in added {
            info.families = vec![(family.to_string(), Language::English_UnitedStates)];
            if let Some(w) = weight.and_then(|w| w.parse::<u16>().ok()) {
                info.weight = fontdb::Weight(w);
            }
            match style {
                Some("italic") => info.style = fontdb::Style::Italic,
                Some("oblique") => info.style = fontdb::Style::Oblique,
                Some("normal") => info.style = fontdb::Style::Normal,
                _ => {}
            }
            db.push_face_info(info);
        }
    }
    if let Some(family) = first {
        db.set_serif_family(family.clone());
        db.set_sans_serif_family(family.clone());
        db.set_monospace_family(family.clone());
        db.set_cursive_family(family.clone());
        db.set_fantasy_family(family);
    }
    db
}

/// The family a text with no `font-family` is set in.
pub fn default_family(fonts: &BTreeMap<String, String>) -> String {
    fonts
        .keys()
        .next()
        .and_then(|k| k.rsplitn(3, ':').nth(2))
        .unwrap_or("sans-serif")
        .to_string()
}
