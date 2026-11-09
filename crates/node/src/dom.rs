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
use kinetograph_dom::document::{
    self, BuildError, EditsError, IslandCache, IslandDocument, Resolved,
};
use kinetograph_dom::readback;
use kinetograph_dom::request::{self, IslandEdits, IslandRequest, Unsupported};

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

/// Documents kept from one render or readback to the next (`IslandCache`), with what the caller knows each as
/// (`Source`): a request with the same text, or edits of the same number, is answered from its document as it is, with
/// no parse of it, no edit and no restyle. A frame's scripts read the layout of the tree they leave, and the frame then
/// draws that same tree: the readback and the render share one document.
#[derive(Default)]
struct Islands {
    cache: IslandCache,
    /// Island path → what its kept document shows.
    sources: HashMap<String, Source>,
}

/// What a kept document shows: the request of this text (none once edits were made to it), and the state the caller
/// numbered so (`IslandEdits::stamp`), when it did.
#[derive(Default)]
struct Source {
    text: Option<String>,
    stamp: Option<u64>,
}

impl Islands {
    /// The path of the kept document resolved from exactly `json`.
    fn path_of(&self, json: &str) -> Option<&str> {
        let (path, _) = self
            .sources
            .iter()
            .find(|(_, source)| source.text.as_deref() == Some(json))?;
        Some(path)
    }

    /// The kept document of what `asked` names, as it is, in `pass`. A request of the text it shows that numbers its
    /// state gives the document that number.
    fn same(&mut self, asked: &Asked, pass: Option<u64>) -> Option<&Resolved> {
        self.cache.enter(pass);
        let path = match asked {
            Asked::Request { text, stamp } => {
                let path = self.path_of(text)?.to_string();
                if stamp.is_some() {
                    self.sources.get_mut(&path)?.stamp = *stamp;
                }
                path
            }
            Asked::Edits(edits) => {
                let source = self.sources.get(&edits.path)?;
                (source.stamp == Some(edits.stamp)).then(|| edits.path.clone())?
            }
        };
        self.cache.peek(&path)
    }

    /// The kept document of what `asked` names, as it is, in `pass`, its request and the caller's number for its
    /// state, taken out: hand them back to `keep`.
    fn take(
        &mut self,
        asked: &Asked,
        pass: Option<u64>,
    ) -> Option<(IslandRequest, Resolved, Option<u64>)> {
        self.same(asked, pass)?;
        let path = match asked {
            Asked::Request { text, .. } => self.path_of(text)?.to_string(),
            Asked::Edits(edits) => edits.path.clone(),
        };
        let stamp = self.sources.remove(&path).and_then(|source| source.stamp);
        let (request, resolved) = self.cache.take(&path)?;
        Some((request, resolved, stamp))
    }

    /// The kept document of the island edited to `request` in `pass`, or a new one (`IslandCache::resolve`), and the
    /// caller's number for its state when the request is the one the kept document showed (its text came another way:
    /// a render's request of the tree a readback sent as edits). Hand them back to `keep`.
    fn resolve(
        &mut self,
        request: &IslandRequest,
        pass: Option<u64>,
    ) -> std::result::Result<(Resolved, Option<u64>), BuildError> {
        self.cache.enter(pass);
        let stamp = self
            .sources
            .remove(&request.path)
            .and_then(|source| source.stamp);
        let stamp = stamp.filter(|_| self.cache.request(&request.path) == Some(request));
        Ok((self.cache.resolve(request, pass)?, stamp))
    }

    /// The kept document of the state `edits.base` with `edits` made to it in `pass`, and its request
    /// (`IslandCache::resolve_edits`). Hand them back to `keep`. A `STALE_BASE` error when that state is not the one
    /// kept, or the edits do not fit it: the caller sends the whole request instead.
    fn resolve_edits(
        &mut self,
        edits: &IslandEdits,
        pass: Option<u64>,
    ) -> std::result::Result<(IslandRequest, Resolved), Failure> {
        self.cache.enter(pass);
        let stale = |why: String| (Code::StaleBase, format!("{why}: send the whole request"));
        let held = self
            .sources
            .get(&edits.path)
            .and_then(|source| source.stamp);
        if held != Some(edits.base) {
            let why = format!("island {} is not kept as state {}", edits.path, edits.base);
            return Err(stale(why));
        }
        let resolved = self.cache.resolve_edits(edits, pass).map_err(|e| match e {
            EditsError::Stale(why) => stale(why),
            EditsError::Build(e) => (Code::Render, e.to_string()),
        })?;
        self.sources.remove(&edits.path);
        Ok(resolved)
    }

