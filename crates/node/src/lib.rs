//! The Node-API addon (`@kinetograph/native`): the Rust core as a Node
//! module. Scenes cross as JSON strings and pixels stay in Rust. The JS API
//! is specified in `docs/AUTHORING.md` §3.
//!
//! The functions that need no GPU (`validateScene`, `inspect`, `layoutText`,
//! `parseRange`, `probeMedia`, `probeStreams`, `scanStreams`, `decodeAudio`, `modelUnsupported`, `riveFrame`,
//! `version`) never open a device; `new Renderer()` does, once, and every scene given to it afterwards reuses that
//! setup.
//!
//! Every call is synchronous and runs on the JS thread. A thrown error is an
//! `Error` whose `code` is one of `error::Code`.

mod bench;
mod canvas;
mod dom;
mod error;
mod layout;
mod media;
mod preview;
mod rive;
pub mod streams;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use kinetograph_cli::encode::{AudioPcm as Pcm, Codec, Pix, Settings};
use kinetograph_cli::render::{
    SceneRequest, VideoWriter as Writer, parse_range as parse_frame_range, render_scene,
};
use kinetograph_core::scene3d::model::Model;
use kinetograph_core::{Error as CoreError, Scene};
use napi::bindgen_prelude::{Buffer, Float32Array};
use napi_derive::napi;
use serde_json::Value;

use crate::error::{Code, Result, count, error, from_core, from_render, invalid};

/// The version of the addon, which is the workspace version.
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// `baseDir`, or the current directory.
fn resolve_base(base_dir: Option<String>) -> PathBuf {
    match base_dir {
        Some(dir) => PathBuf::from(dir),
        None => std::env::current_dir().unwrap_or_default(),
    }
}

fn parse_scene(scene_json: &str, base_dir: &Path) -> Result<Scene> {
    Scene::from_json(scene_json, base_dir.to_path_buf()).map_err(from_core)
}

// ---- CPU only ----

#[napi(object)]
pub struct SceneInfo {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration_in_frames: u32,
    pub margin: u32,
}

/// Parses and validates scene JSON; asset paths resolve against `baseDir`
/// (default: the current directory).
///
/// Beyond what loading a scene checks, the files it names (fonts, images,
/// tables, Lottie files) are checked to exist, without reading them.
#[napi]
pub fn validate_scene(scene_json: String, base_dir: Option<String>) -> Result<SceneInfo> {
    let base = resolve_base(base_dir);
    let scene = parse_scene(&scene_json, &base)?;
    check_files(&scene_json, &base)?;
    Ok(SceneInfo {
        width: scene.width,
        height: scene.height,
        fps: scene.fps,
        duration_in_frames: scene.duration_in_frames,
        margin: scene.margin(),
    })
}

/// Fails with `IO` for the first file the scene names that is not there. It
/// reads the JSON rather than the loaded scene, so a file-valued field a
/// later phase adds (any layer's `src`) is covered without a change here.
fn check_files(scene_json: &str, base: &Path) -> Result<()> {
    let doc: Value = serde_json::from_str(scene_json)
        .map_err(|e| error(Code::SceneInvalid, format!("invalid scene: {e}")))?;
    let mut files = Vec::new();
    if let Some(fonts) = doc.get("fonts").and_then(Value::as_object) {
        files.extend(fonts.values().filter_map(Value::as_str));
    }
    fn layers<'a>(list: &'a Value, files: &mut Vec<&'a str>) {
        for layer in list.as_array().into_iter().flatten() {
            if let Some(src) = layer.get("src").and_then(Value::as_str) {
                files.push(src);
            }
            for effect in layer
                .get("effects")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(src) = effect.get("src").and_then(Value::as_str) {
                    files.push(src);
                }
            }
            if let Some(children) = layer.get("children") {
                layers(children, files);
            }
            if let Some(frames) = layer.get("motionBlur").and_then(|m| m.get("frames")) {
                layers(frames, files);
            }
        }
    }
    if let Some(list) = doc.get("layers") {
        layers(list, &mut files);
    }
    for file in files {
        let path = base.join(file);
        if let Err(source) = std::fs::metadata(&path) {
            return Err(from_core(CoreError::Io { path, source }));
        }
    }
    Ok(())
}

/// The scene resolved at `frame`, as an `InspectResult` JSON string.
#[napi]
pub fn inspect(scene_json: String, frame: f64, base_dir: Option<String>) -> Result<String> {
    let frame = count("frame", frame)?;
    let scene = parse_scene(&scene_json, &resolve_base(base_dir))?;
    let result = kinetograph_core::inspect::inspect(&scene, frame).map_err(from_core)?;
    serde_json::to_string(&result).map_err(|e| error(Code::Render, format!("inspect: {e}")))
}

