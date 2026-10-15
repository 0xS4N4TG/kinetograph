//! CSS that Stylo's Servo build does not parse, carried to the painter in
//! custom properties.
//!
//! This Stylo is built without Gecko's property set: `filter: url(#id)`,
//! `background-clip: text`, `-webkit-text-stroke`, `-webkit-text-fill-color`,
//! `paint-order`, `text-decoration-skip-ink`, `-webkit-line-clamp`,
//! `-webkit-box-orient` and `display: -webkit-box` are dropped as invalid. The
//! front half runs every stylesheet and every `style` attribute through
//! [`shim_css`] before it reaches the document, which writes the same value
//! into a custom property (`--kg-filter: url(#id) blur(2px)`) next to the
//! declaration, and calls [`register_properties`] once per document so those
//! properties do not inherit. The painter reads them back with
//! `Painter::kg_value`.

use blitz_dom::BaseDocument;

/// The properties that are mirrored, by CSS name.
const MIRRORED: &[&str] = &[
    "filter",
    "-webkit-filter",
    "background-clip",
    "-webkit-background-clip",
    "-webkit-text-stroke",
    "-webkit-text-stroke-width",
    "-webkit-text-stroke-color",
    "-webkit-text-fill-color",
    "paint-order",
    "text-decoration-skip-ink",
    "-webkit-line-clamp",
    "-webkit-box-orient",
    // Only the legacy `-webkit-box` values (see `is_mirrored`).
    "display",
];

/// The custom property that mirrors `name` (`filter` and `-webkit-filter`
/// share one; so do the two `background-clip`s).
pub fn kg_name(name: &str) -> String {
    let n = name.trim_start_matches("-webkit-");
    let n = match n {
        "text-stroke-width" | "text-stroke-color" | "text-stroke" => name.trim_start_matches('-'),
        _ => n,
    };
    format!("--kg-{n}")
}

/// Every custom property `shim_css` can write.
pub fn kg_properties() -> Vec<String> {
    let mut v: Vec<String> = MIRRORED.iter().map(|n| kg_name(n)).collect();
    v.sort();
    v.dedup();
    v
}

/// Registers the mirror properties as non-inherited (`@property`), so an
/// element only sees what it declared itself.
pub fn register_properties(doc: &mut BaseDocument) {
    for name in kg_properties() {
        doc.register_custom_property(&name, "*", false, None);
    }
}

/// Splits `s` at its top-level whitespace and commas, keeping groups in
/// parentheses and strings whole.
pub(super) fn top_level_words(s: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut depth = 0;
    let mut quote: Option<char> = None;
    for c in s.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => {
                cur.push(c);
                quote = None;
            }
            (Some(_), c) => cur.push(c),
            (None, '"' | '\'') => {
                quote = Some(c);
                cur.push(c);
            }
            (None, '(') => {
                depth += 1;
                cur.push(c);
            }
            (None, ')') => {
                depth -= 1;
                cur.push(c);
            }
            (None, c) if c.is_whitespace() && depth == 0 => {
                if !cur.is_empty() {
                    words.push(std::mem::take(&mut cur));
                }
            }
            (None, c) => cur.push(c),
        }
    }
    if !cur.is_empty() {
        words.push(cur);
    }
    words
}

/// Splits at top-level commas.
pub(super) fn split_commas(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut depth = 0;
    for c in s.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                out.push(std::mem::take(&mut cur));
                continue;
            }
            _ => {}
        }
        cur.push(c);
    }
    out.push(cur);
    out
}

