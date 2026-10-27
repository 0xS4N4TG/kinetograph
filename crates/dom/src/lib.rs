//! The full engine's front half (packages/cli/skills/kinetograph/references/ENGINE.md): a React host tree styled by
//! Stylo and laid out by taffy and Parley through Blitz's DOM, then painted as
//! Kinetograph scene layers by our own compositor.
//!
//! Ownership (packages/cli/skills/kinetograph/references/ENGINE.md §3): `request`, `document`, `fonts`, `net`, `ua`
//! and `readback` are stream 1's; `paint` is stream 2's; `paint::svg` is
//! stream 3's.

pub mod clamp;
pub mod collapse;
pub mod document;
pub mod fonts;
pub mod inline;
pub mod motion;
pub mod net;
pub mod paint;
pub mod readback;
pub mod request;
pub mod transform;
pub mod ua;

pub use request::{IslandOutput, IslandRequest};
