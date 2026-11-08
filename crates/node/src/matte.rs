//! `mattingSupport` and `matteVideo`: a subject cut out of a video with MODNet or BEN2 (`kinetograph-matte`), written
//! as a video with alpha. A preparation step that writes files once; a render only reads them. Never called during a
//! render.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use kinetograph_matte::{AudioTarget, CANCELLED, Model, Options, Quality};
use napi::bindgen_prelude::{AsyncTask, Function};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::{Env, Status, Task};
use napi_derive::napi;

/// Whether `matteVideo` can run here, and on what.
#[napi(object)]
pub struct MattingSupport {
    /// ONNX Runtime is linked and starts.
    pub available: bool,
    /// What `ben2-base` runs on: `coreml` (a Mac), `directml` (Windows), `cuda` or `webgpu` (builds with them), else
    /// `cpu`. `modnet` always runs on the CPU, at video speed (CoreML did not help it).
    pub backend: String,
    /// Why `available` is false, or why the backend is `cpu`.
    pub reason: Option<String>,
}

#[napi]
pub fn matting_support() -> MattingSupport {
    let support = kinetograph_matte::support();
    MattingSupport {
        available: support.available,
        backend: support.backend.to_string(),
        reason: support.reason,
    }
}

#[napi(object)]
pub struct MatteOptions {
    /// Any video FFmpeg can decode.
    pub input: String,
    /// The `.onnx` file of `model`.
    pub model_path: String,
    /// `modnet` or `ben2-base`.
    pub model: String,
    /// Output: the subject with alpha. `.webm` is VP9 `yuva420p`, `.mov` is ProRes 4444.
    pub foreground: String,
    /// Output: the opaque base layer, the clip itself at the same size and rate (`.webm`, `.mp4` or `.mov`).
    pub base: Option<String>,
    /// Without `audio`: copy the input's audio into the foreground and base files (true), or drop it (false).
    pub keep_audio: Option<bool>,
    /// Which files get the input's audio: `both`, `base`, `foreground` or `none`. Takes the place of `keepAudio`;
    /// `base` when neither is given.
    pub audio: Option<String>,
    /// `very-low`, `low`, `medium`, `high` (default) or `very-high`.
    pub quality: Option<String>,
    /// Bits per second for the video of both files, in place of `quality`'s encoder setting (not for ProRes).
    pub video_bitrate: Option<u32>,
    /// Bits per second for the audio that is encoded (Opus, AAC).
    pub audio_bitrate: Option<u32>,
    /// The longest time between keyframes in both files, in seconds (1).
    pub keyframe_interval_in_seconds: Option<f64>,
    /// Pieces of the clip matted at once (2).
    pub jobs: Option<u32>,
}

#[napi(object)]
pub struct MatteResult {
    pub foreground: String,
    pub base: Option<String>,
    pub frames: u32,
    /// What the model ran on: see `MattingSupport.backend`.
    pub backend: String,
}

/// Stops a `matteVideo` it was passed to: the call rejects with a `Cancelled` error between two frames and leaves no
/// file. (`signal.addEventListener('abort', () => token.cancel())` is how an `AbortSignal` is wired to it.)
#[napi]
pub struct MatteToken {
    flag: Arc<AtomicBool>,
}

#[napi]
impl MatteToken {
    #[napi(constructor)]
    pub fn new() -> MatteToken {
        MatteToken {
            flag: Arc::new(AtomicBool::new(false)),
        }
    }

    #[napi]
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::Relaxed);
    }

    #[napi(getter)]
    pub fn cancelled(&self) -> bool {
        self.flag.load(Ordering::Relaxed)
    }
}

impl Default for MatteToken {
    fn default() -> Self {
        Self::new()
    }
}

pub struct MatteTask {
    request: Option<MatteOptions>,
    cancel: Option<Arc<AtomicBool>>,
    progress: Option<Box<dyn Fn(u32, u32) + Send + Sync>>,
}

