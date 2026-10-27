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
//! Remotion's root `div` is. Percentages, `auto` margins and
//! absolute positions of the island root resolve against the composition.
//!
//! A tree whose root is an `<html>` (a HyperFrames page) is the whole page:
//! its `html` and `body` are the document's own, with the `<style>`s in a
//! `<head>` put first in its `html`, and no container.
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
use style::properties::{ComputedValues, LonghandId};
use style::servo_arc::Arc as ServoArc;

use crate::clamp;
use crate::collapse;
use crate::fonts;
use crate::inline;
use crate::net::{self, LocalFiles};
use crate::paint::{self, Painted};
use crate::request::{DomNode, IslandOutput, IslandRequest};
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
    /// The text node of the `<style>` holding `@starting-style` rules, cleared
    /// once the initial style has been computed.
    starting: Option<NodeId>,
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

/// Switches on the CSS features Chrome has and Stylo ships off (`@container`
/// needs the vendored Stylo, vendor/README.md). They are process-wide and must
/// be set before a document (its style system) is made.
pub fn enable_css_features() {
    style_config::set_pref!("layout.css.has-selector.enabled", true);
    style_config::set_pref!("layout.container-queries.enabled", true);
    style_config::set_pref!("layout.css.nth-child-of.enabled", true);
    style_config::set_pref!("layout.css.at-scope.enabled", true);
    style_config::set_pref!("layout.css.light-dark.images.enabled", true);
    style_config::set_pref!("layout.css.starting-style-at-rules.enabled", true);
    style_config::set_pref!("layout.css.style-queries.enabled", true);
}

/// Builds the DOM of `request` (no style or layout yet).
pub fn build(request: &IslandRequest) -> Result<(IslandDocument, Arc<LocalFiles>), BuildError> {
    build_root(request, &request.root, false)
}

/// The final (`@media not all`) and starting (`@media all`) copies of a
/// stylesheet that has `@starting-style` rules; `None` if it has none.
fn starting_variants(css: &str) -> Option<(String, String)> {
    css.contains("@starting-style").then(|| {
        (
            css.replace("@starting-style", "@media not all"),
            css.replace("@starting-style", "@media all"),
        )
    })
}

/// Puts the request's imported stylesheets in `head`; the text node of the
/// `<style>` holding the `@starting-style` rules, when `with_starting`.
/// (Not inlined: it would grow the frame of `build_root`, which sits under
/// the recursion over deep trees.)
#[inline(never)]
fn add_stylesheets(
    m: &mut DocumentMutator<'_>,
    head: NodeId,
    request: &IslandRequest,
    with_starting: bool,
) -> Option<NodeId> {
    let mut starting_sheets = Vec::new();
    for css in &request.stylesheets {
        let final_css;
        let sheet = match starting_variants(css) {
            Some((f, s)) => {
                if with_starting {
                    starting_sheets.push(s);
                }
                final_css = f;
                &final_css
            }
            None => css.as_str(),
        };
        let style = element(m, "style", false, vec![]);
        // CSS this Stylo does not parse is mirrored into custom properties for
        // the painter (`paint::shim_css`).
        let text = m.create_text_node(&escape_style_text(&crate::paint::shim_css(sheet)));
        m.append_children(style, &[text]);
        m.append_children(head, &[style]);
    }
    (!starting_sheets.is_empty()).then(|| {
        let style = element(m, "style", false, vec![]);
        let css = starting_sheets.join("\n");
        let text = m.create_text_node(&escape_style_text(&crate::paint::shim_css(&css)));
        m.append_children(style, &[text]);
        m.append_children(head, &[style]);
        text
    })
}

/// Whether the island's tree is a whole page: an `<html>` element at its root.
fn is_page(root: &DomNode) -> bool {
    matches!(root, DomNode::Element { tag, .. } if tag.eq_ignore_ascii_case("html"))
}

