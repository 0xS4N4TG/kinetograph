//! Motion tracking with Blender's tracker: libmv's `AutoTrack` (`libmv-sys`), driven the way Blender's "Track Markers"
//! drives it, so a point tracked here follows the path Blender gives it for the same clip and settings.
//!
//! Tracking is precomputed (`kinetograph track`, `track_video`) into a `.track.json` (`file.rs`) that a render reads;
//! it never runs during a render.
//!
//! Coordinates in and out are video pixels, x right and y down, with (0, 0) the top-left corner of the frame (so the
//! centre of the top-left pixel is (0.5, 0.5)), as CSS places things. Inside, the tracker works in libmv's pixels on
//! frames handed over bottom row first, as Blender's image buffers are: x - 0.5 and height - 0.5 - y. Blender's
//! normalised marker position (u, v), v up, is (u * width, (1 - v) * height) here.
//!
//! What follows Blender (4.5, `tracking_auto.cc` and `tracking_util.cc`, as behaviour; none of its GPL code is used):
//!
//! - a new marker's pattern is the square `pattern_size` px wide around the point, its search area the square
//!   `search_size` px wide (defaults 21 and 71);
//! - grayscale is 0.2126 R + 0.7152 G + 0.0722 B of the 8-bit values over 255, computed for the search region only;
//! - each frame, every live track is tracked from its last marker one frame on (or back); the pattern matched is the
//!   keyframe's (the placed marker, Blender's default "Keyframe" match) or the previous frame's;
//! - before each step the margin check: a marker whose pattern (or `margin` px, if larger) reaches past the frame edge
//!   stops its track;
//! - a step libmv cannot use (correlation under the minimum, fell out of the search area, ...) ends the track; Blender
//!   then keeps the marker where it was and disables it at that frame, which is the frame listed in `lost`.

mod file;
mod video;

#[cfg(test)]
mod tests;

use std::os::raw::{c_int, c_void};

use libmv_sys as sys;

pub use file::{Clip, TrackFile, TrackedFrame, TrackedPath};
pub use video::{VideoFrames, track_video};

/// libmv's motion models, in Blender's order (`MovieTrackingTrack.motion_model`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MotionModel {
    /// Position only (Blender's default).
    #[default]
    Loc,
    LocRot,
    LocScale,
    LocRotScale,
    Affine,
    Perspective,
}

impl MotionModel {
    pub const ALL: [MotionModel; 6] = [
        MotionModel::Loc,
        MotionModel::LocRot,
        MotionModel::LocScale,
        MotionModel::LocRotScale,
        MotionModel::Affine,
        MotionModel::Perspective,
    ];

    /// The name used on the command line and in the file: `loc`, `locrot`, `locscale`, `locrotscale`, `affine`,
    /// `perspective`.
    pub fn name(self) -> &'static str {
        match self {
            MotionModel::Loc => "loc",
            MotionModel::LocRot => "locrot",
            MotionModel::LocScale => "locscale",
            MotionModel::LocRotScale => "locrotscale",
            MotionModel::Affine => "affine",
            MotionModel::Perspective => "perspective",
        }
    }

    pub fn parse(name: &str) -> Result<MotionModel, String> {
        MotionModel::ALL.into_iter().find(|m| m.name() == name).ok_or_else(|| {
            let names: Vec<_> = MotionModel::ALL.iter().map(|m| m.name()).collect();
            format!("unknown motion model \"{name}\" (one of {})", names.join(", "))
        })
    }

    fn raw(self) -> c_int {
        match self {
            MotionModel::Loc => sys::KT_MOTION_LOC,
            MotionModel::LocRot => sys::KT_MOTION_LOC_ROT,
            MotionModel::LocScale => sys::KT_MOTION_LOC_SCALE,
            MotionModel::LocRotScale => sys::KT_MOTION_LOC_ROT_SCALE,
            MotionModel::Affine => sys::KT_MOTION_AFFINE,
            MotionModel::Perspective => sys::KT_MOTION_PERSPECTIVE,
        }
    }
}

/// Which pattern a frame is matched against (Blender's `pattern_match`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Match {
    /// The pattern of the placed marker (Blender's default).
    #[default]
    Keyframe,
    /// The pattern found in the frame before.
    Previous,
}

