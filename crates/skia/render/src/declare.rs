//! What the non-drawing children of a node declare: shaders, colour filters,
//! image filters, the mask filter and path effects. Each is pushed on the
//! context's stack, children before their parent, and `render::materialize`
//! sets them on the paint when the node's children are all known.

use skia_safe::runtime_effect::{ChildPtr, uniform};
use skia_safe::{
    BlendMode, Color4f, ColorChannel, ColorFilter, Data, ISize, ImageFilter, MaskFilter, Matrix,
    PathEffect, RuntimeEffect, Shader, TileMode, Vector, color_filters, gradient,
    gradient::Gradient, image_filters, luma_color_filter, shaders,
};

use crate::Error;
use crate::enums;
use crate::render::{Ctx, Node, compose, is_image_filter, is_shader, node, transform_of};
use crate::value::{Props, err};

fn missing<T>(node: Node, what: &str) -> Result<T, Error> {
    err(format!("{} needs {what}", node.kind))
}

// ---- shaders ----

pub fn shaders(ctx: &mut Ctx, nodes: &[Node]) -> Result<(), Error> {
    for n in nodes {
        // A shader's own shader children come first (a runtime shader's inputs, a blend's two sides).
        shaders(ctx, &children_of(n, |k| is_shader(k) || k == "Blend")?)?;
        declare_shader(ctx, *n)?;
    }
    Ok(())
}

fn children_of<'a>(parent: &Node<'a>, keep: impl Fn(&str) -> bool) -> Result<Vec<Node<'a>>, Error> {
    let mut out = Vec::new();
    for child in parent.children {
        let child = node(child)?;
        if keep(child.kind) {
            out.push(child);
        }
    }
    Ok(out)
}

/// The local matrix from `transform`, `origin` and `matrix` props.
fn local_matrix(props: Props) -> Result<Matrix, Error> {
    Ok(transform_of(props)?.unwrap_or_else(Matrix::new_identity))
}

struct GradientParts {
    colors: Vec<Color4f>,
    positions: Option<Vec<f32>>,
    mode: TileMode,
    flags: u32,
    matrix: Matrix,
}

fn gradient_parts(n: Node) -> Result<GradientParts, Error> {
    let colors: Vec<Color4f> = n
        .props
        .array("colors")
        .ok_or_else(|| Error(format!("{} needs colors", n.kind)))?
        .iter()
        .map(|c| {
            crate::value::color(c).ok_or_else(|| Error("a gradient colour must be a colour".into()))
        })
        .collect::<Result<_, _>>()?;
    if colors.is_empty() {
        return missing(n, "at least one colour");
    }
    let positions = n.props.f32s("positions")?;
    if positions.as_ref().is_some_and(|p| p.len() != colors.len()) {
        return err(format!("{}: positions and colors differ in length", n.kind));
    }
    Ok(GradientParts {
        colors,
        positions,
        mode: enums::tile_mode(n.props.str("mode").unwrap_or("clamp"))?,
        flags: n.props.f32("flags")?.unwrap_or(0.0) as u32,
        matrix: local_matrix(n.props)?,
    })
}

impl GradientParts {
    fn gradient(&self) -> Gradient<'_> {
        let colors =
            gradient::Colors::new(&self.colors, self.positions.as_deref(), self.mode, None);
        Gradient::new(colors, gradient::Interpolation::from_flags(self.flags))
    }
}

fn point(n: Node, key: &str) -> Result<skia_safe::Point, Error> {
    n.props
        .point(key)?
        .ok_or_else(|| Error(format!("{} needs {key}", n.kind)))
}

fn number(n: Node, key: &str) -> Result<f32, Error> {
    n.props
        .f32(key)?
        .ok_or_else(|| Error(format!("{} needs {key}", n.kind)))
}

