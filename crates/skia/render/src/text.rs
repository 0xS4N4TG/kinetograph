//! Text: `<Text>`, `<TextPath>` and `<Paragraph>`, and measuring.
//!
//! Only the fonts a project registers exist, as for every other layer: a font
//! is a file (`{ file, size }`), and a paragraph's families are the files it
//! lists. There is no system font lookup, so text is the same on every machine.

use std::path::Path as FsPath;

use serde_json::Value;
use skia_safe::textlayout::{
    FontCollection, ParagraphBuilder, ParagraphStyle, TextAlign, TextDecoration, TextStyle,
    TypefaceFontProvider,
};
use skia_safe::{
    Font, FontMgr, FontStyle, Paint, Point, RSXform, TextBlob,
    font_style::{Slant, Weight, Width},
};

use crate::Error;
use crate::assets::Assets;
use crate::render::{Ctx, Node};
use crate::value::{Props, err};

/// A `{ file, size }` font; `embolden` and `skewX` are read too.
pub fn font_of(ctx: &mut Ctx, v: &Value) -> Result<Font, Error> {
    font_in(ctx.assets, &ctx.base_dir, v)
}

fn font_in(assets: &mut Assets, base: &FsPath, v: &Value) -> Result<Font, Error> {
    let p = Props(v);
    let file = p.str("file").ok_or_else(|| {
        Error("a font needs a file: register it and use useFont or matchFont".into())
    })?;
    let typeface = assets.typeface(&base.join(file))?;
    let mut font = Font::new(typeface, p.f32_or("size", 14.0)?);
    if let Some(on) = p.bool("embolden") {
        font.set_embolden(on);
    }
    if let Some(skew) = p.f32("skewX")? {
        font.set_skew_x(skew);
    }
    font.set_subpixel(true);
    Ok(font)
}

pub fn draw(ctx: &mut Ctx, n: Node, paint: &Paint) -> Result<(), Error> {
    match n.kind {
        "Text" => {
            let Some(font) = n.props.get("font") else {
                return Ok(());
            };
            let font = font_of(ctx, font)?;
            let text = n.props.str("text").unwrap_or_default();
            let at = Point::new(n.props.f32_or("x", 0.0)?, n.props.f32_or("y", 0.0)?);
            ctx.canvas.draw_str(text, at, &font, paint);
        }
        "TextPath" => draw_on_path(ctx, n, paint)?,
        "Paragraph" => draw_paragraph(ctx, n)?,
        _ => unreachable!("only text nodes come here"),
    }
    Ok(())
}

/// Text along a path: each glyph is put where its middle falls on the path and turned to the path's direction.
fn draw_on_path(ctx: &mut Ctx, n: Node, paint: &Paint) -> Result<(), Error> {
    let Some(font) = n.props.get("font") else {
        return Ok(());
    };
    let font = font_of(ctx, font)?;
    let path = n
        .props
        .path("path")?
        .ok_or_else(|| Error("TextPath needs a path".into()))?;
    let text = n.props.str("text").unwrap_or_default();
    let glyphs = font.str_to_glyphs_vec(text);
    let mut widths = vec![0.0; glyphs.len()];
    font.get_widths(&glyphs, &mut widths);
    let mut contours = skia_safe::ContourMeasureIter::new(&path, false, 1.0);
    let mut contour = contours.next();
    let mut distance = n.props.f32_or("initialOffset", 0.0)?;
    let mut transforms = Vec::new();
    for width in &widths {
        let Some(current) = contour.as_ref() else {
            break;
        };
        distance += width / 2.0;
        if distance > current.length() {
            contour = contours.next();
            let Some(next) = contour.as_ref() else { break };
            let _ = next;
            distance = width / 2.0;
        }
        let current = contour.as_ref().expect("checked above");
        let Some((p, t)) = current.pos_tan(distance) else {
            break;
        };
        transforms.push(RSXform::new(
            t.x,
            t.y,
            Point::new(p.x - width / 2.0 * t.x, p.y - width / 2.0 * t.y),
        ));
        distance += width / 2.0;
    }
    let shown: String = text.chars().take(transforms.len()).collect();
    if let Some(blob) = TextBlob::from_rsxform(shown, &transforms, &font) {
        ctx.canvas.draw_text_blob(&blob, (0.0, 0.0), paint);
    }
    Ok(())
}

// ---- paragraphs ----

