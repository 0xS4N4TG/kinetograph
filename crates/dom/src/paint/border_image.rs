//! `border-image`: the nine-slice painting of a picture or a gradient in the
//! border area (CSS Backgrounds 3, section 6).

use blitz_dom::Node;
use serde_json::{Value, json};
use style::properties::ComputedValues;
use style::values::computed::{Image, NumberOrPercentage};
use style::values::generics::border::BorderImageSideWidth as Side;
use style::values::specified::border::BorderImageRepeatKeyword as Rep;

use super::geom::{BoxGeom, Rect};
use super::gradient::gradient_paint;
use super::images::Source;
use super::util::{current_color, lp, num4, rect_shape};
use super::Painter;

/// The most tiles an edge is cut into.
const MAX_TILES: usize = 200;

fn outset_side(
    v: &style::values::generics::length::GenericLengthOrNumber<
        style::values::generics::NonNegative<style::values::computed::Length>,
        style::values::generics::NonNegative<f32>,
    >,
    bw: f64,
) -> f64 {
    use style::values::generics::length::GenericLengthOrNumber as LoN;
    match v {
        LoN::Length(l) => f64::from(l.0.px()),
        LoN::Number(n) => f64::from(n.0) * bw,
    }
}

/// `a * b` for `[a, b, c, d, e, f]` affines (`b` applies first).
fn mul6(a: [f64; 6], b: [f64; 6]) -> [f64; 6] {
    [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ]
}

enum Src {
    Gradient(Box<style::values::computed::image::Gradient>),
    Picture(String),
}

