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

use crate::clamp;
use crate::collapse;
use crate::fonts;
use crate::inline;
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

/// Parses an `IslandRequest`. A tree of elements can be deeper than serde_json's
/// default limit of 128 levels, so the limit is off; the caller needs a stack
/// for the depth (the addon runs islands on a thread with a large one).
pub fn parse_request(json: &str) -> Result<IslandRequest, serde_json::Error> {
    use serde::Deserialize as _;
    let mut de = serde_json::Deserializer::from_str(json);
    de.disable_recursion_limit();
    let request = IslandRequest::deserialize(&mut de)?;
    de.end()?;
    Ok(request)
}

/// Switches on the CSS features Chrome has and Stylo ships off. They are
/// process-wide and must be set before a document (its style system) is made.
pub fn enable_css_features() {
    style_config::set_pref!("layout.css.has-selector.enabled", true);
    style_config::set_pref!("layout.container-queries.enabled", true);
    style_config::set_pref!("layout.css.nth-child-of.enabled", true);
    style_config::set_pref!("layout.css.at-scope.enabled", true);
    style_config::set_pref!("layout.css.light-dark.images.enabled", true);
    style_config::set_pref!("layout.css.starting-style-at-rules.enabled", true);
}

/// Builds the DOM of `request` (no style or layout yet).
pub fn build(request: &IslandRequest) -> Result<(IslandDocument, Arc<LocalFiles>), BuildError> {
    build_root(request, &request.root)
}

