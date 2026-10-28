//! `<Atlas>`, `<Patch>`, `<Glyphs>`, `<TextBlob>`, `<Picture>` and `<ImageSVG>`: the drawings that take an object
//! made with `Skia.*` (a text blob, a recorded picture, an SVG) or a list of them (sprites, glyphs, patch corners).

use serde_json::Value;
use skia_safe::canvas::PointMode;
use skia_safe::svg;
use skia_safe::textlayout::TypefaceFontProvider;
use skia_safe::{
    BlendMode, Canvas, ClipOp, Color, FontMgr, Image, Paint, PictureRecorder, Point, RSXform, Rect,
    Size, TextBlob, TextBlobBuilder, Typeface, canvas::SrcRectConstraint,
};

use crate::Error;
use crate::draw::{image_of, points_of, sampling_of};
use crate::enums;
use crate::render::{Ctx, Node, paint_of};
use crate::text::{font_of, paint_paragraph, typeface_in};
use crate::value::{Props, as_f32, color, err, floats, matrix, path, point, rect_of, rrect_of};

pub fn draw(ctx: &mut Ctx, n: Node, paint: &Paint) -> Result<(), Error> {
    match n.kind {
        "Atlas" => atlas(ctx, ctx.canvas, n.props, paint),
        "Patch" => patch(ctx.canvas, n.props, paint),
        "Glyphs" => glyphs(ctx, n.props, paint),
        "TextBlob" => {
            let Some(held) = n.props.get("blob") else {
                return Ok(());
            };
            let blob = blob_of(ctx, held)?;
            let at = Point::new(n.props.f32_or("x", 0.0)?, n.props.f32_or("y", 0.0)?);
            ctx.canvas.draw_text_blob(&blob, at, paint);
            Ok(())
        }
        "ImageSVG" => svg_image(ctx, n.props),
        _ => unreachable!("only the compound drawings come here"),
    }
}

