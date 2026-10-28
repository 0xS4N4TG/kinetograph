//! Inline SVG and SVG filters (packages/cli/skills/kinetograph/references/ENGINE.md §5): an `<svg>` subtree
//! painted as scene layers, and the filter graph a CSS `filter: url(#id)` names.
//!
//! The box painter calls two functions from here, see packages/cli/skills/kinetograph/references/ENGINE.md §9:
//!
//! - [`paint_svg`] for an `<svg>` element's content, and
//! - [`filter_graph`] for a `url(#id)` in a `filter` property.
//!
//! How it is made: `serialize` writes the subtree as SVG source (resolving what
//! only the document knows: `currentColor`, CSS transforms, definitions in
//! another `<svg>`), usvg resolves it, and `emit` maps the result onto layers.
//! Filters are not taken from usvg: `filter` reads the `<filter>` element
//! itself, so the scene's `filterGraph` gets the attributes as authored.

mod assets;
mod color;
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
    // The same SVG text is painted again by the next frame, and by each
    // sample of a motion-blurred layer. What it paints is a function of the
    // text, the sizes and the ids when it needs no file, font or filter.
    let key = (serialized.filters.is_empty()
        && !serialized.xml.contains("<image")
        && !serialized.xml.contains("<text")
        && !serialized.xml.contains("<use")
        && !serialized.xml.contains(serialize::FOREIGN_PREFIX))
    .then(|| {
        (
            serialized.xml.clone(),
            id.to_string(),
            path.to_string(),
            [size[0].to_bits(), size[1].to_bits()],
            [
                request.viewport.width.to_bits(),
                request.viewport.height.to_bits(),
            ],
            serialized.overflow_visible,
        )
    });
    if let Some(key) = &key
        && let Some(hit) = SVG_PAINTS.with(|c| c.borrow().get(key).cloned())
    {
        return hit;
    }
    let painted = paint_serialized(doc, request, size, id, path, serialized);
    if let Some(key) = key {
        SVG_PAINTS.with(|c| {
            let mut c = c.borrow_mut();
            if c.len() >= SVG_PAINTS_MAX {
                c.clear();
            }
            c.insert(key, painted.clone());
        });
    }
    painted
}

type SvgKey = (String, String, String, [u64; 2], [u64; 2], bool);

/// How many painted SVGs are kept before the lot is dropped.
const SVG_PAINTS_MAX: usize = 4096;

