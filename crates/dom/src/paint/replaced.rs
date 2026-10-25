//! Replaced content: `<img>`, `<video>`, `<canvas>`, list markers, and the
//! canvas background.

use blitz_dom::{Node, local_name};
use serde_json::{Value, json};
use style::computed_values::object_fit::T as ObjectFit;

use super::deco::box_geom;
use super::geom::{Rect, Region};
use super::images::Source;
use super::util::{Layer, lp, num, num4};
use super::{Origin, Painter};

impl<'a> Painter<'a> {
    /// The picture or video of a replaced element, in its content box.
    pub fn replaced_content(&mut self, node: &'a Node, origin: Origin) -> Vec<Value> {
        let Some(style) = node.primary_styles() else {
            return Vec::new();
        };
        if !self.is_visible(node) {
            return Vec::new();
        }
        let Some(el) = node.element_data() else {
            return Vec::new();
        };
        let tag = &el.name.local;
        let geom = box_geom(node, &style);
        let (content, radii) = geom.region(Region::Content);

        // A native `kg-*` element of the TS side: a replaced box whose layers
        // the caller puts where this placeholder is (packages/cli/skills/kinetograph/references/ENGINE.md section 2).
        if &**tag == "kg-native" {
            let path = self.path_of(node);
            return vec![serde_json::json!({
                "type": "native",
                "path": path,
                "x": num(origin.0 + content.x),
                "y": num(origin.1 + content.y),
                "width": num(content.w),
                "height": num(content.h),
            })];
        }
        if content.is_empty() {
            return Vec::new();
        }

        if *tag == local_name!("svg") {
            let id = self.layer_id(node, "svg");
            let path = self.path_of(node);
            let painted = super::svg::paint_svg(
                self.doc,
                self.req,
                node.id,
                [content.w, content.h],
                &id,
                &path,
            );
            self.unsupported.extend(painted.unsupported);
            let Some(mut layer) = painted.layer else {
                return Vec::new();
            };
            super::util::shift(&mut layer, origin.0 + content.x, origin.1 + content.y);
            if !radii.is_zero() {
                let clip_rect = Rect::new(
                    origin.0 + content.x,
                    origin.1 + content.y,
                    content.w,
                    content.h,
                );
                self.clip_layer(&mut layer, clip_rect, radii);
            }
            return vec![layer];
        }
        if *tag == local_name!("canvas") {
            return self.canvas_content(node, origin, content, radii);
        }
        let is_video = *tag == local_name!("video");
        let src_attr = el.attr(local_name!("src")).map(str::to_string);
        let Some(src_attr) = src_attr else {
            return Vec::new();
        };

        let (path, nw, nh) = if is_video {
            let Some(p) = self.resolve_relative(&src_attr).or_else(|| {
                // A file: URL.
                url::Url::parse(&src_attr)
                    .ok()
                    .and_then(|u| u.to_file_path().ok())
            }) else {
                self.report(
                    node,
                    "src",
                    &src_attr,
                    "the video file is not in the project",
                );
                return Vec::new();
            };
            // The video's own size is read by the scene when it loads; the
            // box decides the layer's size.
            (p.to_string_lossy().into_owned(), 0.0, 0.0)
        } else {
            match self.source_of(&src_attr) {
                Source::Raster { path, w, h } => (path, w, h),
                Source::Unsupported(reason) => {
                    self.report(node, "src", &src_attr, &reason);
                    return Vec::new();
                }
            }
        };

        let pos = style.get_position();
        let fit = pos.object_fit;
        // The picture's rectangle in the content box.
        let (pic, needs_clip) = if is_video || nw <= 0.0 || nh <= 0.0 {
            (Rect::new(0.0, 0.0, content.w, content.h), false)
        } else {
            let (mut pw, mut ph) = match fit {
                ObjectFit::Fill => (content.w, content.h),
                ObjectFit::Contain => {
                    let s = (content.w / nw).min(content.h / nh);
                    (nw * s, nh * s)
                }
                ObjectFit::Cover => {
                    let s = (content.w / nw).max(content.h / nh);
                    (nw * s, nh * s)
                }
                ObjectFit::None => (nw, nh),
                ObjectFit::ScaleDown => {
                    let s = (content.w / nw).min(content.h / nh).min(1.0);
                    (nw * s, nh * s)
                }
            };
            if !(pw > 0.0 && ph > 0.0) {
                pw = content.w;
                ph = content.h;
            }
            let px = lp(&pos.object_position.horizontal, content.w - pw);
            let py = lp(&pos.object_position.vertical, content.h - ph);
            let r = Rect::new(px, py, pw, ph);
            let inside = Rect::new(0.0, 0.0, content.w, content.h).contains_rect(&r);
            (r, !inside)
        };

        let id = self.layer_id(node, if is_video { "video" } else { "img" });
        let mut layer = Layer::new(&id, if is_video { "video" } else { "image" })
            .set("src", json!(path))
            .set("width", num(pic.w))
            .set("height", num(pic.h));
        if is_video {
            match fit {
                ObjectFit::Contain | ObjectFit::ScaleDown => {
                    layer = layer.set("fit", json!("contain"));
                }
                ObjectFit::Cover => {
                    layer = layer.set("fit", json!("cover"));
                }
                ObjectFit::Fill | ObjectFit::None => {}
            }
            if let Some(meta) = super::attr(node, "data-kg-video")
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .and_then(|v| v.as_object().cloned())
            {
                for key in ["from", "trimBefore", "trimAfter", "playbackRate", "frame"] {
                    if let Some(val) = meta.get(key).filter(|v| v.is_number()) {
                        layer = layer.set(key, val.clone());
                    }
                }
                if let Some(val) = meta.get("loop").filter(|v| v.is_boolean()) {
                    layer = layer.set("loop", val.clone());
                }
            }
        }
        let lx = origin.0 + content.x + pic.x;
        let ly = origin.1 + content.y + pic.y;
        layer = layer.at(lx, ly);
        let mut layer = layer.build();
        // Cut to the content box when the picture overflows it, or the box is rounded.
        if needs_clip || !radii.is_zero() {
            let clip_rect = Rect::new(
                origin.0 + content.x,
                origin.1 + content.y,
                content.w,
                content.h,
            );
            self.clip_layer(&mut layer, clip_rect, radii);
        }
        vec![layer]
    }

