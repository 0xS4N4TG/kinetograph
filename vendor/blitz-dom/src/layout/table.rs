use blitz_traits::node_id::NodeId;
use std::{ops::Range, sync::Arc};
use style::logical_geometry::WritingMode;
use style::properties::ComputedValues;

use atomic_refcell::AtomicRefCell;
use markup5ever::local_name;
use style::properties::style_structs::Border;
use style::servo_arc::Arc as ServoArc;
use style::typed_om::NumericBaseType;
use style::values::computed::calc::CalcPercentageLeaf;
use style::values::computed::length_percentage::{
    CalcLengthPercentage, CalcNode, ComputedLeaf, Unpacked as UnpackedLengthPercentage,
};
use style::values::computed::{Length, LengthPercentage};
use style::values::generics::Optional;
use style::values::specified::box_::{DisplayInside, DisplayOutside};
use style::{
    Atom, computed_values::border_collapse::T as BorderCollapse,
    computed_values::table_layout::T as TableLayout, values::computed::BorderStyle,
};
use style_traits::values::specified::AllowedNumericType;
use taffy::{
    DetailedGridInfo, LayoutPartialTree as _, ResolveOrZero, TrackSizingFunction, style_helpers,
};

use crate::BaseDocument;
use crate::layout::LayoutPassState;

use super::damage::{CONSTRUCT_BOX, CONSTRUCT_DESCENDENT, CONSTRUCT_FC};
use super::resolve_calc_value;

pub struct TableTreeWrapper<'a, 'doc> {
    pub(crate) doc: &'a mut LayoutPassState<'doc>,
    pub(crate) ctx: Arc<TableContext>,
    /// The table's style with the columns' widths worked out (`auto_columns`), in place
    /// of `ctx.style` for this layout.
    pub(crate) columns_style: Option<taffy::Style<Atom>>,
}

// Deliberately not `Clone`: `style` may hold raw pointers into `calc_values`.
#[derive(Debug)]
pub struct TableContext {
    pub style: taffy::Style<Atom>,
    pub cells: Vec<TableCell>,
    /// Absolutely positioned descendants of the table's row groups and rows (and of the
    /// table itself). They take no part in the table grid.
    pub oof_children: Vec<(NodeId, taffy::Position)>,
    pub rows: Vec<TableRow>,
    pub columns: Vec<TableColumn>,
    /// The table's `<caption>`s (and `display: table-caption` boxes), in tree order. They
    /// sit in the table's box above (`caption-side: top`) and below the grid.
    pub captions: Vec<NodeId>,
    /// How much of the table's box the captions above and below the grid take (set by layout)
    pub caption_extent: AtomicRefCell<[f32; 2]>,
    pub computed_grid_info: AtomicRefCell<Option<DetailedGridInfo<Atom>>>,
    pub border_style: Option<ServoArc<Border>>,
    pub border_collapse: BorderCollapse,
    /// Whether the table uses the fixed layout algorithm (`table-layout: fixed` and a width)
    pub is_fixed: bool,
    /// Backing storage for `calc()` track sizes synthesised by the table layout code.
    /// Taffy stores calc values as raw pointers, so these must outlive the `style`.
    #[allow(dead_code)]
    calc_values: Vec<LengthPercentage>,
}

// #[derive(Debug, Clone, Eq, PartialEq)]
// pub enum TableItemKind {
//     Row,
//     Cell,
// }

#[derive(Debug, Clone)]
pub struct TableCell {
    // kind: TableItemKind,
    pub node_id: NodeId,
    /// Index (into `TableContext::rows`) of the row the cell originates in
    pub row: u16,
    /// Index of the column the cell originates in
    pub column: u16,
    /// How many columns the cell spans
    pub colspan: u16,
    style: taffy::Style<Atom>,
}

/// Tracks the current column position while walking the table's cells, so that
/// cells are assigned the same columns Taffy's dense auto-placement will give them
/// (skipping columns still occupied by rowspan cells from earlier rows).
#[derive(Debug, Default)]
struct ColumnCursor {
    /// The column the next cell in the current row will be placed in
    col: u16,
    /// The total number of columns seen so far
    num_columns: u16,
    /// For each column, the number of further rows it is occupied by a rowspan cell
    rowspans: Vec<u16>,
}

impl ColumnCursor {
    fn start_row(&mut self) {
        self.col = 0;
        for remaining in self.rowspans.iter_mut() {
            *remaining = remaining.saturating_sub(1);
        }
    }

    /// Advance past occupied columns, returning the column of the next cell
    fn next_free(&mut self) -> u16 {
        while self.rowspans.get(self.col as usize).is_some_and(|r| *r > 0) {
            self.col += 1;
        }
        self.col
    }

    fn place(&mut self, colspan: u16, rowspan: u16) {
        let end = self.col + colspan;
        if self.rowspans.len() < end as usize {
            self.rowspans.resize(end as usize, 0);
        }
        for remaining in &mut self.rowspans[self.col as usize..end as usize] {
            *remaining = rowspan - 1;
        }
        self.col = end;
        self.num_columns = self.num_columns.max(end);
    }
}

#[derive(Debug, Clone)]
pub struct TableColumn {
    pub node_id: NodeId,
    /// The column group (if any) that contains the column
    pub group: Option<NodeId>,
}

#[derive(Debug, Clone)]
pub struct TableRow {
    // kind: TableItemKind,
    pub node_id: NodeId,
    /// The row group (if any) that contains the row
    pub group: Option<NodeId>,
    /// The row's specified `height`, if it is a length
    pub height: Option<f32>,
    /// Whether the row or any cell originating in it (and spanning only this row) has a
    /// specified length `height`. Such rows do not receive excess table height when there
    /// are unconstrained rows to receive it instead.
    pub is_constrained: bool,
}

