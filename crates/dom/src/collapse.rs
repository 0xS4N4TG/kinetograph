//! `border-collapse: collapse`: the borders of a table's cells, rows, row
//! groups, columns, column groups and the table itself, resolved to one border
//! on each grid line (CSS 2.1 17.6.2).
//!
//! Chrome lays the collapsed model out with each border centred on its grid
//! line: a cell's border box reaches to the lines around it and holds half of
//! each border of its sides, and the table's box holds half of its outer
//! borders besides. Blitz lays a collapsed table out as a grid with the first
//! cell's border width as the gutter and the cells' own borders left in the
//! cells, so a row is two pixels taller than Chrome's for 1 px borders and a
//! table border wider than the cells' is ignored. [`settle`] fixes that after
//! the first layout, once per table:
//!
//! - it resolves the border of every grid line from the computed styles;
//! - every cell gets `border-*-width: 0` and the half of its resolved sides
//!   added to its `padding-*`, the table the half of its outer borders as
//!   `padding-*` (and no border), so the layout (gutters zero, borders zero)
//!   is Chrome's;
//! - the resolved borders are kept on the table in [`BORDERS_ATTR`], which
//!   the painter draws (`paint::table`): the computed borders are zero now.

use blitz_dom::node::SpecialElementData;
use blitz_dom::{BaseDocument, LocalName, Node, NodeId, QualName, ns};
use serde::{Deserialize, Serialize};
use style::computed_values::border_collapse::T as BorderCollapse;
use style::values::specified::BorderStyle;

use crate::paint::attr;

/// On a collapsed table once [`settle`] has laid it out: its [`Resolved`]
/// borders as JSON.
pub const BORDERS_ATTR: &str = "data-kg-cborders";

/// A border style other than `none` and `hidden`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Line {
    Solid,
    Dashed,
    Dotted,
    Double,
    Groove,
    Ridge,
    Inset,
    Outset,
}

impl Line {
    fn of(s: BorderStyle) -> Option<Line> {
        Some(match s {
            BorderStyle::Solid => Line::Solid,
            BorderStyle::Dashed => Line::Dashed,
            BorderStyle::Dotted => Line::Dotted,
            BorderStyle::Double => Line::Double,
            BorderStyle::Groove => Line::Groove,
            BorderStyle::Ridge => Line::Ridge,
            BorderStyle::Inset => Line::Inset,
            BorderStyle::Outset => Line::Outset,
            BorderStyle::None | BorderStyle::Hidden => return None,
        })
    }

    pub fn style(self) -> BorderStyle {
        match self {
            Line::Solid => BorderStyle::Solid,
            Line::Dashed => BorderStyle::Dashed,
            Line::Dotted => BorderStyle::Dotted,
            Line::Double => BorderStyle::Double,
            Line::Groove => BorderStyle::Groove,
            Line::Ridge => BorderStyle::Ridge,
            Line::Inset => BorderStyle::Inset,
            Line::Outset => BorderStyle::Outset,
        }
    }

    /// How far a style wins an equal-width conflict: double, solid, dashed,
    /// dotted, ridge, outset, groove, inset.
    fn rank(self) -> u8 {
        match self {
            Line::Double => 8,
            Line::Solid => 7,
            Line::Dashed => 6,
            Line::Dotted => 5,
            Line::Ridge => 4,
            Line::Outset => 3,
            Line::Groove => 2,
            Line::Inset => 1,
        }
    }
}

/// A border one element asks for on one side, or the one a grid line gets.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Edge {
    pub width: f64,
    pub style: Line,
    pub color: [f32; 4],
    /// The element it comes from: at equal width and style a cell wins over a
    /// row, a row group, a column, a column group and the table.
    pub rank: u8,
}

pub const CELL: u8 = 5;
pub const ROW: u8 = 4;
pub const ROW_GROUP: u8 = 3;
pub const COLUMN: u8 = 2;
pub const COLUMN_GROUP: u8 = 1;
pub const TABLE: u8 = 0;

/// What an element's side says: `hidden` (which wins over every other
/// border) or a border. `none` is no candidate.
#[derive(Clone, Copy, Debug)]
pub enum Candidate {
    Hidden,
    Edge(Edge),
}

/// The border drawn where `candidates` meet: `None` if one is `hidden` or
/// there is none. The wider wins, then the style, then the element; of two
/// equal ones the first in the list (the cell to the left, or above) stays.
pub fn resolve(candidates: &[Candidate]) -> Option<Edge> {
    let mut best: Option<Edge> = None;
    for c in candidates {
        match c {
            Candidate::Hidden => return None,
            Candidate::Edge(e) => {
                let better = match &best {
                    None => true,
                    Some(b) => {
                        (e.width, e.style.rank(), e.rank) > (b.width, b.style.rank(), b.rank)
                    }
                };
                if better {
                    best = Some(*e);
                }
            }
        }
    }
    best
}

