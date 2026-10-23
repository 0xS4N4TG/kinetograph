//! Datamosh: a video whose keyframe was dropped.
//!
//! In a real datamosh the picture of a cut is thrown away and the decoder keeps
//! applying the new shot's motion vectors to the old picture, so the old
//! picture smears and melts along the new movement. This module does the same,
//! frame by frame, on RGBA pictures, with the motion vectors the video decoder
//! itself exports (`VideoDecoder::picture_motion`).
//!
//! One mosh window runs from frame `start` of the clip. The picture of frame
//! `start` is the held picture (the clip's own previous frame, or a frame of
//! another clip). For each later frame, the previous output is advected: every
//! block of the output pulls its pixels from where the vector says the block
//! came from (`MotionField`, sub-pixel, bilinear, edges clamp). With `mix` above
//! 0 the decoder's residual is added too: the real frame minus the real
//! previous frame moved by the same vectors, times `mix`. That is exactly what a
//! decoder does with a P frame, so at `mix` 1 the new shot's detail rides on the
//! old shot's colour, and at 0 the old picture only melts.
//!
//! Everything here is integer arithmetic on bytes and depends on nothing but
//! the pictures and vectors it is given, so a frame is the same on any machine
//! and at any concurrency. The output of frame `n` takes `n - start` steps from
//! the held picture; `MoshState` keeps the last output so the next frame costs
//! one step, and starts again from the held picture whenever the frame asked
//! for is not the next one. Both ways go through the same `step`, so they give
//! the same bytes. Cost per step: one advection (two when `mix` is above 0) and
//! one decode of the real frame; `MAX_WINDOW` frames bound a cold start.

use std::sync::Arc;

use peniko::ImageData;

use crate::error::{Error, Result};

/// The longest mosh window, in frames. A frame in the window costs one step
/// per frame since the window began when no state is kept (the first frame a
/// worker renders), so the window is capped.
pub const MAX_WINDOW: f64 = 600.0;

/// Motion is kept per 4 x 4 pixel cell: the smallest block H.264 predicts.
const CELL: usize = 4;
/// Displacements are in 1/16 of a pixel.
const SUB: i32 = 16;

/// Codecs whose decoder exports motion vectors (`AV_FRAME_DATA_MOTION_VECTORS`):
/// FFmpeg's H.264 decoder and the MPEG-family decoders built on its mpegvideo code.
const VECTOR_CODECS: [&str; 7] = [
    "h264",
    "mpeg4",
    "mpeg2video",
    "mpeg1video",
    "h263",
    "h263p",
    "flv1",
];

/// Whether a stream of codec `name` carries motion vectors this module can use.
pub fn exports_vectors(name: &str) -> bool {
    VECTOR_CODECS.contains(&name)
}

/// One decoded motion vector (FFmpeg's `AVMotionVector`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Vector {
    /// Negative: the block is predicted from a picture before this one;
    /// positive: from one after it (B frames).
    pub source: i32,
    pub w: u8,
    pub h: u8,
    /// The block's centre, in pixels (it may lie outside the picture).
    pub dst_x: i16,
    pub dst_y: i16,
    /// `src = dst + motion / motion_scale`.
    pub motion_x: i32,
    pub motion_y: i32,
    pub motion_scale: u16,
}

/// Where each 4 x 4 cell of a picture pulls its pixels from, relative to
/// itself, in 1/16 pixels. A cell no vector covers (intra blocks, a frame with
/// no vectors) does not move.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MotionField {
    pub width: usize,
    pub height: usize,
    cols: usize,
    rows: usize,
    cells: Vec<[i16; 2]>,
}

impl MotionField {
    /// A field in which nothing moves.
    pub fn still(width: usize, height: usize) -> MotionField {
        let (cols, rows) = (width.div_ceil(CELL), height.div_ceil(CELL));
        MotionField {
            width,
            height,
            cols,
            rows,
            cells: vec![[0, 0]; cols * rows],
        }
    }