fn declare_shader(ctx: &mut Ctx, n: Node) -> Result<(), Error> {
    let shader = match n.kind {
        "LinearGradient" => {
            let parts = gradient_parts(n)?;
            shaders::linear_gradient(
                (point(n, "start")?, point(n, "end")?),
                &parts.gradient(),
                &parts.matrix,
            )
        }
        "RadialGradient" => {
            let parts = gradient_parts(n)?;
            shaders::radial_gradient(
                (point(n, "c")?, number(n, "r")?),
                &parts.gradient(),
                &parts.matrix,
            )
        }
        "SweepGradient" => {
            let parts = gradient_parts(n)?;
            let start = n.props.f32_or("start", 0.0)?;
            let end = n.props.f32_or("end", 360.0)?;
            shaders::sweep_gradient(
                point(n, "c")?,
                (start, end),
                &parts.gradient(),
                &parts.matrix,
            )
        }
        "TwoPointConicalGradient" => {
            let parts = gradient_parts(n)?;
            shaders::two_point_conical_gradient(
                (point(n, "start")?, number(n, "startR")?),
                (point(n, "end")?, number(n, "endR")?),
                &parts.gradient(),
                &parts.matrix,
            )
        }
        "ColorShader" => {
            let color = n
                .props
                .color("color")?
                .ok_or_else(|| Error("ColorShader needs a color".into()))?;
            Some(shaders::color_in_space(
                color,
                skia_safe::ColorSpace::new_srgb(),
            ))
        }
        "Turbulence" | "FractalNoise" => {
            let frequency = (number(n, "freqX")?, number(n, "freqY")?);
            let octaves = number(n, "octaves")? as usize;
            let seed = number(n, "seed")?;
            let tile = match (n.props.f32("tileWidth")?, n.props.f32("tileHeight")?) {
                (Some(w), Some(h)) => Some(ISize::new(w as i32, h as i32)),
                _ => None,
            };
            if n.kind == "Turbulence" {
                shaders::turbulence(frequency, octaves, seed, tile)
            } else {
                shaders::fractal_noise(frequency, octaves, seed, tile)
            }
        }
        "ImageShader" => image_shader(ctx, n)?,
        "Shader" => runtime_shader(ctx, n)?,
        "Blend" => {
            let mode = enums::blend_mode(
                n.props
                    .str("mode")
                    .ok_or_else(|| Error("Blend needs a mode".into()))?,
            )?;
            let all = std::mem::take(&mut ctx.shaders);
            match compose(all, |dst, src| Some(shaders::blend(mode, dst, src))) {
                Some(shader) => {
                    ctx.shaders.push(shader);
                    return Ok(());
                }
                None => return Ok(()),
            }
        }
        other => return err(format!("unknown shader {other}")),
    };
    ctx.shaders
        .push(shader.ok_or_else(|| Error(format!("{} could not be made from its props", n.kind)))?);
    Ok(())
}

fn image_shader(ctx: &mut Ctx, n: Node) -> Result<Option<Shader>, Error> {
    let Some(source) = n.props.get("image") else {
        return Ok(None);
    };
    let image = crate::draw::image_of(ctx, source)?;
    let mut matrix = Matrix::new_identity();
    if let Some(rect) = n.props.rect()? {
        let fit = n.props.str("fit").unwrap_or("fill");
        let (src, dst) = crate::draw::fit_rects(
            fit,
            skia_safe::Rect::from_wh(image.width() as f32, image.height() as f32),
            rect,
        );
        let sx = dst.width() / src.width();
        let sy = dst.height() / src.height();
        matrix.pre_translate((dst.left - src.left * sx, dst.top - src.top * sy));
        matrix.pre_scale((sx, sy), None);
    }
    if let Some(m) = transform_of(n.props)? {
        matrix.pre_concat(&m);
    }
    let tx = enums::tile_mode(n.props.str("tx").unwrap_or("decal"))?;
    let ty = enums::tile_mode(n.props.str("ty").unwrap_or("decal"))?;
    let sampling = crate::draw::sampling_of(n.props)?;
    Ok(image.to_shader((tx, ty), sampling, &matrix))
}

// ---- runtime effects (SkSL) ----

fn effect_source<'a>(n: Node<'a>) -> Result<&'a str, Error> {
    n.props
        .props("source")
        .and_then(|s| s.str("sksl"))
        .ok_or_else(|| {
            Error(format!(
                "{} needs a source made by Skia.RuntimeEffect.Make",
                n.kind
            ))
        })
}

