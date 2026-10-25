//! Colours in an SVG that usvg cannot read: `var(--x)`, `oklch()`, `oklab()`,
//! `color-mix()`, `rgb(r g b / a)`, `rebeccapurple`, `lab()`, `color()`. They
//! are resolved the way an HTML `background-color` is, by Stylo's own colour
//! parser and computation (`specified::Color::parse_and_compute`), and written
//! back as a plain `rgb`.

use std::borrow::Cow;

use blitz_dom::{BaseDocument, NodeId};
use style::Atom;
use style::color::AbsoluteColor;
use style::context::QuirksMode;
use style::parser::ParserContext;
use style::properties::ComputedValues;
use style::servo_arc::Arc;
use style::stylesheets::{CssRuleType, Origin, UrlExtraData};
use style::values::specified::color::Color;
use style_traits::ParsingMode;

/// Properties whose value is a colour, or a paint that can be one.
pub const COLOR_PROPERTIES: [&str; 6] = [
    "fill",
    "stroke",
    "stop-color",
    "flood-color",
    "lighting-color",
    "color",
];

/// `value` of a colour property as something usvg reads, or `Err` with the
/// reason it could not be resolved (the value is then left as it is). A value
/// usvg already reads is returned as it is.
pub fn resolve(doc: &BaseDocument, id: NodeId, value: &str) -> Result<Cow<'static, str>, String> {
    let v = value.trim();
    let lower = v.to_ascii_lowercase();
    if lower.is_empty()
        || lower == "none"
        || lower == "inherit"
        || lower.starts_with("url(")
        || lower.starts_with("context-")
        || lower == "currentcolor"
    {
        return Err(String::new());
    }
    if !lower.contains("var(") && svgtypes::Paint::from_str(v).is_ok() && !space_rgb(&lower) {
        return Err(String::new());
    }
    let text = substitute(doc, id, v, 0)?;
    let url = url::Url::parse("about:blank").map_err(|e| e.to_string())?;
    let url_data = UrlExtraData(Arc::new(url));
    let context = ParserContext::new(
        Origin::Author,
        &url_data,
        Some(CssRuleType::Style),
        ParsingMode::DEFAULT,
        QuirksMode::NoQuirks,
        Cow::Owned(Default::default()),
        None,
        None,
        Default::default(),
    );
    let mut parser = cssparser::Parser::new(&text);
    let computed = Color::parse_and_compute(&context, &mut parser, None)
        .map_err(|()| format!("{value} is not a colour the engine reads"))?;
    let c = computed.resolve_to_absolute(&AbsoluteColor::BLACK);
    let c = c.into_srgb_legacy();
    let b = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    let [r, g, bl, a] = [c.components.0, c.components.1, c.components.2, c.alpha];
    Ok(Cow::Owned(if a >= 0.999 {
        format!("#{:02x}{:02x}{:02x}", b(r), b(g), b(bl))
    } else {
        format!("rgba({},{},{},{:.3})", b(r), b(g), b(bl), a)
    }))
}

/// `rgb(r g b / a)`: usvg (svgtypes) reads the comma form.
fn space_rgb(lower: &str) -> bool {
    (lower.starts_with("rgb(") || lower.starts_with("rgba(") || lower.starts_with("hsl("))
        && !lower.contains(',')
}

/// `value` with each `var(--name, fallback)` replaced by the custom property
/// the element's computed style holds (or the fallback).
fn substitute(doc: &BaseDocument, id: NodeId, value: &str, depth: u32) -> Result<String, String> {
    if !value.contains("var(") {
        return Ok(value.to_string());
    }
    if depth > 8 {
        return Err(format!("{value}: custom properties refer to each other"));
    }
    let style = doc.get_node(id).and_then(|n| n.primary_styles());
    let mut out = String::new();
    let mut rest = value;
    while let Some(i) = rest.find("var(") {
        out.push_str(&rest[..i]);
        let body = &rest[i + 4..];
        let mut depth_paren = 1;
        let mut end = body.len();
        for (k, c) in body.char_indices() {
            match c {
                '(' => depth_paren += 1,
                ')' => {
                    depth_paren -= 1;
                    if depth_paren == 0 {
                        end = k;
                        break;
                    }
                }
                _ => {}
            }
        }
        let inner = &body[..end];
        let (name, fallback) = match inner.split_once(',') {
            Some((n, f)) => (n.trim(), Some(f.trim())),
            None => (inner.trim(), None),
        };
        let found = style
            .as_ref()
            .and_then(|s| custom(s, name.trim_start_matches("--")));
        match (found, fallback) {
            (Some(v), _) => out.push_str(&v),
            (None, Some(f)) => out.push_str(f),
            (None, None) => return Err(format!("var({name}) is not set")),
        }
        rest = body.get(end + 1..).unwrap_or("");
    }
    out.push_str(rest);
    substitute(doc, id, &out, depth + 1)
}

fn custom(style: &ComputedValues, name: &str) -> Option<String> {
    let name = Atom::from(name);
    let props = style.custom_properties();
    let v = props
        .inherited
        .get(&name)
        .or_else(|| props.non_inherited.get(&name))?;
    Some(v.as_universal()?.css_text().trim().to_string())
}