#[napi(object)]
pub struct TextLayoutRequest {
    pub text: String,
    pub font: String,
    pub size: f64,
    pub line_height: Option<f64>,
    pub max_width: Option<f64>,
    /// `left`, `center` or `right`.
    pub align: Option<String>,
    /// Family key -> font file, as a scene's `fonts`.
    pub fonts: std::collections::HashMap<String, String>,
    pub base_dir: Option<String>,
}

#[napi(object)]
pub struct TextLine {
    pub top: f64,
    pub bottom: f64,
    pub baseline: f64,
    /// Code point indices of the line's first character and one past its last.
    pub start: u32,
    pub end: u32,
}

#[napi(object)]
pub struct TextGlyph {
    /// Index of the glyph's first code point in the text (`chars` index).
    pub char_index: u32,
    pub line: u32,
    /// The glyph origin's x and its baseline, in text-box pixels.
    pub x: f64,
    pub y: f64,
    pub advance: f64,
}

#[napi(object)]
pub struct TextLayout {
    pub width: f64,
    pub height: f64,
    pub lines: Vec<TextLine>,
    pub glyphs: Vec<TextGlyph>,
}

/// Shapes text with the renderer's text engine. Engines are cached per
/// `fonts` map.
#[napi]
pub fn layout_text(request: TextLayoutRequest) -> Result<TextLayout> {
    layout::layout_text(&request)
}

/// `"10..40"` or `"10..=40"` -> `[first, last]`, inclusive.
#[napi]
pub fn parse_range(range: String, duration_in_frames: f64) -> Result<Vec<u32>> {
    let duration = count("durationInFrames", duration_in_frames)?;
    let (first, last) = parse_frame_range(&range, duration).map_err(invalid)?;
    Ok(vec![first, last])
}

/// What `probeMedia` reads from a video's or GIF's header (docs/AUTHORING.md §11.2).
#[napi(object)]
pub struct MediaInfo {
    /// `video` or `gif`.
    pub kind: String,
    pub width: u32,
    pub height: u32,
    pub duration_in_seconds: f64,
    /// A video stream's average frame rate; `null` for a GIF.
    pub fps: Option<f64>,
    /// The container's picture count, if it has one; a GIF's picture count.
    pub frames: Option<u32>,
    pub has_audio: bool,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
}

/// Reads a video's or GIF's header, without decoding a picture.
#[napi]
pub fn probe_media(path: String, base_dir: Option<String>) -> Result<MediaInfo> {
    media::probe_media(&resolve_base(base_dir).join(path))
}

/// The first audio stream of a file, decoded and resampled to `sampleRate`;
/// `null` when the file has none.
#[napi]
pub fn decode_audio(
    path: String,
    sample_rate: f64,
    base_dir: Option<String>,
) -> Result<Option<AudioPcm>> {
    let sample_rate = count("sampleRate", sample_rate)?;
    media::decode_audio(&resolve_base(base_dir).join(path), sample_rate)
}

/// A glTF feature a model file uses that the 3D layer does not read.
#[napi(object)]
pub struct ModelUnsupported {
    pub feature: String,
    pub reason: String,
}

/// Reads a glTF or GLB model and lists what it uses that the 3D layer does not
/// read (docs/SCENE.md, "scene3d"); a file that cannot be read is an error.
#[napi]
pub fn model_unsupported(src: String, base_dir: Option<String>) -> Result<Vec<ModelUnsupported>> {
    // Only the glTF's JSON and buffers are read: the pictures are not decoded.
    let unsupported =
        Model::unsupported_features(&resolve_base(base_dir), &src).map_err(from_core)?;
    Ok(unsupported
        .into_iter()
        .map(|u| ModelUnsupported {
            feature: u.feature,
            reason: u.reason,
        })
        .collect())
}

/// CSS block and flex layout of one DOM island: a
/// `DomLayoutRequest` as JSON in, a `DomLayoutBox` as JSON out.
#[napi]
pub fn layout_dom(request_json: String) -> Result<String> {
    dom::layout_dom(&request_json)
}

/// One DOM island at one frame (docs/ENGINE.md §2): an `IslandRequest` as
/// JSON in, an `IslandOutput` (`layers`, `unsupported`, `camera`) as JSON out.
/// Styled and laid out by Stylo, taffy and Parley through Blitz's DOM, then
/// painted as scene layers. CPU only.
#[napi]
pub fn render_dom_island(request_json: String, pass: Option<u32>) -> Result<String> {
    dom::render_dom_island(&request_json, pass.map(u64::from))
}

/// `renderDomIsland` without waiting: queues the render on the calling
/// thread's island thread, after the renders queued before it, and returns a
/// ticket for `finishDomIsland`, which gives its output once it is done.
#[napi]
pub fn start_dom_island(request_json: String, pass: Option<u32>) -> Result<u32> {
    dom::start_island(&request_json, pass.map(u64::from))
}

/// The output of a render `startDomIsland` queued, waiting for it if it is not
/// done yet.
#[napi]
pub fn finish_dom_island(ticket: u32) -> Result<String> {
    dom::finish_island(ticket)
}

