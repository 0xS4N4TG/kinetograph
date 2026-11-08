//! CSS gradients (`linear-gradient()` and friends) as scene gradients.

use serde_json::{Value, json};
use style::color::mix::{ColorInterpolationMethod, ColorMixItem, mix_many};
use style::color::{AbsoluteColor, ColorSpace};
use style::values::computed::AngleOrPercentage;
use style::values::computed::image::{EndingShape, Gradient, LineDirection};
use style::values::generics::image::{
    Circle, Ellipse, GenericGradientItem as Item, GradientFlags, ShapeExtent,
};
use style::values::specified::position::{HorizontalPositionKeyword, VerticalPositionKeyword};

use super::geom::Rect;
use super::util::{hex_of, lp, num4, resolve_color, rgba};

/// A stop with its position resolved to a distance along the gradient line
/// (or a turn fraction for conic gradients).
#[derive(Clone, Copy, Debug)]
struct Stop {
    pos: f64,
    color: [f32; 4],
    /// The colour as written, in its own space, for interpolating elsewhere.
    abs: AbsoluteColor,
}

/// How many pieces each span between two stops is cut into when the colours
/// interpolate outside sRGB. The scene blends the pieces' ends in sRGB, so the
/// error is the bend of the curve over one piece (see the ΔE test).
const SPACE_STEPS: usize = 32;

/// The colour `w` of the way from `a` to `b` in the gradient's space, as sRGB
/// plus the colour in that space. CSS Color 4 §12: premultiplied, a missing or
/// powerless component taken from the other side, hues by the method.
fn mix_in(
    m: ColorInterpolationMethod,
    a: AbsoluteColor,
    b: AbsoluteColor,
    w: f64,
) -> (AbsoluteColor, [f32; 4]) {
    let w = w as f32;
    let c = mix_many(
        m,
        [ColorMixItem::new(a, 1.0 - w), ColorMixItem::new(b, w)],
        Default::default(),
    );
    (c, rgba(&c))
}


/// The colour interpolation method of a gradient.
fn method_of(g: &Gradient) -> ColorInterpolationMethod {
    match g {
        Gradient::Linear {
            color_interpolation_method: m,
            ..
        }
        | Gradient::Radial {
            color_interpolation_method: m,
            ..
        }
        | Gradient::Conic {
            color_interpolation_method: m,
            ..
        } => *m,
    }
}

/// Fixes up color stop positions as CSS Images 3 §3.4.3 says: the first stop
/// defaults to 0 and the last to the full length, no position goes back, and
/// stops without a position are spread evenly between their neighbours.
/// `positions[i]` is `None` for an unplaced stop.
fn fix_positions(positions: &mut [Option<f64>], full: f64) {
    let n = positions.len();
    if n == 0 {
        return;
    }
    if positions[0].is_none() {
        positions[0] = Some(0.0);
    }
    if positions[n - 1].is_none() {
        positions[n - 1] = Some(full);
    }
    let mut highest = positions[0].unwrap();
    for v in positions.iter_mut().flatten() {
        if *v < highest {
            *v = highest;
        }
        highest = *v;
    }
    let mut i = 0;
    while i < n {
        if positions[i].is_some() {
            i += 1;
            continue;
        }
        let from = positions[i - 1].unwrap();
        let mut j = i;
        while positions[j].is_none() {
            j += 1;
        }
        let to = positions[j].unwrap();
        for (off, slot) in positions[i..j].iter_mut().enumerate() {
            *slot = Some(from + (to - from) * (off + 1) as f64 / (j - i + 1) as f64);
        }
        i = j;
    }
}