/// The used width of one border side: border widths are not adjusted for
/// border-style in computed styles, so a border with `none`/`hidden` style
/// must be treated as zero-width.
/// The writing mode the table's grid runs in (the table's own)
#[cfg_attr(not(feature = "writing-mode"), allow(unused_variables))]
fn table_wm(doc: &BaseDocument, table_root_node_id: NodeId) -> WritingMode {
    #[cfg(feature = "writing-mode")]
    {
        if doc.try_root_element().map(|root| root.id) == Some(table_root_node_id) {
            doc.root_layout_wm(table_root_node_id)
        } else {
            doc.nodes[table_root_node_id].writing_mode()
        }
    }
    #[cfg(not(feature = "writing-mode"))]
    {
        WritingMode::empty()
    }
}

/// Convert a table part's style into the table's writing mode
fn table_taffy_style(style: &ComputedValues, table_wm: WritingMode) -> taffy::Style<Atom> {
    stylo_taffy::to_taffy_style_in(style, table_wm)
}

fn side_width(width: app_units::Au, style: BorderStyle) -> f32 {
    if style.none_or_hidden() {
        0.0
    } else {
        width.to_f32_px()
    }
}

/// Build a `calc(<percent> + <length>)` track sizing function. The calc value is
/// boxed and stored in `calc_values` so that the raw pointer Taffy holds stays valid.
fn percent_plus_length(
    calc_values: &mut Vec<LengthPercentage>,
    percent: f32,
    length: f32,
) -> TrackSizingFunction {
    let node = CalcNode::Sum(
        vec![
            CalcNode::Leaf(ComputedLeaf::Percentage(CalcPercentageLeaf::new(
                percent,
                Optional::Some(NumericBaseType::Length),
            ))),
            CalcNode::Leaf(ComputedLeaf::Length(Length::new(length))),
        ]
        .into(),
    );
    let value = LengthPercentage::new_calc(node, AllowedNumericType::NonNegative);
    let dim = match value.unpack() {
        UnpackedLengthPercentage::Calc(calc) => {
            let ptr = calc as *const CalcLengthPercentage as *const ();
            // SAFETY: the pointer targets the heap allocation owned by `value`, which
            // is kept alive by `calc_values` for as long as the TableContext exists.
            unsafe { taffy::Dimension::from_raw(taffy::CompactLength::calc(ptr)) }
        }
        UnpackedLengthPercentage::Length(len) => style_helpers::length(len.px()),
        UnpackedLengthPercentage::Percentage(p) => style_helpers::percent(p.0),
    };
    calc_values.push(value);
    dim.into()
}

