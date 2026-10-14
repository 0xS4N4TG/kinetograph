use serde::Deserialize;

/// Straight-alpha sRGB colour, 8 bits per channel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(try_from = "String")]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Color {
    pub const BLACK: Color = Color {
        r: 0,
        g: 0,
        b: 0,
        a: 255,
    };

    /// Linear-light RGBA, premultiplied by alpha: what the compositor's
    /// textures hold.
    pub fn linear_premultiplied(self) -> [f64; 4] {
        let lin = |v: u8| {
            let v = f64::from(v) / 255.0;
            if v <= 0.04045 {
                v / 12.92
            } else {
                ((v + 0.055) / 1.055).powf(2.4)
            }
        };
        let a = f64::from(self.a) / 255.0;
        [lin(self.r) * a, lin(self.g) * a, lin(self.b) * a, a]
    }

    /// Parses `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` or `transparent`.
    pub fn parse(s: &str) -> Result<Color, String> {
        let s = s.trim();
        if s.eq_ignore_ascii_case("transparent") {
            return Ok(Color {
                r: 0,
                g: 0,
                b: 0,
                a: 0,
            });
        }
        let hex = s
            .strip_prefix('#')
            .ok_or_else(|| format!("colour {s:?} must start with '#'"))?;
        if !hex.is_ascii() {
            return Err(format!("colour {s:?} has non-hex characters"));
        }
        let digit = |i: usize| {
            u8::from_str_radix(&hex[i..i + 1], 16)
                .map(|d| d * 17)
                .map_err(|_| format!("colour {s:?} has non-hex characters"))
        };
        let byte = |i: usize| {
            u8::from_str_radix(&hex[i..i + 2], 16)
                .map_err(|_| format!("colour {s:?} has non-hex characters"))
        };
        match hex.len() {
            3 => Ok(Color {
                r: digit(0)?,
                g: digit(1)?,
                b: digit(2)?,
                a: 255,
            }),
            4 => Ok(Color {
                r: digit(0)?,
                g: digit(1)?,
                b: digit(2)?,
                a: digit(3)?,
            }),
            6 => Ok(Color {
                r: byte(0)?,
                g: byte(2)?,
                b: byte(4)?,
                a: 255,
            }),
            8 => Ok(Color {
                r: byte(0)?,
                g: byte(2)?,
                b: byte(4)?,
                a: byte(6)?,
            }),
            _ => Err(format!("colour {s:?} must have 3, 4, 6 or 8 hex digits")),
        }
    }
}

/// A colour filter as a 4x5 matrix, the shape of the W3C Filter Effects
/// `feColorMatrix`. Each row says how one output channel (r, g, b, a) is made
/// from the input `[r, g, b, a, 1]`: four coefficients, then an offset. It
/// acts on straight (unpremultiplied) sRGB-encoded values in 0..1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ColorMatrix(pub [[f64; 5]; 4]);

impl ColorMatrix {
    pub const IDENTITY: ColorMatrix = ColorMatrix([
        [1.0, 0.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 0.0, 1.0, 0.0],
    ]);

    /// Colour channels only: alpha passes through unchanged.
    fn rgb(m: [[f64; 3]; 3], offset: [f64; 3]) -> ColorMatrix {
        let row = |i: usize| [m[i][0], m[i][1], m[i][2], 0.0, offset[i]];
        ColorMatrix([row(0), row(1), row(2), [0.0, 0.0, 0.0, 1.0, 0.0]])
    }

