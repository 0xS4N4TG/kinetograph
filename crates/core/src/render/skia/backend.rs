//! The Skia backend's frame loop (`Renderer::skia_canvas`): one Graphite context on wgpu's device and queue (made by
//! `metal.rs` or `vulkan.rs`) and the textures it draws to.

use std::cell::RefCell;
use std::collections::{HashSet, VecDeque};
use std::io::Write;
use std::rc::Rc;
use std::sync::Mutex;

use skia_safe::gpu::graphite;
use skia_safe::{AlphaType, Canvas, ColorSpace, ColorType, Image, Surface};
use kurbo::{Affine, BezPath};

use super::super::{Renderer, warp};
use super::draw::Translator;
use super::native::Native;
use super::Role;
use crate::compositor::{Readback, Tex};
use crate::error::{Error, Result};
use crate::bounds::PixelRect;
use crate::resolve::{ResolvedKind, ResolvedLayer, ResolvedMask, ResolvedScene};
use crate::scene::Scene;

/// Frames whose GPU work may be unfinished when the next one starts. Skia's recordings and wgpu's passes all run on
/// the one queue, so waiting for a frame's readback waits for its Skia work too.
const FRAMES_IN_FLIGHT: usize = 2;

/// What draws the 2D content of the layers the wgpu path draws (`Renderer::skia_leaf` and its kin): Skia's context and
/// a translator on a recorder of its own. Its recordings are submitted as soon as they are made, since wgpu goes on to
/// read what they drew; the frame's own recording (`SkiaBackend::rec`) is submitted last. It moves into
/// `Renderer::skia_inner` while a frame is drawn, because the wgpu path calls it and the backend is out of the renderer
/// then.
pub(in super::super) struct Inner {
    /// Made when first needed.
    tr: Option<Translator>,
    /// The frame `tr` was last told about (`Translator::begin_frame`), and the one being drawn.
    tr_frame: u64,
    frame: u64,
    /// `None` when Skia draws on the CPU (`init`). Last: what Skia made (the translator's images) is dropped before the
    /// context it was made on.
    gpu: Option<Gpu>,
}

/// Graphite on the GPU, for the layers the wgpu path asks Skia to draw.
struct Gpu {
    // Dropped in this order: the recorder, then the context it records for, then what the context runs on.
    rec: Rc<RefCell<graphite::Recorder>>,
    ctx: graphite::Context,
    native: Native,
}

// SAFETY: as for `SkiaBackend`: a `Renderer` is used by one thread at a time.
unsafe impl Send for Inner {}

pub(in super::super) struct SkiaBackend {
    /// The frame's recorder; `None` when Skia draws on the CPU, into raster surfaces that are uploaded to the textures
    /// the GPU path would have drawn into.
    rec: Option<Rc<RefCell<graphite::Recorder>>>,
    tr: Translator,
    /// Frames take the targets in turn, so that a frame is not drawn into the texture the one before is still being
    /// read from.
    targets: Vec<Target>,
    next_target: usize,
    in_flight: VecDeque<wgpu::SubmissionIndex>,
    stats_file: Option<std::fs::File>,
    frame: u64,
    /// `KINETOGRAPH_SKIA_HASH=<dir>`: a hash of every frame's pixels, by frame number, for finding frames that differ
    /// between runs.
    hash_file: Option<std::fs::File>,
    started: VecDeque<u32>,
    /// After everything above (fields drop in order): Skia's surfaces, images and recorders are gone before its context,
    /// and the context before the wgpu device it runs on (on Vulkan Skia frees its memory through the VkDevice, which
    /// lives until the last `wgpu::Device` handle does).
    inner: Option<Inner>,
    _device: wgpu::Device,
}

// SAFETY: a `Renderer` is used by one thread at a time (the napi addon locks it). Nothing here is tied to a thread.
unsafe impl Send for SkiaBackend {}

struct Target {
    size: (u32, u32),
    /// Linear light in Rgba16Float, for a scene that blends in linear light; else sRGB-encoded Rgba8.
    linear: bool,
    view: wgpu::TextureView,
    surface: Surface,
    // Keeps the texture alive for the surface.
    _texture: wgpu::Texture,
}

/// `KINETOGRAPH_SKIA_CPU=1`: draw with Skia's CPU backend even where a GPU one would start (to test that path).
fn cpu_forced() -> bool {
    std::env::var("KINETOGRAPH_SKIA_CPU").is_ok_and(|v| !v.is_empty() && v != "0")
}

