//! Inline SVG and SVG filters (docs/ENGINE.md §5, stream 3): an `<svg>` subtree
//! painted as scene layers, and the filter graph a CSS `filter: url(#id)` names.
//!
//! Stream 2's box painter calls two functions from here, see docs/ENGINE.md §9:
//!
//! - [`paint_svg`] for an `<svg>` element's content, and
//! - [`filter_graph`] for a `url(#id)` in a `filter` property.

use blitz_dom::BaseDocument;
use serde_json::Value;

use crate::request::{IslandRequest, Unsupported};

/// What [`paint_svg`] drew.
#[derive(Clone, Debug, Default)]
pub struct SvgPaint {
    /// One `group` layer, id `id`, holding the SVG content in the SVG's own
    /// coordinates: (0, 0) is the top-left corner of the `<svg>` element's
    /// content box, which is `size` big. The group has no `transform`,
    /// `opacity`, `blendMode`, `effects` or position of its own: the caller
    /// owns the CSS box, so it sets those (`transform.x` and `.y` put the
    /// box in its parent). `None` when nothing is drawn.
    pub layer: Option<Value>,
    /// What was not drawn as Chrome would draw it.
    pub unsupported: Vec<Unsupported>,
}

/// A `filterGraph` effect for a `<filter>` element, see [`filter_graph`].
#[derive(Clone, Debug)]
pub struct FilterEffect {
    /// `{"type": "filterGraph", ...}`: push it onto the layer's `effects`.
    pub effect: Value,
    pub unsupported: Vec<Unsupported>,
}

/// Paints the `<svg>` element `node_id` (a node of `doc`, styled by
/// `resolve`) into scene layers.
///
/// `size` is the width and height of the element's content box in CSS pixels;
/// `viewBox` and `preserveAspectRatio` map the SVG into it. `id` is the layer
/// id of the result and the prefix of the ids inside it, `path` the element's
/// host-tree path (`$0.2.1`) for `Unsupported` items.
pub fn paint_svg(
    doc: &BaseDocument,
    request: &IslandRequest,
    node_id: usize,
    size: [f64; 2],
    id: &str,
    path: &str,
) -> SvgPaint {
    let _ = (doc, request, node_id, size, id, path);
    SvgPaint::default()
}

/// The `filterGraph` effect for `filter: url(<fragment>)`.
///
/// `fragment` is what the CSS had: `#torn`, `url(#torn)` or `torn`; the
/// `<filter>` element can be anywhere in `doc` (inside an `<svg>`, usually).
/// `bbox` is `[x, y, width, height]` of the filtered element's object
/// bounding box in the coordinates of the layer the effect goes on (for an
/// HTML box, its border box); `objectBoundingBox` units, and the default
/// filter region of -10% / 120%, resolve against it. `id` and `path` are as
/// for [`paint_svg`].
///
/// `None` when no `<filter>` has that id: CSS then ignores the reference and
/// the element is drawn unfiltered. A `<filter>` with no primitives gives an
/// effect that draws nothing, as in a browser.
pub fn filter_graph(
    doc: &BaseDocument,
    request: &IslandRequest,
    fragment: &str,
    bbox: [f64; 4],
    id: &str,
    path: &str,
) -> Option<FilterEffect> {
    let _ = (doc, request, fragment, bbox, id, path);
    None
}
