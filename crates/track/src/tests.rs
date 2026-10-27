use super::*;

/// Where frame `f`'s pixel `(x, y)` takes the texture from, or `None` for noise.
type Inverse = Box<dyn Fn(u32, f64, f64) -> Option<(f64, f64)>>;

/// A textured picture moved by `motion(frame)`: frame `f` shows the texture at `(x, y)` taken from
/// `inverse(f, x, y)`. Values are 8-bit gray, as a decoded video's would be.
struct Synthetic {
    width: u32,
    height: u32,
    count: u32,
    inverse: Inverse,
    pixels: Vec<u8>,
    decoded: Vec<u32>,
}

fn texture(x: f64, y: f64) -> f64 {
    let mut v =
        0.5 + 0.12 * (x * 0.31).sin() * (y * 0.23).cos() + 0.1 * (x * 0.07 + y * 0.11).sin();
    for (cx, cy, r) in [
        (60.0, 50.0, 6.0),
        (75.0, 62.0, 4.0),
        (52.0, 70.0, 5.0),
        (110.0, 90.0, 7.0),
    ] {
        let d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        v += 0.3 * (-d2 / (2.0 * r * r)).exp();
    }
    v.clamp(0.0, 1.0)
}

impl Synthetic {
    fn new(
        count: u32,
        inverse: impl Fn(u32, f64, f64) -> Option<(f64, f64)> + 'static,
    ) -> Synthetic {
        Synthetic {
            width: 192,
            height: 144,
            count,
            inverse: Box::new(inverse),
            pixels: Vec::new(),
            decoded: Vec::new(),
        }
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
    Synthetic::new(count, |f, x, y| {
        Some((x - STEP.0 * f as f64, y - STEP.1 * f as f64))
    })
}

fn point(x: f64, y: f64) -> Point {
    Point {
        name: "p".into(),
        x,
        y,
    }
}

fn assert_follows(path: &TrackedPath, start: (f64, f64), at: u32, tolerance: f64) {
    for m in &path.frames {
        let t = m.frame as f64 - at as f64;
        let (ex, ey) = (start.0 + STEP.0 * t, start.1 + STEP.1 * t);
        let (dx, dy) = (m.center[0] as f64 - ex, m.center[1] as f64 - ey);
        assert!(
            dx.hypot(dy) < tolerance,
            "frame {}: {:?}, expected ({ex:.3}, {ey:.3})",
            m.frame,
            m.center
        );
    }
}

#[test]
fn a_sliding_point_is_followed_with_either_match() {
    for matching in [Match::Keyframe, Match::Previous] {
        let mut frames = sliding(20);
        let options = Options {
            matching,
            ..Options::default()
        };
        let paths = track_points(
            &mut frames,
            &[point(60.0, 50.0)],
            &options,
            Range {
                from: 0,
                to: 19,
                backwards: false,
            },
        )
        .unwrap();
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
        Range {
            from: 3,
            to: 15,
            backwards: true,
        },
    )
    .unwrap();
    let frames_seen: Vec<u32> = paths[0].frames.iter().map(|m| m.frame).collect();
    assert_eq!(frames_seen, (3..=15).collect::<Vec<_>>());
    assert_follows(&paths[0], start, 15, 0.05);
}

#[test]
fn the_corners_start_as_blenders_pattern_square() {
    let mut frames = sliding(2);
    let options = Options {
        pattern_size: 21,
        ..Options::default()
    };
    let paths = track_points(
        &mut frames,
        &[point(60.0, 50.0)],
        &options,
        Range {
            from: 0,
            to: 0,
            backwards: false,
        },
    )
    .unwrap();
    let first = paths[0].frames[0];
    // Within the f32 rounding of Blender's normalised coordinates.
    let near = |a: [f32; 2], b: [f32; 2]| (a[0] - b[0]).abs() < 1e-4 && (a[1] - b[1]).abs() < 1e-4;
    assert!(near(first.center, [60.0, 50.0]), "{:?}", first.center);
    let want = [[49.5, 39.5], [70.5, 39.5], [70.5, 60.5], [49.5, 60.5]];
    assert!(
        first.corners.iter().zip(want).all(|(&a, b)| near(a, b)),
        "{:?}",
        first.corners
    );
}

#[test]
fn a_point_that_disappears_is_lost_and_stops() {
    // From frame 6 the picture is noise.
    let mut frames = Synthetic::new(12, |f, x, y| {
        (f < 6).then_some((x - STEP.0 * f as f64, y - STEP.1 * f as f64))
    });
    let paths = track_points(
        &mut frames,
        &[point(60.0, 50.0)],
        &Options::default(),
        Range {
            from: 0,
            to: 11,
            backwards: false,
        },
    )
    .unwrap();
    assert_eq!(paths[0].frames.len(), 6);
    assert_eq!(paths[0].lost, vec![6]);
}

#[test]
fn the_margin_check_stops_a_track_at_the_edge() {
    // Moves left 4 px a frame from x = 30: at x = 10 (frame 5) the 21 px pattern is past the edge, so frame 6 is
    // not tracked.
    let mut frames = Synthetic::new(12, |f, x, y| Some((x + 4.0 * f as f64 + 30.0, y)));
    let paths = track_points(
        &mut frames,
        &[point(30.0, 60.0)],
        &Options::default(),
        Range {
            from: 0,
            to: 11,
            backwards: false,
        },
    )
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
        Some((
            96.0 + dx * a.cos() - dy * a.sin() - 36.0,
            72.0 + dx * a.sin() + dy * a.cos() - 22.0,
        ))
    };
    let mut frames = Synthetic::new(10, rotating);
    let options = Options {
        model: MotionModel::LocRot,
        pattern_size: 31,
        search_size: 81,
        ..Options::default()
    };
    let paths = track_points(
        &mut frames,
        &[point(96.0, 72.0)],
        &options,
        Range {
            from: 0,
            to: 9,
            backwards: false,
        },
    )
    .unwrap();
    let last = paths[0].frames.last().unwrap();
    assert_eq!(last.frame, 9);
    let [tl, tr, _, _] = last.corners;
    let angle = ((tr[1] - tl[1]) as f64)
        .atan2((tr[0] - tl[0]) as f64)
        .to_degrees();
    assert!((angle - 18.0).abs() < 0.5, "angle {angle}");
}