fn runtime_shader(ctx: &mut Ctx, n: Node) -> Result<Option<Shader>, Error> {
    let effect = ctx.assets.effect(effect_source(n)?)?;
    let uniforms = pack_uniforms(&effect, n.props.props("uniforms"))?;
    // The children shaders were pushed just before this one, in the order the effect names its children.
    let wanted = effect.children().len();
    let at = ctx.shaders.len().saturating_sub(wanted);
    let children: Vec<ChildPtr> = ctx
        .shaders
        .split_off(at)
        .into_iter()
        .map(ChildPtr::from)
        .collect();
    if children.len() != wanted {
        return err(format!(
            "the effect has {wanted} child shaders ({}) and got {}",
            effect
                .children()
                .iter()
                .map(|c| c.name())
                .collect::<Vec<_>>()
                .join(", "),
            children.len()
        ));
    }
    let matrix = local_matrix(n.props)?;
    Ok(effect.make_shader(uniforms, &children, Some(&matrix)))
}

/// The bytes of an effect's uniforms from `{ name: number | [numbers] }`.
pub fn pack_uniforms(effect: &RuntimeEffect, values: Option<Props>) -> Result<Data, Error> {
    let mut bytes = vec![0u8; effect.uniform_size()];
    for u in effect.uniforms() {
        let given = values.and_then(|v| v.get(u.name()));
        let Some(given) = given else {
            return err(format!("the uniform {} is not given", u.name()));
        };
        let numbers: Vec<f64> = match given {
            serde_json::Value::Array(a) => {
                // Matrices and arrays of vectors may arrive nested.
                let mut flat = Vec::new();
                for item in a {
                    match item {
                        serde_json::Value::Array(inner) => {
                            flat.extend(inner.iter().filter_map(serde_json::Value::as_f64))
                        }
                        other => flat.extend(other.as_f64()),
                    }
                }
                flat
            }
            serde_json::Value::Bool(b) => vec![f64::from(*b)],
            other => other.as_f64().map(|n| vec![n]).ok_or_else(|| {
                Error(format!(
                    "the uniform {} must be a number or a list of numbers",
                    u.name()
                ))
            })?,
        };
        let per = match u.ty() {
            uniform::Type::Float | uniform::Type::Int => 1,
            uniform::Type::Float2 | uniform::Type::Int2 => 2,
            uniform::Type::Float3 | uniform::Type::Int3 => 3,
            uniform::Type::Float4 | uniform::Type::Int4 | uniform::Type::Float2x2 => 4,
            uniform::Type::Float3x3 => 9,
            uniform::Type::Float4x4 => 16,
        };
        let wanted = per * u.count().max(1) as usize;
        if numbers.len() != wanted {
            return err(format!(
                "the uniform {} takes {wanted} numbers, got {}",
                u.name(),
                numbers.len()
            ));
        }
        let integer = matches!(
            u.ty(),
            uniform::Type::Int | uniform::Type::Int2 | uniform::Type::Int3 | uniform::Type::Int4
        );
        for (i, number) in numbers.iter().enumerate() {
            let at = u.offset() + i * 4;
            let word = if integer {
                (*number as i32).to_ne_bytes()
            } else {
                (*number as f32).to_ne_bytes()
            };
            bytes[at..at + 4].copy_from_slice(&word);
        }
    }
    Ok(Data::new_copy(&bytes))
}

/// What `Skia.RuntimeEffect.Make` tells a project about its source.
pub struct EffectInfo {
    pub uniforms: Vec<(String, usize)>,
    pub children: Vec<String>,
}

/// Compiles SkSL; the error is Skia's own message.
pub fn compile_effect(sksl: &str) -> Result<EffectInfo, Error> {
    let effect = RuntimeEffect::make_for_shader(sksl, None).map_err(Error)?;
    Ok(EffectInfo {
        uniforms: effect
            .uniforms()
            .iter()
            .map(|u| (u.name().to_string(), u.size_in_bytes() / 4))
            .collect(),
        children: effect
            .children()
            .iter()
            .map(|c| c.name().to_string())
            .collect(),
    })
}

// ---- colour filters ----

