//! The `render` command: a range of a scene's frames into a video file.
//!
//! `render` is the command's own entry (a scene file, a new renderer);
//! `render_scene` drives a renderer that already exists with a `Scene`; and
//! `VideoWriter` is for a video whose scene changes from frame to frame. All
//! three keep the same pipeline: the GPU draws frame N+1 while frame N is
//! read back, and an encoder thread takes at most `FRAMES_IN_FLIGHT` finished
//! frames.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::Instant;

use kinetograph_core::{Frame, PendingFrame, Renderer, Scene};

use crate::encode::{self, AudioPcm, VideoEncoder};

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

/// `RenderRequest` for a scene already in memory, with audio.
pub struct SceneRequest<'a> {
    pub output: &'a Path,
    pub range: Option<&'a str>,
    pub encoder: Option<&'a str>,
    /// Muxed as AAC, starting with the first frame.
    pub audio: Option<AudioPcm<'a>>,
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
    pub audio: bool,
}

/// Why a render stopped. The kinds are what the Node addon reports as
/// different error codes.
#[derive(Debug)]
pub enum RenderError {
    /// What was asked for cannot be done: a range, an encoder or container,
    /// an odd size, frames out of order, audio AAC cannot take.
    Invalid(String),
    /// The scene could not be loaded or the renderer set up.
    Core(kinetograph_core::Error),
    /// Drawing one frame failed.
    Frame(u32, kinetograph_core::Error),
    /// ffmpeg failed, or the output could not be written.
    Encode(String),
}

impl fmt::Display for RenderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RenderError::Invalid(msg) | RenderError::Encode(msg) => f.write_str(msg),
            RenderError::Core(e) => write!(f, "{e}"),
            RenderError::Frame(frame, e) => write!(f, "frame {frame}: {e}"),
        }
    }
}

impl std::error::Error for RenderError {}

impl From<kinetograph_core::Error> for RenderError {
    fn from(e: kinetograph_core::Error) -> Self {
        RenderError::Core(e)
    }
}

impl RenderError {
    /// The renderer's error underneath, if there is one.
    pub fn core(&self) -> Option<&kinetograph_core::Error> {
        match self {
            RenderError::Core(e) | RenderError::Frame(_, e) => Some(e),
            _ => None,
        }
    }
}

/// What a request comes to once checked against the scene, before the GPU is
/// touched.
struct Plan {
    first: u32,
    last: u32,
    frames: u32,
    encoder: String,
    width: u32,
    height: u32,
    fps: f64,
}

fn plan(
    scene: &Scene,
    output: &Path,
    range: Option<&str>,
    encoder: Option<&str>,
) -> Result<Plan, RenderError> {
    let (first, last) = match range {
        Some(range) => {
            parse_range(range, scene.duration_in_frames).map_err(RenderError::Invalid)?
        }
        None => (0, scene.duration_in_frames - 1),
    };
    let encoder = encode::select_encoder(encoder, cfg!(target_os = "macos"), encode::has_encoder)
        .map_err(RenderError::Invalid)?;
    check_video(scene.width, scene.height, scene.fps, output)?;
    Ok(Plan {
        first,
        last,
        frames: last - first + 1,
        encoder,
        width: scene.width,
        height: scene.height,
        fps: scene.fps,
    })
}

/// A size, rate or path the encoder cannot take.
fn check_video(width: u32, height: u32, fps: f64, output: &Path) -> Result<(), RenderError> {
    if !width.is_multiple_of(2) || !height.is_multiple_of(2) {
        return Err(RenderError::Invalid(format!(
            "the scene is {width}x{height}: yuv420p video needs an even width and height"
        )));
    }
    encode::container_for(output).map_err(RenderError::Invalid)?;
    encode::fps_rational(fps).map_err(RenderError::Invalid)?;
    Ok(())
}

/// Renders the requested frames of a scene into `output`, calling `progress`
/// with (frames done, frames in all) after each one. A file that could not
/// be finished is removed.
pub fn render(
    request: &RenderRequest,
    progress: impl FnMut(u32, u32),
) -> Result<RenderSummary, String> {
    let run = || -> Result<RenderSummary, RenderError> {
        let scene = Scene::load(request.scene)?;
        let plan = plan(&scene, request.output, request.range, request.encoder)?;
        let mut renderer = Renderer::new(scene)?;
        // The frames come one after the other: a layer that did not change
        // since the last is not drawn again.
        renderer.set_layer_cache(true);
        drive(&mut renderer, &plan, request.output, None, progress)
    };
    run().map_err(|e| e.to_string())
}

