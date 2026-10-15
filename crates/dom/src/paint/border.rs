//! Borders and outlines: per-side widths, colours and styles, rounded corners.

use blitz_dom::Node;
use kurbo::{BezPath, Cap, Join, PathEl, Shape, Stroke, StrokeOpts};
use serde_json::{Value, json};
use style::properties::ComputedValues;
use style::values::specified::BorderStyle;

use super::Painter;
use super::geom::{BoxGeom, Radii, Rect, path_d, rounded_rect_path, rounded_rect_path_reversed};
use super::util::{Layer, current_color, hex_of, num, path_shape, resolve_color, rgba};

/// What a border side is painted as.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Nothing,
    Solid,
    Dashed,
    Dotted,
    Double,
    Groove,
    Ridge,
    Inset,
    Outset,
}

fn kind_of(s: BorderStyle) -> Kind {
    match s {
        BorderStyle::None | BorderStyle::Hidden => Kind::Nothing,
        BorderStyle::Solid => Kind::Solid,
        BorderStyle::Dashed => Kind::Dashed,
        BorderStyle::Dotted => Kind::Dotted,
        BorderStyle::Double => Kind::Double,
        BorderStyle::Groove => Kind::Groove,
        BorderStyle::Ridge => Kind::Ridge,
        BorderStyle::Inset => Kind::Inset,
        BorderStyle::Outset => Kind::Outset,
    }
}

type Rgba = [f32; 4];

/// The darker colour of `inset`, `outset`, `groove` and `ridge` borders (the
/// rule browsers use: scaled towards black by a third of the brightest
/// channel, with white a fixed grey). A colour already near black stays.
fn darker(c: Rgba) -> Rgba {
    let near_black = c[0] * c[0] + c[1] * c[1] + c[2] * c[2] < 3.0 * 0.125 * 0.125;
    if near_black {
        return c;
    }
    if c[0] >= 0.999 && c[1] >= 0.999 && c[2] >= 0.999 {
        return [0.671, 0.671, 0.671, c[3]];
    }
    let v = c[0].max(c[1]).max(c[2]);
    let m = ((v - 0.33) / v).max(0.0);
    [c[0] * m, c[1] * m, c[2] * m, c[3]]
}

/// The lighter colour: each channel scaled so the brightest gains a third
/// (black becomes a dark grey). A colour already near white stays.
fn lighter(c: Rgba) -> Rgba {
    let near_white =
        (1.0 - c[0]).powi(2) + (1.0 - c[1]).powi(2) + (1.0 - c[2]).powi(2) < 3.0 * 0.078 * 0.078;
    if near_white {
        return c;
    }
    let v = c[0].max(c[1]).max(c[2]);
    if v <= 0.0 {
        return [0.329, 0.329, 0.329, c[3]];
    }
    let m = (v + 0.33).min(1.0) / v;
    [
        (c[0] * m).min(1.0),
        (c[1] * m).min(1.0),
        (c[2] * m).min(1.0),
        c[3],
    ]
}

/// One side of a box: top, right, bottom, left.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Side {
    Top,
    Right,
    Bottom,
    Left,
}

const SIDES: [Side; 4] = [Side::Top, Side::Right, Side::Bottom, Side::Left];

impl Side {
    fn index(self) -> usize {
        self as usize
    }
}

/// A border (or outline) to paint: the outer edge, per-side widths, styles
/// and colours.
struct Ring {
    outer: Rect,
    radii: Radii,
    widths: [f64; 4],
    kinds: [Kind; 4],
    colors: [Rgba; 4],
}

impl Ring {
    fn inner(&self) -> (Rect, Radii) {
        let [t, r, b, l] = self.widths;
        (self.outer.inset(t, r, b, l), self.radii.inner(t, r, b, l))
    }
}

impl<'a> Painter<'a> {
    /// The element's `border`, in its own space.
    pub fn borders(
        &mut self,
        node: &'a Node,
        style: &ComputedValues,
        geom: &BoxGeom,
    ) -> Vec<Value> {
        if !geom.has_border() {
            return Vec::new();
        }
        let current = current_color(style);
        let b = style.get_border();
        let color = |c: &style::values::computed::Color| rgba(&resolve_color(c, &current));
        let ring = Ring {
            outer: geom.border_box(),
            radii: geom.radii,
            widths: geom.border,
            kinds: [
                kind_of(b.border_top_style),
                kind_of(b.border_right_style),
                kind_of(b.border_bottom_style),
                kind_of(b.border_left_style),
            ],
            colors: [
                color(&b.border_top_color),
                color(&b.border_right_color),
                color(&b.border_bottom_color),
                color(&b.border_left_color),
            ],
        };
        let id = self.layer_id(node, "border");
        // A border image replaces the painted border.
        if let Some(layers) = self.border_image(node, style, geom, &id) {
            return layers;
        }
        self.paint_ring(node, &id, &ring)
    }

