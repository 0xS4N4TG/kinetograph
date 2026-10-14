//! The `render` command: a range of a scene's frames into a video file.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::Instant;

use kinetograph_core::{Frame, Renderer, Scene};

use crate::encode::{self, VideoEncoder};

/// How many finished frames may wait for the encoder. With two, the GPU
/// renders and reads back frame N+1 while frame N is being encoded, and
/// memory stays at a few frames however long the video is.
const FRAMES_IN_FLIGHT: usize = 2;

pub struct RenderRequest<'a> {
    pub scene: &'a Path,
    pub output: &'a Path,
    /// `a..b` or `a..=b`; the whole scene when `None`.
    pub range: Option<&'a str>,
    /// An ffmpeg encoder name; see `encode::select_encoder`.
    pub encoder: Option<&'a str>,
}

pub struct RenderSummary {
    pub output: PathBuf,
    pub encoder: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub frames: u32,
    pub first: u32,
    /// Inclusive.
    pub last: u32,
    /// Rendering and encoding the range, from the first frame asked for to
    /// the closed file; GPU setup is not in it.
    pub ms: f64,
    pub ms_per_frame: f64,
}

/// Renders the requested frames of a scene into `output`, calling `progress`
/// with (frames done, frames in all) after each one. A file that could not
/// be finished is removed.
pub fn render(
    request: &RenderRequest,
    mut progress: impl FnMut(u32, u32),
) -> Result<RenderSummary, String> {
    let scene = Scene::load(request.scene).map_err(|e| e.to_string())?;
    let (first, last) = match request.range {
        Some(range) => parse_range(range, scene.duration_in_frames)?,
        None => (0, scene.duration_in_frames - 1),
    };
    let frames = last - first + 1;
    let encoder_name = encode::select_encoder(
        request.encoder,
        cfg!(target_os = "macos"),
        encode::has_encoder,
    )?;
    let (width, height, fps) = (scene.width, scene.height, scene.fps);
    // Before the GPU is touched: a size or path the encoder cannot take.
    if !width.is_multiple_of(2) || !height.is_multiple_of(2) {
        return Err(format!(
            "the scene is {width}x{height}: yuv420p video needs an even width and height"
        ));
    }
    encode::container_for(request.output)?;
    encode::fps_rational(fps)?;

    let mut renderer = Renderer::new(scene).map_err(|e| e.to_string())?;
    // The frames come one after the other: a layer that did not change since
    // the last is not drawn again.
    renderer.set_layer_cache(true);
    let started = Instant::now();

    // The encoder lives on its own thread (ffmpeg's contexts cannot cross
    // threads) and says whether the file opened before any frame is made.
    let (frame_tx, frame_rx) = mpsc::sync_channel::<Frame>(FRAMES_IN_FLIGHT);
    let (open_tx, open_rx) = mpsc::sync_channel::<Result<(), String>>(1);
    let output = request.output.to_path_buf();
    let name = encoder_name.clone();
    let encoder_thread = thread::spawn(move || -> Result<u32, String> {
        let mut encoder = match VideoEncoder::create(&output, width, height, fps, &name) {
            Ok(encoder) => {
                let _ = open_tx.send(Ok(()));
                encoder
            }
            Err(e) => {
                let _ = open_tx.send(Err(e.clone()));
                return Err(e);
            }
        };
        for frame in frame_rx {
            encoder.push(&frame.rgba)?;
        }
        encoder.finish()
    });
    if let Err(e) = open_rx
        .recv()
        .unwrap_or_else(|_| Err("the encoder thread died".into()))
    {
        let _ = encoder_thread.join();
        let _ = std::fs::remove_file(request.output);
        return Err(e);
    }

    // Each frame is started before the last one is collected, so the GPU
    // draws one while the next is recorded.
    let mut failure = None;
    let mut done = 0;
    let mut in_flight = None;
    for frame in (first..=last).map(Some).chain([None]) {
        let started = match frame.map(|frame| (frame, renderer.start_frame(frame))) {
            Some((frame, Err(e))) => {
                failure = Some(format!("frame {frame}: {e}"));
                break;
            }
            Some((frame, Ok(pending))) => Some((frame, pending)),
            None => None,
        };
        if let Some((frame, pending)) = std::mem::replace(&mut in_flight, started) {
            match renderer.finish_frame(pending) {
                // The encoder has stopped; its error is reported below.
                Ok(rendered) => {
                    if frame_tx.send(rendered).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    failure = Some(format!("frame {frame}: {e}"));
                    break;
                }
            }
            done += 1;
            progress(done, frames);
        }
    }
    drop(frame_tx);
    let encoded = encoder_thread
        .join()
        .unwrap_or_else(|_| Err("the encoder thread panicked".into()));
    // A render failure is the root cause of an encoder that then saw no more
    // frames; an encoder failure is reported when it is the only one.
    let written = match (failure, encoded) {
        (Some(e), _) | (None, Err(e)) => {
            let _ = std::fs::remove_file(request.output);
            return Err(e);
        }
        (None, Ok(written)) => written,
    };
    if written != frames {
        let _ = std::fs::remove_file(request.output);
        return Err(format!("wrote {written} of {frames} frames"));
    }

    let ms = started.elapsed().as_secs_f64() * 1000.0;
    Ok(RenderSummary {
        output: request.output.to_path_buf(),
        encoder: encoder_name,
        width,
        height,
        fps,
        frames,
        first,
        last,
        ms,
        ms_per_frame: ms / f64::from(frames),
    })
}