pub fn color_filters(ctx: &mut Ctx, nodes: &[Node]) -> Result<(), Error> {
    for n in nodes {
        let children = children_of(n, crate::render::is_color_filter)?;
        color_filters(ctx, &children)?;
        let filter: Option<ColorFilter> = match n.kind {
            "BlendColorFilter" => {
                let color = n
                    .props
                    .color("color")?
                    .ok_or_else(|| Error("BlendColorFilter needs a color".into()))?;
                let mode = enums::blend_mode(n.props.str("mode").unwrap_or("srcOver"))?;
                color_filters::blend(color.to_color(), mode)
            }
            "MatrixColorFilter" => {
                let m = n
                    .props
                    .f32s("matrix")?
                    .ok_or_else(|| Error("ColorMatrix needs a matrix".into()))?;
                let m: [f32; 20] = m
                    .try_into()
                    .map_err(|_| Error("a colour matrix is 20 numbers".into()))?;
                Some(color_filters::matrix_row_major(&m, None))
            }
            "LerpColorFilter" => {
                let second = ctx.color_filters.pop();
                let first = ctx.color_filters.pop();
                match (first, second) {
                    (Some(first), Some(second)) => {
                        color_filters::lerp(number(*n, "t")?, first, second)
                    }
                    _ => return err("LerpColorFilter needs two colour filters"),
                }
            }
            "LumaColorFilter" => Some(luma_color_filter::new()),
            "LinearToSRGBGammaColorFilter" => Some(color_filters::linear_to_srgb_gamma()),
            "SRGBToLinearGammaColorFilter" => Some(color_filters::srgb_to_linear_gamma()),
            other => return err(format!("unknown colour filter {other}")),
        };
        ctx.color_filters.push(
            filter.ok_or_else(|| Error(format!("{} could not be made from its props", n.kind)))?,
        );
        if n.kind != "LerpColorFilter" && !children.is_empty() && ctx.color_filters.len() > 1 {
            let outer = ctx.color_filters.pop().expect("two");
            let inner = ctx.color_filters.pop().expect("two");
            ctx.color_filters.push(
                color_filters::compose(outer, inner)
                    .ok_or_else(|| Error("colour filters could not be composed".into()))?,
            );
        }
    }
    Ok(())
}

// ---- image filters ----

pub fn image_filters(ctx: &mut Ctx, nodes: &[Node]) -> Result<(), Error> {
    for n in nodes {
        // Children that are image filters or shaders come first (a displacement map's shader).
        let children = children_of(n, |k| is_image_filter(k) || is_shader(k) || k == "Blend")?;
        for child in &children {
            if is_shader(child.kind) {
                shaders(ctx, std::slice::from_ref(child))?;
            } else {
                image_filters(ctx, std::slice::from_ref(child))?;
            }
        }
        declare_image_filter(ctx, *n)?;
        if n.kind != "BlendImageFilter" && !children.is_empty() && ctx.image_filters.len() > 1 {
            let outer = ctx.image_filters.pop().expect("two");
            let inner = ctx.image_filters.pop().expect("two");
            ctx.image_filters.push(
                image_filters::compose(outer, inner)
                    .ok_or_else(|| Error("image filters could not be composed".into()))?,
            );
        }
    }
    Ok(())
}