/// The boxes of every element of a DOM island (docs/ENGINE.md §2): an
/// `IslandRequest` as JSON in, `{ [path]: { x, y, width, height, rect, client,
/// scroll } }` as JSON out. `x`..`height` are the border box where layout put
/// it, `rect` the transformed bounding box `getBoundingClientRect` gives.
#[napi]
pub fn dom_layout_boxes(request_json: String) -> Result<String> {
    dom::dom_layout_boxes(&request_json)
}

/// `getComputedStyle` of the element at `path` in a DOM island: the resolved
/// value of each property (CSS or camelCase names), `""` for an unknown one.
#[napi]
pub fn dom_computed_style(
    request_json: String,
    path: String,
    properties: Vec<String>,
) -> Result<Vec<String>> {
    dom::dom_computed_style(&request_json, &path, &properties)
}

/// A Rive file (`.riv`) played to a time, as the commands of a canvas layer
/// (docs/AUTHORING.md §7.6): `{ src, baseDir, artboard, animation, stateMachine,
/// time, width, height, fit, alignment }` as JSON in, the commands as a JSON
/// array out. CPU only; the file is read once.
#[napi]
pub fn rive_frame(request_json: String) -> Result<String> {
    rive::rive_frame(&request_json)
}

// ---- GPU ----

/// A Canvas 2D context's commands drawn on a transparent canvas (docs/SCENE.md,
/// "canvas"): `{ width, height, commands, fonts, baseDir, format }` as JSON in,
/// straight-alpha RGBA (`format: "rgba"`, the default) or a PNG out. For
/// `getImageData` and `toDataURL`; opens the GPU for each call.
#[napi]
pub fn render_canvas(request_json: String) -> Result<Buffer> {
    canvas::render_canvas(&request_json)
}

#[napi(object)]
pub struct RendererOptions {
    /// Default true.
    pub layer_cache: Option<bool>,
}

#[napi(object)]
#[derive(Clone, Copy)]
pub struct Stats {
    pub mean: f64,
    pub min: f64,
    pub max: f64,
}

#[napi(object)]
pub struct BenchStages {
    /// Parsing and validating the JSON and swapping it into the renderer.
    pub handoff: Stats,
    pub resolve: Stats,
    pub raster: Stats,
    pub composite: Stats,
    pub readback: Stats,
    pub total: Stats,
}

#[napi(object)]
pub struct BenchFrame {
    pub frame: u32,
    pub total_ms: f64,
    pub layers_reused: u32,
    pub layers_drawn: u32,
}

#[napi(object)]
pub struct BenchResult {
    pub frame: Option<u32>,
    pub runs: u32,
    pub stages: BenchStages,
    pub frames: Option<Vec<BenchFrame>>,
}

#[napi(object)]
pub struct BenchOptions {
    pub frame: Option<f64>,
    pub runs: Option<f64>,
    pub range: Option<String>,
}

#[napi(object)]
pub struct AudioPcm {
    pub sample_rate: u32,
    /// One array per channel, equal lengths, samples in -1..1.
    pub channels: Vec<Float32Array>,
}

/// `render`'s export options (docs/AUTHORING.md §9); everything left out takes its default.
#[napi(object)]
pub struct ExportOptions {
    /// `h264` (default; `vp9` for `.webm` and `gif` for `.gif` paths), `h265`, `prores`, `vp9` or `gif`.
    pub codec: Option<String>,
    /// An ffmpeg encoder name.
    pub encoder: Option<String>,
    /// Constant quality, lower is better. Not with `videoBitrate`.
    pub crf: Option<f64>,
    /// Bits per second.
    pub video_bitrate: Option<f64>,
    /// `yuv420p`, `yuv422p`, `yuv444p`, `yuv420p10le`, `yuv422p10le` or `yuv444p10le`.
    pub pixel_format: Option<String>,
    /// `proxy`, `light`, `standard`, `hq`, `4444` or `4444-xq`.
    pub prores_profile: Option<String>,
    /// `aac`, `opus` or `pcm`.
    pub audio_codec: Option<String>,
    /// Bits per second.
    pub audio_bitrate: Option<f64>,
    /// GIF only: the frames given are every nth of the composition's, and play at the frame rate over n.
    pub every_nth_frame: Option<f64>,
}

/// What `resolveExport` decided.
#[napi(object)]
pub struct ExportPlan {
    pub codec: String,
    pub encoder: String,
    /// The container: `mp4`, `mov`, `webm` or `gif`.
    pub container: String,
    /// The pixel format of the file.
    pub pixel_format: String,
    /// The format `rgbaToYuv` has to convert to for this encoder (it differs from `pixelFormat` for hardware ProRes).
    pub convert_format: String,
    /// `aac`, `opus` or `pcm`; absent for a GIF.
    pub audio_codec: Option<String>,
}

#[napi(object)]
pub struct VideoOptions {
    pub width: f64,
    pub height: f64,
    pub fps: f64,
    pub encoder: Option<String>,
    pub export: Option<ExportOptions>,
}

