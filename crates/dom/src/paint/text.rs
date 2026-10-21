//! The text of an inline formatting context: Blitz's Parley lines as glyph
//! runs, text decorations and text shadows, and the boxes of inline
//! elements.

use blitz_dom::{Node, NodeData};
use blitz_traits::node_id::NodeId;
use parley::PositionedLayoutItem;
use serde_json::{Value, json};
use style::computed_values::position::T as Position;
use style::properties::ComputedValues;
use style::values::computed::{Float, Length};
use style::values::specified::TextDecorationLine;
use style::values::specified::box_::DisplayOutside;

use super::geom::Rect;
use super::util::{Layer, current_color, hex_of, num, num4, resolve_color, rgba, shift};
use super::{Origin, Painter, Phases};

/// What a run of text is painted with: everything that makes two runs
/// different layers.
#[derive(Clone, Debug, PartialEq)]
struct TextPaint {
    color: [f32; 4],
    shadows: Vec<TextShadow>,
}

#[derive(Clone, Debug, PartialEq)]
struct TextShadow {
    dx: f64,
    dy: f64,
    blur: f64,
    color: [f32; 4],
}

/// A decoration line the run's elements ask for.
#[derive(Clone, Copy, Debug)]
struct Decor {
    underline: bool,
    overline: bool,
    line_through: bool,
    color: [f32; 4],
    style: DecorStyle,
    thickness: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DecorStyle {
    Solid,
    Double,
    Dotted,
    Dashed,
    Wavy,
}

/// A batch of runs with the same paint, becoming one text layer.
struct Batch {
    paint: TextPaint,
    runs: Vec<Value>,
}

impl<'a> Painter<'a> {
    /// The inline content of `node` (an inline formatting context root): the
    /// boxes of its inline elements, its glyphs and its atomic inline boxes,
    /// appended to `ph.inline` in the order the lines have them.
    pub(super) fn paint_inline_root(
        &mut self,
        node: &'a Node,
        origin: Origin,
        ph: &mut Phases,
        pos: &mut Vec<Value>,
    ) {
        let Some(el) = node.element_data() else {
            return;
        };
        let Some(ild) = el.inline_layout_data.as_ref() else {
            return;
        };
        let l = node.final_layout();
        let content = (
            origin.0 + f64::from(l.border.left + l.padding.left),
            origin.1 + f64::from(l.border.top + l.padding.top) + f64::from(ild.block_offset),
        );
        let layout = &ild.layout;
        let scale = f64::from(layout.scale()).max(1e-6);

        // Backgrounds and borders of inline elements go under the text.
        let mut inline_boxes = Vec::new();
        self.inline_element_boxes(node, origin, &mut inline_boxes);
        ph.inline.extend(inline_boxes);

        // The layout's width is its longest line; a centred or right-aligned
        // line sits inside the content box, so the box the glyphs may fall in
        // is the wider of the two (the compositor sizes the layer, and the
        // filters and blurs on it, by this box).
        let content_width = f64::from(
            l.size.width - l.border.left - l.border.right - l.padding.left - l.padding.right,
        );
        // A negative letter-spacing is added after the last glyph too, so the
        // layout ends short of its ink by that much.
        let mut tight = 0.0f64;
        for line in layout.lines() {
            for item in line.items() {
                if let PositionedLayoutItem::GlyphRun(gr) = item {
                    let brush = self.node(NodeId::from_u64(gr.style().brush.id.as_u64()));
                    if let Some(style) = brush.primary_styles() {
                        let spacing = style
                            .get_inherited_text()
                            .letter_spacing
                            .0
                            .resolve(Length::new(style.get_font().font_size.computed_size().px()))
                            .px();
                        tight = tight.max(-f64::from(spacing));
                    }
                }
            }
        }
        let size = (
            (f64::from(layout.width()) / scale + tight).max(content_width),
            f64::from(layout.height()) / scale,
        );
        let mut batch: Option<Batch> = None;
        let mut decor_lines: Vec<(Decor, Rect, f64, bool)> = Vec::new(); // under / through lines, flushed with the batch

        let clamp_line = self.clamp_line(node);
        let overflow_ellipsis = self.overflow_ellipsis(node);
        for (line_index, line) in layout.lines().enumerate() {
            let force = clamp_line == Some(line_index);
            let cut = if force || overflow_ellipsis {
                self.line_cut(node, &line, scale, content_width, force)
            } else {
                None
            };
            for (item_index, item) in line.items().enumerate() {
                match item {
                    PositionedLayoutItem::GlyphRun(gr) => {
                        let brush_node = self.node(NodeId::from_u64(gr.style().brush.id.as_u64()));
                        let Some(style) = brush_node.primary_styles() else {
                            continue;
                        };
                        if style.clone_visibility()
                            != style::computed_values::visibility::T::Visible
                        {
                            continue;
                        }
                        let mut paint = self.text_paint(&style);
                        if let Some(c) = self
                            .kg_value(brush_node, "--kg-text-fill-color")
                            .and_then(|fill| super::util::parse_css_color(&fill))
                        {
                            paint.color = c;
                        }
                        let run = gr.run();
                        let Some(src) = self.font_path(run.font()) else {
                            self.report(
                                node,
                                "font",
                                "file",
                                "the font of this text is not one of the project's font files",
                            );
                            continue;
                        };
                        let synth = run.synthesis();
                        let mut glyphs: Vec<Value> = Vec::new();
                        for g in gr.positioned_glyphs() {
                            let x = f64::from(g.x) / scale;
                            if cut.as_ref().is_some_and(|c| x >= c.x - 0.01) {
                                continue;
                            }
                            glyphs.push(json!([g.id, num(x), num(f64::from(g.y) / scale)]));
                        }
                        // The ellipsis follows the last glyph kept of its run.
                        if let Some(c) = cut.as_ref().filter(|c| c.anchor == item_index) {
                            let y = num(f64::from(gr.baseline()) / scale);
                            for (id, x) in &c.glyphs {
                                glyphs.push(json!([id, num(*x), y]));
                            }
                        }
                        if glyphs.is_empty() {
                            continue;
                        }
                        let mut run_json = json!({
                            "src": src,
                            "index": run.font().index,
                            "size": num(f64::from(run.font_size()) / scale),
                            "glyphs": glyphs,
                        });
                        let coords: Vec<i16> = run
                            .normalized_coords()
                            .iter()
                            .map(|c| c.to_bits())
                            .collect();
                        if !coords.is_empty() {
                            run_json["coords"] = json!(coords);
                        }
                        if let Some(skew) = synth.skew() {
                            run_json["skew"] = json!(skew);
                        }
                        if synth.embolden() {
                            run_json["embolden"] =
                                json!(num4(f64::from(run.font_size()) / scale / 48.0));
                        }

                        // Decorations of this run.
                        let metrics = run.font_metrics();
                        let decor = self.decorations_of(brush_node);
                        let x0 = f64::from(gr.offset()) / scale;
                        let mut adv = f64::from(gr.advance()) / scale;
                        // Chrome's decoration stops where the cut is, ellipsis not included.
                        if let Some(c) = &cut {
                            adv = adv.min((c.x - x0).max(0.0));
                        }
                        let base = f64::from(gr.baseline()) / scale;
                        for d in decor {
                            let t = d
                                .thickness
                                .unwrap_or(f64::from(metrics.underline_size) / scale)
                                .max(1.0);
                            if d.underline {
                                let off = f64::from(metrics.underline_offset) / scale;
                                decor_lines.push((d, Rect::new(x0, base - off, adv, t), t, false));
                            }
                            if d.overline {
                                let top = base - f64::from(metrics.ascent) / scale;
                                decor_lines.push((d, Rect::new(x0, top, adv, t), t, false));
                            }
                            if d.line_through {
                                let off = f64::from(metrics.strikethrough_offset) / scale;
                                let ts = d
                                    .thickness
                                    .unwrap_or(f64::from(metrics.strikethrough_size) / scale)
                                    .max(1.0);
                                decor_lines.push((d, Rect::new(x0, base - off, adv, ts), ts, true));
                            }
                        }

                        match &mut batch {
                            Some(b) if b.paint == paint => b.runs.push(run_json),
                            _ => {
                                if let Some(b) = batch.take() {
                                    let layers = self.text_layers(node, &b, content, size);
                                    ph.inline.extend(layers);
                                }
                                batch = Some(Batch {
                                    paint,
                                    runs: vec![run_json],
                                });
                            }
                        }
                    }
                    PositionedLayoutItem::InlineBox(ib) => {
                        // An atomic inline box: painted whole, in line order.
                        if let Some(b) = batch.take() {
                            let layers = self.text_layers(node, &b, content, size);
                            ph.inline.extend(layers);
                        }
                        if cut
                            .as_ref()
                            .is_some_and(|c| f64::from(ib.x) / scale >= c.x - 0.01)
                        {
                            continue;
                        }
                        let child_id = NodeId::from_u64(ib.id);
                        let child = self.node(child_id);
                        // The front half's zero-height boxes that give inline
                        // edges their width (`inline::SPACER_TAG`).
                        if self.tag_of(child) == crate::inline::SPACER_TAG {
                            continue;
                        }
                        let Some(style) = child.primary_styles() else {
                            continue;
                        };
                        let display = style.clone_display();
                        let floated = style.clone_float() != Float::None;
                        let out_of_flow =
                            matches!(style.clone_position(), Position::Absolute | Position::Fixed);
                        let is_sc = self.is_sc(child, false);
                        let positioned = !matches!(style.clone_position(), Position::Static);
                        drop(style);
                        if floated || out_of_flow || display.outside() != DisplayOutside::Inline {
                            continue;
                        }
                        if is_sc || positioned {
                            // Painted with the positioned boxes.
                            let loc = child.final_layout().location;
                            let at = (origin.0 + f64::from(loc.x), origin.1 + f64::from(loc.y));
                            let layers = if is_sc {
                                self.paint_context(child, at)
                            } else {
                                self.paint_atomic(child, at, pos)
                            };
                            pos.extend(layers);
                            continue;
                        }
                        let loc = child.final_layout().location;
                        let at = (origin.0 + f64::from(loc.x), origin.1 + f64::from(loc.y));
                        let layers = self.paint_atomic(child, at, pos);
                        ph.inline.extend(layers);
                    }
                }
            }
        }
        if let Some(b) = batch.take() {
            let layers = self.text_layers(node, &b, content, size);
            ph.inline.extend(layers);
        }
        // Decoration lines.
        for (n, (d, r, _t, _through)) in decor_lines.into_iter().enumerate() {
            let id = self.layer_id(node, &format!("deco{n}"));
            let layers = self.decoration_line(&id, &d, r);
            for mut l in layers {
                shift(&mut l, content.0, content.1);
                ph.inline.push(l);
            }
        }
    }

