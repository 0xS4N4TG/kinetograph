//! `matte_video`: decode a clip, matte every frame, write the subject with alpha (and the clip as an opaque base).
//!
//! The clip is cut into `jobs` runs of frames, each matted by its own thread on its own copy of the model and encoded
//! to a file of its own; the files are then joined by copying packets, and the clip's audio is muxed in. Inside a
//! run, decode and resize, the model, and each encoder are separate threads joined by short queues, so the GPU, the
//! CPU and the encoders all work at once.
//!
//! A frame is matted on its own (neither model looks at the frames around it), so the runs need no overlap.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};

use kinetograph_cli::encode::{self, AudioPcm, Codec, FrameEncoder, Resolved, Settings};
use kinetograph_core::video::{self, VideoDecoder, VideoInfo};

use crate::infer::Matter;
use crate::join::join;
use crate::model::{Model, alpha_from_matte, with_alpha};
use crate::{audio, infer};

/// How much quality the files keep: the encoder's quality setting (`Quality::settings`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quality {
    VeryLow,
    Low,
    Medium,
    High,
    VeryHigh,
}

impl Quality {
    pub fn parse(name: &str) -> Result<Quality, String> {
        match name {
            "very-low" => Ok(Quality::VeryLow),
            "low" => Ok(Quality::Low),
            "medium" => Ok(Quality::Medium),
            "high" => Ok(Quality::High),
            "very-high" => Ok(Quality::VeryHigh),
            _ => Err(format!(
                "unknown quality {name:?}: use very-low, low, medium, high or very-high"
            )),
        }
    }

    /// libvpx-vp9's constant quality (0 best, 63 worst). It also sets the alpha plane's, so the lower settings blur the
    /// matte's edge as well as the picture.
    fn vp9_crf(self) -> f64 {
        match self {
            Quality::VeryLow => 50.0,
            Quality::Low => 40.0,
            Quality::Medium => 32.0,
            Quality::High => 24.0,
            Quality::VeryHigh => 16.0,
        }
    }

    /// libx264's constant quality, for an H.264 base layer.
    fn h264_crf(self) -> f64 {
        match self {
            Quality::VeryLow => 35.0,
            Quality::Low => 30.0,
            Quality::Medium => 25.0,
            Quality::High => 20.0,
            Quality::VeryHigh => 16.0,
        }
    }

    /// The encoder settings for the layer written to `path`. The foreground needs alpha: `.webm` is VP9 `yuva420p` and
    /// `.mov` is ProRes 4444 (4444 XQ at very-high). The base is `.webm` (VP9), or `.mp4` or `.mov` (H.264).
    pub fn settings(self, path: &Path, foreground: bool) -> Result<Settings, String> {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase);
        match (ext.as_deref(), foreground) {
            (Some("webm"), true) => Ok(Settings {
                codec: Some(Codec::Vp9),
                pixel_format: Some("yuva420p".into()),
                crf: Some(self.vp9_crf()),
                ..Settings::default()
            }),
            (Some("mov"), true) => Ok(Settings {
                codec: Some(Codec::ProRes),
                pixel_format: Some("yuva444p10le".into()),
                prores_profile: Some(
                    if self == Quality::VeryHigh {
                        "4444-xq"
                    } else {
                        "4444"
                    }
                    .into(),
                ),
                ..Settings::default()
            }),
            (_, true) => Err(format!(
                "{}: the foreground keeps alpha, so it is a .webm (VP9) or a .mov (ProRes 4444) file",
                path.display()
            )),
            (Some("webm"), false) => Ok(Settings {
                codec: Some(Codec::Vp9),
                crf: Some(self.vp9_crf()),
                ..Settings::default()
            }),
            (Some("mp4" | "mov"), false) => Ok(Settings {
                codec: Some(Codec::H264),
                crf: Some(self.h264_crf()),
                ..Settings::default()
            }),
            (_, false) => Err(format!(
                "{}: the base is a .webm, .mp4 or .mov file",
                path.display()
            )),
        }
    }
}

