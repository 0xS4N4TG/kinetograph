//! Flex layout of groups, with taffy, applied to a resolved scene.
//!
//! `Scene::resolve` first evaluates every layer on its own, then
//! [`Resolver::lay_out`] runs over the result. Each group with a `layout`
//! that is not itself laid out by another group is the root of a region: the
//! groups with a `layout` inside it, down to its leaves, make one taffy tree.
//! A leaf is a flex item of its box's size (text is measured with the
//! renderer's own engine, so layout sees what is drawn), and taffy gives every
//! node a position and every group a size. The position is then folded into
//! the child's resolved transform, so that everything downstream (bounds, the
//! layer cache, the margin, `inspect`) sees the laid-out layer, and the
//! group's size is stored in the group (it is the group's box).
//!
//! The leaf nodes carry their size in a context that the measure function
//! hands back, with the first baseline, so taffy's baseline alignment works
//! for text.

use taffy::prelude::*;
use taffy::{Baselines, TaffyTree, compute_leaf_layout};
use vello::kurbo::Rect as KRect;

use crate::error::{Error, Result};
use crate::resolve::{ResolvedItem, ResolvedKind, ResolvedLayer, ResolvedLayout, Resolver};
use crate::scene as sc;

/// What a leaf node knows about itself: the size it was given and where its
/// first baseline is, from the top.
#[derive(Clone, Copy)]
struct Leaf {
    size: (f32, f32),
    baseline: f32,
}

/// A layout group's node and its children, in the order of the group's
/// `children`.
struct Plan {
    node: NodeId,
    kids: Vec<Kid>,
}

enum Kid {
    /// Out of the flow (`position: absolute`): left where its transform puts
    /// it; a group in it is laid out on its own.
    Free,
    /// A leaf, in the flow, whose box's top-left corner is `(x, y)` in its
    /// own space.
    Leaf { node: NodeId, x: f64, y: f64 },
    /// A group without a `layout`, in the flow: a node of the size the item
    /// gives it (0 x 0 without one), with no box.
    Plain { node: NodeId },
    /// A group with a `layout`.
    Region(Plan),
}

fn has_layout(layer: &ResolvedLayer) -> bool {
    let inside = match &layer.kind {
        ResolvedKind::Group {
            layout, children, ..
        } => layout.is_some() || children.iter().any(has_layout),
        _ => false,
    };
    inside || layer.motion.iter().any(has_layout)
}

