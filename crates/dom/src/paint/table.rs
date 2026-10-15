//! The parts of a table the box walk does not reach.
//!
//! Blitz lays a table out as a grid of its cells: rows, row groups, columns
//! and column groups have no box of their own, so nothing draws their
//! backgrounds, and the borders of a collapsed table are not in any box.
//!
//! - [`Painter::table_cell_backgrounds`]: the backgrounds of a cell's column
//!   group, column, row group and row, in that order and under the cell's own,
//!   each in the box of its part (so a gradient spans the row) and cut to the
//!   cell, as Chrome paints them.
//! - [`Painter::collapsed_borders`]: the borders `collapse::settle` resolved,
//!   one segment along each stretch of a grid line where the border is the
//!   same, centred on the line as Chrome has it.
//!
//! Both read the `TableContext` Blitz keeps on the table: its cells, rows,
//! columns and the position of every grid track.

use blitz_dom::node::SpecialElementData;
use blitz_dom::{Node, NodeId};
use serde_json::Value;
use style::computed_values::border_collapse::T as BorderCollapse;

use super::Painter;
use super::geom::{BoxGeom, Radii, Rect};
use super::util::{current_color, resolve_color, rgba, shift};
use crate::collapse::{BORDERS_ATTR, Edge, Resolved};

fn span_of(node: &Node, name: &str) -> usize {
    super::attr(node, name)
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(1)
        .max(1)
}

fn track_list(positions: &[taffy::Line<f32>]) -> Vec<(f64, f64)> {
    positions
        .iter()
        .map(|l| (f64::from(l.start), f64::from(l.end)))
        .collect()
}

/// A table's grid: for each column and row, where its track starts and ends
/// in the table's border box.
struct Grid {
    cols: Vec<(f64, f64)>,
    rows: Vec<(f64, f64)>,
}

