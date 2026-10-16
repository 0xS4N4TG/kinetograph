//! Scene -> pixels. Vello rasterises each leaf layer into an sRGB texture;
//! the compositor blends them in linear light.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};

use glam::{DMat3, DMat4, DVec3};
use image::{ExtendedColorType, ImageEncoder, codecs::png::PngEncoder};
use vello::kurbo::{Affine, BezPath, Ellipse, Point, Rect, RoundedRect, Shape, Stroke, Vec2};
use vello::peniko::{self, Blob, Fill, ImageAlphaType, ImageData, ImageFormat};
use vello::util::RenderContext;
use vello::wgpu;
use vello::{AaConfig, AaSupport, RenderParams, RendererOptions};

use crate::blur::MIN_RADIUS;
use crate::bounds::{self, PixelRect};
use crate::box_shadow::BoxShadow;
use crate::cache::{self, Inputs, LayerCache};
use crate::canvas;
use crate::color::Color;
use crate::compositor::{BlendLayer, BlendSource, Compositor, Readback, Tex};
use crate::error::{Error, Result};
use crate::gif::{Gif, Gifs, gif_sources, open_gif};
use crate::lottie::{Lottie, Lotties, lottie_sources, open_lottie};
use crate::lut::Lut;
use crate::mesh;
use crate::resolve::{
    ResolvedChar, ResolvedClip, ResolvedEffect, ResolvedGeometry, ResolvedGradient,
    ResolvedGradientGeometry, ResolvedKind, ResolvedLayer, ResolvedMask, ResolvedPaint,
    ResolvedScene, ResolvedShadow, ShapeStyle,
};
use crate::scene::{
    BlendMode, DotOrder, Extend, Fit, LayerKind, MaskMode, Paint, Scene, ShapeLayer, TextLayer,
    Units, walk_layers,
};
use crate::scene3d::Resolved3d;
use crate::scene3d::draw::{Assets3d, Texture};
use crate::scene3d::model::Model;
use crate::text::{LaidOutText, TextEngine};
use crate::video::{VideoDecoder, Videos, open_video, video_sources};
use crate::warp;

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

/// A frame the GPU is still drawing (`Renderer::start_frame`).
pub struct PendingFrame {
    readback: Readback,
    width: u32,
    height: u32,
}

/// Where one frame's time went, in milliseconds. Collected by
/// [`Renderer::render_timed`]; rendering itself never reads the clock.
#[derive(Clone, Copy, Debug, Default)]
pub struct Timings {
    /// Evaluating the scene's animated values.
    pub resolve_ms: f64,
    /// Vello drawing leaf layers into textures.
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
    _context: RenderContext,
    device: wgpu::Device,
    queue: wgpu::Queue,
    vello: vello::Renderer,
    /// Rasterises image layers only; `None` if the scene has none.
    ///
    /// Vello 0.11 keeps an image atlas between renders but resets it to 1x1
    /// when a scene has only solid-colour paths, while its cache still treats
    /// the images as uploaded. Rendering a shape after an image therefore
    /// blanks the image on every later render. Giving images their own
    /// renderer means it only ever sees scenes that contain an image.
    vello_images: Option<vello::Renderer>,
    vello_scene: vello::Scene,
    vello_view: wgpu::TextureView,
    /// Size of the Vello target and of every compositor texture: the canvas
    /// plus `margin` pixels on every side.
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
    /// The leaves of the frame that Vello draws a page at a time
    /// (`plan_pages`), and the textures of those drawn and not yet used.
    pages: Pages,
    /// The Vello targets of the frame's pages once it is over, to be drawn
    /// into again by the next frame's.
    page_targets: HashMap<(u32, u32), Vec<wgpu::TextureView>>,
    /// Above 0 while the samples of a motion-blurred layer are drawn: they are
    /// copies of one layer with the same ids, and only their average is kept.
    /// Their leaves are also rasterised into the box they cover, not the
    /// whole target (`vello_area`).
    cache_paused: u32,
}