    /// The text layers of a batch: its shadows (lowest first), then the text.
    fn text_layers(
        &mut self,
        node: &'a Node,
        batch: &Batch,
        content: Origin,
        size: (f64, f64),
    ) -> Vec<Value> {
        let mut out = Vec::new();
        let make =
            |p: &mut Self, suffix: &str, color: [f32; 4], dx: f64, dy: f64, blur: f64| -> Value {
                let id = p.layer_id(node, suffix);
                let mut layer = Layer::new(&id, "text")
                    .set("color", Value::String(hex_of(color)))
                    .set("boxWidth", num(size.0))
                    .set("boxHeight", num(size.1))
                    .set("runs", Value::Array(batch.runs.clone()))
                    .at(content.0 + dx, content.1 + dy);
                if blur > 0.0 {
                    layer = layer.set("effects", json!([{ "type": "blur", "radius": num(blur) }]));
                }
                layer.build()
            };
        for (i, s) in batch.paint.shadows.iter().enumerate().rev() {
            if s.color[3] <= 0.0 {
                continue;
            }
            let id = format!("shadow{i}");
            out.push(make(self, &id, s.color, s.dx, s.dy, s.blur / 2.0));
            self.note_reach(s.dx.abs().max(s.dy.abs()) + 3.0 * s.blur / 2.0);
        }
        out.push(make(self, "text", batch.paint.color, 0.0, 0.0, 0.0));
        out
    }

