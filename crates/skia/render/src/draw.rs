//! The drawing nodes: what each draws onto the canvas with the paint the node
//! is drawn with (and again with each `<Paint>` child).

use serde_json::Value;
use skia_safe::vertices::VertexMode;
use skia_safe::{
    AlphaType, BlendMode, Canvas, ColorType, CubicResampler, FilterMode, Image, ImageInfo,
    MipmapMode, Paint, Point, RRect, Rect, SamplingOptions, Vertices, canvas::SrcRectConstraint,
    images, surfaces,
};

use crate::enums;
use std::path::PathBuf;

use crate::assets::Assets;
use crate::render::{Ctx, Node, default_paint};
use crate::value::{Props, err, rect_of, rrect_of};
use crate::{Error, compound, text};

pub fn draw(ctx: &mut Ctx, n: Node) -> Result<(), Error> {
    if matches!(
        n.kind,
        "Group" | "Layer" | "BackdropFilter" | "BoxShadow" | "Paint"
    ) {
        return Ok(());
    }
    // A picture carries its own paints: it is drawn once, whatever paints are declared.
    if n.kind == "Picture" {
        return compound::picture(ctx, n);
    }
    let mut paints = vec![ctx.paint().clone()];
    paints.append(&mut ctx.declared);
    for paint in &paints {
        draw_with(ctx, n, paint)?;
    }
    Ok(())
}

fn draw_with(ctx: &mut Ctx, n: Node, paint: &Paint) -> Result<(), Error> {
    let props = n.props;
    let canvas = ctx.canvas;
    match n.kind {
        "Fill" => {
            canvas.draw_paint(paint);
        }
        "Rect" => {
            canvas.draw_rect(rect_prop(n)?, paint);
        }
        "RoundedRect" => {
            canvas.draw_rrect(rrect_prop(n)?, paint);
        }
        "Oval" => {
            canvas.draw_oval(rect_prop(n)?, paint);
        }
        "Circle" => {
            let c = match props.point("c")? {
                Some(c) => c,
                None => Point::new(props.f32_or("cx", 0.0)?, props.f32_or("cy", 0.0)?),
            };
            let r = props
                .f32("r")?
                .ok_or_else(|| Error("Circle needs r".into()))?;
            canvas.draw_circle(c, r, paint);
        }
        "Line" => {
            let p1 = props
                .point("p1")?
                .ok_or_else(|| Error("Line needs p1".into()))?;
            let p2 = props
                .point("p2")?
                .ok_or_else(|| Error("Line needs p2".into()))?;
            canvas.draw_line(p1, p2, paint);
        }
        "Points" => {
            let points = points_of(props, "points")?;
            let mode = match props.str("mode").unwrap_or("points") {
                "lines" => skia_safe::canvas::PointMode::Lines,
                "polygon" => skia_safe::canvas::PointMode::Polygon,
                _ => skia_safe::canvas::PointMode::Points,
            };
            canvas.draw_points(mode, &points, paint);
        }
        "DiffRect" => {
            let outer = rounded(props.get("outer"), "outer")?;
            let inner = rounded(props.get("inner"), "inner")?;
            canvas.draw_drrect(outer, inner, paint);
        }
        "Path" => draw_path(canvas, props, paint)?,
        "Image" => draw_image(ctx, n, paint)?,
        "Box" => draw_box(ctx, n, paint)?,
        "Vertices" => draw_vertices(canvas, props, paint)?,
        "Text" | "TextPath" | "Paragraph" => text::draw(ctx, n, paint)?,
        "Atlas" | "Patch" | "Glyphs" | "TextBlob" | "ImageSVG" => compound::draw(ctx, n, paint)?,
        other => ctx.leave_out(other, None, "this node is not drawn by the Skia addon"),
    }
    Ok(())
}

