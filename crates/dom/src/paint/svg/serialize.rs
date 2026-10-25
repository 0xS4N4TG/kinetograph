//! An `<svg>` subtree of the document as the SVG source usvg reads.
//!
//! The source is the subtree's attributes, with these changes:
//!
//! - the root is `size` big (its box), and keeps its `viewBox`;
//! - `currentColor` is the element's computed `color`, which Stylo cascaded
//!   from the HTML around it;
//! - names the HTML parser lowercased (`lineargradient`, `viewbox`) are
//!   spelled as SVG spells them;
//! - an element with a `filter` is wrapped: an outer `<g>` takes its `transform`,
//!   `opacity`, `clip-path`, `mask` and `mix-blend-mode`, and an inner marker
//!   `<g id="kgf-N">` holds the element, so the group usvg makes for the marker
//!   is where the filter goes (`FilterUse`). The filter is drawn by us, not by
//!   usvg: it is in the filter's space and goes through `filterGraph`;
//! - CSS `transform`, `rotate`, `scale`, `translate` and `transform-origin` in a
//!   `style` become a `transform` attribute;
//! - an element a `url(#id)` or `href="#id"` names that lives outside the
//!   subtree (a `<filter>` or gradient in another `<svg>`, as React projects
//!   have) is copied into a `<defs>`;
//! - a shape's dashes are scaled by its `pathLength`.

use std::borrow::Cow;
use std::collections::{BTreeSet, HashSet};

use blitz_dom::util::ToColorColor;
use blitz_dom::{BaseDocument, NodeData, NodeId};
use kurbo::{Affine, BezPath, Shape};
use style_traits::ToCss;

use super::css;

/// A reason something is not drawn as Chrome would.
#[derive(Clone, Debug)]
pub struct Note {
    pub element: String,
    pub property: Option<String>,
    pub value: Option<String>,
    pub reason: String,
}

/// An element that has a `filter`: the id of its marker group and what the
/// `filter` property named.
#[derive(Clone, Debug)]
pub struct FilterUse {
    pub group: String,
    /// The ids of the `url(#id)`s, in order.
    pub urls: Vec<String>,
}

pub struct Serialized {
    pub xml: String,
    pub filters: Vec<FilterUse>,
    pub notes: Vec<Note>,
    /// The root says `overflow: visible`.
    pub overflow_visible: bool,
    /// The `font-family` the root took from the HTML around it, when the
    /// `<svg>` sets none of its own.
    pub inherited_family: Option<String>,
}

/// Elements that are not drawn where they are met.
const NOT_DRAWN: [&str; 13] = [
    "defs",
    "clipPath",
    "mask",
    "pattern",
    "marker",
    "symbol",
    "linearGradient",
    "radialGradient",
    "filter",
    "style",
    "title",
    "desc",
    "metadata",
];

const TEXT_CONTAINERS: [&str; 5] = ["text", "tspan", "textPath", "style", "title"];

/// Properties that apply to an element's result after its filter, which the
/// outer group of a filtered element takes.
const COMPOSITING: [&str; 5] = [
    "transform",
    "opacity",
    "clip-path",
    "mask",
    "mix-blend-mode",
];

/// What the root `<svg>` passes on to its content: the inherited presentation
/// properties (the rest of its CSS is the box's, which the caller paints).
const ROOT_INHERITED: [&str; 31] = [
    "fill",
    "fill-opacity",
    "fill-rule",
    "stroke",
    "stroke-width",
    "stroke-opacity",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-dasharray",
    "stroke-dashoffset",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "font-variant",
    "font-stretch",
    "letter-spacing",
    "word-spacing",
    "text-anchor",
    "text-rendering",
    "shape-rendering",
    "image-rendering",
    "paint-order",
    "clip-rule",
    "color-interpolation-filters",
    "visibility",
    "direction",
    "dominant-baseline",
    "color",
    "marker",
];

