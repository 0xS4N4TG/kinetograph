//! The Metal side of the Skia backend: one Graphite context on wgpu's device and queue, the texture it draws to, and
//! the frame loop (`Renderer::skia_canvas`).

use std::cell::RefCell;
use std::collections::{HashSet, VecDeque};
use std::ffi::c_void;
use std::io::Write;
use std::rc::Rc;
use std::sync::Mutex;

use skia_safe::gpu::graphite;
use skia_safe::{AlphaType, ColorSpace, ColorType, Image, Surface};
use vello::kurbo::Affine;
use vello::wgpu;
use wgpu::hal::api::Metal;

use super::super::{Renderer, warp};
use super::draw::Translator;
use crate::compositor::{Readback, Tex};
use crate::error::{Error, Result};
use crate::resolve::{ResolvedKind, ResolvedLayer, ResolvedScene};
use crate::scene::Scene;

/// Frames whose GPU work may be unfinished when the next one starts. Skia's recordings and wgpu's passes all run on
/// the one queue, so waiting for a frame's readback waits for its Skia work too.
const FRAMES_IN_FLIGHT: usize = 2;

pub(in super::super) struct SkiaBackend {
    ctx: graphite::Context,
    rec: Rc<RefCell<graphite::Recorder>>,
    tr: Translator,
    target: Option<Target>,
    in_flight: VecDeque<wgpu::SubmissionIndex>,
    stats_file: Option<std::fs::File>,
    frame: u64,
}

// SAFETY: a `Renderer` is used by one thread at a time (the napi addon locks it). Nothing here is tied to a thread.
unsafe impl Send for SkiaBackend {}

struct Target {
    size: (u32, u32),
    view: wgpu::TextureView,
    surface: Surface,
    // Keeps the texture alive for the surface.
    _texture: wgpu::Texture,
}

fn mtl_ptr<T: ?Sized>(r: &T) -> *mut c_void {
    r as *const T as *const c_void as *mut c_void
}

/// A Skia backend on `device`'s Metal device and `queue`'s command queue, if `KINETOGRAPH_BACKEND=skia`.
pub(in super::super) fn init(device: &wgpu::Device, queue: &wgpu::Queue, scene: &Scene) -> Option<SkiaBackend> {
    if !std::env::var("KINETOGRAPH_BACKEND").is_ok_and(|v| v.eq_ignore_ascii_case("skia")) {
        return None;
    }
    // SAFETY: the raw device and queue stay alive as long as the wgpu ones, which the renderer holds.
    let (dev, q) = unsafe {
        let d = device.as_hal::<Metal>()?;
        let q = queue.as_hal::<Metal>()?;
        (mtl_ptr(&**d.raw_device()), mtl_ptr(q.as_raw()))
    };
    let backend = unsafe { graphite::mtl::BackendContext::new(dev, q) };
    let mut ctx = graphite::mtl::context_factory::make_metal(&backend, None)?;
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
    Some(SkiaBackend { ctx, rec, tr, target: None, in_flight: VecDeque::new(), stats_file, frame: 0 })
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
        while sk.in_flight.len() >= FRAMES_IN_FLIGHT {
            let index = sk.in_flight.pop_front().expect("a frame in flight");
            let _ = self.device.poll(wgpu::PollType::Wait { submission_index: Some(index), timeout: None });
        }
        let size = self.target_size;
        if sk.target.as_ref().is_none_or(|t| t.size != size) {
            sk.target = None;
            let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("skia target"),
                size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
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
            let ptr = unsafe { texture.as_hal::<Metal>().map(|h| mtl_ptr(h.raw_handle())) }
                .ok_or_else(|| Error::Render("the Skia target is not a Metal texture".into()))?;
            let bt = unsafe { graphite::mtl::backend_textures::make_metal((size.0 as i32, size.1 as i32), ptr) };
            let surface =
                graphite::surfaces::wrap_backend_texture(&mut sk.rec.borrow_mut(), &bt, ColorType::RGBA8888, None, None)
                    .ok_or_else(|| Error::Render("Skia could not wrap its target texture".into()))?;
            sk.target = Some(Target { size, view, surface, _texture: texture });
        }

        sk.tr.begin_frame(&self.scene);
        let SkiaBackend { ctx, rec, tr, target, .. } = sk;
        let target = target.as_mut().expect("the Skia target");
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
        let mut recording = rec.borrow_mut().snap().ok_or_else(|| Error::Render("Skia recorded nothing".into()))?;
        let info = graphite::InsertRecordingInfo::new(&mut recording);
        if ctx.insert_recording(&info) != graphite::InsertStatus::Success {
            return Err(Error::Render("Skia refused its recording".into()));
        }
        ctx.submit(None);
        ctx.check_async_work_completion();
        // The fallback textures are free to be drawn into again: what follows on the queue comes after Skia's reads.
        for tex in tr.take_held() {
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
        let target = sk.target.as_ref().expect("the Skia target");
        Ok(self.compositor.from_skia(&target.view))
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
        let ptr = unsafe { tex.texture.as_hal::<Metal>().map(|h| mtl_ptr(h.raw_handle())) }?;
        let bt = unsafe { graphite::mtl::backend_textures::make_metal((tex.size[0] as i32, tex.size[1] as i32), ptr) };
        graphite::images::wrap_texture(rec, &bt, ColorType::RGBAF16, AlphaType::Premul, ColorSpace::new_srgb_linear())
    }
}
