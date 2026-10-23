//! A `<filter>` element of the document as a `filterGraph` effect
//! (`packages/cli/skills/kinetograph/references/SCENE.md`).
//!
//! The attributes are the scene's attributes, as SVG spells them, so this only
//! reads them: the units, the default region and subregions, `in`/`result`
//! links and the rest are what the core does with them. What `usvg` would
//! resolve for us it resolves differently from a browser (the default
//! subregion of a primitive that reads another), which is why the filter is
//! not taken from it.

use std::str::FromStr;

use blitz_dom::{BaseDocument, NodeData, NodeId};
use serde_json::{Map, Value, json};

use super::css;
use super::serialize::{Note, canonical_attr, canonical_tag, computed_color};

/// A number as JSON: whole numbers as integers, which the scene wants for
/// `numOctaves` and friends.
pub fn number(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        Value::from(v as i64)
    } else {
        Value::from(v)
    }
}

struct Element<'a> {
    doc: &'a BaseDocument,
    id: NodeId,
}

impl<'a> Element<'a> {
    fn tag(&self) -> String {
        match self.doc.get_node(self.id).map(|n| &n.data) {
            Some(NodeData::Element(e)) => canonical_tag(&e.name.local),
            _ => String::new(),
        }
    }

    /// An attribute, or the CSS declaration of the same name in `style`
    /// (which wins), by its SVG name.
    fn prop(&self, name: &str) -> Option<String> {
        let node = self.doc.get_node(self.id)?;
        let NodeData::Element(e) = &node.data else {
            return None;
        };
        let mut found = None;
        for a in e.attrs() {
            if canonical_attr(&a.name.local) == name {
                found = Some(a.value.to_string());
            }
        }
        if let Some(style) = e.attrs().iter().find(|a| &*a.name.local == "style")
            && let Some((_, v)) = css::declarations(&style.value)
                .into_iter()
                .find(|(n, _)| n == name)
        {
            found = Some(v);
        }
        found
    }

    fn children(&self) -> Vec<Element<'a>> {
        let Some(node) = self.doc.get_node(self.id) else {
            return Vec::new();
        };
        node.children
            .iter()
            .filter(|&&c| {
                matches!(
                    self.doc.get_node(c).map(|n| &n.data),
                    Some(NodeData::Element(_))
                )
            })
            .map(|&c| Element {
                doc: self.doc,
                id: c,
            })
            .collect()
    }
}

/// What a length or percentage is, in the units the attribute is in:
/// `objectBoundingBox` units take a fraction (`10%` is 0.1), user units a
/// length (`10%` is of the viewport's `viewport` side).
fn coordinate(s: &str, bbox_units: bool, viewport: f64) -> Option<Value> {
    let (n, unit) = css::dimension(s)?;
    let v = match unit {
        "%" if bbox_units => n / 100.0,
        "%" => n / 100.0 * viewport,
        "" | "px" => n,
        _ => css::length(s, viewport)?,
    };
    Some(number(v))
}

fn numbers(s: &str) -> Value {
    let v = css::numbers(s);
    if v.len() == 1 {
        number(v[0])
    } else {
        Value::Array(v.into_iter().map(number).collect())
    }
}

/// A CSS colour as `#rrggbbaa`.
fn color(doc: &BaseDocument, el: &Element, s: &str) -> Option<String> {
    let s = s.trim();
    let resolved;
    let s = if s.eq_ignore_ascii_case("currentcolor") {
        resolved = computed_color(doc, el.id);
        resolved.as_str()
    } else {
        s
    };
    let c = svgtypes::Color::from_str(s).ok()?;
    Some(format!(
        "#{:02x}{:02x}{:02x}{:02x}",
        c.red, c.green, c.blue, c.alpha
    ))
}

