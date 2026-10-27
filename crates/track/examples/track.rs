//! `kinetograph track` without Node, for the Blender parity harness (scripts/track-parity/):
//!
//! cargo run --release -p kinetograph-track --example track -- VIDEO [X,Y ...] [--model M] [--pattern N]
//!     [--search N] [--match keyframe|previous] [--backwards] [--from F] [--to F] [--min-correlation C]
//!     [--detect] [--detect-margin N] [--detect-threshold T] [--detect-distance N]
//!     [--detect-inside X,Y,X,Y,...] [--detect-outside X,Y,X,Y,...]
//!     [--plane [NAME=]all|P1,P2,...] [--plane-corners [NAME=]X,Y,X,Y,X,Y,X,Y]
//!
//! Prints the track file's JSON.

use kinetograph_track::{
    DetectOptions, Job, Match, MotionModel, Placement, PlaneRequest, Point, track_video,
};

fn numbers(s: &str) -> Result<Vec<f64>, String> {
    s.split(',')
        .map(|v| v.trim().parse::<f64>().map_err(|e| format!("{v}: {e}")))
        .collect()
}

fn named(s: &str) -> (Option<&str>, &str) {
    match s.split_once('=') {
        Some((name, rest)) => (Some(name), rest),
        None => (None, s),
    }
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut job = Job::default();
    let mut detect: Option<DetectOptions> = None;
    let (mut inside, mut outside) = (Vec::new(), Vec::new());
    let mut corners: Vec<(Option<String>, [[f64; 2]; 4])> = Vec::new();
    let mut video = None;
    let mut i = 0;
    let value = |i: usize| {
        args.get(i + 1)
            .cloned()
            .ok_or_else(|| format!("{} needs a value", args[i]))
    };
    let number = |s: String| s.parse::<u32>().map_err(|e| format!("{s}: {e}"));
    let polygon = |s: String| -> Result<Vec<[f64; 2]>, String> {
        Ok(numbers(&s)?.as_chunks::<2>().0.to_vec())
    };
    while i < args.len() {
        let options = &mut job.options;
        match args[i].as_str() {
            "--model" => options.model = MotionModel::parse(&value(i)?)?,
            "--pattern" => options.pattern_size = number(value(i)?)?,
            "--search" => options.search_size = number(value(i)?)?,
            "--match" => options.matching = Match::parse(&value(i)?)?,
            "--min-correlation" => {
                options.min_correlation = value(i)?.parse().map_err(|e| format!("{e}"))?
            }
            "--margin" => options.margin = number(value(i)?)?,
            "--from" => job.first = Some(number(value(i)?)?),
            "--to" => job.last = Some(number(value(i)?)?),
            "--detect-margin" => {
                detect.get_or_insert_with(Default::default).margin = number(value(i)?)?
            }
            "--detect-threshold" => {
                detect.get_or_insert_with(Default::default).threshold =
                    value(i)?.parse().map_err(|e| format!("{e}"))?
            }
            "--detect-distance" => {
                detect.get_or_insert_with(Default::default).min_distance = number(value(i)?)?
            }
            "--detect-inside" => inside.push(polygon(value(i)?)?),
            "--detect-outside" => outside.push(polygon(value(i)?)?),
            "--plane" => {
                let v = value(i)?;
                let (name, list) = named(&v);
                job.planes.push(PlaneRequest {
                    name: name
                        .map_or_else(|| format!("plane{}", job.planes.len() + 1), String::from),
                    tracks: if list == "all" {
                        Vec::new()
                    } else {
                        list.split(',').map(String::from).collect()
                    },
                    corners: None,
                });
            }
            "--plane-corners" => {
                let v = value(i)?;
                let (name, list) = named(&v);
                let n = numbers(list)?;
                if n.len() != 8 {
                    return Err(format!("--plane-corners takes 8 numbers, got {}", n.len()));
                }
                corners.push((
                    name.map(String::from),
                    [[n[0], n[1]], [n[2], n[3]], [n[4], n[5]], [n[6], n[7]]],
                ));
            }
            flag @ ("--backwards" | "--detect") => {
                if flag == "--backwards" {
                    job.backwards = true;
                } else {
                    detect.get_or_insert_with(Default::default);
                }
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
                job.points.push(Point {
                    name: format!("p{}", job.points.len() + 1),
                    x: f(x)?,
                    y: f(y)?,
                });
                i += 1;
                continue;
            }
        }
        i += 2;
    }
    if let Some(d) = &mut detect {
        if !inside.is_empty() {
            d.placement = Placement::Inside(inside);
        } else if !outside.is_empty() {
            d.placement = Placement::Outside(outside);
        }
    }
    job.detect = detect;
    for (name, c) in corners {
        let plane = match &name {
            Some(n) => job.planes.iter_mut().find(|p| &p.name == n),
            None => job.planes.first_mut(),
        }
        .ok_or("--plane-corners names no --plane")?;
        plane.corners = Some(c);
    }
    let video = video.ok_or("usage: track VIDEO [X,Y ...] [options]")?;
    let file = track_video(video.as_ref(), &job)?;
    println!("{}", file.to_json());
    Ok(())
}