thread_local! {
    static SVG_PAINTS: std::cell::RefCell<std::collections::HashMap<SvgKey, SvgPaint>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

fn paint_serialized(
    doc: &BaseDocument,
    request: &IslandRequest,
    size: [f64; 2],
    id: &str,
    path: &str,
    serialized: serialize::Serialized,
) -> SvgPaint {
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
    let misses = Arc::new(std::sync::Mutex::new(Vec::new()));
    let options = options(request, misses.clone());
    let tree = match usvg::Tree::from_str(&serialized.xml, &options) {
        Ok(tree) => tree,
        Err(e) => return fail(notes, format!("the SVG could not be read: {e}")),
    };
    for href in misses.lock().map(|m| m.clone()).unwrap_or_default() {
        notes.push(Note {
            element: "image".into(),
            property: Some("href".into()),
            value: Some(href),
            reason: "the picture is not a readable file under the project or its public \
                     directory, so it is not drawn"
                .into(),
        });
    }
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
        request,
        painter: None,
        foreign: Vec::new(),
    };
    let children = emitter.group(tree.root(), Affine::IDENTITY);
    notes.append(&mut emitter.notes);
    let foreign = std::mem::take(&mut emitter.foreign);
    // Text with no font to set it in is dropped by usvg without a word.
    if serialized.xml.contains("<text") {
        if request.fonts.is_empty() {
            notes.push(Note {
                element: "text".into(),
                property: Some("font-family".into()),
                value: None,
                reason: "no registered font matches, so the text is not drawn".into(),
            });
        } else {
            // A text that names no family is set in the default one.
            let mut stacks = crate::fonts::families_in_xml(&serialized.xml);
            // The family the root took from the HTML is every text's default,
            // so it counts only when no text names a family of its own.
            if stacks.len() > 1
                && let Some(inherited) = &serialized.inherited_family
            {
                stacks.retain(|s| s != inherited);
            }
            if stacks.is_empty() {
                stacks.push(String::new());
            }
            // The root passes its own (often inherited) family on, so a loaded
            // family anywhere in the source means the text is probably set in it.
            let unloaded: Vec<_> = stacks
                .into_iter()
                .map(|stack| (crate::fonts::unloaded_reason(&stack, &request.fonts), stack))
                .collect();
            if unloaded.iter().all(|(reason, _)| reason.is_some()) {
                for (reason, stack) in unloaded {
                    notes.push(Note {
                        element: "text".into(),
                        property: Some("font-family".into()),
                        value: (!stack.is_empty()).then_some(stack),
                        reason: reason.unwrap_or_default().into(),
                    });
                }
            }
        }
    }
    let mut reported = unsupported(path, notes);
    reported.extend(foreign);
    if children.is_empty() {
        return SvgPaint {
            layer: None,
            unsupported: reported,
        };
    }
    let mut layer = json!({"id": id, "type": "group", "children": children});
    // `overflow: hidden` on the replaced box. A group with a clip has a buffer
    // of its own, which children that blend (mix-blend-mode) would blend into
    // instead of what is behind the SVG, so the clip is only made when
    // something reaches outside the box (a filter's region counts); otherwise
    // the group passes its children's blending through.
    let reach = tree.root().abs_layer_bounding_box();
    let outside = reach.left() < -0.5
        || reach.top() < -0.5
        || reach.right() > size[0] as f32 + 0.5
        || reach.bottom() > size[1] as f32 + 0.5;
    if outside && !serialized.overflow_visible {
        layer["clip"] = json!({
            "kind": "polygon",
            "points": [[0, 0], [size[0], 0], [size[0], size[1]], [0, size[1]]],
        });
    } else {
        layer["passThrough"] = json!(true);
    }
    SvgPaint {
        layer: Some(layer),
        unsupported: reported,
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
///
/// An `<image href>` is read only from inside `base_dir` or `public_dir`
/// (`assets::resolve_under`): usvg's own resolver would read any path, one
/// with `..` or an absolute one outside them included. An href that cannot be
/// read is pushed onto `misses` (usvg drops such an image without a word).
fn options(
    request: &IslandRequest,
    misses: Arc<std::sync::Mutex<Vec<String>>>,
) -> usvg::Options<'static> {
    let roots: Vec<std::path::PathBuf> = [
        Some(request.base_dir.as_str()),
        request.public_dir.as_deref(),
    ]
    .into_iter()
    .flatten()
    .map(std::path::PathBuf::from)
    .collect();
    let mut options = usvg::Options {
        // Nothing reads through this: the resolver below does not use it.
        resources_dir: None,
        font_family: fonts::default_family(&request.fonts),
        font_size: 16.0,
        fontdb: fonts::database(&request.fonts),
        style_sheet: (!request.stylesheets.is_empty()).then(|| request.stylesheets.join("\n")),
        ..usvg::Options::default()
    };
    options.image_href_resolver.resolve_string =
        Box::new(move |href: &str, opts: &usvg::Options| {
            let roots: Vec<&std::path::Path> =
                roots.iter().map(std::path::PathBuf::as_path).collect();
            let bytes = assets::resolve_under(&roots, href).and_then(|p| std::fs::read(p).ok());
            let Some(bytes) = bytes else {
                if let Ok(mut misses) = misses.lock() {
                    misses.push(href.to_string());
                }
                return None;
            };
            let data = Arc::new(bytes);
            match data.as_slice() {
                [0x89, b'P', b'N', b'G', ..] => Some(usvg::ImageKind::PNG(data)),
                [0xff, 0xd8, 0xff, ..] => Some(usvg::ImageKind::JPEG(data)),
                [b'G', b'I', b'F', ..] => Some(usvg::ImageKind::GIF(data)),
                [
                    b'R',
                    b'I',
                    b'F',
                    b'F',
                    _,
                    _,
                    _,
                    _,
                    b'W',
                    b'E',
                    b'B',
                    b'P',
                    ..,
                ] => Some(usvg::ImageKind::WEBP(data)),
                _ => {
                    let svg = usvg::Tree::from_data_nested(&data, opts).ok();
                    if svg.is_none()
                        && let Ok(mut misses) = misses.lock()
                    {
                        misses.push(href.to_string());
                    }
                    svg.map(usvg::ImageKind::SVG)
                }
            }
        });
    options
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    use crate::request::{DomNode, Size};

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nnot really a picture";

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kg-svg-mod-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn request(base: &Path, public: Option<&Path>) -> IslandRequest {
        IslandRequest {
            root: DomNode::Text {
                text: String::new(),
            },
            stylesheets: Vec::new(),
            viewport: Size {
                width: 100.0,
                height: 100.0,
            },
            fonts: BTreeMap::new(),
            base_dir: base.to_string_lossy().into_owned(),
            public_dir: public.map(|p| p.to_string_lossy().into_owned()),
            time: 0.0,
            path: "$0".into(),
            history: Vec::new(),
        }
    }

    fn resolve(request: &IslandRequest, href: &str) -> Option<usvg::ImageKind> {
        let options = options(request, Arc::default());
        (options.image_href_resolver.resolve_string)(href, &options)
    }

    #[test]
    fn an_href_is_read_from_the_project_directories_only() {
        let root = scratch("href");
        let (base, public, other) = (root.join("base"), root.join("public"), root.join("other"));
        for d in [&base, &public, &other] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(base.join("a.png"), PNG).unwrap();
        std::fs::write(public.join("b.png"), PNG).unwrap();
        std::fs::write(other.join("secret.png"), PNG).unwrap();
        let r = request(&base, Some(&public));
        assert!(matches!(
            resolve(&r, "a.png"),
            Some(usvg::ImageKind::PNG(_))
        ));
        // Falls back to the public directory.
        assert!(matches!(
            resolve(&r, "b.png"),
            Some(usvg::ImageKind::PNG(_))
        ));
        // Out of both: `..`, an absolute path, a link to outside.
        assert!(resolve(&r, "../other/secret.png").is_none());
        assert!(resolve(&r, "sub/../../other/secret.png").is_none());
        assert!(resolve(&r, other.join("secret.png").to_str().unwrap()).is_none());
        // An absolute path under a project directory is read (`staticFile()`).
        assert!(matches!(
            resolve(&r, public.join("b.png").to_str().unwrap()),
            Some(usvg::ImageKind::PNG(_))
        ));
        std::os::unix::fs::symlink(other.join("secret.png"), public.join("l.png")).unwrap();
        assert!(resolve(&r, "l.png").is_none());
        assert!(resolve(&r, "missing.png").is_none());
    }

    #[test]
    fn a_data_picture_reaches_the_scene_in_memory() {
        use blitz_dom::DocumentConfig;
        use blitz_html::HtmlDocument;
        use blitz_traits::shell::{ColorScheme, Viewport};
        // A 1x1 PNG.
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        let html = format!(
            r##"<svg id="s" width="20" height="20"><image href="data:image/png;base64,{png}" width="20" height="20"/></svg>"##
        );
        let mut doc = HtmlDocument::from_html(
            &html,
            DocumentConfig {
                viewport: Some(Viewport::new(50, 50, 1.0, ColorScheme::Light)),
                ..Default::default()
            },
        )
        .into_inner();
        doc.resolve(0.0);
        let id = doc.get_element_by_id("s").unwrap();
        let r = request(&scratch("data"), None);
        let painted = paint_svg(&doc, &r, id, [20.0, 20.0], "s", "$0");
        let layer = painted.layer.expect("drawn").to_string();
        assert!(layer.contains(r#""type":"image""#), "{layer}");
        assert!(
            layer.contains(r#""src":"data:image/png;base64,"#),
            "{layer}"
        );
        // And the scene reads it from memory.
        let scene = format!(
            r##"{{"width": 20, "height": 20, "fps": 30, "durationInFrames": 1, "layers": [{layer}]}}"##
        );
        kinetograph_core::Scene::from_json(&scene, PathBuf::from("/nowhere")).unwrap();
    }

    /// A WebP of 4x4 opaque red, lossless.
    fn webp() -> Vec<u8> {
        let mut out = Vec::new();
        image::codecs::webp::WebPEncoder::new_lossless(&mut out)
            .encode(
                &[255, 0, 0, 255].repeat(16),
                4,
                4,
                image::ExtendedColorType::Rgba8,
            )
            .unwrap();
        out
    }

    fn paint(html: &str, request: &IslandRequest) -> SvgPaint {
        use blitz_dom::DocumentConfig;
        use blitz_html::HtmlDocument;
        use blitz_traits::shell::{ColorScheme, Viewport};
        let mut doc = HtmlDocument::from_html(
            html,
            DocumentConfig {
                viewport: Some(Viewport::new(50, 50, 1.0, ColorScheme::Light)),
                ..Default::default()
            },
        )
        .into_inner();
        doc.resolve(0.0);
        let id = doc.get_element_by_id("s").unwrap();
        paint_svg(&doc, request, id, [20.0, 20.0], "s", "$0")
    }

    #[test]
    fn a_webp_and_an_absolute_public_path_are_drawn_and_a_failed_read_is_reported() {
        let root = scratch("webp");
        let public = root.join("public");
        std::fs::create_dir_all(&public).unwrap();
        std::fs::write(public.join("p.webp"), webp()).unwrap();
        let r = request(&root.join("base"), Some(&public));
        // `staticFile()` gives an absolute path.
        let html = format!(
            r##"<svg id="s" width="20" height="20"><image href="{}" width="20" height="20"/></svg>"##,
            public.join("p.webp").display()
        );
        let painted = paint(&html, &r);
        let layer = painted.layer.expect("drawn").to_string();
        assert!(
            layer.contains(r#""src":"data:image/webp;base64,"#),
            "{layer}"
        );
        assert!(painted.unsupported.is_empty(), "{:?}", painted.unsupported);
        let scene = format!(
            r##"{{"width": 20, "height": 20, "fps": 30, "durationInFrames": 1, "layers": [{layer}]}}"##
        );
        let scene = kinetograph_core::Scene::from_json(&scene, PathBuf::from("/nowhere")).unwrap();
        let _ = scene;

        // A file that is not there is said so, not dropped.
        let html = r##"<svg id="s" width="20" height="20"><image href="/nope/missing.png" width="20" height="20"/></svg>"##;
        let painted = paint(html, &r);
        assert!(painted.layer.is_none());
        assert!(
            painted
                .unsupported
                .iter()
                .any(|u| u.element == "image" && u.value.as_deref() == Some("/nope/missing.png")),
            "{:?}",
            painted.unsupported
        );
    }

    #[test]
    fn an_svg_image_cannot_read_outside_either() {
        // The same resolver serves an <image> inside a nested SVG file.
        let root = scratch("nested");
        let (base, other) = (root.join("base"), root.join("other"));
        std::fs::create_dir_all(&base).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("secret.png"), PNG).unwrap();
        let r = request(&base, None);
        let absolute = other.join("secret.png");
        assert!(resolve(&r, absolute.to_str().unwrap()).is_none());
    }
}
