//! `border-image`: the nine-slice painting of a picture or a gradient in the
//! border area (CSS Backgrounds 3, section 6).

use blitz_dom::Node;
use serde_json::{Value, json};
use style::properties::ComputedValues;
use style::values::computed::{Image, NumberOrPercentage};
use style::values::generics::border::BorderImageSideWidth as Side;
use style::values::specified::border::BorderImageRepeatKeyword as Rep;

use super::Painter;
use super::geom::{BoxGeom, Rect};
use super::gradient::gradient_paint;
use super::images::Source;
use super::util::{current_color, lp, num4, rect_shape};

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
    pub fn border_image(
        &mut self,
        node: &'a Node,
        style: &ComputedValues,
        geom: &BoxGeom,
        id: &str,
    ) -> Option<Vec<Value>> {
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
                self.report(
                    node,
                    "border-image",
                    format!("{other:?}"),
                    "this kind of image is not drawn",
                );
                return None;
            }
        };

        // The border image area: the border box grown by `border-image-outset`.
        let [bt, br, bb, bl] = geom.border;
        let o = &b.border_image_outset;
        let out = [
            outset_side(&o.0, bt),
            outset_side(&o.1, br),
            outset_side(&o.2, bb),
            outset_side(&o.3, bl),
        ];
        let area = Rect::new(
            -out[3],
            -out[0],
            geom.w + out[1] + out[3],
            geom.h + out[0] + out[2],
        );
        let (iw, ih) = if matches!(src, Src::Gradient(_)) {
            (area.w, area.h)
        } else {
            (iw, ih)
        };
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
        let width = |side: &style::values::computed::BorderImageSideWidth,
                     bw: f64,
                     basis: f64,
                     slice_px: f64| match side {
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
                (
                    "tl",
                    Rect::new(0.0, 0.0, sleft, st),
                    Rect::new(x0, y0, wl, wt),
                    Rep::Stretch,
                    Rep::Stretch,
                ),
                (
                    "tr",
                    Rect::new(iw - sr, 0.0, sr, st),
                    Rect::new(x1 - wr, y0, wr, wt),
                    Rep::Stretch,
                    Rep::Stretch,
                ),
                (
                    "bl",
                    Rect::new(0.0, ih - sb, sleft, sb),
                    Rect::new(x0, y1 - wb, wl, wb),
                    Rep::Stretch,
                    Rep::Stretch,
                ),
                (
                    "br",
                    Rect::new(iw - sr, ih - sb, sr, sb),
                    Rect::new(x1 - wr, y1 - wb, wr, wb),
                    Rep::Stretch,
                    Rep::Stretch,
                ),
                (
                    "t",
                    Rect::new(sleft, 0.0, iw - sleft - sr, st),
                    Rect::new(x0 + wl, y0, x1 - x0 - wl - wr, wt),
                    rx,
                    Rep::Stretch,
                ),
                (
                    "b",
                    Rect::new(sleft, ih - sb, iw - sleft - sr, sb),
                    Rect::new(x0 + wl, y1 - wb, x1 - x0 - wl - wr, wb),
                    rx,
                    Rep::Stretch,
                ),
                (
                    "l",
                    Rect::new(0.0, st, sleft, ih - st - sb),
                    Rect::new(x0, y0 + wt, wl, y1 - y0 - wt - wb),
                    Rep::Stretch,
                    ry,
                ),
                (
                    "r",
                    Rect::new(iw - sr, st, sr, ih - st - sb),
                    Rect::new(x1 - wr, y0 + wt, wr, y1 - y0 - wt - wb),
                    Rep::Stretch,
                    ry,
                ),
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
            // The counts come first: a tiny tile must not allocate a huge
            // list, or loop for ever. Too many tiles stretch the edge.
            let planned = plan_axis(d.x, d.w, tw, rep_x)
                .zip(plan_axis(d.y, d.h, th, rep_y))
                .filter(|(x, y)| x.n.checked_mul(y.n).is_some_and(|n| n <= MAX_TILES));
            let (ax, ay) = match planned {
                Some(p) => p,
                None => {
                    self.report(
                        node,
                        "border-image-repeat",
                        "tiles",
                        "too many tiles to draw one by one; the edge is stretched",
                    );
                    (Axis::stretch(d.x, d.w), Axis::stretch(d.y, d.h))
                }
            };
            let (tw, th) = (ax.tile, ay.tile);
            let xs: Vec<f64> = (0..ax.n).map(|k| ax.first + k as f64 * ax.step).collect();
            let ys: Vec<f64> = (0..ay.n).map(|k| ay.first + k as f64 * ay.step).collect();
            let sx = tw / s.w;
            let sy = th / s.h;
            for (yi, &ty) in ys.iter().enumerate() {
                for (xi, &tx) in xs.iter().enumerate() {
                    let tile = Rect::new(tx, ty, tw, th);
                    let vis = tile.intersect(&d);
                    if vis.is_empty() {
                        continue;
                    }
                    let lid = if xs.len() * ys.len() == 1 {
                        format!("{id}.{name}")
                    } else {
                        format!("{id}.{name}{xi}-{yi}")
                    };
                    // Image coordinates to the shape's own: the slice's corner
                    // lands on the tile's.
                    let to_shape = [
                        sx,
                        0.0,
                        0.0,
                        sy,
                        tx - s.x * sx - vis.x,
                        ty - s.y * sy - vis.y,
                    ];
                    let fill = match &src {
                        Src::Picture(path) => json!({
                            "type": "image", "src": path,
                            "x": num4(to_shape[4]), "y": num4(to_shape[5]),
                            "width": num4(iw * sx), "height": num4(ih * sy),
                        }),
                        Src::Gradient(g) => {
                            match gradient_paint(g, Rect::new(0.0, 0.0, iw, ih), &current) {
                                Ok(mut fill) => {
                                    if let Some(o) = fill.as_object_mut() {
                                        let own = o
                                            .get("transform")
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
                                        o.insert(
                                            "transform".into(),
                                            json!(m.iter().map(|v| num4(*v)).collect::<Vec<_>>()),
                                        );
                                    }
                                    fill
                                }
                                Err(reason) => {
                                    self.report(node, "border-image", "gradient", &reason);
                                    return None;
                                }
                            }
                        }
                    };
                    layers.push(
                        rect_shape(&lid, vis.w, vis.h, 0.0, fill)
                            .at(vis.x, vis.y)
                            .build(),
                    );
                }
            }
        }
        Some(layers)
    }
}