    /// A WebGPU canvas's recording (`data-kg-webgl` with a `webgpu` part): what the page did that is not drawn, and
    /// the WGSL naga refuses, are reported, and a recording with a module that is wrong, or a texture out of range, draws nothing.
    fn webgpu_report(&mut self, node: &'a Node, drawn: &mut Value) {
        let Some(part) = drawn.get("webgpu").cloned() else {
            return;
        };
        let recording = match serde_json::from_value::<kinetograph_core::webgpu::WebGpuContent>(part) {
            Ok(r) => r,
            Err(e) => {
                self.report(node, "webgpu", "recording", &format!("the WebGPU recording is not readable: {e}"));
                drawn["webgpu"] = json!({});
                return;
            }
        };
        for note in &recording.notes {
            self.report(node, "webgpu", note, "WebGPU call that is not drawn (the canvas is drawn without it)");
        }
        let problems = kinetograph_core::webgpu::check(&recording);
        for problem in &problems {
            self.report(node, "webgpu", problem, "a WGSL module that is not valid; the canvas draws nothing");
        }
        // The sizes, levels and origins of textures, uploads and copies: a recording that is out of range draws nothing.
        let invalid = kinetograph_core::webgpu::validate(&recording, 8192).err();
        if let Some(problem) = &invalid {
            self.report(node, "webgpu", problem, "a texture, upload or copy that is out of range; the canvas draws nothing");
        }
        if !problems.is_empty() || invalid.is_some() {
            drawn["webgpu"] = json!({});
        }
    }

