//! `mask-image` on an SVG element when it is a list, or has a gradient in it (CSS Masking 1): usvg reads one
//! `mask="url(#id)"` and no gradient, so the layers are written as SVG it does read.
//!
//! - A `url(#id)` layer is the `<mask>` element it names.
//! - A gradient layer is a `<mask mask-type="alpha">` filled with that gradient, which is the computed one with `var()`
//!   resolved. CSS Masking 1 (https://www.w3.org/TR/css-masking-1/), for an SVG element without an associated CSS
//!   layout box: `mask-origin` (7.6) computes `content-box`, `padding-box` and `border-box` to `fill-box`, so the
//!   gradient is laid out on the fill box; `mask-clip` (7.5) computes `border-box` (the initial value) to
//!   `stroke-box`, so the mask paints over the stroke box, the fill box grown by half the stroke width. Past the
//!   fill box the gradient continues with its end colours: `mask-repeat` is not applied, and a layer that `repeat`s into
//!   a stroke wider than zero is reported once for the element.
//! - Layers combined by `mask-composite: intersect` multiply: the first layer is the element's own `mask` and each
//!   other one is a group around the element. `add`, `subtract` and `exclude` between layers are not written.
//!
//! `mask-size`, `mask-position` and `mask-repeat` are not applied: a gradient layer fills the box.

use blitz_dom::{BaseDocument, NodeId};
use kurbo::{BezPath, Shape};
use serde_json::Value;
use style::properties::{LonghandId, PropertyDeclarationId};
use style::values::computed::{BackgroundRepeat, Image};
use style::values::computed::url::ComputedUrl;

use super::css;
use super::serialize::{Attrs, Note, attr_ci, declared};
use crate::paint::geom::Rect;
use crate::paint::gradient::gradient_paint;
use crate::paint::util::current_color;

/// What the layers of an element's `mask-image` come to.
pub struct MaskPlan {
    /// `<linearGradient>`s and `<mask>`s the layers need, to be written before the element.
    pub defs: String,
    /// The `<mask>` ids to apply, the first on the element and the others on groups around it.
    pub masks: Vec<String>,
    /// The `<mask>` elements named, which may be outside the subtree.
    pub refs: Vec<String>,
    pub notes: Vec<Note>,
}

impl MaskPlan {
    fn note(&mut self, tag: &str, value: impl Into<String>, reason: &str) {
        self.notes.push(Note {
            element: tag.to_string(),
            property: Some("mask-image".to_string()),
            value: Some(value.into()),
            reason: reason.to_string(),
        });
    }
}