pub fn canonical_tag(tag: &str) -> String {
    const NAMES: [&str; 30] = [
        "clipPath",
        "feBlend",
        "feColorMatrix",
        "feComponentTransfer",
        "feComposite",
        "feConvolveMatrix",
        "feDiffuseLighting",
        "feDisplacementMap",
        "feDistantLight",
        "feDropShadow",
        "feFlood",
        "feFuncA",
        "feFuncB",
        "feFuncG",
        "feFuncR",
        "feGaussianBlur",
        "feImage",
        "feMerge",
        "feMergeNode",
        "feMorphology",
        "feOffset",
        "fePointLight",
        "feSpecularLighting",
        "feSpotLight",
        "feTile",
        "feTurbulence",
        "foreignObject",
        "linearGradient",
        "radialGradient",
        "textPath",
    ];
    NAMES
        .iter()
        .find(|n| n.eq_ignore_ascii_case(tag))
        .map_or_else(|| tag.to_string(), |n| (*n).to_string())
}

pub fn canonical_attr(name: &str) -> Cow<'_, str> {
    const NAMES: [&str; 43] = [
        "viewBox",
        "preserveAspectRatio",
        "gradientUnits",
        "gradientTransform",
        "spreadMethod",
        "patternUnits",
        "patternContentUnits",
        "patternTransform",
        "clipPathUnits",
        "maskUnits",
        "maskContentUnits",
        "markerUnits",
        "markerWidth",
        "markerHeight",
        "refX",
        "refY",
        "filterUnits",
        "primitiveUnits",
        "stdDeviation",
        "baseFrequency",
        "numOctaves",
        "stitchTiles",
        "xChannelSelector",
        "yChannelSelector",
        "kernelMatrix",
        "kernelUnitLength",
        "tableValues",
        "edgeMode",
        "surfaceScale",
        "diffuseConstant",
        "specularConstant",
        "specularExponent",
        "limitingConeAngle",
        "pointsAtX",
        "pointsAtY",
        "pointsAtZ",
        "preserveAlpha",
        "targetX",
        "targetY",
        "textLength",
        "lengthAdjust",
        "startOffset",
        "pathLength",
    ];
    if name.eq_ignore_ascii_case("xlinkhref") || name.eq_ignore_ascii_case("xlink:href") {
        return Cow::Borrowed("xlink:href");
    }
    NAMES
        .iter()
        .find(|n| n.eq_ignore_ascii_case(name))
        .map_or(Cow::Borrowed(name), |n| Cow::Borrowed(*n))
}

/// The subtree of `node` as SVG source with the root `size` big.
pub fn serialize(doc: &BaseDocument, node: NodeId, size: [f64; 2]) -> Serialized {
    let mut reference = [0.0, 0.0, size[0], size[1]];
    if let Some(n) = doc.get_node(node)
        && let Some(vb) = attr_ci(n, "viewBox")
    {
        let v = css::numbers(vb);
        if v.len() == 4 {
            reference = [v[0], v[1], v[2], v[3]];
        }
    }
    let mut w = Writer {
        doc,
        out: String::new(),
        ids_here: HashSet::new(),
        refs: BTreeSet::new(),
        filters: Vec::new(),
        notes: Vec::new(),
        counter: 0,
        reference,
    };
    let (root_attrs, overflow_visible, inherited_family) = w.root(node, size);
    let body = std::mem::take(&mut w.out);
    // Elements outside the subtree that it refers to (and what they refer to).
    let mut defs = String::new();
    let mut done: BTreeSet<String> = BTreeSet::new();
    loop {
        let next: Vec<String> = w
            .refs
            .iter()
            .filter(|r| !w.ids_here.contains(*r) && !done.contains(*r))
            .cloned()
            .collect();
        if next.is_empty() {
            break;
        }
        for id in next {
            done.insert(id.clone());
            if let Some(n) = doc.get_element_by_id(&id) {
                w.element(n);
                defs.push_str(&std::mem::take(&mut w.out));
            }
        }
    }
    let defs = if defs.is_empty() {
        String::new()
    } else {
        format!("<defs>{defs}</defs>")
    };
    Serialized {
        xml: format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" \
             xmlns:xlink=\"http://www.w3.org/1999/xlink\"{root_attrs}>{defs}{body}</svg>"
        ),
        filters: w.filters,
        notes: w.notes,
        overflow_visible,
        inherited_family,
    }
}