#[napi(object)]
pub struct RenderOptions {
    pub range: Option<String>,
    pub encoder: Option<String>,
    pub export: Option<ExportOptions>,
    pub audio: Option<AudioPcm>,
    pub base_dir: Option<String>,
}

#[napi(object)]
pub struct RenderSummary {
    pub output: String,
    pub encoder: String,
    pub codec: String,
    pub pixel_format: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub frames: u32,
    pub first: u32,
    pub last: u32,
    pub ms: f64,
    pub ms_per_frame: f64,
    pub audio: bool,
    /// Frames not drawn because they were the same as the frame before
    /// (`KINETOGRAPH_NO_REUSE=1` turns that off).
    pub repeated: u32,
}

#[napi(object)]
pub struct RgbaFrame {
    pub width: u32,
    pub height: u32,
    /// Straight-alpha sRGB RGBA8, `width * height * 4` bytes.
    pub data: Buffer,
    /// `finishFrame`: the frame was not drawn because it is the same as the
    /// frame started before it, so `data` is that frame's.
    pub repeated: bool,
}

#[napi(object)]
#[derive(Default)]
pub struct PreviewOptions {
    /// 0 < scale <= 1, default 1.
    pub scale: Option<f64>,
    /// `jpeg` (default) or `png`.
    pub format: Option<String>,
    /// JPEG quality 1..=100, default 80.
    pub quality: Option<f64>,
}

#[napi(object)]
pub struct PreviewImage {
    pub width: u32,
    pub height: u32,
    /// `image/jpeg` or `image/png`.
    pub mime: String,
    pub data: Buffer,
}

impl From<kinetograph_cli::render::RenderSummary> for RenderSummary {
    fn from(s: kinetograph_cli::render::RenderSummary) -> Self {
        RenderSummary {
            output: s.output.to_string_lossy().into_owned(),
            encoder: s.encoder,
            codec: s.codec.to_string(),
            pixel_format: s.pixel_format.to_string(),
            width: s.width,
            height: s.height,
            fps: s.fps,
            frames: s.frames,
            first: s.first,
            last: s.last,
            ms: s.ms,
            ms_per_frame: s.ms_per_frame,
            audio: s.audio,
            repeated: s.repeated,
        }
    }
}

/// The channels of `audio` as slices, for the encoder.
fn channels(audio: &AudioPcm) -> Vec<&[f32]> {
    audio.channels.iter().map(|c| &**c).collect()
}

/// The planes (Y, U, V for `yuv420p`, the default; rows packed) the encoder
/// would make of a straight-alpha RGBA8 frame, converted on the calling
/// thread. A render worker converts its own frames so that one encoder thread
/// only sends them (`VideoWriter.pushYuv`). `pixelFormat` is the plan's
/// `convertFormat` (`resolveExport`).
#[napi]
pub fn rgba_to_yuv(
    rgba: Buffer,
    width: f64,
    height: f64,
    pixel_format: Option<String>,
) -> Result<Buffer> {
    let (width, height) = (count("width", width)?, count("height", height)?);
    let pix = match pixel_format {
        Some(name) => Pix::parse(&name).map_err(invalid)?,
        None => Pix::Yuv420p,
    };
    kinetograph_cli::encode::rgba_to_planes(&rgba, width, height, pix)
        .map(Buffer::from)
        .map_err(invalid)
}

/// Stage times in ms since the last call, for profiling (off unless `KINETOGRAPH_PROFILE` is set, then empty): this
/// thread's stages, emptied by the call, and with `shared` also the encoder thread's totals so far.
#[napi]
pub fn take_profile(shared: Option<bool>) -> std::collections::HashMap<String, f64> {
    let mut out: std::collections::HashMap<String, f64> = kinetograph_core::profile::take_local()
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
    if shared == Some(true) {
        out.extend(
            kinetograph_core::profile::shared()
                .into_iter()
                .map(|(k, v)| (k.to_string(), v)),
        );
    }
    out
}

/// The settings of `options` (and the older `encoder`) as the encoder takes them.
fn settings_of(encoder: Option<String>, export: Option<ExportOptions>) -> Result<Settings> {
    let mut settings = Settings {
        encoder,
        ..Settings::default()
    };
    if let Some(e) = export {
        settings.codec = e
            .codec
            .as_deref()
            .map(Codec::parse)
            .transpose()
            .map_err(invalid)?;
        if e.encoder.is_some() {
            settings.encoder = e.encoder;
        }
        settings.crf = e.crf;
        settings.video_bitrate = e
            .video_bitrate
            .map(|b| count("videoBitrate", b).map(|b| b as usize))
            .transpose()?;
        settings.pixel_format = e.pixel_format;
        settings.prores_profile = e.prores_profile;
        settings.audio_codec = e.audio_codec;
        settings.audio_bitrate = e
            .audio_bitrate
            .map(|b| count("audioBitrate", b).map(|b| b as usize))
            .transpose()?;
        settings.every_nth_frame = e
            .every_nth_frame
            .map(|n| count("everyNthFrame", n))
            .transpose()?;
    }
    Ok(settings)
}