/// Like `render`, for a scene that is already loaded, drawn by `renderer`
/// (which takes the scene first, see `Renderer::set_scene`). The renderer's
/// layer cache is left as it is.
pub fn render_scene(
    renderer: &mut Renderer,
    scene: Scene,
    request: &SceneRequest,
    progress: impl FnMut(u32, u32),
) -> Result<RenderSummary, RenderError> {
    let plan = plan(&scene, request.output, request.range, request.encoder)?;
    if let Some(audio) = &request.audio {
        audio.validate().map_err(RenderError::Invalid)?;
    }
    renderer.set_scene(scene)?;
    drive(
        renderer,
        &plan,
        request.output,
        request.audio.as_ref(),
        progress,
    )
}

fn drive(
    renderer: &mut Renderer,
    plan: &Plan,
    output: &Path,
    audio: Option<&AudioPcm>,
    mut progress: impl FnMut(u32, u32),
) -> Result<RenderSummary, RenderError> {
    let started = Instant::now();
    let mut sink = FrameSink::open(output, plan.width, plan.height, plan.fps, &plan.encoder)?;

    // Each frame is started before the last one is collected, so the GPU
    // draws one while the next is recorded. A failure returns, and dropping
    // the sink removes the unfinished file.
    let mut done = 0;
    let mut in_flight = None;
    for frame in (plan.first..=plan.last).map(Some).chain([None]) {
        let started = match frame {
            Some(frame) => Some((
                frame,
                renderer
                    .start_frame(frame)
                    .map_err(|e| RenderError::Frame(frame, e))?,
            )),
            None => None,
        };
        if let Some((frame, pending)) = std::mem::replace(&mut in_flight, started) {
            let rendered = renderer
                .finish_frame(pending)
                .map_err(|e| RenderError::Frame(frame, e))?;
            sink.push(rendered)?;
            done += 1;
            progress(done, plan.frames);
        }
    }
    let written = sink.finish(audio)?;
    if written != plan.frames {
        let _ = std::fs::remove_file(output);
        return Err(RenderError::Encode(format!(
            "wrote {written} of {} frames",
            plan.frames
        )));
    }

    let ms = started.elapsed().as_secs_f64() * 1000.0;
    Ok(RenderSummary {
        output: output.to_path_buf(),
        encoder: plan.encoder.clone(),
        width: plan.width,
        height: plan.height,
        fps: plan.fps,
        frames: plan.frames,
        first: plan.first,
        last: plan.last,
        ms,
        ms_per_frame: ms / f64::from(plan.frames),
        audio: audio.is_some(),
    })
}

/// A video file being written by an encoder thread.
///
/// The video goes to a file beside the output (`encode::partial_path`) and
/// takes its name only when it is finished, with the audio muxed in if there
/// is any (the audio is not known when the file is opened, and a container's
/// streams are fixed by then). Dropping a sink that was not finished removes
/// that file.
pub struct FrameSink {
    frames: Option<mpsc::SyncSender<Frame>>,
    thread: Option<thread::JoinHandle<Result<u32, String>>>,
    partial: PathBuf,
    output: PathBuf,
}