impl Resolver<'_> {
    /// Places the children of every group with a `layout` in `layers` and
    /// gives those groups their sizes. Text is measured with the resolver's
    /// engine, and only if there is a layout to run.
    pub(crate) fn lay_out(&mut self, layers: &mut [ResolvedLayer]) -> Result<()> {
        if !layers.iter().any(has_layout) {
            return Ok(());
        }
        for layer in layers {
            self.lay_out_layer(layer, None)?;
        }
        Ok(())
    }

    /// Lays out `layer`: a group with a `layout` as a region of its own
    /// (`forced` is the size its parent's layout gave it, if it has one), any
    /// other group by laying out what is inside it, and the same for the
    /// copies of its motion blur.
    fn lay_out_layer(
        &mut self,
        layer: &mut ResolvedLayer,
        forced: Option<(f64, f64)>,
    ) -> Result<()> {
        match &mut layer.kind {
            ResolvedKind::Group {
                layout: Some(_), ..
            } => self.lay_out_region(layer, forced)?,
            ResolvedKind::Group { children, .. } => {
                for child in children {
                    self.lay_out_layer(child, None)?;
                }
            }
            _ => {}
        }
        for copy in &mut layer.motion {
            self.lay_out_layer(copy, forced)?;
        }
        Ok(())
    }

    fn lay_out_region(
        &mut self,
        root: &mut ResolvedLayer,
        forced: Option<(f64, f64)>,
    ) -> Result<()> {
        let mut tree: TaffyTree<Leaf> = TaffyTree::new();
        // Positions stay fractional: they animate.
        tree.disable_rounding();
        let plan = self.build(&mut tree, root, forced, true)?;
        tree.compute_layout_with_measure(plan.node, Size::MAX_CONTENT, |inputs, _, leaf, style| {
            match leaf {
                Some(leaf) => {
                    let size = Size {
                        width: leaf.size.0,
                        height: leaf.size.1,
                    };
                    let mut out = compute_leaf_layout(inputs, style, |_, _| 0.0, |_, _| size);
                    out.baselines = Baselines::from_first(Some(leaf.baseline));
                    out
                }
                // A container with no children.
                None => compute_leaf_layout(inputs, style, |_, _| 0.0, |_, _| Size::ZERO),
            }
        })
        .map_err(layout_error)?;
        self.apply(&tree, &plan, root)
    }

    /// The taffy node of the layout group `layer` (and, below it, of
    /// everything in its flow). `forced` is a size to use instead of the
    /// layout's own; `root` says whether the group is the top of its region,
    /// whose `layoutItem` is not a flex item's.
    fn build(
        &mut self,
        tree: &mut TaffyTree<Leaf>,
        layer: &ResolvedLayer,
        forced: Option<(f64, f64)>,
        root: bool,
    ) -> Result<Plan> {
        let ResolvedKind::Group {
            children,
            layout: Some(layout),
            ..
        } = &layer.kind
        else {
            unreachable!("regions are built from groups with a layout");
        };
        let item = if root { None } else { layer.item.as_ref() };
        let mut nodes = Vec::with_capacity(children.len());
        let mut kids = Vec::with_capacity(children.len());
        for child in children {
            let item = child.item.as_ref();
            if item.is_some_and(|i| i.absolute) {
                kids.push(Kid::Free);
                continue;
            }
            let (node, kid) = match &child.kind {
                ResolvedKind::Group {
                    layout: Some(_), ..
                } => {
                    let plan = self.build(tree, child, None, false)?;
                    (plan.node, Kid::Region(plan))
                }
                ResolvedKind::Group { .. } => {
                    let size = item_size(item, (0.0, 0.0));
                    let node = leaf_node(tree, size, 0.0, item)?;
                    (node, Kid::Plain { node })
                }
                kind => {
                    let (b, baseline) = self.leaf_box(kind)?;
                    let size = item_size(item, (b.width(), b.height()));
                    let node = leaf_node(tree, size, baseline, item)?;
                    (
                        node,
                        Kid::Leaf {
                            node,
                            x: b.x0,
                            y: b.y0,
                        },
                    )
                }
            };
            nodes.push(node);
            kids.push(kid);
        }
        let style = container_style(layout, item, forced);
        let node = tree
            .new_with_children(style, &nodes)
            .map_err(layout_error)?;
        Ok(Plan { node, kids })
    }

    /// The box of a leaf layer (a group without a layout has none: nothing
    /// of its own to measure) and where its first baseline is: the first
    /// line's for text, the bottom edge for anything else, as CSS puts the
    /// baseline of a box without text.
    fn leaf_box(&mut self, kind: &ResolvedKind) -> Result<(KRect, f64)> {
        if let ResolvedKind::Text {
            text,
            font,
            size,
            line_height,
            max_width,
            align,
            ..
        } = kind
        {
            let laid_out =
                self.engine()?
                    .layout(text, font, *size, *line_height, *max_width, *align);
            let (width, height) = laid_out.box_size(*max_width);
            let baseline = laid_out
                .lines
                .first()
                .map_or(height, |line| f64::from(line.baseline));
            return Ok((KRect::new(0.0, 0.0, width, height), baseline));
        }
        let b = self.layer_box(kind)?.unwrap_or(KRect::ZERO);
        Ok((b, b.y1))
    }

    /// Writes taffy's results into `layer`, a layout group, and everything in
    /// its flow: sizes for the layout groups, positions for the children.
    fn apply(
        &mut self,
        tree: &TaffyTree<Leaf>,
        plan: &Plan,
        layer: &mut ResolvedLayer,
    ) -> Result<()> {
        let size = {
            let l = tree.layout(plan.node).map_err(layout_error)?;
            (f64::from(l.size.width), f64::from(l.size.height))
        };
        let ResolvedKind::Group {
            children,
            layout: Some(layout),
            size: group_size,
            ..
        } = &mut layer.kind
        else {
            unreachable!("regions are built from groups with a layout");
        };
        *group_size = Some(size);
        layer.transform.origin_x = layout.origin.0 * size.0;
        layer.transform.origin_y = layout.origin.1 * size.1;
        for (kid, child) in plan.kids.iter().zip(children.iter_mut()) {
            match kid {
                Kid::Free => self.lay_out_layer(child, None)?,
                Kid::Leaf { node, x, y } => {
                    let at = location(tree, *node)?;
                    self.place(child, at, (*x, *y))?;
                }
                Kid::Plain { node } => {
                    let at = location(tree, *node)?;
                    self.lay_out_layer(child, None)?;
                    self.place(child, at, (0.0, 0.0))?;
                }
                Kid::Region(sub) => {
                    self.apply(tree, sub, child)?;
                    let at = location(tree, sub.node)?;
                    // The copies of a blurred group are laid out at the size
                    // the frame's group got.
                    let ResolvedKind::Group {
                        size: Some(own), ..
                    } = &child.kind
                    else {
                        unreachable!("just laid out");
                    };
                    let own = *own;
                    for copy in &mut child.motion {
                        self.lay_out_layer(copy, Some(own))?;
                    }
                    self.place(child, at, (0.0, 0.0))?;
                }
            }
        }
        Ok(())
    }

    /// Moves `layer`, and the copies of its motion blur, so that the top-left
    /// corner of its box, `corner` in its own space, lands at `at` in its
    /// parent's: the layer is drawn as if its `x` and `y` were `x + left -
    /// corner.x + anchorX`, so the transform's own `x`, `y` stay an offset
    /// from the laid-out place.
    fn place(
        &mut self,
        layer: &mut ResolvedLayer,
        at: (f64, f64),
        corner: (f64, f64),
    ) -> Result<()> {
        shift(layer, at, corner);
        for copy in &mut layer.motion {
            let corner = match &copy.kind {
                // A group's box starts at its own origin.
                ResolvedKind::Group { .. } => (0.0, 0.0),
                kind => {
                    let b = self.leaf_box(kind)?.0;
                    (b.x0, b.y0)
                }
            };
            shift(copy, at, corner);
        }
        Ok(())
    }
}