fn text_style(p: Props, families_of: &[String]) -> Result<TextStyle, Error> {
    let mut style = TextStyle::new();
    if let Some(color) = p.color("color")? {
        style.set_color(color.to_color());
    }
    let families: Vec<String> = match p.array("fontFamilies") {
        Some(list) => list
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        None => families_of.to_vec(),
    };
    if !families.is_empty() {
        style.set_font_families(&families);
    }
    if let Some(size) = p.f32("fontSize")? {
        style.set_font_size(size);
    }
    if let Some(font_style) = p.props("fontStyle") {
        let weight = Weight::from(font_style.f32("weight")?.unwrap_or(400.0) as i32);
        let slant = match font_style.str("slant") {
            Some("italic") => Slant::Italic,
            Some("oblique") => Slant::Oblique,
            _ => Slant::Upright,
        };
        style.set_font_style(FontStyle::new(weight, Width::NORMAL, slant));
    }
    if let Some(spacing) = p.f32("letterSpacing")? {
        style.set_letter_spacing(spacing);
    }
    if let Some(spacing) = p.f32("wordSpacing")? {
        style.set_word_spacing(spacing);
    }
    if let Some(height) = p.f32("heightMultiplier")? {
        style.set_height(height);
        style.set_height_override(true);
    }
    if let Some(decoration) = p.str("decoration") {
        style.set_decoration_type(match decoration {
            "underline" => TextDecoration::UNDERLINE,
            "overline" => TextDecoration::OVERLINE,
            "lineThrough" => TextDecoration::LINE_THROUGH,
            _ => TextDecoration::NO_DECORATION,
        });
    }
    if let Some(color) = p.color("decorationColor")? {
        style.set_decoration_color(color.to_color());
    }
    Ok(style)
}

fn draw_paragraph(ctx: &mut Ctx, n: Node) -> Result<(), Error> {
    let Some(held) = n.props.props("paragraph") else {
        return Ok(());
    };
    let mut provider = TypefaceFontProvider::new();
    let mut families = Vec::new();
    for font in held.array("fonts").map(Vec::as_slice).unwrap_or_default() {
        let f = Props(font);
        let (Some(file), Some(family)) = (f.str("file"), f.str("family")) else {
            return err("a paragraph font needs a family and a file");
        };
        let typeface = ctx.assets.typeface(&ctx.file(file))?;
        provider.register_typeface(typeface, Some(family));
        families.push(family.to_string());
    }
    let mut collection = FontCollection::new();
    let manager: FontMgr = provider.into();
    collection.set_asset_font_manager(manager);
    // No system fonts: a family that is not registered finds nothing.
    collection.disable_font_fallback();

    let style_props = held.props("style").unwrap_or(Props(&Value::Null));
    let mut style = ParagraphStyle::new();
    if let Some(align) = style_props.str("textAlign") {
        style.set_text_align(match align {
            "right" => TextAlign::Right,
            "center" => TextAlign::Center,
            "justify" => TextAlign::Justify,
            "end" => TextAlign::End,
            _ => TextAlign::Left,
        });
    }
    if let Some(lines) = style_props.f32("maxLines")? {
        style.set_max_lines(lines as usize);
    }
    if let Some(text) = style_props.props("textStyle") {
        style.set_text_style(&text_style(text, &families)?);
    }
    let mut builder = ParagraphBuilder::new(&style, collection);
    builder.push_style(&text_style(
        style_props
            .props("textStyle")
            .unwrap_or(Props(&Value::Null)),
        &families,
    )?);
    for op in held.array("ops").map(Vec::as_slice).unwrap_or_default() {
        let o = Props(op);
        match o.str("type") {
            Some("pushStyle") => {
                let s = o.props("style").unwrap_or(Props(&Value::Null));
                builder.push_style(&text_style(s, &families)?);
            }
            Some("addText") => {
                builder.add_text(o.str("text").unwrap_or_default());
            }
            Some("pop") => {
                builder.pop();
            }
            other => return err(format!("unknown paragraph operation {other:?}")),
        }
    }
    let mut paragraph = builder.build();
    paragraph.layout(
        n.props
            .f32("width")?
            .ok_or_else(|| Error("Paragraph needs a width".into()))?,
    );
    paragraph.paint(
        ctx.canvas,
        Point::new(n.props.f32_or("x", 0.0)?, n.props.f32_or("y", 0.0)?),
    );
    Ok(())
}

// ---- measuring ----

pub struct FontMetrics {
    pub ascent: f32,
    pub descent: f32,
    pub leading: f32,
}

pub struct TextMeasure {
    pub width: f32,
    pub bounds: [f32; 4],
    pub metrics: FontMetrics,
    pub glyph_ids: Vec<u16>,
    pub glyph_widths: Vec<f32>,
}

/// `font.measureText`, `getGlyphIDs`, `getGlyphWidths` and `getMetrics`.
pub fn measure_text(
    assets: &mut Assets,
    base: &FsPath,
    font: &Value,
    text: &str,
) -> Result<TextMeasure, Error> {
    let font = font_in(assets, base, font)?;
    let (width, bounds) = font.measure_str(text, None);
    let (_, metrics) = font.metrics();
    let glyph_ids = font.str_to_glyphs_vec(text);
    let mut glyph_widths = vec![0.0; glyph_ids.len()];
    font.get_widths(&glyph_ids, &mut glyph_widths);
    Ok(TextMeasure {
        width,
        bounds: [bounds.left, bounds.top, bounds.width(), bounds.height()],
        metrics: FontMetrics {
            ascent: metrics.ascent,
            descent: metrics.descent,
            leading: metrics.leading,
        },
        glyph_ids,
        glyph_widths,
    })
}