impl Renderer {
    pub fn new(scene: Scene) -> Result<Renderer> {
        // Fonts first: nothing is measured before they are registered. All
        // the reading is done before the GPU is touched, so a bad file fails
        // cheaply.
        let mut fresh = read_assets(&scene, &Loaded::default(), false)?;

        let context = RenderContext::new();
        let (device, queue) = pollster::block_on(new_device(&context.instance))
            .ok_or_else(|| Error::Render("no compatible GPU adapter found".into()))?;

        let vello = new_vello(&device)?;
        let margin = scene.margin();
        let target_size = (scene.width + 2 * margin, scene.height + 2 * margin);
        let vello_view = new_vello_target(&device, target_size);
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
            _context: context,
            device,
            queue,
            vello,
            vello_images: None,
            vello_scene: vello::Scene::new(),
            vello_view,
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
            pages: Pages::default(),
            page_targets: HashMap::new(),
            cache_paused: 0,
        };
        renderer.ensure_image_renderer(fresh.has_pictures())?;
        renderer.install_assets(fresh);
        renderer.add_shaders();
        Ok(renderer)
    }

    /// Takes `scene` as the one to render from now on, keeping the device,
    /// the Vello renderers, the compositor's pipelines and the layer cache.
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
        self.ensure_image_renderer(fresh.has_pictures())?;
        // Nothing fails from here on.
        let margin = scene.margin();
        let resized = (scene.width, scene.height, margin)
            != (self.scene.width, self.scene.height, self.margin);
        // What a cached group drew depends on the space it was blended in.
        let respaced = scene.blend_space != self.scene.blend_space;
        if resized || respaced || fresh.rebound {
            self.clear_layer_cache();
        }
        self.compositor
            .set_srgb_blend(scene.blend_space == crate::scene::BlendSpace::Srgb);
        if resized {
            self.clear_pages();
            self.margin = margin;
            self.target_size = (scene.width + 2 * margin, scene.height + 2 * margin);
            self.vello_view = new_vello_target(&self.device, self.target_size);
            self.page_targets.clear();
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

    /// Makes the Vello renderer for image layers once a scene has an image
    /// (see `vello_images`), or when `will_have_images`.
    fn ensure_image_renderer(&mut self, will_have_images: bool) -> Result<()> {
        if self.vello_images.is_none()
            && (will_have_images
                || !self.images.is_empty()
                || !self.lotties.is_empty()
                || !self.videos.is_empty()
                || !self.gifs.is_empty())
        {
            self.vello_images = Some(new_vello(&self.device)?);
        }
        Ok(())
    }

    /// Keeps what `read_assets` read.
    fn install_assets(&mut self, fresh: NewAssets) {
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
        self.compositor.set_fusion(on);
    }

    /// The compositing passes since the last call, with their GPU times.
    /// Vello's rasterising and the copies between textures are not passes
    /// that can be timed, so they are not in it.
    pub fn take_pass_times(&mut self) -> Vec<crate::pass_timer::PassTime> {
        self.compositor.take_pass_times()
    }

    pub fn render_frame(&mut self, frame: u32) -> Result<Frame> {
        let pending = self.start_frame(frame)?;
        self.finish_frame(pending)
    }

    /// `render_frame` up to the readback: the GPU works on the frame while
    /// the caller starts the next one, and `finish_frame` collects it.
    /// Frames are finished in the order they were started.
    pub fn start_frame(&mut self, frame: u32) -> Result<PendingFrame> {
        let resolved = self.scene.resolve_with_text(frame, &mut self.text)?;
        self.start_resolved(&resolved)
    }

    /// The pixels of a frame from `start_frame`.
    pub fn finish_frame(&mut self, pending: PendingFrame) -> Result<Frame> {
        let rgba = self.compositor.finish_readback(pending.readback)?;
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
        let pending = self.start_resolved(scene)?;
        let rgba = self.timed(Stage::Readback, |s| {
            s.compositor.finish_readback(pending.readback)
        })?;
        Ok(Frame {
            width: pending.width,
            height: pending.height,
            rgba,
        })
    }

    fn start_resolved(&mut self, scene: &ResolvedScene) -> Result<PendingFrame> {
        self.projection = warp::projection(scene.camera.as_ref(), self.margin);
        // A frame that failed may have left these half way.
        self.cache_path.clear();
        self.cache_paused = 0;
        self.cache.begin_frame();
        self.compositor.begin_frame();
        self.clear_pages();
        self.plan_pages(&scene.layers)?;
        let color = scene.background.linear_premultiplied();
        let background = self.timed(Stage::Composite, |s| s.compositor.filled(color));
        let canvas =
            self.draw_layers(&scene.layers, margin_origin(self.margin), background, None)?;
        // What this frame did not draw, the next probably will not either.
        for tex in self.cache.end_frame() {
            self.compositor.release(tex);
        }
        self.clear_pages();
        let readback = self.timed(Stage::Readback, |s| s.compositor.start_readback(&canvas));
        self.compositor.release(canvas);
        Ok(PendingFrame {
            readback,
            width: scene.width,
            height: scene.height,
        })
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
        for layer in layers {
            // A matte source is only drawn through the layer it mattes.
            if is_hidden(layer) || is_matte_source(layers, layer) {
                continue;
            }
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
            if pending.len() >= MAX_PENDING {
                canvas = self.blend_pending(canvas, pending);
            }
            self.compositor.submit_if_large();
        }
        Ok(canvas)
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
            })
            .collect();
        let canvas = self.timed(Stage::Composite, |s| {
            s.compositor.blend_many(canvas, &layers)
        });
        drop(layers);
        for waiting in pending.drain(..) {
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
                Waiting::Page { id, inputs, .. } => {
                    if let Some(id) = id {
                        self.cache.note(id, &inputs);
                    }
                }
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
                    pending.push(Pending {
                        what: Waiting::Cached {
                            id: id.clone(),
                            hit,
                        },
                        opacity,
                        mode: layer.blend_mode,
                    });
                    return Ok(canvas);
                }
                Err(Some(stale)) => self.compositor.release(stale),
                Err(None) => {}
            }
        }

        // A plain leaf goes to the blend straight from its page, unless it
        // was the same last frame too: then it is drawn the way that gives
        // the layer cache a texture to keep.
        if !unchanged
            && let Some((leaf, clip, bounds)) =
                self.page_source(layer, siblings, parent, placement)?
        {
            pending.push(Pending {
                what: Waiting::Page {
                    id,
                    inputs,
                    leaf,
                    clip,
                    bounds,
                },
                opacity,
                mode: layer.blend_mode,
            });
            return Ok(canvas);
        }

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
        pending.push(Pending {
            what: match id {
                Some(id) => Waiting::Kept {
                    id,
                    inputs,
                    texture,
                },
                None => Waiting::Loose(texture),
            },
            opacity,
            mode: layer.blend_mode,
        });
        Ok(canvas)
    }

    /// What `blend_many` needs to blend the leaf `layer` straight from its
    /// page (and its clip's, if it has one): the leaf's page and the pixels
    /// of it Vello drew, the clip's, and the box the leaf is not transparent
    /// in. `None` unless the leaf is plain: drawn flat, with no effects, mask
    /// or matte, nothing behind it to look at, a blend mode that works pixel
    /// by pixel, its clip (if any) keeping something, and both on pages.
    #[allow(clippy::type_complexity)]
    fn page_source(
        &mut self,
        layer: &ResolvedLayer,
        siblings: &[ResolvedLayer],
        parent: Affine,
        placement: Option<Placement>,
    ) -> Result<
        Option<(
            (wgpu::TextureView, PixelRect),
            Option<(wgpu::TextureView, PixelRect)>,
            PixelRect,
        )>,
    > {
        if !self.compositor.is_fused()
            || placement.is_some()
            || !layer.motion.is_empty()
            || !layer.effects.is_empty()
            || layer.mask.is_some()
            || layer.matte.is_some()
            || !self.compositor.blends_per_pixel(layer.blend_mode)
            || matches!(
                layer.kind,
                ResolvedKind::Group { .. }
                    | ResolvedKind::MeshGradient { .. }
                    | ResolvedKind::Glsl { .. }
                    | ResolvedKind::Scene3d { .. }
                    | ResolvedKind::Noise { .. }
            )
            || uses_backdrop(siblings, layer)
        {
            return Ok(None);
        }
        let matrix = parent * layer.transform.matrix();
        let Some(&(_, region)) = self.pages.page_of.get(&leaf_key(layer, matrix)) else {
            return Ok(None);
        };
        let Some(leaf) = self.page_target(layer, matrix)? else {
            return Ok(None);
        };
        let Some(clip) = &layer.clip else {
            return Ok(Some((leaf, None, region)));
        };
        let path = self.clip_path(clip, layer)?;
        let bounds = region.intersect(self.path_bounds(&path, matrix));
        if bounds.is_empty() {
            return Ok(None);
        }
        let Some(clip_page) = self.clip_page_target(layer, matrix)? else {
            return Ok(None);
        };
        Ok(Some((leaf, Some(clip_page), bounds)))
    }

    /// The leaf `layer` cut out of its page `page` (drawn over `area`) and
    /// masked by its clip, in one pass, when it can be: it has no effects
    /// (which come between the cut and the clip), its clip shape is on a page
    /// too, and the clip keeps some of the leaf's box `region`.
    fn clipped_from_page(
        &mut self,
        layer: &ResolvedLayer,
        matrix: Affine,
        page: &wgpu::TextureView,
        area: PixelRect,
        region: PixelRect,
    ) -> Result<Option<Tex>> {
        let Some(clip) = &layer.clip else {
            return Ok(None);
        };
        if !self.compositor.is_fused()
            || !layer.effects.is_empty()
            || matches!(layer.kind, ResolvedKind::Noise { .. })
        {
            return Ok(None);
        }
        let path = self.clip_path(clip, layer)?;
        let keep = self.path_bounds(&path, matrix);
        if region.intersect(keep).is_empty() {
            return Ok(None);
        }
        let Some((clip_page, clip_area)) = self.clip_page_target(layer, matrix)? else {
            return Ok(None);
        };
        Ok(Some(self.timed(Stage::Composite, |s| {
            s.compositor
                .leaf_clipped_from_page((page, area), (&clip_page, clip_area), region, keep)
        })))
    }

    /// The inset shadow that is the first effect of the leaf `layer`, if it
    /// can be drawn in the one pass that cuts the leaf out of its page
    /// (`Compositor::inset_from_page`): it has no blur and no spread, and the
    /// leaf's pixels are what the page holds (a noise layer's are made from
    /// them first).
    fn sharp_inset_first(&self, layer: &ResolvedLayer) -> Option<ResolvedShadow> {
        match (&layer.kind, layer.effects.first()) {
            (ResolvedKind::Noise { .. }, _) => None,
            (_, Some(ResolvedEffect::InsetShadow(shadow)))
                if self.compositor.is_sharp_inset(shadow) =>
            {
                Some(*shadow)
            }
            _ => None,
        }
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

    /// The matrix `layer_texture` is given as its parent for `layer` in
    /// `siblings` under `parent`: `parent` moved by `source_shift` if the layer
    /// is warped. `plan_pages` takes it too, so a leaf is found on its page.
    fn shifted_parent(
        &self,
        siblings: &[ResolvedLayer],
        layer: &ResolvedLayer,
        parent: Affine,
    ) -> Affine {
        let Some(world) = warp::layer_world(&layer.transform) else {
            return parent;
        };
        if uses_backdrop(siblings, layer) {
            return parent;
        }
        let placement = Placement {
            parent,
            world,
            backface_hidden: layer.transform.backface_hidden,
        };
        shifted(self.source_shift(&placement), parent)
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
        // How many of the layer's effects drawing it has applied already, and
        // whether its clip has been.
        let mut applied = 0;
        let mut clipped = false;
        let src = match &layer.kind {
            ResolvedKind::Group { children, .. } => {
                let empty = self.timed(Stage::Composite, |s| s.compositor.filled([0.0; 4]));
                self.cache_path.push(layer.id.clone());
                let drawn = self.draw_layers(children, matrix, empty, backdrop);
                self.cache_path.pop();
                drawn?
            }
            // Triangles with vertex colours, not a Vello scene.
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
            // Meshes drawn with a depth buffer, not a Vello scene.
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
                let drawn = match self.page_target(layer, matrix)? {
                    Some((page, area)) => match self.sharp_inset_first(layer) {
                        // One pass cuts the leaf out and draws its inset shadow.
                        Some(shadow) => {
                            applied = 1;
                            self.timed(Stage::Composite, |s| {
                                s.compositor.inset_from_page(&page, area, region, &shadow)
                            })
                        }
                        None => match self.clipped_from_page(layer, matrix, &page, area, region)? {
                            // One pass cuts the leaf out and masks it.
                            Some(tex) => {
                                clipped = true;
                                tex
                            }
                            None => self.timed(Stage::Composite, |s| {
                                s.compositor.from_srgb8(&page, area, region)
                            }),
                        },
                    },
                    None => {
                        let area = self.vello_area(region);
                        self.timed(Stage::Raster, |s| s.rasterise(layer, parent, area))?;
                        self.timed(Stage::Composite, |s| {
                            s.compositor.from_srgb8(&s.vello_view, area, region)
                        })
                    }
                };
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
                    let area = self.vello_area(region);
                    self.timed(Stage::Raster, |s| s.rasterise_coverage(layer, parent, area))?;
                    Some(self.timed(Stage::Composite, |s| {
                        s.compositor.from_srgb8(&s.vello_view, area, region)
                    }))
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
                &layer.effects[applied..],
                backdrop,
                coverage.as_ref(),
                box_shadow.as_ref(),
            )
        });
        if let Some(coverage) = coverage {
            self.compositor.release(coverage);
        }
        if let Some(clip) = layer.clip.as_ref().filter(|_| !clipped) {
            let path = self.clip_path(clip, layer)?;
            let keep = self.path_bounds(&path, matrix);
            if keep.is_empty() {
                // Nothing is kept.
                self.compositor.release(src);
                src = self.timed(Stage::Composite, |s| s.compositor.empty());
            } else if !src.bounds.is_empty() {
                src = match self.clip_page_target(layer, matrix)? {
                    // The shape was drawn with the page it is on.
                    Some((page, area)) => self.timed(Stage::Composite, |s| {
                        s.compositor
                            .mask_from(src, &page, area, MaskMode::Alpha, keep)
                    }),
                    None => {
                        self.timed(Stage::Raster, |s| s.rasterise_clip(&path, matrix))?;
                        self.timed(Stage::Composite, |s| {
                            s.compositor.mask(src, &s.vello_view, MaskMode::Alpha, keep)
                        })
                    }
                };
            }
        }
        if let Some(mask) = &layer.mask
            && !src.bounds.is_empty()
        {
            // A gradient in box units is measured in the layer's box.
            let mask_box = if mask.gradient.units == Units::Box {
                self.layer_box(layer)?
            } else {
                None
            };
            self.timed(Stage::Raster, |s| s.rasterise_mask(mask, matrix, mask_box))?;
            let whole = self.whole();
            src = self.timed(Stage::Composite, |s| {
                s.compositor.mask(src, &s.vello_view, mask.mode, whole)
            });
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

    /// Groups the leaves of the frame that `layer_texture` will rasterise
    /// into pages, and encodes each page's Vello scene. No two leaves of a
    /// page overlap, and a page is drawn over the whole target with the
    /// matrices `rasterise` uses, so each leaf comes out of it as it would
    /// from a draw of its own. A page is drawn when one of its leaves is
    /// first wanted (`take_from_page`), so a frame whose layers all come
    /// from the layer cache draws none. Motion-blurred layers and the
    /// children of preserve3d groups are left out, and are drawn the way
    /// they always were.
    fn plan_pages(&mut self, layers: &[ResolvedLayer]) -> Result<()> {
        let mut leaves = Vec::new();
        self.collect_leaves(layers, margin_origin(self.margin), &mut leaves)?;
        let regions: Vec<PixelRect> = leaves.iter().map(|leaf| leaf.region).collect();
        let packed = pack_pages(&regions);
        for page in packed {
            self.vello_scene.reset();
            let mut has_images = false;
            // Vello draws from the canvas's top left corner, as a draw of the
            // whole canvas does; only the box up to the page's farthest
            // leaf is asked for.
            let mut reach = PixelRect::EMPTY;
            for i in page {
                let leaf = &leaves[i];
                match &leaf.clip {
                    Some(path) => {
                        self.vello_scene.fill(
                            Fill::NonZero,
                            leaf.matrix,
                            peniko::Color::WHITE,
                            None,
                            path,
                        );
                    }
                    None => {
                        self.encode_leaf(leaf.layer, leaf.matrix, None)?;
                        has_images |= draws_image(&leaf.layer.kind);
                    }
                }
                reach = reach.union(leaf.region);
                let key = if leaf.clip.is_some() {
                    clip_key(leaf.layer, leaf.matrix)
                } else {
                    leaf_key(leaf.layer, leaf.matrix)
                };
                self.pages
                    .page_of
                    .insert(key, (self.pages.pages.len(), leaf.region));
            }
            self.pages.pages.push(Page {
                scene: Some(std::mem::replace(
                    &mut self.vello_scene,
                    vello::Scene::new(),
                )),
                has_images,
                area: PixelRect::new(0, 0, reach.x1, reach.y1).intersect(self.whole()),
                target_size: (0, 0),
                target: None,
            });
        }
        Ok(())
    }

    /// The leaves of `layers` and their groups for `plan_pages`: each with
    /// the matrix and the box `layer_texture` rasterises it with, and the
    /// clip shapes of the layers that have a clip, in white, with the box
    /// they are masked by.
    fn collect_leaves<'a>(
        &mut self,
        layers: &'a [ResolvedLayer],
        parent: Affine,
        leaves: &mut Vec<Leaf<'a>>,
    ) -> Result<()> {
        for layer in layers {
            let matte_source = is_matte_source(layers, layer);
            if (is_hidden(layer) && !matte_source) || !layer.motion.is_empty() {
                continue;
            }
            let matrix = self.shifted_parent(layers, layer, parent) * layer.transform.matrix();
            if let Some(clip) = &layer.clip {
                let path = self.clip_path(clip, layer)?;
                let region = self.path_bounds(&path, matrix);
                if !region.is_empty() {
                    leaves.push(Leaf {
                        layer,
                        matrix,
                        region,
                        clip: Some(path),
                    });
                }
            }
            match &layer.kind {
                ResolvedKind::Group {
                    children,
                    preserve3d: false,
                    ..
                } => self.collect_leaves(children, matrix, leaves)?,
                ResolvedKind::Group { .. }
                | ResolvedKind::MeshGradient { .. }
                | ResolvedKind::Glsl { .. } => {}
                ResolvedKind::Scene3d { .. } => {}
                // The passes of its shadows and filters run between its
                // commands, so it is drawn alone (`rasterise`).
                ResolvedKind::Canvas { ops, .. } if canvas::has_effects(ops) => {}
                _ => {
                    let region = self.raster_bounds(layer, matrix)?;
                    if !region.is_empty() {
                        leaves.push(Leaf {
                            layer,
                            matrix,
                            region,
                            clip: None,
                        });
                    }
                }
            }
        }
        Ok(())
    }

    /// The Vello texture that holds the leaf `layer` under `matrix`, from
    /// its page, if it is on one, and the pixels of it that Vello drew: the
    /// page's, drawn now if this is the first leaf of it that is wanted.
    /// `from_srgb8` cuts the leaf out of it. The pixels of the other leaves of
    /// the page are in it too, outside this leaf's box.
    fn page_target(
        &mut self,
        layer: &ResolvedLayer,
        matrix: Affine,
    ) -> Result<Option<(wgpu::TextureView, PixelRect)>> {
        self.page_target_of(leaf_key(layer, matrix))
    }

    /// `page_target` for the clip shape of `layer` under `matrix`, drawn in
    /// white: its alpha is the clip's coverage.
    fn clip_page_target(
        &mut self,
        layer: &ResolvedLayer,
        matrix: Affine,
    ) -> Result<Option<(wgpu::TextureView, PixelRect)>> {
        self.page_target_of(clip_key(layer, matrix))
    }

    fn page_target_of(&mut self, key: LeafKey) -> Result<Option<(wgpu::TextureView, PixelRect)>> {
        if self.cache_paused > 0 {
            return Ok(None);
        }
        let Some(&(page, _)) = self.pages.page_of.get(&key) else {
            return Ok(None);
        };
        let area = self.pages.pages[page].area;
        if let Some(target) = &self.pages.pages[page].target {
            return Ok(Some((target.clone(), area)));
        }
        let scene = self.pages.pages[page]
            .scene
            .take()
            .expect("a page that is not drawn has its scene");
        let has_images = self.pages.pages[page].has_images;
        // A texture just big enough for the area, in steps of
        // `bounds::SIZE_STEP` so that the frames' pages find ones to reuse.
        let size = (
            bounds::size_class(area.width(), self.target_size.0),
            bounds::size_class(area.height(), self.target_size.1),
        );
        let target = self
            .page_targets
            .entry(size)
            .or_default()
            .pop()
            .unwrap_or_else(|| new_vello_target(&self.device, size));
        self.pages.pages[page].target_size = size;
        let previous = std::mem::replace(&mut self.vello_scene, scene);
        let rendered = self.timed(Stage::Raster, |s| {
            s.render_vello_scene_to(has_images, area, &target)
        });
        self.vello_scene = previous;
        rendered?;
        self.pages.pages[page].target = Some(target.clone());
        Ok(Some((target, area)))
    }

    /// Forgets the pages, keeping their Vello textures for the next frame's.
    fn clear_pages(&mut self) {
        for page in self.pages.pages.drain(..) {
            if let Some(target) = page.target {
                self.page_targets
                    .entry(page.target_size)
                    .or_default()
                    .push(target);
            }
        }
        self.pages.page_of.clear();
    }

    /// The box of the padded canvas's pixels.
    fn whole(&self) -> PixelRect {
        PixelRect::whole(self.target_size.0, self.target_size.1)
    }

    /// The pixels Vello is asked to draw for a leaf whose pixels are in
    /// `region`. The whole target, except for the leaves of a motion-blurred
    /// layer's samples (`cache_paused`), which are drawn many times a frame
    /// and are drawn into the box they cover (`bounds::vello_area`).
    fn vello_area(&self, region: PixelRect) -> PixelRect {
        if self.cache_paused > 0 && !region.is_empty() {
            bounds::vello_area(region)
        } else {
            self.whole()
        }
    }

    /// The pixels that rasterising the leaf `layer` under `matrix` can touch:
    /// the box of what it draws in layer space, through the matrix, a pixel
    /// more all round for the anti-aliased edge (Vello draws nothing else),
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
                text_bounds(&laid_out, *size, *max_width, chars)
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

    /// Draws one leaf layer, with all transforms applied, into the Vello
    /// target texture: the pixels `area` of the canvas, from the texture's
    /// top left corner.
    fn rasterise(&mut self, layer: &ResolvedLayer, parent: Affine, area: PixelRect) -> Result<()> {
        let matrix = in_area(area, parent * layer.transform.matrix());
        self.vello_scene.reset();
        // The pictures a canvas's shadows and filters make live in Vello's
        // image atlas until it has drawn them.
        let mut pictures = Vec::new();
        let drawn = self
            .encode_leaf(layer, matrix, Some((area, &mut pictures)))
            .and_then(|()| self.render_vello_scene(draws_image(&layer.kind), area));
        if let Some(renderer) = self.vello_images.as_mut() {
            for picture in pictures {
                renderer.unregister_texture(picture);
            }
        }
        drawn
    }

    /// Adds the leaf `layer`, drawn with `matrix`, to `vello_scene`. A canvas
    /// layer's shadows and filters run when `effects` says where on the
    /// canvas the scene's corner is (`rasterise`'s `area`) and holds the
    /// pictures they make.
    fn encode_leaf(
        &mut self,
        layer: &ResolvedLayer,
        matrix: Affine,
        effects: Option<(PixelRect, &mut Vec<ImageData>)>,
    ) -> Result<()> {
        match &layer.kind {
            ResolvedKind::Shape {
                geometry,
                fill,
                stroke,
                style,
            } => {
                let path = geometry_path(geometry)?;
                if let Some(paint) = fill {
                    // The box a gradient in box units is measured in: the
                    // geometry, without the stroke.
                    let (brush, brush_transform) =
                        paint_brush_in(paint, Some(path.bounding_box()), &self.images);
                    self.vello_scene
                        .fill(fill_rule(style), matrix, &brush, brush_transform, &path);
                }
                if let Some((color, width)) = stroke {
                    self.vello_scene.stroke(
                        &stroke_of(*width, style),
                        matrix,
                        to_peniko(*color),
                        None,
                        &path,
                    );
                }
            }
            ResolvedKind::Text {
                text,
                font,
                size,
                color,
                line_height,
                max_width,
                align,
                chars,
                runs,
                box_size,
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
                let (box_width, box_height) = laid_out.box_size(*max_width);
                let text_box = Rect::new(0.0, 0.0, box_width, box_height);
                let (brush, brush_transform) = paint_brush_in(color, Some(text_box), &self.images);
                let centres = if chars.iter().any(Option::is_some) {
                    laid_out.char_centres()
                } else {
                    BTreeMap::new()
                };
                for run in &laid_out.runs {
                    let mut plain = Vec::new();
                    let draw = |scene: &mut vello::Scene,
                                matrix: Affine,
                                brush: &peniko::Brush,
                                brush_transform: Option<Affine>,
                                glyphs: &mut Vec<vello::Glyph>| {
                        if glyphs.is_empty() {
                            return;
                        }
                        scene
                            .draw_glyphs(&run.font)
                            .transform(matrix)
                            .glyph_transform(
                                (run.skew != 0.0).then(|| {
                                    Affine::skew(f64::from(run.skew).to_radians().tan(), 0.0)
                                }),
                            )
                            .normalized_coords(&run.coords)
                            .font_embolden(vello::FontEmbolden::new(vello::kurbo::Diagonal2::new(
                                f64::from(run.embolden),
                                f64::from(run.embolden),
                            )))
                            .brush_transform(brush_transform)
                            .font_size(run.font_size)
                            .hint(false)
                            .brush(brush)
                            .draw(Fill::NonZero, glyphs.drain(..));
                    };
                    for g in &run.glyphs {
                        let glyph = vello::Glyph {
                            id: g.id,
                            x: g.x,
                            y: g.y,
                        };
                        let Some(style) = char_style(chars, g.char_index) else {
                            plain.push(glyph);
                            continue;
                        };
                        // The characters before this one are drawn first, to
                        // keep the order of the text.
                        draw(
                            &mut self.vello_scene,
                            matrix,
                            &brush,
                            brush_transform,
                            &mut plain,
                        );
                        if style.opacity <= 0.0 {
                            continue;
                        }
                        let centre = centres.get(&g.char_index).copied().unwrap_or_default();
                        let own = match style.color {
                            Some(c) => peniko::Brush::Solid(to_peniko(c)),
                            None => brush.clone(),
                        }
                        .multiply_alpha(style.opacity);
                        let own_transform = if style.color.is_some() {
                            None
                        } else {
                            brush_transform
                        };
                        draw(
                            &mut self.vello_scene,
                            matrix * char_matrix(style, centre),
                            &own,
                            own_transform,
                            &mut vec![glyph],
                        );
                    }
                    draw(
                        &mut self.vello_scene,
                        matrix,
                        &brush,
                        brush_transform,
                        &mut plain,
                    );
                }
            }
            ResolvedKind::Image {
                src,
                width,
                height,
                fit,
            } => {
                draw_picture(
                    &mut self.vello_scene,
                    &self.images[src],
                    matrix,
                    (*width, *height),
                    *fit,
                );
            }
            // A video's picture and a GIF's go in like an image.
            ResolvedKind::Video {
                src,
                width,
                height,
                fit,
                time,
            } => {
                let image = self.videos.image(src, *time)?;
                draw_picture(
                    &mut self.vello_scene,
                    &image,
                    matrix,
                    (*width, *height),
                    *fit,
                );
            }
            ResolvedKind::Gif {
                src,
                width,
                height,
                fit,
                time,
                looped,
            } => {
                let image = self.gifs.image(src, *time, *looped)?;
                draw_picture(
                    &mut self.vello_scene,
                    &image,
                    matrix,
                    (*width, *height),
                    *fit,
                );
            }
            // ThorVG paints the animation at the size it is drawn at, and
            // it goes in like an image.
            ResolvedKind::Lottie {
                src,
                width,
                height,
                time,
                looped,
            } => {
                if let Some((pixels_wide, pixels_high)) = lottie_pixels((*width, *height), matrix) {
                    let image =
                        self.lotties
                            .image(src, *time, *looped, pixels_wide, pixels_high)?;
                    let to_box = Affine::scale_non_uniform(
                        width / f64::from(pixels_wide),
                        height / f64::from(pixels_high),
                    );
                    self.vello_scene.draw_image(&image, matrix * to_box);
                }
            }
            ResolvedKind::Canvas { width, height, ops } => {
                let whole = self.whole();
                let mut passes = effects.map(|(area, pictures)| CanvasPasses {
                    device: &self.device,
                    queue: &self.queue,
                    vello: &mut self.vello,
                    vello_images: self.vello_images.as_mut(),
                    target: &self.vello_view,
                    compositor: &mut self.compositor,
                    area,
                    whole,
                    pictures,
                });
                canvas::encode(
                    &mut self.vello_scene,
                    &mut canvas::Drawing {
                        text: &mut self.text,
                        images: &self.images,
                        effects: passes
                            .as_mut()
                            .map(|passes| passes as &mut dyn canvas::Effects),
                    },
                    (*width, *height),
                    ops,
                    matrix,
                )?;
            }
            // The box in opaque white: the noise pass fills its coverage.
            ResolvedKind::Noise { width, height, .. } => {
                self.vello_scene.fill(
                    Fill::NonZero,
                    matrix,
                    peniko::Color::WHITE,
                    None,
                    &Rect::new(0.0, 0.0, *width, *height),
                );
            }
            ResolvedKind::Group { .. }
            | ResolvedKind::MeshGradient { .. }
            | ResolvedKind::Glsl { .. }
            | ResolvedKind::Scene3d { .. } => {
                unreachable!(
                    "groups, meshes, WebGL layers and 3D scenes are composited, not rasterised"
                )
            }
        }
        Ok(())
    }

    /// Draws a shape layer's fill and stroke in opaque white into the Vello
    /// target (the pixels `area`, as in `rasterise`), whatever their colours
    /// and alphas; its alpha is then where the shape is solid.
    fn rasterise_coverage(
        &mut self,
        layer: &ResolvedLayer,
        parent: Affine,
        area: PixelRect,
    ) -> Result<()> {
        let matrix = in_area(area, parent * layer.transform.matrix());
        self.vello_scene.reset();
        if let ResolvedKind::Shape {
            geometry,
            fill,
            stroke,
            style,
        } = &layer.kind
        {
            let path = geometry_path(geometry)?;
            if fill.is_some() {
                self.vello_scene
                    .fill(fill_rule(style), matrix, peniko::Color::WHITE, None, &path);
            }
            if let Some((_, width)) = stroke {
                self.vello_scene.stroke(
                    &stroke_of(*width, style),
                    matrix,
                    peniko::Color::WHITE,
                    None,
                    &path,
                );
            }
        }
        self.render_vello_scene(false, area)
    }

    /// Draws the layer's clip shape (`path`, in layer space) in opaque white
    /// into the Vello target; its alpha is then the clip's coverage.
    fn rasterise_clip(&mut self, path: &BezPath, matrix: Affine) -> Result<()> {
        self.vello_scene.reset();
        self.vello_scene
            .fill(Fill::NonZero, matrix, peniko::Color::WHITE, None, path);
        self.render_vello_scene(false, self.whole())
    }

    /// Fills the whole target (canvas and margin) with the mask's gradient,
    /// which lives in layer space (or in the layer's box, `layer_box`), into
    /// the Vello target.
    fn rasterise_mask(
        &mut self,
        mask: &ResolvedMask,
        matrix: Affine,
        layer_box: Option<Rect>,
    ) -> Result<()> {
        let (brush, brush_transform) = gradient_brush_in(&mask.gradient, layer_box);
        let canvas = Rect::new(
            0.0,
            0.0,
            f64::from(self.target_size.0),
            f64::from(self.target_size.1),
        );
        self.vello_scene.reset();
        self.vello_scene.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            &brush,
            Some(matrix * brush_transform),
            &canvas,
        );
        self.render_vello_scene(false, self.whole())
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

    /// Renders `vello_scene` into the top left corner of the Vello target
    /// texture, `area` pixels across and down (`area` is a box of the padded
    /// canvas, and the scene's matrices already put its corner at (0, 0), see
    /// `in_area`). Vello writes only the pixels of that size, so the rest of
    /// the texture keeps what it held and is not read (`from_srgb8`). Image
    /// layers use their own renderer (see `vello_images`).
    fn render_vello_scene(&mut self, has_images: bool, area: PixelRect) -> Result<()> {
        // The passes recorded so far may read what Vello drew last.
        self.compositor.submit();
        let target = self.vello_view.clone();
        self.render_vello_scene_to(has_images, area, &target)
    }

    /// `render_vello_scene` into `target`, a texture of the same size that no
    /// recorded pass is to read the old contents of.
    fn render_vello_scene_to(
        &mut self,
        has_images: bool,
        area: PixelRect,
        target: &wgpu::TextureView,
    ) -> Result<()> {
        let renderer = if has_images {
            self.vello_images.as_mut()
        } else {
            Some(&mut self.vello)
        }
        .expect("scenes with image layers get an image renderer");
        renderer
            .render_to_texture(
                &self.device,
                &self.queue,
                &self.vello_scene,
                target,
                &RenderParams {
                    base_color: peniko::Color::TRANSPARENT,
                    width: area.width(),
                    height: area.height(),
                    antialiasing_method: AaConfig::Msaa16,
                },
            )
            .map_err(|e| Error::Render(format!("Vello render failed: {e}")))
    }
}

