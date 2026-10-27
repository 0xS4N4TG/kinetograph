//! Blender's plane track: four corners carried through the clip by the homography of four or more point tracks.
//!
//! What follows Blender (as behaviour, from its manual and from running it; none of its GPL code is used):
//!
//! - the plane is made at the frame the points are placed at; its corners start as the bounding box of the tracks'
//!   pattern squares there (Blender's "Create Plane Track"), or as corners given instead (Blender's corners dragged
//!   into place);
//! - from that frame it is carried forwards, then backwards, one frame at a time: the tracks with a marker on both
//!   frames give the point pairs (in Blender's normalised f32 positions), libmv's homography (MIT,
//!   `EstimateHomography2DFromCorrespondences`) is fitted to them, and each corner is moved by it, in f32 as Blender
//!   stores the matrix and the corners;
//! - it stops where fewer than four tracks have markers on both frames.

use std::os::raw::c_int;

use libmv_sys as sys;

use crate::detect::normalised;
use crate::file::{PlaneFrame, PlaneTrack};

/// A plane track to make from point tracks.
#[derive(Clone, Debug, PartialEq)]
pub struct PlaneRequest {
    pub name: String,
    /// The point tracks it follows, by name (at least four); empty means every track.
    pub tracks: Vec<String>,
    /// The corners at the frame the points are placed at, video pixels (top-left, top-right, bottom-right,
    /// bottom-left). None: the bounding box of the tracks' patterns, as Blender makes a new plane.
    pub corners: Option<[[f64; 2]; 4]>,
}

/// One point track as the plane reads it: its name, and Blender's normalised position (v up) at each frame it has a
/// marker on, in increasing frame order.
pub(crate) struct Positions<'a> {
    pub name: &'a str,
    pub frames: Vec<(u32, [f32; 2])>,
}

impl Positions<'_> {
    fn at(&self, frame: u32) -> Option<[f32; 2]> {
        self.frames
            .binary_search_by_key(&frame, |(f, _)| *f)
            .ok()
            .map(|i| self.frames[i].1)
    }
}

/// libmv's homography from the pairs, as f32 in column-major order (`h[3 * column + row]`), as Blender keeps it.
fn homography(x1: &[[f32; 2]], x2: &[[f32; 2]]) -> Result<[f32; 9], String> {
    let flat = |xs: &[[f32; 2]]| -> Vec<f64> {
        xs.iter()
            .flat_map(|p| [f64::from(p[0]), f64::from(p[1])])
            .collect()
    };
    let (a, b) = (flat(x1), flat(x2));
    let mut h = [0.0f64; 9];
    // SAFETY: `a` and `b` hold `n` pairs each; `h` holds 9.
    let status =
        unsafe { sys::kt_homography(a.as_ptr(), b.as_ptr(), x1.len() as c_int, h.as_mut_ptr()) };
    // Blender uses the estimate whether or not Ceres calls it usable; only a failure to estimate stops here.
    if status < 0 {
        return Err("the homography could not be estimated".into());
    }
    Ok(h.map(|v| v as f32))
}

/// A corner moved by `h`, in f32 and unfused, as Blender multiplies a 3x3 matrix by a vector.
fn apply(h: &[f32; 9], c: [f32; 2]) -> [f32; 2] {
    let row = |r: usize| h[r] * c[0] + h[3 + r] * c[1] + h[6 + r];
    let z = row(2);
    [row(0) / z, row(1) / z]
}

/// The plane track for `request` over `tracks` (already tracked), made at `reference`, the frame the points were
/// placed at. `pattern` is the tracks' pattern size, px.
pub(crate) fn track_plane(
    request: &PlaneRequest,
    tracks: &[Positions],
    reference: u32,
    pattern: u32,
    width: u32,
    height: u32,
) -> Result<PlaneTrack, String> {
    let chosen: Vec<&Positions> = if request.tracks.is_empty() {
        tracks.iter().collect()
    } else {
        request
            .tracks
            .iter()
            .map(|name| {
                tracks.iter().find(|t| t.name == name).ok_or_else(|| {
                    format!("plane \"{}\": there is no track \"{name}\"", request.name)
                })
            })
            .collect::<Result<_, _>>()?
    };
    if chosen.len() < 4 {
        return Err(format!(
            "plane \"{}\" needs at least 4 point tracks (got {})",
            request.name,
            chosen.len()
        ));
    }
    // Blender's corner order: bottom-left, bottom-right, top-right, top-left (v up).
    let start: [[f32; 2]; 4] = match request.corners {
        Some([tl, tr, br, bl]) => [bl, br, tr, tl].map(|[x, y]| normalised(x, y, width, height)),
        None => {
            let half = [
                pattern as f32 / 2.0 / width as f32,
                pattern as f32 / 2.0 / height as f32,
            ];
            let (mut min, mut max) = ([f32::MAX; 2], [f32::MIN; 2]);
            for t in &chosen {
                let pos = t.at(reference).ok_or_else(|| {
                    format!(
                        "plane \"{}\": track \"{}\" has no marker at frame {reference}",
                        request.name, t.name
                    )
                })?;
                for i in 0..2 {
                    min[i] = min[i].min(-half[i] + pos[i]);
                    max[i] = max[i].max(half[i] + pos[i]);
                }
            }
            [min, [max[0], min[1]], max, [min[0], max[1]]]
        }
    };

    let mut frames = vec![(reference, start)];
    for forwards in [true, false] {
        let mut corners = start;
        let mut frame = reference;
        loop {
            let next = if forwards {
                frame.checked_add(1)
            } else {
                frame.checked_sub(1)
            };
            let Some(next) = next else { break };
            let (x1, x2): (Vec<[f32; 2]>, Vec<[f32; 2]>) = chosen
                .iter()
                .filter_map(|t| Some((t.at(frame)?, t.at(next)?)))
                .unzip();
            if x1.len() < 4 {
                break;
            }
            let h = homography(&x1, &x2)?;
            corners = corners.map(|c| apply(&h, c));
            frames.push((next, corners));
            frame = next;
        }
    }
    frames.sort_by_key(|(f, _)| *f);

    // In f64, so the file holds Blender's f32 corners exactly (u * width is exact in f64).
    let (w, h) = (f64::from(width), f64::from(height));
    let video = |[u, v]: [f32; 2]| [f64::from(u) * w, (1.0 - f64::from(v)) * h];
    Ok(PlaneTrack {
        name: request.name.clone(),
        tracks: chosen.iter().map(|t| t.name.to_string()).collect(),
        frames: frames
            .into_iter()
            .map(|(frame, [bl, br, tr, tl])| PlaneFrame {
                frame,
                corners: [video(tl), video(tr), video(br), video(bl)],
            })
            .collect(),
    })
}
