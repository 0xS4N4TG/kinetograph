//! The fonts that CSS generic and operating-system family names are set in.
//!
//! Kinetograph reads no system fonts, so a page that asks for `system-ui`, `Georgia` or `Menlo` would get whatever the
//! project registered first. These names map to three bundled families instead, on every machine: sans (`system-ui`,
//! `sans-serif`, `Arial`, `Segoe UI`, ...) is Inter, serif (`serif`, `Georgia`, `Times New Roman`, ...) is EB Garamond
//! (the font HyperFrames maps those names to), and mono (`monospace`, `Menlo`, `Consolas`, ...) is JetBrains Mono
//! (`fallback_fonts::monospace_face`). A family the project registers under one of these names is used as it is.
//!
//! The faces are Latin subsets (Inter is the variable face, weights 100 to 900); a character they lack falls back to
//! the symbol fonts and is reported when none has it.

use std::sync::{Arc, OnceLock};

use parley::fontique::{
    Blob, Collection, FamilyId, FontInfoOverride, FontStyle, FontWeight, GenericFamily,
};

use crate::fallback_fonts::Face;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Sans,
    Serif,
    Mono,
}

/// Lower-cased names that are not CSS generic families but that pages use as one: system fonts and the
/// `-apple-system` family. The CSS generic keywords are in [`kind_of`].
const SYSTEM_NAMES: [(Kind, &[&str]); 3] = [
    (
        Kind::Sans,
        &[
            "-apple-system",
            "blinkmacsystemfont",
            "segoe ui",
            "sf pro",
            "sf pro text",
            "sf pro display",
            "sf pro rounded",
            "helvetica",
            "helvetica neue",
            "arial",
            "tahoma",
            "verdana",
            "trebuchet ms",
            "lucida grande",
            "dejavu sans",
            "liberation sans",
        ],
    ),
    (
        Kind::Serif,
        &[
            "georgia",
            "times",
            "times new roman",
            "palatino",
            "palatino linotype",
            "book antiqua",
            "cambria",
            "garamond",
            "dejavu serif",
            "liberation serif",
        ],
    ),
    (
        Kind::Mono,
        &[
            "sfmono-regular",
            "sf mono",
            "menlo",
            "monaco",
            "consolas",
            "courier",
            "courier new",
            "lucida console",
            "andale mono",
            "cascadia code",
            "cascadia mono",
            "dejavu sans mono",
            "liberation mono",
        ],
    ),
];

/// The CSS generic family keywords. `cursive` and `fantasy` are sans, as they have no face of their own.
fn generic_kind(lower: &str) -> Option<Kind> {
    match lower {
        "sans-serif" | "system-ui" | "ui-sans-serif" | "ui-rounded" | "cursive" | "fantasy" => {
            Some(Kind::Sans)
        }
        "serif" | "ui-serif" => Some(Kind::Serif),
        "monospace" | "ui-monospace" => Some(Kind::Mono),
        _ => None,
    }
}

/// Whether `name` is a CSS generic family keyword (`serif`, `system-ui`, ...), which the font list falls back to.
pub fn is_generic(name: &str) -> bool {
    generic_kind(&name.trim().to_ascii_lowercase()).is_some()
}

/// Which bundled font a family name from a `font-family` list is set in, if it is a generic or system name. Case does
/// not matter. A system name (`Georgia`) is only set in it through a generic keyword that follows it in the list
/// (`Georgia, serif`): the name itself is not a family of the collection.
pub fn kind_of(name: &str) -> Option<Kind> {
    let lower = name.trim().to_ascii_lowercase();
    generic_kind(&lower).or_else(|| {
        SYSTEM_NAMES
            .iter()
            .find(|(_, names)| names.contains(&lower.as_str()))
            .map(|(kind, _)| *kind)
    })
}

/// The first generic or system name of a comma-separated family list (`"JetBrains Mono", Menlo, monospace` is mono),
/// which is the font the list is set in when it names no family that is loaded.
pub fn kind_of_list(list: &str) -> Option<Kind> {
    list.split(',').find_map(|name| kind_of(name.trim().trim_matches(['"', '\''])))
}

/// A bundled face and the weight (range) it is registered under.
pub struct Styled {
    pub face: Face,
    pub weight: f32,
    /// The top of the weight range of a variable face.
    pub weight_max: Option<f32>,
}

fn unpack(name: &'static str, family: &'static str, woff2: &[u8]) -> Face {
    let data = Arc::new(
        wuff::decompress_woff2(woff2).unwrap_or_else(|e| panic!("bundled font {name}: {e:?}")),
    );
    Face {
        name,
        family,
        blob: Blob::new(data.clone()),
        data,
    }
}