/// How many pixels of pictures the shadows and filters of one canvas layer may
/// make: three quarters of Vello's largest image atlas (8192 x 8192), which a
/// fuller one cannot be counted on to pack. Vello leaves out what does not
/// fit, so past this a frame is refused instead.
const PICTURE_PIXELS: u64 = 8192 * 8192 / 4 * 3;

/// The shadows and filters of a canvas layer's commands (`canvas::Effects`):
/// each is drawn alone with Vello, run through the compositor's passes, and
/// handed back as a picture registered with the image renderer.
struct CanvasPasses<'a> {
    device: &'a wgpu::Device,
    queue: &'a wgpu::Queue,
    vello: &'a mut vello::Renderer,
    vello_images: Option<&'a mut vello::Renderer>,
    /// The Vello target, which a command is drawn alone into.
    target: &'a wgpu::TextureView,
    compositor: &'a mut Compositor,
    /// The pixels of the canvas that the scene being encoded starts at
    /// (`rasterise`'s `area`).
    area: PixelRect,
    whole: PixelRect,
    /// Every picture made, for the caller to unregister.
    pictures: &'a mut Vec<ImageData>,
}

impl canvas::Effects for CanvasPasses<'_> {
    fn run(
        &mut self,
        alone: &vello::Scene,
        pictures: bool,
        bounds: Rect,
        filter: &[ResolvedEffect],
        shadow: Option<&ResolvedShadow>,
    ) -> Result<canvas::Rendered> {
        let corner = Affine::translate((f64::from(self.area.x0), f64::from(self.area.y0)));
        let region = device_bounds(corner, bounds).intersect(self.whole);
        if region.is_empty() {
            return Ok(canvas::Rendered::default());
        }
        // Vello draws only the box the command can touch, at the target's
        // corner.
        let mut moved = vello::Scene::new();
        moved.append(
            alone,
            Some(Affine::translate((
                f64::from(self.area.x0 - region.x0),
                f64::from(self.area.y0 - region.y0),
            ))),
        );
        // The commands recorded so far may read what Vello drew last.
        self.compositor.submit();
        let renderer = if pictures {
            self.vello_images.as_deref_mut()
        } else {
            Some(&mut *self.vello)
        }
        .expect("scenes with a shadow or a filter get an image renderer");
        renderer
            .render_to_texture(
                self.device,
                self.queue,
                &moved,
                self.target,
                &RenderParams {
                    base_color: peniko::Color::TRANSPARENT,
                    width: region.width(),
                    height: region.height(),
                    antialiasing_method: AaConfig::Msaa16,
                },
            )
            .map_err(|e| Error::Render(format!("Vello render failed: {e}")))?;
        let drawn = self.compositor.from_srgb8(self.target, region, region);
        let filtered =
            self.compositor
                .apply_effects(drawn, Affine::IDENTITY, None, filter, None, None, None);
        let shadow = shadow.map(|s| self.compositor.cast_shadow(&filtered, s));
        let rendered = canvas::Rendered {
            shape: if filter.is_empty() {
                None
            } else {
                self.picture(&filtered)?
            },
            shadow: match &shadow {
                Some(s) => self.picture(s)?,
                None => None,
            },
        };
        self.compositor.release(filtered);
        if let Some(shadow) = shadow {
            self.compositor.release(shadow);
        }
        Ok(rendered)
    }
}

