//! 3D colour lookup tables from Adobe/Resolve `.cube` files, for the `lut`
//! effect. Parsing is plain Rust; `compositor.rs` uploads the table and
//! `shaders/lut.wgsl` applies it.

use std::path::Path;

use crate::error::{Error, Result};
use crate::scene::{Effect, Layer, Scene, walk_layers};

pub const MIN_LUT_SIZE: u32 = 2;
pub const MAX_LUT_SIZE: u32 = 64;

/// A 3D LUT: `size`^3 output colours for the grid of input colours.
#[derive(Clone, Debug, PartialEq)]
pub struct Lut {
    /// Points per axis.
    pub size: u32,
    /// The input values that map to the first and last grid point of each
    /// channel; inputs outside are clamped to them.
    pub domain_min: [f32; 3],
    pub domain_max: [f32; 3],
    /// `size`^3 rows of r, g, b, red index varying fastest, then green, then
    /// blue (the order of the file).
    pub rgb: Vec<[f32; 3]>,
}

impl Lut {
    /// Parses the text of a `.cube` file. Errors start with `line N:`.
    ///
    /// Understood: `TITLE` and `#` comments (ignored), `DOMAIN_MIN`,
    /// `DOMAIN_MAX`, `LUT_3D_SIZE` and the data rows. A 1D table
    /// (`LUT_1D_SIZE`) or any other keyword is an error.
    pub fn parse(text: &str) -> std::result::Result<Lut, String> {
        let mut size: Option<u32> = None;
        let mut domain_min = [0.0; 3];
        let mut domain_max = [1.0; 3];
        let mut rgb: Vec<[f32; 3]> = Vec::new();
        let mut last_line = 0;
        for (index, raw) in text.lines().enumerate() {
            let line_number = index + 1;
            last_line = line_number;
            let bad = |msg: String| Err(format!("line {line_number}: {msg}"));
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut words = line.split_whitespace();
            let first = words.next().unwrap_or_default();
            // The title is free text; anything else loses a trailing comment.
            if first == "TITLE" {
                continue;
            }
            let line = line.split('#').next().unwrap_or_default();
            let rest: Vec<&str> = line.split_whitespace().skip(1).collect();
            match first {
                "LUT_1D_SIZE" => {
                    return bad(
                        "1D LUTs are not supported; export a 3D LUT (LUT_3D_SIZE)".to_string()
                    );
                }
                "LUT_3D_SIZE" => {
                    if size.is_some() {
                        return bad("LUT_3D_SIZE given twice".to_string());
                    }
                    let n = match rest[..] {
                        [n] => n.parse::<u32>().ok(),
                        _ => None,
                    };
                    let Some(n) = n.filter(|n| (MIN_LUT_SIZE..=MAX_LUT_SIZE).contains(n)) else {
                        return bad(format!(
                            "LUT_3D_SIZE must be a whole number from {MIN_LUT_SIZE} to \
                             {MAX_LUT_SIZE}, got {:?}",
                            rest.join(" ")
                        ));
                    };
                    size = Some(n);
                    rgb.reserve((n * n * n) as usize);
                }
                "DOMAIN_MIN" | "DOMAIN_MAX" => {
                    let Some(values) = triple(&rest) else {
                        return bad(format!("{first} needs three numbers"));
                    };
                    if first == "DOMAIN_MIN" {
                        domain_min = values;
                    } else {
                        domain_max = values;
                    }
                }
                _ if first.parse::<f32>().is_ok() => {
                    let Some(n) = size else {
                        return bad("a data row before LUT_3D_SIZE".to_string());
                    };
                    let words: Vec<&str> = line.split_whitespace().collect();
                    let Some(row) = triple(&words) else {
                        return bad(format!("a data row needs three numbers, got {line:?}"));
                    };
                    if rgb.len() == (n * n * n) as usize {
                        return bad(format!(
                            "more than the {} rows a size-{n} LUT has",
                            n * n * n
                        ));
                    }
                    rgb.push(row);
                }
                _ => return bad(format!("unknown keyword {first:?}")),
            }
        }
        let Some(size) = size else {
            return Err("no LUT_3D_SIZE: not a 3D .cube file".to_string());
        };
        let expected = (size * size * size) as usize;
        if rgb.len() != expected {
            return Err(format!(
                "line {last_line}: a size-{size} LUT has {expected} rows, found {}",
                rgb.len()
            ));
        }
        if (0..3).any(|c| domain_max[c] <= domain_min[c]) {
            return Err(format!(
                "DOMAIN_MAX {domain_max:?} must be above DOMAIN_MIN {domain_min:?} in every channel"
            ));
        }
        Ok(Lut {
            size,
            domain_min,
            domain_max,
            rgb,
        })
    }

