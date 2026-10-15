//! Prints a hash of every frame's bytes, rendered the way `kinetograph render`
//! does (layer cache on, the next frame started before the last is read), so
//! two builds can be compared for byte-identical output.
//!
//!   cargo run --release -p kinetograph-core --example frame_hashes -- scene.json [first last] [--no-cache] [--no-fusion] [--times] [--dump DIR]
//!
//! `--times` prints the milliseconds `start_frame` (recording and submitting)
//! and `finish_frame` (waiting for the GPU) took per frame instead of the
//! hashes. `--dump DIR` also writes each frame as `DIR/N.png`.

use std::time::Instant;

use kinetograph_core::{Renderer, Scene};

fn hash(bytes: &[u8]) -> u64 {
    // FNV-1a over 8-byte words keeps this fast on 8 MB frames.
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let (words, rest) = bytes.as_chunks::<8>();
    for word in words {
        h ^= u64::from_le_bytes(*word);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
        h ^= h >> 29;
    }
    for &b in rest {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

fn main() {
    let mut positional = Vec::new();
    let (mut no_cache, mut no_fusion, mut times, mut dump) = (false, false, false, None);
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--no-cache" => no_cache = true,
            "--no-fusion" => no_fusion = true,
            "--times" => times = true,
            "--dump" => dump = Some(args.next().expect("--dump needs a directory")),
            _ => positional.push(arg),
        }
    }
    let scene = Scene::load(std::path::Path::new(&positional[0])).expect("scene");
    let first: u32 = positional.get(1).map_or(0, |s| s.parse().expect("first"));
    let last: u32 = positional
        .get(2)
        .map_or(scene.duration_in_frames - 1, |s| s.parse().expect("last"));
    if let Some(dir) = &dump {
        std::fs::create_dir_all(dir).expect("dump directory");
    }
    let mut renderer = Renderer::new(scene).expect("renderer");
    renderer.set_layer_cache(!no_cache);
    renderer.set_pass_fusion(!no_fusion);
    let (mut start_ms, mut finish_ms) = (0.0, 0.0);
    let all = Instant::now();
    let mut in_flight = None;
    for frame in (first..=last).map(Some).chain([None]) {
        let t = Instant::now();
        let started = frame.map(|f| (f, renderer.start_frame(f).expect("start")));
        start_ms += t.elapsed().as_secs_f64() * 1000.0;
        if let Some((f, pending)) = std::mem::replace(&mut in_flight, started) {
            let t = Instant::now();
            let rendered = renderer.finish_frame(pending).expect("finish");
            finish_ms += t.elapsed().as_secs_f64() * 1000.0;
            if !times {
                println!("{f} {:016x}", hash(&rendered.rgba));
            }
            if let Some(dir) = &dump {
                let png = rendered.encode_png().expect("png");
                std::fs::write(format!("{dir}/{f}.png"), png).expect("write");
            }
        }
    }
    if times {
        let n = f64::from(last - first + 1);
        println!(
            "per frame: start {:.2} ms, finish {:.2} ms, total {:.2} ms",
            start_ms / n,
            finish_ms / n,
            all.elapsed().as_secs_f64() * 1000.0 / n
        );
    }
}