impl<'a> Painter<'a> {
    /// The table a cell sits in.
    fn table_of(&self, cell: &'a Node) -> Option<&'a Node> {
        let table = self.node(cell.layout_parent.get()?);
        table.flags.is_table_root().then_some(table)
    }

    /// How much of a table's box its captions above and below the grid take,
    /// if it has any.
    pub(super) fn table_caption_extent(&self, node: &Node) -> Option<(f64, f64)> {
        if !node.flags.is_table_root() {
            return None;
        }
        match node.element_data().map(|e| &e.special_data) {
            Some(SpecialElementData::TableRoot(ctx)) if !ctx.captions.is_empty() => {
                let [above, below] = *ctx.caption_extent.borrow();
                Some((f64::from(above), f64::from(below)))
            }
            _ => None,
        }
    }

    /// Whether `node` is a table whose borders are collapsed: its own border
    /// is then one of the collapsed ones.
    pub(super) fn is_collapsed_table(&self, node: &Node) -> bool {
        if !node.flags.is_table_root() {
            return false;
        }
        match node.element_data().map(|e| &e.special_data) {
            Some(SpecialElementData::TableRoot(ctx)) => {
                ctx.border_collapse == BorderCollapse::Collapse
            }
            _ => false,
        }
    }

    /// The backgrounds of the column group, column, row group and row a cell
    /// is in (those it spans, for a cell with a span), each laid out in the
    /// box of its part and cut to the cell. `at` is the cell's border-box corner.
    pub(super) fn table_cell_backgrounds(
        &mut self,
        cell: &'a Node,
        at: super::Origin,
    ) -> Vec<Value> {
        let Some(table) = self.table_of(cell) else {
            return Vec::new();
        };
        let Some(SpecialElementData::TableRoot(ctx)) =
            table.element_data().map(|e| &e.special_data)
        else {
            return Vec::new();
        };
        let Some(tc) = ctx.cells.iter().find(|c| c.node_id == cell.id) else {
            return Vec::new();
        };
        let guard = ctx.computed_grid_info.borrow();
        let Some(info) = guard.as_ref() else {
            return Vec::new();
        };
        let grid = Grid {
            cols: track_list(&info.columns.positions),
            rows: track_list(&info.rows.positions),
        };
        if grid.cols.is_empty() || grid.rows.is_empty() {
            return Vec::new();
        }
        let (c0, r0) = (tc.column as usize, tc.row as usize);
        let c1 = (c0 + span_of(cell, "colspan")).min(grid.cols.len());
        let r1 = (r0 + span_of(cell, "rowspan")).min(grid.rows.len());
        let all_x = (grid.cols[0].0, grid.cols[grid.cols.len() - 1].1);
        let all_y = (grid.rows[0].0, grid.rows[grid.rows.len() - 1].1);

        // The parts that reach the cell, lowest first, with their boxes.
        let mut parts: Vec<(NodeId, Rect)> = Vec::new();
        let rect_of = |x: (f64, f64), y: (f64, f64)| Rect::new(x.0, y.0, x.1 - x.0, y.1 - y.0);
        let mut groups: Vec<NodeId> = Vec::new();
        for col in &ctx.columns[c0.min(ctx.columns.len())..c1.min(ctx.columns.len())] {
            if let Some(g) = col.group
                && !groups.contains(&g)
            {
                groups.push(g);
                let members: Vec<usize> = ctx
                    .columns
                    .iter()
                    .enumerate()
                    .filter(|(_, c)| c.group == Some(g))
                    .map(|(i, _)| i)
                    .collect();
                if let (Some(a), Some(b)) = (members.first(), members.last())
                    && *b < grid.cols.len()
                {
                    parts.push((g, rect_of((grid.cols[*a].0, grid.cols[*b].1), all_y)));
                }
            }
        }
        for (j, col) in ctx.columns.iter().enumerate().take(c1).skip(c0) {
            parts.push((col.node_id, rect_of(grid.cols[j], all_y)));
        }
        let mut groups: Vec<NodeId> = Vec::new();
        for row in &ctx.rows[r0.min(ctx.rows.len())..r1.min(ctx.rows.len())] {
            if let Some(g) = row.group
                && !groups.contains(&g)
            {
                groups.push(g);
                let members: Vec<usize> = ctx
                    .rows
                    .iter()
                    .enumerate()
                    .filter(|(_, r)| r.group == Some(g))
                    .map(|(i, _)| i)
                    .collect();
                if let (Some(a), Some(b)) = (members.first(), members.last())
                    && *b < grid.rows.len()
                {
                    parts.push((g, rect_of(all_x, (grid.rows[*a].0, grid.rows[*b].1))));
                }
            }
        }
        for (i, row) in ctx.rows.iter().enumerate().take(r1).skip(r0) {
            parts.push((row.node_id, rect_of(all_x, grid.rows[i])));
        }

        let l = cell.final_layout();
        let cell_rect = Rect::new(
            f64::from(l.location.x),
            f64::from(l.location.y),
            f64::from(l.size.width),
            f64::from(l.size.height),
        );
        let origin = (at.0 - cell_rect.x, at.1 - cell_rect.y);
        let mut out = Vec::new();
        for (id, rect) in parts {
            let part = self.node(id);
            let Some(style) = part.primary_styles() else {
                continue;
            };
            let bg = style.get_background();
            let current = current_color(&style);
            let has_color = rgba(&resolve_color(&bg.background_color, &current))[3] > 0.0;
            let has_image = bg
                .background_image
                .0
                .iter()
                .any(|i| !matches!(i, style::values::computed::Image::None));
            if (!has_color && !has_image) || !self.is_visible(part) || rect.is_empty() {
                continue;
            }
            let geom = BoxGeom {
                w: rect.w,
                h: rect.h,
                border: [0.0; 4],
                padding: [0.0; 4],
                radii: Radii::ZERO,
            };
            let mut layers = self.background(part, &style, &geom);
            let cut = Rect::new(
                cell_rect.x - rect.x,
                cell_rect.y - rect.y,
                cell_rect.w,
                cell_rect.h,
            );
            for layer in &mut layers {
                self.clip_layer(layer, cut, Radii::ZERO);
                shift(layer, origin.0 + rect.x, origin.1 + rect.y);
            }
            out.extend(layers);
        }
        out
    }

    /// The borders of a table with `border-collapse: collapse`, one segment
    /// along each stretch of a grid line where the border is the same. They
    /// come from `collapse::settle`; a table it has not seen draws none.
    /// `origin` is the table's border-box corner.
    pub(super) fn collapsed_borders(
        &mut self,
        table: &'a Node,
        origin: super::Origin,
    ) -> Vec<Value> {
        let Some(res) = super::attr(table, BORDERS_ATTR)
            .and_then(|json| serde_json::from_str::<Resolved>(json).ok())
        else {
            return Vec::new();
        };
        let Some(SpecialElementData::TableRoot(ctx)) =
            table.element_data().map(|e| &e.special_data)
        else {
            return Vec::new();
        };
        let guard = ctx.computed_grid_info.borrow();
        let Some(info) = guard.as_ref() else {
            return Vec::new();
        };
        let grid = Grid {
            cols: track_list(&info.columns.positions),
            rows: track_list(&info.rows.positions),
        };
        let (nc, nr) = (res.cols, res.rows);
        if grid.cols.len() != nc || grid.rows.len() != nr {
            return Vec::new();
        }

        // The lines between tracks (there are no gutters in a collapsed table).
        let x_line = |j: usize| {
            if j == nc {
                grid.cols[nc - 1].1
            } else {
                grid.cols[j].0
            }
        };
        let y_line = |i: usize| {
            if i == nr {
                grid.rows[nr - 1].1
            } else {
                grid.rows[i].0
            }
        };
        // How far a line's border reaches past a junction: half of the widest
        // border that crosses it there.
        let half = |edges: &[Option<Edge>], at: usize| -> f64 {
            [at.checked_sub(1), Some(at)]
                .into_iter()
                .flatten()
                .filter_map(|k| edges.get(k).copied().flatten())
                .fold(0.0_f64, |w, e: Edge| w.max(e.width))
                / 2.0
        };

        let mut out = Vec::new();
        let mut put = |p: &mut Self, rect: Rect, vertical: bool, edge: Edge| {
            // Chrome snaps a border to whole pixels.
            let (x0, y0) = (rect.x.round(), rect.y.round());
            let (x1, y1) = (rect.right().round(), rect.bottom().round());
            let rect = Rect::new(x0, y0, (x1 - x0).max(1.0), (y1 - y0).max(1.0));
            let id = p.layer_id(table, "cborder");
            let mut layers =
                p.border_segment(table, &id, rect, vertical, edge.style.style(), edge.color);
            for l in &mut layers {
                shift(l, origin.0, origin.1);
            }
            out.extend(layers);
        };
        // Horizontal lines, then vertical ones; a run of tracks with the same
        // border is one segment.
        for i in 0..=nr {
            for (a, b, edge) in runs(&res.horizontal[i]) {
                let (mut x0, mut x1) = (grid.cols[a].0, grid.cols[b].1);
                if a == 0 {
                    x0 -= half(&res.vertical[0], i);
                }
                if b == nc - 1 {
                    x1 += half(&res.vertical[nc], i);
                }
                let y = y_line(i);
                put(
                    self,
                    Rect::new(x0, y - edge.width / 2.0, x1 - x0, edge.width),
                    false,
                    edge,
                );
            }
        }
        for j in 0..=nc {
            for (a, b, edge) in runs(&res.vertical[j]) {
                let (mut y0, mut y1) = (grid.rows[a].0, grid.rows[b].1);
                if a == 0 {
                    y0 -= half(&res.horizontal[0], j);
                }
                if b == nr - 1 {
                    y1 += half(&res.horizontal[nr], j);
                }
                let x = x_line(j);
                put(
                    self,
                    Rect::new(x - edge.width / 2.0, y0, edge.width, y1 - y0),
                    true,
                    edge,
                );
            }
        }
        out
    }
}

/// The runs of equal borders along a line: (first track, last track, border).
fn runs(edges: &[Option<Edge>]) -> Vec<(usize, usize, Edge)> {
    let mut out: Vec<(usize, usize, Edge)> = Vec::new();
    for (i, e) in edges.iter().enumerate() {
        let Some(e) = e else {
            continue;
        };
        match out.last_mut() {
            Some((_, end, last))
                if *end + 1 == i
                    && last.width == e.width
                    && last.style == e.style
                    && last.color == e.color =>
            {
                *end = i;
            }
            _ => out.push((i, i, *e)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collapse::{CELL, Line};

    #[test]
    fn equal_neighbours_make_one_segment() {
        let e = Edge {
            width: 1.0,
            style: Line::Solid,
            color: [0.0, 0.0, 0.0, 1.0],
            rank: CELL,
        };
        let thick = Edge { width: 2.0, ..e };
        let r = runs(&[Some(e), Some(e), None, Some(e), Some(thick)]);
        assert_eq!(
            r.iter().map(|(a, b, _)| (*a, *b)).collect::<Vec<_>>(),
            [(0, 1), (3, 3), (4, 4)]
        );
    }
}
