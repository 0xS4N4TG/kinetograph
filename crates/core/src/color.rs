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