fn rect_prop(n: Node) -> Result<Rect, Error> {
    n.props.rect()?.ok_or_else(|| {
        Error(format!(
            "{} needs x, y, width and height, or a rect",
            n.kind
        ))
    })
}

fn rrect_prop(n: Node) -> Result<RRect, Error> {
    if let Some(held) = n.props.get("rect") {
        return rrect_of(held)
            .ok_or_else(|| Error("RoundedRect rect must be a rounded rect".into()));
    }
    let rect = rect_prop(n)?;
    let r = n.props.radius("r")?.unwrap_or_default();
    Ok(RRect::new_rect_xy(rect, r.x, r.y))
}

/// A rect or a rounded rect as a rounded rect.
fn rounded(v: Option<&Value>, key: &str) -> Result<RRect, Error> {
    let v = v.ok_or_else(|| Error(format!("DiffRect needs {key}")))?;
    if v.get("rx").is_some() {
        return rrect_of(v).ok_or_else(|| Error(format!("{key} must be a rounded rect")));
    }
    rect_of(v)
        .map(RRect::new_rect)
        .ok_or_else(|| Error(format!("{key} must be a rect or a rounded rect")))
}

pub fn points_of(props: Props, key: &str) -> Result<Vec<Point>, Error> {
    props
        .array(key)
        .ok_or_else(|| Error(format!("{key} must be a list of points")))?
        .iter()
        .map(|p| {
            crate::value::point(p).ok_or_else(|| Error(format!("{key} must be a list of points")))
        })
        .collect()
}

fn draw_path(canvas: &Canvas, props: Props, paint: &Paint) -> Result<(), Error> {
    let mut path = props
        .path("path")?
        .ok_or_else(|| Error("Path needs a path".into()))?;
    if let Some(fill) = props.str("fillType") {
        path = path.with_fill_type(crate::value::fill_type(fill));
    }
    let start = props.f32_or("start", 0.0)?.clamp(0.0, 1.0);
    let end = props.f32_or("end", 1.0)?.clamp(0.0, 1.0);
    if start != 0.0 || end != 1.0 {
        let trim =
            skia_safe::trim_path_effect::new(start, end, skia_safe::trim_path_effect::Mode::Normal)
                .ok_or_else(|| Error("the path could not be trimmed".into()))?;
        let rec = skia_safe::StrokeRec::new_fill();
        path = trim
            .filter_path(&path, &rec, path.bounds())
            .map(|(p, _)| skia_safe::Path::from(p))
            .ok_or_else(|| Error("the path could not be trimmed".into()))?;
    }
    if let Some(stroke) = props.props("stroke") {
        let mut outline = Paint::default();
        outline.set_style(skia_safe::PaintStyle::Stroke);
        outline.set_stroke_width(stroke.f32_or("width", 1.0)?);
        if let Some(join) = stroke.str("join") {
            outline.set_stroke_join(enums::paint_join(join)?);
        }
        if let Some(cap) = stroke.str("cap") {
            outline.set_stroke_cap(enums::paint_cap(cap)?);
        }
        if let Some(miter) = stroke.f32("miter_limit")? {
            outline.set_stroke_miter(miter);
        }
        let precision = stroke.f32_or("precision", 1.0)?;
        let mut stroked = skia_safe::PathBuilder::new();
        let scale = skia_safe::Matrix::scale((precision, precision));
        // A hairline (width 0) stays a path to stroke; anything else becomes the outline to fill.
        skia_safe::path_utils::fill_path_with_paint(&path, &outline, &mut stroked, None, scale);
        path = skia_safe::Path::from(stroked);
    }
    canvas.draw_path(&path, paint);
    Ok(())
}

// ---- images ----