/// The `filterGraph` for the `<filter>` with `id` anywhere in `doc`, or `None`
/// if there is none. `bbox` is `[x, y, width, height]` of what the filter is
/// on; `viewport` the size percentages in user units are of.
pub fn effect(
    doc: &BaseDocument,
    id: &str,
    bbox: Option<[f64; 4]>,
    viewport: [f64; 2],
    notes: &mut Vec<Note>,
) -> Option<Value> {
    let start = doc.get_element_by_id(id)?;
    let first = Element { doc, id: start };
    if first.tag() != "filter" {
        return None;
    }
    // `href` to another filter lends its attributes and, if this one has none,
    // its primitives.
    let mut chain = vec![first];
    let mut seen = vec![start];
    while let Some(next) = chain
        .last()
        .and_then(|e| e.prop("xlink:href").or_else(|| e.prop("href")))
        .and_then(|h| h.strip_prefix('#').map(str::to_string))
        .and_then(|h| doc.get_element_by_id(&h))
    {
        if seen.contains(&next) || chain.len() > 8 {
            break;
        }
        let e = Element { doc, id: next };
        if e.tag() != "filter" {
            break;
        }
        seen.push(next);
        chain.push(e);
    }
    let attr = |name: &str| chain.iter().find_map(|e| e.prop(name));
    let filter_units = attr("filterUnits").unwrap_or_else(|| "objectBoundingBox".to_string());
    let primitive_units = attr("primitiveUnits").unwrap_or_else(|| "userSpaceOnUse".to_string());
    let bbox_units = filter_units == "objectBoundingBox";
    let prim_bbox = primitive_units == "objectBoundingBox";

    let mut g = Map::new();
    g.insert("type".into(), json!("filterGraph"));
    g.insert("filterUnits".into(), json!(filter_units));
    g.insert("primitiveUnits".into(), json!(primitive_units));
    for (key, axis) in [("x", 0), ("y", 1), ("width", 0), ("height", 1)] {
        if let Some(v) = attr(key).and_then(|v| coordinate(&v, bbox_units, viewport[axis])) {
            g.insert(key.into(), v);
        }
    }
    if let Some(c) = attr("color-interpolation-filters") {
        g.insert(
            "colorInterpolationFilters".into(),
            json!(if c == "sRGB" || c == "auto" {
                "sRGB"
            } else {
                "linearRGB"
            }),
        );
    }
    if let Some(b) = bbox {
        g.insert("bbox".into(), json!(b.map(number)));
    }
    let source = chain
        .iter()
        .find(|e| !e.children().is_empty())
        .unwrap_or(&chain[0]);
    let mut primitives = Vec::new();
    for child in source.children() {
        let tag = child.tag();
        if !tag.starts_with("fe") {
            continue;
        }
        match primitive(doc, &child, &tag, prim_bbox, viewport, notes) {
            Some(p) => primitives.push(p),
            None => {
                notes.push(Note {
                    element: tag.clone(),
                    property: None,
                    value: None,
                    reason: format!("{tag} is not drawn: a transparent image takes its place"),
                });
                // Later primitives can still read its result.
                let mut placeholder = json!({"primitive": "feFlood", "floodOpacity": 0});
                if let Some(r) = child.prop("result") {
                    placeholder["result"] = json!(r.trim());
                }
                primitives.push(placeholder);
            }
        }
    }
    g.insert("primitives".into(), Value::Array(primitives));
    Some(Value::Object(g))
}

