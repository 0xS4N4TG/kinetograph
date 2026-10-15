//! Text shaping and line wrapping with Parley.
//!
//! Fonts are registered when the engine is built, before anything is
//! measured. No system fonts are loaded, so layout does not depend on the
//! machine.

use std::collections::{BTreeMap, HashMap};
use std::ops::Range;
use std::path::{Path, PathBuf};

use parley::fontique::{Blob, Collection, CollectionOptions, FontInfoOverride, SourceCache};
use parley::{
    Alignment, AlignmentOptions, FontContext, FontData, FontFamily, LayoutContext, LineHeight,
    PositionedLayoutItem, StyleProperty,
};

use crate::error::{Error, Result};
use crate::scene::{GlyphRun, TextAlign};

pub struct TextEngine {
    font_cx: FontContext,
    layout_cx: LayoutContext<()>,
    /// The directory font paths of glyph runs resolve against.
    base_dir: PathBuf,
    /// Fonts of glyph runs (`GlyphRun::src`), read when first used.
    run_fonts: HashMap<(String, u32), Option<FontData>>,
}

/// Shaped and positioned text. Coordinates are in pixels, relative to the
/// top-left of the text box, y pointing down.
#[derive(Clone, Debug)]
pub struct LaidOutText {
    pub width: f32,
    pub height: f32,
    pub lines: Vec<LaidOutLine>,
    pub runs: Vec<LaidOutRun>,
}

impl LaidOutText {
    /// The centre of each character, by code point index, in text-box space:
    /// the middle of its glyphs' advance across, and the middle of its line
    /// box (`top` to `bottom`) down. Characters with no glyph (a newline, a
    /// ligature's later letters) have none.
    pub fn char_centres(&self) -> BTreeMap<u32, (f64, f64)> {
        let mut spans: BTreeMap<u32, (f64, f64, usize)> = BTreeMap::new();
        for run in &self.runs {
            for glyph in &run.glyphs {
                let (left, right) = (f64::from(glyph.x), f64::from(glyph.x + glyph.advance));
                let span = spans
                    .entry(glyph.char_index)
                    .or_insert((left, right, run.line));
                span.0 = span.0.min(left);
                span.1 = span.1.max(right);
            }
        }
        spans
            .into_iter()
            .map(|(index, (left, right, line))| {
                let line = &self.lines[line];
                let middle = f64::from(line.top + line.bottom) / 2.0;
                (index, ((left + right) / 2.0, middle))
            })
            .collect()
    }

    /// The text box (`docs/SCENE.md`, "Clip paths"): `max_width`, or the
    /// widest line without one, by the height.
    pub fn box_size(&self, max_width: Option<f32>) -> (f64, f64) {
        (
            f64::from(max_width.unwrap_or(self.width)),
            f64::from(self.height),
        )
    }
}

#[derive(Clone, Debug)]
pub struct LaidOutLine {
    pub baseline: f32,
    /// The font's ascent above the baseline and descent below it.
    pub ascent: f32,
    pub descent: f32,
    /// Top and bottom of the line box.
    pub top: f32,
    pub bottom: f32,
    /// Byte range of the source string on this line.
    pub text_range: Range<usize>,
}

/// Glyphs that share a font on one line.
#[derive(Clone)]
pub struct LaidOutRun {
    pub line: usize,
    pub font: FontData,
    pub font_size: f32,
    /// Byte range of the source string this run covers.
    pub text_range: Range<usize>,
    pub glyphs: Vec<PositionedGlyph>,
    /// Normalised variable-font coordinates; empty for a static face.
    pub coords: Vec<i16>,
    /// Synthetic italic, in degrees to the right.
    pub skew: f32,
    /// Synthetic bold: pixels the outlines grow by on each side.
    pub embolden: f32,
}

impl std::fmt::Debug for LaidOutRun {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LaidOutRun")
            .field("line", &self.line)
            .field("font_size", &self.font_size)
            .field("text_range", &self.text_range)
            .field("glyphs", &self.glyphs)
            .finish()
    }
}