/// Which of the two files carry the clip's audio.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioTarget {
    Both,
    Base,
    Foreground,
    None,
}

impl AudioTarget {
    pub fn parse(name: &str) -> Result<AudioTarget, String> {
        match name {
            "both" => Ok(AudioTarget::Both),
            "base" => Ok(AudioTarget::Base),
            "foreground" => Ok(AudioTarget::Foreground),
            "none" => Ok(AudioTarget::None),
            _ => Err(format!(
                "unknown audio setting {name:?}: use both, base, foreground or none"
            )),
        }
    }

    fn wants(self, foreground: bool) -> bool {
        match self {
            AudioTarget::Both => true,
            AudioTarget::None => false,
            AudioTarget::Foreground => foreground,
            AudioTarget::Base => !foreground,
        }
    }
}

pub struct Options {
    pub input: PathBuf,
    pub model_path: PathBuf,
    pub model: Model,
    pub foreground: PathBuf,
    pub base: Option<PathBuf>,
    /// Which files get the input's audio (none, when the input has none).
    pub audio: AudioTarget,
    pub quality: Quality,
    /// Bits per second for the video of both files, in place of `quality`'s setting (not for ProRes).
    pub video_bitrate: Option<usize>,
    /// Bits per second for the audio that is encoded (Opus or AAC; PCM has none).
    pub audio_bitrate: Option<usize>,
    /// The longest time between keyframes, in seconds (1).
    pub keyframe_seconds: Option<f64>,
    /// Runs of the clip matted at once.
    pub jobs: usize,
    /// Set from another thread to stop: the run ends between frames with a "cancelled" error and leaves no file.
    pub cancel: Option<Arc<AtomicBool>>,
}

#[derive(Debug)]
pub struct Output {
    pub foreground: PathBuf,
    pub base: Option<PathBuf>,
    pub frames: u64,
    pub backend: &'static str,
}

/// `frames` cut into at most `jobs` runs of whole frames, as (first frame, count), as even as can be and none empty.
pub fn split(frames: u64, jobs: usize) -> Vec<(u64, u64)> {
    let jobs = (jobs.max(1) as u64).min(frames.max(1));
    (0..jobs)
        .map(|j| {
            (
                frames * j / jobs,
                frames * (j + 1) / jobs - frames * j / jobs,
            )
        })
        .filter(|(_, count)| *count > 0)
        .collect()
}

/// The frames of the clip: the container's count, else the duration at the frame rate.
fn frame_count(info: &VideoInfo, fps: f64) -> u64 {
    info.frames
        .unwrap_or_else(|| (info.duration * fps).round().max(1.0) as u64)
}

/// A file beside `output` for run `piece` of it, hidden and not named like the result.
fn piece_path(output: &Path, piece: usize) -> PathBuf {
    let name = output
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = output
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_default();
    output.with_file_name(format!(".{name}.piece{piece}.{ext}"))
}

/// What a layer is written with: the resolved encoder, the path it goes to, and the pieces' paths.
struct Layer {
    settings: Resolved,
    output: PathBuf,
    pieces: Vec<PathBuf>,
    /// Whether the audio goes into this file.
    audio: bool,
}

impl Layer {
    fn new(
        options: &Options,
        output: &Path,
        foreground: bool,
        runs: usize,
    ) -> Result<Layer, String> {
        let mut settings = options.quality.settings(output, foreground)?;
        let prores = settings.codec == Some(Codec::ProRes);
        if let Some(bits) = options.video_bitrate.filter(|_| !prores) {
            settings.crf = None;
            settings.video_bitrate = Some(bits);
        }
        // ProRes files carry PCM, which has no bit rate.
        settings.audio_bitrate = options.audio_bitrate.filter(|_| !prores);
        settings.keyframe_seconds = Some(options.keyframe_seconds.unwrap_or(1.0));
        let settings = encode::resolve(
            &settings,
            output,
            cfg!(target_os = "macos"),
            encode::has_encoder,
        )?;
        Ok(Layer {
            settings,
            output: output.to_path_buf(),
            pieces: (0..runs).map(|i| piece_path(output, i)).collect(),
            audio: options.audio.wants(foreground),
        })
    }
}

