//! What the DOM shim of the TS side asks the laid-out document: boxes for
//! `offsetWidth`, `getBoundingClientRect`, `clientWidth`, `scrollHeight` and
//! `ResizeObserver` (docs/ENGINE.md §2), and computed styles for
//! `getComputedStyle`.

use std::collections::BTreeMap;

use blitz_dom::{BaseDocument, Node, NodeId};
use serde::Serialize;

use crate::document::IslandDocument;
use crate::transform::{self, Matrix};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

/// One element's boxes, in island coordinates (the island's containing box is
/// at the origin).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct ElementBox {
    /// The border box where layout put it: `offsetLeft`/`Top`/`Width`/`Height`
    /// measured from the island, ignoring `transform`s.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// The transformed bounding box, as `getBoundingClientRect` gives.
    pub rect: Rect,
    /// `clientWidth`, `clientHeight`: the padding box, whole pixels.
    pub client: Size,
    /// `scrollWidth`, `scrollHeight`: the content including overflow, whole pixels.
    pub scroll: Size,
}

/// The boxes of every element and native placeholder, by host-tree path.
/// An element without a box (`display: none`, `display: contents`) is all zeros.
pub fn layout_boxes(island: &IslandDocument) -> BTreeMap<String, ElementBox> {
    let origin = border_box_origin(&island.doc, island.container);
    island
        .paths
        .iter()
        .map(|(path, id)| (path.clone(), element_box(&island.doc, *id, origin)))
        .collect()
}

/// The box of one node; `origin` is the island container's position, which is
/// the island's origin.
pub fn element_box(doc: &BaseDocument, id: NodeId, origin: (f64, f64)) -> ElementBox {
    let Some(node) = doc.get_node(id) else {
        return ElementBox::default();
    };
    if !node.has_boxes() {
        return ElementBox::default();
    }

    // A non-atomic inline has no box of its own: its boxes are the fragments
    // of the lines it sits on.
    if let Some(fragments) = fragments(doc, node) {
        let Some(union) = fragments.into_iter().reduce(union) else {
            return ElementBox::default();
        };
        let offset = Rect {
            x: union.x - origin.0,
            y: union.y - origin.1,
            width: union.width,
            height: union.height,
        };
        // Transforms on the inline's ancestors still apply to its fragments.
        let rect = match node
            .inline_root_ancestor()
            .and_then(|root| ctm(doc, root.id))
        {
            Some(m) => {
                let root_pos = border_box_origin(doc, node.inline_root_ancestor().unwrap().id);
                transformed(&m, root_pos, offset, origin)
            }
            None => offset,
        };
        return ElementBox {
            x: offset.x,
            y: offset.y,
            width: offset.width,
            height: offset.height,
            rect,
            client: Size::default(),
            scroll: Size::default(),
        };
    }

    let layout = node.unrounded_layout();
    let (px, py) = border_box_origin(doc, id);
    let offset = Rect {
        x: px - origin.0,
        y: py - origin.1,
        width: f64::from(layout.size.width),
        height: f64::from(layout.size.height),
    };
    let rect = match ctm(doc, id) {
        Some(m) => {
            match transform::bounding_box(&m, offset.width, offset.height) {
                Some((x, y, w, h)) => Rect {
                    x: x - origin.0,
                    y: y - origin.1,
                    width: w,
                    height: h,
                },
                // Entirely behind the viewer: nothing is there.
                None => Rect::default(),
            }
        }
        None => offset,
    };
    ElementBox {
        x: offset.x,
        y: offset.y,
        width: offset.width,
        height: offset.height,
        rect,
        client: Size {
            width: f64::from(node.client_width()).round().max(0.0),
            height: f64::from(node.client_height()).round().max(0.0),
        },
        scroll: Size {
            width: f64::from(node.scroll_width()).round().max(0.0),
            height: f64::from(node.scroll_height()).round().max(0.0),
        },
    }
}

fn union(a: Rect, b: Rect) -> Rect {
    let x = a.x.min(b.x);
    let y = a.y.min(b.y);
    Rect {
        x,
        y,
        width: (a.x + a.width).max(b.x + b.width) - x,
        height: (a.y + a.height).max(b.y + b.height) - y,
    }
}

/// The line fragments of a non-atomic inline, in document coordinates.
fn fragments(doc: &BaseDocument, node: &Node) -> Option<Vec<Rect>> {
    let local = node.inline_fragment_boxes()?;
    let root = node.inline_root_ancestor()?;
    let (ox, oy) = border_box_origin(doc, root.id);
    Some(
        local
            .map(|r| Rect {
                x: ox + f64::from(r.left),
                y: oy + f64::from(r.top),
                width: f64::from(r.right - r.left),
                height: f64::from(r.bottom - r.top),
            })
            .collect(),
    )
}