/// `x` is the left edge of the glyph's origin and `y` its baseline, both in
/// text-box space.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PositionedGlyph {
    pub id: u32,
    pub x: f32,
    pub y: f32,
    pub advance: f32,
    /// The index, in Unicode code points, of the character the glyph shows:
    /// the first code point of its cluster (a ligature's glyph belongs to the
    /// first letter of the ligature, a mark's base letter to the base).
    pub char_index: u32,
}

/// A WOFF or WOFF2 file unpacked to the plain font it wraps; any other bytes
/// are returned as they are.
fn unpack_web_font(data: Vec<u8>) -> std::result::Result<Vec<u8>, String> {
    match data.get(..4) {
        Some(b"wOF2") => {
            wuff::decompress_woff2(&data).map_err(|e| format!("cannot unpack WOFF2: {e:?}"))
        }
        Some(b"wOFF") => {
            wuff::decompress_woff1(&data).map_err(|e| format!("cannot unpack WOFF: {e:?}"))
        }
        _ => Ok(data),
    }
}

impl TextEngine {
    /// Registers every font in `fonts` (family name -> path, relative to
    /// `base_dir`) under its scene name.
    pub fn new(fonts: &BTreeMap<String, String>, base_dir: &Path) -> Result<TextEngine> {
        let mut font_cx = FontContext {
            collection: Collection::new(CollectionOptions {
                shared: false,
                system_fonts: false,
            }),
            source_cache: SourceCache::default(),
        };
        for (name, file) in fonts {
            let path = base_dir.join(file);
            let data = std::fs::read(&path).map_err(|source| Error::Io {
                path: path.clone(),
                source,
            })?;
            let data = unpack_web_font(data)
                .map_err(|e| Error::Render(format!("{}: {e}", path.display())))?;
            let registered = font_cx.collection.register_fonts(
                Blob::from(data),
                Some(FontInfoOverride {
                    family_name: Some(name),
                    ..Default::default()
                }),
            );
            if registered.is_empty() {
                return Err(Error::Render(format!(
                    "{} contains no usable font",
                    path.display()
                )));
            }
        }
        Ok(TextEngine {
            font_cx,
            layout_cx: LayoutContext::new(),
            base_dir: base_dir.to_path_buf(),
            run_fonts: HashMap::new(),
        })
    }

    /// The font file a glyph run names, read once.
    fn run_font(&mut self, src: &str, index: u32) -> Option<FontData> {
        let base_dir = &self.base_dir;
        self.run_fonts
            .entry((src.to_string(), index))
            .or_insert_with(|| {
                let data = std::fs::read(base_dir.join(src)).ok()?;
                let data = unpack_web_font(data).ok()?;
                Some(FontData::new(Blob::from(data), index))
            })
            .clone()
    }

    /// Lays out a text layer: its `runs` as given when it has any (a box of
    /// `box_size`), otherwise `text` shaped in `font`.
    #[allow(clippy::too_many_arguments)]
    pub fn layout_layer(
        &mut self,
        text: &str,
        font: &str,
        size: f32,
        line_height: Option<f32>,
        max_width: Option<f32>,
        align: TextAlign,
        runs: &[GlyphRun],
        box_size: (f32, f32),
    ) -> LaidOutText {
        if runs.is_empty() {
            return self.layout(text, font, size, line_height, max_width, align);
        }
        let mut laid = LaidOutText {
            width: box_size.0,
            height: box_size.1,
            lines: vec![LaidOutLine {
                baseline: box_size.1,
                ascent: box_size.1,
                descent: 0.0,
                top: 0.0,
                bottom: box_size.1,
                text_range: 0..0,
            }],
            runs: Vec::new(),
        };
        for run in runs {
            let Some(font) = self.run_font(&run.src, run.index) else {
                continue;
            };
            laid.runs.push(LaidOutRun {
                line: 0,
                font,
                font_size: run.size,
                text_range: 0..0,
                glyphs: run
                    .glyphs
                    .iter()
                    .map(|g| PositionedGlyph {
                        id: g[0] as u32,
                        x: g[1],
                        y: g[2],
                        advance: 0.0,
                        char_index: 0,
                    })
                    .collect(),
                coords: run.coords.clone(),
                skew: run.skew,
                embolden: run.embolden,
            });
        }
        laid
    }