pub(crate) fn build_table_context(
    doc: &mut BaseDocument,
    table_root_node_id: NodeId,
) -> (TableContext, Vec<NodeId>) {
    let mut cells: Vec<TableCell> = Vec::new();
    let mut oof_children: Vec<(NodeId, taffy::Position)> = Vec::new();
    let mut rows: Vec<TableRow> = Vec::new();
    let mut row = 0u16;
    let mut cursor = ColumnCursor::default();

    let wm = table_wm(doc, table_root_node_id);
    let root_node = &mut doc.nodes[table_root_node_id];

    let children = std::mem::take(&mut root_node.children);

    let Some(stylo_styles) = root_node.primary_styles() else {
        panic!("Ignoring table because it has no styles");
    };

    let mut style = table_taffy_style(&stylo_styles, wm);
    style.item_is_table = true;
    // Use `dense` row-flow so that each cell scans the row from its
    // leftmost column for the first free track. Without `dense`,
    // `place_definite_secondary_axis_item` keeps a per-item secondary
    // cursor across rows, which means cells in later rows do not
    // backfill columns freed up by rowspan cells from earlier rows.
    style.grid_auto_flow = taffy::GridAutoFlow::RowDense;
    style.grid_auto_columns = Vec::new();
    style.grid_auto_rows = Vec::new();

    // The fixed table layout algorithm only applies when the table has a non-auto width
    let is_fixed = match stylo_styles.clone_table_layout() {
        TableLayout::Fixed => !style.size.width.is_auto(),
        TableLayout::Auto => false,
    };

    let border_collapse = stylo_styles.clone_border_collapse();
    let border_spacing = stylo_styles.clone_border_spacing().0;

    drop(stylo_styles);

    let is_caption = |doc: &BaseDocument, id: NodeId| {
        doc.nodes[id]
            .display_style()
            .is_some_and(|d| d.outside() == DisplayOutside::TableCaption)
    };
    let captions: Vec<NodeId> = children
        .iter()
        .copied()
        .filter(|id| is_caption(doc, *id))
        .collect();
    let mut columns: Vec<TableColumn> = Vec::new();
    let mut column_sizes: Vec<taffy::TrackSizingFunction> = Vec::new();
    for child_id in children.iter().copied() {
        collect_columns(doc, child_id, wm, &mut columns, &mut column_sizes);
    }
    // Percentage column widths only take effect in the fixed table layout algorithm
    if !is_fixed {
        for column in column_sizes.iter_mut() {
            if column.max.into_raw().tag() == taffy::CompactLength::PERCENT_TAG {
                *column = style_helpers::auto();
            }
        }
    }
    let mut first_cell_border: Option<ServoArc<Border>> = None;
    // Percentage widths set on first-row cells: (column index, percentage, padding + border)
    let mut percent_columns: Vec<(u16, f32, f32)> = Vec::new();
    let mut calc_values: Vec<LengthPercentage> = Vec::new();
    // Header row groups are laid out before other rows, and footer row groups after
    let row_group_order = |doc: &BaseDocument, child_id: NodeId| -> u8 {
        let display = doc.nodes[child_id]
            .primary_styles()
            .map(|s| s.clone_display());
        match display.map(|d| d.inside()) {
            Some(DisplayInside::TableHeaderGroup) => 0,
            Some(DisplayInside::TableFooterGroup) => 2,
            _ => 1,
        }
    };
    for order in 0..3 {
        for child_id in children.iter().copied() {
            if row_group_order(doc, child_id) != order || captions.contains(&child_id) {
                continue;
            }
            collect_table_cells(
                doc,
                child_id,
                wm,
                is_fixed,
                border_collapse,
                &mut row,
                &mut cursor,
                &mut cells,
                &mut oof_children,
                &mut rows,
                &mut column_sizes,
                &mut first_cell_border,
                &mut percent_columns,
            );
        }
    }
    let remaining_column = if is_fixed {
        style_helpers::minmax(style_helpers::length(0.0), style_helpers::fr(1.0))
    } else {
        style_helpers::auto()
    };
    // Trailing `<col>` columns which contain no cells and have no definite width
    // (i.e. would be zero-width) are dropped, so they don't add border-spacing.
    while column_sizes.len() > cursor.num_columns as usize
        && column_sizes
            .last()
            .is_some_and(|c| c.min.into_raw().tag() == taffy::CompactLength::AUTO_TAG)
    {
        column_sizes.pop();
        columns.pop();
    }
    let num_columns = cursor.num_columns.max(column_sizes.len() as u16);
    column_sizes.resize(num_columns as usize, remaining_column);
    if is_fixed {
        // In the fixed table layout algorithm, percentage column widths resolve against
        // the table's content width minus the horizontal border-spacing between columns,
        // whereas Taffy resolves percentage tracks against the container's inner width
        // (from which only the outer border-spacing has been removed via padding). Fold
        // the inner border-spacing into the percentage using `calc(N% - N * spacing)`.
        let spacing_x = match border_collapse {
            BorderCollapse::Separate => border_spacing.width.px(),
            BorderCollapse::Collapse => 0.0,
        };
        let inner_spacing = spacing_x * num_columns.saturating_sub(1) as f32;
        let mut percent_track = |percent: f32, extra: f32| -> TrackSizingFunction {
            let extra = extra - percent * inner_spacing;
            if extra == 0.0 {
                style_helpers::percent(percent)
            } else {
                percent_plus_length(&mut calc_values, percent, extra)
            }
        };

        for column in column_sizes.iter_mut() {
            if column.max.is_auto() {
                *column = remaining_column;
            } else if column.max.into_raw().tag() == taffy::CompactLength::PERCENT_TAG {
                *column = percent_track(column.max.into_raw().value(), 0.0);
            }
        }

        // Percentage widths on cells apply to the cell's content box, so the
        // cell's horizontal padding and border must be added to the column width.
        for (col_idx, percent, extra) in percent_columns {
            if let Some(column) = column_sizes.get_mut(col_idx as usize) {
                *column = percent_track(percent, extra);
            }
        }
    }

    style.grid_template_columns = column_sizes.into_iter().map(|dim| dim.into()).collect();
    // A row's `height` is a minimum: the row grows to fit the content of its cells.
    // Excess table height is distributed to unconstrained rows (via the stretching of
    // `auto` tracks) if there are any, and to all rows otherwise. So constrained rows
    // use a `max-content` (rather than `auto`) maximum when there are unconstrained rows.
    let has_unconstrained_rows = rows.iter().any(|row| !row.is_constrained);
    style.grid_template_rows = rows
        .iter()
        .map(|row| {
            let min = match row.height {
                Some(height) => style_helpers::length(height),
                None => style_helpers::auto(),
            };
            let max = if row.is_constrained && has_unconstrained_rows {
                style_helpers::max_content()
            } else {
                style_helpers::auto()
            };
            style_helpers::minmax(min, max)
        })
        .collect();

    style.gap = match border_collapse {
        BorderCollapse::Separate => {
            // In the separated borders model, `border-spacing` also applies between
            // the table border and the outermost cells, in addition to between cells.
            let spacing_x = border_spacing.width.px();
            let spacing_y = border_spacing.height.px();
            let padding = style.padding.resolve_or_zero(None, resolve_calc_value);
            style.padding = taffy::Rect {
                left: style_helpers::length(padding.left + spacing_x),
                right: style_helpers::length(padding.right + spacing_x),
                top: style_helpers::length(padding.top + spacing_y),
                bottom: style_helpers::length(padding.bottom + spacing_y),
            };
            taffy::Size {
                width: style_helpers::length(spacing_x),
                height: style_helpers::length(spacing_y),
            }
        }
        BorderCollapse::Collapse => first_cell_border
            .as_ref()
            .map(|border| {
                let x = side_width(border.border_left_width.0, border.border_left_style).max(
                    side_width(border.border_right_width.0, border.border_right_style),
                );
                let y = side_width(border.border_top_width.0, border.border_top_style).max(
                    side_width(border.border_bottom_width.0, border.border_bottom_style),
                );
                taffy::Size {
                    width: style_helpers::length(x),
                    height: style_helpers::length(y),
                }
            })
            .unwrap_or(taffy::Size::ZERO.map(style_helpers::length)),
    };

    if border_collapse == BorderCollapse::Collapse {
        style.border = taffy::Rect {
            left: style.gap.width,
            right: style.gap.width,
            top: style.gap.height,
            bottom: style.gap.height,
        };
    }

    let layout_children = cells
        .iter()
        .map(|cell| cell.node_id)
        .chain(captions.iter().copied())
        .chain(oof_children.iter().map(|(node_id, _)| *node_id))
        .collect();
    let root_node = &mut doc.nodes[table_root_node_id];
    root_node.children = children;

    (
        TableContext {
            style,
            cells,
            oof_children,
            rows,
            columns,
            captions,
            caption_extent: AtomicRefCell::new([0.0, 0.0]),
            computed_grid_info: AtomicRefCell::new(None),
            border_collapse,
            is_fixed,
            border_style: first_cell_border,
            calc_values,
        },
        layout_children,
    )
}