    /// The field of a decoded picture's vectors. A block predicted from the past
    /// pulls from `dst + motion`; one predicted from the future (a B frame)
    /// came from where the picture is going, so it pulls the other way; a
    /// block with both takes the mean.
    pub fn from_vectors(width: usize, height: usize, vectors: &[Vector]) -> MotionField {
        let mut field = MotionField::still(width, height);
        let mut sum = vec![[0i32; 2]; field.cells.len()];
        let mut count = vec![0u32; field.cells.len()];
        for v in vectors {
            let scale = i32::from(v.motion_scale.max(1));
            let sign = if v.source > 0 { -1 } else { 1 };
            let dx = sign * v.motion_x * SUB / scale;
            let dy = sign * v.motion_y * SUB / scale;
            let x0 = i32::from(v.dst_x) - i32::from(v.w) / 2;
            let y0 = i32::from(v.dst_y) - i32::from(v.h) / 2;
            let (x1, y1) = (x0 + i32::from(v.w), y0 + i32::from(v.h));
            let (cx0, cx1) = (
                (x0.max(0) as usize) / CELL,
                (x1.clamp(0, width as i32) as usize).div_ceil(CELL),
            );
            let (cy0, cy1) = (
                (y0.max(0) as usize) / CELL,
                (y1.clamp(0, height as i32) as usize).div_ceil(CELL),
            );
            for cy in cy0..cy1 {
                for cx in cx0..cx1 {
                    let i = cy * field.cols + cx;
                    sum[i][0] += dx;
                    sum[i][1] += dy;
                    count[i] += 1;
                }
            }
        }
        for (i, cell) in field.cells.iter_mut().enumerate() {
            if count[i] > 0 {
                let n = count[i] as i32;
                let clamp = |v: i32| (v / n).clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16;
                *cell = [clamp(sum[i][0]), clamp(sum[i][1])];
            }
        }
        field
    }

    /// The cell at pixel `(x, y)`'s displacement in 1/16 pixels.
    pub fn at(&self, x: usize, y: usize) -> [i16; 2] {
        self.cells[(y / CELL) * self.cols + x / CELL]
    }

    /// Whether no cell moves.
    pub fn is_still(&self) -> bool {
        self.cells.iter().all(|c| *c == [0, 0])
    }
}

/// `dst[p] = src[p + displacement(p)]` for every pixel of RGBA8 pictures
/// `field.width` x `field.height`: each cell moves as one block, a fractional
/// displacement is bilinear (weights in 1/16, rounded), a source outside the
/// picture is the nearest edge pixel.
pub fn advect(src: &[u8], dst: &mut [u8], field: &MotionField) {
    let (w, h) = (field.width, field.height);
    assert!(
        src.len() == w * h * 4 && dst.len() == src.len(),
        "advect: wrong picture size"
    );
    let clamp_x = |x: i32| x.clamp(0, w as i32 - 1) as usize;
    let clamp_y = |y: i32| y.clamp(0, h as i32 - 1) as usize;
    for y in 0..h {
        let row = (y / CELL) * field.cols;
        let mut x = 0;
        while x < w {
            let [dx, dy] = field.cells[row + x / CELL];
            let end = ((x / CELL + 1) * CELL).min(w);
            let (dx, dy) = (i32::from(dx), i32::from(dy));
            let (ox, oy) = (dx >> 4, dy >> 4);
            let (fx, fy) = (dx & 15, dy & 15);
            let (ya, yb) = (clamp_y(y as i32 + oy), clamp_y(y as i32 + oy + 1));
            if fx == 0 && fy == 0 {
                for px in x..end {
                    let s = (ya * w + clamp_x(px as i32 + ox)) * 4;
                    let d = (y * w + px) * 4;
                    dst[d..d + 4].copy_from_slice(&src[s..s + 4]);
                }
            } else {
                let (w00, w01) = ((16 - fx) * (16 - fy), fx * (16 - fy));
                let (w10, w11) = ((16 - fx) * fy, fx * fy);
                for px in x..end {
                    let (xa, xb) = (clamp_x(px as i32 + ox), clamp_x(px as i32 + ox + 1));
                    let (a, b) = ((ya * w + xa) * 4, (ya * w + xb) * 4);
                    let (c, e) = ((yb * w + xa) * 4, (yb * w + xb) * 4);
                    let d = (y * w + px) * 4;
                    for k in 0..4 {
                        let v = w00 * i32::from(src[a + k])
                            + w01 * i32::from(src[b + k])
                            + w10 * i32::from(src[c + k])
                            + w11 * i32::from(src[e + k]);
                        dst[d + k] = ((v + 128) >> 8) as u8;
                    }
                }
            }
            x = end;
        }
    }
}

