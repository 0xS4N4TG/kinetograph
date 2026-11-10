//! Flattening a frame: where each layer sits, in 3D or flat, and the depth order of a
//! `preserve3d` group.

use super::*;

/// A layer of a preserve3d group drawn flat for warping piece by piece:
/// drawn `shift` pixels right and down of where it belongs, and `h` the warp
/// of that picture into place.
pub(super) struct Flat {
    pub(super) tex: Tex,
    pub(super) h: DMat3,
    pub(super) shift: (f64, f64),
}

/// How a layer is moved in 3D: `world` is its `W` (see `warp.rs`; inside a
/// `preserve3d` group, the accumulated one), acting on the plane of the
/// space whose flat matrix is `parent`.
#[derive(Clone, Copy)]
pub(super) struct Placement {
    pub(super) parent: Affine,
    pub(super) world: DMat4,
    /// Not drawn when turned to show its back (`Transform::backface_hidden`).
    pub(super) backface_hidden: bool,
}

/// Where a `preserve3d` group's children are, while they are being placed.
/// Everything is relative to the space outside the outermost preserve3d group
/// (`parent` is that space's flat matrix, with the margin offset).
#[derive(Clone, Copy)]
pub(super) struct Space3d {
    pub(super) parent: Affine,
    /// From the space of the children's parent to the outer space: the product
    /// of the 2D matrices of the preserve3d groups down to it.
    pub(super) flat: Affine,
    /// The `W` of the children's parent in the outer space (`warp::child_world`
    /// builds a child's from it).
    pub(super) world: DMat4,
    /// The product of those groups' opacities.
    pub(super) opacity: f32,
}

/// A layer of a `preserve3d` group waiting for its turn to be drawn.
pub(super) struct DepthItem<'a> {
    pub(super) layer: &'a ResolvedLayer,
    /// The list `layer` is in, where its matte source is found.
    pub(super) siblings: &'a [ResolvedLayer],
    /// Flat matrix of the layer's parent, with the margin: what
    /// `layer_texture` rasterises the layer under.
    pub(super) flat_parent: Affine,
    pub(super) placement: Placement,
    /// The preserve3d groups' opacity, to multiply into the layer's own.
    pub(super) opacity: f32,
    /// What it is sorted by: the z of the layer's centre once placed.
    pub(super) depth: f64,
    /// Its box in its own space (`Renderer::plane_extent`), if it has one.
    pub(super) extent: Option<Rect>,
}

/// Lists the layers a `preserve3d` group draws: its `children`, with those of
/// preserve3d groups nested in it in their place (nested groups sort as one),
/// in document order. A group that is not itself preserve3d is one item, drawn
/// as a flat picture. `layer_box` gives a layer's box in its own space (none
/// for a group), whose middle is where its depth is measured; a layer without
/// one is measured at its position. Matte sources and layers with no
/// opacity are left out.
pub(super) fn collect_preserve3d<'a>(
    children: &'a [ResolvedLayer],
    space: Space3d,
    layer_box: &mut impl FnMut(&ResolvedLayer) -> Result<Option<Rect>>,
    out: &mut Vec<DepthItem<'a>>,
) -> Result<()> {
    // A group scaled to nothing shows nothing, and cannot be inverted.
    if !warp::invertible(space.flat) {
        return Ok(());
    }
    for child in children {
        if child.opacity <= 0.0 || is_matte_source(children, child) {
            continue;
        }
        let world = match warp::layer_world(&child.transform) {
            Some(own) => warp::child_world(space.world, space.flat, own),
            None => space.world,
        };
        let flat = space.flat * child.transform.matrix();
        if let ResolvedKind::Group {
            children: inner,
            preserve3d: true,
            ..
        } = &child.kind
        {
            let inner_space = Space3d {
                flat,
                world,
                opacity: space.opacity * child.opacity,
                ..space
            };
            collect_preserve3d(inner, inner_space, layer_box, out)?;
            continue;
        }
        let extent = layer_box(child)?;
        let local = match extent {
            Some(b) => b.center(),
            None => Point::new(child.transform.anchor_x, child.transform.anchor_y),
        };
        let centre = flat * local;
        out.push(DepthItem {
            layer: child,
            siblings: children,
            flat_parent: space.parent * space.flat,
            placement: Placement {
                parent: space.parent,
                world,
                backface_hidden: child.transform.backface_hidden,
            },
            opacity: space.opacity,
            depth: warp::depth(&world, (centre.x, centre.y)),
            extent,
        });
    }
    Ok(())
}

