//! What the resolve passes of this thread did since the last `take`: how many
//! ran, how long each phase took, and how much of the box tree they rebuilt.
//! Per thread, so that documents resolved on other threads (another render
//! worker's) do not count here. Kinetograph reads them after each island
//! render to show under its profiler.

use std::cell::Cell;
use std::time::Instant;

#[derive(Clone, Copy, Debug, Default)]
pub struct Counters {
    /// Resolve passes (a container query's extra passes count too).
    pub passes: u64,
    /// Nanoseconds in each phase of the passes.
    pub style_ns: u64,
    pub damage_ns: u64,
    pub construct_ns: u64,
    /// Inline layouts built in `resolve_deferred_tasks` (text shaping).
    pub inline_ns: u64,
    pub layout_ns: u64,
    pub round_ns: u64,
    pub paint_tree_ns: u64,
    /// Nodes whose layout children were collected again (box construction).
    pub nodes_reconstructed: u64,
    /// Anonymous blocks freed by that construction.
    pub anonymous_freed: u64,
    /// Inline layouts built again.
    pub inline_rebuilt: u64,
}

thread_local! {
    static COUNTERS: Cell<Counters> = const { Cell::new(Counters {
        passes: 0, style_ns: 0, damage_ns: 0, construct_ns: 0, inline_ns: 0, layout_ns: 0,
        round_ns: 0, paint_tree_ns: 0, nodes_reconstructed: 0, anonymous_freed: 0, inline_rebuilt: 0,
    }) };
}

/// This thread's counters since the last call, which start again from zero.
pub fn take() -> Counters {
    COUNTERS.with(|c| c.take())
}

pub(crate) fn add(update: impl FnOnce(&mut Counters)) {
    COUNTERS.with(|c| {
        let mut now = c.get();
        update(&mut now);
        c.set(now);
    });
}

/// The nanoseconds since `start`, and a new start.
pub(crate) fn lap(start: &mut Instant) -> u64 {
    let now = Instant::now();
    let ns = now.duration_since(*start).as_nanos() as u64;
    *start = now;
    ns
}