    fn text_paint(&mut self, style: &ComputedValues) -> TextPaint {
        let current = current_color(style);
        let color = rgba(&current);
        let shadows = style
            .get_inherited_text()
            .text_shadow
            .0
            .iter()
            .map(|s| TextShadow {
                dx: f64::from(s.horizontal.px()),
                dy: f64::from(s.vertical.px()),
                blur: f64::from(s.blur.0.px()),
                color: rgba(&resolve_color(&s.color, &current)),
            })
            .collect();
        TextPaint { color, shadows }
    }

    /// The decoration lines that apply to text whose style is `node`'s: its
    /// own and its ancestors', up to a box that stops them.
    fn decorations_of(&self, node: &Node) -> Vec<Decor> {
        let mut out = Vec::new();
        let mut cur = Some(node);
        while let Some(n) = cur {
            if let Some(style) = n.primary_styles() {
                let t = style.get_text();
                let line = t.text_decoration_line;
                if line.intersects(
                    TextDecorationLine::UNDERLINE
                        | TextDecorationLine::OVERLINE
                        | TextDecorationLine::LINE_THROUGH,
                ) {
                    let current = current_color(&style);
                    let color = rgba(&resolve_color(&t.text_decoration_color, &current));
                    let st = format!("{:?}", t.text_decoration_style);
                    let style_kind = match st.as_str() {
                        "Double" => DecorStyle::Double,
                        "Dotted" => DecorStyle::Dotted,
                        "Dashed" => DecorStyle::Dashed,
                        "Wavy" => DecorStyle::Wavy,
                        _ => DecorStyle::Solid,
                    };
                    let thickness = match t.text_decoration_thickness {
                        style::values::computed::text::TextDecorationLength::Auto
                        | style::values::computed::text::TextDecorationLength::FromFont => None,
                        style::values::computed::text::TextDecorationLength::LengthPercentage(
                            ref l,
                        ) => {
                            let fs = f64::from(style.get_font().font_size.computed_size().px());
                            Some(super::util::lp(l, fs))
                        }
                    };
                    out.push(Decor {
                        underline: line.contains(TextDecorationLine::UNDERLINE),
                        overline: line.contains(TextDecorationLine::OVERLINE),
                        line_through: line.contains(TextDecorationLine::LINE_THROUGH),
                        color,
                        style: style_kind,
                        thickness,
                    });
                }
                // Floats, absolutely positioned and atomic boxes stop them.
                let stops = style.clone_float() != Float::None
                    || matches!(style.clone_position(), Position::Absolute | Position::Fixed)
                    || (style.clone_display().outside() == DisplayOutside::Inline
                        && !n.is_non_atomic_inline()
                        && n.element_data().is_some()
                        && !n.flags.is_inline_root());
                if stops || n.flags.is_inline_root() && false {
                    break;
                }
            }
            if matches!(n.data, NodeData::Document(_)) {
                break;
            }
            cur = n.parent.map(|p| self.node(p));
        }
        out
    }

