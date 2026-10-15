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
pub fn font_context(fonts: &BTreeMap<String, String>) -> Result<FontContext, String> {
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
    for (key, path) in fonts {
        let (family, weight, style) = parse_key(key);
        let data = font_bytes(path)?;
        let registered = ctx.collection.register_fonts(
            Blob::new(data),
            Some(FontInfoOverride {
                family_name: Some(family),
                weight: Some(FontWeight::new(weight)),
                style: Some(style),
                ..Default::default()
            }),
        );
        if registered.is_empty() {
            return Err(format!("{path} contains no usable font"));
        }
        for (id, _) in registered {
            if !families.contains(&id) {
                families.push(id);
            }
        }
    }
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
        ctx.collection
            .append_generic_families(generic, families.iter().copied());
    }
    Ok(ctx)
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