/// The tiles of one edge, as a count and how to place them: tile `k` starts
/// at `first + k * step`.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Axis {
    tile: f64,
    first: f64,
    step: f64,
    n: usize,
}

impl Axis {
    /// One tile over the whole edge.
    fn stretch(start: f64, len: f64) -> Axis {
        Axis {
            tile: len,
            first: start,
            step: len,
            n: 1,
        }
    }
}

/// How an edge of length `len` starting at `start` is tiled with tiles `tile`
/// long (CSS Backgrounds 3, section 6.5), without making the tiles: `None`
/// when there would be more than `MAX_TILES` or the numbers are not finite
/// (a near-zero tile).
fn plan_axis(start: f64, len: f64, tile: f64, rep: Rep) -> Option<Axis> {
    if !(start.is_finite() && len.is_finite() && tile.is_finite()) {
        return None;
    }
    if rep == Rep::Stretch || tile <= 0.0 || len <= 0.0 {
        return Some(Axis::stretch(start, len));
    }
    let count = |n: f64| (n.is_finite() && n <= MAX_TILES as f64).then_some(n);
    match rep {
        Rep::Stretch => unreachable!("handled above"),
        Rep::Repeat => {
            let n = count((len / tile).ceil().max(1.0))?;
            // The tiles are centred, so the cut-off is shared by both ends.
            Some(Axis {
                tile,
                first: start + (len - n * tile) / 2.0,
                step: tile,
                n: n as usize,
            })
        }
        Rep::Round => {
            let n = count((len / tile).round().max(1.0))?;
            let t = len / n;
            Some(Axis {
                tile: t,
                first: start,
                step: t,
                n: n as usize,
            })
        }
        Rep::Space => {
            let n = (len / tile).floor();
            if n < 1.0 {
                return Some(Axis {
                    tile,
                    first: start,
                    step: tile,
                    n: 0,
                });
            }
            let n = count(n)?;
            let gap = (len - n * tile) / (n + 1.0);
            Some(Axis {
                tile,
                first: start + gap,
                step: tile + gap,
                n: n as usize,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edges_tile_as_css_says() {
        let r = plan_axis(0.0, 100.0, 30.0, Rep::Round).unwrap();
        assert!((r.tile - 100.0 / 3.0).abs() < 1e-9 && r.n == 3);
        let s = plan_axis(0.0, 100.0, 30.0, Rep::Space).unwrap();
        assert_eq!(s.n, 3);
        assert!((s.first - 2.5).abs() < 1e-9, "{s:?}");
        let p = plan_axis(0.0, 100.0, 30.0, Rep::Repeat).unwrap();
        assert_eq!(p.n, 4);
        assert!((p.first + 10.0).abs() < 1e-9, "{p:?}");
    }

    #[test]
    fn a_tiny_tile_is_refused_before_anything_is_allocated() {
        for rep in [Rep::Repeat, Rep::Round, Rep::Space] {
            assert_eq!(plan_axis(0.0, 1000.0, 0.0001, rep), None, "{rep:?}");
            assert_eq!(plan_axis(0.0, 1000.0, f64::MIN_POSITIVE, rep), None);
            assert_eq!(plan_axis(0.0, f64::INFINITY, 1.0, rep), None);
            assert_eq!(plan_axis(0.0, 1000.0, f64::NAN, rep), None);
        }
        // Stretch never tiles, whatever the tile.
        assert_eq!(plan_axis(0.0, 50.0, 0.0001, Rep::Stretch).unwrap().n, 1);
    }

    #[test]
    fn affines_compose_right_to_left() {
        let scale = [2.0, 0.0, 0.0, 2.0, 0.0, 0.0];
        let shift = [1.0, 0.0, 0.0, 1.0, 5.0, 0.0];
        // shift applies first, then scale.
        assert_eq!(mul6(scale, shift)[4], 10.0);
    }
}
