//! The ellipsis at the end of a line: `text-overflow: ellipsis` on a box that
//! clips, and the end of the last line of a `-webkit-line-clamp` box
//! (`crate::clamp`).
//!
//! The line is cut at a cluster boundary: trailing spaces go, then whole
//! clusters until the ellipsis (`…`, or three full stops if the font has no
//! `…`) fits in the line's width. It is set in the font and colour of the text
//! it follows, which is how Chrome has it. Right-to-left lines are not cut.

use parley::PositionedLayoutItem;
use parley::layout::Line;
use skrifa::instance::{LocationRef, NormalizedCoord, Size};
use skrifa::{FontRef, MetadataProvider};
use style::values::specified::text::TextOverflowSide;

use super::{Painter, attr};
use crate::clamp::CLAMP_ATTR;
use blitz_dom::Node;
use blitz_dom::node::TextBrush;

/// Where a line is cut and what is drawn after the cut.
pub(super) struct Cut {
    /// Glyphs that start at or after this x (CSS px, in the text's space) are
    /// not drawn, nor are inline boxes at or after it.
    pub x: f64,
    /// The index of the line item (a glyph run) the ellipsis glyphs follow.
    pub anchor: usize,
    /// Glyph ids and x of the ellipsis.
    pub glyphs: Vec<(u32, f64)>,
}

/// One cluster or atomic inline box of a line, in visual order.
struct Entry {
    item: usize,
    x0: f64,
    x1: f64,
    space: bool,
}

impl<'a> Painter<'a> {
    /// The line of the inline formatting context `root` that ends with a
    /// line-clamp ellipsis (`crate::clamp::apply` marked the clamped box).
    pub(super) fn clamp_line(&self, root: &Node) -> Option<usize> {
        let mut cur = Some(root);
        while let Some(n) = cur {
            if let Some(mark) = attr(n, CLAMP_ATTR) {
                let (id, line) = mark.split_once(':')?;
                return (id.parse::<u64>().ok()? == root.id.as_u64())
                    .then(|| line.parse().ok())
                    .flatten();
            }
            cur = n.layout_parent.get().map(|p| self.node(p));
        }
        None
    }

    /// Whether the lines of `root` that overflow get an ellipsis
    /// (`text-overflow: ellipsis` on a box with `overflow` other than
    /// `visible`). A string value is reported.
    pub(super) fn overflow_ellipsis(&mut self, root: &'a Node) -> bool {
        // An anonymous block takes the style of the box it is in.
        let mut block = root;
        while block.is_anonymous() {
            let Some(p) = block.layout_parent.get() else {
                break;
            };
            block = self.node(p);
        }
        let Some(style) = block.primary_styles() else {
            return false;
        };
        use style::computed_values::overflow_x::T as Overflow;
        if style.get_box().overflow_x == Overflow::Visible {
            return false;
        }
        match &style.get_text().text_overflow.second {
            TextOverflowSide::Ellipsis => true,
            TextOverflowSide::Clip => false,
            TextOverflowSide::String(s) => {
                let value = format!("{s:?}");
                drop(style);
                self.report(
                    block,
                    "text-overflow",
                    value,
                    "a string in place of the ellipsis is not drawn",
                );
                false
            }
        }
    }

