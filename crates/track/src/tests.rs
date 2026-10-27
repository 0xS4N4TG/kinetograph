use super::*;

/// A textured picture moved by `motion(frame)`: frame `f` shows the texture at `(x, y)` taken from
/// `inverse(f, x, y)`. Values are 8-bit gray, as a decoded video's would be.
struct Synthetic {
    width: u32,
    height: u32,
    count: u32,
    inverse: Box<dyn Fn(u32, f64, f64) -> Option<(f64, f64)>>,
    pixels: Vec<u8>,
    decoded: Vec<u32>,
}

fn texture(x: f64, y: f64) -> f64 {
    let mut v = 0.5 + 0.12 * (x * 0.31).sin() * (y * 0.23).cos() + 0.1 * (x * 0.07 + y * 0.11).sin();
    for (cx, cy, r) in [(60.0, 50.0, 6.0), (75.0, 62.0, 4.0), (52.0, 70.0, 5.0), (110.0, 90.0, 7.0)] {
        let d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        v += 0.3 * (-d2 / (2.0 * r * r)).exp();
    }
    v.clamp(0.0, 1.0)
}

impl Synthetic {
    fn new(count: u32, inverse: impl Fn(u32, f64, f64) -> Option<(f64, f64)> + 'static) -> Synthetic {
        Synthetic { width: 192, height: 144, count, inverse: Box::new(inverse), pixels: Vec::new(), decoded: Vec::new() }
    }
}

impl Frames for Synthetic {
    fn width(&self) -> u32 {
        self.width
    }
    fn height(&self) -> u32 {
        self.height
    }
    fn count(&self) -> u32 {
        self.count
    }
    fn rgba(&mut self, frame: u32, _backwards: bool) -> Result<&[u8], String> {
        self.decoded.push(frame);
        self.pixels.clear();
        for y in 0..self.height {
            for x in 0..self.width {
                // Pixel centres are at +0.5 in video pixels.
                let v = match (self.inverse)(frame, x as f64 + 0.5, y as f64 + 0.5) {
                    Some((u, w)) => texture(u, w),
                    None => ((x * 7919 + y * 104729 + frame * 31) % 256) as f64 / 255.0,
                };
                let b = (v * 255.0).round() as u8;
                self.pixels.extend_from_slice(&[b, b, b, 255]);
            }
        }
        Ok(&self.pixels)
    }
}

const STEP: (f64, f64) = (1.3, -0.7);

fn sliding(count: u32) -> Synthetic {
    Synthetic::new(count, |f, x, y| Some((x - STEP.0 * f as f64, y - STEP.1 * f as f64)))
}

fn point(x: f64, y: f64) -> Point {
    Point { name: "p".into(), x, y }
}

fn assert_follows(path: &TrackedPath, start: (f64, f64), at: u32, tolerance: f64) {
    for m in &path.frames {
        let t = m.frame as f64 - at as f64;
        let (ex, ey) = (start.0 + STEP.0 * t, start.1 + STEP.1 * t);
        let (dx, dy) = (m.center[0] as f64 - ex, m.center[1] as f64 - ey);
        assert!(dx.hypot(dy) < tolerance, "frame {}: {:?}, expected ({ex:.3}, {ey:.3})", m.frame, m.center);
    }
}

#[test]
fn a_sliding_point_is_followed_with_either_match() {
    for matching in [Match::Keyframe, Match::Previous] {
        let mut frames = sliding(20);
        let options = Options { matching, ..Options::default() };
        let paths =
            track_points(&mut frames, &[point(60.0, 50.0)], &options, Range { from: 0, to: 19, backwards: false }).unwrap();
        let path = &paths[0];
        assert_eq!(path.frames.len(), 20, "{matching:?}");
        assert!(path.lost.is_empty());
        assert_eq!(path.model, "loc");
        assert_follows(path, (60.0, 50.0), 0, 0.05);
        assert!(path.frames[1..].iter().all(|m| m.correlation > 0.9));
    }
}

#[test]
fn backwards_starts_at_the_end_and_lists_frames_in_order() {
    let mut frames = sliding(16);
    let start = (60.0 + STEP.0 * 15.0, 50.0 + STEP.1 * 15.0);
    let paths = track_points(
        &mut frames,
        &[point(start.0, start.1)],
        &Options::default(),
        Range { from: 3, to: 15, backwards: true },
    )
    .unwrap();
    let frames_seen: Vec<u32> = paths[0].frames.iter().map(|m| m.frame).collect();
    assert_eq!(frames_seen, (3..=15).collect::<Vec<_>>());
    assert_follows(&paths[0], start, 15, 0.05);
}

