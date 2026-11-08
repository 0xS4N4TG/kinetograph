//! A scene evaluated at one frame: every animated number is a plain value.

use std::collections::HashMap;
use std::sync::Arc;

use kurbo::{Affine, BezPath, Rect, Shape};

use crate::anim::Num;
use crate::canvas::CanvasOp;
use crate::color::{Color, ColorMatrix};
use crate::error::{Error, Result};
use crate::datamosh::{ResolvedHold, ResolvedMosh};
use crate::scene::{
    AlignContent, Datamosh, Hold, AlignItems, AlignSelf, BlendMode, Channel, Clip, DitherMode, DotOrder, DotShape,
    Effect, Extend, FillRule, Fit, FlexBasis, FlexDirection, FlexWrap, Geometry, GlyphRun,
    Gradient, GradientGeometry, HalftoneShape, ImageLayer, JustifyContent, Layer, LayerKind,
    Layout, LayoutItem, LutInterpolation, MAX_DITHER_LEVELS, MAX_SHADOW_SIZE, MIN_DITHER_LEVELS, MaskMode, MatteMode,
    NoiseChannels, Paint, Position, SampleChange, Sampling, Scene, Shadow, ShapeLayer, Spacing, Stop,
    StrokeCap, StrokeJoin, TextAlign, TextPaintOrder, Transform, Turbulence, TurbulenceKind, Units, changes_by_id,
};
use crate::text::TextEngine;
use crate::turbulence::MAX_OCTAVES;
use crate::video::{Clip as VideoClip, MediaTime, VideoInfo};
use crate::warp;

mod eval;
mod types;

pub use types::*;
pub(crate) use eval::{Resolver, resolve_effects, resolve_gradient};