/// Checks the export options against the output path and this machine's ffmpeg, and says what will be written:
/// the codec, the encoder, the container and the pixel format. Throws `INVALID_ARG` with what to change.
#[napi]
pub fn resolve_export(output: String, options: Option<ExportOptions>) -> Result<ExportPlan> {
    let settings = settings_of(None, options)?;
    let plan = kinetograph_cli::encode::resolve(
        &settings,
        Path::new(&output),
        cfg!(target_os = "macos"),
        kinetograph_cli::encode::has_encoder,
    )
    .map_err(invalid)?;
    Ok(ExportPlan {
        codec: plan.codec.name().to_string(),
        encoder: plan.encoder,
        container: plan.container.to_string(),
        pixel_format: plan.pix.file_name().to_string(),
        convert_format: plan.pix.name().to_string(),
        audio_codec: plan.audio_codec.map(|a| a.name().to_string()),
    })
}

/// A scene that opens the GPU and nothing else: `new Renderer()` has no scene
/// yet, and the renderer is made with one.
const EMPTY_SCENE: &str =
    r#"{ "width": 16, "height": 16, "fps": 30, "durationInFrames": 1, "layers": [] }"#;

/// What a `Renderer` and the `VideoWriter`s it makes share.
struct Shared {
    gpu: Mutex<kinetograph_core::Renderer>,
    /// A video is being written: the renderer is busy with its frames, which
    /// are collected one call late, so nothing else may draw until it ends.
    video_open: AtomicBool,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, kinetograph_core::Renderer> {
        self.gpu.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The renderer, for a call of the `Renderer` itself.
    fn idle(&self) -> Result<MutexGuard<'_, kinetograph_core::Renderer>> {
        if self.video_open.load(Ordering::SeqCst) {
            return Err(invalid(
                "a video is being written (beginVideo): finish or abort it first",
            ));
        }
        Ok(self.lock())
    }
}

/// One GPU setup, reused for every scene and frame given to it.
#[napi]
pub struct Renderer {
    shared: Arc<Shared>,
    layer_cache: bool,
    /// Frames `startFrame` queued that `finishFrame` has not collected, oldest first: what each will send when the
    /// frame is started.
    started: std::collections::VecDeque<std::sync::mpsc::Receiver<Result<kinetograph_core::PendingFrame>>>,
    /// The thread that starts frames (parses their scene, builds and submits their GPU work) while the caller
    /// goes on to the JS of the next one; started with the first frame.
    starter: Option<std::sync::mpsc::Sender<StartJob>>,
}

/// Whether `startFrame` waits for the frame to be started (`KINETOGRAPH_SYNC_START=1`).
fn sync_start() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("KINETOGRAPH_SYNC_START").is_some())
}

/// What the starter thread does, in the order it is given.
enum StartJob {
    Start {
        scene_json: String,
        frame: u32,
        base_dir: PathBuf,
        done: std::sync::mpsc::Sender<Result<kinetograph_core::PendingFrame>>,
        caller: String,
    },
    Forget,
}

/// The starter thread of a renderer: it ends when the renderer's sender is dropped.
fn spawn_starter(shared: Arc<Shared>) -> std::sync::mpsc::Sender<StartJob> {
    let (jobs, queue) = std::sync::mpsc::channel::<StartJob>();
    std::thread::Builder::new()
        .name("kinetograph-start".to_string())
        .spawn(move || {
            for job in queue {
                match job {
                    StartJob::Start {
                        scene_json,
                        frame,
                        base_dir,
                        done,
                        caller,
                    } => {
                        let started = (|| {
                            let timer = kinetograph_core::profile::start();
                            let scene = parse_scene(&scene_json, &base_dir)?;
                            kinetograph_core::profile::add_since("parse", timer);
                            let mut gpu = shared.idle()?;
                            let timer = kinetograph_core::profile::start();
                            gpu.set_scene(scene).map_err(from_core)?;
                            kinetograph_core::profile::add_since("set_scene", timer);
                            gpu.start_frame(frame).map_err(from_core)
                        })();
                        kinetograph_core::profile::forward(&caller);
                        let _ = done.send(started);
                    }
                    StartJob::Forget => shared.lock().forget_frame(),
                }
            }
        })
        .expect("cannot start the frame starter thread");
    jobs
}