/// Reports `(done, total)` frames; called from the threads that finish them, in no fixed order across runs.
pub type Progress<'a> = &'a (dyn Fn(u64, u64) + Sync);

/// The first error that is not just another thread's stopping.
const STOPPED: &str = "stopped";

/// The error of a run that `Options::cancel` stopped.
pub const CANCELLED: &str = "cancelled";

fn first_error(results: Vec<Result<(), String>>) -> Result<(), String> {
    let errors: Vec<String> = results.into_iter().filter_map(Result::err).collect();
    match errors.iter().find(|e| *e != STOPPED) {
        Some(e) => Err(e.clone()),
        None if errors.is_empty() => Ok(()),
        None => Err(STOPPED.into()),
    }
}

pub fn matte_video(options: &Options, progress: Progress) -> Result<Output, String> {
    video::init();
    if !options.model_path.is_file() {
        return Err(format!(
            "the model file {} is not there",
            options.model_path.display()
        ));
    }
    let info =
        video::probe(&options.input).map_err(|e| format!("{}: {e}", options.input.display()))?;
    let fps = info
        .fps
        .filter(|f| *f > 0.0)
        .ok_or_else(|| format!("{}: no frame rate", options.input.display()))?;
    let frames = frame_count(&info, fps);
    // Video needs even sides: a source with an odd one loses its last row or column.
    let (width, height) = (info.width & !1, info.height & !1);
    if width == 0 || height == 0 {
        return Err(format!(
            "{}: the video is too small to matte",
            options.input.display()
        ));
    }
    let (fps_num, fps_den) = encode::fps_rational(fps)?;
    let runs = split(frames, options.jobs);

    let fg = Layer::new(options, &options.foreground, true, runs.len())?;
    let base = options
        .base
        .as_ref()
        .map(|path| Layer::new(options, path, false, runs.len()))
        .transpose()?;
    for path in [Some(&options.foreground), options.base.as_ref()]
        .into_iter()
        .flatten()
    {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("cannot make {}: {e}", dir.display()))?;
        }
    }
    // The audio is read first so that a file with a stream it cannot decode fails before any frame is matted.
    let pcm = if options.audio != AudioTarget::None && info.has_audio {
        audio::decode(&options.input, 48000)?
    } else {
        None
    };

    let done = AtomicU64::new(0);
    let report = || progress(done.fetch_add(1, Ordering::Relaxed) + 1, frames);
    let threads = std::thread::available_parallelism()
        .map_or(4, |n| n.get())
        .div_ceil(runs.len());
    let results: Vec<Result<&'static str, String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = runs
            .iter()
            .enumerate()
            .map(|(i, &(first, count))| {
                let (info, fg, base, report) = (&info, &fg, base.as_ref(), &report);
                scope.spawn(move || {
                    run_piece(
                        options,
                        info,
                        Piece {
                            first,
                            count,
                            fps,
                            size: (width, height),
                            threads,
                        },
                        (&fg.settings, &fg.pieces[i]),
                        base.map(|b| (&b.settings, b.pieces[i].as_path())),
                        report,
                    )
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| {
                h.join()
                    .unwrap_or_else(|_| Err("a matting thread panicked".into()))
            })
            .collect()
    });

    let finish = || -> Result<&'static str, String> {
        first_error(
            results
                .iter()
                .map(|r| r.as_ref().map(|_| ()).map_err(Clone::clone))
                .collect(),
        )?;
        let backend = results[0].as_ref().map_err(Clone::clone)?;
        for layer in [Some(&fg), base.as_ref()].into_iter().flatten() {
            publish(
                layer,
                &runs,
                pcm.as_deref().filter(|_| layer.audio),
                (fps_num, fps_den),
            )?;
        }
        Ok(*backend)
    };
    let outcome = finish();
    for layer in [Some(&fg), base.as_ref()].into_iter().flatten() {
        for piece in &layer.pieces {
            let _ = std::fs::remove_file(piece);
        }
    }
    let backend = match outcome {
        Ok(backend) => backend,
        Err(e) => {
            // No half-written result keeps the final name.
            for layer in [Some(&fg), base.as_ref()].into_iter().flatten() {
                let _ = std::fs::remove_file(encode::partial_path(&layer.output));
            }
            return Err(e);
        }
    };
    Ok(Output {
        foreground: fg.output,
        base: base.map(|b| b.output),
        frames,
        backend,
    })
}

