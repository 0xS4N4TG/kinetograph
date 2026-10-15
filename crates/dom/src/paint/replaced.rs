//! Replaced content: `<img>`, `<video>`, `<canvas>`, list markers, and the
//! canvas background.

use blitz_dom::{Node, local_name};
use serde_json::{Value, json};
use style::computed_values::object_fit::T as ObjectFit;

use super::deco::box_geom;
use super::geom::{Rect, Region};
use super::images::Source;
use super::util::{Layer, lp, num};
use super::{Origin, Painter};

impl<'a> Painter<'a> {
    /// The picture or video of a replaced element, in its content box.
    pub fn replaced_content(&mut self, node: &'a Node, origin: Origin) -> Vec<Value> {
        let Some(style) = node.primary_styles() else { return Vec::new() };
        if !self.is_visible(node) {
            return Vec::new();
        }
        let Some(el) = node.element_data() else { return Vec::new() };
        let tag = &el.name.local;
        let geom = box_geom(node, &style);
        let (content, radii) = geom.region(Region::Content);
        if content.is_empty() {
            return Vec::new();
        }

        if *tag == local_name!("canvas") {
            self.report_element(node, "a <canvas> is not drawn yet");
            return Vec::new();
        }
        let is_video = *tag == local_name!("video");
        let src_attr = el.attr(local_name!("src")).map(str::to_string);
        let Some(src_attr) = src_attr else {
            return Vec::new();
        };

        let (path, nw, nh) = if is_video {
            let Some(p) = self.resolve_relative(&src_attr).or_else(|| {
                // A file: URL.
                url::Url::parse(&src_attr).ok().and_then(|u| u.to_file_path().ok())
            }) else {
                self.report(node, "src", &src_attr, "the video file is not in the project");
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
        let lx = origin.0 + content.x + pic.x;
        let ly = origin.1 + content.y + pic.y;
        layer = layer.at(lx, ly);
        let mut layer = layer.build();
        // Cut to the content box when the picture overflows it, or the box is rounded.
        if needs_clip || !radii.is_zero() {
            let clip_rect = Rect::new(origin.0 + content.x, origin.1 + content.y, content.w, content.h);
            self.clip_layer(&mut layer, clip_rect, radii);
        }
        vec![layer]
    }

    /// List markers: discs, circles and squares are shapes; numbers are text.
    pub fn list_marker(&mut self, node: &'a Node, _origin: Origin) -> Vec<Value> {
        let _ = node;
        Vec::new()
    }

    // ---- the canvas ----

    /// The node whose background paints the canvas (the root, or the body when
    /// the root has none), and whether it is the body.
    pub fn canvas_background(&mut self, root: &'a Node, body: Option<&'a Node>) -> Option<(&'a Node, bool)> {
        let has_bg = |n: &Node| {
            n.primary_styles().is_some_and(|s| {
                let bg = s.get_background();
                let current = super::util::current_color(&s);
                super::util::rgba(&super::util::resolve_color(&bg.background_color, &current))[3] > 0.0
                    || bg.background_image.0.iter().any(|i| !matches!(i, style::values::computed::Image::None))
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
        let Some(style) = source.primary_styles() else { return Vec::new() };
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