/// One frame of a mosh: `out` becomes `out` moved by `field`, plus `mix256 / 256`
/// of the residual `current - previous moved by field` (which is why `previous`
/// is the real previous picture, moved by the same vectors); `previous` then
/// becomes `current`. `scratch` is a buffer of the same size.
fn step(
    out: &mut Vec<u8>,
    previous: &mut [u8],
    current: &[u8],
    field: &MotionField,
    mix256: i32,
    scratch: &mut Vec<u8>,
) {
    advect(out, scratch, field);
    std::mem::swap(out, scratch);
    if mix256 > 0 {
        advect(previous, scratch, field);
        for ((o, c), p) in out.iter_mut().zip(current).zip(scratch.iter()) {
            let residual = i32::from(*c) - i32::from(*p);
            let v = i32::from(*o) + ((residual * mix256 + 128) >> 8);
            *o = v.clamp(0, 255) as u8;
        }
    }
    previous.copy_from_slice(current);
}

/// Where a mosh window starts from.
#[derive(Clone, Debug, PartialEq)]
pub enum ResolvedHold {
    /// The clip's own picture one frame before the window.
    Previous,
    /// A picture of another file: the file and the timestamp (stream ticks).
    Clip { src: String, ts: i64 },
}

/// A video layer's mosh on one frame: what the frame needs to be computed from
/// the window's start.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedMosh {
    pub hold: ResolvedHold,
    /// The residual's weight, 0 to 256.
    pub mix: u16,
    /// The timestamp of the picture the clip shows on each frame from one
    /// before the window's first to the frame being drawn. So
    /// `ts[0]` is the held picture of `Previous`, `ts[1]` the window's first
    /// frame, and the last is the frame being drawn.
    pub ts: Arc<Vec<i64>>,
}

/// A decoded picture, its vectors, and which picture of the stream it is
/// (the same one for every timestamp it lasts over).
pub struct Fetched {
    pub image: ImageData,
    pub motion: Arc<MotionField>,
    pub pts: i64,
}

/// The output of a mosh so far, kept between frames. Rebuilt from the held
/// picture whenever the frame asked for is not the next one.
pub struct MoshState {
    hold: ResolvedHold,
    mix: u16,
    /// The timestamps already fed in, as `ResolvedMosh::ts`.
    ts: Vec<i64>,
    last_pts: i64,
    width: u32,
    height: u32,
    out: Vec<u8>,
    previous: Vec<u8>,
    scratch: Vec<u8>,
}

