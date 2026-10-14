use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use clap::{Parser, Subcommand};
use kinetograph_core::{Scene, render_still};

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
}

fn main() -> ExitCode {
    let Cli { command } = Cli::parse();
    let Command::Still {
        scene,
        frame,
        output,
        json,
    } = command;
    match still(&scene, frame, &output) {
        Ok(result) => {
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "output": output,
                        "width": result.width,
                        "height": result.height,
                        "frame": frame,
                        "ms": result.ms,
                    })
                );
            } else {
                println!(
                    "wrote {} ({}x{}, frame {frame}, {:.1} ms)",
                    output.display(),
                    result.width,
                    result.height,
                    result.ms
                );
            }
            ExitCode::SUCCESS
        }
        Err(message) => {
            if json {
                println!("{}", serde_json::json!({ "error": message }));
            } else {
                eprintln!("error: {message}");
            }
            ExitCode::FAILURE
        }
    }
}

struct StillResult {
    width: u32,
    height: u32,
    /// Wall time for GPU setup, rendering and PNG encoding.
    ms: f64,
}

fn still(scene_path: &Path, frame: i64, output: &Path) -> Result<StillResult, String> {
    let scene = Scene::load(scene_path).map_err(|e| e.to_string())?;
    let frame = u32::try_from(frame)
        .map_err(|_| format!("frame {frame} is out of range: frames start at 0"))?;

    let started = Instant::now();
    let (width, height) = (scene.width, scene.height);
    let png = render_still(scene, frame)
        .and_then(|f| f.encode_png())
        .map_err(|e| e.to_string())?;
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    std::fs::write(output, png).map_err(|e| format!("cannot write {}: {e}", output.display()))?;
    Ok(StillResult { width, height, ms })
}