    /// One decoration line over the rectangle `r` (in the content box).
    fn decoration_line(&mut self, id: &str, d: &Decor, r: Rect) -> Vec<Value> {
        let color = Value::String(hex_of(d.color));
        match d.style {
            DecorStyle::Solid => vec![
                super::util::rect_shape(id, r.w, r.h, 0.0, color)
                    .at(r.x, r.y)
                    .build(),
            ],
            DecorStyle::Double => {
                let t = (r.h * 0.6).max(1.0);
                vec![
                    super::util::rect_shape(&format!("{id}.a"), r.w, t, 0.0, color.clone())
                        .at(r.x, r.y)
                        .build(),
                    super::util::rect_shape(&format!("{id}.b"), r.w, t, 0.0, color)
                        .at(r.x, r.y + r.h + t)
                        .build(),
                ]
            }
            DecorStyle::Dotted | DecorStyle::Dashed => {
                let (dash, gap) = if d.style == DecorStyle::Dotted {
                    (r.h, r.h)
                } else {
                    (3.0 * r.h, 2.0 * r.h)
                };
                let mut out = Vec::new();
                let mut x = 0.0;
                let mut i = 0;
                while x < r.w && i < 400 {
                    let w = dash.min(r.w - x);
                    out.push(
                        super::util::rect_shape(&format!("{id}.{i}"), w, r.h, 0.0, color.clone())
                            .at(r.x + x, r.y)
                            .build(),
                    );
                    x += dash + gap;
                    i += 1;
                }
                out
            }
            DecorStyle::Wavy => {
                // A sine-like wave: quadratic arcs of a period of 4 thicknesses.
                let amp = r.h;
                let half = (2.0 * r.h).max(2.0);
                let mut d_path = String::new();
                let mut x = 0.0;
                let mut up = true;
                d_path.push_str(&format!("M0 {}", num(amp)));
                while x < r.w {
                    let nx = (x + half).min(r.w);
                    let cy = if up { 0.0 } else { 2.0 * amp };
                    d_path.push_str(&format!(
                        " Q{} {} {} {}",
                        num((x + nx) / 2.0),
                        num(cy),
                        num(nx),
                        num(amp)
                    ));
                    x = nx;
                    up = !up;
                }
                let layer = Layer::new(id, "shape")
                    .set("shape", json!({ "kind": "path", "d": "M0 0" }))
                    .set(
                        "stroke",
                        json!({ "color": hex_of(d.color), "width": num(r.h) }),
                    )
                    .set("shape", json!({ "kind": "path", "d": d_path }))
                    .at(r.x, r.y);
                vec![layer.build()]
            }
        }
    }

