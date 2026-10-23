//! The fonts of an island: only the files the project registered, no system
//! fonts, so a frame looks the same on every machine.
//!
//! `request.fonts` maps a font key (`fontKey` of `@kinetograph/scene`: `Inter`
//! for 400 normal, `Inter:800`, `Inter:400i`) to a file. Each file is registered
//! in Parley's collection under the key's family name, weight and style, which
//! is what CSS font matching (`font-family` stack, `font-weight`, `font-style`)
//! selects on. Generic families (`sans-serif`, `serif`, ...) and anything the
//! stack does not name fall back to the registered families, in key order.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use blitz_dom::FontContext;
use parley::fontique::{
    Blob, Collection, CollectionOptions, FontInfoOverride, FontStyle, FontWeight, GenericFamily,
    SourceCache,
};

/// The key the host registers the built-in fallback font under when the project
/// registered no font at all. Text then has to be set in it, which is not what
/// the author asked for, so the painter reports it.
pub const FALLBACK_KEY: &str = "Kinetograph Fallback";

/// Whether `fonts` is only the built-in fallback.
pub fn is_fallback(fonts: &BTreeMap<String, String>) -> bool {
    fonts.contains_key(FALLBACK_KEY)
}

/// The reason text set in the built-in fallback is reported with.
pub const FALLBACK_REASON: &str = "font not loaded; drawn with the built-in fallback";

/// The reason text is reported with when none of its families is loaded but
/// other fonts are: it is drawn in whichever registered font the engine picks.
pub const UNLOADED_REASON: &str = "font not loaded; drawn with another loaded font";

/// Why text asking for the font-family `stack` (as CSS writes it) is not set
/// in a font of the project's, if it is not: none of its families is
/// registered. Generic families alone (`serif`) name nothing loaded.
pub fn unloaded_reason(stack: &str, fonts: &BTreeMap<String, String>) -> Option<&'static str> {
    let loaded = |name: &str| {
        fonts
            .keys()
            .filter(|k| k.as_str() != FALLBACK_KEY)
            .any(|k| parse_key(k).0.eq_ignore_ascii_case(name))
    };
    let named = stack
        .split(',')
        .map(|f| f.trim().trim_matches(|c| c == '"' || c == '\'').trim())
        .any(|f| !f.is_empty() && loaded(f));
    if named {
        None
    } else if is_fallback(fonts) {
        Some(FALLBACK_REASON)
    } else {
        Some(UNLOADED_REASON)
    }
}

/// Every `font-family` an SVG source sets, as attribute or in a `style`.
pub fn families_in_xml(xml: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (marker, ends) in [
        ("font-family=\"", &['"'][..]),
        ("font-family='", &['\''][..]),
        ("font-family:", &[';', '"'][..]),
    ] {
        for part in xml.split(marker).skip(1) {
            let value = part.split(|c| ends.contains(&c)).next().unwrap_or("");
            let value = value
                .replace("&quot;", "\"")
                .replace("&apos;", "'")
                .replace("&#39;", "'")
                .trim()
                .to_string();
            if !value.is_empty() && !out.contains(&value) {
                out.push(value);
            }
        }
    }
    out
}

/// A font key split into family, weight and style.
pub fn parse_key(key: &str) -> (&str, f32, FontStyle) {
    if let Some((family, rest)) = key.rsplit_once(':') {
        let (digits, italic) = match rest.strip_suffix('i') {
            Some(d) => (d, true),
            None => (rest, false),
        };
        if let Ok(weight) = digits.parse::<u16>()
            && !family.is_empty()
        {
            let style = if italic {
                FontStyle::Italic
            } else {
                FontStyle::Normal
            };
            return (family, f32::from(weight), style);
        }
    }
    (key, 400.0, FontStyle::Normal)
}

type Key = (String, u64, Option<SystemTime>);

/// Decoded font bytes by path, length and modification time. Reading and
/// unpacking a WOFF2 file for each frame would cost more than the frame; a
/// changed file has a new key, so the cache never serves stale bytes.
fn file_cache() -> &'static Mutex<BTreeMap<Key, Arc<Vec<u8>>>> {
    static CACHE: OnceLock<Mutex<BTreeMap<Key, Arc<Vec<u8>>>>> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