#[napi]
impl Renderer {
    /// Opens the GPU and builds the pipelines, once.
    #[napi(constructor)]
    pub fn new(options: Option<RendererOptions>) -> Result<Self> {
        let layer_cache = options.and_then(|o| o.layer_cache).unwrap_or(true);
        let scene = Scene::from_json(EMPTY_SCENE, PathBuf::new()).map_err(from_core)?;
        let mut gpu = kinetograph_core::Renderer::new(scene).map_err(from_core)?;
        gpu.set_layer_cache(layer_cache);
        // Frames one after the other, as the layer cache is for: one that is
        // the same as the last is not drawn again (`KINETOGRAPH_NO_REUSE=1`
        // turns that off).
        gpu.set_frame_reuse(layer_cache && kinetograph_core::reuse::allowed_by_env());
        Ok(Renderer {
            shared: Arc::new(Shared {
                gpu: Mutex::new(gpu),
                video_open: AtomicBool::new(false),
            }),
            layer_cache,
            started: std::collections::VecDeque::new(),
            starter: None,
        })
    }

    /// One frame as a PNG.
    #[napi]
    pub fn still(
        &mut self,
        scene_json: String,
        frame: f64,
        base_dir: Option<String>,
    ) -> Result<Buffer> {
        let frame = count("frame", frame)?;
        let scene = parse_scene(&scene_json, &resolve_base(base_dir))?;
        let mut gpu = self.shared.idle()?;
        gpu.set_scene(scene).map_err(from_core)?;
        let png = gpu
            .render_frame(frame)
            .and_then(|f| f.encode_png())
            .map_err(from_core)?;
        Ok(Buffer::from(png))
    }

    /// One frame rendered at full size, box-filtered down to `scale` and
    /// encoded as JPEG or PNG, for the studio's preview.
    #[napi]
    pub fn preview(
        &mut self,
        scene_json: String,
        frame: f64,
        options: Option<PreviewOptions>,
        base_dir: Option<String>,
    ) -> Result<PreviewImage> {
        let frame = count("frame", frame)?;
        let options = options.unwrap_or_default();
        let scene = parse_scene(&scene_json, &resolve_base(base_dir))?;
        let mut gpu = self.shared.idle()?;
        gpu.set_scene(scene).map_err(from_core)?;
        let rendered = gpu.render_frame(frame).map_err(from_core)?;
        preview::preview(&rendered.rgba, rendered.width, rendered.height, &options)
    }

    /// One frame as straight-alpha sRGB RGBA8.
    #[napi]
    pub fn rgba(
        &mut self,
        scene_json: String,
        frame: f64,
        base_dir: Option<String>,
    ) -> Result<RgbaFrame> {
        let frame = count("frame", frame)?;
        let scene = parse_scene(&scene_json, &resolve_base(base_dir))?;
        let mut gpu = self.shared.idle()?;
        gpu.set_scene(scene).map_err(from_core)?;
        let rendered = gpu.render_frame(frame).map_err(from_core)?;
        Ok(RgbaFrame {
            width: rendered.width,
            height: rendered.height,
            data: Buffer::from(rendered.rgba),
            repeated: false,
        })
    }

    /// Starts drawing a frame without waiting for it: a thread of its own parses the scene and starts the GPU
    /// on it while the caller does other things (the JS of the next frame), and `finishFrame` collects the
    /// frames in the order they were started. A scene that cannot be drawn is reported by the `finishFrame` of
    /// its frame. Call `finishFrame` for the frame before starting the next, or the two wait for each other's
    /// use of the GPU renderer.
    #[napi]
    pub fn start_frame(
        &mut self,
        scene_json: String,
        frame: f64,
        base_dir: Option<String>,
    ) -> Result<()> {
        let frame = count("frame", frame)?;
        let base_dir = resolve_base(base_dir);
        let shared = self.shared.clone();
        let starter = self
            .starter
            .get_or_insert_with(|| spawn_starter(shared));
        let (done, result) = std::sync::mpsc::channel();
        starter
            .send(StartJob::Start {
                scene_json,
                frame,
                base_dir,
                done,
                caller: kinetograph_core::profile::caller(),
            })
            .map_err(|_| error(Code::Render, "the frame starter thread has stopped"))?;
        if sync_start() {
            // The frame is started before this call returns (`KINETOGRAPH_SYNC_START=1`, for comparing).
            let started = result
                .recv()
                .map_err(|_| error(Code::Render, "the frame starter thread has stopped"))?;
            let (done, ready) = std::sync::mpsc::channel();
            let _ = done.send(started);
            self.started.push_back(ready);
        } else {
            self.started.push_back(result);
        }
        Ok(())
    }

    /// The oldest frame `startFrame` began, as straight-alpha sRGB RGBA8.
    #[napi]
    pub fn finish_frame(&mut self) -> Result<RgbaFrame> {
        let result = self
            .started
            .pop_front()
            .ok_or_else(|| invalid("no frame was started (startFrame)"))?;
        let pending = result
            .recv()
            .map_err(|_| error(Code::Render, "the frame starter thread has stopped"))??;
        let mut gpu = self.shared.idle()?;
        let repeated = pending.is_repeat();
        let rendered = gpu.finish_frame(pending).map_err(from_core)?;
        Ok(RgbaFrame {
            width: rendered.width,
            height: rendered.height,
            data: Buffer::from(rendered.rgba),
            repeated,
        })
    }