fn shift(layer: &mut ResolvedLayer, at: (f64, f64), corner: (f64, f64)) {
    let t = &mut layer.transform;
    t.x += at.0 - corner.0 + t.anchor_x;
    t.y += at.1 - corner.1 + t.anchor_y;
}

fn location(tree: &TaffyTree<Leaf>, node: NodeId) -> Result<(f64, f64)> {
    let l = tree.layout(node).map_err(layout_error)?;
    Ok((f64::from(l.location.x), f64::from(l.location.y)))
}

fn layout_error(e: taffy::TaffyError) -> Error {
    Error::Render(format!("layout failed: {e}"))
}

/// The size the layout uses for a leaf: the item's, side by side, or the box's.
fn item_size(item: Option<&ResolvedItem>, own: (f64, f64)) -> (f64, f64) {
    (
        item.and_then(|i| i.width).unwrap_or(own.0),
        item.and_then(|i| i.height).unwrap_or(own.1),
    )
}

fn leaf_node(
    tree: &mut TaffyTree<Leaf>,
    size: (f64, f64),
    baseline: f64,
    item: Option<&ResolvedItem>,
) -> Result<NodeId> {
    let mut style = Style {
        display: Display::Flex,
        size: Size {
            width: Dimension::length(size.0 as f32),
            height: Dimension::length(size.1 as f32),
        },
        ..Style::default()
    };
    if let Some(item) = item {
        item_style(&mut style, item);
    }
    let leaf = Leaf {
        size: (size.0 as f32, size.1 as f32),
        baseline: baseline as f32,
    };
    tree.new_leaf_with_context(style, leaf)
        .map_err(layout_error)
}

/// The flex item properties of `item`, onto `style`.
fn item_style(style: &mut Style, item: &ResolvedItem) {
    style.flex_grow = item.grow as f32;
    style.flex_shrink = item.shrink as f32;
    style.flex_basis = item
        .basis
        .map_or(Dimension::auto(), |b| Dimension::length(b as f32));
    style.align_self = match item.align_self {
        sc::AlignSelf::Auto => None,
        sc::AlignSelf::FlexStart => Some(AlignItems::FLEX_START),
        sc::AlignSelf::FlexEnd => Some(AlignItems::FLEX_END),
        sc::AlignSelf::Center => Some(AlignItems::CENTER),
        sc::AlignSelf::Baseline => Some(AlignItems::BASELINE),
        sc::AlignSelf::Stretch => Some(AlignItems::STRETCH),
    };
    let [top, right, bottom, left] = item.margin.map(|m| LengthPercentageAuto::length(m as f32));
    style.margin = taffy::Rect {
        left,
        right,
        top,
        bottom,
    };
}

