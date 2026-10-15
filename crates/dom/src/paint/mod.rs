//! The painter (docs/ENGINE.md §4, stream 2): a styled, laid-out Blitz document
//! walked in CSS paint order and written as scene layers.
//!
//! Layout is Blitz's (Stylo styles, taffy boxes, Parley lines); everything
//! here is reading that result and emitting `docs/SCENE.md` layers:
//!
//! - `walk` is CSS 2.1 Appendix E: each stacking context collects its
//!   descendants' backgrounds, floats, inline content, outlines, normal-flow
//!   layers and positioned layers in separate lists (`Phases`) and writes
//!   them in order.
//! - `deco` draws one box (shadows, background, border, outline), `text` the
//!   glyph runs of an inline formatting context, `effects` the stacking
//!   context properties (transform, opacity, filter, clip-path, mask, blend).
//!
//! Anything that cannot be drawn as Chrome would is reported through
//! `Painter::unsupported`, never drawn wrongly.

mod background;
mod border;
mod clip;
mod deco;
mod effects;
mod fonts;
mod geom;
mod gradient;
mod images;
mod mat;
mod replaced;
mod shadow;
mod shim;
pub mod svg;
mod text;
mod util;

pub use fonts::register_font_path;
pub use shim::{kg_properties, register_properties, shim_css};

use std::collections::HashSet;

use blitz_dom::{BaseDocument, Node, local_name};
use blitz_traits::node_id::NodeId;
use serde_json::Value;
use style::computed_values::position::T as Position;
use style::computed_values::visibility::T as Visibility;
use style::values::computed::Float;
use style::values::specified::box_::{DisplayInside, DisplayOutside};

use crate::request::{IslandOutput, IslandRequest, Unsupported};
use geom::{Radii, Rect};

/// Paints a document that `resolve` has styled and laid out.
pub fn paint(doc: &BaseDocument, request: &IslandRequest) -> IslandOutput {
    let mut painter = Painter::new(doc, request);
    let layers = painter.paint_root();
    IslandOutput {
        layers,
        unsupported: painter.unsupported,
        camera: painter.camera,
        margin: (painter.margin_reach > 0.0).then(|| painter.margin_reach.ceil() as u32),
        blend_space: "srgb",
    }
}

/// The lists a stacking context (or an element painted as one) collects before
/// writing them out in CSS paint order (CSS 2.1 Appendix E, steps 4 to 7, with
/// Chrome's normal-flow layers).
#[derive(Default)]
struct Phases {
    /// Backgrounds and borders of in-flow, non-positioned blocks (step 4).
    blocks: Vec<Value>,
    /// Floats, each painted as an atomic unit (step 5).
    floats: Vec<Value>,
    /// Inline content, flex and grid items, replaced content (steps 6 and 7).
    inline: Vec<Value>,
    /// Outlines (step 10).
    outlines: Vec<Value>,
    /// Blocks that clip their overflow: painted after the parent's own
    /// content, in tree order, like Chrome's normal-flow paint layers.
    normal: Vec<Value>,
}

impl Phases {
    fn flatten(self) -> Vec<Value> {
        let mut out = self.blocks;
        out.extend(self.floats);
        out.extend(self.inline);
        out.extend(self.normal);
        out.extend(self.outlines);
        out
    }
}

pub(crate) struct Painter<'a> {
    pub doc: &'a BaseDocument,
    pub req: &'a IslandRequest,
    pub unsupported: Vec<Unsupported>,
    unsupported_seen: HashSet<String>,
    ids: HashSet<String>,
    pub camera: Option<Value>,
    /// The node whose background went to the canvas.
    pub canvas_node: Option<NodeId>,
    /// The farthest a blur reaches past its layer, for the scene's margin.
    pub margin_reach: f64,
    /// The mode (`alpha` or `luminance`) of each mask source group, by id.
    pub mask_modes: std::collections::HashMap<String, &'static str>,
}

/// Where a box's border-box top-left corner is in the current frame.
type Origin = (f64, f64);

