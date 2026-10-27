//! Raw bindings to csrc/kt_libmv.h: Blender's motion tracker (libmv's AutoTrack over Ceres and Eigen), its Harris
//! feature detector and its homography estimation.
//!
//! The C API, built statically. Coordinates are libmv's frame pixels: (0, 0) is the centre of the pixel in row 0,
//! column 0 of what the region callback reads, y grows with the row. `kinetograph-track` is the safe API over this.

#![allow(non_camel_case_types)]

use std::os::raw::{c_int, c_void};

pub const KT_MOTION_LOC: c_int = 0;
pub const KT_MOTION_LOC_ROT: c_int = 1;
pub const KT_MOTION_LOC_SCALE: c_int = 2;
pub const KT_MOTION_LOC_ROT_SCALE: c_int = 3;
pub const KT_MOTION_AFFINE: c_int = 4;
pub const KT_MOTION_PERSPECTIVE: c_int = 5;

/// Fills `out` (`width * height` floats, row-major, already zero) with frame `frame`'s grayscale pixels in the
/// rectangle whose top-left pixel is (`x`, `y`); pixels outside the frame stay zero. Returns 0 when there is no frame.
pub type kt_region_fn = unsafe extern "C" fn(
    user: *mut c_void,
    frame: c_int,
    x: c_int,
    y: c_int,
    width: c_int,
    height: c_int,
    out: *mut f32,
) -> c_int;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct kt_marker {
    pub frame: c_int,
    pub track: c_int,
    pub center: [f32; 2],
    pub patch: [[f32; 2]; 4],
    pub search_min: [f32; 2],
    pub search_max: [f32; 2],
    pub reference_frame: c_int,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct kt_track_options {
    pub motion_model: c_int,
    pub backwards: c_int,
    pub use_brute: c_int,
    pub use_normalization: c_int,
    pub minimum_correlation: f64,
    pub num_iterations: c_int,
    pub sigma: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct kt_track_result {
    pub termination: c_int,
    pub correlation: f64,
    pub num_iterations: c_int,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct kt_feature {
    pub x: f32,
    pub y: f32,
    pub score: f32,
}

#[repr(C)]
pub struct kt_features {
    _private: [u8; 0],
}

#[repr(C)]
pub struct kt_tracker {
    _private: [u8; 0],
}

unsafe extern "C" {
    pub fn kt_track_options_default(options: *mut kt_track_options);
    pub fn kt_tracker_new(
        width: c_int,
        height: c_int,
        num_frames: c_int,
        region_fn: kt_region_fn,
        user: *mut c_void,
    ) -> *mut kt_tracker;
    pub fn kt_tracker_free(tracker: *mut kt_tracker);
    pub fn kt_tracker_add_marker(
        tracker: *mut kt_tracker,
        marker: *const kt_marker,
        tracked: c_int,
    );
    pub fn kt_tracker_track(
        tracker: *mut kt_tracker,
        options: *const kt_track_options,
        marker: *mut kt_marker,
        result: *mut kt_track_result,
    ) -> c_int;
    pub fn kt_detect_harris(
        rgba: *const u8,
        width: c_int,
        height: c_int,
        margin: c_int,
        min_distance: c_int,
        threshold: f64,
    ) -> *mut kt_features;
    pub fn kt_features_count(features: *const kt_features) -> c_int;
    pub fn kt_features_get(features: *const kt_features, index: c_int) -> kt_feature;
    pub fn kt_features_free(features: *mut kt_features);
    pub fn kt_homography(x1: *const f64, x2: *const f64, n: c_int, h: *mut f64) -> c_int;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_homography_of_point_pairs_is_recovered() {
        // x2 = H x1 for a known projective H (row-major here).
        let h = [1.1, 0.05, 3.0, -0.02, 0.95, -2.0, 0.001, -0.0005, 1.0];
        let x1 = [
            [0.0, 0.0],
            [10.0, 0.0],
            [10.0, 8.0],
            [0.0, 8.0],
            [4.0, 3.0],
            [7.0, 6.0],
        ];
        let map = |p: [f64; 2]| {
            let z = h[6] * p[0] + h[7] * p[1] + h[8];
            [
                (h[0] * p[0] + h[1] * p[1] + h[2]) / z,
                (h[3] * p[0] + h[4] * p[1] + h[5]) / z,
            ]
        };
        let a: Vec<f64> = x1.iter().flatten().copied().collect();
        let b: Vec<f64> = x1.iter().flat_map(|&p| map(p)).collect();
        let mut out = [0.0f64; 9];
        // SAFETY: 6 pairs each, 9 out.
        let status = unsafe { kt_homography(a.as_ptr(), b.as_ptr(), 6, out.as_mut_ptr()) };
        assert_eq!(status, 1);
        // Column-major and up to scale: compare after normalising by H[2][2].
        let s = out[8];
        for r in 0..3 {
            for c in 0..3 {
                let got = out[3 * c + r] / s;
                assert!((got - h[3 * r + c]).abs() < 1e-9, "H[{r}][{c}] = {got}");
            }
        }
    }

    #[test]
    fn harris_finds_the_corners_of_a_square() {
        // 64 x 48, a white square from (16, 12) to (40, 36).
        let (w, h) = (64, 48);
        let mut rgba = Vec::new();
        for y in 0..h {
            for x in 0..w {
                let v = if (16..40).contains(&x) && (12..36).contains(&y) {
                    255
                } else {
                    0
                };
                rgba.extend_from_slice(&[v, v, v, 255]);
            }
        }
        // SAFETY: w * h RGBA8 pixels; the handle is freed below.
        let found: Vec<kt_feature> = unsafe {
            let f = kt_detect_harris(rgba.as_ptr(), w, h, 2, 8, 1e-5);
            assert!(!f.is_null());
            let list = (0..kt_features_count(f))
                .map(|i| kt_features_get(f, i))
                .collect();
            kt_features_free(f);
            list
        };
        assert_eq!(found.len(), 4, "{found:?}");
        // Best first.
        assert!(found.windows(2).all(|p| p[0].score >= p[1].score));
        for (cx, cy) in [(16.0, 12.0), (40.0, 12.0), (40.0, 36.0), (16.0, 36.0)] {
            assert!(
                found
                    .iter()
                    .any(|f| (f.x - cx).abs() <= 2.0 && (f.y - cy).abs() <= 2.0),
                "no corner near ({cx}, {cy}): {found:?}"
            );
        }
    }
}
