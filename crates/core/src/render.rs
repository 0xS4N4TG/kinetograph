//! Scene -> pixels. Skia draws the 2D layers of a frame (`render/skia.rs`); the wgpu path draws what Skia does not
//! (3D, shaders, mesh gradients) and the compositor blends in linear light.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};

use glam::{DMat3, DMat4, DVec3};
use image::{ExtendedColorType, ImageEncoder, codecs::png::PngEncoder};
use kurbo::{Affine, BezPath, Ellipse, Point, Rect, RoundedRect, Shape};
use peniko::{Blob, ImageAlphaType, ImageData, ImageFormat};

use crate::blur::MIN_RADIUS;
use crate::bounds::{self, PixelRect};
use crate::box_shadow::BoxShadow;
use crate::cache::{self, Inputs, LayerCache};
use crate::canvas;
use crate::compositor::{BLEND_SLOTS, BlendLayer, Compositor, Readback, Tex};
use crate::error::{Error, Result};
use crate::gif::{Gif, Gifs, gif_sources, open_gif};
use crate::lottie::{Lottie, Lotties, lottie_sources, open_lottie};
use crate::lut::Lut;
use crate::mesh;
use crate::resolve::{
    ResolvedChar, ResolvedClip, ResolvedEffect, ResolvedGeometry, ResolvedKind, ResolvedLayer, ResolvedPaint,
    ResolvedScene, ShapeStyle,
};
use crate::reuse;
use crate::scene::{
    BlendMode, DotOrder, LayerKind, MaskMode, MatteMode, Paint, Scene, ShapeLayer, TextLayer, walk_layers,
};
use crate::scene3d::draw::{Assets3d, Texture};
use crate::scene3d::environment::Environment;
use crate::scene3d::model::Model;
use crate::scene3d::{Resolved3d, Sources3d};
use crate::text::{LaidOutText, TextEngine};
use crate::video::{VideoDecoder, Videos, open_video, video_sources};
use crate::warp;

mod skia;
pub(crate) use skia::create_texture;

/// Curve flattening tolerance when converting shapes to paths.
const SHAPE_TOLERANCE: f64 = 0.1;

/// How many bytes of finished layer textures the layer cache keeps from one
/// frame to the next (`cache.rs`).
const CACHE_BYTES: u64 = 1 << 30;

/// Tightly packed RGBA8, straight alpha, sRGB-encoded.
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl Frame {
    pub fn encode_png(&self) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        PngEncoder::new(&mut out)
            .write_image(
                &self.rgba,
                self.width,
                self.height,
                ExtendedColorType::Rgba8,
            )
            .map_err(|e| Error::Render(format!("PNG encode failed: {e}")))?;
        Ok(out)
    }
}

/// A frame the GPU is still drawing (`Renderer::start_frame`), or one that
/// is the same as the frame drawn before it and is not drawn (`reuse.rs`).
pub struct PendingFrame {
    work: Work,
    width: u32,
    height: u32,
}

enum Work {
    /// Drawn: the readback of frame number `seq` of the renderer's starts.
    Drawn { readback: Readback, seq: u64 },
    /// The same as the drawn frame `of`: its pixels again.
    Repeat { of: u64 },
}

impl PendingFrame {
    /// Whether this frame is the same as the frame started before it, which
    /// it was not drawn for: its pixels are that frame's (`reuse.rs`). A
    /// caller that kept the earlier frame's pixels, or what it made of them,
    /// may use those and drop this without `finish_frame`.
    pub fn is_repeat(&self) -> bool {
        matches!(self.work, Work::Repeat { .. })
    }
}

/// Where one frame's time went, in milliseconds. Collected by
/// [`Renderer::render_timed`]; rendering itself never reads the clock.
#[derive(Clone, Copy, Debug, Default)]
pub struct Timings {
    /// Evaluating the scene's animated values.
    pub resolve_ms: f64,
    /// Skia drawing the 2D layers into textures.
    pub raster_ms: f64,
    /// Colour conversion, effects and blending.
    pub composite_ms: f64,
    /// Encoding to sRGB 8-bit and copying back to the CPU.
    pub readback_ms: f64,
}

#[derive(Clone, Copy)]
enum Stage {
    Raster,
    Composite,
    Readback,
}

/// Resolves `frame` (so a bad frame number fails before any GPU work) and
/// renders it.
pub fn render_still(scene: Scene, frame: u32) -> Result<Frame> {
    let resolved = scene.resolve(frame)?;
    Renderer::new(scene)?.render_resolved(&resolved)
}

/// GPU state for rendering scenes. Reuse it to render more than one frame,
/// and to move on to another scene (`set_scene`) without setting the GPU up
/// again.
pub struct Renderer {
    scene: Scene,
    // Keeps the wgpu instance alive for the device.
    _instance: wgpu::Instance,
    device: wgpu::Device,
    queue: wgpu::Queue,
    /// Size of every compositor texture: the canvas plus `margin` pixels on
    /// every side.
    target_size: (u32, u32),
    /// See `Scene::margin`.
    margin: u32,
    /// The camera of the frame being rendered (`warp::projection`).
    projection: DMat4,
    compositor: Compositor,
    text: TextEngine,
    images: HashMap<String, ImageData>,
    /// The files the fonts, images and tables were read from.
    loaded: Loaded,
    /// The Lottie animations of the scene, painted at the size each is drawn at.
    lotties: Lotties,
    /// The video files of the scene, one decoder each. A decoder keeps its
    /// place and a few recent pictures between frames; the picture of a frame
    /// does not depend on them (`video.rs`).
    videos: Videos,
    /// The GIFs of the scene, all their pictures decoded.
    gifs: Gifs,
    /// The models and textures of 3D layers, and the meshes built for them.
    assets3d: Assets3d,
    /// `Some` while `render_timed` runs.
    timings: Option<Timings>,
    /// The textures of layers that stopped changing, kept for the next frame.
    cache: LayerCache<Tex>,
    /// The ids of the groups the layer being drawn is in, outermost first.
    /// With the layer's own id they say which layer it is to the cache.
    cache_path: Vec<String>,
    /// Above 0 while the samples of a motion-blurred layer are drawn: they are
    /// copies of one layer with the same ids, and only their average is kept.
    cache_paused: u32,
    /// Identical-frame reuse (`reuse.rs`), off in a new renderer.
    reuse: bool,
    /// The frames started so far, which numbers them.
    starts: u64,
    /// The last frame drawn by `start_frame` and its number, while frames
    /// may be compared with it.
    drawn: Option<(u64, ResolvedScene)>,
    /// The latest drawn frame a repeat was started for.
    repeat_of: Option<u64>,
    /// The pixels of a drawn frame that a repeat may need, by its number.
    pixels: Option<(u64, Vec<u8>)>,
    /// Frames that were repeats of the one before.
    repeats: u64,
    /// Above 0 while the children of a fused group are drawn
    /// (`draw_fused_group`): what they wait to be blended stays together.
    group_depth: u32,
    /// The Skia backend (`skia.rs`); `None` only while a frame is being drawn.
    skia: Option<skia::SkiaBackend>,
    /// Skia's GPU context and the translator that draws the 2D content of the layers it hands to this renderer, while
    /// a Skia frame is being drawn (`skia/backend.rs`); `None` otherwise.
    skia_inner: Option<skia::Inner>,
}

impl Renderer {
    pub fn new(scene: Scene) -> Result<Renderer> {
        // Fonts first: nothing is measured before they are registered. All
        // the reading is done before the GPU is touched, so a bad file fails
        // cheaply.
        let mut fresh = read_assets(&scene, &Loaded::default(), false)?;

        let (instance, device, queue) = pollster::block_on(new_gpu()).ok_or_else(|| {
            Error::Render("no compatible GPU adapter found (Metal on macOS; Vulkan on Linux and Windows, or Direct3D 12 on Windows)".into())
        })?;

        let margin = scene.margin();
        let target_size = (scene.width + 2 * margin, scene.height + 2 * margin);
        // The scene's shaders and tables join below, the way a later
        // scene's do (`set_scene`).
        let mut compositor = Compositor::new(
            &device,
            &queue,
            scene.width,
            scene.height,
            margin,
            &[],
            &HashMap::new(),
        );
        compositor.set_srgb_blend(scene.blend_space == crate::scene::BlendSpace::Srgb);

        let text = fresh
            .text
            .take()
            .expect("the first read of a scene's assets builds the text engine");
        let mut renderer = Renderer {
            scene,
            _instance: instance,
            device,
            queue,
            target_size,
            margin,
            projection: DMat4::IDENTITY,
            compositor,
            text,
            images: HashMap::new(),
            lotties: Lotties::default(),
            videos: Videos::default(),
            gifs: Gifs::default(),
            assets3d: Assets3d::default(),
            loaded: Loaded::default(),
            timings: None,
            cache: LayerCache::new(CACHE_BYTES),
            cache_path: Vec::new(),
            cache_paused: 0,
            reuse: false,
            starts: 0,
            drawn: None,
            repeat_of: None,
            pixels: None,
            repeats: 0,
            group_depth: 0,
            skia: None,
            skia_inner: None,
        };
        renderer.skia = Some(skia::init(&renderer.device, &renderer.queue, &renderer.scene)?);
        renderer.install_assets(fresh);
        renderer.add_shaders();
        Ok(renderer)
    }

    /// Takes `scene` as the one to render from now on, keeping the device,
    /// the compositor's pipelines and the layer cache.
    /// Only what the scene needs that the renderer has not read yet is
    /// loaded: fonts, images and tables by the file they came from, shader
    /// pipelines by their source. The textures that depend on the size are
    /// remade only if the canvas size or the margin changed. A frame of the
    /// scene is the same as a new renderer's frame of it.
    ///
    /// If anything in the scene cannot be loaded, the error is returned and
    /// the renderer is left as it was.
    ///
    /// The layer cache is kept across scenes: a cached layer is used again
    /// when everything it was drawn from is equal (`cache.rs`), whichever
    /// scene it came from. It is emptied when that no longer holds: when the
    /// size or margin changes, and when a font, image or table name the
    /// renderer has already loaded stands for another file in the new scene.
    /// A file is told apart by its path, size and modification time, so one
    /// that is edited between scenes is read again.
    pub fn set_scene(&mut self, scene: Scene) -> Result<()> {
        let fresh = read_assets(&scene, &self.loaded, true)?;
        // Nothing fails from here on.
        let margin = scene.margin();
        let resized = (scene.width, scene.height, margin)
            != (self.scene.width, self.scene.height, self.margin);
        // What a cached group drew depends on the space it was blended in.
        let respaced = scene.blend_space != self.scene.blend_space;
        crate::profile::add_value("margin", f64::from(margin));
        crate::profile::add_value("resized", f64::from(u8::from(resized)));
        if resized || respaced || fresh.rebound {
            self.clear_layer_cache();
        }
        // A frame is only compared with one drawn from the same files and
        // settings (`reuse.rs`).
        if resized
            || respaced
            || !fresh.is_empty()
            || scene.fps != self.scene.fps
            || scene.fonts != self.scene.fonts
            || scene.base_dir != self.scene.base_dir
        {
            self.drawn = None;
        }
        self.compositor
            .set_srgb_blend(scene.blend_space == crate::scene::BlendSpace::Srgb);
        if resized {
            self.margin = margin;
            self.target_size = (scene.width + 2 * margin, scene.height + 2 * margin);
            self.compositor.resize(scene.width, scene.height, margin);
        }
        self.install_assets(fresh);
        self.scene = scene;
        self.add_shaders();
        Ok(())
    }

    /// The scene the renderer is drawing.
    pub fn scene(&self) -> &Scene {
        &self.scene
    }

    /// Keeps what `read_assets` read.
    fn install_assets(&mut self, fresh: NewAssets) {
        // Skia reads picture and video files itself and keeps what it read, by name: a name that now means another
        // file (or a file that changed) must be read again.
        if fresh.text.is_some()
            || !(fresh.images.is_empty() && fresh.lotties.is_empty() && fresh.videos.is_empty() && fresh.gifs.is_empty())
        {
            self.skia_forget_files();
        }
        if let Some(text) = fresh.text {
            self.text = text;
            self.assets3d.forget_text();
        }
        self.loaded.fonts = fresh.fonts;
        for (src, id, image) in fresh.images {
            self.images.insert(src.clone(), image);
            self.loaded.images.insert(src, id);
        }
        for (src, id, lottie) in fresh.lotties {
            self.lotties.insert(src.clone(), lottie);
            self.loaded.lotties.insert(src, id);
        }
        for (src, id, video) in fresh.videos {
            self.videos.insert(src.clone(), video);
            self.loaded.videos.insert(src, id);
        }
        for (src, id, gif) in fresh.gifs {
            self.gifs.insert(src.clone(), gif);
            self.loaded.gifs.insert(src, id);
        }
        for (src, id, model) in fresh.models {
            self.assets3d.insert_model(src.clone(), model);
            self.loaded.models.insert(src, id);
        }
        for (src, id, texture) in fresh.textures3d {
            self.assets3d.insert_texture(src.clone(), texture);
            self.loaded.textures3d.insert(src, id);
        }
        for (src, id, environment) in fresh.environments {
            self.assets3d.insert_environment(src.clone(), environment);
            self.loaded.environments.insert(src, id);
        }
        let mut luts = HashMap::new();
        for (src, id, lut) in fresh.luts {
            luts.insert(src.clone(), lut);
            self.loaded.luts.insert(src, id);
        }
        self.compositor.set_luts(&luts);
    }

    /// Builds the pipelines for the scene's custom shaders that the
    /// compositor does not have.
    fn add_shaders(&mut self) {
        self.compositor.add_shaders(&self.scene.shader_sources());
    }

    /// Empties the layer cache, giving its textures back to the pool.
    fn clear_layer_cache(&mut self) {
        let on = self.cache.enabled();
        for tex in self.cache.set_enabled(false) {
            self.compositor.release(tex);
        }
        self.cache.set_enabled(on);
    }

    /// Turns the layer cache on or off; a new renderer has it off. With it
    /// on, a frame that has a layer the last frame had blends the layer's
    /// texture from the last frame again instead of drawing it, whenever
    /// everything the texture is made from is equal (`cache.rs`): the frames
    /// are the same either way. It is for rendering frames one after the
    /// other (`render`); rendering one frame over and over, as `bench` does,
    /// would only time the cache. Turning it off empties it; turning it on
    /// starts from an empty one.
    pub fn set_layer_cache(&mut self, on: bool) {
        self.drawn = None;
        for tex in self.cache.set_enabled(on) {
            self.compositor.release(tex);
        }
    }

    /// How many layers have been drawn from the layer cache so far, and how
    /// many were looked for in it and drawn instead.
    pub fn layer_cache_counts(&self) -> (u64, u64) {
        self.cache.counts()
    }

    /// Times every compositing pass on the GPU from now on, for
    /// `take_pass_times`. `false` if the GPU cannot (no `TIMESTAMP_QUERY`).
    pub fn set_pass_timing(&mut self, on: bool) -> bool {
        self.compositor.set_pass_timing(on)
    }

    /// Turns the compositor's passes that do the work of several off
    /// (`false`) or back on (they are on in a new renderer). Either way the
    /// pixels are the same, byte for byte; the switch exists for tests.
    pub fn set_pass_fusion(&mut self, on: bool) {
        self.drawn = None;
        self.compositor.set_fusion(on);
    }

    /// The compositing passes since the last call, with their GPU times.
    /// Skia's drawing and the copies between textures are not passes
    /// that can be timed, so they are not in it.
    pub fn take_pass_times(&mut self) -> Vec<crate::pass_timer::PassTime> {
        self.compositor.take_pass_times()
    }

    /// Turns identical-frame reuse on or off (`reuse.rs`); a new renderer
    /// has it off. With it on, `start_frame` does not draw a frame whose
    /// resolved scene is equal to that of the frame started just before it,
    /// and `finish_frame` gives that frame's pixels again: the frames are the
    /// same either way. It is for rendering frames one after the other;
    /// timing one frame over and over, as `bench` does, would only time the
    /// comparison.
    pub fn set_frame_reuse(&mut self, on: bool) {
        self.reuse = on;
        self.forget_frame();
    }

    /// Whether identical-frame reuse is on.
    pub fn frame_reuse(&self) -> bool {
        self.reuse
    }

    /// Makes the next frame be drawn whatever the last one was: frames from
    /// here on are only compared with frames started after this. A render
    /// worker calls it at the start of each run of frames, so that no frame
    /// is taken from one that is not the frame before it in the film.
    pub fn forget_frame(&mut self) {
        self.drawn = None;
    }