/// The bounding box of `rect` (given in document coordinates, inside the
/// border box at `root_pos`) under `m`, which maps the root's own coordinates
/// to the document.
fn transformed(m: &Matrix, root_pos: (f64, f64), rect: Rect, origin: (f64, f64)) -> Rect {
    let local = Rect {
        x: rect.x + origin.0 - root_pos.0,
        y: rect.y + origin.1 - root_pos.1,
        ..rect
    };
    let corner = |x: f64, y: f64| {
        let p = m.transform_point3d_homogeneous(euclid::default::Point3D::new(x, y, 0.0));
        (p.x / p.w, p.y / p.w)
    };
    let pts = [
        corner(local.x, local.y),
        corner(local.x + local.width, local.y),
        corner(local.x + local.width, local.y + local.height),
        corner(local.x, local.y + local.height),
    ];
    let min_x = pts.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
    let min_y = pts.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
    let max_x = pts.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
    let max_y = pts.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
    Rect {
        x: min_x - origin.0,
        y: min_y - origin.1,
        width: max_x - min_x,
        height: max_y - min_y,
    }
}

/// The document position of a node's border box where layout put it,
/// untransformed: its offset in the containing block, and that block's, and so on.
pub fn border_box_origin(doc: &BaseDocument, id: NodeId) -> (f64, f64) {
    let mut x = 0.0;
    let mut y = 0.0;
    let mut current = Some(id);
    while let Some(c) = current {
        let Some(node) = doc.get_node(c) else { break };
        let l = node.unrounded_layout().location;
        x += f64::from(l.x);
        y += f64::from(l.y);
        current = node.containing_block();
    }
    (x, y)
}

/// The matrix from `id`'s border box coordinates to the document's, or `None`
/// when nothing in the chain is transformed (it is then a translation).
pub fn ctm(doc: &BaseDocument, id: NodeId) -> Option<Matrix> {
    // Walk up the containing blocks. At each step the matrix so far maps the
    // node's box into `cur`'s coordinates; `cur`'s own transform and offset
    // take it into its parent's, where the parent's perspective applies, and a
    // parent that is not `preserve-3d` flattens it into its plane.
    let mut acc = Matrix::identity();
    let mut any = false;
    let mut cur = id;
    loop {
        let node = doc.get_node(cur)?;
        let layout = node.unrounded_layout();
        if let Some(local) =
            transform::local_transform(node, (layout.size.width, layout.size.height))
        {
            any = true;
            acc = acc.then(&local);
        }
        acc = acc.then(&Matrix::translation(
            f64::from(layout.location.x),
            f64::from(layout.location.y),
            0.0,
        ));
        let Some(parent_id) = node.containing_block() else {
            break;
        };
        if let Some(parent) = doc.get_node(parent_id) {
            let size = parent.unrounded_layout().size;
            if let Some(persp) = transform::perspective_matrix(parent, (size.width, size.height)) {
                any = true;
                acc = acc.then(&persp);
            }
            if !transform::preserves_3d(parent) {
                acc = transform::flatten(&acc);
            }
        }
        cur = parent_id;
    }
    any.then_some(acc)
}

// ---- computed style ----

/// `getComputedStyle(element).getPropertyValue(name)` for each name: the
/// resolved value, the used value for layout-dependent properties (`width`,
/// margins, `transform-origin`), `""` for an unknown property. Names are CSS
/// (`font-size`, `--accent`) or React's camelCase (`fontSize`, `WebkitMask`).
pub fn computed_style(
    island: &IslandDocument,
    path: &str,
    properties: &[String],
) -> Option<Vec<String>> {
    let id = island.node(path)?;
    Some(
        properties
            .iter()
            .map(|p| island.doc.resolved_style_value(id, &css_name(p)))
            .collect(),
    )
}

/// `fontSize` → `font-size`, `WebkitMaskImage` → `-webkit-mask-image`; CSS
/// names and custom properties as they are.
pub fn css_name(name: &str) -> String {
    if name.starts_with("--") || !name.chars().any(|c| c.is_ascii_uppercase()) {
        return name.to_string();
    }
    let mut out = String::with_capacity(name.len() + 4);
    if name.starts_with(|c: char| c.is_ascii_uppercase()) && name != "cssFloat" {
        // A vendor prefix capitalised: WebkitFoo, MozFoo, msFoo is ms-lower.
        out.push('-');
    }
    for c in name.chars() {
        if c.is_ascii_uppercase() {
            if !out.is_empty() && !out.ends_with('-') {
                out.push('-');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    if out == "css-float" {
        return "float".to_string();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::css_name;

    #[test]
    fn camel_case_becomes_css_names() {
        assert_eq!(css_name("fontSize"), "font-size");
        assert_eq!(css_name("font-size"), "font-size");
        assert_eq!(css_name("WebkitMaskImage"), "-webkit-mask-image");
        assert_eq!(css_name("--MyVar"), "--MyVar");
        assert_eq!(css_name("cssFloat"), "float");
        assert_eq!(css_name("width"), "width");
    }
}
