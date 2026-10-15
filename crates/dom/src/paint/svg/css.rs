//! Small CSS readers for what SVG needs from a `style` attribute: the
//! declarations, and the transform properties (`transform`, `rotate`, `scale`,
//! `translate`, `transform-origin`), which usvg does not read from CSS.

use kurbo::Affine;

/// The declarations of a `style` attribute, `(name, value)`, in order. Splits
/// at `;` outside parentheses and quotes (a `url(data:...;base64,...)` has
/// semicolons inside).
pub fn declarations(style: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut current = String::new();
    let flush = |current: &mut String, out: &mut Vec<(String, String)>| {
        if let Some((name, value)) = current.split_once(':') {
            let (name, value) = (name.trim(), value.trim());
            if !name.is_empty() && !value.is_empty() {
                out.push((name.to_ascii_lowercase(), value.to_string()));
            }
        }
        current.clear();
    };
    for c in style.chars() {
        match (c, quote) {
            ('"' | '\'', None) => {
                quote = Some(c);
                current.push(c);
            }
            (q, Some(open)) if q == open => {
                quote = None;
                current.push(c);
            }
            ('(', None) => {
                depth += 1;
                current.push(c);
            }
            (')', None) => {
                depth -= 1;
                current.push(c);
            }
            (';', None) if depth <= 0 => flush(&mut current, &mut out),
            _ => current.push(c),
        }
    }
    flush(&mut current, &mut out);
    out
}

/// Writes declarations back as a `style` attribute value.
pub fn to_style(decls: &[(String, String)]) -> String {
    decls
        .iter()
        .map(|(n, v)| format!("{n}:{v}"))
        .collect::<Vec<_>>()
        .join(";")
}

/// A number with an optional unit: `12`, `12px`, `-1.5e2deg`, `50%`.
pub fn dimension(s: &str) -> Option<(f64, &str)> {
    let s = s.trim();
    let split = s
        .char_indices()
        .find(|&(i, c)| {
            c.is_ascii_alphabetic() && !(matches!(c, 'e' | 'E') && is_exponent(s, i)) || c == '%'
        })
        .map_or(s.len(), |(i, _)| i);
    let number: f64 = s[..split].trim().parse().ok()?;
    Some((number, s[split..].trim()))
}

fn is_exponent(s: &str, i: usize) -> bool {
    let rest = s[i + 1..].trim_start_matches(['+', '-']);
    rest.chars().next().is_some_and(|c| c.is_ascii_digit())
}

/// A length in CSS pixels. `percent_of` is what `%` is a percentage of.
pub fn length(s: &str, percent_of: f64) -> Option<f64> {
    let (n, unit) = dimension(s)?;
    Some(match unit.to_ascii_lowercase().as_str() {
        "" | "px" => n,
        "%" => n / 100.0 * percent_of,
        "pt" => n * 96.0 / 72.0,
        "pc" => n * 16.0,
        "in" => n * 96.0,
        "cm" => n * 96.0 / 2.54,
        "mm" => n * 96.0 / 25.4,
        "em" => n * 16.0,
        "rem" => n * 16.0,
        _ => return None,
    })
}

/// An angle in degrees.
pub fn angle(s: &str) -> Option<f64> {
    let (n, unit) = dimension(s)?;
    Some(match unit.to_ascii_lowercase().as_str() {
        "" | "deg" => n,
        "rad" => n.to_degrees(),
        "grad" => n * 0.9,
        "turn" => n * 360.0,
        _ => return None,
    })
}

/// The functions of a `transform` value as `(name, arguments)`.
fn functions(value: &str) -> Option<Vec<(String, Vec<String>)>> {
    let mut out = Vec::new();
    let mut rest = value.trim();
    while !rest.is_empty() {
        let open = rest.find('(')?;
        let close = rest[open..].find(')')? + open;
        let name = rest[..open].trim().to_ascii_lowercase();
        let args = rest[open + 1..close]
            .split([',', ' '])
            .map(str::trim)
            .filter(|a| !a.is_empty())
            .map(str::to_string)
            .collect();
        out.push((name, args));
        rest = rest[close + 1..].trim_start_matches([' ', ',']);
    }
    Some(out)
}