    /// How many frames `start_frame` has not drawn because they were the
    /// same as the frame before.
    pub fn repeated_frames(&self) -> u64 {
        self.repeats
    }

    pub fn render_frame(&mut self, frame: u32) -> Result<Frame> {
        let pending = self.start_frame(frame)?;
        self.finish_frame(pending)
    }

    /// `render_frame` up to the readback: the GPU works on the frame while
    /// the caller starts the next one, and `finish_frame` collects it.
    /// Frames are finished in the order they were started.
    ///
    /// With frame reuse on, a frame equal to the one started just before it
    /// is not drawn (`set_frame_reuse`, `PendingFrame::is_repeat`).
    pub fn start_frame(&mut self, frame: u32) -> Result<PendingFrame> {
        if crate::profile::passes() {
            if !self.compositor.is_timing_passes() {
                self.compositor.set_pass_timing(true);
            }
        }
        let timer = crate::profile::start();
        let resolved = self.scene.resolve_with_text(frame, &mut self.text)?;
        crate::profile::add_since("resolve", timer);
        let timer = crate::profile::start();
        self.starts += 1;
        let seq = self.starts;
        if self.reuse
            && let Some((of, drawn)) = &self.drawn
            && reuse::same_frame(drawn, &resolved)
        {
            let of = *of;
            self.repeat_of = Some(of);
            self.repeats += 1;
            crate::profile::add_value("repeat", 1.0);
            crate::profile::add_since("start", timer);
            return Ok(PendingFrame {
                work: Work::Repeat { of },
                width: resolved.width,
                height: resolved.height,
            });
        }
        self.drawn = None;
        self.skia_started(frame);
        let (hits, misses) = self.cache.counts();
        let (readback, width, height) = self.start_resolved(&resolved)?;
        if crate::profile::enabled() {
            let (now_hits, now_misses) = self.cache.counts();
            crate::profile::add_value("cache_hits", (now_hits - hits) as f64);
            crate::profile::add_value("cache_misses", (now_misses - misses) as f64);
        }
        if self.reuse {
            self.drawn = Some((seq, resolved));
        }
        crate::profile::add_since("start", timer);
        if crate::profile::sync() {
            let timer = crate::profile::start();
            // A lost device makes the readback fail anyway.
            let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
            crate::profile::add_since("gpu_sync", timer);
        }
        if crate::profile::passes() {
            self.record_pass_profile();
        }
        Ok(PendingFrame {
            work: Work::Drawn { readback, seq },
            width,
            height,
        })
    }

    /// Adds the GPU time of the passes of the frame `start_frame` just encoded to the profile: each compositor pass kind
    /// (`gpu_<name>` ms, `gpun_<name>` count, `gput_<name>` texels) and the frame's span and busy time.
    fn record_pass_profile(&mut self) {
        use crate::profile::{add_dyn, add_gpu};
        // The frame's first start, last end and the sum of its passes' times, on the GPU's clock.
        let (mut first, mut last, mut busy) = (f64::MAX, 0.0f64, 0.0);
        for pass in self.compositor.take_pass_times() {
            add_gpu(pass.name, pass.ms);
            add_dyn(&format!("gput_{}", pass.name), pass.texels as f64);
            first = first.min(pass.begin_ms);
            last = last.max(pass.begin_ms + pass.ms);
            busy += pass.ms;
        }
        if last > first {
            // `gspan` is the time from the frame's first timed pass to its last; what `gbusy` leaves out of it is
            // the copies, buffer clears and uploads, and the gaps between passes.
            add_dyn("gspan", last - first);
            add_dyn("gbusy", busy);
        }
    }

    /// The pixels of a frame from `start_frame`.
    pub fn finish_frame(&mut self, pending: PendingFrame) -> Result<Frame> {
        let rgba = match pending.work {
            Work::Drawn { readback, seq } => {
                let rgba = self.compositor.finish_readback(readback)?;
                self.skia_finished(&rgba);
                // Kept when a repeat of it has started, or may still start
                // (nothing was started after it).
                let wanted = self.repeat_of == Some(seq)
                    || (self.starts == seq
                        && self.drawn.as_ref().is_some_and(|(of, _)| *of == seq));
                // Older pixels are needed by no repeat once a later frame is
                // finished: repeats are finished in order too.
                self.pixels = wanted.then(|| (seq, rgba.clone()));
                rgba
            }
            Work::Repeat { of } => match &self.pixels {
                Some((seq, rgba)) if *seq == of => rgba.clone(),
                _ => {
                    return Err(Error::Render(
                        "a repeated frame's pixels are gone: frames must be finished in the order they were started".into(),
                    ));
                }
            },
        };
        Ok(Frame {
            width: pending.width,
            height: pending.height,
            rgba,
        })
    }

    /// Like `render_frame`, but also reports where the time went. To make
    /// each stage's number include the GPU's work and not just the submit,
    /// this waits for the GPU after every step, so it is slower than
    /// `render_frame`; use `render_frame` to time the whole frame.
    pub fn render_timed(&mut self, frame: u32) -> Result<(Frame, Timings)> {
        self.drawn = None;
        let start = Instant::now();
        let resolved = self.scene.resolve_with_text(frame, &mut self.text)?;
        self.timings = Some(Timings {
            resolve_ms: start.elapsed().as_secs_f64() * 1000.0,
            ..Timings::default()
        });
        let rendered = self.render_resolved(&resolved);
        let timings = self.timings.take().unwrap_or_default();
        Ok((rendered?, timings))
    }

    /// Runs `f` and, when timing, waits for the GPU and adds the elapsed
    /// time to `stage`.
    fn timed<T>(&mut self, stage: Stage, f: impl FnOnce(&mut Self) -> T) -> T {
        if self.timings.is_none() {
            return f(self);
        }
        let start = Instant::now();
        let out = f(self);
        self.compositor.submit();
        // A lost device makes the next call fail anyway.
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        if let Some(t) = self.timings.as_mut() {
            *match stage {
                Stage::Raster => &mut t.raster_ms,
                Stage::Composite => &mut t.composite_ms,
                Stage::Readback => &mut t.readback_ms,
            } += ms;
        }
        out
    }

    pub fn render_resolved(&mut self, scene: &ResolvedScene) -> Result<Frame> {
        self.drawn = None;
        let (readback, width, height) = self.start_resolved(scene)?;
        let rgba = self.timed(Stage::Readback, |s| s.compositor.finish_readback(readback))?;
        Ok(Frame {
            width,
            height,
            rgba,
        })
    }

    /// Draws `scene` and starts reading it back: the readback and the size.
    fn start_resolved(&mut self, scene: &ResolvedScene) -> Result<(Readback, u32, u32)> {
        self.projection = warp::projection(scene.camera.as_ref(), self.margin);
        // A frame that failed may have left these half way.
        self.cache_path.clear();
        self.cache_paused = 0;
        self.group_depth = 0;
        self.cache.begin_frame();
        self.compositor.begin_frame();
        let canvas = self.skia_canvas(scene)?;
        // What this frame did not draw, the next probably will not either.
        for tex in self.cache.end_frame() {
            self.compositor.release(tex);
        }
        let readback = self.timed(Stage::Readback, |s| s.compositor.start_readback(&canvas));
        self.compositor.release(canvas);
        self.skia_submitted(&readback);
        Ok((readback, scene.width, scene.height))
    }

    /// Blends `layers` (bottom first) onto `canvas`. `parent` is the product
    /// of the enclosing groups' matrices, starting from the margin offset.
    /// `below` is what lies behind `canvas` when it is a group's buffer (the
    /// group's own backdrop), and `None` for the scene's canvas itself.
    fn draw_layers(
        &mut self,
        layers: &[ResolvedLayer],
        parent: Affine,
        canvas: Tex,
        below: Option<&Tex>,
    ) -> Result<Tex> {
        let mut pending = Vec::new();
        let canvas = self.draw_layers_into(layers, parent, canvas, below, &mut pending)?;
        Ok(self.blend_pending(canvas, &mut pending))
    }

