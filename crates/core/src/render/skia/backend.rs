//! The Skia backend's frame loop (`Renderer::skia_canvas`): one Graphite context on wgpu's device and queue (made by
//! `metal.rs` or `vulkan.rs`) and the textures it draws to.

use std::cell::RefCell;
use std::collections::{HashSet, VecDeque};
use std::io::Write;
use std::rc::Rc;
use std::sync::Mutex;

use skia_safe::gpu::graphite;
use skia_safe::{AlphaType, ColorSpace, ColorType, Image, Surface};
use vello::kurbo::Affine;
use vello::wgpu;

use super::super::{Renderer, warp};
use super::draw::Translator;
use super::native::Native;
use super::Role;
use crate::compositor::{Readback, Tex};
use crate::error::{Error, Result};
use crate::resolve::{ResolvedKind, ResolvedLayer, ResolvedScene};
use crate::scene::Scene;

/// Frames whose GPU work may be unfinished when the next one starts. Skia's recordings and wgpu's passes all run on
/// the one queue, so waiting for a frame's readback waits for its Skia work too.
const FRAMES_IN_FLIGHT: usize = 2;

pub(in super::super) struct SkiaBackend {
    native: Native,
    ctx: graphite::Context,
    rec: Rc<RefCell<graphite::Recorder>>,
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

/// A Skia backend on `device`'s GPU device and `queue`'s command queue, if `KINETOGRAPH_BACKEND=skia`.
pub(in super::super) fn init(device: &wgpu::Device, queue: &wgpu::Queue, scene: &Scene) -> Option<SkiaBackend> {
    if !std::env::var("KINETOGRAPH_BACKEND").is_ok_and(|v| v.eq_ignore_ascii_case("skia")) {
        return None;
    }
    let (native, mut ctx) = Native::new(device, queue)?;
    let rec = Rc::new(RefCell::new(ctx.make_recorder(None)?));
    let mut tr = Translator::new(scene);
    tr.set_recorder(rec.clone());
    let upload_rec = rec.clone();
    tr.upload = Some(Rc::new(move |img: &Image| graphite::images::texture_from_image(&mut upload_rec.borrow_mut(), img)));
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
    Some(SkiaBackend { native, ctx, rec, tr, targets: Vec::new(), next_target: 0, in_flight: VecDeque::new(), stats_file, frame: 0, hash_file, started: VecDeque::new() })
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
        if sk.targets.first().is_none_or(|t| t.size != size || t.linear != linear) {
            sk.targets.clear();
            for _ in 0..=FRAMES_IN_FLIGHT {
            let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("skia target"),
                size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: if linear { wgpu::TextureFormat::Rgba16Float } else { wgpu::TextureFormat::Rgba8Unorm },
                usage: Native::target_usage(),
                view_formats: &[],
            });
            // wgpu zeroes a texture it has not seen written before its first read, which would wipe what Skia drew: one
            // clear marks it as written.
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
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
            let (color_type, space) =
                if linear { (ColorType::RGBAF16, ColorSpace::new_srgb_linear()) } else { (ColorType::RGBA8888, ColorSpace::new_srgb()) };
            let surface = graphite::surfaces::wrap_backend_texture(&mut sk.rec.borrow_mut(), &bt, color_type, Some(space), None)
                    .ok_or_else(|| Error::Render("Skia could not wrap its target texture".into()))?;
            sk.targets.push(Target { size, linear, view, surface, _texture: texture });
            }
        }
        let current = sk.next_target % sk.targets.len();
        sk.next_target = current + 1;


        sk.tr.begin_frame(&self.scene);
        let SkiaBackend { native, ctx, rec, tr, targets, .. } = sk;
        let target = &mut targets[current];
        let margin = self.margin;
        tr.draw_scene(target.surface.canvas(), scene, scene.background, self, margin);
        if let Some(e) = tr.error.take() {
            // The recording is abandoned: whatever was queued is dropped with it.
            let _ = rec.borrow_mut().snap();
            for tex in tr.take_held() {
                self.compositor.release(tex);
            }
            return Err(e);
        }
        // What the fallbacks drew goes first; Skia reads it.
        self.compositor.submit();
        let held = tr.take_held();
        // Whatever wgpu has to do to the textures first (image layouts on Vulkan; nothing on Metal).
        native.before_skia(&self.device, &self.queue, &targets[current].view, &held);
        let mut recording = rec.borrow_mut().snap().ok_or_else(|| Error::Render("Skia recorded nothing".into()))?;
        let info = graphite::InsertRecordingInfo::new(&mut recording);
        if ctx.insert_recording(&info) != graphite::InsertStatus::Success {
            return Err(Error::Render("Skia refused its recording".into()));
        }
        ctx.submit(None);
        ctx.check_async_work_completion();
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

    /// `tex`, a linear premultiplied Rgba16Float texture of the compositor's, as a Skia image.
    pub(in super::super) fn skia_wrap(&self, rec: &mut graphite::Recorder, tex: &Tex) -> Option<Image> {
        let bt = Native::backend_texture(&self.device, &tex.texture, (tex.size[0], tex.size[1]), Role::Sampled)?;
        graphite::images::wrap_texture(rec, &bt, ColorType::RGBAF16, AlphaType::Premul, ColorSpace::new_srgb_linear())
    }
}