/// Graphite on `device`'s GPU device and `queue`'s command queue, with two recorders (the frame's and the one for the
/// layers the wgpu path asks for), if Skia can start there and draw into the textures wgpu makes of both formats it
/// draws to. `None` if there is no such GPU API (a Metal or Vulkan device) or the driver lacks what Graphite needs.
fn start_gpu(device: &wgpu::Device, queue: &wgpu::Queue) -> Option<(Gpu, graphite::Recorder)> {
    let (native, mut ctx) = Native::new(device, queue)?;
    let mut rec = ctx.make_recorder(None)?;
    let raster = ctx.make_recorder(None)?;
    // A texture of each format, wrapped as Graphite wraps the real ones: refused by a driver that cannot be drawn to.
    for (format, color_type, space) in [
        (wgpu::TextureFormat::Rgba8Unorm, ColorType::RGBA8888, ColorSpace::new_srgb()),
        (wgpu::TextureFormat::Rgba16Float, ColorType::RGBAF16, ColorSpace::new_srgb_linear()),
    ] {
        let texture = Native::create_texture(
            device,
            &wgpu::TextureDescriptor {
                label: Some("skia probe"),
                size: wgpu::Extent3d { width: 16, height: 16, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: Native::target_usage(),
                view_formats: &[],
            },
        );
        let bt = Native::backend_texture(device, &texture, (16, 16), Role::Target)?;
        graphite::surfaces::wrap_backend_texture(&mut rec, &bt, color_type, Some(space), None)?;
    }
    Some((Gpu { native, ctx, rec: Rc::new(RefCell::new(raster)) }, rec))
}

/// A Skia backend on `device`'s GPU device and `queue`'s command queue; if Skia's GPU backend cannot start on this
/// device (no Metal or Vulkan device, or a Vulkan driver without what Graphite needs), or `KINETOGRAPH_SKIA_CPU=1`,
/// one that draws with Skia's CPU backend instead, and says so once.
pub(in super::super) fn init(device: &wgpu::Device, queue: &wgpu::Queue, scene: &Scene) -> Result<SkiaBackend> {
    let forced = cpu_forced();
    let started = if forced { None } else { start_gpu(device, queue) };
    if started.is_none() {
        warn_cpu(forced);
    }
    let (gpu, rec) = match started {
        Some((gpu, rec)) => (Some(gpu), Some(Rc::new(RefCell::new(rec)))),
        None => (None, None),
    };
    let mut tr = Translator::new(scene);
    if let Some(rec) = &rec {
        use_recorder(&mut tr, rec);
    }
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let stats_file = std::env::var("KINETOGRAPH_SKIA_STATS").ok().and_then(|dir| {
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::fs::create_dir_all(&dir).ok()?;
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(format!("{dir}/skia-{}-{n}.jsonl", std::process::id()))
            .ok()
    });
    let hash_file = std::env::var("KINETOGRAPH_SKIA_HASH").ok().and_then(|dir| {
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::fs::create_dir_all(&dir).ok()?;
        std::fs::OpenOptions::new().create(true).append(true).open(format!("{dir}/hash-{}-{n}.txt", std::process::id())).ok()
    });
    let inner = Inner { gpu, tr: None, tr_frame: u64::MAX, frame: 0 };
    Ok(SkiaBackend { _device: device.clone(), inner: Some(inner), rec, tr, targets: Vec::new(), next_target: 0, in_flight: VecDeque::new(), stats_file, frame: 0, hash_file, started: VecDeque::new() })
}

/// Tells, once per process, that Skia draws on the CPU.
fn warn_cpu(forced: bool) {
    static SAID: std::sync::Once = std::sync::Once::new();
    SAID.call_once(|| {
        if forced {
            eprintln!("kinetograph: drawing with Skia on the CPU (KINETOGRAPH_SKIA_CPU is set)");
        } else {
            eprintln!("kinetograph: drawing with Skia on the CPU; no GPU Skia can use");
        }
    });
}

/// Makes `tr` draw with Graphite: images are uploaded by `rec` and the wgpu path's textures are wrapped by it.
fn use_recorder(tr: &mut Translator, rec: &Rc<RefCell<graphite::Recorder>>) {
    tr.set_recorder(rec.clone());
    let upload_rec = rec.clone();
    tr.upload = Some(Rc::new(move |img: &Image| graphite::images::texture_from_image(&mut upload_rec.borrow_mut(), img)));
}

fn warn_once(what: &str) {
    static SEEN: Mutex<Option<HashSet<String>>> = Mutex::new(None);
    let mut seen = SEEN.lock().unwrap();
    if seen.get_or_insert_with(HashSet::new).insert(what.to_string()) {
        eprintln!("kinetograph: skia backend did not draw: {what}");
    }
}

fn json_map(m: &std::collections::BTreeMap<String, u32>) -> String {
    let items: Vec<String> = m.iter().map(|(k, v)| format!("{}:{v}", serde_json::to_string(k).unwrap())).collect();
    format!("{{{}}}", items.join(","))
}

impl Renderer {
    /// Drops what Skia read from files (pictures, videos, fonts), so that the next frame reads them again.
    pub(in super::super) fn skia_forget_files(&mut self) {
        if let Some(sk) = &mut self.skia {
            sk.tr.forget_files();
            if let Some(tr) = sk.inner.as_mut().and_then(|inner| inner.tr.as_mut()) {
                tr.forget_files();
            }
        }
    }

    /// Draws `scene` with Skia into the canvas texture (linear, premultiplied, the size of the canvas and its margin).
    pub(in super::super) fn skia_canvas(&mut self, scene: &ResolvedScene) -> Result<Tex> {
        let mut sk = self.skia.take().expect("the Skia backend");
        let drawn = self.skia_draw(&mut sk, scene);
        self.skia = Some(sk);
        drawn
    }

    fn skia_draw(&mut self, sk: &mut SkiaBackend, scene: &ResolvedScene) -> Result<Tex> {
        // Bound the frames in flight.
        let bound = std::env::var("KINETOGRAPH_SKIA_INFLIGHT").ok().and_then(|v| v.parse().ok()).unwrap_or(FRAMES_IN_FLIGHT);
        while sk.in_flight.len() >= bound.max(1) {
            let index = sk.in_flight.pop_front().expect("a frame in flight");
            let _ = self.device.poll(wgpu::PollType::Wait { submission_index: Some(index), timeout: None });
        }
        let size = self.target_size;
        let linear = self.scene.blend_space == crate::scene::BlendSpace::Linear;
        let cpu = sk.rec.is_none();
        if sk.targets.first().is_none_or(|t| t.size != size || t.linear != linear) {
            sk.targets.clear();
            // Drawn on the CPU, a frame is uploaded whole, in order, so one texture serves every frame.
            for _ in 0..if cpu { 1 } else { FRAMES_IN_FLIGHT + 1 } {
                let texture = Native::create_texture(
                    &self.device,
                    &wgpu::TextureDescriptor {
                        label: Some("skia target"),
                        size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
                        mip_level_count: 1,
                        sample_count: 1,
                        dimension: wgpu::TextureDimension::D2,
                        format: if linear { wgpu::TextureFormat::Rgba16Float } else { wgpu::TextureFormat::Rgba8Unorm },
                        usage: if cpu { Native::target_usage() | wgpu::TextureUsages::COPY_DST } else { Native::target_usage() },
                        view_formats: &[],
                    },
                );
                let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
                let (color_type, space) =
                    if linear { (ColorType::RGBAF16, ColorSpace::new_srgb_linear()) } else { (ColorType::RGBA8888, ColorSpace::new_srgb()) };
                let surface = match &sk.rec {
                    Some(rec) => {
                        // wgpu zeroes a texture it has not seen written before its first read, which would wipe what Skia drew:
                        // one clear marks it as written.
                        let mut encoder = self.device.create_command_encoder(&Default::default());
                        drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                            label: Some("skia target init"),
                            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                                view: &view,
                                depth_slice: None,
                                resolve_target: None,
                                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                            })],
                            ..Default::default()
                        }));
                        self.queue.submit([encoder.finish()]);
                        let bt = Native::backend_texture(&self.device, &texture, size, Role::Target)
                            .ok_or_else(|| Error::Render("the Skia target is not a texture of the GPU API Skia runs on".into()))?;
                        graphite::surfaces::wrap_backend_texture(&mut rec.borrow_mut(), &bt, color_type, Some(space), None)
                            .ok_or_else(|| Error::Render("Skia could not wrap its target texture".into()))?
                    }
                    None => cpu_surface(size, color_type, space)?,
                };
                sk.targets.push(Target { size, linear, view, surface, _texture: texture });
            }
        }
        let current = sk.next_target % sk.targets.len();
        sk.next_target = current + 1;


        sk.tr.begin_frame(&self.scene);
        let frame = sk.frame + 1;
        let SkiaBackend { inner, rec, tr, targets, .. } = sk;
        let mut side = inner.take().expect("the Skia context");
        side.frame = frame;
        self.skia_inner = Some(side);
        let target = &mut targets[current];
        let margin = self.margin;
        tr.draw_scene(target.surface.canvas(), scene, scene.background, self, margin);
        *inner = self.skia_inner.take();
        let Inner { gpu, tr: raster, .. } = inner.as_mut().expect("the Skia context");
        if let Some(raster) = raster {
            for (what, n) in std::mem::take(&mut raster.stats.unsupported) {
                *tr.stats.unsupported.entry(what).or_default() += n;
            }
            for (what, n) in std::mem::take(&mut raster.stats.approximated) {
                *tr.stats.approximated.entry(what).or_default() += n;
            }
        }
        if let Some(e) = tr.error.take() {
            // The recording is abandoned: whatever was queued is dropped with it.
            if let Some(rec) = rec.as_ref() {
                let _ = rec.borrow_mut().snap();
            }
            for tex in tr.take_held() {
                self.compositor.release(tex);
            }
            return Err(e);
        }
        // What the fallbacks drew goes first; Skia reads it.
        self.compositor.submit();
        let held = tr.take_held();
        match (gpu.as_mut(), rec.as_ref()) {
            (Some(Gpu { native, ctx, .. }), Some(rec)) => {
                // Whatever wgpu has to do to the textures first (image layouts on Vulkan; nothing on Metal).
                native.before_skia(&self.device, &self.queue, &targets[current].view, &held.iter().collect::<Vec<_>>());
                let mut recording = rec.borrow_mut().snap().ok_or_else(|| Error::Render("Skia recorded nothing".into()))?;
                let info = graphite::InsertRecordingInfo::new(&mut recording);
                if ctx.insert_recording(&info) != graphite::InsertStatus::Success {
                    return Err(Error::Render("Skia refused its recording".into()));
                }
                ctx.submit(None);
                ctx.check_async_work_completion();
            }
            _ => {
                let target = &mut targets[current];
                upload_pixels(&self.queue, &mut target.surface, &target._texture, size)?;
            }
        }
        // The fallback textures are free to be drawn into again: what follows on the queue comes after Skia's reads.
        for tex in held {
            self.compositor.release(tex);
        }

        // Counters.
        for (what, n) in &tr.stats.unsupported {
            if *n > 0 {
                warn_once(what);
            }
        }
        sk.frame += 1;
        if let Some(file) = &mut sk.stats_file {
            let s = &tr.stats;
            let _ = writeln!(
                file,
                "{{\"frame\":{},\"layers\":{},\"fallbacks\":{},\"not_drawn\":{},\"approx\":{}}}",
                sk.frame,
                s.layers,
                json_map(&s.fallbacks),
                json_map(&s.unsupported),
                json_map(&s.approximated)
            );
        }
        Ok(self.compositor.from_skia(&sk.targets[current].view, linear))
    }

    /// Notes the number of the frame `start_frame` is drawing, for `skia_finished`.
    pub(in super::super) fn skia_started(&mut self, frame: u32) {
        if let Some(sk) = &mut self.skia {
            sk.started.push_back(frame);
        }
    }

    pub(in super::super) fn skia_finished(&mut self, rgba: &[u8]) {
        if let Some(sk) = &mut self.skia
            && let Some(file) = &mut sk.hash_file
            && let Some(frame) = sk.started.pop_front()
        {
            let mut h: u64 = 0xcbf29ce484222325;
            for b in rgba {
                h = (h ^ u64::from(*b)).wrapping_mul(0x100000001b3);
            }
            let _ = writeln!(file, "{frame} {h:016x}");
            // KINETOGRAPH_SKIA_PNG=<dir>:<frame>: that frame's pixels as `<dir>/<hash>.png`.
            if let Ok(spec) = std::env::var("KINETOGRAPH_SKIA_PNG")
                && let Some((dir, f)) = spec.rsplit_once(':')
                && f.parse::<u32>() == Ok(frame)
            {
                let _ = std::fs::create_dir_all(dir);
                let _ = image::save_buffer(format!("{dir}/{h:016x}.png"), rgba, self.scene.width, self.scene.height, image::ColorType::Rgba8);
            }
        }
    }

    pub(in super::super) fn skia_submitted(&mut self, readback: &Readback) {
        if let Some(sk) = &mut self.skia
            && let Some(index) = readback.submission()
        {
            sk.in_flight.push_back(index);
        }
    }

    /// `layer` as the wgpu path draws it (effects, clip, mask and matte on; opacity and blend left to the caller), for
    /// Skia to draw as an image: a texture of the canvas, or `None` if nothing shows. `parent` is the matrix from the
    /// layer's parent to the canvas texture.
    pub(in super::super) fn skia_fallback(
        &mut self,
        layer: &ResolvedLayer,
        siblings: &[ResolvedLayer],
        parent: Affine,
    ) -> Result<Option<Tex>> {
        if let ResolvedKind::Group { children, preserve3d: true, .. } = &layer.kind {
            let empty = self.compositor.filled([0.0; 4]);
            return self.draw_preserve3d(layer, children, parent, empty, None).map(Some);
        }
        let placement = warp::layer_world(&layer.transform).map(|world| super::super::Placement {
            parent,
            world,
            backface_hidden: layer.transform.backface_hidden,
        });
        self.layer_final_texture(layer, siblings, parent, placement, 1.0, None)
    }

    /// The camera's projection of the frame being drawn (`warp::projection`).
    pub(in super::super) fn skia_projection(&self) -> glam::DMat4 {
        self.projection
    }

    /// `tex`, a linear premultiplied Rgba16Float texture of the compositor's, as a Skia image: wrapped, for Graphite
    /// (`rec`), or, drawing on the CPU (`rec` is `None`), read back from the GPU (only the box it holds anything in).
    pub(in super::super) fn skia_wrap(&self, rec: Option<&mut graphite::Recorder>, tex: &Tex) -> Option<Image> {
        let Some(rec) = rec else {
            let texels = self.compositor.read_texels(tex).ok()?;
            let info = skia_safe::ImageInfo::new(
                (tex.size[0] as i32, tex.size[1] as i32),
                ColorType::RGBAF16,
                AlphaType::Premul,
                Some(ColorSpace::new_srgb_linear()),
            );
            return skia_safe::images::raster_from_data(&info, skia_safe::Data::new_copy(&texels), tex.size[0] as usize * 8);
        };
        let bt = Native::backend_texture(&self.device, &tex.texture, (tex.size[0], tex.size[1]), Role::Sampled)?;
        graphite::images::wrap_texture(rec, &bt, ColorType::RGBAF16, AlphaType::Premul, ColorSpace::new_srgb_linear())
    }
}

