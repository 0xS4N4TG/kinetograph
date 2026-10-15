//! Inline SVG and SVG filters (docs/ENGINE.md §5, stream 3): an `<svg>` subtree
//! painted as scene layers, and the filter graph a CSS `filter: url(#id)` names.
//!
//! Stream 2's box painter calls two functions from here, see docs/ENGINE.md §9:
//!
//! - [`paint_svg`] for an `<svg>` element's content, and
//! - [`filter_graph`] for a `url(#id)` in a `filter` property.
//!
//! How it is made: `serialize` writes the subtree as SVG source (resolving what
//! only the document knows: `currentColor`, CSS transforms, definitions in
//! another `<svg>`), usvg resolves it, and `emit` maps the result onto layers.
//! Filters are not taken from usvg: `filter` reads the `<filter>` element
//! itself, so the scene's `filterGraph` gets the attributes as authored.

mod css;
mod emit;
mod filter;
mod fonts;
mod serialize;

use std::sync::Arc;

use blitz_dom::{BaseDocument, NodeId};
use kurbo::Affine;
use serde_json::{Value, json};

use crate::request::{IslandRequest, Unsupported};
use serialize::Note;

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

fn unsupported(path: &str, notes: Vec<Note>) -> Vec<Unsupported> {
    notes
        .into_iter()
        .map(|n| Unsupported {
            path: format!("{path} <{}>", n.element),
            element: n.element,
            property: n.property,
            value: n.value,
            reason: n.reason,
        })
        .collect()
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
    node_id: NodeId,
    size: [f64; 2],
    id: &str,
    path: &str,
) -> SvgPaint {
    let serialized = serialize::serialize(doc, node_id, size);
    let mut notes = serialized.notes.clone();
    let fail = |notes: Vec<Note>, reason: String| SvgPaint {
        layer: None,
        unsupported: unsupported(
            path,
            notes
                .into_iter()
                .chain([Note {
                    element: "svg".into(),
                    property: None,
                    value: None,
                    reason,
                }])
                .collect(),
        ),
    };
    let options = options(request);
    let tree = match usvg::Tree::from_str(&serialized.xml, &options) {
        Ok(tree) => tree,
        Err(e) => return fail(notes, format!("the SVG could not be read: {e}")),
    };
    let mut emitter = emit::Emitter {
        doc,
        id: id.to_string(),
        counter: 0,
        notes: Vec::new(),
        filters: serialized
            .filters
            .iter()
            .map(|f| (f.group.clone(), f.urls.clone()))
            .collect(),
        viewport: [request.viewport.width, request.viewport.height],
        coverage: false,
    };
    let children = emitter.group(tree.root(), Affine::IDENTITY);
    notes.append(&mut emitter.notes);
    // Text with no font to set it in is dropped by usvg without a word.
    if serialized.xml.contains("<text") && !tree.has_text_nodes() {
        notes.push(Note {
            element: "text".into(),
            property: Some("font-family".into()),
            value: None,
            reason: "no registered font matches, so the text is not drawn".into(),
        });
    }
    if children.is_empty() {
        return SvgPaint {
            layer: None,
            unsupported: unsupported(path, notes),
        };
    }
    let mut layer = json!({"id": id, "type": "group", "children": children});
    if !serialized.overflow_visible {
        // `overflow: hidden` on the replaced box.
        layer["clip"] = json!({
            "kind": "polygon",
            "points": [[0, 0], [size[0], 0], [size[0], size[1]], [0, size[1]]],
        });
    }
    SvgPaint {
        layer: Some(layer),
        unsupported: unsupported(path, notes),
    }
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
    let _ = id;
    let name = fragment.trim();
    let name = name
        .strip_prefix("url(")
        .and_then(|s| s.strip_suffix(')'))
        .unwrap_or(name)
        .trim()
        .trim_matches(['"', '\''])
        .trim_start_matches('#');
    let mut notes = Vec::new();
    let effect = filter::effect(
        doc,
        name,
        Some(bbox),
        [request.viewport.width, request.viewport.height],
        &mut notes,
    )?;
    Some(FilterEffect {
        effect,
        unsupported: unsupported(path, notes),
    })
}

/// usvg's options for a request: its fonts and its asset directories.
fn options(request: &IslandRequest) -> usvg::Options<'static> {
    let default = usvg::ImageHrefResolver::default_string_resolver();
    let public = request.public_dir.clone();
    let mut options = usvg::Options {
        resources_dir: Some(request.base_dir.clone().into()),
        font_family: fonts::default_family(&request.fonts),
        font_size: 16.0,
        fontdb: fonts::database(&request.fonts),
        style_sheet: (!request.stylesheets.is_empty()).then(|| request.stylesheets.join("\n")),
        ..usvg::Options::default()
    };
    options.image_href_resolver.resolve_string =
        Box::new(move |href: &str, opts: &usvg::Options| {
            default(href, opts).or_else(|| {
                let bytes =
                    std::fs::read(std::path::Path::new(public.as_deref()?).join(href)).ok()?;
                let data = Arc::new(bytes);
                match data.as_slice() {
                    [0x89, b'P', b'N', b'G', ..] => Some(usvg::ImageKind::PNG(data)),
                    [0xff, 0xd8, 0xff, ..] => Some(usvg::ImageKind::JPEG(data)),
                    [b'G', b'I', b'F', ..] => Some(usvg::ImageKind::GIF(data)),
                    _ => None,
                }
            })
        });
    options
}
