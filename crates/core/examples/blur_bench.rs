//! Times whole frames of scenes, for comparing blurs of different radii:
//! `cargo run --release --example blur_bench -- a.json b.json ...` renders
//! each scene's frames 0..5 to warm up, then all its frames three times, and
//! prints the best of the three mean milliseconds per frame (the frame read
//! back to the CPU included).

use std::path::Path;
use std::time::Instant;

use kinetograph_core::{Renderer, Scene};

fn main() {
    for path in std::env::args().skip(1) {
        let scene = Scene::load(Path::new(&path)).expect("a scene");
        let frames = scene.duration_in_frames;
        let mut renderer = Renderer::new(scene).expect("a renderer");
        for f in 0..5.min(frames) {
            renderer.render_frame(f).expect("a frame");
        }
        let mut ms = f64::MAX;
        for _ in 0..3 {
            let start = Instant::now();
            for f in 0..frames {
                renderer.render_frame(f).expect("a frame");
            }
            ms = ms.min(start.elapsed().as_secs_f64() * 1000.0 / f64::from(frames));
        }
        let name = Path::new(&path).file_stem().unwrap().to_string_lossy();
        println!("{name}: {ms:.2} ms/frame");
    }
}
