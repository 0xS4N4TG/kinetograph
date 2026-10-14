//! The Node-API addon (`@kinetograph/native`): the Rust core as a Node
//! module. Scenes cross as JSON strings and pixels stay in Rust. The JS API
//! is specified in `docs/AUTHORING.md` §3.
//!
//! Orchestrator scaffolding: every export has its final signature and a
//! body that fails with "not implemented"; stream 1 (`feat/napi-addon`)
//! fills them in.

use napi::bindgen_prelude::{Buffer, Float32Array};
use napi::{Error, Result};
use napi_derive::napi;

fn not_implemented<T>(what: &str) -> Result<T> {
    Err(Error::from_reason(format!("not implemented: {what}")))
}

/// The version of the addon, which is the workspace version.
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
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
#[napi]
pub fn validate_scene(scene_json: String, base_dir: Option<String>) -> Result<SceneInfo> {
    let _ = (scene_json, base_dir);
    not_implemented("validateScene")
}

/// The scene resolved at `frame`, as an `InspectResult` JSON string.
#[napi]
pub fn inspect(scene_json: String, frame: u32, base_dir: Option<String>) -> Result<String> {
    let _ = (scene_json, frame, base_dir);
    not_implemented("inspect")
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

/// Shapes text with the renderer's text engine.
#[napi]
pub fn layout_text(request: TextLayoutRequest) -> Result<TextLayout> {
    let _ = request;
    not_implemented("layoutText")
}

/// `"10..40"` or `"10..=40"` -> `[first, last]`, inclusive.
#[napi]
pub fn parse_range(range: String, duration_in_frames: u32) -> Result<Vec<u32>> {
    let _ = (range, duration_in_frames);
    not_implemented("parseRange")
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
    pub frame: Option<u32>,
    pub runs: Option<u32>,
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
    pub width: u32,
    pub height: u32,
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

/// One GPU setup, reused for every scene and frame given to it.
#[napi]
pub struct Renderer {}

#[napi]
impl Renderer {
    #[napi(constructor)]
    pub fn new(options: Option<RendererOptions>) -> Result<Self> {
        let _ = options;
        not_implemented("Renderer")
    }

    /// One frame as a PNG.
    #[napi]
    pub fn still(
        &mut self,
        scene_json: String,
        frame: u32,
        base_dir: Option<String>,
    ) -> Result<Buffer> {
        let _ = (scene_json, frame, base_dir);
        not_implemented("Renderer.still")
    }

    /// One frame as straight-alpha sRGB RGBA8.
    #[napi]
    pub fn rgba(
        &mut self,
        scene_json: String,
        frame: u32,
        base_dir: Option<String>,
    ) -> Result<RgbaFrame> {
        let _ = (scene_json, frame, base_dir);
        not_implemented("Renderer.rgba")
    }

    /// Times one frame or successive frames, as the Rust `bench`.
    #[napi]
    pub fn bench(
        &mut self,
        scene_json: String,
        options: BenchOptions,
        base_dir: Option<String>,
    ) -> Result<BenchResult> {
        let _ = (scene_json, options, base_dir);
        not_implemented("Renderer.bench")
    }

    /// A whole JSON scene to a video, as the Rust `render`.
    #[napi]
    pub fn render(
        &mut self,
        scene_json: String,
        output: String,
        options: Option<RenderOptions>,
    ) -> Result<RenderSummary> {
        let _ = (scene_json, output, options);
        not_implemented("Renderer.render")
    }

    /// A video built frame by frame.
    #[napi]
    pub fn begin_video(&mut self, output: String, options: VideoOptions) -> Result<VideoWriter> {
        let _ = (output, options);
        not_implemented("Renderer.beginVideo")
    }
}

/// A video being written frame by frame (`Renderer.beginVideo`).
#[napi]
pub struct VideoWriter {}

#[napi]
impl VideoWriter {
    /// Renders `frame` of this scene and queues it for encoding.
    #[napi]
    pub fn push_frame(
        &mut self,
        scene_json: String,
        frame: u32,
        base_dir: Option<String>,
    ) -> Result<()> {
        let _ = (scene_json, frame, base_dir);
        not_implemented("VideoWriter.pushFrame")
    }

    /// Flushes, muxes `audio` if given, closes the file.
    #[napi]
    pub fn finish(&mut self, audio: Option<AudioPcm>) -> Result<RenderSummary> {
        let _ = audio;
        not_implemented("VideoWriter.finish")
    }

    /// Stops and deletes the partial file.
    #[napi]
    pub fn abort(&mut self) -> Result<()> {
        not_implemented("VideoWriter.abort")
    }
}
