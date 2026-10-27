//! Repeatability goldens: real footage tracked with fixed settings must give the same bits every run on a platform.
//!
//! Each case's markers (every coordinate and correlation, as f32 bits) are hashed; `goldens/<platform>.txt` holds the
//! hash and a readable summary per case. Platforms are not expected to agree with each other bit for bit (different
//! compilers and maths libraries round Ceres's and Eigen's sums differently), so each has its own file. A platform
//! without a file only prints its lines. `KT_UPDATE_GOLDENS=1` writes the file.

use std::path::{Path, PathBuf};

use kinetograph_track::{
    DetectOptions, Job, Match, MotionModel, Options, PlaneRequest, Point, TrackFile, track_video,
};

fn platform() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-arm64",
        ("linux", "x86_64") => "linux-x64-gnu",
        ("windows", "x86_64") => "win32-x64-msvc",
        _ => "other",
    }
}

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// FNV-1a over every number of every marker.
fn digest(file: &TrackFile) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |v: u32| {
        for b in v.to_le_bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    };
    for t in &file.tracks {
        for m in &t.frames {
            eat(m.frame);
            m.center
                .iter()
                .chain(m.corners.iter().flatten())
                .for_each(|v| eat(v.to_bits()));
            eat(m.correlation.to_bits());
        }
        t.lost.iter().for_each(|&f| eat(f));
    }
    for p in &file.planes {
        for m in &p.frames {
            eat(m.frame);
            for v in m.corners.iter().flatten() {
                let bits = v.to_bits();
                eat(bits as u32);
                eat((bits >> 32) as u32);
            }
        }
    }
    h
}

fn line(name: &str, file: &TrackFile) -> String {
    let mut summary: Vec<String> = file
        .tracks
        .iter()
        .take(4)
        .map(|t| {
            let last = t.frames.last().expect("a placed marker");
            format!(
                "{}:{}@{}=({:.3},{:.3})",
                t.name,
                t.frames.len(),
                last.frame,
                last.center[0],
                last.center[1]
            )
        })
        .collect();
    if file.tracks.len() > 4 {
        summary.push(format!("({} tracks)", file.tracks.len()));
    }
    summary.extend(file.planes.iter().map(|p| {
        let last = p.frames.last().expect("a plane marker");
        format!(
            "{}:{}@{}=({:.3},{:.3})",
            p.name,
            p.frames.len(),
            last.frame,
            last.corners[0][0],
            last.corners[0][1]
        )
    }));
    format!("{name} {:016x} {}", digest(file), summary.join(" "))
}

/// A name and the job.
type Case = (&'static str, Job);

#[test]
fn real_footage_tracks_the_same_every_run() {
    // A camera pan over a crowd (62 frames, 24 fps): every point tracks the whole clip, so each case is a long chain.
    let clip = repo().join("examples/launch/public/footage/veteran.mp4");
    let points = |xy: &[(f64, f64)]| -> Vec<Point> {
        xy.iter()
            .enumerate()
            .map(|(i, &(x, y))| Point {
                name: format!("p{}", i + 1),
                x,
                y,
            })
            .collect()
    };
    let four = points(&[
        (820.0, 540.0),
        (1250.0, 430.0),
        (820.0, 360.0),
        (200.0, 600.0),
    ]);
    let cases: Vec<Case> = vec![
        (
            "loc-keyframe",
            Job {
                points: four.clone(),
                ..Job::default()
            },
        ),
        (
            "affine-previous",
            Job {
                points: points(&[(1250.0, 430.0)]),
                options: Options {
                    model: MotionModel::Affine,
                    matching: Match::Previous,
                    pattern_size: 31,
                    search_size: 91,
                    ..Options::default()
                },
                ..Job::default()
            },
        ),
        (
            "perspective-backwards",
            Job {
                points: points(&[(820.0, 540.0)]),
                options: Options {
                    model: MotionModel::Perspective,
                    pattern_size: 41,
                    search_size: 101,
                    ..Options::default()
                },
                first: Some(10),
                last: Some(50),
                backwards: true,
                ..Job::default()
            },
        ),
        (
            "plane-middle",
            Job {
                points: four,
                first: Some(20),
                planes: vec![PlaneRequest {
                    name: "plane1".into(),
                    tracks: Vec::new(),
                    corners: None,
                }],
                ..Job::default()
            },
        ),
        (
            "detect-plane",
            Job {
                detect: Some(DetectOptions {
                    threshold: 0.05,
                    min_distance: 150,
                    ..DetectOptions::default()
                }),
                last: Some(30),
                planes: vec![PlaneRequest {
                    name: "plane1".into(),
                    tracks: Vec::new(),
                    corners: Some([
                        [700.0, 300.0],
                        [1300.0, 320.0],
                        [1280.0, 700.0],
                        [720.0, 680.0],
                    ]),
                }],
                ..Job::default()
            },
        ),
    ];
    let lines: Vec<String> = cases
        .iter()
        .map(|(name, job)| {
            let a = track_video(&clip, job).unwrap();
            let b = track_video(&clip, job).unwrap();
            assert_eq!(a, b, "{name}: two runs differ");
            line(name, &a)
        })
        .collect();
    let text = lines.join("\n") + "\n";
    let golden =
        Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/goldens/{}.txt", platform()));
    if std::env::var_os("KT_UPDATE_GOLDENS").is_some() {
        std::fs::create_dir_all(golden.parent().unwrap()).unwrap();
        std::fs::write(&golden, &text).unwrap();
    }
    match std::fs::read_to_string(&golden) {
        Ok(want) => assert_eq!(text, want, "tracks differ from {}", golden.display()),
        Err(_) => eprintln!("no golden for {}; this run gives:\n{text}", platform()),
    }
}