/// A CPU surface for Skia to draw a `size` canvas into: premultiplied, `color_type` in `space`.
fn cpu_surface(size: (u32, u32), color_type: ColorType, space: ColorSpace) -> Result<Surface> {
    let info = skia_safe::ImageInfo::new((size.0 as i32, size.1 as i32), color_type, AlphaType::Premul, Some(space));
    skia_safe::surfaces::raster(&info, None, None).ok_or_else(|| Error::Render(format!("no memory for a {}x{} Skia surface", size.0, size.1)))
}

/// Writes the pixels of the CPU `surface` over the whole of `texture` (the same size, the same format).
fn upload_pixels(queue: &wgpu::Queue, surface: &mut Surface, texture: &wgpu::Texture, size: (u32, u32)) -> Result<()> {
    let pixmap = surface.peek_pixels().ok_or_else(|| Error::Render("Skia's CPU surface has no pixels".into()))?;
    let bytes = pixmap.bytes().ok_or_else(|| Error::Render("Skia's CPU surface has no pixels".into()))?;
    queue.write_texture(
        texture.as_image_copy(),
        bytes,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(pixmap.row_bytes() as u32), rows_per_image: Some(size.1) },
        wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
    );
    Ok(())
}

/// One step of `Renderer::skia_flat`.
pub(in super::super) enum RasterOp<'a> {
    /// A leaf under the matrix that takes its layer space to canvas pixels.
    Leaf(&'a ResolvedLayer, Affine),
    /// The start of a group's clip: the path in the group's space, and the matrix of that space.
    Clip(BezPath, Affine),
    /// The end of the innermost clip.
    Pop,
}

