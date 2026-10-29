//! The fonts of an island: only the files the project registered, no system
//! fonts, so a frame looks the same on every machine.
//!
//! `request.fonts` maps a font key (`fontKey` of `@kinetographdev/scene`: `Inter`
//! for 400 normal, `Inter:800`, `Inter:400i`) to a file. Each file is registered
//! in Parley's collection under the key's family name, weight and style, which
//! is what CSS font matching (`font-family` stack, `font-weight`, `font-style`)
//! selects on. Generic families (`sans-serif`, `serif`, ...) and anything the
//! stack does not name fall back to the registered families, in key order. A
//! character none of them has falls back to the symbol fonts the engine bundles
//! (`kinetograph_core::fallback_fonts`).

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

/// A font key split into family, weight and style. A weight range (`Family:300-1000`) gives its bottom.
pub fn parse_key(key: &str) -> (&str, f32, FontStyle) {
    let (family, weight, _, style) = parse_key_range(key);
    (family, weight, style)
}

/// A font key split into family, weight, the top of its weight range (a face declared
/// `font-weight: 300 1000` is the key `Family:300-1000`) and style.
pub fn parse_key_range(key: &str) -> (&str, f32, Option<f32>, FontStyle) {
    if let Some((family, rest)) = key.rsplit_once(':') {
        let (digits, italic) = match rest.strip_suffix('i') {
            Some(d) => (d, true),
            None => (rest, false),
        };
        let (low, high) = match digits.split_once('-') {
            Some((low, high)) => (low, Some(high)),
            None => (digits, None),
        };
        if let Ok(weight) = low.parse::<u16>()
            && let Some(high) = match high {
                None => Some(None),
                Some(h) => h.parse::<u16>().ok().map(Some),
            }
            && !family.is_empty()
        {
            let style = if italic {
                FontStyle::Italic
            } else {
                FontStyle::Normal
            };
            return (family, f32::from(weight), high.map(f32::from), style);
        }
    }
    (key, 400.0, None, FontStyle::Normal)
}

type Key = (String, u64, Option<SystemTime>);

/// Decoded font bytes by path, length and modification time. Reading and
/// unpacking a WOFF2 file for each frame would cost more than the frame; a
/// changed file has a new key, so the cache never serves stale bytes.
fn file_cache() -> &'static Mutex<BTreeMap<Key, Arc<Vec<u8>>>> {
    static CACHE: OnceLock<Mutex<BTreeMap<Key, Arc<Vec<u8>>>>> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

pub(crate) fn font_bytes(path: &str) -> Result<Arc<Vec<u8>>, String> {
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
        let (family, weight, weight_max, style) = parse_key_range(key);
        // Paths are absolute; a relative one is read from baseDir.
        let data = font_bytes(&base_dir.join(path).to_string_lossy())?;
        let registered = ctx.collection.register_fonts(
            Blob::new(data.clone()),
            Some(FontInfoOverride {
                family_name: Some(family),
                weight: Some(FontWeight::new(weight)),
                style: Some(style),
                // The file is the face of that weight: a variable font stays
                // at it (the vendored fontique, vendor/README.md). A face
                // declared with a weight range follows the requested weight
                // within it instead.
                pin_weight: weight_max.is_none(),
                weight_max,
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
    // one, else to the bundled JetBrains Mono; every other generic family prefers the proportional ones.
    let proportional: Vec<_> = families
        .iter()
        .copied()
        .filter(|id| !fixed_pitch.contains(id))
        .collect();
    // With none, the bundled JetBrains Mono leads, so code columns line up.
    let monospace_first: Vec<_> = if fixed_pitch.is_empty() {
        kinetograph_core::fallback_fonts::register_monospace(&mut ctx.collection)
            .into_iter()
            .chain(proportional.iter().copied())
            .collect()
    } else {
        fixed_pitch.iter().chain(&proportional).copied().collect()
    };
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
    // After the project's fonts and the generics built from them: a character
    // none of them has falls back to the bundled symbol fonts.
    kinetograph_core::fallback_fonts::register(&mut ctx.collection, &proportional_first);
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

    /// The family names of a generic family, in order.
    fn generic(ctx: &mut FontContext, generic: GenericFamily) -> Vec<String> {
        let ids: Vec<_> = ctx.collection.generic_families(generic).collect();
        ids.into_iter()
            .filter_map(|id| ctx.collection.family_name(id).map(str::to_string))
            .collect()
    }

    #[test]
    fn a_registered_fixed_pitch_font_leads_monospace_and_the_bundled_one_is_left_out() {
        let fixture = |name: &str| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/fonts")
                .join(name)
                .to_string_lossy()
                .into_owned()
        };
        let bundled = kinetograph_core::fallback_fonts::monospace_face().family;
        // A fixed-pitch font (the fixture is JetBrains Mono) leads, and the bundled one is not registered.
        let fonts = BTreeMap::from([
            (
                "Code".to_string(),
                fixture("jetbrains-mono-700-latin.woff2"),
            ),
            ("Text".to_string(), fixture("inter-800-latin.woff2")),
        ]);
        let mut ctx = font_context(&fonts, std::path::Path::new("")).unwrap();
        assert_eq!(
            generic(&mut ctx, GenericFamily::Monospace),
            ["Code", "Text"]
        );
        assert_eq!(
            generic(&mut ctx, GenericFamily::UiMonospace),
            ["Code", "Text"]
        );
        assert_eq!(
            generic(&mut ctx, GenericFamily::SansSerif),
            ["Text", "Code"]
        );
        // Without one, the bundled font leads `monospace`, and no other generic family.
        let fonts = BTreeMap::from([("Text".to_string(), fixture("inter-800-latin.woff2"))]);
        let mut ctx = font_context(&fonts, std::path::Path::new("")).unwrap();
        assert_eq!(
            generic(&mut ctx, GenericFamily::Monospace),
            [bundled, "Text"]
        );
        assert_eq!(
            generic(&mut ctx, GenericFamily::UiMonospace),
            [bundled, "Text"]
        );
        assert_eq!(generic(&mut ctx, GenericFamily::Serif), ["Text"]);
    }

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
        // A weight range, as `font-weight: 300 1000` registers it.
        assert_eq!(
            parse_key_range("Wave:300-1000"),
            ("Wave", 300.0, Some(1000.0), FontStyle::Normal)
        );
        assert_eq!(
            parse_key_range("Wave:100-900i"),
            ("Wave", 100.0, Some(900.0), FontStyle::Italic)
        );
        assert_eq!(parse_key_range("Foo:1-"), ("Foo:1-", 400.0, None, FontStyle::Normal));
    }
}