/// Collect `<col>` elements (and `display: table-column` elements) along with their
/// widths, which take precedence over cell widths in the fixed table layout algorithm.
/// Columns without a specified width are recorded as `auto`.
fn collect_columns(
    doc: &mut BaseDocument,
    node_id: NodeId,
    wm: WritingMode,
    columns: &mut Vec<TableColumn>,
    column_sizes: &mut Vec<TrackSizingFunction>,
) {
    let node = &doc.nodes[node_id];
    if !node.is_element() {
        return;
    }
    let Some(display) = node.display_style() else {
        return;
    };

    match display.inside() {
        DisplayInside::TableColumnGroup => {
            let first_column = columns.len();
            let children = std::mem::take(&mut doc.nodes[node_id].children);
            for child_id in children.iter().copied() {
                collect_columns(doc, child_id, wm, columns, column_sizes);
            }
            doc.nodes[node_id].children = children;
            for column in &mut columns[first_column..] {
                column.group.get_or_insert(node_id);
            }
        }
        DisplayInside::TableColumn => {
            let style = table_taffy_style(&node.primary_styles().unwrap(), wm);
            let span: u16 = node
                .attr(local_name!("span"))
                .and_then(|val| val.parse::<u16>().ok())
                .map(|v| v.max(1))
                .unwrap_or(1);
            let column: TrackSizingFunction = match style.size.width.tag() {
                taffy::CompactLength::LENGTH_TAG => {
                    // A definite `max-width` clamps the column width; a zero width is treated as auto
                    let mut width = style.size.width.value();
                    if style.max_size.width.into_raw().tag() == taffy::CompactLength::LENGTH_TAG {
                        width = width.min(style.max_size.width.into_raw().value());
                    }
                    if width > 0.0 {
                        style_helpers::length(width)
                    } else {
                        style_helpers::auto()
                    }
                }
                taffy::CompactLength::PERCENT_TAG => {
                    style_helpers::percent(style.size.width.value())
                }
                // Browsers treat calc() widths on columns as auto
                _ => style_helpers::auto(),
            };
            // A definite `min-width` on a column acts as a floor on its width
            let column = match style.min_size.width.into_raw().tag() {
                taffy::CompactLength::LENGTH_TAG if column.max.is_auto() => style_helpers::minmax(
                    style_helpers::length(style.min_size.width.into_raw().value()),
                    style_helpers::auto(),
                ),
                _ => column,
            };
            for _ in 0..span {
                columns.push(TableColumn {
                    node_id,
                    group: None,
                });
                column_sizes.push(column);
            }
        }
        _ => {}
    }
}