    /// Where to cut `line` so that an ellipsis ends within `limit` (the right
    /// edge of the line box). `force` puts the ellipsis on a line that fits
    /// (the last line of a clamp). `None` when the line needs none.
    pub(super) fn line_cut(
        &mut self,
        node: &Node,
        line: &Line<'_, TextBrush>,
        scale: f64,
        limit: f64,
        force: bool,
    ) -> Option<Cut> {
        let mut entries: Vec<Entry> = Vec::new();
        let mut anchors: Vec<usize> = Vec::new();
        let mut used: std::collections::HashMap<usize, usize> = Default::default();
        for (item, it) in line.items().enumerate() {
            match it {
                PositionedLayoutItem::GlyphRun(gr) => {
                    if gr.run().is_rtl() {
                        self.report(
                            node,
                            "text-overflow",
                            "ellipsis",
                            "the ellipsis of right-to-left text is not drawn",
                        );
                        return None;
                    }
                    anchors.push(item);
                    // A glyph run is the part of a shaped run that has one
                    // style; the clusters of the run, in order, give it
                    // `glyphs.len()` glyphs after those of the glyph runs
                    // before it.
                    let glyphs: Vec<_> = gr.positioned_glyphs().collect();
                    let skip = *used.entry(gr.run().index()).or_default();
                    let (mut passed, mut next) = (0, 0);
                    for cluster in gr.run().visual_clusters() {
                        let n = cluster.glyphs().count();
                        if passed < skip {
                            passed += n;
                            continue;
                        }
                        if n == 0 {
                            continue;
                        }
                        if next >= glyphs.len() {
                            break;
                        }
                        let x0 = f64::from(glyphs[next].x) / scale;
                        entries.push(Entry {
                            item,
                            x0,
                            x1: x0 + f64::from(cluster.advance()) / scale,
                            space: cluster.is_space_or_nbsp(),
                        });
                        next += n;
                    }
                    *used.entry(gr.run().index()).or_default() += glyphs.len();
                }
                PositionedLayoutItem::InlineBox(ib) => {
                    let x0 = f64::from(ib.x) / scale;
                    entries.push(Entry {
                        item,
                        x0,
                        x1: x0 + f64::from(ib.width) / scale,
                        space: false,
                    });
                }
            }
        }
        if anchors.is_empty() {
            return None;
        }
        let start = entries.first().map_or(0.0, |e| e.x0);
        // Trailing spaces hang: the ellipsis follows the last visible content.
        let mut keep = entries.len();
        while keep > 0 && entries[keep - 1].space {
            keep -= 1;
        }
        let end_of = |keep: usize| {
            if keep > 0 {
                entries[keep - 1].x1
            } else {
                start
            }
        };
        if !force && end_of(keep) <= limit + 0.01 {
            return None;
        }

        // The font of the text the ellipsis follows (the first run's if
        // nothing is kept).
        let anchor_of = |keep: usize| {
            entries[..keep]
                .iter()
                .rev()
                .map(|e| e.item)
                .find(|i| anchors.contains(i))
                .unwrap_or(anchors[0])
        };
        let items: Vec<_> = line.items().collect();
        loop {
            let anchor = anchor_of(keep);
            let PositionedLayoutItem::GlyphRun(gr) = &items[anchor] else {
                return None;
            };
            let glyphs = ellipsis_glyphs(gr.run(), scale)?;
            let width: f64 = glyphs.iter().map(|g| g.1).sum();
            let x = end_of(keep);
            if x + width <= limit + 0.01 || keep == 0 {
                let mut at = x;
                let placed = glyphs
                    .iter()
                    .map(|(id, adv)| {
                        let g = (*id, at);
                        at += adv;
                        g
                    })
                    .collect();
                return Some(Cut {
                    x,
                    anchor,
                    glyphs: placed,
                });
            }
            keep -= 1;
            while keep > 0 && entries[keep - 1].space {
                keep -= 1;
            }
        }
    }
}

/// The glyph ids and advances (CSS px) of an ellipsis in the font of `run`:
/// `…`, or three `.`. `None` when the font has neither.
fn ellipsis_glyphs(
    run: &parley::layout::Run<'_, TextBrush>,
    scale: f64,
) -> Option<Vec<(u32, f64)>> {
    let font = run.font();
    let file = FontRef::from_index(font.data.data(), font.index).ok()?;
    let coords: Vec<_> = run
        .normalized_coords()
        .iter()
        .map(|c| NormalizedCoord::from_bits(c.to_bits()))
        .collect();
    let metrics = file.glyph_metrics(Size::new(run.font_size()), LocationRef::new(&coords));
    let advance = |c: char| -> Option<(u32, f64)> {
        let id = file.charmap().map(c)?;
        Some((id.to_u32(), f64::from(metrics.advance_width(id)?) / scale))
    };
    if let Some(g) = advance('\u{2026}') {
        return Some(vec![g]);
    }
    let dot = advance('.')?;
    Some(vec![dot; 3])
}