    fn keep(&mut self, request: IslandRequest, source: Source, resolved: Resolved) {
        let path = request.path.clone();
        self.cache.keep(request, resolved);
        if self.cache.peek(&path).is_some() {
            self.sources.insert(path, source);
        } else {
            self.sources.remove(&path);
        }
    }
}

/// What a readback is asked of: a request, or edits to a state of the island the caller sent before. A request whose
/// state the caller numbers comes as `{"stamp":N,"request":REQUEST}`.
enum Asked<'a> {
    Request { text: &'a str, stamp: Option<u64> },
    Edits(IslandEdits),
}

fn asked<'a>(json: &'a str, what: &str) -> std::result::Result<Asked<'a>, Failure> {
    let Some(rest) = json.strip_prefix(r#"{"stamp":"#) else {
        return Ok(Asked::Request {
            text: json,
            stamp: None,
        });
    };
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    let request = rest[digits..]
        .strip_prefix(r#","request":"#)
        .and_then(|r| r.strip_suffix('}'));
    if let (Ok(stamp), Some(text)) = (rest[..digits].parse(), request) {
        return Ok(Asked::Request {
            text,
            stamp: Some(stamp),
        });
    }
    serde_json::from_str(json)
        .map(Asked::Edits)
        .map_err(|e| (Code::InvalidArg, format!("invalid {what} edits: {e}")))
}

thread_local! {
    /// The islands of the pass in progress: the frame's renders, its motion-blur samples' and its scripts' readbacks.
    static SAMPLES: std::cell::RefCell<Islands> = std::cell::RefCell::new(Islands::default());
    /// The layers each island's renders are written against (`request::delta`), by island path, and the pass in
    /// progress.
    static BASES: std::cell::RefCell<(Option<u64>, HashMap<String, Base>)> =
        std::cell::RefCell::new((None, HashMap::new()));
}

/// The layers of an island's first render in `pass`, or of its last render written in full, as written. The caller
/// holds the same layers (it names their pass), and the renders after them are written as changes from them, in that
/// pass and the next.
struct Base {
    pass: u64,
    layers: Vec<request::Written>,
}

/// Moves the bases to `pass`, as `IslandCache::enter` moves the documents: the pass after the last keeps the bases the
/// last made, any other none.
fn enter_bases(at: &mut Option<u64>, bases: &mut HashMap<String, Base>, pass: Option<u64>) {
    if *at == pass {
        return;
    }
    match (*at, pass) {
        (Some(was), Some(now)) if now == was.wrapping_add(1) => bases.retain(|_, b| b.pass == was),
        _ => bases.clear(),
    }
    *at = pass;
}

/// One DOM island at one frame: an `IslandRequest` as JSON in, an
/// `IslandOutput` as JSON out. `pass` numbers the renders of one frame, its
/// motion-blur sub-frames included: they update one document per island
/// instead of building it again. `base` is the pass of the layers of this island the caller holds (`Base`): when they
/// are the ones kept here, the layers come back as changes from them (`delta`), with `"delta": base`.
pub fn render_dom_island(
    request_json: &str,
    pass: Option<u64>,
    base: Option<u64>,
) -> Result<String> {
    wait_for(start_dom_island(request_json, pass, base)?)
}

thread_local! {
    /// The island renders started on the calling thread and not yet finished, by ticket.
    static STARTED: std::cell::RefCell<(u32, HashMap<u32, Outcome<String>>)> =
        std::cell::RefCell::new((0, HashMap::new()));
}