/// Adds stops that follow an interpolation hint's curve: the colour halfway
/// between two stops is at the hint, and elsewhere the weight is
/// `t ^ (ln 0.5 / ln h)` (CSS Images 4).
fn with_hints(items: Vec<Entry>, full: f64, m: ColorInterpolationMethod) -> Vec<Stop> {
    let srgb = m.space == ColorSpace::Srgb;
    // Resolve positions first, hints included, so a hint is placed too.
    let mut positions: Vec<Option<f64>> = items.iter().map(|e| e.pos).collect();
    // A hint takes its position as given; a hint with none is not valid.
    fix_positions(&mut positions, full);
    let mut out: Vec<Stop> = Vec::new();
    for (i, e) in items.iter().enumerate() {
        let pos = positions[i].unwrap_or(0.0);
        match e.kind {
            EntryKind::Stop(color, abs) => out.push(Stop { pos, color, abs }),
            EntryKind::Hint => {
                let (Some(prev), Some(next)) =
                    (out.last().copied(), next_stop(&items, &positions, i))
                else {
                    continue;
                };
                let span = next.pos - prev.pos;
                if span <= 0.0 {
                    continue;
                }
                let h = ((pos - prev.pos) / span).clamp(0.001, 0.999);
                let exponent = 0.5_f64.ln() / h.ln();
                let steps = if srgb { 8 } else { SPACE_STEPS };
                for k in 1..steps {
                    let t = k as f64 / steps as f64;
                    let w = t.powf(exponent);
                    let pos = prev.pos + span * t;
                    if !srgb {
                        let (abs, color) = mix_in(m, prev.abs, next.abs, w);
                        out.push(Stop { pos, color, abs });
                        continue;
                    }
                    let mut c = [0.0_f32; 4];
                    // Premultiplied interpolation.
                    let (pa, na) = (f64::from(prev.color[3]), f64::from(next.color[3]));
                    let a = pa + (na - pa) * w;
                    for (ch, slot) in c.iter_mut().enumerate().take(3) {
                        let pm = f64::from(prev.color[ch]) * pa;
                        let nm = f64::from(next.color[ch]) * na;
                        let mm = pm + (nm - pm) * w;
                        *slot = if a > 0.0 { (mm / a) as f32 } else { 0.0 };
                    }
                    c[3] = a as f32;
                    out.push(Stop {
                        pos,
                        color: c,
                        abs: prev.abs,
                    });
                }
            }
        }
    }
    if !srgb {
        out = subdivide(&out, m);
    }
    out
}

fn next_stop(items: &[Entry], positions: &[Option<f64>], from: usize) -> Option<Stop> {
    for i in from + 1..items.len() {
        if let EntryKind::Stop(color, abs) = items[i].kind {
            return Some(Stop {
                pos: positions[i].unwrap_or(0.0),
                color,
                abs,
            });
        }
    }
    None
}

#[derive(Clone, Copy)]
enum EntryKind {
    Stop([f32; 4], AbsoluteColor),
    Hint,
}

#[derive(Clone, Copy)]
struct Entry {
    kind: EntryKind,
    pos: Option<f64>,
}

/// Cuts every span between two stops into `SPACE_STEPS` pieces coloured by
/// interpolating in the gradient's space. A span with no length (a hard edge)
/// is kept as is.
fn subdivide(stops: &[Stop], m: ColorInterpolationMethod) -> Vec<Stop> {
    let mut out = Vec::with_capacity(stops.len() * SPACE_STEPS);
    for (i, a) in stops.iter().enumerate() {
        out.push(*a);
        let Some(b) = stops.get(i + 1) else { break };
        if b.pos - a.pos < 1e-9 {
            continue;
        }
        for k in 1..SPACE_STEPS {
            let t = k as f64 / SPACE_STEPS as f64;
            let (abs, color) = mix_in(m, a.abs, b.abs, t);
            out.push(Stop {
                pos: a.pos + (b.pos - a.pos) * t,
                color,
                abs,
            });
        }
    }
    out
}