    /// The table as the RGBA32F texels the GPU reads (alpha 1), red varying
    /// fastest like the file.
    pub fn rgba(&self) -> Vec<f32> {
        self.rgb
            .iter()
            .flat_map(|[r, g, b]| [*r, *g, *b, 1.0])
            .collect()
    }
}

/// Three finite numbers, or `None`.
fn triple(words: &[&str]) -> Option<[f32; 3]> {
    let [r, g, b] = words else {
        return None;
    };
    let parse = |w: &str| w.parse::<f32>().ok().filter(|v| v.is_finite());
    Some([parse(r)?, parse(g)?, parse(b)?])
}

/// Every `lut` effect in the scene as (layer id, `src`), in order of use.
fn sources(layers: &[Layer], out: &mut Vec<(String, String)>) {
    walk_layers(layers, &mut |layer| {
        for effect in &layer.effects {
            if let Effect::Lut { src, .. } = effect {
                out.push((layer.id.clone(), src.clone()));
            }
        }
    });
}

/// Every `lut` effect in the scene as (layer id, `src`), in order of use. A
/// table used twice is listed twice.
pub(crate) fn lut_sources(scene: &Scene) -> Vec<(String, String)> {
    let mut used = Vec::new();
    sources(&scene.layers, &mut used);
    used
}

/// Reads and parses the LUT file `src` (relative to `base_dir`) that layer
/// `id` uses. Errors name the layer, the file, and for a malformed file the
/// line.
pub(crate) fn read_lut(base_dir: &Path, id: &str, src: &str) -> Result<Lut> {
    let path = base_dir.join(src);
    let fail = |msg: String| Error::Scene(format!("layer {id:?}: lut {}: {msg}", path.display()));
    let text = std::fs::read_to_string(&path).map_err(|e| fail(format!("cannot read: {e}")))?;
    Lut::parse(&text).map_err(fail)
}