impl MoshState {
    /// The output picture, RGBA8.
    pub fn rgba(&self) -> &[u8] {
        &self.out
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// Whether this state is a prefix of `mosh`'s frames, so continuing it gives
    /// what a fresh start would.
    fn continues(&self, mosh: &ResolvedMosh) -> bool {
        self.hold == mosh.hold && self.mix == mosh.mix && mosh.ts.starts_with(&self.ts)
    }
}

/// Brings `slot` to the frame `mosh` describes and returns it: continues the
/// state in `slot` when `mosh` is its next frames, otherwise starts from the
/// held picture. `fetch(ts)` is the clip's picture and vectors at a timestamp
/// (a decoder with vectors on, asked for consecutive timestamps), and
/// `other(w, h)` the picture of the `Clip` hold, fitted to `w` x `h`.
pub fn frame<'a>(
    slot: &'a mut Option<MoshState>,
    mosh: &ResolvedMosh,
    other: impl FnOnce(u32, u32) -> Result<Vec<u8>>,
    mut fetch: impl FnMut(i64) -> Result<Fetched>,
) -> Result<&'a MoshState> {
    if mosh.ts.len() < 2 {
        return Err(Error::Render(
            "datamosh: a window needs two timestamps".into(),
        ));
    }
    if !slot.as_ref().is_some_and(|s| s.continues(mosh)) {
        let (held, first) = match &mosh.hold {
            ResolvedHold::Previous => {
                let held = fetch(mosh.ts[0])?;
                (Some(held.image), fetch(mosh.ts[1])?)
            }
            ResolvedHold::Clip { .. } => (None, fetch(mosh.ts[1])?),
        };
        let (width, height) = (first.image.width, first.image.height);
        let out = match held {
            Some(image) if (image.width, image.height) == (width, height) => {
                image.data.as_ref().to_vec()
            }
            Some(_) => {
                return Err(Error::Render(
                    "datamosh: the held picture changed size".into(),
                ));
            }
            None => other(width, height)?,
        };
        let previous = first.image.data.as_ref().to_vec();
        *slot = Some(MoshState {
            hold: mosh.hold.clone(),
            mix: mosh.mix,
            ts: mosh.ts[..2].to_vec(),
            last_pts: first.pts,
            width,
            height,
            scratch: vec![0; out.len()],
            out,
            previous,
        });
    }
    let state = slot.as_mut().expect("just made");
    for i in state.ts.len()..mosh.ts.len() {
        let next = fetch(mosh.ts[i])?;
        if (next.image.width, next.image.height) != (state.width, state.height) {
            return Err(Error::Render(
                "datamosh: the clip's pictures changed size".into(),
            ));
        }
        // The same picture on two frames (a clip slower than the scene) moves nothing.
        if next.pts != state.last_pts {
            step(
                &mut state.out,
                &mut state.previous,
                next.image.data.as_ref(),
                &next.motion,
                i32::from(state.mix),
                &mut state.scratch,
            );
            state.last_pts = next.pts;
        }
        state.ts.push(mosh.ts[i]);
    }
    Ok(slot.as_ref().expect("just made"))
}

