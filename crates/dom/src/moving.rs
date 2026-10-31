//! Whether an island's imported stylesheets can start a CSS transition or
//! animation on any element of its trees.
//!
//! An edited document and a replayed history differ from a fresh build only
//! when a transition or an animation starts, and that needs a rule that sets
//! one to match an element. A stylesheet that merely mentions the words (a
//! Tailwind build has `.transition`, `@keyframes spin` and
//! `--default-transition-duration` whether or not a class uses them) starts
//! nothing when no element can match the rules that set them.
//!
//! The answer errs one way only: a rule counts as matching unless the
//! rightmost compound of every one of its selectors asks for a class, id or
//! tag that no element of the trees has. Anything the scan does not follow
//! (an `@import`, `@starting-style`, unbalanced braces, a namespace) counts as
//! moving.

use std::collections::HashSet;

use crate::request::DomNode;

/// The classes, ids and tags of the elements of an island's trees, lower-cased.
#[derive(Default)]
struct Present {
    classes: HashSet<String>,
    ids: HashSet<String>,
    tags: HashSet<String>,
}

impl Present {
    fn of(trees: &[&DomNode]) -> Present {
        let mut present = Present::default();
        // What the document wraps the island in (`document::build_root`).
        for tag in ["html", "head", "body", "div", "style", "kg-native"] {
            present.tags.insert(tag.to_string());
        }
        fn walk(node: &DomNode, present: &mut Present) {
            if let DomNode::Element {
                tag,
                attrs,
                children,
                ..
            } = node
            {
                present.tags.insert(tag.to_ascii_lowercase());
                if let Some(class) = attrs.get("class") {
                    for name in class.split_ascii_whitespace() {
                        present.classes.insert(name.to_lowercase());
                    }
                }
                if let Some(id) = attrs.get("id") {
                    present.ids.insert(id.to_lowercase());
                }
                for child in children {
                    walk(child, present);
                }
            }
        }
        for tree in trees {
            walk(tree, &mut present);
        }
        present
    }
}

/// Whether a declaration named `property` can start a transition or an animation.
fn moving_property(property: &str) -> bool {
    !property.starts_with("--") && (property.contains("transition") || property.contains("animation"))
}

/// Whether the CSS text mentions anything that can start a transition or an animation.
pub fn mentions(css: &str) -> bool {
    css.contains("transition") || css.contains("animation") || css.contains("starting-style")
}

/// Whether any of `sheets` can start a transition or an animation on an element of `trees`.
pub fn sheets_move(sheets: &[String], trees: &[&DomNode]) -> bool {
    let mut present = None;
    for sheet in sheets {
        if !mentions(sheet) {
            continue;
        }
        let present = present.get_or_insert_with(|| Present::of(trees));
        let css = strip_comments(sheet);
        let mut scan = Scan { s: css.as_bytes(), i: 0 };
        // An error means the scan lost its place: count it as moving.
        if scan.rules(None, true, present).unwrap_or(true) {
            return true;
        }
    }
    false
}

/// `css` without its comments (strings kept as they are).
fn strip_comments(css: &str) -> String {
    let b = css.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i < b.len() && !(b[i] == b'*' && b.get(i + 1) == Some(&b'/')) {
                    i += 1;
                }
                i += 2;
                // A comment separates tokens.
                out.push(b' ');
            }
            q @ (b'"' | b'\'') => {
                let start = i;
                i = skip_string(b, i, q);
                out.extend_from_slice(&b[start..i.min(b.len())]);
            }
            b'\\' => {
                let end = (i + 2).min(b.len());
                out.extend_from_slice(&b[i..end]);
                i = end;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    // Only whole ASCII bytes were dropped or added, so the text is still UTF-8.
    String::from_utf8(out).unwrap_or_default()
}

/// The index after the string that starts at `i` with quote `q`.
fn skip_string(b: &[u8], mut i: usize, q: u8) -> usize {
    i += 1;
    while i < b.len() && b[i] != q {
        if b[i] == b'\\' {
            i += 1;
        }
        i += 1;
    }
    i + 1
}

/// The index after the escape that starts at `i` (a backslash).
fn skip_escape(b: &[u8], i: usize) -> usize {
    let mut j = i + 1;
    if j < b.len() && b[j].is_ascii_hexdigit() {
        let start = j;
        while j < b.len() && j - start < 6 && b[j].is_ascii_hexdigit() {
            j += 1;
        }
        // One white space after a hex escape belongs to it.
        if j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        j
    } else {
        j + 1
    }
}