/// The `url(...)` words of a `filter` value are removed from what Stylo is
/// given (it would drop the whole declaration).
fn without_urls(value: &str) -> String {
    let words = top_level_words(value);
    let kept: Vec<&String> = words.iter().filter(|w| !w.starts_with("url(")).collect();
    if kept.is_empty() {
        "none".to_string()
    } else {
        kept.iter()
            .map(|w| w.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// Rewrites a stylesheet or a declaration list so the mirrored properties
/// also appear as custom properties.
pub fn shim_css(css: &str) -> String {
    let bytes: Vec<char> = css.chars().collect();
    let mut out = String::with_capacity(css.len() + 64);
    let mut i = 0;
    // Whether the next token can start a declaration.
    let mut at_decl_start = true;
    let mut depth_paren = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == '/' && bytes.get(i + 1) == Some(&'*') {
            // A comment.
            let start = i;
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == '*' && bytes[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            out.extend(&bytes[start..i]);
            continue;
        }
        if c == '"' || c == '\'' {
            let start = i;
            i += 1;
            while i < bytes.len() && bytes[i] != c {
                if bytes[i] == '\\' {
                    i += 1;
                }
                i += 1;
            }
            i = (i + 1).min(bytes.len());
            out.extend(&bytes[start..i]);
            at_decl_start = false;
            continue;
        }
        if c == '(' {
            depth_paren += 1;
        }
        if c == ')' {
            depth_paren -= 1;
        }
        if depth_paren == 0 && (c == '{' || c == ';' || c == '}') {
            out.push(c);
            i += 1;
            at_decl_start = true;
            continue;
        }
        if at_decl_start && (c.is_ascii_alphabetic() || c == '-') {
            // A property name?
            let mut j = i;
            while j < bytes.len()
                && (bytes[j].is_ascii_alphanumeric() || bytes[j] == '-' || bytes[j] == '_')
            {
                j += 1;
            }
            let name: String = bytes[i..j].iter().collect();
            let mut k = j;
            while k < bytes.len() && bytes[k].is_whitespace() {
                k += 1;
            }
            if bytes.get(k) == Some(&':') && MIRRORED.contains(&name.to_ascii_lowercase().as_str())
            {
                // The value runs to the next top-level `;` or `}`.
                let vstart = k + 1;
                let mut e = vstart;
                let mut depth = 0;
                let mut quote: Option<char> = None;
                while e < bytes.len() {
                    let ch = bytes[e];
                    match quote {
                        Some(q) => {
                            if ch == '\\' {
                                e += 1;
                            } else if ch == q {
                                quote = None;
                            }
                        }
                        None => match ch {
                            '"' | '\'' => quote = Some(ch),
                            '(' => depth += 1,
                            ')' => depth -= 1,
                            ';' | '}' if depth == 0 => break,
                            _ => {}
                        },
                    }
                    e += 1;
                }
                let raw: String = bytes[vstart..e].iter().collect();
                let value = raw.trim();
                let (important, value) = match value.strip_suffix("!important") {
                    Some(v) => (" !important", v.trim()),
                    None => ("", value),
                };
                let lname = name.to_ascii_lowercase();
                // Every `display` is parsed by Stylo; only the legacy box values are not.
                if lname == "display" && !value.to_ascii_lowercase().starts_with("-webkit-") {
                    out.extend(&bytes[i..e]);
                    i = e;
                    at_decl_start = false;
                    continue;
                }
                // What Stylo is given: the value, less the `url()`s of a filter.
                let for_stylo =
                    if (lname == "filter" || lname == "-webkit-filter") && value.contains("url(") {
                        without_urls(value)
                    } else {
                        value.to_string()
                    };
                out.push_str(&format!("{name}:{for_stylo}{important};"));
                out.push_str(&format!("{}:{}{}", kg_name(&lname), value, important));
                i = e;
                at_decl_start = false;
                continue;
            }
        }
        if !c.is_whitespace() {
            at_decl_start = false;
        }
        out.push(c);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mirrors_a_declaration_list() {
        let s = shim_css("color:red; background-clip: text; width:3px");
        assert!(s.contains("--kg-background-clip:text"), "{s}");
        assert!(s.contains("color:red;"), "{s}");
        assert!(s.ends_with("width:3px"), "{s}");
    }

    #[test]
    fn a_filter_with_a_url_keeps_the_rest_for_stylo() {
        let s = shim_css("a{filter:url(#torn) blur(2px)}");
        assert!(s.contains("filter:blur(2px);"), "{s}");
        assert!(s.contains("--kg-filter:url(#torn) blur(2px)"), "{s}");
        let s = shim_css("a{filter: url(#only)}");
        assert!(s.contains("filter:none;"), "{s}");
    }

    #[test]
    fn the_legacy_box_properties_are_mirrored_but_other_displays_are_not() {
        let s = shim_css("a{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}");
        assert!(s.contains("--kg-display:-webkit-box"), "{s}");
        assert!(s.contains("--kg-box-orient:vertical"), "{s}");
        assert!(s.contains("--kg-line-clamp:2"), "{s}");
        let s = shim_css("a{display:flex;color:red}");
        assert_eq!(s, "a{display:flex;color:red}");
    }

    #[test]
    fn names_share_one_property() {
        assert_eq!(kg_name("-webkit-background-clip"), "--kg-background-clip");
        assert_eq!(kg_name("filter"), "--kg-filter");
        assert_eq!(kg_name("-webkit-text-stroke"), "--kg-webkit-text-stroke");
    }

    #[test]
    fn urls_and_strings_are_left_alone() {
        let s = shim_css("a{background:url(\"x;filter:y\")}");
        assert_eq!(s, "a{background:url(\"x;filter:y\")}");
    }
}
