//! `Renderer.bench`: the Rust CLI's `bench` (the stages of one frame on a
//! warm renderer, or of successive frames with the layer cache on) plus the
//! handoff, which is what JavaScript pays per frame to give the addon a scene:
//! parsing and validating its JSON and swapping it into the renderer.
//!
//! The handoff is timed on the same JSON string every time, so file reads and
//! the like are the warm case; a scene that changes from frame to frame costs
//! about that plus whatever its changed layers cost to draw. `total` is the
//! frame as `render_frame` runs it, with no waits between steps and without
//! the handoff, so the cost of a frame from JSON string to pixels is
//! `handoff` plus `total`. There is no PNG encode: pixels stay in Rust.

use std::path::Path;
use std::time::Instant;

use kinetograph_cli::render::parse_range;
use kinetograph_core::{Renderer, Scene};

use crate::error::{Result, count, from_core, invalid};
use crate::{BenchFrame, BenchOptions, BenchResult, BenchStages, Stats};

/// Runs when `runs` is not given.
const DEFAULT_RUNS: u32 = 10;

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

fn stats(samples: &[f64]) -> Stats {
    Stats {
        mean: samples.iter().sum::<f64>() / samples.len() as f64,
        min: samples.iter().copied().fold(f64::INFINITY, f64::min),
        max: samples.iter().copied().fold(f64::NEG_INFINITY, f64::max),
    }
}

/// Parses `json` and gives it to the renderer; the time it took, in ms.
fn handoff(gpu: &mut Renderer, json: &str, base_dir: &Path) -> Result<f64> {
    let started = Instant::now();
    let scene = Scene::from_json(json, base_dir.to_path_buf()).map_err(from_core)?;
    gpu.set_scene(scene).map_err(from_core)?;
    Ok(ms(started))
}

/// The samples of the stages the renderer times itself.
#[derive(Default)]
struct Stages {
    handoff: Vec<f64>,
    resolve: Vec<f64>,
    raster: Vec<f64>,
    composite: Vec<f64>,
    readback: Vec<f64>,
    total: Vec<f64>,
}

impl Stages {
    fn finish(&self) -> BenchStages {
        BenchStages {
            handoff: stats(&self.handoff),
            resolve: stats(&self.resolve),
            raster: stats(&self.raster),
            composite: stats(&self.composite),
            readback: stats(&self.readback),
            total: stats(&self.total),
        }
    }
}

/// Times `json` on `gpu`. `layer_cache` is the setting to leave the renderer
/// with: the benchmark turns the cache off and on as the CLI's does.
pub fn bench(
    gpu: &mut Renderer,
    json: &str,
    options: &BenchOptions,
    base_dir: &Path,
    layer_cache: bool,
) -> Result<BenchResult> {
    // Every frame is drawn: reuse would time the comparison, not the frame.
    let reuse = gpu.frame_reuse();
    gpu.set_frame_reuse(false);
    let result = match &options.range {
        Some(range) => {
            if options.frame.is_some() || options.runs.is_some() {
                return Err(invalid(
                    "range replaces frame and runs: give one or the other",
                ));
            }
            bench_range(gpu, json, range, base_dir)
        }
        None => {
            let frame = options.frame.map_or(Ok(0), |f| count("frame", f))?;
            let runs = options
                .runs
                .map_or(Ok(DEFAULT_RUNS), |r| count("runs", r))?;
            if runs == 0 {
                return Err(invalid("runs must be at least 1"));
            }
            bench_frame(gpu, json, frame, runs, base_dir)
        }
    };
    gpu.set_layer_cache(layer_cache);
    gpu.set_frame_reuse(reuse);
    result
}

/// One frame, over and over, with the layer cache off (on, every run after
/// the first would only time the cache).
fn bench_frame(
    gpu: &mut Renderer,
    json: &str,
    frame: u32,
    runs: u32,
    base_dir: &Path,
) -> Result<BenchResult> {
    handoff(gpu, json, base_dir)?;
    gpu.set_layer_cache(false);
    // Warm-up: pipelines and the texture pool fill on the first frame, and
    // one render per timing path.
    gpu.render_timed(frame).map_err(from_core)?;
    gpu.render_frame(frame).map_err(from_core)?;

    let mut s = Stages::default();
    for _ in 0..runs {
        s.handoff.push(handoff(gpu, json, base_dir)?);
        // The stages: the GPU is waited on after every step.
        let (_, t) = gpu.render_timed(frame).map_err(from_core)?;
        s.resolve.push(t.resolve_ms);
        s.raster.push(t.raster_ms);
        s.composite.push(t.composite_ms);
        s.readback.push(t.readback_ms);
        // The whole frame, with no extra waits; its readback waits for the
        // GPU, so this is real latency.
        let started = Instant::now();
        gpu.render_frame(frame).map_err(from_core)?;
        s.total.push(ms(started));
    }
    Ok(BenchResult {
        frame: Some(frame),
        runs,
        stages: s.finish(),
        frames: None,
    })
}

/// The frames of `range` in order with the layer cache on, as `render` runs
/// them. Each is timed once, so what a frame costs includes what the cache
/// saved it from drawing. The range is rendered twice from an empty cache,
/// because the stage times wait for the GPU after every step and so cannot
/// also be the time of the whole frame: first the whole frames (with a
/// handoff before each, as a video of per-frame scenes has), then the stages.
fn bench_range(
    gpu: &mut Renderer,
    json: &str,
    range: &str,
    base_dir: &Path,
) -> Result<BenchResult> {
    let duration = Scene::from_json(json, base_dir.to_path_buf())
        .map_err(from_core)?
        .duration_in_frames;
    let (first, last) = parse_range(range, duration).map_err(invalid)?;
    handoff(gpu, json, base_dir)?;

    // Warm-up with the cache off, so the pipelines and the texture pool are
    // filled and the cache is not: its first frame is as cold as it gets.
    gpu.set_layer_cache(false);
    gpu.render_frame(first).map_err(from_core)?;
    gpu.set_layer_cache(true);

    let mut s = Stages::default();
    let mut frames = Vec::new();
    for frame in first..=last {
        s.handoff.push(handoff(gpu, json, base_dir)?);
        let (hits, misses) = gpu.layer_cache_counts();
        let started = Instant::now();
        gpu.render_frame(frame).map_err(from_core)?;
        let elapsed = ms(started);
        s.total.push(elapsed);
        let (now_hits, now_misses) = gpu.layer_cache_counts();
        frames.push(BenchFrame {
            frame,
            total_ms: elapsed,
            layers_reused: (now_hits - hits) as u32,
            layers_drawn: (now_misses - misses) as u32,
        });
    }

    // The same frames again, from an empty cache, for the stages.
    gpu.set_layer_cache(false);
    gpu.set_layer_cache(true);
    for frame in first..=last {
        let (_, t) = gpu.render_timed(frame).map_err(from_core)?;
        s.resolve.push(t.resolve_ms);
        s.raster.push(t.raster_ms);
        s.composite.push(t.composite_ms);
        s.readback.push(t.readback_ms);
    }
    Ok(BenchResult {
        frame: None,
        runs: last - first + 1,
        stages: s.finish(),
        frames: Some(frames),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats_are_the_mean_and_extremes() {
        let s = stats(&[3.0, 1.0, 2.0]);
        assert_eq!((s.mean, s.min, s.max), (2.0, 1.0, 3.0));
    }
}
