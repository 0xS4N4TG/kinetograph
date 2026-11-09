//! What the island renders of this thread did since the last `take`, for the profiler (`KINETOGRAPH_PROFILE`):
//! Blitz's resolve passes (`blitz_dom::counters`).

/// This thread's counts since the last call, by profile stage name, and zero again. Times are in ms.
pub fn take() -> Vec<(&'static str, f64)> {
    let b = blitz_dom::counters::take();
    let ms = |ns: u64| ns as f64 / 1e6;
    vec![
        ("bz_passes", b.passes as f64),
        ("bz_style", ms(b.style_ns)),
        ("bz_damage", ms(b.damage_ns)),
        ("bz_construct", ms(b.construct_ns)),
        ("bz_inline", ms(b.inline_ns)),
        ("bz_layout", ms(b.layout_ns)),
        ("bz_round", ms(b.round_ns)),
        ("bz_paint_tree", ms(b.paint_tree_ns)),
        ("bz_reconstructed", b.nodes_reconstructed as f64),
        ("bz_anon_freed", b.anonymous_freed as f64),
        ("bz_inline_rebuilt", b.inline_rebuilt as f64),
    ]
}
