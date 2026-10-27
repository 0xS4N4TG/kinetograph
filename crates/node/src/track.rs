//! `track` (`kinetograph track`, AUTHORING.md "Motion tracking"): points tracked through a video with Blender's
//! tracker (`kinetograph-track`), placed by hand or by Blender's Detect Features, and plane tracks made from them,
//! returned as the `.track.json` text. CPU only; never called during a render.

use kinetograph_track::{
    DetectOptions, Job, Match, MotionModel, Options, Placement, PlaneRequest, Point, track_video,
};
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

/// Blender's Detect Features; every setting defaults to the operator's.
#[napi(object)]
pub struct TrackDetect {
    /// Px from the frame edge where nothing is detected (16).
    pub margin: Option<u32>,
    /// Harris threshold, Blender's units (0.5).
    pub threshold: Option<f64>,
    /// Px between features, at least (120).
    pub min_distance: Option<u32>,
    /// Keep only features inside one of these polygons (flat x, y lists in video pixels).
    pub inside: Option<Vec<Vec<f64>>>,
    /// Keep only features outside all of these polygons.
    pub outside: Option<Vec<Vec<f64>>>,
}

/// A plane track made from point tracks.
#[napi(object)]
pub struct TrackPlane {
    /// Default `plane1`, `plane2`, ... in order.
    pub name: Option<String>,
    /// Names of the point tracks it follows (at least 4); default every track.
    pub tracks: Option<Vec<String>>,
    /// Its corners at the frame the points are placed at: x, y of top-left, top-right, bottom-right, bottom-left in
    /// video pixels. Default: the bounding box of the tracks' patterns, as Blender makes a new plane.
    pub corners: Option<Vec<f64>>,
}

/// What to track and how; every setting defaults to Blender's for a new track.
#[napi(object)]
pub struct TrackRequest {
    /// Points placed by hand; may be empty when `detect` is given.
    pub points: Vec<TrackPoint>,
    /// Place more points with Detect Features at the frame the points are placed at.
    pub detect: Option<TrackDetect>,
    pub planes: Option<Vec<TrackPlane>>,
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

/// Tracks the points through the video at `path` (resolved against `baseDir`), detecting more first and making the
/// plane tracks after when asked, and returns the track file's JSON.
#[napi]
pub fn track(path: String, request: TrackRequest, base_dir: Option<String>) -> Result<String> {
    let path = resolve_base(base_dir).join(path);
    std::fs::metadata(&path)
        .map_err(|e| error(Code::Io, format!("cannot read {}: {e}", path.display())))?;
    if request.points.is_empty() && request.detect.is_none() {
        return Err(invalid("track needs at least one point, or detect"));
    }
    let defaults = Options::default();
    let options = Options {
        model: request
            .model
            .as_deref()
            .map(MotionModel::parse)
            .transpose()
            .map_err(invalid)?
            .unwrap_or(defaults.model),
        pattern_size: request.pattern.unwrap_or(defaults.pattern_size),
        search_size: request.search.unwrap_or(defaults.search_size),
        min_correlation: request.min_correlation.unwrap_or(defaults.min_correlation),
        margin: request.margin.unwrap_or(defaults.margin),
        normalize: request.normalize.unwrap_or(defaults.normalize),
        brute: request.brute.unwrap_or(defaults.brute),
        matching: request
            .matching
            .as_deref()
            .map(Match::parse)
            .transpose()
            .map_err(invalid)?
            .unwrap_or(defaults.matching),
    };
    let points: Vec<Point> = request
        .points
        .into_iter()
        .enumerate()
        .map(|(i, p)| Point {
            name: p.name.unwrap_or_else(|| format!("p{}", i + 1)),
            x: p.x,
            y: p.y,
        })
        .collect();
    let detect = request.detect.map(detect_options).transpose()?;
    let planes = request
        .planes
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(i, p)| {
            let corners = match p.corners {
                None => None,
                Some(c) if c.len() == 8 => {
                    Some([[c[0], c[1]], [c[2], c[3]], [c[4], c[5]], [c[6], c[7]]])
                }
                Some(c) => {
                    return Err(invalid(format!(
                        "a plane's corners are 8 numbers (x, y of four corners), got {}",
                        c.len()
                    )));
                }
            };
            Ok(PlaneRequest {
                name: p.name.unwrap_or_else(|| format!("plane{}", i + 1)),
                tracks: p.tracks.unwrap_or_default(),
                corners,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let job = Job {
        points,
        detect,
        options,
        first: request.from,
        last: request.to,
        backwards: request.backwards.unwrap_or(false),
        planes,
    };
    let file = track_video(&path, &job).map_err(invalid)?;
    Ok(file.to_json())
}

fn polygons(list: Vec<Vec<f64>>) -> Result<Vec<Vec<[f64; 2]>>> {
    list.into_iter()
        .map(|p| {
            if p.len() < 6 || p.len() % 2 != 0 {
                return Err(invalid(format!(
                    "a detect polygon is x, y pairs, at least 3 of them (got {} numbers)",
                    p.len()
                )));
            }
            Ok(p.as_chunks::<2>().0.to_vec())
        })
        .collect()
}

fn detect_options(d: TrackDetect) -> Result<DetectOptions> {
    let defaults = DetectOptions::default();
    let placement = match (d.inside, d.outside) {
        (Some(_), Some(_)) => {
            return Err(invalid(
                "detect takes inside or outside polygons, not both (Blender has one placement)",
            ));
        }
        (Some(inside), None) => Placement::Inside(polygons(inside)?),
        (None, Some(outside)) => Placement::Outside(polygons(outside)?),
        (None, None) => Placement::Frame,
    };
    Ok(DetectOptions {
        margin: d.margin.unwrap_or(defaults.margin),
        threshold: d.threshold.map_or(defaults.threshold, |t| t as f32),
        min_distance: d.min_distance.unwrap_or(defaults.min_distance),
        placement,
    })
}
