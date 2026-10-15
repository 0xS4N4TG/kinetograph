//! `layoutDom` (docs/COMPAT.md §5.1): CSS block and flex layout of a DOM
//! island by taffy, text measured by Parley. CPU only.
//!
//! Also the full engine's DOM islands (docs/ENGINE.md §2): `renderDomIsland`,
//! `domLayoutBoxes` and `domComputedStyle`, which build a Blitz document from
//! an `IslandRequest`, style and lay it out with Stylo, taffy and Parley, and
//! paint it or read it back.

use kinetograph_core::dom_layout::{
    DomLayoutBox, DomLayoutError, DomLayoutRequest, TextSize, has_text, layout_dom as lay_out,
    measure_text,
};
use kinetograph_dom::document::{self, IslandDocument};
use kinetograph_dom::request::{IslandRequest, Unsupported};
use kinetograph_dom::{paint, readback};

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

// ---- the full engine's DOM islands (docs/ENGINE.md §2) ----

fn parse_island(request_json: &str, what: &str) -> Result<IslandRequest> {
    serde_json::from_str(request_json).map_err(|e| invalid(format!("invalid {what} request: {e}")))
}

/// Builds the island's document, styled and laid out at `request.time`. A
/// panic inside Stylo or Blitz becomes a `RENDER` error instead of taking the
/// process down.
fn resolve_island(request: &IslandRequest) -> Result<IslandDocument> {
    let built =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| document::resolve(request)));
    match built {
        Ok(Ok(island)) => Ok(island),
        Ok(Err(e)) => Err(error(Code::Render, e.to_string())),
        Err(panic) => {
            let message = panic
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".to_string());
            Err(error(Code::Render, format!("DOM layout failed: {message}")))
        }
    }
}

/// One DOM island at one frame: an `IslandRequest` as JSON in, an
/// `IslandOutput` as JSON out.
pub fn render_dom_island(request_json: &str) -> Result<String> {
    let request = parse_island(request_json, "renderDomIsland")?;
    let island = resolve_island(&request)?;
    let mut output = paint::paint(&island.doc, &request);
    // A file the island named that could not be read is not drawn as the
    // author meant: say so rather than draw a blank.
    for missing in &island.missing {
        output.unsupported.push(Unsupported {
            path: request.path.clone(),
            element: "resource".to_string(),
            property: None,
            value: Some(missing.clone()),
            reason: format!("cannot load a resource: {missing}"),
        });
    }
    serde_json::to_string(&output)
        .map_err(|e| error(Code::Render, format!("cannot write the island: {e}")))
}

/// The boxes of every element of the island (`getBoundingClientRect`,
/// `offsetWidth`, `clientWidth`, `scrollHeight`): `{ [path]: ElementBox }`.
pub fn dom_layout_boxes(request_json: &str) -> Result<String> {
    let request = parse_island(request_json, "domLayoutBoxes")?;
    let island = resolve_island(&request)?;
    serde_json::to_string(&readback::layout_boxes(&island))
        .map_err(|e| error(Code::Render, format!("cannot write the boxes: {e}")))
}

/// `getComputedStyle(element).getPropertyValue(p)` for each property, for the
/// element at `path`.
pub fn dom_computed_style(
    request_json: &str,
    path: &str,
    properties: &[String],
) -> Result<Vec<String>> {
    let request = parse_island(request_json, "domComputedStyle")?;
    let island = resolve_island(&request)?;
    readback::computed_style(&island, path, properties)
        .ok_or_else(|| invalid(format!("no element at path {path:?} in the island")))
}