struct Scan<'a> {
    s: &'a [u8],
    i: usize,
}

/// What ended a chunk of a block.
enum End {
    Semicolon,
    Open,
    Close,
    Eof,
}

impl<'a> Scan<'a> {
    /// The text up to the next `;`, `{` or `}` outside strings and brackets, and which it was.
    fn chunk(&mut self) -> (&'a [u8], End) {
        let b = self.s;
        let start = self.i;
        let mut depth = 0usize;
        while self.i < b.len() {
            match b[self.i] {
                q @ (b'"' | b'\'') => {
                    self.i = skip_string(b, self.i, q);
                    continue;
                }
                b'\\' => {
                    self.i = skip_escape(b, self.i);
                    continue;
                }
                b'(' | b'[' => depth += 1,
                b')' | b']' => depth = depth.saturating_sub(1),
                b';' | b'{' | b'}' if depth == 0 => {
                    let end = match b[self.i] {
                        b';' => End::Semicolon,
                        b'{' => End::Open,
                        _ => End::Close,
                    };
                    let chunk = &b[start..self.i];
                    self.i += 1;
                    return (chunk, end);
                }
                _ => {}
            }
            self.i += 1;
        }
        self.i = b.len();
        (&b[start..], End::Eof)
    }

    /// Skips the rest of a block whose `{` was just read.
    fn skip_block(&mut self) -> Result<(), ()> {
        loop {
            match self.chunk().1 {
                End::Open => self.skip_block()?,
                End::Close => return Ok(()),
                End::Semicolon => {}
                End::Eof => return Err(()),
            }
        }
    }

    /// Reads rules and declarations up to the end of the block whose `{` was
    /// just read (or of the sheet, `top`). `inside`: whether the style rule
    /// the block belongs to can match an element (None: no style rule). True
    /// when something in it can start a transition or an animation; an error
    /// when the scan loses its place.
    fn rules(&mut self, inside: Option<bool>, top: bool, present: &Present) -> Result<bool, ()> {
        loop {
            let (chunk, end) = self.chunk();
            let text = String::from_utf8_lossy(chunk);
            let text = text.trim();
            match end {
                End::Eof if top => return Ok(declaration(text, inside)),
                End::Close if !top => return Ok(declaration(text, inside)),
                End::Eof | End::Close => return Err(()),
                End::Semicolon => {
                    if let Some(at) = text.strip_prefix('@') {
                        // What an imported sheet holds is not known here.
                        if at.to_ascii_lowercase().starts_with("import") {
                            return Ok(true);
                        }
                    } else if declaration(text, inside) {
                        return Ok(true);
                    }
                }
                End::Open => {
                    let found = if let Some(at) = text.strip_prefix('@') {
                        let name = at
                            .chars()
                            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                            .collect::<String>()
                            .to_ascii_lowercase();
                        match name.as_str() {
                            "starting-style" => true,
                            // Keyframes animate only through an `animation` declaration; the
                            // others hold no style rules.
                            "keyframes" | "-webkit-keyframes" | "-moz-keyframes" | "font-face" | "property" | "page"
                            | "counter-style" | "font-feature-values" | "font-palette-values" => {
                                self.skip_block()?;
                                false
                            }
                            // Conditional and layer blocks hold rules for the same elements.
                            _ => self.rules(inside, false, present)?,
                        }
                    } else {
                        let matches = selectors_match(text, inside, present);
                        self.rules(Some(matches), false, present)?
                    };
                    if found {
                        return Ok(true);
                    }
                }
            }
        }
    }
}

/// Whether the declaration `text` (in a rule that can match an element, or
/// at the top: `inside` None) can start a transition or an animation.
fn declaration(text: &str, inside: Option<bool>) -> bool {
    let Some((property, _)) = text.split_once(':') else {
        return false;
    };
    let property = property.trim().to_ascii_lowercase();
    moving_property(&property) && inside != Some(false)
}

/// Whether any selector of the list `text` can match an element of the
/// trees. `parent`: whether the enclosing style rule can (nesting).
fn selectors_match(text: &str, parent: Option<bool>, present: &Present) -> bool {
    split_top(text, b',').into_iter().any(|selector| selector_matches(selector.trim(), parent, present))
}

