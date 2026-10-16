//! Walking the tree: the paint stack, the declarations a node's children make
//! (shaders, filters, path effects, extra paints), the canvas state of a group
//! (transform, clip, layer) and, at each drawing node, the draws.
//!
//! The rules are RN-Skia's: a node with paint props, or with declaration
//! children, pushes a copy of the paint it inherits with those laid over it;
//! the declarations (a shader, a colour filter, ...) are collected from the
//! children in order and set on that paint when they are all known; a `<Paint>`
//! child is another paint the node's drawing is repeated with.

use std::path::PathBuf;

use serde_json::Value;
use skia_safe::{
    Canvas, ColorFilter, ImageFilter, ImageInfo, AlphaType, ColorType, Paint, PathEffect, Shader,
    color_filters, canvas::SaveLayerRec, image_filters, surfaces, Matrix, ClipOp,
};

use crate::assets::Assets;
use crate::enums;
use crate::value::{err, Props};
use crate::{declare, draw, Error, Output, Unsupported};

/// One node of the tree: `{ type, props, children }`.
#[derive(Clone, Copy)]
pub struct Node<'a> {
    pub kind: &'a str,
    pub props: Props<'a>,
    pub children: &'a [Value],
}

pub fn node(v: &Value) -> Result<Node<'_>, Error> {
    let kind = v.get("type").and_then(Value::as_str).ok_or_else(|| Error("a node needs a type".into()))?;
    static NONE: Value = Value::Null;
    Ok(Node {
        kind,
        props: Props(v.get("props").unwrap_or(&NONE)),
        children: v.get("children").and_then(Value::as_array).map_or(&[], Vec::as_slice),
    })
}

pub struct Ctx<'a> {
    pub canvas: &'a Canvas,
    pub assets: &'a mut Assets,
    pub base_dir: PathBuf,
    pub paints: Vec<Paint>,
    /// The `<Paint>` children met so far: the next draw is repeated with each.
    pub declared: Vec<Paint>,
    pub color_filters: Vec<ColorFilter>,
    pub shaders: Vec<Shader>,
    pub image_filters: Vec<ImageFilter>,
    pub path_effects: Vec<PathEffect>,
    pub unsupported: Vec<Unsupported>,
}

impl Ctx<'_> {
    pub fn paint(&self) -> &Paint {
        self.paints.last().expect("the paint stack is never empty")
    }

    fn paint_mut(&mut self) -> &mut Paint {
        self.paints.last_mut().expect("the paint stack is never empty")
    }

    pub fn leave_out(&mut self, element: &str, property: Option<&str>, reason: impl Into<String>) {
        let item = Unsupported {
            element: element.to_string(),
            property: property.map(str::to_string),
            reason: reason.into(),
        };
        if !self.unsupported.contains(&item) {
            self.unsupported.push(item);
        }
    }

    /// A path in a file named by a tree: relative to the scene's directory.
    pub fn file(&self, name: &str) -> PathBuf {
        self.base_dir.join(name)
    }
}

/// A new paint as Skia's own default, with anti-aliasing on, as RN-Skia's `Skia.Paint()`.
pub fn default_paint() -> Paint {
    let mut paint = Paint::default();
    paint.set_anti_alias(true);
    paint
}

/// Draws `nodes` (the children of the canvas) into a picture `width` by `height`.
pub fn render(
    width: u32,
    height: u32,
    nodes: &[Value],
    assets: &mut Assets,
    base_dir: PathBuf,
) -> Result<Output, Error> {
    if width == 0 || height == 0 {
        return err("the canvas has no area");
    }
    let info = ImageInfo::new((width as i32, height as i32), ColorType::RGBA8888, AlphaType::Premul, None);
    let mut surface = surfaces::raster(&info, None, None).ok_or_else(|| Error("no surface of that size".into()))?;
    let unsupported = {
        let mut ctx = Ctx {
            canvas: surface.canvas(),
            assets,
            base_dir,
            paints: vec![default_paint()],
            declared: Vec::new(),
            color_filters: Vec::new(),
            shaders: Vec::new(),
            image_filters: Vec::new(),
            path_effects: Vec::new(),
            unsupported: Vec::new(),
        };
        for child in nodes {
            visit(&mut ctx, node(child)?)?;
        }
        ctx.unsupported
    };
    // Skia draws premultiplied; the canvas layer takes straight alpha.
    let straight = ImageInfo::new((width as i32, height as i32), ColorType::RGBA8888, AlphaType::Unpremul, None);
    let mut rgba = vec![0u8; width as usize * height as usize * 4];
    if !surface.read_pixels(&straight, &mut rgba, width as usize * 4, (0, 0)) {
        return err("the picture could not be read back");
    }
    Ok(Output {
        width,
        height,
        rgba,
        unsupported,
    })
}