    /// The element's `outline`, outside its border box, in the box's space.
    pub fn outline(&mut self, node: &'a Node, origin: super::Origin) -> Vec<Value> {
        let Some(style) = node.primary_styles() else {
            return Vec::new();
        };
        if !self.is_visible(node) {
            return Vec::new();
        }
        let o = style.get_outline();
        let width = f64::from(o.outline_width.0.to_f32_px());
        // `auto` is a browser-drawn focus ring; `none` draws nothing.
        let kind = match o.outline_style {
            style::values::computed::OutlineStyle::BorderStyle(s) => kind_of(s),
            style::values::computed::OutlineStyle::Auto => Kind::Solid,
        };
        if width <= 0.0 || kind == Kind::Nothing {
            return Vec::new();
        }
        let current = current_color(&style);
        let color = rgba(&resolve_color(&o.outline_color, &current));
        let geom = super::deco::box_geom(node, &style);
        let offset = f64::from(o.outline_offset.to_f32_px());
        let grow = offset + width;
        let outer = geom.border_box().inflate(grow);
        // The outline follows the border's rounding, grown by the same.
        let r = |c: (f64, f64)| {
            if c.0 > 0.0 && c.1 > 0.0 {
                (c.0 + grow, c.1 + grow)
            } else {
                (0.0, 0.0)
            }
        };
        let radii = Radii {
            tl: r(geom.radii.tl),
            tr: r(geom.radii.tr),
            br: r(geom.radii.br),
            bl: r(geom.radii.bl),
        };
        let ring = Ring {
            outer,
            radii,
            widths: [width; 4],
            kinds: [kind; 4],
            colors: [color; 4],
        };
        let id = self.layer_id(node, "outline");
        let mut layers = self.paint_ring(node, &id, &ring);
        for l in &mut layers {
            super::util::shift(l, origin.0, origin.1);
        }
        layers
    }

    fn paint_ring(&mut self, node: &'a Node, id: &str, ring: &Ring) -> Vec<Value> {
        // Sides with nothing to paint have no width.
        let mut ring_widths = ring.widths;
        for s in SIDES {
            if ring.kinds[s.index()] == Kind::Nothing || ring.colors[s.index()][3] <= 0.0 {
                // A transparent side still takes up its width: only its paint
                // is missing. Keep the width for the geometry.
                let _ = &mut ring_widths;
            }
        }
        let live: Vec<Side> = SIDES
            .into_iter()
            .filter(|s| {
                ring.widths[s.index()] > 0.0
                    && ring.kinds[s.index()] != Kind::Nothing
                    && ring.colors[s.index()][3] > 0.0
            })
            .collect();
        if live.is_empty() {
            return Vec::new();
        }
        let first = live[0].index();
        let same_paint = live.len() == 4
            && live.iter().all(|s| {
                ring.kinds[s.index()] == ring.kinds[first]
                    && ring.colors[s.index()] == ring.colors[first]
            });
        let uniform_width = ring
            .widths
            .iter()
            .all(|w| (*w - ring.widths[0]).abs() < 1e-9);

        // One paint on every side.
        if same_paint {
            match ring.kinds[first] {
                Kind::Solid => {
                    return vec![self.ring_fill(id, ring, ring.colors[first], None)];
                }
                Kind::Double => {
                    return self.double_ring(id, ring, ring.colors[first], None);
                }
                Kind::Dashed | Kind::Dotted if uniform_width => {
                    return self
                        .dashed_ring(id, ring, ring.kinds[first], ring.colors[first], None)
                        .into_iter()
                        .collect();
                }
                _ => {}
            }
        }

        // Otherwise each side on its own, cut by the lines from the box's
        // corners to the padding box's corners.
        let mut out = Vec::new();
        for s in live {
            let i = s.index();
            let clip = self.side_clip(ring, s);
            let kind = ring.kinds[i];
            let color = ring.colors[i];
            let sid = format!("{id}.{}", ["top", "right", "bottom", "left"][i]);
            let layers: Vec<Value> = match kind {
                Kind::Solid => vec![self.ring_fill(&sid, ring, color, Some(clip))],
                Kind::Double => self.double_ring(&sid, ring, color, Some(clip)),
                Kind::Dashed | Kind::Dotted => {
                    // The side's own width is the stroke.
                    let w = ring.widths[i];
                    let own = Ring {
                        outer: ring.outer,
                        radii: ring.radii,
                        widths: [w; 4],
                        kinds: [kind; 4],
                        colors: [color; 4],
                    };
                    self.dashed_ring(&sid, &own, kind, color, Some(clip))
                        .into_iter()
                        .collect()
                }
                Kind::Groove | Kind::Ridge => {
                    let (outer_c, inner_c) = relief_pair(kind, s, color);
                    self.relief_rings(&sid, ring, s, outer_c, inner_c, clip)
                }
                Kind::Inset | Kind::Outset => {
                    let c = relief_single(kind, s, color);
                    vec![self.ring_fill(&sid, ring, c, Some(clip))]
                }
                Kind::Nothing => Vec::new(),
            };
            out.extend(layers);
        }
        let _ = node;
        out
    }