    /// `draw_layers`, leaving the layers it has drawn in `pending` instead of
    /// blending them: they are blended together, in as few passes as
    /// possible, when something needs the canvas as it would be with them on
    /// it (`blend_pending`), which the caller does at the end.
    fn draw_layers_into<'a>(
        &mut self,
        layers: &'a [ResolvedLayer],
        parent: Affine,
        mut canvas: Tex,
        below: Option<&Tex>,
        pending: &mut Vec<Pending<'a>>,
    ) -> Result<Tex> {
        // Plain leaves met under motion blur, drawn together in one Skia pass.
        let mut run: Vec<FlatOp<'a>> = Vec::new();
        for layer in layers {
            // A matte source is only drawn through the layer it mattes.
            if is_hidden(layer) || is_matte_source(layers, layer) {
                continue;
            }
            if self.cache_paused > 0 && is_flat(layer) {
                self.collect_flat(layer, parent, &mut run)?;
                continue;
            }
            self.flush_flat(&mut run, pending)?;
            // No buffer of its own: the children go straight onto the canvas.
            if let ResolvedKind::Group {
                children,
                preserve3d: true,
                ..
            } = &layer.kind
            {
                canvas = self.blend_pending(canvas, pending);
                canvas = self.draw_preserve3d(layer, children, parent, canvas, below)?;
                continue;
            }
            // A group that changes nothing about how its children are blended
            // needs no buffer either (`needs_no_buffer`).
            if let ResolvedKind::Group { children, .. } = &layer.kind
                && needs_no_buffer(layer)
            {
                self.cache_path.push(layer.id.clone());
                let drawn = self.draw_layers_into(
                    children,
                    parent * layer.transform.matrix(),
                    canvas,
                    below,
                    pending,
                );
                self.cache_path.pop();
                canvas = drawn?;
                continue;
            }
            // A layer turned in 3D is drawn flat and then warped about its
            // own position, in its parent's plane.
            let placement = warp::layer_world(&layer.transform).map(|world| Placement {
                parent,
                world,
                backface_hidden: layer.transform.backface_hidden,
            });
            canvas = self.draw_layer(
                layer, layers, parent, placement, 1.0, canvas, below, pending,
            )?;
            // (Not inside a fused group, whose layers go in one pass.)
            if pending.len() >= MAX_PENDING && self.group_depth == 0 {
                canvas = self.blend_pending(canvas, pending);
            }
            self.compositor.submit_if_large();
        }
        self.flush_flat(&mut run, pending)?;
        Ok(canvas)
    }

    /// Adds the leaves of the flat `layer` (`is_flat`) to `run`, each with
    /// the matrix and the box `layer_texture` would rasterise it with.
    fn collect_flat<'a>(
        &mut self,
        layer: &'a ResolvedLayer,
        parent: Affine,
        run: &mut Vec<FlatOp<'a>>,
    ) -> Result<()> {
        let matrix = parent * layer.transform.matrix();
        if let ResolvedKind::Group { children, .. } = &layer.kind {
            let clip = match &layer.clip {
                Some(clip) => {
                    let path = self.clip_path(clip, layer)?;
                    // A clip that keeps nothing leaves nothing of the group.
                    if self.path_bounds(&path, matrix).is_empty() {
                        return Ok(());
                    }
                    run.push(FlatOp::Clip(path, matrix));
                    true
                }
                None => false,
            };
            for child in children.iter().filter(|c| !is_hidden(c)) {
                self.collect_flat(child, matrix, run)?;
            }
            if clip {
                run.push(FlatOp::Pop);
            }
            return Ok(());
        }
        let region = self.raster_bounds(layer, matrix)?;
        if !region.is_empty() {
            run.push(FlatOp::Leaf(layer, matrix, region));
        }
        Ok(())
    }

    /// Draws the leaves in `run` bottom first with one Skia pass into one
    /// texture, and leaves it in `pending`. Many plain leaves of a
    /// motion-blurred layer's sample cost one draw instead of one each.
    fn flush_flat(
        &mut self,
        run: &mut Vec<FlatOp<'_>>,
        pending: &mut Vec<Pending<'_>>,
    ) -> Result<()> {
        if run.is_empty() {
            return Ok(());
        }
        let region = run.iter().fold(PixelRect::EMPTY, |r, op| match op {
            FlatOp::Leaf(_, _, region) => r.union(*region),
            _ => r,
        });
        if region.is_empty() {
            run.clear();
            return Ok(());
        }
        let ops: Vec<skia::RasterOp<'_>> = run
            .drain(..)
            .map(|op| match op {
                FlatOp::Leaf(layer, matrix, _) => skia::RasterOp::Leaf(layer, matrix),
                FlatOp::Clip(path, matrix) => skia::RasterOp::Clip(path, matrix),
                FlatOp::Pop => skia::RasterOp::Pop,
            })
            .collect();
        let tex = self.timed(Stage::Raster, |s| s.skia_flat(&ops, region))?;
        pending.push(Pending::new(Waiting::Loose(tex), 1.0, BlendMode::Normal));
        Ok(())
    }

    /// Blends the layers in `pending`, oldest first, onto `canvas`, and does
    /// with each what its drawing left to do: gives the layer cache the
    /// texture, or the pool.
    fn blend_pending(&mut self, canvas: Tex, pending: &mut Vec<Pending<'_>>) -> Tex {
        if pending.is_empty() {
            return canvas;
        }
        let layers: Vec<BlendLayer> = pending
            .iter()
            .map(|p| BlendLayer {
                source: p.source(),
                opacity: p.opacity,
                mode: p.mode,
                opens: p.opens,
                closes: p.closes,
            })
            .collect();
        let canvas = self.timed(Stage::Composite, |s| {
            s.compositor.blend_many(canvas, &layers)
        });
        drop(layers);
        for waiting in pending.drain(..) {
            if let Some((id, inputs)) = &waiting.note {
                self.cache.note(id.clone(), inputs);
            }
            match waiting.what {
                Waiting::Cached { id, hit } => self.cache.put_back(id, hit),
                Waiting::Kept {
                    id,
                    inputs,
                    texture,
                } => {
                    for tex in self.cache.put(id, &inputs, texture) {
                        self.compositor.release(tex);
                    }
                }
                Waiting::Loose(texture) => self.compositor.release(texture),
            }
        }
        canvas
    }

    /// Draws a `preserve3d` group: its children, and those of the preserve3d
    /// groups nested in it, go straight onto `canvas` with their combined 3D
    /// placements, farthest first (`warp::sort_far_to_near`), the group's own
    /// opacity multiplied into each. `parent` is the group's parent's flat
    /// matrix.
    fn draw_preserve3d(
        &mut self,
        group: &ResolvedLayer,
        children: &[ResolvedLayer],
        parent: Affine,
        mut canvas: Tex,
        below: Option<&Tex>,
    ) -> Result<Tex> {
        let space = Space3d {
            parent,
            flat: group.transform.matrix(),
            world: warp::layer_world(&group.transform).unwrap_or(DMat4::IDENTITY),
            opacity: group.opacity,
        };
        let mut items = Vec::new();
        collect_preserve3d(children, space, &mut |l| self.layer_box(l), &mut items)?;
        warp::sort_far_to_near(&mut items, |item| item.depth);
        self.cache_path.push(group.id.clone());
        for item in items {
            // One at a time: each is placed in 3D and blended before the next.
            let mut pending = Vec::new();
            let drawn = self.draw_layer(
                item.layer,
                item.siblings,
                item.flat_parent,
                Some(item.placement),
                item.opacity,
                canvas,
                below,
                &mut pending,
            );
            canvas = match drawn {
                Ok(canvas) => self.blend_pending(canvas, &mut pending),
                Err(e) => {
                    self.cache_path.pop();
                    return Err(e);
                }
            };
        }
        self.cache_path.pop();
        Ok(canvas)
    }

    /// Draws one layer of `siblings` for `canvas`: its own pixels
    /// (`layer_texture`), warped into place if it has a `placement`, to be
    /// blended with its opacity times `opacity_scale`. The blend waits in
    /// `pending` (see `draw_layers_into`), unless the layer needs the canvas
    /// as it is: then what is pending is blended first. `parent` is the flat
    /// matrix of the layer's parent, as in `draw_layers`. A layer with motion
    /// blur ignores `placement` and works its own out for each sub-frame, so
    /// it cannot be drawn by `draw_preserve3d` (the scene refuses it).
    ///
    /// The texture it blends is the layer cache's when the layer is what it
    /// was in the last frame (`cache.rs`), and is kept there when it is not.
    #[allow(clippy::too_many_arguments)]
    fn draw_layer<'a>(
        &mut self,
        layer: &'a ResolvedLayer,
        siblings: &'a [ResolvedLayer],
        parent: Affine,
        placement: Option<Placement>,
        opacity_scale: f32,
        mut canvas: Tex,
        below: Option<&Tex>,
        pending: &mut Vec<Pending<'a>>,
    ) -> Result<Tex> {
        // Each sub-frame's opacity is already in a blurred layer's average.
        let opacity = if layer.motion.is_empty() {
            layer.opacity * opacity_scale
        } else {
            1.0
        };
        let matte = layer
            .matte
            .as_ref()
            .and_then(|m| siblings.iter().find(|l| l.id == m.layer));
        let id = self.cache_id(layer, matte);
        // A blurred layer places its sub-frames one by one.
        let placed = placement
            .filter(|_| layer.motion.is_empty())
            .map(|p| (p.parent, p.world));
        let inputs = Inputs {
            layer,
            matte,
            parent,
            placement: placed,
            // The warp reads the camera: for a layer placed from outside (the
            // children of a preserve3d group are, whatever their own
            // transform) as well as for one with something moved in 3D in it.
            projection: (placed.is_some()
                || cache::uses_projection(layer)
                || matte.is_some_and(cache::uses_projection))
            .then_some(self.projection),
            opacity_scale: (!layer.motion.is_empty()).then_some(opacity_scale),
        };
        // (Asked before `take` removes what it would be told by.)
        let unchanged = id
            .as_ref()
            .is_some_and(|id| self.cache.is_unchanged(id, &inputs));
        if let Some(id) = &id {
            match self.cache.take(id, &inputs) {
                Ok(hit) => {
                    census(layer, "cache", opacity);
                    pending.push(Pending::new(
                        Waiting::Cached {
                            id: id.clone(),
                            hit,
                        },
                        opacity,
                        layer.blend_mode,
                    ));
                    return Ok(canvas);
                }
                Err(Some(stale)) => self.compositor.release(stale),
                Err(None) => {}
            }
        }

        // A group of plain leaves goes to the blend as they are, in one pass.
        if !unchanged && self.fusable_group(layer, siblings, placement) {
            census(layer, "fused", opacity);
            return self.draw_fused_group(layer, parent, opacity, id, inputs, canvas, pending);
        }

        census(layer, "tex", opacity);
        // The backdrop is only built for a layer that blurs it: the canvas so
        // far, under anything the enclosing groups have behind them.
        let needs_backdrop = uses_backdrop(siblings, layer);
        if needs_backdrop {
            canvas = self.blend_pending(canvas, pending);
        }
        let combined = match below {
            Some(below) if needs_backdrop => {
                Some(self.timed(Stage::Composite, |s| s.compositor.over(below, &canvas)))
            }
            _ => None,
        };
        let backdrop = needs_backdrop.then(|| combined.as_ref().unwrap_or(&canvas));
        let drawn =
            self.layer_final_texture(layer, siblings, parent, placement, opacity_scale, backdrop);
        if let Some(combined) = combined {
            self.compositor.release(combined);
        }
        // Seen edge on: nothing to blend.
        let Some(texture) = drawn? else {
            return Ok(canvas);
        };
        pending.push(Pending::new(
            match id {
                Some(id) => Waiting::Kept {
                    id,
                    inputs,
                    texture,
                },
                None => Waiting::Loose(texture),
            },
            opacity,
            layer.blend_mode,
        ));
        Ok(canvas)
    }

    /// Whether the group `layer` can be composited by `blend_many` from its
    /// children, in one pass, instead of into a texture of its own that is
    /// then blended (and masked, if it has a clip): it has no effects, mask,
    /// matte, motion blur or 3D placement, blends per pixel, does not look at
    /// the backdrop, and everything in it that is drawn blends per pixel and
    /// is one layer of the pass (the pass has `BLEND_SLOTS` of them, a clip
    /// uses one).
    fn fusable_group(
        &self,
        layer: &ResolvedLayer,
        siblings: &[ResolvedLayer],
        placement: Option<Placement>,
    ) -> bool {
        let ResolvedKind::Group {
            children,
            preserve3d: false,
            glsl: None,
            canvas: None,
            ..
        } = &layer.kind
        else {
            return false;
        };
        let reason = if !self.compositor.is_fused() {
            "unfused"
        } else if self.cache_paused > 0 {
            "paused"
        } else if self.group_depth > 0 {
            "nested"
        } else if placement.is_some() {
            "placed"
        } else if !layer.motion.is_empty() {
            "motion"
        } else if !layer.effects.is_empty() {
            "effects"
        } else if layer.mask.is_some() || layer.matte.is_some() || layer.clip.is_some() {
            "mask"
        } else if !self.compositor.blends_per_pixel(layer.blend_mode) {
            "mode"
        } else if uses_backdrop(siblings, layer) {
            "backdrop"
        } else {
            ""
        };
        if !reason.is_empty() {
            census_why(layer, reason);
            return false;
        }
        match self.fused_layers(children) {
            Some(n) if n <= BLEND_SLOTS => {}
            Some(n) => {
                census_why(layer, &format!("big{n}"));
                return false;
            }
            None => {
                census_why(layer, "children");
                return false;
            }
        }
        true
    }

    /// How many layers of a `blend_many` pass `layers` take when `draw_layers_into`
    /// draws them for a fused group, or `None` if one of them is not
    /// something that pass can composite in place: a 3D group, or a layer
    /// that is blended whole-texture (a non-separable blend mode).
    fn fused_layers(&self, layers: &[ResolvedLayer]) -> Option<usize> {
        let mut n = 0;
        for layer in layers {
            if is_hidden(layer) || is_matte_source(layers, layer) {
                continue;
            }
            if !self.compositor.blends_per_pixel(layer.blend_mode) {
                return None;
            }
            match &layer.kind {
                ResolvedKind::Group {
                    preserve3d: true, ..
                } => return None,
                ResolvedKind::Group { children, .. } if needs_no_buffer(layer) => {
                    n += self.fused_layers(children)?;
                }
                // A group of groups is left to be drawn one group at a time:
                // fused as a whole it would keep the groups in it from being
                // fused themselves.
                ResolvedKind::Group { .. } => return None,
                _ => n += 1,
            }
        }
        Some(n)
    }

    /// Draws the children of the group `layer` for `blend_many` to composite
    /// as a group (`fusable_group`), leaving them in `pending` marked as one.
    #[allow(clippy::too_many_arguments)]
    fn draw_fused_group<'a>(
        &mut self,
        layer: &'a ResolvedLayer,
        parent: Affine,
        opacity: f32,
        id: Option<Vec<String>>,
        inputs: Inputs<'a>,
        canvas: Tex,
        pending: &mut Vec<Pending<'a>>,
    ) -> Result<Tex> {
        let ResolvedKind::Group { children, .. } = &layer.kind else {
            unreachable!("only groups are fused");
        };
        let start = pending.len();
        self.cache_path.push(layer.id.clone());
        self.group_depth += 1;
        let drawn = self.draw_layers_into(
            children,
            parent * layer.transform.matrix(),
            canvas,
            None,
            pending,
        );
        self.group_depth -= 1;
        self.cache_path.pop();
        let canvas = drawn?;
        if pending.len() == start {
            return Ok(canvas);
        }
        debug_assert!(pending.len() - start <= BLEND_SLOTS);
        pending[start].opens = true;
        let last = pending.last_mut().expect("the group drew something");
        last.closes = Some((opacity, layer.blend_mode));
        last.note = id.map(|id| (id, inputs));
        Ok(canvas)
    }

    /// Where `layer`'s texture is cached, if it may be: the cache is on, the
    /// layer is not one of a motion-blurred layer's samples, and neither it
    /// nor its matte source blurs the backdrop, which makes its texture
    /// depend on the canvas under it.
    fn cache_id(
        &self,
        layer: &ResolvedLayer,
        matte: Option<&ResolvedLayer>,
    ) -> Option<Vec<String>> {
        if !self.cache.enabled()
            || self.cache_paused > 0
            || cache::mentions_backdrop(layer)
            || matte.is_some_and(cache::mentions_backdrop)
        {
            return None;
        }
        let mut id = self.cache_path.clone();
        id.push(layer.id.clone());
        Some(id)
    }

    /// `layer`'s texture as it is blended: drawn, then warped to its 3D
    /// `placement` if it has one, or the average of its motion blur samples
    /// (each placed by itself). `None` if it is seen edge on.
    fn layer_final_texture(
        &mut self,
        layer: &ResolvedLayer,
        siblings: &[ResolvedLayer],
        parent: Affine,
        placement: Option<Placement>,
        opacity_scale: f32,
        backdrop: Option<&Tex>,
    ) -> Result<Option<Tex>> {
        if layer.motion.is_empty() {
            let shift = match &placement {
                Some(placement) if backdrop.is_none() => self.source_shift(placement),
                _ => (0.0, 0.0),
            };
            let src =
                self.layer_texture(layer, siblings, shifted(shift, parent), backdrop, None)?;
            return Ok(match placement {
                Some(placement) => self.place(src, &placement, shift),
                None => Some(src),
            });
        }
        self.cache_paused += 1;
        let sum = self.motion_blurred(layer, siblings, parent, backdrop, opacity_scale);
        self.cache_paused -= 1;
        sum.map(Some)
    }

    /// The average of `layer`'s sub-frames (`ResolvedLayer::motion`), each
    /// drawn and warped into place as `draw_layer` would draw it at that
    /// time and weighted by its own opacity times `opacity_scale`. A
    /// sub-frame seen edge on adds nothing but still counts in the average.
    fn motion_blurred(
        &mut self,
        layer: &ResolvedLayer,
        siblings: &[ResolvedLayer],
        parent: Affine,
        backdrop: Option<&Tex>,
        opacity_scale: f32,
    ) -> Result<Tex> {
        let weight = opacity_scale / layer.motion.len() as f32;
        let mut sum = self.timed(Stage::Composite, |s| s.compositor.filled([0.0; 4]));
        for (i, sub) in layer.motion.iter().enumerate() {
            if sub.opacity <= 0.0 {
                continue;
            }
            let placement = warp::layer_world(&sub.transform).map(|world| Placement {
                parent,
                world,
                backface_hidden: sub.transform.backface_hidden,
            });
            let shift = match &placement {
                Some(placement) if backdrop.is_none() => self.source_shift(placement),
                _ => (0.0, 0.0),
            };
            let src = self.layer_texture(
                sub,
                siblings,
                shifted(shift, parent),
                backdrop,
                Some((i, layer.motion.len())),
            )?;
            let src = match placement {
                Some(placement) => match self.place(src, &placement, shift) {
                    Some(src) => src,
                    None => continue,
                },
                None => src,
            };
            sum = self.timed(Stage::Composite, |s| {
                s.compositor.accumulate(sum, src, sub.opacity * weight)
            });
        }
        Ok(sum)
    }

    /// Where the flat texture of a layer with this `placement` is drawn, in
    /// pixels right and down, so that the warp finds what it brings onto the
    /// canvas (`warp::source_shift`). `place` is told the same.
    fn source_shift(&self, placement: &Placement) -> (f64, f64) {
        match warp::plane_homography(self.projection, placement.parent, placement.world) {
            Some(h) if !warp::is_identity(&h) => warp::source_shift(
                &h,
                (f64::from(self.target_size.0), f64::from(self.target_size.1)),
            ),
            _ => (0.0, 0.0),
        }
    }

    /// Warps a finished layer texture, drawn `shift` pixels right and down of
    /// where it belongs, to where its 3D placement puts it, as seen by the
    /// camera. `None` (and `src` released) if the layer is seen edge on.
    fn place(&mut self, src: Tex, placement: &Placement, shift: (f64, f64)) -> Option<Tex> {
        let Some(h) = warp::plane_homography(self.projection, placement.parent, placement.world)
        else {
            self.compositor.release(src);
            return None;
        };
        let h = if shift == (0.0, 0.0) {
            h
        } else {
            h * DMat3::from_cols(
                DVec3::new(1.0, 0.0, 0.0),
                DVec3::new(0.0, 1.0, 0.0),
                DVec3::new(-shift.0, -shift.1, 1.0),
            )
        };
        // The plane is seen from behind when the map flips it over.
        if placement.backface_hidden && h.determinant() < 0.0 {
            self.compositor.release(src);
            return None;
        }
        // A placement that changes nothing (a group at depth 0 in a flat
        // stack) costs no pass.
        if warp::is_identity(&h) {
            return Some(src);
        }
        Some(self.timed(Stage::Composite, |s| s.compositor.warp(src, h)))
    }

    /// A canvas pass's picture: the commands `ops` on a canvas of `size` under `matrix`, with the
    /// textures `layers` (the pass's children, by id) as the pictures its `layer` sources name.
    fn canvas_pass(
        &mut self,
        id: &str,
        size: (f64, f64),
        ops: &std::sync::Arc<Vec<canvas::CanvasOp>>,
        matrix: Affine,
        layers: &[(&str, &Tex)],
    ) -> Result<Tex> {
        let canvas = canvas_layer(id, size, ops);
        let region = self.raster_bounds(&canvas, matrix)?;
        if region.is_empty() {
            return Ok(self.compositor.empty());
        }
        self.timed(Stage::Raster, |s| s.skia_canvas_pass(&canvas, matrix, region, layers))
    }

    /// One layer's own pixels, ready to blend: drawn, then run through its
    /// effects, clip, mask and matte, in that order. `siblings` is the list
    /// `layer` is in, where its matte source is found. `backdrop` is what is
    /// behind the layer, given when it or its matte source blurs it.
    ///
    /// `sub` is `layer`'s sub-frame number and the count when it is one of a
    /// blurred layer's copies: its matte source is then the source's copy at the
    /// same time, if the source is blurred the same number of times (a
    /// source that is not, or not as many, stays at the frame).
    fn layer_texture(
        &mut self,
        layer: &ResolvedLayer,
        siblings: &[ResolvedLayer],
        parent: Affine,
        backdrop: Option<&Tex>,
        sub: Option<(usize, usize)>,
    ) -> Result<Tex> {
        // Layer space to padded texture pixels.
        let matrix = parent * layer.transform.matrix();
        // Where a leaf layer's pixels are (see `raster_bounds`).
        let raster = match &layer.kind {
            ResolvedKind::Group { .. }
            | ResolvedKind::MeshGradient { .. }
            | ResolvedKind::Glsl { .. }
            | ResolvedKind::Scene3d { .. } => None,
            _ => Some(self.raster_bounds(layer, matrix)?),
        };
        let src = match &layer.kind {
            // The children are the textures of a GLSL pass.
            ResolvedKind::Group {
                children,
                glsl: Some(glsl),
                ..
            } => {
                let mut drawn = Vec::with_capacity(children.len());
                self.cache_path.push(layer.id.clone());
                for child in children {
                    let empty = self.timed(Stage::Composite, |s| s.compositor.filled([0.0; 4]));
                    match self.draw_layers(std::slice::from_ref(child), matrix, empty, backdrop) {
                        Ok(tex) => drawn.push(tex),
                        Err(e) => {
                            self.cache_path.pop();
                            return Err(e);
                        }
                    }
                }
                self.cache_path.pop();
                let base_dir = self.scene.base_dir.clone();
                let layers: Vec<(&str, &Tex)> =
                    children.iter().map(|c| c.id.as_str()).zip(&drawn).collect();
                let tex = self.timed(Stage::Raster, |s| {
                    s.compositor.glsl_group(
                        &glsl.recording.0,
                        (glsl.width, glsl.height),
                        matrix,
                        &base_dir,
                        &layers,
                    )
                });
                for tex in drawn {
                    self.compositor.release(tex);
                }
                tex?
            }
            // The children are the pictures a Canvas 2D pass draws.
            ResolvedKind::Group {
                children,
                canvas: Some((width, height, ops)),
                ..
            } => {
                let mut drawn = Vec::with_capacity(children.len());
                self.cache_path.push(layer.id.clone());
                for child in children {
                    let empty = self.timed(Stage::Composite, |s| s.compositor.filled([0.0; 4]));
                    match self.draw_layers(std::slice::from_ref(child), matrix, empty, backdrop) {
                        Ok(tex) => drawn.push(tex),
                        Err(e) => {
                            self.cache_path.pop();
                            return Err(e);
                        }
                    }
                }
                self.cache_path.pop();
                let layers: Vec<(&str, &Tex)> =
                    children.iter().map(|c| c.id.as_str()).zip(&drawn).collect();
                // Skia draws the children as they are, and the commands over them.
                let tex = self.canvas_pass(&layer.id, (*width, *height), ops, matrix, &layers);
                for tex in drawn {
                    self.compositor.release(tex);
                }
                tex?
            }
            ResolvedKind::Group { children, .. } => {
                let empty = self.timed(Stage::Composite, |s| s.compositor.filled([0.0; 4]));
                self.cache_path.push(layer.id.clone());
                let drawn = self.draw_layers(children, matrix, empty, backdrop);
                self.cache_path.pop();
                drawn?
            }
            // Triangles with vertex colours.
            ResolvedKind::MeshGradient {
                columns,
                rows,
                points,
                colors,
                ..
            } => {
                let vertices = mesh::tessellate(*columns, *rows, points, colors, matrix);
                self.timed(Stage::Raster, |s| s.compositor.mesh_gradient(&vertices))
            }
            // The page's own shaders, run on the GPU into a drawing buffer.
            ResolvedKind::Glsl {
                width,
                height,
                recording,
            } => {
                let base_dir = self.scene.base_dir.clone();
                self.timed(Stage::Raster, |s| {
                    s.compositor
                        .glsl(&recording.0, (*width, *height), matrix, &base_dir)
                })?
            }
            // Meshes drawn with a depth buffer.
            ResolvedKind::Scene3d {
                width,
                height,
                scene,
            } => self.scene3d_texture(&layer.id, matrix, (*width, *height), scene)?,
            // Nothing lands on the texture: nothing to draw.
            _ if raster.is_some_and(|r| r.is_empty()) => {
                self.timed(Stage::Composite, |s| s.compositor.empty())
            }
            _ => {
                let region = raster.unwrap_or_else(|| self.whole());
                let drawn = self.timed(Stage::Raster, |s| s.skia_leaf(layer, matrix, region))?;
                match &layer.kind {
                    // What was drawn is the box's coverage; the noise fills it.
                    ResolvedKind::Noise {
                        turbulence,
                        channels,
                        ..
                    } => self.timed(Stage::Composite, |s| {
                        s.compositor.noise(drawn, matrix, turbulence, *channels)
                    }),
                    _ => drawn,
                }
            }
        };
        // A shape frosts its whole geometry, however see-through its fill is.
        let coverage = match (&layer.kind, backdrop) {
            (ResolvedKind::Shape { .. }, Some(_)) if has_backdrop_blur(&layer.effects) => {
                let region = raster.unwrap_or_else(|| self.whole());
                if region.is_empty() {
                    Some(self.timed(Stage::Composite, |s| s.compositor.empty()))
                } else {
                    Some(self.timed(Stage::Raster, |s| s.skia_coverage(layer, matrix, region))?)
                }
            }
            _ => None,
        };
        let layer_box = if needs_box(&layer.effects) {
            self.layer_box(layer)?
        } else {
            None
        };
        // The first effect, if it is a drop shadow with a formula.
        let box_shadow = BoxShadow::plan(layer, matrix);
        let mut src = self.timed(Stage::Composite, |s| {
            s.compositor.apply_effects(
                src,
                matrix,
                layer_box,
                &layer.effects,
                backdrop,
                coverage.as_ref(),
                box_shadow.as_ref(),
            )
        });
        if let Some(coverage) = coverage {
            self.compositor.release(coverage);
        }
        if let Some(clip) = layer.clip.as_ref() {
            let path = self.clip_path(clip, layer)?;
            let keep = self.path_bounds(&path, matrix);
            if keep.is_empty() {
                // Nothing is kept.
                self.compositor.release(src);
                src = self.timed(Stage::Composite, |s| s.compositor.empty());
            } else if !src.bounds.is_empty() {
                let clip = self.timed(Stage::Raster, |s| s.skia_clip(&path, matrix, keep))?;
                src = self.timed(Stage::Composite, |s| {
                    s.compositor.matte(src, clip, 1.0, MatteMode::Alpha)
                });
            }
        }
        if let Some(mask) = &layer.mask
            && !src.bounds.is_empty()
        {
            let whole = self.whole();
            let gradient = self.timed(Stage::Raster, |s| s.skia_mask(layer, mask, matrix, whole))?;
            let mode = match mask.mode {
                MaskMode::Alpha => MatteMode::Alpha,
                MaskMode::Luminance => MatteMode::Luminance,
            };
            src = self.timed(Stage::Composite, |s| s.compositor.matte(src, gradient, 1.0, mode));
        }
        if let Some(matte) = &layer.matte {
            let source = siblings
                .iter()
                .find(|l| l.id == matte.layer)
                .ok_or_else(|| {
                    Error::Render(format!(
                        "layer {:?}: matte source {:?} not found among its siblings",
                        layer.id, matte.layer
                    ))
                })?;
            let source = match sub {
                Some((i, count)) if source.motion.len() == count => &source.motion[i],
                _ => source,
            };
            // The source cannot have a matte (checked at load), so this
            // recursion is one level deep.
            let matte_tex = self.layer_texture(source, siblings, parent, backdrop, None)?;
            src = self.timed(Stage::Composite, |s| {
                s.compositor
                    .matte(src, matte_tex, source.opacity, matte.mode)
            });
        }
        Ok(src)
    }

    /// Draws a 3D layer's scene into a texture, its box `size` placed on
    /// the canvas by `matrix`.
    fn scene3d_texture(
        &mut self,
        id: &str,
        matrix: Affine,
        size: (f64, f64),
        scene: &Resolved3d,
    ) -> Result<Tex> {
        let bounds =
            device_bounds(matrix, Rect::new(0.0, 0.0, size.0, size.1)).intersect(self.whole());
        if bounds.is_empty() || !(size.0 > 0.0 && size.1 > 0.0) {
            return Ok(self.timed(Stage::Composite, |s| s.compositor.empty()));
        }
        let draw = self.assets3d.draw_scene(id, scene, size, &mut self.text)?;
        Ok(self.timed(Stage::Raster, |s| {
            s.compositor.scene3d(&draw, matrix, bounds)
        }))
    }

    /// The box of the padded canvas's pixels.
    fn whole(&self) -> PixelRect {
        PixelRect::whole(self.target_size.0, self.target_size.1)
    }

    /// The pixels that rasterising the leaf `layer` under `matrix` can touch:
    /// the box of what it draws in layer space, through the matrix, a pixel
    /// more all round for the anti-aliased edge (the edge of a shape reaches that far),
    /// cut to the target.
    ///
    /// - a shape: the box of its path, and for a stroke half the stroke's
    ///   width more, which is how far the round joins and caps reach;
    /// - text: the layout box and where the glyphs sit, a font size more
    ///   each way (`text_bounds`);
    /// - an image or a noise layer: its box.
    fn raster_bounds(&mut self, layer: &ResolvedLayer, matrix: Affine) -> Result<PixelRect> {
        let whole = self.whole();
        let local = match &layer.kind {
            ResolvedKind::Shape {
                geometry,
                fill,
                stroke,
                style,
            } => {
                if fill.is_none() && stroke.is_none() {
                    return Ok(PixelRect::EMPTY);
                }
                shape_box(geometry, stroke.map(|(_, width)| (width, style)))?
            }
            ResolvedKind::Text {
                text,
                font,
                size,
                line_height,
                max_width,
                align,
                chars,
                runs,
                box_size,
                stroke,
                ..
            } => {
                let laid_out = self.text.layout_layer(
                    text,
                    font,
                    *size,
                    *line_height,
                    *max_width,
                    *align,
                    runs,
                    *box_size,
                );
                // A stroke reaches half its width (a miter join, up to the limit) past the outline.
                let reach = stroke.as_ref().map_or(0.0, |st| {
                    let join = if st.join == crate::scene::StrokeJoin::Miter { st.miter_limit } else { 1.0 };
                    st.width * 0.5 * join.max(1.0) + 1.0
                });
                text_bounds(&laid_out, (*size).max(reach as f32), *max_width, chars)
            }
            ResolvedKind::Image { width, height, .. }
            | ResolvedKind::Lottie { width, height, .. }
            | ResolvedKind::Video { width, height, .. }
            | ResolvedKind::Gif { width, height, .. }
            | ResolvedKind::Canvas { width, height, .. }
            | ResolvedKind::Scene3d { width, height, .. }
            | ResolvedKind::Noise { width, height, .. } => Rect::new(0.0, 0.0, *width, *height),
            ResolvedKind::Group { .. }
            | ResolvedKind::MeshGradient { .. }
            | ResolvedKind::Glsl { .. } => return Ok(whole),
        };
        Ok(device_bounds(matrix, local).intersect(whole))
    }

    /// The pixels a path in layer space can touch under `matrix` (see
    /// `raster_bounds`); none for a path with no segments.
    fn path_bounds(&self, path: &BezPath, matrix: Affine) -> PixelRect {
        if path.elements().is_empty() {
            return PixelRect::EMPTY;
        }
        device_bounds(matrix, path.bounding_box()).intersect(self.whole())
    }

    /// The clip as a path in layer space. Empty when it keeps nothing.
    fn clip_path(&mut self, clip: &ResolvedClip, layer: &ResolvedLayer) -> Result<BezPath> {
        Ok(match clip {
            ResolvedClip::Polygon { points } => {
                let mut path = BezPath::new();
                for (i, &(x, y)) in points.iter().enumerate() {
                    if i == 0 {
                        path.move_to((x, y));
                    } else {
                        path.line_to((x, y));
                    }
                }
                path.close_path();
                path
            }
            ResolvedClip::Inset {
                top,
                right,
                bottom,
                left,
                radius,
            } => {
                let b = self.layer_box(layer)?.ok_or_else(|| {
                    Error::Render(format!("layer {:?}: inset clip on a group", layer.id))
                })?;
                inset_path(b, *top, *right, *bottom, *left, *radius)
            }
            ResolvedClip::Ellipse { cx, cy, rx, ry } => {
                if *rx <= 0.0 || *ry <= 0.0 {
                    BezPath::new()
                } else {
                    Ellipse::new((*cx, *cy), (*rx, *ry), 0.0).to_path(SHAPE_TOLERANCE)
                }
            }
            ResolvedClip::Path { d } => BezPath::from_svg(d)
                .map_err(|e| Error::Scene(format!("bad clip SVG path {d:?}: {e}")))?,
        })
    }

    /// The layer's own box in layer space, which `inset` clips are measured
    /// from. A group has one only with a layout: the size the layout gave it.
    fn layer_box(&mut self, layer: &ResolvedLayer) -> Result<Option<Rect>> {
        Ok(match &layer.kind {
            ResolvedKind::Shape { geometry, .. } => Some(match geometry {
                ResolvedGeometry::Rect { width, height }
                | ResolvedGeometry::RoundedRect { width, height, .. }
                | ResolvedGeometry::Ellipse { width, height } => {
                    Rect::new(0.0, 0.0, *width, *height)
                }
                ResolvedGeometry::Path { .. } => geometry_path(geometry)?.bounding_box(),
            }),
            ResolvedKind::Text {
                text,
                font,
                size,
                line_height,
                max_width,
                align,
                runs,
                box_size,
                ..
            } => {
                let laid_out = self.text.layout_layer(
                    text,
                    font,
                    *size,
                    *line_height,
                    *max_width,
                    *align,
                    runs,
                    *box_size,
                );
                let (width, height) = laid_out.box_size(*max_width);
                Some(Rect::new(0.0, 0.0, width, height))
            }
            ResolvedKind::Image { width, height, .. }
            | ResolvedKind::Lottie { width, height, .. }
            | ResolvedKind::Video { width, height, .. }
            | ResolvedKind::Gif { width, height, .. }
            | ResolvedKind::Canvas { width, height, .. }
            | ResolvedKind::Noise { width, height, .. }
            | ResolvedKind::Scene3d { width, height, .. }
            | ResolvedKind::MeshGradient { width, height, .. }
            | ResolvedKind::Glsl { width, height, .. } => {
                Some(Rect::new(0.0, 0.0, *width, *height))
            }
            ResolvedKind::Group { size, .. } => size.map(|(w, h)| Rect::new(0.0, 0.0, w, h)),
        })
    }

}