    /// Shapes `text` in the named font. `line_height` is a multiple of
    /// `size`; `max_width` wraps lines. `align` places each line within
    /// `max_width`, or within the widest line when there is none.
    pub fn layout(
        &mut self,
        text: &str,
        font: &str,
        size: f32,
        line_height: Option<f32>,
        max_width: Option<f32>,
        align: TextAlign,
    ) -> LaidOutText {
        let mut builder = self
            .layout_cx
            .ranged_builder(&mut self.font_cx, text, 1.0, false);
        builder.push_default(StyleProperty::FontFamily(FontFamily::named(font)));
        builder.push_default(StyleProperty::FontSize(size));
        if let Some(lh) = line_height {
            builder.push_default(StyleProperty::LineHeight(LineHeight::FontSizeRelative(lh)));
        }
        let mut layout = builder.build(text);
        layout.break_all_lines(max_width);
        // Left is Parley's own start: leaving it alone keeps left-aligned
        // text exactly as it was before alignment existed.
        match align {
            TextAlign::Left => {}
            TextAlign::Center => layout.align(Alignment::Center, AlignmentOptions::default()),
            TextAlign::Right => layout.align(Alignment::Right, AlignmentOptions::default()),
        }

        // Code point index of each byte of `text`, for the clusters' ranges.
        let mut char_at = vec![0_u32; text.len() + 1];
        for (index, (start, c)) in text.char_indices().enumerate() {
            char_at[start..start + c.len_utf8()].fill(index as u32);
        }
        char_at[text.len()] = text.chars().count() as u32;

        let mut lines = Vec::new();
        let mut runs = Vec::new();
        for (index, line) in layout.lines().enumerate() {
            let m = line.metrics();
            lines.push(LaidOutLine {
                baseline: m.baseline,
                ascent: m.baseline - m.content_block_min_coord,
                descent: m.content_block_max_coord - m.baseline,
                top: m.block_min_coord,
                bottom: m.block_max_coord,
                text_range: line.text_range(),
            });
            for item in line.items() {
                let PositionedLayoutItem::GlyphRun(glyph_run) = item else {
                    continue;
                };
                let run = glyph_run.run();
                // The glyphs of a run come in the order of its visual
                // clusters, which hold them: one code point index for each.
                let mut chars = Vec::new();
                for cluster in run.visual_clusters() {
                    let first = char_at[cluster.text_range().start];
                    chars.extend(std::iter::repeat_n(first, cluster.glyphs().count()));
                }
                runs.push(LaidOutRun {
                    line: index,
                    font: run.font().clone(),
                    font_size: run.font_size(),
                    text_range: run.text_range(),
                    glyphs: glyph_run
                        .positioned_glyphs()
                        .enumerate()
                        .map(|(i, g)| PositionedGlyph {
                            id: g.id,
                            x: g.x,
                            y: g.y,
                            advance: g.advance,
                            char_index: chars.get(i).or(chars.last()).copied().unwrap_or_default(),
                        })
                        .collect(),
                    coords: Vec::new(),
                    skew: 0.0,
                    embolden: 0.0,
                });
            }
        }
        LaidOutText {
            width: layout.width(),
            height: layout.height(),
            lines,
            runs,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> TextEngine {
        let fonts = BTreeMap::from([(
            "DM Sans".to_string(),
            "assets/fonts/DMSans-Medium.ttf".to_string(),
        )]);
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        TextEngine::new(&fonts, &root).unwrap()
    }

    fn glyph_count(t: &LaidOutText) -> usize {
        t.runs.iter().map(|r| r.glyphs.len()).sum()
    }

    #[test]
    fn exposes_glyph_positions() {
        let t = engine().layout("Hello", "DM Sans", 32.0, None, None, TextAlign::Left);
        assert_eq!(t.lines.len(), 1);
        assert_eq!(glyph_count(&t), 5);
        let glyphs: Vec<_> = t.runs.iter().flat_map(|r| &r.glyphs).collect();
        assert!(glyphs.windows(2).all(|w| w[1].x > w[0].x));
        assert!(glyphs.iter().all(|g| g.y == t.lines[0].baseline));
        assert!(t.width > 0.0 && t.height > 0.0);
    }

    #[test]
    fn wraps_at_max_width_and_honours_newlines() {
        let mut e = engine();
        let one = e.layout(
            "alpha beta gamma",
            "DM Sans",
            32.0,
            None,
            None,
            TextAlign::Left,
        );
        let wrapped = e.layout(
            "alpha beta gamma",
            "DM Sans",
            32.0,
            None,
            Some(150.0),
            TextAlign::Left,
        );
        assert_eq!(one.lines.len(), 1);
        assert!(wrapped.lines.len() > 1);
        assert!(wrapped.width <= 150.0);
        let broken = e.layout("a\nb", "DM Sans", 32.0, None, None, TextAlign::Left);
        assert_eq!(broken.lines.len(), 2);
    }

    fn char_indices(t: &LaidOutText) -> Vec<u32> {
        t.runs
            .iter()
            .flat_map(|r| &r.glyphs)
            .map(|g| g.char_index)
            .collect()
    }

    #[test]
    fn glyphs_know_their_code_point_index() {
        let mut e = engine();
        let plain = e.layout("Hello", "DM Sans", 32.0, None, None, TextAlign::Left);
        assert_eq!(char_indices(&plain), [0, 1, 2, 3, 4]);
        // A newline is a code point of its own with no glyph.
        let lines = e.layout("ab\ncd", "DM Sans", 32.0, None, None, TextAlign::Left);
        assert_eq!(char_indices(&lines), [0, 1, 3, 4]);
        // Code points, not bytes: 'é' is two bytes.
        let wide = e.layout("é!x", "DM Sans", 32.0, None, None, TextAlign::Left);
        assert_eq!(char_indices(&wide), [0, 1, 2]);
        // A wrapped line carries on counting.
        let wrapped = e.layout(
            "aa bb cc",
            "DM Sans",
            32.0,
            None,
            Some(60.0),
            TextAlign::Left,
        );
        assert!(wrapped.lines.len() > 1);
        let indices = char_indices(&wrapped);
        assert!(indices.windows(2).all(|w| w[1] > w[0]));
        assert_eq!(*indices.last().unwrap(), 7);
    }

    #[test]
    fn a_ligature_or_a_mark_belongs_to_its_first_code_point() {
        let mut e = engine();
        // A base letter and a combining acute: one cluster, however many
        // glyphs the font makes of it; every glyph is the base letter's.
        let marked = e.layout("xe\u{301}y", "DM Sans", 32.0, None, None, TextAlign::Left);
        let indices = char_indices(&marked);
        assert_eq!(indices.first(), Some(&0));
        assert_eq!(indices.last(), Some(&3));
        assert!(!indices.contains(&2), "{indices:?}");
        // Ligatures: whatever the font joins, no glyph is attributed past
        // the end of the text, and the indices never go backwards.
        let joined = e.layout("office fifi", "DM Sans", 32.0, None, None, TextAlign::Left);
        let indices = char_indices(&joined);
        assert!(indices.windows(2).all(|w| w[1] >= w[0]), "{indices:?}");
        assert!(indices.iter().all(|&i| i < 11));
    }

    #[test]
    fn character_centres_are_the_middle_of_the_advance_and_of_the_line() {
        let mut e = engine();
        let t = e.layout("ab\ncd", "DM Sans", 32.0, None, None, TextAlign::Left);
        let centres = t.char_centres();
        // No centre for the newline.
        assert_eq!(centres.keys().copied().collect::<Vec<_>>(), [0, 1, 3, 4]);
        let glyph = |i: usize| t.runs.iter().flat_map(|r| &r.glyphs).nth(i).unwrap();
        let (a, b) = (glyph(0), glyph(1));
        assert!((centres[&0].0 - f64::from(a.x + a.advance / 2.0)).abs() < 1e-4);
        assert!((centres[&1].0 - f64::from(b.x + b.advance / 2.0)).abs() < 1e-4);
        let line = |i: usize| f64::from(t.lines[i].top + t.lines[i].bottom) / 2.0;
        assert!((centres[&0].1 - line(0)).abs() < 1e-4);
        assert!((centres[&3].1 - line(1)).abs() < 1e-4);
        assert!(centres[&3].1 > centres[&0].1);
    }

    /// The left edge of the first glyph of each line and the line's width.
    fn line_starts(t: &LaidOutText) -> Vec<(f32, f32)> {
        t.lines
            .iter()
            .enumerate()
            .map(|(i, _)| {
                let glyphs: Vec<_> = t
                    .runs
                    .iter()
                    .filter(|r| r.line == i)
                    .flat_map(|r| &r.glyphs)
                    .collect();
                let first = glyphs.first().unwrap().x;
                let last = glyphs.last().unwrap();
                (first, last.x + last.advance - first)
            })
            .collect()
    }

    #[test]
    fn aligns_lines_within_the_widest_line() {
        let mut e = engine();
        let text = "a long line\nshort";
        let left = e.layout(text, "DM Sans", 32.0, None, None, TextAlign::Left);
        let [(l0, w0), (l1, w1)] = line_starts(&left)[..] else {
            panic!("two lines");
        };
        assert!(l0.abs() < 0.01 && l1.abs() < 0.01 && w1 < w0);
        let center = e.layout(text, "DM Sans", 32.0, None, None, TextAlign::Center);
        let [(c0, _), (c1, _)] = line_starts(&center)[..] else {
            panic!("two lines");
        };
        assert!(c0.abs() < 0.01, "the widest line stays put: {c0}");
        assert!(
            (c1 - (w0 - w1) / 2.0).abs() < 0.05,
            "{c1} vs {}",
            (w0 - w1) / 2.0
        );
        let right = e.layout(text, "DM Sans", 32.0, None, None, TextAlign::Right);
        let [(r0, _), (r1, _)] = line_starts(&right)[..] else {
            panic!("two lines");
        };
        assert!(r0.abs() < 0.01);
        assert!((r1 - (w0 - w1)).abs() < 0.05, "{r1} vs {}", w0 - w1);
        // The box does not change with the alignment.
        assert_eq!(left.box_size(None), center.box_size(None));
    }

    #[test]
    fn aligns_lines_within_the_max_width() {
        let mut e = engine();
        let w = 400.0;
        let left = e.layout("hi", "DM Sans", 32.0, None, Some(w), TextAlign::Left);
        let width = line_starts(&left)[0].1;
        let center = e.layout("hi", "DM Sans", 32.0, None, Some(w), TextAlign::Center);
        let right = e.layout("hi", "DM Sans", 32.0, None, Some(w), TextAlign::Right);
        assert!((line_starts(&center)[0].0 - (w - width) / 2.0).abs() < 0.05);
        assert!((line_starts(&right)[0].0 - (w - width)).abs() < 0.05);
        // The box is the max width.
        assert_eq!(right.box_size(Some(w)).0, 400.0);
    }

    #[test]
    fn line_height_scales_with_size() {
        let mut e = engine();
        let t = e.layout("a\nb", "DM Sans", 20.0, Some(2.0), None, TextAlign::Left);
        assert!((t.lines[1].baseline - t.lines[0].baseline - 40.0).abs() < 0.01);
    }
}