/// `render_dom_island` without waiting: the render is queued on the island
/// thread after the ones before it, and the ticket returned finishes it
/// (`finish_dom_island`). The caller can build what comes next meanwhile.
pub fn start_island(request_json: &str, pass: Option<u64>, base: Option<u64>) -> Result<u32> {
    let outcome = start_dom_island(request_json, pass, base)?;
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

fn start_dom_island(
    request_json: &str,
    pass: Option<u64>,
    base: Option<u64>,
) -> Result<Outcome<String>> {
    let json = request_json.to_string();
    let caller = kinetograph_core::profile::caller();
    start_on_island_thread(RENDER_STAGES, move || {
        use kinetograph_core::profile::{add_for_since, add_shared_since};
        // A request, or the state a readback of the frame left (edits that change nothing).
        let asked = asked(&json, "renderDomIsland")?;
        if let Asked::Edits(edits) = &asked
            && !(edits.set.is_empty() && edits.stamp == edits.base)
        {
            return Err((
                Code::InvalidArg,
                "a render names the state a readback left, with no edits".to_string(),
            ));
        }
        // The text of the request, kept when it came as one.
        let whole = matches!(asked, Asked::Request { stamp: None, .. });
        // The tree the frame's scripts read last is drawn from the document they read.
        let (request, mut resolved, stamp) = match SAMPLES
            .with(|islands| islands.borrow_mut().take(&asked, pass))
        {
            Some(kept) => {
                kinetograph_core::profile::add_for(&caller, "n_reused", 1.0);
                kept
            }
            None => {
                let Asked::Request { text, .. } = asked else {
                    let message =
                        "the island is not kept as the state named: send the whole request";
                    return Err((Code::StaleBase, message.to_string()));
                };
                let timer = kinetograph_core::profile::start();
                let request = parse_island(text, "renderDomIsland")?;
                add_shared_since("dom_parse", timer);
                add_for_since(&caller, "n_parse", timer);
                let timer = kinetograph_core::profile::start();
                let (was_edited, was_built) =
                    SAMPLES.with(|islands| islands.borrow().cache.counts());
                let (resolved, stamp) = SAMPLES
                    .with(|islands| islands.borrow_mut().resolve(&request, pass))
                    .map_err(|e| (Code::Render, e.to_string()))?;
                add_shared_since("dom_resolve", timer);
                add_for_since(&caller, "n_resolve", timer);
                let (edited, built) = SAMPLES.with(|islands| islands.borrow().cache.counts());
                kinetograph_core::profile::add_for(
                    &caller,
                    "n_edited",
                    (edited - was_edited) as f64,
                );
                kinetograph_core::profile::add_for(&caller, "n_built", (built - was_built) as f64);
                (request, resolved, stamp)
            }
        };
        let timer = kinetograph_core::profile::start();
        let mut output = resolved.paint(&request);
        add_shared_since("dom_paint", timer);
        add_for_since(&caller, "n_paint", timer);
        take_counters(&caller);
        if crate::dom_verify::enabled() {
            crate::dom_verify::check_render(&json, &request, &resolved.island, &output)?;
        }
        let (replayed, painted) = resolved.replayed();
        kinetograph_core::profile::add_for(&caller, "n_sc_replayed", replayed as f64);
        kinetograph_core::profile::add_for(&caller, "n_sc_painted", painted as f64);
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
        SAMPLES.with(|islands| {
            let source = Source {
                text: whole.then_some(json),
                stamp,
            };
            islands.borrow_mut().keep(request, source, resolved)
        });
        // Written as changes from the layers the caller holds, when they are the ones kept here; the island's first
        // render of the pass, and one written in full, are kept for the later ones to be written against.
        let write = |e: serde_json::Error| (Code::Render, format!("cannot write the island: {e}"));
        let layers = request::written(&output.layers).map_err(write)?;
        let (mut json, mut keep_base) = (None, None);
        if let Some(now) = pass {
            BASES.with(|bases| {
                let (at, bases) = &mut *bases.borrow_mut();
                enter_bases(at, bases, pass);
                let kept = bases.get(&path).filter(|kept| Some(kept.pass) == base);
                json = kept.map(|kept| {
                    request::write_output(&output, &layers, Some((&kept.layers, kept.pass)))
                });
                if kept.is_none_or(|kept| kept.pass != now) {
                    keep_base = Some(now);
                }
            });
        }
        let json = json
            .unwrap_or_else(|| request::write_output(&output, &layers, None))
            .map_err(write)?;
        if let Some(pass) = keep_base {
            BASES.with(|bases| bases.borrow_mut().1.insert(path, Base { pass, layers }));
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
/// one edits that document to the new tree, so only what changed is restyled. The change can come as the edits a
/// script made since a state sent before (`Asked::Edits`), which skips writing, sending, parsing and comparing the
/// whole tree. In a pass (`pass`, the frame's), the document is the one the frame's render draws, kept from the frame
/// before; outside one, the readbacks' own.
fn with_readback_island<T>(
    caller: &str,
    json: String,
    pass: Option<u64>,
    what: &str,
    read: impl FnOnce(&IslandDocument) -> std::result::Result<T, Failure>,
) -> std::result::Result<T, Failure> {
    let asked = asked(&json, what)?;
    let answer = |islands: &mut Islands, asked: Asked, pass: Option<u64>| {
        use kinetograph_core::profile::{add_for, add_for_since, start};
        if let Some(kept) = islands.same(&asked, pass) {
            add_for(caller, "rb_same", 1.0);
            let timer = start();
            let answer = read(&kept.island);
            add_for_since(caller, "rb_read", timer);
            return answer;
        }
        let (was_edited, _) = islands.cache.counts();
        let (request, source, resolved) = match asked {
            Asked::Request { text, stamp } => {
                add_for(caller, "rb_bytes", text.len() as f64);
                let timer = start();
                let request = parse_island(text, what)?;
                add_for_since(caller, "rb_parse", timer);
                let timer = start();
                let (resolved, held) = islands
                    .resolve(&request, pass)
                    .map_err(|e| (Code::Render, e.to_string()))?;
                add_for_since(caller, "rb_resolve", timer);
                let source = Source {
                    text: Some(text.to_string()),
                    stamp: stamp.or(held),
                };
                (request, source, resolved)
            }
            Asked::Edits(edits) => {
                add_for(caller, "rb_edits", 1.0);
                let timer = start();
                let (request, resolved) = islands.resolve_edits(&edits, pass)?;
                add_for_since(caller, "rb_resolve", timer);
                let source = Source {
                    text: None,
                    stamp: Some(edits.stamp),
                };
                (request, source, resolved)
            }
        };
        add_for(
            caller,
            "rb_edited",
            (islands.cache.counts().0 - was_edited) as f64,
        );
        take_counters(caller);
        if crate::dom_verify::enabled() {
            crate::dom_verify::check_readback(&json, &request, &resolved.island)?;
        }
        let timer = start();
        let answer = read(&resolved.island);
        add_for_since(caller, "rb_read", timer);
        islands.keep(request, source, resolved);
        answer
    };
    match pass {
        Some(_) => SAMPLES.with(|islands| answer(&mut islands.borrow_mut(), asked, pass)),
        None => READBACK.with(|state| {
            let (islands, last) = &mut *state.borrow_mut();
            // What was read last is read where it is; anything else is the next pass.
            if islands.same(&asked, Some(*last)).is_none() {
                *last += 1;
            }
            answer(islands, asked, Some(*last))
        }),
    }
}

/// Hands what the island thread's resolves and paints did (`kinetograph_dom::counters`) to the profile of `caller`.
fn take_counters(caller: &str) {
    if kinetograph_core::profile::enabled() {
        for (stage, value) in kinetograph_dom::counters::take() {
            kinetograph_core::profile::add_for(caller, stage, value);
        }
    }
}

/// The boxes of every element of the island (`getBoundingClientRect`,
/// `offsetWidth`, `clientWidth`, `scrollHeight`), or of those at `paths`: `{ [path]: ElementBox }`.
pub fn dom_layout_boxes(
    request_json: &str,
    pass: Option<u64>,
    paths: Option<Vec<String>>,
) -> Result<String> {
    let json = request_json.to_string();
    let caller = kinetograph_core::profile::caller();
    on_island_thread(READBACK_STAGES, move || {
        with_readback_island(&caller, json, pass, "domLayoutBoxes", |island| {
            let boxes = match &paths {
                Some(paths) => readback::layout_boxes_of(island, paths),
                None => readback::layout_boxes(island),
            };
            serde_json::to_string(&boxes)
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
