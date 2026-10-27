//! `kinetograph track` without Node, for the Blender parity harness (scripts/track-parity/):
//!
//! cargo run --release -p kinetograph-track --example track -- VIDEO X,Y [X,Y ...] [--model M] [--pattern N]
//!     [--search N] [--match keyframe|previous] [--backwards] [--from F] [--to F] [--min-correlation C]
//!
//! Prints the track file's JSON.

use kinetograph_track::{Match, MotionModel, Options, Point, track_video};

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut options = Options::default();
    let (mut first, mut last, mut backwards) = (None, None, false);
    let mut points = Vec::new();
    let mut video = None;
    let mut i = 0;
    let value = |i: usize| {
        args.get(i + 1)
            .cloned()
            .ok_or_else(|| format!("{} needs a value", args[i]))
    };
    let number = |s: String| s.parse::<u32>().map_err(|e| format!("{s}: {e}"));
    while i < args.len() {
        match args[i].as_str() {
            "--model" => options.model = MotionModel::parse(&value(i)?)?,
            "--pattern" => options.pattern_size = number(value(i)?)?,
            "--search" => options.search_size = number(value(i)?)?,
            "--match" => options.matching = Match::parse(&value(i)?)?,
            "--min-correlation" => {
                options.min_correlation = value(i)?.parse().map_err(|e| format!("{e}"))?
            }
            "--from" => first = Some(number(value(i)?)?),
            "--to" => last = Some(number(value(i)?)?),
            "--backwards" => {
                backwards = true;
                i += 1;
                continue;
            }
            a if video.is_none() => {
                video = Some(a.to_string());
                i += 1;
                continue;
            }
            a => {
                let (x, y) = a.split_once(',').ok_or_else(|| format!("{a}: not X,Y"))?;
                let f = |s: &str| s.parse::<f64>().map_err(|e| format!("{s}: {e}"));
                points.push(Point {
                    name: format!("p{}", points.len() + 1),
                    x: f(x)?,
                    y: f(y)?,
                });
                i += 1;
                continue;
            }
        }
        i += 2;
    }
    let video = video.ok_or("usage: track VIDEO X,Y [X,Y ...] [options]")?;
    let file = track_video(video.as_ref(), &points, &options, first, last, backwards)?;
    println!("{}", file.to_json());
    Ok(())
}
