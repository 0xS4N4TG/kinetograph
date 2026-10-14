use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use clap::{Parser, Subcommand};
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
    /// Time the render stages of one frame on a warm renderer
    Bench {
        /// Scene JSON file (see docs/SCENE.md)
        scene: PathBuf,
        /// Frame number, 0-based
        #[arg(long, default_value_t = 0, allow_negative_numbers = true)]
        frame: i64,
        /// Timed runs after two warm-up renders (one per timing path)
        #[arg(long, default_value_t = 10)]
        runs: u32,
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
        Command::Bench {
            scene,
            frame,
            runs,
            json,
        } => (json, bench(&scene, frame, runs)),
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

fn bench(scene_path: &Path, frame: i64, runs: u32) -> Result<Output, String> {
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

    // Warm-up: pipelines, texture pool and caches fill on the first frame.
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
        "{}  {width}x{height}  frame {frame}  {runs} runs after 2 warm-up renders\n\
         setup (GPU, shaders, fonts; once per process): {setup_ms:.1} ms\n\n\
         {:<11}{:>10}{:>10}{:>10}\n",
        scene_path.display(),
        "stage (ms)",
        "mean",
        "min",
        "max"
    );
    for (name, s) in &stages {
        text.push_str(&format!(
            "{name:<11}{:>10.3}{:>10.3}{:>10.3}\n",
            s.mean, s.min, s.max
        ));
    }
    text.push_str(
        "\nStages wait for the GPU after every step, so they add up to more than\n\
         total, which is the whole frame without those waits.",
    );
    let stages_json: serde_json::Map<String, Value> = stages
        .iter()
        .map(|(name, s)| {
            let key = name.replace(' ', "_");
            (key, json!({ "mean": s.mean, "min": s.min, "max": s.max }))
        })
        .collect();
    Ok(Output {
        text,
        json: json!({
            "scene": scene_path,
            "width": width,
            "height": height,
            "frame": frame,
            "runs": runs,
            "setup_ms": setup_ms,
            "stages_ms": stages_json,
        }),
    })
}