#[test]
fn tracking_twice_gives_the_same_bits() {
    let run = || {
        let mut frames = sliding(12);
        let options = Options {
            model: MotionModel::Affine,
            ..Options::default()
        };
        track_points(
            &mut frames,
            &[point(60.0, 50.0), point(110.0, 90.0)],
            &options,
            Range {
                from: 0,
                to: 11,
                backwards: false,
            },
        )
        .unwrap()
    };
    assert_eq!(run(), run());
}

#[test]
fn bad_ranges_and_points_are_errors() {
    let mut frames = sliding(4);
    let options = Options::default();
    assert!(
        track_points(
            &mut frames,
            &[point(60.0, 50.0)],
            &options,
            Range {
                from: 0,
                to: 4,
                backwards: false
            }
        )
        .is_err()
    );
    assert!(
        track_points(
            &mut frames,
            &[point(-1.0, 50.0)],
            &options,
            Range {
                from: 0,
                to: 3,
                backwards: false
            }
        )
        .is_err()
    );
    let tiny = Options {
        search_size: 10,
        ..Options::default()
    };
    assert!(
        track_points(
            &mut frames,
            &[point(60.0, 50.0)],
            &tiny,
            Range {
                from: 0,
                to: 3,
                backwards: false
            }
        )
        .is_err()
    );
}

