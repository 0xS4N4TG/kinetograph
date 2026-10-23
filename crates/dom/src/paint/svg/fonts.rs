//! The fonts usvg lays out SVG text with: the project's own, never the
//! system's, so a frame is the same on every machine.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock};

use usvg::fontdb::{self, Database, Language};

/// The font database for a request's fonts (`fontKey` -> file, the key being
/// `family:weight[i]`, see `fonts::parse_key`), built once per distinct set. Each font is
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
        let (family, weight, style) = crate::fonts::parse_key(key);
        first.get_or_insert_with(|| family.to_string());
        for mut info in added {
            info.families = vec![(family.to_string(), Language::English_UnitedStates)];
            info.weight = fontdb::Weight(weight as u16);
            info.style = match style {
                parley::fontique::FontStyle::Italic => fontdb::Style::Italic,
                _ => fontdb::Style::Normal,
            };
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
        .map_or("sans-serif", |k| crate::fonts::parse_key(k).0)
        .to_string()
}