/// Inter, the variable face. Unpacked on first use.
pub fn sans() -> &'static [Styled] {
    static FACES: OnceLock<[Styled; 1]> = OnceLock::new();
    FACES.get_or_init(|| {
        [Styled {
            face: unpack(
                "Inter",
                "Kinetograph Sans",
                include_bytes!("../fonts/Inter-Variable-latin.woff2"),
            ),
            weight: 100.0,
            weight_max: Some(900.0),
        }]
    })
}

/// EB Garamond, regular and bold. Unpacked on first use.
pub fn serif() -> &'static [Styled] {
    static FACES: OnceLock<[Styled; 2]> = OnceLock::new();
    FACES.get_or_init(|| {
        [
            Styled {
                face: unpack(
                    "EBGaramond",
                    "Kinetograph Serif",
                    include_bytes!("../fonts/EBGaramond-Regular-latin.woff2"),
                ),
                weight: 400.0,
                weight_max: None,
            },
            Styled {
                face: unpack(
                    "EBGaramondBold",
                    "Kinetograph Serif",
                    include_bytes!("../fonts/EBGaramond-Bold-latin.woff2"),
                ),
                weight: 700.0,
                weight_max: None,
            },
        ]
    })
}

/// The bundled faces of the sans and serif families.
pub fn faces() -> impl Iterator<Item = &'static Face> {
    sans().iter().chain(serif()).map(|s| &s.face)
}

/// Registers `faces` in `collection` under their family name and returns the family.
fn register_family(collection: &mut Collection, faces: &[Styled]) -> Vec<FamilyId> {
    let mut ids = Vec::new();
    for s in faces {
        let registered = collection.register_fonts(
            s.face.blob.clone(),
            Some(FontInfoOverride {
                family_name: Some(s.face.family),
                weight: Some(FontWeight::new(s.weight)),
                style: Some(FontStyle::Normal),
                // A fixed face stays at its weight (the vendored fontique, vendor/README.md); the variable one follows the request.
                pin_weight: s.weight_max.is_none(),
                weight_max: s.weight_max,
                ..Default::default()
            }),
        );
        for (id, _) in registered {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    ids
}

/// Registers Inter and EB Garamond in `collection`: the families for the sans and serif generic families, in that order.
pub fn register(collection: &mut Collection) -> (Vec<FamilyId>, Vec<FamilyId>) {
    (
        register_family(collection, sans()),
        register_family(collection, serif()),
    )
}

/// The generic families a [`Kind`] stands for.
pub fn generics(kind: Kind) -> &'static [GenericFamily] {
    match kind {
        Kind::Sans => &[
            GenericFamily::SansSerif,
            GenericFamily::Cursive,
            GenericFamily::Fantasy,
            GenericFamily::SystemUi,
            GenericFamily::UiSansSerif,
            GenericFamily::UiRounded,
        ],
        Kind::Serif => &[GenericFamily::Serif, GenericFamily::UiSerif],
        Kind::Mono => &[GenericFamily::Monospace, GenericFamily::UiMonospace],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generic_and_system_names_map_to_a_kind() {
        for (name, kind) in [
            ("sans-serif", Kind::Sans),
            ("system-ui", Kind::Sans),
            ("-apple-system", Kind::Sans),
            ("BlinkMacSystemFont", Kind::Sans),
            ("Segoe UI", Kind::Sans),
            ("  Helvetica Neue ", Kind::Sans),
            ("serif", Kind::Serif),
            ("Georgia", Kind::Serif),
            ("Times New Roman", Kind::Serif),
            ("monospace", Kind::Mono),
            ("ui-monospace", Kind::Mono),
            ("SFMono-Regular", Kind::Mono),
            ("Menlo", Kind::Mono),
            ("Consolas", Kind::Mono),
        ] {
            assert_eq!(kind_of(name), Some(kind), "{name}");
        }
        // Web fonts are not system names: a page that wants one has to register it.
        for name in ["Inter", "Roboto", "Poppins", "", "inherit"] {
            assert_eq!(kind_of(name), None, "{name}");
        }
    }

    #[test]
    fn every_generic_family_belongs_to_one_kind() {
        let mut seen = Vec::new();
        for kind in [Kind::Sans, Kind::Serif, Kind::Mono] {
            for g in generics(kind) {
                assert!(!seen.contains(g), "{g:?} is in two kinds");
                seen.push(*g);
            }
        }
    }

    #[test]
    fn the_bundled_families_unpack_and_register() {
        for f in faces() {
            assert!(f.data.starts_with(&[0, 1, 0, 0]), "{} is TrueType", f.name);
        }
        let mut collection = Collection::new(parley::fontique::CollectionOptions {
            shared: false,
            system_fonts: false,
        });
        let (sans, serif) = register(&mut collection);
        assert_eq!(sans.len(), 1);
        assert_eq!(serif.len(), 1, "regular and bold are one family");
        assert_eq!(collection.family_name(sans[0]), Some("Kinetograph Sans"));
        assert_eq!(collection.family_name(serif[0]), Some("Kinetograph Serif"));
    }
}
