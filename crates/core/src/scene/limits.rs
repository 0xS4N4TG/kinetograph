//! Limits the scene format enforces.

/// Largest canvas side; wgpu's default texture limit.
pub const MAX_CANVAS_SIDE: u32 = 8192;

/// Fewest and most sub-frames a layer's motion blur averages.
pub const MIN_MOTION_SAMPLES: i64 = 2;
pub const MAX_MOTION_SAMPLES: i64 = 64;

/// Fewest and most levels per channel a `dither` takes.
pub const MIN_DITHER_LEVELS: f64 = 2.0;
pub const MAX_DITHER_LEVELS: f64 = 256.0;

/// Fewest and most stops a `gradientMap` takes; the shader's uniform block
/// holds 16.
pub const MIN_GRADIENT_MAP_STOPS: usize = 2;
pub const MAX_GRADIENT_MAP_STOPS: usize = 16;

/// Fewest and most points a `meshGradient` has along each axis.
pub const MIN_MESH_POINTS: u32 = 2;
pub const MAX_MESH_POINTS: u32 = 8;

/// Largest shadow spread, in pixels; bigger values are clamped.
pub const MAX_SHADOW_SIZE: f64 = 128.0;

/// The largest blur radius the margin makes room for (`3 *` this past the
/// canvas): a wider blur still blurs as wide, but what lies further past the
/// edge of the canvas is not drawn for it.
pub const MAX_MARGIN_BLUR: f64 = 128.0;
