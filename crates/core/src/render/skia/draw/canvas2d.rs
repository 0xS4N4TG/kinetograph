//! Canvas 2D commands (`crate::canvas`) drawn with Skia, onto the same canvas the other layers go to. The Vello path in
//! `canvas.rs` stays what it was; this draws the same recorded commands: fills, strokes (caps, joins, dashes), text as
//! glyph outlines, `drawImage`, gradients, patterns (also for strokes and text), the composite operations, clips,
//! shadows and `filter` lists (as image filters of a layer).

use super::*;
use crate::canvas::{
    CanvasBlend, CanvasCap, CanvasJoin, CanvasOp, CanvasPaint, CanvasSource, CanvasTextAlign, CanvasBaseline, DrawState,
    FillOp, FilterFn, ImageOp, LineStyle, StrokeOp, TextOp,
};
use skia_safe::path_utils::fill_path_with_paint;

fn sk_composite(b: CanvasBlend) -> SkBlend {
    match b {
        CanvasBlend::SourceOver => SkBlend::SrcOver,
        CanvasBlend::SourceIn => SkBlend::SrcIn,
        CanvasBlend::SourceOut => SkBlend::SrcOut,
        CanvasBlend::SourceAtop => SkBlend::SrcATop,
        CanvasBlend::DestinationOver => SkBlend::DstOver,
        CanvasBlend::DestinationIn => SkBlend::DstIn,
        CanvasBlend::DestinationOut => SkBlend::DstOut,
        CanvasBlend::DestinationAtop => SkBlend::DstATop,
        CanvasBlend::Lighter => SkBlend::Plus,
        CanvasBlend::Copy => SkBlend::Src,
        CanvasBlend::Xor => SkBlend::Xor,
        CanvasBlend::Multiply => SkBlend::Multiply,
        CanvasBlend::Screen => SkBlend::Screen,
        CanvasBlend::Overlay => SkBlend::Overlay,
        CanvasBlend::Darken => SkBlend::Darken,
        CanvasBlend::Lighten => SkBlend::Lighten,
        CanvasBlend::ColorDodge => SkBlend::ColorDodge,
        CanvasBlend::ColorBurn => SkBlend::ColorBurn,
        CanvasBlend::HardLight => SkBlend::HardLight,
        CanvasBlend::SoftLight => SkBlend::SoftLight,
        CanvasBlend::Difference => SkBlend::Difference,
        CanvasBlend::Exclusion => SkBlend::Exclusion,
        CanvasBlend::Hue => SkBlend::Hue,
        CanvasBlend::Saturation => SkBlend::Saturation,
        CanvasBlend::Color => SkBlend::Color,
        CanvasBlend::Luminosity => SkBlend::Luminosity,
        CanvasBlend::Clear => SkBlend::Clear,
    }
}

fn state_of(op: &CanvasOp) -> Option<&DrawState> {
    op.state()
}

/// Whether any command changes pixels by a composite operation: the canvas is then drawn in a layer of its own, so the
/// operation sees the canvas's pixels and not the page behind it.
fn uses_composite(ops: &[CanvasOp]) -> bool {
    ops.iter().any(|op| state_of(op).is_some_and(|s| s.blend != CanvasBlend::SourceOver))
}

fn stroke_style(p: &mut Paint, l: &LineStyle) {
    p.set_style(PaintStyle::Stroke);
    p.set_stroke_width(l.width as f32);
    p.set_stroke_cap(match l.cap {
        CanvasCap::Butt => PaintCap::Butt,
        CanvasCap::Round => PaintCap::Round,
        CanvasCap::Square => PaintCap::Square,
    });
    p.set_stroke_join(match l.join {
        CanvasJoin::Miter => PaintJoin::Miter,
        CanvasJoin::Round => PaintJoin::Round,
        CanvasJoin::Bevel => PaintJoin::Bevel,
    });
    p.set_stroke_miter(l.miter_limit as f32);
    if !l.dash.is_empty() {
        let mut d: Vec<f32> = l.dash.iter().map(|v| *v as f32).collect();
        if d.len() % 2 == 1 {
            let c = d.clone();
            d.extend(c);
        }
        p.set_path_effect(PathEffect::dash(&d, l.dash_offset as f32));
    }
}

