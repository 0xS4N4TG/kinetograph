//! What the island renders of this thread did since the last `take`, for the profiler (`KINETOGRAPH_PROFILE`):
//! Blitz's resolve passes (`blitz_dom::counters`), what each edit of a kept document left for the transform-only
//! repaint (`transform_changes` in `document`) and how each paint was made.

use std::cell::Cell;

/// Why an edited document was painted whole rather than from its last paint with new transforms.
#[derive(Clone, Copy)]
pub enum Miss {
    /// The edits since the last paint set more than `style` attributes, the document was not plain, or there was no
    /// last paint.
    NotStyleOnly,
    /// The document has another number of nodes.
    Length,
    /// A node of the last paint is gone (freed, or made again under a new id).
    NodeGone,
    /// A box moved or changed size.
    Layout,
    /// A node's style differs in more than its transform properties, or one that was not edited changed.
    Value,
    /// Every node was the same, but a moved element was not painted as a group with a matrix
    /// (`paint::repaint_transforms` said no).
    Repaint,
}

#[derive(Clone, Copy, Default)]
struct Paints {
    /// Edits after which only transforms had changed since the last paint.
    moved: u64,
    /// Edits after which more had, by reason; and paints `repaint_transforms` turned down.
    missed: [u64; 6],
    /// Paints from the last paint with new transforms.
    repainted: u64,
    /// Whole paints of a document painted before.
    whole: u64,
    /// Paints of a document not painted before.
    fresh: u64,
}

thread_local! {
    static PAINTS: Cell<Paints> =
        const { Cell::new(Paints { moved: 0, missed: [0; 6], repainted: 0, whole: 0, fresh: 0 }) };
}

fn add(update: impl FnOnce(&mut Paints)) {
    PAINTS.with(|p| {
        let mut now = p.get();
        update(&mut now);
        p.set(now);
    });
}

pub(crate) fn moved() {
    add(|p| p.moved += 1);
}

pub(crate) fn repainted() {
    add(|p| p.repainted += 1);
}

pub(crate) fn whole() {
    add(|p| p.whole += 1);
}

pub(crate) fn missed(why: Miss) {
    add(|p| p.missed[why as usize] += 1);
}

pub(crate) fn fresh() {
    add(|p| p.fresh += 1);
}

/// This thread's counts since the last call, by profile stage name, and zero again. Times are in ms.
pub fn take() -> Vec<(&'static str, f64)> {
    let b = blitz_dom::counters::take();
    let p = PAINTS.with(|p| p.take());
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
        ("tf_moved", p.moved as f64),
        ("tf_repainted", p.repainted as f64),
        ("tf_whole", p.whole as f64),
        ("tf_fresh", p.fresh as f64),
        (
            "tf_miss_not_style",
            p.missed[Miss::NotStyleOnly as usize] as f64,
        ),
        ("tf_miss_length", p.missed[Miss::Length as usize] as f64),
        (
            "tf_miss_node_gone",
            p.missed[Miss::NodeGone as usize] as f64,
        ),
        ("tf_miss_layout", p.missed[Miss::Layout as usize] as f64),
        ("tf_miss_value", p.missed[Miss::Value as usize] as f64),
        ("tf_miss_repaint", p.missed[Miss::Repaint as usize] as f64),
    ]
}
