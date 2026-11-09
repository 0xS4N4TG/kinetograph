//! Bilinear resizing with the triangle filter that widens when the picture shrinks (so a downscale averages the pixels it
//! drops instead of skipping them), the "bilinear" resample of the models' preprocessor configs (PIL's, `resample: 2`).
//! Pixel centres sit at half pixels, so a picture resized to its own size comes out unchanged.

/// For each output position, the first source index and the weights over the source indices from there, summing to 1.
fn taps(src: usize, dst: usize) -> Vec<(usize, Vec<f32>)> {
    let scale = src as f64 / dst as f64;
    let filter_scale = scale.max(1.0);
    let support = filter_scale;
    (0..dst)
        .map(|x| {
            let center = (x as f64 + 0.5) * scale;
            let lo = ((center - support + 0.5) as i64).clamp(0, src as i64 - 1) as usize;
            let hi = ((center + support + 0.5) as i64).clamp(lo as i64 + 1, src as i64) as usize;
            let mut weights: Vec<f64> = (lo..hi)
                .map(|i| (1.0 - ((i as f64 + 0.5 - center) / filter_scale).abs()).max(0.0))
                .collect();
            let sum: f64 = weights.iter().sum();
            if sum > 0.0 {
                weights.iter_mut().for_each(|w| *w /= sum);
            } else {
                // The window holds no pixel centre inside the filter: take the nearest one.
                let nearest = (center.floor() as i64).clamp(lo as i64, hi as i64 - 1) as usize - lo;
                weights
                    .iter_mut()
                    .enumerate()
                    .for_each(|(i, w)| *w = f64::from(i == nearest));
            }
            (lo, weights.into_iter().map(|w| w as f32).collect())
        })
        .collect()
}

/// `src` (`sw` x `sh`, one channel of floats) resized to `dw` x `dh`.
pub fn resize_plane(src: &[f32], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<f32> {
    assert_eq!(src.len(), sw * sh, "plane size");
    let (xs, ys) = (taps(sw, dw), taps(sh, dh));
    // Across, into `sh` rows of `dw`.
    let mut wide = vec![0f32; dw * sh];
    for y in 0..sh {
        let row = &src[y * sw..(y + 1) * sw];
        for (x, (lo, weights)) in xs.iter().enumerate() {
            wide[y * dw + x] = weights.iter().zip(&row[*lo..]).map(|(w, v)| w * v).sum();
        }
    }
    // Down, row by row, over whole rows so the inner loop reads and writes along memory.
    let mut out = vec![0f32; dw * dh];
    for (y, (lo, weights)) in ys.iter().enumerate() {
        let dst = &mut out[y * dw..(y + 1) * dw];
        for (j, w) in weights.iter().enumerate() {
            let row = &wide[(lo + j) * dw..(lo + j + 1) * dw];
            for (d, v) in dst.iter_mut().zip(row) {
                *d += w * v;
            }
        }
    }
    out
}

/// A tightly packed RGBA8 picture (`sw` x `sh`) resized to `dw` x `dh` as three planes of floats on the 0 to 255 scale,
/// red, green, blue one after another (the layout of a model's `1 x 3 x H x W` input).
pub fn resize_rgba_planes(rgba: &[u8], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<f32> {
    assert_eq!(rgba.len(), sw * sh * 4, "picture size");
    let (xs, ys) = (taps(sw, dw), taps(sh, dh));
    let mut out = vec![0f32; 3 * dw * dh];
    let mut wide = vec![0f32; dw * sh];
    for c in 0..3 {
        for y in 0..sh {
            let row = &rgba[y * sw * 4..(y + 1) * sw * 4];
            for (x, (lo, weights)) in xs.iter().enumerate() {
                let mut sum = 0.0;
                for (i, w) in weights.iter().enumerate() {
                    sum += w * f32::from(row[(lo + i) * 4 + c]);
                }
                wide[y * dw + x] = sum;
            }
        }
        let plane = &mut out[c * dw * dh..(c + 1) * dw * dh];
        for (y, (lo, weights)) in ys.iter().enumerate() {
            let dst = &mut plane[y * dw..(y + 1) * dw];
            for (j, w) in weights.iter().enumerate() {
                let row = &wide[(lo + j) * dw..(lo + j + 1) * dw];
                for (d, v) in dst.iter_mut().zip(row) {
                    *d += w * v;
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_size_changes_nothing() {
        let src: Vec<f32> = (0..12).map(|v| v as f32 * 3.0).collect();
        let out = resize_plane(&src, 4, 3, 4, 3);
        for (a, b) in src.iter().zip(&out) {
            assert!((a - b).abs() < 1e-4, "{a} vs {b}");
        }
    }

    #[test]
    fn a_flat_picture_stays_flat_at_any_size() {
        for (dw, dh) in [(1, 1), (3, 7), (40, 25), (100, 100)] {
            let out = resize_plane(&vec![0.5; 20 * 10], 20, 10, dw, dh);
            assert_eq!(out.len(), dw * dh);
            assert!(out.iter().all(|v| (v - 0.5).abs() < 1e-5), "{dw}x{dh}");
        }
    }

    #[test]
    fn halving_widens_the_filter_over_the_pixels_it_drops() {
        // 1, 3, 5, 7 down to two. The triangle spans two source pixels each side of the centre, weights .75 .75 .25
        // (renormalised at the edge): (.75 + 2.25 + 1.25) / 1.75 = 2.43, and the mirror of it, symmetric about 4.
        let out = resize_plane(&[1.0, 3.0, 5.0, 7.0], 4, 1, 2, 1);
        assert!(
            (out[0] - 4.25 / 1.75).abs() < 1e-5 && (out[1] - (8.0 - 4.25 / 1.75)).abs() < 1e-5,
            "{out:?}"
        );
    }

    #[test]
    fn doubling_interpolates_between_centres() {
        // 0 and 4 up to four: centres at 0.25 and 0.75 of the way blend the two.
        let out = resize_plane(&[0.0, 4.0], 2, 1, 4, 1);
        let want = [0.0, 1.0, 3.0, 4.0];
        for (a, b) in out.iter().zip(want) {
            assert!((a - b).abs() < 1e-5, "{out:?}");
        }
    }

    #[test]
    fn rgba_planes_come_out_red_then_green_then_blue() {
        // 2x1 picture, red (255, 0, 0) and blue (0, 0, 255), alpha ignored; kept at its size.
        let out = resize_rgba_planes(&[255, 0, 0, 9, 0, 0, 255, 9], 2, 1, 2, 1);
        assert_eq!(out.len(), 6);
        let near = |a: f32, b: f32| (a - b).abs() < 1e-3;
        assert!(near(out[0], 255.0) && near(out[1], 0.0), "{out:?}");
        assert!(near(out[2], 0.0) && near(out[3], 0.0), "{out:?}");
        assert!(near(out[4], 0.0) && near(out[5], 255.0), "{out:?}");
    }
}
