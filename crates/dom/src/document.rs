//! `IslandRequest` → a styled and laid-out `blitz_dom::BaseDocument`.
//!
//! ```text
//! <html>
//!   <head> <style>…each request.stylesheets entry…</style> </head>
//!   <body>                      (margin 0, see ua.rs)
//!     <div data-kg-island>      the containing box: position: relative; viewport-sized
//!       …the DomNode tree…      every element carries data-kg-path="$0.2.1"
//! ```
//!
//! The island is laid out as CSS would in a box the viewport's size, as
//! Remotion's root `div` is (docs/COMPAT.md §2): percentages, `auto` margins and
//! absolute positions of the island root resolve against the composition.
//!
//! A document is built per call and resolved at the request's time, so a frame
//! is a pure function of its request.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use blitz_dom::net::ResourceLoadResponse;
use blitz_dom::{
    Attribute, BaseDocument, DocumentConfig, DocumentMutator, LocalName, NodeId, QualName, ns,
};
use blitz_traits::shell::{ColorScheme, Viewport};

use crate::fonts;
use crate::net::{self, LocalFiles};
use crate::request::{DomNode, IslandRequest};
use crate::ua;

/// The attribute every element of the island carries: its host-tree path.
pub const PATH_ATTR: &str = "data-kg-path";
/// The attribute of the island's containing box.
pub const ISLAND_ATTR: &str = "data-kg-island";

/// A resolved island document and the maps between its nodes and host-tree paths.
pub struct IslandDocument {
    pub doc: BaseDocument,
    /// Host-tree path → node, for every element and native placeholder.
    pub paths: BTreeMap<String, NodeId>,
    /// The reverse of `paths`.
    pub node_paths: HashMap<NodeId, String>,
    /// The island's containing box (`<div data-kg-island>`).
    pub container: NodeId,
    /// The node of `request.root`.
    pub root: Option<NodeId>,
    /// Sub-resources that could not be read (a missing image, a network URL),
    /// each with the reason.
    pub missing: Vec<String>,
}

impl IslandDocument {
    /// The node at a host-tree path.
    pub fn node(&self, path: &str) -> Option<NodeId> {
        self.paths.get(path).copied()
    }
}

/// An error building a document: a font file that cannot be read or has no font in it.
#[derive(Debug)]
pub struct BuildError(pub String);

impl std::fmt::Display for BuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for BuildError {}

/// Builds the DOM of `request` (no style or layout yet).
pub fn build(request: &IslandRequest) -> Result<(IslandDocument, Arc<LocalFiles>), BuildError> {
    let base_dir = PathBuf::from(&request.base_dir);
    let public_dir = request.public_dir.as_deref().map(Path::new);
    let files = Arc::new(LocalFiles::new(&base_dir, public_dir));

    let font_ctx = fonts::font_context(&request.fonts, &base_dir).map_err(BuildError)?;
    let width = request.viewport.width.max(0.0).round() as u32;
    let height = request.viewport.height.max(0.0).round() as u32;
    let mut doc = BaseDocument::new(DocumentConfig {
        viewport: Some(Viewport::new(width, height, 1.0, ColorScheme::Light)),
        base_url: Some(net::base_url(&base_dir)),
        ua_stylesheets: Some(ua::sheets()),
        net_provider: Some(files.clone()),
        font_ctx: Some(font_ctx),
        ..DocumentConfig::default()
    });

    let mut paths = BTreeMap::new();
    let (container, root) = {
        let mut m = doc.mutate();
        let html = element(&mut m, "html", false, vec![]);
        let head = element(&mut m, "head", false, vec![]);
        let body = element(&mut m, "body", false, vec![]);
        // Imported stylesheets come before the `<style>` elements of the tree.
        for css in &request.stylesheets {
            let style = element(&mut m, "style", false, vec![]);
            let text = m.create_text_node(&escape_style_text(css));
            m.append_children(style, &[text]);
            m.append_children(head, &[style]);
        }
        let container = element(
            &mut m,
            "div",
            false,
            vec![
                attr(ISLAND_ATTR, ""),
                attr(
                    "style",
                    &format!(
                        "position: relative; display: block; width: {}px; height: {}px",
                        request.viewport.width, request.viewport.height
                    ),
                ),
            ],
        );
        let root = build_node(&mut m, &request.root, false, &mut paths);
        if let Some(root) = root {
            m.append_children(container, &[root]);
        }
        m.append_children(body, &[container]);
        m.append_children(html, &[head, body]);
        let document = m.doc.root_node().id;
        m.append_children(document, &[html]);
        (container, root)
    };

    let node_paths = paths.iter().map(|(p, id)| (*id, p.clone())).collect();
    Ok((
        IslandDocument {
            doc,
            paths,
            node_paths,
            container,
            root,
            missing: Vec::new(),
        },
        files,
    ))
}

/// Builds the document, styles it and lays it out at `request.time`.
pub fn resolve(request: &IslandRequest) -> Result<IslandDocument, BuildError> {
    let (mut island, files) = build(request)?;
    // Images and `@font-face` files are answered while the tree is built
    // (`<img>`) and while styles are computed (`background-image`, `@import`),
    // and enter the document before the next resolve. Resolve until nothing
    // new arrives; the passes after the first only redo what the new resource
    // touched.
    //
    // CSS animations start at the first style computation, with the clock
    // there. Starting it at 0 and then moving to `time` makes the animation's
    // progress `time`, whatever the frame.
    deliver(&mut island.doc, &files);
    for _ in 0..4 {
        files.take_served();
        island.doc.resolve(0.0);
        if files.take_served() == 0 {
            break;
        }
        deliver(&mut island.doc, &files);
    }
    if request.time != 0.0 && island.doc.is_animating() {
        // Stylo moves an animation on by one iteration per style pass, so a
        // jump to a later iteration takes one pass for each iteration passed.
        let passes = iteration_lag(&island.doc, request.time).min(MAX_CATCH_UP_PASSES) + 1;
        for _ in 0..passes {
            island.doc.resolve(request.time);
        }
    }
    island.missing = files.missing();
    Ok(island)
}