fn declare_image_filter(ctx: &mut Ctx, n: Node) -> Result<(), Error> {
    let filter: Option<ImageFilter> = match n.kind {
        "BlurImageFilter" => {
            let sigma = n
                .props
                .radius("blur")?
                .ok_or_else(|| Error("Blur needs a blur".into()))?;
            let mode = enums::tile_mode(n.props.str("mode").unwrap_or("decal"))?;
            image_filters::blur((sigma.x, sigma.y), mode, None, None)
        }
        "MorphologyImageFilter" => {
            let r = n
                .props
                .radius("radius")?
                .ok_or_else(|| Error("Morphology needs a radius".into()))?;
            match n.props.str("operator") {
                Some("erode") => image_filters::erode((r.x, r.y), None, None),
                _ => image_filters::dilate((r.x, r.y), None, None),
            }
        }
        "OffsetImageFilter" => {
            image_filters::offset(Vector::new(number(n, "x")?, number(n, "y")?), None, None)
        }
        "DropShadowImageFilter" => {
            let color = n
                .props
                .color("color")?
                .ok_or_else(|| Error("Shadow needs a color".into()))?;
            let (dx, dy, blur) = (number(n, "dx")?, number(n, "dy")?, number(n, "blur")?);
            let shadow_only = n.props.bool("shadowOnly") == Some(true);
            if n.props.bool("inner") == Some(true) {
                inner_shadow(dx, dy, blur, color, shadow_only)
            } else if shadow_only {
                image_filters::drop_shadow_only(
                    Vector::new(dx, dy),
                    (blur, blur),
                    color,
                    None,
                    None,
                    None,
                )
            } else {
                image_filters::drop_shadow(
                    Vector::new(dx, dy),
                    (blur, blur),
                    color,
                    None,
                    None,
                    None,
                )
            }
        }
        "BlendImageFilter" => {
            let mode = enums::blend_mode(
                n.props
                    .str("mode")
                    .ok_or_else(|| Error("Blend needs a mode".into()))?,
            )?;
            let all = std::mem::take(&mut ctx.image_filters);
            match compose(all, |background, foreground| {
                image_filters::blend(mode, background, foreground, None)
            }) {
                Some(filter) => {
                    ctx.image_filters.push(filter);
                    return Ok(());
                }
                None => return Ok(()),
            }
        }
        "DisplacementMapImageFilter" => {
            let shader = ctx
                .shaders
                .pop()
                .ok_or_else(|| Error("DisplacementMap expects a shader as child".into()))?;
            let map = image_filters::shader(shader, None);
            let channel = |key: &str| -> Result<ColorChannel, Error> {
                Ok(match n.props.str(key).unwrap_or("r") {
                    "r" => ColorChannel::R,
                    "g" => ColorChannel::G,
                    "b" => ColorChannel::B,
                    "a" => ColorChannel::A,
                    other => return err(format!("unknown colour channel {other:?}")),
                })
            };
            image_filters::displacement_map(
                (channel("channelX")?, channel("channelY")?),
                number(n, "scale")?,
                map,
                None,
                None,
            )
        }
        "RuntimeShaderImageFilter" => {
            let effect = ctx.assets.effect(effect_source(n)?)?;
            let mut builder = skia_safe::runtime_effect::RuntimeShaderBuilder::new(effect.clone());
            set_builder_uniforms(&effect, &mut builder, n.props.props("uniforms"))?;
            image_filters::runtime_shader(&builder, "", None)
        }
        "ShaderImageFilter" => {
            let shader = ctx
                .shaders
                .pop()
                .ok_or_else(|| Error("an image filter of a shader needs the shader".into()))?;
            image_filters::shader(shader, None)
        }
        "ColorFilterImageFilter" => {
            let before = ctx.color_filters.len();
            color_filters(ctx, &children_of(&n, crate::render::is_color_filter)?)?;
            let made = ctx
                .color_filters
                .split_off(before.min(ctx.color_filters.len()));
            let filter = compose(made, color_filters::compose).ok_or_else(|| {
                Error("an image filter of a colour filter needs the colour filter".into())
            })?;
            image_filters::color_filter(filter, None, None)
        }
        other => return err(format!("unknown image filter {other}")),
    };
    ctx.image_filters
        .push(filter.ok_or_else(|| Error(format!("{} could not be made from its props", n.kind)))?);
    Ok(())
}

fn set_builder_uniforms(
    effect: &RuntimeEffect,
    builder: &mut skia_safe::runtime_effect::RuntimeShaderBuilder,
    values: Option<Props>,
) -> Result<(), Error> {
    let packed = pack_uniforms(effect, values)?;
    let bytes = packed.as_bytes();
    for u in effect.uniforms() {
        let slice = &bytes[u.offset()..u.offset() + u.size_in_bytes()];
        let result = if matches!(
            u.ty(),
            uniform::Type::Int | uniform::Type::Int2 | uniform::Type::Int3 | uniform::Type::Int4
        ) {
            let ints: Vec<i32> = slice
                .as_chunks::<4>()
                .0
                .iter()
                .map(|c| i32::from_ne_bytes(*c))
                .collect();
            builder.set_uniform_int(u.name(), &ints)
        } else {
            let floats: Vec<f32> = slice
                .as_chunks::<4>()
                .0
                .iter()
                .map(|c| f32::from_ne_bytes(*c))
                .collect();
            builder.set_uniform_float(u.name(), &floats)
        };
        result.map_err(|e| Error(format!("uniform {}: {e}", u.name())))?;
    }
    Ok(())
}