impl Translator {
    /// Draws a canvas layer's commands in the box `(0, 0, width, height)` of the current space.
    pub(super) fn draw_canvas_layer(&mut self, canvas: &Canvas, size: (f64, f64), ops: &[CanvasOp]) {
        let isolate = uses_composite(ops);
        if isolate {
            let b = Rect::new(0.0, 0.0, size.0 as f32, size.1 as f32);
            self.save_layer(canvas, Some(b), &Paint::default(), None);
        }
        self.canvas_ops(canvas, size, ops);
        if isolate {
            canvas.restore();
        }
    }

    /// Another canvas drawn into this one (a pattern tile, `drawImage` of a canvas): as a whole, with `alpha`.
    fn canvas_nested(&mut self, canvas: &Canvas, size: (f64, f64), ops: &[CanvasOp], alpha: f32, blend: SkBlend) {
        let layer = alpha < 1.0 || blend != SkBlend::SrcOver || uses_composite(ops);
        if layer {
            let mut p = Paint::default();
            p.set_alpha_f(alpha);
            p.set_blend_mode(blend);
            let b = Rect::new(0.0, 0.0, size.0 as f32, size.1 as f32);
            self.save_layer(canvas, Some(b), &p, None);
        }
        self.canvas_ops(canvas, size, ops);
        if layer {
            canvas.restore();
        }
    }

    fn canvas_ops(&mut self, canvas: &Canvas, size: (f64, f64), ops: &[CanvasOp]) {
        canvas.save();
        canvas.clip_rect(Rect::new(0.0, 0.0, size.0 as f32, size.1 as f32), ClipOp::Intersect, true);
        let mut open = 0_usize;
        for op in ops {
            match op {
                CanvasOp::Clip(c) => {
                    canvas.save();
                    open += 1;
                    match self.svg_path(&c.path, c.rule == crate::canvas::CanvasRule::EvenOdd) {
                        Some(path) => {
                            let moved = path.make_transform(&mat(Affine::new(c.m)));
                            canvas.clip_path(&moved, ClipOp::Intersect, true);
                        }
                        None => {
                            canvas.clip_rect(Rect::new(0.0, 0.0, 0.0, 0.0), ClipOp::Intersect, false);
                        }
                    }
                }
                CanvasOp::Unclip => {
                    if open > 0 {
                        canvas.restore();
                        open -= 1;
                    }
                }
                _ => {
                    let state = state_of(op).expect("a command that is not a clip has a state");
                    self.canvas_command(canvas, size, op, state);
                }
            }
        }
        for _ in 0..open {
            canvas.restore();
        }
        canvas.restore();
    }

    /// One drawing command, with its composite operation, shadow and filter.
    fn canvas_command(&mut self, canvas: &Canvas, size: (f64, f64), op: &CanvasOp, state: &DrawState) {
        let whole = state.blend.reaches_whole_canvas();
        if whole {
            // `source-in` and the like change pixels the shape does not cover: applied over the whole canvas.
            let mut p = Paint::default();
            p.set_blend_mode(sk_composite(state.blend));
            let b = Rect::new(0.0, 0.0, size.0 as f32, size.1 as f32);
            self.save_layer(canvas, Some(b), &p, None);
        }
        let blend = if whole { SkBlend::SrcOver } else { sk_composite(state.blend) };
        let comp = Comp { alpha: state.a, blend };
        if state.has_effects() {
            self.canvas_with_effects(canvas, size, op, state, comp);
        } else {
            self.canvas_emit(canvas, size, op, state, comp);
        }
        if whole {
            canvas.restore();
        }
    }