impl<'a> Painter<'a> {
    /// The layers of a `border-image`, in the box's space; `None` when the
    /// element has none or its source cannot be drawn (the normal border is
    /// then painted, as CSS says for an image that fails).
    pub fn border_image(&mut self, node: &'a Node, style: &ComputedValues, geom: &BoxGeom, id: &str) -> Option<Vec<Value>> {
        let b = style.get_border();
        let current = current_color(style);
        // The source and the size it is a picture of.
        let (src, iw, ih) = match &b.border_image_source {
            Image::None => return None,
            Image::Gradient(g) => {
                // A gradient is an image as big as the border image area.
                (Src::Gradient(g.clone()), 0.0, 0.0)
            }
            Image::Url(u) => match self.source_of_url(u) {
                Source::Raster { path, w, h } => (Src::Picture(path), w, h),
                Source::Unsupported(reason) => {
                    self.report(node, "border-image", "url()", &reason);
                    return None;
                }
            },
            other => {
                self.report(node, "border-image", format!("{other:?}"), "this kind of image is not drawn");
                return None;
            }
        };

        // The border image area: the border box grown by `border-image-outset`.
        let [bt, br, bb, bl] = geom.border;
        let o = &b.border_image_outset;
        let out = [outset_side(&o.0, bt), outset_side(&o.1, br), outset_side(&o.2, bb), outset_side(&o.3, bl)];
        let area = Rect::new(-out[3], -out[0], geom.w + out[1] + out[3], geom.h + out[0] + out[2]);
        let (iw, ih) = if matches!(src, Src::Gradient(_)) { (area.w, area.h) } else { (iw, ih) };
        if !(iw > 0.0 && ih > 0.0) {
            return None;
        }

        // Slices, in image pixels.
        let sl = &b.border_image_slice;
        let slice = |v: &NumberOrPercentage, basis: f64| match v {
            NumberOrPercentage::Number(n) => f64::from(*n),
            NumberOrPercentage::Percentage(p) => f64::from(p.0) * basis,
        };
        let (st, sr, sb, sleft) = (
            slice(&sl.offsets.0.0, ih).min(ih),
            slice(&sl.offsets.1.0, iw).min(iw),
            slice(&sl.offsets.2.0, ih).min(ih),
            slice(&sl.offsets.3.0, iw).min(iw),
        );

        // Widths of the border image's edges.
        let w = &b.border_image_width;
        let width = |side: &style::values::computed::BorderImageSideWidth, bw: f64, basis: f64, slice_px: f64| match side {
            Side::Number(n) => f64::from(n.0) * bw,
            Side::LengthPercentage(l) => lp(&l.0, basis),
            Side::Auto => slice_px,
        };
        let (wt, wr, wb, wl) = (
            width(&w.0, bt, area.h, st),
            width(&w.1, br, area.w, sr),
            width(&w.2, bb, area.h, sb),
            width(&w.3, bl, area.w, sleft),
        );
        // Widths that do not fit scale down together.
        let mut f: f64 = 1.0;
        if wl + wr > area.w && wl + wr > 0.0 {
            f = f.min(area.w / (wl + wr));
        }
        if wt + wb > area.h && wt + wb > 0.0 {
            f = f.min(area.h / (wt + wb));
        }
        let (wt, wr, wb, wl) = (wt * f, wr * f, wb * f, wl * f);

        let repeat = b.border_image_repeat;
        let (rx, ry) = (repeat.0, repeat.1);

        // The nine regions: (source rect, destination rect, repeat x, repeat y).
        let (x0, y0, x1, y1) = (area.x, area.y, area.right(), area.bottom());
        let regions: Vec<(&str, Rect, Rect, Rep, Rep)> = {
            let mut v = vec![
                ("tl", Rect::new(0.0, 0.0, sleft, st), Rect::new(x0, y0, wl, wt), Rep::Stretch, Rep::Stretch),
                ("tr", Rect::new(iw - sr, 0.0, sr, st), Rect::new(x1 - wr, y0, wr, wt), Rep::Stretch, Rep::Stretch),
                ("bl", Rect::new(0.0, ih - sb, sleft, sb), Rect::new(x0, y1 - wb, wl, wb), Rep::Stretch, Rep::Stretch),
                ("br", Rect::new(iw - sr, ih - sb, sr, sb), Rect::new(x1 - wr, y1 - wb, wr, wb), Rep::Stretch, Rep::Stretch),
                ("t", Rect::new(sleft, 0.0, iw - sleft - sr, st), Rect::new(x0 + wl, y0, x1 - x0 - wl - wr, wt), rx, Rep::Stretch),
                ("b", Rect::new(sleft, ih - sb, iw - sleft - sr, sb), Rect::new(x0 + wl, y1 - wb, x1 - x0 - wl - wr, wb), rx, Rep::Stretch),
                ("l", Rect::new(0.0, st, sleft, ih - st - sb), Rect::new(x0, y0 + wt, wl, y1 - y0 - wt - wb), Rep::Stretch, ry),
                ("r", Rect::new(iw - sr, st, sr, ih - st - sb), Rect::new(x1 - wr, y0 + wt, wr, y1 - y0 - wt - wb), Rep::Stretch, ry),
            ];
            if sl.fill {
                v.push((
                    "c",
                    Rect::new(sleft, st, iw - sleft - sr, ih - st - sb),
                    Rect::new(x0 + wl, y0 + wt, x1 - x0 - wl - wr, y1 - y0 - wt - wb),
                    rx,
                    ry,
                ));
            }
            v
        };

        let mut layers = Vec::new();
        for (name, s, d, rep_x, rep_y) in regions {
            if s.is_empty() || d.is_empty() {
                continue;
            }
            // Scale of the slice into its destination; an edge keeps the
            // slice's aspect along its own direction when it repeats.
            let mut sx = d.w / s.w;
            let mut sy = d.h / s.h;
            if rep_x != Rep::Stretch && rep_y == Rep::Stretch {
                sx = sy;
            }
            if rep_y != Rep::Stretch && rep_x == Rep::Stretch {
                sy = sx;
            }
            if rep_x != Rep::Stretch && rep_y != Rep::Stretch {
                // The centre: keeps the ratio of its slice, scaled by the
                // larger factor... as the corners do not constrain it, use
                // the border width ratio of the nearest edges.
                sy = sx;
            }
            let (tw, th) = (s.w * sx, s.h * sy);
            let xs = tile_starts(d.x, d.w, tw, rep_x);
            let ys = tile_starts(d.y, d.h, th, rep_y);
            let (tw, xs) = xs;
            let (th, ys) = ys;
            let sx = tw / s.w;
            let sy = th / s.h;
            if xs.len() * ys.len() > MAX_TILES {
                self.report(node, "border-image-repeat", "tiles", "too many tiles to draw one by one");
                return None;
            }
            for (yi, &ty) in ys.iter().enumerate() {
                for (xi, &tx) in xs.iter().enumerate() {
                    let tile = Rect::new(tx, ty, tw, th);
                    let vis = tile.intersect(&d);
                    if vis.is_empty() {
                        continue;
                    }
                    let lid = if xs.len() * ys.len() == 1 { format!("{id}.{name}") } else { format!("{id}.{name}{xi}-{yi}") };
                    // Image coordinates to the shape's own: the slice's corner
                    // lands on the tile's.
                    let to_shape = [sx, 0.0, 0.0, sy, tx - s.x * sx - vis.x, ty - s.y * sy - vis.y];
                    let fill = match &src {
                        Src::Picture(path) => json!({
                            "type": "image", "src": path,
                            "x": num4(to_shape[4]), "y": num4(to_shape[5]),
                            "width": num4(iw * sx), "height": num4(ih * sy),
                        }),
                        Src::Gradient(g) => match gradient_paint(g, Rect::new(0.0, 0.0, iw, ih), &current) {
                            Ok(mut fill) => {
                                if let Some(o) = fill.as_object_mut() {
                                    let own = o
                                        .get("matrix")
                                        .and_then(|m| m.as_array())
                                        .map(|m| {
                                            let mut a = [0.0; 6];
                                            for (i, v) in m.iter().enumerate().take(6) {
                                                a[i] = v.as_f64().unwrap_or(0.0);
                                            }
                                            a
                                        })
                                        .unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
                                    let m = mul6(to_shape, own);
                                    o.insert("matrix".into(), json!(m.iter().map(|v| num4(*v)).collect::<Vec<_>>()));
                                }
                                fill
                            }
                            Err(reason) => {
                                self.report(node, "border-image", "gradient", &reason);
                                return None;
                            }
                        },
                    };
                    layers.push(rect_shape(&lid, vis.w, vis.h, 0.0, fill).at(vis.x, vis.y).build());
                }
            }
        }
        Some(layers)
    }
}