    /// Makes the next frame `startFrame` begins be drawn, whatever the frame
    /// before it was: a frame is only taken from a frame started after this.
    /// A render worker calls it at the start of each run of frames.
    #[napi]
    pub fn forget_frame(&mut self) -> Result<()> {
        match &self.starter {
            // After the frames already queued, which it must not forget the other way round.
            Some(starter) => starter
                .send(StartJob::Forget)
                .map_err(|_| error(Code::Render, "the frame starter thread has stopped")),
            None => {
                self.shared.idle()?.forget_frame();
                Ok(())
            }
        }
    }

    /// Times one frame or successive frames, as the Rust `bench`.
    #[napi]
    pub fn bench(
        &mut self,
        scene_json: String,
        options: BenchOptions,
        base_dir: Option<String>,
    ) -> Result<BenchResult> {
        let base = resolve_base(base_dir);
        let mut gpu = self.shared.idle()?;
        bench::bench(&mut gpu, &scene_json, &options, &base, self.layer_cache)
    }

    /// A whole JSON scene to a video, as the Rust `render`.
    #[napi]
    pub fn render(
        &mut self,
        scene_json: String,
        output: String,
        options: Option<RenderOptions>,
    ) -> Result<RenderSummary> {
        let (range, settings, audio, base) = match options {
            Some(o) => (
                o.range,
                settings_of(o.encoder, o.export)?,
                o.audio,
                resolve_base(o.base_dir),
            ),
            None => (None, Settings::default(), None, resolve_base(None)),
        };
        let scene = parse_scene(&scene_json, &base)?;
        let chans = audio.as_ref().map(channels);
        let request = SceneRequest {
            output: Path::new(&output),
            range: range.as_deref(),
            settings: &settings,
            audio: audio.as_ref().zip(chans.as_deref()).map(|(a, c)| Pcm {
                sample_rate: a.sample_rate,
                channels: c,
            }),
        };
        let mut gpu = self.shared.idle()?;
        let summary = render_scene(&mut gpu, scene, &request, |_, _| {}).map_err(from_render)?;
        Ok(summary.into())
    }

    /// A video built frame by frame.
    #[napi]
    pub fn begin_video(&mut self, output: String, options: VideoOptions) -> Result<VideoWriter> {
        let width = count("width", options.width)?;
        let height = count("height", options.height)?;
        let settings = settings_of(options.encoder, options.export)?;
        if self
            .shared
            .video_open
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(invalid(
                "a video is already being written: finish or abort it first",
            ));
        }
        match Writer::open(Path::new(&output), width, height, options.fps, &settings) {
            Ok(writer) => Ok(VideoWriter {
                shared: self.shared.clone(),
                writer: Arc::new(Mutex::new(Some(writer))),
                pusher: None,
                failed: Arc::new(Mutex::new(None)),
                last_pushed: None,
            }),
            Err(e) => {
                self.shared.video_open.store(false, Ordering::SeqCst);
                Err(from_render(e))
            }
        }
    }
}

/// A video being written frame by frame (`Renderer.beginVideo`).
///
/// A failed `pushFrame` ends the video: the partial file is deleted, as
/// `abort` does, and later calls fail. `pushFrame` returns once the frame is queued: a thread of the writer's own
/// parses the scene, draws the frame and hands the one before it to the encoder while the caller goes on to the
/// JS of the next frame, so a frame that fails is reported by a later call (`pushFrame`, `finish`).
#[napi]
pub struct VideoWriter {
    shared: Arc<Shared>,
    writer: Arc<Mutex<Option<Writer>>>,
    /// The queue of the thread that draws the frames (started by the first `pushFrame`), and what the first
    /// frame that failed said.
    pusher: Option<std::sync::mpsc::SyncSender<PushJob>>,
    failed: Arc<Mutex<Option<(Code, String)>>>,
    /// The last frame number pushed: frames must come in increasing order, which is checked as they are pushed.
    last_pushed: Option<u32>,
}

/// What a writer's thread does, in order.
enum PushJob {
    Push {
        scene_json: String,
        frame: u32,
        base_dir: PathBuf,
        caller: String,
    },
    /// Answers once the jobs before it are done.
    Sync(std::sync::mpsc::Sender<()>),
}