    /// The shadow first (the shape's filtered picture blurred, moved and tinted), then the shape; each takes the
    /// command's alpha and composite operation, as the canvas does.
    fn canvas_with_effects(&mut self, canvas: &Canvas, size: (f64, f64), op: &CanvasOp, state: &DrawState, comp: Comp) {
        let b = Rect::new(0.0, 0.0, size.0 as f32, size.1 as f32);
        let filter = self.canvas_filter(&state.filter);
        if let Some(sh) = &state.shadow {
            let sg = (sh.blur / 2.0).clamp(0.0, crate::scene::MAX_SHADOW_SIZE) as f32;
            let f = image_filters::drop_shadow_only((sh.x as f32, sh.y as f32), (sg, sg), color4(sh.color), None, filter.clone(), None);
            let mut p = Paint::default();
            p.set_alpha_f(comp.alpha);
            p.set_blend_mode(comp.blend);
            p.set_image_filter(f);
            self.save_layer(canvas, Some(b), &p, None);
            self.canvas_emit(canvas, size, op, state, Comp { alpha: 1.0, blend: SkBlend::SrcOver });
            canvas.restore();
        }
        if filter.is_none() {
            self.canvas_emit(canvas, size, op, state, comp);
        } else {
            let mut p = Paint::default();
            p.set_alpha_f(comp.alpha);
            p.set_blend_mode(comp.blend);
            p.set_image_filter(filter);
            self.save_layer(canvas, Some(b), &p, None);
            self.canvas_emit(canvas, size, op, state, Comp { alpha: 1.0, blend: SkBlend::SrcOver });
            canvas.restore();
        }
    }

    /// A `filter` list as one image filter, in the pixels of the space the canvas is drawn in.
    fn canvas_filter(&mut self, filter: &[FilterFn]) -> Option<ImageFilter> {
        let mut out: Option<ImageFilter> = None;
        for e in crate::canvas::filter_effects(filter, Affine::IDENTITY) {
            match e {
                ResolvedEffect::Blur { radius } => {
                    if radius > 0.0 {
                        out = image_filters::blur((radius, radius), TileMode::Decal, out.take(), None);
                    }
                }
                ResolvedEffect::ColorMatrix(cm) => {
                    let m = &cm.0;
                    let f = color_filters::matrix_row_major(
                        &[
                            m[0][0] as f32, m[0][1] as f32, m[0][2] as f32, m[0][3] as f32, m[0][4] as f32,
                            m[1][0] as f32, m[1][1] as f32, m[1][2] as f32, m[1][3] as f32, m[1][4] as f32,
                            m[2][0] as f32, m[2][1] as f32, m[2][2] as f32, m[2][3] as f32, m[2][4] as f32,
                            m[3][0] as f32, m[3][1] as f32, m[3][2] as f32, m[3][3] as f32, m[3][4] as f32,
                        ],
                        None,
                    );
                    out = image_filters::color_filter(f, out.take(), None);
                }
                ResolvedEffect::DropShadow(sh) => {
                    let input = out.take();
                    let shadow = image_filters::drop_shadow_only((sh.x, sh.y), (sh.blur, sh.blur), color4(sh.color), None, input.clone(), None);
                    out = image_filters::merge([shadow, input], None);
                }
                other => self.stats.no(&format!("canvas filter {}", effect_name(&other))),
            }
        }
        out
    }

    /// Draws the command's shape, text or picture with `comp`, in the space of its matrix.
    fn canvas_emit(&mut self, canvas: &Canvas, size: (f64, f64), op: &CanvasOp, state: &DrawState, comp: Comp) {
        canvas.save();
        canvas.concat(&mat(Affine::new(state.m)));
        match op {
            CanvasOp::Fill(FillOp { path, rule, paint, .. }) => {
                if let Some(p) = self.svg_path(path, *rule == crate::canvas::CanvasRule::EvenOdd) {
                    self.canvas_paint_path(canvas, &p, None, paint, comp);
                }
            }
            CanvasOp::Stroke(StrokeOp { path, paint, line, .. }) => {
                if let Some(p) = self.svg_path(path, false) {
                    self.canvas_paint_path(canvas, &p, Some(line), paint, comp);
                }
            }
            CanvasOp::Text(t) => self.canvas_text(canvas, t, comp),
            CanvasOp::Image(i) => self.canvas_image(canvas, i, comp),
            CanvasOp::Clip(_) | CanvasOp::Unclip => {}
        }
        let _ = size;
        canvas.restore();
    }