#[allow(clippy::too_many_arguments)]
fn collect_table_cells(
    doc: &mut BaseDocument,
    node_id: NodeId,
    wm: WritingMode,
    is_fixed: bool,
    border_collapse: BorderCollapse,
    row: &mut u16,
    cursor: &mut ColumnCursor,
    cells: &mut Vec<TableCell>,
    oof_children: &mut Vec<(NodeId, taffy::Position)>,
    rows: &mut Vec<TableRow>,
    columns: &mut Vec<TrackSizingFunction>,
    first_cell_border: &mut Option<ServoArc<Border>>,
    percent_columns: &mut Vec<(u16, f32, f32)>,
) {
    let node = &mut doc.nodes[node_id];

    if !node.is_element() {
        return;
    }

    let Some(display) = node.display_style() else {
        #[cfg(feature = "tracing")]
        tracing::info!("Ignoring table descendent because it has no styles");
        return;
    };

    if display.outside() == DisplayOutside::None {
        node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
        return;
    }

    // Absolutely positioned boxes are out-of-flow: they are laid out by their containing
    // block rather than as part of the table grid.
    let position = node.primary_styles().unwrap().clone_position();
    if position.is_absolutely_positioned() {
        oof_children.push((node_id, stylo_taffy::convert::position(position)));
        return;
    }

    match display.inside() {
        DisplayInside::TableRowGroup
        | DisplayInside::TableHeaderGroup
        | DisplayInside::TableFooterGroup
        | DisplayInside::Contents => {
            let first_row = rows.len();
            let children = std::mem::take(&mut doc.nodes[node_id].children);
            for child_id in children.iter().copied() {
                doc.nodes[child_id]
                    .remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
                collect_table_cells(
                    doc,
                    child_id,
                    wm,
                    is_fixed,
                    border_collapse,
                    row,
                    cursor,
                    cells,
                    oof_children,
                    rows,
                    columns,
                    first_cell_border,
                    percent_columns,
                );
            }
            doc.nodes[node_id].children = children;
            if display.inside() != DisplayInside::Contents {
                for row in &mut rows[first_row..] {
                    row.group.get_or_insert(node_id);
                }
            }
        }
        DisplayInside::TableRow => {
            node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
            *row += 1;
            cursor.start_row();

            let height = node.primary_styles().and_then(|style| {
                let height = stylo_taffy::convert::dimension(&style.clone_height());
                (height.tag() == taffy::CompactLength::LENGTH_TAG).then(|| height.value())
            });
            rows.push(TableRow {
                node_id,
                group: None,
                height,
                is_constrained: height.is_some(),
            });

            let children = std::mem::take(&mut doc.nodes[node_id].children);
            for child_id in children.iter().copied() {
                collect_table_cells(
                    doc,
                    child_id,
                    wm,
                    is_fixed,
                    border_collapse,
                    row,
                    cursor,
                    cells,
                    oof_children,
                    rows,
                    columns,
                    first_cell_border,
                    percent_columns,
                );
            }
            doc.nodes[node_id].children = children;
        }
        DisplayInside::TableCell => {
            // node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
            let stylo_style = &node.primary_styles().unwrap();
            let colspan: u16 = node
                .attr(local_name!("colspan"))
                .and_then(|val| val.parse().ok())
                .unwrap_or(1);
            let rowspan: u16 = node
                .attr(local_name!("rowspan"))
                .and_then(|val| val.parse::<u16>().ok())
                .map(|v| v.clamp(1, 65534))
                .unwrap_or(1);
            let mut style = table_taffy_style(stylo_style, wm);
            let col = cursor.next_free();

            // In the collapsed borders model the borders are laid out as gutters between
            // the cells (see the table's `gap`) rather than as part of the cells
            if border_collapse == BorderCollapse::Collapse {
                style.border = taffy::Rect::ZERO.map(style_helpers::length);
            }

            if first_cell_border.is_none() {
                *first_cell_border = Some(stylo_style.clone_border());
            }

            // In the fixed table layout algorithm the widths of columns are not
            // affected by cell contents, so cells must not impose a min-content
            // floor on their tracks.
            if is_fixed {
                style.min_size.width = style_helpers::length(0.0);
            }

            // Column widths from `<col>` elements take precedence over cell widths
            let col_needs_width =
                (col as usize) >= columns.len() || columns[col as usize].max.is_auto();
            if *row == 1 && col_needs_width {
                let column: TrackSizingFunction = match style.size.width.tag() {
                    taffy::CompactLength::LENGTH_TAG => {
                        let len = style.size.width.value();
                        let padding = style.padding.resolve_or_zero(None, resolve_calc_value);
                        let border = style.border.resolve_or_zero(None, resolve_calc_value);
                        match style.box_sizing {
                            taffy::BoxSizing::ContentBox => style_helpers::length(
                                len + padding.left + padding.right + border.left + border.right,
                            ),
                            taffy::BoxSizing::BorderBox => style_helpers::length(len),
                        }
                    }
                    taffy::CompactLength::PERCENT_TAG => {
                        if is_fixed {
                            let extra = match style.box_sizing {
                                taffy::BoxSizing::ContentBox => {
                                    let padding =
                                        style.padding.resolve_or_zero(None, resolve_calc_value);
                                    let border =
                                        style.border.resolve_or_zero(None, resolve_calc_value);
                                    padding.left + padding.right + border.left + border.right
                                }
                                taffy::BoxSizing::BorderBox => 0.0,
                            };
                            // Resolved in `build_table_context` once the column count is known
                            percent_columns.push((col, style.size.width.value(), extra));
                            style_helpers::percent(style.size.width.value())
                        } else {
                            style_helpers::auto()
                        }
                    }
                    taffy::CompactLength::AUTO_TAG => style_helpers::auto(),
                    // Dimension values are always length, percentage, auto or calc(),
                    // so any other tag is a calc() value. Pass it through so that
                    // Taffy resolves it against the table's inner width.
                    _ => style.size.width.into(),
                };
                if (col as usize) < columns.len() {
                    if !column.max.is_auto() {
                        columns[col as usize] = column;
                    }
                } else {
                    columns.resize(col as usize, style_helpers::auto());
                    columns.push(column);
                }
            }

            // The margin properties do not apply to table-internal elements
            style.margin = taffy::Rect::ZERO.map(style_helpers::length);

            // Let Taffy auto-place the column. Combined with
            // `grid_auto_flow: RowDense` set on the table root, each cell
            // scans from the first track in its row for a free position,
            // which makes cells automatically skip columns occupied by
            // rowspan cells from earlier rows.
            style.grid_column = taffy::Line {
                start: style_helpers::auto(),
                end: style_helpers::span(colspan),
            };
            style.grid_row = taffy::Line {
                start: style_helpers::line(*row as i16),
                end: style_helpers::span(rowspan),
            };
            if rowspan == 1 && style.size.height.tag() == taffy::CompactLength::LENGTH_TAG {
                if let Some(row) = rows.last_mut() {
                    row.is_constrained = true;
                }
            }

            style.size.width = style_helpers::auto();
            // A cell's `height` is its border box's (Chrome and Gecko size a row so that it holds
            // the cell's whole box, where `width` stays the content box's), and a minimum for its
            // row: the cell fills the row (a rowspan cell all its rows), so the height does not
            // size the item itself.
            if style.size.height.tag() == taffy::CompactLength::LENGTH_TAG {
                let padding = style.padding.resolve_or_zero(None, resolve_calc_value);
                let border = style.border.resolve_or_zero(None, resolve_calc_value);
                let edges = padding.top + padding.bottom + border.top + border.bottom;
                let height = style.size.height.value();
                let content = match style.box_sizing {
                    taffy::BoxSizing::ContentBox => (height - edges).max(0.0),
                    taffy::BoxSizing::BorderBox => height,
                };
                style.min_size.height = style_helpers::length(content);
                style.size.height = style_helpers::auto();
            }
            cells.push(TableCell {
                node_id,
                row: row.saturating_sub(1),
                column: col,
                colspan,
                style,
            });

            cursor.place(colspan, rowspan);
        }
        DisplayInside::Flow
        | DisplayInside::FlowRoot
        | DisplayInside::Flex
        | DisplayInside::Grid => {
            node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
            // Probably a table caption: ignore
            // println!(
            //     "Warning: ignoring non-table typed descendent of table ({:?})",
            //     display.inside()
            // );
        }
        DisplayInside::TableColumnGroup | DisplayInside::TableColumn | DisplayInside::Table => {
            node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
            //Ignore
        }
        DisplayInside::None => {
            node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
            // Ignore
        }
    }
}

pub struct RangeIter(Range<usize>);

impl Iterator for RangeIter {
    type Item = taffy::NodeId;

    fn next(&mut self) -> Option<Self::Item> {
        self.0.next().map(taffy::NodeId::from)
    }
}

impl taffy::TraversePartialTree for TableTreeWrapper<'_, '_> {
    type ChildIter<'a>
        = RangeIter
    where
        Self: 'a;

    #[inline(always)]
    fn child_ids(&self, _node_id: taffy::NodeId) -> Self::ChildIter<'_> {
        RangeIter(0..self.ctx.cells.len())
    }

    #[inline(always)]
    fn child_count(&self, _node_id: taffy::NodeId) -> usize {
        self.ctx.cells.len()
    }

    #[inline(always)]
    fn get_child_id(&self, _node_id: taffy::NodeId, index: usize) -> taffy::NodeId {
        index.into()
    }
}
impl taffy::TraverseTree for TableTreeWrapper<'_, '_> {}

impl taffy::LayoutPartialTree for TableTreeWrapper<'_, '_> {
    type CoreContainerStyle<'a>
        = &'a taffy::Style<Atom>
    where
        Self: 'a;

