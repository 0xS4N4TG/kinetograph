//! CSS block and flex layout of a DOM island (docs/COMPAT.md §5.1), with
//! taffy. Text leaves are measured with the renderer's own Parley engine, at
//! the width taffy offers, so the lines a text layer will break at are the
//! lines this layout counted.
//!
//! The request is JSON-shaped (see [`DomLayoutRequest`]); `layoutDom` in the
//! addon parses it and hands the text engine in. CPU only.
//!
//! The island is laid out inside a box of the `available` size, as Remotion's
//! root `div` is: the root node is the one child of an anonymous block of that
//! size, so a percentage, an `auto` margin or an absolute position of the
//! root resolves against the composition.

use std::collections::HashMap;
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use taffy::prelude::*;
use taffy::{Baselines, Overflow, TaffyTree, compute_leaf_layout};

use crate::scene::TextAlign;
use crate::text::TextEngine;

/// Why a layout could not be made.
#[derive(Debug)]
pub enum DomLayoutError {
    /// The request is wrong: a style key or value taffy cannot take, a font
    /// that was not given.
    Invalid(String),
    /// Layout itself failed.
    Layout(String),
}

impl fmt::Display for DomLayoutError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DomLayoutError::Invalid(m) => write!(f, "{m}"),
            DomLayoutError::Layout(m) => write!(f, "layout failed: {m}"),
        }
    }
}

impl std::error::Error for DomLayoutError {}

fn invalid(message: impl Into<String>) -> DomLayoutError {
    DomLayoutError::Invalid(message.into())
}