/// The side of a box: top, right, bottom, left.
pub type Side = usize;
pub const TOP: Side = 0;
pub const RIGHT: Side = 1;
pub const BOTTOM: Side = 2;
pub const LEFT: Side = 3;

/// The border `node` has on `side`, if it has one.
pub fn side_border(node: &Node, side: Side, rank: u8) -> Option<Candidate> {
    let style = node.primary_styles()?;
    let b = style.get_border();
    let (st, width, color) = match side {
        TOP => (b.border_top_style, &b.border_top_width, &b.border_top_color),
        RIGHT => (
            b.border_right_style,
            &b.border_right_width,
            &b.border_right_color,
        ),
        BOTTOM => (
            b.border_bottom_style,
            &b.border_bottom_width,
            &b.border_bottom_color,
        ),
        _ => (
            b.border_left_style,
            &b.border_left_width,
            &b.border_left_color,
        ),
    };
    if st == BorderStyle::Hidden {
        return Some(Candidate::Hidden);
    }
    let line = Line::of(st)?;
    let width = f64::from(width.0.to_f32_px());
    if width <= 0.0 {
        return None;
    }
    let current = crate::paint::current_color(&style);
    Some(Candidate::Edge(Edge {
        width,
        style: line,
        color: crate::paint::rgba(&color.resolve_to_absolute(&current)),
        rank,
    }))
}

/// The resolved borders of a table's grid lines.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Resolved {
    pub cols: usize,
    pub rows: usize,
    /// `vertical[j][r]`: the border on the line before column `j` (`cols + 1`
    /// lines) in row `r`.
    pub vertical: Vec<Vec<Option<Edge>>>,
    /// `horizontal[i][c]`: the border on the line before row `i` (`rows + 1`
    /// lines) in column `c`.
    pub horizontal: Vec<Vec<Option<Edge>>>,
}

fn span_of(node: &Node, name: &str) -> usize {
    attr(node, name)
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(1)
        .max(1)
}

/// The cells of a table with their grid slots: node, row, column, row span,
/// column span.
fn cells_of(doc: &BaseDocument, table: &Node) -> Vec<(NodeId, usize, usize, usize, usize)> {
    let Some(SpecialElementData::TableRoot(ctx)) = table.element_data().map(|e| &e.special_data)
    else {
        return Vec::new();
    };
    ctx.cells
        .iter()
        .map(|c| {
            let n = doc.get_node(c.node_id).expect("a cell");
            (
                c.node_id,
                c.row as usize,
                c.column as usize,
                span_of(n, "rowspan"),
                span_of(n, "colspan"),
            )
        })
        .collect()
}

