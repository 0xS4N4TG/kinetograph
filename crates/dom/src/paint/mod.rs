//! The painter (docs/ENGINE.md §4, stream 2): a styled, laid-out Blitz document
//! walked in CSS paint order and written as scene layers.

pub mod svg;

use blitz_dom::BaseDocument;

use crate::request::{IslandOutput, IslandRequest};

/// Paints a document that `resolve` has styled and laid out.
pub fn paint(doc: &BaseDocument, request: &IslandRequest) -> IslandOutput {
    let _ = (doc, request);
    IslandOutput::default()
}