/// An attribute by its name in any letter case.
fn attr_ci<'a>(node: &'a blitz_dom::Node, name: &str) -> Option<&'a str> {
    node.attrs()?
        .iter()
        .find(|a| (*a.name.local).eq_ignore_ascii_case(name))
        .map(|a| &*a.value)
}

struct Writer<'a> {
    doc: &'a BaseDocument,
    out: String,
    ids_here: HashSet<String>,
    refs: BTreeSet<String>,
    filters: Vec<FilterUse>,
    notes: Vec<Note>,
    counter: usize,
    /// `[x, y, width, height]` of the view box: what CSS transforms and their
    /// origins are measured in (`transform-box: view-box`).
    reference: [f64; 4],
}

fn escape(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
}

/// Finds the ids of `url(#id)`s in `value`.
fn scan_refs(value: &str, refs: &mut BTreeSet<String>) {
    let mut rest = value;
    while let Some(i) = rest.find("url(") {
        let after = &rest[i + 4..];
        let end = after.find(')').unwrap_or(after.len());
        let inner = after[..end].trim().trim_matches(['"', '\'']);
        if let Some(id) = inner.strip_prefix('#') {
            refs.insert(id.to_string());
        }
        rest = &after[end..];
    }
}

/// The computed `color` of the node, or of its nearest ancestor with one, as
/// a CSS colour.
pub fn computed_color(doc: &BaseDocument, mut id: NodeId) -> String {
    while let Some(node) = doc.get_node(id) {
        if let Some(style) = node.primary_styles() {
            return rgba(style.clone_color().as_color_color().components);
        }
        match node.parent {
            Some(p) => id = p,
            None => break,
        }
    }
    "#000000".to_string()
}

/// The computed `font-family`, `font-size`, `font-weight` and `font-style` of
/// the node as SVG attributes: Stylo cascaded them from the HTML around the
/// `<svg>`, and text inside it inherits them like any element's.
fn computed_font(doc: &BaseDocument, id: NodeId) -> Attrs {
    let Some(style) = doc.get_node(id).and_then(|n| n.primary_styles()) else {
        return Vec::new();
    };
    let font = style.get_font();
    let font_style = font.font_style.to_css_string();
    vec![
        ("font-family".into(), font.font_family.to_css_string()),
        (
            "font-size".into(),
            format!("{}", font.font_size.computed_size().px()),
        ),
        ("font-weight".into(), format!("{}", font.font_weight.value())),
        (
            "font-style".into(),
            font_style
                .split_whitespace()
                .next()
                .unwrap_or("normal")
                .to_string(),
        ),
    ]
}

fn rgba(c: [f32; 4]) -> String {
    let b = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    if c[3] >= 0.999 {
        format!("#{:02x}{:02x}{:02x}", b(c[0]), b(c[1]), b(c[2]))
    } else {
        format!("rgba({},{},{},{:.3})", b(c[0]), b(c[1]), b(c[2]), c[3])
    }
}

type Attrs = Vec<(String, String)>;

/// Removes `name` from the declarations and the attributes, the declaration
/// winning as CSS has it.
fn take(attrs: &mut Attrs, decls: &mut Attrs, name: &str) -> Option<String> {
    let from_decl = decls
        .iter()
        .position(|(n, _)| n == name)
        .map(|i| decls.remove(i).1);
    let from_attr = attrs
        .iter()
        .position(|(n, _)| n == name)
        .map(|i| attrs.remove(i).1);
    from_decl.or(from_attr)
}

