//! `layoutDom`: CSS block and flex layout of a DOM
//! island by taffy, text measured by Parley. CPU only.
//!
//! Also the full engine's DOM islands (packages/cli/skills/kinetograph/references/ENGINE.md §2): `renderDomIsland`,
//! `domLayoutBoxes` and `domComputedStyle`, which build a Blitz document from
//! an `IslandRequest`, style and lay it out with Stylo, taffy and Parley, and
//! paint it or read it back.

use std::collections::HashMap;
use std::sync::mpsc::{Receiver, Sender, channel};

use kinetograph_core::dom_layout::{
    DomLayoutBox, DomLayoutError, DomLayoutRequest, TextSize, has_text, layout_dom as lay_out,
    measure_text,
};
use kinetograph_dom::document::{self, BuildError, IslandCache, IslandDocument, Resolved};
use kinetograph_dom::readback;
use kinetograph_dom::request::{self, IslandRequest, Unsupported};
use serde_json::Value;

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

// ---- the full engine's DOM islands (packages/cli/skills/kinetograph/references/ENGINE.md §2) ----

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
    stages: Stages,
    job: impl FnOnce() -> std::result::Result<T, Failure> + Send + 'static,
) -> Result<T> {
    let timer = kinetograph_core::profile::start();
    let outcome = start_on_island_thread(stages, job)?;
    let answer = wait_for(outcome);
    kinetograph_core::profile::add_since(stages.wait, timer);
    answer
}

/// The profile stages of a kind of job on the island thread: the time from queueing it to its start (`hop`), the job
/// itself (`job`), and the calling thread's whole wait for it (`wait`, for a job it waits for at once). The wait less
/// the job is the cost of handing the job over and back.
#[derive(Clone, Copy)]
struct Stages {
    hop: &'static str,
    job: &'static str,
    wait: &'static str,
}

const RENDER_STAGES: Stages = Stages {
    hop: "n_hop",
    job: "n_job",
    wait: "n_wait",
};
const READBACK_STAGES: Stages = Stages {
    hop: "rb_hop",
    job: "rb_job",
    wait: "rb_wait_dom",
};

/// What a job started on the island thread will send.
type Outcome<T> = Receiver<std::result::Result<T, Failure>>;

/// Queues `job` on the island thread, after the jobs queued before it, and
/// returns where its result will come.
fn start_on_island_thread<T: Send + 'static>(
    stages: Stages,
    job: impl FnOnce() -> std::result::Result<T, Failure> + Send + 'static,
) -> Result<Outcome<T>> {
    let (done, result) = channel();
    let queued = kinetograph_core::profile::start();
    let caller = queued.map(|_| kinetograph_core::profile::caller());
    let wrapped: Job = Box::new(move || {
        let timer = kinetograph_core::profile::start();
        if let Some(caller) = &caller {
            kinetograph_core::profile::add_for_since(caller, stages.hop, queued);
        }
        let outcome =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(job)).unwrap_or_else(|panic| {
                let message = panic
                    .downcast_ref::<&str>()
                    .map(|s| (*s).to_string())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "unknown panic".to_string());
                Err((Code::Render, format!("DOM layout failed: {message}")))
            });
        if let Some(caller) = &caller {
            kinetograph_core::profile::add_for_since(caller, stages.job, timer);
        }
        let _ = done.send(outcome);
    });
    if island_thread().send(wrapped).is_err() {
        return Err(error(Code::Render, "the DOM thread has stopped"));
    }
    Ok(result)
}

