//! The fonts text falls back to for a character its own font lacks (an arrow, a
//! check mark, a maths sign, an emoji), as a browser falls back to a system font.
//!
//! Kinetograph reads no system fonts, so the fallbacks ship with the engine:
//! Noto Sans Symbols 2, Noto Sans Math and Noto Emoji (monochrome), SIL OFL 1.1
//! (`fonts/OFL.txt`). The order is fixed, so a character is drawn in the same
//! font on every machine: the CSS `font-family` list first, then these in the
//! order of [`SOURCES`]. CJK and other scripts are not covered; what no font has
//! is reported (`LaidOutText::missing_chars`, the DOM painter's `report`).
//!
//! Glyph runs name a font by file (`GlyphRun::src`); a fallback is named
//! `builtin:<name>` instead, which [`face`] resolves.

use std::sync::{Arc, OnceLock};

use parley::fontique::{
    Blob, Collection, FallbackKey, FamilyId, FontInfoOverride, GenericFamily, Script,
};

/// What a glyph run's `src` starts with when it names a bundled fallback font.
pub const BUILTIN_PREFIX: &str = "builtin:";

/// Name, family name in the collection and WOFF2 file, in fallback order.
/// Symbols and dingbats come before the maths font so that a ✓ or a ★ is
/// drawn in the dingbat style; arrows and operators are in the maths font only.
const SOURCES: [(&str, &str, &[u8]); 3] = [
    (
        "NotoSansSymbols2",
        "Kinetograph Fallback Symbols 2",
        include_bytes!("../fonts/NotoSansSymbols2-Regular.woff2"),
    ),
    (
        "NotoSansMath",
        "Kinetograph Fallback Math",
        include_bytes!("../fonts/NotoSansMath-Regular.woff2"),
    ),
    (
        "NotoEmoji",
        "Kinetograph Fallback Emoji",
        include_bytes!("../fonts/NotoEmoji-Regular.woff2"),
    ),
];

/// The scripts whose text falls back to these. fontique also appends the Han
/// list to every query, which covers the rest; naming the common ones keeps
/// this working if that goes.
const SCRIPTS: [[u8; 4]; 6] = [*b"Zyyy", *b"Zinh", *b"Latn", *b"Grek", *b"Cyrl", *b"Hani"];

/// A bundled fallback font, unpacked.
pub struct Face {
    /// The `builtin:` name.
    pub name: &'static str,
    pub family: &'static str,
    /// The plain TrueType bytes.
    pub data: Arc<Vec<u8>>,
    /// One blob for every collection, so its id names the font.
    pub blob: Blob<u8>,
}

/// The bundled fallback fonts, in fallback order. Unpacked on first use.
pub fn faces() -> &'static [Face] {
    static FACES: OnceLock<Vec<Face>> = OnceLock::new();
    FACES.get_or_init(|| {
        SOURCES
            .iter()
            .map(|(name, family, woff2)| {
                let data = Arc::new(
                    wuff::decompress_woff2(woff2)
                        .unwrap_or_else(|e| panic!("bundled font {name}: {e:?}")),
                );
                Face {
                    name,
                    family,
                    blob: Blob::new(data.clone()),
                    data,
                }
            })
            .collect()
    })
}

/// The face a `builtin:` glyph-run `src` names.
pub fn face(src: &str) -> Option<&'static Face> {
    let name = src.strip_prefix(BUILTIN_PREFIX)?;
    faces().iter().find(|f| f.name == name)
}

/// The `builtin:` name of the face whose blob has this id.
pub fn name_of_blob(blob_id: u64) -> Option<String> {
    faces()
        .iter()
        .find(|f| f.blob.id() == blob_id)
        .map(|f| format!("{BUILTIN_PREFIX}{}", f.name))
}

/// Adds the fallback fonts to `collection`, as the fallback of the common scripts and as the emoji family. `project`
/// are the families the project registered, in the order text that names none of them is set in; they lead each
/// fallback list, so the bundled fonts are only reached for a character none of the project's fonts has. (Without
/// them, text in a family that is not loaded would take the first bundled font that has its letters.)
pub fn register(collection: &mut Collection, project: &[FamilyId]) {
    let mut ids: Vec<FamilyId> = Vec::new();
    for face in faces() {
        let registered = collection.register_fonts(
            face.blob.clone(),
            Some(FontInfoOverride {
                family_name: Some(face.family),
                ..Default::default()
            }),
        );
        for (id, _) in registered {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    for script in SCRIPTS {
        collection.append_fallbacks(
            FallbackKey::new(Script::from_bytes(script), None),
            project.iter().chain(&ids).copied(),
        );
    }
    if let Some(emoji) = ids.last() {
        collection.append_generic_families(GenericFamily::Emoji, std::iter::once(*emoji));
    }
}

/// Characters a browser does not draw when no font has them (spaces, controls,
/// joiners, variation selectors): a missing glyph for one is not a gap.
pub fn is_invisible(c: char) -> bool {
    c.is_whitespace()
        || c.is_control()
        || matches!(c as u32,
            0x00AD | 0x034F | 0x061C | 0x115F..=0x1160 | 0x17B4..=0x17B5 | 0x180B..=0x180F
            | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x206F | 0x3164
            | 0xFE00..=0xFE0F | 0xFEFF | 0xFFA0 | 0xFFF0..=0xFFF8 | 0xE0000..=0xE0FFF)
}

/// The characters of `text` a run of glyphs left as the font's missing-glyph
/// box, by code point index, each once and in order of appearance.
pub fn missing_chars(text: &str, glyph_char_indices: impl Iterator<Item = usize>) -> Vec<char> {
    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<char> = Vec::new();
    for index in glyph_char_indices {
        if let Some(&c) = chars.get(index)
            && !is_invisible(c)
            && !out.contains(&c)
        {
            out.push(c);
        }
    }
    out
}

/// `U+2192 "→"` for each of `chars`, joined, with `and N more` after the
/// first few.
pub fn describe(chars: &[char]) -> String {
    const SHOWN: usize = 6;
    let mut parts: Vec<String> = chars
        .iter()
        .take(SHOWN)
        .map(|c| format!("U+{:04X} \"{c}\"", *c as u32))
        .collect();
    if chars.len() > SHOWN {
        parts.push(format!("and {} more", chars.len() - SHOWN));
    }
    parts.join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_fonts_unpack_and_are_named() {
        let names: Vec<_> = faces().iter().map(|f| f.name).collect();
        assert_eq!(names, ["NotoSansSymbols2", "NotoSansMath", "NotoEmoji"]);
        for f in faces() {
            assert!(f.data.starts_with(&[0, 1, 0, 0]), "{} is TrueType", f.name);
            assert!(face(&format!("builtin:{}", f.name)).is_some());
            assert_eq!(
                name_of_blob(f.blob.id()),
                Some(format!("builtin:{}", f.name))
            );
        }
        assert!(face("builtin:Nope").is_none());
        assert!(face("DMSans.ttf").is_none());
    }

    #[test]
    fn spaces_and_joiners_are_not_gaps() {
        let text = "a \u{200B}\u{FE0F}→\n";
        assert_eq!(missing_chars(text, 0..text.chars().count()), ['a', '→']);
    }

    #[test]
    fn describes_characters_by_code_point() {
        assert_eq!(describe(&['→']), "U+2192 \"→\"");
        let many: Vec<char> = ('a'..='h').collect();
        assert!(describe(&many).ends_with("and 2 more"));
    }
}
