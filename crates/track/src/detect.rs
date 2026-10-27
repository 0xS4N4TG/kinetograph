//! Blender's "Detect Features" (`bpy.ops.clip.detect_features`): libmv's Harris detector over one frame, each feature
//! becoming a point to track.
//!
//! What follows Blender (as behaviour, from its manual and from running it; none of its GPL code is used):
//!
//! - the frame goes to libmv as Blender's image buffer holds it: RGBA, rows bottom first, each byte over 255; libmv
//!   turns it grey (0.2126 R + 0.7152 G + 0.0722 B);
//! - the defaults are the operator's: margin 16 px, threshold 0.5, minimum distance 120 px, placement the whole frame;
//!   the threshold reaches libmv divided by 100000 (in f32), as Blender passes it;
//! - a feature at libmv's pixel (x, y) is a marker at Blender's normalised ((x + 0.5) / width, (y + 0.5) / height),
//!   v up; the markers are added in the reverse of libmv's order (libmv lists the best first);
//! - placement inside or outside an annotation keeps the features inside any of its strokes (an even-odd test in
//!   normalised f32 coordinates), or outside all of them. Here the strokes are polygons in video pixels.

use std::os::raw::c_int;

use libmv_sys as sys;

use crate::Frames;

/// Which detected features are kept (Blender's `placement`).
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Placement {
    /// All of them (Blender's default, `FRAME`).
    #[default]
    Frame,
    /// Those inside any of these polygons (`INSIDE_GPENCIL`), each a list of points in video pixels (y down).
    Inside(Vec<Vec<[f64; 2]>>),
    /// Those outside all of these polygons (`OUTSIDE_GPENCIL`).
    Outside(Vec<Vec<[f64; 2]>>),
}

/// Detect Features' settings, with Blender's defaults.
#[derive(Clone, Debug, PartialEq)]
pub struct DetectOptions {
    /// Px from the frame edge where nothing is detected (16).
    pub margin: u32,
    /// Harris response a feature must pass, in Blender's units (0.5; libmv gets it over 100000).
    pub threshold: f32,
    /// Px a feature keeps from every better one (120).
    pub min_distance: u32,
    pub placement: Placement,
}

impl Default for DetectOptions {
    fn default() -> DetectOptions {
        DetectOptions {
            margin: 16,
            threshold: 0.5,
            min_distance: 120,
            placement: Placement::Frame,
        }
    }
}

/// Blender's normalised f32 position (v up) of the video pixel point (x, y).
pub(crate) fn normalised(x: f64, y: f64, width: u32, height: u32) -> [f32; 2] {
    let (w, h) = (f64::from(width), f64::from(height));
    [(x / w) as f32, ((h - y) / h) as f32]
}

/// Even-odd test: whether the point is inside the polygon (normalised coordinates, f32 as Blender's strokes are).
fn inside_polygon(polygon: &[[f32; 2]], p: [f32; 2]) -> bool {
    let mut inside = false;
    let mut prev = polygon.len().wrapping_sub(1);
    for (i, a) in polygon.iter().enumerate() {
        let b = polygon[prev];
        if (a[1] < p[1] && b[1] >= p[1]) || (b[1] < p[1] && a[1] >= p[1]) {
            let t = (p[1] - a[1]) / (b[1] - a[1]);
            if a[0] + t * (b[0] - a[0]) < p[0] {
                inside = !inside;
            }
        }
        prev = i;
    }
    inside
}

/// Runs Detect Features on frame `frame` and returns the features as points in video pixels (y down), in the order
/// Blender adds their tracks.
pub fn detect_features(
    frames: &mut dyn Frames,
    frame: u32,
    options: &DetectOptions,
) -> Result<Vec<[f64; 2]>, String> {
    let (width, height) = (frames.width(), frames.height());
    if frame >= frames.count() {
        return Err(format!(
            "frame {frame} is not in the clip (frames 0..{})",
            frames.count().saturating_sub(1)
        ));
    }
    if !(options.threshold.is_finite() && options.threshold >= 0.0) {
        return Err(format!(
            "the detect threshold must be 0 or more (got {})",
            options.threshold
        ));
    }
    let rgba = frames.rgba(frame, false)?;
    // Blender's image buffers hold the bottom row first.
    let row = width as usize * 4;
    let mut flipped = Vec::with_capacity(rgba.len());
    for r in rgba.chunks_exact(row).rev() {
        flipped.extend_from_slice(r);
    }
    let threshold = f64::from(options.threshold / 100000.0f32);
    // SAFETY: `flipped` holds width * height RGBA8 pixels; the handle is freed below.
    let raw = unsafe {
        sys::kt_detect_harris(
            flipped.as_ptr(),
            width as c_int,
            height as c_int,
            options.margin as c_int,
            options.min_distance as c_int,
            threshold,
        )
    };
    if raw.is_null() {
        return Err("feature detection failed".into());
    }
    // SAFETY: a live handle; indices below its count.
    let features: Vec<sys::kt_feature> = unsafe {
        let n = sys::kt_features_count(raw);
        let list = (0..n).map(|i| sys::kt_features_get(raw, i)).collect();
        sys::kt_features_free(raw);
        list
    };
    let polygons = |list: &[Vec<[f64; 2]>]| -> Vec<Vec<[f32; 2]>> {
        list.iter()
            .map(|p| {
                p.iter()
                    .map(|&[x, y]| normalised(x, y, width, height))
                    .collect()
            })
            .collect()
    };
    let keep: Box<dyn Fn([f32; 2]) -> bool> = match &options.placement {
        Placement::Frame => Box::new(|_| true),
        Placement::Inside(list) => {
            let list = polygons(list);
            Box::new(move |p| list.iter().any(|poly| inside_polygon(poly, p)))
        }
        Placement::Outside(list) => {
            let list = polygons(list);
            Box::new(move |p| !list.iter().any(|poly| inside_polygon(poly, p)))
        }
    };
    let (w, h) = (f64::from(width), f64::from(height));
    Ok(features
        .iter()
        .rev()
        .filter_map(|f| {
            // libmv's integer pixel is a pixel centre; Blender adds half a pixel.
            let (x, y) = (f64::from(f.x) + 0.5, f64::from(f.y) + 0.5);
            let uv = [(x / w) as f32, (y / h) as f32];
            keep(uv).then_some([x, h - y])
        })
        .collect())
}