/// One primitive, or `None` if it cannot be drawn (the caller makes it a
/// transparent flood, so that later primitives can still read its result).
fn primitive(
    doc: &BaseDocument,
    el: &Element,
    tag: &str,
    prim_bbox: bool,
    viewport: [f64; 2],
    notes: &mut Vec<Note>,
) -> Option<Value> {
    let mut p = Map::new();
    p.insert("primitive".into(), json!(tag));
    for (key, axis) in [("x", 0), ("y", 1), ("width", 0), ("height", 1)] {
        if let Some(v) = el
            .prop(key)
            .and_then(|v| coordinate(&v, prim_bbox, viewport[axis]))
        {
            p.insert(key.into(), v);
        }
    }
    for key in ["in", "in2", "result"] {
        if let Some(v) = el.prop(key) {
            p.insert(key.into(), json!(v.trim()));
        }
    }
    if let Some(c) = el.prop("color-interpolation-filters") {
        p.insert(
            "colorInterpolationFilters".into(),
            json!(if c == "sRGB" || c == "auto" {
                "sRGB"
            } else {
                "linearRGB"
            }),
        );
    }
    let text = |p: &mut Map<String, Value>, name: &str| {
        if let Some(v) = el.prop(name) {
            p.insert(name.into(), json!(v.trim()));
        }
    };
    let num = |p: &mut Map<String, Value>, name: &str| {
        if let Some((n, _)) = el.prop(name).as_deref().and_then(css::dimension) {
            p.insert(name.into(), number(n));
        }
    };
    let list = |p: &mut Map<String, Value>, name: &str| {
        if let Some(v) = el.prop(name) {
            p.insert(name.into(), numbers(&v));
        }
    };
    let as_list = |p: &mut Map<String, Value>, name: &str| {
        // A list the scene wants as an array even with one number.
        if let Some(v) = el.prop(name) {
            p.insert(
                name.into(),
                Value::Array(css::numbers(&v).into_iter().map(number).collect()),
            );
        }
    };
    let colour = |p: &mut Map<String, Value>, name: &str, key: &str| {
        if let Some(c) = el.prop(name).and_then(|v| color(doc, el, &v)) {
            p.insert(key.into(), json!(c));
        }
    };
    match tag {
        "feTurbulence" => {
            text(&mut p, "type");
            list(&mut p, "baseFrequency");
            num(&mut p, "numOctaves");
            num(&mut p, "seed");
            if let Some(v) = el.prop("stitchTiles") {
                p.insert("stitchTiles".into(), json!(v.trim() == "stitch"));
            }
        }
        "feDisplacementMap" => {
            num(&mut p, "scale");
            text(&mut p, "xChannelSelector");
            text(&mut p, "yChannelSelector");
        }
        "feGaussianBlur" => list(&mut p, "stdDeviation"),
        "feColorMatrix" => {
            text(&mut p, "type");
            as_list(&mut p, "values");
        }
        "feOffset" => {
            num(&mut p, "dx");
            num(&mut p, "dy");
        }
        "feFlood" => {
            colour(&mut p, "flood-color", "floodColor");
            num(&mut p, "flood-opacity");
            rename(&mut p, "flood-opacity", "floodOpacity");
        }
        "feComposite" => {
            text(&mut p, "operator");
            for k in ["k1", "k2", "k3", "k4"] {
                num(&mut p, k);
            }
        }
        "feBlend" => text(&mut p, "mode"),
        "feMerge" => {
            let nodes: Vec<Value> = el
                .children()
                .iter()
                .filter(|c| c.tag() == "feMergeNode")
                .map(|c| json!(c.prop("in").unwrap_or_default().trim()))
                .collect();
            p.insert("nodes".into(), Value::Array(nodes));
        }
        "feComponentTransfer" => {
            for child in el.children() {
                let key = match child.tag().as_str() {
                    "feFuncR" => "funcR",
                    "feFuncG" => "funcG",
                    "feFuncB" => "funcB",
                    "feFuncA" => "funcA",
                    _ => continue,
                };
                let mut f = Map::new();
                if let Some(t) = child.prop("type") {
                    f.insert("type".into(), json!(t.trim()));
                }
                if let Some(v) = child.prop("tableValues") {
                    f.insert(
                        "tableValues".into(),
                        Value::Array(css::numbers(&v).into_iter().map(number).collect()),
                    );
                }
                for k in ["slope", "intercept", "amplitude", "exponent", "offset"] {
                    if let Some((n, _)) = child.prop(k).as_deref().and_then(css::dimension) {
                        f.insert(k.into(), number(n));
                    }
                }
                p.insert(key.into(), Value::Object(f));
            }
        }
        "feDropShadow" => {
            num(&mut p, "dx");
            num(&mut p, "dy");
            list(&mut p, "stdDeviation");
            colour(&mut p, "flood-color", "floodColor");
            num(&mut p, "flood-opacity");
            rename(&mut p, "flood-opacity", "floodOpacity");
        }
        "feMorphology" => {
            text(&mut p, "operator");
            list(&mut p, "radius");
        }
        "feTile" => {}
        "feConvolveMatrix" => {
            list(&mut p, "order");
            as_list(&mut p, "kernelMatrix");
            for k in ["divisor", "bias", "targetX", "targetY"] {
                num(&mut p, k);
            }
            text(&mut p, "edgeMode");
            if let Some(v) = el.prop("preserveAlpha") {
                p.insert("preserveAlpha".into(), json!(v.trim() == "true"));
            }
        }
        "feDiffuseLighting" | "feSpecularLighting" => {
            num(&mut p, "surfaceScale");
            num(&mut p, "diffuseConstant");
            num(&mut p, "specularConstant");
            num(&mut p, "specularExponent");
            colour(&mut p, "lighting-color", "lightingColor");
            let light = el.children().into_iter().find_map(|c| {
                let kind = match c.tag().as_str() {
                    "feDistantLight" => "distant",
                    "fePointLight" => "point",
                    "feSpotLight" => "spot",
                    _ => return None,
                };
                let mut l = Map::new();
                l.insert("type".into(), json!(kind));
                for k in [
                    "azimuth",
                    "elevation",
                    "x",
                    "y",
                    "z",
                    "pointsAtX",
                    "pointsAtY",
                    "pointsAtZ",
                    "specularExponent",
                    "limitingConeAngle",
                ] {
                    if let Some((n, _)) = c.prop(k).as_deref().and_then(css::dimension) {
                        l.insert(k.into(), number(n));
                    }
                }
                Some(Value::Object(l))
            });
            // A lighting filter with no light is an error, which draws nothing.
            p.insert("light".into(), light?);
        }
        "feImage" => {
            notes.push(Note {
                element: tag.to_string(),
                property: Some("href".into()),
                value: el.prop("href").or_else(|| el.prop("xlink:href")),
                reason: "feImage is not supported".into(),
            });
            return None;
        }
        _ => return None,
    }
    Some(Value::Object(p))
}

