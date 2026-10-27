//! The `.track.json` file `kinetograph track` writes and `useTrack()` reads (AUTHORING.md, "Motion tracking"):
//!
//! ```json
//! { "version": 1,
//!   "clip": { "width": 1920, "height": 1080, "fps": 30, "frames": 120 },
//!   "tracks": [ { "name": "p1", "model": "loc",
//!                 "frames": [ { "frame": 0, "center": [x, y], "corners": [[x, y], [x, y], [x, y], [x, y]],
//!                               "correlation": 1 } ],
//!                 "lost": [57] } ] }
//! ```
//!
//! Video pixels, y down, (0, 0) the frame's top-left corner; corners top-left, top-right, bottom-right, bottom-left.
//! `frames` is in increasing frame order; `lost` holds the frame where a track stopped before the end of the range.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TrackFile {
    pub version: u32,
    pub clip: Clip,
    pub tracks: Vec<TrackedPath>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Clip {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub frames: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TrackedPath {
    pub name: String,
    pub model: String,
    pub frames: Vec<TrackedFrame>,
    pub lost: Vec<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct TrackedFrame {
    pub frame: u32,
    pub center: [f32; 2],
    pub corners: [[f32; 2]; 4],
    /// How well the pattern matched (1 at the placed frame).
    pub correlation: f32,
}

impl TrackFile {
    pub const VERSION: u32 = 1;

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("a track file serialises")
    }
}