#[derive(Debug, Clone, Deserialize)]
pub struct Available {
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomLayoutRequest {
    pub root: DomLayoutNode,
    /// The containing block of the root: the composition's size.
    pub available: Available,
    /// Font key -> file, as `layoutText` takes them.
    pub fonts: HashMap<String, String>,
    pub base_dir: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DomLayoutNode {
    /// taffy's style under CSS names. Lengths are px numbers, `{ "percent": n }`
    /// (n = 50 is 50%) or `"auto"`; see [`apply_style`] for the keys.
    #[serde(default)]
    pub style: Map<String, Value>,
    /// A leaf whose content is measured: text, or a box of an intrinsic size.
    pub measure: Option<Measure>,
    #[serde(default)]
    pub children: Vec<DomLayoutNode>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Measure {
    Text { text: TextMeasure },
    Size { width: f32, height: f32 },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextMeasure {
    pub text: String,
    pub font: String,
    pub size: f32,
    pub line_height: Option<f32>,
    pub align: Option<String>,
    /// `nowrap` never wraps; anything else wraps at the width on offer.
    pub white_space: Option<String>,
}

/// The border box of a node in its parent's border-box space, with the
/// padding and border it has.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DomLayoutBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Top, right, bottom, left.
    pub padding: [f64; 4],
    pub border: [f64; 4],
    pub children: Vec<DomLayoutBox>,
}

/// What a text measurement gives back.
#[derive(Debug, Clone, Copy)]
pub struct TextSize {
    pub width: f32,
    pub height: f32,
    /// The first line's baseline from the top of the text.
    pub baseline: f32,
}

/// Widths are reported on the 1/64 px grid Chrome lays out on, rounded up, so
/// a box sized from a measurement never re-wraps its own text.
fn grid(value: f32) -> f32 {
    (value * 64.0).ceil() / 64.0
}

/// Shapes `spec` with `engine`, wrapping at `max_width` (none: only at `\n`).
pub fn measure_text(
    engine: &mut TextEngine,
    spec: &TextMeasure,
    max_width: Option<f32>,
) -> TextSize {
    let align = match spec.align.as_deref() {
        Some("center") => TextAlign::Center,
        Some("right") => TextAlign::Right,
        _ => TextAlign::Left,
    };
    let max_width = if spec.white_space.as_deref() == Some("nowrap") {
        None
    } else {
        max_width
    };
    let laid = engine.layout(
        &spec.text,
        &spec.font,
        spec.size,
        spec.line_height,
        max_width,
        align,
    );
    TextSize {
        width: grid(laid.width),
        height: laid.height,
        baseline: laid.lines.first().map_or(laid.height, |l| l.baseline),
    }
}

/// What a leaf knows: how to measure itself, and the offset of its content
/// inside its border box (for the baseline).
enum Leaf {
    Text { spec: TextMeasure, inset_top: f32 },
    Fixed { width: f32, height: f32 },
}

/// A text measurement: the spec and the width offered, the size back.
pub type TextMeasurer<'a> =
    dyn FnMut(&TextMeasure, Option<f32>) -> std::result::Result<TextSize, DomLayoutError> + 'a;

/// Whether any node of the tree is a text leaf (so a text engine is needed).
pub fn has_text(node: &DomLayoutNode) -> bool {
    matches!(node.measure, Some(Measure::Text { .. })) || node.children.iter().any(has_text)
}

/// Lays out `request`. `measure` shapes text; it is not called when the tree
/// has no text leaf.
pub fn layout_dom(
    request: &DomLayoutRequest,
    measure: &mut TextMeasurer<'_>,
) -> std::result::Result<DomLayoutBox, DomLayoutError> {
    let mut tree: TaffyTree<Leaf> = TaffyTree::new();
    // Positions stay fractional, as in the scene's own layout.
    tree.disable_rounding();
    let root = build(&mut tree, &request.root, &request.fonts)?;
    let wrapper = tree
        .new_with_children(
            Style {
                display: Display::Block,
                size: Size {
                    width: Dimension::length(request.available.width),
                    height: Dimension::length(request.available.height),
                },
                ..Style::default()
            },
            &[root],
        )
        .map_err(layout_error)?;

    let mut failure: Option<DomLayoutError> = None;
    tree.compute_layout_with_measure(
        wrapper,
        Size {
            width: AvailableSpace::Definite(request.available.width),
            height: AvailableSpace::Definite(request.available.height),
        },
        |inputs, _, leaf, style| match leaf {
            Some(Leaf::Fixed { width, height }) => {
                let size = Size {
                    width: *width,
                    height: *height,
                };
                compute_leaf_layout(inputs, style, |_, _| 0.0, |_, _| size)
            }
            Some(Leaf::Text { spec, inset_top }) => {
                let mut baseline = 0.0;
                let mut out = compute_leaf_layout(
                    inputs,
                    style,
                    |_, _| 0.0,
                    |known, available| {
                        let offered = known.width.or(match available.width {
                            AvailableSpace::Definite(w) => Some(w),
                            AvailableSpace::MinContent => Some(0.0),
                            AvailableSpace::MaxContent => None,
                        });
                        match measure(spec, offered) {
                            Ok(size) => {
                                baseline = size.baseline;
                                Size {
                                    width: size.width,
                                    height: size.height,
                                }
                            }
                            Err(e) => {
                                failure.get_or_insert(e);
                                Size::ZERO
                            }
                        }
                    },
                );
                out.baselines = Baselines::from_first(Some(baseline + *inset_top));
                out
            }
            None => compute_leaf_layout(inputs, style, |_, _| 0.0, |_, _| Size::ZERO),
        },
    )
    .map_err(layout_error)?;
    if let Some(e) = failure {
        return Err(e);
    }
    describe(&tree, root)
}

fn describe(
    tree: &TaffyTree<Leaf>,
    node: NodeId,
) -> std::result::Result<DomLayoutBox, DomLayoutError> {
    let l = tree.layout(node).map_err(layout_error)?;
    let kids = tree.children(node).map_err(layout_error)?;
    let sides = |r: taffy::Rect<f32>| {
        [
            f64::from(r.top),
            f64::from(r.right),
            f64::from(r.bottom),
            f64::from(r.left),
        ]
    };
    Ok(DomLayoutBox {
        x: f64::from(l.location.x),
        y: f64::from(l.location.y),
        width: f64::from(l.size.width),
        height: f64::from(l.size.height),
        padding: sides(l.padding),
        border: sides(l.border),
        children: kids
            .into_iter()
            .map(|k| describe(tree, k))
            .collect::<std::result::Result<_, _>>()?,
    })
}

fn layout_error(e: taffy::TaffyError) -> DomLayoutError {
    DomLayoutError::Layout(e.to_string())
}

fn build(
    tree: &mut TaffyTree<Leaf>,
    node: &DomLayoutNode,
    fonts: &HashMap<String, String>,
) -> std::result::Result<NodeId, DomLayoutError> {
    // CSS's initial values where taffy's differ: content-box sizing, and a
    // flex container that stretches its items and its lines.
    let mut style = Style {
        display: Display::Block,
        box_sizing: BoxSizing::ContentBox,
        align_items: AlignItems::STRETCH,
        align_content: AlignContent::STRETCH,
        flex_shrink: 1.0,
        ..Style::default()
    };
    apply_style(&mut style, &node.style)?;

    if let Some(measure) = &node.measure {
        if !node.children.is_empty() {
            return Err(invalid("a node with a measure cannot have children"));
        }
        let leaf = match measure {
            Measure::Size { width, height } => {
                // A replaced box (an image) is its intrinsic size, not the
                // width of its container, when its style says nothing.
                style.item_is_replaced = true;
                Leaf::Fixed {
                    width: *width,
                    height: *height,
                }
            }
            Measure::Text { text } => {
                if !fonts.contains_key(&text.font) {
                    return Err(invalid(format!(
                        "font {:?} is not one of the fonts given: {:?}",
                        text.font,
                        fonts.keys().collect::<Vec<_>>()
                    )));
                }
                if !(text.size.is_finite() && text.size > 0.0) {
                    return Err(invalid(format!(
                        "text size must be greater than 0, got {}",
                        text.size
                    )));
                }
                Leaf::Text {
                    spec: text.clone(),
                    inset_top: inset_top(&node.style),
                }
            }
        };
        return tree
            .new_leaf_with_context(style, leaf)
            .map_err(layout_error);
    }

    let kids = node
        .children
        .iter()
        .map(|c| build(tree, c, fonts))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    tree.new_with_children(style, &kids).map_err(layout_error)
}

/// The padding and border above a leaf's content, in px (a percentage counts
/// as 0 here: it only moves the baseline of a text leaf).
fn inset_top(style: &Map<String, Value>) -> f32 {
    let side = |key: &str| {
        style
            .get(key)
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(Value::as_f64)
            .unwrap_or(0.0) as f32
    };
    side("padding") + side("borderWidth")
}

// ---- style ----

type R<T> = std::result::Result<T, DomLayoutError>;

fn number(key: &str, v: &Value) -> R<f32> {
    match v.as_f64() {
        Some(n) if n.is_finite() => Ok(n as f32),
        _ => Err(invalid(format!("{key} must be a finite number, got {v}"))),
    }
}

fn percent(v: &Value) -> Option<f32> {
    v.as_object()
        .and_then(|o| o.get("percent"))
        .and_then(Value::as_f64)
        .map(|p| (p / 100.0) as f32)
}

fn is_auto(v: &Value) -> bool {
    matches!(v.as_str(), Some("auto" | "none"))
}

fn dimension(key: &str, v: &Value) -> R<Dimension> {
    if is_auto(v) {
        return Ok(Dimension::auto());
    }
    if let Some(p) = percent(v) {
        return Ok(Dimension::percent(p));
    }
    Ok(Dimension::length(number(key, v)?))
}

fn auto_length(key: &str, v: &Value) -> R<LengthPercentageAuto> {
    if is_auto(v) {
        return Ok(LengthPercentageAuto::auto());
    }
    if let Some(p) = percent(v) {
        return Ok(LengthPercentageAuto::percent(p));
    }
    Ok(LengthPercentageAuto::length(number(key, v)?))
}

fn length(key: &str, v: &Value) -> R<LengthPercentage> {
    if let Some(p) = percent(v) {
        return Ok(LengthPercentage::percent(p));
    }
    Ok(LengthPercentage::length(number(key, v)?))
}

fn four<'a>(key: &str, v: &'a Value) -> R<[&'a Value; 4]> {
    match v.as_array().map(Vec::as_slice) {
        Some([t, r, b, l]) => Ok([t, r, b, l]),
        _ => Err(invalid(format!(
            "{key} must be [top, right, bottom, left], got {v}"
        ))),
    }
}

fn word<'a>(key: &str, v: &'a Value) -> R<&'a str> {
    v.as_str()
        .ok_or_else(|| invalid(format!("{key} must be a string, got {v}")))
}