/// Reads `--range`: `a..b` (frames a up to but not including b) or `a..=b`
/// (a through b). `a` may be left out (start of the scene) and, in the
/// exclusive form, `b` too (end of it). Returns the first and last frame,
/// both inside `0..duration`.
pub fn parse_range(range: &str, duration: u32) -> Result<(u32, u32), String> {
    let (start, end, inclusive) = if let Some((a, b)) = range.split_once("..=") {
        (a, b, true)
    } else if let Some((a, b)) = range.split_once("..") {
        (a, b, false)
    } else {
        return Err(format!(
            "range {range:?} should look like 10..40 (frames 10 to 39) or 10..=40 (10 to 40)"
        ));
    };
    let number = |text: &str| {
        text.trim()
            .parse::<u32>()
            .map_err(|_| format!("range {range:?}: {text:?} is not a frame number"))
    };
    let first = if start.trim().is_empty() {
        0
    } else {
        number(start)?
    };
    let last = match (end.trim().is_empty(), inclusive) {
        (true, true) => return Err(format!("range {range:?} needs a last frame after ..=")),
        (true, false) => duration.checked_sub(1),
        (false, true) => Some(number(end)?),
        // The end is not part of it; 0 leaves nothing.
        (false, false) => number(end)?.checked_sub(1),
    };
    match last {
        Some(last) if first <= last => {
            if last >= duration {
                Err(format!(
                    "range {range:?} runs past the scene, which has frames 0 to {} ({duration} in all)",
                    duration - 1
                ))
            } else {
                Ok((first, last))
            }
        }
        _ => Err(format!("range {range:?} has no frames")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclusive_ranges_stop_before_the_end() {
        assert_eq!(parse_range("10..40", 90), Ok((10, 39)));
        assert_eq!(parse_range("0..90", 90), Ok((0, 89)));
        assert_eq!(parse_range("5..6", 90), Ok((5, 5)));
    }

    #[test]
    fn inclusive_ranges_include_the_end() {
        assert_eq!(parse_range("10..=40", 90), Ok((10, 40)));
        assert_eq!(parse_range("89..=89", 90), Ok((89, 89)));
    }

    #[test]
    fn a_missing_start_or_exclusive_end_is_the_scene_edge() {
        assert_eq!(parse_range("..30", 90), Ok((0, 29)));
        assert_eq!(parse_range("60..", 90), Ok((60, 89)));
        assert_eq!(parse_range("..", 90), Ok((0, 89)));
        assert_eq!(parse_range("..=30", 90), Ok((0, 30)));
        assert!(parse_range("5..=", 90).is_err());
    }

    #[test]
    fn bad_ranges_say_what_is_wrong() {
        let cases = [
            ("10", "should look like"),
            ("a..5", "not a frame number"),
            ("-1..5", "not a frame number"),
            ("1.5..4", "not a frame number"),
            ("5..5", "no frames"),
            ("0..0", "no frames"),
            ("9..3", "no frames"),
            ("90..", "no frames"),
            ("80..91", "runs past the scene"),
            ("0..=90", "runs past the scene"),
        ];
        for (range, want) in cases {
            let msg = parse_range(range, 90).unwrap_err();
            assert!(msg.contains(want) && msg.contains(range), "{range}: {msg}");
        }
    }
}