impl<'a> Painter<'a> {
    fn new(doc: &'a BaseDocument, req: &'a IslandRequest) -> Painter<'a> {
        Painter {
            doc,
            req,
            unsupported: Vec::new(),
            unsupported_seen: HashSet::new(),
            ids: HashSet::new(),
            camera: None,
            canvas_node: None,
            margin_reach: 0.0,
            mask_modes: Default::default(),
        }
    }

    pub fn node(&self, id: NodeId) -> &'a Node {
        self.doc.get_node(id).expect("a node of the document")
    }

    // ---- identity ----

    /// The value of a `--kg-*` mirror property (`shim`) on `node`, if the
    /// element declared it.
    pub fn kg_value(&self, node: &Node, name: &str) -> Option<String> {
        let v = self.doc.resolved_style_value(node.id, name);
        let v = v.trim();
        (!v.is_empty() && v != "initial").then(|| v.to_string())
    }

    /// The element's host-tree path (`$0.2`): the `data-kg-path` attribute the
    /// front half sets, or a stand-in made from the node's id.
    pub fn path_of(&self, node: &Node) -> String {
        attr(node, "data-kg-path")
            .map(str::to_string)
            .unwrap_or_else(|| format!("n{}", node.id.as_u64()))
    }

    pub fn tag_of(&self, node: &Node) -> String {
        node.element_data()
            .map(|e| e.name.local.to_string())
            .unwrap_or_else(|| "#text".to_string())
    }

    /// A layer id for `node` and `suffix`: the node's explicit `id` attribute
    /// if it is usable, else its path; unique in the island.
    pub fn layer_id(&mut self, node: &Node, suffix: &str) -> String {
        let explicit = attr(node, "id")
            .filter(|id| !id.is_empty() && !id.contains(char::is_whitespace));
        let base = match explicit {
            Some(id) if !self.ids.contains(id) || !suffix.is_empty() => id.to_string(),
            _ => self.path_of(node),
        };
        let mut id = if suffix.is_empty() {
            base.clone()
        } else {
            format!("{base}.{suffix}")
        };
        let mut n = 1;
        while !self.ids.insert(id.clone()) {
            n += 1;
            id = if suffix.is_empty() {
                format!("{base}~{n}")
            } else {
                format!("{base}.{suffix}~{n}")
            };
        }
        id
    }

    /// Reports something that cannot be drawn as Chrome would (once per
    /// element, property and reason).
    pub fn report(&mut self, node: &Node, property: &str, value: impl ToString, reason: &str) {
        let tag = self.tag_of(node);
        let path = format!("{} <{}>", self.path_of(node), tag);
        let value = value.to_string();
        let key = format!("{path}\0{property}\0{reason}\0{value}");
        if !self.unsupported_seen.insert(key) {
            return;
        }
        self.unsupported.push(Unsupported {
            path,
            element: tag,
            property: Some(property.to_string()),
            value: Some(value),
            reason: reason.to_string(),
        });
    }

    /// An element that is not drawn at all.
    pub fn report_element(&mut self, node: &Node, reason: &str) {
        let tag = self.tag_of(node);
        let path = format!("{} <{}>", self.path_of(node), tag);
        let key = format!("{path}\0\0{reason}");
        if !self.unsupported_seen.insert(key) {
            return;
        }
        self.unsupported.push(Unsupported {
            path,
            element: tag,
            property: None,
            value: None,
            reason: reason.to_string(),
        });
    }

    // ---- the root ----

    fn paint_root(&mut self) -> Vec<Value> {
        let root = self.doc.root_element();
        let mut out = Vec::new();
        // The canvas takes the background of the root element, or of the body
        // when the root has none (CSS Backgrounds 3, section 2.11.2).
        let viewport = (
            f64::from(self.req.viewport.width),
            f64::from(self.req.viewport.height),
        );
        let body = self.body_of(root);
        if let Some((source, _from_body)) = self.canvas_background(root, body) {
            out.extend(self.canvas_layers(source, viewport));
        }
        out.extend(self.sc_content(root));
        out
    }

    fn body_of(&self, root: &'a Node) -> Option<&'a Node> {
        root.children
            .iter()
            .map(|id| self.node(*id))
            .find(|n| n.data.is_element_with_tag_name(&local_name!("body")))
    }

    // ---- stacking contexts ----

    /// The layers inside the frame of the stacking context rooted at `sc`
    /// (origin: its border-box corner): its own box, negative z-index
    /// contexts, then the in-flow phases, then the positioned and positive
    /// z-index ones.
    fn sc_content(&mut self, sc: &'a Node) -> Vec<Value> {
        let mut out = Vec::new();
        let mut ph = Phases::default();
        let mut pos: Vec<Value> = Vec::new();
        out.extend(self.decoration(sc, (0.0, 0.0), true));
        if let Some(ctx) = sc.stacking_context.as_ref() {
            for hc in ctx.neg_z_hoisted_children() {
                out.extend(self.hoisted(sc, hc));
            }
        }
        self.walk(sc, (0.0, 0.0), &mut ph, &mut pos);
        out.extend(ph.flatten());
        out.extend(pos);
        if let Some(ctx) = sc.stacking_context.as_ref() {
            for hc in ctx.pos_z_hoisted_children() {
                out.extend(self.hoisted(sc, hc));
            }
        }
        out
    }

    /// A z-indexed context hoisted into `sc`: painted at its place in `sc`'s
    /// frame.
    fn hoisted(&mut self, sc: &'a Node, hc: &blitz_dom::HoistedPaintChild) -> Vec<Value> {
        let child = self.node(hc.node_id);
        let offset = hc.position(self.doc.tree(), sc.id);
        let loc = child.final_layout().location;
        let at = (
            f64::from(offset.x + loc.x),
            f64::from(offset.y + loc.y),
        );
        self.paint_context(child, at)
    }

    /// An element that makes a stacking context, as a group at `at` in its
    /// parent's frame.
    fn paint_context(&mut self, node: &'a Node, at: Origin) -> Vec<Value> {
        let id = self.layer_id(node, "");
        let children = self.sc_content(node);
        match self.context_group(node, &id, at, children) {
            Some(group) => vec![group],
            None => Vec::new(),
        }
    }

    // ---- the walk (CSS 2.1 Appendix E) ----

    /// Collects what `node` (a block-level box or the root of an element
    /// painted atomically) holds into `ph`, and positioned descendants into
    /// `pos`. `origin` is `node`'s border-box corner in the frame.
    fn walk(
        &mut self,
        node: &'a Node,
        origin: Origin,
        ph: &mut Phases,
        pos: &mut Vec<Value>,
    ) {
        let parent_flex = node
            .primary_styles()
            .map(|s| {
                matches!(
                    s.clone_display().inside(),
                    DisplayInside::Flex | DisplayInside::Grid
                )
            })
            .unwrap_or(false);

        if node.flags.is_inline_root() {
            self.paint_inline_root(node, origin, ph, pos);
        }
        // Replaced content (an image, a video) of this box.
        if node.element_data().is_some() && self.is_replaced(node) {
            let layers = self.replaced_content(node, origin);
            ph.inline.extend(layers);
        }
        // List markers.
        if node
            .element_data()
            .is_some_and(|e| e.list_item_data.is_some())
        {
            let layers = self.list_marker(node, origin);
            ph.inline.extend(layers);
        }

        let children: Vec<NodeId> = node
            .paint_children
            .borrow()
            .as_ref()
            .map(|c| c.iter().copied().collect())
            .unwrap_or_default();
        for cid in children {
            let child = self.node(cid);
            let loc = child.final_layout().location;
            let at = (origin.0 + f64::from(loc.x), origin.1 + f64::from(loc.y));
            if child.is_anonymous() {
                // A box Blitz made to hold inline content among blocks: no box
                // of its own to paint.
                self.walk(child, at, ph, pos);
                continue;
            }
            let Some(style) = child.primary_styles() else {
                // An anonymous block: no box of its own.
                self.walk(child, at, ph, pos);
                continue;
            };
            let display = style.clone_display();
            let position = style.clone_position();
            let floated = style.clone_float() != Float::None;
            let positioned = !matches!(position, Position::Static);
            let is_sc = self.is_sc(child, parent_flex);
            let inline_level = display.outside() == DisplayOutside::Inline;
            drop(style);

            if is_sc {
                // z-index 0 / auto contexts (non-zero ones were hoisted).
                let layers = self.paint_context(child, at);
                pos.extend(layers);
            } else if positioned {
                let mark = pos.len();
                let layers = self.paint_atomic(child, at, pos);
                let tail = pos.split_off(mark);
                pos.extend(layers);
                pos.extend(tail);
            } else if floated {
                let layers = self.paint_atomic(child, at, pos);
                ph.floats.extend(layers);
            } else if inline_level && !parent_flex {
                // Atomic inline-level boxes are painted from the inline root's
                // lines, in the order the line has them.
            } else if parent_flex {
                let layers = self.paint_atomic(child, at, pos);
                ph.inline.extend(layers);
            } else if self.clips_overflow(child) {
                let layers = self.paint_atomic(child, at, pos);
                ph.normal.extend(layers);
            } else {
                // A block-level box in flow.
                if self.is_visible(child) {
                    ph.blocks.extend(self.decoration(child, at, false));
                }
                self.walk(child, at, ph, pos);
            }
        }
        // Outline of the box itself (steps 10).
        if node.element_data().is_some() {
            let outline = self.outline(node, origin);
            ph.outlines.extend(outline);
        }
    }

    /// An element painted as one unit (a float, an inline-block, a flex item,
    /// a positioned box, a block that clips): its own box, then its content in
    /// phases. Positioned descendants go to `pos`, the enclosing stacking
    /// context's list.
    fn paint_atomic(&mut self, node: &'a Node, at: Origin, pos: &mut Vec<Value>) -> Vec<Value> {
        let mut out = Vec::new();
        if self.is_visible(node) {
            out.extend(self.decoration(node, at, false));
        }
        let mut ph = Phases::default();
        self.walk_clipped(node, at, &mut ph, pos);
        out.extend(ph.flatten());
        out
    }

    /// `walk`, with the content cut to the box when it clips its overflow.
    fn walk_clipped(&mut self, node: &'a Node, at: Origin, ph: &mut Phases, pos: &mut Vec<Value>) {
        if !self.clips_overflow(node) {
            self.walk(node, at, ph, pos);
            return;
        }
        let mut inner = Phases::default();
        self.walk(node, at, &mut inner, pos);
        let content = inner.flatten();
        if content.is_empty() {
            return;
        }
        let id = self.layer_id(node, "content");
        let clip = self.overflow_clip(node, at);
        let group = util::group(&id, content);
        let group = match clip {
            Some(clip) => group.set("clip", clip),
            None => group,
        };
        ph.inline.push(group.build());
    }

    // ---- small queries ----

    /// Whether `node` makes a stacking context: Blitz's rule plus what it
    /// leaves out (`mix-blend-mode`, `perspective`, `preserve-3d`,
    /// `backdrop-filter`).
    pub fn is_sc(&self, node: &Node, parent_flex: bool) -> bool {
        if node.is_stacking_context_root(parent_flex) {
            return true;
        }
        node.primary_styles().is_some_and(|s| {
            use style::computed_values::mix_blend_mode::T as Blend;
            use style::computed_values::transform_style::T as Style3d;
            use style::values::computed::Perspective;
            let b = s.get_box();
            s.get_effects().mix_blend_mode != Blend::Normal
                || !matches!(b.perspective, Perspective::None)
                || b.transform_style == Style3d::Preserve3d
                || !s.get_effects().backdrop_filter.0.is_empty()
        })
    }

    pub fn is_visible(&self, node: &Node) -> bool {
        node.primary_styles()
            .map(|s| s.clone_visibility() == Visibility::Visible)
            .unwrap_or(true)
    }

    pub fn is_replaced(&self, node: &Node) -> bool {
        let Some(e) = node.element_data() else {
            return false;
        };
        let t = &e.name.local;
        *t == local_name!("img")
            || *t == local_name!("video")
            || *t == local_name!("canvas")
            || *t == local_name!("svg")
    }

    fn clips_overflow(&self, node: &Node) -> bool {
        node.primary_styles().is_some_and(|s| {
            use style::computed_values::overflow_x::T as Overflow;
            let b = s.get_box();
            b.overflow_x != Overflow::Visible || b.overflow_y != Overflow::Visible
        })
    }
}

/// An attribute of an element, by name.
pub fn attr<'n>(node: &'n Node, name: &str) -> Option<&'n str> {
    node.element_data()?
        .attrs()
        .iter()
        .find(|a| &*a.name.local == name)
        .map(|a| &*a.value)
}

/// The border-box size of a laid-out node.
pub fn box_size(node: &Node) -> (f64, f64) {
    let l = node.final_layout();
    (f64::from(l.size.width), f64::from(l.size.height))
}
