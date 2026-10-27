//! Raw bindings to csrc/kt_libmv.h: Blender's motion tracker (libmv's AutoTrack over Ceres and Eigen).
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
}