/// Resolves the borders of `table`'s grid lines from the computed styles.
/// `None` when it is not a laid-out table.
pub fn resolve_table(doc: &BaseDocument, table: &Node) -> Option<Resolved> {
    let Some(SpecialElementData::TableRoot(ctx)) = table.element_data().map(|e| &e.special_data)
    else {
        return None;
    };
    let (nc, nr) = {
        let guard = ctx.computed_grid_info.borrow();
        let info = guard.as_ref()?;
        (info.columns.positions.len(), info.rows.positions.len())
    };
    if nc == 0 || nr == 0 {
        return None;
    }
    let node = |id: NodeId| doc.get_node(id).expect("a table part");
    let cells = cells_of(doc, table);

    // Which cell covers each slot of the grid.
    let mut owner: Vec<Vec<Option<usize>>> = vec![vec![None; nc]; nr];
    for (i, &(_, r0, c0, rs, cs)) in cells.iter().enumerate() {
        for row in owner.iter_mut().take((r0 + rs).min(nr)).skip(r0) {
            for slot in row.iter_mut().take((c0 + cs).min(nc)).skip(c0) {
                *slot = Some(i);
            }
        }
    }
    let group_rows = |g: NodeId| -> (usize, usize) {
        let rows: Vec<usize> = ctx
            .rows
            .iter()
            .enumerate()
            .filter(|(_, r)| r.group == Some(g))
            .map(|(i, _)| i)
            .collect();
        (rows[0], rows[rows.len() - 1])
    };
    let group_cols = |g: NodeId| -> (usize, usize) {
        let cols: Vec<usize> = ctx
            .columns
            .iter()
            .enumerate()
            .filter(|(_, c)| c.group == Some(g))
            .map(|(i, _)| i)
            .collect();
        (cols[0], cols[cols.len() - 1])
    };
    let cell_side = |i: usize, side: Side| side_border(node(cells[i].0), side, CELL);

    let mut vertical = vec![vec![None; nr]; nc + 1];
    for (j, line) in vertical.iter_mut().enumerate() {
        for (r, slot) in line.iter_mut().enumerate() {
            let left = if j > 0 { owner[r][j - 1] } else { None };
            let right = if j < nc { owner[r][j] } else { None };
            if left.is_some() && left == right {
                // Inside a cell that spans both columns.
                continue;
            }
            let mut c: Vec<Option<Candidate>> = Vec::new();
            if let Some(i) = left {
                c.push(cell_side(i, RIGHT));
            }
            if let Some(i) = right {
                c.push(cell_side(i, LEFT));
            }
            let edge_side = match j {
                0 => Some(LEFT),
                _ if j == nc => Some(RIGHT),
                _ => None,
            };
            if let (Some(side), Some(row)) = (edge_side, ctx.rows.get(r)) {
                c.push(side_border(node(row.node_id), side, ROW));
                if let Some(g) = row.group {
                    c.push(side_border(node(g), side, ROW_GROUP));
                }
            }
            if j > 0
                && let Some(col) = ctx.columns.get(j - 1)
            {
                c.push(side_border(node(col.node_id), RIGHT, COLUMN));
                if let Some(g) = col.group
                    && group_cols(g).1 == j - 1
                {
                    c.push(side_border(node(g), RIGHT, COLUMN_GROUP));
                }
            }
            if j < nc
                && let Some(col) = ctx.columns.get(j)
            {
                c.push(side_border(node(col.node_id), LEFT, COLUMN));
                if let Some(g) = col.group
                    && group_cols(g).0 == j
                {
                    c.push(side_border(node(g), LEFT, COLUMN_GROUP));
                }
            }
            if let Some(side) = edge_side {
                c.push(side_border(table, side, TABLE));
            }
            let c: Vec<Candidate> = c.into_iter().flatten().collect();
            *slot = resolve(&c);
        }
    }

    let mut horizontal = vec![vec![None; nc]; nr + 1];
    for (i, line) in horizontal.iter_mut().enumerate() {
        for (col, slot) in line.iter_mut().enumerate() {
            let above = if i > 0 { owner[i - 1][col] } else { None };
            let below = if i < nr { owner[i][col] } else { None };
            if above.is_some() && above == below {
                continue;
            }
            let mut c: Vec<Option<Candidate>> = Vec::new();
            if let Some(k) = above {
                c.push(cell_side(k, BOTTOM));
            }
            if let Some(k) = below {
                c.push(cell_side(k, TOP));
            }
            if i > 0
                && let Some(row) = ctx.rows.get(i - 1)
            {
                c.push(side_border(node(row.node_id), BOTTOM, ROW));
                if let Some(g) = row.group
                    && group_rows(g).1 == i - 1
                {
                    c.push(side_border(node(g), BOTTOM, ROW_GROUP));
                }
            }
            if i < nr
                && let Some(row) = ctx.rows.get(i)
            {
                c.push(side_border(node(row.node_id), TOP, ROW));
                if let Some(g) = row.group
                    && group_rows(g).0 == i
                {
                    c.push(side_border(node(g), TOP, ROW_GROUP));
                }
            }
            if i == 0 {
                c.push(side_border(table, TOP, TABLE));
            } else if i == nr {
                c.push(side_border(table, BOTTOM, TABLE));
            }
            let c: Vec<Candidate> = c.into_iter().flatten().collect();
            *slot = resolve(&c);
        }
    }
    Some(Resolved {
        cols: nc,
        rows: nr,
        vertical,
        horizontal,
    })
}

/// The widest border of `edges`, or 0.
fn widest<'a>(edges: impl Iterator<Item = &'a Option<Edge>>) -> f64 {
    edges.flatten().fold(0.0, |w, e| w.max(e.width))
}

/// Whether `doc` has a table that [`apply`] has not laid out yet. A cheap test
/// of the request's CSS: whether any of it says `border-collapse`.
pub fn requested(request: &crate::request::IslandRequest) -> bool {
    use crate::request::DomNode;
    const NAME: &str = "border-collapse";
    fn node(n: &DomNode) -> bool {
        match n {
            DomNode::Text { text } => text.contains(NAME),
            DomNode::Native { .. } => false,
            DomNode::Element {
                attrs,
                style,
                children,
                ..
            } => {
                style.contains(NAME)
                    || attrs.get("style").is_some_and(|s| s.contains(NAME))
                    || children.iter().any(node)
            }
        }
    }
    request.stylesheets.iter().any(|s| s.contains(NAME)) || node(&request.root)
}