/// How a layer is moved in 3D: `world` is its `W` (see `warp.rs`; inside a
/// `preserve3d` group, the accumulated one), acting on the plane of the
/// space whose flat matrix is `parent`.
#[derive(Clone, Copy)]
struct Placement {
    parent: Affine,
    world: DMat4,
    /// Not drawn when turned to show its back (`Transform::backface_hidden`).
    backface_hidden: bool,
}

/// Where a `preserve3d` group's children are, while they are being placed.
/// Everything is relative to the space outside the outermost preserve3d group
/// (`parent` is that space's flat matrix, with the margin offset).
#[derive(Clone, Copy)]
struct Space3d {
    parent: Affine,
    /// From the space of the children's parent to the outer space: the product
    /// of the 2D matrices of the preserve3d groups down to it.
    flat: Affine,
    /// The `W` of the children's parent in the outer space (`warp::child_world`
    /// builds a child's from it).
    world: DMat4,
    /// The product of those groups' opacities.
    opacity: f32,
}

/// A layer of a `preserve3d` group waiting for its turn to be drawn.
struct DepthItem<'a> {
    layer: &'a ResolvedLayer,
    /// The list `layer` is in, where its matte source is found.
    siblings: &'a [ResolvedLayer],
    /// Flat matrix of the layer's parent, with the margin: what
    /// `layer_texture` rasterises the layer under.
    flat_parent: Affine,
    placement: Placement,
    /// The preserve3d groups' opacity, to multiply into the layer's own.
    opacity: f32,
    /// What it is sorted by: the z of the layer's centre once placed.
    depth: f64,
}

/// Lists the layers a `preserve3d` group draws: its `children`, with those of
/// preserve3d groups nested in it in their place (nested groups sort as one),
/// in document order. A group that is not itself preserve3d is one item, drawn
/// as a flat picture. `layer_box` gives a layer's box in its own space (none
/// for a group), whose middle is where its depth is measured; a layer without
/// one is measured at its position. Matte sources and layers with no
/// opacity are left out.
fn collect_preserve3d<'a>(
    children: &'a [ResolvedLayer],
    space: Space3d,
    layer_box: &mut impl FnMut(&ResolvedLayer) -> Result<Option<Rect>>,
    out: &mut Vec<DepthItem<'a>>,
) -> Result<()> {
    // A group scaled to nothing shows nothing, and cannot be inverted.
    if !warp::invertible(space.flat) {
        return Ok(());
    }
    for child in children {
        if child.opacity <= 0.0 || is_matte_source(children, child) {
            continue;
        }
        let world = match warp::layer_world(&child.transform) {
            Some(own) => warp::child_world(space.world, space.flat, own),
            None => space.world,
        };
        let flat = space.flat * child.transform.matrix();
        if let ResolvedKind::Group {
            children: inner,
            preserve3d: true,
            ..
        } = &child.kind
        {
            let inner_space = Space3d {
                flat,
                world,
                opacity: space.opacity * child.opacity,
                ..space
            };
            collect_preserve3d(inner, inner_space, layer_box, out)?;
            continue;
        }
        let local = match layer_box(child)? {
            Some(b) => b.center(),
            None => Point::new(child.transform.anchor_x, child.transform.anchor_y),
        };
        let centre = flat * local;
        out.push(DepthItem {
            layer: child,
            siblings: children,
            flat_parent: space.parent * space.flat,
            placement: Placement {
                parent: space.parent,
                world,
                backface_hidden: child.transform.backface_hidden,
            },
            opacity: space.opacity,
            depth: warp::depth(&world, (centre.x, centre.y)),
        });
    }
    Ok(())
}

/// How many half stroke widths past the path a stroke finished as `style`
/// reaches: a miter join as far as its limit, a square cap a corner.
fn stroke_reach(style: &ShapeStyle) -> f64 {
    use crate::scene::{StrokeCap, StrokeJoin};
    let join = if style.join == StrokeJoin::Miter {
        style.miter_limit.max(1.0)
    } else {
        1.0
    };
    let cap = if style.cap == StrokeCap::Square {
        std::f64::consts::SQRT_2
    } else {
        1.0
    };
    join.max(cap)
}