/// The layer's pieces as its output file: joined (or the one piece moved), with the audio in when there is some.
fn publish(
    layer: &Layer,
    runs: &[(u64, u64)],
    pcm: Option<&[Vec<f32>]>,
    fps: (i32, i32),
) -> Result<(), String> {
    let video = if pcm.is_some() {
        encode::partial_path(&layer.output)
    } else {
        layer.output.clone()
    };
    if let [piece] = layer.pieces.as_slice() {
        std::fs::rename(piece, &video)
            .map_err(|e| format!("cannot write {}: {e}", video.display()))?;
    } else {
        let pieces: Vec<(PathBuf, u64)> = layer
            .pieces
            .iter()
            .cloned()
            .zip(runs.iter().map(|r| r.0))
            .collect();
        join(&pieces, &video, &layer.settings, fps)?;
    }
    if let Some(channels) = pcm {
        let channels: Vec<&[f32]> = channels.iter().map(|c| c.as_slice()).collect();
        let pcm = AudioPcm {
            sample_rate: 48000,
            channels: &channels,
        };
        encode::mux_audio(&video, &layer.output, &pcm, &layer.settings)?;
        let _ = std::fs::remove_file(&video);
    }
    Ok(())
}

struct Piece {
    first: u64,
    count: u64,
    fps: f64,
    /// The picture's size, both even.
    size: (u32, u32),
    threads: usize,
}

/// One frame decoded and resized for the model.
struct Decoded {
    rgba: Arc<Vec<u8>>,
    input: Vec<f32>,
}

/// One frame and its matte (the model's, at the model's size).
struct Matted {
    rgba: Arc<Vec<u8>>,
    matte: Vec<f32>,
}

/// Mattes frames `first..first + count` of the clip into the piece files; returns the backend the model ran on.
fn run_piece(
    options: &Options,
    info: &Arc<VideoInfo>,
    piece: Piece,
    fg: (&Resolved, &Path),
    base: Option<(&Resolved, &Path)>,
    report: &(dyn Fn() + Sync),
) -> Result<&'static str, String> {
    let (width, height) = piece.size;
    let model = options.model;
    let input_size = model.input_size(width, height);
    // The model is opened here, before the other threads start, so that a model that will not load fails at once.
    let mut matter = Matter::load(&options.model_path, model, input_size, piece.threads)?;
    let backend = matter.backend();

    let (to_model, from_decode): (SyncSender<Decoded>, Receiver<Decoded>) = sync_channel(3);
    let (to_fg, from_model): (SyncSender<Matted>, Receiver<Matted>) = sync_channel(3);
    let (to_base, from_decode_base) = sync_channel::<Arc<Vec<u8>>>(3);
    let has_base = base.is_some();

    let results = std::thread::scope(|scope| {
        let decode = scope.spawn(move || -> Result<(), String> {
            let mut decoder = VideoDecoder::open(&options.input, info.clone())?;
            for n in piece.first..piece.first + piece.count {
                if options
                    .cancel
                    .as_ref()
                    .is_some_and(|c| c.load(Ordering::Relaxed))
                {
                    return Err(CANCELLED.into());
                }
                let ts = info.media_time(n as f64 / piece.fps, info.duration).ts;
                let picture = decoder.picture(ts)?;
                let rgba = Arc::new(even_crop(
                    picture.data.data(),
                    picture.width,
                    picture.height,
                    width,
                    height,
                )?);
                let input = model.preprocess(&rgba, width, height);
                if has_base {
                    to_base
                        .send(rgba.clone())
                        .map_err(|_| STOPPED.to_string())?;
                }
                to_model
                    .send(Decoded { rgba, input })
                    .map_err(|_| STOPPED.to_string())?;
            }
            Ok(())
        });
        let infer_stage = scope.spawn(move || -> Result<(), String> {
            for Decoded { rgba, input } in from_decode {
                let matte = matter.run(input)?;
                to_fg
                    .send(Matted { rgba, matte })
                    .map_err(|_| STOPPED.to_string())?;
            }
            Ok(())
        });
        let fg_stage = scope.spawn(move || -> Result<(), String> {
            let mut out = FrameEncoder::create(fg.1, width, height, piece.fps, fg.0)?;
            for Matted { rgba, matte } in from_model {
                let alpha = alpha_from_matte(&matte, input_size.0, input_size.1, width, height);
                out.push(&with_alpha(&rgba, &alpha))?;
                report();
            }
            out.finish().map(|_| ())
        });
        let base_stage = scope.spawn(move || -> Result<(), String> {
            let Some((settings, path)) = base else {
                return Ok(());
            };
            let mut out = FrameEncoder::create(path, width, height, piece.fps, settings)?;
            for rgba in from_decode_base {
                out.push(&rgba)?;
            }
            out.finish().map(|_| ())
        });
        [decode, infer_stage, fg_stage, base_stage]
            .into_iter()
            .map(|h| {
                h.join()
                    .unwrap_or_else(|_| Err("a matting thread panicked".into()))
            })
            .collect::<Vec<_>>()
    });
    first_error(results)?;
    Ok(backend)
}