#[test]
fn the_corners_start_as_blenders_pattern_square() {
    let mut frames = sliding(2);
    let options = Options { pattern_size: 21, ..Options::default() };
    let paths = track_points(&mut frames, &[point(60.0, 50.0)], &options, Range { from: 0, to: 0, backwards: false }).unwrap();
    let first = paths[0].frames[0];
    // Within the f32 rounding of Blender's normalised coordinates.
    let near = |a: [f32; 2], b: [f32; 2]| (a[0] - b[0]).abs() < 1e-4 && (a[1] - b[1]).abs() < 1e-4;
    assert!(near(first.center, [60.0, 50.0]), "{:?}", first.center);
    let want = [[49.5, 39.5], [70.5, 39.5], [70.5, 60.5], [49.5, 60.5]];
    assert!(first.corners.iter().zip(want).all(|(&a, b)| near(a, b)), "{:?}", first.corners);
}

#[test]
fn a_point_that_disappears_is_lost_and_stops() {
    // From frame 6 the picture is noise.
    let mut frames = Synthetic::new(12, |f, x, y| (f < 6).then(|| (x - STEP.0 * f as f64, y - STEP.1 * f as f64)));
    let paths =
        track_points(&mut frames, &[point(60.0, 50.0)], &Options::default(), Range { from: 0, to: 11, backwards: false })
            .unwrap();
    assert_eq!(paths[0].frames.len(), 6);
    assert_eq!(paths[0].lost, vec![6]);
}

#[test]
fn the_margin_check_stops_a_track_at_the_edge() {
    // Moves left 4 px a frame from x = 30: at x = 10 (frame 5) the 21 px pattern is past the edge, so frame 6 is
    // not tracked.
    let mut frames = Synthetic::new(12, |f, x, y| Some((x + 4.0 * f as f64 + 30.0, y)));
    let paths =
        track_points(&mut frames, &[point(30.0, 60.0)], &Options::default(), Range { from: 0, to: 11, backwards: false })
            .unwrap();
    let last = paths[0].frames.last().unwrap();
    assert_eq!(last.frame, 5, "{last:?}");
    assert_eq!(paths[0].lost, vec![last.frame + 1]);
}

#[test]
fn a_rotating_patch_turns_its_corners() {
    // Turns 2 degrees a frame about (96, 72).
    let rotating = |f: u32, x: f64, y: f64| {
        let a = -(2.0f64).to_radians() * f as f64;
        let (dx, dy) = (x - 96.0, y - 72.0);
        Some((96.0 + dx * a.cos() - dy * a.sin() - 36.0, 72.0 + dx * a.sin() + dy * a.cos() - 22.0))
    };
    let mut frames = Synthetic::new(10, rotating);
    let options = Options { model: MotionModel::LocRot, pattern_size: 31, search_size: 81, ..Options::default() };
    let paths = track_points(&mut frames, &[point(96.0, 72.0)], &options, Range { from: 0, to: 9, backwards: false }).unwrap();
    let last = paths[0].frames.last().unwrap();
    assert_eq!(last.frame, 9);
    let [tl, tr, _, _] = last.corners;
    let angle = ((tr[1] - tl[1]) as f64).atan2((tr[0] - tl[0]) as f64).to_degrees();
    assert!((angle - 18.0).abs() < 0.5, "angle {angle}");
}

#[test]
fn tracking_twice_gives_the_same_bits() {
    let run = || {
        let mut frames = sliding(12);
        let options = Options { model: MotionModel::Affine, ..Options::default() };
        track_points(&mut frames, &[point(60.0, 50.0), point(110.0, 90.0)], &options, Range { from: 0, to: 11, backwards: false })
            .unwrap()
    };
    assert_eq!(run(), run());
}

#[test]
fn bad_ranges_and_points_are_errors() {
    let mut frames = sliding(4);
    let options = Options::default();
    assert!(track_points(&mut frames, &[point(60.0, 50.0)], &options, Range { from: 0, to: 4, backwards: false }).is_err());
    assert!(track_points(&mut frames, &[point(-1.0, 50.0)], &options, Range { from: 0, to: 3, backwards: false }).is_err());
    let tiny = Options { search_size: 10, ..Options::default() };
    assert!(track_points(&mut frames, &[point(60.0, 50.0)], &tiny, Range { from: 0, to: 3, backwards: false }).is_err());
}

#[test]
fn names_parse_back() {
    for m in MotionModel::ALL {
        assert_eq!(MotionModel::parse(m.name()), Ok(m));
    }
    assert!(MotionModel::parse("homography").is_err());
    assert_eq!(Match::parse("previous"), Ok(Match::Previous));
}