    type CustomIdent = Atom;

    fn get_core_container_style(&self, _node_id: taffy::NodeId) -> &taffy::Style<Atom> {
        self.columns_style.as_ref().unwrap_or(&self.ctx.style)
    }

    fn resolve_calc_value(&self, calc_ptr: *const (), parent_size: f32) -> f32 {
        resolve_calc_value(calc_ptr, parent_size)
    }

    fn set_unrounded_layout(&mut self, node_id: taffy::NodeId, layout: &taffy::Layout) {
        let node_id = crate::taffy_node_id(self.ctx.cells[usize::from(node_id)].node_id);
        self.doc.set_unrounded_layout(node_id, layout)
    }

    fn compute_child_layout(
        &mut self,
        node_id: taffy::NodeId,
        inputs: taffy::tree::LayoutInput,
    ) -> taffy::LayoutOutput {
        let cell = &self.ctx.cells[usize::from(node_id)];
        let node_id = crate::taffy_node_id(cell.node_id);
        // The cell's own `width` and `height` do not size it: its column and row do (the
        // item style above carries the `height` as the row's minimum, a border box's).
        let mut inputs = inputs;
        inputs.sizing_mode = taffy::SizingMode::ContentSize;
        self.doc.compute_child_layout(node_id, inputs)
    }
}

impl taffy::LayoutGridContainer for TableTreeWrapper<'_, '_> {
    type GridContainerStyle<'a>
        = &'a taffy::Style<Atom>
    where
        Self: 'a;

    type GridItemStyle<'a>
        = &'a taffy::Style<Atom>
    where
        Self: 'a;

    fn get_grid_container_style(&self, node_id: taffy::NodeId) -> Self::GridContainerStyle<'_> {
        self.get_core_container_style(node_id)
    }

    fn get_grid_child_style(&self, child_node_id: taffy::NodeId) -> Self::GridItemStyle<'_> {
        &self.ctx.cells[usize::from(child_node_id)].style
    }

    fn set_detailed_grid_info(
        &mut self,
        _node_id: taffy::NodeId,
        detailed_grid_info: DetailedGridInfo<Atom>,
    ) {
        *self.ctx.computed_grid_info.borrow_mut() = Some(detailed_grid_info);
    }
}


/// A column of the automatic table layout: what its cells ask of it.
#[derive(Clone, Copy, Default)]
struct ColumnDemand {
    /// The narrowest it can be (the widest min-content of its cells)
    min: f32,
    /// The width it wants (the widest max-content of its cells)
    max: f32,
    /// A width a cell or `<col>` gave it
    fixed: Option<f32>,
    /// A percentage of the table's width a cell or `<col>` gave it
    percent: Option<f32>,
}

/// The length of a track that `build_table_context` made from a `<col>` or a first-row cell.
fn track_length(t: &taffy::GridTemplateComponent<Atom>) -> Option<f32> {
    match t {
        taffy::GridTemplateComponent::Single(f) => {
            let max = f.max.into_raw();
            (max.tag() == taffy::CompactLength::LENGTH_TAG).then(|| max.value())
        }
        _ => None,
    }
}

