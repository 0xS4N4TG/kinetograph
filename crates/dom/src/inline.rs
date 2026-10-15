//! Inline elements: horizontal margin, border and padding, and the boxes an
//! inline element occupies.
//!
//! Blitz lays an inline element (`<span>`, `<b>`, `<a>`) out as a style span in
//! its inline root's text, and ignores its horizontal margin, border and
//! padding: the text of `a <span style="padding: 0 20px">b</span> c` runs on as
//! `a b c`. Chrome moves it. [`add_edge_spacers`] gives the text those widths
//! with zero-height `inline-block`s (`<kg-spacer>`): the margin of each side
//! outside the element, its border and padding inside it. Lines then break and
//! the following text moves as in Chrome, and the element's line fragments
//! (which Blitz takes as the union of the glyphs and inline boxes inside it)
//! cover its border box: a fragment that starts the element includes the left
//! edge, one that ends it the right edge, as `box-decoration-break: slice` has it.
//!
//! [`fragments`] gives those fragments the way Chrome's
//! `getClientRects()` does: the content area of the element's font (ascent
//! plus descent, not the line), grown by the vertical padding and border.

use blitz_dom::{BaseDocument, Node, NodeId};
use style::computed_values::direction::T as Direction;
use style::values::computed::length::CSSPixelLength;

use crate::readback::Rect;

/// The tag of the helper boxes. The painter skips them.
pub const SPACER_TAG: &str = "kg-spacer";

/// The edges an inline element adds to its text, in CSS pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Edges {
    pub margin_left: f32,
    pub margin_right: f32,
    pub border_left: f32,
    pub border_right: f32,
    pub padding_left: f32,
    pub padding_right: f32,
    pub padding_top: f32,
    pub padding_bottom: f32,
    pub border_top: f32,
    pub border_bottom: f32,
}

impl Edges {
    fn horizontal(&self) -> bool {
        [
            self.margin_left,
            self.margin_right,
            self.border_left,
            self.border_right,
            self.padding_left,
            self.padding_right,
        ]
        .iter()
        .any(|v| *v != 0.0)
    }
}

/// The margin, border and padding of an element, with percentages taken
/// against `basis` (the width of the containing block).
pub fn edges(node: &Node, basis: f32) -> Option<Edges> {
    let styles = node.primary_styles()?;
    let basis = CSSPixelLength::new(basis);
    let margin = styles.get_margin();
    let padding = styles.get_padding();
    let border = styles.get_border();
    let m = |side: &style::values::computed::Margin| match side {
        style::values::computed::Margin::LengthPercentage(lp) => lp.resolve(basis).px(),
        _ => 0.0,
    };
    let p =
        |side: &style::values::computed::NonNegativeLengthPercentage| side.0.resolve(basis).px();
    // A side with `border-style: none` or `hidden` has no width, whatever its
    // `border-width` (medium, 3px, by default).
    let b = |style: &style::values::computed::BorderStyle,
             width: &style::values::computed::BorderSideWidth| {
        use style::values::computed::BorderStyle;
        match style {
            BorderStyle::None | BorderStyle::Hidden => 0.0,
            _ => width.0.to_f32_px(),
        }
    };
    Some(Edges {
        margin_left: m(&margin.margin_left),
        margin_right: m(&margin.margin_right),
        padding_left: p(&padding.padding_left),
        padding_right: p(&padding.padding_right),
        padding_top: p(&padding.padding_top),
        padding_bottom: p(&padding.padding_bottom),
        border_left: b(&border.border_left_style, &border.border_left_width),
        border_right: b(&border.border_right_style, &border.border_right_width),
        border_top: b(&border.border_top_style, &border.border_top_width),
        border_bottom: b(&border.border_bottom_style, &border.border_bottom_width),
    })
}

/// The width the inline elements of `root` resolve percentages against: the
/// content width of the inline root that holds them.
fn containing_width(doc: &BaseDocument, node: &Node) -> f32 {
    node.inline_root_ancestor()
        .map(|root| {
            let l = root.final_layout();
            (l.size.width - l.padding.left - l.padding.right - l.border.left - l.border.right)
                .max(0.0)
        })
        .or_else(|| {
            node.parent
                .and_then(|p| doc.get_node(p))
                .map(|p| p.final_layout().size.width)
        })
        .unwrap_or(0.0)
}

