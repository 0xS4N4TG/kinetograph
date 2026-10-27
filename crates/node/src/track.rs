//! `track` (`kinetograph track`, AUTHORING.md "Motion tracking"): points tracked through a video with Blender's
//! tracker (`kinetograph-track`), returned as the `.track.json` text. CPU only; never called during a render.

use kinetograph_track::{Match, MotionModel, Options, Point, track_video};
use napi_derive::napi;

use crate::error::{Code, Result, error, invalid};
use crate::resolve_base;

/// A point to track, in video pixels of the first frame tracked (y down, (0, 0) the top-left corner).
#[napi(object)]
pub struct TrackPoint {
    /// Default `p1`, `p2`, ... in order.
    pub name: Option<String>,
    pub x: f64,
    pub y: f64,
}

/// What to track and how; every setting defaults to Blender's for a new track.
#[napi(object)]
pub struct TrackRequest {
    pub points: Vec<TrackPoint>,
    /// `loc` (default), `locrot`, `locscale`, `locrotscale`, `affine`, `perspective`.
    pub model: Option<String>,
    /// Pattern square, px (21).
    pub pattern: Option<u32>,
    /// Search square, px (71).
    pub search: Option<u32>,
    /// Minimum correlation (0.75).
    pub min_correlation: Option<f64>,
    /// Px the pattern keeps from the frame edge (0).
    pub margin: Option<u32>,
    pub normalize: Option<bool>,
    /// Brute-force pre-pass (on).
    pub brute: Option<bool>,
    /// `keyframe` (default) or `previous`.
    #[napi(js_name = "match")]
    pub matching: Option<String>,
    /// First frame (0).
    pub from: Option<u32>,
    /// Last frame (the clip's last).
    pub to: Option<u32>,
    /// Place the points at `to` and track back to `from`.
    pub backwards: Option<bool>,
}

/// Tracks the points through the video at `path` (resolved against `baseDir`) and returns the track file's JSON.
#[napi]
pub fn track(path: String, request: TrackRequest, base_dir: Option<String>) -> Result<String> {
    let path = resolve_base(base_dir).join(path);
    std::fs::metadata(&path).map_err(|e| error(Code::Io, format!("cannot read {}: {e}", path.display())))?;
    if request.points.is_empty() {
        return Err(invalid("track needs at least one point"));
    }
    let defaults = Options::default();
    let options = Options {
        model: request.model.as_deref().map(MotionModel::parse).transpose().map_err(invalid)?.unwrap_or(defaults.model),
        pattern_size: request.pattern.unwrap_or(defaults.pattern_size),
        search_size: request.search.unwrap_or(defaults.search_size),
        min_correlation: request.min_correlation.unwrap_or(defaults.min_correlation),
        margin: request.margin.unwrap_or(defaults.margin),
        normalize: request.normalize.unwrap_or(defaults.normalize),
        brute: request.brute.unwrap_or(defaults.brute),
        matching: request.matching.as_deref().map(Match::parse).transpose().map_err(invalid)?.unwrap_or(defaults.matching),
    };
    let points: Vec<Point> = request
        .points
        .into_iter()
        .enumerate()
        .map(|(i, p)| Point { name: p.name.unwrap_or_else(|| format!("p{}", i + 1)), x: p.x, y: p.y })
        .collect();
    let file = track_video(&path, &points, &options, request.from, request.to, request.backwards.unwrap_or(false)).map_err(invalid)?;
    Ok(file.to_json())
}