/// The thread of a `VideoWriter`: it ends when the writer's sender is dropped.
fn spawn_pusher(
    shared: Arc<Shared>,
    writer: Arc<Mutex<Option<Writer>>>,
    failed: Arc<Mutex<Option<(Code, String)>>>,
) -> std::sync::mpsc::SyncSender<PushJob> {
    // A frame or two ahead of the thread, no more: the caller waits when the thread is behind.
    let (jobs, queue) = std::sync::mpsc::sync_channel::<PushJob>(2);
    std::thread::Builder::new()
        .name("kinetograph-write".to_string())
        .spawn(move || {
            for job in queue {
                match job {
                    PushJob::Push {
                        scene_json,
                        frame,
                        base_dir,
                        caller,
                    } => {
                        if failed.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
                            continue;
                        }
                        let pushed = (|| {
                            let timer = kinetograph_core::profile::start();
                            let scene = parse_scene(&scene_json, &base_dir)?;
                            kinetograph_core::profile::add_since("parse", timer);
                            let mut writer = writer.lock().unwrap_or_else(|e| e.into_inner());
                            let writer = writer.as_mut().ok_or_else(|| {
                                invalid("the video was already finished or aborted")
                            })?;
                            let mut gpu = shared.lock();
                            writer
                                .push_frame(&mut gpu, scene, frame)
                                .map_err(from_render)
                        })();
                        kinetograph_core::profile::forward(&caller);
                        if let Err(e) = pushed {
                            failed
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .get_or_insert((e.status, e.reason.clone()));
                        }
                    }
                    PushJob::Sync(done) => {
                        let _ = done.send(());
                    }
                }
            }
        })
        .expect("cannot start the video writer thread");
    jobs
}

impl VideoWriter {
    /// Waits for the frames queued so far to be drawn.
    fn sync(&self) {
        if let Some(pusher) = &self.pusher {
            let (done, wait) = std::sync::mpsc::channel();
            if pusher.send(PushJob::Sync(done)).is_ok() {
                let _ = wait.recv();
            }
        }
    }

    /// The first failure of a queued frame, if there was one.
    fn failure(&self) -> Option<crate::error::Error> {
        self.failed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .map(|(code, message)| error(code, message))
    }

    /// Ends the video, deleting the partial file, and frees the renderer.
    fn close(&mut self) {
        // Frames still queued fail on finding no writer.
        self.pusher = None;
        *self.writer.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.shared.video_open.store(false, Ordering::SeqCst);
    }
}

impl Drop for VideoWriter {
    fn drop(&mut self) {
        self.close();
    }
}

#[napi]
impl VideoWriter {
    /// Queues `frame` of this scene to be rendered and encoded.
    #[napi]
    pub fn push_frame(
        &mut self,
        scene_json: String,
        frame: f64,
        base_dir: Option<String>,
    ) -> Result<()> {
        let queued = (|| {
            if let Some(e) = self.failure() {
                return Err(e);
            }
            if self
                .writer
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_none()
            {
                return Err(invalid("the video was already finished or aborted"));
            }
            let frame = count("frame", frame)?;
            if let Some(last) = self.last_pushed.filter(|&last| frame <= last) {
                return Err(invalid(format!(
                    "frames must come in increasing order: {frame} after {last}"
                )));
            }
            let (shared, writer, failed) =
                (self.shared.clone(), self.writer.clone(), self.failed.clone());
            let pusher = self
                .pusher
                .get_or_insert_with(|| spawn_pusher(shared, writer, failed));
            pusher
                .send(PushJob::Push {
                    scene_json,
                    frame,
                    base_dir: resolve_base(base_dir),
                    caller: kinetograph_core::profile::caller(),
                })
                .map_err(|_| error(Code::Render, "the video writer thread has stopped"))?;
            self.last_pushed = Some(frame);
            if sync_start() {
                // The frame is drawn before this call returns (`KINETOGRAPH_SYNC_START=1`, for comparing).
                self.sync();
                if let Some(e) = self.failure() {
                    return Err(e);
                }
            }
            Ok(())
        })();
        if queued.is_err() {
            self.close();
        }
        queued
    }

    /// Queues a frame that `rgbaToYuv` converted (in a render worker).
    #[napi]
    pub fn push_yuv(&mut self, yuv: Buffer, frame: f64) -> Result<()> {
        self.sync();
        let pushed = (|| {
            if let Some(e) = self.failure() {
                return Err(e);
            }
            let frame = count("frame", frame)?;
            self.writer
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_mut()
                .ok_or_else(|| invalid("the video was already finished or aborted"))?
                .push_converted(frame, yuv.to_vec())
                .map_err(from_render)
        })();
        if pushed.is_err() {
            self.close();
        }
        pushed
    }

    /// Flushes, muxes `audio` if given, closes the file.
    #[napi]
    pub fn finish(&mut self, audio: Option<AudioPcm>) -> Result<RenderSummary> {
        self.sync();
        if let Some(e) = self.failure() {
            self.close();
            return Err(e);
        }
        let writer = self
            .writer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .ok_or_else(|| invalid("the video was already finished or aborted"))?;
        let chans = audio.as_ref().map(channels);
        let pcm = audio.as_ref().zip(chans.as_deref()).map(|(a, c)| Pcm {
            sample_rate: a.sample_rate,
            channels: c,
        });
        let shared = self.shared.clone();
        let summary = writer.finish(&mut shared.lock(), pcm.as_ref());
        self.close();
        summary.map(Into::into).map_err(from_render)
    }

    /// Stops and deletes the partial file.
    #[napi]
    pub fn abort(&mut self) -> Result<()> {
        self.close();
        Ok(())
    }
}
