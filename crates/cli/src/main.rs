use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use clap::{Parser, Subcommand};
use kinetograph_cli::render::{RenderRequest, parse_range, render};
use kinetograph_core::{Renderer, Scene, render_still};
use serde_json::{Value, json};

#[derive(Parser)]
#[command(
    name = "kinetograph",
    version,
    about = "Render scenes from the Kinetograph engine"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Render one frame of a scene to a PNG
    Still {
        /// Scene JSON file (see docs/SCENE.md)
        scene: PathBuf,
        /// Frame number, 0-based
        #[arg(allow_negative_numbers = true)]
        frame: i64,
        /// Output PNG path
        #[arg(short, long)]
        output: PathBuf,
        /// Print the result as JSON: {output, width, height, frame, ms}
        #[arg(long)]
        json: bool,
    },
    /// Render frames of a scene to an H.264 video (.mp4 or .mov)
    Render {
        /// Scene JSON file (see docs/SCENE.md)
        scene: PathBuf,
        /// Output video path; the extension picks the container
        #[arg(short, long)]
        output: PathBuf,
        /// Frames to render: 10..40 (10 to 39) or 10..=40 (10 to 40); the
        /// whole scene if left out
        #[arg(long)]
        range: Option<String>,
        /// ffmpeg encoder name; default h264_videotoolbox on macOS when
        /// ffmpeg has it, else libx264
        #[arg(long)]
        encoder: Option<String>,
        /// Print the result as JSON: {output, encoder, width, height, fps,
        /// frames, first, last, ms, ms_per_frame, repeated}
        #[arg(long)]
        json: bool,
    },
    /// Time the render stages of one frame on a warm renderer, or of
    /// successive frames with the layer cache on
    Bench {
        /// Scene JSON file (see docs/SCENE.md)
        scene: PathBuf,
        /// Frame number, 0-based. It is rendered over and over, so the layer
        /// cache is off (on, only the cache would be timed)
        #[arg(long, default_value_t = 0, allow_negative_numbers = true)]
        frame: i64,
        /// Timed runs after two warm-up renders (one per timing path)
        #[arg(long, default_value_t = 10)]
        runs: u32,
        /// Frames to time instead, in order and with the layer cache on, as
        /// `render` runs them: 10..40 (10 to 39) or 10..=40 (10 to 40).
        /// Replaces `--frame` and `--runs`: the range is rendered twice from
        /// an empty cache, once for each frame's whole time and once for
        /// its stages
        #[arg(long, conflicts_with_all = ["frame", "runs"])]
        range: Option<String>,
        /// Also time each compositing pass on the GPU, in one more round of
        /// the same frames, and print the passes grouped by kind
        #[arg(long)]
        passes: bool,
        /// Print the result as JSON
        #[arg(long)]
        json: bool,
    },
}

/// What a command prints: a line or table for people, or JSON for agents.
struct Output {
    text: String,
    json: Value,
}

fn main() -> ExitCode {
    let (as_json, result) = match Cli::parse().command {
        Command::Still {
            scene,
            frame,
            output,
            json,
        } => (json, still(&scene, frame, &output)),
        Command::Render {
            scene,
            output,
            range,
            encoder,
            json,
        } => (
            json,
            render_video(&scene, &output, range.as_deref(), encoder.as_deref(), json),
        ),
        Command::Bench {
            scene,
            frame,
            runs,
            range,
            passes,
            json,
        } => (
            json,
            match range {
                Some(range) => bench_range(&scene, &range, passes),
                None => bench(&scene, frame, runs, passes),
            },
        ),
    };
    match result {
        Ok(out) => {
            println!(
                "{}",
                if as_json {
                    out.json.to_string()
                } else {
                    out.text
                }
            );
            ExitCode::SUCCESS
        }
        Err(message) => {
            if as_json {
                println!("{}", json!({ "error": message }));
            } else {
                eprintln!("error: {message}");
            }
            ExitCode::FAILURE
        }
    }
}

fn parse_frame(frame: i64) -> Result<u32, String> {
    u32::try_from(frame).map_err(|_| format!("frame {frame} is out of range: frames start at 0"))
}

fn still(scene_path: &Path, frame: i64, output: &Path) -> Result<Output, String> {
    let scene = Scene::load(scene_path).map_err(|e| e.to_string())?;
    let frame = parse_frame(frame)?;

    let started = Instant::now();
    let (width, height) = (scene.width, scene.height);
    let png = render_still(scene, frame)
        .and_then(|f| f.encode_png())
        .map_err(|e| e.to_string())?;
    // Wall time for GPU setup, rendering and PNG encoding.
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    std::fs::write(output, png).map_err(|e| format!("cannot write {}: {e}", output.display()))?;
    Ok(Output {
        text: format!(
            "wrote {} ({width}x{height}, frame {frame}, {ms:.1} ms)",
            output.display()
        ),
        json: json!({
            "output": output,
            "width": width,
            "height": height,
            "frame": frame,
            "ms": ms,
        }),
    })
}