const COLOR_FILTERS: &[&str] = &[
    "BlendColorFilter",
    "MatrixColorFilter",
    "LerpColorFilter",
    "LumaColorFilter",
    "SRGBToLinearGammaColorFilter",
    "LinearToSRGBGammaColorFilter",
];
const PATH_EFFECTS: &[&str] = &[
    "DiscretePathEffect",
    "DashPathEffect",
    "Path1DPathEffect",
    "Path2DPathEffect",
    "CornerPathEffect",
    "SumPathEffect",
    "Line2DPathEffect",
];
const IMAGE_FILTERS: &[&str] = &[
    "OffsetImageFilter",
    "DisplacementMapImageFilter",
    "BlurImageFilter",
    "DropShadowImageFilter",
    "MorphologyImageFilter",
    "BlendImageFilter",
    "RuntimeShaderImageFilter",
];
const SHADERS: &[&str] = &[
    "Shader",
    "ImageShader",
    "ColorShader",
    "Turbulence",
    "FractalNoise",
    "LinearGradient",
    "RadialGradient",
    "SweepGradient",
    "TwoPointConicalGradient",
];

pub fn is_color_filter(kind: &str) -> bool {
    COLOR_FILTERS.contains(&kind)
}
pub fn is_path_effect(kind: &str) -> bool {
    PATH_EFFECTS.contains(&kind)
}
pub fn is_image_filter(kind: &str) -> bool {
    IMAGE_FILTERS.contains(&kind)
}
pub fn is_shader(kind: &str) -> bool {
    SHADERS.contains(&kind)
}

/// A node's children by what they are for.
#[derive(Default)]
struct Sorted<'a> {
    color_filters: Vec<Node<'a>>,
    mask_filters: Vec<Node<'a>>,
    drawings: Vec<Node<'a>>,
    shaders: Vec<Node<'a>>,
    image_filters: Vec<Node<'a>>,
    path_effects: Vec<Node<'a>>,
    paints: Vec<Node<'a>>,
}

fn sort<'a>(children: &'a [Value]) -> Result<Sorted<'a>, Error> {
    let mut sorted = Sorted::default();
    for child in children {
        let child = node(child)?;
        match child.kind {
            kind if is_color_filter(kind) => sorted.color_filters.push(child),
            "BlurMaskFilter" => sorted.mask_filters.push(child),
            kind if is_path_effect(kind) => sorted.path_effects.push(child),
            kind if is_image_filter(kind) => sorted.image_filters.push(child),
            kind if is_shader(kind) => sorted.shaders.push(child),
            "Paint" => sorted.paints.push(child),
            // A blend of image filters is an image filter; of anything else, a shader.
            "Blend" => match child.children.first().map(node).transpose()? {
                Some(first) if is_image_filter(first.kind) => sorted.image_filters.push(Node {
                    kind: "BlendImageFilter",
                    ..child
                }),
                _ => sorted.shaders.push(child),
            },
            _ => sorted.drawings.push(child),
        }
    }
    Ok(sorted)
}

const PAINT_PROPS: &[&str] = &[
    "opacity",
    "color",
    "strokeWidth",
    "blendMode",
    "style",
    "strokeJoin",
    "strokeCap",
    "strokeMiter",
    "antiAlias",
    "dither",
    "paint",
];

fn has_paint_props(props: Props) -> bool {
    PAINT_PROPS.iter().any(|key| props.has(key))
}

/// RN-Skia's `setPaintProperties`.
fn apply_paint_props(paint: &mut Paint, props: Props) -> Result<(), Error> {
    if let Some(opacity) = props.f32("opacity")? {
        paint.set_alpha_f(paint.alpha_f() * opacity);
    }
    if let Some(color) = props.color("color")? {
        let current = paint.alpha_f();
        paint.set_shader(None);
        paint.set_color4f(color, None);
        paint.set_alpha_f(current * paint.alpha_f());
    }
    if let Some(mode) = props.str("blendMode") {
        paint.set_blend_mode(enums::blend_mode(mode)?);
    }
    if let Some(width) = props.f32("strokeWidth")? {
        paint.set_stroke_width(width);
    }
    if let Some(style) = props.str("style") {
        paint.set_style(enums::paint_style(style)?);
    }
    if let Some(join) = props.str("strokeJoin") {
        paint.set_stroke_join(enums::paint_join(join)?);
    }
    if let Some(cap) = props.str("strokeCap") {
        paint.set_stroke_cap(enums::paint_cap(cap)?);
    }
    if let Some(miter) = props.f32("strokeMiter")? {
        paint.set_stroke_miter(miter);
    }
    if let Some(on) = props.bool("antiAlias") {
        paint.set_anti_alias(on);
    }
    if let Some(on) = props.bool("dither") {
        paint.set_dither(on);
    }
    Ok(())
}