/// The picture of an `image` prop. A picture is one of
///
/// - `{ src }`: a file, read once; with `frame` (an index) or `time` (milliseconds, looping) it is that frame of an
///   animated GIF or WebP;
/// - `{ data }`: encoded bytes kept with `putData` (`Skia.Image.MakeImageFromEncoded`), with `frame` or `time` too;
/// - `{ pixels, width, height, colorType, alphaType, rowBytes }`: raw pixels kept with `putData` (`Skia.Image.MakeImage`);
/// - `{ picture, width, height }`: a recorded picture drawn into a picture of that size (a surface's snapshot);
/// - `{ nodes, width, height }`: a tree drawn into a picture of that size (`drawAsImage`).
pub fn image_of(ctx: &mut Ctx, v: &Value) -> Result<Image, Error> {
    let p = Props(v);
    if p.has("frame") || p.has("time") {
        let path = p.str("src").map(|src| ctx.file(src));
        let animation = ctx.assets.animation(path.as_deref(), p.str("data"))?;
        let index = match p.f32("frame")? {
            Some(frame) => (frame.max(0.0) as usize).min(animation.frames.len() - 1),
            None => animation.index_at(f64::from(p.f32_or("time", 0.0)?)),
        };
        return Ok(animation.frames[index].clone());
    }
    if let Some(src) = p.str("src") {
        let path = ctx.file(src);
        return ctx.assets.image(&path);
    }
    if let Some(id) = p.str("data") {
        return ctx.assets.data_image(id);
    }
    let size = || -> Result<(i32, i32), Error> {
        match (p.f32("width")?, p.f32("height")?) {
            (Some(w), Some(h)) if (1.0..=16384.0).contains(&w) && (1.0..=16384.0).contains(&h) => {
                Ok((w as i32, h as i32))
            }
            _ => err("a picture needs a width and a height of 1 to 16384 pixels"),
        }
    };
    if let Some(id) = p.str("pixels") {
        let (width, height) = size()?;
        let color_type = match p.str("colorType").unwrap_or("rgba8888") {
            "rgba8888" => ColorType::RGBA8888,
            "bgra8888" => ColorType::BGRA8888,
            "alpha8" => ColorType::Alpha8,
            "gray8" => ColorType::Gray8,
            "rgbaf16" => ColorType::RGBAF16,
            "rgbaf32" => ColorType::RGBAF32,
            other => return err(format!("unknown colour type {other:?}")),
        };
        let alpha_type = match p.str("alphaType").unwrap_or("unpremul") {
            "opaque" => AlphaType::Opaque,
            "premul" => AlphaType::Premul,
            "unpremul" => AlphaType::Unpremul,
            other => return err(format!("unknown alpha type {other:?}")),
        };
        let info = ImageInfo::new((width, height), color_type, alpha_type, None);
        let row_bytes = match p.f32("rowBytes")? {
            Some(n) => n as usize,
            None => info.min_row_bytes(),
        };
        let data = ctx.assets.data(id)?;
        if data.len() < info.compute_byte_size(row_bytes) {
            return err(format!(
                "the pixels are {} bytes, a {width} x {height} picture needs {}",
                data.len(),
                info.compute_byte_size(row_bytes)
            ));
        }
        return images::raster_from_data(&info, data, row_bytes)
            .ok_or_else(|| Error("the pixels could not be made into a picture".into()));
    }
    if p.has("picture") || p.has("nodes") {
        let (width, height) = size()?;
        let info = ImageInfo::new(
            (width, height),
            ColorType::RGBA8888,
            AlphaType::Premul,
            None,
        );
        let mut surface = surfaces::raster(&info, None, None)
            .ok_or_else(|| Error("no surface of that size".into()))?;
        if let Some(picture) = p.get("picture") {
            let recorded = crate::compound::record(ctx, picture)?;
            surface.canvas().draw_picture(&recorded, None, None);
        } else {
            let nodes = p.array("nodes").map(Vec::as_slice).unwrap_or_default();
            let left_out = crate::render::draw_nodes(
                surface.canvas(),
                nodes,
                ctx.assets,
                ctx.base_dir.clone(),
            )?;
            for item in left_out {
                if !ctx.unsupported.contains(&item) {
                    ctx.unsupported.push(item);
                }
            }
        }
        return Ok(surface.image_snapshot());
    }
    err("an image needs a src, data, pixels, a picture or nodes")
}