#[test]
fn names_parse_back() {
    for m in MotionModel::ALL {
        assert_eq!(MotionModel::parse(m.name()), Ok(m));
    }
    assert!(MotionModel::parse("homography").is_err());
    assert_eq!(Match::parse("previous"), Ok(Match::Previous));
}

/// Black frames with two white squares, the same on every frame: eight sharp corners for the detector.
struct Squares {
    pixels: Vec<u8>,
}

const SQUARES: [(u32, u32, u32, u32); 2] = [(40, 30, 80, 70), (120, 80, 160, 120)];

impl Squares {
    fn new() -> Squares {
        let (w, h) = (192u32, 144u32);
        let mut pixels = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                let white = SQUARES
                    .iter()
                    .any(|&(x0, y0, x1, y1)| (x0..x1).contains(&x) && (y0..y1).contains(&y));
                let v = if white { 255 } else { 0 };
                pixels.extend_from_slice(&[v, v, v, 255]);
            }
        }
        Squares { pixels }
    }

    /// The squares' corners, video pixels.
    fn corners() -> Vec<[f64; 2]> {
        SQUARES
            .iter()
            .flat_map(|&(x0, y0, x1, y1)| {
                [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(|[x, y]| [f64::from(x), f64::from(y)])
            })
            .collect()
    }
}

impl Frames for Squares {
    fn width(&self) -> u32 {
        192
    }
    fn height(&self) -> u32 {
        144
    }
    fn count(&self) -> u32 {
        3
    }
    fn rgba(&mut self, _frame: u32, _backwards: bool) -> Result<&[u8], String> {
        Ok(&self.pixels)
    }
}

fn near(found: &[[f64; 2]], want: [f64; 2], tolerance: f64) -> bool {
    found
        .iter()
        .any(|p| (p[0] - want[0]).hypot(p[1] - want[1]) <= tolerance)
}

