//! The conditionals and macros of a GLSL shader, as far as reading its declarations needs them
//! (`glsl.rs`): which lines a `#if` leaves out, and what an array length written as a macro is.
//! Object-like macros, `#if`, `#ifdef`, `#ifndef`, `#elif`, `#else`, `#endif` and `#undef`, with integer
//! expressions, `defined`, and the C operators. Function-like macros are known by name only.

use std::collections::BTreeMap;

/// How deep macros may refer to macros, so one that names itself ends.
const MAX_DEPTH: u32 = 16;

struct Macro {
    /// Defined with parameters (`#define S(x) ...`): not usable in an expression here.
    function_like: bool,
    value: String,
}

/// One open `#if`: whether its current branch is live, and whether an earlier branch was.
struct Frame {
    active: bool,
    taken: bool,
}

pub(crate) struct Cpp {
    macros: BTreeMap<String, Macro>,
    open: Vec<Frame>,
}

impl Cpp {
    pub fn new() -> Self {
        let mut cpp = Cpp {
            macros: BTreeMap::new(),
            open: Vec::new(),
        };
        cpp.define("GL_ES", false, "1");
        // The fragment shader has highp, as the replay computes in 32-bit floats.
        cpp.define("GL_FRAGMENT_PRECISION_HIGH", false, "1");
        cpp.define("__VERSION__", false, "100");
        cpp
    }

    fn define(&mut self, name: &str, function_like: bool, value: &str) {
        self.macros.insert(
            name.to_string(),
            Macro {
                function_like,
                value: value.trim().to_string(),
            },
        );
    }

    /// Whether the code at this point is kept by the conditionals around it.
    pub fn active(&self) -> bool {
        self.open.last().is_none_or(|f| f.active)
    }

    /// Notes a directive (the text after its `#`).
    pub fn directive(&mut self, line: &str) -> Result<(), String> {
        let line = line.trim_start();
        let keyword: String = line
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        let rest = line[keyword.len()..].trim();
        let live = self.active();
        match keyword.as_str() {
            "if" | "ifdef" | "ifndef" => {
                let on = live
                    && match keyword.as_str() {
                        "if" => self.calc(rest)? != 0,
                        "ifdef" => self.macros.contains_key(first_word(rest)),
                        _ => !self.macros.contains_key(first_word(rest)),
                    };
                self.open.push(Frame {
                    active: on,
                    taken: on,
                });
            }
            "elif" | "else" => {
                let parent_live = self.open.len() < 2 || self.open[self.open.len() - 2].active;
                let Some(top) = self.open.last() else {
                    return Err(format!("`#{keyword}` without `#if`"));
                };
                let taken = top.taken;
                let on = parent_live
                    && !taken
                    && (keyword == "else" || self.calc(rest)? != 0);
                let top = self.open.last_mut().expect("checked above");
                top.active = on;
                top.taken = taken || on || keyword == "else";
            }
            "endif" => {
                if self.open.pop().is_none() {
                    return Err("`#endif` without `#if`".to_string());
                }
            }
            "define" if live => {
                let name = first_word(rest);
                let after = &rest[name.len()..];
                if !name.is_empty() {
                    self.define(name, after.starts_with('('), after);
                }
            }
            "undef" if live => {
                self.macros.remove(first_word(rest));
            }
            "version" if live => {
                let number = first_word(rest).to_string();
                self.define("__VERSION__", false, &number);
            }
            _ => {}
        }
        Ok(())
    }

    /// An array length as written: its value when it is an integer expression of numbers and macros, else the text.
    pub fn length(&self, written: &str) -> String {
        match self.calc_at(written, 0, true) {
            Ok(n) if (0..=i64::from(u32::MAX)).contains(&n) => n.to_string(),
            _ => written.to_string(),
        }
    }

    /// The value of an integer expression (a calculator over numbers and macros: nothing is run).
    fn calc(&self, text: &str) -> Result<i64, String> {
        self.calc_at(text, 0, false)
    }

