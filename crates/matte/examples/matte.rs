//! `cargo run -p kinetograph-matte --release --example matte -- <input> <modnet|ben2-base> <model.onnx> <foreground> [base] [jobs]`
//! Mattes a clip without the addon, for measuring.

use std::path::PathBuf;
use std::time::Instant;

use kinetograph_matte::{AudioTarget, Model, Options, Quality, matte_video, support};

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    if a.len() < 4 {
        eprintln!(
            "usage: matte <input> <model> <model.onnx> <foreground> [base|-] [jobs] [quality] [audio]"
        );
        std::process::exit(2);
    }
    let s = support();
    println!(
        "support: available={} backend={} reason={:?}",
        s.available, s.backend, s.reason
    );
    let options = Options {
        input: PathBuf::from(&a[0]),
        model: Model::parse(&a[1]).unwrap(),
        model_path: PathBuf::from(&a[2]),
        foreground: PathBuf::from(&a[3]),
        base: a.get(4).filter(|b| *b != "-").map(PathBuf::from),
        audio: if a.get(7).is_none_or(|v| v == "keep") {
            AudioTarget::Both
        } else {
            AudioTarget::None
        },
        video_bitrate: None,
        audio_bitrate: None,
        keyframe_seconds: None,
        cancel: None,
        quality: Quality::parse(a.get(6).map_or("high", |q| q.as_str())).unwrap(),
        jobs: a.get(5).map_or(2, |j| j.parse().unwrap()),
    };
    let t = Instant::now();
    let last = std::sync::atomic::AtomicU64::new(0);
    let out = matte_video(&options, &|done, total| {
        if done % 20 == 0 || done == total {
            last.store(done, std::sync::atomic::Ordering::Relaxed);
            eprintln!("  {done}/{total}");
        }
    })
    .unwrap();
    let secs = t.elapsed().as_secs_f64();
    println!(
        "{out:?}: {} frames in {secs:.2}s = {:.1} fps",
        out.frames,
        out.frames as f64 / secs
    );
}