/// What `SkImage` and `SkAnimatedImage` answer about a picture (`{ image, call }`): `size` is `{ width, height }`,
/// `frames` is `{ count, durations }` (milliseconds) of an animated one.
pub fn image_call(assets: &mut Assets, base_dir: PathBuf, request: &Value) -> Result<Value, Error> {
    let call = Props(request).str("call").unwrap_or("size");
    let held = request
        .get("image")
        .ok_or_else(|| Error("an image call needs an image".into()))?;
    if call == "frames" {
        let p = Props(held);
        let path = p.str("src").map(|src| base_dir.join(src));
        let animation = assets.animation(path.as_deref(), p.str("data"))?;
        return Ok(serde_json::json!({
            "count": animation.frames.len(),
            "durations": animation.durations,
        }));
    }
    let image = with_image(assets, base_dir, held, |image| Ok(image.clone()))?;
    match call {
        "size" => Ok(serde_json::json!({ "width": image.width(), "height": image.height() })),
        other => err(format!("unknown image call {other:?}")),
    }
}

/// The bytes of a picture (`{ image, format }`): `rgba` is its pixels, straight alpha, row after row; `png` is a PNG.
pub fn image_bytes(
    assets: &mut Assets,
    base_dir: PathBuf,
    request: &Value,
) -> Result<Vec<u8>, Error> {
    let held = request
        .get("image")
        .ok_or_else(|| Error("an image call needs an image".into()))?;
    let format = Props(request).str("format").unwrap_or("rgba");
    with_image(assets, base_dir, held, |image| {
        let (w, h) = (image.width(), image.height());
        match format {
            "rgba" => {
                let info = ImageInfo::new((w, h), ColorType::RGBA8888, AlphaType::Unpremul, None);
                let mut rgba = vec![0u8; w as usize * h as usize * 4];
                if !image.read_pixels(
                    &info,
                    &mut rgba,
                    w as usize * 4,
                    (0, 0),
                    skia_safe::image::CachingHint::Allow,
                ) {
                    return err("the picture's pixels could not be read");
                }
                Ok(rgba)
            }
            "png" => {
                let raster = image
                    .make_raster_image(None, None)
                    .unwrap_or_else(|| image.clone());
                skia_safe::png_encoder::encode_image(None, &raster, &Default::default())
                    .map(|d| d.as_bytes().to_vec())
                    .ok_or_else(|| Error("the picture could not be encoded".into()))
            }
            other => err(format!("unknown picture format {other:?}")),
        }
    })
}

/// Runs `f` on the picture `held` names, made in a context of its own.
fn with_image<T>(
    assets: &mut Assets,
    base_dir: PathBuf,
    held: &Value,
    f: impl FnOnce(&Image) -> Result<T, Error>,
) -> Result<T, Error> {
    let mut surface = surfaces::raster_n32_premul((1, 1))
        .ok_or_else(|| Error("no surface could be made".into()))?;
    let mut ctx = Ctx::new(surface.canvas(), assets, base_dir);
    let image = image_of(&mut ctx, held)?;
    f(&image)
}

pub fn sampling_of(props: Props) -> Result<SamplingOptions, Error> {
    let Some(s) = props.props("sampling") else {
        return Ok(SamplingOptions::new(FilterMode::Linear, MipmapMode::None));
    };
    if let (Some(b), Some(c)) = (s.f32("B")?, s.f32("C")?) {
        return Ok(SamplingOptions::from(CubicResampler { b, c }));
    }
    let filter = if s.str("filter") == Some("nearest") {
        FilterMode::Nearest
    } else {
        FilterMode::Linear
    };
    let mipmap = match s.str("mipmap") {
        Some("nearest") => MipmapMode::Nearest,
        Some("linear") => MipmapMode::Linear,
        _ => MipmapMode::None,
    };
    Ok(SamplingOptions::new(filter, mipmap))
}