fn render_video(
    scene: &Path,
    output: &Path,
    range: Option<&str>,
    encoder: Option<&str>,
    as_json: bool,
) -> Result<Output, String> {
    // Progress goes to stderr and not at all for JSON, whose caller is a
    // program. A terminal gets one line rewritten in place; anything else
    // (a log) gets a line about every tenth of the way.
    let tty = std::io::stderr().is_terminal();
    let mut next_line = 0;
    let summary = render(
        &RenderRequest {
            scene,
            output,
            range,
            encoder,
        },
        |done, total| {
            if as_json {
                return;
            }
            if tty {
                eprint!("\rrendering frame {done}/{total}");
                let _ = std::io::stderr().flush();
            } else if done * 10 >= next_line * total {
                eprintln!("rendering frame {done}/{total}");
                next_line = done * 10 / total + 1;
            }
        },
    );
    if tty && !as_json {
        eprintln!();
    }
    let s = summary?;
    Ok(Output {
        text: format!(
            "wrote {} ({}x{}, {} frames{} {}..={} at {} fps, {}, {:.1} ms, {:.2} ms/frame)",
            s.output.display(),
            s.width,
            s.height,
            s.frames,
            if s.repeated > 0 {
                format!(
                    " ({} the same as the frame before, not drawn again)",
                    s.repeated
                )
            } else {
                String::new()
            },
            s.first,
            s.last,
            s.fps,
            s.encoder,
            s.ms,
            s.ms_per_frame
        ),
        json: json!({
            "output": s.output,
            "encoder": s.encoder,
            "width": s.width,
            "height": s.height,
            "fps": s.fps,
            "frames": s.frames,
            "first": s.first,
            "last": s.last,
            "ms": s.ms,
            "ms_per_frame": s.ms_per_frame,
            "repeated": s.repeated,
        }),
    })
}

/// Mean, min and max of a stage's samples, in milliseconds.
struct Stats {
    mean: f64,
    min: f64,
    max: f64,
}

impl Stats {
    fn of(samples: &[f64]) -> Stats {
        Stats {
            mean: samples.iter().sum::<f64>() / samples.len() as f64,
            min: samples.iter().copied().fold(f64::INFINITY, f64::min),
            max: samples.iter().copied().fold(f64::NEG_INFINITY, f64::max),
        }
    }
}

fn bench(scene_path: &Path, frame: i64, runs: u32, passes: bool) -> Result<Output, String> {
    if runs == 0 {
        return Err("--runs must be at least 1".into());
    }
    let scene = Scene::load(scene_path).map_err(|e| e.to_string())?;
    let frame = parse_frame(frame)?;
    let (width, height) = (scene.width, scene.height);
    let err = |e: kinetograph_core::Error| e.to_string();

    // GPU setup, shader compilation and font loading: paid once per process.
    let started = Instant::now();
    let mut renderer = Renderer::new(scene).map_err(err)?;
    let setup_ms = started.elapsed().as_secs_f64() * 1000.0;
    // The same frame is rendered over and over, so the layer cache stays off
    // (a new renderer has it off): on, every run after the first would only
    // time the cache.

    // Warm-up: pipelines and the texture pool fill on the first frame.
    let (warm, _) = renderer.render_timed(frame).map_err(err)?;
    warm.encode_png().map_err(err)?;
    renderer.render_frame(frame).map_err(err)?;

    let mut resolve = Vec::new();
    let mut raster = Vec::new();
    let mut composite = Vec::new();
    let mut readback = Vec::new();
    let mut png = Vec::new();
    let mut total = Vec::new();
    let ms = |t: Instant| t.elapsed().as_secs_f64() * 1000.0;
    for _ in 0..runs {
        // Stage breakdown: the GPU is waited on after every step.
        let (rendered, t) = renderer.render_timed(frame).map_err(err)?;
        resolve.push(t.resolve_ms);
        raster.push(t.raster_ms);
        composite.push(t.composite_ms);
        readback.push(t.readback_ms);
        let started = Instant::now();
        rendered.encode_png().map_err(err)?;
        png.push(ms(started));

        // Whole frame as `render_frame` runs it, with no extra waits. The
        // readback at its end waits for the GPU, so this is real latency.
        let started = Instant::now();
        let rendered = renderer.render_frame(frame).map_err(err)?;
        rendered.encode_png().map_err(err)?;
        total.push(ms(started));
    }

    let stages = [
        ("resolve", Stats::of(&resolve)),
        ("raster", Stats::of(&raster)),
        ("composite", Stats::of(&composite)),
        ("readback", Stats::of(&readback)),
        ("png encode", Stats::of(&png)),
        ("total", Stats::of(&total)),
    ];
    let mut text = format!(
        "{}  {width}x{height}  frame {frame}  {runs} runs after 2 warm-up renders, layer cache off\n\
         setup (GPU, shaders, fonts; once per process): {setup_ms:.1} ms\n\n",
        scene_path.display(),
    );
    text.push_str(&stage_table(&stages));
    let mut json = json!({
        "scene": scene_path,
        "width": width,
        "height": height,
        "frame": frame,
        "runs": runs,
        "layer_cache": false,
        "setup_ms": setup_ms,
        "stages_ms": stages_json(&stages),
    });
    if passes {
        let frames = (0..runs).map(|_| frame).collect::<Vec<_>>();
        let (table, value) = time_passes(&mut renderer, &frames)?;
        text.push_str(&table);
        json["passes"] = value;
    }
    Ok(Output { text, json })
}