impl Writer<'_> {
    fn current_color(&self, id: NodeId) -> String {
        computed_color(self.doc, id)
    }

    fn note(&mut self, element: &str, property: &str, value: &str, reason: &str) {
        self.notes.push(Note {
            element: element.to_string(),
            property: Some(property.to_string()),
            value: Some(value.to_string()),
            reason: reason.to_string(),
        });
    }

    /// The attributes and style declarations of an element, with
    /// `currentColor` resolved and its references noted.
    fn read(&mut self, id: NodeId) -> Option<(String, Attrs, Attrs)> {
        let node = self.doc.get_node(id)?;
        let NodeData::Element(el) = &node.data else {
            return None;
        };
        let tag = canonical_tag(&el.name.local);
        let mut attrs: Attrs = Vec::new();
        let mut decls: Attrs = Vec::new();
        for a in el.attrs() {
            let name = canonical_attr(&a.name.local);
            let value = a.value.to_string();
            match &*name {
                "style" => decls = css::declarations(&value),
                "xmlns" => {}
                n if n.starts_with("xmlns:") || n.starts_with("data-") => {}
                _ => attrs.push((name.into_owned(), value)),
            }
        }
        let color = self.current_color(id);
        for (_, v) in attrs.iter_mut().chain(decls.iter_mut()) {
            if v.contains("currentColor") {
                *v = v.replace("currentColor", &color);
            }
            scan_refs(v, &mut self.refs);
        }
        if let Some((_, href)) = attrs.iter().find(|(n, _)| n == "xlink:href" || n == "href")
            && let Some(target) = href.strip_prefix('#')
        {
            self.refs.insert(target.to_string());
        }
        if let Some((_, v)) = attrs.iter().find(|(n, _)| n == "id") {
            self.ids_here.insert(v.clone());
        }
        Some((tag, attrs, decls))
    }

    /// The root: its attributes (the box and what its content inherits) and
    /// whether it says `overflow: visible`; its content goes to `out`.
    fn root(&mut self, id: NodeId, size: [f64; 2]) -> (String, bool, Option<String>) {
        let Some((tag, mut attrs, mut decls)) = self.read(id) else {
            return (String::new(), false, None);
        };
        let overflow = take(&mut attrs, &mut decls, "overflow");
        // What the svg does not set itself, its text inherits from the HTML.
        let mut inherited_family = None;
        for (n, v) in computed_font(self.doc, id) {
            if !attrs.iter().chain(decls.iter()).any(|(a, _)| *a == n) {
                if n == "font-family" {
                    inherited_family = Some(v.clone());
                }
                attrs.push((n, v));
            }
        }
        let mut out = String::new();
        let mut put = |n: &str, v: &str| {
            out.push_str(&format!(" {n}=\""));
            escape(v, &mut out);
            out.push('"');
        };
        for (n, v) in &attrs {
            if matches!(n.as_str(), "viewBox" | "preserveAspectRatio")
                || ROOT_INHERITED.contains(&n.as_str())
            {
                put(n, v);
            }
        }
        let inherited: Attrs = decls
            .iter()
            .filter(|(n, _)| ROOT_INHERITED.contains(&n.as_str()))
            .cloned()
            .collect();
        if !inherited.is_empty() {
            put("style", &css::to_style(&inherited));
        }
        put("width", &size[0].to_string());
        put("height", &size[1].to_string());
        self.children(id, &tag);
        (
            out,
            overflow.is_some_and(|o| o == "visible" || o == "auto"),
            inherited_family,
        )
    }

    fn open(&mut self, tag: &str, attrs: &Attrs) {
        self.out.push('<');
        self.out.push_str(tag);
        for (n, v) in attrs {
            self.out.push(' ');
            self.out.push_str(n);
            self.out.push_str("=\"");
            escape(v, &mut self.out);
            self.out.push('"');
        }
        self.out.push('>');
    }

    fn children(&mut self, id: NodeId, tag: &str) {
        let Some(node) = self.doc.get_node(id) else {
            return;
        };
        let children: Vec<NodeId> = node.children.iter().copied().collect();
        for child in children {
            let Some(c) = self.doc.get_node(child) else {
                continue;
            };
            match &c.data {
                NodeData::Element(_) => self.element(child),
                NodeData::Text(t) if TEXT_CONTAINERS.contains(&tag) => {
                    escape(&t.content, &mut self.out);
                }
                _ => {}
            }
        }
    }

    /// The `transform` attribute for an element that has CSS transform
    /// properties.
    fn css_transform(&mut self, tag: &str, attrs: &mut Attrs, decls: &mut Attrs) -> Option<String> {
        let names = [
            "transform",
            "transform-origin",
            "transform-box",
            "rotate",
            "scale",
            "translate",
        ];
        if !decls.iter().any(|(n, _)| names.contains(&n.as_str())) {
            return None;
        }
        let reference = self.reference;
        let size = [reference[2], reference[3]];
        let transform = decls
            .iter()
            .position(|(n, _)| n == "transform")
            .map(|i| decls.remove(i).1);
        let origin = take(attrs, decls, "transform-origin");
        let tbox = take(attrs, decls, "transform-box");
        let rotate = take(attrs, decls, "rotate");
        let scale = take(attrs, decls, "scale");
        let translate = take(attrs, decls, "translate");
        if let Some(b) = &tbox
            && matches!(
                b.as_str(),
                "fill-box" | "stroke-box" | "content-box" | "border-box"
            )
        {
            self.note(
                tag,
                "transform-box",
                b,
                "only view-box is supported; the viewBox is used",
            );
        }
        let mut m = Affine::IDENTITY;
        if let Some(v) = &translate {
            let p: Vec<&str> = v.split_whitespace().collect();
            match (
                p.first().and_then(|a| css::length(a, size[0])),
                p.get(1).map_or(Some(0.0), |b| css::length(b, size[1])),
            ) {
                (Some(x), Some(y)) => m *= Affine::translate((x, y)),
                _ => self.note(tag, "translate", v, "not understood"),
            }
        }
        if let Some(v) = &rotate {
            match css::angle(v) {
                Some(a) => m *= Affine::rotate(a.to_radians()),
                None => self.note(
                    tag,
                    "rotate",
                    v,
                    "only a rotation about the z axis is supported",
                ),
            }
        }
        if let Some(v) = &scale {
            let p = css::numbers(v);
            match p.as_slice() {
                [s] => m *= Affine::scale(*s),
                [x, y] | [x, y, _] => m *= Affine::scale_non_uniform(*x, *y),
                _ => self.note(tag, "scale", v, "not understood"),
            }
        }
        // The transform list, or the attribute, which is the same property.
        let list = transform.or_else(|| {
            attrs
                .iter()
                .position(|(n, _)| n == "transform")
                .map(|i| attrs.remove(i).1)
        });
        if let Some(v) = &list {
            match css::transform_list(v, size) {
                Some(t) => m *= t,
                None => self.note(tag, "transform", v, "not understood"),
            }
        }
        // SVG elements turn about the view box's corner unless told otherwise.
        let o = origin
            .as_deref()
            .and_then(|o| css::transform_origin(o, reference))
            .unwrap_or([0.0, 0.0]);
        let m = Affine::translate((o[0], o[1])) * m * Affine::translate((-o[0], -o[1]));
        let c = m.as_coeffs();
        Some(format!(
            "matrix({} {} {} {} {} {})",
            c[0], c[1], c[2], c[3], c[4], c[5]
        ))
    }

    fn element(&mut self, id: NodeId) {
        let Some((tag, mut attrs, mut decls)) = self.read(id) else {
            return;
        };
        let filter = take(&mut attrs, &mut decls, "filter");
        if let Some(scale) = path_length_scale(&tag, &attrs) {
            rescale_dashes(&mut attrs, &mut decls, scale);
        }
        let transform = self.css_transform(&tag, &mut attrs, &mut decls);
        if let Some(t) = transform {
            attrs.retain(|(n, _)| n != "transform");
            attrs.push(("transform".into(), t));
        }
        if !decls.is_empty() {
            attrs.push(("style".into(), css::to_style(&decls)));
        }
        let drawn = !NOT_DRAWN.contains(&tag.as_str());
        let urls = match &filter {
            Some(f) if drawn => filter_urls(f, &tag, &mut self.notes),
            _ => Vec::new(),
        };
        if urls.is_empty() {
            self.open(&tag, &attrs);
            self.children(id, &tag);
            self.out.push_str(&format!("</{tag}>"));
            return;
        }
        self.counter += 1;
        let group = format!("kgf-{}", self.counter);
        self.filters.push(FilterUse {
            group: group.clone(),
            urls,
        });
        // The outer group takes what applies after the filter.
        let mut outer: Attrs = Vec::new();
        for name in COMPOSITING {
            if let Some(i) = attrs.iter().position(|(n, _)| n == name) {
                outer.push(attrs.remove(i));
            }
        }
        if let Some(i) = attrs.iter().position(|(n, _)| n == "style") {
            let (comp, rest): (Vec<_>, Vec<_>) = css::declarations(&attrs[i].1)
                .into_iter()
                .partition(|(n, _)| COMPOSITING.contains(&n.as_str()));
            if !comp.is_empty() {
                outer.push(("style".into(), css::to_style(&comp)));
                if rest.is_empty() {
                    attrs.remove(i);
                } else {
                    attrs[i].1 = css::to_style(&rest);
                }
            }
        }
        self.open("g", &outer);
        self.out
            .push_str(&format!("<g id=\"{group}\" style=\"isolation:isolate\">"));
        if tag == "g" {
            self.children(id, &tag);
        } else {
            self.open(&tag, &attrs);
            self.children(id, &tag);
            self.out.push_str(&format!("</{tag}>"));
        }
        self.out.push_str("</g></g>");
    }
}