    /// The filled ring between the outer edge and the inner edge, optionally
    /// cut to a side.
    fn ring_fill(&self, id: &str, ring: &Ring, color: Rgba, clip: Option<Value>) -> Value {
        let (inner, inner_radii) = ring.inner();
        let mut path = rounded_rect_path(ring.outer, ring.radii);
        if !inner.is_empty() {
            path.extend(
                rounded_rect_path_reversed(inner, inner_radii)
                    .elements()
                    .iter()
                    .copied(),
            );
        }
        self.finish(id, &path, ring.outer, color, clip)
    }

    /// A path shape of `path` (in the box's space) filled with `color`.
    fn finish(
        &self,
        id: &str,
        path: &BezPath,
        _bounds: Rect,
        color: Rgba,
        clip: Option<Value>,
    ) -> Value {
        let mut layer = path_shape(id, &path_d(path), Value::String(hex_of(color)));
        if let Some(c) = clip {
            layer = layer.set("clip", c);
        }
        layer.build()
    }

    /// The area of one side: the quadrilateral from the box's corners to the
    /// padding box's corners (a mitre at each corner).
    fn side_clip(&self, ring: &Ring, side: Side) -> Value {
        let o = ring.outer;
        let [t, r, b, l] = ring.widths;
        let (ix0, iy0, ix1, iy1) = (o.x + l, o.y + t, o.right() - r, o.bottom() - b);
        let pts: [(f64, f64); 4] = match side {
            Side::Top => [(o.x, o.y), (o.right(), o.y), (ix1, iy0), (ix0, iy0)],
            Side::Right => [
                (o.right(), o.y),
                (o.right(), o.bottom()),
                (ix1, iy1),
                (ix1, iy0),
            ],
            Side::Bottom => [
                (o.right(), o.bottom()),
                (o.x, o.bottom()),
                (ix0, iy1),
                (ix1, iy1),
            ],
            Side::Left => [(o.x, o.bottom()), (o.x, o.y), (ix0, iy0), (ix0, iy1)],
        };
        json!({ "kind": "polygon", "points": pts.iter().map(|p| json!([num(p.0), num(p.1)])).collect::<Vec<_>>() })
    }

    /// `double`: two rings of a third of the width, with a gap between.
    fn double_ring(&self, id: &str, ring: &Ring, color: Rgba, clip: Option<Value>) -> Vec<Value> {
        let band = |w: f64| {
            if w >= 3.0 {
                (w / 3.0).round().max(1.0)
            } else {
                0.0
            }
        };
        let b = ring.widths.map(band);
        if b.iter().all(|w| *w == 0.0) {
            // Thinner than 3px: a double border is drawn solid.
            return vec![self.ring_fill(id, ring, color, clip)];
        }
        let outer_band = Ring {
            outer: ring.outer,
            radii: ring.radii,
            widths: b,
            kinds: ring.kinds,
            colors: ring.colors,
        };
        // The inner band hugs the padding edge.
        let w = ring.widths;
        let skip = [w[0] - b[0], w[1] - b[1], w[2] - b[2], w[3] - b[3]];
        let o = ring.outer.inset(skip[0], skip[1], skip[2], skip[3]);
        let r = ring.radii.inner(skip[0], skip[1], skip[2], skip[3]);
        let inner_band = Ring {
            outer: o,
            radii: r,
            widths: b,
            kinds: ring.kinds,
            colors: ring.colors,
        };
        vec![
            self.ring_fill(&format!("{id}.a"), &outer_band, color, clip.clone()),
            self.ring_fill(&format!("{id}.b"), &inner_band, color, clip),
        ]
    }

