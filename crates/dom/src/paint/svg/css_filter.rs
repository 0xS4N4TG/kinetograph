//! The CSS filter functions of an element inside an `<svg>` (`blur()`,
//! `drop-shadow()`, `brightness()`, ...). Stylo does not compute them for SVG
//! content, so the `filter` value is read here, as text, into the same scene
//! effects the box painter makes for an HTML box (`paint/effects.rs`).
//! Lengths are user units, as Chrome reads them for an SVG element.

use std::str::FromStr;

use serde_json::{Value, json};

use crate::paint::effects::CHROME_MAX_SIGMA;
use crate::paint::shim::top_level_words;
use crate::paint::util::{num, num4};

/// One entry of a `filter` list.
#[derive(Clone, Debug)]
pub enum FilterItem {
    /// `url(#id)`: a `<filter>` element.
    Url(String),
    /// A filter function as a scene effect.
    Effect(Value),
    /// `opacity()`: it multiplies the opacity of the filtered group.
    Opacity(f64),
}

/// A length in px (or a bare `0`), or `None`.
fn length(w: &str) -> Option<f64> {
    let w = w.trim();
    let n = w.strip_suffix("px").unwrap_or(w);
    n.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// A number or a percentage as a fraction; no argument is 1.
fn amount(arg: &str) -> Option<f64> {
    let a = arg.trim();
    if a.is_empty() {
        return Some(1.0);
    }
    match a.strip_suffix('%') {
        Some(p) => p.trim().parse::<f64>().ok().map(|v| v / 100.0),
        None => a.parse::<f64>().ok(),
    }
    .filter(|v| v.is_finite() && *v >= 0.0)
}

fn angle(arg: &str) -> Option<f64> {
    let a = arg.trim();
    if a.is_empty() || a == "0" {
        return Some(0.0);
    }
    let (n, k) = if let Some(n) = a.strip_suffix("deg") {
        (n, 1.0)
    } else if let Some(n) = a.strip_suffix("grad") {
        (n, 0.9)
    } else if let Some(n) = a.strip_suffix("rad") {
        (n, 180.0 / std::f64::consts::PI)
    } else if let Some(n) = a.strip_suffix("turn") {
        (n, 360.0)
    } else {
        return None;
    };
    n.trim().parse::<f64>().ok().map(|v| v * k)
}

/// A colour word as `#rrggbb[aa]`; `resolve` handles what `svgtypes` cannot
/// (`var()`, `oklch()`, ...), `current` is the element's `color`.
fn colour(w: &str, current: &str, resolve: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    let w = if w.eq_ignore_ascii_case("currentcolor") {
        current
    } else {
        w
    };
    let c = svgtypes::Color::from_str(w)
        .ok()
        .or_else(|| svgtypes::Color::from_str(&resolve(w)?).ok())?;
    Some(if c.alpha == 255 {
        format!("#{:02x}{:02x}{:02x}", c.red, c.green, c.blue)
    } else {
        format!("#{:02x}{:02x}{:02x}{:02x}", c.red, c.green, c.blue, c.alpha)
    })
}

fn drop_shadow(
    arg: &str,
    current: &str,
    resolve: &dyn Fn(&str) -> Option<String>,
) -> Option<Value> {
    let mut lengths = Vec::new();
    let mut color = None;
    for w in top_level_words(arg) {
        match length(&w) {
            Some(l) => lengths.push(l),
            None => color = Some(colour(&w, current, resolve)?),
        }
    }
    if !(2..=3).contains(&lengths.len()) || lengths.get(2).is_some_and(|b| *b < 0.0) {
        return None;
    }
    let color = color.or_else(|| colour("currentcolor", current, resolve))?;
    Some(json!({
        "type": "dropShadow",
        "x": num(lengths[0]), "y": num(lengths[1]),
        // The blur length is the standard deviation itself, as for HTML.
        "blur": num(lengths.get(2).copied().unwrap_or(0.0).min(CHROME_MAX_SIGMA)),
        "color": color,
    }))
}

/// The entries of a `filter` value, in order. A word that is not a filter
/// (or is one this cannot read) is returned in the second list.
pub fn parse(
    value: &str,
    current: &str,
    resolve: &dyn Fn(&str) -> Option<String>,
) -> (Vec<FilterItem>, Vec<String>) {
    let mut items = Vec::new();
    let mut rejected = Vec::new();
    for w in top_level_words(value) {
        if w.eq_ignore_ascii_case("none") {
            continue;
        }
        let Some((name, rest)) = w.split_once('(') else {
            rejected.push(w);
            continue;
        };
        let Some(arg) = rest.strip_suffix(')') else {
            rejected.push(w);
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let one = |kind: &str| {
            amount(arg).map(|a| FilterItem::Effect(json!({"type": kind, "amount": num4(a)})))
        };
        let item = match name.as_str() {
            "url" => {
                let id = arg.trim().trim_matches(['"', '\'']);
                id.strip_prefix('#')
                    .map(|id| FilterItem::Url(id.to_string()))
            }
            "blur" => length(arg).filter(|r| *r >= 0.0).map(|r| {
                FilterItem::Effect(json!({"type": "blur", "radius": num(r.min(CHROME_MAX_SIGMA))}))
            }),
            "brightness" => one("brightness"),
            "contrast" => one("contrast"),
            "saturate" => one("saturate"),
            "grayscale" => amount(arg).map(|a| {
                FilterItem::Effect(json!({"type": "grayscale", "amount": num4(a.min(1.0))}))
            }),
            "invert" => amount(arg)
                .map(|a| FilterItem::Effect(json!({"type": "invert", "amount": num4(a.min(1.0))}))),
            "sepia" => amount(arg)
                .map(|a| FilterItem::Effect(json!({"type": "sepia", "amount": num4(a.min(1.0))}))),
            "opacity" => amount(arg).map(|a| FilterItem::Opacity(a.min(1.0))),
            "hue-rotate" => angle(arg)
                .map(|a| FilterItem::Effect(json!({"type": "hueRotate", "angle": num4(a)}))),
            "drop-shadow" => drop_shadow(arg, current, resolve).map(FilterItem::Effect),
            _ => None,
        };
        match item {
            Some(i) => items.push(i),
            None => rejected.push(w),
        }
    }
    (items, rejected)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(v: &str) -> (Vec<FilterItem>, Vec<String>) {
        parse(v, "#112233", &|_| None)
    }

    #[test]
    fn blur_and_a_drop_shadow_with_a_colour_function() {
        let (items, bad) = p("blur(4px) drop-shadow(0 10px 20px rgba(0, 113, 227, 0.22))");
        assert!(bad.is_empty(), "{bad:?}");
        let FilterItem::Effect(b) = &items[0] else {
            panic!()
        };
        assert_eq!(b["radius"], 4);
        let FilterItem::Effect(d) = &items[1] else {
            panic!()
        };
        assert_eq!(d["y"], 10);
        assert_eq!(d["blur"], 20);
        assert_eq!(d["color"], "#0071e338");
    }

    #[test]
    fn a_shadow_without_a_colour_takes_the_current_one_and_a_leading_colour_works() {
        let (items, _) = p("drop-shadow(2px 3px)");
        let FilterItem::Effect(d) = &items[0] else {
            panic!()
        };
        assert_eq!(d["color"], "#112233");
        let (items, _) = p("drop-shadow(red 1px 1px 0)");
        let FilterItem::Effect(d) = &items[0] else {
            panic!()
        };
        assert_eq!(d["color"], "#ff0000");
    }

    #[test]
    fn amounts_urls_and_what_cannot_be_read() {
        let (items, bad) = p("url(#a) brightness(150%) hue-rotate(0.5turn) opacity(0.5) blur(1em)");
        assert_eq!(items.len(), 4);
        assert!(matches!(&items[0], FilterItem::Url(i) if i == "a"));
        assert!(matches!(items[3], FilterItem::Opacity(o) if o == 0.5));
        assert_eq!(bad, vec!["blur(1em)".to_string()]);
    }
}