fn size_of(w: f32, h: f32) -> (f32, f32) {
    (w, h)
}

/// RN-Skia's `fitRects`: the part of `source` shown and where it goes inside `target`.
pub fn fit_rects(fit: &str, source: Rect, target: Rect) -> (Rect, Rect) {
    let (iw, ih) = size_of(source.width(), source.height());
    let (ow, oh) = size_of(target.width(), target.height());
    let (src, dst) = if ih <= 0.0 || iw <= 0.0 || oh <= 0.0 || ow <= 0.0 {
        ((0.0, 0.0), (0.0, 0.0))
    } else {
        match fit {
            "fill" => ((iw, ih), (ow, oh)),
            "cover" => {
                let src = if ow / oh > iw / ih {
                    (iw, iw * oh / ow)
                } else {
                    (ih * ow / oh, ih)
                };
                (src, (ow, oh))
            }
            "fitWidth" => {
                let src = (iw, iw * oh / ow);
                (src, (ow, src.1 * ow / src.0))
            }
            "fitHeight" => {
                let src = (ih * ow / oh, ih);
                (src, (src.0 * oh / src.1, oh))
            }
            "none" => {
                let s = (iw.min(ow), ih.min(oh));
                (s, s)
            }
            "scaleDown" => {
                let aspect = iw / ih;
                let mut dst = (iw, ih);
                if dst.1 > oh {
                    dst = (oh * aspect, oh);
                }
                if dst.0 > ow {
                    dst = (ow, ow / aspect);
                }
                ((iw, ih), dst)
            }
            // "contain", and what RN-Skia treats as it.
            _ => {
                let dst = if ow / oh > iw / ih {
                    (iw * oh / ih, oh)
                } else {
                    (ow, ih * ow / iw)
                };
                ((iw, ih), dst)
            }
        }
    };
    let inscribe = |size: (f32, f32), r: Rect| {
        Rect::from_xywh(
            r.left + (r.width() - size.0) / 2.0,
            r.top + (r.height() - size.1) / 2.0,
            size.0,
            size.1,
        )
    };
    (inscribe(src, source), inscribe(dst, target))
}

fn draw_image(ctx: &mut Ctx, n: Node, paint: &Paint) -> Result<(), Error> {
    let Some(held) = n.props.get("image") else {
        return Ok(());
    };
    let image = image_of(ctx, held)?;
    let target = rect_prop(n)?;
    let fit = n.props.str("fit").unwrap_or("contain");
    let (src, dst) = fit_rects(
        fit,
        Rect::from_wh(image.width() as f32, image.height() as f32),
        target,
    );
    let sampling = sampling_of(n.props)?;
    ctx.canvas.draw_image_rect_with_sampling_options(
        &image,
        Some((&src, SrcRectConstraint::Fast)),
        dst,
        sampling,
        paint,
    );
    Ok(())
}

// ---- box shadows ----