    /// `groove` and `ridge` for one side: the outer half and the inner half.
    fn relief_rings(
        &self,
        id: &str,
        ring: &Ring,
        side: Side,
        outer_c: Rgba,
        inner_c: Rgba,
        clip: Value,
    ) -> Vec<Value> {
        let w = ring.widths;
        let half = w.map(|v| v / 2.0);
        let outer_half = Ring {
            outer: ring.outer,
            radii: ring.radii,
            widths: half,
            kinds: ring.kinds,
            colors: ring.colors,
        };
        let o = ring.outer.inset(half[0], half[1], half[2], half[3]);
        let r = ring.radii.inner(half[0], half[1], half[2], half[3]);
        let inner_half = Ring {
            outer: o,
            radii: r,
            widths: half,
            kinds: ring.kinds,
            colors: ring.colors,
        };
        let _ = side;
        vec![
            self.ring_fill(&format!("{id}.a"), &outer_half, outer_c, Some(clip.clone())),
            self.ring_fill(&format!("{id}.b"), &inner_half, inner_c, Some(clip)),
        ]
    }

    /// A dashed or dotted border: the centre line of the ring, dashed and
    /// stroked as wide as the border.
    fn dashed_ring(
        &self,
        id: &str,
        ring: &Ring,
        kind: Kind,
        color: Rgba,
        clip: Option<Value>,
    ) -> Option<Value> {
        let w = ring.widths[0];
        if w <= 0.0 {
            return None;
        }
        let rect = ring.outer.inset(w / 2.0, w / 2.0, w / 2.0, w / 2.0);
        let radii = ring.radii.inner(w / 2.0, w / 2.0, w / 2.0, w / 2.0);
        if rect.is_empty() {
            return None;
        }
        let center = rounded_rect_path(rect, radii);
        let length = center.perimeter(0.01);
        let (pattern, cap): (Vec<f64>, Cap) = if kind == Kind::Dotted {
            // Round dots as wide as the border, a dot width apart.
            let n = (length / (2.0 * w)).round().max(1.0);
            let step = length / n;
            (vec![0.001, (step - 0.001).max(0.001)], Cap::Round)
        } else {
            let (d, g) = if w >= 3.0 {
                (2.0 * w, w)
            } else {
                (3.0 * w, 2.0 * w)
            };
            let n = (length / (d + g)).round().max(1.0);
            let scale = length / (n * (d + g));
            (vec![d * scale, g * scale], Cap::Butt)
        };
        let dashed: BezPath =
            kurbo::dash(center.elements().iter().copied(), 0.0, &pattern).collect();
        let outline = kurbo::stroke(
            dashed.elements().iter().copied(),
            &Stroke::new(w).with_caps(cap).with_join(Join::Miter),
            &StrokeOpts::default(),
            0.05,
        );
        let _ = PathEl::ClosePath;
        Some(self.finish(id, &outline, ring.outer, color, clip))
    }
}

/// The two colours of a groove or ridge side: outer half, inner half.
fn relief_pair(kind: Kind, side: Side, c: Rgba) -> (Rgba, Rgba) {
    let top_left = matches!(side, Side::Top | Side::Left);
    let dark_outer = top_left == (kind == Kind::Groove);
    let base = lighter(c);
    if dark_outer {
        (darker(c), base)
    } else {
        (base, darker(c))
    }
}

/// The colour of an inset or outset side.
fn relief_single(kind: Kind, side: Side, c: Rgba) -> Rgba {
    let top_left = matches!(side, Side::Top | Side::Left);
    let dark = top_left == (kind == Kind::Inset);
    if dark { darker(c) } else { lighter(c) }
}

#[allow(dead_code)]
fn unused(_: Layer) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn darker_follows_the_browser_rule() {
        let c = darker([1.0, 0.0, 0.0, 1.0]);
        assert!((c[0] - 0.67).abs() < 0.01, "{c:?}");
        // #48c lightens to #5af.
        let l = lighter([
            0x44 as f32 / 255.0,
            0x88 as f32 / 255.0,
            0xcc as f32 / 255.0,
            1.0,
        ]);
        assert!(
            (l[0] * 255.0 - 85.0).abs() < 1.0 && (l[2] - 1.0).abs() < 1e-6,
            "{l:?}"
        );
        assert_eq!(darker([1.0, 1.0, 1.0, 1.0])[0], 0.671);
    }
}
