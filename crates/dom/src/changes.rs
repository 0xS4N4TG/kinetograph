//! What changed in an edited document since its last paint: the nodes whose
//! style values, box, attributes or text differ, and the ones that came or
//! went. The painter replays a stacking context's content from that paint
//! when nothing in it changed (`paint::retain`).

use std::collections::{HashMap, HashSet};

use blitz_dom::{BaseDocument, Node, NodeId, ns};
use style::properties::{ComputedValues, LonghandId};
use style::servo_arc::Arc as ServoArc;

/// A node's computed style, box and place in the tree as a paint saw them.
/// The style is held, so another one cannot take its place in memory.
pub struct Stamp {
    node: NodeId,
    parent: Option<NodeId>,
    layout_parent: Option<NodeId>,
    style: Option<ServoArc<ComputedValues>>,
    layout: Option<taffy::Layout>,
}

/// A node's box; text and comments have none.
fn layout_of(node: &Node) -> Option<taffy::Layout> {
    use blitz_dom::node::NodeData;
    matches!(
        node.data,
        NodeData::Element(_) | NodeData::AnonymousBlock(_) | NodeData::Document(_)
    )
    .then(|| *node.final_layout())
}

/// The stamps of every node of `doc`, in id order.
pub fn stamps(doc: &BaseDocument) -> Vec<Stamp> {
    let mut stamps: Vec<Stamp> = doc
        .tree()
        .iter()
        .map(|(_, node)| Stamp {
            node: node.id,
            parent: node.parent,
            layout_parent: node.layout_parent.get(),
            style: node.primary_styles().map(|s| (*s).clone()),
            layout: layout_of(node),
        })
        .collect();
    stamps.sort_by_key(|s| s.node.as_u64());
    stamps
}

/// The properties that only make a stacking context's group: a change to
/// them leaves the content inside the group as it was.
const GROUP_PROPERTIES: [LonghandId; 8] = [
    LonghandId::Transform,
    LonghandId::Translate,
    LonghandId::Rotate,
    LonghandId::Scale,
    LonghandId::TransformOrigin,
    LonghandId::Opacity,
    LonghandId::Filter,
    LonghandId::MixBlendMode,
];

/// The changed nodes of a document, for the painter.
pub struct Changes {
    /// Each changed node, and whether the change is to its group alone (its
    /// style differs in [`GROUP_PROPERTIES`], its box in its place, and no
    /// edit set its attributes or text).
    dirty: HashMap<NodeId, bool>,
    /// The nodes a changed node is strictly inside (or that lost a child).
    above: HashSet<NodeId>,
}

impl Changes {
    /// Whether `node` changed, and if so whether only in its group.
    pub fn of(&self, node: NodeId) -> Option<bool> {
        self.dirty.get(&node).copied()
    }

    /// Whether a node strictly inside `node` changed.
    pub fn inside(&self, node: NodeId) -> bool {
        self.above.contains(&node)
    }
}

/// The parent a node is painted under: its element, or the box Blitz made round it.
fn up(node: &Node) -> Option<NodeId> {
    node.parent.or(node.layout_parent.get())
}

/// Whether `node` is part of what an SVG reference can name: an SVG element
/// with an `id` at or above it (a gradient, a clip path, a filter or a
/// symbol, painted wherever a `url(#id)` or an `href` names it).
fn referable(doc: &BaseDocument, node: &Node) -> bool {
    let mut cur = Some(node);
    while let Some(n) = cur {
        if let Some(e) = n.element_data()
            && e.name.ns == ns!(svg)
            && e.attrs()
                .iter()
                .any(|a| &*a.name.local == "id" && !a.value.is_empty())
        {
            return true;
        }
        cur = n.parent.and_then(|p| doc.get_node(p));
    }
    false
}

/// Whether a style change reaches past the element's own box in what the
/// painter reads: a text decoration its descendants' text draws, a mirror
/// property it walks up to, or what stops either (`float`, `position`,
/// `display`, which also numbers list items).
fn reaches_out(was: &ComputedValues, now: &ComputedValues) -> bool {
    use style::values::computed::text::TextDecorationLine;
    let decorated =
        |s: &ComputedValues| s.get_text().text_decoration_line != TextDecorationLine::NONE;
    !was.float_equals(now)
        || !was.position_equals(now)
        || !was.display_equals(now)
        || was.custom_properties().non_inherited != now.custom_properties().non_inherited
        || ((decorated(was) || decorated(now))
            && !(was.text_decoration_line_equals(now)
                && was.text_decoration_style_equals(now)
                && was.text_decoration_color_equals(now)
                && was.text_decoration_thickness_equals(now)
                && was.color_equals(now)
                && was.font_size_equals(now)))
}