/// Builds a document for `request`'s page with `root` as the island's tree.
fn build_root(
    request: &IslandRequest,
    root: &DomNode,
) -> Result<(IslandDocument, Arc<LocalFiles>), BuildError> {
    let base_dir = PathBuf::from(&request.base_dir);
    let public_dir = request.public_dir.as_deref().map(Path::new);
    let files = Arc::new(LocalFiles::new(&base_dir, public_dir));

    enable_css_features();
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

    // The painter's mirror properties do not inherit.
    crate::paint::register_properties(&mut doc);
    let mut paths = BTreeMap::new();
    let (container, root) = {
        let mut m = doc.mutate();
        let html = element(&mut m, "html", false, vec![]);
        let head = element(&mut m, "head", false, vec![]);
        let body = element(&mut m, "body", false, vec![]);
        // Imported stylesheets come before the `<style>` elements of the tree.
        for css in &request.stylesheets {
            let style = element(&mut m, "style", false, vec![]);
            // CSS this Stylo does not parse is mirrored into custom properties for
            // the painter (`paint::shim_css`).
            let text = m.create_text_node(&escape_style_text(&crate::paint::shim_css(css)));
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
        let root = build_node(&mut m, root, false, &mut paths);
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
///
/// A CSS transition starts when a style value changes, which needs a state
/// before the change, and a frame is built from nothing. `request.history`
/// supplies the states before: the document is built from the oldest, and
/// each later state (the request's own last) is applied to it as attribute,
/// `style` and text changes and styled at its time, so Stylo starts a
/// transition at the time of the first state that shows the new value, and
/// its progress at `request.time` follows from the clock alone. A state that
/// adds, removes or retags elements starts the replay over from it (a new
/// element does not transition, as in a browser). With no history, nothing
/// transitions and every value is its final one.
pub fn resolve(request: &IslandRequest) -> Result<IslandDocument, BuildError> {
    let mut states: Vec<(f64, &DomNode)> = request
        .history
        .iter()
        .filter(|s| s.time < request.time)
        .map(|s| (s.time, &s.root))
        .collect();
    states.sort_by(|a, b| a.0.total_cmp(&b.0));
    states.push((request.time, &request.root));

    let (mut island, mut files) = build_root(request, states[0].1)?;
    start(&mut island, &files, states[0].0);
    for &(time, root) in &states[1..] {
        match changes(&island, root) {
            Some(edits) => {
                if !edits.is_empty() {
                    apply(&mut island, &edits);
                    load(&mut island, &files, time);
                }
                advance(&mut island.doc, time);
            }
            None => {
                (island, files) = build_root(request, root)?;
                start(&mut island, &files, time);
            }
        }
    }
    // Inline elements with horizontal margin, border or padding: Blitz leaves
    // those widths out of the text, so give the text the widths (inline.rs).
    if inline::add_edge_spacers(&mut island.doc) > 0 {
        island.doc.resolve(request.time);
    }
    // A collapsed table's cells give up their borders for half of each in their
    // padding, as Chrome lays it out (collapse.rs).
    if collapse::requested(request) {
        collapse::settle(&mut island.doc, request.time);
    }
    // `-webkit-line-clamp` boxes cut their height at the Nth line, which is
    // only known once the text is laid out.
    if clamp::requested(request) {
        clamp::settle(&mut island.doc, request.time);
    }
    island.missing = files.missing();
    Ok(island)
}

/// Styles a freshly built document and brings it to `time`.
///
/// CSS animations start at the first style computation, with the clock
/// there. Starting it at 0 and then moving to `time` makes the animation's
/// progress `time`, whatever the frame.
fn start(island: &mut IslandDocument, files: &LocalFiles, time: f64) {
    load(island, files, 0.0);
    advance(&mut island.doc, time);
}

/// Resolves the document at `at` until its sub-resources have arrived.
///
/// Images and `@font-face` files are answered while the tree is built
/// (`<img>`) and while styles are computed (`background-image`, `@import`),
/// and enter the document before the next resolve. Resolve until nothing new
/// arrives; the passes after the first only redo what the new resource touched.
fn load(island: &mut IslandDocument, files: &LocalFiles, at: f64) {
    deliver(&mut island.doc, files);
    for _ in 0..4 {
        files.take_served();
        island.doc.resolve(at);
        if files.take_served() == 0 {
            break;
        }
        deliver(&mut island.doc, files);
    }
}

/// Moves the document's animation clock on to `time`.
fn advance(doc: &mut BaseDocument, time: f64) {
    if time != 0.0 && doc.is_animating() {
        // Stylo moves an animation on by one iteration per style pass, so a
        // jump to a later iteration takes one pass for each iteration passed.
        let passes = iteration_lag(doc, time).min(MAX_CATCH_UP_PASSES) + 1;
        for _ in 0..passes {
            doc.resolve(time);
        }
    }
}

/// A change to a built document that makes it show another state of the island.
enum Edit {
    /// Sets (`Some`) or removes (`None`) an attribute.
    Attr(NodeId, QualName, Option<String>),
    Text(NodeId, String),
}

/// The edits that turn the document into the state `root`, or `None` when the
/// states differ in structure (another element, another number of children).
fn changes(island: &IslandDocument, root: &DomNode) -> Option<Vec<Edit>> {
    let mut edits = Vec::new();
    let id = island.root?;
    diff(&island.doc, id, root, false, &mut edits).then_some(edits)
}

/// Compares the node `id` with `want`, pushing what has to change; false if
/// the two do not have the same shape.
fn diff(
    doc: &BaseDocument,
    id: NodeId,
    want: &DomNode,
    in_svg: bool,
    edits: &mut Vec<Edit>,
) -> bool {
    let Some(node) = doc.get_node(id) else {
        return false;
    };
    match want {
        DomNode::Text { text } => match node.text_data() {
            Some(data) => {
                if data.content != *text {
                    edits.push(Edit::Text(id, text.clone()));
                }
                true
            }
            None => false,
        },
        DomNode::Native {
            path,
            width,
            height,
        } => {
            node.data
                .is_element_with_tag_name(&LocalName::from("kg-native"))
                && diff_attrs(node, native_attributes(path, *width, *height), edits)
        }
        DomNode::Element {
            tag,
            path,
            attrs,
            style,
            children,
        } => {
            let svg = in_svg || tag == "svg";
            let tag = if svg {
                tag.clone()
            } else {
                tag.to_ascii_lowercase()
            };
            if tag == "script"
                || !node
                    .data
                    .is_element_with_tag_name(&LocalName::from(tag.as_str()))
            {
                return false;
            }
            if !diff_attrs(node, element_attributes(path, attrs, style, svg), edits) {
                return false;
            }
            let child_svg = svg && tag != "foreignObject";
            let wanted: Vec<&DomNode> = children
                .iter()
                .filter(|c| !matches!(c, DomNode::Element { tag, .. } if tag == "script"))
                .collect();
            if node.children.len() != wanted.len() {
                return false;
            }
            let is_style = tag == "style";
            node.children
                .iter()
                .zip(wanted)
                .all(|(&child, want)| match (is_style, want) {
                    (true, DomNode::Text { text }) => {
                        let text = escape_style_text(&crate::paint::shim_css(text));
                        let same = doc
                            .get_node(child)
                            .and_then(|n| n.text_data())
                            .is_some_and(|d| d.content == text);
                        if !same {
                            edits.push(Edit::Text(child, text));
                        }
                        true
                    }
                    _ => diff(doc, child, want, child_svg, edits),
                })
        }
    }
}

/// Pushes the attribute edits that make `node`'s attributes `want`.
fn diff_attrs(node: &blitz_dom::Node, want: Vec<Attribute>, edits: &mut Vec<Edit>) -> bool {
    let Some(have) = node.attrs() else {
        return false;
    };
    for w in &want {
        match have.iter().find(|h| h.name == w.name) {
            Some(h) if h.value == w.value => {}
            _ => edits.push(Edit::Attr(node.id, w.name.clone(), Some(w.value.clone()))),
        }
    }
    for h in have {
        if !want.iter().any(|w| w.name == h.name) {
            edits.push(Edit::Attr(node.id, h.name.clone(), None));
        }
    }
    true
}

fn apply(island: &mut IslandDocument, edits: &[Edit]) {
    let mut m = island.doc.mutate();
    for edit in edits {
        match edit {
            Edit::Attr(id, name, Some(value)) => m.set_attribute(*id, name.clone(), value),
            Edit::Attr(id, name, None) => m.clear_attribute(*id, name.clone()),
            Edit::Text(id, text) => m.set_node_text(*id, text),
        }
    }
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

/// The attributes of an island element: its host-tree path, `attrs`, and the
/// `style` run through the painter's CSS shim.
fn element_attributes(
    path: &str,
    attrs: &BTreeMap<String, String>,
    style: &str,
    svg: bool,
) -> Vec<Attribute> {
    let mut list = vec![attr(PATH_ATTR, path)];
    for (name, value) in attrs {
        if name == "style" || name == PATH_ATTR {
            continue;
        }
        list.push(attribute(name, value, svg));
    }
    // `attrs["style"]` would be a second style source; the `style` field wins.
    if !style.trim().is_empty() {
        list.push(attr("style", &crate::paint::shim_css(style)));
    }
    list
}

/// The attributes of a native element's placeholder box.
fn native_attributes(path: &str, width: Option<f64>, height: Option<f64>) -> Vec<Attribute> {
    let style = format!(
        "width: {}px; height: {}px",
        width.unwrap_or(0.0),
        height.unwrap_or(0.0)
    );
    vec![attr(PATH_ATTR, path), attr("style", &style)]
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
            let id = element(
                m,
                "kg-native",
                false,
                native_attributes(path, *width, *height),
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
            let id = element(m, &tag, svg, element_attributes(path, attrs, style, svg));
            paths.insert(path.clone(), id);
            let is_style = tag == "style";
            // `foreignObject` holds HTML again.
            let child_svg = svg && tag != "foreignObject";
            let mut ids = Vec::with_capacity(children.len());
            for child in children {
                if let DomNode::Text { text } = child
                    && is_style
                {
                    ids.push(m.create_text_node(&escape_style_text(&crate::paint::shim_css(text))));
                } else if let Some(c) = build_node(m, child, child_svg, paths) {
                    ids.push(c);
                }
            }
            m.append_children(id, &ids);
            Some(id)
        }
    }
}
