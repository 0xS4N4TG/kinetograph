//! Tracks one point through a clip the way Blender's "Track Markers" does, frame by frame.
//!
//! cargo run --release -p libmv-sys --example track_point -- CLIP X Y [--frames N] [--model loc|locrot|locscale|
//!     locrotscale|affine|perspective] [--pattern PX] [--search PX] [--png OUT.png] [--dump OUT.txt]
//!
//! Frames are decoded with `ffmpeg` (or $FFMPEG) to RGB, then made grayscale as Blender does
//! (0.2126 R + 0.7152 G + 0.0722 B on bytes / 255). Prints the path and the time per tracked frame; `--dump` writes
//! every result as bit patterns, for comparing runs byte for byte.

use libmv_sys::*;
use std::io::{Read, Write};
use std::os::raw::{c_int, c_void};
use std::process::{Command, Stdio};
use std::time::Instant;

struct Clip {
    width: usize,
    height: usize,
    frames: Vec<Vec<f32>>,
}

unsafe extern "C" fn get_frame(user: *mut c_void, frame: c_int, pixels: *mut *const f32) -> c_int {
    let clip = unsafe { &*(user as *const Clip) };
    match clip.frames.get(frame as usize) {
        Some(f) if frame >= 0 => {
            unsafe { *pixels = f.as_ptr() };
            1
        }
        _ => 0,
    }
}

fn probe(path: &str) -> (usize, usize) {
    let out = Command::new(ffprobe())
        .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path])
        .output()
        .expect("ffprobe");
    let s = String::from_utf8_lossy(&out.stdout);
    let mut it = s.trim().split(',').map(|v| v.parse::<usize>().expect("size"));
    (it.next().unwrap(), it.next().unwrap())
}

fn ffmpeg() -> String {
    std::env::var("FFMPEG").unwrap_or_else(|_| "ffmpeg".into())
}

fn ffprobe() -> String {
    std::env::var("FFPROBE").unwrap_or_else(|_| "ffprobe".into())
}

fn decode(path: &str, frames: usize) -> (Clip, Vec<Vec<u8>>) {
    let (width, height) = probe(path);
    let mut child = Command::new(ffmpeg())
        .args(["-v", "error", "-i", path, "-frames:v", &frames.to_string(), "-pix_fmt", "rgb24", "-f", "rawvideo", "-"])
        .stdout(Stdio::piped())
        .spawn()
        .expect("ffmpeg");
    let mut raw = Vec::new();
    child.stdout.take().unwrap().read_to_end(&mut raw).unwrap();
    child.wait().unwrap();
    let size = width * height * 3;
    let rgb: Vec<Vec<u8>> = raw.chunks_exact(size).map(|c| c.to_vec()).collect();
    let gray = rgb
        .iter()
        .map(|f| {
            f.chunks_exact(3)
                .map(|p| {
                    let (r, g, b) = (p[0] as f32 * (1.0 / 255.0), p[1] as f32 * (1.0 / 255.0), p[2] as f32 * (1.0 / 255.0));
                    0.2126f32 * r + 0.7152f32 * g + 0.0722f32 * b
                })
                .collect()
        })
        .collect();
    (Clip { width, height, frames: gray }, rgb)
}

fn marker_at(x: f32, y: f32, pattern: f32, search: f32) -> kt_marker {
    let (p, s) = (pattern / 2.0, search / 2.0);
    kt_marker {
        frame: 0,
        track: 0,
        center: [x, y],
        // Blender's corner order: bottom-left, bottom-right, top-right, top-left in its y-up frame.
        patch: [[x - p, y - p], [x + p, y - p], [x + p, y + p], [x - p, y + p]],
        search_min: [x - s, y - s],
        search_max: [x + s, y + s],
        reference_frame: 0,
    }
}