/// What the wgpu path asks Skia to draw. Each returns a texture of the compositor's (linear,
/// premultiplied Rgba16Float, `region` as its bounds, transparent outside) that Skia drew into directly, so the
/// compositor takes it directly. A scene that blends in sRGB is drawn
/// into sRGB-encoded Rgba8 first, as the frame is, and converted.
impl Renderer {
    /// The leaf `layer` (no effects, clip, mask or matte) under `matrix`, which takes its layer space to canvas pixels.
    pub(in super::super) fn skia_leaf(&mut self, layer: &ResolvedLayer, matrix: Affine, region: PixelRect) -> Result<Tex> {
        self.skia_raster(region, |tr, canvas| tr.raster_leaf(canvas, layer, matrix))
    }

    /// The shape `layer`'s fill and stroke in opaque white, whatever their colours: where the shape is solid.
    pub(in super::super) fn skia_coverage(&mut self, layer: &ResolvedLayer, matrix: Affine, region: PixelRect) -> Result<Tex> {
        self.skia_raster(region, |tr, canvas| tr.raster_coverage(canvas, layer, matrix))
    }

    /// A clip `path` (layer space, under `matrix`) in opaque white; its alpha is the clip's coverage within `keep`.
    pub(in super::super) fn skia_clip(&mut self, path: &BezPath, matrix: Affine, keep: PixelRect) -> Result<Tex> {
        self.skia_raster(keep, |tr, canvas| tr.raster_clip(canvas, path, matrix))
    }

