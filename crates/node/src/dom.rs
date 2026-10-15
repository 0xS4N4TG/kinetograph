//! `layoutDom` (docs/COMPAT.md §5.1): CSS block and flex layout of a DOM
//! island by taffy, text measured by Parley. CPU only. Stream 2.

use crate::error::{Code, Result, error};

/// A `DomLayoutRequest` as JSON in, a `DomLayoutBox` as JSON out.
pub fn layout_dom(_request_json: &str) -> Result<String> {
    Err(error(
        Code::Render,
        "not implemented: layoutDom (docs/COMPAT.md §5.1)",
    ))
}