/// Builds a document for `request`'s page with `root` as the island's tree.
fn build_root(
    request: &IslandRequest,
    root: &DomNode,
    with_starting: bool,
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
    // A page (a tree whose root is an `<html>`, as a HyperFrames page is) is the document itself: its `html` and `body`
    // are the document's, so `:root`, `html > body`, `rem` and the canvas background are those of a browser's page.
    if is_page(root) {
        let (html, starting) = {
            let mut m = doc.mutate();
            let html = build_node(&mut m, root, false, &mut paths).expect("an html element");
            let head = element(&mut m, "head", false, vec![]);
            let starting = add_stylesheets(&mut m, head, request, with_starting);
            m.prepend_nodes(html, &[head]);
            let document = m.doc.root_node().id;
            m.append_children(document, &[html]);
            (html, starting)
        };
        let node_paths = paths.iter().map(|(p, id)| (*id, p.clone())).collect();
        return Ok((
            IslandDocument {
                doc,
                paths,
                node_paths,
                container: html,
                root: Some(html),
                starting,
                missing: Vec::new(),
            },
            files,
        ));
    }
    let (container, root, starting) = {
        let mut m = doc.mutate();
        let html = element(&mut m, "html", false, vec![]);
        let head = element(&mut m, "head", false, vec![]);
        let body = element(&mut m, "body", false, vec![]);
        // Imported stylesheets come before the `<style>` elements of the tree.
        let starting = add_stylesheets(&mut m, head, request, with_starting);
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
        (container, root, starting)
    };

    let node_paths = paths.iter().map(|(p, id)| (*id, p.clone())).collect();
    Ok((
        IslandDocument {
            doc,
            paths,
            node_paths,
            container,
            root,
            starting,
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
/// element does not transition, as in a browser). When a document is built
/// before the last state, `@starting-style` rules give elements their first
/// values and are cleared at that state's time so entry transitions start
/// from them. With no history, nothing transitions and every value is its
/// final one.
pub fn resolve(request: &IslandRequest) -> Result<IslandDocument, BuildError> {
    resolve_keeping(request, &mut None, &mut false)
}

/// [`resolve`], handing out what [`IslandCache`] needs to update the document
/// to another state. (The results go through references, not a struct: the
/// deep recursion in Stylo and Blitz runs below this frame, and in a debug
/// build every copy of the document it holds is stack.)
fn resolve_keeping(
    request: &IslandRequest,
    files_out: &mut Option<Arc<LocalFiles>>,
    plain_out: &mut bool,
) -> Result<IslandDocument, BuildError> {
    // Only a transition or an animation reads the states before: when none can
    // start, the replay ends where a build of the last state starts.
    let replay = !request.history.is_empty() && moves(request, &[]);
    let mut states: Vec<(f64, &DomNode)> = request
        .history
        .iter()
        .filter(|s| replay && s.time < request.time)
        .map(|s| (s.time, &s.root))
        .collect();
    states.sort_by(|a, b| a.0.total_cmp(&b.0));
    states.push((request.time, &request.root));

    let last = states.len() - 1;
    let (mut island, mut files) = build_root(request, states[0].1, last > 0)?;
    start(&mut island, &files, states[0].0);
    clear_starting(&mut island, &files, states[0].0);
    for (i, &(time, root)) in states.iter().enumerate().skip(1) {
        match changes(&island, None, root) {
            Some(edits) => {
                if !edits.is_empty() {
                    apply(&mut island, &edits);
                    load(&mut island, &files, time);
                }
                advance(&mut island.doc, time);
            }
            None => {
                (island, files) = build_root(request, root, i < last)?;
                start(&mut island, &files, time);
                clear_starting(&mut island, &files, time);
            }
        }
    }
    // A state that has history is a replay, and is built afresh each time.
    *plain_out = settle(&mut island, request) && !replay;
    island.missing = files.missing();
    *files_out = Some(files);
    Ok(island)
}

/// The passes after styling that mend what Blitz leaves out. True when none
/// of them changed the document's tree or styles, so the document is still
/// what building the request's tree gives and [`changes`] can edit it.
#[inline(never)]
fn settle(island: &mut IslandDocument, request: &IslandRequest) -> bool {
    let mut plain = true;
    // Inline elements with horizontal margin, border or padding: Blitz leaves
    // those widths out of the text, so give the text the widths (inline.rs).
    if inline::add_edge_spacers(&mut island.doc) > 0 {
        island.doc.resolve(request.time);
        plain = false;
    }
    // A collapsed table's cells give up their borders for half of each in their
    // padding, as Chrome lays it out (collapse.rs).
    if collapse::requested(request) {
        collapse::settle(&mut island.doc, request.time);
        plain = false;
    }
    // `-webkit-line-clamp` boxes cut their height at the Nth line, which is
    // only known once the text is laid out.
    if clamp::requested(request) {
        clamp::settle(&mut island.doc, request.time);
        plain = false;
    }
    plain
}

/// A resolved island with the files it reads.
pub struct Resolved {
    pub island: IslandDocument,
    files: Arc<LocalFiles>,
    /// Whether [`IslandCache`] may keep it.
    plain: bool,
    /// The last paint of the document, and the style and box of each node then.
    painted: Option<(Painted, Vec<Stamp>)>,
    /// The elements whose transforms alone changed since that paint, when
    /// nothing else did (`Resolved::paint`).
    moved: Option<Vec<NodeId>>,
}

/// A node's computed style and box as a paint saw them. The style is held,
/// so another one cannot take its place in memory.
struct Stamp {
    node: NodeId,
    style: Option<ServoArc<ComputedValues>>,
    layout: Option<taffy::Layout>,
}

/// A node's box; text and comments have none.
fn layout_of(node: &blitz_dom::Node) -> Option<taffy::Layout> {
    use blitz_dom::node::NodeData;
    matches!(
        node.data,
        NodeData::Element(_) | NodeData::AnonymousBlock(_) | NodeData::Document(_)
    )
    .then(|| *node.final_layout())
}

fn stamps(doc: &BaseDocument) -> Vec<Stamp> {
    doc.tree()
        .iter()
        .map(|(_, node)| Stamp {
            node: node.id,
            style: node.primary_styles().map(|s| (*s).clone()),
            layout: layout_of(node),
        })
        .collect()
}

impl Resolved {
    /// Paints the island. After an edit that only changed transforms, the
    /// last paint's layers with those groups' transforms worked out again
    /// (`paint::repaint_transforms`); otherwise a whole paint.
    pub fn paint(&mut self, request: &IslandRequest) -> IslandOutput {
        let doc = &self.island.doc;
        let again = match (self.moved.take(), self.painted.take()) {
            (Some(moved), Some((painted, _))) => {
                paint::repaint_transforms(doc, request, painted, &moved)
            }
            _ => None,
        };
        let (output, painted) = again.unwrap_or_else(|| paint::paint_keeping(doc, request));
        self.painted = Some((painted, stamps(doc)));
        output
    }
}

/// The properties that only make an element's matrix.
const TRANSFORM_PROPERTIES: [LonghandId; 4] = [
    LonghandId::Transform,
    LonghandId::Translate,
    LonghandId::Rotate,
    LonghandId::Scale,
];

/// The nodes whose `style` `edits` set: None when an edit is anything else
/// (a text, another attribute).
fn style_edits(edits: &[Edit]) -> Option<Vec<NodeId>> {
    edits
        .iter()
        .map(|edit| match edit {
            Edit::Attr(id, name, Some(_)) if name.local == *"style" => Some(*id),
            _ => None,
        })
        .collect()
}

/// The nodes whose transforms alone changed between `stamps` (the last
/// paint) and now, if that is all that changed: every box is where it was,
/// every node has the values it had, and of the nodes in `edited` only the
/// transform properties differ.
fn transform_changes(
    island: &IslandDocument,
    edited: &[NodeId],
    stamps: &[Stamp],
) -> Option<Vec<NodeId>> {
    let doc = &island.doc;
    if stamps.len() != doc.tree().len() {
        return None;
    }
    let mut moved = Vec::new();
    for stamp in stamps {
        let node = doc.get_node(stamp.node)?;
        if layout_of(node) != stamp.layout {
            return None;
        }
        let style = node.primary_styles();
        match (&stamp.style, &style) {
            (None, None) => {}
            (Some(was), Some(now)) => {
                let now: &ServoArc<ComputedValues> = now;
                if ServoArc::ptr_eq(was, now) || was.same_values_except(now, &[]) {
                    continue;
                }
                if !edited.contains(&stamp.node)
                    || !was.same_values_except(now, &TRANSFORM_PROPERTIES)
                {
                    return None;
                }
                moved.push(stamp.node);
            }
            _ => return None,
        }
    }
    Some(moved)
}

/// The islands of one motion-blurred frame's samples (packages/cli/skills/kinetograph/references/SCENE.md, "Motion
/// blur"). A layer is drawn at several moments of the same frame, and its
/// islands differ in a few styles (a transform, an opacity) while their
/// structure, text and sheets stay. The document of an earlier sample is
/// edited to the next one instead of building, styling and shaping all of it
/// again; the edits restyle and lay out only what they touch. When they
/// changed nothing but transforms (every box where it was, every other value
/// the same), the island is painted from its last paint with those groups'
/// transforms worked out again (`Resolved::paint`). The result is the same as
/// building and painting the sample afresh. It is not used when a transition
/// or animation could start from an edit, nor for a tree whose structure
/// changed.
///
/// A pass is the renders of one frame, its samples included. The pass that
/// follows it (its number one more) edits the documents the pass left, from
/// the state of one frame to the next, and drops the islands the pass did not
/// render. Any other pass number (or none) empties the cache, so a frame that
/// does not follow the one before sees nothing an earlier one left: the
/// caller skips a number where the frames are not in sequence.
#[derive(Default)]
pub struct IslandCache {
    pass: Option<u64>,
    kept: HashMap<String, Kept>,
    /// How many documents the passes edited and how many they built.
    edited: u64,
    built: u64,
}

struct Kept {
    resolved: Resolved,
    /// The request the document shows.
    request: IslandRequest,
    /// The pass that last rendered it.
    pass: u64,
}

/// Whether two requests build a document from the same sheets, fonts and box.
fn same_page(a: &IslandRequest, b: &IslandRequest) -> bool {
    a.stylesheets == b.stylesheets
        && a.viewport.width.to_bits() == b.viewport.width.to_bits()
        && a.viewport.height.to_bits() == b.viewport.height.to_bits()
        && a.fonts == b.fonts
        && a.base_dir == b.base_dir
        && a.public_dir == b.public_dir
}

/// Whether any CSS of `request` can start a transition or an animation on an
/// element of its tree, its history's or `others`: an edit (or a replay) would
/// start one that a fresh build does not have. An imported stylesheet counts
/// when one of its rules that sets one can match an element of those trees
/// (`moving`); a `style` and a `<style>` element when they mention one.
fn moves(request: &IslandRequest, others: &[&DomNode]) -> bool {
    use crate::moving::mentions;
    // Only a `<style>` element's text is CSS: a word in the page's text starts nothing.
    fn node(n: &DomNode, sheet: bool) -> bool {
        match n {
            DomNode::Text { text } => sheet && mentions(text),
            DomNode::Native { .. } => false,
            DomNode::Element {
                tag,
                attrs,
                style,
                children,
                ..
            } => {
                mentions(style)
                    || attrs.get("style").is_some_and(|s| mentions(s))
                    || children.iter().any(|c| node(c, tag == "style"))
            }
        }
    }
    let mut trees = vec![&request.root];
    trees.extend(request.history.iter().map(|s| &s.root));
    trees.extend_from_slice(others);
    trees.iter().any(|tree| node(tree, false)) || crate::moving::sheets_move(&request.stylesheets, &trees)
}

impl IslandCache {
    /// The island of `request`: the kept one of the same path edited to the
    /// request's tree, or a new one. Hand it back to [`keep`](Self::keep) to
    /// let the next sample of the pass use it.
    pub fn resolve(
        &mut self,
        request: &IslandRequest,
        pass: Option<u64>,
    ) -> Result<Resolved, BuildError> {
        if self.pass != pass {
            match (self.pass, pass) {
                // The next frame: the islands the last one rendered stay.
                (Some(was), Some(now)) if now == was.wrapping_add(1) => {
                    self.kept.retain(|_, kept| kept.pass == was);
                }
                _ => self.kept.clear(),
            }
            self.pass = pass;
        }
        let editable = pass.is_some()
            && self
                .kept
                .get(&request.path)
                .is_some_and(|kept| !moves(request, &[&kept.request.root]));
        if editable
            && let Some(mut kept) = self.kept.remove(&request.path)
            && same_page(&kept.request, request)
            && let Some(edits) = changes(
                &kept.resolved.island,
                Some(&kept.request.root),
                &request.root,
            )
        {
            let Resolved {
                island,
                files,
                plain,
                painted,
                moved,
            } = &mut kept.resolved;
            // A change to transforms alone can be painted from the last paint.
            let edited = style_edits(&edits);
            if !edits.is_empty() {
                apply(island, &edits);
                load(island, files, request.time);
            }
            advance(&mut island.doc, request.time);
            *plain = settle(island, request);
            island.missing = files.missing();
            *moved = match (edited, painted.as_ref()) {
                (Some(edited), Some((_, stamps))) if *plain => {
                    transform_changes(island, &edited, stamps)
                }
                _ => None,
            };
            self.edited += 1;
            return Ok(kept.resolved);
        }
        let (mut files, mut plain) = (None, false);
        let island = resolve_keeping(request, &mut files, &mut plain)?;
        self.built += 1;
        Ok(Resolved {
            island,
            files: files.expect("a resolved island has its files"),
            plain,
            painted: None,
            moved: None,
        })
    }

    /// Keeps `resolved` for the next sample of the same pass.
    pub fn keep(&mut self, request: IslandRequest, resolved: Resolved) {
        if let Some(pass) = self.pass
            && resolved.plain
        {
            self.kept.insert(
                request.path.clone(),
                Kept {
                    resolved,
                    request,
                    pass,
                },
            );
        }
    }

    /// The kept document of the island at `path`, if there is one.
    pub fn peek(&self, path: &str) -> Option<&Resolved> {
        self.kept.get(path).map(|k| &k.resolved)
    }

    /// How many renders edited a kept document, and how many built one.
    pub fn counts(&self) -> (u64, u64) {
        (self.edited, self.built)
    }
}

/// Once a document built with `@starting-style` rules has its first style,
/// drops them and restyles at `time`: the transitions start from the starting
/// values then. (Written in place, not as a function returning the document:
/// a copy of it on the stack matters under the recursion over deep trees.)
fn clear_starting(island: &mut IslandDocument, files: &LocalFiles, time: f64) {
    if let Some(id) = island.starting.take() {
        island.doc.mutate().set_node_text(id, "");
        load(island, files, time);
    }
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
///
/// `built` is the tree the document was last made to show, when that is known:
/// what is the same in both is not looked at again.
fn changes(island: &IslandDocument, built: Option<&DomNode>, root: &DomNode) -> Option<Vec<Edit>> {
    let mut edits = Vec::new();
    let id = island.root?;
    diff(&island.doc, id, built, root, false, &mut edits).then_some(edits)
}

/// Compares the node `id` with `want`, pushing what has to change; false if
/// the two do not have the same shape.
fn diff(
    doc: &BaseDocument,
    id: NodeId,
    built: Option<&DomNode>,
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
                let same = matches!(built, Some(DomNode::Text { text: t }) if t == text);
                if !same && data.content != *text {
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
            overlay,
        } => {
            node.data
                .is_element_with_tag_name(&LocalName::from("kg-native"))
                && (matches!(
                    built,
                    Some(DomNode::Native { path: p, width: w, height: h, overlay: o })
                        if p == path && w == width && h == height && o == overlay
                ) || diff_attrs(
                    node,
                    native_attributes(path, *width, *height, *overlay),
                    edits,
                ))
        }
        DomNode::Element {
            tag,
            path,
            attrs,
            style,
            children,
        } => {
            let raw = tag;
            let svg = in_svg || tag == "svg";
            let tag = if svg {
                tag.clone()
            } else {
                tag.to_ascii_lowercase()
            };
            // The same tag, attributes and style as the tree the document shows.
            let (same, old_children) = match built {
                Some(DomNode::Element {
                    tag: t,
                    path: p,
                    attrs: a,
                    style: st,
                    children: c,
                }) => (t == raw && p == path && a == attrs && st == style, Some(c)),
                _ => (false, None),
            };
            if !same {
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
            }
            let child_svg = svg && tag != "foreignObject";
            let not_script =
                |c: &&DomNode| !matches!(c, DomNode::Element { tag, .. } if tag == "script");
            let wanted: Vec<&DomNode> = children.iter().filter(not_script).collect();
            // A page's `html` holds the `head` of stylesheets the document was built with, which the tree does not.
            let have: Vec<NodeId> = node
                .children
                .iter()
                .copied()
                .filter(|&c| {
                    tag != "html"
                        || !doc.get_node(c).is_some_and(|n| {
                            n.data.is_element_with_tag_name(&LocalName::from("head"))
                        })
                })
                .collect();
            if have.len() != wanted.len() {
                return false;
            }
            let old: Vec<&DomNode> = old_children
                .map(|c| c.iter().filter(not_script).collect())
                .unwrap_or_default();
            let old = if old.len() == wanted.len() {
                old
            } else {
                Vec::new()
            };
            let is_style = tag == "style";
            have.iter()
                .enumerate()
                .zip(wanted)
                .all(|((i, &child), want)| match (is_style, want) {
                    (true, DomNode::Text { text }) => {
                        let unchanged =
                            matches!(old.get(i), Some(DomNode::Text { text: t }) if t == text);
                        if !unchanged {
                            let text = escape_style_text(&crate::paint::shim_css(text));
                            let same = doc
                                .get_node(child)
                                .and_then(|n| n.text_data())
                                .is_some_and(|d| d.content == text);
                            if !same {
                                edits.push(Edit::Text(child, text));
                            }
                        }
                        true
                    }
                    _ => diff(doc, child, old.get(i).copied(), want, child_svg, edits),
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
fn native_attributes(
    path: &str,
    width: Option<f64>,
    height: Option<f64>,
    overlay: bool,
) -> Vec<Attribute> {
    let mut style = format!(
        "width: {}px; height: {}px",
        width.unwrap_or(0.0),
        height.unwrap_or(0.0)
    );
    if overlay {
        style.push_str("; position: absolute; left: 0; top: 0");
    }
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
            overlay,
        } => {
            let id = element(
                m,
                "kg-native",
                false,
                native_attributes(path, *width, *height, *overlay),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn request(root: serde_json::Value) -> IslandRequest {
        parse_request(
            &serde_json::json!({ "root": root, "viewport": { "width": 10, "height": 10 }, "path": "$0", "baseDir": "" })
                .to_string(),
        )
        .unwrap()
    }

    fn el(tag: &str, style: &str, children: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "kind": "element", "tag": tag, "path": "$0", "style": style, "children": children })
    }

    #[test]
    fn only_css_can_start_a_transition() {
        let words = serde_json::json!([{ "kind": "text", "text": "TransitionSeries, @remotion/transitions" }]);
        assert!(!moves(&request(el("div", "", words.clone())), &[]));
        assert!(moves(
            &request(el("div", "", serde_json::json!([el("style", "", words)]))),
            &[]
        ));
        assert!(moves(
            &request(el("div", "transition: opacity 1s", serde_json::json!([]))),
            &[]
        ));
    }

    #[test]
    fn a_sheet_moves_only_what_its_rules_can_match() {
        let with_sheet = |class: &str| {
            let mut root = el("div", "", serde_json::json!([]));
            root["attrs"] = serde_json::json!({ "class": class });
            let mut r = request(root);
            r.stylesheets = vec![".transition { transition-property: opacity; transition-duration: 150ms }".to_string()];
            r
        };
        assert!(!moves(&with_sheet("flex"), &[]));
        assert!(moves(&with_sheet("flex transition"), &[]));
        // The tree an edit starts from counts too.
        let was = with_sheet("transition").root;
        assert!(moves(&with_sheet("flex"), &[&was]));
    }
}