    /// CSS `saturate()`: 0 is grey, 1 no change, above 1 over-saturated.
    /// Negative amounts count as 0.
    pub fn saturate(amount: f64) -> ColorMatrix {
        let s = amount.max(0.0);
        ColorMatrix::rgb(
            [
                [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
                [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
                [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
            ],
            [0.0; 3],
        )
    }

    /// CSS `hue-rotate()`, `degrees` turning the hue clockwise round the
    /// colour wheel.
    pub fn hue_rotate(degrees: f64) -> ColorMatrix {
        let (sin, cos) = degrees.to_radians().sin_cos();
        ColorMatrix::rgb(
            [
                [
                    0.213 + cos * 0.787 - sin * 0.213,
                    0.715 - cos * 0.715 - sin * 0.715,
                    0.072 - cos * 0.072 + sin * 0.928,
                ],
                [
                    0.213 - cos * 0.213 + sin * 0.143,
                    0.715 + cos * 0.285 + sin * 0.140,
                    0.072 - cos * 0.072 - sin * 0.283,
                ],
                [
                    0.213 - cos * 0.213 - sin * 0.787,
                    0.715 - cos * 0.715 + sin * 0.715,
                    0.072 + cos * 0.928 + sin * 0.072,
                ],
            ],
            [0.0; 3],
        )
    }

    /// CSS `grayscale()`: 0 is no change, 1 is fully grey (clamped to 0..1).
    pub fn grayscale(amount: f64) -> ColorMatrix {
        let s = 1.0 - amount.clamp(0.0, 1.0);
        ColorMatrix::rgb(
            [
                [
                    0.2126 + 0.7874 * s,
                    0.7152 - 0.7152 * s,
                    0.0722 - 0.0722 * s,
                ],
                [
                    0.2126 - 0.2126 * s,
                    0.7152 + 0.2848 * s,
                    0.0722 - 0.0722 * s,
                ],
                [
                    0.2126 - 0.2126 * s,
                    0.7152 - 0.7152 * s,
                    0.0722 + 0.9278 * s,
                ],
            ],
            [0.0; 3],
        )
    }

    /// CSS `sepia()`: 0 is no change, 1 is full sepia (clamped to 0..1).
    pub fn sepia(amount: f64) -> ColorMatrix {
        let s = 1.0 - amount.clamp(0.0, 1.0);
        ColorMatrix::rgb(
            [
                [0.393 + 0.607 * s, 0.769 - 0.769 * s, 0.189 - 0.189 * s],
                [0.349 - 0.349 * s, 0.686 + 0.314 * s, 0.168 - 0.168 * s],
                [0.272 - 0.272 * s, 0.534 - 0.534 * s, 0.131 + 0.869 * s],
            ],
            [0.0; 3],
        )
    }

    /// CSS `invert()`: 0 is no change, 1 is the full negative, between is
    /// a mix (clamped to 0..1).
    pub fn invert(amount: f64) -> ColorMatrix {
        let a = amount.clamp(0.0, 1.0);
        let k = 1.0 - 2.0 * a;
        ColorMatrix::rgb([[k, 0.0, 0.0], [0.0, k, 0.0], [0.0, 0.0, k]], [a; 3])
    }

    /// CSS `brightness()`: a multiplier on the colour channels. Negative
    /// amounts count as 0.
    pub fn brightness(amount: f64) -> ColorMatrix {
        let a = amount.max(0.0);
        ColorMatrix::rgb([[a, 0.0, 0.0], [0.0, a, 0.0], [0.0, 0.0, a]], [0.0; 3])
    }

    /// CSS `contrast()`: scales the colour channels about mid grey. Negative
    /// amounts count as 0.
    pub fn contrast(amount: f64) -> ColorMatrix {
        let a = amount.max(0.0);
        ColorMatrix::rgb(
            [[a, 0.0, 0.0], [0.0, a, 0.0], [0.0, 0.0, a]],
            [0.5 - 0.5 * a; 3],
        )
    }

    /// The filter that does `self` first and `next` after. Values are not
    /// clamped to 0..1 in between, only (by the caller) at the end.
    pub fn then(&self, next: &ColorMatrix) -> ColorMatrix {
        let mut out = [[0.0; 5]; 4];
        for (i, row) in out.iter_mut().enumerate() {
            for (j, value) in row.iter_mut().enumerate() {
                *value = (0..4).map(|k| next.0[i][k] * self.0[k][j]).sum::<f64>();
            }
            // The offset column also picks up `next`'s own offset.
            row[4] += next.0[i][4];
        }
        ColorMatrix(out)
    }
}

impl TryFrom<String> for Color {
    type Error = String;

    fn try_from(s: String) -> Result<Color, String> {
        Color::parse(&s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linear_premultiplied_decodes_srgb_and_multiplies_alpha() {
        let close = |a: [f64; 4], b: [f64; 4]| a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-9);
        let rgba = |s: &str| Color::parse(s).unwrap().linear_premultiplied();
        assert!(close(rgba("#ffffff"), [1.0; 4]));
        assert!(close(rgba("#000000"), [0.0, 0.0, 0.0, 1.0]));
        assert!(close(rgba("transparent"), [0.0; 4]));
        // sRGB 0x80 is 0.2158605 in linear light; half alpha halves it.
        let half = rgba("#80808080");
        let a = 128.0 / 255.0;
        assert!((half[3] - a).abs() < 1e-9);
        assert!((half[0] - 0.2158605 * a).abs() < 1e-6);
        // Below the sRGB knee the curve is linear: 10 / 255 / 12.92.
        assert!((rgba("#0a0a0a")[0] - 10.0 / 255.0 / 12.92).abs() < 1e-9);
    }

    /// `matrix` applied to a straight colour, with no clamping.
    fn apply(matrix: &ColorMatrix, c: [f64; 4]) -> [f64; 4] {
        let v = [c[0], c[1], c[2], c[3], 1.0];
        matrix
            .0
            .map(|row| row.iter().zip(v).map(|(m, x)| m * x).sum())
    }

    fn close(a: [f64; 4], b: [f64; 4]) -> bool {
        a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-9)
    }

    #[test]
    fn neutral_filters_are_the_identity() {
        let neutral = [
            ColorMatrix::saturate(1.0),
            ColorMatrix::hue_rotate(0.0),
            ColorMatrix::hue_rotate(360.0),
            ColorMatrix::grayscale(0.0),
            ColorMatrix::sepia(0.0),
            ColorMatrix::invert(0.0),
            ColorMatrix::brightness(1.0),
            ColorMatrix::contrast(1.0),
        ];
        for m in neutral {
            for row in 0..4 {
                for col in 0..5 {
                    let want = ColorMatrix::IDENTITY.0[row][col];
                    assert!((m.0[row][col] - want).abs() < 1e-9, "{m:?}");
                }
            }
        }
    }

    #[test]
    fn filters_leave_alpha_alone() {
        let filters = [
            ColorMatrix::saturate(3.0),
            ColorMatrix::hue_rotate(70.0),
            ColorMatrix::grayscale(1.0),
            ColorMatrix::sepia(1.0),
            ColorMatrix::invert(1.0),
            ColorMatrix::brightness(0.3),
            ColorMatrix::contrast(2.0),
        ];
        for m in filters {
            assert_eq!(apply(&m, [0.2, 0.4, 0.6, 0.25])[3], 0.25);
        }
    }

    #[test]
    fn grayscale_and_saturate_zero_make_luma() {
        // Rec. 709 luma for grayscale, the older 0.213 / 0.715 / 0.072 for
        // saturate, as in the W3C definitions.
        let red = [1.0, 0.0, 0.0, 1.0];
        let grey = apply(&ColorMatrix::grayscale(1.0), red);
        assert!(close(grey, [0.2126, 0.2126, 0.2126, 1.0]));
        let grey = apply(&ColorMatrix::saturate(0.0), red);
        assert!(close(grey, [0.213, 0.213, 0.213, 1.0]));
        // Half way is the average of the original and the grey.
        let half = apply(&ColorMatrix::grayscale(0.5), red);
        assert!(close(half, [0.6063, 0.1063, 0.1063, 1.0]));
        // Amounts are clamped: grayscale to 0..1, saturate at 0 from below.
        assert_eq!(ColorMatrix::grayscale(7.0), ColorMatrix::grayscale(1.0));
        assert_eq!(ColorMatrix::grayscale(-1.0), ColorMatrix::grayscale(0.0));
        assert_eq!(ColorMatrix::saturate(-2.0), ColorMatrix::saturate(0.0));
    }

    #[test]
    fn sepia_matches_the_w3c_matrix() {
        // Full sepia of white is the sum of each row, before clamping.
        let white = apply(&ColorMatrix::sepia(1.0), [1.0, 1.0, 1.0, 1.0]);
        assert!(close(white, [1.351, 1.203, 0.937, 1.0]));
        let half = apply(&ColorMatrix::sepia(0.5), [0.0, 1.0, 0.0, 1.0]);
        assert!(close(half, [0.3845, 0.843, 0.267, 1.0]));
    }

    #[test]
    fn hue_rotate_keeps_grey_and_turns_red() {
        for degrees in [30.0, 90.0, 180.0, -75.0] {
            let m = ColorMatrix::hue_rotate(degrees);
            assert!(close(apply(&m, [0.5, 0.5, 0.5, 1.0]), [0.5, 0.5, 0.5, 1.0]));
        }
        // A quarter turn: the red column of the W3C matrix at cos 0, sin 1.
        let red = apply(&ColorMatrix::hue_rotate(90.0), [1.0, 0.0, 0.0, 1.0]);
        assert!(close(red, [0.0, 0.356, -0.574, 1.0]));
    }

    #[test]
    fn invert_brightness_and_contrast() {
        let c = [0.25, 0.5, 1.0, 1.0];
        assert!(close(
            apply(&ColorMatrix::invert(1.0), c),
            [0.75, 0.5, 0.0, 1.0]
        ));
        // Half inverted is mid grey whatever the colour.
        assert!(close(
            apply(&ColorMatrix::invert(0.5), c),
            [0.5, 0.5, 0.5, 1.0]
        ));
        assert!(close(
            apply(&ColorMatrix::brightness(0.5), c),
            [0.125, 0.25, 0.5, 1.0]
        ));
        assert!(close(
            apply(&ColorMatrix::brightness(-1.0), c),
            [0.0, 0.0, 0.0, 1.0]
        ));
        // Contrast pivots on 0.5; 0 flattens everything to it.
        assert!(close(
            apply(&ColorMatrix::contrast(2.0), c),
            [0.0, 0.5, 1.5, 1.0]
        ));
        assert!(close(
            apply(&ColorMatrix::contrast(0.0), c),
            [0.5, 0.5, 0.5, 1.0]
        ));
    }

    #[test]
    fn then_runs_the_first_filter_first() {
        let c = [0.25, 0.5, 0.75, 0.5];
        let double = ColorMatrix::brightness(2.0);
        let invert = ColorMatrix::invert(1.0);
        // Double then invert: 1 - 2c. Invert then double: 2 - 2c.
        let a = apply(&double.then(&invert), c);
        assert!(close(a, [0.5, 0.0, -0.5, 0.5]));
        let b = apply(&invert.then(&double), c);
        assert!(close(b, [1.5, 1.0, 0.5, 0.5]));
        // Composing equals applying one after the other (no clamping between).
        let chain = [
            ColorMatrix::sepia(0.6),
            ColorMatrix::hue_rotate(40.0),
            ColorMatrix::contrast(1.3),
            ColorMatrix::saturate(0.7),
        ];
        let mut composed = ColorMatrix::IDENTITY;
        let mut stepped = c;
        for m in chain {
            composed = composed.then(&m);
            stepped = apply(&m, stepped);
        }
        assert!(close(apply(&composed, c), stepped));
        assert!(close(
            apply(&ColorMatrix::IDENTITY.then(&invert), c),
            apply(&invert, c)
        ));
    }

    #[test]
    fn parses_all_hex_forms() {
        assert_eq!(
            Color::parse("#f80"),
            Ok(Color {
                r: 255,
                g: 136,
                b: 0,
                a: 255
            })
        );
        assert_eq!(
            Color::parse("#f808"),
            Ok(Color {
                r: 255,
                g: 136,
                b: 0,
                a: 136
            })
        );
        assert_eq!(
            Color::parse("#102030"),
            Ok(Color {
                r: 16,
                g: 32,
                b: 48,
                a: 255
            })
        );
        assert_eq!(
            Color::parse("#10203040"),
            Ok(Color {
                r: 16,
                g: 32,
                b: 48,
                a: 64
            })
        );
        assert_eq!(
            Color::parse("#FFFFFF"),
            Ok(Color {
                r: 255,
                g: 255,
                b: 255,
                a: 255
            })
        );
        assert_eq!(
            Color::parse("transparent"),
            Ok(Color {
                r: 0,
                g: 0,
                b: 0,
                a: 0
            })
        );
    }

    #[test]
    fn rejects_bad_colours() {
        assert!(Color::parse("red").is_err());
        assert!(Color::parse("#12").is_err());
        assert!(Color::parse("#12345").is_err());
        assert!(Color::parse("#gg0000").is_err());
        assert!(Color::parse("#é12").is_err());
    }
}