    /// Fills `path`, or strokes it with `line`, in `paint`.
    fn canvas_paint_path(&mut self, canvas: &Canvas, path: &Path, line: Option<&LineStyle>, paint: &CanvasPaint, comp: Comp) {
        let mut p = Self::base_paint(comp);
        if let Some(l) = line {
            stroke_style(&mut p, l);
        }
        if let CanvasPaint::Pattern { source: CanvasSource::Canvas { width, height, commands }, repeat_x, repeat_y, m } = paint {
            self.canvas_tiles(canvas, path, &p, line.is_some(), (*width, *height), commands, (*repeat_x, *repeat_y), m.map_or(Affine::IDENTITY, Affine::new), comp);
            return;
        }
        if !self.canvas_ink(&mut p, paint) {
            return;
        }
        canvas.draw_path(path, &p);
        self.stats.draws += 1;
    }

    /// Sets the colour or shader of `p` for `paint`; false when nothing is to be drawn.
    fn canvas_ink(&mut self, p: &mut Paint, paint: &CanvasPaint) -> bool {
        let gradient = |geometry: ResolvedGradientGeometry, stops: &[(f64, crate::color::Color)]| -> Option<Shader> {
            if stops.is_empty() {
                return None;
            }
            let g = ResolvedGradient { geometry, stops: stops.to_vec(), extend: Extend::Pad, units: Units::User, transform: Affine::IDENTITY };
            gradient_shader_for(&g, None)
        };
        let shader = match paint {
            CanvasPaint::Color { color } => {
                let c = color4(*color);
                let a = p.alpha_f();
                p.set_color4f(Color4f::new(c.r, c.g, c.b, c.a * a), None);
                return true;
            }
            CanvasPaint::Linear { x0, y0, x1, y1, stops } => {
                gradient(ResolvedGradientGeometry::Linear { x0: *x0, y0: *y0, x1: *x1, y1: *y1 }, stops)
            }
            CanvasPaint::Radial { x0, y0, r0, x1, y1, r1, stops } => gradient(
                ResolvedGradientGeometry::FocalRadial { cx: *x1, cy: *y1, r: *r1, fx: *x0, fy: *y0, fr: *r0 },
                stops,
            ),
            // The scene's conic angle runs from 12 o'clock, the canvas's from 3.
            CanvasPaint::Conic { x, y, angle, stops } => {
                gradient(ResolvedGradientGeometry::Conic { cx: *x, cy: *y, angle: angle.to_degrees() + 90.0 }, stops)
            }
            CanvasPaint::Pattern { source, repeat_x, repeat_y, m } => {
                let img = self.canvas_picture(source);
                img.map(|img| {
                    // Outside a pattern that does not repeat the canvas draws nothing.
                    let tile = |r: bool| if r { TileMode::Repeat } else { TileMode::Decal };
                    let local = mat(m.map_or(Affine::IDENTITY, Affine::new));
                    img.to_shader(
                        (tile(*repeat_x), tile(*repeat_y)),
                        SamplingOptions::new(skia_safe::FilterMode::Linear, skia_safe::MipmapMode::None),
                        &local,
                    )
                })
                .flatten()
            }
        };
        match shader {
            Some(s) => {
                p.set_shader(s);
                true
            }
            None => false,
        }
    }

    /// The pixels behind a picture source (a canvas is drawn, not sampled).
    fn canvas_picture(&mut self, source: &CanvasSource) -> Option<Image> {
        match source {
            CanvasSource::Src { src } => self.image(src),
            CanvasSource::Pixels { width, height, data } => {
                use std::hash::{Hash, Hasher};
                let mut h = std::collections::hash_map::DefaultHasher::new();
                data.hash(&mut h);
                let key = format!("pixels:{width}x{height}:{:x}", h.finish());
                if let Some(i) = self.images.get(&key) {
                    return i.clone();
                }
                let img = crate::canvas::pixels(*width, *height, data).ok().and_then(|d| {
                    let info = skia_safe::ImageInfo::new(
                        (*width as i32, *height as i32),
                        skia_safe::ColorType::RGBA8888,
                        skia_safe::AlphaType::Unpremul,
                        None,
                    );
                    images::raster_from_data(&info, Data::new_copy(d.data.data()), *width as usize * 4)
                });
                let img = match (&self.upload, img) {
                    (Some(up), Some(i)) => up(&i),
                    (_, i) => i,
                };
                self.images.insert(key, img.clone());
                img
            }
            CanvasSource::Canvas { .. } => None,
        }
    }

