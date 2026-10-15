//! `layoutText`: the renderer's own text shaping (Parley), for measuring
//! text in JavaScript. CPU only.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use kinetograph_core::scene::TextAlign;
use kinetograph_core::text::{LaidOutText, TextEngine};

use crate::error::{Result, from_core, invalid};
use crate::{TextGlyph, TextLayout, TextLayoutRequest, TextLine};

/// How many font sets keep an engine. A project has one or two; past this the
/// cache starts again, which only costs reading the fonts once more.
const MAX_ENGINES: usize = 8;

/// Engines by the fonts they were built from: shaping needs a mutable engine
/// and building one reads every font file.
fn engines() -> &'static Mutex<HashMap<String, TextEngine>> {
    static ENGINES: OnceLock<Mutex<HashMap<String, TextEngine>>> = OnceLock::new();
    ENGINES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A key for a set of fonts: each family with the file it names, by absolute
/// path, size and modification time, so an edited font is read again.
fn fonts_key(fonts: &BTreeMap<String, PathBuf>) -> String {
    let mut key = String::new();
    for (name, path) in fonts {
        let meta = std::fs::metadata(path).ok();
        let modified = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_nanos());
        key.push_str(&format!(
            "{name}\0{}\0{}\0{modified}\n",
            path.display(),
            meta.map_or(0, |m| m.len())
        ));
    }
    key
}

pub fn layout_text(request: &TextLayoutRequest) -> Result<TextLayout> {
    if !(request.size.is_finite() && request.size > 0.0) {
        return Err(invalid(format!(
            "size must be greater than 0, got {}",
            request.size
        )));
    }
    if let Some(h) = request.line_height
        && !(h.is_finite() && h > 0.0)
    {
        return Err(invalid(format!(
            "lineHeight must be greater than 0, got {h}"
        )));
    }
    if let Some(w) = request.max_width
        && !(w.is_finite() && w > 0.0)
    {
        return Err(invalid(format!("maxWidth must be greater than 0, got {w}")));
    }
    let align = match request.align.as_deref() {
        None | Some("left") => TextAlign::Left,
        Some("center") => TextAlign::Center,
        Some("right") => TextAlign::Right,
        Some(other) => {
            return Err(invalid(format!(
                "align must be left, center or right, got {other:?}"
            )));
        }
    };
    if !request.fonts.contains_key(&request.font) {
        return Err(invalid(format!(
            "font {:?} is not one of the fonts given: {:?}",
            request.font,
            request.fonts.keys().collect::<Vec<_>>()
        )));
    }

    let base = match &request.base_dir {
        Some(dir) => PathBuf::from(dir),
        None => std::env::current_dir().unwrap_or_default(),
    };
    let fonts: BTreeMap<String, PathBuf> = request
        .fonts
        .iter()
        .map(|(name, file)| {
            let path = base.join(file);
            (name.clone(), std::path::absolute(&path).unwrap_or(path))
        })
        .collect();
    let key = fonts_key(&fonts);

    let mut engines = engines().lock().unwrap_or_else(|e| e.into_inner());
    if !engines.contains_key(&key) {
        let files: BTreeMap<String, String> = fonts
            .iter()
            .map(|(name, path)| (name.clone(), path.to_string_lossy().into_owned()))
            .collect();
        let engine = TextEngine::new(&files, Path::new("")).map_err(from_core)?;
        if engines.len() >= MAX_ENGINES {
            engines.clear();
        }
        engines.insert(key.clone(), engine);
    }
    let engine = engines.get_mut(&key).expect("inserted above");
    let laid_out = engine.layout(
        &request.text,
        &request.font,
        request.size as f32,
        request.line_height.map(|h| h as f32),
        request.max_width.map(|w| w as f32),
        align,
    );
    drop(engines);
    Ok(describe(&request.text, &laid_out))
}