/// `text` split at `sep` outside strings and brackets.
fn split_top(text: &str, sep: u8) -> Vec<&str> {
    let b = text.as_bytes();
    let (mut parts, mut start, mut depth, mut i) = (Vec::new(), 0, 0usize, 0);
    while i < b.len() {
        match b[i] {
            q @ (b'"' | b'\'') => {
                i = skip_string(b, i, q);
                continue;
            }
            b'\\' => {
                i = skip_escape(b, i);
                continue;
            }
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth = depth.saturating_sub(1),
            c if c == sep && depth == 0 => {
                parts.push(&text[start..i]);
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    parts.push(&text[start.min(text.len())..]);
    parts
}

/// Whether the complex selector `selector` can match an element: its
/// rightmost compound's classes, ids and tag are all present (and, with `&`,
/// the enclosing rule can match). Anything not understood can match.
fn selector_matches(selector: &str, parent: Option<bool>, present: &Present) -> bool {
    let b = selector.as_bytes();
    if b.is_empty() {
        return true;
    }
    // The rightmost compound starts after the last combinator outside brackets.
    let (mut start, mut depth, mut i) = (0, 0usize, 0);
    while i < b.len() {
        match b[i] {
            q @ (b'"' | b'\'') => {
                i = skip_string(b, i, q);
                continue;
            }
            b'\\' => {
                i = skip_escape(b, i);
                continue;
            }
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth = depth.saturating_sub(1),
            b' ' | b'\t' | b'\n' | b'\r' | b'\x0c' | b'>' | b'+' | b'~' if depth == 0 => start = i + 1,
            _ => {}
        }
        i += 1;
    }
    let compound = &b[start.min(b.len())..];
    let mut i = 0;
    let mut nesting = false;
    while i < compound.len() {
        match compound[i] {
            b'&' => {
                nesting = true;
                i += 1;
            }
            b'*' => i += 1,
            b'.' | b'#' => {
                let (name, next) = ident(compound, i + 1);
                if name.is_empty() {
                    return true;
                }
                let name = name.to_lowercase();
                let found = if compound[i] == b'.' { present.classes.contains(&name) } else { present.ids.contains(&name) };
                if !found {
                    return false;
                }
                i = next;
            }
            b'[' | b'(' => {
                // An attribute selector: not followed. Skip it.
                let mut depth = 0usize;
                while i < compound.len() {
                    match compound[i] {
                        q @ (b'"' | b'\'') => {
                            i = skip_string(compound, i, q);
                            continue;
                        }
                        b'\\' => {
                            i = skip_escape(compound, i);
                            continue;
                        }
                        b'[' | b'(' => depth += 1,
                        b']' | b')' => {
                            depth -= 1;
                            if depth == 0 {
                                i += 1;
                                break;
                            }
                        }
                        _ => {}
                    }
                    i += 1;
                }
            }
            b':' => {
                // A pseudo-class or pseudo-element, with its arguments: not followed.
                i += 1;
                if compound.get(i) == Some(&b':') {
                    i += 1;
                }
                let (_, next) = ident(compound, i);
                i = next;
            }
            c if i == 0 && (c.is_ascii_alphabetic() || c == b'_' || c == b'-' || c >= 0x80 || c == b'\\') => {
                let (name, next) = ident(compound, i);
                if compound.get(next) == Some(&b'|') {
                    return true;
                }
                if !present.tags.contains(&name.to_ascii_lowercase()) {
                    return false;
                }
                i = next;
            }
            _ => return true,
        }
    }
    !nesting || parent != Some(false)
}

/// The identifier at `i`, unescaped, and the index after it.
fn ident(b: &[u8], mut i: usize) -> (String, usize) {
    let mut out = String::new();
    while i < b.len() {
        let c = b[i];
        if c == b'\\' {
            let end = skip_escape(b, i);
            let body = &b[i + 1..end.min(b.len())];
            let hex: Vec<u8> = body.iter().copied().take_while(|c| c.is_ascii_hexdigit()).collect();
            if !hex.is_empty() {
                let code = u32::from_str_radix(std::str::from_utf8(&hex).unwrap_or("0"), 16).unwrap_or(0xfffd);
                out.push(char::from_u32(code).filter(|_| code != 0).unwrap_or('\u{fffd}'));
            } else if let Some(s) = std::str::from_utf8(body).ok() {
                out.push_str(s);
            }
            i = end;
        } else if c.is_ascii_alphanumeric() || c == b'-' || c == b'_' {
            out.push(c as char);
            i += 1;
        } else if c >= 0x80 {
            // A multi-byte character: copy it whole.
            let len = match c {
                0xc0..=0xdf => 2,
                0xe0..=0xef => 3,
                _ => 4,
            };
            let end = (i + len).min(b.len());
            out.push_str(&String::from_utf8_lossy(&b[i..end]));
            i = end;
        } else {
            break;
        }
    }
    (out, i)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(classes: &[&str]) -> DomNode {
        let children: Vec<serde_json::Value> = classes
            .iter()
            .map(|c| serde_json::json!({ "kind": "element", "tag": "span", "path": "$0.0", "attrs": { "class": c } }))
            .collect();
        serde_json::from_value(serde_json::json!({
            "kind": "element", "tag": "section", "path": "$0", "attrs": { "id": "Main" }, "children": children
        }))
        .unwrap()
    }

    fn moves(css: &str, classes: &[&str]) -> bool {
        sheets_move(&[css.to_string()], &[&tree(classes)])
    }

    const TAILWIND: &str = r#"
        @layer theme { :root, :host { --default-transition-duration: 150ms; --animate-spin: spin 1s linear infinite; } }
        @layer utilities {
          .transition { transition-property: color, opacity; transition-duration: var(--tw-duration, var(--default-transition-duration)); }
          .animate-spin { animation: var(--animate-spin); }
          .hover\:transition-all { &:hover { @media (hover: hover) { transition-property: all; } } }
          .flex { display: flex; }
        }
        @keyframes spin { to { transform: rotate(360deg); animation-timing-function: linear; } }
        @property --tw-duration { syntax: "*"; inherits: false; }
        /* .flex { transition: all 1s } */
    "#;

    #[test]
    fn unused_rules_start_nothing() {
        assert!(!moves(TAILWIND, &["flex p-4"]));
        assert!(moves(TAILWIND, &["flex transition"]));
        assert!(moves(TAILWIND, &["animate-spin"]));
        assert!(moves(TAILWIND, &["hover:transition-all"]));
    }

    #[test]
    fn the_rightmost_compound_decides() {
        assert!(moves(".a .b { transition: opacity 1s }", &["b"]));
        assert!(!moves(".a .b { transition: opacity 1s }", &["a"]));
        assert!(!moves(".b.c { transition: opacity 1s }", &["b"]));
        assert!(moves(".b.c::before { transition: opacity 1s }", &["b c"]));
        assert!(moves("section { transition: opacity 1s }", &[]));
        assert!(moves("body > div { animation: x 1s }", &[]));
        assert!(!moves("p { transition: opacity 1s }", &[]));
        assert!(moves("#main { transition: opacity 1s }", &[]));
        assert!(!moves("#other { transition: opacity 1s }", &[]));
        assert!(!moves(".x { &:hover { transition: all } }", &[]));
        assert!(moves(".x { &:hover { transition: all } }", &["x"]));
        assert!(moves(".x { .y & { transition: all } }", &["x"]));
        assert!(moves("@media (min-width: 1px) { .y { animation: z 1s } }", &["y"]));
        assert!(!moves(".y { color: red; --transition: 1s; }", &["y"]));
    }

    #[test]
    fn what_is_not_followed_moves() {
        assert!(moves(":is(.q) { transition: opacity 1s }", &[]));
        assert!(moves("[data-x] { transition: opacity 1s }", &[]));
        assert!(moves("* { transition: opacity 1s }", &[]));
        assert!(moves("svg|rect { transition: opacity 1s }", &[]));
        assert!(moves(".a { transition: opacity 1s", &[]));
        assert!(moves("@import 'other.css'; .a { transition: opacity 1s }", &[]));
        assert!(moves("@starting-style { .a { opacity: 0 } } .t { transition: x }", &[]));
        assert!(moves(r".\31 0 { transition: opacity 1s }", &["10"]));
        assert!(!moves(r".\31 0 { transition: opacity 1s }", &["1"]));
        assert!(!moves("/* .flex { transition: all 1s } */ .flex { color: red }", &["flex"]));
        assert!(moves(".a { content: '}'; transition: all 1s }", &["a"]));
    }
}