/// Renders `frames` in order with the pass timer on and groups the passes
/// by kind: a table, and the same as JSON.
fn time_passes(renderer: &mut Renderer, frames: &[u32]) -> Result<(String, Value), String> {
    if !renderer.set_pass_timing(true) {
        return Err("--passes: this GPU cannot time passes (no TIMESTAMP_QUERY)".into());
    }
    // (passes, ms, texels) by kind, over all the frames.
    let mut kinds: Vec<(&'static str, u64, f64, u64)> = Vec::new();
    let mut per_frame = Vec::new();
    for &frame in frames {
        renderer.render_frame(frame).map_err(|e| e.to_string())?;
        let times = renderer.take_pass_times();
        per_frame.push((times.len(), times.iter().map(|t| t.ms).sum::<f64>()));
        for t in times {
            match kinds.iter_mut().find(|k| k.0 == t.name) {
                Some(k) => {
                    k.1 += 1;
                    k.2 += t.ms;
                    k.3 += t.texels;
                }
                None => kinds.push((t.name, 1, t.ms, t.texels)),
            }
        }
    }
    renderer.set_pass_timing(false);
    kinds.sort_by(|a, b| b.2.total_cmp(&a.2));

    let n = frames.len().max(1) as f64;
    let passes_mean = per_frame.iter().map(|p| p.0 as f64).sum::<f64>() / n;
    let gpu_mean = per_frame.iter().map(|p| p.1).sum::<f64>() / n;
    let mut text = format!(
        "\n\npasses, per frame over {} frames: {passes_mean:.0} passes, {gpu_mean:.3} ms of GPU time\n\
         {:<20}{:>9}{:>11}{:>10}{:>14}\n",
        frames.len(),
        "kind",
        "passes",
        "ms",
        "us/pass",
        "Mtexels"
    );
    let mut rows = Vec::new();
    for (name, count, ms, texels) in &kinds {
        let us = ms * 1000.0 / *count as f64;
        let (count, ms, mtexels) = (*count as f64 / n, ms / n, *texels as f64 / n / 1e6);
        text.push_str(&format!(
            "{name:<20}{count:>9.1}{ms:>11.3}{us:>10.1}{mtexels:>14.1}\n"
        ));
        rows.push(json!({
            "kind": name,
            "passes_per_frame": count,
            "ms_per_frame": ms,
            "us_per_pass": us,
            "mtexels_per_frame": mtexels,
        }));
    }
    text.push_str(
        "\nEach pass is timed from its start to its end on the GPU; passes can overlap,\n\
         so their sum can differ from the frame's time. Mtexels is the size of the\n\
         textures drawn into. Skia's drawing and texture copies are not timed.",
    );
    let value = json!({
        "frames": frames.len(),
        "passes_per_frame": passes_mean,
        "gpu_ms_per_frame": gpu_mean,
        "kinds": rows,
    });
    Ok((text, value))
}

/// The stages' mean, min and max as a table, with the note on what the waits
/// do to them.
fn stage_table(stages: &[(&str, Stats)]) -> String {
    let mut text = format!(
        "{:<11}{:>10}{:>10}{:>10}\n",
        "stage (ms)", "mean", "min", "max"
    );
    for (name, s) in stages {
        text.push_str(&format!(
            "{name:<11}{:>10.3}{:>10.3}{:>10.3}\n",
            s.mean, s.min, s.max
        ));
    }
    text.push_str(
        "\nStages wait for the GPU after every step, so they add up to more than\n\
         total, which is the whole frame without those waits.",
    );
    text
}

fn stages_json(stages: &[(&str, Stats)]) -> serde_json::Map<String, Value> {
    stages
        .iter()
        .map(|(name, s)| {
            let key = name.replace(' ', "_");
            (key, json!({ "mean": s.mean, "min": s.min, "max": s.max }))
        })
        .collect()
}

/// `bench --range`: the frames of the range, in order, on one renderer with
/// the layer cache on, as `render` runs them. Each frame is timed once, so
/// what a frame costs includes what the cache saved it from drawing, which
/// depends on the frames before it. The range is rendered twice, each time
/// from an empty cache, because the stage times wait for the GPU after every
/// step and so cannot also be the time of the whole frame: first the whole
/// frames, then the stages.
fn bench_range(scene_path: &Path, range: &str, passes: bool) -> Result<Output, String> {
    let scene = Scene::load(scene_path).map_err(|e| e.to_string())?;
    let (first, last) = parse_range(range, scene.duration_in_frames)?;
    let (width, height) = (scene.width, scene.height);
    let err = |e: kinetograph_core::Error| e.to_string();

    let started = Instant::now();
    let mut renderer = Renderer::new(scene).map_err(err)?;
    let setup_ms = started.elapsed().as_secs_f64() * 1000.0;

    // Warm-up with the cache off (a new renderer has it so), so the pipelines
    // and the texture pool are filled and the cache is not: its first frame
    // is as cold as it gets.
    renderer.render_frame(first).map_err(err)?;
    renderer.set_layer_cache(true);

    let ms = |t: Instant| t.elapsed().as_secs_f64() * 1000.0;
    // (frame, ms, layers drawn from the cache, layers drawn)
    let mut per_frame = Vec::new();
    let mut total = Vec::new();
    for frame in first..=last {
        let (hits, misses) = renderer.layer_cache_counts();
        let started = Instant::now();
        let rendered = renderer.render_frame(frame).map_err(err)?;
        rendered.encode_png().map_err(err)?;
        let elapsed = ms(started);
        total.push(elapsed);
        let (now_hits, now_misses) = renderer.layer_cache_counts();
        per_frame.push((frame, elapsed, now_hits - hits, now_misses - misses));
    }

    // The same frames again, from an empty cache, for the stages.
    renderer.set_layer_cache(false);
    renderer.set_layer_cache(true);
    let mut resolve = Vec::new();
    let mut raster = Vec::new();
    let mut composite = Vec::new();
    let mut readback = Vec::new();
    let mut png = Vec::new();
    for frame in first..=last {
        let (rendered, t) = renderer.render_timed(frame).map_err(err)?;
        resolve.push(t.resolve_ms);
        raster.push(t.raster_ms);
        composite.push(t.composite_ms);
        readback.push(t.readback_ms);
        let started = Instant::now();
        rendered.encode_png().map_err(err)?;
        png.push(ms(started));
    }

    let stages = [
        ("resolve", Stats::of(&resolve)),
        ("raster", Stats::of(&raster)),
        ("composite", Stats::of(&composite)),
        ("readback", Stats::of(&readback)),
        ("png encode", Stats::of(&png)),
        ("total", Stats::of(&total)),
    ];
    let frames = last - first + 1;
    let mut text = format!(
        "{}  {width}x{height}  frames {first}..={last} ({frames}), in order, layer cache on\n\
         setup (GPU, shaders, fonts; once per process): {setup_ms:.1} ms\n\n\
         {:<7}{:>12}{:>9}{:>9}\n",
        scene_path.display(),
        "frame",
        "total (ms)",
        "reused",
        "drawn"
    );
    for (frame, elapsed, reused, drawn) in &per_frame {
        text.push_str(&format!("{frame:<7}{elapsed:>12.3}{reused:>9}{drawn:>9}\n"));
    }
    text.push('\n');
    text.push_str(&stage_table(&stages));
    text.push_str(
        "\n\"reused\" and \"drawn\" count the layers blended from the cache and those drawn\n\
         (and kept) in the whole-frame pass; the stage rows are a second pass from an empty cache.",
    );
    let frames_json: Vec<Value> = per_frame
        .iter()
        .map(|(frame, elapsed, reused, drawn)| {
            json!({ "frame": frame, "total_ms": elapsed, "layers_reused": reused, "layers_drawn": drawn })
        })
        .collect();
    let mut json = json!({
        "scene": scene_path,
        "width": width,
        "height": height,
        "first": first,
        "last": last,
        "frames": frames,
        "layer_cache": true,
        "setup_ms": setup_ms,
        "stages_ms": stages_json(&stages),
        "per_frame": frames_json,
    });
    if passes {
        // Once more from an empty cache, as `render` runs the range.
        renderer.set_layer_cache(false);
        renderer.set_layer_cache(true);
        let (table, value) = time_passes(&mut renderer, &(first..=last).collect::<Vec<_>>())?;
        text.push_str(&table);
        json["passes"] = value;
    }
    Ok(Output { text, json })
}
