//! `-webkit-line-clamp`: a box that cuts its text at N lines.
//!
//! Chrome's legacy box (`display: -webkit-box; -webkit-box-orient: vertical;
//! -webkit-line-clamp: N`) lays its lines out as a block does, then makes its
//! height the bottom of the Nth line (when its `height` is `auto`) and puts an
//! ellipsis at the end of that line when more lines follow. The lines after
//! the Nth are still laid out and painted: they overflow the box, and show
//! unless the box clips them. The count runs across the box's in-flow block
//! children (`<p>`s), not per child.
//!
//! Stylo's Servo build does not parse the three properties, so the shim
//! (`paint::shim_css`) mirrors them into `--kg-line-clamp`, `--kg-box-orient`
//! and `--kg-display`. [`settle`] runs after the first layout: it makes each
//! such box a block formatting context (as Chrome does), lays out again, finds
//! the boxes whose lines pass the clamp, gives each a `height`, lays out once
//! more and records the line to end with an ellipsis in the [`CLAMP_ATTR`]
//! attribute, which the painter reads (`paint::ellipsis`).

use crate::paint::attr;
use crate::request::{DomNode, IslandRequest};
use blitz_dom::{BaseDocument, LocalName, Node, NodeId, QualName, ns};
use style::computed_values::box_sizing::T as BoxSizing;
use style::computed_values::position::T as Position;
use style::values::computed::Float;
use style::values::specified::box_::{DisplayInside, DisplayOutside};

/// On a clamped box whose text passes the clamp: `<root id>:<line index>`, the
/// inline formatting context and its line that end with the ellipsis.
pub const CLAMP_ATTR: &str = "data-kg-clamp";

/// The line count of a box that clamps, and whether it is the inline kind:
/// `display: -webkit-box` (or `-webkit-inline-box`), `-webkit-box-orient:
/// vertical` (or `block-axis`) and a positive integer `-webkit-line-clamp`.
fn lines_of(doc: &BaseDocument, id: NodeId) -> Option<(usize, bool)> {
    let value = |name: &str| doc.resolved_style_value(id, name);
    let n: usize = value("--kg-line-clamp").trim().parse().ok()?;
    let display = value("--kg-display").to_ascii_lowercase();
    let display = display.trim();
    let orient = value("--kg-box-orient").to_ascii_lowercase();
    (n > 0
        && matches!(display, "-webkit-box" | "-webkit-inline-box")
        && matches!(orient.trim(), "vertical" | "block-axis"))
    .then_some((n, display == "-webkit-inline-box"))
}

/// The line the clamp ends the box at.
struct Cut {
    root: NodeId,
    line: usize,
    /// The bottom of the line, from the top of the clamped box's border box.
    bottom: f32,
}

/// An in-flow block-level box that the clamp counts the lines of.
fn counts_lines(node: &Node) -> bool {
    let Some(style) = node.primary_styles() else {
        return false;
    };
    let display = style.clone_display();
    display.outside() == DisplayOutside::Block
        && matches!(
            display.inside(),
            DisplayInside::Flow | DisplayInside::FlowRoot
        )
        && style.clone_float() == Float::None
        && !matches!(style.clone_position(), Position::Absolute | Position::Fixed)
}

/// Walks the lines of `id`'s inline formatting contexts (itself, or those of
/// its in-flow block descendants) in order, counting up to `want`; `y` is the
/// top of `id`'s border box in the clamped box's. Returns the cut once the
/// `want`th line has been passed and another line follows.
fn walk(
    doc: &BaseDocument,
    id: NodeId,
    y: f32,
    seen: &mut usize,
    want: usize,
    found: &mut Option<Cut>,
) -> bool {
    let Some(node) = doc.get_node(id) else {
        return false;
    };
    if let Some(ild) = node
        .element_data()
        .and_then(|el| el.inline_layout_data.as_ref())
    {
        let l = node.final_layout();
        let top = y + l.border.top + l.padding.top + ild.block_offset;
        let scale = ild.layout.scale().max(1e-6);
        for (i, line) in ild.layout.lines().enumerate() {
            if *seen == want {
                // A line after the cut.
                return true;
            }
            *seen += 1;
            if *seen == want {
                *found = Some(Cut {
                    root: id,
                    line: i,
                    bottom: top + line.metrics().block_max_coord / scale,
                });
            }
        }
        return false;
    }
    let children = node.layout_children.borrow().clone().unwrap_or_default();
    for child in children {
        let Some(c) = doc.get_node(child) else {
            continue;
        };
        if !counts_lines(c) && !c.is_anonymous() {
            continue;
        }
        if walk(
            doc,
            child,
            y + c.final_layout().location.y,
            seen,
            want,
            found,
        ) {
            return true;
        }
    }
    false
}