fn wait_for<T>(result: Outcome<T>) -> Result<T> {
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

/// Documents kept from one render or readback to the next (`IslandCache`), with the text of the request each was
/// resolved from: a request with the same text is answered from its document as it is, with no parse of it, no edit
/// and no restyle. A frame's scripts read the layout of the tree they leave, and the frame then draws that same tree:
/// the readback and the render share one document.
#[derive(Default)]
struct Islands {
    cache: IslandCache,
    /// Island path → the text of the request its kept document shows.
    sources: HashMap<String, String>,
}

impl Islands {
    /// The path of the kept document resolved from exactly `json`.
    fn path_of(&self, json: &str) -> Option<&str> {
        let (path, _) = self.sources.iter().find(|(_, text)| text.as_str() == json)?;
        Some(path)
    }

    /// The kept document resolved from exactly `json` in `pass`.
    fn same(&mut self, json: &str, pass: Option<u64>) -> Option<&Resolved> {
        self.cache.enter(pass);
        let path = self.path_of(json)?;
        self.cache.peek(path)
    }

    /// The kept document resolved from exactly `json` in `pass`, and its request, taken out: hand them back to `keep`.
    fn take(&mut self, json: &str, pass: Option<u64>) -> Option<(IslandRequest, Resolved)> {
        self.cache.enter(pass);
        let path = self.path_of(json)?.to_string();
        self.sources.remove(&path);
        self.cache.take(&path)
    }

    /// The kept document of the island edited to `request` in `pass`, or a new one (`IslandCache::resolve`). Hand it
    /// back to `keep`.
    fn resolve(
        &mut self,
        request: &IslandRequest,
        pass: Option<u64>,
    ) -> std::result::Result<Resolved, BuildError> {
        self.sources.remove(&request.path);
        self.cache.resolve(request, pass)
    }

    fn keep(&mut self, request: IslandRequest, json: String, resolved: Resolved) {
        let path = request.path.clone();
        self.cache.keep(request, resolved);
        if self.cache.peek(&path).is_some() {
            self.sources.insert(path, json);
        } else {
            self.sources.remove(&path);
        }
    }
}

thread_local! {
    /// The islands of the pass in progress: the frame's renders, its motion-blur samples' and its scripts' readbacks.
    static SAMPLES: std::cell::RefCell<Islands> = std::cell::RefCell::new(Islands::default());
    /// The first layers each island drew in the pass in progress, which the
    /// later renders of the pass are written against (`request::delta`).
    static BASES: std::cell::RefCell<(Option<u64>, Bases)> =
        std::cell::RefCell::new((None, HashMap::new()));
}

/// Layers by island path.
type Bases = HashMap<String, Vec<Value>>;

/// One DOM island at one frame: an `IslandRequest` as JSON in, an
/// `IslandOutput` as JSON out. `pass` numbers the renders of one frame, its
/// motion-blur sub-frames included: they update one document per island
/// instead of building it again, and each render after an island's first
/// gives its layers as changes from that first's (`delta`).
pub fn render_dom_island(request_json: &str, pass: Option<u64>) -> Result<String> {
    wait_for(start_dom_island(request_json, pass)?)
}

thread_local! {
    /// The island renders started on the calling thread and not yet finished, by ticket.
    static STARTED: std::cell::RefCell<(u32, HashMap<u32, Outcome<String>>)> =
        std::cell::RefCell::new((0, HashMap::new()));
}

/// `render_dom_island` without waiting: the render is queued on the island
/// thread after the ones before it, and the ticket returned finishes it
/// (`finish_dom_island`). The caller can build what comes next meanwhile.
pub fn start_island(request_json: &str, pass: Option<u64>) -> Result<u32> {
    let outcome = start_dom_island(request_json, pass)?;
    Ok(STARTED.with(|started| {
        let (next, pending) = &mut *started.borrow_mut();
        *next = next.wrapping_add(1);
        pending.insert(*next, outcome);
        *next
    }))
}

/// The `IslandOutput` of a render `start_island` queued, once it is done.
pub fn finish_island(ticket: u32) -> Result<String> {
    let outcome = STARTED.with(|started| started.borrow_mut().1.remove(&ticket));
    match outcome {
        Some(outcome) => wait_for(outcome),
        None => Err(invalid(format!("no island render was started as {ticket}"))),
    }
}

fn start_dom_island(request_json: &str, pass: Option<u64>) -> Result<Outcome<String>> {
    let json = request_json.to_string();
    let caller = kinetograph_core::profile::caller();
    start_on_island_thread(RENDER_STAGES, move || {
        use kinetograph_core::profile::{add_for_since, add_shared_since};
        // The tree the frame's scripts read last is drawn from the document they read.
        let (request, mut resolved) = match SAMPLES.with(|islands| islands.borrow_mut().take(&json, pass)) {
            Some(kept) => {
                kinetograph_core::profile::add_for(&caller, "n_reused", 1.0);
                kept
            }
            None => {
                let timer = kinetograph_core::profile::start();
                let request = parse_island(&json, "renderDomIsland")?;
                add_shared_since("dom_parse", timer);
                add_for_since(&caller, "n_parse", timer);
                let timer = kinetograph_core::profile::start();
                let (was_edited, was_built) = SAMPLES.with(|islands| islands.borrow().cache.counts());
                let resolved = SAMPLES
                    .with(|islands| islands.borrow_mut().resolve(&request, pass))
                    .map_err(|e| (Code::Render, e.to_string()))?;
                add_shared_since("dom_resolve", timer);
                add_for_since(&caller, "n_resolve", timer);
                let (edited, built) = SAMPLES.with(|islands| islands.borrow().cache.counts());
                kinetograph_core::profile::add_for(&caller, "n_edited", (edited - was_edited) as f64);
                kinetograph_core::profile::add_for(&caller, "n_built", (built - was_built) as f64);
                (request, resolved)
            }
        };
        let timer = kinetograph_core::profile::start();
        let mut output = resolved.paint(&request);
        add_shared_since("dom_paint", timer);
        add_for_since(&caller, "n_paint", timer);
        let write_timer = kinetograph_core::profile::start();
        let island = &resolved.island;
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
        let path = request.path.clone();
        SAMPLES.with(|islands| islands.borrow_mut().keep(request, json, resolved));
        // The first render of an island in the pass is kept, once written,
        // for the later ones to be written against.
        let (mut delta, mut first) = (false, None);
        if pass.is_some() {
            BASES.with(|bases| {
                let (at, bases) = &mut *bases.borrow_mut();
                if *at != pass {
                    bases.clear();
                    *at = pass;
                }
                match bases.get(&path) {
                    Some(base) => {
                        output.layers = request::delta(std::mem::take(&mut output.layers), base);
                        delta = true;
                    }
                    None => first = Some(path),
                }
            });
        }
        let mut json = serde_json::to_string(&output)
            .map_err(|e| (Code::Render, format!("cannot write the island: {e}")))?;
        if delta {
            // The output is an object: say that its layers are changes.
            json.pop();
            json.push_str(r#","delta":true}"#);
        }
        if let Some(path) = first {
            BASES.with(|bases| bases.borrow_mut().1.insert(path, output.layers));
        }
        kinetograph_core::profile::add_shared_since("dom_write", write_timer);
        kinetograph_core::profile::add_for_since(&caller, "n_write", write_timer);
        Ok(json)
    })
}

thread_local! {
    /// The islands of the readbacks made outside a pass (a frame skipped or replayed, a measurement), and the number
    /// of the last: each is a pass of its own, which edits the document the one before left.
    static READBACK: std::cell::RefCell<(Islands, u64)> = std::cell::RefCell::new((Islands::default(), 0));
}

/// Runs `read` on the island of `json`. A page reads thousands of styles of one tree, and the tree changes between
/// some of the reads (a script writes a style): the same request is answered from the document as it is, and a changed
/// one edits that document to the new tree, so only what changed is restyled. In a pass (`pass`, the frame's), the
/// document is the one the frame's render draws, kept from the frame before; outside one, the readbacks' own.
fn with_readback_island<T>(
    caller: &str,
    json: String,
    pass: Option<u64>,
    what: &str,
    read: impl FnOnce(&IslandDocument) -> std::result::Result<T, Failure>,
) -> std::result::Result<T, Failure> {
    let answer = |islands: &mut Islands, json: String, pass: Option<u64>| {
        use kinetograph_core::profile::{add_for, add_for_since, start};
        if let Some(kept) = islands.same(&json, pass) {
            add_for(caller, "rb_same", 1.0);
            let timer = start();
            let answer = read(&kept.island);
            add_for_since(caller, "rb_read", timer);
            return answer;
        }
        add_for(caller, "rb_bytes", json.len() as f64);
        let timer = start();
        let request = parse_island(&json, what)?;
        add_for_since(caller, "rb_parse", timer);
        let timer = start();
        let (was_edited, _) = islands.cache.counts();
        let resolved = islands
            .resolve(&request, pass)
            .map_err(|e| (Code::Render, e.to_string()))?;
        add_for_since(caller, "rb_resolve", timer);
        add_for(caller, "rb_edited", (islands.cache.counts().0 - was_edited) as f64);
        let timer = start();
        let answer = read(&resolved.island);
        add_for_since(caller, "rb_read", timer);
        islands.keep(request, json, resolved);
        answer
    };
    match pass {
        Some(_) => SAMPLES.with(|islands| answer(&mut islands.borrow_mut(), json, pass)),
        None => READBACK.with(|state| {
            let (islands, last) = &mut *state.borrow_mut();
            // A request seen last is read where it is; any other is the next pass.
            if islands.same(&json, Some(*last)).is_none() {
                *last += 1;
            }
            answer(islands, json, Some(*last))
        }),
    }
}

/// The boxes of every element of the island (`getBoundingClientRect`,
/// `offsetWidth`, `clientWidth`, `scrollHeight`): `{ [path]: ElementBox }`.
pub fn dom_layout_boxes(request_json: &str, pass: Option<u64>) -> Result<String> {
    let json = request_json.to_string();
    let caller = kinetograph_core::profile::caller();
    on_island_thread(READBACK_STAGES, move || {
        with_readback_island(&caller, json, pass, "domLayoutBoxes", |island| {
            serde_json::to_string(&readback::layout_boxes(island))
                .map_err(|e| (Code::Render, format!("cannot write the boxes: {e}")))
        })
    })
}

/// `getComputedStyle(element).getPropertyValue(p)` for each property, for the
/// element at `path`.
pub fn dom_computed_style(
    request_json: &str,
    path: &str,
    properties: &[String],
    pass: Option<u64>,
) -> Result<Vec<String>> {
    let (json, path, properties) = (
        request_json.to_string(),
        path.to_string(),
        properties.to_vec(),
    );
    let caller = kinetograph_core::profile::caller();
    on_island_thread(READBACK_STAGES, move || {
        with_readback_island(&caller, json, pass, "domComputedStyle", |island| {
            readback::computed_style(island, &path, &properties).ok_or_else(|| {
                (
                    Code::InvalidArg,
                    format!("no element at path {path:?} in the island"),
                )
            })
        })
    })
}
