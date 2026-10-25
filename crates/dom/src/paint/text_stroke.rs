//! `-webkit-text-stroke` and `paint-order` of text.
//!
//! This Stylo drops both, so the front half mirrors them into custom
//! properties (`shim`). Both properties inherit in CSS and the mirrors do not,
//! so the value of a text run is the one of the nearest element at or above its
//! style node that declared it.

use std::str::FromStr;

use blitz_dom::Node;

use super::Painter;
use super::shim::top_level_words;
use super::util::{current_color, parse_css_color, rgba};

const SHORTHAND: &str = "--kg-webkit-text-stroke";
const WIDTH: &str = "--kg-webkit-text-stroke-width";
const COLOR: &str = "--kg-webkit-text-stroke-color";
const PAINT_ORDER: &str = "--kg-paint-order";

/// The outline of the glyphs of a run of text.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct TextStroke {
    pub color: [f32; 4],
    pub width: f64,
}

/// A `<length>` or a border-width keyword, in pixels. `em` is the font size of
/// the element that declared it.
fn parse_width(word: &str, em: f64) -> Option<f64> {
    let w = word.trim().to_ascii_lowercase();
    match w.as_str() {
        "thin" => return Some(1.0),
        "medium" => return Some(3.0),
        "thick" => return Some(5.0),
        "0" => return Some(0.0),
        _ => {}
    }
    let split = w.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(w.len());
    let (n, unit) = w.split_at(split);
    let n: f64 = n.parse().ok()?;
    let k = match unit {
        "px" => 1.0,
        "em" => em,
        // The root's font size is the browser default unless a page sets it.
        "rem" => 16.0,
        "pt" => 96.0 / 72.0,
        "pc" => 16.0,
        "in" => 96.0,
        "cm" => 96.0 / 2.54,
        "mm" => 96.0 / 25.4,
        "q" => 96.0 / 101.6,
        _ => return None,
    };
    (n >= 0.0 && n.is_finite()).then_some(n * k)
}

/// A colour word as RGBA, with `currentcolor` for `current`.
fn parse_color(word: &str, current: [f32; 4]) -> Option<[f32; 4]> {
    let w = word.trim();
    if w.eq_ignore_ascii_case("currentcolor") {
        return Some(current);
    }
    parse_css_color(w).or_else(|| {
        let c = svgtypes::Color::from_str(w).ok()?;
        Some([
            f32::from(c.red) / 255.0,
            f32::from(c.green) / 255.0,
            f32::from(c.blue) / 255.0,
            f32::from(c.alpha) / 255.0,
        ])
    })
}

impl<'a> Painter<'a> {
    /// The nearest element at or above `node` that declared one of `names`
    /// (the first of the list winning on one element), with the name and value.
    fn kg_inherited(
        &self,
        node: &'a Node,
        names: &[&'static str],
    ) -> Option<(&'a Node, &'static str, String)> {
        let mut cur = Some(node);
        while let Some(n) = cur {
            for name in names {
                if let Some(v) = self.kg_value(n, name) {
                    return Some((n, name, v));
                }
            }
            cur = n.parent.map(|p| self.node(p)).filter(|p| p.is_element());
        }
        None
    }

    fn font_px(&self, node: &Node) -> f64 {
        node.primary_styles().map_or(16.0, |s| {
            f64::from(s.get_font().font_size.computed_size().px())
        })
    }

    /// The text stroke of text styled by `node`: `None` when it has no width.
    pub(super) fn text_stroke_of(&mut self, node: &'a Node) -> Option<TextStroke> {
        let current = node
            .primary_styles()
            .map_or([0.0, 0.0, 0.0, 1.0], |s| rgba(&current_color(&s)));
        let width = match self.kg_inherited(node, &[WIDTH, SHORTHAND]) {
            None => 0.0,
            Some((at, name, value)) => {
                let em = self.font_px(at);
                let parsed = if name == WIDTH {
                    parse_width(&value, em)
                } else {
                    top_level_words(&value)
                        .iter()
                        .find_map(|w| parse_width(w, em))
                };
                match parsed {
                    Some(w) => w,
                    // A shorthand with only a colour keeps the initial width, 0.
                    None if name == SHORTHAND && !value.trim().is_empty() => 0.0,
                    None => {
                        self.report(
                            at,
                            "-webkit-text-stroke-width",
                            value,
                            "this width is not understood; the text is not stroked",
                        );
                        0.0
                    }
                }
            }
        };
        if width <= 0.0 || !width.is_finite() {
            return None;
        }
        let color = match self.kg_inherited(node, &[COLOR, SHORTHAND]) {
            None => current,
            Some((at, name, value)) => {
                let at_current = at
                    .primary_styles()
                    .map_or(current, |s| rgba(&current_color(&s)));
                if name == COLOR {
                    parse_color(&value, at_current)
                } else {
                    let em = self.font_px(at);
                    let words = top_level_words(&value);
                    match words.iter().find(|w| parse_width(w, em).is_none()) {
                        Some(w) => parse_color(w, at_current),
                        None => Some(at_current),
                    }
                }
                .unwrap_or_else(|| {
                    self.report(
                        at,
                        "-webkit-text-stroke-color",
                        value,
                        "this colour is not understood; the stroke is the text colour",
                    );
                    at_current
                })
            }
        };
        Some(TextStroke { color, width })
    }

    /// Whether the stroke of text styled by `node` is drawn before its fill
    /// (`paint-order: stroke fill`, or `stroke` alone).
    pub(super) fn stroke_first(&self, node: &'a Node) -> bool {
        let Some((_, _, value)) = self.kg_inherited(node, &[PAINT_ORDER]) else {
            return false;
        };
        let words = top_level_words(&value.to_ascii_lowercase());
        let at = |w: &str| words.iter().position(|x| x == w);
        match (at("stroke"), at("fill")) {
            (Some(s), Some(f)) => s < f,
            (Some(_), None) => true,
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widths() {
        assert_eq!(parse_width("12px", 16.0), Some(12.0));
        assert_eq!(parse_width("0.5em", 20.0), Some(10.0));
        assert_eq!(parse_width("thick", 16.0), Some(5.0));
        assert_eq!(parse_width("0", 16.0), Some(0.0));
        assert_eq!(parse_width("red", 16.0), None);
        assert_eq!(parse_width("#fff", 16.0), None);
        assert_eq!(parse_width("-2px", 16.0), None);
    }

    #[test]
    fn colours() {
        let cur = [0.1, 0.2, 0.3, 1.0];
        assert_eq!(parse_color("currentColor", cur), Some(cur));
        assert_eq!(parse_color("#000", cur), Some([0.0, 0.0, 0.0, 1.0]));
        assert_eq!(parse_color("orange", cur).map(|c| c[3]), Some(1.0));
        assert_eq!(parse_color("12px", cur), None);
    }
}