/// The matrix of a CSS `transform` value. `reference` is the width and height
/// a percentage in a translation is of. `None` if a function or unit is not
/// understood (a 3D function included).
pub fn transform_list(value: &str, reference: [f64; 2]) -> Option<Affine> {
    let value = value.trim();
    if value.eq_ignore_ascii_case("none") {
        return Some(Affine::IDENTITY);
    }
    let mut m = Affine::IDENTITY;
    for (name, args) in functions(value)? {
        let num = |i: usize| -> Option<f64> { dimension(args.get(i)?).map(|(n, _)| n) };
        let len = |i: usize, of: f64| -> Option<f64> { length(args.get(i)?, of) };
        let f = match name.as_str() {
            "matrix" if args.len() == 6 => {
                let v: Option<Vec<f64>> = (0..6).map(num).collect();
                let v = v?;
                Affine::new([v[0], v[1], v[2], v[3], v[4], v[5]])
            }
            "translate" => Affine::translate((
                len(0, reference[0])?,
                if args.len() > 1 {
                    len(1, reference[1])?
                } else {
                    0.0
                },
            )),
            "translatex" => Affine::translate((len(0, reference[0])?, 0.0)),
            "translatey" => Affine::translate((0.0, len(0, reference[1])?)),
            "scale" => {
                let sx = num(0)?;
                Affine::scale_non_uniform(sx, if args.len() > 1 { num(1)? } else { sx })
            }
            "scalex" => Affine::scale_non_uniform(num(0)?, 1.0),
            "scaley" => Affine::scale_non_uniform(1.0, num(0)?),
            // SVG's `rotate(a cx cy)`.
            "rotate" if args.len() == 3 => {
                let (cx, cy) = (num(1)?, num(2)?);
                Affine::translate((cx, cy))
                    * Affine::rotate(angle(&args[0])?.to_radians())
                    * Affine::translate((-cx, -cy))
            }
            "rotate" | "rotatez" => Affine::rotate(angle(args.first()?)?.to_radians()),
            "skewx" => Affine::new([
                1.0,
                0.0,
                angle(args.first()?)?.to_radians().tan(),
                1.0,
                0.0,
                0.0,
            ]),
            "skewy" => Affine::new([
                1.0,
                angle(args.first()?)?.to_radians().tan(),
                0.0,
                1.0,
                0.0,
                0.0,
            ]),
            "skew" => Affine::new([
                1.0,
                if args.len() > 1 {
                    angle(&args[1])?.to_radians().tan()
                } else {
                    0.0
                },
                angle(args.first()?)?.to_radians().tan(),
                1.0,
                0.0,
                0.0,
            ]),
            _ => return None,
        };
        m *= f;
    }
    Some(m)
}

/// `transform-origin` as a point in CSS pixels; `reference` is the box the
/// percentages and keywords are in, `[x, y, width, height]`.
pub fn transform_origin(value: &str, reference: [f64; 4]) -> Option<[f64; 2]> {
    let parts: Vec<&str> = value.split_whitespace().collect();
    let one = |s: &str, horizontal: bool| -> Option<f64> {
        let (start, size) = if horizontal {
            (reference[0], reference[2])
        } else {
            (reference[1], reference[3])
        };
        Some(
            start
                + match s.to_ascii_lowercase().as_str() {
                    "left" | "top" => 0.0,
                    "center" => size / 2.0,
                    "right" | "bottom" => size,
                    other => length(other, size)?,
                },
        )
    };
    match parts.as_slice() {
        [x] => {
            // A single keyword may be vertical.
            if matches!(x.to_ascii_lowercase().as_str(), "top" | "bottom") {
                Some([one("center", true)?, one(x, false)?])
            } else {
                Some([one(x, true)?, one("center", false)?])
            }
        }
        [a, b, ..] => {
            let swap = matches!(a.to_ascii_lowercase().as_str(), "top" | "bottom")
                || matches!(b.to_ascii_lowercase().as_str(), "left" | "right");
            if swap {
                Some([one(b, true)?, one(a, false)?])
            } else {
                Some([one(a, true)?, one(b, false)?])
            }
        }
        [] => None,
    }
}

/// The values of a list attribute such as `stroke-dasharray` or `viewBox`.
pub fn numbers(s: &str) -> Vec<f64> {
    s.split([',', ' ', '\t', '\n'])
        .filter(|p| !p.is_empty())
        .filter_map(|p| dimension(p).map(|(n, _)| n))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declarations_keep_parenthesised_semicolons() {
        let d = declarations("fill: red; background:url(data:image/png;base64,AAA); opacity:.5;");
        assert_eq!(d.len(), 3);
        assert_eq!(
            d[1],
            ("background".into(), "url(data:image/png;base64,AAA)".into())
        );
    }

    #[test]
    fn dimensions_read_units_and_exponents() {
        assert_eq!(dimension("12px"), Some((12.0, "px")));
        assert_eq!(dimension("1e2"), Some((100.0, "")));
        assert_eq!(dimension("-45deg"), Some((-45.0, "deg")));
        assert_eq!(dimension("50%"), Some((50.0, "%")));
        assert_eq!(length("1in", 0.0), Some(96.0));
        assert_eq!(length("25%", 200.0), Some(50.0));
        assert_eq!(angle("0.25turn"), Some(90.0));
    }

    #[test]
    fn a_transform_list_multiplies_left_to_right() {
        let m = transform_list("translate(10px, 20px) scale(2)", [0.0, 0.0]).unwrap();
        // Scale first, then the translation.
        let p = m * kurbo::Point::new(1.0, 1.0);
        assert_eq!((p.x, p.y), (12.0, 22.0));
        let r = transform_list("rotate(90deg)", [0.0, 0.0]).unwrap() * kurbo::Point::new(1.0, 0.0);
        assert!(r.x.abs() < 1e-9 && (r.y - 1.0).abs() < 1e-9);
        assert!(transform_list("rotateX(20deg)", [0.0, 0.0]).is_none());
        assert_eq!(transform_list("none", [0.0, 0.0]), Some(Affine::IDENTITY));
    }

    #[test]
    fn origins_take_keywords_lengths_and_percentages() {
        let b = [0.0, 0.0, 200.0, 100.0];
        assert_eq!(transform_origin("50% 50%", b), Some([100.0, 50.0]));
        assert_eq!(transform_origin("center", b), Some([100.0, 50.0]));
        assert_eq!(transform_origin("0 0", b), Some([0.0, 0.0]));
        assert_eq!(transform_origin("bottom right", b), Some([200.0, 100.0]));
        assert_eq!(transform_origin("10px 20px", b), Some([10.0, 20.0]));
        assert_eq!(transform_origin("top", b), Some([100.0, 0.0]));
    }
}