    /// `strict`: a name that is no macro is an error, not 0 (what an array length needs).
    fn calc_at(&self, text: &str, depth: u32, strict: bool) -> Result<i64, String> {
        if depth > MAX_DEPTH {
            return Err(format!("`{text}` expands without end"));
        }
        let mut parser = Parser {
            cpp: self,
            tokens: tokenize(text)?,
            at: 0,
            depth,
            strict,
        };
        let value = parser.ternary()?;
        if parser.at < parser.tokens.len() {
            return Err(format!("unexpected `{}` in `{text}`", parser.tokens[parser.at]));
        }
        Ok(value)
    }
}

fn first_word(text: &str) -> &str {
    let end = text
        .find(|c: char| !(c.is_alphanumeric() || c == '_'))
        .unwrap_or(text.len());
    &text[..end]
}

fn tokenize(text: &str) -> Result<Vec<String>, String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
        } else if c.is_alphanumeric() || c == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            out.push(chars[start..i].iter().collect());
        } else {
            let two: String = chars[i..chars.len().min(i + 2)].iter().collect();
            if ["&&", "||", "==", "!=", "<=", ">=", "<<", ">>"].contains(&two.as_str()) {
                out.push(two);
                i += 2;
            } else if "!~+-*/%<>&|^()?:".contains(c) {
                out.push(c.to_string());
                i += 1;
            } else {
                return Err(format!("unexpected `{c}` in `{text}`"));
            }
        }
    }
    Ok(out)
}

struct Parser<'a> {
    cpp: &'a Cpp,
    tokens: Vec<String>,
    at: usize,
    depth: u32,
    strict: bool,
}