/// `MatteOptions` checked: the model, the quality and the audio setting named, both files there to read.
fn options_of(
    request: MatteOptions,
    cancel: Option<Arc<AtomicBool>>,
) -> std::result::Result<Options, String> {
    let model = Model::parse(&request.model)?;
    let quality = request
        .quality
        .as_deref()
        .map(Quality::parse)
        .transpose()?
        .unwrap_or_default();
    for (what, path) in [
        ("input", &request.input),
        ("model file", &request.model_path),
    ] {
        std::fs::metadata(path).map_err(|e| format!("cannot read the {what} {path}: {e}"))?;
    }
    if request.jobs == Some(0) {
        return Err("jobs must be at least 1".into());
    }
    if let Some(seconds) = request.keyframe_interval_in_seconds
        && !(seconds.is_finite() && seconds > 0.0)
    {
        return Err("keyframeIntervalInSeconds must be a positive number".into());
    }
    if request.video_bitrate == Some(0) || request.audio_bitrate == Some(0) {
        return Err("a bitrate must be above 0".into());
    }
    let audio = match (&request.audio, request.keep_audio) {
        (Some(name), _) => AudioTarget::parse(name)?,
        (None, Some(true)) => AudioTarget::Both,
        (None, Some(false)) => AudioTarget::None,
        (None, None) => AudioTarget::Base,
    };
    Ok(Options {
        input: PathBuf::from(&request.input),
        model_path: PathBuf::from(&request.model_path),
        model,
        foreground: PathBuf::from(&request.foreground),
        base: request.base.map(PathBuf::from),
        audio,
        quality,
        video_bitrate: request.video_bitrate.map(|b| b as usize),
        audio_bitrate: request.audio_bitrate.map(|b| b as usize),
        keyframe_seconds: request.keyframe_interval_in_seconds,
        jobs: request.jobs.unwrap_or(2) as usize,
        cancel,
    })
}

impl Task for MatteTask {
    type Output = MatteResult;
    type JsValue = MatteResult;

    fn compute(&mut self) -> napi::Result<MatteResult> {
        let request = self
            .request
            .take()
            .ok_or_else(|| napi::Error::new(Status::GenericFailure, "already run".to_string()))?;
        let options = options_of(request, self.cancel.take())
            .map_err(|e| napi::Error::new(Status::InvalidArg, e))?;
        let report = |done: u64, total: u64| {
            if let Some(progress) = &self.progress {
                progress(done as u32, total as u32);
            }
        };
        let out = kinetograph_matte::matte_video(&options, &report).map_err(|e| {
            let status = if e == CANCELLED {
                Status::Cancelled
            } else {
                Status::GenericFailure
            };
            napi::Error::new(status, e)
        })?;
        Ok(MatteResult {
            foreground: out.foreground.to_string_lossy().into_owned(),
            base: out.base.map(|b| b.to_string_lossy().into_owned()),
            frames: u32::try_from(out.frames).unwrap_or(u32::MAX),
            backend: out.backend.to_string(),
        })
    }

    fn resolve(&mut self, _env: Env, output: MatteResult) -> napi::Result<MatteResult> {
        Ok(output)
    }
}

/// Mattes every frame of `input` and writes the subject with alpha to `foreground` (and the clip as an opaque `base`).
/// `onProgress(doneFrames, totalFrames)` is called on the event loop as frames finish. Every failure rejects the
/// promise: a bad option or a missing input or model file (`InvalidArg`), a file that cannot be read or written
/// (`GenericFailure`), or `token.cancel()` (`Cancelled`).
#[napi(
    ts_args_type = "options: MatteOptions, onProgress?: ((doneFrames: number, totalFrames: number) => void) | undefined | null, token?: MatteToken | undefined | null",
    ts_return_type = "Promise<MatteResult>"
)]
pub fn matte_video(
    options: MatteOptions,
    on_progress: Option<Function<(u32, u32), ()>>,
    token: Option<&MatteToken>,
) -> napi::Result<AsyncTask<MatteTask>> {
    let progress: Option<Box<dyn Fn(u32, u32) + Send + Sync>> = match on_progress {
        None => None,
        Some(f) => {
            let tsfn = f
                .build_threadsafe_function::<(u32, u32)>()
                .callee_handled::<false>()
                .build()?;
            Some(Box::new(move |done, total| {
                tsfn.call((done, total), ThreadsafeFunctionCallMode::NonBlocking);
            }))
        }
    };
    Ok(AsyncTask::new(MatteTask {
        request: Some(options),
        cancel: token.map(|t| t.flag.clone()),
        progress,
    }))
}