#[test]
fn detect_features_finds_each_corner_once_and_keeps_its_distances() {
    let options = DetectOptions {
        min_distance: 10,
        margin: 4,
        ..DetectOptions::default()
    };
    let found = detect_features(&mut Squares::new(), 0, &options).unwrap();
    assert_eq!(found.len(), 8, "{found:?}");
    for c in Squares::corners() {
        assert!(near(&found, c, 2.0), "no feature near {c:?}: {found:?}");
    }
    for (i, a) in found.iter().enumerate() {
        // libmv's pixel centres: x + 0.5 in video pixels.
        assert_eq!(a[0].fract(), 0.5);
        assert_eq!(a[1].fract(), 0.5);
        for b in &found[i + 1..] {
            assert!((a[0] - b[0]).hypot(a[1] - b[1]) >= 10.0);
        }
    }
    // Blender's defaults keep one feature per 120 px.
    let sparse = detect_features(&mut Squares::new(), 0, &DetectOptions::default()).unwrap();
    assert!((1..=2).contains(&sparse.len()), "{sparse:?}");
    // A margin past the squares leaves nothing.
    let none = DetectOptions {
        margin: 72,
        min_distance: 10,
        ..DetectOptions::default()
    };
    assert!(
        detect_features(&mut Squares::new(), 0, &none)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn detect_placement_keeps_inside_or_outside_the_polygons() {
    // A triangle around the first square's top-left corner only.
    let polygon = vec![[20.0, 10.0], [70.0, 10.0], [20.0, 60.0]];
    let options = |placement| DetectOptions {
        min_distance: 10,
        margin: 4,
        placement,
        ..DetectOptions::default()
    };
    let all = detect_features(&mut Squares::new(), 0, &options(Placement::Frame)).unwrap();
    let inside = detect_features(
        &mut Squares::new(),
        0,
        &options(Placement::Inside(vec![polygon.clone()])),
    )
    .unwrap();
    let outside = detect_features(
        &mut Squares::new(),
        0,
        &options(Placement::Outside(vec![polygon])),
    )
    .unwrap();
    assert_eq!(inside.len(), 1, "{inside:?}");
    assert!(near(&inside, [40.0, 30.0], 2.0));
    assert_eq!(outside.len(), 7);
    assert!(!near(&outside, [40.0, 30.0], 2.0));
    // Placement only filters: the kept features are in the same order as without it.
    let rest: Vec<_> = all
        .iter()
        .filter(|p| !inside.contains(p))
        .copied()
        .collect();
    assert_eq!(rest, outside);
}

#[test]
fn detect_errors_on_a_missing_frame_or_a_bad_threshold() {
    assert!(detect_features(&mut Squares::new(), 3, &DetectOptions::default()).is_err());
    let bad = DetectOptions {
        threshold: -1.0,
        ..DetectOptions::default()
    };
    assert!(detect_features(&mut Squares::new(), 0, &bad).is_err());
}

/// Four points of `texture` that track well, no three on a line (that would leave the homography undetermined).
fn blobs() -> Vec<Point> {
    [(60.0, 50.0), (140.0, 40.0), (52.0, 70.0), (110.0, 90.0)]
        .iter()
        .enumerate()
        .map(|(i, &(x, y))| Point {
            name: format!("p{}", i + 1),
            x,
            y,
        })
        .collect()
}

fn plane(tracks: &[&str], corners: Option<[[f64; 2]; 4]>) -> PlaneRequest {
    PlaneRequest {
        name: "plane1".into(),
        tracks: tracks.iter().map(|s| s.to_string()).collect(),
        corners,
    }
}

#[test]
fn a_plane_starts_as_the_patterns_bounding_box_and_slides_with_the_points() {
    let job = Job {
        points: blobs(),
        first: Some(5),
        last: Some(15),
        planes: vec![plane(&[], None)],
        ..Job::default()
    };
    let (tracks, planes) = track_clip(&mut sliding(30), &job).unwrap();
    assert_eq!(tracks.len(), 4);
    let p = &planes[0];
    assert_eq!(p.tracks, ["p1", "p2", "p3", "p4"]);
    // Blender carries the plane one frame past each end, onto the disabled markers there.
    let seen: Vec<u32> = p.frames.iter().map(|f| f.frame).collect();
    assert_eq!(seen, (4..=16).collect::<Vec<_>>());
    // Bounding box of the 21 px patterns around the points at frame 5.
    let start = p.frames.iter().find(|f| f.frame == 5).unwrap().corners;
    let (x0, y0, x1, y1) = (52.0 - 10.5, 40.0 - 10.5, 140.0 + 10.5, 90.0 + 10.5);
    let want = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    for (c, w) in start.iter().zip(want) {
        assert!(
            (c[0] - w[0]).abs() < 1e-3 && (c[1] - w[1]).abs() < 1e-3,
            "{start:?}"
        );
    }
    // The frame before the start holds the placed markers, so the plane stays.
    assert_eq!(p.frames[0].corners, start);
    for f in &p.frames[1..p.frames.len() - 1] {
        let t = f.frame as f64 - 5.0;
        for (c, w) in f.corners.iter().zip(want) {
            let (ex, ey) = (w[0] + STEP.0 * t, w[1] + STEP.1 * t);
            // Corners away from the points, carried frame to frame, gather the tracks' small errors.
            assert!(
                (c[0] - ex).hypot(c[1] - ey) < 0.15,
                "frame {}: {c:?}, expected ({ex}, {ey})",
                f.frame
            );
        }
    }
}

/// A clip whose texture turns and grows about (96, 72), a little more each frame: frame `f` shows the texture's
/// point q at c + s R (q - c).
fn turning(count: u32) -> Synthetic {
    Synthetic::new(count, |f, x, y| {
        let (s, a) = (1.0 + 0.006 * f as f64, (0.5 * f as f64).to_radians());
        let (dx, dy) = ((x - 96.0) / s, (y - 72.0) / s);
        Some((
            96.0 + dx * a.cos() + dy * a.sin(),
            72.0 - dx * a.sin() + dy * a.cos(),
        ))
    })
}

#[test]
fn given_corners_follow_the_motion_of_the_points() {
    let corners = [[30.0, 30.0], [150.0, 40.0], [140.0, 110.0], [40.0, 100.0]];
    let job = Job {
        points: blobs(),
        options: Options {
            model: MotionModel::LocRotScale,
            ..Options::default()
        },
        last: Some(10),
        planes: vec![plane(&["p1", "p2", "p3", "p4"], Some(corners))],
        ..Job::default()
    };
    let (_, planes) = track_clip(&mut turning(11), &job).unwrap();
    let frames = &planes[0].frames;
    assert_eq!(frames.len(), 11);
    for f in frames {
        let (s, a) = (
            1.0 + 0.006 * f.frame as f64,
            (0.5 * f.frame as f64).to_radians(),
        );
        for (c, q) in f.corners.iter().zip(corners) {
            let (dx, dy) = (q[0] - 96.0, q[1] - 72.0);
            let want = [
                96.0 + s * (dx * a.cos() - dy * a.sin()),
                72.0 + s * (dx * a.sin() + dy * a.cos()),
            ];
            assert!(
                (c[0] - want[0]).hypot(c[1] - want[1]) < 0.3,
                "frame {}: {c:?}, expected {want:?}",
                f.frame
            );
        }
    }
}

#[test]
fn a_plane_stops_where_fewer_than_four_tracks_go_on() {
    let mut frames = Synthetic::new(12, |f, x, y| {
        // Noise from frame 6 on in the bottom-right quarter: p4 (110, 90) is lost there.
        if f >= 6 && x > 96.0 && y > 72.0 {
            None
        } else {
            Some((x - STEP.0 * f as f64, y - STEP.1 * f as f64))
        }
    });
    let job = Job {
        points: blobs(),
        planes: vec![plane(&[], None)],
        ..Job::default()
    };
    let (tracks, planes) = track_clip(&mut frames, &job).unwrap();
    let lost_at = tracks[3].lost.first().copied().expect("p4 is lost");
    assert!(lost_at >= 6, "{:?}", tracks[3].lost);
    // Forwards it reaches the disabled markers at the lost frame and one past it (a failed match), then stops.
    let last = planes[0].frames.last().unwrap().frame;
    assert_eq!(last, lost_at + 1);
    assert_eq!(planes[0].frames[0].frame, 0);
}

#[test]
fn plane_and_job_errors_name_the_problem() {
    let run = |job: Job| track_clip(&mut sliding(5), &job).unwrap_err();
    let e = run(Job {
        points: blobs()[..3].to_vec(),
        planes: vec![plane(&[], None)],
        ..Job::default()
    });
    assert!(e.contains("at least 4"), "{e}");
    let e = run(Job {
        points: blobs(),
        planes: vec![plane(&["p1", "p2", "p3", "nope"], None)],
        ..Job::default()
    });
    assert!(e.contains("\"nope\""), "{e}");
    let e = run(Job::default());
    assert!(e.contains("no point"), "{e}");
    let mut twice = blobs();
    twice[1].name = "p1".into();
    let e = run(Job {
        points: twice,
        ..Job::default()
    });
    assert!(e.contains("\"p1\""), "{e}");
}

#[test]
fn detected_points_are_named_on_from_the_given_ones() {
    let job = Job {
        points: vec![Point {
            name: "mine".into(),
            x: 100.0,
            y: 20.0,
        }],
        detect: Some(DetectOptions {
            min_distance: 10,
            margin: 4,
            ..DetectOptions::default()
        }),
        last: Some(1),
        ..Job::default()
    };
    let (tracks, _) = track_clip(&mut Squares::new(), &job).unwrap();
    let names: Vec<&str> = tracks.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(
        names,
        ["mine", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"]
    );
}