/// Sets what the declarations collected on the stack onto the current paint, and empties the stack.
fn materialize(ctx: &mut Ctx) {
    let color_filters = std::mem::take(&mut ctx.color_filters);
    let shaders = std::mem::take(&mut ctx.shaders);
    let image_filters = std::mem::take(&mut ctx.image_filters);
    let path_effects = std::mem::take(&mut ctx.path_effects);
    let paint = ctx.paint_mut();
    if let Some(filter) = compose(color_filters, |outer, inner| color_filters::compose(outer, inner)) {
        paint.set_color_filter(filter);
    }
    if let Some(shader) = shaders.last() {
        paint.set_shader(shader.clone());
    }
    if let Some(filter) = compose(image_filters, |outer, inner| image_filters::compose(outer, inner)) {
        paint.set_image_filter(filter);
    }
    if let Some(effect) = compose(path_effects, |outer, inner| Some(PathEffect::compose(outer, inner))) {
        paint.set_path_effect(effect);
    }
}

/// `composer(first, composer(second, ... last))`: RN-Skia's `composeDeclarations`.
pub fn compose<T>(mut items: Vec<T>, composer: impl Fn(T, T) -> Option<T>) -> Option<T> {
    let mut composed = items.pop()?;
    while let Some(outer) = items.pop() {
        composed = composer(outer, composed)?;
    }
    Some(composed)
}

/// Pushes a paint for a node: the inherited one with `props` laid over it, or the paint the props hold.
fn save_paint(ctx: &mut Ctx, props: Props) -> Result<(), Error> {
    if let Some(held) = props.get("paint") {
        let paint = paint_of(ctx, held)?;
        ctx.paints.push(paint);
    } else {
        let mut paint = ctx.paint().clone();
        apply_paint_props(&mut paint, props)?;
        ctx.paints.push(paint);
    }
    Ok(())
}

/// A paint made from a `Skia.Paint()` object: a `Paint` node, built on a default paint.
pub fn paint_of(ctx: &mut Ctx, held: &Value) -> Result<Paint, Error> {
    let held = node(held)?;
    ctx.paints.push(default_paint());
    let result = (|| {
        apply_paint_props(ctx.paints.last_mut().unwrap(), held.props)?;
        declare_children(ctx, &sort(held.children)?)?;
        materialize(ctx);
        Ok(())
    })();
    let paint = ctx.paints.pop().expect("pushed above");
    result.map(|()| paint)
}

fn declare_children(ctx: &mut Ctx, sorted: &Sorted) -> Result<(), Error> {
    declare::color_filters(ctx, &sorted.color_filters)?;
    declare::image_filters(ctx, &sorted.image_filters)?;
    if let Some(last) = sorted.mask_filters.last() {
        let filter = declare::mask_filter(last.props)?;
        ctx.paint_mut().set_mask_filter(filter);
    }
    declare::shaders(ctx, &sorted.shaders)?;
    declare::path_effects(ctx, &sorted.path_effects)
}

fn push_paints(ctx: &mut Ctx, paints: &[Node]) -> Result<(), Error> {
    for paint in paints {
        save_paint(ctx, paint.props)?;
        declare_children(ctx, &sort(paint.children)?)?;
        materialize(ctx);
        let done = ctx.paints.pop().expect("pushed above");
        ctx.declared.push(done);
    }
    Ok(())
}

fn visit(ctx: &mut Ctx, node: Node) -> Result<(), Error> {
    let sorted = sort(node.children)?;
    let pushes_paint = has_paint_props(node.props)
        || !(sorted.color_filters.is_empty()
            && sorted.mask_filters.is_empty()
            && sorted.image_filters.is_empty()
            && sorted.path_effects.is_empty()
            && sorted.shaders.is_empty());
    if pushes_paint {
        save_paint(ctx, node.props)?;
        declare_children(ctx, &sorted)?;
        if node.kind == "BackdropFilter" {
            backdrop(ctx);
        } else {
            materialize(ctx);
        }
    }
    push_paints(ctx, &sorted.paints)?;
    if node.kind == "Layer" {
        materialize(ctx);
        let paint = ctx.declared.pop();
        match paint {
            Some(paint) => ctx.canvas.save_layer(&SaveLayerRec::default().paint(&paint)),
            None => ctx.canvas.save_layer(&SaveLayerRec::default()),
        };
    }
    let saved = save_ctm(ctx, node.props)?;
    draw::draw(ctx, node)?;
    for drawing in &sorted.drawings {
        visit(ctx, *drawing)?;
    }
    if pushes_paint {
        ctx.paints.pop();
    }
    if saved || node.kind == "Layer" {
        ctx.canvas.restore();
    }
    Ok(())
}

