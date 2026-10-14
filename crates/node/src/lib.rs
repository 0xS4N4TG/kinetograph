//! The Node-API addon (`@kinetograph/native`): the Rust core as a Node
//! module. Scenes cross as JSON strings and pixels stay in Rust. The JS API
//! is specified in `docs/AUTHORING.md` §3.
//!
//! The functions that need no GPU (`validateScene`, `inspect`, `layoutText`,
//! `parseRange`, `version`) never open a device; `new Renderer()` does, once,
//! and every scene given to it afterwards reuses that setup.
//!
//! Every call is synchronous and runs on the JS thread. A thrown error is an
//! `Error` whose `code` is one of `error::Code`.

mod bench;
mod error;
mod layout;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use kinetograph_cli::encode::AudioPcm as Pcm;
use kinetograph_cli::render::{
    SceneRequest, VideoWriter as Writer, parse_range as parse_frame_range, render_scene,
};
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

// ---- GPU ----

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

#[napi(object)]
pub struct VideoOptions {
    pub width: f64,
    pub height: f64,
    pub fps: f64,
    pub encoder: Option<String>,
}

#[napi(object)]
pub struct RenderOptions {
    pub range: Option<String>,
    pub encoder: Option<String>,
    pub audio: Option<AudioPcm>,
    pub base_dir: Option<String>,
}

#[napi(object)]
pub struct RenderSummary {
    pub output: String,
    pub encoder: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub frames: u32,
    pub first: u32,
    pub last: u32,
    pub ms: f64,
    pub ms_per_frame: f64,
    pub audio: bool,
}

#[napi(object)]
pub struct RgbaFrame {
    pub width: u32,
    pub height: u32,
    /// Straight-alpha sRGB RGBA8, `width * height * 4` bytes.
    pub data: Buffer,
}

impl From<kinetograph_cli::render::RenderSummary> for RenderSummary {
    fn from(s: kinetograph_cli::render::RenderSummary) -> Self {
        RenderSummary {
            output: s.output.to_string_lossy().into_owned(),
            encoder: s.encoder,
            width: s.width,
            height: s.height,
            fps: s.fps,
            frames: s.frames,
            first: s.first,
            last: s.last,
            ms: s.ms,
            ms_per_frame: s.ms_per_frame,
            audio: s.audio,
        }
    }
}

/// The channels of `audio` as slices, for the encoder.
fn channels(audio: &AudioPcm) -> Vec<&[f32]> {
    audio.channels.iter().map(|c| &**c).collect()
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
        Ok(Renderer {
            shared: Arc::new(Shared {
                gpu: Mutex::new(gpu),
                video_open: AtomicBool::new(false),
            }),
            layer_cache,
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
        })
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
        let (range, encoder, audio, base) = match options {
            Some(o) => (o.range, o.encoder, o.audio, resolve_base(o.base_dir)),
            None => (None, None, None, resolve_base(None)),
        };
        let scene = parse_scene(&scene_json, &base)?;
        let chans = audio.as_ref().map(channels);
        let request = SceneRequest {
            output: Path::new(&output),
            range: range.as_deref(),
            encoder: encoder.as_deref(),
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
        match Writer::open(
            Path::new(&output),
            width,
            height,
            options.fps,
            options.encoder.as_deref(),
        ) {
            Ok(writer) => Ok(VideoWriter {
                shared: self.shared.clone(),
                writer: Some(writer),
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
/// `abort` does, and later calls fail.
#[napi]
pub struct VideoWriter {
    shared: Arc<Shared>,
    writer: Option<Writer>,
}

impl VideoWriter {
    /// Ends the video, deleting the partial file, and frees the renderer.
    fn close(&mut self) {
        self.writer = None;
        self.shared.video_open.store(false, Ordering::SeqCst);
    }

    fn writer(&mut self) -> Result<&mut Writer> {
        self.writer
            .as_mut()
            .ok_or_else(|| invalid("the video was already finished or aborted"))
    }
}

impl Drop for VideoWriter {
    fn drop(&mut self) {
        self.close();
    }
}

#[napi]
impl VideoWriter {
    /// Renders `frame` of this scene and queues it for encoding.
    #[napi]
    pub fn push_frame(
        &mut self,
        scene_json: String,
        frame: f64,
        base_dir: Option<String>,
    ) -> Result<()> {
        let pushed = (|| {
            let frame = count("frame", frame)?;
            let scene = parse_scene(&scene_json, &resolve_base(base_dir))?;
            let shared = self.shared.clone();
            let mut gpu = shared.lock();
            self.writer()?
                .push_frame(&mut gpu, scene, frame)
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
        let writer = self
            .writer
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
