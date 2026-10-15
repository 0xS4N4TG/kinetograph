//! The user-agent stylesheet: Blitz's (Gecko's `html.css`, which has Chrome's
//! element defaults: block elements, heading sizes and margins, `b`, `i`,
//! lists, form controls) plus the few rules where Chrome's UA sheet differs
//! or the island needs its own.

pub const KINETOGRAPH_UA: &str = r#"
/* The island sits in a page with no margin, as Remotion's page does. */
html, body { margin: 0; padding: 0; }

/* Chrome: svg:not(:root), symbol, image, marker, pattern, foreignObject clip their overflow. */
svg:not(:root), symbol, image, marker, pattern, foreignObject { overflow: hidden; }

/* A native kg-* element is a box of its given size. */
kg-native { display: block; }

/* Chrome shows no marker box for these. */
template, script, noscript { display: none; }
"#;

/// The UA sheets in cascade order.
pub fn sheets() -> Vec<String> {
    vec![blitz_dom::DEFAULT_CSS.to_string(), KINETOGRAPH_UA.to_string()]
}