/// A backdrop filter: what is behind the node is filtered where the node's layer is, nothing is drawn into it.
fn backdrop(ctx: &mut Ctx) {
    let filter = match ctx.image_filters.pop() {
        Some(filter) => Some(filter),
        None => ctx
            .color_filters
            .pop()
            .and_then(|cf| image_filters::color_filter(cf, None, None)),
    };
    ctx.color_filters.clear();
    ctx.shaders.clear();
    ctx.image_filters.clear();
    ctx.path_effects.clear();
    if let Some(filter) = filter {
        ctx.canvas.save_layer(&SaveLayerRec::default().backdrop(&filter));
        ctx.canvas.restore();
    }
}

/// A group's transform, clip and layer. True when it saved the canvas state.
fn save_ctm(ctx: &mut Ctx, props: Props) -> Result<bool, Error> {
    let matrix = transform_of(props)?;
    let clip = props.get("clip");
    let layer = props.get("layer").filter(|l| l.as_bool() != Some(false));
    if matrix.is_none() && clip.is_none() && layer.is_none() {
        return Ok(false);
    }
    match layer {
        Some(Value::Bool(_)) => {
            ctx.canvas.save_layer(&SaveLayerRec::default());
        }
        Some(held) => {
            let paint = paint_of(ctx, held)?;
            ctx.canvas.save_layer(&SaveLayerRec::default().paint(&paint));
        }
        None => {
            ctx.canvas.save();
        }
    }
    if let Some(matrix) = matrix {
        ctx.canvas.concat(&matrix);
    }
    if let Some(clip) = clip {
        let op = if props.bool("invertClip") == Some(true) { ClipOp::Difference } else { ClipOp::Intersect };
        clip_to(ctx.canvas, clip, op)?;
    }
    Ok(true)
}

fn clip_to(canvas: &Canvas, clip: &Value, op: ClipOp) -> Result<(), Error> {
    use crate::value::{path, rect_of, rrect_of};
    if clip.is_string() || clip.get("d").is_some() {
        canvas.clip_path(&path(clip)?, op, true);
    } else if clip.get("rx").is_some() {
        canvas.clip_rrect(rrect_of(clip).ok_or_else(|| Error("clip must be a rounded rect".into()))?, op, true);
    } else {
        canvas.clip_rect(rect_of(clip).ok_or_else(|| Error("clip must be a rect, a rounded rect or a path".into()))?, op, true);
    }
    Ok(())
}

/// The matrix of `transform`, `origin` and `matrix` props; None when there are none.
pub fn transform_of(props: Props) -> Result<Option<Matrix>, Error> {
    let origin = props.point("origin")?;
    let mut matrix = Matrix::new_identity();
    if let Some(m) = props.matrix("matrix")? {
        if let Some(o) = origin {
            matrix.pre_translate(o);
        }
        matrix.pre_concat(&m);
        if let Some(o) = origin {
            matrix.pre_translate((-o.x, -o.y));
        }
        return Ok(Some(matrix));
    }
    if let Some(list) = props.array("transform") {
        if let Some(o) = origin {
            matrix.pre_translate(o);
        }
        for item in list {
            apply_transform(&mut matrix, item)?;
        }
        if let Some(o) = origin {
            matrix.pre_translate((-o.x, -o.y));
        }
        return Ok(Some(matrix));
    }
    Ok(None)
}

/// One item of a `transform` list: `{ translateX: 10 }`, `{ rotate: 1.2 }`, ...
fn apply_transform(m: &mut Matrix, item: &Value) -> Result<(), Error> {
    let (key, value) = item
        .as_object()
        .and_then(|o| o.iter().next())
        .ok_or_else(|| Error("a transform is a list of { name: value }".into()))?;
    let n = || value.as_f64().map(|n| n as f32).ok_or_else(|| Error(format!("{key} must be a number")));
    match key.as_str() {
        "translateX" => m.pre_translate((n()?, 0.0)),
        "translateY" => m.pre_translate((0.0, n()?)),
        "scale" => m.pre_scale((n()?, n()?), None),
        "scaleX" => m.pre_scale((n()?, 1.0), None),
        "scaleY" => m.pre_scale((1.0, n()?), None),
        "skewX" => m.pre_skew((n()?, 0.0), None),
        "skewY" => m.pre_skew((0.0, n()?), None),
        "rotate" | "rotateZ" => m.pre_rotate(n()?.to_degrees(), None),
        "matrix" => {
            let inner = crate::value::matrix(value).ok_or_else(|| Error("matrix must be a matrix".into()))?;
            m.pre_concat(&inner)
        }
        other => return err(format!("unknown transform {other:?}")),
    };
    Ok(())
}
