//! The start-up trace: with `KINETOGRAPH_TRACE_START` set (not empty, not `0`), one line on stderr before each start-up
//! step and one after, so that a process a driver kills leaves the step it died in as the last `start` with no `done`.
//!
//! A line is `kinetograph-trace: <n> <start|done|note> <step> <detail>`: `n` counts the lines (there is no clock here),
//! `step` is a fixed word, `detail` is free text on one line. The lines are written whole and unbuffered, so a crash
//! right after loses none. Nothing here changes what is drawn; the variable is read once.

use std::fmt;
use std::io::Write;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Whether `KINETOGRAPH_TRACE_START` is set; read on the first call.
pub fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var("KINETOGRAPH_TRACE_START").is_ok_and(|v| !v.is_empty() && v != "0"))
}

/// `true` the first time it is called with `flag`, when tracing: for steps that happen often and are worth a line once.
pub fn first(flag: &AtomicBool) -> bool {
    enabled() && !flag.swap(true, Ordering::Relaxed)
}

fn line(kind: &str, step: &str, detail: fmt::Arguments) {
    static COUNT: AtomicU64 = AtomicU64::new(0);
    let n = COUNT.fetch_add(1, Ordering::Relaxed) + 1;
    let detail = detail.to_string().replace(['\n', '\r'], " ");
    let mut err = std::io::stderr().lock();
    // A closed stderr is no reason to stop rendering.
    let _ = writeln!(err, "kinetograph-trace: {n} {kind} {step} {detail}");
    let _ = err.flush();
}

/// Says that `step` is about to begin.
pub fn start(step: &str, detail: fmt::Arguments) {
    if enabled() {
        line("start", step, detail);
    }
}

/// Says that `step` ended.
pub fn done(step: &str, detail: fmt::Arguments) {
    if enabled() {
        line("done", step, detail);
    }
}

/// Says something that is not a step: one adapter of the list, a choice made.
pub fn note(step: &str, detail: fmt::Arguments) {
    if enabled() {
        line("note", step, detail);
    }
}
