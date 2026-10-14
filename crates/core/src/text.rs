//! Text shaping and line wrapping with Parley.
//!
//! Fonts are registered when the engine is built, before anything is
//! measured. No system fonts are loaded, so layout does not depend on the
//! machine.

use std::collections::BTreeMap;
use std::ops::Range;
use std::path::Path;

use parley::fontique::{Blob, Collection, CollectionOptions, FontInfoOverride, SourceCache};
use parley::{
    FontContext, FontData, FontFamily, LayoutContext, LineHeight, PositionedLayoutItem,
    StyleProperty,
};

use crate::error::{Error, Result};

pub struct TextEngine {
    font_cx: FontContext,
    layout_cx: LayoutContext<()>,
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

#[derive(Clone, Debug)]
pub struct LaidOutLine {
    pub baseline: f32,
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
        })
    }

    /// Shapes `text` in the named font. `line_height` is a multiple of
    /// `size`; `max_width` wraps lines.
    pub fn layout(
        &mut self,
        text: &str,
        font: &str,
        size: f32,
        line_height: Option<f32>,
        max_width: Option<f32>,
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

        let mut lines = Vec::new();
        let mut runs = Vec::new();
        for (index, line) in layout.lines().enumerate() {
            let m = line.metrics();
            lines.push(LaidOutLine {
                baseline: m.baseline,
                top: m.block_min_coord,
                bottom: m.block_max_coord,
                text_range: line.text_range(),
            });
            for item in line.items() {
                let PositionedLayoutItem::GlyphRun(glyph_run) = item else {
                    continue;
                };
                let run = glyph_run.run();
                runs.push(LaidOutRun {
                    line: index,
                    font: run.font().clone(),
                    font_size: run.font_size(),
                    text_range: run.text_range(),
                    glyphs: glyph_run
                        .positioned_glyphs()
                        .map(|g| PositionedGlyph {
                            id: g.id,
                            x: g.x,
                            y: g.y,
                            advance: g.advance,
                        })
                        .collect(),
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
        let t = engine().layout("Hello", "DM Sans", 32.0, None, None);
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
        let one = e.layout("alpha beta gamma", "DM Sans", 32.0, None, None);
        let wrapped = e.layout("alpha beta gamma", "DM Sans", 32.0, None, Some(150.0));
        assert_eq!(one.lines.len(), 1);
        assert!(wrapped.lines.len() > 1);
        assert!(wrapped.width <= 150.0);
        let broken = e.layout("a\nb", "DM Sans", 32.0, None, None);
        assert_eq!(broken.lines.len(), 2);
    }

    #[test]
    fn line_height_scales_with_size() {
        let mut e = engine();
        let t = e.layout("a\nb", "DM Sans", 20.0, Some(2.0), None);
        assert!((t.lines[1].baseline - t.lines[0].baseline - 40.0).abs() < 0.01);
    }
}