/// Gives every collapsed table that has not been given its layout the one
/// described in the module docs. Returns how many tables it changed; when it
/// is not zero the document has to be laid out again.
pub fn apply(doc: &mut BaseDocument) -> usize {
    let tables: Vec<NodeId> = doc
        .tree()
        .iter()
        .filter(|(_, n)| n.flags.is_table_root() && n.flags.is_in_document())
        .map(|(id, _)| id)
        .collect();
    let mut edits: Vec<(NodeId, &'static str, String)> = Vec::new();
    let mut marks: Vec<(NodeId, String)> = Vec::new();
    for id in tables {
        let table = doc.get_node(id).expect("a table");
        if attr(table, BORDERS_ATTR).is_some() {
            continue;
        }
        let collapsed = matches!(
            table.element_data().map(|e| &e.special_data),
            Some(SpecialElementData::TableRoot(ctx)) if ctx.border_collapse == BorderCollapse::Collapse
        );
        if !collapsed {
            continue;
        }
        let Some(res) = resolve_table(doc, table) else {
            continue;
        };
        let px = |v: f64| format!("{}px", (v * 1000.0).round() / 1000.0);
        const BORDER: [&str; 4] = [
            "border-top-width",
            "border-right-width",
            "border-bottom-width",
            "border-left-width",
        ];
        const PADDING: [&str; 4] = [
            "padding-top",
            "padding-right",
            "padding-bottom",
            "padding-left",
        ];
        // The table: half of each outer border, and no border.
        let outer = [
            widest(res.horizontal[0].iter()),
            widest(res.vertical[res.cols].iter()),
            widest(res.horizontal[res.rows].iter()),
            widest(res.vertical[0].iter()),
        ];
        for (side, w) in outer.iter().enumerate() {
            edits.push((id, BORDER[side], "0px".into()));
            edits.push((id, PADDING[side], px(w / 2.0)));
        }
        // Each cell: half of the borders on its sides, in place of its border.
        for (cell, r0, c0, rs, cs) in cells_of(doc, table) {
            let (r1, c1) = ((r0 + rs).min(res.rows), (c0 + cs).min(res.cols));
            let halves = [
                widest(res.horizontal[r0][c0..c1].iter()),
                widest(res.vertical[c1][r0..r1].iter()),
                widest(res.horizontal[r1][c0..c1].iter()),
                widest(res.vertical[c0][r0..r1].iter()),
            ];
            let l = doc.get_node(cell).expect("a cell").final_layout();
            let padding = [
                l.padding.top,
                l.padding.right,
                l.padding.bottom,
                l.padding.left,
            ];
            for side in 0..4 {
                edits.push((cell, BORDER[side], "0px".into()));
                edits.push((
                    cell,
                    PADDING[side],
                    px(f64::from(padding[side]) + halves[side] / 2.0),
                ));
            }
        }
        marks.push((id, serde_json::to_string(&res).expect("serialises")));
    }
    let n = marks.len();
    let mut m = doc.mutate();
    for (id, name, value) in edits {
        m.set_style_property(id, name, &value);
    }
    for (id, json) in marks {
        m.set_attribute(
            id,
            QualName::new(None, ns!(), LocalName::from(BORDERS_ATTR)),
            &json,
        );
    }
    n
}

/// Runs [`apply`] and the layout it asks for.
pub fn settle(doc: &mut BaseDocument, time: f64) {
    if apply(doc) > 0 {
        doc.resolve(time);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(width: f64, style: Line, rank: u8) -> Candidate {
        Candidate::Edge(Edge {
            width,
            style,
            color: [0.0, 0.0, 0.0, 1.0],
            rank,
        })
    }

    #[test]
    fn the_wider_border_wins_then_the_style_then_the_element() {
        let w = resolve(&[edge(1.0, Line::Solid, CELL), edge(3.0, Line::Dotted, TABLE)]);
        assert_eq!(w.unwrap().width, 3.0);
        let s = resolve(&[edge(2.0, Line::Dashed, CELL), edge(2.0, Line::Solid, TABLE)]);
        assert_eq!(s.unwrap().style, Line::Solid);
        let e = resolve(&[edge(2.0, Line::Solid, TABLE), edge(2.0, Line::Solid, CELL)]);
        assert_eq!(e.unwrap().rank, CELL);
        // Of two equal ones the first (the cell to the left) stays.
        let red = Candidate::Edge(Edge {
            width: 1.0,
            style: Line::Solid,
            color: [1.0, 0.0, 0.0, 1.0],
            rank: CELL,
        });
        let blue = Candidate::Edge(Edge {
            width: 1.0,
            style: Line::Solid,
            color: [0.0, 0.0, 1.0, 1.0],
            rank: CELL,
        });
        assert_eq!(resolve(&[red, blue]).unwrap().color, [1.0, 0.0, 0.0, 1.0]);
    }

    #[test]
    fn hidden_wins_over_everything_and_nothing_is_no_border() {
        assert!(resolve(&[edge(5.0, Line::Solid, CELL), Candidate::Hidden]).is_none());
        assert!(resolve(&[]).is_none());
    }
}