/// The widths of a table's columns by the automatic table layout algorithm
/// (CSS 2.1 17.5.2.2, distributed as Chrome does), as the table's style with
/// those widths for its columns. `None` for a fixed layout or a table without columns.
///
/// Each column wants the widest max-content of its cells (a cell's `width`
/// raises that, to at least its min-content) and needs the widest min-content. A
/// cell that spans columns asks the rest of what its columns lack in proportion to
/// their max widths. The table's width (given, or shrink-to-fit between the sum of
/// the minimums and of the wants within the space it has) is then shared: all
/// minimums if it is not more; the minimums plus the same share of each column's
/// range (max less min) if it is less than the wants; the wants plus the rest in
/// proportion to the wants, to the columns without a given width first, if it is
/// more. A column with a percentage is at least that part of the table.
/// Grid's `auto` tracks share the rest equally instead.
pub(crate) fn auto_columns(
    wrapper: &mut TableTreeWrapper<'_, '_>,
    inputs: taffy::tree::LayoutInput,
) -> Option<taffy::Style<Atom>> {
    let ctx = Arc::clone(&wrapper.ctx);
    if ctx.is_fixed {
        return None;
    }
    let n = ctx.style.grid_template_columns.len();
    if n == 0 {
        return None;
    }
    let calc = |ptr: *const (), basis: f32| resolve_calc_value(ptr, basis);

    // What each cell asks of its columns.
    let mut demands = vec![ColumnDemand::default(); n];
    for (i, t) in ctx.style.grid_template_columns.iter().enumerate() {
        demands[i].fixed = track_length(t);
    }
    let mut spans: Vec<(usize, usize, f32, f32)> = Vec::new();
    for (index, cell) in ctx.cells.iter().enumerate() {
        let id: taffy::NodeId = index.into();
        let measure = |w: &mut TableTreeWrapper<'_, '_>, space: taffy::AvailableSpace| {
            w.compute_child_layout(
                id,
                taffy::tree::LayoutInput {
                    known_dimensions: taffy::Size::NONE,
                    known_dimensions_are_definite: taffy::Size {
                        width: true,
                        height: true,
                    },
                    parent_size: taffy::Size::NONE,
                    available_space: taffy::Size {
                        width: space,
                        height: taffy::AvailableSpace::MaxContent,
                    },
                    sizing_mode: taffy::SizingMode::ContentSize,
                    axis: taffy::RequestedAxis::Horizontal,
                    run_mode: taffy::RunMode::ComputeSize,
                    vertical_margins_are_collapsible: taffy::Line::FALSE,
                },
            )
            .size
            .width
        };
        let min = measure(wrapper, taffy::AvailableSpace::MinContent);
        let max = measure(wrapper, taffy::AvailableSpace::MaxContent).max(min);
        let (c0, cs) = (cell.column as usize, (cell.colspan as usize).max(1));
        if c0 >= n {
            continue;
        }
        // A `width` on the cell: a length (of the content box, unless border-box) or a percentage.
        let width = wrapper.doc.nodes[cell.node_id]
            .primary_styles()
            .map(|s| stylo_taffy::convert::dimension(&s.clone_width()));
        let (mut fixed, mut percent) = (None, None);
        if let Some(width) = width {
            let pb = {
                let padding = cell.style.padding.resolve_or_zero(None, calc);
                let border = cell.style.border.resolve_or_zero(None, calc);
                padding.left + padding.right + border.left + border.right
            };
            // (`cell.style` is border-box for its `height`; the author's `box-sizing` is the node's.)
            let border_box = wrapper.doc.nodes[cell.node_id]
                .primary_styles()
                .is_some_and(|s| s.get_position().box_sizing == style::computed_values::box_sizing::T::BorderBox);
            match width.tag() {
                taffy::CompactLength::LENGTH_TAG => {
                    fixed = Some(if border_box {
                        width.value()
                    } else {
                        width.value() + pb
                    });
                }
                taffy::CompactLength::PERCENT_TAG => percent = Some(width.value()),
                _ => {}
            }
        }
        if cs == 1 {
            let d = &mut demands[c0];
            d.min = d.min.max(min);
            d.max = d.max.max(max);
            if let Some(f) = fixed {
                d.fixed = Some(d.fixed.map_or(f, |g| g.max(f)));
            }
            if let Some(p) = percent {
                d.percent = Some(d.percent.map_or(p, |q| q.max(p)));
            }
        } else {
            spans.push((c0, cs.min(n - c0), min, max));
        }
    }
    for d in demands.iter_mut() {
        if let Some(f) = d.fixed {
            // A given width is the width it wants, but never less than it needs.
            d.max = f.max(d.min);
        }
        d.max = d.max.max(d.min);
    }
    // Cells that span columns: the narrower spans first. A span's minimum is met inside the
    // range its columns already have (each column grows towards what it wants, by how much it
    // has to give), and beyond that, and for what it wants, by the columns without a given width
    // (all of them if every one has a given width), in proportion to what they want.
    spans.sort_by_key(|s| s.1);
    for (c0, cs, min, max) in spans {
        let cols: Vec<usize> = (c0..c0 + cs).collect();
        let free: Vec<usize> = cols
            .iter()
            .copied()
            .filter(|c| demands[*c].fixed.is_none())
            .collect();
        let takers = if free.is_empty() { cols.clone() } else { free };
        let spread = |demands: &mut Vec<ColumnDemand>, extra: f32, what: usize| {
            let weight: f32 = takers.iter().map(|c| demands[*c].max).sum();
            for c in &takers {
                let share = if weight > 0.0 {
                    demands[*c].max / weight
                } else {
                    1.0 / takers.len() as f32
                };
                if what == 0 {
                    demands[*c].min += extra * share;
                } else {
                    demands[*c].max += extra * share;
                }
            }
        };
        let have_min: f32 = cols.iter().map(|c| demands[*c].min).sum();
        let have_max: f32 = cols.iter().map(|c| demands[*c].max).sum();
        if min > have_min {
            if min <= have_max {
                let range: f32 = cols.iter().map(|c| demands[*c].max - demands[*c].min).sum();
                for c in &cols {
                    let give = demands[*c].max - demands[*c].min;
                    demands[*c].min += (min - have_min) * give / range;
                }
            } else {
                for c in &cols {
                    demands[*c].min = demands[*c].max;
                }
                spread(&mut demands, min - have_max, 0);
            }
        }
        for c in &cols {
            demands[*c].max = demands[*c].max.max(demands[*c].min);
        }
        let have_max: f32 = cols.iter().map(|c| demands[*c].max).sum();
        if max > have_max {
            spread(&mut demands, max - have_max, 1);
        }
    }

    // The width the tracks share: the table's less its padding, border and the gaps.
    let style = &ctx.style;
    let parent_width = inputs.parent_size.width;
    let padding = style.padding.resolve_or_zero(parent_width, calc);
    let border = style.border.resolve_or_zero(parent_width, calc);
    let gap = style.gap.width.resolve_or_zero(parent_width, calc);
    let frame = padding.left + padding.right + border.left + border.right + gap * n.saturating_sub(1) as f32;
    let given = inputs.known_dimensions.width.or_else(|| match style.size.width.tag() {
        taffy::CompactLength::LENGTH_TAG => Some(style.size.width.value()),
        taffy::CompactLength::PERCENT_TAG => parent_width.map(|w| w * style.size.width.value()),
        taffy::CompactLength::AUTO_TAG => None,
        _ => Some(calc(style.size.width.calc_value(), parent_width.unwrap_or(0.0))),
    });
    let sum_min: f32 = demands.iter().map(|d| d.min).sum();
    let sum_max: f32 = demands.iter().map(|d| d.max).sum();
    let tracks = match given {
        // A given width is the table's border box, or its content box with `content-box`.
        Some(w) => match style.box_sizing {
            taffy::BoxSizing::BorderBox => (w - frame).max(0.0),
            taffy::BoxSizing::ContentBox => w.max(0.0),
        },
        None => match inputs.available_space.width {
            taffy::AvailableSpace::MinContent => sum_min,
            taffy::AvailableSpace::MaxContent => sum_max,
            taffy::AvailableSpace::Definite(a) => (a - frame).max(sum_min).min(sum_max),
        },
    };

    // A percentage is a share of a table whose width is given: those columns take it (but not
    // less than they need) and the others share what is left.
    let mut widths = vec![0.0_f32; n];
    let mut rest: Vec<usize> = (0..n).collect();
    let mut room = tracks;
    if given.is_some() {
        rest.retain(|i| {
            let Some(p) = demands[*i].percent else {
                return true;
            };
            widths[*i] = (p * tracks).max(demands[*i].min);
            room -= widths[*i];
            false
        });
    }
    let room = room.max(0.0);
    let min_sum: f32 = rest.iter().map(|i| demands[*i].min).sum();
    let max_sum: f32 = rest.iter().map(|i| demands[*i].max).sum();
    if room <= min_sum {
        for i in &rest {
            widths[*i] = demands[*i].min;
        }
    } else if room < max_sum {
        let t = (room - min_sum) / (max_sum - min_sum);
        for i in &rest {
            widths[*i] = demands[*i].min + (demands[*i].max - demands[*i].min) * t;
        }
    } else {
        // More room than the columns want: those without a given width take it, in proportion
        // to what they want; if every column has one, all of them.
        let free = |i: &usize| demands[*i].fixed.is_none();
        let grows: Vec<usize> = if rest.iter().any(free) {
            rest.iter().copied().filter(free).collect()
        } else {
            rest.clone()
        };
        let weight: f32 = grows.iter().map(|i| demands[*i].max).sum();
        for i in &rest {
            widths[*i] = demands[*i].max;
        }
        for i in &grows {
            widths[*i] += if weight > 0.0 {
                (room - max_sum) * demands[*i].max / weight
            } else {
                (room - max_sum) / grows.len() as f32
            };
        }
    }

    let mut out = style.clone();
    out.grid_template_columns = widths
        .into_iter()
        .map(|w| style_helpers::length::<f32, TrackSizingFunction>(w).into())
        .collect();
    Some(out)
}