impl Match {
    pub fn name(self) -> &'static str {
        match self {
            Match::Keyframe => "keyframe",
            Match::Previous => "previous",
        }
    }

    pub fn parse(name: &str) -> Result<Match, String> {
        match name {
            "keyframe" => Ok(Match::Keyframe),
            "previous" => Ok(Match::Previous),
            _ => Err(format!("unknown match \"{name}\" (keyframe or previous)")),
        }
    }
}

/// A track's settings, with Blender's defaults for a new track.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Options {
    pub model: MotionModel,
    /// Width of the pattern square, px (21).
    pub pattern_size: u32,
    /// Width of the search square, px (71).
    pub search_size: u32,
    /// A match worse than this ends the track (0.75).
    pub min_correlation: f64,
    /// Px the pattern keeps from the frame edge, at least (0).
    pub margin: u32,
    /// Match brightness-normalised patterns (off).
    pub normalize: bool,
    /// Search the area by brute force before refining (on).
    pub brute: bool,
    pub matching: Match,
}

impl Default for Options {
    fn default() -> Options {
        Options {
            model: MotionModel::Loc,
            pattern_size: 21,
            search_size: 71,
            min_correlation: 0.75,
            margin: 0,
            normalize: false,
            brute: true,
            matching: Match::Keyframe,
        }
    }
}

/// A point to track: where it is in the first frame tracked, in video pixels (y down, see the crate docs).
#[derive(Clone, Debug, PartialEq)]
pub struct Point {
    pub name: String,
    pub x: f64,
    pub y: f64,
}

/// What the tracker reads: a clip's frames as straight RGBA8, rows top first, `width * height * 4` bytes.
pub trait Frames {
    fn width(&self) -> u32;
    fn height(&self) -> u32;
    /// How many frames there are; they are numbered from 0.
    fn count(&self) -> u32;
    /// Frame `frame`'s pixels. `backwards` says the tracker is going towards frame 0, for a source that reads ahead.
    fn rgba(&mut self, frame: u32, backwards: bool) -> Result<&[u8], String>;
}

/// The range to track and the way: points are placed at `from` and tracked to `to` (forwards), or placed at `to` and
/// tracked back to `from` (`backwards`). Both ends included.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Range {
    pub from: u32,
    pub to: u32,
    pub backwards: bool,
}

/// One marker in libmv's space (see the crate docs).
type RawMarker = sys::kt_marker;

/// What the region callback reads from: the frames, and the first error they gave.
struct Reader<'a> {
    frames: &'a mut dyn Frames,
    backwards: bool,
    error: Option<String>,
}

/// Fills a region of a frame the way Blender's frame accessor does: rows bottom first, each 8-bit channel over 255,
/// then 0.2126 R + 0.7152 G + 0.0722 B. Outside the frame stays zero.
unsafe extern "C" fn read_region(
    user: *mut c_void,
    frame: c_int,
    x: c_int,
    y: c_int,
    width: c_int,
    height: c_int,
    out: *mut f32,
) -> c_int {
    // SAFETY: `user` is the `Reader` that `Tracker::track` set up and is live for the call; `out` holds
    // `width * height` floats (kt_libmv.h).
    let reader = unsafe { &mut *(user as *mut Reader) };
    let out = unsafe { std::slice::from_raw_parts_mut(out, (width.max(0) * height.max(0)) as usize) };
    let (w, h) = (reader.frames.width() as i64, reader.frames.height() as i64);
    if frame < 0 || frame as u32 >= reader.frames.count() {
        return 0;
    }
    let rgba = match reader.frames.rgba(frame as u32, reader.backwards) {
        Ok(rgba) => rgba,
        Err(e) => {
            reader.error.get_or_insert(e);
            return 0;
        }
    };
    for row in 0..height as i64 {
        let ly = y as i64 + row;
        if ly < 0 || ly >= h {
            continue;
        }
        let source = ((h - 1 - ly) * w) as usize * 4;
        for col in 0..width as i64 {
            let lx = x as i64 + col;
            if lx < 0 || lx >= w {
                continue;
            }
            let p = &rgba[source + lx as usize * 4..];
            let (r, g, b) =
                (p[0] as f32 * (1.0 / 255.0), p[1] as f32 * (1.0 / 255.0), p[2] as f32 * (1.0 / 255.0));
            out[(row * width as i64 + col) as usize] = 0.2126f32 * r + 0.7152f32 * g + 0.0722f32 * b;
        }
    }
    1
}