/// The pieces `items` are painted in, back to front (`bsp::paint_order`):
/// each item's plane is its box (or, without one, the whole canvas `whole`)
/// in the flat space of the padded canvas, moved into 3D by its placement and
/// seen through `projection`.
pub(super) fn preserve3d_pieces(items: &[DepthItem<'_>], projection: DMat4, whole: Rect) -> Vec<bsp::Piece> {
    let planes: Vec<bsp::Plane> = items
        .iter()
        .map(|item| {
            let parent = item.placement.parent;
            let to_world = if warp::invertible(parent) {
                warp::flat(parent) * item.placement.world * warp::flat(parent.inverse())
            } else {
                DMat4::ZERO
            };
            let flat = item.flat_parent * item.layer.transform.matrix();
            let corners = match item.extent {
                Some(b) => [
                    flat * Point::new(b.x0, b.y0),
                    flat * Point::new(b.x1, b.y0),
                    flat * Point::new(b.x1, b.y1),
                    flat * Point::new(b.x0, b.y1),
                ],
                None => [
                    Point::new(whole.x0, whole.y0),
                    Point::new(whole.x1, whole.y0),
                    Point::new(whole.x1, whole.y1),
                    Point::new(whole.x0, whole.y1),
                ],
            };
            bsp::Plane {
                to_world,
                corners: corners.map(|p| [p.x, p.y]),
            }
        })
        .collect();
    bsp::paint_order(&planes, eye_of(projection))
}

/// Where the camera `projection` looks from, in homogeneous coordinates: the
/// point it sends to `w = 0` at the origin (`(0, 0, 1, 0)`, from far along
/// +z, for no camera). The null vector of its x, y and w rows.
fn eye_of(projection: DMat4) -> DVec4 {
    let m = projection.transpose();
    let rows = [m.x_axis, m.y_axis, m.w_axis];
    let minor = |skip: usize| {
        let cols: Vec<usize> = (0..4).filter(|c| *c != skip).collect();
        let at = |r: usize, c: usize| rows[r][cols[c]];
        DMat3::from_cols(
            DVec3::new(at(0, 0), at(1, 0), at(2, 0)),
            DVec3::new(at(0, 1), at(1, 1), at(2, 1)),
            DVec3::new(at(0, 2), at(1, 2), at(2, 2)),
        )
        .determinant()
    };
    let e = DVec4::new(minor(0), -minor(1), minor(2), -minor(3));
    if e.w < 0.0 || (e.w == 0.0 && e.z < 0.0) {
        -e
    } else {
        e
    }
}

/// How many half stroke widths past the path a stroke finished as `style`
/// reaches: a miter join as far as its limit, a square cap a corner.
fn stroke_reach(style: &ShapeStyle) -> f64 {
    use crate::scene::{StrokeCap, StrokeJoin};
    let join = if style.join == StrokeJoin::Miter {
        style.miter_limit.max(1.0)
    } else {
        1.0
    };
    let cap = if style.cap == StrokeCap::Square {
        std::f64::consts::SQRT_2
    } else {
        1.0
    };
    join.max(cap)
}

/// The box of a shape in layer space: its geometry, and, if it has a stroke
/// of that width, half the width more all round (times `stroke_reach`), which
/// is as far as its joins and caps reach.
pub(super) fn shape_box(geometry: &ResolvedGeometry, stroke: Option<(f64, &ShapeStyle)>) -> Result<Rect> {
    let shape = match geometry {
        ResolvedGeometry::Rect { width, height }
        | ResolvedGeometry::RoundedRect { width, height, .. }
        | ResolvedGeometry::Ellipse { width, height } => Rect::new(0.0, 0.0, *width, *height),
        ResolvedGeometry::Path { .. } => geometry_path(geometry)?.bounding_box(),
    };
    let half = stroke.map_or(0.0, |(width, style)| {
        width.max(0.0) / 2.0 * stroke_reach(style)
    });
    Ok(shape.inflate(half, half))
}

/// The pixels that a box `local` in layer space reaches under `matrix`: its
/// corners through the matrix, rounded outwards, with a pixel more all round
/// for the anti-aliased edge. Anywhere (a huge box) if that is not a number.
pub(super) fn device_bounds(matrix: Affine, local: Rect) -> PixelRect {
    let anywhere = PixelRect::new(i32::MIN / 4, i32::MIN / 4, i32::MAX / 4, i32::MAX / 4);
    bounds::pixel_rect(bounds::transformed(matrix, local).inflate(1.0, 1.0)).unwrap_or(anywhere)
}

/// Where the glyphs of `laid_out` (text of font size `size`, wrapped at
/// `max_width`) can be drawn, in layout space: the layout box and every
/// glyph's origin and advance, grown by one font size on each side, which
/// holds the ink of any glyph that rises or falls less than that from its
/// baseline or overhangs its advance by less (descenders, accents, italic
/// slants). A word wider than `max_width` hangs out of the box, so the glyphs
/// count as well.
///
/// A character with its own style (`chars`) is moved, scaled and turned about
/// its centre: its glyphs' box, grown by the same font size, goes through the
/// character's matrix and is added.
pub(super) fn text_bounds(
    laid_out: &LaidOutText,
    size: f32,
    max_width: Option<f32>,
    chars: &[Option<ResolvedChar>],
) -> Rect {
    let width = max_width.unwrap_or(0.0).max(laid_out.width);
    let mut b = Rect::new(0.0, 0.0, f64::from(width), f64::from(laid_out.height));
    for glyph in laid_out.runs.iter().flat_map(|run| &run.glyphs) {
        b = b
            .union_pt((f64::from(glyph.x), f64::from(glyph.y)))
            .union_pt((f64::from(glyph.x + glyph.advance), f64::from(glyph.y)));
    }
    let em = f64::from(size).abs();
    let mut b = b.inflate(em, em);
    if let Some([l, t, r, bot]) = laid_out.ink_extent() {
        b = b.union(Rect::new(f64::from(l), f64::from(t), f64::from(r), f64::from(bot)));
    }
    if chars.iter().any(Option::is_some) {
        let centres = laid_out.char_centres();
        for glyph in laid_out.runs.iter().flat_map(|run| &run.glyphs) {
            let Some(style) = char_style(chars, glyph.char_index) else {
                continue;
            };
            let centre = centres.get(&glyph.char_index).copied().unwrap_or_default();
            let ink = Rect::new(
                f64::from(glyph.x),
                f64::from(glyph.y),
                f64::from(glyph.x + glyph.advance),
                f64::from(glyph.y),
            )
            .inflate(em, em);
            b = b.union(bounds::transformed(char_matrix(style, centre), ink));
        }
    }
    b
}

/// The style of the character at code point `index`, if it has one.
pub(crate) fn char_style(chars: &[Option<ResolvedChar>], index: u32) -> Option<&ResolvedChar> {
    chars.get(index as usize).and_then(Option::as_ref)
}

/// Where a styled character goes, in text-box space: moved by its offset,
/// then scaled and turned about its centre.
pub(crate) fn char_matrix(style: &ResolvedChar, centre: (f64, f64)) -> Affine {
    Affine::translate((style.x, style.y))
        * Affine::translate(centre)
        * Affine::rotate(style.rotation.to_radians())
        * Affine::scale(style.scale)
        * Affine::translate((-centre.0, -centre.1))
}

/// `parent` moved `shift` pixels right and down (`Renderer::source_shift`),
/// itself when there is none: the same bits for a layer that is not moved.
pub(super) fn shifted(shift: (f64, f64), parent: Affine) -> Affine {
    if shift == (0.0, 0.0) {
        parent
    } else {
        Affine::translate(shift) * parent
    }
}

/// What `flush_flat` draws, in order: a leaf, the start of a group's clip, or
/// the end of the innermost clip.
pub(super) enum FlatOp<'a> {
    /// A leaf, the matrix that takes its layer space to canvas pixels, and the pixels it can touch.
    Leaf(&'a ResolvedLayer, Affine, PixelRect),
    /// The clip's path, its matrix and whether it fills even-odd.
    Clip(BezPath, Affine, bool),
    Pop,
}

/// Whether `clip` keeps what the even-odd rule fills, rather than the non-zero rule.
pub(super) fn clip_even_odd(clip: &ResolvedClip) -> bool {
    matches!(
        clip,
        ResolvedClip::Polygon { fill_rule: FillRule::EvenOdd, .. }
            | ResolvedClip::Path { fill_rule: FillRule::EvenOdd, .. }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::tests::{card, resolve_layers};
    use crate::scene::TextAlign;

    /// The box of a rect shape or an empty group, which is all these tests
    /// use; the renderer's own `layer_box` needs a GPU for the rest.
    fn test_box(layer: &ResolvedLayer) -> Result<Option<Rect>> {
        Ok(match &layer.kind {
            ResolvedKind::Shape {
                geometry: ResolvedGeometry::Rect { width, height },
                ..
            } => Some(Rect::new(0.0, 0.0, *width, *height)),
            _ => None,
        })
    }
    /// The ids of what a preserve3d group at the top of `layers` draws, in
    /// painting order.
    fn painting_order(layers: &[ResolvedLayer]) -> (Vec<(String, f32)>, Vec<DepthItem<'_>>) {
        let ResolvedKind::Group { children, .. } = &layers[0].kind else {
            panic!("not a group");
        };
        let space = Space3d {
            parent: Affine::IDENTITY,
            flat: layers[0].transform.matrix(),
            world: warp::layer_world(&layers[0].transform).unwrap_or(DMat4::IDENTITY),
            opacity: layers[0].opacity,
        };
        let mut items = Vec::new();
        collect_preserve3d(children, space, &mut test_box, &mut items).unwrap();
        warp::sort_far_to_near(&mut items, |i| i.depth);
        let pieces = preserve3d_pieces(&items, DMat4::IDENTITY, Rect::new(0.0, 0.0, 400.0, 300.0));
        let order = pieces
            .iter()
            .map(|p| (items[p.item].layer.id.clone(), items[p.item].opacity))
            .collect();
        (order, items)
    }
    fn ids(order: &[(String, f32)]) -> Vec<&str> {
        order.iter().map(|(id, _)| id.as_str()).collect()
    }
    #[test]
    fn crossing_cards_are_painted_in_pieces() {
        // Two cards about the same middle, one turned a quarter about y: it
        // crosses the other, half behind and half in front.
        let layers = resolve_layers(&format!(
            r#"[{{"id": "g", "type": "group", "preserve3d": true,
                 "transform": {{"x": 200, "y": 150}}, "children": [{}, {}]}}]"#,
            card("flat", r#"{"anchorX": 10, "anchorY": 5}"#),
            card("turned", r#"{"anchorX": 10, "anchorY": 5, "rotateY": 90}"#),
        ));
        let (order, _) = painting_order(&layers);
        let order = ids(&order);
        assert_eq!(order.len(), 3, "{order:?}");
        assert_eq!(order.iter().filter(|id| **id == "turned").count(), 2);
        assert_eq!(order[1], "flat");
    }
    #[test]
    fn the_eye_is_where_the_camera_looks_from() {
        assert_eq!(eye_of(DMat4::IDENTITY), DVec4::new(0.0, 0.0, 1.0, 0.0));
        let camera = crate::resolve::ResolvedCamera {
            x: 100.0,
            y: 50.0,
            perspective: 800.0,
        };
        let e = eye_of(warp::projection(Some(&camera), 10));
        let e = e / e.w;
        assert!(
            e.abs_diff_eq(DVec4::new(110.0, 60.0, 800.0, 1.0), 1e-9),
            "{e:?}"
        );
    }
    #[test]
    fn a_preserve3d_group_paints_far_to_near_whatever_the_document_order() {
        let cards = [
            card("front", r#"{"z": 40}"#),
            card("back", r#"{"z": -50}"#),
            card("mid", r#"{"z": 0}"#),
        ]
        .join(",");
        let layers = resolve_layers(&format!(
            r#"[{{"id": "g", "type": "group", "preserve3d": true, "children": [{cards}]}}]"#
        ));
        let (order, _) = painting_order(&layers);
        assert_eq!(ids(&order), ["back", "mid", "front"]);
    }
    #[test]
    fn layers_at_the_same_depth_keep_document_order() {
        let cards = [
            card("a", r#"{"x": 100, "z": 10}"#),
            card("b", r#"{"x": 150, "z": -10}"#),
            card("c", r#"{"x": 200, "z": 10}"#),
            card("d", r#"{"x": 250, "z": 10}"#),
        ]
        .join(",");
        let layers = resolve_layers(&format!(
            r#"[{{"id": "g", "type": "group", "preserve3d": true, "children": [{cards}]}}]"#
        ));
        let (order, _) = painting_order(&layers);
        assert_eq!(ids(&order), ["b", "a", "c", "d"]);
    }
    #[test]
    fn turning_the_group_turns_the_depth_order() {
        // Three cards side by side at one depth. Turn the group a quarter
        // about the vertical axis and the one on the right is the farthest.
        let cards = [
            card("left", r#"{"x": -40}"#),
            card("middle", r#"{"x": 0}"#),
            card("right", r#"{"x": 40}"#),
        ]
        .join(",");
        let group = |turn: f64| {
            resolve_layers(&format!(
                r#"[{{"id": "g", "type": "group", "preserve3d": true,
                     "transform": {{"x": 200, "y": 150, "rotateY": {turn}}}, "children": [{cards}]}}]"#
            ))
        };
        let flat = group(0.0);
        assert_eq!(ids(&painting_order(&flat).0), ["left", "middle", "right"]);
        let turned = group(60.0);
        assert_eq!(ids(&painting_order(&turned).0), ["right", "middle", "left"]);
        let other_way = group(-60.0);
        assert_eq!(
            ids(&painting_order(&other_way).0),
            ["left", "middle", "right"]
        );
    }
    #[test]
    fn a_layers_depth_is_measured_at_the_middle_of_its_box() {
        // Both sit at the group's origin, but the wide one's middle is 100
        // px to the right, which a quarter turn sends far back.
        let cards = [
            r##"{"id": "wide", "type": "shape", "fill": "#fff",
                "shape": {"kind": "rect", "width": 200, "height": 10}}"##
                .to_string(),
            card("narrow", r#"{"x": 0}"#),
        ]
        .join(",");
        let layers = resolve_layers(&format!(
            r#"[{{"id": "g", "type": "group", "preserve3d": true,
                 "transform": {{"rotateY": 90}}, "children": [{cards}]}}]"#
        ));
        let (order, items) = painting_order(&layers);
        assert_eq!(ids(&order), ["wide", "narrow"]);
        // 100 px right of the pivot at a quarter turn is 100 px back; the
        // narrow one's middle is 10 px right, 10 px back.
        assert!((items[0].depth + 100.0).abs() < 1e-9);
        assert!((items[1].depth + 10.0).abs() < 1e-9);
    }
    #[test]
    fn a_groups_depth_is_measured_at_its_position() {
        // A plain group has no box: it sorts at its position. Rotating the
        // parent a quarter turn sends the one at x = 80 behind the one at 0.
        let layers = resolve_layers(
            r#"[{"id": "g", "type": "group", "preserve3d": true,
                 "transform": {"rotateY": 90}, "children": [
                   {"id": "right", "type": "group", "transform": {"x": 80}, "children": []},
                   {"id": "origin", "type": "group", "children": []}]}]"#,
        );
        let (order, items) = painting_order(&layers);
        assert_eq!(ids(&order), ["right", "origin"]);
        assert!((items[0].depth + 80.0).abs() < 1e-9);
    }
    #[test]
    fn nested_preserve3d_groups_sort_with_their_parents_children() {
        let inner = [
            card("in-near", r#"{"z": 30}"#),
            card("in-far", r#"{"z": -30}"#),
        ]
        .join(",");
        let layers = resolve_layers(&format!(
            r#"[{{"id": "g", "type": "group", "preserve3d": true, "children": [
                 {first},
                 {{"id": "nested", "type": "group", "preserve3d": true,
                   "transform": {{"z": 5}}, "children": [{inner}]}},
                 {last}]}}]"#,
            first = card("first", r#"{"z": 10}"#),
            last = card("last", r#"{"z": -50}"#),
        ));
        let (order, items) = painting_order(&layers);
        // The nested group's z of 5 is added to its children's.
        assert_eq!(ids(&order), ["last", "in-far", "first", "in-near"]);
        let depth = |id: &str| items.iter().find(|i| i.layer.id == id).unwrap().depth;
        assert!((depth("in-far") + 25.0).abs() < 1e-9);
        assert!((depth("in-near") - 35.0).abs() < 1e-9);
        // Siblings are the list the layer is in, for its matte source.
        let nested: Vec<_> = items
            .iter()
            .filter(|i| i.layer.id.starts_with("in-"))
            .collect();
        assert!(nested.iter().all(|i| i.siblings.len() == 2));
    }
    #[test]
    fn placements_compose_the_whole_chain_of_matrices() {
        // A preserve3d group inside another, each moved and turned in 3D
        // and in 2D, around a card with its own 3D transform: the card's
        // world matrix times its flat matrix is the product of the three
        // full matrices from the formula.
        let layers = resolve_layers(&format!(
            r#"[{{"id": "outer", "type": "group", "preserve3d": true,
                 "transform": {{"x": 90, "y": 60, "rotation": 12, "scale": 1.4, "rotateY": 35, "z": 20,
                               "anchorX": 5, "anchorY": 7}},
                 "children": [{{"id": "inner", "type": "group", "preserve3d": true,
                   "transform": {{"x": 30, "y": -10, "rotateX": -20, "rotation": -8, "scale": 0.8}},
                   "children": [{card}]}}]}}]"#,
            card = card(
                "leaf",
                r#"{"x": 12, "y": 9, "z": 15, "rotateY": 50, "rotateX": 10, "rotation": 25, "anchorX": 10, "anchorY": 5}"#
            ),
        ));
        let (_, items) = painting_order(&layers);
        assert_eq!(items.len(), 1);
        let item = &items[0];
        let ResolvedKind::Group { children, .. } = &layers[0].kind else {
            unreachable!()
        };
        let inner = &children[0];
        let ResolvedKind::Group { children, .. } = &inner.kind else {
            unreachable!()
        };
        let leaf = &children[0];
        let want = warp::full_matrix(&layers[0].transform)
            * warp::full_matrix(&inner.transform)
            * warp::full_matrix(&leaf.transform);
        let flat = item.flat_parent * leaf.transform.matrix();
        let got = item.placement.world * warp::flat(flat);
        assert!(got.abs_diff_eq(want, 1e-8), "{got:?} vs {want:?}");
        // The layer is rasterised under the groups' flat matrices alone.
        assert_eq!(
            item.flat_parent,
            layers[0].transform.matrix() * inner.transform.matrix()
        );
    }
    #[test]
    fn group_opacities_multiply_into_the_layers_and_hidden_ones_are_skipped() {
        let layers = resolve_layers(&format!(
            r##"[{{"id": "g", "type": "group", "preserve3d": true, "opacity": 0.5, "children": [
                 {a},
                 {{"id": "hidden", "type": "group", "preserve3d": true, "opacity": 0,
                   "children": [{b}]}},
                 {{"id": "faded", "type": "group", "preserve3d": true, "opacity": 0.5,
                   "children": [{c}]}},
                 {{"id": "cut", "type": "shape", "fill": "#fff", "matte": {{"layer": "source"}},
                   "shape": {{"kind": "rect", "width": 5, "height": 5}}}},
                 {{"id": "source", "type": "shape", "fill": "#fff",
                   "shape": {{"kind": "rect", "width": 5, "height": 5}}}}]}}]"##,
            a = card("a", "{}"),
            b = card("b-in-hidden", "{}"),
            c = card("c-in-faded", "{}"),
        ));
        let (order, _) = painting_order(&layers);
        // `source` is only drawn through `cut`; `hidden` and what is in it
        // are not drawn at all.
        assert_eq!(ids(&order), ["a", "c-in-faded", "cut"]);
        assert_eq!(order[0].1, 0.5);
        assert_eq!(order[1].1, 0.25);
        assert_eq!(order[2].1, 0.5);
    }
    #[test]
    fn a_group_scaled_to_nothing_draws_nothing() {
        let layers = resolve_layers(&format!(
            r#"[{{"id": "g", "type": "group", "preserve3d": true,
                 "transform": {{"scale": 0}}, "children": [{}]}}]"#,
            card("a", r#"{"z": 5}"#)
        ));
        assert!(painting_order(&layers).0.is_empty());
    }
    #[test]
    fn a_shape_reaches_half_its_strokes_width_past_its_geometry() {
        let rect = ResolvedGeometry::Rect {
            width: 40.0,
            height: 20.0,
        };
        assert_eq!(
            shape_box(&rect, None).unwrap(),
            Rect::new(0.0, 0.0, 40.0, 20.0)
        );
        let plain = ShapeStyle::default();
        assert_eq!(
            shape_box(&rect, Some((10.0, &plain))).unwrap(),
            Rect::new(-5.0, -5.0, 45.0, 25.0)
        );
        // A miter join reaches as far as its limit, a square cap a corner.
        let miter = ShapeStyle {
            join: crate::scene::StrokeJoin::Miter,
            miter_limit: 3.0,
            ..ShapeStyle::default()
        };
        assert_eq!(
            shape_box(&rect, Some((10.0, &miter))).unwrap(),
            Rect::new(-15.0, -15.0, 55.0, 35.0)
        );
        let square = ShapeStyle {
            cap: crate::scene::StrokeCap::Square,
            ..ShapeStyle::default()
        };
        let reach = 5.0 * std::f64::consts::SQRT_2;
        assert!((shape_box(&rect, Some((10.0, &square))).unwrap().x0 + reach).abs() < 1e-9);
        // A rounded corner or an ellipse stays in the box.
        let round = ResolvedGeometry::RoundedRect {
            width: 40.0,
            height: 20.0,
            radius: 8.0,
        };
        assert_eq!(
            shape_box(&round, None).unwrap(),
            shape_box(&rect, None).unwrap()
        );
        // A path is its curves' box, not its control points': the curve
        // from (0, 0) through a control at (50, 100) to (100, 0) peaks at 50.
        let curve = ResolvedGeometry::Path {
            d: "M 0 0 Q 50 100 100 0".into(),
        };
        let b = shape_box(&curve, None).unwrap();
        assert!(
            (b.y1 - 50.0).abs() < 1e-9 && b.x0 == 0.0 && b.x1 == 100.0,
            "{b:?}"
        );
        let bad = ResolvedGeometry::Path {
            d: "not a path".into(),
        };
        assert!(shape_box(&bad, None).is_err());
    }
    #[test]
    fn device_boxes_are_the_matrix_image_a_pixel_wider_and_rounded_out() {
        let local = Rect::new(0.0, 0.0, 10.0, 4.0);
        // Moved by a fraction: 10.3 - 1 = 9.3 rounds down to 9, 20.3 + 1 = 21.3 up to 22.
        let moved = Affine::translate((10.3, 5.0));
        assert_eq!(device_bounds(moved, local), PixelRect::new(9, 4, 22, 10));
        // Turned a quarter: the box is 4 wide and 10 tall.
        let turned = Affine::translate((50.0, 50.0)) * Affine::rotate(std::f64::consts::FRAC_PI_2);
        assert_eq!(device_bounds(turned, local), PixelRect::new(45, 49, 51, 61));
        // Not a number: anywhere.
        let nan = device_bounds(Affine::scale(f64::NAN), local);
        assert!(nan.x0 < -1_000_000 && nan.x1 > 1_000_000);
    }
    fn text_engine() -> TextEngine {
        let fonts = std::collections::BTreeMap::from([(
            "DM Sans".to_string(),
            "assets/fonts/DMSans-Medium.ttf".to_string(),
        )]);
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        TextEngine::new(&fonts, &root).unwrap()
    }
    #[test]
    fn text_is_bounded_by_its_layout_and_its_glyphs_a_font_size_wider() {
        let mut engine = text_engine();
        let laid_out = engine.layout("Hello world", "DM Sans", 40.0, None, None, TextAlign::Left);
        let b = text_bounds(&laid_out, 40.0, None, &[]);
        assert_eq!(b.x0, -40.0);
        assert_eq!(b.y0, -40.0);
        assert!((b.x1 - (f64::from(laid_out.width) + 40.0)).abs() < 1e-3);
        assert!((b.y1 - (f64::from(laid_out.height) + 40.0)).abs() < 1e-3);
        // Every glyph's origin and advance is inside.
        for glyph in laid_out.runs.iter().flat_map(|r| &r.glyphs) {
            assert!(f64::from(glyph.x) >= b.x0 && f64::from(glyph.x + glyph.advance) <= b.x1);
            assert!(f64::from(glyph.y) >= b.y0 && f64::from(glyph.y) <= b.y1);
        }
        // A word wider than the wrap width hangs out of the box, and the
        // bounds follow it.
        let wide = engine.layout(
            "Unbreakable",
            "DM Sans",
            40.0,
            None,
            Some(60.0),
            TextAlign::Left,
        );
        let b = text_bounds(&wide, 40.0, Some(60.0), &[]);
        assert!(
            f64::from(wide.width) > 60.0,
            "the word fits: {}",
            wide.width
        );
        assert!(b.x1 >= f64::from(wide.width) + 40.0 - 1e-3, "{b:?}");
        // A box wider than the text (a wrap width) counts as it is.
        let b = text_bounds(&laid_out, 40.0, Some(500.0), &[]);
        assert_eq!(b.x1, 540.0);
    }
    fn style(x: f64, y: f64, scale: f64, rotation: f64) -> ResolvedChar {
        ResolvedChar {
            x,
            y,
            scale,
            rotation,
            opacity: 1.0,
            color: None,
        }
    }
    #[test]
    fn a_character_turns_and_scales_about_its_centre_after_its_offset() {
        let centre = (30.0, 20.0);
        // Nothing set: the identity.
        assert_eq!(
            char_matrix(&style(0.0, 0.0, 1.0, 0.0), centre),
            Affine::IDENTITY
        );
        // Scale and turn leave the centre where it is.
        let m = char_matrix(&style(0.0, 0.0, 2.5, 70.0), centre);
        assert!((m * Point::new(30.0, 20.0)).distance(Point::new(30.0, 20.0)) < 1e-9);
        // 90 degrees clockwise (y down): the point to the right of the centre
        // goes below it, at twice the distance for a scale of 2.
        let m = char_matrix(&style(0.0, 0.0, 2.0, 90.0), centre);
        assert!((m * Point::new(40.0, 20.0)).distance(Point::new(30.0, 40.0)) < 1e-9);
        // The offset moves the centre.
        let m = char_matrix(&style(5.0, -7.0, 2.0, 90.0), centre);
        assert!((m * Point::new(30.0, 20.0)).distance(Point::new(35.0, 13.0)) < 1e-9);
    }
    #[test]
    fn styled_characters_widen_the_text_bounds_and_the_rest_do_not() {
        let mut engine = text_engine();
        let laid_out = engine.layout("Hello", "DM Sans", 40.0, None, None, TextAlign::Left);
        let plain = text_bounds(&laid_out, 40.0, None, &[]);
        // Only null entries: the same box.
        assert_eq!(
            text_bounds(&laid_out, 40.0, None, &[None, None, None]),
            plain
        );
        // Styled but not moved: inside it.
        let b = text_bounds(&laid_out, 40.0, None, &[Some(style(0.0, 0.0, 1.0, 0.0))]);
        assert_eq!(b, plain);
        // The last letter thrown 300 px down and made twice as big.
        let chars = [None, None, None, None, Some(style(0.0, 300.0, 2.0, 0.0))];
        let b = text_bounds(&laid_out, 40.0, None, &chars);
        assert!(b.y1 > plain.y1 + 250.0, "{b:?} vs {plain:?}");
        assert!(b.x1 > plain.x1, "{b:?} vs {plain:?}");
        assert_eq!((b.x0, b.y0), (plain.x0, plain.y0));
    }
}