/// The shaped text as the addon returns it.
fn describe(text: &str, laid_out: &LaidOutText) -> TextLayout {
    // Byte offsets to code point indices, which is what `chars` counts.
    let mut code_point = vec![0_u32; text.len() + 1];
    let mut count = 0_u32;
    for (byte, c) in text.char_indices() {
        for slot in &mut code_point[byte..byte + c.len_utf8()] {
            *slot = count;
        }
        count += 1;
    }
    code_point[text.len()] = count;

    let lines: Vec<TextLine> = laid_out
        .lines
        .iter()
        .map(|line| TextLine {
            top: f64::from(line.top),
            bottom: f64::from(line.bottom),
            baseline: f64::from(line.baseline),
            start: code_point[line.text_range.start.min(text.len())],
            end: code_point[line.text_range.end.min(text.len())],
        })
        .collect();

    let glyphs = laid_out
        .runs
        .iter()
        .flat_map(|run| {
            run.glyphs.iter().map(|glyph| TextGlyph {
                char_index: glyph.char_index,
                line: run.line as u32,
                x: f64::from(glyph.x),
                y: f64::from(glyph.y),
                advance: f64::from(glyph.advance),
            })
        })
        .collect();

    TextLayout {
        width: f64::from(laid_out.width),
        height: f64::from(laid_out.height),
        lines,
        glyphs,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn request(text: &str) -> TextLayoutRequest {
        TextLayoutRequest {
            text: text.into(),
            font: "DM Sans".into(),
            size: 32.0,
            line_height: None,
            max_width: None,
            align: None,
            fonts: HashMap::from([(
                "DM Sans".to_string(),
                "assets/fonts/DMSans-Medium.ttf".to_string(),
            )]),
            base_dir: Some(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../..")
                    .to_string_lossy()
                    .into_owned(),
            ),
        }
    }

    #[test]
    fn glyphs_are_indexed_by_code_point() {
        let t = layout_text(&request("Héllo\nwörld")).unwrap();
        assert_eq!(t.lines.len(), 2);
        assert_eq!((t.lines[0].start, t.lines[1].end), (0, 11));
        assert_eq!(t.lines[0].end, t.lines[1].start);
        let indices: Vec<u32> = t.glyphs.iter().map(|g| g.char_index).collect();
        // Every letter has its own glyph; the newline has none.
        let letters: Vec<u32> = (0..11).filter(|i| *i != 5).collect();
        assert_eq!(indices, letters);
        assert!(
            t.glyphs
                .iter()
                .all(|g| g.line == u32::from(g.char_index >= 6))
        );
        // Pen positions climb along a line and the baseline is the line's.
        assert!(t.glyphs[..5].windows(2).all(|w| w[1].x > w[0].x));
        assert!(t.glyphs[5].y > t.glyphs[0].y);
        assert!(t.width > 0.0 && t.height > t.lines[0].bottom);
    }

    #[test]
    fn wrapping_and_line_height_come_from_the_engine() {
        let mut r = request("alpha beta gamma");
        let one = layout_text(&r).unwrap();
        r.max_width = Some(150.0);
        let wrapped = layout_text(&r).unwrap();
        assert_eq!(one.lines.len(), 1);
        assert!(wrapped.lines.len() > 1 && wrapped.width <= 150.0);
        let mut r = request("a\nb");
        r.size = 20.0;
        r.line_height = Some(2.0);
        let t = layout_text(&r).unwrap();
        assert!((t.lines[1].baseline - t.lines[0].baseline - 40.0).abs() < 0.01);
    }

    #[test]
    fn lines_align_within_the_wrap_width() {
        let mut r = request("hi\nthere you");
        r.max_width = Some(400.0);
        let left = layout_text(&r).unwrap();
        r.align = Some("center".into());
        let centre = layout_text(&r).unwrap();
        r.align = Some("right".into());
        let right = layout_text(&r).unwrap();
        let end = |t: &TextLayout, line: u32| {
            t.glyphs
                .iter()
                .filter(|g| g.line == line)
                .map(|g| g.x + g.advance)
                .fold(0.0, f64::max)
        };
        for line in 0..2 {
            assert!((end(&right, line) - 400.0).abs() < 1e-3);
            let room = 400.0 - end(&left, line);
            assert!((end(&centre, line) - end(&left, line) - room / 2.0).abs() < 1e-3);
        }
        assert_eq!(left.glyphs[0].x, 0.0);
    }

    #[test]
    fn bad_requests_are_invalid_arguments() {
        let bad = [
            ("size", {
                let mut r = request("a");
                r.size = 0.0;
                r
            }),
            ("lineHeight", {
                let mut r = request("a");
                r.line_height = Some(-1.0);
                r
            }),
            ("maxWidth", {
                let mut r = request("a");
                r.max_width = Some(0.0);
                r
            }),
            ("align", {
                let mut r = request("a");
                r.align = Some("justify".into());
                r
            }),
            ("font", {
                let mut r = request("a");
                r.font = "Nope".into();
                r
            }),
        ];
        for (what, r) in bad {
            let e = layout_text(&r).err().expect("an error");
            assert_eq!(e.status, crate::error::Code::InvalidArg, "{what}");
            assert!(e.reason.contains(what), "{what}: {}", e.reason);
        }
        let mut r = request("a");
        r.fonts
            .insert("DM Sans".into(), "assets/fonts/missing.ttf".into());
        let e = layout_text(&r).err().expect("an error");
        assert_eq!(e.status, crate::error::Code::Io);
        assert!(e.reason.contains("missing.ttf"));
    }
}