impl Parser<'_> {
    fn peek(&self) -> Option<&str> {
        self.tokens.get(self.at).map(String::as_str)
    }

    fn take(&mut self) -> Option<String> {
        let token = self.tokens.get(self.at).cloned();
        self.at += 1;
        token
    }

    fn ternary(&mut self) -> Result<i64, String> {
        let condition = self.binary(1)?;
        if self.peek() != Some("?") {
            return Ok(condition);
        }
        self.at += 1;
        let yes = self.ternary()?;
        if self.take().as_deref() != Some(":") {
            return Err("`?` without `:`".to_string());
        }
        let no = self.ternary()?;
        Ok(if condition != 0 { yes } else { no })
    }

    fn precedence(op: &str) -> Option<u8> {
        Some(match op {
            "||" => 1,
            "&&" => 2,
            "|" => 3,
            "^" => 4,
            "&" => 5,
            "==" | "!=" => 6,
            "<" | ">" | "<=" | ">=" => 7,
            "<<" | ">>" => 8,
            "+" | "-" => 9,
            "*" | "/" | "%" => 10,
            _ => return None,
        })
    }

    fn binary(&mut self, min: u8) -> Result<i64, String> {
        let mut left = self.unary()?;
        while let Some(op) = self.peek().map(str::to_string) {
            let Some(level) = Self::precedence(&op).filter(|l| *l >= min) else {
                break;
            };
            self.at += 1;
            let right = self.binary(level + 1)?;
            left = match op.as_str() {
                "||" => i64::from(left != 0 || right != 0),
                "&&" => i64::from(left != 0 && right != 0),
                "|" => left | right,
                "^" => left ^ right,
                "&" => left & right,
                "==" => i64::from(left == right),
                "!=" => i64::from(left != right),
                "<" => i64::from(left < right),
                ">" => i64::from(left > right),
                "<=" => i64::from(left <= right),
                ">=" => i64::from(left >= right),
                "<<" => left.wrapping_shl((right & 63) as u32),
                ">>" => left.wrapping_shr((right & 63) as u32),
                "+" => left.wrapping_add(right),
                "-" => left.wrapping_sub(right),
                "*" => left.wrapping_mul(right),
                _ if right == 0 => return Err("division by zero".to_string()),
                "/" => left.wrapping_div(right),
                _ => left.wrapping_rem(right),
            };
        }
        Ok(left)
    }

    fn unary(&mut self) -> Result<i64, String> {
        let Some(token) = self.take() else {
            return Err("the expression ends early".to_string());
        };
        match token.as_str() {
            "!" => Ok(i64::from(self.unary()? == 0)),
            "~" => Ok(!self.unary()?),
            "-" => Ok(self.unary()?.wrapping_neg()),
            "+" => self.unary(),
            "(" => {
                let value = self.ternary()?;
                if self.take().as_deref() != Some(")") {
                    return Err("`(` without `)`".to_string());
                }
                Ok(value)
            }
            "defined" => {
                let parenthesised = self.peek() == Some("(");
                if parenthesised {
                    self.at += 1;
                }
                let name = self.take().ok_or("`defined` without a name")?;
                if parenthesised && self.take().as_deref() != Some(")") {
                    return Err("`defined(` without `)`".to_string());
                }
                Ok(i64::from(self.cpp.macros.contains_key(&name)))
            }
            word if word.starts_with(|c: char| c.is_ascii_digit()) => {
                let digits = word.trim_end_matches(['u', 'U', 'l', 'L']);
                let parsed = match digits.strip_prefix("0x").or_else(|| digits.strip_prefix("0X")) {
                    Some(hex) => i64::from_str_radix(hex, 16),
                    None => digits.parse::<i64>(),
                };
                parsed.map_err(|_| format!("`{word}` is not an integer"))
            }
            word => match self.cpp.macros.get(word) {
                // An identifier that is no macro is 0, as in C.
                None if self.strict => Err(format!("`{word}` is not defined")),
                None => Ok(0),
                Some(m) if m.function_like => Err(format!("`{word}` is a macro with arguments")),
                Some(m) => self.cpp.calc_at(&m.value, self.depth + 1, self.strict),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(lines: &[&str]) -> Cpp {
        let mut cpp = Cpp::new();
        for line in lines {
            cpp.directive(line).unwrap();
        }
        cpp
    }

    #[test]
    fn ifdef_else_and_nesting_pick_one_branch() {
        let mut cpp = run(&["define A", "ifdef A", "ifdef B"]);
        assert!(!cpp.active());
        cpp.directive("else").unwrap();
        assert!(cpp.active());
        cpp.directive("endif").unwrap();
        cpp.directive("else").unwrap();
        assert!(!cpp.active());
        cpp.directive("endif").unwrap();
        assert!(cpp.active());
    }

    #[test]
    fn if_evaluates_defined_macros_and_c_operators() {
        let cpp = run(&["define N 3", "define LIST (N * 2 + 1)"]);
        assert_eq!(cpp.calc("defined(N) && !defined X").unwrap(), 1);
        assert_eq!(cpp.calc("LIST == 7 && N > 2 || 0").unwrap(), 1);
        assert_eq!(cpp.calc("( defined( USE_A ) && ! defined( B ) )").unwrap(), 0);
        assert_eq!(cpp.calc("0 > 0").unwrap(), 0);
        assert_eq!(cpp.calc("N == 3 ? 10 : 20").unwrap(), 10);
        assert_eq!(cpp.calc("GL_ES").unwrap(), 1);
    }

    #[test]
    fn elif_takes_the_first_live_branch_only() {
        let mut cpp = run(&["if 0"]);
        assert!(!cpp.active());
        cpp.directive("elif 1").unwrap();
        assert!(cpp.active());
        cpp.directive("elif 1").unwrap();
        assert!(!cpp.active());
        cpp.directive("else").unwrap();
        assert!(!cpp.active());
    }

    #[test]
    fn a_define_in_a_dead_branch_does_not_happen() {
        let cpp = run(&["if 0", "define N 4", "endif"]);
        assert_eq!(cpp.length("N"), "N");
        let cpp = run(&["if 1", "define N 4", "endif"]);
        assert_eq!(cpp.length("N"), "4");
    }

    #[test]
    fn a_length_is_a_number_or_stays_as_written() {
        let cpp = run(&["define A B", "define B 5", "define F(x) 2", "define SELF SELF"]);
        assert_eq!(cpp.length(" 8 "), "8");
        assert_eq!(cpp.length("A"), "5");
        assert_eq!(cpp.length("A / 2"), "2");
        assert_eq!(cpp.length("F"), "F");
        assert_eq!(cpp.length("SELF"), "SELF");
        assert_eq!(cpp.length("1 / 0"), "1 / 0");
        assert_eq!(cpp.length("0 - 1"), "0 - 1");
    }

    #[test]
    fn unbalanced_conditionals_are_errors() {
        assert!(Cpp::new().directive("endif").is_err());
        assert!(Cpp::new().directive("else").is_err());
        assert!(Cpp::new().directive("if 1 +").is_err());
    }
}