fn container_style(
    layout: &ResolvedLayout,
    item: Option<&ResolvedItem>,
    forced: Option<(f64, f64)>,
) -> Style {
    let side = |forced: Option<f64>, item: Option<f64>, own: Option<f64>| {
        forced
            .or(item)
            .or(own)
            .map_or(Dimension::auto(), |v| Dimension::length(v as f32))
    };
    let mut style = Style {
        display: Display::Flex,
        flex_direction: match layout.direction {
            sc::FlexDirection::Row => FlexDirection::Row,
            sc::FlexDirection::Column => FlexDirection::Column,
            sc::FlexDirection::RowReverse => FlexDirection::RowReverse,
            sc::FlexDirection::ColumnReverse => FlexDirection::ColumnReverse,
        },
        flex_wrap: match layout.wrap {
            sc::FlexWrap::Nowrap => FlexWrap::NoWrap,
            sc::FlexWrap::Wrap => FlexWrap::Wrap,
            sc::FlexWrap::WrapReverse => FlexWrap::WrapReverse,
        },
        justify_content: match layout.justify_content {
            sc::JustifyContent::FlexStart => JustifyContent::FLEX_START,
            sc::JustifyContent::FlexEnd => JustifyContent::FLEX_END,
            sc::JustifyContent::Center => JustifyContent::CENTER,
            sc::JustifyContent::SpaceBetween => JustifyContent::SPACE_BETWEEN,
            sc::JustifyContent::SpaceAround => JustifyContent::SPACE_AROUND,
            sc::JustifyContent::SpaceEvenly => JustifyContent::SPACE_EVENLY,
        },
        align_items: match layout.align_items {
            sc::AlignItems::FlexStart => AlignItems::FLEX_START,
            sc::AlignItems::FlexEnd => AlignItems::FLEX_END,
            sc::AlignItems::Center => AlignItems::CENTER,
            sc::AlignItems::Baseline => AlignItems::BASELINE,
            sc::AlignItems::Stretch => AlignItems::STRETCH,
        },
        align_content: match layout.align_content {
            sc::AlignContent::FlexStart => AlignContent::FLEX_START,
            sc::AlignContent::FlexEnd => AlignContent::FLEX_END,
            sc::AlignContent::Center => AlignContent::CENTER,
            sc::AlignContent::SpaceBetween => AlignContent::SPACE_BETWEEN,
            sc::AlignContent::SpaceAround => AlignContent::SPACE_AROUND,
            sc::AlignContent::SpaceEvenly => AlignContent::SPACE_EVENLY,
            sc::AlignContent::Stretch => AlignContent::STRETCH,
        },
        gap: Size {
            // The row gap is between rows (vertical), the column gap between
            // columns.
            width: LengthPercentage::length(layout.gap.1 as f32),
            height: LengthPercentage::length(layout.gap.0 as f32),
        },
        padding: {
            let [top, right, bottom, left] =
                layout.padding.map(|p| LengthPercentage::length(p as f32));
            taffy::Rect {
                left,
                right,
                top,
                bottom,
            }
        },
        size: Size {
            width: side(
                forced.map(|f| f.0),
                item.and_then(|i| i.width),
                layout.width,
            ),
            height: side(
                forced.map(|f| f.1),
                item.and_then(|i| i.height),
                layout.height,
            ),
        },
        ..Style::default()
    };
    if let Some(item) = item {
        item_style(&mut style, item);
    }
    style
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::scene::Scene;
    use crate::text::TextEngine;

    /// `layers` as the top-level layers of a 400 x 300 scene (DM Sans
    /// registered), resolved at frame 5 of 10.
    fn laid_out(layers: &str) -> Vec<ResolvedLayer> {
        let json = format!(
            r##"{{"width": 400, "height": 300, "fps": 30, "durationInFrames": 11,
                "fonts": {{"DM Sans": "assets/fonts/DMSans-Medium.ttf"}}, "layers": {layers}}}"##
        );
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        Scene::from_json(&json, root)
            .unwrap()
            .resolve(5)
            .unwrap()
            .layers
    }

    fn rect(id: &str, w: f64, h: f64, extra: &str) -> String {
        format!(
            r##"{{"id": "{id}", "type": "shape", "fill": "#fff", {extra}
                 "shape": {{"kind": "rect", "width": {w}, "height": {h}}}}}"##
        )
    }

    fn group(id: &str, layout: &str, extra: &str, children: &[String]) -> String {
        format!(
            r#"{{"id": "{id}", "type": "group", "layout": {layout}, {extra} "children": [{}]}}"#,
            children.join(",")
        )
    }

    fn children(layer: &ResolvedLayer) -> &[ResolvedLayer] {
        match &layer.kind {
            ResolvedKind::Group { children, .. } => children,
            _ => panic!("not a group"),
        }
    }

    fn size(layer: &ResolvedLayer) -> Option<(f64, f64)> {
        match &layer.kind {
            ResolvedKind::Group { size, .. } => *size,
            _ => panic!("not a group"),
        }
    }

    fn at(layer: &ResolvedLayer) -> (f64, f64) {
        (layer.transform.x, layer.transform.y)
    }

    fn near(got: (f64, f64), want: (f64, f64)) {
        assert!(
            (got.0 - want.0).abs() < 1e-3 && (got.1 - want.1).abs() < 1e-3,
            "{got:?} vs {want:?}"
        );
    }

    #[test]
    fn a_row_centres_its_items_inside_the_padding() {
        let row = group(
            "row",
            r#"{"justifyContent": "center", "alignItems": "center", "gap": 8,
                "padding": [10, 10, 10, 10], "width": 400, "height": 100}"#,
            "",
            &[rect("a", 50.0, 20.0, ""), rect("b", 30.0, 40.0, "")],
        );
        let layers = laid_out(&format!("[{row}]"));
        assert_eq!(size(&layers[0]), Some((400.0, 100.0)));
        // The content is 380 wide and 80 tall; the items and the gap are 88
        // wide, so they start at 10 + (380 - 88) / 2.
        near(at(&children(&layers[0])[0]), (156.0, 40.0));
        near(at(&children(&layers[0])[1]), (214.0, 30.0));
    }

    #[test]
    fn a_container_without_a_size_is_as_big_as_its_content() {
        let row = group(
            "row",
            r#"{"gap": [100, 6], "padding": [1, 2, 3, 4]}"#,
            "",
            &[rect("a", 50.0, 20.0, ""), rect("b", 30.0, 40.0, "")],
        );
        let layers = laid_out(&format!("[{row}]"));
        // 4 + 50 + 6 + 30 + 2 wide, 1 + 40 + 3 tall (the row gap is between
        // rows, and there is one row).
        assert_eq!(size(&layers[0]), Some((92.0, 44.0)));
        near(at(&children(&layers[0])[0]), (4.0, 1.0));
        near(at(&children(&layers[0])[1]), (60.0, 1.0));
    }

    #[test]
    fn items_grow_by_their_factors_but_keep_their_own_size() {
        let col = group(
            "col",
            r#"{"flexDirection": "column", "width": 100, "height": 300}"#,
            "",
            &[
                rect("a", 100.0, 50.0, r#""layoutItem": {"flexGrow": 1},"#),
                rect("b", 100.0, 50.0, r#""layoutItem": {"flexGrow": 2},"#),
            ],
        );
        let layers = laid_out(&format!("[{col}]"));
        // 200 free: a grows to 116.67, b starts after it and is 133.33 tall.
        near(at(&children(&layers[0])[0]), (0.0, 0.0));
        near(at(&children(&layers[0])[1]), (0.0, 50.0 + 200.0 / 3.0));
        // The shape itself is not resized.
        assert!(matches!(
            children(&layers[0])[0].kind,
            ResolvedKind::Shape {
                geometry: crate::resolve::ResolvedGeometry::Rect { height, .. },
                ..
            } if height == 50.0
        ));
    }

    #[test]
    fn space_between_reverse_and_wrap() {
        let items = |n: usize| -> Vec<String> {
            (0..n)
                .map(|i| rect(&format!("i{i}"), 40.0, 20.0, ""))
                .collect()
        };
        let between = group(
            "between",
            r#"{"justifyContent": "space-between", "width": 200, "height": 20}"#,
            "",
            &items(3),
        );
        let layers = laid_out(&format!("[{between}]"));
        let xs: Vec<f64> = children(&layers[0]).iter().map(|c| at(c).0).collect();
        assert!(
            xs.iter()
                .zip([0.0, 80.0, 160.0])
                .all(|(a, b)| (a - b).abs() < 1e-3),
            "{xs:?}"
        );

        let reversed = group(
            "reversed",
            r#"{"flexDirection": "row-reverse", "width": 200, "height": 20}"#,
            "",
            &items(2),
        );
        let layers = laid_out(&format!("[{reversed}]"));
        let xs: Vec<f64> = children(&layers[0]).iter().map(|c| at(c).0).collect();
        assert!(
            xs.iter()
                .zip([160.0, 120.0])
                .all(|(a, b)| (a - b).abs() < 1e-3),
            "{xs:?}"
        );

        // Three 40 wide items fit in 100 two at a time; the row gap is 10 and
        // the column gap 5.
        let wrapped = group(
            "wrapped",
            r#"{"flexWrap": "wrap", "gap": [10, 5], "width": 100, "alignContent": "flex-start"}"#,
            "",
            &items(3),
        );
        let layers = laid_out(&format!("[{wrapped}]"));
        let kids = children(&layers[0]);
        near(at(&kids[0]), (0.0, 0.0));
        near(at(&kids[1]), (45.0, 0.0));
        near(at(&kids[2]), (0.0, 30.0));
    }

    #[test]
    fn margins_and_align_self_place_an_item() {
        let row = group(
            "row",
            r#"{"alignItems": "flex-start", "width": 200, "height": 100}"#,
            "",
            &[
                rect(
                    "a",
                    30.0,
                    20.0,
                    r#""layoutItem": {"margin": [4, 0, 0, 7]},"#,
                ),
                rect(
                    "b",
                    30.0,
                    20.0,
                    r#""layoutItem": {"alignSelf": "flex-end"},"#,
                ),
                rect(
                    "c",
                    30.0,
                    20.0,
                    r#""layoutItem": {"alignSelf": "center", "margin": 3},"#,
                ),
            ],
        );
        let layers = laid_out(&format!("[{row}]"));
        let kids = children(&layers[0]);
        near(at(&kids[0]), (7.0, 4.0));
        // After a's 7 + 30 and b's 30, c's own 3 margin.
        near(at(&kids[1]), (37.0, 80.0));
        near(at(&kids[2]), (70.0, 40.0));
    }

    #[test]
    fn a_layout_item_size_stands_in_for_the_box() {
        let row = group(
            "row",
            r#"{"width": 300, "height": 50}"#,
            "",
            &[
                rect("a", 10.0, 10.0, r#""layoutItem": {"width": 100},"#),
                rect("b", 10.0, 10.0, ""),
                // A group without a layout is 0 x 0 unless the item says.
                group_plain("g", r#""layoutItem": {"width": 20, "height": 20},"#),
                group_plain("empty", ""),
                rect("c", 10.0, 10.0, ""),
            ],
        );
        let layers = laid_out(&format!("[{row}]"));
        let xs: Vec<f64> = children(&layers[0]).iter().map(|c| at(c).0).collect();
        let want = [0.0, 100.0, 110.0, 130.0, 130.0];
        assert!(
            xs.iter().zip(want).all(|(a, b)| (a - b).abs() < 1e-3),
            "{xs:?}"
        );
    }

    fn group_plain(id: &str, extra: &str) -> String {
        format!(r#"{{"id": "{id}", "type": "group", {extra} "children": []}}"#)
    }

    #[test]
    fn the_transform_is_an_offset_from_the_laid_out_place() {
        // An anchor and an own offset: x = own + left - box.x + anchor.
        let row = group(
            "row",
            r#"{"padding": 10}"#,
            "",
            &[
                rect(
                    "a",
                    40.0,
                    20.0,
                    r#""transform": {"x": 3, "y": -2, "anchorX": 20, "anchorY": 10},"#,
                ),
                // A path whose box starts at (20, 10).
                r##"{"id": "p", "type": "shape", "fill": "#fff",
                    "shape": {"kind": "path", "d": "M20 10 L60 10 L40 50 Z"}}"##
                    .to_string(),
            ],
        );
        let layers = laid_out(&format!("[{row}]"));
        let kids = children(&layers[0]);
        near(at(&kids[0]), (10.0 + 3.0 + 20.0, 10.0 - 2.0 + 10.0));
        // Its corner is at left 50 (after a's 40), top 10, and its box starts at (20, 10).
        near(at(&kids[1]), (50.0 - 20.0, 10.0 - 10.0));
        // So the box's corner lands at the laid-out place.
        let corner = kids[1].transform.matrix() * vello::kurbo::Point::new(20.0, 10.0);
        near((corner.x, corner.y), (50.0, 10.0));
        let corner = kids[0].transform.matrix() * vello::kurbo::Point::new(0.0, 0.0);
        near((corner.x, corner.y), (13.0, 8.0));
    }

    #[test]
    fn absolute_items_are_left_where_their_transform_puts_them() {
        let row = group(
            "row",
            r#"{"width": 200, "height": 50}"#,
            "",
            &[
                rect(
                    "badge",
                    10.0,
                    10.0,
                    r#""layoutItem": {"position": "absolute"}, "transform": {"x": 150, "y": 5},"#,
                ),
                rect("a", 30.0, 20.0, ""),
            ],
        );
        let layers = laid_out(&format!("[{row}]"));
        let kids = children(&layers[0]);
        near(at(&kids[0]), (150.0, 5.0));
        near(at(&kids[1]), (0.0, 0.0));
    }

    #[test]
    fn layout_groups_nest_and_get_the_size_their_parent_gives_them() {
        let inner = group(
            "inner",
            r#"{"flexDirection": "column", "gap": 4}"#,
            "",
            &[rect("a", 30.0, 10.0, ""), rect("b", 50.0, 10.0, "")],
        );
        let outer = group(
            "outer",
            r#"{"width": 200, "height": 100, "alignItems": "stretch"}"#,
            "",
            &[rect("lead", 20.0, 20.0, ""), inner],
        );
        let layers = laid_out(&format!("[{outer}]"));
        let kids = children(&layers[0]);
        // The inner column is 50 x 24 from its content, stretched to the
        // row's 100.
        assert_eq!(size(&kids[1]), Some((50.0, 100.0)));
        near(at(&kids[1]), (20.0, 0.0));
        near(at(&children(&kids[1])[1]), (0.0, 14.0));
        // A layout item can size a nested group, and it can grow.
        let inner = group(
            "inner",
            r#"{}"#,
            r#""layoutItem": {"flexGrow": 1},"#,
            &[rect("a", 30.0, 10.0, "")],
        );
        let outer = group(
            "outer",
            r#"{"width": 200, "height": 100, "alignItems": "center"}"#,
            "",
            &[rect("lead", 20.0, 20.0, ""), inner],
        );
        let layers = laid_out(&format!("[{outer}]"));
        let kids = children(&layers[0]);
        assert_eq!(size(&kids[1]), Some((180.0, 10.0)));
        near(at(&kids[1]), (20.0, 45.0));
    }

    #[test]
    fn a_layout_groups_origin_is_a_fraction_of_the_size_the_layout_gives_it() {
        let g = group(
            "g",
            r#"{"width": 100, "height": 40}"#,
            r#""transform": {"originX": 0.5, "originY": 1},"#,
            &[rect("a", 10.0, 10.0, "")],
        );
        let layers = laid_out(&format!("[{g}]"));
        assert_eq!(
            (layers[0].transform.origin_x, layers[0].transform.origin_y),
            (50.0, 40.0)
        );
    }

    #[test]
    fn a_layout_group_has_a_box_for_clips_and_corner_pins() {
        let json = |extra: &str| {
            format!(
                r#"[{}]"#,
                group("g", r#"{"width": 100, "height": 40}"#, extra, &[])
            )
        };
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let load = |extra: &str| {
            Scene::from_json(
                &format!(
                    r##"{{"width": 100, "height": 100, "fps": 30, "durationInFrames": 1, "layers": {}}}"##,
                    json(extra)
                ),
                root.clone(),
            )
        };
        load(r#""clip": {"kind": "inset", "top": 2},"#).unwrap();
        load(r#""effects": [{"type": "cornerPin"}],"#).unwrap();
        // Without a layout a group still has none.
        let msg = Scene::from_json(
            r##"{"width": 10, "height": 10, "fps": 30, "durationInFrames": 1, "layers": [
              {"id": "plain", "type": "group", "children": [], "clip": {"kind": "inset"}}]}"##,
            root,
        )
        .unwrap_err()
        .to_string();
        assert!(
            msg.contains("\"plain\"") && msg.contains("without a layout"),
            "{msg}"
        );
    }

    #[test]
    fn text_is_an_item_of_its_laid_out_box_and_aligns_by_its_baseline() {
        let text = |id: &str, size: u32| {
            format!(
                r##"{{"id": "{id}", "type": "text", "text": "Hxg", "font": "DM Sans", "size": {size},
                     "color": "#fff"}}"##
            )
        };
        let row = group(
            "row",
            r#"{"alignItems": "baseline"}"#,
            "",
            &[
                text("small", 20),
                text("big", 60),
                rect("box", 10.0, 30.0, ""),
            ],
        );
        let layers = laid_out(&format!("[{row}]"));
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let fonts = std::collections::BTreeMap::from([(
            "DM Sans".to_string(),
            "assets/fonts/DMSans-Medium.ttf".to_string(),
        )]);
        let mut engine = TextEngine::new(&fonts, &root).unwrap();
        let mut baseline = |size: f32| {
            let t = engine.layout(
                "Hxg",
                "DM Sans",
                size,
                None,
                None,
                crate::scene::TextAlign::Left,
            );
            (f64::from(t.lines[0].baseline), f64::from(t.width))
        };
        let kids = children(&layers[0]);
        let (small, big) = (baseline(20.0), baseline(60.0));
        // The baselines are on one line, and the box sits on it by its bottom
        // edge, 30 below its top.
        let line = at(&kids[1]).1 + big.0;
        assert!((at(&kids[0]).1 + small.0 - line).abs() < 1e-3);
        assert!((at(&kids[2]).1 + 30.0 - line).abs() < 1e-3);
        // Side by side by their laid-out widths.
        assert!((at(&kids[1]).0 - small.1).abs() < 1e-3);
        assert!((at(&kids[2]).0 - small.1 - big.1).abs() < 1e-3);
        // The row is as tall as the tallest above and below the line.
        assert!(size(&layers[0]).unwrap().1 >= 60.0);
    }

    #[test]
    fn motion_blur_copies_are_placed_like_the_layer() {
        let blurred = r##"{"id": "m", "type": "shape", "fill": "#fff",
              "shape": {"kind": "rect", "width": 10, "height": 10},
              "motionBlur": {"samples": 2, "shutter": 1, "frames": [
                {"id": "m", "type": "shape", "fill": "#fff", "transform": {"x": 1},
                 "shape": {"kind": "rect", "width": 10, "height": 10}},
                {"id": "m", "type": "shape", "fill": "#fff", "transform": {"x": 5},
                 "shape": {"kind": "rect", "width": 10, "height": 10}}]}}"##
            .to_string();
        let row = group(
            "row",
            r#"{"padding": 20}"#,
            "",
            &[rect("lead", 40.0, 10.0, ""), blurred],
        );
        let layers = laid_out(&format!("[{row}]"));
        let m = &children(&layers[0])[1];
        near(at(m), (60.0, 20.0));
        // Each copy is its own offset from the same place.
        near(at(&m.motion[0]), (61.0, 20.0));
        near(at(&m.motion[1]), (65.0, 20.0));
    }

    #[test]
    fn nested_layout_groups_of_a_blurred_group_are_laid_out_in_each_copy() {
        let make = |id: &str, w: f64| {
            group(
                id,
                r#"{"padding": 5}"#,
                "",
                &[rect("k", w, 10.0, ""), rect("k2", 10.0, 10.0, "")],
            )
        };
        let blurred = make("g", 20.0).replacen(
            r#""children""#,
            &format!(
                r#""motionBlur": {{"samples": 2, "shutter": 1, "frames": [{}, {}]}}, "children""#,
                make("g", 20.0),
                make("g", 30.0)
            ),
            1,
        );
        let outer = group(
            "outer",
            r#"{"width": 200, "height": 100}"#,
            "",
            &[rect("lead", 20.0, 10.0, ""), blurred],
        );
        let layers = laid_out(&format!("[{outer}]"));
        let g = &children(&layers[0])[1];
        assert_eq!(g.motion.len(), 2);
        // The copies keep the size the frame's group got (a width from its
        // content: 5 + 20 + 10 + 5), and place their children inside it.
        assert_eq!(size(g), Some((40.0, 100.0)));
        for copy in &g.motion {
            assert_eq!(size(copy), Some((40.0, 100.0)));
            near(at(copy), (20.0, 0.0));
        }
        near(at(&children(&g.motion[1])[1]), (5.0 + 30.0, 5.0));
    }

    #[test]
    fn scenes_without_a_layout_are_resolved_as_they_were() {
        // Nothing to lay out: no engine is needed (there are no fonts at all).
        let json = r##"{"width": 100, "height": 100, "fps": 30, "durationInFrames": 2, "layers": [
          {"id": "a", "type": "shape", "fill": "#fff", "layoutItem": {"flexGrow": 3},
           "shape": {"kind": "rect", "width": 10, "height": 10}, "transform": {"x": 7}}]}"##;
        let scene = Scene::from_json(json, std::path::PathBuf::new()).unwrap();
        let layers = scene.resolve(1).unwrap().layers;
        assert_eq!(at(&layers[0]), (7.0, 0.0));
    }

    #[test]
    fn the_same_layout_comes_from_a_borrowed_engine() {
        let row = group(
            "row",
            r#"{"justifyContent": "center", "width": 300, "height": 40}"#,
            "",
            &[
                r##"{"id": "t", "type": "text", "text": "Hello", "font": "DM Sans", "size": 30,
                    "color": "#fff"}"##
                    .to_string(),
            ],
        );
        let json = format!(
            r##"{{"width": 400, "height": 300, "fps": 30, "durationInFrames": 2,
                "fonts": {{"DM Sans": "assets/fonts/DMSans-Medium.ttf"}}, "layers": [{row}]}}"##
        );
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let scene = Scene::from_json(&json, root).unwrap();
        let mut engine = TextEngine::new(&scene.fonts, &scene.base_dir).unwrap();
        let borrowed = scene.resolve_with_text(1, &mut engine).unwrap();
        assert_eq!(borrowed.layers, scene.resolve(1).unwrap().layers);
        // Centred: the text is not at 0.
        assert!(at(&children(&borrowed.layers[0])[0]).0 > 10.0);
    }
}