/// The `url(#id)`s of a `filter` value; what else it holds is noted.
fn filter_urls(value: &str, tag: &str, notes: &mut Vec<Note>) -> Vec<String> {
    let mut urls = Vec::new();
    let mut rest = value;
    let mut other = String::new();
    while let Some(i) = rest.find("url(") {
        other.push_str(&rest[..i]);
        let after = &rest[i + 4..];
        let end = after.find(')').unwrap_or(after.len());
        let inner = after[..end].trim().trim_matches(['"', '\'']);
        if let Some(id) = inner.strip_prefix('#') {
            urls.push(id.to_string());
        }
        rest = after.get(end + 1..).unwrap_or("");
    }
    other.push_str(rest);
    if !other.trim().is_empty() && !other.trim().eq_ignore_ascii_case("none") {
        notes.push(Note {
            element: tag.to_string(),
            property: Some("filter".to_string()),
            value: Some(other.trim().to_string()),
            reason: "CSS filter functions on SVG elements are not drawn".to_string(),
        });
    }
    urls
}

/// How much longer the shape is than its `pathLength`, if it has one.
fn path_length_scale(tag: &str, attrs: &Attrs) -> Option<f64> {
    let get = |name: &str| {
        attrs
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    };
    let declared: f64 = get("pathLength")?
        .trim()
        .parse()
        .ok()
        .filter(|v: &f64| *v > 0.0)?;
    let num = |name: &str| {
        get(name)
            .and_then(|v| css::dimension(v))
            .map_or(0.0, |(n, _)| n)
    };
    let actual = match tag {
        "path" => BezPath::from_svg(get("d")?).ok()?.perimeter(0.01),
        "circle" => std::f64::consts::TAU * num("r"),
        "ellipse" => kurbo::Ellipse::new((0.0, 0.0), (num("rx"), num("ry")), 0.0).perimeter(0.01),
        "rect" => 2.0 * (num("width") + num("height")),
        "line" => ((num("x2") - num("x1")).powi(2) + (num("y2") - num("y1")).powi(2)).sqrt(),
        _ => return None,
    };
    (actual > 0.0).then_some(actual / declared)
}

/// Multiplies the dash lengths and the offset by `scale`.
fn rescale_dashes(attrs: &mut Attrs, decls: &mut Attrs, scale: f64) {
    for list in [attrs, decls] {
        for (n, v) in list.iter_mut() {
            if n == "stroke-dasharray" {
                *v = css::numbers(v)
                    .iter()
                    .map(|d| (d * scale).to_string())
                    .collect::<Vec<_>>()
                    .join(" ");
            } else if n == "stroke-dashoffset"
                && let Some((d, _)) = css::dimension(v)
            {
                *v = (d * scale).to_string();
            }
        }
    }
}