/// Gives every non-atomic inline element with horizontal margin, border or
/// padding the spacer boxes that make the text move. Returns how many
/// elements got spacers; the caller resolves again when it is not 0.
pub fn add_edge_spacers(doc: &mut BaseDocument) -> usize {
    use blitz_dom::{LocalName, QualName, ns};

    struct Job {
        id: NodeId,
        outer: (f32, f32),
        inner: (f32, f32),
    }
    let mut jobs = Vec::new();
    for (id, node) in doc.tree().iter() {
        if !node.is_non_atomic_inline() || node.has_attr_spacer() {
            continue;
        }
        let basis = containing_width(doc, node);
        let Some(e) = edges(node, basis) else {
            continue;
        };
        if !e.horizontal() {
            continue;
        }
        // The left and right of the box are the start and end of its text
        // in a left-to-right element, the other way round in a right-to-left one.
        let rtl = node
            .primary_styles()
            .is_some_and(|s| s.get_inherited_box().direction == Direction::Rtl);
        let (outer_l, outer_r) = (e.margin_left, e.margin_right);
        let (inner_l, inner_r) = (
            e.border_left + e.padding_left,
            e.border_right + e.padding_right,
        );
        let (outer, inner) = if rtl {
            ((outer_r, outer_l), (inner_r, inner_l))
        } else {
            ((outer_l, outer_r), (inner_l, inner_r))
        };
        jobs.push(Job { id, outer, inner });
    }
    let count = jobs.len();
    if count == 0 {
        return 0;
    }
    let mut m = doc.mutate();
    for job in jobs {
        let spacer = |m: &mut blitz_dom::DocumentMutator<'_>, width: f32| {
            m.create_element(
                QualName::new(None, ns!(html), LocalName::from(SPACER_TAG)),
                vec![blitz_dom::Attribute {
                    name: QualName::new(None, ns!(), LocalName::from("style")),
                    value: format!("width: {width}px"),
                }],
            )
        };
        if job.inner.1 != 0.0 {
            let s = spacer(&mut m, job.inner.1);
            m.append_children(job.id, &[s]);
        }
        if job.inner.0 != 0.0 {
            let s = spacer(&mut m, job.inner.0);
            m.prepend_nodes(job.id, &[s]);
        }
        if job.outer.1 != 0.0 {
            let s = spacer(&mut m, job.outer.1);
            m.insert_nodes_after(job.id, &[s]);
        }
        if job.outer.0 != 0.0 {
            let s = spacer(&mut m, job.outer.0);
            m.insert_nodes_before(job.id, &[s]);
        }
    }
    count
}

trait SpacerExt {
    fn has_attr_spacer(&self) -> bool;
}

impl SpacerExt for Node {
    fn has_attr_spacer(&self) -> bool {
        self.element_data()
            .is_some_and(|e| &*e.name.local == SPACER_TAG)
    }
}

/// One line's piece of an inline element, in document coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fragment {
    /// The border box, as `getClientRects()` reports it.
    pub rect: Rect,
    /// The baseline of the line the fragment is on.
    pub baseline: f64,
}

/// The pieces of a non-atomic inline element, one per line, as Chrome's
/// `getClientRects()` gives them. `None` for an element with a box of its own.
pub fn fragments(doc: &BaseDocument, id: NodeId) -> Option<Vec<Fragment>> {
    use blitz_dom::node::TextBrush;
    use parley::PositionedLayoutItem;

    let node = doc.get_node(id)?;
    if !node.is_non_atomic_inline() {
        return None;
    }
    let root = node.inline_root_ancestor()?;
    let text = root.element_data()?.inline_layout_data.as_ref()?;
    let layout = &text.layout;
    let scale = f64::from(layout.scale());
    let (root_x, root_y) = crate::readback::border_box_origin(doc, root.id);
    let l = root.unrounded_layout();
    let origin_x = root_x + f64::from(l.padding.left + l.border.left);
    let origin_y = root_y + f64::from(l.padding.top + l.border.top) + f64::from(text.block_offset);
    let edges = edges(node, containing_width(doc, node)).unwrap_or_default();
    let in_target = |mut at: NodeId| -> bool {
        loop {
            if at == id {
                return true;
            }
            if at == root.id {
                return false;
            }
            match doc.get_node(at).and_then(|n| n.parent) {
                Some(p) => at = p,
                None => return false,
            }
        }
    };

    let mut out = Vec::new();
    for line in layout.lines() {
        let metrics = line.metrics();
        let mut x0 = f64::INFINITY;
        let mut x1 = f64::NEG_INFINITY;
        // The first run in the element sets the content area.
        let mut area: Option<(f64, f64)> = None;
        for item in line.items() {
            match item {
                PositionedLayoutItem::GlyphRun(run) => {
                    let TextBrush { id: owner } = run.style().brush;
                    if !in_target(owner) {
                        continue;
                    }
                    x0 = x0.min(f64::from(run.offset()));
                    x1 = x1.max(f64::from(run.offset() + run.advance()));
                    if area.is_none() {
                        let m = run.run().font_metrics();
                        // Chrome rounds the font's ascent and descent to whole pixels.
                        area = Some((
                            (f64::from(m.ascent) / scale).round() * scale,
                            (f64::from(m.descent) / scale).round() * scale,
                        ));
                    }
                }
                PositionedLayoutItem::InlineBox(b) => {
                    if !in_target(NodeId::from_u64(b.id)) {
                        continue;
                    }
                    x0 = x0.min(f64::from(b.x));
                    x1 = x1.max(f64::from(b.x + b.width));
                }
            }
        }
        if !x0.is_finite() {
            continue;
        }
        // Whitespace at the end of a line hangs past it and is not part of
        // the element's box.
        let visible_end = f64::from(metrics.offset + metrics.advance - metrics.hanging_advance);
        if x1 > visible_end && visible_end > x0 {
            x1 = visible_end;
        }
        let baseline = f64::from(metrics.baseline);
        // An element with spacers but no text of its own (only an inline box)
        // has the line's own ascent and descent.
        let (ascent, descent) = area.unwrap_or((
            baseline - f64::from(metrics.block_min_coord),
            f64::from(metrics.block_max_coord) - baseline,
        ));
        let top = baseline - ascent - scale * f64::from(edges.padding_top + edges.border_top);
        let bottom =
            baseline + descent + scale * f64::from(edges.padding_bottom + edges.border_bottom);
        out.push(Fragment {
            rect: Rect {
                x: origin_x + x0 / scale,
                y: origin_y + top / scale,
                width: (x1 - x0) / scale,
                height: (bottom - top) / scale,
            },
            baseline: origin_y + baseline / scale,
        });
    }
    Some(out)
}