/// A caption laid out for a table of a given width.
pub(crate) struct PlacedCaption {
    node: NodeId,
    output: taffy::LayoutOutput,
    margin: taffy::Rect<f32>,
    padding: taffy::Rect<f32>,
    border: taffy::Rect<f32>,
    above: bool,
}

/// The table's captions laid out as blocks of the table's width, and how much of
/// its box those above and below the grid take.
pub(crate) struct Captions {
    placed: Vec<PlacedCaption>,
    pub above: f32,
    pub below: f32,
}

/// Lays out the table's captions for a table box `width` wide. `None` without captions.
pub(crate) fn measure_captions(
    doc: &mut LayoutPassState<'_>,
    ctx: &TableContext,
    width: f32,
    run_mode: taffy::RunMode,
) -> Option<Captions> {
    use style::computed_values::caption_side::T as CaptionSide;
    use taffy::CoreStyle as _;

    if ctx.captions.is_empty() {
        return None;
    }
    let mut placed = Vec::new();
    for &caption in &ctx.captions {
        let above = doc.nodes[caption]
            .primary_styles()
            .is_none_or(|s| s.get_inherited_table().caption_side == CaptionSide::Top);
        let (margin, padding, border) = {
            let style = doc.child_layout_style(&doc.nodes[caption]);
            let basis = Some(width);
            (
                style.margin().resolve_or_zero(basis, resolve_calc_value),
                style.padding().resolve_or_zero(basis, resolve_calc_value),
                style.border().resolve_or_zero(basis, resolve_calc_value),
            )
        };
        let avail = (width - margin.left - margin.right).max(0.0);
        let output = doc.compute_child_layout(
            crate::taffy_node_id(caption),
            taffy::tree::LayoutInput {
                known_dimensions: taffy::Size {
                    width: Some(avail),
                    height: None,
                },
                known_dimensions_are_definite: taffy::Size {
                    width: true,
                    height: true,
                },
                parent_size: taffy::Size {
                    width: Some(width),
                    height: None,
                },
                available_space: taffy::Size {
                    width: taffy::AvailableSpace::Definite(avail),
                    height: taffy::AvailableSpace::MaxContent,
                },
                sizing_mode: taffy::SizingMode::InherentSize,
                axis: taffy::RequestedAxis::Both,
                run_mode,
                vertical_margins_are_collapsible: taffy::Line::FALSE,
            },
        );
        placed.push(PlacedCaption {
            node: caption,
            output,
            margin,
            padding,
            border,
            above,
        });
    }
    let outer = |c: &PlacedCaption| c.output.size.height + c.margin.top + c.margin.bottom;
    let above = placed.iter().filter(|c| c.above).map(outer).sum();
    let below = placed.iter().filter(|c| !c.above).map(outer).sum();
    Some(Captions {
        placed,
        above,
        below,
    })
}

/// Puts the captions around the grid whose layout `output` is: the cells and the
/// grid's rows move down by the height of the captions above, the captions
/// take their places, and the table's size takes them in.
pub(crate) fn place_captions(
    doc: &mut LayoutPassState<'_>,
    ctx: &TableContext,
    captions: Captions,
    run_mode: taffy::RunMode,
    output: &mut taffy::LayoutOutput,
) {
    let (above, below) = (captions.above, captions.below);
    if run_mode == taffy::RunMode::PerformLayout {
        if above != 0.0 {
            for cell in &ctx.cells {
                doc.nodes[cell.node_id].unrounded_layout_mut().location.y += above;
            }
            if let Some(info) = ctx.computed_grid_info.borrow_mut().as_mut() {
                for line in info.rows.positions.iter_mut() {
                    line.start += above;
                    line.end += above;
                }
            }
        }
        *ctx.caption_extent.borrow_mut() = [above, below];
        let (mut y_above, mut y_below) = (0.0, above + output.size.height);
        for (order, c) in captions.placed.into_iter().enumerate() {
            let y = if c.above { &mut y_above } else { &mut y_below };
            let layout = doc.nodes[c.node].unrounded_layout_mut();
            layout.order = (ctx.cells.len() + order) as u32;
            layout.location = taffy::Point {
                x: c.margin.left,
                y: *y + c.margin.top,
            };
            layout.size = c.output.size;
            layout.scrollable_overflow_rect = c.output.scrollable_overflow_rect;
            layout.margin = c.margin;
            layout.padding = c.padding;
            layout.border = c.border;
            *y += c.output.size.height + c.margin.top + c.margin.bottom;
        }
    }
    output.size.height += above + below;
    output.scrollable_overflow_rect.bottom += above + below;
}