    /// What a `<canvas>`'s context drew: the 2D commands the TS side puts in
    /// `data-kg-canvas` (packages/cli/skills/kinetograph/references/SCENE.md, "canvas"), as one canvas layer the size
    /// of the canvas's bitmap (`width` and `height`, 300 x 150 without them),
    /// stretched to the content box as `object-fit: fill` does. A canvas
    /// nothing was drawn on draws nothing.
    fn canvas_content(
        &mut self,
        node: &'a Node,
        origin: Origin,
        content: Rect,
        radii: super::geom::Radii,
    ) -> Vec<Value> {
        // A WebGL context's recording (`data-kg-webgl`, packages/cli/skills/kinetograph/references/SCENE.md, "glsl") is
        // a glsl layer the same way; a 2D context's commands a canvas layer.
        let (kind, text) = if let Some(recording) = super::attr(node, "data-kg-webgl") {
            ("glsl", recording)
        } else if let Some(commands) = super::attr(node, "data-kg-canvas") {
            ("canvas", commands)
        } else {
            return Vec::new();
        };
        let Ok(drawn) = serde_json::from_str::<Value>(text) else {
            self.report_element(node, "what was drawn on this <canvas> is not JSON");
            return Vec::new();
        };
        let side = |name: &str, default: f64| {
            super::attr(node, name)
                .and_then(|v| v.trim().parse::<f64>().ok())
                .filter(|v| v.is_finite() && *v >= 0.0)
                .map_or(default, f64::floor)
        };
        let (width, height) = (side("width", 300.0), side("height", 150.0));
        if !(width > 0.0 && height > 0.0) {
            return Vec::new();
        }
        let mut drawn = drawn;
        if kind == "glsl" && drawn.get("webgpu").is_some() {
            self.webgpu_report(node, &mut drawn);
        }
        if kind == "canvas" {
            let mut urls = Vec::new();
            url_filters(&drawn, &mut urls);
            for url in urls {
                self.report(
                    node,
                    "filter",
                    url,
                    "a url() filter is not drawn on a canvas",
                );
            }
        }
        let id = self.layer_id(node, kind);
        let mut layer = Layer::new(&id, kind)
            .set("width", num(width))
            .set("height", num(height));
        layer = if kind == "glsl" {
            // The recording's fields are the layer's.
            let fields = drawn.as_object().cloned().unwrap_or_default();
            fields
                .into_iter()
                .fold(layer, |layer, (key, value)| layer.set(&key, value))
        } else {
            layer.set("commands", drawn)
        };
        let mut layer = layer.build();
        let (sx, sy) = (content.w / width, content.h / height);
        if sx != 1.0 || sy != 1.0 {
            // A flat scale: drawn sharp, not resampled.
            layer["transform"] = json!({
                "matrix": [num4(sx), 0, 0, 0, 0, num4(sy), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
            });
        }
        let (x, y) = (origin.0 + content.x, origin.1 + content.y);
        if radii.is_zero() {
            super::util::shift(&mut layer, x, y);
            return vec![layer];
        }
        // A rounded box cuts the stretched bitmap: the clip is in the space of a layer without the scale, so it
        // goes on a group around it.
        let mut group = super::util::group(&format!("{id}.clip"), vec![layer])
            .at(x, y)
            .build();
        self.clip_layer(&mut group, Rect::new(x, y, content.w, content.h), radii);
        vec![group]
    }

    /// The baseline of the first line of text in `node`, from its border box's
    /// top, and the ascent of the font of that line.
    fn first_baseline(&self, node: &'a Node) -> Option<(f64, f64)> {
        if let Some(ild) = node
            .element_data()
            .and_then(|e| e.inline_layout_data.as_ref())
        {
            let l = node.final_layout();
            let line = ild.layout.lines().next()?;
            let ascent = line
                .items()
                .find_map(|i| match i {
                    parley::PositionedLayoutItem::GlyphRun(g) => {
                        Some(f64::from(g.run().font_metrics().ascent))
                    }
                    _ => None,
                })
                .unwrap_or(0.0);
            let top = f64::from(l.border.top + l.padding.top) + f64::from(ild.block_offset);
            return Some((top + f64::from(line.metrics().baseline), ascent));
        }
        let children: Vec<_> = node
            .layout_children
            .borrow()
            .as_ref()
            .map(|c| c.iter().copied().collect())
            .unwrap_or_default();
        for cid in children {
            let c = self.node(cid);
            if let Some((b, a)) = self.first_baseline(c) {
                return Some((b + f64::from(c.final_layout().location.y), a));
            }
        }
        None
    }

    /// The marker of a list item: discs, circles and squares as shapes the way
    /// Chrome sizes them, numbers as text, both outside the content box.
    pub fn list_marker(&mut self, node: &'a Node, origin: Origin) -> Vec<Value> {
        use blitz_dom::node::{ListItemLayoutPosition, Marker};
        let Some(item) = node
            .element_data()
            .and_then(|e| e.list_item_data.as_deref())
        else {
            return Vec::new();
        };
        let Some(style) = node.primary_styles() else {
            return Vec::new();
        };
        if !self.is_visible(node) {
            return Vec::new();
        }
        let color = super::util::rgba(&super::util::current_color(&style));
        let l = node.final_layout();
        let content_x = origin.0 + f64::from(l.border.left + l.padding.left);
        let Some((baseline, ascent)) = self.first_baseline(node) else {
            return Vec::new();
        };
        let baseline = origin.1 + baseline;
        let id = self.layer_id(node, "marker");
        let fill = Value::String(super::util::hex_of(color));
        match (&item.marker, &item.position) {
            (Marker::Char(c), ListItemLayoutPosition::Outside(_))
            | (Marker::Char(c), ListItemLayoutPosition::Inside)
                if matches!(c, '\u{2022}' | '\u{25e6}' | '\u{25aa}') =>
            {
                let inside = matches!(item.position, ListItemLayoutPosition::Inside);
                let ascent = ascent.round();
                let d = ((ascent * 2.0 / 3.0).floor() + 1.0).div_euclid(2.0);
                let d = d.max(1.0);
                let top = baseline - ascent
                    + (3.0 * (ascent - (ascent * 2.0 / 3.0).floor()) / 2.0).floor();
                let x = if inside {
                    content_x
                } else {
                    content_x - 7.0 - 2.0 * d
                };
                match c {
                    '\u{2022}' => vec![super::util::Layer::new(&id, "shape")
                        .set("shape", json!({ "kind": "ellipse", "width": num(d), "height": num(d) }))
                        .set("fill", fill)
                        .at(x, top)
                        .build()],
                    '\u{25e6}' => vec![super::util::Layer::new(&id, "shape")
                        .set("shape", json!({ "kind": "ellipse", "width": num(d - 1.0), "height": num(d - 1.0) }))
                        .set("stroke", json!({ "color": super::util::hex_of(color), "width": 1 }))
                        .at(x + 0.5, top + 0.5)
                        .build()],
                    _ => vec![super::util::Layer::new(&id, "shape")
                        .set("shape", json!({ "kind": "rect", "width": num(d), "height": num(d) }))
                        .set("fill", fill)
                        .at(x, top)
                        .build()],
                }
            }
            (Marker::String(_), ListItemLayoutPosition::Outside(layout))
            | (Marker::Char(_), ListItemLayoutPosition::Outside(layout)) => {
                // A text marker ends where the content starts, on the first baseline.
                let scale = f64::from(layout.scale()).max(1e-6);
                let width = f64::from(layout.full_width()) / scale;
                let mut runs: Vec<Value> = Vec::new();
                let mut first_base = 0.0;
                for (n, line) in layout.lines().enumerate() {
                    for it in line.items() {
                        let parley::PositionedLayoutItem::GlyphRun(gr) = it else {
                            continue;
                        };
                        if n == 0 && first_base == 0.0 {
                            first_base = f64::from(gr.baseline()) / scale;
                        }
                        let run = gr.run();
                        let Some(src) = self.font_path(run.font()) else {
                            self.report(
                                node,
                                "list-style-type",
                                "marker",
                                "the marker's font is not a project font file",
                            );
                            return Vec::new();
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
                        runs.push(json!({ "src": src, "index": run.font().index, "size": num(f64::from(run.font_size()) / scale), "glyphs": glyphs }));
                    }
                }
                if runs.is_empty() {
                    return Vec::new();
                }
                vec![
                    super::util::Layer::new(&id, "text")
                        .set("color", fill)
                        .set("boxWidth", num(width))
                        .set("boxHeight", num(f64::from(layout.height()) / scale))
                        .set("runs", Value::Array(runs))
                        // The marker's string ends in a space Blitz's layout trims.
                        .at(
                            content_x
                                - width
                                - f64::from(style.get_font().font_size.computed_size().px()) * 0.26,
                            baseline - first_base,
                        )
                        .build(),
                ]
            }
            _ => {
                self.report(
                    node,
                    "list-style-position",
                    "inside",
                    "an inside marker in the bundled bullet font is not drawn",
                );
                Vec::new()
            }
        }
    }

    // ---- the canvas ----

    /// The node whose background paints the canvas (the root, or the body when
    /// the root has none), and whether it is the body.
    pub fn canvas_background(
        &mut self,
        root: &'a Node,
        body: Option<&'a Node>,
    ) -> Option<(&'a Node, bool)> {
        let has_bg = |n: &Node| {
            n.primary_styles().is_some_and(|s| {
                let bg = s.get_background();
                let current = super::util::current_color(&s);
                super::util::rgba(&super::util::resolve_color(&bg.background_color, &current))[3]
                    > 0.0
                    || bg
                        .background_image
                        .0
                        .iter()
                        .any(|i| !matches!(i, style::values::computed::Image::None))
            })
        };
        if has_bg(root) {
            self.canvas_node = Some(root.id);
            return Some((root, false));
        }
        let body = body?;
        if has_bg(body) {
            self.canvas_node = Some(body.id);
            return Some((body, true));
        }
        None
    }

    /// The background of `source` over the whole canvas.
    pub fn canvas_layers(&mut self, source: &'a Node, viewport: (f64, f64)) -> Vec<Value> {
        let Some(style) = source.primary_styles() else {
            return Vec::new();
        };
        let mut geom = box_geom(source, &style);
        // The canvas is the painting and positioning area (the root element's
        // box for the positioning area; a body's background is positioned
        // against the root element's box).
        let root = self.doc.root_element();
        let (w, h) = (
            f64::from(root.final_layout().size.width).max(viewport.0),
            f64::from(root.final_layout().size.height).max(viewport.1),
        );
        geom.w = w;
        geom.h = h;
        geom.border = [0.0; 4];
        geom.padding = [0.0; 4];
        geom.radii = super::geom::Radii::ZERO;
        self.background(source, &style, &geom)
    }

    pub fn note_reach(&mut self, reach: f64) {
        self.margin_reach = self.margin_reach.max(reach);
    }
}

/// The `url()` filters among a canvas's commands, also inside the canvases
/// they draw: the context wrote them in `unsupportedFilter` because it could
/// not have the renderer draw them.
fn url_filters(commands: &Value, out: &mut Vec<String>) {
    for command in commands.as_array().into_iter().flatten() {
        if let Some(url) = command.get("unsupportedFilter").and_then(Value::as_str) {
            out.push(url.to_string());
        }
        if let Some(inner) = command.pointer("/source/commands") {
            url_filters(inner, out);
        }
    }
}