/// The plan for the element's `mask-image`, or `None` when there is none or it is a lone `url(#id)`, which is the
/// element's `mask` as it stands.
pub fn plan(
    doc: &BaseDocument,
    id: NodeId,
    tag: &str,
    attrs: &Attrs,
    decls: &Attrs,
    reference: [f64; 4],
    counter: &mut usize,
) -> Option<MaskPlan> {
    let node = doc.get_node(id)?;
    let style = node.primary_styles()?;
    let svg = style.get_svg();
    let images = &svg.mask_image.0;
    if images.iter().all(|i| matches!(i, Image::None))
        || (images.len() == 1 && matches!(images[0], Image::Url(_)))
    {
        return None;
    }
    let current = current_color(&style);
    let mut plan = MaskPlan {
        defs: String::new(),
        masks: Vec::new(),
        refs: Vec::new(),
        notes: Vec::new(),
    };
    let boxed = fill_box(tag, attrs, reference);
    if boxed.is_none() {
        plan.note(
            tag,
            tag,
            "the box of this element is not known here, so a gradient mask layer fills the view box",
        );
    }
    let bounds = boxed.unwrap_or(Rect::new(
        reference[0],
        reference[1],
        reference[2],
        reference[3],
    ));
    let grow = stroke_reach(doc, id, attrs, decls, reference[2]);
    let area = Rect::new(
        bounds.x - grow,
        bounds.y - grow,
        bounds.w + 2.0 * grow,
        bounds.h + 2.0 * grow,
    );
    let composite = &svg.mask_composite.0;
    let repeats = &svg.mask_repeat.0;
    let mut told_repeat = false;
    let last = images.len() - 1;
    for (i, image) in images.iter().enumerate() {
        if matches!(image, Image::None) {
            continue;
        }
        // Each layer but the bottom one is combined with the layers below it.
        if i != last {
            let op = if composite.is_empty() {
                "Add".to_string()
            } else {
                format!("{:?}", composite[i % composite.len()])
            };
            if op != "Intersect" {
                plan.note(
                    tag,
                    op,
                    "only intersect is drawn between mask layers of an SVG element, so this layer is left out",
                );
                continue;
            }
        }
        match image {
            Image::Url(url) => {
                let text = match url {
                    ComputedUrl::Valid(u) => u.as_str(),
                    ComputedUrl::Invalid(s) => s.as_ref(),
                };
                match text.rsplit_once('#') {
                    Some((_, fragment)) if !fragment.is_empty() => {
                        plan.masks.push(fragment.to_string());
                        plan.refs.push(fragment.to_string());
                    }
                    _ => plan.note(
                        tag,
                        "url()",
                        "a picture as a mask layer of an SVG element is not drawn",
                    ),
                }
            }
            Image::Gradient(g) => match gradient_paint(g, bounds, &current) {
                Ok(paint) => {
                    // The initial `mask-repeat` tiles the layer over the stroke box; it is drawn as one tile.
                    let tiled = repeats.is_empty() || {
                        let BackgroundRepeat(x, y) = repeats[i % repeats.len()];
                        format!("{x:?}") != "NoRepeat" || format!("{y:?}") != "NoRepeat"
                    };
                    if grow > 0.0 && tiled && !told_repeat {
                        told_repeat = true;
                        plan.notes.push(Note {
                            element: tag.to_string(),
                            property: Some("mask-repeat".to_string()),
                            value: Some("repeat".to_string()),
                            reason: "mask-repeat on an SVG element's mask layer is drawn as no-repeat"
                                .to_string(),
                        });
                    }
                    *counter += 1;
                    let name = format!("kgm-{counter}");
                    match gradient_mask(&name, &paint, area) {
                        Some(xml) => {
                            plan.defs.push_str(&xml);
                            plan.masks.push(name);
                        }
                        None => plan.note(
                            tag,
                            "conic-gradient()",
                            "a conic gradient as a mask layer of an SVG element is not drawn",
                        ),
                    }
                }
                Err(reason) => plan.note(tag, "gradient", &reason),
            },
            other => plan.note(
                tag,
                format!("{other:?}"),
                "this kind of image is not drawn as a mask layer of an SVG element",
            ),
        }
    }
    Some(plan)
}

/// The `<defs>` holding the gradient of the scene gradient `paint` and the alpha `<mask>` `name` of the box `bounds`
/// (the stroke box) filled with it. `None` for a kind that has no SVG form here (conic).
fn gradient_mask(name: &str, paint: &Value, bounds: Rect) -> Option<String> {
    let num = |k: &str| paint[k].as_f64().unwrap_or(0.0);
    let stops = |out: &mut String| {
        for stop in paint["stops"].as_array().into_iter().flatten() {
            let (rgb, alpha) = split_hex(stop["color"].as_str().unwrap_or("#000000"));
            out.push_str(&format!(
                "<stop offset=\"{}\" stop-color=\"{rgb}\" stop-opacity=\"{alpha}\"/>",
                stop["offset"].as_f64().unwrap_or(0.0)
            ));
        }
    };
    let spread = if paint["extend"] == "repeat" {
        " spreadMethod=\"repeat\""
    } else {
        ""
    };
    let mut xml = String::new();
    let (fill, opacity) = if let Some(hex) = paint.as_str() {
        // A gradient with no extent is one colour.
        let (rgb, alpha) = split_hex(hex);
        (rgb, format!(" fill-opacity=\"{alpha}\""))
    } else {
        match paint["type"].as_str() {
            Some("linear") => xml.push_str(&format!(
                "<linearGradient id=\"{name}-g\" gradientUnits=\"userSpaceOnUse\" x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\"{spread}>",
                num("x0"),
                num("y0"),
                num("x1"),
                num("y1")
            )),
            Some("radial") => {
                let matrix = paint["transform"]
                    .as_array()
                    .map(|t| {
                        let n: Vec<String> =
                            t.iter().map(|v| v.as_f64().unwrap_or(0.0).to_string()).collect();
                        format!(" gradientTransform=\"matrix({})\"", n.join(" "))
                    })
                    .unwrap_or_default();
                xml.push_str(&format!(
                    "<radialGradient id=\"{name}-g\" gradientUnits=\"userSpaceOnUse\" cx=\"{}\" cy=\"{}\" r=\"{}\"{matrix}{spread}>",
                    num("cx"),
                    num("cy"),
                    num("r")
                ));
            }
            _ => return None,
        }
        stops(&mut xml);
        xml.push_str(if paint["type"] == "linear" {
            "</linearGradient>"
        } else {
            "</radialGradient>"
        });
        (format!("url(#{name}-g)"), String::new())
    };
    xml.push_str(&format!(
        "<mask id=\"{name}\" mask-type=\"alpha\" maskUnits=\"userSpaceOnUse\" x=\"{x}\" y=\"{y}\" width=\"{w}\" height=\"{h}\">\
         <rect x=\"{x}\" y=\"{y}\" width=\"{w}\" height=\"{h}\" fill=\"{fill}\"{opacity}/></mask>",
        x = bounds.x,
        y = bounds.y,
        w = bounds.w,
        h = bounds.h
    ));
    Some(format!("<defs>{xml}</defs>"))
}