    /// The boxes of the non-atomic inline elements below `inline_root`, in tree
    /// order: one background and border per line the element spans.
    fn inline_element_boxes(&mut self, node: &'a Node, root_origin: Origin, out: &mut Vec<Value>) {
        for cid in node.children.iter() {
            let child = self.node(*cid);
            if !child.is_element() || !child.is_non_atomic_inline() {
                continue;
            }
            if self.is_visible(child)
                && let Some(frags) = child.inline_fragment_boxes()
            {
                let rects: Vec<Rect> = frags
                    .map(|r| {
                        Rect::new(
                            f64::from(r.left) + root_origin.0,
                            f64::from(r.top) + root_origin.1,
                            f64::from(r.right - r.left),
                            f64::from(r.bottom - r.top),
                        )
                    })
                    .collect();
                let layers = self.inline_fragments(child, &rects);
                out.extend(layers);
            }
            self.inline_element_boxes(child, root_origin, out);
        }
    }

    /// Backgrounds, shadows and borders of one inline element over its line
    /// fragments (`box-decoration-break: slice`: the ends of the element carry
    /// the border edges).
    fn inline_fragments(&mut self, node: &'a Node, rects: &[Rect]) -> Vec<Value> {
        let Some(style) = node.primary_styles() else {
            return Vec::new();
        };
        let count = rects.len();
        let mut out = Vec::new();
        let mut any_deco = false;
        {
            let bg = style.get_background();
            let has_bg = !bg
                .background_image
                .0
                .iter()
                .all(|i| matches!(i, style::values::computed::Image::None))
                || rgba(&resolve_color(&bg.background_color, &current_color(&style)))[3] > 0.0;
            let has_shadow = !style.get_effects().box_shadow.0.is_empty();
            let b = style.get_border();
            let _ = b;
            let has_border = border_widths(&style).iter().any(|w| *w > 0.0);
            any_deco |= has_bg || has_shadow || has_border;
        }
        if !any_deco {
            return out;
        }
        for (i, r) in rects.iter().enumerate() {
            let geom = self.inline_fragment_geom(node, &style, *r, i == 0, i + 1 == count);
            let mut layers = Vec::new();
            layers.extend(self.box_shadows(node, &style, &geom, false));
            layers.extend(self.background(node, &style, &geom));
            layers.extend(self.box_shadows(node, &style, &geom, true));
            layers.extend(self.borders(node, &style, &geom));
            for mut l in layers {
                shift(&mut l, r.x, r.y);
                out.push(l);
            }
        }
        out
    }
}

impl<'a> Painter<'a> {
    /// The box of one line fragment of an inline element: the element's
    /// border and padding on the ends it has (`box-decoration-break: slice`).
    fn inline_fragment_geom(
        &self,
        _node: &Node,
        style: &ComputedValues,
        rect: Rect,
        first: bool,
        last: bool,
    ) -> super::geom::BoxGeom {
        let b = style.get_border();
        let bw = border_widths(style);
        let p = style.get_padding();
        let pad = |x: &style::values::computed::LengthPercentage| super::util::lp(x, rect.w);
        let radius = |c: &style::values::computed::BorderCornerRadius| {
            (
                super::util::lp(&c.0.width.0, rect.w),
                super::util::lp(&c.0.height.0, rect.h),
            )
        };
        let zero = (0.0, 0.0);
        let radii = super::geom::Radii {
            tl: if first {
                radius(&b.border_top_left_radius)
            } else {
                zero
            },
            bl: if first {
                radius(&b.border_bottom_left_radius)
            } else {
                zero
            },
            tr: if last {
                radius(&b.border_top_right_radius)
            } else {
                zero
            },
            br: if last {
                radius(&b.border_bottom_right_radius)
            } else {
                zero
            },
        }
        .fitted(rect.w, rect.h);
        super::geom::BoxGeom {
            w: rect.w,
            h: rect.h,
            border: [
                bw[0],
                if last { bw[1] } else { 0.0 },
                bw[2],
                if first { bw[3] } else { 0.0 },
            ],
            padding: [
                pad(&p.padding_top.0),
                if last { pad(&p.padding_right.0) } else { 0.0 },
                pad(&p.padding_bottom.0),
                if first { pad(&p.padding_left.0) } else { 0.0 },
            ],
            radii,
        }
    }
}

impl<'a> Painter<'a> {
    /// White text layers of every glyph `node` and its descendants hold, in
    /// `node`'s own space: the shape `background-clip: text` cuts the
    /// background to.
    pub fn text_mask_layers(&mut self, node: &'a Node, id: &str) -> Vec<Value> {
        let mut out = Vec::new();
        let mut n = 0;
        self.collect_text_mask(node, (0.0, 0.0), id, &mut n, &mut out);
        out
    }