fn bad_value(key: &str, v: &str) -> DomLayoutError {
    invalid(format!("{key} {v:?} is not supported"))
}

fn overflow(key: &str, v: &Value) -> R<Overflow> {
    Ok(match word(key, v)? {
        "visible" => Overflow::Visible,
        "clip" => Overflow::Clip,
        "hidden" => Overflow::Hidden,
        "scroll" | "auto" => Overflow::Scroll,
        other => return Err(bad_value(key, other)),
    })
}

fn align(key: &str, v: &Value) -> R<AlignItems> {
    Ok(match word(key, v)? {
        "normal" | "stretch" => AlignItems::STRETCH,
        "flex-start" | "start" => AlignItems::FLEX_START,
        "flex-end" | "end" => AlignItems::FLEX_END,
        "center" => AlignItems::CENTER,
        "baseline" => AlignItems::BASELINE,
        other => return Err(bad_value(key, other)),
    })
}

fn content(key: &str, v: &Value) -> R<AlignContent> {
    Ok(match word(key, v)? {
        "normal" | "stretch" => AlignContent::STRETCH,
        "flex-start" | "start" => AlignContent::FLEX_START,
        "flex-end" | "end" => AlignContent::FLEX_END,
        "center" => AlignContent::CENTER,
        "space-between" => AlignContent::SPACE_BETWEEN,
        "space-around" => AlignContent::SPACE_AROUND,
        "space-evenly" => AlignContent::SPACE_EVENLY,
        other => return Err(bad_value(key, other)),
    })
}