/// `#rrggbb` or `#rrggbbaa` as its colour and its alpha in 0..1.
fn split_hex(hex: &str) -> (String, f64) {
    if hex.len() == 9 {
        (
            hex[..7].to_string(),
            f64::from(u8::from_str_radix(&hex[7..], 16).unwrap_or(255)) / 255.0,
        )
    } else {
        (hex.to_string(), 1.0)
    }
}

/// Half the element's stroke width, which the stroke box is wider than the fill box by on each side: 0 when it is not
/// stroked. The stroke and its width are the element's computed ones (a rule, `style`, or inherited from a rule), else
/// the presentation attribute on the element or the nearest ancestor that has one.
fn stroke_reach(doc: &BaseDocument, id: NodeId, attrs: &Attrs, decls: &Attrs, percent_of: f64) -> f64 {
    let computed = |l: LonghandId, initial: &str| {
        let style = doc.get_node(id).and_then(|n| n.primary_styles())?;
        let v = style.computed_value_to_string(PropertyDeclarationId::Longhand(l));
        (v != initial).then_some(v)
    };
    let value = |name: &str, l: LonghandId, initial: &str| -> Option<String> {
        // What a rule or the `style` attribute of the element itself says wins, `none` included: it computes to the
        // initial value, which is no sign that nothing was set.
        let own = doc
            .get_node(id)
            .and_then(|n| n.primary_styles())
            .and_then(|style| declared(doc, &style, l));
        if let Some(v) = own {
            return Some(v.trim().to_string());
        }
        if let Some((_, v)) = decls.iter().find(|(n, _)| n == name) {
            return Some(v.trim().to_string());
        }
        if let Some(v) = computed(l, initial) {
            return Some(v);
        }
        if let Some((_, v)) = attrs.iter().find(|(n, _)| n == name) {
            return Some(v.trim().to_string());
        }
        let mut up = doc.get_node(id).and_then(|n| n.parent);
        while let Some(node) = up.and_then(|p| doc.get_node(p)) {
            if let Some(v) = attr_ci(node, name) {
                return Some(v.trim().to_string());
            }
            up = node.parent;
        }
        None
    };
    let stroked = value("stroke", LonghandId::Stroke, "none")
        .is_some_and(|v| !v.eq_ignore_ascii_case("none"));
    if !stroked {
        return 0.0;
    }
    value("stroke-width", LonghandId::StrokeWidth, "1px")
        .and_then(|v| css::length(&v, percent_of))
        .unwrap_or(1.0)
        / 2.0
}

/// The fill box of a basic shape in the element's own coordinates, when its attributes give it.
fn fill_box(tag: &str, attrs: &Attrs, reference: [f64; 4]) -> Option<Rect> {
    let get = |n: &str| attrs.iter().find(|(a, _)| a == n).map(|(_, v)| v.as_str());
    let (vw, vh) = (reference[2], reference[3]);
    let len = |n: &str, of: f64| get(n).and_then(|v| css::length(v, of));
    let at = |n: &str, of: f64| len(n, of).unwrap_or(0.0);
    match tag {
        "rect" => Some(Rect::new(at("x", vw), at("y", vh), len("width", vw)?, len("height", vh)?)),
        "circle" => {
            let r = len("r", vw.hypot(vh) / std::f64::consts::SQRT_2)?;
            Some(Rect::new(at("cx", vw) - r, at("cy", vh) - r, 2.0 * r, 2.0 * r))
        }
        "ellipse" => {
            let (rx, ry) = (len("rx", vw)?, len("ry", vh)?);
            Some(Rect::new(at("cx", vw) - rx, at("cy", vh) - ry, 2.0 * rx, 2.0 * ry))
        }
        "path" => {
            let b = BezPath::from_svg(get("d")?).ok()?.bounding_box();
            Some(Rect::new(b.x0, b.y0, b.width(), b.height()))
        }
        _ => None,
    }
}