/// The box of a shape in layer space: its geometry, and, if it has a stroke
/// of that width, half the width more all round (times `stroke_reach`), which
/// is as far as its joins and caps reach.
fn shape_box(geometry: &ResolvedGeometry, stroke: Option<(f64, &ShapeStyle)>) -> Result<Rect> {
    let shape = match geometry {
        ResolvedGeometry::Rect { width, height }
        | ResolvedGeometry::RoundedRect { width, height, .. }
        | ResolvedGeometry::Ellipse { width, height } => Rect::new(0.0, 0.0, *width, *height),
        ResolvedGeometry::Path { .. } => geometry_path(geometry)?.bounding_box(),
    };
    let half = stroke.map_or(0.0, |(width, style)| {
        width.max(0.0) / 2.0 * stroke_reach(style)
    });
    Ok(shape.inflate(half, half))
}

/// The pixels that a box `local` in layer space reaches under `matrix`: its
/// corners through the matrix, rounded outwards, with a pixel more all round
/// for the anti-aliased edge. Anywhere (a huge box) if that is not a number.
fn device_bounds(matrix: Affine, local: Rect) -> PixelRect {
    let anywhere = PixelRect::new(i32::MIN / 4, i32::MIN / 4, i32::MAX / 4, i32::MAX / 4);
    bounds::pixel_rect(bounds::transformed(matrix, local).inflate(1.0, 1.0)).unwrap_or(anywhere)
}

/// Where the glyphs of `laid_out` (text of font size `size`, wrapped at
/// `max_width`) can be drawn, in layout space: the layout box and every
/// glyph's origin and advance, grown by one font size on each side, which
/// holds the ink of any glyph that rises or falls less than that from its
/// baseline or overhangs its advance by less (descenders, accents, italic
/// slants). A word wider than `max_width` hangs out of the box, so the glyphs
/// count as well.
///
/// A character with its own style (`chars`) is moved, scaled and turned about
/// its centre: its glyphs' box, grown by the same font size, goes through the
/// character's matrix and is added.
fn text_bounds(
    laid_out: &LaidOutText,
    size: f32,
    max_width: Option<f32>,
    chars: &[Option<ResolvedChar>],
) -> Rect {
    let width = max_width.unwrap_or(0.0).max(laid_out.width);
    let mut b = Rect::new(0.0, 0.0, f64::from(width), f64::from(laid_out.height));
    for glyph in laid_out.runs.iter().flat_map(|run| &run.glyphs) {
        b = b
            .union_pt((f64::from(glyph.x), f64::from(glyph.y)))
            .union_pt((f64::from(glyph.x + glyph.advance), f64::from(glyph.y)));
    }
    let em = f64::from(size).abs();
    let mut b = b.inflate(em, em);
    if let Some([l, t, r, bot]) = laid_out.ink_extent() {
        b = b.union(Rect::new(f64::from(l), f64::from(t), f64::from(r), f64::from(bot)));
    }
    if chars.iter().any(Option::is_some) {
        let centres = laid_out.char_centres();
        for glyph in laid_out.runs.iter().flat_map(|run| &run.glyphs) {
            let Some(style) = char_style(chars, glyph.char_index) else {
                continue;
            };
            let centre = centres.get(&glyph.char_index).copied().unwrap_or_default();
            let ink = Rect::new(
                f64::from(glyph.x),
                f64::from(glyph.y),
                f64::from(glyph.x + glyph.advance),
                f64::from(glyph.y),
            )
            .inflate(em, em);
            b = b.union(bounds::transformed(char_matrix(style, centre), ink));
        }
    }
    b
}

/// The style of the character at code point `index`, if it has one.
pub(crate) fn char_style(chars: &[Option<ResolvedChar>], index: u32) -> Option<&ResolvedChar> {
    chars.get(index as usize).and_then(Option::as_ref)
}

/// Where a styled character goes, in text-box space: moved by its offset,
/// then scaled and turned about its centre.
pub(crate) fn char_matrix(style: &ResolvedChar, centre: (f64, f64)) -> Affine {
    Affine::translate((style.x, style.y))
        * Affine::translate(centre)
        * Affine::rotate(style.rotation.to_radians())
        * Affine::scale(style.scale)
        * Affine::translate((-centre.0, -centre.1))
}

/// `parent` moved `shift` pixels right and down (`Renderer::source_shift`),
/// itself when there is none: the same bits for a layer that is not moved.
fn shifted(shift: (f64, f64), parent: Affine) -> Affine {
    if shift == (0.0, 0.0) {
        parent
    } else {
        Affine::translate(shift) * parent
    }
}

/// What `flush_flat` draws, in order: a leaf, the start of a group's clip, or
/// the end of the innermost clip.
enum FlatOp<'a> {
    /// A leaf, the matrix that takes its layer space to canvas pixels, and the pixels it can touch.
    Leaf(&'a ResolvedLayer, Affine, PixelRect),
    Clip(BezPath, Affine),
    Pop,
}

/// A layer drawn and waiting to be blended onto its canvas.
struct Pending<'a> {
    what: Waiting<'a>,
    opacity: f32,
    mode: BlendMode,
    /// A fused group opens before this layer, or closes after it with this
    /// opacity and blend mode (`BlendLayer`).
    opens: bool,
    closes: Option<(f32, BlendMode)>,
    /// What the layer cache is told when this is blended: the fused group
    /// that closes here was made from `inputs` (`LayerCache::note`).
    note: Option<(Vec<String>, Inputs<'a>)>,
}

impl<'a> Pending<'a> {
    fn new(what: Waiting<'a>, opacity: f32, mode: BlendMode) -> Pending<'a> {
        Pending {
            what,
            opacity,
            mode,
            opens: false,
            closes: None,
            note: None,
        }
    }
}

/// The texture of a `Pending` layer, and what is to be done with it once it
/// is blended.
// A `Tex` is large, and so is a cache entry; a few of these exist at a time.
#[allow(clippy::large_enum_variant)]
enum Waiting<'a> {
    /// The layer cache had it from the last frame: put it back.
    Cached {
        id: Vec<String>,
        hit: cache::Hit<Tex>,
    },
    /// Drawn now, and made from `inputs`: the layer cache keeps it.
    Kept {
        id: Vec<String>,
        inputs: Inputs<'a>,
        texture: Tex,
    },
    /// Drawn now, not for the layer cache: the pool has it back.
    Loose(Tex),
}

impl Pending<'_> {
    fn source(&self) -> &Tex {
        match &self.what {
            Waiting::Cached { hit, .. } => hit.texture(),
            Waiting::Kept { texture, .. } | Waiting::Loose(texture) => texture,
        }
    }
}

/// How many drawn layers may wait to be blended before they are. A flush
/// costs the passes that `blend_many` makes of them; more waiting layers
/// would hold more textures than the pool is likely to have.
const MAX_PENDING: usize = 16;

/// Temporary: `KG_CENSUS=1` prints one line per drawn layer.
fn census(layer: &ResolvedLayer, path: &str, opacity: f32) {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if !*ON.get_or_init(|| std::env::var_os("KG_CENSUS").is_some()) {
        return;
    }
    let kind = format!("{:?}", layer.kind);
    let kind = kind.split([' ', '(', '{']).next().unwrap_or("");
    let effects: Vec<String> = layer
        .effects
        .iter()
        .map(|e| {
            let n = format!("{e:?}");
            n.split([' ', '(', '{']).next().unwrap_or("").to_string()
        })
        .collect();
    eprintln!(
        "CENSUS {path} {kind} fx=[{}] clip={} mask={} matte={} blend={:?} op={opacity:.2} id={}",
        effects.join(","),
        layer.clip.is_some(),
        layer.mask.is_some(),
        layer.matte.is_some(),
        layer.blend_mode,
        layer.id
    );
}

/// Temporary: why `KG_CENSUS=1` finds a group not fused.
fn census_why(layer: &ResolvedLayer, why: &str) {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if *ON.get_or_init(|| std::env::var_os("KG_CENSUS").is_some()) {
        eprintln!("WHY {why} id={}", layer.id);
    }
}

fn is_hidden(layer: &ResolvedLayer) -> bool {
    if layer.motion.is_empty() {
        layer.opacity <= 0.0
    } else {
        layer.motion.iter().all(|sub| sub.opacity <= 0.0)
    }
}

/// Whether `layer` is a plain leaf (a shape or text with a colour or gradient)
/// or a group of them that blends straight onto its canvas: nothing in it
/// needs a texture of its own, so `flush_flat` can draw it with its
/// neighbours.
fn is_flat(layer: &ResolvedLayer) -> bool {
    let is_group = matches!(layer.kind, ResolvedKind::Group { .. });
    // A group's clip is drawn as a clip layer in the scene.
    let plain = layer.blend_mode == BlendMode::Normal
        && layer.opacity == 1.0
        && layer.effects.is_empty()
        && (is_group || layer.clip.is_none())
        && layer.mask.is_none()
        && layer.matte.is_none()
        && layer.motion.is_empty()
        && warp::layer_world(&layer.transform).is_none();
    if !plain {
        return false;
    }
    match &layer.kind {
        ResolvedKind::Group {
            children,
            preserve3d: false,
            glsl: None,
            canvas: None,
            ..
        } => children
            .iter()
            .filter(|c| !is_hidden(c))
            .all(|c| !is_matte_source(children, c) && is_flat(c)),
        ResolvedKind::Shape { .. } | ResolvedKind::Text { .. } => !draws_image(&layer.kind),
        _ => false,
    }
}

/// Whether a leaf is drawn with an image (a flat run of a motion-blurred layer's samples leaves such a leaf out, `is_flat`).
fn draws_image(kind: &ResolvedKind) -> bool {
    let image_paint = |p: &Option<ResolvedPaint>| matches!(p, Some(ResolvedPaint::Image(_)));
    if let ResolvedKind::Shape { fill, .. } = kind
        && image_paint(fill)
    {
        return true;
    }
    if let ResolvedKind::Text { color, .. } = kind
        && matches!(color, ResolvedPaint::Image(_))
    {
        return true;
    }
    if let ResolvedKind::Canvas { ops, .. } = kind {
        return canvas::draws_pictures(ops);
    }
    matches!(
        kind,
        ResolvedKind::Image { .. }
            | ResolvedKind::Lottie { .. }
            | ResolvedKind::Video { .. }
            | ResolvedKind::Gif { .. }
    )
}

/// Whether `layer` is a flat group whose children can be drawn straight onto
/// its parent's canvas, under its matrix, instead of into a buffer of its own
/// that is then blended: it blends normally at opacity 1, with no effects,
/// clip, mask, matte, motion blur or 3D turn, nothing in it reads the backdrop,
/// and every child it draws blends normally, nor passes a blend through from
/// inside it (unless the group is `pass_through`: then they blend with the
/// canvas as they would without it)
/// and is not a preserve3d group (whose children would blend one by one). Its children are then blended
/// onto the canvas in the same order, so the result is the same up to f16
/// rounding: `(b over a) over canvas` against `b over (a over canvas)`.
fn needs_no_buffer(layer: &ResolvedLayer) -> bool {
    let ResolvedKind::Group {
        children,
        preserve3d: false,
        pass_through,
        glsl: None,
        canvas: None,
        ..
    } = &layer.kind
    else {
        return false;
    };
    layer.blend_mode == BlendMode::Normal
        && layer.opacity == 1.0
        && layer.effects.is_empty()
        && layer.clip.is_none()
        && layer.mask.is_none()
        && layer.matte.is_none()
        && layer.motion.is_empty()
        && warp::layer_world(&layer.transform).is_none()
        && !needs_backdrop(layer)
        && children
            .iter()
            .filter(|c| !is_hidden(c) && !is_matte_source(children, c))
            .all(|c| {
                (*pass_through || !blends_outside(c))
                    && !matches!(
                        c.kind,
                        ResolvedKind::Group {
                            preserve3d: true,
                            ..
                        }
                    )
            })
}

/// Whether `layer` blends with whatever is under the group it is in: it has
/// a blend mode itself, or it is a `pass_through` group (no buffer of its own)
/// with something in it that does.
fn blends_outside(layer: &ResolvedLayer) -> bool {
    layer.blend_mode != BlendMode::Normal
        || matches!(&layer.kind, ResolvedKind::Group { children, pass_through: true, .. }
            if children.iter().any(blends_outside))
}

/// Whether another layer in `layers` uses `layer` as its matte.
fn is_matte_source(layers: &[ResolvedLayer], layer: &ResolvedLayer) -> bool {
    layers
        .iter()
        .any(|l| l.matte.as_ref().is_some_and(|m| m.layer == layer.id))
}

/// Whether any of `effects` measures across the layer's box, which then has
/// to be worked out: a sweeping dot matrix, a corner pin.
fn needs_box(effects: &[ResolvedEffect]) -> bool {
    effects.iter().any(|e| {
        matches!(e, ResolvedEffect::CornerPin(_))
            || matches!(e, ResolvedEffect::FilterGraph(g) if g.needs_box())
            || matches!(e, ResolvedEffect::ColorGrade(g) if g.rect.is_none())
            || matches!(e, ResolvedEffect::DotMatrix(d) if d.order == DotOrder::Sweep)
    })
}

/// Whether `effects` blur the backdrop.
fn has_backdrop_blur(effects: &[ResolvedEffect]) -> bool {
    effects
        .iter()
        .any(|e| matches!(e, ResolvedEffect::BackdropBlur { radius } if *radius >= MIN_RADIUS))
}

/// Whether drawing `layer` looks at what is behind it: it blurs the backdrop,
/// or so does something inside it, or one of its motion blur sub-frames does
/// (an animated radius can be under the minimum at the frame itself).
fn needs_backdrop(layer: &ResolvedLayer) -> bool {
    has_backdrop_blur(&layer.effects)
        || matches!(&layer.kind, ResolvedKind::Group { children, .. } if children.iter().any(needs_backdrop))
        || layer.motion.iter().any(needs_backdrop)
}

/// Like `needs_backdrop`, counting the layer's matte source, which is drawn
/// through it.
fn uses_backdrop(siblings: &[ResolvedLayer], layer: &ResolvedLayer) -> bool {
    needs_backdrop(layer)
        || layer
            .matte
            .as_ref()
            .and_then(|m| siblings.iter().find(|l| l.id == m.layer))
            .is_some_and(needs_backdrop)
}

/// Largest side, in pixels, ThorVG is asked to paint a Lottie layer at.
const MAX_LOTTIE_SIDE: f64 = 4096.0;

/// The size in pixels to paint a Lottie layer whose box is `size`, drawn under
/// `matrix`: the box through the matrix's largest stretch, rounded up, and cut
/// down to `MAX_LOTTIE_SIDE` a side. `None` for a box with no area.
pub(crate) fn lottie_pixels(size: (f64, f64), matrix: Affine) -> Option<(u32, u32)> {
    let stretch = bounds::max_stretch(matrix);
    let (width, height) = (size.0 * stretch, size.1 * stretch);
    if !(width > 0.0 && height > 0.0 && width.is_finite() && height.is_finite()) {
        return None;
    }
    let down = (MAX_LOTTIE_SIDE / width.max(height)).min(1.0);
    Some((
        (width * down).ceil().max(1.0) as u32,
        (height * down).ceil().max(1.0) as u32,
    ))
}

/// `b` shrunk by the four distances, with rounded corners. Empty when
/// nothing is left. The radius is limited to half the shorter side.
fn inset_path(b: Rect, top: f64, right: f64, bottom: f64, left: f64, radius: f64) -> BezPath {
    let r = Rect::new(b.x0 + left, b.y0 + top, b.x1 - right, b.y1 - bottom);
    if r.width() <= 0.0 || r.height() <= 0.0 {
        return BezPath::new();
    }
    let radius = radius.min(r.width() / 2.0).min(r.height() / 2.0);
    RoundedRect::from_rect(r, radius).to_path(SHAPE_TOLERANCE)
}

/// The wgpu instance on `backends`.
fn new_instance(backends: wgpu::Backends) -> wgpu::Instance {
    wgpu::Instance::new(wgpu::InstanceDescriptor {
        display: None,
        backends,
        flags: wgpu::InstanceFlags::from_build_config().with_env(),
        memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
        backend_options: wgpu::BackendOptions::from_env_or_default(),
    })
}

/// The wgpu instance, device and queue. Skia's Graphite shares wgpu's device when that is a Metal one (macOS,
/// `render/skia/metal.rs`) or a Vulkan one (Linux and Windows, `render/skia/vulkan.rs`), so those come first. Where
/// there is no such adapter (a Windows machine with no Vulkan driver) wgpu may use any backend that has one, Direct3D 12
/// with its software adapter (WARP) included, and Skia then draws on the CPU (`render/skia/backend.rs`). An explicit
/// `WGPU_BACKEND` decides alone. wgpu itself takes a software adapter (lavapipe, WARP) when it is the only one.
async fn new_gpu() -> Option<(wgpu::Instance, wgpu::Device, wgpu::Queue)> {
    let tries = match wgpu::Backends::from_env() {
        Some(backends) => vec![backends],
        None if cfg!(target_os = "macos") => vec![wgpu::Backends::default()],
        None => vec![wgpu::Backends::VULKAN, wgpu::Backends::PRIMARY],
    };
    for backends in tries {
        let instance = new_instance(backends);
        if let Some((device, queue)) = new_device(&instance).await {
            return Some((instance, device, queue));
        }
    }
    None
}