/// Whether two boxes differ in their place alone.
fn moved_only(was: &taffy::Layout, now: &taffy::Layout) -> bool {
    taffy::Layout {
        location: now.location,
        ..*was
    } == *now
}

/// The changes between `stamps` (the last paint) and `doc`, given the nodes
/// an edit set an attribute (other than `style`) or the text of since then.
/// None when a change can reach anything: one to what an SVG reference can
/// name ([`referable`]), or one that [`reaches_out`].
pub fn changes(doc: &BaseDocument, stamps: &[Stamp], touched: &[NodeId]) -> Option<Changes> {
    let mut dirty: HashMap<NodeId, bool> = HashMap::new();
    let stamp_at = |id: u64| {
        stamps
            .binary_search_by_key(&id, |s| s.node.as_u64())
            .ok()
            .map(|i| &stamps[i])
    };
    // The same node in the same place: a slot Blitz freed and filled again is another node.
    let same_node = |s: &Stamp, node: &Node| {
        s.parent == node.parent && s.layout_parent == node.layout_parent.get()
    };
    for (_, node) in doc.tree().iter() {
        let Some(stamp) = stamp_at(node.id.as_u64()).filter(|s| same_node(s, node)) else {
            if referable(doc, node) {
                return None;
            }
            dirty.insert(node.id, false);
            continue;
        };
        let group_style = match (&stamp.style, node.primary_styles()) {
            (None, None) => None,
            (Some(was), Some(now)) => {
                let now: &ServoArc<ComputedValues> = &now;
                if ServoArc::ptr_eq(was, now) || was.same_values_except(now, &[]) {
                    None
                } else if referable(doc, node) || reaches_out(was, now) {
                    return None;
                } else {
                    Some(
                        same_group_kind(was, now) && was.same_values_except(now, &GROUP_PROPERTIES),
                    )
                }
            }
            _ => Some(false),
        };
        let layout = layout_of(node);
        let group_box = match (&stamp.layout, &layout) {
            (was, now) if was == now => None,
            (Some(was), Some(now)) => Some(moved_only(was, now)),
            _ => Some(false),
        };
        if group_style.is_some() || group_box.is_some() {
            dirty.insert(
                node.id,
                group_style.unwrap_or(true) && group_box.unwrap_or(true),
            );
        }
    }
    for &id in touched {
        let Some(node) = doc.get_node(id) else {
            continue;
        };
        if referable(doc, node) {
            return None;
        }
        dirty.insert(id, false);
    }
    // Everything a changed node is inside, and everything a node that went was inside.
    let mut above: HashSet<NodeId> = HashSet::new();
    let mark_from = |above: &mut HashSet<NodeId>, mut cur: Option<NodeId>| {
        while let Some(id) = cur {
            if !above.insert(id) {
                break;
            }
            cur = doc.get_node(id).and_then(up);
        }
    };
    for &id in dirty.keys() {
        mark_from(&mut above, doc.get_node(id).and_then(up));
    }
    for stamp in stamps {
        let gone = doc
            .get_node(stamp.node)
            .is_none_or(|n| !same_node(stamp, n));
        if gone {
            // Its parent (or, if that went too, the first of the stamps' parents that is still there).
            let mut parent = stamp.parent.or(stamp.layout_parent);
            while let Some(p) = parent {
                match (doc.get_node(p), stamp_at(p.as_u64())) {
                    (Some(n), Some(s)) if same_node(s, n) => break,
                    (_, Some(s)) => parent = s.parent.or(s.layout_parent),
                    (_, None) => parent = None,
                }
            }
            mark_from(&mut above, parent);
        }
    }
    Some(Changes { dirty, above })
}

/// Whether two styles of an element both have a transform or both have none,
/// and the same for a filter: a transform or a filter makes the element the
/// containing block of its fixed descendants, which changes what it paints.
fn same_group_kind(was: &ComputedValues, now: &ComputedValues) -> bool {
    use style::values::computed::{Rotate, Scale, Translate};
    let transformed = |s: &ComputedValues| {
        let b = s.get_box();
        !b.transform.0.is_empty()
            || !matches!(b.translate, Translate::None)
            || !matches!(b.rotate, Rotate::None)
            || !matches!(b.scale, Scale::None)
    };
    let filtered = |s: &ComputedValues| !s.get_effects().filter.0.is_empty();
    transformed(was) == transformed(now) && filtered(was) == filtered(now)
}