fn draw_box(ctx: &mut Ctx, n: Node, paint: &Paint) -> Result<(), Error> {
    let canvas = ctx.canvas;
    let held = n
        .props
        .get("box")
        .ok_or_else(|| Error("Box needs a box".into()))?;
    let boxed = if held.get("rx").is_some() {
        rrect_of(held).ok_or_else(|| Error("box must be a rect or a rounded rect".into()))?
    } else {
        RRect::new_rect(
            rect_of(held).ok_or_else(|| Error("box must be a rect or a rounded rect".into()))?,
        )
    };
    let opacity = paint.alpha_f();
    let mut shadows = Vec::new();
    for child in n.children {
        let child = crate::render::node(child)?;
        if child.kind == "BoxShadow" {
            shadows.push(child.props);
        }
    }
    let shadow_paint = |p: Props| -> Result<Paint, Error> {
        let mut shadow = default_paint();
        let color = p
            .color("color")?
            .unwrap_or(skia_safe::Color4f::new(0.0, 0.0, 0.0, 1.0));
        shadow.set_color4f(color, None);
        shadow.set_alpha_f(shadow.alpha_f() * opacity);
        let blur = p
            .f32("blur")?
            .ok_or_else(|| Error("BoxShadow needs a blur".into()))?;
        shadow.set_mask_filter(skia_safe::MaskFilter::blur(
            skia_safe::BlurStyle::Normal,
            blur,
            true,
        ));
        Ok(shadow)
    };
    let grown = |b: &RRect, dx: f32, dy: f32, tx: f32, ty: f32| {
        let r = b.rect();
        RRect::new_rect_xy(
            Rect::from_xywh(
                r.left - dx + tx,
                r.top - dy + ty,
                r.width() + 2.0 * dx,
                r.height() + 2.0 * dy,
            ),
            b.simple_radii().x + dx,
            b.simple_radii().y + dy,
        )
    };
    for p in shadows.iter().filter(|p| p.bool("inner") != Some(true)) {
        let spread = p.f32_or("spread", 0.0)?;
        let rect = grown(
            &boxed,
            spread,
            spread,
            p.f32_or("dx", 0.0)?,
            p.f32_or("dy", 0.0)?,
        );
        canvas.draw_rrect(rect, &shadow_paint(*p)?);
    }
    canvas.draw_rrect(boxed, paint);
    for p in shadows.iter().filter(|p| p.bool("inner") == Some(true)) {
        let (dx, dy) = (p.f32_or("dx", 0.0)?, p.f32_or("dy", 0.0)?);
        let spread = p.f32_or("spread", 0.0)?;
        canvas.save();
        canvas.clip_rrect(boxed, skia_safe::ClipOp::Intersect, false);
        let inner = grown(&boxed, -spread, -spread, dx, dy);
        let outer = grown(&boxed, 10.0 + dx.abs(), 10.0 + dy.abs(), 0.0, 0.0);
        canvas.draw_drrect(outer, inner, &shadow_paint(*p)?);
        canvas.restore();
    }
    Ok(())
}

// ---- vertices ----

fn draw_vertices(canvas: &Canvas, props: Props, paint: &Paint) -> Result<(), Error> {
    let positions = points_of(props, "vertices")?;
    let textures = if props.has("textures") {
        Some(points_of(props, "textures")?)
    } else {
        None
    };
    let colors: Option<Vec<skia_safe::Color>> = match props.array("colors") {
        Some(list) => Some(
            list.iter()
                .map(|c| {
                    crate::value::color(c)
                        .map(|c| c.to_color())
                        .ok_or_else(|| Error("colors must be colours".into()))
                })
                .collect::<Result<_, _>>()?,
        ),
        None => None,
    };
    let indices: Option<Vec<u16>> = props
        .f32s("indices")?
        .map(|i| i.into_iter().map(|n| n as u16).collect());
    let mode = match props.str("mode").unwrap_or("triangles") {
        "triangleStrip" => VertexMode::TriangleStrip,
        "triangleFan" => VertexMode::TriangleFan,
        _ => VertexMode::Triangles,
    };
    let vertices = Vertices::new_copy(
        mode,
        &positions,
        textures.as_deref().unwrap_or(&[]),
        colors.as_deref().unwrap_or(&[]),
        indices.as_deref(),
    );
    let default_blend = if colors.is_some() {
        BlendMode::DstOver
    } else {
        BlendMode::SrcOver
    };
    let blend = match props.str("blendMode") {
        Some(name) => enums::blend_mode(name)?,
        None => default_blend,
    };
    canvas.draw_vertices(&vertices, blend, paint);
    Ok(())
}