/// The GPU device: the default adapter, default limits, `CLEAR_TEXTURE` and `PIPELINE_CACHE` when there, plus
/// `TIMESTAMP_QUERY` when there, for `set_pass_timing`.
async fn new_device(instance: &wgpu::Instance) -> Option<(wgpu::Device, wgpu::Queue)> {
    let adapter = wgpu::util::initialize_adapter_from_env_or_default(instance, None)
        .await
        .ok()?;
    let wanted = wgpu::Features::CLEAR_TEXTURE
        | wgpu::Features::PIPELINE_CACHE
        | wgpu::Features::TIMESTAMP_QUERY;
    adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: None,
            required_features: adapter.features() & wanted,
            required_limits: wgpu::Limits::default(),
            ..Default::default()
        })
        .await
        .ok()
}

fn geometry_path(geometry: &ResolvedGeometry) -> Result<BezPath> {
    Ok(match geometry {
        ResolvedGeometry::Rect { width, height } => {
            Rect::new(0.0, 0.0, *width, *height).to_path(SHAPE_TOLERANCE)
        }
        ResolvedGeometry::RoundedRect {
            width,
            height,
            radius,
        } => RoundedRect::new(0.0, 0.0, *width, *height, *radius).to_path(SHAPE_TOLERANCE),
        ResolvedGeometry::Ellipse { width, height } => Ellipse::new(
            (width / 2.0, height / 2.0),
            (width / 2.0, height / 2.0),
            0.0,
        )
        .to_path(SHAPE_TOLERANCE),
        ResolvedGeometry::Path { d } => {
            BezPath::from_svg(d).map_err(|e| Error::Scene(format!("bad SVG path {d:?}: {e}")))?
        }
    })
}

/// The `src` of every image layer in the scene, in order of use. One used
/// twice is listed twice.
fn image_sources(scene: &Scene) -> Vec<String> {
    // `walk_layers` also visits motion-blur copies, which can hold images of
    // their own.
    let mut sources = Vec::new();
    walk_layers(&scene.layers, &mut |layer| match &layer.kind {
        LayerKind::Image(i) => sources.push(i.src.clone()),
        // A picture as a fill or a text colour (`scene::Paint::Image`).
        LayerKind::Shape(ShapeLayer {
            fill: Some(Paint::Image(i)),
            ..
        })
        | LayerKind::Text(TextLayer {
            color: Paint::Image(i),
            ..
        }) => sources.push(i.src.clone()),
        // The pictures a canvas's commands draw.
        LayerKind::Canvas(c) => canvas::sources(&c.commands.0, &mut sources),
        _ => {}
    });
    sources
}

/// Decodes the image file `src`, relative to `base_dir`.
fn read_image(base_dir: &Path, src: &str) -> Result<ImageData> {
    let path = base_dir.join(src);
    // A `data:` URL is decoded from memory, with no file.
    let decoded = if let Some(bytes) = crate::scene::data_uri_bytes(src) {
        image::load_from_memory(&bytes)
            .map_err(|e| Error::Render(format!("cannot decode a data: picture: {e}")))?
    } else {
        image::open(&path)
            .map_err(|e| Error::Render(format!("cannot decode {}: {e}", path.display())))?
    }
    .to_rgba8();
    let (width, height) = decoded.dimensions();
    Ok(ImageData {
        data: Blob::from(decoded.into_raw()),
        format: ImageFormat::Rgba8,
        alpha_type: ImageAlphaType::Alpha,
        width,
        height,
    })
}

/// Decodes every image the scene refers to. The renderer reads them a file at
/// a time (`read_assets`); this is for the test that every committed scene's
/// files load.
#[cfg(test)]
pub(crate) fn load_images(scene: &Scene) -> Result<HashMap<String, ImageData>> {
    let mut images = HashMap::new();
    for src in image_sources(scene) {
        if images.contains_key(&src) {
            continue;
        }
        let image = read_image(&scene.base_dir, &src)?;
        images.insert(src, image);
    }
    Ok(images)
}

/// The model, texture and environment files the 3D layers of `scene` name.
pub(crate) fn scene3d_sources(scene: &Scene) -> Sources3d {
    let mut all = Sources3d::default();
    walk_layers(&scene.layers, &mut |layer| {
        if let LayerKind::Scene3d(s) = &layer.kind {
            let sources = s.sources();
            all.models.extend(sources.models);
            all.textures.extend(sources.textures);
            all.environments.extend(sources.environments);
        }
    });
    all
}

/// A file as the renderer read it. Two scenes that name the same file get
/// the same `FileId` as long as it has not been edited, and the renderer then
/// keeps what it read instead of reading again. (The modification time only
/// decides whether to read again; it never reaches a pixel.)
#[derive(Clone, Debug, PartialEq, Eq)]
struct FileId {
    /// Absolute, so the same file reached from two scenes' directories is one.
    path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
}

impl FileId {
    /// A file that cannot be inspected gets an id no earlier read has, so
    /// the read that follows reports what is wrong with it.
    fn of(path: &Path) -> FileId {
        let path = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
        let meta = std::fs::metadata(&path).ok();
        FileId {
            len: meta.as_ref().map_or(0, std::fs::Metadata::len),
            modified: meta.and_then(|m| m.modified().ok()),
            path,
        }
    }
}

/// The files behind everything a renderer has loaded from scenes, by the
/// name a scene calls it: a font family, an image's or a table's `src`.
#[derive(Default)]
struct Loaded {
    fonts: BTreeMap<String, FileId>,
    images: HashMap<String, FileId>,
    lotties: HashMap<String, FileId>,
    videos: HashMap<String, FileId>,
    gifs: HashMap<String, FileId>,
    luts: HashMap<String, FileId>,
    models: HashMap<String, FileId>,
    textures3d: HashMap<String, FileId>,
    environments: HashMap<String, FileId>,
}

/// What reading a scene's assets found that the renderer did not hold yet
/// (`read_assets`).
struct NewAssets {
    /// An engine with every font, made when a font is new or has changed
    /// (and when the renderer has none).
    text: Option<TextEngine>,
    /// Every font the renderer will hold.
    fonts: BTreeMap<String, FileId>,
    images: Vec<(String, FileId, ImageData)>,
    lotties: Vec<(String, FileId, Lottie)>,
    videos: Vec<(String, FileId, VideoDecoder)>,
    gifs: Vec<(String, FileId, Gif)>,
    luts: Vec<(String, FileId, Lut)>,
    models: Vec<(String, FileId, Model)>,
    textures3d: Vec<(String, FileId, Texture)>,
    environments: Vec<(String, FileId, Environment)>,
    /// A name the renderer already held now stands for another file, so what
    /// the layer cache drew from the old one is out of date.
    rebound: bool,
}

impl NewAssets {
    /// Whether nothing was read: no font, file or table the renderer did not
    /// hold, and none that changed.
    fn is_empty(&self) -> bool {
        self.text.is_none()
            && self.images.is_empty()
            && self.lotties.is_empty()
            && self.videos.is_empty()
            && self.gifs.is_empty()
            && self.luts.is_empty()
            && self.models.is_empty()
            && self.textures3d.is_empty()
            && self.environments.is_empty()
            && !self.rebound
    }
}

/// Reads the fonts, images, Lottie animations, videos, GIFs and tables of `scene` that
/// `loaded` does not have
/// (or has from another file). It changes nothing, so a failure leaves the
/// renderer as it was; `Renderer::install_assets` keeps the result. With
/// `has_text` false the result has a text engine whatever the fonts are.
///
/// Fonts the renderer holds stay registered when the scene does not name
/// them. That cannot change a frame: a text layer's font must be one of the
/// scene's own (`Scene::validate`), and no system fonts are loaded for text
/// to fall back on.
fn read_assets(scene: &Scene, loaded: &Loaded, has_text: bool) -> Result<NewAssets> {
    let mut rebound = false;

    let mut fonts = loaded.fonts.clone();
    // The new fonts' paths, as the scene spells them.
    let mut files = BTreeMap::new();
    for (name, file) in &scene.fonts {
        let path = scene.base_dir.join(file);
        let id = FileId::of(&path);
        match fonts.get(name) {
            Some(held) if *held == id => continue,
            Some(_) => rebound = true,
            None => {}
        }
        files.insert(name.clone(), path.to_string_lossy().into_owned());
        fonts.insert(name.clone(), id);
    }
    let text = if has_text && files.is_empty() {
        None
    } else {
        for (name, id) in &fonts {
            files
                .entry(name.clone())
                .or_insert_with(|| id.path.to_string_lossy().into_owned());
        }
        // Paths are already joined to their scene's directory.
        Some(TextEngine::new(&files, Path::new(""))?)
    };

    let mut images = Vec::new();
    let mut seen = HashSet::new();
    for src in image_sources(scene) {
        if !seen.insert(src.clone()) {
            continue;
        }
        let id = FileId::of(&scene.base_dir.join(&src));
        match loaded.images.get(&src) {
            Some(held) if *held == id => continue,
            Some(_) => rebound = true,
            None => {}
        }
        let image = read_image(&scene.base_dir, &src)?;
        images.push((src, id, image));
    }

    let mut lotties = Vec::new();
    let mut seen = HashSet::new();
    for (layer, src) in lottie_sources(scene) {
        if !seen.insert(src.clone()) {
            continue;
        }
        let id = FileId::of(&scene.base_dir.join(&src));
        match loaded.lotties.get(&src) {
            Some(held) if *held == id => continue,
            Some(_) => rebound = true,
            None => {}
        }
        let lottie = open_lottie(&scene.base_dir, &layer, &src)?;
        lotties.push((src, id, lottie));
    }

    let mut videos = Vec::new();
    let mut seen = HashSet::new();
    for (layer, src) in video_sources(scene) {
        if !seen.insert(src.clone()) {
            continue;
        }
        let id = FileId::of(&scene.base_dir.join(&src));
        match loaded.videos.get(&src) {
            Some(held) if *held == id => continue,
            Some(_) => rebound = true,
            None => {}
        }
        let video = open_video(&scene.base_dir, &layer, &src)?;
        videos.push((src, id, video));
    }

    let mut gifs = Vec::new();
    let mut seen = HashSet::new();
    for (layer, src) in gif_sources(scene) {
        if !seen.insert(src.clone()) {
            continue;
        }
        let id = FileId::of(&scene.base_dir.join(&src));
        match loaded.gifs.get(&src) {
            Some(held) if *held == id => continue,
            Some(_) => rebound = true,
            None => {}
        }
        let gif = open_gif(&scene.base_dir, &layer, &src)?;
        gifs.push((src, id, gif));
    }

    let mut luts = Vec::new();
    let mut seen = HashSet::new();
    for (layer, src) in crate::lut::lut_sources(scene) {
        if !seen.insert(src.clone()) {
            continue;
        }
        let id = FileId::of(&scene.base_dir.join(&src));
        match loaded.luts.get(&src) {
            Some(held) if *held == id => continue,
            Some(_) => rebound = true,
            None => {}
        }
        let lut = crate::lut::read_lut(&scene.base_dir, &layer, &src)?;
        luts.push((src, id, lut));
    }

    let sources3d = scene3d_sources(scene);
    let mut models = Vec::new();
    let mut seen = HashSet::new();
    for src in sources3d.models {
        if !seen.insert(src.clone()) {
            continue;
        }
        let id = FileId::of(&scene.base_dir.join(&src));
        match loaded.models.get(&src) {
            Some(held) if *held == id => continue,
            Some(_) => rebound = true,
            None => {}
        }
        let model = Model::open(&scene.base_dir, &src)?;
        models.push((src, id, model));
    }

    let mut textures3d = Vec::new();
    let mut seen = HashSet::new();
    for src in sources3d.textures {
        if !seen.insert(src.clone()) {
            continue;
        }
        let id = FileId::of(&scene.base_dir.join(&src));
        match loaded.textures3d.get(&src) {
            Some(held) if *held == id => continue,
            Some(_) => rebound = true,
            None => {}
        }
        let texture = Texture::open(&scene.base_dir, &src)?;
        textures3d.push((src, id, texture));
    }

    let mut environments = Vec::new();
    let mut seen = HashSet::new();
    for src in sources3d.environments {
        if !seen.insert(src.clone()) {
            continue;
        }
        let id = FileId::of(&scene.base_dir.join(&src));
        match loaded.environments.get(&src) {
            Some(held) if *held == id => continue,
            Some(_) => rebound = true,
            None => {}
        }
        let environment = Environment::open(&scene.base_dir, &src)?;
        environments.push((src, id, environment));
    }

    Ok(NewAssets {
        text,
        fonts,
        images,
        lotties,
        videos,
        gifs,
        luts,
        models,
        textures3d,
        environments,
        rebound,
    })
}