/// The top-left `width` x `height` of a tightly packed RGBA picture (what the encoders take), or the picture itself.
fn even_crop(
    rgba: &[u8],
    from_width: u32,
    from_height: u32,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, String> {
    if from_width < width
        || from_height < height
        || rgba.len() != from_width as usize * from_height as usize * 4
    {
        return Err(format!(
            "a {from_width}x{from_height} picture came out where {width}x{height} was expected"
        ));
    }
    if (from_width, from_height) == (width, height) {
        return Ok(rgba.to_vec());
    }
    let (row, from_row) = (width as usize * 4, from_width as usize * 4);
    Ok((0..height as usize)
        .flat_map(|y| rgba[y * from_row..y * from_row + row].iter().copied())
        .collect())
}

/// One frame (tightly packed RGBA8) matted on its own: the alpha at the frame's size, and the backend the model ran on.
/// For checking a model file on a machine without running a whole clip.
pub fn matte_frame(
    model_path: &Path,
    model: Model,
    rgba: &[u8],
    width: u32,
    height: u32,
) -> Result<(Vec<u8>, &'static str), String> {
    let size = model.input_size(width, height);
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    let mut matter = Matter::load(model_path, model, size, threads)?;
    let matte = matter.run(model.preprocess(rgba, width, height))?;
    Ok((
        alpha_from_matte(&matte, size.0, size.1, width, height),
        matter.backend(),
    ))
}

/// Whether ONNX Runtime is there, and the GPU back end `ben2-base` would use (`modnet` always runs on the CPU): the
/// answer `mattingSupport()` gives.
pub struct Support {
    pub available: bool,
    pub backend: &'static str,
    pub reason: Option<String>,
}

pub fn support() -> Support {
    if let Some(reason) = infer::runtime_unavailable() {
        return Support {
            available: false,
            backend: "cpu",
            reason: Some(reason),
        };
    }
    match (infer::GPU_BACKEND, infer::gpu_unavailable()) {
        (Some(backend), None) => Support {
            available: true,
            backend,
            reason: None,
        },
        (_, reason) => Support {
            available: true,
            backend: "cpu",
            reason,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_split_evenly_into_runs_with_none_empty() {
        assert_eq!(split(120, 2), vec![(0, 60), (60, 60)]);
        assert_eq!(split(10, 3), vec![(0, 3), (3, 3), (6, 4)]);
        // More runs than frames: one frame each.
        assert_eq!(split(2, 8), vec![(0, 1), (1, 1)]);
        assert_eq!(split(5, 1), vec![(0, 5)]);
        assert_eq!(split(5, 0), vec![(0, 5)]);
        for (frames, jobs) in [(121, 4), (1, 3), (1000, 7)] {
            let runs = split(frames, jobs);
            assert_eq!(runs.iter().map(|r| r.1).sum::<u64>(), frames);
            assert!(runs.windows(2).all(|w| w[0].0 + w[0].1 == w[1].0));
        }
    }

    #[test]
    fn quality_maps_to_the_encoders_settings() {
        let fg = |name: &str, q: Quality| q.settings(Path::new(name), true);
        let very_low = fg("a.webm", Quality::VeryLow).unwrap();
        let low = fg("a.webm", Quality::Low).unwrap();
        let top = fg("a.webm", Quality::VeryHigh).unwrap();
        assert_eq!(
            (low.codec, low.pixel_format.as_deref()),
            (Some(Codec::Vp9), Some("yuva420p"))
        );
        assert!(
            very_low.crf.unwrap() > low.crf.unwrap() && low.crf.unwrap() > top.crf.unwrap(),
            "a lower quality is a higher CRF"
        );
        let prores = fg("a.mov", Quality::High).unwrap();
        assert_eq!(prores.prores_profile.as_deref(), Some("4444"));
        assert_eq!(prores.pixel_format.as_deref(), Some("yuva444p10le"));
        assert_eq!(
            fg("a.mov", Quality::VeryHigh)
                .unwrap()
                .prores_profile
                .as_deref(),
            Some("4444-xq")
        );
        // Alpha needs one of the two containers.
        assert!(fg("a.mp4", Quality::High).is_err());
        // The base has no alpha: WebM is VP9 without it, MP4 and MOV are H.264.
        let base = Quality::High.settings(Path::new("b.webm"), false).unwrap();
        assert_eq!((base.codec, base.pixel_format), (Some(Codec::Vp9), None));
        assert_eq!(
            Quality::High
                .settings(Path::new("b.mp4"), false)
                .unwrap()
                .codec,
            Some(Codec::H264)
        );
        assert!(Quality::High.settings(Path::new("b.avi"), false).is_err());
        assert!(Quality::parse("ultra").is_err());
    }

    #[test]
    fn every_foreground_setting_resolves_to_an_alpha_format() {
        // The settings pass the encoder module's own checks (with every encoder reported present).
        for (name, want) in [("a.webm", "yuva420p"), ("a.mov", "yuva444p10le")] {
            for q in [
                Quality::VeryLow,
                Quality::Low,
                Quality::Medium,
                Quality::High,
                Quality::VeryHigh,
            ] {
                let s = q.settings(Path::new(name), true).unwrap();
                let r = encode::resolve(&s, Path::new(name), false, |_| true).unwrap();
                assert_eq!(r.pix.name(), want);
                assert!(r.pix.has_alpha());
            }
        }
    }

    #[test]
    fn odd_pictures_lose_a_row_and_column_and_even_ones_pass_through() {
        // 3x3 RGBA, pixel value = its index, cropped to 2x2.
        let rgba: Vec<u8> = (0..9u8).flat_map(|i| [i, i, i, 255]).collect();
        let out = even_crop(&rgba, 3, 3, 2, 2).unwrap();
        let reds: Vec<u8> = out.chunks(4).map(|p| p[0]).collect();
        assert_eq!(reds, vec![0, 1, 3, 4]);
        assert_eq!(even_crop(&rgba, 3, 3, 3, 3).unwrap(), rgba);
        assert!(even_crop(&rgba, 3, 3, 4, 4).is_err());
    }

    #[test]
    fn a_runs_files_sit_beside_the_output_and_never_take_its_name() {
        assert_eq!(
            piece_path(Path::new("/out/fg.webm"), 1),
            PathBuf::from("/out/.fg.webm.piece1.webm")
        );
    }

    #[test]
    fn the_first_real_error_wins_over_a_stopped_thread() {
        assert_eq!(
            first_error(vec![Ok(()), Err(STOPPED.into()), Err("no frame".into())]),
            Err("no frame".into())
        );
        assert_eq!(first_error(vec![Ok(())]), Ok(()));
    }
}