/// Hands the images the net provider has decoded to the document.
fn deliver(doc: &mut BaseDocument, files: &LocalFiles) {
    for (url, resource) in files.take_deliveries() {
        doc.load_resource(ResourceLoadResponse {
            request_id: 0,
            node_id: None,
            resolved_url: Some(url),
            result: Ok(resource),
        });
    }
}

/// A bound on the style passes spent catching an animation up to a late time
/// (a 50 ms animation at the 30th second is iteration 600).
const MAX_CATCH_UP_PASSES: usize = 2000;

/// The most whole iterations any animation in `doc` has to be moved on by to
/// show `time`.
fn iteration_lag(doc: &BaseDocument, time: f64) -> usize {
    let mut lag = 0.0_f64;
    for (_, node) in doc.tree().iter() {
        let Some(styles) = node.primary_styles() else {
            continue;
        };
        let ui = styles.get_ui();
        for (i, name) in ui.animation_name_iter().enumerate() {
            if name.as_atom().is_none() {
                continue;
            }
            let duration = f64::from(ui.animation_duration_mod(i).seconds());
            let elapsed = time - f64::from(ui.animation_delay_mod(i).seconds());
            if duration <= 0.0 || elapsed <= 0.0 {
                continue;
            }
            let passed = (elapsed / duration).floor();
            // The count is a number; `infinite` is infinity.
            let count = f64::from(ui.animation_iteration_count_mod(i).0);
            let last = (count.ceil() - 1.0).max(0.0);
            lag = lag.max(passed.min(last));
        }
    }
    lag as usize
}

// ---- building ----

fn attr(name: &str, value: &str) -> Attribute {
    Attribute {
        name: QualName::new(None, ns!(), LocalName::from(name)),
        value: value.to_string(),
    }
}

fn element(m: &mut DocumentMutator<'_>, tag: &str, svg: bool, attrs: Vec<Attribute>) -> NodeId {
    let namespace = if svg { ns!(svg) } else { ns!(html) };
    m.create_element(QualName::new(None, namespace, LocalName::from(tag)), attrs)
}

/// The stylesheet text of a `<style>`: Blitz decodes HTML entities in it, which
/// a browser does not, so `&` is escaped to survive that.
fn escape_style_text(css: &str) -> String {
    css.replace('&', "&amp;")
}

fn attribute(name: &str, value: &str, svg: bool) -> Attribute {
    if let Some(local) = name.strip_prefix("xlink:") {
        return Attribute {
            name: QualName::new(
                Some(blitz_dom::namespace_prefix!("xlink")),
                ns!(xlink),
                LocalName::from(local),
            ),
            value: value.to_string(),
        };
    }
    // HTML attribute names are ASCII case-insensitive and stored lower-case;
    // SVG's (`viewBox`, `gradientUnits`) are case-sensitive.
    let name = if svg {
        name.to_string()
    } else {
        name.to_ascii_lowercase()
    };
    attr(&name, value)
}

fn build_node(
    m: &mut DocumentMutator<'_>,
    node: &DomNode,
    in_svg: bool,
    paths: &mut BTreeMap<String, NodeId>,
) -> Option<NodeId> {
    match node {
        DomNode::Text { text } => Some(m.create_text_node(text)),
        DomNode::Native {
            path,
            width,
            height,
        } => {
            let style = format!(
                "width: {}px; height: {}px",
                width.unwrap_or(0.0),
                height.unwrap_or(0.0)
            );
            let id = element(
                m,
                "kg-native",
                false,
                vec![attr(PATH_ATTR, path), attr("style", &style)],
            );
            paths.insert(path.clone(), id);
            Some(id)
        }
        DomNode::Element {
            tag,
            path,
            attrs,
            style,
            children,
        } => {
            if tag == "script" {
                return None;
            }
            let svg = in_svg || tag == "svg";
            let tag = if svg {
                tag.clone()
            } else {
                tag.to_ascii_lowercase()
            };
            let mut list = vec![attr(PATH_ATTR, path)];
            for (name, value) in attrs {
                if name == "style" || name == PATH_ATTR {
                    continue;
                }
                list.push(attribute(name, value, svg));
            }
            // `attrs["style"]` would be a second style source; the `style` field wins.
            if !style.trim().is_empty() {
                list.push(attr("style", style));
            }
            let id = element(m, &tag, svg, list);
            paths.insert(path.clone(), id);
            let is_style = tag == "style";
            // `foreignObject` holds HTML again.
            let child_svg = svg && tag != "foreignObject";
            let mut ids = Vec::with_capacity(children.len());
            for child in children {
                if let DomNode::Text { text } = child
                    && is_style
                {
                    ids.push(m.create_text_node(&escape_style_text(text)));
                } else if let Some(c) = build_node(m, child, child_svg, paths) {
                    ids.push(c);
                }
            }
            m.append_children(id, &ids);
            Some(id)
        }
    }
}