    /// A pattern of another canvas: the area of `path` (its outline when stroked) is clipped and the canvas drawn once
    /// per tile it covers.
    #[allow(clippy::too_many_arguments)]
    fn canvas_tiles(
        &mut self,
        canvas: &Canvas,
        path: &Path,
        style: &Paint,
        stroked: bool,
        (width, height): (f64, f64),
        commands: &[CanvasOp],
        (repeat_x, repeat_y): (bool, bool),
        base: Affine,
        comp: Comp,
    ) {
        if !(width > 0.0 && height > 0.0 && width.is_finite() && height.is_finite()) {
            return;
        }
        let det = base.determinant();
        if det == 0.0 || !det.is_finite() {
            return;
        }
        let cover = if stroked {
            let mut pb = PathBuilder::new();
            if fill_path_with_paint(path, style, &mut pb, None, Some(canvas.local_to_device_as_3x3())) { pb.detach() } else { path.clone() }
        } else {
            path.clone()
        };
        let bb = cover.bounds();
        let tile_bbox = base.inverse().transform_rect_bbox(vello::kurbo::Rect::new(
            bb.left as f64,
            bb.top as f64,
            bb.right as f64,
            bb.bottom as f64,
        ));
        let xs = if repeat_x { (tile_bbox.x0 / width).floor() as i64..(tile_bbox.x1 / width).ceil() as i64 } else { 0..1 };
        let ys = if repeat_y { (tile_bbox.y0 / height).floor() as i64..(tile_bbox.y1 / height).ceil() as i64 } else { 0..1 };
        let tiles = i128::from((xs.end - xs.start).max(0)) * i128::from((ys.end - ys.start).max(0));
        if tiles > 10_000 {
            self.stats.no("canvas pattern of more than 10000 tiles");
            return;
        }
        canvas.save();
        canvas.clip_path(&cover, ClipOp::Intersect, true);
        let layer = comp.blend != SkBlend::SrcOver;
        if layer {
            let mut p = Paint::default();
            p.set_blend_mode(comp.blend);
            self.save_layer(canvas, Some(*bb), &p, None);
        }
        for j in ys {
            for i in xs.clone() {
                canvas.save();
                canvas.concat(&mat(base * Affine::translate((i as f64 * width, j as f64 * height))));
                self.canvas_nested(canvas, (width, height), commands, comp.alpha, SkBlend::SrcOver);
                canvas.restore();
            }
        }
        if layer {
            canvas.restore();
        }
        canvas.restore();
    }

    fn canvas_image(&mut self, canvas: &Canvas, op: &ImageOp, comp: Comp) {
        let (nw, nh) = match &op.source {
            CanvasSource::Src { .. } | CanvasSource::Pixels { .. } => match self.canvas_picture(&op.source) {
                Some(i) => (i.width() as f64, i.height() as f64),
                None => {
                    self.stats.no("canvas image (file)");
                    return;
                }
            },
            CanvasSource::Canvas { width, height, .. } => (*width, *height),
        };
        let (sx, sy) = (op.sx.unwrap_or(0.0), op.sy.unwrap_or(0.0));
        let (sw, sh) = (op.sw.unwrap_or(nw), op.sh.unwrap_or(nh));
        if !(sw > 0.0 && sh > 0.0 && op.dw != 0.0 && op.dh != 0.0 && nw > 0.0 && nh > 0.0) {
            return;
        }
        // The source rectangle onto the destination one; a negative `dw` or `dh` flips.
        let to_dest = Affine::translate((op.dx, op.dy)) * Affine::scale_non_uniform(op.dw / sw, op.dh / sh) * Affine::translate((-sx, -sy));
        let src = Rect::new(sx as f32, sy as f32, (sx + sw) as f32, (sy + sh) as f32);
        canvas.save();
        canvas.concat(&mat(to_dest));
        match &op.source {
            CanvasSource::Canvas { width, height, commands } => {
                canvas.clip_rect(src, ClipOp::Intersect, true);
                self.canvas_nested(canvas, (*width, *height), commands, comp.alpha, comp.blend);
            }
            source => {
                if let Some(img) = self.canvas_picture(source) {
                    let p = Self::base_paint(comp);
                    let sampling = if op.smooth {
                        SamplingOptions::new(skia_safe::FilterMode::Linear, skia_safe::MipmapMode::None)
                    } else {
                        SamplingOptions::new(skia_safe::FilterMode::Nearest, skia_safe::MipmapMode::None)
                    };
                    canvas.draw_image_rect_with_sampling_options(&img, Some((&src, skia_safe::canvas::SrcRectConstraint::Strict)), src, sampling, &p);
                    self.stats.draws += 1;
                }
            }
        }
        canvas.restore();
    }