impl CanvasPasses<'_> {
    /// `tex` as a picture of the scene, where it is non-zero. `None` when it
    /// is nowhere.
    fn picture(&mut self, tex: &Tex) -> Result<Option<canvas::Placed>> {
        let region = tex.bounds.intersect(self.whole);
        if region.is_empty() {
            return Ok(None);
        }
        let made: u64 = self
            .pictures
            .iter()
            .map(|p| u64::from(p.width) * u64::from(p.height))
            .sum();
        if made + u64::from(region.width()) * u64::from(region.height()) > PICTURE_PIXELS {
            return Err(Error::Render(format!(
                "canvas: the shadows and filters of one canvas layer make pictures of more than {PICTURE_PIXELS} \
                 pixels (Vello's image atlas holds 8192 x 8192): draw fewer, or smaller ones"
            )));
        }
        let texture = self.compositor.to_srgb8(tex, region);
        let image = self
            .vello_images
            .as_deref_mut()
            .expect("scenes with a shadow or a filter get an image renderer")
            .register_texture(texture);
        self.pictures.push(image.clone());
        Ok(Some(canvas::Placed {
            image,
            at: (
                f64::from(region.x0 - self.area.x0),
                f64::from(region.y0 - self.area.y0),
            ),
        }))
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

/// The fill rule of a shape as Vello has it.
fn fill_rule(style: &ShapeStyle) -> Fill {
    match style.fill_rule {
        crate::scene::FillRule::NonZero => Fill::NonZero,
        crate::scene::FillRule::EvenOdd => Fill::EvenOdd,
    }
}

/// The stroke of a shape: `width` wide, finished as `style` says.
fn stroke_of(width: f64, style: &ShapeStyle) -> Stroke {
    use crate::scene::{StrokeCap, StrokeJoin};
    let cap = match style.cap {
        StrokeCap::Butt => vello::kurbo::Cap::Butt,
        StrokeCap::Round => vello::kurbo::Cap::Round,
        StrokeCap::Square => vello::kurbo::Cap::Square,
    };
    let join = match style.join {
        StrokeJoin::Miter => vello::kurbo::Join::Miter,
        StrokeJoin::Round => vello::kurbo::Join::Round,
        StrokeJoin::Bevel => vello::kurbo::Join::Bevel,
    };
    let stroke = Stroke::new(width)
        .with_caps(cap)
        .with_join(join)
        .with_miter_limit(style.miter_limit);
    if style.dash.is_empty() {
        stroke
    } else {
        stroke.with_dashes(style.dash_offset, style.dash.iter().copied())
    }
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
fn char_style(chars: &[Option<ResolvedChar>], index: u32) -> Option<&ResolvedChar> {
    chars.get(index as usize).and_then(Option::as_ref)
}

/// Where a styled character goes, in text-box space: moved by its offset,
/// then scaled and turned about its centre.
fn char_matrix(style: &ResolvedChar, centre: (f64, f64)) -> Affine {
    Affine::translate((style.x, style.y))
        * Affine::translate(centre)
        * Affine::rotate(style.rotation.to_radians())
        * Affine::scale(style.scale)
        * Affine::translate((-centre.0, -centre.1))
}

/// `matrix` (layer space to padded-canvas pixels) for a draw of the pixels
/// `area` of the canvas, whose corner Vello takes for (0, 0): moved back by
/// that corner, a whole number of pixels. A draw from the canvas's own corner
/// gets `matrix` itself.
fn in_area(area: PixelRect, matrix: Affine) -> Affine {
    if area.x0 == 0 && area.y0 == 0 {
        matrix
    } else {
        Affine::translate((-f64::from(area.x0), -f64::from(area.y0))) * matrix
    }
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

/// Where the canvas's top-left corner sits in the padded textures: `margin`
/// pixels in from the corner. Every layer is drawn inside this transform. At
/// margin 0 it is bit for bit `Affine::IDENTITY`.
fn margin_origin(margin: u32) -> Affine {
    Affine::translate((f64::from(margin), f64::from(margin)))
}

/// Whether `layer` draws nothing at any time of its frame.
/// A leaf layer as `layer_texture` rasterises it: the layer itself (its
/// address, which is the same for the whole frame) and its matrix.
type LeafKey = (usize, [u64; 6]);

/// A leaf of `plan_pages`: a layer's own pixels, or the white shape of its
/// clip (`clip`, which `region` is the box of).
struct Leaf<'a> {
    layer: &'a ResolvedLayer,
    matrix: Affine,
    region: PixelRect,
    clip: Option<BezPath>,
}

/// Where the clip shape of a layer is: its key with the address one past
/// the layer's, which no layer is at.
fn clip_key(layer: &ResolvedLayer, matrix: Affine) -> LeafKey {
    let (address, matrix) = leaf_key(layer, matrix);
    (address + 1, matrix)
}

fn leaf_key(layer: &ResolvedLayer, matrix: Affine) -> LeafKey {
    (
        std::ptr::from_ref(layer) as usize,
        matrix.as_coeffs().map(f64::to_bits),
    )
}

/// The leaves of a frame that Vello draws a page at a time
/// (`Renderer::plan_pages`).
#[derive(Default)]
struct Pages {
    pages: Vec<Page>,
    /// Which page each leaf is on, and the pixels it can touch.
    page_of: HashMap<LeafKey, (usize, PixelRect)>,
}

struct Page {
    /// Its Vello scene, until the page is drawn.
    scene: Option<vello::Scene>,
    /// Whether it has an image, which picks the renderer (`vello_images`).
    has_images: bool,
    /// The pixels Vello draws of it: the canvas's top left corner and what
    /// reaches as far as the page's leaves do.
    area: PixelRect,
    /// The size of the texture Vello draws it into, once it is drawn.
    target_size: (u32, u32),
    /// The texture Vello drew it into, once it is drawn. Each page has one
    /// of its own for the rest of the frame, so a leaf is cut out of it
    /// whenever the leaf is wanted.
    target: Option<wgpu::TextureView>,
}

/// Groups the leaves whose pixels are in `regions` into pages, so that no
/// two leaves of a page overlap: each page is drawn by one Vello render. The
/// pages are lists of indices into `regions`, in order. Few pages is what is
/// wanted, and finding the fewest is hard, so this colours the overlap graph
/// with DSATUR (the leaf that has the most colours among the leaves it
/// overlaps, then the most overlaps, takes the first colour free of them),
/// which comes within a page or two of the deepest stack of leaves. Past
/// `DSATUR_LEAVES` leaves, where its quadratic cost is not worth it, each leaf
/// goes on the first page it fits on.
fn pack_pages(regions: &[PixelRect]) -> Vec<Vec<usize>> {
    const DSATUR_LEAVES: usize = 600;
    let n = regions.len();
    let overlaps = |i: usize, j: usize| !regions[i].intersect(regions[j]).is_empty();
    let mut pages: Vec<Vec<usize>> = Vec::new();
    if n > DSATUR_LEAVES {
        // Largest first: the big boxes that overlap everything are alone on
        // their pages early, and the small ones fill in around them.
        let area = |i: usize| i64::from(regions[i].width()) * i64::from(regions[i].height());
        let mut order: Vec<usize> = (0..n).collect();
        order.sort_by_key(|&i| (std::cmp::Reverse(area(i)), i));
        for i in order {
            match pages
                .iter_mut()
                .find(|page| page.iter().all(|&j| !overlaps(i, j)))
            {
                Some(page) => page.push(i),
                None => pages.push(vec![i]),
            }
        }
        for page in &mut pages {
            page.sort_unstable();
        }
        return pages;
    }
    let neighbours: Vec<Vec<usize>> = (0..n)
        .map(|i| (0..n).filter(|&j| j != i && overlaps(i, j)).collect())
        .collect();
    let mut colour: Vec<Option<usize>> = vec![None; n];
    for _ in 0..n {
        // The saturation of a leaf is how many colours its neighbours have.
        let saturation = |i: usize| {
            let mut seen: Vec<usize> = neighbours[i].iter().filter_map(|&j| colour[j]).collect();
            seen.sort_unstable();
            seen.dedup();
            seen.len()
        };
        let next = (0..n)
            .filter(|&i| colour[i].is_none())
            .max_by_key(|&i| (saturation(i), neighbours[i].len(), std::cmp::Reverse(i)))
            .expect("a leaf without a colour is left");
        let taken: Vec<usize> = neighbours[next].iter().filter_map(|&j| colour[j]).collect();
        let free = (0..)
            .find(|c| !taken.contains(c))
            .expect("a colour is free");
        colour[next] = Some(free);
        if free == pages.len() {
            pages.push(Vec::new());
        }
        pages[free].push(next);
    }
    for page in &mut pages {
        page.sort_unstable();
    }
    pages
}

/// A layer drawn and waiting to be blended onto its canvas.
struct Pending<'a> {
    what: Waiting<'a>,
    opacity: f32,
    mode: BlendMode,
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
    /// Not drawn into a texture of its own: blended straight from its Vello
    /// page (and its clip's), the layer cache told only what it was made
    /// from (`LayerCache::note`).
    Page {
        id: Option<Vec<String>>,
        inputs: Inputs<'a>,
        leaf: (wgpu::TextureView, PixelRect),
        clip: Option<(wgpu::TextureView, PixelRect)>,
        bounds: PixelRect,
    },
}

impl Pending<'_> {
    fn source(&self) -> BlendSource<'_> {
        match &self.what {
            Waiting::Cached { hit, .. } => BlendSource::Texture(hit.texture()),
            Waiting::Kept { texture, .. } | Waiting::Loose(texture) => {
                BlendSource::Texture(texture)
            }
            Waiting::Page {
                leaf, clip, bounds, ..
            } => BlendSource::Page {
                leaf: (&leaf.0, leaf.1),
                clip: clip.as_ref().map(|(view, area)| (view, *area)),
                bounds: *bounds,
            },
        }
    }
}