fn font_bytes(path: &str) -> Result<Arc<Vec<u8>>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{path}: {e}"))?;
    let key = (path.to_string(), meta.len(), meta.modified().ok());
    if let Ok(cache) = file_cache().lock()
        && let Some(hit) = cache.get(&key)
    {
        return Ok(hit.clone());
    }
    let raw = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    let data = Arc::new(blitz_dom::decode_font_bytes(&raw).into_owned());
    if let Ok(mut cache) = file_cache().lock() {
        cache.insert(key, data.clone());
    }
    Ok(data)
}

/// A Parley context holding exactly `fonts` (and Blitz's list-marker font).
pub fn font_context(
    fonts: &BTreeMap<String, String>,
    base_dir: &std::path::Path,
) -> Result<FontContext, String> {
    let mut ctx = FontContext {
        source_cache: SourceCache::new_shared(),
        collection: Collection::new(CollectionOptions {
            shared: false,
            system_fonts: false,
        }),
    };
    ctx.collection
        .register_fonts(Blob::new(Arc::new(blitz_dom::BULLET_FONT) as _), None);

    let mut families = Vec::new();
    let mut fixed_pitch = Vec::new();
    for (key, path) in fonts {
        let (family, weight, style) = parse_key(key);
        // Paths are absolute; a relative one is read from baseDir.
        let data = font_bytes(&base_dir.join(path).to_string_lossy())?;
        let registered = ctx.collection.register_fonts(
            Blob::new(data.clone()),
            Some(FontInfoOverride {
                family_name: Some(family),
                weight: Some(FontWeight::new(weight)),
                style: Some(style),
                // The file is the face of that weight: a variable font stays
                // at it (the vendored fontique, vendor/README.md).
                pin_weight: true,
                ..Default::default()
            }),
        );
        if registered.is_empty() {
            return Err(format!("{path} contains no usable font"));
        }
        let mono = is_fixed_pitch(&data);
        for (id, _) in registered {
            if !families.contains(&id) {
                families.push(id);
            }
            if mono && !fixed_pitch.contains(&id) {
                fixed_pitch.push(id);
            }
        }
    }
    // `monospace` falls back to a fixed-pitch font if the project registered
    // one; every other generic family prefers the proportional ones.
    let proportional: Vec<_> = families
        .iter()
        .copied()
        .filter(|id| !fixed_pitch.contains(id))
        .collect();
    let monospace_first: Vec<_> = fixed_pitch.iter().chain(&proportional).copied().collect();
    let proportional_first: Vec<_> = proportional.iter().chain(&fixed_pitch).copied().collect();
    for generic in [
        GenericFamily::SansSerif,
        GenericFamily::Serif,
        GenericFamily::Monospace,
        GenericFamily::Cursive,
        GenericFamily::Fantasy,
        GenericFamily::SystemUi,
        GenericFamily::UiSansSerif,
        GenericFamily::UiSerif,
        GenericFamily::UiMonospace,
        GenericFamily::UiRounded,
    ] {
        let order = match generic {
            GenericFamily::Monospace | GenericFamily::UiMonospace => &monospace_first,
            _ => &proportional_first,
        };
        ctx.collection
            .append_generic_families(generic, order.iter().copied());
    }
    Ok(ctx)
}

/// Whether the font says all its glyphs are as wide as each other (the `post`
/// table's fixed-pitch flag).
fn is_fixed_pitch(data: &[u8]) -> bool {
    use read_fonts::{FontRef, TableProvider as _};
    FontRef::from_index(data, 0)
        .ok()
        .and_then(|font| font.post().ok())
        .is_some_and(|post| post.is_fixed_pitch() != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_font_keys() {
        assert_eq!(parse_key("Inter"), ("Inter", 400.0, FontStyle::Normal));
        assert_eq!(parse_key("Inter:800"), ("Inter", 800.0, FontStyle::Normal));
        assert_eq!(parse_key("Inter:400i"), ("Inter", 400.0, FontStyle::Italic));
        assert_eq!(
            parse_key("DM Sans:700i"),
            ("DM Sans", 700.0, FontStyle::Italic)
        );
        // A colon that is not a weight stays in the family name.
        assert_eq!(parse_key("Foo:Bar"), ("Foo:Bar", 400.0, FontStyle::Normal));
    }
}