/// `src` (`sw` x `sh` RGBA8) scaled to cover `w` x `h` and cropped to the
/// middle, nearest-neighbour, so a held picture of another clip has this clip's size.
pub fn cover(src: &[u8], sw: u32, sh: u32, w: u32, h: u32) -> Vec<u8> {
    let (sw, sh, w, h) = (sw as usize, sh as usize, w as usize, h as usize);
    let mut out = vec![0u8; w * h * 4];
    // The scale is s = max(w / sw, h / sh), and the picture is centred.
    let width_decides = w * sh >= h * sw;
    for y in 0..h {
        for x in 0..w {
            let (sx, sy) = if width_decides {
                (x * sw / w, (sh * w - h * sw + 2 * y * sw) / (2 * w))
            } else {
                ((sw * h - w * sh + 2 * x * sh) / (2 * h), y * sh / h)
            };
            let (sx, sy) = (sx.min(sw - 1), sy.min(sh - 1));
            let s = (sy * sw + sx) * 4;
            let d = (y * w + x) * 4;
            out[d..d + 4].copy_from_slice(&src[s..s + 4]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A picture whose pixel (x, y) is [x, y, x + y, 255], so a move is readable.
    fn ramp(w: usize, h: usize) -> Vec<u8> {
        let mut v = Vec::with_capacity(w * h * 4);
        for y in 0..h {
            for x in 0..w {
                v.extend_from_slice(&[x as u8, y as u8, (x + y) as u8, 255]);
            }
        }
        v
    }

    fn px(img: &[u8], w: usize, x: usize, y: usize) -> [u8; 4] {
        let i = (y * w + x) * 4;
        [img[i], img[i + 1], img[i + 2], img[i + 3]]
    }

    fn vector(x: i16, y: i16, size: u8, mx: i32, my: i32, scale: u16, source: i32) -> Vector {
        Vector {
            source,
            w: size,
            h: size,
            dst_x: x,
            dst_y: y,
            motion_x: mx,
            motion_y: my,
            motion_scale: scale,
        }
    }

    #[test]
    fn a_vector_covers_the_block_around_its_centre() {
        // A 16 x 16 block centred at (8, 8) moves by (+2, -1) pixels (quarter-pel 8, -4).
        let field = MotionField::from_vectors(32, 32, &[vector(8, 8, 16, 8, -4, 4, -1)]);
        assert_eq!(field.at(0, 0), [32, -16]);
        assert_eq!(field.at(15, 15), [32, -16]);
        assert_eq!(field.at(16, 0), [0, 0]);
        assert_eq!(field.at(0, 16), [0, 0]);
        assert!(!field.is_still());
        assert!(MotionField::from_vectors(32, 32, &[]).is_still());
    }

    #[test]
    fn a_future_vector_pulls_the_other_way_and_two_vectors_average() {
        let past = vector(8, 8, 16, 8, 0, 4, -1);
        let future = vector(8, 8, 16, 4, 0, 4, 1);
        let only_future = MotionField::from_vectors(16, 16, &[future]);
        assert_eq!(only_future.at(3, 3), [-16, 0]);
        let both = MotionField::from_vectors(16, 16, &[past, future]);
        // (+32 and -16) / 2
        assert_eq!(both.at(3, 3), [8, 0]);
    }

    #[test]
    fn a_known_field_moves_a_known_picture() {
        let (w, h) = (32usize, 16usize);
        let pic = ramp(w, h);
        // The left 16 x 16 block pulls from 3 pixels right and 2 down; the right one stays.
        let field = MotionField::from_vectors(w, h, &[vector(8, 8, 16, 12, 8, 4, -1)]);
        let mut out = vec![0u8; pic.len()];
        advect(&pic, &mut out, &field);
        assert_eq!(px(&out, w, 0, 0), px(&pic, w, 3, 2));
        assert_eq!(px(&out, w, 5, 7), px(&pic, w, 8, 9));
        // Below the picture's last row the source clamps to the edge.
        assert_eq!(px(&out, w, 4, 15), px(&pic, w, 7, 15));
        // The other block did not move.
        assert_eq!(px(&out, w, 20, 9), px(&pic, w, 20, 9));
    }

    #[test]
    fn a_half_pixel_move_is_the_mean_of_two_neighbours() {
        let (w, h) = (16usize, 4usize);
        let pic = ramp(w, h);
        // Quarter-pel 2 = half a pixel to the right.
        let field = MotionField::from_vectors(w, h, &[vector(8, 2, 16, 2, 0, 4, -1)]);
        let mut out = vec![0u8; pic.len()];
        advect(&pic, &mut out, &field);
        // Red of (5, 1) is the mean of x = 5 and 6: 5.5 rounds to 6 with the weights in 1/16.
        assert_eq!(px(&out, w, 5, 1)[0], 6);
        // Green is the same in both neighbours.
        assert_eq!(px(&out, w, 5, 1)[1], 1);
        // The right edge clamps.
        assert_eq!(px(&out, w, 15, 1)[0], 15);
    }

    #[test]
    fn a_still_field_is_the_identity() {
        let pic = ramp(30, 18);
        let mut out = vec![0u8; pic.len()];
        advect(&pic, &mut out, &MotionField::still(30, 18));
        assert_eq!(out, pic);
    }

    #[test]
    fn the_residual_of_the_real_previous_picture_gives_the_real_picture() {
        // With the output equal to the real previous picture, mix 1 reproduces
        // the real current picture exactly, whatever the vectors: this is a decoder.
        let (w, h) = (32usize, 32usize);
        let previous = ramp(w, h);
        let field = MotionField::from_vectors(w, h, &[vector(8, 8, 16, 6, 2, 4, -1)]);
        let mut current = vec![0u8; previous.len()];
        advect(&previous, &mut current, &field);
        for (i, c) in current.iter_mut().enumerate() {
            if i % 4 != 3 {
                *c = c.wrapping_add(7).min(250);
            }
        }
        let (mut out, mut prev, mut scratch) =
            (previous.clone(), previous.clone(), vec![0; previous.len()]);
        step(&mut out, &mut prev, &current, &field, 256, &mut scratch);
        assert_eq!(out, current);
        assert_eq!(prev, current);
    }

    #[test]
    fn mix_zero_only_moves_the_old_picture() {
        let (w, h) = (32usize, 32usize);
        let held = ramp(w, h);
        let real = vec![200u8; w * h * 4];
        let field = MotionField::from_vectors(w, h, &[vector(8, 8, 16, 8, 0, 4, -1)]);
        let (mut out, mut prev, mut scratch) = (held.clone(), real.clone(), vec![0; held.len()]);
        step(&mut out, &mut prev, &real, &field, 0, &mut scratch);
        assert_eq!(px(&out, w, 4, 4), px(&held, w, 6, 4));
        assert_eq!(px(&out, w, 24, 4), px(&held, w, 24, 4));
    }

    /// `cargo test --release -p kinetograph-core --lib datamosh_cost -- --ignored --nocapture`: the cost of a
    /// step at 1080p with a field in which every other 16 x 16 block moves by a quarter-pixel multiple.
    #[test]
    #[ignore]
    fn datamosh_cost() {
        let (w, h) = (1920usize, 1080usize);
        let mut vectors = Vec::new();
        for by in 0..h.div_ceil(16) {
            for bx in 0..w.div_ceil(16) {
                if (bx + by) % 2 == 0 {
                    let (mx, my) = (
                        ((bx * 7 + by * 3) % 41) as i32 - 20,
                        ((bx * 5 + by * 11) % 33) as i32 - 16,
                    );
                    vectors.push(vector(
                        (bx * 16 + 8) as i16,
                        (by * 16 + 8) as i16,
                        16,
                        mx,
                        my,
                        4,
                        -1,
                    ));
                }
            }
        }
        let field = MotionField::from_vectors(w, h, &vectors);
        let pic = ramp_big(w, h);
        let mut out = pic.clone();
        let mut prev = pic.clone();
        let mut scratch = vec![0u8; pic.len()];
        let time = |name: &str, f: &mut dyn FnMut()| {
            f();
            let t = std::time::Instant::now();
            for _ in 0..10 {
                f();
            }
            eprintln!("{name}: {:.2} ms", t.elapsed().as_secs_f64() * 100.0);
        };
        time("advect", &mut || advect(&pic, &mut scratch, &field));
        time("step mix 0", &mut || {
            step(&mut out, &mut prev, &pic, &field, 0, &mut scratch)
        });
        time("step mix 0.5", &mut || {
            step(&mut out, &mut prev, &pic, &field, 128, &mut scratch)
        });
    }

    fn ramp_big(w: usize, h: usize) -> Vec<u8> {
        (0..w * h * 4)
            .map(|i| (i.wrapping_mul(2654435761) >> 13) as u8)
            .collect()
    }

    fn fake(w: u32, h: u32, n: i64) -> Fetched {
        let (w, h) = (w as usize, h as usize);
        // Picture n: a ramp offset by n; every frame pulls 1 pixel from the right in the left half.
        let mut image = ramp(w, h);
        for b in image.iter_mut() {
            *b = b.wrapping_add(n as u8 * 3);
        }
        let motion = MotionField::from_vectors(
            w,
            h,
            &[vector((w / 4) as i16, (h / 2) as i16, 16, 4, 0, 4, -1)],
        );
        Fetched {
            image: ImageData {
                data: peniko::Blob::from(image),
                format: peniko::ImageFormat::Rgba8,
                alpha_type: peniko::ImageAlphaType::Alpha,
                width: w as u32,
                height: h as u32,
            },
            motion: Arc::new(motion),
            pts: n,
        }
    }

    fn mosh(ts: &[i64], mix: u16) -> ResolvedMosh {
        ResolvedMosh {
            hold: ResolvedHold::Previous,
            mix,
            ts: Arc::new(ts.to_vec()),
        }
    }

    #[test]
    fn a_frame_is_the_same_continued_or_started_from_scratch() {
        let fetch = |ts: i64| -> Result<Fetched> { Ok(fake(48, 32, ts)) };
        for mix in [0u16, 100, 256] {
            let all: Vec<i64> = (0..12).collect();
            // Fresh at frame 11.
            let mut fresh = None;
            let a = frame(&mut fresh, &mosh(&all, mix), |_, _| unreachable!(), fetch)
                .unwrap()
                .rgba()
                .to_vec();
            // Continued from frame 2 one frame at a time.
            let mut kept = None;
            let mut last = Vec::new();
            for n in 2..all.len() {
                last = frame(
                    &mut kept,
                    &mosh(&all[..=n], mix),
                    |_, _| unreachable!(),
                    fetch,
                )
                .unwrap()
                .rgba()
                .to_vec();
            }
            assert_eq!(a, last, "mix {mix}");
            // Asking for an earlier frame starts over and still agrees with a fresh one.
            let early = frame(
                &mut kept,
                &mosh(&all[..=5], mix),
                |_, _| unreachable!(),
                fetch,
            )
            .unwrap()
            .rgba()
            .to_vec();
            let mut other = None;
            let want = frame(
                &mut other,
                &mosh(&all[..=5], mix),
                |_, _| unreachable!(),
                fetch,
            )
            .unwrap()
            .rgba()
            .to_vec();
            assert_eq!(early, want, "mix {mix}");
            assert_ne!(early, a, "mix {mix}: frames differ");
        }
    }

    #[test]
    fn a_repeated_picture_moves_nothing() {
        let fetch = |ts: i64| -> Result<Fetched> {
            let mut f = fake(48, 32, ts / 2);
            f.pts = ts / 2;
            Ok(f)
        };
        let mut slot = None;
        // ts 2 and 3 are one picture (pts 1).
        let a = frame(
            &mut slot,
            &mosh(&[0, 2, 3], 0),
            |_, _| unreachable!(),
            fetch,
        )
        .unwrap()
        .rgba()
        .to_vec();
        let mut slot = None;
        let b = frame(&mut slot, &mosh(&[0, 2], 0), |_, _| unreachable!(), fetch)
            .unwrap()
            .rgba()
            .to_vec();
        assert_eq!(a, b);
    }

    #[test]
    fn the_held_picture_of_another_clip_is_moved_by_this_clips_motion() {
        let fetch = |ts: i64| -> Result<Fetched> { Ok(fake(48, 32, ts)) };
        let held = vec![9u8; 48 * 32 * 4];
        let mosh = ResolvedMosh {
            hold: ResolvedHold::Clip {
                src: "a.mp4".into(),
                ts: 0,
            },
            mix: 0,
            ts: Arc::new(vec![0, 1, 2, 3]),
        };
        let mut slot = None;
        let got = frame(
            &mut slot,
            &mosh,
            |w, h| {
                assert_eq!((w, h), (48, 32));
                Ok(held.clone())
            },
            fetch,
        )
        .unwrap();
        // A flat picture stays flat whatever the motion.
        assert!(got.rgba().iter().all(|b| *b == 9));
    }

    #[test]
    fn cover_fits_a_picture_to_a_box() {
        let src = ramp(8, 4);
        // Same size: unchanged.
        assert_eq!(cover(&src, 8, 4, 8, 4), src);
        // Taller box: the middle columns of the source, stretched by 2 in height... a 4 x 4 box of
        // an 8 x 4 picture shows the middle 4 columns (x = 2 to 5).
        let sq = cover(&src, 8, 4, 4, 4);
        assert_eq!(px(&sq, 4, 0, 0), px(&src, 8, 2, 0));
        assert_eq!(px(&sq, 4, 3, 3), px(&src, 8, 5, 3));
    }
}