/// Reads the style keys of a node onto `style`. Keys (CSS names):
/// `display` (`block`, `flex`, `none`), `position` (`static`, `relative`,
/// `absolute`), `inset` / `margin` / `padding` / `borderWidth` as
/// `[top, right, bottom, left]`, `width`, `height`, `minWidth`, `minHeight`,
/// `maxWidth`, `maxHeight`, `aspectRatio`, `boxSizing`, `overflowX`,
/// `overflowY`, the flex properties and `rowGap`, `columnGap`. Anything else
/// is an error, so a typo is not silently a different layout.
fn apply_style(style: &mut Style, map: &Map<String, Value>) -> R<()> {
    for (key, v) in map {
        let k = key.as_str();
        match k {
            "display" => {
                style.display = match word(k, v)? {
                    "block" => Display::Block,
                    "flex" => Display::Flex,
                    "none" => Display::None,
                    other => return Err(bad_value(k, other)),
                }
            }
            "position" => {
                style.position = match word(k, v)? {
                    "static" => Position::Static,
                    "relative" => Position::Relative,
                    "absolute" => Position::Absolute,
                    other => return Err(bad_value(k, other)),
                }
            }
            "inset" => {
                let [t, r, b, l] = four(k, v)?;
                style.inset = taffy::Rect {
                    top: auto_length(k, t)?,
                    right: auto_length(k, r)?,
                    bottom: auto_length(k, b)?,
                    left: auto_length(k, l)?,
                };
            }
            "margin" => {
                let [t, r, b, l] = four(k, v)?;
                style.margin = taffy::Rect {
                    top: auto_length(k, t)?,
                    right: auto_length(k, r)?,
                    bottom: auto_length(k, b)?,
                    left: auto_length(k, l)?,
                };
            }
            "padding" => {
                let [t, r, b, l] = four(k, v)?;
                style.padding = taffy::Rect {
                    top: length(k, t)?,
                    right: length(k, r)?,
                    bottom: length(k, b)?,
                    left: length(k, l)?,
                };
            }
            "borderWidth" => {
                let [t, r, b, l] = four(k, v)?;
                style.border = taffy::Rect {
                    top: length(k, t)?,
                    right: length(k, r)?,
                    bottom: length(k, b)?,
                    left: length(k, l)?,
                };
            }
            "width" => style.size.width = dimension(k, v)?,
            "height" => style.size.height = dimension(k, v)?,
            "minWidth" => style.min_size.width = auto_length(k, v)?,
            "minHeight" => style.min_size.height = auto_length(k, v)?,
            "maxWidth" => style.max_size.width = auto_length(k, v)?,
            "maxHeight" => style.max_size.height = auto_length(k, v)?,
            "aspectRatio" => {
                let ratio = number(k, v)?;
                if ratio <= 0.0 {
                    return Err(invalid(format!("aspectRatio must be above 0, got {ratio}")));
                }
                style.aspect_ratio = Some(ratio);
            }
            "boxSizing" => {
                style.box_sizing = match word(k, v)? {
                    "content-box" => BoxSizing::ContentBox,
                    "border-box" => BoxSizing::BorderBox,
                    other => return Err(bad_value(k, other)),
                }
            }
            "overflowX" => style.overflow.x = overflow(k, v)?,
            "overflowY" => style.overflow.y = overflow(k, v)?,
            "flexDirection" => {
                style.flex_direction = match word(k, v)? {
                    "row" => FlexDirection::Row,
                    "row-reverse" => FlexDirection::RowReverse,
                    "column" => FlexDirection::Column,
                    "column-reverse" => FlexDirection::ColumnReverse,
                    other => return Err(bad_value(k, other)),
                }
            }
            "flexWrap" => {
                style.flex_wrap = match word(k, v)? {
                    "nowrap" => FlexWrap::NoWrap,
                    "wrap" => FlexWrap::Wrap,
                    "wrap-reverse" => FlexWrap::WrapReverse,
                    other => return Err(bad_value(k, other)),
                }
            }
            "flexGrow" => style.flex_grow = number(k, v)?,
            "flexShrink" => style.flex_shrink = number(k, v)?,
            "flexBasis" => style.flex_basis = dimension(k, v)?,
            "justifyContent" => {
                style.justify_content = match word(k, v)? {
                    "normal" => JustifyContent::FLEX_START,
                    _ => content(k, v)?,
                }
            }
            "alignContent" => style.align_content = content(k, v)?,
            "alignItems" => style.align_items = align(k, v)?,
            "alignSelf" => {
                style.align_self = match word(k, v)? {
                    "auto" => None,
                    _ => Some(align(k, v)?),
                }
            }
            "rowGap" => style.gap.height = length(k, v)?,
            "columnGap" => style.gap.width = length(k, v)?,
            other => return Err(invalid(format!("unknown style property {other:?}"))),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::Path;

    use serde_json::json;

    use super::*;

    const FONT: &str = "assets/fonts/DMSans-Medium.ttf";

    fn engine() -> TextEngine {
        let fonts = BTreeMap::from([("DM Sans".to_string(), FONT.to_string())]);
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        TextEngine::new(&fonts, &root).unwrap()
    }

    fn request(root: Value, width: f32, height: f32) -> DomLayoutRequest {
        serde_json::from_value(json!({
            "root": root,
            "available": { "width": width, "height": height },
            "fonts": { "DM Sans": FONT },
        }))
        .unwrap()
    }

    /// Lays out `root` in a 1000 x 800 box, with the DM Sans engine.
    fn run(root: Value) -> DomLayoutBox {
        run_in(root, 1000.0, 800.0)
    }

    fn run_in(root: Value, width: f32, height: f32) -> DomLayoutBox {
        let request = request(root, width, height);
        let mut engine = engine();
        layout_dom(&request, &mut |spec, max| {
            Ok(measure_text(&mut engine, spec, max))
        })
        .unwrap()
    }

    fn boxed(b: &DomLayoutBox) -> [f64; 4] {
        [b.x, b.y, b.width, b.height]
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-3
    }

    fn text(s: &str, size: f64) -> Value {
        json!({ "text": { "text": s, "font": "DM Sans", "size": size } })
    }

    fn one_line(e: &mut TextEngine, s: &str, size: f32) -> crate::text::LaidOutText {
        e.layout(s, "DM Sans", size, None, None, TextAlign::Left)
    }

    #[test]
    fn a_block_fills_the_width_and_its_children_stack() {
        let b = run(json!({
            "style": { "padding": [10, 20, 10, 20] },
            "children": [
                { "style": { "height": 50 } },
                { "style": { "height": 30, "margin": [5, 0, 0, 0] } },
            ],
        }));
        // Stretched to the composition's width, as tall as its content.
        assert_eq!(boxed(&b), [0.0, 0.0, 1000.0, 105.0]);
        assert_eq!(b.padding, [10.0, 20.0, 10.0, 20.0]);
        assert_eq!(boxed(&b.children[0]), [20.0, 10.0, 960.0, 50.0]);
        assert_eq!(boxed(&b.children[1]), [20.0, 65.0, 960.0, 30.0]);
    }

    #[test]
    fn vertical_margins_of_siblings_collapse() {
        let b = run(json!({
            "children": [
                { "style": { "height": 20, "margin": [0, 0, 30, 0] } },
                { "style": { "height": 20, "margin": [10, 0, 0, 0] } },
            ],
        }));
        // 30 and 10 collapse into 30.
        assert_eq!(b.children[1].y, 50.0);
    }

    #[test]
    fn border_box_and_content_box_sizing() {
        let b = run(json!({
            "children": [
                { "style": { "width": 100, "height": 50, "padding": [5, 5, 5, 5], "borderWidth": [2, 2, 2, 2] } },
                { "style": { "width": 100, "height": 50, "padding": [5, 5, 5, 5], "borderWidth": [2, 2, 2, 2],
                             "boxSizing": "border-box" } },
            ],
        }));
        assert_eq!(boxed(&b.children[0])[2..], [114.0, 64.0]);
        assert_eq!(boxed(&b.children[1])[2..], [100.0, 50.0]);
        assert_eq!(b.children[1].border, [2.0; 4]);
    }

    #[test]
    fn flex_row_distributes_space_and_aligns() {
        let b = run(json!({
            "style": { "display": "flex", "justifyContent": "space-between", "alignItems": "center",
                       "height": 100 },
            "children": [
                { "style": { "width": 100, "height": 40 } },
                { "style": { "width": 100, "height": 60 } },
                { "style": { "width": 100, "height": 20 } },
            ],
        }));
        assert_eq!(boxed(&b.children[0]), [0.0, 30.0, 100.0, 40.0]);
        assert_eq!(boxed(&b.children[1]), [450.0, 20.0, 100.0, 60.0]);
        assert_eq!(boxed(&b.children[2]), [900.0, 40.0, 100.0, 20.0]);
    }

    #[test]
    fn flex_grow_shrink_gap_and_wrap() {
        let b = run(json!({
            "style": { "display": "flex", "columnGap": 10 },
            "children": [
                { "style": { "flexGrow": 1, "height": 10 } },
                { "style": { "flexGrow": 3, "height": 10 } },
            ],
        }));
        // 1000 - 10 of gap, shared 1:3.
        assert!(close(b.children[0].width, 247.5) && close(b.children[1].width, 742.5));
        assert!(close(b.children[1].x, 257.5));

        let shrunk = run(json!({
            "style": { "display": "flex" },
            "children": [
                { "style": { "width": 800, "height": 10 } },
                { "style": { "width": 400, "height": 10, "flexShrink": 0 } },
            ],
        }));
        assert_eq!(shrunk.children[1].width, 400.0);
        assert_eq!(shrunk.children[0].width, 600.0);

        let wrapped = run(json!({
            "style": { "display": "flex", "flexWrap": "wrap", "rowGap": 5, "alignContent": "flex-start" },
            "children": [
                { "style": { "width": 600, "height": 20 } },
                { "style": { "width": 600, "height": 20 } },
            ],
        }));
        assert_eq!(wrapped.children[1].y, 25.0);
    }

    #[test]
    fn flex_column_with_percentages() {
        let b = run(json!({
            "style": { "display": "flex", "flexDirection": "column", "height": { "percent": 100 } },
            "children": [
                { "style": { "height": { "percent": 25 }, "width": { "percent": 50 } } },
                { "style": { "flexGrow": 1 } },
            ],
        }));
        // The root's percentage resolves against the 800 px composition.
        assert_eq!(b.height, 800.0);
        assert_eq!(boxed(&b.children[0]), [0.0, 0.0, 500.0, 200.0]);
        assert_eq!(boxed(&b.children[1]), [0.0, 200.0, 1000.0, 600.0]);
    }

    #[test]
    fn auto_margins_centre_and_push() {
        let b = run(json!({
            "children": [
                { "style": { "width": 200, "height": 20, "margin": [0, "auto", 0, "auto"] } },
            ],
        }));
        assert_eq!(b.children[0].x, 400.0);
        let f = run(json!({
            "style": { "display": "flex", "height": 100 },
            "children": [
                { "style": { "width": 100, "height": 20 } },
                { "style": { "width": 100, "height": 20, "margin": [0, 0, 0, "auto"] } },
            ],
        }));
        assert_eq!(f.children[1].x, 900.0);
    }

    #[test]
    fn min_and_max_sizes_and_aspect_ratio() {
        let b = run(json!({
            "children": [
                { "style": { "width": 2000, "maxWidth": 300, "height": 10 } },
                { "style": { "width": 10, "minWidth": 120, "height": 10 } },
                { "style": { "width": 300, "aspectRatio": 2 } },
            ],
        }));
        assert_eq!(b.children[0].width, 300.0);
        assert_eq!(b.children[1].width, 120.0);
        assert_eq!(boxed(&b.children[2])[2..], [300.0, 150.0]);
    }

    #[test]
    fn absolute_boxes_leave_the_flow_and_use_their_insets() {
        let b = run(json!({
            "style": { "position": "relative", "height": 300 },
            "children": [
                { "style": { "position": "absolute", "inset": [10, "auto", "auto", 20], "width": 50, "height": 40 } },
                { "style": { "position": "absolute", "inset": ["auto", 5, 5, "auto"], "width": 50, "height": 40 } },
                { "style": { "position": "absolute", "inset": [0, 0, 0, 0] } },
                { "style": { "height": 70 } },
            ],
        }));
        assert_eq!(boxed(&b.children[0]), [20.0, 10.0, 50.0, 40.0]);
        assert_eq!(boxed(&b.children[1]), [945.0, 255.0, 50.0, 40.0]);
        assert_eq!(boxed(&b.children[2]), [0.0, 0.0, 1000.0, 300.0]);
        // The flow ignores them.
        assert_eq!(boxed(&b.children[3]), [0.0, 0.0, 1000.0, 70.0]);
    }

    #[test]
    fn an_absolute_root_is_placed_in_the_composition() {
        let b = run(json!({
            "style": { "position": "absolute", "inset": [0, 0, 0, 0], "display": "flex",
                       "flexDirection": "column", "justifyContent": "center", "alignItems": "center" },
            "children": [{ "style": { "width": 100, "height": 100 } }],
        }));
        assert_eq!(boxed(&b), [0.0, 0.0, 1000.0, 800.0]);
        assert_eq!(boxed(&b.children[0]), [450.0, 350.0, 100.0, 100.0]);
    }

    #[test]
    fn display_none_takes_no_space() {
        let b = run(json!({
            "children": [
                { "style": { "display": "none", "height": 90 } },
                { "style": { "height": 10 } },
            ],
        }));
        assert_eq!(b.children[1].y, 0.0);
        assert_eq!(b.children[0].height, 0.0);
    }

    #[test]
    fn text_wraps_at_the_width_it_is_given() {
        let long = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
        let b = run(json!({
            "style": { "width": 220 },
            "children": [{ "style": { "padding": [0, 10, 0, 10] }, "measure": text(long, 32.0) }],
        }));
        let t = &b.children[0];
        assert_eq!(t.width, 220.0);
        // The lines the text layer gets with maxWidth = the content box.
        let mut e = engine();
        let spec = TextMeasure {
            text: long.into(),
            font: "DM Sans".into(),
            size: 32.0,
            line_height: None,
            align: None,
            white_space: None,
        };
        let wrapped = measure_text(&mut e, &spec, Some(200.0));
        assert!(wrapped.height > one_line(&mut e, long, 32.0).height * 1.5);
        assert!(
            close(t.height, f64::from(wrapped.height)),
            "{} vs {}",
            t.height,
            wrapped.height
        );
    }

    #[test]
    fn text_in_a_flex_item_is_as_wide_as_its_text_until_the_row_is_full() {
        let b = run(json!({
            "style": { "display": "flex" },
            "children": [{ "measure": text("Hello", 40.0) }],
        }));
        let mut e = engine();
        let one = one_line(&mut e, "Hello", 40.0);
        assert!(close(b.children[0].width, f64::from(grid(one.width))));
        assert!(close(b.children[0].height, f64::from(one.height)));

        let tight = run(json!({
            "style": { "display": "flex", "width": 130 },
            "children": [{ "measure": text("Hello world again", 40.0) }],
        }));
        // The item shrinks to the row and its text wraps.
        assert!(tight.children[0].width <= 130.0 + 1e-3);
        assert!(tight.children[0].height > f64::from(one.height) * 1.5);
    }

    #[test]
    fn nowrap_text_keeps_one_line_and_a_line_height_is_a_multiple() {
        let b = run(json!({
            "style": { "width": 50 },
            "children": [
                { "measure": { "text": { "text": "a long line of words", "font": "DM Sans", "size": 20,
                                         "whiteSpace": "nowrap" } } },
                { "measure": { "text": { "text": "a\nb", "font": "DM Sans", "size": 20, "lineHeight": 2 } } },
            ],
        }));
        let mut e = engine();
        let one = one_line(&mut e, "a long line of words", 20.0);
        assert!(close(b.children[0].height, f64::from(one.height)));
        assert!(close(b.children[1].height, 80.0));
    }

    #[test]
    fn text_baselines_line_up_in_a_row() {
        let b = run(json!({
            "style": { "display": "flex", "alignItems": "baseline" },
            "children": [
                { "measure": text("Big", 60.0) },
                { "measure": text("small", 20.0) },
            ],
        }));
        let mut e = engine();
        let big = one_line(&mut e, "Big", 60.0);
        let small = one_line(&mut e, "small", 20.0);
        let gap = f64::from(big.lines[0].baseline - small.lines[0].baseline);
        assert!(close(b.children[1].y - b.children[0].y, gap));
    }

    #[test]
    fn a_leaf_of_an_intrinsic_size() {
        let img = run(json!({
            "children": [
                { "style": { "width": 300 }, "measure": { "width": 40, "height": 30 } },
                { "measure": { "width": 40, "height": 30 } },
            ],
        }));
        assert_eq!(boxed(&img.children[0])[2..], [300.0, 30.0]);
        // A block-level replaced box with no width is its intrinsic width.
        assert_eq!(boxed(&img.children[1])[2..], [40.0, 30.0]);
    }

    #[test]
    fn bad_styles_and_fonts_are_invalid_requests() {
        let error = |style: Value, measure: Value| {
            let request = request(json!({ "style": style, "measure": measure }), 10.0, 10.0);
            layout_dom(&request, &mut |_, _| {
                Ok(TextSize {
                    width: 1.0,
                    height: 1.0,
                    baseline: 1.0,
                })
            })
            .expect_err("an error")
            .to_string()
        };
        assert!(error(json!({ "colour": 1 }), Value::Null).contains("unknown style property"));
        assert!(error(json!({ "display": "grid" }), Value::Null).contains("display"));
        assert!(error(json!({ "margin": [1, 2] }), Value::Null).contains("margin"));
        assert!(
            error(
                json!({}),
                json!({ "text": { "text": "a", "font": "Nope", "size": 10 } })
            )
            .contains("Nope")
        );
    }
}