    /// The gradient of `mask` over `region`, laid out as it is for `layer` under `matrix`.
    pub(in super::super) fn skia_mask(&mut self, layer: &ResolvedLayer, mask: &ResolvedMask, matrix: Affine, region: PixelRect) -> Result<Tex> {
        self.skia_raster(region, |tr, canvas| tr.raster_mask(canvas, layer, mask, matrix))
    }

    /// The leaves of `ops`, bottom first, drawn together (a motion-blurred layer's samples).
    pub(in super::super) fn skia_flat(&mut self, ops: &[RasterOp<'_>], region: PixelRect) -> Result<Tex> {
        self.skia_raster(region, |tr, canvas| {
            for op in ops {
                match op {
                    RasterOp::Leaf(layer, matrix) => tr.raster_leaf(canvas, layer, *matrix),
                    RasterOp::Clip(path, matrix) => tr.raster_push_clip(canvas, path, *matrix),
                    RasterOp::Pop => tr.raster_pop(canvas),
                }
            }
        })
    }

    /// A canvas pass: the canvas layer `layer` (its commands) under `matrix`, with the children `pictures` as the
    /// pictures its `layer` sources name.
    pub(in super::super) fn skia_canvas_pass(
        &mut self,
        layer: &ResolvedLayer,
        matrix: Affine,
        region: PixelRect,
        pictures: &[(&str, &Tex)],
    ) -> Result<Tex> {
        let held: Vec<&Tex> = pictures.iter().map(|(_, t)| *t).collect();
        let mut inner = self.skia_inner.take().expect("a Skia frame is being drawn");
        let drawn = self.skia_raster_with(&mut inner, region, &held, |tr, canvas| tr.raster_canvas_pass(canvas, layer, matrix, pictures));
        self.skia_inner = Some(inner);
        drawn
    }

    /// Runs `draw` on a canvas whose pixels are the canvas pixels of `region` (cut to the target), and returns what it
    /// drew as a texture whose bounds are `region`.
    fn skia_raster(&mut self, region: PixelRect, draw: impl FnOnce(&mut Translator, &Canvas)) -> Result<Tex> {
        let mut inner = self.skia_inner.take().expect("a Skia frame is being drawn");
        let drawn = self.skia_raster_with(&mut inner, region, &[], draw);
        self.skia_inner = Some(inner);
        drawn
    }

    /// `held` are the compositor textures `draw` samples.
    fn skia_raster_with(&mut self, inner: &mut Inner, region: PixelRect, held: &[&Tex], draw: impl FnOnce(&mut Translator, &Canvas)) -> Result<Tex> {
        let region = region.intersect(self.whole());
        let linear = self.scene.blend_space == crate::scene::BlendSpace::Linear;
        let tex = self.compositor.skia_target(region);
        if region.is_empty() {
            return Ok(tex);
        }
        let gpu_rec = inner.gpu.as_ref().map(|g| g.rec.clone());
        if inner.tr.is_none() {
            let mut tr = Translator::new(&self.scene);
            if let Some(rec) = &gpu_rec {
                use_recorder(&mut tr, rec);
            }
            inner.tr = Some(tr);
            inner.tr_frame = u64::MAX;
        }
        if inner.tr_frame != inner.frame {
            inner.tr.as_mut().expect("made above").begin_frame(&self.scene);
            inner.tr_frame = inner.frame;
        }
        // What Skia draws into: the texture itself in linear light, else sRGB-encoded Rgba8 of the region's size.
        let (target, srgb8) = if linear {
            (None, None)
        } else {
            let (w, h) = (region.width(), region.height());
            let texture = Native::create_texture(
                &self.device,
                &wgpu::TextureDescriptor {
                    label: Some("skia srgb page"),
                    size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    usage: if gpu_rec.is_some() { Native::target_usage() } else { Native::target_usage() | wgpu::TextureUsages::COPY_DST },
                    view_formats: &[],
                },
            );
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            if gpu_rec.is_some() {
                // Marks the texture as written (see `skia_draw`).
                let mut encoder = self.device.create_command_encoder(&Default::default());
                drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("skia page init"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                    })],
                    ..Default::default()
                }));
                self.queue.submit([encoder.finish()]);
            }
            (Some((texture, view)), Some((w, h)))
        };
        let (draw_texture, draw_view, size, origin) = match &target {
            Some((texture, view)) => (texture, view, srgb8.expect("sized above"), (region.x0, region.y0)),
            None => (&tex.texture, &tex.view, (tex.size[0], tex.size[1]), (tex.origin[0], tex.origin[1])),
        };
        // The compositor's pending passes may still read this texture: they go first.
        self.compositor.submit();
        let (color_type, space) =
            if linear { (ColorType::RGBAF16, ColorSpace::new_srgb_linear()) } else { (ColorType::RGBA8888, ColorSpace::new_srgb()) };
        let mut surface = match (&mut inner.gpu, &gpu_rec) {
            (Some(gpu), Some(rec)) => {
                gpu.native.before_skia(&self.device, &self.queue, draw_view, held);
                let bt = Native::backend_texture(&self.device, draw_texture, size, Role::Target)
                    .ok_or_else(|| Error::Render("the Skia raster target is not a texture of the GPU API Skia runs on".into()))?;
                graphite::surfaces::wrap_backend_texture(&mut rec.borrow_mut(), &bt, color_type, Some(space), None)
                    .ok_or_else(|| Error::Render("Skia could not wrap its raster target".into()))?
            }
            _ => cpu_surface(size, color_type, space)?,
        };
        let canvas = surface.canvas();
        canvas.clear(skia_safe::Color4f::new(0.0, 0.0, 0.0, 0.0));
        canvas.translate((-origin.0 as f32, -origin.1 as f32));
        // Nothing lands outside the box the texture promises to hold.
        canvas.clip_rect(
            skia_safe::Rect::new(region.x0 as f32, region.y0 as f32, region.x1 as f32, region.y1 as f32),
            skia_safe::ClipOp::Intersect,
            false,
        );
        let tr = inner.tr.as_mut().expect("made above");
        tr.set_host(self);
        draw(tr, canvas);
        tr.set_host(std::ptr::null_mut());
        match (&mut inner.gpu, &gpu_rec) {
            (Some(gpu), Some(rec)) => {
                let mut recording = rec.borrow_mut().snap().ok_or_else(|| Error::Render("Skia recorded nothing".into()))?;
                drop(surface);
                let info = graphite::InsertRecordingInfo::new(&mut recording);
                if gpu.ctx.insert_recording(&info) != graphite::InsertStatus::Success {
                    return Err(Error::Render("Skia refused its recording".into()));
                }
                gpu.ctx.submit(None);
                gpu.ctx.check_async_work_completion();
            }
            _ => upload_pixels(&self.queue, &mut surface, draw_texture, size)?,
        }
        match target {
            Some((_, view)) => {
                // `tex` was only the size class; the converted page replaces it.
                self.compositor.release(tex);
                Ok(self.compositor.from_skia_srgb(&view, region, region))
            }
            None => Ok(tex),
        }
    }
}
