//! The full engine's front half (docs/ENGINE.md): a React host tree styled by
//! Stylo and laid out by taffy and Parley through Blitz's DOM, then painted as
//! Kinetograph scene layers by our own compositor.
//!
//! Ownership (docs/ENGINE.md §3): `request`, `document` and `readback` are
//! stream 1's; `paint` is stream 2's; `paint::svg` is stream 3's.

pub mod paint;
pub mod request;

pub use request::{IslandOutput, IslandRequest};