/// Reads and parses every LUT file the scene refers to, once each, keyed by
/// the `src` as the scene spells it. The renderer reads them a file at a time
/// (`render::read_assets`); this is for the test that every committed scene's
/// files load.
#[cfg(test)]
pub(crate) fn load_luts(scene: &Scene) -> Result<std::collections::HashMap<String, Lut>> {
    let mut luts = std::collections::HashMap::new();
    for (id, src) in lut_sources(scene) {
        if luts.contains_key(&src) {
            continue;
        }
        let lut = read_lut(&scene.base_dir, &id, &src)?;
        luts.insert(src, lut);
    }
    Ok(luts)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A size-2 identity cube: red varies fastest.
    fn identity(extra: &str) -> String {
        format!(
            "TITLE \"identity # not a comment\"\n# a comment\n{extra}LUT_3D_SIZE 2\n\
             0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n"
        )
    }

    #[test]
    fn parses_an_identity_cube() {
        let lut = Lut::parse(&identity("")).unwrap();
        assert_eq!(lut.size, 2);
        assert_eq!((lut.domain_min, lut.domain_max), ([0.0; 3], [1.0; 3]));
        assert_eq!(lut.rgb.len(), 8);
        // Red varies fastest: the second row is pure red, the third pure
        // green, the fifth pure blue.
        assert_eq!(lut.rgb[1], [1.0, 0.0, 0.0]);
        assert_eq!(lut.rgb[2], [0.0, 1.0, 0.0]);
        assert_eq!(lut.rgb[4], [0.0, 0.0, 1.0]);
        let rgba = lut.rgba();
        assert_eq!(rgba.len(), 32);
        assert_eq!(&rgba[4..8], [1.0, 0.0, 0.0, 1.0]);
    }

    #[test]
    fn reads_the_domain_and_tolerates_layout_variations() {
        let text = identity("DOMAIN_MIN -0.5 0 0.25\nDOMAIN_MAX 2 1 1.5 # trailing comment\n")
            .replace('\n', "\r\n")
            .replace("0 0 0\r\n", "  0.0\t0.0   0.0  \r\n\r\n");
        let lut = Lut::parse(&text).unwrap();
        assert_eq!(lut.domain_min, [-0.5, 0.0, 0.25]);
        assert_eq!(lut.domain_max, [2.0, 1.0, 1.5]);
        assert_eq!(lut.rgb[0], [0.0; 3]);
        // Exponent notation, as Resolve writes it.
        let text = identity("").replace("1 1 1\n", "1.0e0 9.9E-1 1\n");
        assert_eq!(Lut::parse(&text).unwrap().rgb[7], [1.0, 0.99, 1.0]);
    }

    #[test]
    fn errors_say_which_line() {
        let cases = [
            (
                "LUT_1D_SIZE 4\n0 0 0\n",
                "line 1: 1D LUTs are not supported",
            ),
            (
                "LUT_3D_SIZE 1\n",
                "line 1: LUT_3D_SIZE must be a whole number from 2 to 64",
            ),
            (
                "LUT_3D_SIZE 65\n",
                "line 1: LUT_3D_SIZE must be a whole number from 2 to 64",
            ),
            ("LUT_3D_SIZE two\n", "line 1: LUT_3D_SIZE"),
            (
                "# c\nLUT_3D_SIZE 2\nLUT_3D_SIZE 2\n",
                "line 3: LUT_3D_SIZE given twice",
            ),
            (
                "0 0 0\nLUT_3D_SIZE 2\n",
                "line 1: a data row before LUT_3D_SIZE",
            ),
            (
                "LUT_3D_SIZE 2\n0 0\n",
                "line 2: a data row needs three numbers",
            ),
            (
                "LUT_3D_SIZE 2\n0 0 x\n",
                "line 2: a data row needs three numbers",
            ),
            (
                "LUT_3D_SIZE 2\n0 0 0 0\n",
                "line 2: a data row needs three numbers",
            ),
            (
                "LUT_3D_SIZE 2\nDOMAIN_MIN 0 0\n",
                "line 2: DOMAIN_MIN needs three numbers",
            ),
            (
                "LUT_3D_SIZE 2\nBOGUS 1\n",
                "line 2: unknown keyword \"BOGUS\"",
            ),
            (
                "LUT_3D_SIZE 2\n0 0 0\n1 1 1\n",
                "line 3: a size-2 LUT has 8 rows, found 2",
            ),
            ("", "no LUT_3D_SIZE"),
            ("TITLE \"x\"\n# only\n", "no LUT_3D_SIZE"),
        ];
        for (text, want) in cases {
            let msg = Lut::parse(text).unwrap_err();
            assert!(msg.contains(want), "{text:?}: {msg}");
        }
        // A ninth row is flagged where it is, not at the end.
        let msg = Lut::parse(&format!("{}2 2 2\n", identity(""))).unwrap_err();
        assert!(msg.starts_with("line 12: more than the 8 rows"), "{msg}");
        let msg = Lut::parse(&identity("DOMAIN_MAX 0 1 1\n")).unwrap_err();
        assert!(msg.contains("DOMAIN_MAX"), "{msg}");
    }

    #[test]
    fn accepts_the_largest_size() {
        let n = MAX_LUT_SIZE as usize;
        let rows = "0 0 0\n".repeat(n * n * n);
        let lut = Lut::parse(&format!("LUT_3D_SIZE {n}\n{rows}")).unwrap();
        assert_eq!(lut.size, MAX_LUT_SIZE);
        assert_eq!(lut.rgba().len(), n * n * n * 4);
    }

    #[test]
    fn loading_names_the_layer_and_the_file() {
        let dir = std::env::temp_dir().join(format!("kinetograph-lut-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("good.cube"), identity("")).unwrap();
        std::fs::write(dir.join("bad.cube"), "LUT_3D_SIZE 2\n0 0 0\nBOGUS\n").unwrap();
        let scene = |src: &str| {
            let json = format!(
                r#"{{"width": 20, "height": 20, "fps": 30, "durationInFrames": 1,
                    "layers": [{{"id": "a", "type": "group", "children": [
                      {{"id": "inner", "type": "group", "children": [],
                        "effects": [{{"type": "lut", "src": "{src}"}}]}}]}},
                      {{"id": "b", "type": "group", "children": [],
                        "effects": [{{"type": "lut", "src": "good.cube"}}]}}]}}"#
            );
            Scene::from_json(&json, dir.clone()).unwrap()
        };
        // Both layers use good.cube: one entry.
        let luts = load_luts(&scene("good.cube")).unwrap();
        assert_eq!(luts.len(), 1);
        assert_eq!(luts["good.cube"].size, 2);
        let msg = load_luts(&scene("bad.cube")).unwrap_err().to_string();
        assert!(
            msg.contains("layer \"inner\"") && msg.contains("bad.cube") && msg.contains("line 3"),
            "{msg}"
        );
        let msg = load_luts(&scene("missing.cube")).unwrap_err().to_string();
        assert!(
            msg.contains("layer \"inner\"")
                && msg.contains("missing.cube")
                && msg.contains("cannot read"),
            "{msg}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
