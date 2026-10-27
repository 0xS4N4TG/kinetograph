//! Raw bindings to csrc/kt_libmv.h: Blender's motion tracker (libmv's AutoTrack over Ceres and Eigen).
//!
//! Spike crate: the C API, built statically. Coordinates are frame pixels, y down, (0, 0) the centre of the top-left
//! pixel.

#![allow(non_camel_case_types)]

use std::os::raw::{c_int, c_void};

pub const KT_MOTION_LOC: c_int = 0;
pub const KT_MOTION_LOC_ROT: c_int = 1;
pub const KT_MOTION_LOC_SCALE: c_int = 2;
pub const KT_MOTION_LOC_ROT_SCALE: c_int = 3;
pub const KT_MOTION_AFFINE: c_int = 4;
pub const KT_MOTION_PERSPECTIVE: c_int = 5;

/// Hands over frame `frame` as `width * height` grayscale floats, row-major from the top. Returns 0 when missing.
pub type kt_frame_fn = unsafe extern "C" fn(user: *mut c_void, frame: c_int, pixels: *mut *const f32) -> c_int;

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
pub struct kt_tracker {
    _private: [u8; 0],
}

unsafe extern "C" {
    pub fn kt_track_options_default(options: *mut kt_track_options);
    pub fn kt_tracker_new(
        width: c_int,
        height: c_int,
        num_frames: c_int,
        frame_fn: kt_frame_fn,
        user: *mut c_void,
    ) -> *mut kt_tracker;
    pub fn kt_tracker_free(tracker: *mut kt_tracker);
    pub fn kt_tracker_add_marker(tracker: *mut kt_tracker, marker: *const kt_marker);
    pub fn kt_tracker_track(
        tracker: *mut kt_tracker,
        options: *const kt_track_options,
        marker: *mut kt_marker,
        result: *mut kt_track_result,
    ) -> c_int;
}
