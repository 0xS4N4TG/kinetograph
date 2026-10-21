//! `layoutDom` (docs/COMPAT.md §5.1): CSS block and flex layout of a DOM
//! island by taffy, text measured by Parley. CPU only.
//!
//! Also the full engine's DOM islands (docs/ENGINE.md §2): `renderDomIsland`,
//! `domLayoutBoxes` and `domComputedStyle`, which build a Blitz document from
//! an `IslandRequest`, style and lay it out with Stylo, taffy and Parley, and
//! paint it or read it back.

use std::sync::mpsc::{Sender, channel};

use kinetograph_core::dom_layout::{
    DomLayoutBox, DomLayoutError, DomLayoutRequest, TextSize, has_text, layout_dom as lay_out,
    measure_text,
};
use kinetograph_dom::document::{self, IslandCache, IslandDocument};
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

/// An error made off the JS thread: the code and the message.
type Failure = (Code, String);

type Job = Box<dyn FnOnce() + Send>;

/// The stack of the island thread. Stylo and Blitz recurse over the tree, so
/// a deep DOM needs far more than a thread's default; the memory is only
/// reserved, and used as deep as the tree goes.
const ISLAND_STACK: usize = 512 * 1024 * 1024;

thread_local! {
    /// The island thread of the calling thread. A render worker (`render --concurrency`) is a thread of its own,
    /// and gets its own island thread, so that the workers' DOM work does not queue behind one another.
    static WORKER: std::cell::RefCell<Option<Sender<Job>>> = const { std::cell::RefCell::new(None) };
}

fn island_thread() -> Sender<Job> {
    WORKER.with(|slot| {
        let mut slot = slot.borrow_mut();
        if let Some(sender) = slot.as_ref() {
            return sender.clone();
        }
        let (sender, jobs) = channel::<Job>();
        std::thread::Builder::new()
            .name("kinetograph-dom".to_string())
            .stack_size(ISLAND_STACK)
            .spawn(move || {
                for job in jobs {
                    job();
                }
            })
            .expect("cannot start the DOM thread");
        *slot = Some(sender.clone());
        sender
    })
}

/// Runs `job` on the island thread and waits for it. One thread serves every
/// call of a calling thread, so Blitz's per-thread caches stay warm. A panic inside Stylo or
/// Blitz becomes a `RENDER` error instead of taking the process down.
fn on_island_thread<T: Send + 'static>(
    job: impl FnOnce() -> std::result::Result<T, Failure> + Send + 'static,
) -> Result<T> {
    let (done, result) = channel();
    let wrapped: Job = Box::new(move || {
        let outcome =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(job)).unwrap_or_else(|panic| {
                let message = panic
                    .downcast_ref::<&str>()
                    .map(|s| (*s).to_string())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "unknown panic".to_string());
                Err((Code::Render, format!("DOM layout failed: {message}")))
            });
        let _ = done.send(outcome);
    });
    if island_thread().send(wrapped).is_err() {
        return Err(error(Code::Render, "the DOM thread has stopped"));
    }
    match result.recv() {
        Ok(Ok(value)) => Ok(value),
        Ok(Err((code, message))) => Err(error(code, message)),
        Err(_) => Err(error(Code::Render, "the DOM thread has stopped")),
    }
}

fn parse_island(request_json: &str, what: &str) -> std::result::Result<IslandRequest, Failure> {
    document::parse_request(request_json)
        .map_err(|e| (Code::InvalidArg, format!("invalid {what} request: {e}")))
}

fn resolve_island(request: &IslandRequest) -> std::result::Result<IslandDocument, Failure> {
    document::resolve(request).map_err(|e| (Code::Render, e.to_string()))
}

thread_local! {
    /// The islands of the motion-blur sample pass in progress (`IslandCache`).
    static SAMPLES: std::cell::RefCell<IslandCache> = std::cell::RefCell::new(IslandCache::default());
}

/// One DOM island at one frame: an `IslandRequest` as JSON in, an
/// `IslandOutput` as JSON out. `pass` numbers the sub-frame renders of one
/// motion-blurred frame; the samples of a pass update one document per island
/// instead of building it again.
pub fn render_dom_island(request_json: &str, pass: Option<u64>) -> Result<String> {
    let json = request_json.to_string();
    on_island_thread(move || {
        let request = parse_island(&json, "renderDomIsland")?;
        let resolved = SAMPLES
            .with(|cache| cache.borrow_mut().resolve(&request, pass))
            .map_err(|e| (Code::Render, e.to_string()))?;
        let island = &resolved.island;
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
        SAMPLES.with(|cache| cache.borrow_mut().keep(request, resolved));
        serde_json::to_string(&output)
            .map_err(|e| (Code::Render, format!("cannot write the island: {e}")))
    })
}

/// The boxes of every element of the island (`getBoundingClientRect`,
/// `offsetWidth`, `clientWidth`, `scrollHeight`): `{ [path]: ElementBox }`.
pub fn dom_layout_boxes(request_json: &str) -> Result<String> {
    let json = request_json.to_string();
    on_island_thread(move || {
        let request = parse_island(&json, "domLayoutBoxes")?;
        let island = resolve_island(&request)?;
        serde_json::to_string(&readback::layout_boxes(&island))
            .map_err(|e| (Code::Render, format!("cannot write the boxes: {e}")))
    })
}

/// `getComputedStyle(element).getPropertyValue(p)` for each property, for the
/// element at `path`.
pub fn dom_computed_style(
    request_json: &str,
    path: &str,
    properties: &[String],
) -> Result<Vec<String>> {
    let (json, path, properties) = (
        request_json.to_string(),
        path.to_string(),
        properties.to_vec(),
    );
    on_island_thread(move || {
        let request = parse_island(&json, "domComputedStyle")?;
        let island = resolve_island(&request)?;
        readback::computed_style(&island, &path, &properties).ok_or_else(|| {
            (
                Code::InvalidArg,
                format!("no element at path {path:?} in the island"),
            )
        })
    })
}
