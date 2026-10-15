//! `layoutDom` (docs/COMPAT.md §5.1): CSS block and flex layout of a DOM
//! island by taffy, text measured by Parley. CPU only.

use kinetograph_core::dom_layout::{
    DomLayoutBox, DomLayoutError, DomLayoutRequest, TextSize, has_text, layout_dom as lay_out,
    measure_text,
};

use crate::error::{Code, Result, error, invalid};
use crate::layout::with_engine;

/// A `DomLayoutRequest` as JSON in, a `DomLayoutBox` as JSON out.
pub fn layout_dom(request_json: &str) -> Result<String> {
    let request: DomLayoutRequest = serde_json::from_str(request_json)
        .map_err(|e| invalid(format!("invalid layoutDom request: {e}")))?;
    for (what, v) in [
        ("width", request.available.width),
        ("height", request.available.height),
    ] {
        if !(v.is_finite() && v >= 0.0) {
            return Err(invalid(format!(
                "available {what} must be 0 or more, got {v}"
            )));
        }
    }
    let boxed: std::result::Result<DomLayoutBox, DomLayoutError> = if has_text(&request.root) {
        with_engine(&request.fonts, request.base_dir.as_deref(), |engine| {
            lay_out(&request, &mut |spec, max| {
                Ok(measure_text(engine, spec, max))
            })
        })?
    } else {
        lay_out(&request, &mut |_, _| {
            Ok(TextSize {
                width: 0.0,
                height: 0.0,
                baseline: 0.0,
            })
        })
    };
    let boxed = boxed.map_err(|e| match e {
        DomLayoutError::Invalid(m) => invalid(m),
        DomLayoutError::Layout(m) => error(Code::Render, format!("layout failed: {m}")),
    })?;
    serde_json::to_string(&boxed)
        .map_err(|e| error(Code::Render, format!("cannot write the layout: {e}")))
}