/// Whether any CSS of `request` mentions `-webkit-line-clamp`: the test that
/// lets a frame without one skip [`settle`].
pub fn requested(request: &IslandRequest) -> bool {
    const NAME: &str = "line-clamp";
    fn node(n: &DomNode) -> bool {
        match n {
            DomNode::Text { text } => text.contains(NAME),
            DomNode::Native { .. } => false,
            DomNode::Element {
                attrs,
                style,
                children,
                ..
            } => {
                style.contains(NAME)
                    || attrs.get("style").is_some_and(|s| s.contains(NAME))
                    || children.iter().any(node)
            }
        }
    }
    request.stylesheets.iter().any(|s| s.contains(NAME)) || node(&request.root)
}

/// Clamps the document and lays it out again as often as that needs (two
/// rounds at most; the third `apply` only confirms there is nothing left).
pub fn settle(doc: &mut BaseDocument, time: f64) {
    for _ in 0..3 {
        if apply(doc) == 0 {
            break;
        }
        doc.resolve(time);
    }
}

/// What [`apply`] changes on a box.
struct Edit {
    id: NodeId,
    display: Option<&'static str>,
    mark: Option<String>,
    height: Option<f32>,
}

/// Clamps every box whose lines pass its `-webkit-line-clamp`, as described in
/// the module docs. Returns how many changes it made; when it is not zero the
/// document has to be laid out again and `apply` called once more (a box first
/// becomes a block formatting context, as Chrome makes it, which moves its
/// lines; the next call measures them).
pub fn apply(doc: &mut BaseDocument) -> usize {
    let ids: Vec<NodeId> = doc
        .tree()
        .iter()
        // A box that has no style (`display: none`) has no lines either.
        .filter(|(_, n)| n.is_element() && n.flags.is_in_document() && n.primary_styles().is_some())
        .map(|(id, _)| id)
        .collect();
    let mut edits = Vec::new();
    for id in ids {
        let Some((want, inline)) = lines_of(doc, id) else {
            continue;
        };
        let node = doc.get_node(id).expect("a node");
        let (display, auto_height, border_box) = {
            let style = node.primary_styles().expect("a styled node");
            (
                style.clone_display(),
                style.get_position().height.is_auto(),
                style.get_position().box_sizing == BoxSizing::BorderBox,
            )
        };
        // Chrome lays the box out as `flow-root` (`inline-block` for the
        // inline kind): its first and last children's margins stay inside it.
        if display.inside() != DisplayInside::FlowRoot
            || (display.outside() == DisplayOutside::Inline) != inline
        {
            edits.push(Edit {
                id,
                display: Some(if inline { "inline-block" } else { "flow-root" }),
                mark: None,
                height: None,
            });
            continue;
        }
        let mut seen = 0;
        let mut found = None;
        if !walk(doc, id, 0.0, &mut seen, want, &mut found) {
            continue;
        }
        let Some(cut) = found else {
            continue;
        };
        let l = node.final_layout();
        // The `height` that puts the box's bottom at the line's.
        let height = if border_box {
            cut.bottom + l.padding.bottom + l.border.bottom
        } else {
            cut.bottom - l.border.top - l.padding.top
        };
        let mark = format!("{}:{}", cut.root.as_u64(), cut.line);
        if attr(node, CLAMP_ATTR) == Some(mark.as_str()) && !auto_height {
            continue;
        }
        edits.push(Edit {
            id,
            display: None,
            mark: Some(mark),
            height: auto_height.then_some(height.max(0.0)),
        });
    }
    let n = edits.len();
    let mut m = doc.mutate();
    for e in edits {
        if let Some(display) = e.display {
            m.set_style_property(e.id, "display", display);
        }
        if let Some(mark) = e.mark {
            m.set_attribute(
                e.id,
                QualName::new(None, ns!(), LocalName::from(CLAMP_ATTR)),
                &mark,
            );
        }
        if let Some(height) = e.height {
            m.set_style_property(e.id, "height", &format!("{height}px"));
        }
    }
    n
}
