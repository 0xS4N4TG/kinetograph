//! 4x4 matrices in CSS's `matrix3d()` order (column-major, column vectors),
//! enough to build a box's transform from the CSS transform functions.

/// `m[col * 4 + row]`: the sixteen numbers of `matrix3d(a1, b1, c1, d1, a2, ...)`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mat4(pub [f64; 16]);

impl Mat4 {
    pub const IDENTITY: Mat4 = Mat4([
        1.0, 0.0, 0.0, 0.0, //
        0.0, 1.0, 0.0, 0.0, //
        0.0, 0.0, 1.0, 0.0, //
        0.0, 0.0, 0.0, 1.0,
    ]);

    pub fn translate(x: f64, y: f64, z: f64) -> Mat4 {
        let mut m = Mat4::IDENTITY;
        m.0[12] = x;
        m.0[13] = y;
        m.0[14] = z;
        m
    }

    pub fn scale(x: f64, y: f64, z: f64) -> Mat4 {
        let mut m = Mat4::IDENTITY;
        m.0[0] = x;
        m.0[5] = y;
        m.0[10] = z;
        m
    }

    /// `rotate3d(x, y, z, angle)` (CSS Transforms 2, §"Mathematical
    /// Description"); a zero axis is the identity.
    pub fn rotate3d(x: f64, y: f64, z: f64, radians: f64) -> Mat4 {
        let len = (x * x + y * y + z * z).sqrt();
        if len == 0.0 {
            return Mat4::IDENTITY;
        }
        let (x, y, z) = (x / len, y / len, z / len);
        let (sin, cos) = (radians / 2.0).sin_cos();
        let sc = sin * cos;
        let sq = sin * sin;
        let (xx, yy, zz) = (x * x, y * y, z * z);
        Mat4([
            1.0 - 2.0 * (yy + zz) * sq,
            2.0 * (x * y * sq + z * sc),
            2.0 * (x * z * sq - y * sc),
            0.0,
            2.0 * (x * y * sq - z * sc),
            1.0 - 2.0 * (xx + zz) * sq,
            2.0 * (y * z * sq + x * sc),
            0.0,
            2.0 * (x * z * sq + y * sc),
            2.0 * (y * z * sq - x * sc),
            1.0 - 2.0 * (xx + yy) * sq,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
        ])
    }

    /// `perspective(d)`: `d` pixels from the eye to the z = 0 plane. A
    /// non-positive `d` is the identity (CSS treats it as infinite).
    pub fn perspective(d: f64) -> Mat4 {
        let mut m = Mat4::IDENTITY;
        if d > 0.0 {
            m.0[11] = -1.0 / d;
        }
        m
    }

    /// `self * rhs`: `rhs` applies first.
    pub fn mul(&self, rhs: &Mat4) -> Mat4 {
        let a = &self.0;
        let b = &rhs.0;
        let mut out = [0.0; 16];
        for col in 0..4 {
            for row in 0..4 {
                let mut sum = 0.0;
                for k in 0..4 {
                    sum += a[k * 4 + row] * b[col * 4 + k];
                }
                out[col * 4 + row] = sum;
            }
        }
        Mat4(out)
    }

    /// `T(o) * self * T(-o)`: this transform about the point `o`.
    pub fn about(&self, ox: f64, oy: f64, oz: f64) -> Mat4 {
        Mat4::translate(ox, oy, oz)
            .mul(self)
            .mul(&Mat4::translate(-ox, -oy, -oz))
    }

    pub fn is_identity(&self) -> bool {
        self.0
            .iter()
            .zip(Mat4::IDENTITY.0.iter())
            .all(|(a, b)| (a - b).abs() < 1e-9)
    }

    /// Whether the matrix only moves points in the z = 0 plane to other
    /// points of it, without perspective: the six numbers of a 2D affine.
    pub fn is_affine_2d(&self) -> bool {
        let m = &self.0;
        let zero = |v: f64| v.abs() < 1e-12;
        zero(m[2])
            && zero(m[3])
            && zero(m[6])
            && zero(m[7])
            && zero(m[8])
            && zero(m[9])
            && (m[10] - 1.0).abs() < 1e-12
            && zero(m[11])
            && zero(m[14])
            && (m[15] - 1.0).abs() < 1e-12
    }

    /// `[a, b, c, d, e, f]` of the 2D part.
    pub fn affine6(&self) -> [f64; 6] {
        let m = &self.0;
        [m[0], m[1], m[4], m[5], m[12], m[13]]
    }

    /// Maps a point of the z = 0 plane through the matrix, perspective divide
    /// included. `None` when the point lands behind the eye.
    pub fn project(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        let m = &self.0;
        let w = m[3] * x + m[7] * y + m[15];
        if w <= 0.0 {
            return None;
        }
        Some((
            (m[0] * x + m[4] * y + m[12]) / w,
            (m[1] * x + m[5] * y + m[13]) / w,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotate_z_90_turns_x_into_y() {
        let m = Mat4::rotate3d(0.0, 0.0, 1.0, std::f64::consts::FRAC_PI_2);
        let (x, y) = m.project(1.0, 0.0).unwrap();
        assert!(x.abs() < 1e-9 && (y - 1.0).abs() < 1e-9, "{x} {y}");
        assert!(m.is_affine_2d());
    }

    #[test]
    fn about_keeps_the_pivot_fixed() {
        let m = Mat4::scale(2.0, 3.0, 1.0).about(10.0, 20.0, 0.0);
        let (x, y) = m.project(10.0, 20.0).unwrap();
        assert!((x - 10.0).abs() < 1e-9 && (y - 20.0).abs() < 1e-9);
        let (x, y) = m.project(11.0, 21.0).unwrap();
        assert!((x - 12.0).abs() < 1e-9 && (y - 23.0).abs() < 1e-9);
    }

    #[test]
    fn perspective_shrinks_what_is_far() {
        // A point 100 behind the plane with d = 100 is at half size.
        let m = Mat4::perspective(100.0).mul(&Mat4::translate(0.0, 0.0, -100.0));
        let (x, _) = m.project(10.0, 0.0).unwrap();
        assert!((x - 5.0).abs() < 1e-9, "{x}");
        assert!(!m.is_affine_2d());
    }
}
