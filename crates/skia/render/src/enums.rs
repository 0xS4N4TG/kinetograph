//! RN-Skia's string enums (`blendMode="srcOver"`, `mode="clamp"`, ...).

use skia_safe::{BlendMode, BlurStyle, PaintCap, PaintJoin, PaintStyle, TileMode};

use crate::Error;

fn unknown<T>(what: &str, name: &str) -> Result<T, Error> {
    Err(Error(format!("unknown {what} {name:?}")))
}

pub fn blend_mode(name: &str) -> Result<BlendMode, Error> {
    use BlendMode::*;
    Ok(match name {
        "clear" => Clear,
        "src" => Src,
        "dst" => Dst,
        "srcOver" => SrcOver,
        "dstOver" => DstOver,
        "srcIn" => SrcIn,
        "dstIn" => DstIn,
        "srcOut" => SrcOut,
        "dstOut" => DstOut,
        "srcATop" => SrcATop,
        "dstATop" => DstATop,
        "xor" => Xor,
        "plus" => Plus,
        "modulate" => Modulate,
        "screen" => Screen,
        "overlay" => Overlay,
        "darken" => Darken,
        "lighten" => Lighten,
        "colorDodge" => ColorDodge,
        "colorBurn" => ColorBurn,
        "hardLight" => HardLight,
        "softLight" => SoftLight,
        "difference" => Difference,
        "exclusion" => Exclusion,
        "multiply" => Multiply,
        "hue" => Hue,
        "saturation" => Saturation,
        "color" => Color,
        "luminosity" => Luminosity,
        _ => return unknown("blend mode", name),
    })
}

pub fn tile_mode(name: &str) -> Result<TileMode, Error> {
    Ok(match name {
        "clamp" => TileMode::Clamp,
        "repeat" => TileMode::Repeat,
        "mirror" => TileMode::Mirror,
        "decal" => TileMode::Decal,
        _ => return unknown("tile mode", name),
    })
}

pub fn paint_style(name: &str) -> Result<PaintStyle, Error> {
    Ok(match name {
        "fill" => PaintStyle::Fill,
        "stroke" => PaintStyle::Stroke,
        _ => return unknown("paint style", name),
    })
}

pub fn paint_cap(name: &str) -> Result<PaintCap, Error> {
    Ok(match name {
        "butt" => PaintCap::Butt,
        "round" => PaintCap::Round,
        "square" => PaintCap::Square,
        _ => return unknown("stroke cap", name),
    })
}

pub fn paint_join(name: &str) -> Result<PaintJoin, Error> {
    Ok(match name {
        "miter" => PaintJoin::Miter,
        "round" => PaintJoin::Round,
        "bevel" => PaintJoin::Bevel,
        _ => return unknown("stroke join", name),
    })
}

pub fn blur_style(name: &str) -> Result<BlurStyle, Error> {
    Ok(match name {
        "normal" => BlurStyle::Normal,
        "solid" => BlurStyle::Solid,
        "outer" => BlurStyle::Outer,
        "inner" => BlurStyle::Inner,
        _ => return unknown("blur style", name),
    })
}