/// Where the tiles of one edge start, and the tile length: `stretch` is one
/// tile over the whole edge; the others tile it with `tile`-long tiles
/// (CSS Backgrounds 3, section 6.5).
fn tile_starts(start: f64, len: f64, tile: f64, rep: Rep) -> (f64, Vec<f64>) {
    match rep {
        Rep::Stretch => (len, vec![start]),
        _ if !(tile > 0.0) => (len, vec![start]),
        Rep::Repeat => {
            let n = (len / tile).ceil().max(1.0);
            // The tiles are centred, so the cut-off is shared by both ends.
            let first = start + (len - n * tile) / 2.0;
            (tile, (0..n as usize).map(|k| first + k as f64 * tile).collect())
        }
        Rep::Round => {
            let n = (len / tile).round().max(1.0);
            let t = len / n;
            (t, (0..n as usize).map(|k| start + k as f64 * t).collect())
        }
        Rep::Space => {
            let n = (len / tile).floor();
            if n < 1.0 {
                return (tile, Vec::new());
            }
            let gap = (len - n * tile) / (n + 1.0);
            (tile, (0..n as usize).map(|k| start + gap + k as f64 * (tile + gap)).collect())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edges_tile_as_css_says() {
        let (t, v) = tile_starts(0.0, 100.0, 30.0, Rep::Round);
        assert!((t - 100.0 / 3.0).abs() < 1e-9 && v.len() == 3);
        let (_, v) = tile_starts(0.0, 100.0, 30.0, Rep::Space);
        assert_eq!(v.len(), 3);
        assert!((v[0] - 2.5).abs() < 1e-9, "{v:?}");
        let (_, v) = tile_starts(0.0, 100.0, 30.0, Rep::Repeat);
        assert_eq!(v.len(), 4);
        assert!((v[0] + 10.0).abs() < 1e-9, "{v:?}");
    }

    #[test]
    fn affines_compose_right_to_left() {
        let scale = [2.0, 0.0, 0.0, 2.0, 0.0, 0.0];
        let shift = [1.0, 0.0, 0.0, 1.0, 5.0, 0.0];
        // shift applies first, then scale.
        assert_eq!(mul6(scale, shift)[4], 10.0);
    }
}