fn draw_path(rgb: &[u8], w: usize, h: usize, path: &[kt_marker], out: &str) {
    let mut img = image::RgbImage::from_raw(w as u32, h as u32, rgb.to_vec()).unwrap();
    let mut put = |x: i64, y: i64, c: [u8; 3]| {
        if x >= 0 && y >= 0 && (x as usize) < w && (y as usize) < h {
            img.put_pixel(x as u32, y as u32, image::Rgb(c));
        }
    };
    for pair in path.windows(2) {
        let (a, b) = (pair[0].center, pair[1].center);
        let n = ((b[0] - a[0]).abs().max((b[1] - a[1]).abs()).ceil() as i64).max(1);
        for i in 0..=n {
            let t = i as f32 / n as f32;
            let (x, y) = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
            for dy in -1..=1 {
                for dx in -1..=1 {
                    put(x.round() as i64 + dx, y.round() as i64 + dy, [255, 40, 40]);
                }
            }
        }
    }
    // Last pattern quad in green.
    if let Some(m) = path.last() {
        for i in 0..4 {
            let (a, b) = (m.patch[i], m.patch[(i + 1) % 4]);
            for s in 0..=100 {
                let t = s as f32 / 100.0;
                put((a[0] + (b[0] - a[0]) * t).round() as i64, (a[1] + (b[1] - a[1]) * t).round() as i64, [40, 255, 40]);
            }
        }
    }
    img.save(out).unwrap();
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let clip_path = &args[1];
    let x: f32 = args[2].parse().unwrap();
    let y: f32 = args[3].parse().unwrap();
    let flag = |name: &str| args.iter().position(|a| a == name).map(|i| args[i + 1].clone());
    let frames: usize = flag("--frames").map_or(60, |v| v.parse().unwrap());
    let pattern: f32 = flag("--pattern").map_or(31.0, |v| v.parse().unwrap());
    let search: f32 = flag("--search").map_or(121.0, |v| v.parse().unwrap());
    let model = match flag("--model").as_deref().unwrap_or("loc") {
        "loc" => KT_MOTION_LOC,
        "locrot" => KT_MOTION_LOC_ROT,
        "locscale" => KT_MOTION_LOC_SCALE,
        "locrotscale" => KT_MOTION_LOC_ROT_SCALE,
        "affine" => KT_MOTION_AFFINE,
        "perspective" => KT_MOTION_PERSPECTIVE,
        m => panic!("unknown model {m}"),
    };

    let t0 = Instant::now();
    let (clip, rgb) = decode(clip_path, frames);
    eprintln!("decoded {} frames {}x{} in {:.0} ms", clip.frames.len(), clip.width, clip.height, t0.elapsed().as_secs_f64() * 1e3);

    let mut options = kt_track_options::default();
    unsafe { kt_track_options_default(&mut options) };
    options.motion_model = model;

    let tracker = unsafe {
        kt_tracker_new(clip.width as c_int, clip.height as c_int, clip.frames.len() as c_int, get_frame, &clip as *const Clip as *mut c_void)
    };
    assert!(!tracker.is_null());

    // Blender's default: match against the previous frame's pattern ("Previous frame" match), forwards.
    let mut current = marker_at(x, y, pattern, search);
    unsafe { kt_tracker_add_marker(tracker, &current) };
    let mut path = vec![current];
    let mut results = vec![kt_track_result { termination: 0, correlation: 1.0, num_iterations: 0 }];
    let mut times = Vec::new();
    for frame in 1..clip.frames.len() as c_int {
        let mut next = current;
        next.frame = frame;
        next.reference_frame = current.frame;
        let mut result = kt_track_result::default();
        let t = Instant::now();
        let ok = unsafe { kt_tracker_track(tracker, &options, &mut next, &mut result) };
        times.push(t.elapsed().as_secs_f64() * 1e3);
        if ok == 0 {
            eprintln!("frame {frame}: lost (termination {}, correlation {:.3})", result.termination, result.correlation);
            break;
        }
        unsafe { kt_tracker_add_marker(tracker, &next) };
        path.push(next);
        results.push(result);
        current = next;
    }
    unsafe { kt_tracker_free(tracker) };

    for (m, r) in path.iter().zip(&results) {
        println!("{:3} {:9.3} {:9.3} corr {:.4}", m.frame, m.center[0], m.center[1], r.correlation);
    }
    if !times.is_empty() {
        let mut sorted = times.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mean = times.iter().sum::<f64>() / times.len() as f64;
        eprintln!(
            "tracked {} frames: mean {:.2} ms, median {:.2} ms, max {:.2} ms per frame per point",
            times.len(),
            mean,
            sorted[sorted.len() / 2],
            sorted[sorted.len() - 1]
        );
    }
    if let Some(out) = flag("--png") {
        let last = path.last().unwrap().frame as usize;
        draw_path(&rgb[last], clip.width, clip.height, &path, &out);
        eprintln!("wrote {out}");
    }
    if let Some(out) = flag("--dump") {
        let mut f = std::fs::File::create(&out).unwrap();
        for (m, r) in path.iter().zip(&results) {
            let bits: Vec<String> = [m.center[0], m.center[1]]
                .iter()
                .chain(m.patch.iter().flatten())
                .chain(m.search_min.iter())
                .chain(m.search_max.iter())
                .map(|v| format!("{:08x}", v.to_bits()))
                .collect();
            writeln!(f, "{} {} {:016x}", m.frame, bits.join(" "), r.correlation.to_bits()).unwrap();
        }
        eprintln!("wrote {out}");
    }
}