/// RN-Skia's inner shadow: the shadow of what is outside the shape, cut to the shape.
fn inner_shadow(
    dx: f32,
    dy: f32,
    blur: f32,
    color: Color4f,
    shadow_only: bool,
) -> Option<ImageFilter> {
    let black = Color4f::new(0.0, 0.0, 0.0, 1.0);
    let filter = |c: Color4f, mode: BlendMode| {
        image_filters::color_filter(color_filters::blend(c.to_color(), mode)?, None, None)
    };
    let source_graphic = filter(black, BlendMode::Dst)?;
    let source_alpha = filter(black, BlendMode::SrcIn)?;
    let outside = filter(color, BlendMode::SrcOut)?;
    let moved = image_filters::offset(Vector::new(dx, dy), outside, None)?;
    let blurred = image_filters::blur((blur, blur), TileMode::Decal, moved, None)?;
    let clipped = image_filters::blend(BlendMode::SrcIn, source_alpha, blurred, None)?;
    if shadow_only {
        return Some(clipped);
    }
    image_filters::blend(BlendMode::SrcOver, source_graphic, clipped, None)
}

// ---- mask filter ----

pub fn mask_filter(props: Props) -> Result<MaskFilter, Error> {
    let blur = props
        .f32("blur")?
        .ok_or_else(|| Error("BlurMask needs a blur".into()))?;
    let style = enums::blur_style(props.str("style").unwrap_or("normal"))?;
    let respect = props.bool("respectCTM").unwrap_or(true);
    MaskFilter::blur(style, blur, respect)
        .ok_or_else(|| Error("the blur mask filter could not be made".into()))
}

// ---- path effects ----

pub fn path_effects(ctx: &mut Ctx, nodes: &[Node]) -> Result<(), Error> {
    for n in nodes {
        let children = children_of(n, crate::render::is_path_effect)?;
        path_effects(ctx, &children)?;
        let effect: Option<PathEffect> = match n.kind {
            "DashPathEffect" => {
                let intervals = n
                    .props
                    .f32s("intervals")?
                    .ok_or_else(|| Error("DashPathEffect needs intervals".into()))?;
                PathEffect::dash(&intervals, n.props.f32_or("phase", 0.0)?)
            }
            "CornerPathEffect" => PathEffect::corner_path(number(*n, "r")?),
            "DiscretePathEffect" => PathEffect::discrete(
                number(*n, "length")?,
                number(*n, "deviation")?,
                Some(number(*n, "seed")? as u32),
            ),
            "Line2DPathEffect" => {
                let matrix = n
                    .props
                    .matrix("matrix")?
                    .ok_or_else(|| Error("Line2DPathEffect needs a matrix".into()))?;
                PathEffect::line_2d(number(*n, "width")?, &matrix)
            }
            "Path2DPathEffect" => {
                let matrix = n
                    .props
                    .matrix("matrix")?
                    .ok_or_else(|| Error("Path2DPathEffect needs a matrix".into()))?;
                let path = n
                    .props
                    .path("path")?
                    .ok_or_else(|| Error("Path2DPathEffect needs a path".into()))?;
                Some(PathEffect::path_2d(&matrix, &path))
            }
            "Path1DPathEffect" => {
                let path = n
                    .props
                    .path("path")?
                    .ok_or_else(|| Error("Path1DPathEffect needs a path".into()))?;
                let style = match n.props.str("style").unwrap_or("translate") {
                    "rotate" => skia_safe::path_1d_path_effect::Style::Rotate,
                    "morph" => skia_safe::path_1d_path_effect::Style::Morph,
                    _ => skia_safe::path_1d_path_effect::Style::Translate,
                };
                PathEffect::path_1d(
                    &path,
                    number(*n, "advance")?,
                    n.props.f32_or("phase", 0.0)?,
                    style,
                )
            }
            "SumPathEffect" => {
                let all = std::mem::take(&mut ctx.path_effects);
                match compose(all, |first, second| Some(PathEffect::sum(first, second))) {
                    Some(effect) => {
                        ctx.path_effects.push(effect);
                        continue;
                    }
                    None => continue,
                }
            }
            other => return err(format!("unknown path effect {other}")),
        };
        ctx.path_effects.push(
            effect.ok_or_else(|| Error(format!("{} could not be made from its props", n.kind)))?,
        );
        if n.kind != "SumPathEffect" && !children.is_empty() && ctx.path_effects.len() > 1 {
            let outer = ctx.path_effects.pop().expect("two");
            let inner = ctx.path_effects.pop().expect("two");
            ctx.path_effects.push(PathEffect::compose(outer, inner));
        }
    }
    Ok(())
}
