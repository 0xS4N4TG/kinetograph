//! The size a Lottie layer is painted at.

use super::*;

/// Largest side, in pixels, ThorVG is asked to paint a Lottie layer at.
const MAX_LOTTIE_SIDE: f64 = 4096.0;

/// The size in pixels to paint a Lottie layer whose box is `size`, drawn under
/// `matrix`: the box through the matrix's largest stretch, rounded up, and cut
/// down to `MAX_LOTTIE_SIDE` a side. `None` for a box with no area.
pub(crate) fn lottie_pixels(size: (f64, f64), matrix: Affine) -> Option<(u32, u32)> {
    let stretch = bounds::max_stretch(matrix);
    let (width, height) = (size.0 * stretch, size.1 * stretch);
    if !(width > 0.0 && height > 0.0 && width.is_finite() && height.is_finite()) {
        return None;
    }
    let down = (MAX_LOTTIE_SIDE / width.max(height)).min(1.0);
    Some((
        (width * down).ceil().max(1.0) as u32,
        (height * down).ceil().max(1.0) as u32,
    ))
}