fn rename(p: &mut Map<String, Value>, from: &str, to: &str) {
    if let Some(v) = p.remove(from) {
        p.insert(to.into(), v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use blitz_dom::DocumentConfig;
    use blitz_html::HtmlDocument;
    use blitz_traits::shell::{ColorScheme, Viewport};

    fn doc(html: &str) -> BaseDocument {
        let mut doc = HtmlDocument::from_html(
            html,
            DocumentConfig {
                viewport: Some(Viewport::new(200, 200, 1.0, ColorScheme::Light)),
                ..Default::default()
            },
        )
        .into_inner();
        doc.resolve(0.0);
        doc
    }

    #[test]
    fn a_filter_becomes_a_filter_graph_with_its_attributes() {
        let d = doc(
            r##"<svg><filter id="torn" x="-6%" y="-10%" width="112%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency="0.11" numOctaves="3" seed="11" result="n"/>
            <feDisplacementMap in="SourceGraphic" in2="n" scale="7" xChannelSelector="R" yChannelSelector="G"/>
        </filter></svg>"##,
        );
        let mut notes = Vec::new();
        let e = effect(
            &d,
            "torn",
            Some([0.0, 0.0, 100.0, 50.0]),
            [200.0, 200.0],
            &mut notes,
        )
        .unwrap();
        assert_eq!(e["type"], "filterGraph");
        assert_eq!(e["filterUnits"], "objectBoundingBox");
        assert_eq!(e["x"], json!(-0.06));
        assert_eq!(e["width"], json!(1.12));
        assert_eq!(e["bbox"], json!([0, 0, 100, 50]));
        let p = e["primitives"].as_array().unwrap();
        assert_eq!(p.len(), 2);
        assert_eq!(p[0]["primitive"], "feTurbulence");
        assert_eq!(p[0]["numOctaves"], json!(3));
        assert_eq!(p[0]["baseFrequency"], json!(0.11));
        assert_eq!(p[0]["seed"], json!(11));
        assert_eq!(p[1]["in2"], "n");
        assert_eq!(p[1]["scale"], json!(7));
        assert!(notes.is_empty());
        // It reads as the scene's own type.
        let layer = json!({"width": 10, "height": 10, "fps": 30, "durationInFrames": 1,
            "layers": [{"id": "a", "type": "group", "children": [], "effects": [e]}]});
        kinetograph_core::Scene::from_json(&layer.to_string(), Default::default()).unwrap();
    }

    #[test]
    fn lowercased_names_and_other_attributes_are_read() {
        // The HTML parser keeps SVG's camelCase, but a project's host tree may
        // not.
        let d = doc(
            r##"<svg><filter id="f" filterunits="userSpaceOnUse" x="0" y="0" width="50%" height="20">
            <fegaussianblur stddeviation="3 0"/>
            <fecolormatrix type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0"/>
            <feflood flood-color="purple" flood-opacity="0.5"/>
            <fecomponenttransfer><fefuncr type="table" tablevalues="0 1"/></fecomponenttransfer>
            <fedistantlight azimuth="45"/>
        </filter></svg>"##,
        );
        let mut notes = Vec::new();
        let e = effect(&d, "f", None, [200.0, 100.0], &mut notes).unwrap();
        assert_eq!(e["filterUnits"], "userSpaceOnUse");
        assert_eq!(e["width"], json!(100));
        let p = e["primitives"].as_array().unwrap();
        assert_eq!(p[0]["stdDeviation"], json!([3, 0]));
        assert_eq!(p[2]["floodColor"], "#800080ff");
        assert_eq!(p[2]["floodOpacity"], json!(0.5));
        assert_eq!(p[3]["funcR"]["tableValues"], json!([0, 1]));
    }

    #[test]
    fn a_missing_or_wrong_element_is_none() {
        let d = doc(r##"<svg><rect id="r"/></svg>"##);
        let mut notes = Vec::new();
        assert!(effect(&d, "nope", None, [1.0, 1.0], &mut notes).is_none());
        assert!(effect(&d, "r", None, [1.0, 1.0], &mut notes).is_none());
    }

    #[test]
    fn href_lends_primitives_and_an_unsupported_one_is_noted() {
        let d = doc(r##"<svg>
            <filter id="base"><feOffset dx="3"/></filter>
            <filter id="derived" href="#base" filterUnits="userSpaceOnUse" x="0" y="0" width="9" height="9"/>
            <filter id="img"><feImage href="#base" result="i"/><feOffset in="i" dx="1"/></filter></svg>"##);
        let mut notes = Vec::new();
        let e = effect(&d, "derived", None, [1.0, 1.0], &mut notes).unwrap();
        assert_eq!(e["primitives"].as_array().unwrap().len(), 1);
        assert_eq!(e["filterUnits"], "userSpaceOnUse");
        let e = effect(&d, "img", None, [1.0, 1.0], &mut notes).unwrap();
        assert_eq!(e["primitives"].as_array().unwrap().len(), 2);
        assert_eq!(e["primitives"][0]["result"], "i");
        assert!(notes.iter().any(|n| n.element == "feImage"));
    }
}