/// How many drawn layers may wait to be blended before they are. A flush
/// costs the passes that `blend_many` makes of them; more waiting layers
/// would hold more textures than the pool is likely to have.
const MAX_PENDING: usize = 16;

fn is_hidden(layer: &ResolvedLayer) -> bool {
    if layer.motion.is_empty() {
        layer.opacity <= 0.0
    } else {
        layer.motion.iter().all(|sub| sub.opacity <= 0.0)
    }
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

/// The brush for a fill or text colour, and the transform to apply to it on
/// top of the transform of whatever it paints (`None` for a solid colour).
///
/// `layer_box` is the box of the layer being painted, which a gradient in box
/// units is measured in (`gradient_brush_in`).
fn paint_brush(paint: &ResolvedPaint, layer_box: Option<Rect>) -> (peniko::Brush, Option<Affine>) {
    match paint {
        ResolvedPaint::Solid(color) => (peniko::Brush::Solid(to_peniko(*color)), None),
        ResolvedPaint::Gradient(g) => {
            let (brush, brush_transform) = gradient_brush_in(g, layer_box);
            (brush, Some(brush_transform))
        }
        // Needs the decoded pictures: see `paint_brush_in`.
        ResolvedPaint::Image(_) => (peniko::Brush::Solid(peniko::Color::TRANSPARENT), None),
    }
}

/// `paint_brush`, with the pictures an image paint draws (`Renderer::images`).
/// The picture is placed and sized by the paint, and repeats in the
/// directions it says (an axis that does not repeat holds its edge pixels, so
/// the shape painted must stop at the tile).
fn paint_brush_in(
    paint: &ResolvedPaint,
    layer_box: Option<Rect>,
    images: &HashMap<String, ImageData>,
) -> (peniko::Brush, Option<Affine>) {
    let ResolvedPaint::Image(i) = paint else {
        return paint_brush(paint, layer_box);
    };
    let Some(image) = images.get(&i.src) else {
        return (peniko::Brush::Solid(peniko::Color::TRANSPARENT), None);
    };
    let extend = |repeat: bool| {
        if repeat {
            peniko::Extend::Repeat
        } else {
            peniko::Extend::Pad
        }
    };
    let sampler = peniko::ImageSampler {
        x_extend: extend(i.repeat_x),
        y_extend: extend(i.repeat_y),
        ..Default::default()
    };
    let brush = peniko::Brush::Image(peniko::ImageBrush {
        image: image.clone(),
        sampler,
    });
    let to_tile = Affine::translate((i.x, i.y))
        * Affine::scale_non_uniform(
            i.width / f64::from(image.width.max(1)),
            i.height / f64::from(image.height.max(1)),
        );
    (brush, Some(to_tile))
}

/// `gradient_brush`, for a gradient that may be in box units: its coordinates
/// are then fractions of `layer_box`, so the brush is moved to the box's
/// corner and stretched to its size, after the gradient's own turn (SVG's
/// `objectBoundingBox`). A box with no width or height has no extent, and so
/// paints the last stop's colour, like any gradient without one.
fn gradient_brush_in(g: &ResolvedGradient, layer_box: Option<Rect>) -> (peniko::Brush, Affine) {
    let (brush, turn) = gradient_brush(g);
    let turn = g.transform * turn;
    let (Units::Box, Some(b)) = (g.units, layer_box) else {
        return (
            linear_in_layer_space(g, brush, Affine::IDENTITY, turn),
            linear_transform(g, turn),
        );
    };
    if !(b.width() > 0.0 && b.height() > 0.0) {
        let last = g.stops[g.stops.len() - 1].1;
        return (peniko::Brush::Solid(to_peniko(last)), Affine::IDENTITY);
    }
    let to_box = Affine::translate((b.x0, b.y0)) * Affine::scale_non_uniform(b.width(), b.height());
    (
        linear_in_layer_space(g, brush, to_box, turn),
        linear_transform(g, to_box * turn),
    )
}

/// Vello places a linear gradient by moving its two end points, so a matrix
/// that stretches or skews does not tilt the lines of one colour as it should
/// (SVG's `gradientTransform` on a diagonal gradient, or `objectBoundingBox`
/// on a box that is not square). The same gradient, for any matrix, is the
/// one whose line runs along the direction its colour changes fastest in the
/// painted space; the brush for that has no matrix of its own
/// (`linear_transform`). Everything else goes through Vello's matrix as it is.
fn linear_in_layer_space(
    g: &ResolvedGradient,
    brush: peniko::Brush,
    to_box: Affine,
    turn: Affine,
) -> peniko::Brush {
    let ResolvedGradientGeometry::Linear { x0, y0, x1, y1 } = g.geometry else {
        return brush;
    };
    let m = to_box * turn;
    if !moves_by_matrix(g, m) {
        return brush;
    }
    let (dx, dy) = (x1 - x0, y1 - y0);
    let len2 = dx * dx + dy * dy;
    if len2 < 1e-12 {
        return brush;
    }
    // t at a layer point p is ((m^-1 p - start) . d) / |d|^2: a plane, with
    // this slope and its value at the origin.
    let [a, b, c, d, e, f] = m.inverse().as_coeffs();
    let slope = Vec2::new((a * dx + b * dy) / len2, (c * dx + d * dy) / len2);
    let at_origin = ((e - x0) * dx + (f - y0) * dy) / len2;
    let slope2 = slope.hypot2();
    if slope2 < 1e-18 {
        return brush;
    }
    let start = Point::ZERO - slope * (at_origin / slope2);
    let end = start + slope / slope2;
    let mut moved = g.clone();
    moved.geometry = ResolvedGradientGeometry::Linear {
        x0: start.x,
        y0: start.y,
        x1: end.x,
        y1: end.y,
    };
    gradient_brush(&moved).0
}

/// The matrix to give the brush `linear_in_layer_space` made, or `m` for any
/// other.
fn linear_transform(g: &ResolvedGradient, m: Affine) -> Affine {
    if moves_by_matrix(g, m) {
        Affine::IDENTITY
    } else {
        m
    }
}

/// Whether `linear_in_layer_space` applies: a linear gradient with a matrix
/// of its own (`Gradient::transform`) that Vello would place wrongly. One
/// without keeps the placement it always had.
fn moves_by_matrix(g: &ResolvedGradient, m: Affine) -> bool {
    matches!(g.geometry, ResolvedGradientGeometry::Linear { .. })
        && g.transform != Affine::IDENTITY
        && !m.is_nan()
        && m.determinant().abs() >= 1e-12
        && !is_similarity(m)
}

/// Whether `m` is a rotation, a uniform scale and a move: Vello then places a
/// linear gradient exactly.
fn is_similarity(m: Affine) -> bool {
    let [a, b, c, d, _, _] = m.as_coeffs();
    let s = a.hypot(b);
    (a - d).abs() < 1e-9 * s.max(1.0) && (b + c).abs() < 1e-9 * s.max(1.0)
}

/// A resolved gradient as a Vello brush, plus a transform to apply to the
/// brush on top of the transform of whatever it paints (a conic gradient is
/// turned here so its first stop points the way CSS wants).
///
/// Stops are adjusted for how Vello reads them: it ignores the first stop's
/// offset (treating it as 0) and pads past the last, so end stops are added at
/// 0 and 1. For `repeat` and `reflect`, the span between the first and last
/// stop is what repeats (as in CSS), so the line, radius or angle is scaled to
/// that span and the stops stretched to fill 0..=1. A gradient with no
/// extent (zero length or radius, or all stops at one offset in a repeating
/// gradient) is the solid colour of its last stop.
pub(crate) fn gradient_brush(g: &ResolvedGradient) -> (peniko::Brush, Affine) {
    let last = g.stops[g.stops.len() - 1];
    let solid = (peniko::Brush::Solid(to_peniko(last.1)), Affine::IDENTITY);
    let (lo, hi) = match g.extend {
        Extend::Pad => (0.0, 1.0),
        _ => (g.stops[0].0, last.0),
    };
    if hi - lo < 1e-6 {
        return solid;
    }
    let mut turn = Affine::IDENTITY;
    let gradient = match g.geometry {
        ResolvedGradientGeometry::Linear { x0, y0, x1, y1 } => {
            let (p0, p1) = (Point::new(x0, y0), Point::new(x1, y1));
            if p0.distance(p1) < 1e-6 {
                return solid;
            }
            peniko::Gradient::new_linear(p0 + (p1 - p0) * lo, p0 + (p1 - p0) * hi)
        }
        ResolvedGradientGeometry::Radial { cx, cy, r } => {
            if r < 1e-6 {
                return solid;
            }
            let c = Point::new(cx, cy);
            peniko::Gradient::new_two_point_radial(c, (r * lo) as f32, c, (r * hi) as f32)
        }
        ResolvedGradientGeometry::FocalRadial {
            cx,
            cy,
            r,
            fx,
            fy,
            fr,
        } => {
            // The circles run from the focal one (offset 0) to the outer one
            // (offset 1); the span `lo..hi` is what is drawn.
            let at = |t: f64| {
                (
                    Point::new(fx + (cx - fx) * t, fy + (cy - fy) * t),
                    (fr + (r - fr) * t) as f32,
                )
            };
            let ((c0, r0), (c1, r1)) = (at(lo), at(hi));
            if c0.distance(c1) < 1e-6 && (r1 - r0).abs() < 1e-6 {
                return solid;
            }
            peniko::Gradient::new_two_point_radial(c0, r0, c1, r1)
        }
        ResolvedGradientGeometry::Conic { cx, cy, angle } => {
            let c = Point::new(cx, cy);
            // Vello's sweep starts at 3 o'clock; CSS starts at 12.
            turn = Affine::rotate_about((angle - 90.0).to_radians(), c);
            let turns = std::f64::consts::TAU;
            peniko::Gradient::new_sweep(c, (lo * turns) as f32, (hi * turns) as f32)
        }
    };
    let extend = match g.extend {
        Extend::Pad => peniko::Extend::Pad,
        Extend::Repeat => peniko::Extend::Repeat,
        Extend::Reflect => peniko::Extend::Reflect,
    };
    let gradient = gradient
        .with_extend(extend)
        .with_stops(vello_stops(&g.stops, lo, hi).as_slice());
    (peniko::Brush::Gradient(gradient), turn)
}

/// `stops` with offsets mapped from `lo..=hi` onto 0..=1, and a stop added at
/// 0 and at 1 if the first or last does not already sit there.
fn vello_stops(stops: &[(f64, Color)], lo: f64, hi: f64) -> Vec<peniko::ColorStop> {
    let at = |offset: f64, color: Color| peniko::ColorStop::from((offset as f32, to_peniko(color)));
    let mut out = Vec::with_capacity(stops.len() + 2);
    let (first, last) = (stops[0], stops[stops.len() - 1]);
    if first.0 > lo {
        out.push(at(0.0, first.1));
    }
    for &(offset, color) in stops {
        out.push(at(((offset - lo) / (hi - lo)).clamp(0.0, 1.0), color));
    }
    if last.0 < hi {
        out.push(at(1.0, last.1));
    }
    out
}

/// Whether a leaf is drawn with an image (the image renderer, `vello_images`).
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

/// Adds `image` to `scene`, fitted to the box `size` at the layer origin as
/// `fit` says, under `matrix`. `cover` overhangs the box, so a clip cuts it
/// to the box.
fn draw_picture(
    scene: &mut vello::Scene,
    image: &ImageData,
    matrix: Affine,
    size: (f64, f64),
    fit: Fit,
) {
    let natural = (f64::from(image.width), f64::from(image.height));
    if let Some(placed) = fit_image(fit, size, natural) {
        let cut = fit == Fit::Cover;
        if cut {
            scene.push_clip_layer(Fill::NonZero, matrix, &Rect::new(0.0, 0.0, size.0, size.1));
        }
        scene.draw_image(image, matrix * placed);
        if cut {
            scene.pop_layer();
        }
    }
}

/// Largest side, in pixels, ThorVG is asked to paint a Lottie layer at.
const MAX_LOTTIE_SIDE: f64 = 4096.0;

/// The size in pixels to paint a Lottie layer whose box is `size`, drawn under
/// `matrix`: the box through the matrix's largest stretch, rounded up, and cut
/// down to `MAX_LOTTIE_SIDE` a side. `None` for a box with no area.
fn lottie_pixels(size: (f64, f64), matrix: Affine) -> Option<(u32, u32)> {
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

/// Where a picture of `image` pixels sits in a box of `size`, as the matrix
/// from the picture's pixels to the box's space; `None` when it would have no
/// area. `Fill` stretches it to the box, `Contain` and `Cover` keep its aspect
/// ratio and centre it, the first inside the box, the second over it.
fn fit_image(fit: Fit, size: (f64, f64), image: (f64, f64)) -> Option<Affine> {
    let (sx, sy) = (size.0 / image.0, size.1 / image.1);
    if fit == Fit::Fill {
        return Some(Affine::scale_non_uniform(sx, sy));
    }
    let scale = if fit == Fit::Contain {
        sx.min(sy)
    } else {
        sx.max(sy)
    };
    if !(scale > 0.0 && scale.is_finite()) {
        return None;
    }
    Some(
        Affine::translate((
            (size.0 - image.0 * scale) / 2.0,
            (size.1 - image.1 * scale) / 2.0,
        )) * Affine::scale(scale),
    )
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

/// The texture Vello draws into: the padded canvas, `size` texels.
fn new_vello_target(device: &wgpu::Device, size: (u32, u32)) -> wgpu::TextureView {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("vello target"),
        size: wgpu::Extent3d {
            width: size.0,
            height: size.1,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    texture.create_view(&wgpu::TextureViewDescriptor::default())
}

/// The GPU device, made as `vello::util::RenderContext::device` makes it
/// (the default adapter, default limits, `CLEAR_TEXTURE` and
/// `PIPELINE_CACHE` when there), plus `TIMESTAMP_QUERY` when there, for
/// `set_pass_timing`.
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

fn new_vello(device: &wgpu::Device) -> Result<vello::Renderer> {
    vello::Renderer::new(
        device,
        RendererOptions {
            // 16x MSAA, not Vello's analytic `Area` mode: with `Area`, the
            // order of path segments inside a tile depends on GPU thread
            // timing, which changed a couple of edge pixels by a level or
            // two between runs of the same frame. MSAA coverage comes from
            // integer masks, so it does not.
            antialiasing_support: AaSupport {
                area: false,
                msaa8: false,
                msaa16: true,
            },
            ..Default::default()
        },
    )
    .map_err(|e| Error::Render(format!("Vello init failed: {e}")))
}

pub(crate) fn to_peniko(c: Color) -> peniko::Color {
    peniko::Color::from_rgba8(c.r, c.g, c.b, c.a)
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

/// The model and texture files the 3D layers of `scene` name.
pub(crate) fn scene3d_sources(scene: &Scene) -> (Vec<String>, Vec<String>) {
    let (mut models, mut textures) = (Vec::new(), Vec::new());
    walk_layers(&scene.layers, &mut |layer| {
        if let LayerKind::Scene3d(s) = &layer.kind {
            let (m, t) = s.sources();
            models.extend(m);
            textures.extend(t);
        }
    });
    (models, textures)
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
    /// Whether a canvas layer draws pictures (pixels of its own count, with no
    /// file behind them).
    canvas_pictures: bool,
    /// A name the renderer already held now stands for another file, so what
    /// the layer cache drew from the old one is out of date.
    rebound: bool,
}

impl NewAssets {
    /// Whether any of it is drawn with Vello's image renderer.
    fn has_pictures(&self) -> bool {
        self.canvas_pictures
            || !(self.images.is_empty()
                && self.lotties.is_empty()
                && self.videos.is_empty()
                && self.gifs.is_empty())
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

    let (model_srcs, texture_srcs) = scene3d_sources(scene);
    let mut models = Vec::new();
    let mut seen = HashSet::new();
    for src in model_srcs {
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
    for src in texture_srcs {
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

    let mut canvas_pictures = false;
    walk_layers(&scene.layers, &mut |layer| {
        if let LayerKind::Canvas(c) = &layer.kind {
            canvas_pictures |= canvas::draws_pictures(&c.commands.0);
        }
    });

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
        canvas_pictures,
        rebound,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::TextAlign;
    use vello::peniko::GradientKind;

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

    const RED: Color = Color {
        r: 255,
        g: 0,
        b: 0,
        a: 255,
    };

    fn gradient(
        geometry: ResolvedGradientGeometry,
        stops: &[(f64, Color)],
        extend: Extend,
    ) -> ResolvedGradient {
        ResolvedGradient {
            geometry,
            stops: stops.to_vec(),
            extend,
            units: Units::User,
            transform: Affine::IDENTITY,
        }
    }

    fn peniko_gradient(brush: peniko::Brush) -> peniko::Gradient {
        match brush {
            peniko::Brush::Gradient(g) => g,
            other => panic!("expected a gradient, got {other:?}"),
        }
    }

    fn offsets(g: &peniko::Gradient) -> Vec<f32> {
        g.stops.iter().map(|s| s.offset).collect()
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
    fn no_margin_is_the_identity() {
        let bits = |a: Affine| a.as_coeffs().map(f64::to_bits);
        assert_eq!(bits(margin_origin(0)), bits(Affine::IDENTITY));
        assert_eq!(
            margin_origin(7) * Point::new(1.0, 2.0),
            Point::new(8.0, 9.0)
        );
    }

    #[test]
    fn a_draw_of_part_of_the_canvas_puts_its_corner_at_the_origin() {
        let bits = |a: Affine| a.as_coeffs().map(f64::to_bits);
        let matrix = Affine::translate((130.25, 77.5)) * Affine::rotate(0.3) * Affine::scale(1.5);
        // From the canvas's own corner: the matrix itself, not a product.
        assert_eq!(
            bits(in_area(PixelRect::new(0, 0, 500, 300), matrix)),
            bits(matrix)
        );
        // From a corner on the tile grid: the same matrix moved back by the
        // corner, a whole number of pixels, so the linear part keeps its bits.
        let area = bounds::vello_area(PixelRect::new(133, 85, 200, 150));
        assert_eq!((area.x0, area.y0), (128, 80));
        let moved = in_area(area, matrix);
        assert_eq!(bits(moved)[..4], bits(matrix)[..4]);
        for p in [Point::new(0.0, 0.0), Point::new(40.5, 12.25)] {
            let (at, in_draw) = (matrix * p, moved * p);
            assert!((in_draw.x - (at.x - 128.0)).abs() < 1e-9, "{p:?}");
            assert!((in_draw.y - (at.y - 80.0)).abs() < 1e-9, "{p:?}");
        }
        // A corner on one axis only moves along the other.
        let moved = in_area(PixelRect::new(0, 48, 10, 60), matrix);
        let (at, in_draw) = (matrix * Point::new(3.0, 4.0), moved * Point::new(3.0, 4.0));
        assert_eq!(in_draw.x, at.x);
        assert!((in_draw.y - (at.y - 48.0)).abs() < 1e-9);
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
    fn padded_gradients_get_end_stops() {
        let line = ResolvedGradientGeometry::Linear {
            x0: 0.0,
            y0: 0.0,
            x1: 100.0,
            y1: 0.0,
        };
        let (brush, turn) = gradient_brush(&gradient(
            line,
            &[(0.2, RED), (0.8, Color::BLACK)],
            Extend::Pad,
        ));
        let g = peniko_gradient(brush);
        assert_eq!(offsets(&g), [0.0, 0.2, 0.8, 1.0]);
        assert_eq!(turn, Affine::IDENTITY);
        let GradientKind::Linear(pos) = g.kind else {
            panic!("not linear");
        };
        assert_eq!(
            (pos.start, pos.end),
            (Point::new(0.0, 0.0), Point::new(100.0, 0.0))
        );
    }

    #[test]
    fn repeating_gradients_repeat_the_stop_span() {
        let line = ResolvedGradientGeometry::Linear {
            x0: 0.0,
            y0: 10.0,
            x1: 100.0,
            y1: 10.0,
        };
        let stops = [(0.25, RED), (0.75, Color::BLACK)];
        let (brush, _) = gradient_brush(&gradient(line, &stops, Extend::Repeat));
        let g = peniko_gradient(brush);
        // The period is half the line, starting a quarter of the way along.
        assert_eq!(offsets(&g), [0.0, 1.0]);
        assert_eq!(g.extend, peniko::Extend::Repeat);
        let GradientKind::Linear(pos) = g.kind else {
            panic!("not linear");
        };
        assert_eq!(
            (pos.start, pos.end),
            (Point::new(25.0, 10.0), Point::new(75.0, 10.0))
        );

        let circle = ResolvedGradientGeometry::Radial {
            cx: 5.0,
            cy: 6.0,
            r: 40.0,
        };
        let (brush, _) = gradient_brush(&gradient(circle, &stops, Extend::Reflect));
        let g = peniko_gradient(brush);
        assert_eq!(g.extend, peniko::Extend::Reflect);
        let GradientKind::Radial(pos) = g.kind else {
            panic!("not radial");
        };
        assert_eq!((pos.start_radius, pos.end_radius), (10.0, 30.0));
        assert_eq!(
            (pos.start_center, pos.end_center),
            (Point::new(5.0, 6.0), Point::new(5.0, 6.0))
        );
    }

    #[test]
    fn conic_gradients_start_at_twelve_oclock() {
        let conic = |angle| ResolvedGradientGeometry::Conic {
            cx: 10.0,
            cy: 20.0,
            angle,
        };
        let stops = [(0.0, RED), (1.0, Color::BLACK)];
        let direction = |angle: f64| {
            let (brush, turn) = gradient_brush(&gradient(conic(angle), &stops, Extend::Pad));
            let GradientKind::Sweep(pos) = peniko_gradient(brush).kind else {
                panic!("not a sweep");
            };
            assert_eq!(
                (pos.start_angle, pos.end_angle),
                (0.0, std::f32::consts::TAU)
            );
            // Where the sweep's start direction (+x from the centre) ends up.
            let p = turn * Point::new(11.0, 20.0);
            (p.x - 10.0, p.y - 20.0)
        };
        let (x, y) = direction(0.0);
        assert!(
            x.abs() < 1e-9 && (y + 1.0).abs() < 1e-9,
            "up, got ({x}, {y})"
        );
        let (x, y) = direction(90.0);
        assert!(
            (x - 1.0).abs() < 1e-9 && y.abs() < 1e-9,
            "right, got ({x}, {y})"
        );
    }

    #[test]
    fn gradients_without_extent_are_solid_colours() {
        let stops = [(0.0, RED), (1.0, Color::BLACK)];
        let is_black = |g: ResolvedGradient| matches!(gradient_brush(&g).0, peniko::Brush::Solid(c) if c == to_peniko(Color::BLACK));
        let zero_line = ResolvedGradientGeometry::Linear {
            x0: 3.0,
            y0: 3.0,
            x1: 3.0,
            y1: 3.0,
        };
        assert!(is_black(gradient(zero_line, &stops, Extend::Pad)));
        let no_radius = ResolvedGradientGeometry::Radial {
            cx: 0.0,
            cy: 0.0,
            r: 0.0,
        };
        assert!(is_black(gradient(no_radius, &stops, Extend::Pad)));
        // Repeating a span of zero width.
        let line = ResolvedGradientGeometry::Linear {
            x0: 0.0,
            y0: 0.0,
            x1: 9.0,
            y1: 0.0,
        };
        let same = [(0.5, RED), (0.5, Color::BLACK)];
        assert!(is_black(gradient(line, &same, Extend::Repeat)));
        // Padding it is fine: a hard edge at 0.5.
        let (brush, _) = gradient_brush(&gradient(line, &same, Extend::Pad));
        assert_eq!(offsets(&peniko_gradient(brush)), [0.0, 0.5, 0.5, 1.0]);
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

    #[test]
    fn paint_brush_only_transforms_gradients() {
        let (brush, transform) = paint_brush(&ResolvedPaint::Solid(RED), None);
        assert!(matches!(brush, peniko::Brush::Solid(_)) && transform.is_none());
        let g = gradient(
            ResolvedGradientGeometry::Conic {
                cx: 10.0,
                cy: 20.0,
                angle: 90.0,
            },
            &[(0.0, RED), (1.0, Color::BLACK)],
            Extend::Pad,
        );
        let (brush, transform) = paint_brush(&ResolvedPaint::Gradient(g), None);
        assert!(matches!(brush, peniko::Brush::Gradient(_)));
        // The conic turn about its centre leaves the centre where it is.
        let moved = transform.unwrap() * Point::new(10.0, 20.0);
        assert!(moved.distance(Point::new(10.0, 20.0)) < 1e-9);
    }

    fn in_box_units(mut g: ResolvedGradient) -> ResolvedGradient {
        g.units = Units::Box;
        g
    }

    #[test]
    fn a_box_unit_gradient_is_stretched_to_the_layers_box() {
        let line = ResolvedGradientGeometry::Linear {
            x0: 0.0,
            y0: 0.0,
            x1: 1.0,
            y1: 1.0,
        };
        let stops = [(0.0, RED), (1.0, Color::BLACK)];
        let g = in_box_units(gradient(line, &stops, Extend::Pad));
        let b = Rect::new(10.0, 20.0, 50.0, 40.0);
        let (_, transform) = gradient_brush_in(&g, Some(b));
        // The unit square's corners land on the box's.
        let corner = |x: f64, y: f64| transform * Point::new(x, y);
        assert!(corner(0.0, 0.0).distance(Point::new(10.0, 20.0)) < 1e-9);
        assert!(corner(1.0, 1.0).distance(Point::new(50.0, 40.0)) < 1e-9);
        assert!(corner(1.0, 0.0).distance(Point::new(50.0, 20.0)) < 1e-9);
        // The same gradient in pixels is left alone, box or not.
        let plain = gradient(line, &stops, Extend::Pad);
        assert_eq!(gradient_brush_in(&plain, Some(b)).1, Affine::IDENTITY);
        // A conic gradient turns about its centre first, and the box then
        // stretches the turn: the centre (0.5, 0.5) lands on the box's.
        let conic = in_box_units(gradient(
            ResolvedGradientGeometry::Conic {
                cx: 0.5,
                cy: 0.5,
                angle: 90.0,
            },
            &stops,
            Extend::Pad,
        ));
        let (_, transform) = gradient_brush_in(&conic, Some(b));
        assert!((transform * Point::new(0.5, 0.5)).distance(b.center()) < 1e-9);
        // Through paint_brush, which text and shapes use.
        let (_, via_paint) = paint_brush(&ResolvedPaint::Gradient(g), Some(b));
        assert_eq!(
            via_paint.map(|t| t * Point::new(1.0, 1.0)),
            Some(Point::new(50.0, 40.0))
        );
    }

    #[test]
    fn a_box_unit_gradient_on_an_empty_box_is_the_last_stop() {
        let line = ResolvedGradientGeometry::Linear {
            x0: 0.0,
            y0: 0.0,
            x1: 1.0,
            y1: 0.0,
        };
        let g = in_box_units(gradient(
            line,
            &[(0.0, RED), (1.0, Color::BLACK)],
            Extend::Pad,
        ));
        for b in [
            Rect::new(0.0, 0.0, 0.0, 10.0),
            Rect::new(0.0, 0.0, 10.0, 0.0),
        ] {
            let (brush, _) = gradient_brush_in(&g, Some(b));
            assert!(
                matches!(brush, peniko::Brush::Solid(c) if c == to_peniko(Color::BLACK)),
                "{b:?}"
            );
        }
    }

    #[test]
    fn images_fit_their_box_by_fill_contain_or_cover() {
        let at = |m: Affine, x: f64, y: f64| m * Point::new(x, y);
        // A 720 x 540 picture in a 200 x 200 box.
        let (size, image) = ((200.0, 200.0), (720.0, 540.0));
        let fill = fit_image(Fit::Fill, size, image).unwrap();
        assert_eq!(
            fill,
            Affine::scale_non_uniform(200.0 / 720.0, 200.0 / 540.0)
        );
        // Contain: the width fills the box, the picture is 150 high and
        // centred.
        let contain = fit_image(Fit::Contain, size, image).unwrap();
        assert!(at(contain, 0.0, 0.0).distance(Point::new(0.0, 25.0)) < 1e-9);
        assert!(at(contain, 720.0, 540.0).distance(Point::new(200.0, 175.0)) < 1e-9);
        // Cover: the height fills the box, the picture is 266.67 wide and
        // overhangs by a sixth on each side.
        let cover = fit_image(Fit::Cover, size, image).unwrap();
        let overhang = (200.0 * 720.0 / 540.0 - 200.0) / 2.0;
        assert!(at(cover, 0.0, 0.0).distance(Point::new(-overhang, 0.0)) < 1e-9);
        assert!(at(cover, 720.0, 540.0).distance(Point::new(200.0 + overhang, 200.0)) < 1e-9);
        // A box of the picture's own shape needs no fitting.
        let same = fit_image(Fit::Cover, (360.0, 270.0), image).unwrap();
        assert!(at(same, 720.0, 540.0).distance(Point::new(360.0, 270.0)) < 1e-9);
        // An empty box has nothing to fit (fill keeps its old, empty, result; a
        // cover with one side left is cut to nothing by the clip).
        assert!(fit_image(Fit::Contain, (0.0, 50.0), image).is_none());
        assert!(fit_image(Fit::Cover, (0.0, 0.0), image).is_none());
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
        assert!(fresh.has_pictures());
        hold(&mut loaded, &fresh);
        // The next frame's scene names them again: nothing is read.
        let fresh = read_assets(&scene, &loaded, true).unwrap();
        assert!(fresh.videos.is_empty() && fresh.gifs.is_empty() && !fresh.rebound);
        assert!(!fresh.has_pictures());
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

    /// Whether `pages` holds each of the `n` leaves once and no page has two
    /// that overlap.
    fn is_a_packing(pages: &[Vec<usize>], regions: &[PixelRect]) -> bool {
        let mut seen = vec![0; regions.len()];
        for page in pages {
            for (k, &i) in page.iter().enumerate() {
                seen[i] += 1;
                for &j in &page[k + 1..] {
                    if !regions[i].intersect(regions[j]).is_empty() {
                        return false;
                    }
                }
            }
        }
        seen.iter().all(|&n| n == 1)
    }

    #[test]
    fn leaves_that_overlap_go_on_different_pages() {
        // Five boxes in a stack, and five more at its sides, each on only one
        // of the stack's boxes.
        let mut regions: Vec<PixelRect> = (0..5)
            .map(|k| PixelRect::new(10 + k, 10 + k, 60, 60))
            .collect();
        regions.extend((0..5).map(|k| PixelRect::new(50 + 10 * k, 5, 54 + 10 * k, 12)));
        let pages = pack_pages(&regions);
        assert!(is_a_packing(&pages, &regions));
        assert_eq!(pages.len(), 5, "five deep at most: {pages:?}");
        // Each page lists its leaves in order.
        assert!(pages.iter().all(|p| p.windows(2).all(|w| w[0] < w[1])));
    }

    #[test]
    fn leaves_that_overlap_nothing_share_a_page_and_nothing_gives_no_pages() {
        let spread: Vec<PixelRect> = (0..20)
            .map(|k| PixelRect::new(10 * k, 0, 10 * k + 9, 9))
            .collect();
        assert_eq!(pack_pages(&spread), vec![(0..20).collect::<Vec<_>>()]);
        assert!(pack_pages(&[]).is_empty());
    }

    #[test]
    fn a_chain_of_overlaps_needs_two_pages() {
        // 0-1, 1-2, 2-3 and 3-4 overlap and nothing else does: {0, 2, 4} and
        // {1, 3}.
        let chain: Vec<PixelRect> = (0..5)
            .map(|k| PixelRect::new(20 * k, 0, 20 * k + 30, 10))
            .collect();
        let pages = pack_pages(&chain);
        assert!(is_a_packing(&pages, &chain));
        assert_eq!(pages.len(), 2, "{pages:?}");
    }

    #[test]
    fn many_leaves_are_still_packed() {
        // More than DSATUR is used for.
        let regions: Vec<PixelRect> = (0..700)
            .map(|k| PixelRect::new(k % 50, 0, k % 50 + 8, 8))
            .collect();
        let pages = pack_pages(&regions);
        assert!(is_a_packing(&pages, &regions));
    }
}