    fn collect_text_mask(
        &mut self,
        node: &'a Node,
        origin: Origin,
        id: &str,
        n: &mut usize,
        out: &mut Vec<Value>,
    ) {
        if let Some(ild) = node
            .element_data()
            .and_then(|e| e.inline_layout_data.as_ref())
        {
            let l = node.final_layout();
            let content = (
                origin.0 + f64::from(l.border.left + l.padding.left),
                origin.1 + f64::from(l.border.top + l.padding.top) + f64::from(ild.block_offset),
            );
            let layout = &ild.layout;
            let scale = f64::from(layout.scale()).max(1e-6);
            let mut runs: Vec<Value> = Vec::new();
            for line in layout.lines() {
                for item in line.items() {
                    let PositionedLayoutItem::GlyphRun(gr) = item else {
                        continue;
                    };
                    let run = gr.run();
                    let Some(src) = self.font_path(run.font()) else {
                        continue;
                    };
                    let glyphs: Vec<Value> = gr
                        .positioned_glyphs()
                        .map(|g| {
                            json!([
                                g.id,
                                num(f64::from(g.x) / scale),
                                num(f64::from(g.y) / scale)
                            ])
                        })
                        .collect();
                    if glyphs.is_empty() {
                        continue;
                    }
                    let mut r = json!({ "src": src, "index": run.font().index, "size": num(f64::from(run.font_size()) / scale), "glyphs": glyphs });
                    let coords: Vec<i16> = run
                        .normalized_coords()
                        .iter()
                        .map(|c| c.to_bits())
                        .collect();
                    if !coords.is_empty() {
                        r["coords"] = json!(coords);
                    }
                    if let Some(skew) = run.synthesis().skew() {
                        r["skew"] = json!(skew);
                    }
                    runs.push(r);
                }
            }
            if !runs.is_empty() {
                *n += 1;
                let layer = Layer::new(&format!("{id}.{n}"), "text")
                    .set("color", json!("#ffffff"))
                    .set("boxWidth", num(f64::from(layout.width()) / scale))
                    .set("boxHeight", num(f64::from(layout.height()) / scale))
                    .set("runs", Value::Array(runs))
                    .at(content.0, content.1);
                out.push(layer.build());
            }
        }
        let children: Vec<NodeId> = node
            .layout_children
            .borrow()
            .as_ref()
            .map(|c| c.iter().copied().collect())
            .unwrap_or_default();
        for cid in children {
            let child = self.node(cid);
            let loc = child.final_layout().location;
            self.collect_text_mask(
                child,
                (origin.0 + f64::from(loc.x), origin.1 + f64::from(loc.y)),
                id,
                n,
                out,
            );
        }
    }
}

/// The four border widths (top, right, bottom, left) of an element, 0 where
/// the style is `none` or `hidden` (Stylo keeps the `medium` width then).
pub(super) fn border_widths(style: &ComputedValues) -> [f64; 4] {
    use style::values::specified::BorderStyle as S;
    let b = style.get_border();
    let w = |width: &style::values::computed::BorderSideWidth, st: S| {
        if matches!(st, S::None | S::Hidden) {
            0.0
        } else {
            f64::from(width.0.to_f32_px())
        }
    };
    [
        w(&b.border_top_width, b.border_top_style),
        w(&b.border_right_width, b.border_right_style),
        w(&b.border_bottom_width, b.border_bottom_style),
        w(&b.border_left_width, b.border_left_style),
    ]
}