/// libmv's `AutoTrack` over one clip: the markers it knows (placed and tracked) and the frames it reads.
pub struct Tracker<'a> {
    raw: *mut sys::kt_tracker,
    reader: Box<Reader<'a>>,
}

impl<'a> Tracker<'a> {
    pub fn new(frames: &'a mut dyn Frames) -> Result<Tracker<'a>, String> {
        let (w, h, n) = (frames.width() as c_int, frames.height() as c_int, frames.count() as c_int);
        let mut reader = Box::new(Reader { frames, backwards: false, error: None });
        let user = &mut *reader as *mut Reader as *mut c_void;
        // SAFETY: `reader` is boxed, so `user` stays valid as long as the tracker, which is freed first (Drop).
        let raw = unsafe { sys::kt_tracker_new(w, h, n, read_region, user) };
        if raw.is_null() {
            return Err("cannot make the tracker".into());
        }
        Ok(Tracker { raw, reader })
    }

    fn add(&mut self, marker: &RawMarker, tracked: bool) {
        // SAFETY: a live tracker and a marker it copies.
        unsafe { sys::kt_tracker_add_marker(self.raw, marker, c_int::from(tracked)) };
    }

    /// Tracks `marker` (holding the guess: last marker moved to the new frame, `reference_frame` set) into its frame.
    /// Ok(None) when libmv cannot use the result; Err when a frame could not be read.
    fn track(
        &mut self,
        options: &Options,
        backwards: bool,
        marker: &mut RawMarker,
    ) -> Result<Option<f64>, String> {
        let mut raw = sys::kt_track_options::default();
        // SAFETY: fills the struct.
        unsafe { sys::kt_track_options_default(&mut raw) };
        raw.motion_model = options.model.raw();
        raw.backwards = c_int::from(backwards);
        raw.use_brute = c_int::from(options.brute);
        raw.use_normalization = c_int::from(options.normalize);
        raw.minimum_correlation = options.min_correlation;
        self.reader.backwards = backwards;
        let mut result = sys::kt_track_result::default();
        // SAFETY: a live tracker; the reader its callback uses is live and not otherwise borrowed during the call.
        let ok = unsafe { sys::kt_tracker_track(self.raw, &raw, marker, &mut result) };
        if let Some(e) = self.reader.error.take() {
            return Err(e);
        }
        Ok((ok != 0).then_some(result.correlation))
    }
}

impl Drop for Tracker<'_> {
    fn drop(&mut self) {
        // SAFETY: made by kt_tracker_new, freed once.
        unsafe { sys::kt_tracker_free(self.raw) };
    }
}

/// A new marker at `point` (video pixels), as Blender makes one: pattern and search squares around it, corners in
/// Blender's order (its bottom-left, bottom-right, top-right, top-left, v up).
fn place(point: &Point, frame: u32, track: usize, options: &Options, height: u32) -> RawMarker {
    let x = (point.x - 0.5) as f32;
    let y = (f64::from(height) - 0.5 - point.y) as f32;
    let p = options.pattern_size as f32 / 2.0;
    let s = options.search_size as f32 / 2.0;
    RawMarker {
        frame: frame as c_int,
        track: track as c_int,
        center: [x, y],
        patch: [[x - p, y - p], [x + p, y - p], [x + p, y + p], [x - p, y + p]],
        search_min: [x - s, y - s],
        search_max: [x + s, y + s],
        reference_frame: frame as c_int,
    }
}