impl FrameSink {
    /// Opens the file for `width` x `height` frames at `fps`. The caller has
    /// checked the size, rate and path (`check_video`); the file is
    /// opened, and its failure reported, before this returns.
    pub fn open(
        output: &Path,
        width: u32,
        height: u32,
        fps: f64,
        encoder_name: &str,
    ) -> Result<FrameSink, RenderError> {
        let partial = encode::partial_path(output);
        // The encoder lives on its own thread (ffmpeg's contexts cannot cross
        // threads) and says whether the file opened before any frame is made.
        let (frame_tx, frame_rx) = mpsc::sync_channel::<Frame>(FRAMES_IN_FLIGHT);
        let (open_tx, open_rx) = mpsc::sync_channel::<Result<(), String>>(1);
        let (path, name) = (partial.clone(), encoder_name.to_string());
        let thread = thread::spawn(move || -> Result<u32, String> {
            let mut encoder = match VideoEncoder::create(&path, width, height, fps, &name) {
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
        let mut sink = FrameSink {
            frames: Some(frame_tx),
            thread: Some(thread),
            partial,
            output: output.to_path_buf(),
        };
        if let Err(e) = open_rx
            .recv()
            .unwrap_or_else(|_| Err("the encoder thread died".into()))
        {
            let _ = sink.close();
            return Err(RenderError::Encode(e));
        }
        Ok(sink)
    }

    /// Queues a finished frame, waiting if the encoder is two frames behind.
    pub fn push(&mut self, frame: Frame) -> Result<(), RenderError> {
        let sent = self
            .frames
            .as_ref()
            .is_some_and(|tx| tx.send(frame).is_ok());
        if sent {
            return Ok(());
        }
        // The encoder has stopped; its own error is the cause.
        let reason = self.close().err();
        Err(RenderError::Encode(
            reason.unwrap_or_else(|| "the encoder stopped".into()),
        ))
    }

    /// Flushes the encoder and gives the file its name, with `audio` muxed in
    /// if given. Returns the number of frames written.
    pub fn finish(mut self, audio: Option<&AudioPcm>) -> Result<u32, RenderError> {
        let written = self.close().map_err(RenderError::Encode)?;
        match audio {
            Some(audio) => {
                let muxed = encode::mux_audio(&self.partial, &self.output, audio);
                let _ = std::fs::remove_file(&self.partial);
                if let Err(e) = muxed {
                    let _ = std::fs::remove_file(&self.output);
                    return Err(RenderError::Encode(e));
                }
            }
            None => std::fs::rename(&self.partial, &self.output).map_err(|e| {
                let _ = std::fs::remove_file(&self.partial);
                RenderError::Encode(format!("cannot write {}: {e}", self.output.display()))
            })?,
        }
        Ok(written)
    }

    /// Ends the frames and waits for the encoder thread. Whatever it
    /// reports, the partial file is removed on an error.
    fn close(&mut self) -> Result<u32, String> {
        self.frames = None;
        let Some(thread) = self.thread.take() else {
            return Err("the encoder has already stopped".into());
        };
        let result = thread
            .join()
            .unwrap_or_else(|_| Err("the encoder thread panicked".into()));
        if result.is_err() {
            let _ = std::fs::remove_file(&self.partial);
        }
        result
    }
}

impl Drop for FrameSink {
    fn drop(&mut self) {
        // Not finished (that leaves no thread): stop, and remove the file.
        if self.thread.is_some() {
            let _ = self.close();
            let _ = std::fs::remove_file(&self.partial);
        }
    }
}

/// A video built a frame at a time, from scenes that may differ from frame
/// to frame. The scene's size and rate must be the writer's.
pub struct VideoWriter {
    sink: FrameSink,
    encoder: String,
    output: PathBuf,
    size: (u32, u32),
    fps: f64,
    started: Instant,
    /// The frame the GPU is drawing: collected and sent to the encoder when
    /// the next is started.
    in_flight: Option<(u32, PendingFrame)>,
    /// The first and last frame number pushed, and how many.
    first: Option<u32>,
    last: Option<u32>,
    pushed: u32,
}

impl VideoWriter {
    /// Opens `output` (the extension picks the container) for frames of
    /// `width` x `height` at `fps`.
    pub fn open(
        output: &Path,
        width: u32,
        height: u32,
        fps: f64,
        encoder: Option<&str>,
    ) -> Result<VideoWriter, RenderError> {
        let encoder =
            encode::select_encoder(encoder, cfg!(target_os = "macos"), encode::has_encoder)
                .map_err(RenderError::Invalid)?;
        check_video(width, height, fps, output)?;
        let started = Instant::now();
        let sink = FrameSink::open(output, width, height, fps, &encoder)?;
        Ok(VideoWriter {
            sink,
            encoder,
            output: output.to_path_buf(),
            size: (width, height),
            fps,
            started,
            in_flight: None,
            first: None,
            last: None,
            pushed: 0,
        })
    }

    /// Draws `frame` of `scene` with `renderer` and queues it for encoding.
    /// Frames come in increasing order. The GPU starts this one before the
    /// last is read back.
    pub fn push_frame(
        &mut self,
        renderer: &mut Renderer,
        scene: Scene,
        frame: u32,
    ) -> Result<(), RenderError> {
        if (scene.width, scene.height) != self.size || scene.fps != self.fps {
            return Err(RenderError::Invalid(format!(
                "the scene is {}x{} at {} fps, but the video is {}x{} at {} fps",
                scene.width, scene.height, scene.fps, self.size.0, self.size.1, self.fps
            )));
        }
        if let Some(last) = self.last.filter(|&last| frame <= last) {
            return Err(RenderError::Invalid(format!(
                "frames must come in increasing order: {frame} after {last}"
            )));
        }
        renderer.set_scene(scene)?;
        let pending = renderer
            .start_frame(frame)
            .map_err(|e| RenderError::Frame(frame, e))?;
        self.first.get_or_insert(frame);
        self.last = Some(frame);
        self.pushed += 1;
        if let Some((previous, pending)) = self.in_flight.replace((frame, pending)) {
            self.send(renderer, previous, pending)?;
        }
        Ok(())
    }

    fn send(
        &mut self,
        renderer: &mut Renderer,
        frame: u32,
        pending: PendingFrame,
    ) -> Result<(), RenderError> {
        let rendered = renderer
            .finish_frame(pending)
            .map_err(|e| RenderError::Frame(frame, e))?;
        self.sink.push(rendered)
    }

    /// Reads back the last frame, flushes the encoder and gives the file its
    /// name, with `audio` muxed in if given.
    pub fn finish(
        mut self,
        renderer: &mut Renderer,
        audio: Option<&AudioPcm>,
    ) -> Result<RenderSummary, RenderError> {
        if let Some(audio) = audio {
            audio.validate().map_err(RenderError::Invalid)?;
        }
        if let Some((frame, pending)) = self.in_flight.take() {
            self.send(renderer, frame, pending)?;
        }
        let (Some(first), Some(last)) = (self.first, self.last) else {
            return Err(RenderError::Invalid("no frames were pushed".into()));
        };
        let written = self.sink.finish(audio)?;
        if written != self.pushed {
            let _ = std::fs::remove_file(&self.output);
            return Err(RenderError::Encode(format!(
                "wrote {written} of {} frames",
                self.pushed
            )));
        }
        let ms = self.started.elapsed().as_secs_f64() * 1000.0;
        Ok(RenderSummary {
            output: self.output.clone(),
            encoder: self.encoder.clone(),
            width: self.size.0,
            height: self.size.1,
            fps: self.fps,
            frames: self.pushed,
            first,
            last,
            ms,
            ms_per_frame: ms / f64::from(self.pushed),
            audio: audio.is_some(),
        })
    }
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

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("kinetograph-sink-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn grey(level: u8) -> Frame {
        Frame {
            width: 64,
            height: 48,
            rgba: vec![level; 64 * 48 * 4],
        }
    }

    #[test]
    fn a_sink_gives_the_file_its_name_only_when_it_is_finished() {
        let dir = scratch("finish");
        let out = dir.join("out.mp4");
        let mut sink = FrameSink::open(&out, 64, 48, 30.0, "libx264").unwrap();
        for i in 0..5 {
            sink.push(grey(100 + i * 10)).unwrap();
        }
        assert!(!out.exists() && encode::partial_path(&out).exists());
        assert_eq!(sink.finish(None).unwrap(), 5);
        assert!(out.exists() && !encode::partial_path(&out).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_sink_that_is_dropped_or_fails_leaves_no_file() {
        let dir = scratch("drop");
        let out = dir.join("out.mp4");
        let mut sink = FrameSink::open(&out, 64, 48, 30.0, "libx264").unwrap();
        sink.push(grey(10)).unwrap();
        drop(sink);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);

        // A frame of the wrong size stops the encoder; the error says so and
        // the file goes.
        let mut sink = FrameSink::open(&out, 64, 48, 30.0, "libx264").unwrap();
        let wrong = Frame {
            width: 2,
            height: 2,
            rgba: vec![0; 16],
        };
        let mut failure = sink.push(wrong).err();
        // The channel holds a couple of frames, so the failure may show on a
        // later push.
        for _ in 0..8 {
            if failure.is_some() {
                break;
            }
            failure = sink.push(grey(0)).err();
        }
        let message = failure.expect("the encoder rejected a frame").to_string();
        assert!(message.contains("expected"), "{message}");
        assert!(matches!(sink.finish(None), Err(RenderError::Encode(_))));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);

        // A file that cannot be created fails at open.
        let err = FrameSink::open(&dir.join("no/such/dir/out.mp4"), 64, 48, 30.0, "libx264")
            .err()
            .expect("opened a file in a missing directory");
        assert!(matches!(err, RenderError::Encode(_)), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_sink_finishes_with_audio() {
        let dir = scratch("audio");
        let out = dir.join("out.mov");
        let mut sink = FrameSink::open(&out, 64, 48, 30.0, "libx264").unwrap();
        for i in 0..6 {
            sink.push(grey(50 + i * 20)).unwrap();
        }
        let silence = vec![0.0_f32; 48000 / 5];
        let audio = AudioPcm {
            sample_rate: 48000,
            channels: &[&silence],
        };
        assert_eq!(sink.finish(Some(&audio)).unwrap(), 6);
        assert!(out.exists() && !encode::partial_path(&out).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn requests_are_checked_before_anything_is_opened() {
        let out = Path::new("/nonexistent/dir/out.mp4");
        for (w, h, fps, want) in [(65, 48, 30.0, "even"), (64, 48, 0.0, "fps")] {
            let err = VideoWriter::open(out, w, h, fps, Some("libx264"))
                .err()
                .expect("accepted a bad video");
            assert!(matches!(err, RenderError::Invalid(_)), "{err}");
            assert!(err.to_string().contains(want), "{err}");
        }
        let err = VideoWriter::open(Path::new("out.mkv"), 64, 48, 30.0, Some("libx264"))
            .err()
            .unwrap();
        assert!(matches!(err, RenderError::Invalid(_)) && err.to_string().contains(".mp4 or .mov"));
        let err = VideoWriter::open(out, 64, 48, 30.0, Some("no-such-encoder"))
            .err()
            .unwrap();
        assert!(matches!(err, RenderError::Invalid(_)), "{err}");
    }

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