    /// Text as glyph outlines (so a frame stays a pure function of its commands), filled or, with a line style,
    /// stroked.
    fn canvas_text(&mut self, canvas: &Canvas, op: &TextOp, comp: Comp) {
        if op.text.is_empty() || op.size.is_nan() || op.size <= 0.0 {
            return;
        }
        let laid = self.text.layout(&op.text, &op.font, op.size, None, None, crate::scene::TextAlign::Left);
        let Some(line) = laid.lines.first() else { return };
        let spaced = op.letter_spacing != 0.0 || op.word_spacing != 0.0;
        let mut spaces_before = Vec::new();
        let width = if spaced {
            let mut spaces = 0_u32;
            for c in op.text.chars() {
                spaces_before.push(spaces);
                if c == ' ' {
                    spaces += 1;
                }
            }
            spaces_before.push(spaces);
            let chars = (spaces_before.len() - 1) as f64;
            (f64::from(laid.width) + op.letter_spacing * chars + op.word_spacing * f64::from(spaces)).max(0.0)
        } else {
            f64::from(laid.width)
        };
        // `maxWidth` squeezes wider text to fit.
        let squeeze = match op.max_width {
            Some(max) if max > 0.0 && width > max => max / width,
            Some(max) if max <= 0.0 => return,
            _ => 1.0,
        };
        let left = match op.align {
            CanvasTextAlign::Start | CanvasTextAlign::Left => 0.0,
            CanvasTextAlign::Center => -width / 2.0,
            CanvasTextAlign::End | CanvasTextAlign::Right => -width,
        };
        let (ascent, descent) = (f64::from(line.ascent), f64::from(line.descent));
        let down = match op.baseline {
            CanvasBaseline::Alphabetic => 0.0,
            CanvasBaseline::Top => ascent,
            CanvasBaseline::Hanging => ascent * 0.8,
            CanvasBaseline::Middle => (ascent - descent) / 2.0,
            CanvasBaseline::Ideographic | CanvasBaseline::Bottom => -descent,
        };
        let origin = Affine::translate((op.x, op.y + down))
            * Affine::scale_non_uniform(squeeze, 1.0)
            * Affine::translate((left, -f64::from(line.baseline)));
        let mut pb = PathBuilder::new();
        for run in &laid.runs {
            if run.glyphs.is_empty() {
                continue;
            }
            let Some(tf) = self.typeface(run) else {
                self.stats.no("font (typeface)");
                continue;
            };
            let face = tf.unique_id();
            let mut f = Font::from_typeface(tf, run.font_size);
            f.set_subpixel(true);
            f.set_hinting(skia_safe::FontHinting::None);
            f.set_edging(skia_safe::font::Edging::AntiAlias);
            f.set_linear_metrics(true);
            if run.skew != 0.0 {
                f.set_skew_x(-run.skew.to_radians().tan());
            }
            if run.embolden > 0.0 {
                f.set_embolden(true);
            }
            for g in &run.glyphs {
                let x = if spaced {
                    let k = g.char_index as usize;
                    let w = spaces_before.get(k).copied().unwrap_or(0);
                    (f64::from(g.x) + op.letter_spacing * (k as f64) + op.word_spacing * f64::from(w)) as f32
                } else {
                    g.x
                };
                let key = (face, run.font_size.to_bits(), run.skew.to_bits(), run.embolden > 0.0, g.id as u16);
                let outline = self.glyph_paths.entry(key).or_insert_with(|| f.get_path(g.id as u16)).clone();
                if let Some(outline) = outline {
                    pb.add_path_with_offset(&outline, (x, g.y), None);
                }
            }
        }
        let path = pb.detach().make_transform(&mat(origin));
        self.canvas_paint_path(canvas, &path, op.line.as_ref(), &op.paint, comp);
    }
}