fn stops_json(stops: &[Stop], lo: f64, hi: f64) -> Value {
    let span = hi - lo;
    Value::Array(
        stops
            .iter()
            .map(|s| {
                let offset = if span > 0.0 {
                    ((s.pos - lo) / span).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                json!({ "offset": num4(offset), "color": hex_of(s.color) })
            })
            .collect(),
    )
}

/// Which colour a gradient with no extent shows: its last stop's.
fn solid(stops: &[Stop]) -> Value {
    let c = stops.last().map_or([0.0; 4], |s| s.color);
    Value::String(hex_of(c))
}

/// The result of converting a gradient: a scene paint (`fill`) in the
/// coordinates of the box `tile`, which is the gradient's image.
pub fn gradient_paint(g: &Gradient, tile: Rect, current: &AbsoluteColor) -> Result<Value, String> {
    let method = method_of(g);
    match g {
        Gradient::Linear {
            direction,
            items,
            flags,
            ..
        } => {
            let (dx, dy, len) = match *direction {
                LineDirection::Angle(a) => {
                    let r = f64::from(a.degrees()).to_radians();
                    let (dx, dy) = (r.sin(), -r.cos());
                    (dx, dy, (tile.w * dx).abs() + (tile.h * dy).abs())
                }
                LineDirection::Horizontal(h) => {
                    let dx = if h == HorizontalPositionKeyword::Right {
                        1.0
                    } else {
                        -1.0
                    };
                    (dx, 0.0, tile.w)
                }
                LineDirection::Vertical(v) => {
                    let dy = if v == VerticalPositionKeyword::Bottom {
                        1.0
                    } else {
                        -1.0
                    };
                    (0.0, dy, tile.h)
                }
                LineDirection::Corner(h, v) => {
                    let sx = if h == HorizontalPositionKeyword::Right {
                        1.0
                    } else {
                        -1.0
                    };
                    let sy = if v == VerticalPositionKeyword::Bottom {
                        1.0
                    } else {
                        -1.0
                    };
                    let norm = tile.w.hypot(tile.h);
                    let (dx, dy) = if norm > 0.0 {
                        (sx * tile.h / norm, sy * tile.w / norm)
                    } else {
                        (0.0, 1.0)
                    };
                    (dx, dy, (tile.w * dx).abs() + (tile.h * dy).abs())
                }
            };
            let entries = items
                .iter()
                .map(|item| entry(item, current, |p| lp(p, len)))
                .collect::<Vec<_>>();
            let stops = with_hints(entries, len, method);
            if stops.is_empty() {
                return Err("a gradient with no colour stops".into());
            }
            let (mut lo, mut hi) = (stops[0].pos, stops[stops.len() - 1].pos);
            let repeating = flags.contains(GradientFlags::REPEATING);
            if len <= 0.0 || (repeating && hi - lo < 1e-6) {
                return Ok(solid(&stops));
            }
            // Every stop at one position is a hard edge there (the first
            // colour before it, the last after), not a solid fill.
            if hi - lo < 1e-6 {
                (lo, hi) = (0.0, len);
            }
            let (cx, cy) = (tile.x + tile.w / 2.0, tile.y + tile.h / 2.0);
            let start = (cx - dx * len / 2.0, cy - dy * len / 2.0);
            let mut g = json!({
                "type": "linear",
                "x0": num4(start.0 + dx * lo), "y0": num4(start.1 + dy * lo),
                "x1": num4(start.0 + dx * hi), "y1": num4(start.1 + dy * hi),
                "stops": stops_json(&stops, lo, hi),
            });
            if repeating {
                g["extend"] = json!("repeat");
            }
            Ok(g)
        }
        Gradient::Radial {
            shape,
            position,
            items,
            flags,
            ..
        } => {
            let cx = tile.x + lp(&position.horizontal, tile.w);
            let cy = tile.y + lp(&position.vertical, tile.h);
            let (rx, ry) = radial_radii(shape, tile, cx, cy)?;
            let entries = items
                .iter()
                .map(|item| entry(item, current, |p| lp(p, rx)))
                .collect::<Vec<_>>();
            let stops = with_hints(entries, rx, method);
            if stops.is_empty() {
                return Err("a gradient with no colour stops".into());
            }
            let repeating = flags.contains(GradientFlags::REPEATING);
            let (lo, hi) = (stops[0].pos.max(0.0), stops[stops.len() - 1].pos);
            if rx <= 0.0 || ry <= 0.0 || (repeating && hi - lo < 1e-6) {
                return Ok(solid(&stops));
            }
            // Every stop at one radius is a hard edge there. At radius 0 the
            // whole plane is past it: the last colour.
            let hi = if hi > 1e-6 { hi } else { rx };
            // The scene's radial gradient is a circle of radius `r` (offset 1);
            // an ellipse is that circle squashed about its centre.
            let mut g = json!({
                "type": "radial", "cx": num4(cx), "cy": num4(cy), "r": num4(hi),
                "stops": stops_json(&stops, 0.0, hi),
            });
            if repeating {
                g["extend"] = json!("repeat");
            }
            if (rx - ry).abs() > 1e-6 * rx.max(1.0) {
                let k = ry / rx;
                g["transform"] = json!([1, 0, 0, num4(k), 0, num4(cy * (1.0 - k))]);
            }
            Ok(g)
        }
        Gradient::Conic {
            angle,
            position,
            items,
            flags,
            ..
        } => {
            let cx = tile.x + lp(&position.horizontal, tile.w);
            let cy = tile.y + lp(&position.vertical, tile.h);
            let entries = items
                .iter()
                .map(|item| match item {
                    Item::SimpleColorStop(c) => Entry {
                        kind: stop_of(c, current),
                        pos: None,
                    },
                    Item::ComplexColorStop { color, position } => Entry {
                        kind: stop_of(color, current),
                        pos: Some(turn_fraction(position)),
                    },
                    Item::InterpolationHint(position) => Entry {
                        kind: EntryKind::Hint,
                        pos: Some(turn_fraction(position)),
                    },
                })
                .collect::<Vec<_>>();
            let stops = with_hints(entries, 1.0, method);
            if stops.is_empty() {
                return Err("a gradient with no colour stops".into());
            }
            let repeating = flags.contains(GradientFlags::REPEATING);
            let (lo, hi) = (stops[0].pos, stops[stops.len() - 1].pos);
            if repeating && hi - lo < 1e-6 {
                return Ok(solid(&stops));
            }
            let mut g = json!({
                "type": "conic", "cx": num4(cx), "cy": num4(cy),
                "angle": num4(f64::from(angle.degrees())),
                "stops": stops_json(&stops, 0.0, 1.0),
            });
            if repeating {
                g["extend"] = json!("repeat");
            }
            Ok(g)
        }
    }
}

fn stop_of(c: &style::values::computed::Color, current: &AbsoluteColor) -> EntryKind {
    let abs = resolve_color(c, current);
    EntryKind::Stop(rgba(&abs), abs)
}

fn turn_fraction(p: &AngleOrPercentage) -> f64 {
    match p {
        AngleOrPercentage::Percentage(p) => f64::from(p.0),
        AngleOrPercentage::Angle(a) => f64::from(a.degrees()) / 360.0,
    }
}

fn entry<T>(
    item: &Item<style::values::computed::Color, T>,
    current: &AbsoluteColor,
    pos: impl Fn(&T) -> f64,
) -> Entry {
    match item {
        Item::SimpleColorStop(c) => Entry {
            kind: stop_of(c, current),
            pos: None,
        },
        Item::ComplexColorStop { color, position } => Entry {
            kind: stop_of(color, current),
            pos: Some(pos(position)),
        },
        Item::InterpolationHint(position) => Entry {
            kind: EntryKind::Hint,
            pos: Some(pos(position)),
        },
    }
}

/// The ending shape's radii in pixels for a gradient centred at (cx, cy) in
/// `tile`.
fn radial_radii(shape: &EndingShape, tile: Rect, cx: f64, cy: f64) -> Result<(f64, f64), String> {
    let left = (cx - tile.x).abs();
    let right = (tile.right() - cx).abs();
    let top = (cy - tile.y).abs();
    let bottom = (tile.bottom() - cy).abs();
    let extent = |kw: ShapeExtent, circle: bool| -> (f64, f64) {
        use ShapeExtent::*;
        if circle {
            let corners = [
                left.hypot(top),
                right.hypot(top),
                left.hypot(bottom),
                right.hypot(bottom),
            ];
            let r = match kw {
                ClosestSide => left.min(right).min(top).min(bottom),
                FarthestSide => left.max(right).max(top).max(bottom),
                ClosestCorner | Contain => corners.iter().cloned().fold(f64::INFINITY, f64::min),
                FarthestCorner | Cover => corners.iter().cloned().fold(0.0, f64::max),
            };
            (r, r)
        } else {
            let closest = (left.min(right), top.min(bottom));
            let farthest = (left.max(right), top.max(bottom));
            match kw {
                ClosestSide => closest,
                FarthestSide => farthest,
                ClosestCorner | Contain => (
                    closest.0 * std::f64::consts::SQRT_2,
                    closest.1 * std::f64::consts::SQRT_2,
                ),
                FarthestCorner | Cover => (
                    farthest.0 * std::f64::consts::SQRT_2,
                    farthest.1 * std::f64::consts::SQRT_2,
                ),
            }
        }
    };
    Ok(match shape {
        EndingShape::Circle(Circle::Radius(r)) => {
            let r = f64::from(r.0.px());
            (r, r)
        }
        EndingShape::Circle(Circle::Extent(kw)) => extent(*kw, true),
        EndingShape::Ellipse(Ellipse::Radii(w, h)) => (lp(&w.0, tile.w), lp(&h.0, tile.h)),
        EndingShape::Ellipse(Ellipse::Extent(kw)) => extent(*kw, false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_positions_follow_css() {
        let mut p = vec![None, None, Some(0.5), None, Some(0.3), None];
        fix_positions(&mut p, 1.0);
        let p: Vec<f64> = p.into_iter().map(Option::unwrap).collect();
        // First is 0, the 0.3 after 0.5 is raised to 0.5, the gaps are spread.
        assert!((p[0] - 0.0).abs() < 1e-9);
        assert!((p[1] - 0.25).abs() < 1e-9);
        assert!((p[2] - 0.5).abs() < 1e-9);
        assert!((p[3] - 0.5).abs() < 1e-9);
        assert!((p[4] - 0.5).abs() < 1e-9);
        assert!((p[5] - 1.0).abs() < 1e-9);
    }

    use style::color::mix::HueInterpolationMethod as Hue;

    fn method(space: ColorSpace, hue: Hue) -> ColorInterpolationMethod {
        ColorInterpolationMethod { space, hue }
    }

    fn srgb(r: f32, g: f32, b: f32, a: f32) -> AbsoluteColor {
        AbsoluteColor::new(ColorSpace::Srgb, r, g, b, a)
    }

    fn hue_of(c: &AbsoluteColor, space: ColorSpace) -> f32 {
        c.to_color_space(space).components.0
    }

    #[test]
    fn endpoints_are_the_stops() {
        let (a, b) = (srgb(1.0, 0.0, 0.0, 1.0), srgb(0.0, 0.0, 1.0, 1.0));
        for space in [
            ColorSpace::Oklab,
            ColorSpace::Oklch,
            ColorSpace::Lab,
            ColorSpace::Hsl,
        ] {
            let m = method(space, Hue::Shorter);
            let (_, c0) = mix_in(m, a, b, 0.0);
            let (_, c1) = mix_in(m, a, b, 1.0);
            for k in 0..3 {
                assert!((c0[k] - [1.0, 0.0, 0.0][k]).abs() < 2e-3, "{space:?} {c0:?}");
                assert!((c1[k] - [0.0, 0.0, 1.0][k]).abs() < 2e-3, "{space:?} {c1:?}");
            }
        }
    }

    #[test]
    fn linear_light_midpoint_is_brighter_than_srgb() {
        // Black to white in linear light: 0.5 linear is 0.735 in sRGB.
        let (a, b) = (srgb(0.0, 0.0, 0.0, 1.0), srgb(1.0, 1.0, 1.0, 1.0));
        let (_, c) = mix_in(method(ColorSpace::SrgbLinear, Hue::Shorter), a, b, 0.5);
        assert!((c[0] - 0.7354).abs() < 2e-3, "{c:?}");
    }

    #[test]
    fn oklab_midpoint_of_black_and_white_is_oklab_grey() {
        // L 0.5 in Oklab is 0.5^3 = 0.125 linear light, 0.389 in sRGB.
        let (a, b) = (srgb(0.0, 0.0, 0.0, 1.0), srgb(1.0, 1.0, 1.0, 1.0));
        let (_, c) = mix_in(method(ColorSpace::Oklab, Hue::Shorter), a, b, 0.5);
        assert!((c[0] - 0.3892).abs() < 3e-3, "{c:?}");
    }

    #[test]
    fn hue_methods_go_the_right_way_round() {
        // Hues 20 and 340 in HSL: shorter crosses 0, longer goes through 180.
        let a = AbsoluteColor::new(ColorSpace::Hsl, 20.0, 1.0, 0.5, 1.0);
        let b = AbsoluteColor::new(ColorSpace::Hsl, 340.0, 1.0, 0.5, 1.0);
        let at = |hue| mix_in(method(ColorSpace::Hsl, hue), a, b, 0.5).0;
        let near = |h: f32, want: f32| ((h - want + 540.0).rem_euclid(360.0) - 180.0).abs() < 1.0;
        assert!(near(hue_of(&at(Hue::Shorter), ColorSpace::Hsl), 0.0));
        assert!(near(hue_of(&at(Hue::Longer), ColorSpace::Hsl), 180.0));
        // 20 -> 340 increasing runs up through 180; decreasing runs down through 0.
        assert!(near(hue_of(&at(Hue::Increasing), ColorSpace::Hsl), 180.0));
        assert!(near(hue_of(&at(Hue::Decreasing), ColorSpace::Hsl), 0.0));
    }

    #[test]
    fn a_grey_stop_has_a_powerless_hue() {
        // Grey to red in Oklch takes red's hue all the way.
        let (g, r) = (srgb(0.5, 0.5, 0.5, 1.0), srgb(1.0, 0.0, 0.0, 1.0));
        let m = method(ColorSpace::Oklch, Hue::Shorter);
        let red_hue = r.to_color_space(ColorSpace::Oklch).components.2;
        let (c, _) = mix_in(m, g, r, 0.5);
        // Component order is L, C, H: the hue is the third.
        let h = c.to_color_space(ColorSpace::Oklch).components.2;
        assert!((h - red_hue).abs() < 1.0, "{c:?}");
    }

    #[test]
    fn alpha_is_premultiplied() {
        // Opaque red to transparent blue: the midpoint is still red, half opaque.
        let (a, b) = (srgb(1.0, 0.0, 0.0, 1.0), srgb(0.0, 0.0, 1.0, 0.0));
        let (_, c) = mix_in(method(ColorSpace::Oklab, Hue::Shorter), a, b, 0.5);
        assert!((c[3] - 0.5).abs() < 2e-3, "{c:?}");
        assert!(c[0] > 0.95 && c[2] < 0.05, "{c:?}");
    }

    #[test]
    fn subdivide_keeps_hard_edges_and_fills_spans() {
        let m = method(ColorSpace::Oklab, Hue::Shorter);
        let mk = |pos, abs: AbsoluteColor| Stop {
            pos,
            color: rgba(&abs),
            abs,
        };
        let (r, b) = (srgb(1.0, 0.0, 0.0, 1.0), srgb(0.0, 0.0, 1.0, 1.0));
        let out = subdivide(&[mk(0.0, r), mk(0.5, b), mk(0.5, r), mk(1.0, b)], m);
        assert_eq!(out.len(), 2 * SPACE_STEPS + 2);
        assert!(out.windows(2).all(|w| w[1].pos >= w[0].pos));
    }
}