fn colors_of(v: Option<&Vec<Value>>, what: &str) -> Result<Option<Vec<Color>>, Error> {
    let Some(list) = v else { return Ok(None) };
    list.iter()
        .map(|c| {
            color(c)
                .map(|c| c.to_color())
                .ok_or_else(|| Error(format!("{what} must be colours")))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

fn xform_of(v: &Value) -> Result<RSXform, Error> {
    let n = |k: &str| {
        v.get(k)
            .and_then(as_f32)
            .ok_or_else(|| Error("an RSXform is { scos, ssin, tx, ty }".into()))
    };
    Ok(RSXform::new(
        n("scos")?,
        n("ssin")?,
        Point::new(n("tx")?, n("ty")?),
    ))
}

fn xforms_of(list: &[Value]) -> Result<Vec<RSXform>, Error> {
    list.iter().map(xform_of).collect()
}

// ---- Atlas ----

fn atlas(ctx: &mut Ctx, canvas: &Canvas, props: Props, paint: &Paint) -> Result<(), Error> {
    let Some(held) = props.get("image") else {
        return Ok(());
    };
    let image: Image = image_of(ctx, held)?;
    let sprites: Vec<Rect> = props
        .array("sprites")
        .ok_or_else(|| Error("Atlas needs sprites".into()))?
        .iter()
        .map(|r| rect_of(r).ok_or_else(|| Error("sprites must be rects".into())))
        .collect::<Result<_, _>>()?;
    let transforms = xforms_of(
        props
            .array("transforms")
            .ok_or_else(|| Error("Atlas needs transforms".into()))?,
    )?;
    if sprites.len() != transforms.len() {
        return err("Atlas needs as many transforms as sprites");
    }
    let colors = colors_of(props.array("colors"), "colors")?;
    if colors.as_ref().is_some_and(|c| c.len() != sprites.len()) {
        return err("Atlas needs as many colors as sprites");
    }
    let mode = match props.str("colorBlendMode") {
        Some(name) => enums::blend_mode(name)?,
        None => BlendMode::DstOver,
    };
    canvas.draw_atlas(
        &image,
        &transforms,
        &sprites,
        colors.as_deref(),
        mode,
        sampling_of(props)?,
        None,
        Some(paint),
    );
    Ok(())
}

// ---- Patch ----

/// The corners of a patch, clockwise from the top left: `{ pos, c1, c2 }`, `c1` the control point on the edge that
/// arrives at the corner and `c2` the one on the edge that leaves it.
fn patch(canvas: &Canvas, props: Props, paint: &Paint) -> Result<(), Error> {
    let corners = props
        .array("patch")
        .or_else(|| props.array("cubics"))
        .filter(|c| c.len() == 4)
        .ok_or_else(|| Error("Patch needs patch: four { pos, c1, c2 } corners".into()))?;
    let at = |i: usize, key: &str| {
        corners[i]
            .get(key)
            .and_then(point)
            .ok_or_else(|| Error(format!("patch corner {i} needs {key} as a point")))
    };
    let cubics = [
        at(0, "pos")?,
        at(0, "c2")?,
        at(1, "c1")?,
        at(1, "pos")?,
        at(1, "c2")?,
        at(2, "c1")?,
        at(2, "pos")?,
        at(2, "c2")?,
        at(3, "c1")?,
        at(3, "pos")?,
        at(3, "c2")?,
        at(0, "c1")?,
    ];
    patch_draw(canvas, &cubics, props, "texture", paint)
}

/// `drawPatch` with the 12 points, and `colors`, the texture points (under `texture_key`) and `blendMode` of `props`.
fn patch_draw(
    canvas: &Canvas,
    cubics: &[Point; 12],
    props: Props,
    texture_key: &str,
    paint: &Paint,
) -> Result<(), Error> {
    let colors: Option<[Color; 4]> = colors_of(props.array("colors"), "colors")?
        .map(|c| {
            c.try_into()
                .map_err(|_| Error("Patch needs four colors".into()))
        })
        .transpose()?;
    let key = if props.has(texture_key) {
        texture_key
    } else {
        "textures"
    };
    let textures: Option<[Point; 4]> = if props.has(key) {
        Some(
            points_of(props, key)?
                .try_into()
                .map_err(|_| Error("Patch needs four texture points".into()))?,
        )
    } else {
        None
    };
    let mode = match props.str("blendMode") {
        Some(name) => enums::blend_mode(name)?,
        None if colors.is_some() => BlendMode::DstOver,
        None => BlendMode::SrcOver,
    };
    canvas.draw_patch(cubics, colors.as_ref(), textures.as_ref(), mode, paint);
    Ok(())
}

// ---- Glyphs and text blobs ----

fn glyph_ids(v: &Value) -> Result<Vec<u16>, Error> {
    Ok(floats(v)
        .ok_or_else(|| Error("glyph ids must be a list of numbers".into()))?
        .into_iter()
        .map(|n| n as u16)
        .collect())
}

fn glyphs(ctx: &mut Ctx, props: Props, paint: &Paint) -> Result<(), Error> {
    let Some(font) = props.get("font") else {
        return Ok(());
    };
    let font = font_of(ctx, font)?;
    let list = props
        .array("glyphs")
        .ok_or_else(|| Error("Glyphs needs glyphs: { id, pos }".into()))?;
    let mut ids = Vec::with_capacity(list.len());
    let mut positions = Vec::with_capacity(list.len());
    for g in list {
        ids.push(
            g.get("id")
                .and_then(as_f32)
                .ok_or_else(|| Error("a glyph is { id, pos }".into()))? as u16,
        );
        positions.push(
            g.get("pos")
                .and_then(point)
                .ok_or_else(|| Error("a glyph is { id, pos }".into()))?,
        );
    }
    let origin = Point::new(props.f32_or("x", 0.0)?, props.f32_or("y", 0.0)?);
    ctx.canvas
        .draw_glyphs_at(&ids, positions.as_slice(), origin, &font, paint);
    Ok(())
}

/// The blob of `Skia.TextBlob.Make*`: `{ glyphs | text, font, xforms? }`. Glyphs of a text are those the font maps its
/// characters to; without transforms they follow one another by the font's advances.
pub fn blob_of(ctx: &mut Ctx, v: &Value) -> Result<TextBlob, Error> {
    let font = font_of(
        ctx,
        v.get("font")
            .ok_or_else(|| Error("a text blob needs a font".into()))?,
    )?;
    let ids = match (v.get("glyphs"), v.get("text").and_then(Value::as_str)) {
        (Some(g), _) => glyph_ids(g)?,
        (None, Some(text)) => font.str_to_glyphs_vec(text),
        _ => return err("a text blob needs text or glyphs"),
    };
    let mut builder = TextBlobBuilder::new();
    match v.get("xforms").and_then(Value::as_array) {
        Some(xforms) => {
            let xforms = xforms_of(xforms)?;
            if xforms.len() != ids.len() {
                return err("a text blob needs one transform for each glyph");
            }
            let (glyphs, out) = builder.alloc_run_rsxform(&font, ids.len());
            glyphs.copy_from_slice(&ids);
            out.copy_from_slice(&xforms);
        }
        None => {
            let glyphs = builder.alloc_run(&font, ids.len(), (0.0, 0.0), None);
            glyphs.copy_from_slice(&ids);
        }
    }
    builder
        .make()
        .ok_or_else(|| Error("the text blob is empty".into()))
}

// ---- Picture ----

/// Replays a picture the authoring side recorded (`Skia.PictureRecorder`): its operations are recorded again by
/// Skia's own recorder and the picture it makes is drawn.
pub fn picture(ctx: &mut Ctx, n: Node) -> Result<(), Error> {
    let Some(held) = n.props.get("picture") else {
        return Ok(());
    };
    let made = record(ctx, held)?;
    ctx.canvas.draw_picture(&made, None, None);
    Ok(())
}

pub fn record(ctx: &mut Ctx, v: &Value) -> Result<skia_safe::Picture, Error> {
    let ops = v
        .get("ops")
        .and_then(Value::as_array)
        .ok_or_else(|| Error("a picture is { ops }".into()))?;
    let bounds = v
        .get("bounds")
        .and_then(rect_of)
        .unwrap_or_else(|| Rect::new(-1e7, -1e7, 1e7, 1e7));
    let mut recorder = PictureRecorder::new();
    let canvas = recorder.begin_recording(bounds, false);
    for op in ops {
        replay(ctx, canvas, op)?;
    }
    recorder
        .finish_recording_as_picture(None)
        .ok_or_else(|| Error("the picture could not be recorded".into()))
}

fn replay(ctx: &mut Ctx, canvas: &Canvas, op: &Value) -> Result<(), Error> {
    let p = Props(op);
    let name = p.str("op").unwrap_or_default();
    let need = |key: &str| {
        p.get(key)
            .ok_or_else(|| Error(format!("{name} needs {key}")))
    };
    let num = |key: &str| p.f32_or(key, 0.0);
    let paint_for = |ctx: &mut Ctx| match p.get("paint") {
        Some(held) => paint_of(ctx, held),
        None => Ok(crate::render::default_paint()),
    };
    match name {
        "save" => {
            canvas.save();
        }
        "restore" => {
            canvas.restore();
        }
        "translate" => {
            canvas.translate((num("x")?, num("y")?));
        }
        "scale" => {
            canvas.scale((num("x")?, num("y")?));
        }
        "rotate" => {
            let at = (p.has("x") || p.has("y"))
                .then(|| Point::new(num("x").unwrap_or(0.0), num("y").unwrap_or(0.0)));
            canvas.rotate(num("degrees")?, at);
        }
        "skew" => {
            canvas.skew((num("x")?, num("y")?));
        }
        "concat" => {
            canvas.concat(
                &matrix(need("matrix")?).ok_or_else(|| Error("concat needs a matrix".into()))?,
            );
        }
        "clipRect" | "clipRRect" | "clipPath" => {
            let clip_op = if p.str("clipOp") == Some("difference") {
                ClipOp::Difference
            } else {
                ClipOp::Intersect
            };
            let aa = p.bool("antiAlias").unwrap_or(true);
            let shape = need("shape")?;
            match name {
                "clipRect" => canvas.clip_rect(
                    rect_of(shape).ok_or_else(|| Error("clipRect needs a rect".into()))?,
                    clip_op,
                    aa,
                ),
                "clipRRect" => canvas.clip_rrect(
                    rrect_of(shape)
                        .ok_or_else(|| Error("clipRRect needs a rounded rect".into()))?,
                    clip_op,
                    aa,
                ),
                _ => canvas.clip_path(&path(shape)?, clip_op, aa),
            };
        }
        "drawPaint" => {
            canvas.draw_paint(&paint_for(ctx)?);
        }
        "drawColor" => {
            let c =
                color(need("color")?).ok_or_else(|| Error("drawColor needs a colour".into()))?;
            let mode = p.str("blendMode").map(enums::blend_mode).transpose()?;
            canvas.draw_color(c, mode);
        }
        "drawRect" => {
            let r = rect_of(need("rect")?).ok_or_else(|| Error("drawRect needs a rect".into()))?;
            canvas.draw_rect(r, &paint_for(ctx)?);
        }
        "drawRRect" => {
            let r = rrect_of(need("rrect")?)
                .ok_or_else(|| Error("drawRRect needs a rounded rect".into()))?;
            canvas.draw_rrect(r, &paint_for(ctx)?);
        }
        "drawOval" => {
            let r = rect_of(need("rect")?).ok_or_else(|| Error("drawOval needs a rect".into()))?;
            canvas.draw_oval(r, &paint_for(ctx)?);
        }
        "drawCircle" => {
            canvas.draw_circle((num("x")?, num("y")?), num("r")?, &paint_for(ctx)?);
        }
        "drawLine" => {
            canvas.draw_line(
                (num("x0")?, num("y0")?),
                (num("x1")?, num("y1")?),
                &paint_for(ctx)?,
            );
        }
        "drawPath" => {
            canvas.draw_path(&path(need("path")?)?, &paint_for(ctx)?);
        }
        "drawPoints" => {
            let mode = match p.str("mode") {
                Some("lines") => PointMode::Lines,
                Some("polygon") => PointMode::Polygon,
                _ => PointMode::Points,
            };
            canvas.draw_points(mode, &points_of(p, "points")?, &paint_for(ctx)?);
        }
        "drawImage" => {
            let image = image_of(ctx, need("image")?)?;
            let paint = p.get("paint").map(|h| paint_of(ctx, h)).transpose()?;
            canvas.draw_image(&image, (num("x")?, num("y")?), paint.as_ref());
        }
        "drawImageRect" => {
            let image = image_of(ctx, need("image")?)?;
            let src =
                rect_of(need("src")?).ok_or_else(|| Error("drawImageRect needs src".into()))?;
            let dst =
                rect_of(need("dest")?).ok_or_else(|| Error("drawImageRect needs dest".into()))?;
            canvas.draw_image_rect(
                &image,
                Some((&src, SrcRectConstraint::Fast)),
                dst,
                &paint_for(ctx)?,
            );
        }
        "drawText" => {
            let font = font_of(ctx, need("font")?)?;
            canvas.draw_str(
                p.str("text").unwrap_or_default(),
                (num("x")?, num("y")?),
                &font,
                &paint_for(ctx)?,
            );
        }
        "drawTextBlob" => {
            let blob = blob_of(ctx, need("blob")?)?;
            canvas.draw_text_blob(&blob, (num("x")?, num("y")?), &paint_for(ctx)?);
        }
        "drawGlyphs" => {
            let font = font_of(ctx, need("font")?)?;
            let ids = glyph_ids(need("glyphs")?)?;
            let positions = points_of(p, "positions")?;
            if positions.len() != ids.len() {
                return err("drawGlyphs needs a position for each glyph");
            }
            canvas.draw_glyphs_at(
                &ids,
                positions.as_slice(),
                (num("x")?, num("y")?),
                &font,
                &paint_for(ctx)?,
            );
        }
        "drawPicture" => {
            let inner = record(ctx, need("picture")?)?;
            canvas.draw_picture(&inner, None, None);
        }
        "drawAtlas" => {
            let paint = paint_for(ctx)?;
            atlas(ctx, canvas, p, &paint)?
        }
        "drawPatch" => {
            let cubics: [Point; 12] = points_of(p, "points")?
                .try_into()
                .map_err(|_| Error("drawPatch needs 12 points".into()))?;
            patch_draw(canvas, &cubics, p, "texs", &paint_for(ctx)?)?
        }
        "drawNodes" => {
            let nodes = p.array("nodes").map(Vec::as_slice).unwrap_or_default();
            let left_out =
                crate::render::draw_nodes(canvas, nodes, ctx.assets, ctx.base_dir.clone())?;
            for item in left_out {
                if !ctx.unsupported.contains(&item) {
                    ctx.unsupported.push(item);
                }
            }
        }
        "drawParagraph" => {
            let held = p
                .props("paragraph")
                .ok_or_else(|| Error("drawParagraph needs a paragraph".into()))?;
            let width = p.f32("width")?.unwrap_or(f32::INFINITY);
            paint_paragraph(ctx, held, width, Point::new(num("x")?, num("y")?), canvas)?;
        }
        other => return err(format!("a picture cannot record {other:?}")),
    }
    Ok(())
}

// ---- ImageSVG ----

fn dom_of(svg: &str, fonts: FontMgr) -> Result<svg::Dom, Error> {
    svg::Dom::from_str(svg, fonts).map_err(|_| Error("the SVG could not be parsed".into()))
}

/// `{ width, height }` of the SVG's own size.
pub fn svg_size(svg: &str) -> Result<(f32, f32), Error> {
    let size: Size = dom_of(svg, FontMgr::empty())?.root().intrinsic_size();
    Ok((size.width, size.height))
}

/// The CSS generic families: an SVG that asks for one gets the fallback font without a warning.
const GENERIC_FAMILIES: &[&str] = &[
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-serif",
    "ui-sans-serif",
    "ui-monospace",
    "ui-rounded",
    "math",
    "emoji",
    "fangsong",
];

/// Every `font-family` an SVG names, as written: in an attribute (`font-family="Inter, sans-serif"`) or in a style
/// (`style="font-family: 'Inter'"`, a `<style>` rule).
fn font_family_values(svg: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = svg;
    while let Some(at) = rest.find("font-family") {
        rest = &rest[at + "font-family".len()..];
        let after = rest.trim_start();
        let value = if let Some(v) = after.strip_prefix('=') {
            let v = v.trim_start();
            let quote = v.chars().next().filter(|c| *c == '"' || *c == '\'');
            match quote {
                Some(q) => v[1..].split(q).next().unwrap_or_default(),
                None => continue,
            }
        } else if let Some(v) = after.strip_prefix(':') {
            v.split([';', '"', '}', '>']).next().unwrap_or_default()
        } else {
            continue;
        };
        let value = value.trim().to_string();
        if !value.is_empty() && !out.contains(&value) {
            out.push(value);
        }
    }
    out
}

/// The fonts an SVG's text is drawn with: the project's registered fonts, each under the `font-family` values that
/// name it, and the fallback font under the rest (and Skia's default family). No system font is read, so the text is
/// the same on every machine. Answers the families that are named and not registered.
fn svg_fonts(ctx: &mut Ctx, held: Props, svg: &str) -> Result<(FontMgr, Vec<String>), Error> {
    let mut registered: Vec<(String, Typeface)> = Vec::new();
    for font in held.array("fonts").map(Vec::as_slice).unwrap_or_default() {
        let f = Props(font);
        let Some(family) = f.str("family") else {
            continue;
        };
        let typeface = typeface_in(ctx.assets, &ctx.base_dir, f)?;
        registered.push((family.to_string(), typeface));
    }
    let fallback = match held.props("fallback") {
        Some(f) => Some(typeface_in(ctx.assets, &ctx.base_dir, f)?),
        None => registered.first().map(|(_, t)| t.clone()),
    };
    let mut provider = TypefaceFontProvider::new();
    let mut missing = Vec::new();
    let mut aliases = vec!["default".to_string()];
    for value in font_family_values(svg) {
        if !aliases.contains(&value) {
            aliases.push(value);
        }
    }
    for alias in &aliases {
        let names: Vec<String> = alias
            .split(',')
            .map(|n| n.trim().trim_matches(['"', '\'']).trim().to_string())
            .filter(|n| !n.is_empty())
            .collect();
        let chosen = names.iter().find(|name| {
            registered
                .iter()
                .any(|(family, _)| family.eq_ignore_ascii_case(name))
        });
        match chosen {
            Some(name) => {
                for (family, typeface) in &registered {
                    if family.eq_ignore_ascii_case(name) {
                        provider.register_typeface(typeface.clone(), Some(alias.as_str()));
                    }
                }
            }
            None => {
                for name in &names {
                    let generic = GENERIC_FAMILIES.contains(&name.to_ascii_lowercase().as_str());
                    if !generic && name != "default" && !missing.contains(name) {
                        missing.push(name.clone());
                    }
                }
                if let Some(typeface) = &fallback {
                    provider.register_typeface(typeface.clone(), Some(alias.as_str()));
                }
            }
        }
    }
    Ok((provider.into(), missing))
}

fn svg_image(ctx: &mut Ctx, props: Props) -> Result<(), Error> {
    let Some(held) = props.get("svg") else {
        return Ok(());
    };
    let text = held.get("svg").and_then(Value::as_str).ok_or_else(|| {
        Error("svg must be an SVG made with Skia.SVG.MakeFromString or useSVG".into())
    })?;
    let fonts = if text.contains("<text") {
        let (fonts, missing) = svg_fonts(ctx, Props(held), text)?;
        if fonts.count_families() == 0 {
            ctx.leave_out(
                "ImageSVG",
                Some("text"),
                "no font is registered and there is no fallback font: the SVG's text is not drawn",
            );
        }
        for family in missing {
            ctx.leave_out(
                "ImageSVG",
                Some("text"),
                format!(
                    "the font \"{family}\" is not registered: the SVG's text is drawn in the fallback font"
                ),
            );
        }
        fonts
    } else {
        FontMgr::empty()
    };
    let canvas = ctx.canvas;
    let mut dom = dom_of(text, fonts)?;
    let own = dom.root().intrinsic_size();
    let width = props.f32("width")?.unwrap_or(own.width);
    let height = props.f32("height")?.unwrap_or(own.height);
    canvas.save();
    canvas.translate((props.f32_or("x", 0.0)?, props.f32_or("y", 0.0)?));
    if own.width > 0.0 && own.height > 0.0 {
        // An SVG with a size of its own keeps it: it is fitted into the rectangle as SVG's default
        // `preserveAspectRatio` does (whole picture, centred).
        let scale = (width / own.width).min(height / own.height);
        canvas.translate((
            (width - own.width * scale) / 2.0,
            (height - own.height * scale) / 2.0,
        ));
        canvas.scale((scale, scale));
        dom.set_container_size(own);
    } else {
        // Sized by percentages: the rectangle is what they are of.
        dom.set_container_size((width, height));
    }
    dom.render(canvas);
    canvas.restore();
    Ok(())
}