/// Blender's margin check: false when the pattern, or `margin` px if that is more, reaches past a frame edge.
fn inside_margin(m: &RawMarker, margin: u32, width: u32, height: u32) -> bool {
    let (mut min, mut max) = ([f32::MAX; 2], [f32::MIN; 2]);
    for c in &m.patch {
        for i in 0..2 {
            min[i] = min[i].min(c[i]);
            max[i] = max[i].max(c[i]);
        }
    }
    let margin = margin as f32;
    let left = (m.center[0] - min[0]).max(margin);
    let right = (max[0] - m.center[0]).max(margin);
    let bottom = (m.center[1] - min[1]).max(margin);
    let top = (max[1] - m.center[1]).max(margin);
    !(m.center[0] < left
        || m.center[0] > width as f32 - right
        || m.center[1] < bottom
        || m.center[1] > height as f32 - top)
}

/// A marker in video pixels; corners top-left, top-right, bottom-right, bottom-left as seen (y down).
fn to_video(m: &RawMarker, frame: u32, correlation: f64, height: u32) -> TrackedFrame {
    let h = height as f32;
    let at = |p: [f32; 2]| [p[0] + 0.5, h - 0.5 - p[1]];
    TrackedFrame {
        frame,
        center: at(m.center),
        // libmv's corner 3 is Blender's top-left (v up), which is top-left on screen too.
        corners: [at(m.patch[3]), at(m.patch[2]), at(m.patch[1]), at(m.patch[0])],
        correlation: correlation as f32,
    }
}

/// Tracks every point through `range` with the same options, the way Blender tracks selected markers: frame by frame,
/// each live track one step. Each path lists its frames in increasing order.
pub fn track_points(
    frames: &mut dyn Frames,
    points: &[Point],
    options: &Options,
    range: Range,
) -> Result<Vec<TrackedPath>, String> {
    let (width, height, count) = (frames.width(), frames.height(), frames.count());
    if count == 0 {
        return Err("the clip has no frames".into());
    }
    if range.from > range.to || range.to >= count {
        return Err(format!("frames {}..{} are not in the clip (frames 0..{})", range.from, range.to, count - 1));
    }
    if options.pattern_size < 5 || options.search_size < options.pattern_size {
        return Err(format!(
            "the pattern must be at least 5 px and the search area at least as big (got {} and {})",
            options.pattern_size, options.search_size
        ));
    }
    for p in points {
        if !(0.0..=f64::from(width)).contains(&p.x) || !(0.0..=f64::from(height)).contains(&p.y) {
            return Err(format!("point \"{}\" ({}, {}) is outside the {width}x{height} frame", p.name, p.x, p.y));
        }
    }
    let start = if range.backwards { range.to } else { range.from };
    let mut tracker = Tracker::new(frames)?;

    struct Live {
        current: RawMarker,
        frames: Vec<TrackedFrame>,
        lost: Vec<u32>,
        live: bool,
    }
    let mut live: Vec<Live> = points
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let m = place(p, start, i, options, height);
            Live { current: m, frames: vec![to_video(&m, start, 1.0, height)], lost: Vec::new(), live: true }
        })
        .collect();
    for t in &live {
        tracker.add(&t.current, false);
    }

    let steps = range.to - range.from;
    for step in 1..=steps {
        let frame = if range.backwards { start - step } else { start + step };
        for t in live.iter_mut().filter(|t| t.live) {
            if !inside_margin(&t.current, options.margin, width, height) {
                t.lost.push(frame);
                t.live = false;
                continue;
            }
            let mut next = t.current;
            next.frame = frame as c_int;
            next.reference_frame = match options.matching {
                Match::Keyframe => t.current.reference_frame,
                Match::Previous => t.current.frame,
            };
            match tracker.track(options, range.backwards, &mut next)? {
                Some(correlation) => {
                    tracker.add(&next, true);
                    t.frames.push(to_video(&next, frame, correlation, height));
                    t.current = next;
                }
                None => {
                    t.lost.push(frame);
                    t.live = false;
                }
            }
        }
        if live.iter().all(|t| !t.live) {
            break;
        }
    }

    Ok(live
        .into_iter()
        .zip(points)
        .map(|(mut t, p)| {
            if range.backwards {
                t.frames.reverse();
            }
            TrackedPath { name: p.name.clone(), model: options.model.name().into(), frames: t.frames, lost: t.lost }
        })
        .collect())
}
