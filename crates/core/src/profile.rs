//! Stage timers for profiling a render, off unless `KINETOGRAPH_PROFILE` is set in the environment. Off, each call is
//! one cached flag test. A stage's milliseconds are added to a per-thread table that the caller drains with `take` after
//! the step it is timing (the addon's `takeProfile`); the encoder thread adds to a table shared by all threads instead.
//! `KINETOGRAPH_PROFILE_SYNC=1` also makes the frame loop wait for the GPU after submitting each frame, so that
//! `gpu_sync` is the GPU's own time for the frame (it removes the overlap with the next frame's CPU work).

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// Whether profiling is on.
pub fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("KINETOGRAPH_PROFILE").is_some())
}

/// Whether the GPU is waited for after each frame is submitted (`KINETOGRAPH_PROFILE_SYNC`).
pub fn sync() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| enabled() && std::env::var_os("KINETOGRAPH_PROFILE_SYNC").is_some())
}

thread_local! {
    static LOCAL: RefCell<BTreeMap<&'static str, f64>> = const { RefCell::new(BTreeMap::new()) };
}

static SHARED: Mutex<BTreeMap<&'static str, f64>> = Mutex::new(BTreeMap::new());

/// Stages other threads measured for a calling thread (the DOM island thread's, for the thread that asked for the
/// island), which that thread's `take_local` picks up.
static FOR_THREAD: Mutex<BTreeMap<String, BTreeMap<&'static str, f64>>> = Mutex::new(BTreeMap::new());

/// The calling thread's identity, to hand to a thread that works for it (`add_for`).
pub fn caller() -> String {
    format!("{:?}", std::thread::current().id())
}

/// Adds `value` to `stage` of the thread `caller` (from `caller()`), whichever thread this is.
pub fn add_for(caller: &str, stage: &'static str, value: f64) {
    if enabled() {
        *FOR_THREAD
            .lock()
            .unwrap()
            .entry(caller.to_string())
            .or_default()
            .entry(stage)
            .or_insert(0.0) += value;
    }
}

/// Adds the time since `start` to `stage` of the thread `caller`.
pub fn add_for_since(caller: &str, stage: &'static str, start: Option<Instant>) {
    if let Some(ms) = since(start) {
        add_for(caller, stage, ms);
    }
}

/// The time since `start`, in ms, or None when profiling is off.
pub fn since(start: Option<Instant>) -> Option<f64> {
    start.map(|s| s.elapsed().as_secs_f64() * 1000.0)
}

/// `Some(now)` when profiling, to pass to `add_since`.
pub fn start() -> Option<Instant> {
    enabled().then(Instant::now)
}

/// Adds the time since `start` to this thread's `stage`.
pub fn add_since(stage: &'static str, start: Option<Instant>) {
    if let Some(ms) = since(start) {
        LOCAL.with(|t| *t.borrow_mut().entry(stage).or_insert(0.0) += ms);
    }
}

/// Adds `value` to this thread's `stage` (a count, not a time).
pub fn add_value(stage: &'static str, value: f64) {
    if enabled() {
        LOCAL.with(|t| *t.borrow_mut().entry(stage).or_insert(0.0) += value);
    }
}

/// Adds the time since `start` to the table shared by all threads (the encoder thread's).
pub fn add_shared_since(stage: &'static str, start: Option<Instant>) {
    if let Some(ms) = since(start) {
        *SHARED.lock().unwrap().entry(stage).or_insert(0.0) += ms;
    }
}

/// Counts one event in the shared table.
pub fn count_shared(stage: &'static str) {
    if enabled() {
        *SHARED.lock().unwrap().entry(stage).or_insert(0.0) += 1.0;
    }
}

/// This thread's stages since the last call, emptied.
pub fn take_local() -> BTreeMap<&'static str, f64> {
    let mut mine = LOCAL.with(|t| std::mem::take(&mut *t.borrow_mut()));
    if enabled()
        && let Some(theirs) = FOR_THREAD.lock().unwrap().remove(&caller())
    {
        for (stage, value) in theirs {
            *mine.entry(stage).or_insert(0.0) += value;
        }
    }
    mine
}

/// Hands this thread's stages to the thread `caller` (from `caller()`), whose `take_local` returns them: for a thread
/// that works for another and times what it does.
pub fn forward(caller: &str) {
    if !enabled() {
        return;
    }
    for (stage, value) in LOCAL.with(|t| std::mem::take(&mut *t.borrow_mut())) {
        add_for(caller, stage, value);
    }
}

/// The shared stages, as they stand.
pub fn shared() -> BTreeMap<&'static str, f64> {
    SHARED.lock().unwrap().clone()
}
