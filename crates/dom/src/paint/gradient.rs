//! CSS gradients (`linear-gradient()` and friends) as scene gradients.

use serde_json::{Value, json};
use style::color::AbsoluteColor;
use style::values::computed::AngleOrPercentage;
use style::values::computed::image::{EndingShape, Gradient, LineDirection};
use style::values::generics::image::{
    Circle, Ellipse, GenericGradientItem as Item, GradientFlags, ShapeExtent,
};
use style::values::specified::position::{HorizontalPositionKeyword, VerticalPositionKeyword};

use super::geom::Rect;
use super::util::{hex_of, lp, num, num4, resolve_color, rgba};

/// A stop with its position resolved to a distance along the gradient line
/// (or a turn fraction for conic gradients).
#[derive(Clone, Copy, Debug)]
struct Stop {
    pos: f64,
    color: [f32; 4],
}

/// Whether the colours interpolate the way the scene's gradients do (sRGB,
/// premultiplied, which is CSS's default for the legacy colour syntaxes).
fn plain_interpolation(g: &Gradient) -> bool {
    use style::color::ColorSpace;
    let m = match g {
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
        } => m,
    };
    m.space == ColorSpace::Srgb
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
    for p in positions.iter_mut() {
        if let Some(v) = p {
            if *v < highest {
                *v = highest;
            }
            highest = *v;
        }
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
        for k in i..j {
            positions[k] = Some(from + (to - from) * (k - i + 1) as f64 / (j - i + 1) as f64);
        }
        i = j;
    }
}

/// Adds stops that follow an interpolation hint's curve: the colour halfway
/// between two stops is at the hint, and elsewhere the weight is
/// `t ^ (ln 0.5 / ln h)` (CSS Images 4).
fn with_hints(items: Vec<Entry>, full: f64) -> Vec<Stop> {
    // Resolve positions first, hints included, so a hint is placed too.
    let mut positions: Vec<Option<f64>> = items.iter().map(|e| e.pos).collect();
    // A hint takes its position as given; a hint with none is not valid.
    fix_positions(&mut positions, full);
    let mut out: Vec<Stop> = Vec::new();
    for (i, e) in items.iter().enumerate() {
        let pos = positions[i].unwrap_or(0.0);
        match e.kind {
            EntryKind::Stop(color) => out.push(Stop { pos, color }),
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
                for k in 1..8 {
                    let t = f64::from(k) / 8.0;
                    let w = t.powf(exponent);
                    let mut c = [0.0_f32; 4];
                    // Premultiplied interpolation.
                    let (pa, na) = (f64::from(prev.color[3]), f64::from(next.color[3]));
                    let a = pa + (na - pa) * w;
                    for ch in 0..3 {
                        let pm = f64::from(prev.color[ch]) * pa;
                        let nm = f64::from(next.color[ch]) * na;
                        let m = pm + (nm - pm) * w;
                        c[ch] = if a > 0.0 { (m / a) as f32 } else { 0.0 };
                    }
                    c[3] = a as f32;
                    out.push(Stop {
                        pos: prev.pos + span * t,
                        color: c,
                    });
                }
            }
        }
    }
    out
}

fn next_stop(items: &[Entry], positions: &[Option<f64>], from: usize) -> Option<Stop> {
    for i in from + 1..items.len() {
        if let EntryKind::Stop(color) = items[i].kind {
            return Some(Stop {
                pos: positions[i].unwrap_or(0.0),
                color,
            });
        }
    }
    None
}

#[derive(Clone, Copy)]
enum EntryKind {
    Stop([f32; 4]),
    Hint,
}

#[derive(Clone, Copy)]
struct Entry {
    kind: EntryKind,
    pos: Option<f64>,
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
    if !plain_interpolation(g) {
        return Err("a gradient that interpolates in a colour space other than sRGB".into());
    }
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
            let stops = with_hints(entries, len);
            if stops.is_empty() {
                return Err("a gradient with no colour stops".into());
            }
            let (lo, hi) = (stops[0].pos, stops[stops.len() - 1].pos);
            let repeating = flags.contains(GradientFlags::REPEATING);
            if hi - lo < 1e-6 || len <= 0.0 {
                return Ok(solid(&stops));
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
            let stops = with_hints(entries, rx);
            if stops.is_empty() {
                return Err("a gradient with no colour stops".into());
            }
            let repeating = flags.contains(GradientFlags::REPEATING);
            let (lo, hi) = (stops[0].pos.max(0.0), stops[stops.len() - 1].pos);
            if hi - lo < 1e-6 || rx <= 0.0 || ry <= 0.0 {
                return Ok(solid(&stops));
            }
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
                g["matrix"] = json!([1, 0, 0, num4(k), 0, num4(cy * (1.0 - k))]);
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
                        kind: EntryKind::Stop(rgba(&resolve_color(c, current))),
                        pos: None,
                    },
                    Item::ComplexColorStop { color, position } => Entry {
                        kind: EntryKind::Stop(rgba(&resolve_color(color, current))),
                        pos: Some(turn_fraction(position)),
                    },
                    Item::InterpolationHint(position) => Entry {
                        kind: EntryKind::Hint,
                        pos: Some(turn_fraction(position)),
                    },
                })
                .collect::<Vec<_>>();
            let stops = with_hints(entries, 1.0);
            if stops.is_empty() {
                return Err("a gradient with no colour stops".into());
            }
            let repeating = flags.contains(GradientFlags::REPEATING);
            let (lo, hi) = (stops[0].pos, stops[stops.len() - 1].pos);
            if hi - lo < 1e-6 {
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
            kind: EntryKind::Stop(rgba(&resolve_color(c, current))),
            pos: None,
        },
        Item::ComplexColorStop { color, position } => Entry {
            kind: EntryKind::Stop(rgba(&resolve_color(color, current))),
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
}