/// The canvas layer that draws a canvas pass's commands `ops`, `size` across.
fn canvas_layer(id: &str, size: (f64, f64), ops: &std::sync::Arc<Vec<canvas::CanvasOp>>) -> ResolvedLayer {
    ResolvedLayer {
        id: id.to_string(),
        transform: crate::resolve::ResolvedTransform::default(),
        opacity: 1.0,
        blend_mode: BlendMode::Normal,
        effects: Vec::new(),
        clip: None,
        mask: None,
        matte: None,
        kind: ResolvedKind::Canvas {
            width: size.0,
            height: size.1,
            ops: ops.clone(),
        },
        item: None,
        motion: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::TextAlign;

    #[test]
    fn only_a_sweep_and_a_corner_pin_need_the_layer_box() {
        let dots = |order| {
            ResolvedEffect::DotMatrix(crate::resolve::ResolvedDotMatrix {
                size: 12.0,
                progress: 0.5,
                order,
                angle: 0.0,
                stagger: 0.6,
                seed: 1,
                shape: crate::scene::DotShape::Circle,
            })
        };
        assert!(needs_box(&[dots(DotOrder::Sweep)]));
        assert!(!needs_box(&[dots(DotOrder::Random)]));
        assert!(!needs_box(&[]));
        let pin =
            ResolvedEffect::CornerPin(crate::resolve::ResolvedCornerPin { corners: [None; 4] });
        assert!(needs_box(&[dots(DotOrder::Random), pin]));
    }

    #[test]
    fn only_layers_that_blur_the_backdrop_need_it() {
        let json = r##"{"width": 20, "height": 20, "fps": 30, "durationInFrames": 1,
            "layers": [
              {"id": "plain", "type": "group", "children": []},
              {"id": "frost", "type": "group", "children": [],
               "effects": [{"type": "backdropBlur", "radius": 8}]},
              {"id": "faint", "type": "group", "children": [],
               "effects": [{"type": "backdropBlur", "radius": 0.5}]},
              {"id": "outer", "type": "group", "children": [
                {"id": "inner", "type": "group", "children": [
                  {"id": "deep", "type": "group", "children": [],
                   "effects": [{"type": "backdropBlur", "radius": 8}]}]}]},
              {"id": "uses", "type": "group", "children": [], "matte": {"layer": "frost"}},
              {"id": "alone", "type": "group", "children": [], "matte": {"layer": "plain"}}]}"##;
        let scene = Scene::from_json(json, std::path::PathBuf::new()).unwrap();
        let layers = scene.resolve(0).unwrap().layers;
        let needs: Vec<_> = layers
            .iter()
            .map(|l| (l.id.as_str(), uses_backdrop(&layers, l)))
            .collect();
        assert_eq!(
            needs,
            [
                ("plain", false),
                ("frost", true),
                // Below the blur's minimum radius it does nothing.
                ("faint", false),
                ("outer", true),
                ("uses", true),
                ("alone", false)
            ]
        );
    }

    #[test]
    fn only_matte_sources_are_skipped() {
        let json = r##"{"width": 20, "height": 20, "fps": 30, "durationInFrames": 1,
            "layers": [
              {"id": "photo", "type": "group", "children": [], "matte": {"layer": "shape"}},
              {"id": "shape", "type": "group", "children": []},
              {"id": "other", "type": "group", "children": []}]}"##;
        let scene = Scene::from_json(json, std::path::PathBuf::new()).unwrap();
        let resolved = scene.resolve(0).unwrap();
        let skipped: Vec<_> = resolved
            .layers
            .iter()
            .map(|l| is_matte_source(&resolved.layers, l))
            .collect();
        assert_eq!(skipped, [false, true, false]);
        let matte = resolved.layers[0].matte.as_ref().unwrap();
        assert_eq!(matte.layer, "shape");
    }

    #[test]
    fn inset_shrinks_the_box_and_limits_the_radius() {
        let b = Rect::new(0.0, 0.0, 100.0, 50.0);
        let path = inset_path(b, 5.0, 10.0, 15.0, 20.0, 0.0);
        assert_eq!(path.bounding_box(), Rect::new(20.0, 5.0, 90.0, 35.0));
        // A huge radius turns the 70 x 30 rectangle into a stadium; its
        // bounding box is unchanged.
        let round = inset_path(b, 5.0, 10.0, 15.0, 20.0, 1000.0);
        let bb = round.bounding_box();
        assert!((bb.x0 - 20.0).abs() < 1e-9 && (bb.y1 - 35.0).abs() < 1e-9);
        // A negative inset grows past the box.
        let grown = inset_path(b, -4.0, -4.0, -4.0, -4.0, 0.0);
        assert_eq!(grown.bounding_box(), Rect::new(-4.0, -4.0, 104.0, 54.0));
    }

    #[test]
    fn inset_with_nothing_left_is_empty() {
        let b = Rect::new(0.0, 0.0, 100.0, 50.0);
        assert!(
            inset_path(b, 0.0, 60.0, 0.0, 40.0, 0.0)
                .elements()
                .is_empty()
        );
        assert!(
            inset_path(b, 25.0, 0.0, 25.0, 0.0, 0.0)
                .elements()
                .is_empty()
        );
    }

    /// The box of a rect shape or an empty group, which is all these tests
    /// use; the renderer's own `layer_box` needs a GPU for the rest.
    fn test_box(layer: &ResolvedLayer) -> Result<Option<Rect>> {
        Ok(match &layer.kind {
            ResolvedKind::Shape {
                geometry: ResolvedGeometry::Rect { width, height },
                ..
            } => Some(Rect::new(0.0, 0.0, *width, *height)),
            _ => None,
        })
    }

    /// `layers_json` at frame 0 as the top-level layers, resolved.
    fn resolve_layers(layers_json: &str) -> Vec<ResolvedLayer> {
        let json = format!(
            r##"{{"width": 400, "height": 300, "fps": 30, "durationInFrames": 1,
                "layers": {layers_json}}}"##
        );
        Scene::from_json(&json, std::path::PathBuf::new())
            .unwrap()
            .resolve(0)
            .unwrap()
            .layers
    }

    fn card(id: &str, transform: &str) -> String {
        format!(
            r##"{{"id": "{id}", "type": "shape", "fill": "#fff",
                "shape": {{"kind": "rect", "width": 20, "height": 10}}, "transform": {transform}}}"##
        )
    }

    /// The ids of what a preserve3d group at the top of `layers` draws, in
    /// painting order.
    fn painting_order(layers: &[ResolvedLayer]) -> (Vec<(String, f32)>, Vec<DepthItem<'_>>) {
        let ResolvedKind::Group { children, .. } = &layers[0].kind else {
            panic!("not a group");
        };
        let space = Space3d {
            parent: Affine::IDENTITY,
            flat: layers[0].transform.matrix(),
            world: warp::layer_world(&layers[0].transform).unwrap_or(DMat4::IDENTITY),
            opacity: layers[0].opacity,
        };
        let mut items = Vec::new();
        collect_preserve3d(children, space, &mut test_box, &mut items).unwrap();
        warp::sort_far_to_near(&mut items, |i| i.depth);
        let order = items
            .iter()
            .map(|i| (i.layer.id.clone(), i.opacity))
            .collect();
        (order, items)
    }

    fn ids(order: &[(String, f32)]) -> Vec<&str> {
        order.iter().map(|(id, _)| id.as_str()).collect()
    }

    #[test]
    fn a_preserve3d_group_paints_far_to_near_whatever_the_document_order() {
        let cards = [
            card("front", r#"{"z": 40}"#),
            card("back", r#"{"z": -50}"#),
            card("mid", r#"{"z": 0}"#),
        ]
        .join(",");
        let layers = resolve_layers(&format!(
            r#"[{{"id": "g", "type": "group", "preserve3d": true, "children": [{cards}]}}]"#
        ));
        let (order, _) = painting_order(&layers);
        assert_eq!(ids(&order), ["back", "mid", "front"]);
    }

    #[test]
    fn layers_at_the_same_depth_keep_document_order() {
        let cards = [
            card("a", r#"{"x": 100, "z": 10}"#),
            card("b", r#"{"x": 150, "z": -10}"#),
            card("c", r#"{"x": 200, "z": 10}"#),
            card("d", r#"{"x": 250, "z": 10}"#),
        ]
        .join(",");
        let layers = resolve_layers(&format!(
            r#"[{{"id": "g", "type": "group", "preserve3d": true, "children": [{cards}]}}]"#
        ));
        let (order, _) = painting_order(&layers);
        assert_eq!(ids(&order), ["b", "a", "c", "d"]);
    }

    #[test]
    fn turning_the_group_turns_the_depth_order() {
        // Three cards side by side at one depth. Turn the group a quarter
        // about the vertical axis and the one on the right is the farthest.
        let cards = [
            card("left", r#"{"x": -40}"#),
            card("middle", r#"{"x": 0}"#),
            card("right", r#"{"x": 40}"#),
        ]
        .join(",");
        let group = |turn: f64| {
            resolve_layers(&format!(
                r#"[{{"id": "g", "type": "group", "preserve3d": true,
                     "transform": {{"x": 200, "y": 150, "rotateY": {turn}}}, "children": [{cards}]}}]"#
            ))
        };
        let flat = group(0.0);
        assert_eq!(ids(&painting_order(&flat).0), ["left", "middle", "right"]);
        let turned = group(60.0);
        assert_eq!(ids(&painting_order(&turned).0), ["right", "middle", "left"]);
        let other_way = group(-60.0);
        assert_eq!(
            ids(&painting_order(&other_way).0),
            ["left", "middle", "right"]
        );
    }

    #[test]
    fn a_layers_depth_is_measured_at_the_middle_of_its_box() {
        // Both sit at the group's origin, but the wide one's middle is 100
        // px to the right, which a quarter turn sends far back.
        let cards = [
            r##"{"id": "wide", "type": "shape", "fill": "#fff",
                "shape": {"kind": "rect", "width": 200, "height": 10}}"##
                .to_string(),
            card("narrow", r#"{"x": 0}"#),
        ]
        .join(",");
        let layers = resolve_layers(&format!(
            r#"[{{"id": "g", "type": "group", "preserve3d": true,
                 "transform": {{"rotateY": 90}}, "children": [{cards}]}}]"#
        ));
        let (order, items) = painting_order(&layers);
        assert_eq!(ids(&order), ["wide", "narrow"]);
        // 100 px right of the pivot at a quarter turn is 100 px back; the
        // narrow one's middle is 10 px right, 10 px back.
        assert!((items[0].depth + 100.0).abs() < 1e-9);
        assert!((items[1].depth + 10.0).abs() < 1e-9);
    }

    #[test]
    fn a_groups_depth_is_measured_at_its_position() {
        // A plain group has no box: it sorts at its position. Rotating the
        // parent a quarter turn sends the one at x = 80 behind the one at 0.
        let layers = resolve_layers(
            r#"[{"id": "g", "type": "group", "preserve3d": true,
                 "transform": {"rotateY": 90}, "children": [
                   {"id": "right", "type": "group", "transform": {"x": 80}, "children": []},
                   {"id": "origin", "type": "group", "children": []}]}]"#,
        );
        let (order, items) = painting_order(&layers);
        assert_eq!(ids(&order), ["right", "origin"]);
        assert!((items[0].depth + 80.0).abs() < 1e-9);
    }

    #[test]
    fn nested_preserve3d_groups_sort_with_their_parents_children() {
        let inner = [
            card("in-near", r#"{"z": 30}"#),
            card("in-far", r#"{"z": -30}"#),
        ]
        .join(",");
        let layers = resolve_layers(&format!(
            r#"[{{"id": "g", "type": "group", "preserve3d": true, "children": [
                 {first},
                 {{"id": "nested", "type": "group", "preserve3d": true,
                   "transform": {{"z": 5}}, "children": [{inner}]}},
                 {last}]}}]"#,
            first = card("first", r#"{"z": 10}"#),
            last = card("last", r#"{"z": -50}"#),
        ));
        let (order, items) = painting_order(&layers);
        // The nested group's z of 5 is added to its children's.
        assert_eq!(ids(&order), ["last", "in-far", "first", "in-near"]);
        let depth = |id: &str| items.iter().find(|i| i.layer.id == id).unwrap().depth;
        assert!((depth("in-far") + 25.0).abs() < 1e-9);
        assert!((depth("in-near") - 35.0).abs() < 1e-9);
        // Siblings are the list the layer is in, for its matte source.
        let nested: Vec<_> = items
            .iter()
            .filter(|i| i.layer.id.starts_with("in-"))
            .collect();
        assert!(nested.iter().all(|i| i.siblings.len() == 2));
    }

    #[test]
    fn placements_compose_the_whole_chain_of_matrices() {
        // A preserve3d group inside another, each moved and turned in 3D
        // and in 2D, around a card with its own 3D transform: the card's
        // world matrix times its flat matrix is the product of the three
        // full matrices from the formula.
        let layers = resolve_layers(&format!(
            r#"[{{"id": "outer", "type": "group", "preserve3d": true,
                 "transform": {{"x": 90, "y": 60, "rotation": 12, "scale": 1.4, "rotateY": 35, "z": 20,
                               "anchorX": 5, "anchorY": 7}},
                 "children": [{{"id": "inner", "type": "group", "preserve3d": true,
                   "transform": {{"x": 30, "y": -10, "rotateX": -20, "rotation": -8, "scale": 0.8}},
                   "children": [{card}]}}]}}]"#,
            card = card(
                "leaf",
                r#"{"x": 12, "y": 9, "z": 15, "rotateY": 50, "rotateX": 10, "rotation": 25, "anchorX": 10, "anchorY": 5}"#
            ),
        ));
        let (_, items) = painting_order(&layers);
        assert_eq!(items.len(), 1);
        let item = &items[0];
        let ResolvedKind::Group { children, .. } = &layers[0].kind else {
            unreachable!()
        };
        let inner = &children[0];
        let ResolvedKind::Group { children, .. } = &inner.kind else {
            unreachable!()
        };
        let leaf = &children[0];
        let want = warp::full_matrix(&layers[0].transform)
            * warp::full_matrix(&inner.transform)
            * warp::full_matrix(&leaf.transform);
        let flat = item.flat_parent * leaf.transform.matrix();
        let got = item.placement.world * warp::flat(flat);
        assert!(got.abs_diff_eq(want, 1e-8), "{got:?} vs {want:?}");
        // The layer is rasterised under the groups' flat matrices alone.
        assert_eq!(
            item.flat_parent,
            layers[0].transform.matrix() * inner.transform.matrix()
        );
    }

    #[test]
    fn group_opacities_multiply_into_the_layers_and_hidden_ones_are_skipped() {
        let layers = resolve_layers(&format!(
            r##"[{{"id": "g", "type": "group", "preserve3d": true, "opacity": 0.5, "children": [
                 {a},
                 {{"id": "hidden", "type": "group", "preserve3d": true, "opacity": 0,
                   "children": [{b}]}},
                 {{"id": "faded", "type": "group", "preserve3d": true, "opacity": 0.5,
                   "children": [{c}]}},
                 {{"id": "cut", "type": "shape", "fill": "#fff", "matte": {{"layer": "source"}},
                   "shape": {{"kind": "rect", "width": 5, "height": 5}}}},
                 {{"id": "source", "type": "shape", "fill": "#fff",
                   "shape": {{"kind": "rect", "width": 5, "height": 5}}}}]}}]"##,
            a = card("a", "{}"),
            b = card("b-in-hidden", "{}"),
            c = card("c-in-faded", "{}"),
        ));
        let (order, _) = painting_order(&layers);
        // `source` is only drawn through `cut`; `hidden` and what is in it
        // are not drawn at all.
        assert_eq!(ids(&order), ["a", "c-in-faded", "cut"]);
        assert_eq!(order[0].1, 0.5);
        assert_eq!(order[1].1, 0.25);
        assert_eq!(order[2].1, 0.5);
    }

    #[test]
    fn only_groups_that_change_nothing_about_blending_skip_their_buffer() {
        let group = |fields: &str, children: &str| {
            let json =
                format!(r##"[{{"id": "g", "type": "group"{fields}, "children": [{children}]}}]"##);
            needs_no_buffer(&resolve_layers(&json)[0])
        };
        let plain = format!("{}, {}", card("a", "{}"), card("b", r##"{"x": 5}"##));
        assert!(group("", &plain));
        assert!(group(
            r##", "transform": {"x": 10, "rotation": 30, "scale": 2}"##,
            &plain
        ));
        // A faded child is blended by itself either way.
        assert!(group(
            "",
            r##"{"id": "c", "type": "shape", "fill": "#fff", "opacity": 0.5,
            "shape": {"kind": "rect", "width": 5, "height": 5}}"##
        ));
        // A plain group inside: blended normally, whatever it does itself.
        assert!(group(
            "",
            r##"{"id": "inner", "type": "group", "children": [
            {"id": "m", "type": "shape", "fill": "#fff", "blendMode": "multiply",
              "shape": {"kind": "rect", "width": 5, "height": 5}}]}"##
        ));
        // A pass-through group inside whose child blends reaches the backdrop
        // of the group it is in, which then keeps its buffer (an SVG with a
        // multiply in it, in a div that turns: the blend stays in the div).
        let through = |id: &str, inner: &str| {
            format!(
                r##"{{"id": "{id}", "type": "group", "passThrough": true, "children": [{inner}]}}"##
            )
        };
        let multiply = r##"{"id": "m", "type": "shape", "fill": "#fff", "blendMode": "multiply",
            "shape": {"kind": "rect", "width": 5, "height": 5}}"##;
        assert!(!group("", &through("svg", multiply)));
        assert!(!group("", &through("outer", &through("svg", multiply))));
        assert!(group("", &through("svg", &card("a", "{}"))));
        // The pass-through group itself passes it on up, so it may skip its own.
        let json = format!(
            r##"[{{"id": "g", "type": "group", "passThrough": true, "children": [{multiply}]}}]"##
        );
        assert!(needs_no_buffer(&resolve_layers(&json)[0]));
        // A hidden child, or a matte source, is not drawn by the group.
        assert!(group(
            "",
            r##"{"id": "h", "type": "shape", "fill": "#fff", "opacity": 0,
            "blendMode": "screen", "shape": {"kind": "rect", "width": 5, "height": 5}},
            {"id": "cut", "type": "shape", "fill": "#fff", "matte": {"layer": "src"},
            "shape": {"kind": "rect", "width": 5, "height": 5}},
            {"id": "src", "type": "shape", "fill": "#fff", "blendMode": "multiply",
            "shape": {"kind": "rect", "width": 5, "height": 5}}"##
        ));

        for fields in [
            r##", "opacity": 0.5"##,
            r##", "blendMode": "multiply""##,
            r##", "effects": [{"type": "blur", "radius": 4}]"##,
            r##", "clip": {"kind": "polygon", "points": [[0, 0], [9, 0], [0, 9]]}"##,
            r##", "transform": {"rotateY": 20}"##,
            r##", "motionBlur": {"samples": 4, "shutter": 1}, "transform": {"x": [{"frame": 0, "value": 0}, {"frame": 1, "value": 10}]}"##,
            r##", "preserve3d": true"##,
        ] {
            assert!(!group(fields, &plain), "{fields}");
        }
        // A child that blends against what is under it, or reads it.
        assert!(!group(
            "",
            r##"{"id": "m", "type": "shape", "fill": "#fff", "blendMode": "multiply",
            "shape": {"kind": "rect", "width": 5, "height": 5}}"##
        ));
        assert!(!group(
            "",
            r##"{"id": "f", "type": "shape", "fill": "#fff",
            "effects": [{"type": "backdropBlur", "radius": 8}],
            "shape": {"kind": "rect", "width": 5, "height": 5}}"##
        ));
        assert!(!group(
            "",
            &format!(
                r##"{{"id": "p", "type": "group", "preserve3d": true,
            "children": [{}]}}"##,
                card("a", "{}")
            )
        ));
        // Not a group at all.
        assert!(!needs_no_buffer(
            &resolve_layers(&format!("[{}]", card("a", "{}")))[0]
        ));
    }

    #[test]
    fn a_group_scaled_to_nothing_draws_nothing() {
        let layers = resolve_layers(&format!(
            r#"[{{"id": "g", "type": "group", "preserve3d": true,
                 "transform": {{"scale": 0}}, "children": [{}]}}]"#,
            card("a", r#"{"z": 5}"#)
        ));
        assert!(painting_order(&layers).0.is_empty());
    }

    #[test]
    fn a_blurred_layer_is_hidden_only_when_every_sub_frame_is() {
        // Fades in across frames 0..2; the shutter reaches back to before it.
        let layers = resolve_layers(
            r##"[{"id": "fade", "type": "shape", "fill": "#fff",
                  "shape": {"kind": "rect", "width": 20, "height": 10},
                  "opacity": [{"frame": 0, "value": 0}, {"frame": 2, "value": 1}],
                  "motionBlur": {"samples": 4, "shutter": 1}},
                 {"id": "gone", "type": "shape", "fill": "#fff",
                  "shape": {"kind": "rect", "width": 20, "height": 10},
                  "opacity": 0, "motionBlur": {"samples": 4, "shutter": 1}},
                 {"id": "plain", "type": "shape", "fill": "#fff",
                  "shape": {"kind": "rect", "width": 20, "height": 10}, "opacity": 0}]"##,
        );
        // Frame 0 itself is invisible, but frame 0.375 is not.
        assert_eq!(layers[0].opacity, 0.0);
        assert!(!is_hidden(&layers[0]));
        assert!(is_hidden(&layers[1]) && is_hidden(&layers[2]));
    }

    #[test]
    fn a_blurred_layer_needs_the_backdrop_when_a_sub_frame_frosts_it() {
        // The radius is 0 at frame 0 and grows after it; the shutter reaches
        // past it.
        let layers = resolve_layers(
            r##"[{"id": "frost", "type": "group", "children": [],
                  "effects": [{"type": "backdropBlur",
                    "radius": [{"frame": 0, "value": 0}, {"frame": 1, "value": 16}]}],
                  "motionBlur": {"samples": 4, "shutter": 1}}]"##,
        );
        assert!(!has_backdrop_blur(&layers[0].effects));
        assert!(uses_backdrop(&layers, &layers[0]));
    }

    #[test]
    fn a_shape_reaches_half_its_strokes_width_past_its_geometry() {
        let rect = ResolvedGeometry::Rect {
            width: 40.0,
            height: 20.0,
        };
        assert_eq!(
            shape_box(&rect, None).unwrap(),
            Rect::new(0.0, 0.0, 40.0, 20.0)
        );
        let plain = ShapeStyle::default();
        assert_eq!(
            shape_box(&rect, Some((10.0, &plain))).unwrap(),
            Rect::new(-5.0, -5.0, 45.0, 25.0)
        );
        // A miter join reaches as far as its limit, a square cap a corner.
        let miter = ShapeStyle {
            join: crate::scene::StrokeJoin::Miter,
            miter_limit: 3.0,
            ..ShapeStyle::default()
        };
        assert_eq!(
            shape_box(&rect, Some((10.0, &miter))).unwrap(),
            Rect::new(-15.0, -15.0, 55.0, 35.0)
        );
        let square = ShapeStyle {
            cap: crate::scene::StrokeCap::Square,
            ..ShapeStyle::default()
        };
        let reach = 5.0 * std::f64::consts::SQRT_2;
        assert!((shape_box(&rect, Some((10.0, &square))).unwrap().x0 + reach).abs() < 1e-9);
        // A rounded corner or an ellipse stays in the box.
        let round = ResolvedGeometry::RoundedRect {
            width: 40.0,
            height: 20.0,
            radius: 8.0,
        };
        assert_eq!(
            shape_box(&round, None).unwrap(),
            shape_box(&rect, None).unwrap()
        );
        // A path is its curves' box, not its control points': the curve
        // from (0, 0) through a control at (50, 100) to (100, 0) peaks at 50.
        let curve = ResolvedGeometry::Path {
            d: "M 0 0 Q 50 100 100 0".into(),
        };
        let b = shape_box(&curve, None).unwrap();
        assert!(
            (b.y1 - 50.0).abs() < 1e-9 && b.x0 == 0.0 && b.x1 == 100.0,
            "{b:?}"
        );
        let bad = ResolvedGeometry::Path {
            d: "not a path".into(),
        };
        assert!(shape_box(&bad, None).is_err());
    }

    #[test]
    fn device_boxes_are_the_matrix_image_a_pixel_wider_and_rounded_out() {
        let local = Rect::new(0.0, 0.0, 10.0, 4.0);
        // Moved by a fraction: 10.3 - 1 = 9.3 rounds down to 9, 20.3 + 1 = 21.3 up to 22.
        let moved = Affine::translate((10.3, 5.0));
        assert_eq!(device_bounds(moved, local), PixelRect::new(9, 4, 22, 10));
        // Turned a quarter: the box is 4 wide and 10 tall.
        let turned = Affine::translate((50.0, 50.0)) * Affine::rotate(std::f64::consts::FRAC_PI_2);
        assert_eq!(device_bounds(turned, local), PixelRect::new(45, 49, 51, 61));
        // Not a number: anywhere.
        let nan = device_bounds(Affine::scale(f64::NAN), local);
        assert!(nan.x0 < -1_000_000 && nan.x1 > 1_000_000);
    }

    fn text_engine() -> TextEngine {
        let fonts = std::collections::BTreeMap::from([(
            "DM Sans".to_string(),
            "assets/fonts/DMSans-Medium.ttf".to_string(),
        )]);
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        TextEngine::new(&fonts, &root).unwrap()
    }

    #[test]
    fn text_is_bounded_by_its_layout_and_its_glyphs_a_font_size_wider() {
        let mut engine = text_engine();
        let laid_out = engine.layout("Hello world", "DM Sans", 40.0, None, None, TextAlign::Left);
        let b = text_bounds(&laid_out, 40.0, None, &[]);
        assert_eq!(b.x0, -40.0);
        assert_eq!(b.y0, -40.0);
        assert!((b.x1 - (f64::from(laid_out.width) + 40.0)).abs() < 1e-3);
        assert!((b.y1 - (f64::from(laid_out.height) + 40.0)).abs() < 1e-3);
        // Every glyph's origin and advance is inside.
        for glyph in laid_out.runs.iter().flat_map(|r| &r.glyphs) {
            assert!(f64::from(glyph.x) >= b.x0 && f64::from(glyph.x + glyph.advance) <= b.x1);
            assert!(f64::from(glyph.y) >= b.y0 && f64::from(glyph.y) <= b.y1);
        }
        // A word wider than the wrap width hangs out of the box, and the
        // bounds follow it.
        let wide = engine.layout(
            "Unbreakable",
            "DM Sans",
            40.0,
            None,
            Some(60.0),
            TextAlign::Left,
        );
        let b = text_bounds(&wide, 40.0, Some(60.0), &[]);
        assert!(
            f64::from(wide.width) > 60.0,
            "the word fits: {}",
            wide.width
        );
        assert!(b.x1 >= f64::from(wide.width) + 40.0 - 1e-3, "{b:?}");
        // A box wider than the text (a wrap width) counts as it is.
        let b = text_bounds(&laid_out, 40.0, Some(500.0), &[]);
        assert_eq!(b.x1, 540.0);
    }

    /// A scene with an image that has a table, in `dir`, whose fonts are
    /// `fonts` (family -> file).
    fn assets_scene(dir: &Path, fonts: &[(&str, &str)]) -> Scene {
        let fonts: BTreeMap<&str, &str> = fonts.iter().copied().collect();
        let json = serde_json::json!({
            "width": 64, "height": 64, "fps": 30, "durationInFrames": 2,
            "fonts": fonts,
            "layers": [
                { "id": "pic", "type": "image", "src": "pic.png", "width": 8, "height": 8,
                  "effects": [{ "type": "lut", "src": "look.cube" }] },
            ],
        });
        Scene::from_json(&json.to_string(), dir.to_path_buf()).unwrap()
    }

    fn write_assets(dir: &Path, cube_comment: &str) {
        std::fs::create_dir_all(dir).unwrap();
        image::RgbaImage::from_pixel(8, 8, image::Rgba([1, 2, 3, 255]))
            .save(dir.join("pic.png"))
            .unwrap();
        std::fs::write(
            dir.join("look.cube"),
            format!(
                "# {cube_comment}\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n"
            ),
        )
        .unwrap();
    }

    /// What `Renderer::install_assets` records.
    fn hold(loaded: &mut Loaded, fresh: &NewAssets) {
        loaded.fonts = fresh.fonts.clone();
        for (src, id, _) in &fresh.images {
            loaded.images.insert(src.clone(), id.clone());
        }
        for (src, id, _) in &fresh.lotties {
            loaded.lotties.insert(src.clone(), id.clone());
        }
        for (src, id, _) in &fresh.videos {
            loaded.videos.insert(src.clone(), id.clone());
        }
        for (src, id, _) in &fresh.gifs {
            loaded.gifs.insert(src.clone(), id.clone());
        }
        for (src, id, _) in &fresh.luts {
            loaded.luts.insert(src.clone(), id.clone());
        }
    }

    fn style(x: f64, y: f64, scale: f64, rotation: f64) -> ResolvedChar {
        ResolvedChar {
            x,
            y,
            scale,
            rotation,
            opacity: 1.0,
            color: None,
        }
    }

    #[test]
    fn assets_are_read_once_and_again_only_when_they_changed() {
        let base = std::env::temp_dir().join(format!("kinetograph-assets-{}", std::process::id()));
        let (a, b) = (base.join("a"), base.join("b"));
        write_assets(&a, "a");
        write_assets(&b, "b, a file of another length");
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let font = root.join("assets/fonts/DMSans-Medium.ttf");
        let font = font.to_str().unwrap();
        let mut loaded = Loaded::default();

        // The first read gets everything, and an engine.
        let scene = assets_scene(&a, &[("DM Sans", font)]);
        let fresh = read_assets(&scene, &loaded, false).unwrap();
        assert!(fresh.text.is_some() && !fresh.rebound);
        assert_eq!((fresh.images.len(), fresh.luts.len()), (1, 1));
        hold(&mut loaded, &fresh);

        // The same scene again: nothing to do.
        let fresh = read_assets(&scene, &loaded, true).unwrap();
        assert!(fresh.text.is_none() && !fresh.rebound);
        assert!(fresh.images.is_empty() && fresh.luts.is_empty());

        // Another directory: the same names stand for other files.
        let moved = assets_scene(&b, &[("DM Sans", font)]);
        let fresh = read_assets(&moved, &loaded, true).unwrap();
        assert!(fresh.rebound);
        assert_eq!((fresh.images.len(), fresh.luts.len()), (1, 1));
        // The font is the same file, spelt as an absolute path both times.
        assert!(fresh.text.is_none());

        // A new family builds a new engine and rebinds nothing.
        let more = assets_scene(&a, &[("DM Sans", font), ("Second", font)]);
        let fresh = read_assets(&more, &loaded, true).unwrap();
        assert!(fresh.text.is_some() && !fresh.rebound);
        assert_eq!(fresh.fonts.len(), 2);
        hold(&mut loaded, &fresh);

        // A family that is not named again stays.
        let fewer = assets_scene(&a, &[]);
        let fresh = read_assets(&fewer, &loaded, true).unwrap();
        assert!(fresh.text.is_none() && fresh.fonts.len() == 2);

        // A file edited in place is read again.
        write_assets(&a, "a, edited so that it is longer");
        let fresh = read_assets(&scene, &loaded, true).unwrap();
        assert!(fresh.rebound && fresh.luts.len() == 1);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn lottie_files_are_read_once_like_images() {
        let anims = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scenes/anims");
        let json = serde_json::json!({
            "width": 64, "height": 64, "fps": 30, "durationInFrames": 2,
            "layers": [
                { "id": "a", "type": "lottie", "src": "burst.json", "width": 32, "height": 32 },
                { "id": "b", "type": "lottie", "src": "burst.json", "width": 16, "height": 16 },
            ],
        });
        let scene = Scene::from_json(&json.to_string(), anims).unwrap();
        let mut loaded = Loaded::default();
        let fresh = read_assets(&scene, &loaded, false).unwrap();
        // Two layers, one file.
        assert_eq!(fresh.lotties.len(), 1);
        hold(&mut loaded, &fresh);
        // The next frame's scene names it again: nothing is read.
        let fresh = read_assets(&scene, &loaded, true).unwrap();
        assert!(fresh.lotties.is_empty() && !fresh.rebound);
    }

    #[test]
    fn video_and_gif_files_are_opened_once_per_file() {
        let media = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scenes/media");
        let json = serde_json::json!({
            "width": 64, "height": 64, "fps": 24, "durationInFrames": 2,
            "layers": [
                { "id": "a", "type": "video", "src": "clip.mp4" },
                { "id": "b", "type": "video", "src": "clip.mp4", "trimBefore": 12 },
                { "id": "c", "type": "gif", "src": "spinner.gif" },
                { "id": "d", "type": "gif", "src": "spinner.gif", "loop": false },
            ],
        });
        let scene = Scene::from_json(&json.to_string(), media).unwrap();
        let mut loaded = Loaded::default();
        let fresh = read_assets(&scene, &loaded, false).unwrap();
        // Four layers, two files.
        assert_eq!((fresh.videos.len(), fresh.gifs.len()), (1, 1));
        hold(&mut loaded, &fresh);
        // The next frame's scene names them again: nothing is read.
        let fresh = read_assets(&scene, &loaded, true).unwrap();
        assert!(fresh.videos.is_empty() && fresh.gifs.is_empty() && !fresh.rebound);
    }

    #[test]
    fn a_missing_file_fails_the_read_and_names_it() {
        let dir = std::env::temp_dir().join(format!("kinetograph-missing-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let scene = assets_scene(&dir, &[]);
        let err = read_assets(&scene, &Loaded::default(), false)
            .err()
            .expect("read a missing image")
            .to_string();
        assert!(err.contains("pic.png"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_character_turns_and_scales_about_its_centre_after_its_offset() {
        let centre = (30.0, 20.0);
        // Nothing set: the identity.
        assert_eq!(
            char_matrix(&style(0.0, 0.0, 1.0, 0.0), centre),
            Affine::IDENTITY
        );
        // Scale and turn leave the centre where it is.
        let m = char_matrix(&style(0.0, 0.0, 2.5, 70.0), centre);
        assert!((m * Point::new(30.0, 20.0)).distance(Point::new(30.0, 20.0)) < 1e-9);
        // 90 degrees clockwise (y down): the point to the right of the centre
        // goes below it, at twice the distance for a scale of 2.
        let m = char_matrix(&style(0.0, 0.0, 2.0, 90.0), centre);
        assert!((m * Point::new(40.0, 20.0)).distance(Point::new(30.0, 40.0)) < 1e-9);
        // The offset moves the centre.
        let m = char_matrix(&style(5.0, -7.0, 2.0, 90.0), centre);
        assert!((m * Point::new(30.0, 20.0)).distance(Point::new(35.0, 13.0)) < 1e-9);
    }

    #[test]
    fn styled_characters_widen_the_text_bounds_and_the_rest_do_not() {
        let mut engine = text_engine();
        let laid_out = engine.layout("Hello", "DM Sans", 40.0, None, None, TextAlign::Left);
        let plain = text_bounds(&laid_out, 40.0, None, &[]);
        // Only null entries: the same box.
        assert_eq!(
            text_bounds(&laid_out, 40.0, None, &[None, None, None]),
            plain
        );
        // Styled but not moved: inside it.
        let b = text_bounds(&laid_out, 40.0, None, &[Some(style(0.0, 0.0, 1.0, 0.0))]);
        assert_eq!(b, plain);
        // The last letter thrown 300 px down and made twice as big.
        let chars = [None, None, None, None, Some(style(0.0, 300.0, 2.0, 0.0))];
        let b = text_bounds(&laid_out, 40.0, None, &chars);
        assert!(b.y1 > plain.y1 + 250.0, "{b:?} vs {plain:?}");
        assert!(b.x1 > plain.x1, "{b:?} vs {plain:?}");
        assert_eq!((b.x0, b.y0), (plain.x0, plain.y0));
    }

}
