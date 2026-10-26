//! Replays a `ResolvedScene` (kinetograph-core's frame IR: layers with matrices, opacity, blend modes, effects, clips,
//! masks, mattes, motion-blur sub-frames) with Skia calls. A layer Skia cannot draw (`gaps`) is drawn by the wgpu path
//! (`Renderer::skia_fallback`) into a texture that Skia then draws as an image; those are counted in
//! `Stats::fallbacks`. What is neither (`Stats::unsupported`) is reported, never skipped silently.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::rc::Rc;

use skia_safe::gpu::graphite;

use crate::compositor::Tex;
use crate::render::Renderer;

use crate::resolve::{
    ResolvedClip, ResolvedEffect, ResolvedGeometry, ResolvedGradient, ResolvedGradientGeometry, ResolvedKind,
    ResolvedLayer, ResolvedPaint, ResolvedScene, ShapeStyle, TextStroke,
};
use crate::scene::{
    BlendMode, Extend, FillRule, Fit, MaskMode, MatteMode, Scene, StrokeCap, StrokeJoin, TextPaintOrder, Units,
};
use crate::text::TextEngine;

use kurbo::{Affine, BezPath, PathEl};
use skia_safe::{
    BlendMode as SkBlend, Canvas, ClipOp, Color, Color4f, ColorFilter, ColorSpace, Data, Font, FontMgr, Image, ImageFilter,
    Matrix, Paint, PaintCap, PaintJoin, PaintStyle, Path, PathBuilder, PathFillType, Point, RRect, Rect, SamplingOptions,
    Shader, TextBlobBuilder, TileMode, Typeface, canvas::SaveLayerRec, color_filters, gradient_shader, image_filters,
    images, path_effect::PathEffect,
};

mod canvas2d;

#[derive(Default, Clone)]
pub struct Stats {
    pub layers: u32,
    pub save_layers: u32,
    pub draws: u32,
    /// Pixels of offscreen layers made this frame (device bounds clipped to the clip), and how many had no bounds.
    pub layer_px: u64,
    pub unbounded_layers: u32,
    pub unsupported: BTreeMap<String, u32>,
    pub approximated: BTreeMap<String, u32>,
    /// Layers drawn by the wgpu path, by why Skia could not draw them.
    pub fallbacks: BTreeMap<String, u32>,
}

impl Stats {
    fn no(&mut self, what: &str) {
        *self.unsupported.entry(what.to_string()).or_default() += 1;
    }
    fn approx(&mut self, what: &str) {
        *self.approximated.entry(what.to_string()).or_default() += 1;
    }
}

/// Graphite needs raster images turned into its own textures by the recorder.
pub type Upload = std::rc::Rc<dyn Fn(&Image) -> Option<Image>>;

pub struct Translator {
    pub upload: Option<Upload>,
    pub text: TextEngine,
    pub stats: Stats,
    base_dir: PathBuf,
    fonts_key: std::collections::BTreeMap<String, String>,
    images: HashMap<String, Option<Image>>,
    typefaces: HashMap<(u64, u32, Vec<i16>), Option<Typeface>>,
    glyph_paths: HashMap<(skia_safe::typeface::TypefaceId, u32, u32, bool, u16), Option<Path>>,
    text_atlas: bool,
    svg_paths: HashMap<String, Path>,
    srgb: bool,
    fx: HashMap<String, Option<skia_safe::RuntimeEffect>>,
    videos: HashMap<String, crate::video::VideoDecoder>,
    video_last: HashMap<String, (i64, Image)>,
    /// Datamosh: a decoder with motion vectors per file, and the mosh so far per layer (`datamosh.rs`).
    mosh_videos: HashMap<String, crate::video::VideoDecoder>,
    mosh_states: HashMap<String, Option<crate::datamosh::MoshState>>,
    gif_pics: HashMap<(String, usize), Option<Image>>,
    #[allow(clippy::type_complexity)]
    lottie_last: HashMap<(String, u32, u32), ((u64, bool), Image)>,
    /// SVG pictures, parsed once per file (`None`: it could not be read), and painted once per size they are drawn at.
    svg_files: HashMap<String, Option<Rc<crate::svg_picture::Picture>>>,
    svg_pics: HashMap<(String, u32, u32), Option<Image>>,
    /// Effect classes to leave out (SKIA_SKIP=blur,shadow,inset,color,filtergraph,mask,matte,backdrop), to see where the GPU time goes.
    skip: Vec<String>,
    /// The renderer that draws the fallback layers: set by `draw_scene` for the length of the call only.
    host: *mut Renderer,
    /// The recorder the frame is drawn with, to wrap the fallback textures as images.
    rec: Option<Rc<RefCell<graphite::Recorder>>>,
    /// The fallback textures of the frame: Skia reads them when the recording runs, so they go back to the compositor's
    /// pool after that (`take_held`).
    held: Vec<Tex>,
    /// The pictures of a canvas pass's children while its commands are drawn (`raster_canvas_pass`).
    layer_pics: Option<LayerPictures>,
    /// A fallback failed (`Renderer::skia_fallback`'s error), reported by `draw_scene`'s caller.
    pub error: Option<crate::error::Error>,
}

/// The children of a canvas pass as pictures: each a compositor texture wrapped as an image, with the matrix that takes
/// a point of the picture (the pass's own space, `size` across) to a texel of that image.
struct LayerPictures {
    size: (f64, f64),
    /// The canvas pixels back to the pass's space.
    from_canvas: Affine,
    /// By child id: the image, the part of it that holds pixels, and the canvas pixel its texel (0, 0) is.
    images: HashMap<String, (Image, Rect, [i32; 2])>,
}

fn mat(a: Affine) -> Matrix {
    let [a, b, c, d, e, f] = a.as_coeffs();
    Matrix::new_all(a as f32, c as f32, e as f32, b as f32, d as f32, f as f32, 0.0, 0.0, 1.0)
}

fn color4(c: crate::color::Color) -> Color4f {
    Color4f::new(
        f32::from(c.r) / 255.0,
        f32::from(c.g) / 255.0,
        f32::from(c.b) / 255.0,
        f32::from(c.a) / 255.0,
    )
}

fn sk_blend(m: BlendMode) -> SkBlend {
    match m {
        BlendMode::Normal => SkBlend::SrcOver,
        BlendMode::Multiply => SkBlend::Multiply,
        BlendMode::Screen => SkBlend::Screen,
        BlendMode::Overlay => SkBlend::Overlay,
        BlendMode::Darken => SkBlend::Darken,
        BlendMode::Lighten => SkBlend::Lighten,
        BlendMode::ColorDodge => SkBlend::ColorDodge,
        BlendMode::ColorBurn => SkBlend::ColorBurn,
        BlendMode::HardLight => SkBlend::HardLight,
        BlendMode::SoftLight => SkBlend::SoftLight,
        BlendMode::Difference => SkBlend::Difference,
        BlendMode::Exclusion => SkBlend::Exclusion,
        BlendMode::Hue => SkBlend::Hue,
        BlendMode::Saturation => SkBlend::Saturation,
        BlendMode::Color => SkBlend::Color,
        BlendMode::Luminosity => SkBlend::Luminosity,
    }
}

fn bez_to_path(b: &BezPath, even_odd: bool) -> Path {
    let mut pb = PathBuilder::new();
    for el in b.elements() {
        match *el {
            PathEl::MoveTo(p) => {
                pb.move_to((p.x as f32, p.y as f32));
            }
            PathEl::LineTo(p) => {
                pb.line_to((p.x as f32, p.y as f32));
            }
            PathEl::QuadTo(a, p) => {
                pb.quad_to((a.x as f32, a.y as f32), (p.x as f32, p.y as f32));
            }
            PathEl::CurveTo(a, b2, p) => {
                pb.cubic_to((a.x as f32, a.y as f32), (b2.x as f32, b2.y as f32), (p.x as f32, p.y as f32));
            }
            PathEl::ClosePath => {
                pb.close();
            }
        }
    }
    pb.set_fill_type(if even_odd { PathFillType::EvenOdd } else { PathFillType::Winding });
    pb.detach()
}

/// A leaf layer's paint and how the layer composites into its parent.
#[derive(Clone, Copy)]
struct Comp {
    alpha: f32,
    blend: SkBlend,
}

impl Translator {
    pub fn new(scene: &Scene) -> Translator {
        Translator {
            upload: None,
            text: TextEngine::new(&scene.fonts, &scene.base_dir).expect("text engine"),
            stats: Stats::default(),
            base_dir: scene.base_dir.clone(),
            fonts_key: scene.fonts.clone(),
            images: HashMap::new(),
            typefaces: HashMap::new(),
            glyph_paths: HashMap::new(),
            text_atlas: std::env::var("KINETOGRAPH_SKIA_TEXT").is_ok_and(|v| v == "atlas"),
            svg_paths: HashMap::new(),
            srgb: false,
            fx: HashMap::new(),
            videos: HashMap::new(),
            video_last: HashMap::new(),
            mosh_videos: HashMap::new(),
            mosh_states: HashMap::new(),
            gif_pics: HashMap::new(),
            lottie_last: HashMap::new(),
            svg_files: HashMap::new(),
            svg_pics: HashMap::new(),
            skip: std::env::var("SKIA_SKIP").unwrap_or_default().split(',').map(str::to_string).collect(),
            host: std::ptr::null_mut(),
            rec: None,
            held: Vec::new(),
            layer_pics: None,
            error: None,
        }
    }

    /// Whether the surface holds linear light (the scene blends in linear light) and not sRGB-encoded values.
    fn linear(&self) -> bool {
        !self.srgb
    }

    /// `f` with its maths done on sRGB-encoded values, as CSS colour filters are, even if the surface holds linear light.
    fn in_srgb(&self, f: ColorFilter) -> ColorFilter {
        if self.linear() { f.with_working_color_space(ColorSpace::new_srgb()).unwrap_or(f) } else { f }
    }

    pub fn set_recorder(&mut self, rec: Rc<RefCell<graphite::Recorder>>) {
        self.rec = Some(rec);
    }

    /// `tex`, a texture of the wgpu path's, as an image: wrapped for Graphite if there is a recorder, else (Skia is
    /// drawing on the CPU) read back.
    fn wrap(&self, host: &Renderer, tex: &Tex) -> Option<Image> {
        match &self.rec {
            Some(rec) => host.skia_wrap(Some(&mut rec.borrow_mut()), tex),
            None => host.skia_wrap(None, tex),
        }
    }

    /// The fallback textures of the frame, to be released once Skia has run its recording.
    pub fn take_held(&mut self) -> Vec<Tex> {
        std::mem::take(&mut self.held)
    }

    /// Forgets everything read from a file, so that it is read again.
    pub fn forget_files(&mut self) {
        self.images.clear();
        self.videos.clear();
        self.video_last.clear();
        self.mosh_videos.clear();
        self.mosh_states.clear();
        self.gif_pics.clear();
        self.lottie_last.clear();
        self.svg_files.clear();
        self.svg_pics.clear();
        self.fonts_key.clear();
    }

    pub fn begin_frame(&mut self, scene: &Scene) {
        self.stats = Stats::default();
        self.base_dir = scene.base_dir.clone();
        if self.fonts_key != scene.fonts {
            self.text = TextEngine::new(&scene.fonts, &scene.base_dir).expect("text engine");
            self.fonts_key = scene.fonts.clone();
        }
        self.srgb = matches!(scene.blend_space, crate::scene::BlendSpace::Srgb);
    }

    /// Draws the scene on `canvas`, whose origin is the margin's corner (`margin` pixels in). `host` draws the fallback
    /// layers and is not otherwise used while this runs; it must not be the renderer `self` belongs to.
    pub fn draw_scene(&mut self, canvas: &Canvas, scene: &ResolvedScene, bg: crate::color::Color, host: &mut Renderer, margin: u32) {
        canvas.clear(color4(bg));
        canvas.save();
        canvas.translate((margin as f32, margin as f32));
        self.host = host;
        self.draw_layers(canvas, &scene.layers, 1.0);
        self.host = std::ptr::null_mut();
        canvas.restore();
    }

    fn draw_layers(&mut self, canvas: &Canvas, layers: &[ResolvedLayer], scale: f64) {
        for layer in layers {
            if is_hidden(layer) || is_matte_source(layers, layer) {
                continue;
            }
            self.draw_layer(canvas, layer, layers, scale);
        }
    }

    fn draw_layer(&mut self, canvas: &Canvas, layer: &ResolvedLayer, siblings: &[ResolvedLayer], scale: f64) {
        let comp = if layer.motion.is_empty() {
            Comp { alpha: layer.opacity, blend: sk_blend(layer.blend_mode) }
        } else {
            Comp { alpha: 1.0, blend: sk_blend(layer.blend_mode) }
        };
        self.draw_layer_with(canvas, layer, siblings, comp, scale);
    }

    fn draw_layer_with(&mut self, canvas: &Canvas, layer: &ResolvedLayer, siblings: &[ResolvedLayer], comp: Comp, scale: f64) {
        self.stats.layers += 1;
        if let Some(why) = gaps(layer, siblings) {
            self.draw_fallback(canvas, layer, siblings, comp, why);
            return;
        }
        // A blurred layer's own 3D placement is not used: each sub-frame has its own (`Renderer::layer_final_texture`).
        if layer.motion.is_empty()
            && let Some(world) = crate::warp::layer_world(&layer.transform)
        {
            self.draw_warped(canvas, layer, siblings, comp, scale, world);
            return;
        }
        self.draw_flat(canvas, layer, siblings, comp, scale);
    }

    /// A layer turned in 3D: drawn flat into a layer of its own, which is then warped by the homography the wgpu path
    /// warps its texture with (`warp::plane_homography`), as an image filter on that layer.
    fn draw_warped(&mut self, canvas: &Canvas, layer: &ResolvedLayer, siblings: &[ResolvedLayer], comp: Comp, scale: f64, world: glam::DMat4) {
        use glam::{DMat3, DVec3};
        let m = canvas.local_to_device_as_3x3();
        let parent = Affine::new([
            m.scale_x() as f64,
            m.skew_y() as f64,
            m.skew_x() as f64,
            m.scale_y() as f64,
            m.translate_x() as f64,
            m.translate_y() as f64,
        ]);
        // SAFETY: `host` is the renderer `draw_scene` was given; this translator is not part of it.
        let projection = unsafe { &*self.host }.skia_projection();
        let Some(h) = crate::warp::plane_homography(projection, parent, world) else {
            return;
        };
        // Seen from behind.
        if layer.transform.backface_hidden && h.determinant() < 0.0 {
            return;
        }
        if crate::warp::is_identity(&h) {
            self.draw_flat(canvas, layer, siblings, comp, scale);
            return;
        }
        let [a, b, c, d, e, f] = parent.as_coeffs();
        let p = DMat3::from_cols(DVec3::new(a, b, 0.0), DVec3::new(c, d, 0.0), DVec3::new(e, f, 1.0));
        let bounds = self.layer_bounds(layer, scale).map(|r| mat(layer.transform.matrix()).map_rect(r).0);
        // Skia reads the warp with its last entry made 1: where the layer's local origin is behind the camera (w <= 0)
        // that flips the sign of w everywhere, and Skia drops the half that is in front. So the layer is warped in a
        // frame whose origin `o` is in front (the farthest in front of the layer's corners and of what is visible), the
        // canvas translated there; a layer whose origin is already in front is warped as it always was.
        let w_at = |m: &DMat3, x: f64, y: f64| m.x_axis.z * x + m.y_axis.z * y + m.z_axis.z;
        let l0 = p.inverse() * h * p;
        let mut origin = (0.0f64, 0.0f64);
        if w_at(&l0, 0.0, 0.0) <= 0.0 {
            let mut corners: Vec<(f64, f64)> = Vec::new();
            for r in [bounds, Some(canvas.local_clip_bounds().unwrap_or(Rect::new(0.0, 0.0, 0.0, 0.0)))].into_iter().flatten() {
                corners.extend([(r.left, r.top), (r.right, r.top), (r.right, r.bottom), (r.left, r.bottom)].map(|(x, y)| (f64::from(x), f64::from(y))));
            }
            let best = corners.into_iter().max_by(|a, b| w_at(&l0, a.0, a.1).total_cmp(&w_at(&l0, b.0, b.1)));
            match best {
                Some(o) if w_at(&l0, o.0, o.1) > 0.0 => origin = o,
                // Everything is behind the camera.
                _ => return,
            }
        }
        let moved = origin != (0.0, 0.0);
        let p = if moved { p * DMat3::from_translation(glam::DVec2::new(origin.0, origin.1)) } else { p };
        // The filter works in the local space of the layer, the device-space warp `h` in that: P^-1 H P.
        let l = p.inverse() * h * p;
        let l = l * (1.0 / l.z_axis.z);
        let local = Matrix::new_all(
            l.x_axis.x as f32, l.y_axis.x as f32, l.z_axis.x as f32,
            l.x_axis.y as f32, l.y_axis.y as f32, l.z_axis.y as f32,
            l.x_axis.z as f32, l.y_axis.z as f32, 1.0,
        );
        let filter = image_filters::matrix_transform(&local, SamplingOptions::new(skia_safe::FilterMode::Linear, skia_safe::MipmapMode::None), None);
        let (ox, oy) = (origin.0 as f32, origin.1 as f32);
        let bounds = bounds.map(|r| Rect::new(r.left - ox, r.top - oy, r.right - ox, r.bottom - oy));
        let mut paint = Paint::default();
        paint.set_alpha_f(comp.alpha);
        paint.set_blend_mode(comp.blend);
        paint.set_image_filter(filter);
        if moved {
            canvas.save();
            canvas.translate((ox, oy));
        }
        self.save_layer(canvas, bounds, &paint, None);
        if moved {
            canvas.translate((-ox, -oy));
        }
        self.draw_flat(canvas, layer, siblings, Comp { alpha: 1.0, blend: SkBlend::SrcOver }, scale);
        canvas.restore();
        if moved {
            canvas.restore();
        }
    }

    fn draw_flat(&mut self, canvas: &Canvas, layer: &ResolvedLayer, siblings: &[ResolvedLayer], comp: Comp, scale: f64) {
        let m = layer.transform.matrix();
        let outer = scale;
        let scale = scale * m.determinant().abs().sqrt();
        canvas.save();
        canvas.concat(&mat(m));

        // Motion blur: the sub-frames are summed with equal weights into one buffer.
        if !layer.motion.is_empty() {
            // The sub-frames are where the layer was during the shutter, not where it is: the union of theirs, in this layer's space.
            let inv = mat(m.inverse());
            let mut bounds: Option<Rect> = None;
            let mut all = true;
            for sub in layer.motion.iter().filter(|sub| sub.opacity > 0.0) {
                match self.layer_bounds(sub, outer * sub.transform.matrix().determinant().abs().sqrt()) {
                    Some(b) => {
                        let r = Matrix::concat(&inv, &mat(sub.transform.matrix())).map_rect(b).0;
                        bounds = Some(match bounds {
                            None => r,
                            Some(a) => Rect::new(a.left.min(r.left), a.top.min(r.top), a.right.max(r.right), a.bottom.max(r.bottom)),
                        });
                    }
                    None => all = false,
                }
            }
            let bounds = if all { bounds } else { None };
            let mut p = Paint::default();
            p.set_blend_mode(comp.blend);
            self.save_layer_with(canvas, bounds, &p, None, true);
            let n = layer.motion.len() as f32;
            for sub in &layer.motion {
                if sub.opacity <= 0.0 {
                    continue;
                }
                // The sub-frame carries its own matrix (it is a full copy of the layer): undo ours.
                canvas.save();
                canvas.concat(&mat(m.inverse()));
                self.draw_layer_with(canvas, sub, siblings, Comp { alpha: sub.opacity / n, blend: SkBlend::Plus }, outer);
                canvas.restore();
            }
            canvas.restore();
            canvas.restore();
            return;
        }

        let simple_leaf = matches!(layer.kind, ResolvedKind::Shape { .. } | ResolvedKind::Text { .. } | ResolvedKind::Image { .. } | ResolvedKind::Video { .. });
        let no_extras = layer.effects.is_empty() && layer.mask.is_none() && layer.matte.is_none();
        let plain = no_extras && (layer.clip.is_none() || !matches!(layer.kind, ResolvedKind::Group { .. }) || true);
        let single_paint = match &layer.kind {
            ResolvedKind::Shape { fill, stroke, .. } => !(fill.is_some() && stroke.is_some()),
            ResolvedKind::Text { .. } | ResolvedKind::Image { .. } | ResolvedKind::Video { .. } => true,
            _ => false,
        };

        if no_extras && simple_leaf && single_paint {
            // Opacity and blend go straight into the draw.
            self.apply_clip(canvas, layer);
            self.draw_content(canvas, layer, comp, scale);
        } else if no_extras {
            // A group (or two-paint leaf) with only opacity/blend/clip.
            let isolates = matches!(&layer.kind, ResolvedKind::Group { children, pass_through: false, preserve3d: false, .. } if children.iter().any(blends_outside));
            let needs_layer = comp.alpha < 1.0 || comp.blend != SkBlend::SrcOver || isolates;
            self.apply_clip(canvas, layer);
            if needs_layer {
                let bounds = self.layer_bounds(layer, scale);
                let mut p = Paint::default();
                p.set_alpha_f(comp.alpha);
                p.set_blend_mode(comp.blend);
                self.save_layer(canvas, bounds, &p, None);
                self.draw_content(canvas, layer, Comp { alpha: 1.0, blend: SkBlend::SrcOver }, scale);
                canvas.restore();
            } else {
                self.draw_content(canvas, layer, comp, scale);
            }
        } else {
            let _ = plain;
            self.draw_with_extras(canvas, layer, siblings, comp, scale);
        }
        canvas.restore();
    }

    /// Effects, mask and matte: the layer is drawn into a buffer, filtered, cut, and composited.
    fn draw_with_extras(&mut self, canvas: &Canvas, layer: &ResolvedLayer, siblings: &[ResolvedLayer], comp: Comp, scale: f64) {
        // Graphite filters the whole device behind a layer with a backdrop filter, whatever the layer's bounds: a clip keeps it
        // to the bounds.
        let backdrop_box = layer.effects.iter().any(|e| matches!(e, ResolvedEffect::BackdropBlur { .. })).then(|| self.layer_bounds(layer, scale)).flatten();
        if let Some(b) = backdrop_box {
            canvas.save();
            canvas.clip_rect(b, ClipOp::Intersect, false);
            self.draw_extras(canvas, layer, siblings, comp, scale);
            canvas.restore();
        } else {
            self.draw_extras(canvas, layer, siblings, comp, scale);
        }
    }

    /// The layer's content, into a layer that starts as the blurred backdrop if `backdrop`: the backdrop then shows only
    /// where the content draws (a shape frosts its whole geometry, however see-through its fill is), and the content goes
    /// over it.
    fn draw_body(&mut self, canvas: &Canvas, layer: &ResolvedLayer, bounds: Option<Rect>, backdrop: bool, scale: f64) {
        let plain = Comp { alpha: 1.0, blend: SkBlend::SrcOver };
        if backdrop {
            let mut keep = Paint::default();
            keep.set_blend_mode(SkBlend::DstIn);
            self.save_layer(canvas, bounds, &keep, None);
            match &layer.kind {
                ResolvedKind::Shape { geometry, style, .. } => {
                    self.draw_shape(canvas, layer, geometry, Some(&ResolvedPaint::Solid(crate::color::Color::BLACK)), None, style, plain)
                }
                _ => self.draw_content(canvas, layer, plain, scale),
            }
            canvas.restore();
        }
        self.draw_content(canvas, layer, plain, scale);
    }

    fn draw_extras(&mut self, canvas: &Canvas, layer: &ResolvedLayer, siblings: &[ResolvedLayer], comp: Comp, scale: f64) {
        let bounds = self.layer_bounds(layer, scale);
        let (filter, backdrop) = self.effect_filter(canvas, layer, scale);
        let deferred = layer.clip.is_some() || layer.mask.is_some() || layer.matte.is_some();
        // Without a clip/mask/matte the filter rides on the one layer that also carries opacity and blend.
        let mut outer = Paint::default();
        outer.set_alpha_f(comp.alpha);
        outer.set_blend_mode(comp.blend);
        if !deferred {
            outer.set_image_filter(filter.clone());
            self.save_layer(canvas, bounds, &outer, backdrop.as_ref());
            self.draw_body(canvas, layer, bounds, backdrop.is_some(), scale);
            canvas.restore();
            return;
        }
        self.save_layer(canvas, bounds, &outer, backdrop.as_ref());
        if let Some(f) = filter {
            let mut inner = Paint::default();
            inner.set_image_filter(Some(f));
            self.save_layer(canvas, bounds, &inner, None);
            self.draw_content(canvas, layer, Comp { alpha: 1.0, blend: SkBlend::SrcOver }, scale);
            canvas.restore();
        } else {
            self.draw_body(canvas, layer, bounds, backdrop.is_some(), scale);
        }
        if let Some(clip) = &layer.clip
            && let Some(path) = self.clip_path(clip, layer)
        {
            let mut p = Paint::default();
            p.set_anti_alias(true);
            // DstIn only touches what the shape covers: the outside is cleared with the inverse fill.
            p.set_blend_mode(SkBlend::Clear);
            canvas.draw_path(&path.with_toggle_inverse_fill_type(), &p);
            self.stats.draws += 1;
        }
        if let Some(mask) = &layer.mask {
            let mut p = Paint::default();
            p.set_blend_mode(SkBlend::DstIn);
            let layer_box = self.layer_box(layer);
            p.set_shader(gradient_shader_for(&mask.gradient, layer_box, self.linear(), true));
            if mask.mode == MaskMode::Luminance {
                p.set_color_filter(skia_safe::luma_color_filter::new());
                self.stats.approx("luminance mask via sRGB luma");
            }
            canvas.draw_paint(&p);
            self.stats.draws += 1;
        }
        if let Some(matte) = &layer.matte
            && let Some(src) = siblings.iter().find(|l| l.id == matte.layer)
        {
            let mut p = Paint::default();
            p.set_blend_mode(match matte.mode {
                MatteMode::Alpha | MatteMode::Luminance | MatteMode::SrgbLuminance => SkBlend::DstIn,
                MatteMode::AlphaInverted | MatteMode::LuminanceInverted => SkBlend::DstOut,
            });
            match matte.mode {
                MatteMode::Alpha | MatteMode::AlphaInverted => {}
                MatteMode::Luminance | MatteMode::SrgbLuminance => {
                    let luma = skia_safe::luma_color_filter::new();
                    p.set_color_filter(if matte.mode == MatteMode::SrgbLuminance { self.in_srgb(luma) } else { luma });
                    self.stats.approx("luminance matte via sRGB luma");
                }
                MatteMode::LuminanceInverted => {
                    p.set_color_filter(skia_safe::luma_color_filter::new());
                    self.stats.no("luminanceInverted matte (drawn as alphaInverted of luma)");
                }
            }
            self.save_layer(canvas, bounds, &p, None);
            // The source sits in the parent's space, not in the matted layer's own.
            canvas.save();
            canvas.concat(&mat(layer.transform.matrix().inverse()));
            self.draw_layer(canvas, src, siblings, scale);
            canvas.restore();
            canvas.restore();
        }
        canvas.restore();
    }

    fn save_layer(&mut self, canvas: &Canvas, bounds: Option<Rect>, paint: &Paint, backdrop: Option<&ImageFilter>) {
        self.save_layer_with(canvas, bounds, paint, backdrop, false);
    }

    /// `f16`: the layer keeps half-float colour (a sum of many faint terms loses its low bits in 8).
    fn save_layer_with(&mut self, canvas: &Canvas, bounds: Option<Rect>, paint: &Paint, backdrop: Option<&ImageFilter>, f16: bool) {
        self.stats.save_layers += 1;
        let clip = canvas.device_clip_bounds().unwrap_or(skia_safe::IRect::new(0, 0, 0, 0));
        let area = match bounds {
            Some(b) => {
                let d = canvas.local_to_device_as_3x3().map_rect(b).0;
                let (l, t, r, btm) = (d.left.max(clip.left as f32), d.top.max(clip.top as f32), d.right.min(clip.right as f32), d.bottom.min(clip.bottom as f32));
                (r - l).max(0.0) as u64 * (btm - t).max(0.0) as u64
            }
            None => {
                self.stats.unbounded_layers += 1;
                (clip.width().max(0) as u64) * (clip.height().max(0) as u64)
            }
        };
        self.stats.layer_px += area;
        let mut rec = SaveLayerRec::default().paint(paint);
        if f16 {
            rec = rec.flags(skia_safe::canvas::SaveLayerFlags::F16_COLOR_TYPE);
        }
        if let Some(b) = bounds.as_ref() {
            rec = rec.bounds(b);
        }
        if let Some(bd) = backdrop {
            rec = rec.backdrop(bd);
        }
        canvas.save_layer(&rec);
    }

    fn apply_clip(&mut self, canvas: &Canvas, layer: &ResolvedLayer) {
        if let Some(clip) = &layer.clip {
            match self.clip_path(clip, layer) {
                Some(path) => {
                    canvas.clip_path(&path, ClipOp::Intersect, true);
                }
                None => {
                    canvas.clip_rect(Rect::new(0.0, 0.0, 0.0, 0.0), ClipOp::Intersect, false);
                }
            }
        }
    }

    fn clip_path(&mut self, clip: &ResolvedClip, layer: &ResolvedLayer) -> Option<Path> {
        match clip {
            ResolvedClip::Polygon { points } => {
                let mut pb = PathBuilder::new();
                for (i, &(x, y)) in points.iter().enumerate() {
                    if i == 0 {
                        pb.move_to((x as f32, y as f32));
                    } else {
                        pb.line_to((x as f32, y as f32));
                    }
                }
                pb.close();
                Some(pb.detach())
            }
            ResolvedClip::Inset { top, right, bottom, left, radius } => {
                let b = self.layer_box(layer)?;
                let r = Rect::new(
                    b.left + *left as f32,
                    b.top + *top as f32,
                    b.right - *right as f32,
                    b.bottom - *bottom as f32,
                );
                if r.width() <= 0.0 || r.height() <= 0.0 {
                    return None;
                }
                let rad = (*radius as f32).min(r.width() / 2.0).min(r.height() / 2.0);
                let mut pb = PathBuilder::new();
                pb.add_rrect(RRect::new_rect_xy(r, rad, rad), None, None);
                Some(pb.detach())
            }
            ResolvedClip::Ellipse { cx, cy, rx, ry } => {
                if *rx <= 0.0 || *ry <= 0.0 {
                    return None;
                }
                let mut pb = PathBuilder::new();
                pb.add_oval(
                    Rect::new((*cx - *rx) as f32, (*cy - *ry) as f32, (*cx + *rx) as f32, (*cy + *ry) as f32),
                    None,
                    None,
                );
                Some(pb.detach())
            }
            ResolvedClip::Path { d } => self.svg_path(d, false),
        }
    }

    fn svg_path(&mut self, d: &str, even_odd: bool) -> Option<Path> {
        let key = format!("{}{d}", if even_odd { "e" } else { "n" });
        if let Some(p) = self.svg_paths.get(&key) {
            return Some(p.clone());
        }
        let bez = BezPath::from_svg(d).ok()?;
        let p = bez_to_path(&bez, even_odd);
        self.svg_paths.insert(key, p.clone());
        Some(p)
    }

    /// The layer's own box in layer space (what `inset` clips and box-unit gradients measure).
    fn layer_box(&mut self, layer: &ResolvedLayer) -> Option<Rect> {
        match &layer.kind {
            ResolvedKind::Shape { geometry, .. } => Some(match geometry {
                ResolvedGeometry::Rect { width, height }
                | ResolvedGeometry::RoundedRect { width, height, .. }
                | ResolvedGeometry::Ellipse { width, height } => Rect::new(0.0, 0.0, *width as f32, *height as f32),
                ResolvedGeometry::Path { d } => {
                    let p = self.svg_path(d, false)?;
                    *p.bounds()
                }
            }),
            ResolvedKind::Text { text, font, size, line_height, max_width, align, runs, box_size, .. } => {
                let laid = self.text.layout_layer(text, font, *size, *line_height, *max_width, *align, runs, *box_size);
                let (w, h) = laid.box_size(*max_width);
                Some(Rect::new(0.0, 0.0, w as f32, h as f32))
            }
            ResolvedKind::Image { width, height, .. }
            | ResolvedKind::Video { width, height, .. }
            | ResolvedKind::Gif { width, height, .. }
            | ResolvedKind::Lottie { width, height, .. }
            | ResolvedKind::Noise { width, height, .. } => Some(Rect::new(0.0, 0.0, *width as f32, *height as f32)),
            ResolvedKind::Canvas { width, height, .. } => Some(Rect::new(0.0, 0.0, *width as f32, *height as f32)),
            ResolvedKind::Group { size, .. } => size.map(|(w, h)| Rect::new(0.0, 0.0, w as f32, h as f32)),
            _ => None,
        }
    }

    /// Bounds of what the layer can touch, in its own space, grown by its effects; `None` is unbounded.
    fn layer_bounds(&mut self, layer: &ResolvedLayer, scale: f64) -> Option<Rect> {
        let mut r = self.content_bounds(layer, scale)?;
        let s = scale.max(1e-6) as f32;
        for e in &layer.effects {
            match e {
                ResolvedEffect::Blur { radius } => {
                    let g = 3.0 * radius / s + 2.0;
                    r = Rect::new(r.left - g, r.top - g, r.right + g, r.bottom + g);
                }
                ResolvedEffect::DropShadow(sh) => {
                    let g = (3.0 * sh.blur + sh.spread.max(0.0)) / s + 2.0;
                    let (dx, dy) = (sh.x / s, sh.y / s);
                    let moved = Rect::new(r.left + dx - g, r.top + dy - g, r.right + dx + g, r.bottom + dy + g);
                    r = Rect::new(r.left.min(moved.left), r.top.min(moved.top), r.right.max(moved.right), r.bottom.max(moved.bottom));
                }
                ResolvedEffect::Glow(g) => {
                    let gr = 3.0 * g.radius / s + 2.0;
                    r = Rect::new(r.left - gr, r.top - gr, r.right + gr, r.bottom + gr);
                }
                ResolvedEffect::FilterGraph(fg) => {
                    use crate::filter::FeOp;
                    // Displacement moves pixels by up to half its scale; blurs and offsets reach further.
                    let mut grow = 2.0f32;
                    for n in &fg.nodes {
                        match &n.op {
                            FeOp::DisplacementMap { scale, .. } => grow += scale.abs(),
                            FeOp::GaussianBlur { std } => grow += 3.0 * std[0].max(std[1]),
                            FeOp::Offset { dx, dy } => grow += dx.abs().max(dy.abs()),
                            FeOp::Morphology { radius, .. } => grow += radius[0].max(radius[1]),
                            _ => {}
                        }
                    }
                    let g = grow / s;
                    let content = r;
                    r = Rect::new(r.left - g, r.top - g, r.right + g, r.bottom + g);
                    // A tile repeats over the whole filter region, not just where the layer draws.
                    if fg.nodes.iter().any(|n| matches!(n.op, FeOp::Tile)) {
                        let content = kurbo::Rect::new(content.left as f64, content.top as f64, content.right as f64, content.bottom as f64);
                        let reg = fg.plan(Some(content))?.region;
                        r = Rect::new(r.left.min(reg.x0 as f32), r.top.min(reg.y0 as f32), r.right.max(reg.x1 as f32), r.bottom.max(reg.y1 as f32));
                    }
                }
                ResolvedEffect::InsetShadow(_) | ResolvedEffect::ColorMatrix(_) | ResolvedEffect::GradientMap(_) | ResolvedEffect::Grain(_) | ResolvedEffect::BackdropBlur { .. } => {}
                _ => return None,
            }
        }
        Some(r)
    }

    /// The box of the glyph outlines in text-box space, which reaches past the text box when the line box is shorter than
    /// the font (`line-height: 1` under a descender); `None` for no glyphs. A layer sized to the box alone would cut that.
    fn text_ink(&mut self, laid: &crate::text::LaidOutText) -> Option<Rect> {
        let mut ink: Option<Rect> = None;
        for run in &laid.runs {
            let Some(tf) = self.typeface(run) else { continue };
            let tf_id = tf.unique_id();
            let f = text_font(tf, run);
            for g in &run.glyphs {
                let key = (tf_id, run.font_size.to_bits(), run.skew.to_bits(), run.embolden > 0.0, g.id as u16);
                let Some(outline) = self.glyph_paths.entry(key).or_insert_with(|| f.get_path(g.id as u16)).clone() else { continue };
                let o = outline.bounds();
                let r = Rect::new(g.x + o.left, g.y + o.top, g.x + o.right, g.y + o.bottom);
                ink = Some(match ink {
                    None => r,
                    Some(a) => Rect::new(a.left.min(r.left), a.top.min(r.top), a.right.max(r.right), a.bottom.max(r.bottom)),
                });
            }
        }
        ink
    }

    fn content_bounds(&mut self, layer: &ResolvedLayer, scale: f64) -> Option<Rect> {
        let _ = scale;
        match &layer.kind {
            ResolvedKind::Shape { geometry, stroke, style, .. } => {
                let mut b = self.layer_box(layer)?;
                if let Some((_, w)) = stroke {
                    let g = (*w as f32) * 0.5 * (if style.join == StrokeJoin::Miter { style.miter_limit as f32 } else { 1.0 }).max(1.0) + 1.0;
                    b = Rect::new(b.left - g, b.top - g, b.right + g, b.bottom + g);
                }
                let _ = geometry;
                Some(b)
            }
            ResolvedKind::Text { size, chars, text, font, line_height, max_width, align, runs, box_size, stroke, .. } => {
                let b = self.layer_box(layer)?;
                let laid = self.text.layout_layer(text, font, *size, *line_height, *max_width, *align, runs, *box_size);
                // A stroke reaches half its width (a miter join, up to the limit) past the outline.
                let reach = stroke.as_ref().map_or(0.0, |st| st.width as f32 * 0.5 * if st.join == StrokeJoin::Miter { st.miter_limit as f32 } else { 1.0 }.max(1.0) + 1.0);
                let g = (*size).max(reach);
                let mut b = Rect::new(b.left - g, b.top - g, b.right + g, b.bottom + g);
                if let Some(ink) = self.text_ink(&laid) {
                    // A pixel more for the anti-aliased edge, as the box has.
                    b = Rect::new(b.left.min(ink.left - 1.0), b.top.min(ink.top - 1.0), b.right.max(ink.right + 1.0), b.bottom.max(ink.bottom + 1.0));
                }
                if chars.iter().any(Option::is_some) {
                    // A styled character moves, scales and turns about its centre: its glyph box goes through that.
                    let centres = laid.char_centres();
                    for glyph in laid.runs.iter().flat_map(|run| &run.glyphs) {
                        let Some(style) = crate::render::char_style(chars, glyph.char_index) else { continue };
                        let centre = centres.get(&glyph.char_index).copied().unwrap_or_default();
                        let ink = Rect::new(glyph.x - g, glyph.y - g, glyph.x + glyph.advance + g, glyph.y + g);
                        let r = mat(crate::render::char_matrix(style, centre)).map_rect(ink).0;
                        b = Rect::new(b.left.min(r.left), b.top.min(r.top), b.right.max(r.right), b.bottom.max(r.bottom));
                    }
                }
                Some(b)
            }
            ResolvedKind::Image { .. } | ResolvedKind::Video { .. } | ResolvedKind::Canvas { .. } | ResolvedKind::Gif { .. } | ResolvedKind::Lottie { .. } | ResolvedKind::Noise { .. } => {
                self.layer_box(layer)
            }
            ResolvedKind::Group { children, .. } => {
                let mut acc: Option<Rect> = None;
                for c in children {
                    if is_hidden(c) || is_matte_source(children, c) {
                        continue;
                    }
                    if crate::warp::layer_world(&c.transform).is_some() {
                        return None;
                    }
                    let cb = self.layer_bounds(c, scale)?;
                    let cm = mat(c.transform.matrix());
                    let mapped = cm.map_rect(cb).0;
                    acc = Some(match acc {
                        None => mapped,
                        Some(a) => Rect::new(a.left.min(mapped.left), a.top.min(mapped.top), a.right.max(mapped.right), a.bottom.max(mapped.bottom)),
                    });
                }
                // Motion sub-frames carry their own matrices: bounded by the canvas.
                if children.iter().any(|c| !c.motion.is_empty()) {
                    return None;
                }
                Some(acc.unwrap_or(Rect::new(0.0, 0.0, 0.0, 0.0)))
            }
            _ => None,
        }
    }

    /// The image filter for the layer's effects in order, and a backdrop filter if one blurs the backdrop.
    fn effect_filter(&mut self, canvas: &Canvas, layer: &ResolvedLayer, scale: f64) -> (Option<ImageFilter>, Option<ImageFilter>) {
        let _ = canvas;
        let s = scale.max(1e-6) as f32;
        let mut filter: Option<ImageFilter> = None;
        let mut backdrop: Option<ImageFilter> = None;
        // Colour filters in a run combine into one.
        for e in &layer.effects {
            let class = match e {
                ResolvedEffect::Blur { .. } => "blur",
                ResolvedEffect::BackdropBlur { .. } => "backdrop",
                ResolvedEffect::DropShadow(_) => "shadow",
                ResolvedEffect::InsetShadow(_) => "inset",
                ResolvedEffect::ColorMatrix(_) => "color",
                ResolvedEffect::FilterGraph(_) => "filtergraph",
                ResolvedEffect::Glow(_) => "glow",
                ResolvedEffect::GradientMap(_) => "gradientmap",
                ResolvedEffect::Grain(_) => "grain",
                _ => "",
            };
            if self.skip.iter().any(|k| k == class) {
                continue;
            }
            match e {
                ResolvedEffect::Blur { radius } => {
                    if *radius >= 1.0 {
                        let sg = radius / s;
                        filter = image_filters::blur((sg, sg), TileMode::Decal, filter.take(), None);
                    }
                }
                ResolvedEffect::BackdropBlur { radius } => {
                    let sg = radius / s;
                    backdrop = image_filters::blur((sg, sg), TileMode::Clamp, None, None);
                }
                ResolvedEffect::DropShadow(sh) => {
                    let sg = sh.blur / s;
                    let input = filter.take();
                    let src = if sh.spread != 0.0 {
                        let r = sh.spread.abs() / s;
                        if sh.spread > 0.0 {
                            image_filters::dilate((r, r), input.clone(), None)
                        } else {
                            image_filters::erode((r, r), input.clone(), None)
                        }
                    } else {
                        input.clone()
                    };
                    let shadow = image_filters::drop_shadow_only((sh.x / s, sh.y / s), (sg, sg), color4(sh.color), None, src, None);
                    filter = image_filters::merge([shadow, input], None);
                }
                ResolvedEffect::InsetShadow(sh) => {
                    let sg = sh.blur / s;
                    let input = filter.take();
                    // The layer's alpha inverted, in the shadow colour; blurred, moved, then kept where the layer is.
                    let c = color4(sh.color);
                    let inv = color_filters::matrix_row_major(&[
                        0.0, 0.0, 0.0, 0.0, c.r, //
                        0.0, 0.0, 0.0, 0.0, c.g, //
                        0.0, 0.0, 0.0, 0.0, c.b, //
                        0.0, 0.0, 0.0, -c.a, c.a,
                    ], None);
                    let inverted = image_filters::color_filter(inv, input.clone(), None);
                    let grown = if sh.spread != 0.0 {
                        let r = sh.spread.abs() / s;
                        if sh.spread > 0.0 {
                            image_filters::dilate((r, r), inverted, None)
                        } else {
                            image_filters::erode((r, r), inverted, None)
                        }
                    } else {
                        inverted
                    };
                    let moved = image_filters::offset((sh.x / s, sh.y / s), grown, None);
                    let blurred = if sg >= 0.3 { image_filters::blur((sg, sg), TileMode::Clamp, moved, None) } else { moved };
                    let inside = image_filters::blend(SkBlend::DstIn, blurred, input.clone(), None);
                    filter = image_filters::merge([input, inside], None);
                }
                ResolvedEffect::ColorMatrix(cm) => {
                    let m = &cm.0;
                    let f = color_filters::matrix_row_major(&[
                        m[0][0] as f32, m[0][1] as f32, m[0][2] as f32, m[0][3] as f32, m[0][4] as f32,
                        m[1][0] as f32, m[1][1] as f32, m[1][2] as f32, m[1][3] as f32, m[1][4] as f32,
                        m[2][0] as f32, m[2][1] as f32, m[2][2] as f32, m[2][3] as f32, m[2][4] as f32,
                        m[3][0] as f32, m[3][1] as f32, m[3][2] as f32, m[3][3] as f32, m[3][4] as f32,
                    ], None);
                    filter = image_filters::color_filter(self.in_srgb(f), filter.take(), None);
                }
                ResolvedEffect::FilterGraph(g) => {
                    let input = filter.take();
                    let lb = self.layer_box(layer);
                    filter = self.filter_graph(g, input, s, lb);
                }
                ResolvedEffect::Glow(g) => {
                    if g.radius >= 1.0 && g.intensity > 0.0 {
                        let input = filter.take();
                        let sg = g.radius / s;
                        let mut halo = image_filters::blur((sg, sg), TileMode::Decal, input.clone(), None);
                        if self.linear() {
                            // The compositor's halo: the blurred layer, or the colour times its alpha; times the intensity; one
                            // brighter than opaque is scaled back to alpha 1, which keeps its colour.
                            let fx = self.runtime("glowHalo", "uniform shader src; uniform float k; uniform float tinted; uniform float4 tint;
                                half4 main(float2 xy) { half4 b = src.eval(xy); float4 h = tinted > 0.5 ? tint * b.a : float4(b); h *= k;
                                  if (h.a > 1.0) { h /= h.a; } return half4(h); }");
                            let tint = g.color.map(|c| c.linear_premultiplied().map(|v| v as f32));
                            filter = fx.and_then(|fx| {
                                let mut b = skia_safe::runtime_effect::RuntimeShaderBuilder::new(fx);
                                b.set_uniform_float("k", &[g.intensity]).ok()?;
                                b.set_uniform_float("tinted", &[if tint.is_some() { 1.0 }  else { 0.0 }]).ok()?;
                                b.set_uniform_float("tint", &tint.unwrap_or([0.0; 4])).ok()?;
                                image_filters::blend(SkBlend::DstOver, input, image_filters::runtime_shader(&b, "src", halo), None)
                            });
                            continue;
                        }
                        if let Some(c) = g.color {
                            let c = color4(c);
                            let tint = color_filters::matrix_row_major(
                                &[0.0, 0.0, 0.0, 0.0, c.r, 0.0, 0.0, 0.0, 0.0, c.g, 0.0, 0.0, 0.0, 0.0, c.b, 0.0, 0.0, 0.0, c.a, 0.0],
                                None,
                            );
                            halo = image_filters::color_filter(tint, halo, None);
                        }
                        // layer + halo * (1 - layer alpha): the halo under the layer.
                        filter = image_filters::blend(SkBlend::DstOver, halo.and_then(|h| {
                            let k = g.intensity;
                            image_filters::color_filter(
                                color_filters::matrix_row_major(&[k, 0.0, 0.0, 0.0, 0.0, 0.0, k, 0.0, 0.0, 0.0, 0.0, 0.0, k, 0.0, 0.0, 0.0, 0.0, 0.0, k, 0.0], None),
                                Some(h),
                                None,
                            )
                        }), input, None);
                        self.stats.approx("glow halo (sRGB, clamped) approximates linear-light glow");
                    }
                }
                ResolvedEffect::GradientMap(gm) => {
                    let input = filter.take();
                    filter = self.gradient_map(gm, input);
                }
                ResolvedEffect::Grain(gr) => {
                    let input = filter.take();
                    filter = self.grain(gr, input);
                }
                other => {
                    let name = effect_name(other);
                    self.stats.no(&format!("effect {name}"));
                }
            }
        }
        (filter, backdrop)
    }

    /// The SVG filter graph as a DAG of Skia image filters: turbulence, displacement, blur, offset, colour matrix,
    /// flood, merge, composite; other primitives are counted. Filter regions and subregions are not applied.
    fn filter_graph(&mut self, g: &crate::filter::ResolvedFilterGraph, source: Option<ImageFilter>, s: f32, layer_box: Option<Rect>) -> Option<ImageFilter> {
        use crate::filter::{CompositeOp, FeInput, FeOp};
        let mut results: Vec<Option<ImageFilter>> = Vec::new();
        // The region and subregions in layer units, and the lengths scaled by `primitiveUnits`; each result is cut to its
        // subregion, as the wgpu path does.
        let plan = g.plan(layer_box.map(|b| kurbo::Rect::new(b.left as f64, b.top as f64, b.right as f64, b.bottom as f64)));
        if plan.is_none() {
            self.stats.approx("filter region/subregion not applied (no layer box)");
        }
        let sk = |r: &kurbo::Rect| Rect::new(r.x0 as f32, r.y0 as f32, r.x1 as f32, r.y1 as f32);
        for (idx, node) in g.nodes.iter().enumerate() {
            let op = plan.as_ref().map_or(&node.op, |p| &p.nodes[idx].op);
            // A primitive that works in linearRGB reads its inputs decoded and its result is encoded again (flood
            // colours are given in sRGB and stay there). On a surface that holds linear light the conversions go the
            // other way: a primitive that works in sRGB gets its inputs encoded and its result decoded.
            let lin = node.linear;
            let surface_lin = self.linear();
            let input = |i: usize, results: &Vec<Option<ImageFilter>>| -> Option<ImageFilter> {
                let f = match node.inputs.get(i).copied().unwrap_or(FeInput::Source) {
                    FeInput::Source => source.clone(),
                    FeInput::SourceAlpha => {
                        let f = color_filters::matrix_row_major(
                            &[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
                            None,
                        );
                        image_filters::color_filter(f, source.clone(), None)
                    }
                    FeInput::Node(n) => results.get(n).cloned().flatten(),
                    FeInput::Empty => Some(image_filters::empty()),
                };
                // `None` is the layer itself.
                match (lin, surface_lin) {
                    (true, false) => image_filters::color_filter(color_filters::srgb_to_linear_gamma(), f, None),
                    (false, true) => image_filters::color_filter(color_filters::linear_to_srgb_gamma(), f, None),
                    _ => f,
                }
            };
            let out = match op {
                FeOp::Turbulence { fractal, frequency, octaves, seed, .. } => {
                    let sh = if *fractal {
                        skia_safe::shaders::fractal_noise((frequency[0], frequency[1]), *octaves as usize, *seed as f32, None)
                    } else {
                        skia_safe::shaders::turbulence((frequency[0], frequency[1]), *octaves as usize, *seed as f32, None)
                    };
                    sh.and_then(|sh| image_filters::shader(sh, None))
                }
                FeOp::DisplacementMap { scale, x_channel, y_channel } => {
                    let ch = |c: u32| match c {
                        0 => skia_safe::ColorChannel::R,
                        1 => skia_safe::ColorChannel::G,
                        2 => skia_safe::ColorChannel::B,
                        _ => skia_safe::ColorChannel::A,
                    };
                    image_filters::displacement_map((ch(*x_channel), ch(*y_channel)), *scale / s, input(1, &results), input(0, &results), None)
                }
                FeOp::GaussianBlur { std } => image_filters::blur((std[0] / s, std[1] / s), TileMode::Decal, input(0, &results), None),
                FeOp::Offset { dx, dy } => image_filters::offset((dx / s, dy / s), input(0, &results), None),
                FeOp::ColorMatrix { rows } => {
                    let mut m = [0.0f32; 20];
                    for (r, row) in rows.iter().enumerate() {
                        m[r * 5..r * 5 + 5].copy_from_slice(row);
                    }
                    image_filters::color_filter(color_filters::matrix_row_major(&m, None), input(0, &results), None)
                }
                FeOp::Merge => {
                    let all: Vec<Option<ImageFilter>> = (0..node.inputs.len()).map(|i| input(i, &results)).collect();
                    image_filters::merge(all, None)
                }
                FeOp::Composite { operator: CompositeOp::Arithmetic, k } => {
                    // in is the foreground, in2 the background: k1 in in2 + k2 in + k3 in2 + k4, clamped to a valid colour.
                    image_filters::arithmetic(k[0], k[1], k[2], k[3], true, input(1, &results), input(0, &results), None)
                }
                FeOp::Flood { color } => {
                    let c = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
                    image_filters::shader(skia_safe::shaders::color(Color::from_argb(c(color[3]), c(color[0]), c(color[1]), c(color[2]))), None)
                }
                FeOp::Blend { mode } => image_filters::blend(sk_blend(*mode), input(1, &results), input(0, &results), None),
                FeOp::ComponentTransfer { funcs } => {
                    let table = |f: &crate::filter::ResolvedTransfer| -> Option<[u8; 256]> {
                        if f.kind == 0 {
                            return None;
                        }
                        let mut t = [0u8; 256];
                        for (i, v) in t.iter_mut().enumerate() {
                            *v = (transfer(f, i as f32 / 255.0).clamp(0.0, 1.0) * 255.0).round() as u8;
                        }
                        Some(t)
                    };
                    let [r, g, b, a] = [table(&funcs[0]), table(&funcs[1]), table(&funcs[2]), table(&funcs[3])];
                    color_filters::table_argb(a.as_ref(), r.as_ref(), g.as_ref(), b.as_ref()).and_then(|f| image_filters::color_filter(f, input(0, &results), None))
                }
                FeOp::Morphology { dilate, radius } => {
                    let r = (radius[0] / s, radius[1] / s);
                    if *dilate { image_filters::dilate(r, input(0, &results), None) } else { image_filters::erode(r, input(0, &results), None) }
                }
                FeOp::Tile => {
                    // The input's subregion is repeated over the plane; it must be given in user units.
                    let sub = match (node.inputs.first(), &plan) {
                        (Some(FeInput::Node(i)), Some(p)) => p.nodes.get(*i).map(|n| n.sub),
                        _ => None,
                    };
                    match sub {
                        Some(r) if r.width() > 0.0 && r.height() > 0.0 => {
                            let src = sk(&r);
                            image_filters::tile(src, Rect::new(-1e5, -1e5, 1e5, 1e5), input(0, &results))
                        }
                        _ => {
                            self.stats.no("filter primitive feTile (input subregion unknown)");
                            input(0, &results)
                        }
                    }
                }
                FeOp::ConvolveMatrix { order, kernel, divisor, bias, target, edge, preserve_alpha } => {
                    let tile = match edge {
                        crate::filter::EdgeMode::Duplicate => TileMode::Clamp,
                        crate::filter::EdgeMode::Wrap => TileMode::Repeat,
                        crate::filter::EdgeMode::None => TileMode::Decal,
                    };
                    let (ow, oh) = (order[0] as i32, order[1] as i32);
                    if ow <= 0 || oh <= 0 || kernel.len() != (ow * oh) as usize {
                        input(0, &results)
                    } else {
                        let gain = if *divisor != 0.0 { 1.0 / divisor } else { 1.0 };
                        image_filters::matrix_convolution((ow, oh), kernel, gain, *bias, skia_safe::IPoint::new(target[0], target[1]), tile, !*preserve_alpha, input(0, &results), None)
                    }
                }
                FeOp::Lighting { specular, surface_scale, constant, exponent, color, light } => {
                    let c = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
                    let dec = |v: f32| if !lin || surface_lin { v } else if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) };
                    let col = Color::from_rgb(c(dec(color[0])), c(dec(color[1])), c(dec(color[2])));
                    let p3 = |p: &[f32; 3]| skia_safe::Point3::new(p[0], p[1], p[2]);
                    let inp = input(0, &results);
                    let (ss, k, e) = (*surface_scale, *constant, *exponent);
                    match (light, *specular) {
                        (crate::filter::ResolvedLight::Distant { azimuth, elevation }, spec) => {
                            let (az, el) = (azimuth.to_radians(), elevation.to_radians());
                            let d = skia_safe::Point3::new(az.cos() * el.cos(), az.sin() * el.cos(), el.sin());
                            if spec { image_filters::distant_lit_specular(d, col, ss, k, e, inp, None) } else { image_filters::distant_lit_diffuse(d, col, ss, k, inp, None) }
                        }
                        (crate::filter::ResolvedLight::Point { position }, spec) => {
                            if spec { image_filters::point_lit_specular(p3(position), col, ss, k, e, inp, None) } else { image_filters::point_lit_diffuse(p3(position), col, ss, k, inp, None) }
                        }
                        (crate::filter::ResolvedLight::Spot { position, points_at, exponent: fo, cone }, spec) => {
                            let cone = cone.unwrap_or(180.0);
                            if spec {
                                image_filters::spot_lit_specular(p3(position), p3(points_at), *fo, cone, col, ss, k, e, inp, None)
                            } else {
                                image_filters::spot_lit_diffuse(p3(position), p3(points_at), *fo, cone, col, ss, k, inp, None)
                            }
                        }
                    }
                }
                FeOp::Composite { operator, .. } => {
                    let mode = match operator {
                        CompositeOp::Over => SkBlend::SrcOver,
                        CompositeOp::In => SkBlend::SrcIn,
                        CompositeOp::Out => SkBlend::SrcOut,
                        CompositeOp::Atop => SkBlend::SrcATop,
                        _ => SkBlend::Xor,
                    };
                    image_filters::blend(mode, input(1, &results), input(0, &results), None)
                }
            };
            let out = match out {
                Some(f) if lin != surface_lin && !matches!(op, FeOp::Flood { .. }) => {
                    let back = if lin { color_filters::linear_to_srgb_gamma() } else { color_filters::srgb_to_linear_gamma() };
                    image_filters::color_filter(back, f, None)
                }
                f => f,
            };
            let out = match (&plan, out) {
                (Some(p), Some(f)) => image_filters::crop(sk(&p.nodes[idx].sub), TileMode::Decal, f),
                (_, f) => f,
            };
            results.push(out);
        }
        results.pop().flatten().or(source)
    }

    fn runtime(&mut self, key: &str, sksl: &str) -> Option<skia_safe::RuntimeEffect> {
        if let Some(e) = self.fx.get(key) {
            return e.clone();
        }
        let e = match skia_safe::RuntimeEffect::make_for_shader(sksl, None) {
            Ok(e) => Some(e),
            Err(err) => {
                eprintln!("kinetograph: skia runtime effect {key} did not compile: {err}");
                None
            }
        };
        self.fx.insert(key.to_string(), e.clone());
        e
    }

    fn gradient_map(&mut self, gm: &crate::resolve::ResolvedGradientMap, input: Option<ImageFilter>) -> Option<ImageFilter> {
        let lin = if self.linear() { 1.0 } else { 0.0 };
        let fx = self.runtime("gmap", &[SKSL_SRGB, "uniform shader src; uniform float count; uniform float amount; uniform float offs[16]; uniform float cr[16]; uniform float cg[16]; uniform float cb[16]; uniform float ca[16];
            half4 main(float2 xy) { half4 c = src.eval(xy); if (c.a <= 0.0) { return half4(0); }
              half3 s = clamp(c.rgb / c.a, 0, 1); if (lin > 0.5) { s = half3(toS(float3(s))); } float l = dot(float3(s), float3(0.2126, 0.7152, 0.0722));
              float4 g = float4(cr[15], cg[15], cb[15], ca[15]);
              if (l <= offs[0]) { g = float4(cr[0], cg[0], cb[0], ca[0]); } else {
                for (int i = 1; i < 16; i++) {
                  if (l <= offs[i]) { float d = offs[i] - offs[i - 1]; g = mix(float4(cr[i - 1], cg[i - 1], cb[i - 1], ca[i - 1]), float4(cr[i], cg[i], cb[i], ca[i]), d > 0.0 ? (l - offs[i - 1]) / d : 1.0); break; } } }
              float4 o = float4(s, c.a); float4 gr = float4(g.rgb, c.a * g.a); float4 r = mix(o, gr, amount);
              if (lin > 0.5) { r.rgb = toL(r.rgb); }
              return half4(half3(r.rgb * r.a), half(r.a)); }"].concat())?;
        let mut b = skia_safe::runtime_effect::RuntimeShaderBuilder::new(fx);
        let n = gm.stops.len().min(16);
        let mut offs = [0.0f32; 16];
        let mut cols = [[0.0f32; 16]; 4];
        for i in 0..16 {
            let (o, c) = gm.stops[i.min(n - 1)];
            offs[i] = o as f32;
            let c = color4(c);
            for (k, v) in [c.r, c.g, c.b, c.a].into_iter().enumerate() {
                cols[k][i] = v;
            }
        }
        b.set_uniform_float("lin", &[lin]).ok()?;
        b.set_uniform_float("count", &[n as f32]).map_err(|e| eprintln!("kinetograph: gradientMap uniform count: {e}")).ok()?;
        b.set_uniform_float("amount", &[gm.amount]).ok()?;
        b.set_uniform_float("offs", &offs).map_err(|e| eprintln!("kinetograph: gradientMap uniform offs: {e}")).ok()?;
        for (name, v) in ["cr", "cg", "cb", "ca"].into_iter().zip(&cols) {
            b.set_uniform_float(name, v).map_err(|e| eprintln!("kinetograph: gradientMap uniform {name}: {e}")).ok()?;
        }
        image_filters::runtime_shader(&b, "src", input)
    }

    fn grain(&mut self, gr: &crate::resolve::ResolvedGrain, input: Option<ImageFilter>) -> Option<ImageFilter> {
        // A float hash in place of the integer PCG hash of the compositor: same kind of noise, not the same pattern.
        let lin = if self.linear() { 1.0 } else { 0.0 };
        let fx = self.runtime("grain", &[SKSL_SRGB, "uniform shader src; uniform float amount; uniform float size; uniform float mono; uniform float seed;
            float h(float2 p) { return fract(sin(dot(p, float2(127.1, 311.7)) + seed) * 43758.5453); }
            float3 lat(float2 i) { float a = h(i); float b = h(i + 17.0);
              if (mono > 0.5) { return float3(a + b - 1.0); }
              return float3(a + h(i + 3.0) - 1.0, h(i + 7.0) + h(i + 11.0) - 1.0, b + h(i + 13.0) - 1.0); }
            half4 main(float2 xy) { half4 c = src.eval(xy); if (c.a <= 0.0) { return half4(0); }
              half3 s = clamp(c.rgb / c.a, 0, 1); if (lin > 0.5) { s = half3(toS(float3(s))); }
              float2 p = floor(xy) / max(size, 1.0); float2 i = floor(p); float2 f = p - i; float2 w = f * f * (3.0 - 2.0 * f);
              float3 n = mix(mix(lat(i), lat(i + float2(1, 0)), w.x), mix(lat(i + float2(0, 1)), lat(i + float2(1, 1)), w.x), w.y);
              half3 rgb = clamp(s + half3(amount * n), 0, 1); if (lin > 0.5) { rgb = half3(toL(float3(rgb))); }
              return half4(rgb * c.a, c.a); }"].concat())?;
        let mut b = skia_safe::runtime_effect::RuntimeShaderBuilder::new(fx);
        b.set_uniform_float("lin", &[lin]).ok()?;
        b.set_uniform_float("amount", &[gr.amount]).ok()?;
        b.set_uniform_float("size", &[gr.size]).ok()?;
        b.set_uniform_float("mono", &[if gr.monochrome { 1.0 } else { 0.0 }]).ok()?;
        b.set_uniform_float("seed", &[(gr.seed % 1000) as f32 + (gr.frame % 1000) as f32 * 0.37]).ok()?;
        self.stats.approx("grain uses a float hash, not the compositor's PCG pattern");
        image_filters::runtime_shader(&b, "src", input)
    }

    fn draw_content(&mut self, canvas: &Canvas, layer: &ResolvedLayer, comp: Comp, scale: f64) {
        match &layer.kind {
            ResolvedKind::Group { children, .. } => self.draw_layers(canvas, children, scale),
            ResolvedKind::Shape { geometry, fill, stroke, style } => {
                self.draw_shape(canvas, layer, geometry, fill.as_ref(), stroke.as_ref(), style, comp)
            }
            ResolvedKind::Text { .. } => self.draw_text(canvas, layer, comp),
            ResolvedKind::Image { src, width, height, fit } => {
                self.draw_image(canvas, src, (*width, *height), *fit, comp)
            }
            ResolvedKind::Video { src, width, height, fit, time, mosh } => {
                let moshed = mosh.as_ref().and_then(|m| self.mosh_image(&layer.id, src, m));
                match moshed.or_else(|| self.video_image(src, time.ts)) {
                    Some(img) => self.draw_picture(canvas, &img, (*width, *height), *fit, comp),
                    None => self.stats.no("video layer (decode failed)"),
                }
            }
            ResolvedKind::Canvas { width, height, ops } => self.draw_canvas_layer(canvas, (*width, *height), ops),
            ResolvedKind::Gif { src, width, height, fit, time, looped } => match self.gif_image(src, *time, *looped) {
                Some(img) => self.draw_picture(canvas, &img, (*width, *height), *fit, comp),
                None => self.stats.no("gif layer (not loaded)"),
            },
            ResolvedKind::Lottie { src, width, height, time, looped } => self.draw_lottie(canvas, src, (*width, *height), *time, *looped, comp),
            ResolvedKind::Noise { width, height, turbulence, channels } => self.draw_noise(canvas, (*width, *height), turbulence, *channels, comp),
            // Handed to the wgpu path before this (`gaps`).
            ResolvedKind::Glsl { .. }
            | ResolvedKind::Scene3d { .. }
            | ResolvedKind::MeshGradient { .. } => self.stats.no("layer kind that should have fallen back"),
        }
    }

    fn base_paint(comp: Comp) -> Paint {
        let mut p = Paint::default();
        p.set_anti_alias(true);
        p.set_alpha_f(comp.alpha);
        p.set_blend_mode(comp.blend);
        p
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_shape(
        &mut self,
        canvas: &Canvas,
        layer: &ResolvedLayer,
        geometry: &ResolvedGeometry,
        fill: Option<&ResolvedPaint>,
        stroke: Option<&(crate::color::Color, f64)>,
        style: &ShapeStyle,
        comp: Comp,
    ) {
        let layer_box = self.layer_box(layer);
        let path = match geometry {
            ResolvedGeometry::Path { d } => self.svg_path(d, style.fill_rule == FillRule::EvenOdd),
            _ => None,
        };
        let draw = |canvas: &Canvas, p: &Paint| match geometry {
            ResolvedGeometry::Rect { width, height } => {
                canvas.draw_rect(Rect::new(0.0, 0.0, *width as f32, *height as f32), p);
            }
            ResolvedGeometry::RoundedRect { width, height, radius } => {
                let r = (*radius as f32).min(*width as f32 / 2.0).min(*height as f32 / 2.0);
                canvas.draw_rrect(RRect::new_rect_xy(Rect::new(0.0, 0.0, *width as f32, *height as f32), r, r), p);
            }
            ResolvedGeometry::Ellipse { width, height } => {
                canvas.draw_oval(Rect::new(0.0, 0.0, *width as f32, *height as f32), p);
            }
            ResolvedGeometry::Path { .. } => {
                if let Some(path) = &path {
                    canvas.draw_path(path, p);
                }
            }
        };
        if let Some(f) = fill {
            let mut p = Self::base_paint(comp);
            self.set_paint(canvas, &mut p, f, layer_box);
            draw(canvas, &p);
            self.stats.draws += 1;
        }
        if let Some((color, width)) = stroke {
            let mut p = Self::base_paint(comp);
            p.set_color4f(
                {
                    let c = color4(*color);
                    Color4f::new(c.r, c.g, c.b, c.a * comp.alpha)
                },
                None,
            );
            p.set_style(PaintStyle::Stroke);
            p.set_stroke_width(*width as f32);
            p.set_stroke_cap(match style.cap {
                StrokeCap::Butt => PaintCap::Butt,
                StrokeCap::Round => PaintCap::Round,
                StrokeCap::Square => PaintCap::Square,
            });
            p.set_stroke_join(match style.join {
                StrokeJoin::Round => PaintJoin::Round,
                StrokeJoin::Miter => PaintJoin::Miter,
                StrokeJoin::Bevel => PaintJoin::Bevel,
            });
            p.set_stroke_miter(style.miter_limit as f32);
            if !style.dash.is_empty() {
                let mut d: Vec<f32> = style.dash.iter().map(|v| *v as f32).collect();
                if d.len() % 2 == 1 {
                    let c = d.clone();
                    d.extend(c);
                }
                p.set_path_effect(PathEffect::dash(&d, style.dash_offset as f32));
            }
            draw(canvas, &p);
            self.stats.draws += 1;
        }
    }

    fn set_paint(&mut self, canvas: &Canvas, p: &mut Paint, paint: &ResolvedPaint, layer_box: Option<Rect>) {
        match paint {
            ResolvedPaint::Solid(c) => {
                let c = color4(*c);
                let a = p.alpha_f();
                p.set_color4f(Color4f::new(c.r, c.g, c.b, c.a * a), None);
            }
            ResolvedPaint::Gradient(g) => {
                p.set_shader(gradient_shader_for(g, layer_box, self.linear(), true));
            }
            ResolvedPaint::Image(i) => {
                let img = if crate::svg_picture::is_svg(&i.src) {
                    let (w, h) = (i.width, i.height);
                    self.svg_image(canvas, &i.src, |n| (w / n.0, h / n.1))
                } else {
                    self.image(&i.src)
                };
                let Some(img) = img else {
                    self.stats.no("image paint (file)");
                    return;
                };
                let tile = |r: bool| if r { TileMode::Repeat } else { TileMode::Clamp };
                let local = Matrix::translate((i.x as f32, i.y as f32))
                    * Matrix::scale((i.width as f32 / img.width() as f32, i.height as f32 / img.height() as f32));
                p.set_shader(img.to_shader((tile(i.repeat_x), tile(i.repeat_y)), SamplingOptions::new(skia_safe::FilterMode::Linear, skia_safe::MipmapMode::None), &local));
            }
        }
    }

    fn image(&mut self, src: &str) -> Option<Image> {
        if let Some(i) = self.images.get(src) {
            return i.clone();
        }
        let decoded = if crate::svg_picture::is_svg(src) {
            // Where the size it is drawn at is not known (a canvas's `drawImage`): at its natural size. `draw_image` and
            // image paints paint it for the size they draw it at (`svg_image`).
            self.svg_file(src).and_then(|pic| {
                let (w, h) = pic.size();
                let (w, h) = (w.ceil().max(1.0) as u32, h.ceil().max(1.0) as u32);
                image::RgbaImage::from_raw(w, h, pic.paint(w, h)?).map(image::DynamicImage::ImageRgba8)
            })
        } else if let Some(bytes) = data_uri_bytes(src) {
            image::load_from_memory(&bytes).ok()
        } else {
            image::open(self.base_dir.join(src)).ok()
        }
        .map(|d| d.to_rgba8());
        let img = decoded.and_then(|rgba| {
            let (w, h) = rgba.dimensions();
            let info = skia_safe::ImageInfo::new((w as i32, h as i32), skia_safe::ColorType::RGBA8888, skia_safe::AlphaType::Unpremul, None);
            images::raster_from_data(&info, Data::new_copy(rgba.as_raw()), (w * 4) as usize)
        });
        let img = match (&self.upload, img) {
            (Some(up), Some(i)) => up(&i),
            (_, i) => i,
        };
        self.images.insert(src.to_string(), img.clone());
        img
    }

    /// The SVG picture `src`, parsed once. A file that cannot be read is reported each time it is used.
    fn svg_file(&mut self, src: &str) -> Option<Rc<crate::svg_picture::Picture>> {
        if !self.svg_files.contains_key(src) {
            let pic = crate::svg_picture::Picture::open(&self.base_dir, src).ok().map(Rc::new);
            self.svg_files.insert(src.to_string(), pic);
        }
        let pic = self.svg_files.get(src).cloned().flatten();
        match &pic {
            Some(p) if p.has_text() => self.stats.approx("SVG picture text (left out: a picture sets text in no fonts)"),
            Some(_) => {}
            None => self.stats.no("SVG picture (the file cannot be read)"),
        }
        pic
    }

    /// The SVG picture `src` painted for being drawn `scale` layer units per natural pixel on each axis, under the
    /// canvas's matrix: one painted pixel to each drawn one, sharp at any scale. Painted once per size.
    fn svg_image(&mut self, canvas: &Canvas, src: &str, scale: impl Fn((f64, f64)) -> (f64, f64)) -> Option<Image> {
        let pic = self.svg_file(src)?;
        let natural = pic.size();
        let m = canvas.local_to_device_as_3x3();
        let dev = Affine::new([m.scale_x() as f64, m.skew_y() as f64, m.skew_x() as f64, m.scale_y() as f64, m.translate_x() as f64, m.translate_y() as f64]);
        let (pw, ph) = crate::svg_picture::pixels(natural, scale(natural), crate::bounds::max_stretch(dev))?;
        let key = (src.to_string(), pw, ph);
        if let Some(img) = self.svg_pics.get(&key) {
            return img.clone();
        }
        let img = pic.paint(pw, ph).and_then(|rgba| self.rgba_image(&rgba, pw, ph));
        if self.svg_pics.len() >= 48 {
            self.svg_pics.clear();
        }
        self.svg_pics.insert(key, img.clone());
        if img.is_none() {
            self.stats.no("SVG picture (cannot be painted)");
        }
        img
    }

    fn draw_image(&mut self, canvas: &Canvas, src: &str, size: (f64, f64), fit: Fit, comp: Comp) {
        if crate::svg_picture::is_svg(src) {
            let (sx, sy) = (size.0, size.1);
            let img = self.svg_image(canvas, src, |n| {
                let (kx, ky) = (sx / n.0, sy / n.1);
                match fit {
                    Fit::Fill => (kx, ky),
                    Fit::Contain => (kx.min(ky), kx.min(ky)),
                    Fit::Cover => (kx.max(ky), kx.max(ky)),
                }
            });
            if let Some(img) = img {
                self.draw_picture(canvas, &img, size, fit, comp);
            }
            return;
        }
        let Some(img) = self.image(src) else {
            self.stats.no("image (file)");
            return;
        };
        self.draw_picture(canvas, &img, size, fit, comp);
    }

    fn video_image(&mut self, src: &str, ts: i64) -> Option<Image> {
        if let Some((t, img)) = self.video_last.get(src)
            && *t == ts
        {
            return Some(img.clone());
        }
        if !self.videos.contains_key(src) {
            crate::video::init();
            let path = self.base_dir.join(src);
            let info = crate::video::probe(&path).ok()?;
            let dec = crate::video::VideoDecoder::open(&path, info).ok()?;
            self.videos.insert(src.to_string(), dec);
        }
        let pic = self.videos.get_mut(src)?.picture(ts).ok()?;
        let info = skia_safe::ImageInfo::new((pic.width as i32, pic.height as i32), skia_safe::ColorType::RGBA8888, skia_safe::AlphaType::Unpremul, None);
        let img = images::raster_from_data(&info, Data::new_copy(pic.data.data()), pic.width as usize * 4)?;
        let img = match &self.upload {
            Some(up) => up(&img)?,
            None => img,
        };
        self.video_last.insert(src.to_string(), (ts, img.clone()));
        Some(img)
    }

    /// A datamosh frame of video layer `id` (`datamosh.rs`): the held picture moved by the clip's motion up to this
    /// frame. `None` (the caller then draws the clip plain, and the frame says why) when the clip's codec exports no
    /// motion vectors or a file cannot be decoded.
    fn mosh_image(&mut self, id: &str, src: &str, mosh: &crate::datamosh::ResolvedMosh) -> Option<Image> {
        use crate::video::{VideoDecoder, init, probe};
        init();
        if !self.mosh_videos.contains_key(src) {
            let path = self.base_dir.join(src);
            let info = probe(&path).ok()?;
            if !crate::datamosh::exports_vectors(&info.video_codec) {
                self.stats.no("datamosh (the codec exports no motion vectors; drawn without it)");
                return None;
            }
            self.mosh_videos.insert(src.to_string(), VideoDecoder::open_with_motion(&path, info).ok()?);
        }
        // The held picture of another file is its own decoder's, so the plain video cache is shared with `video_image`.
        let base_dir = self.base_dir.clone();
        let videos = &mut self.videos;
        let clip = self.mosh_videos.get_mut(src)?;
        let mut state = self.mosh_states.remove(id).unwrap_or(None);
        let result = crate::datamosh::frame(
            &mut state,
            mosh,
            |w, h| {
                let crate::datamosh::ResolvedHold::Clip { src: other, ts } = &mosh.hold else {
                    return Err(crate::error::Error::Render("datamosh: no held clip".into()));
                };
                if !videos.contains_key(other) {
                    let path = base_dir.join(other);
                    let info = probe(&path).map_err(crate::error::Error::Render)?;
                    let decoder = VideoDecoder::open(&path, info).map_err(crate::error::Error::Render)?;
                    videos.insert(other.clone(), decoder);
                }
                let pic = videos
                    .get_mut(other)
                    .expect("just opened")
                    .picture(*ts)
                    .map_err(crate::error::Error::Render)?;
                Ok(crate::datamosh::cover(pic.data.data(), pic.width, pic.height, w, h))
            },
            |ts| clip.picture_motion(ts).map_err(|e| crate::error::Error::Render(format!("video {src:?}: {e}"))),
        );
        let image = match &result {
            Ok(state) => {
                let (w, h) = state.size();
                self.rgba_image(state.rgba(), w, h)
            }
            Err(e) => {
                self.stats.no(&format!("datamosh ({e})"));
                None
            }
        };
        self.mosh_states.insert(id.to_string(), state);
        if self.mosh_states.len() > 8 {
            self.mosh_states.retain(|k, _| k == id);
        }
        image
    }

    /// The noise layer: SVG's turbulence over the box, in layer space (Skia's Perlin shader is the reference algorithm;
    /// the compositor's `noise.wgsl` is the same). Its channels are linear RGB, as the compositor stores colour, so they are
    /// encoded to sRGB here; `gray` is the red channel, opaque.
    fn draw_noise(&mut self, canvas: &Canvas, size: (f64, f64), t: &crate::resolve::ResolvedTurbulence, channels: crate::scene::NoiseChannels, comp: Comp) {
        let noise = if t.fractal {
            skia_safe::shaders::fractal_noise((t.frequency[0], t.frequency[1]), t.octaves as usize, t.seed as f32, None)
        } else {
            skia_safe::shaders::turbulence((t.frequency[0], t.frequency[1]), t.octaves as usize, t.seed as f32, None)
        };
        let fx = self.runtime("noiseLayer", "uniform shader n; uniform float gray; uniform float lin;
            float enc(float v) { v = clamp(v, 0.0, 1.0); if (lin > 0.5) { return v; } return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055; }
            half4 main(float2 xy) { half4 c = n.eval(xy);
              float3 u = c.a > 0.0 ? float3(c.rgb) / c.a : float3(0.0);
              if (gray > 0.5) { float g = enc(u.r); return half4(half3(g), 1); }
              float3 e = float3(enc(u.r), enc(u.g), enc(u.b));
              return half4(half3(e * c.a), c.a); }");
        let (Some(noise), Some(fx)) = (noise, fx) else {
            self.stats.no("noise layer (shader)");
            return;
        };
        let gray: f32 = if channels == crate::scene::NoiseChannels::Gray { 1.0 } else { 0.0 };
        let uniforms = [gray, if self.linear() { 1.0f32 } else { 0.0 }].map(f32::to_le_bytes).concat();
        let Some(sh) = fx.make_shader(Data::new_copy(&uniforms), &[skia_safe::runtime_effect::ChildPtr::Shader(noise)], None) else {
            self.stats.no("noise layer (shader)");
            return;
        };
        let mut p = Self::base_paint(comp);
        p.set_shader(sh);
        canvas.draw_rect(Rect::new(0.0, 0.0, size.0 as f32, size.1 as f32), &p);
        self.stats.draws += 1;
    }

    fn rgba_image(&mut self, rgba: &[u8], w: u32, h: u32) -> Option<Image> {
        let info = skia_safe::ImageInfo::new((w as i32, h as i32), skia_safe::ColorType::RGBA8888, skia_safe::AlphaType::Unpremul, None);
        let img = images::raster_from_data(&info, Data::new_copy(rgba), (w * 4) as usize)?;
        match &self.upload {
            Some(up) => up(&img),
            None => Some(img),
        }
    }

    /// The picture a GIF shows `time` seconds in; each picture is uploaded once.
    fn gif_image(&mut self, src: &str, time: f64, looped: bool) -> Option<Image> {
        // SAFETY: `host` is the renderer `draw_scene` was given; this translator is not part of it.
        let host = unsafe { self.host.as_ref()? };
        let i = host.gifs.index(src, time, looped)?;
        let key = (src.to_string(), i);
        if let Some(img) = self.gif_pics.get(&key) {
            return img.clone();
        }
        let pic = host.gifs.image(src, time, looped).ok()?;
        let img = self.rgba_image(pic.data.data(), pic.width, pic.height);
        self.gif_pics.insert(key, img.clone());
        img
    }

    /// A Lottie frame: ThorVG paints it (straight-alpha RGBA) at the pixel size the layer is drawn at, and it is drawn
    /// as an image of the layer's box.
    fn draw_lottie(&mut self, canvas: &Canvas, src: &str, size: (f64, f64), time: f64, looped: bool, comp: Comp) {
        let m = canvas.local_to_device_as_3x3();
        let dev = Affine::new([m.scale_x() as f64, m.skew_y() as f64, m.skew_x() as f64, m.scale_y() as f64, m.translate_x() as f64, m.translate_y() as f64]);
        let Some((pw, ph)) = crate::render::lottie_pixels(size, dev) else { return };
        // SAFETY: as in `gif_image`.
        let Some(host) = (unsafe { self.host.as_mut() }) else { return };
        let key = (src.to_string(), pw, ph);
        let stamp = (time.to_bits(), looped);
        let img = match self.lottie_last.get(&key) {
            Some((s, img)) if *s == stamp => Some(img.clone()),
            _ => match host.lotties.image(src, time, looped, pw, ph) {
                Ok(pic) => self.rgba_image(pic.data.data(), pw, ph),
                Err(_) => None,
            },
        };
        let Some(img) = img else {
            self.stats.no("lottie layer (render failed)");
            return;
        };
        self.lottie_last.insert(key, (stamp, img.clone()));
        let (iw, ih) = (img.width() as f64, img.height() as f64);
        canvas.save();
        canvas.scale(((size.0 / iw) as f32, (size.1 / ih) as f32));
        let p = Self::base_paint(comp);
        canvas.draw_image_with_sampling_options(&img, (0.0, 0.0), SamplingOptions::new(skia_safe::FilterMode::Linear, skia_safe::MipmapMode::None), Some(&p));
        self.stats.draws += 1;
        canvas.restore();
    }

    fn draw_picture(&mut self, canvas: &Canvas, img: &Image, size: (f64, f64), fit: Fit, comp: Comp) {
        let (iw, ih) = (img.width() as f64, img.height() as f64);
        let (sx, sy) = (size.0 / iw, size.1 / ih);
        let placed = match fit {
            Fit::Fill => Affine::scale_non_uniform(sx, sy),
            Fit::Contain | Fit::Cover => {
                let s = if fit == Fit::Contain { sx.min(sy) } else { sx.max(sy) };
                Affine::translate(((size.0 - iw * s) / 2.0, (size.1 - ih * s) / 2.0)) * Affine::scale(s)
            }
        };
        canvas.save();
        if fit == Fit::Cover {
            canvas.clip_rect(Rect::new(0.0, 0.0, size.0 as f32, size.1 as f32), ClipOp::Intersect, true);
        }
        canvas.concat(&mat(placed));
        let p = Self::base_paint(comp);
        canvas.draw_image_with_sampling_options(img, (0.0, 0.0), SamplingOptions::new(skia_safe::FilterMode::Linear, skia_safe::MipmapMode::None), Some(&p));
        self.stats.draws += 1;
        canvas.restore();
    }

    fn typeface(&mut self, run: &crate::text::LaidOutRun) -> Option<Typeface> {
        let key = (run.font.data.id(), run.font.index, run.coords.clone());
        if let Some(t) = self.typefaces.get(&key) {
            return t.clone();
        }
        let base_key = (run.font.data.id(), run.font.index, Vec::new());
        let base = match self.typefaces.get(&base_key) {
            Some(t) => t.clone(),
            None => {
                let t = FontMgr::default().new_from_data(Data::new_copy(run.font.data.data()), run.font.index);
                self.typefaces.insert(base_key, t.clone());
                t
            }
        };
        let t = match (&base, run.coords.iter().any(|c| *c != 0)) {
            (Some(b), true) => {
                // Normalised F2Dot14 coordinates back to design values, from the font's own axes.
                use skrifa::MetadataProvider;
                let coords: Vec<skia_safe::font_arguments::variation_position::Coordinate> =
                    skrifa::FontRef::from_index(run.font.data.data(), run.font.index)
                        .ok()
                        .map(|f| {
                            f.axes()
                                .iter()
                                .enumerate()
                                .map(|(i, a)| {
                                    let n = f32::from(run.coords.get(i).copied().unwrap_or(0)) / 16384.0;
                                    let v = if n >= 0.0 {
                                        a.default_value() + n * (a.max_value() - a.default_value())
                                    } else {
                                        a.default_value() + n * (a.default_value() - a.min_value())
                                    };
                                    let t = a.tag().to_be_bytes();
                                    skia_safe::font_arguments::variation_position::Coordinate {
                                        axis: skia_safe::FourByteTag::from_chars(t[0] as char, t[1] as char, t[2] as char, t[3] as char),
                                        value: v,
                                    }
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                let args = skia_safe::FontArguments::new()
                    .set_variation_design_position(skia_safe::font_arguments::VariationPosition { coordinates: &coords });
                b.clone_with_arguments(&args).or(base.clone())
            }
            _ => base.clone(),
        };
        self.typefaces.insert(key, t.clone());
        t
    }

    /// The paint of a text's stroke: centred on the glyph outline, with the join and miter limit it asks for.
    fn text_stroke_paint(st: &TextStroke, comp: Comp) -> Paint {
        let mut p = Self::base_paint(comp);
        let c = color4(st.color);
        p.set_color4f(Color4f::new(c.r, c.g, c.b, c.a * comp.alpha), None);
        p.set_style(PaintStyle::Stroke);
        p.set_stroke_width(st.width as f32);
        p.set_stroke_join(match st.join {
            StrokeJoin::Round => PaintJoin::Round,
            StrokeJoin::Miter => PaintJoin::Miter,
            StrokeJoin::Bevel => PaintJoin::Bevel,
        });
        p.set_stroke_miter(st.miter_limit as f32);
        p
    }

    fn draw_text(&mut self, canvas: &Canvas, layer: &ResolvedLayer, comp: Comp) {
        let ResolvedKind::Text { text, font, size, color, line_height, max_width, align, chars, runs, box_size, stroke, paint_order } = &layer.kind else {
            return;
        };
        let laid = self.text.layout_layer(text, font, *size, *line_height, *max_width, *align, runs, *box_size);
        let (bw, bh) = laid.box_size(*max_width);
        let text_box = Some(Rect::new(0.0, 0.0, bw as f32, bh as f32));
        let styled = chars.iter().any(Option::is_some);
        let centres = if styled { laid.char_centres() } else { BTreeMap::new() };
        let mut paint = Self::base_paint(comp);
        self.set_paint(canvas, &mut paint, color, text_box);
        let stroke_paint = stroke.as_ref().map(|st| Self::text_stroke_paint(st, comp));
        let stroke_first = *paint_order == TextPaintOrder::StrokeFill;
        // The fill and the stroke of a path, in the order `paint-order` gives.
        let draw_both = |canvas: &Canvas, path: &Path, fill: &Paint, stroke: Option<&Paint>| {
            let mut draws = 0;
            for pass in 0..2 {
                if (pass == 0) == stroke_first {
                    if let Some(sp) = stroke {
                        canvas.draw_path(path, sp);
                        draws += 1;
                    }
                } else {
                    canvas.draw_path(path, fill);
                    draws += 1;
                }
            }
            draws
        };
        for run in &laid.runs {
            if run.glyphs.is_empty() {
                continue;
            }
            let Some(tf) = self.typeface(run) else {
                self.stats.no("font (typeface)");
                continue;
            };
            if run.coords.iter().any(|c| *c != 0) {
                self.stats.approx("variable-font coordinates (normalised back to design values, avar ignored)");
            }
            let tf_id = tf.unique_id();
            let f = text_font(tf, run);
            if run.embolden > 0.0 {
                self.stats.approx("synthetic bold (Skia's own amount)");
            }
            // Glyphs go in as outlines, one path a run. Graphite's glyph atlas gives a glyph the sampling coordinates of
            // wherever it happens to sit, which moves a few pixels by one level depending on what was drawn before: a
            // frame would not be a pure function of (project, frame). KINETOGRAPH_SKIA_TEXT=atlas draws them as a blob.
            if !self.text_atlas {
                let face = tf_id;
                let mut pb = PathBuilder::new();
                for g in &run.glyphs {
                    let key = (face, run.font_size.to_bits(), run.skew.to_bits(), run.embolden > 0.0, g.id as u16);
                    let outline = self.glyph_paths.entry(key).or_insert_with(|| f.get_path(g.id as u16)).clone();
                    let Some(style) = crate::render::char_style(chars, g.char_index) else {
                        if let Some(outline) = outline {
                            pb.add_path_with_offset(&outline, (g.x, g.y), None);
                        }
                        continue;
                    };
                    // A character with its own style is drawn about its centre, after the ones before it.
                    self.stats.draws += draw_both(canvas, &std::mem::replace(&mut pb, PathBuilder::new()).detach(), &paint, stroke_paint.as_ref());
                    let (Some(outline), true) = (outline, style.opacity > 0.0) else { continue };
                    let centre = centres.get(&g.char_index).copied().unwrap_or_default();
                    let mut own = Self::base_paint(comp);
                    own.set_alpha_f(own.alpha_f() * style.opacity);
                    match style.color {
                        Some(c) => self.set_paint(canvas, &mut own, &ResolvedPaint::Solid(c), text_box),
                        None => self.set_paint(canvas, &mut own, color, text_box),
                    }
                    canvas.save();
                    canvas.concat(&mat(crate::render::char_matrix(style, centre)));
                    let own_stroke = stroke.as_ref().map(|st| {
                        let mut sp = Self::text_stroke_paint(st, comp);
                        sp.set_alpha_f(sp.alpha_f() * style.opacity);
                        sp
                    });
                    self.stats.draws += draw_both(canvas, &Path::from(outline).make_offset((g.x, g.y)), &own, own_stroke.as_ref());
                    canvas.restore();
                }
                self.stats.draws += draw_both(canvas, &pb.detach(), &paint, stroke_paint.as_ref());
                continue;
            }
            let mut b = TextBlobBuilder::new();
            let (ids, pos) = b.alloc_run_pos(&f, run.glyphs.len(), None);
            for (i, g) in run.glyphs.iter().enumerate() {
                ids[i] = g.id as u16;
                pos[i] = Point::new(g.x, g.y);
            }
            if let Some(blob) = b.make() {
                canvas.draw_text_blob(&blob, (0.0, 0.0), &paint);
                self.stats.draws += 1;
            }
        }
    }
}

/// One `feFunc*` at `c` in 0..1 (`transfer` in `filter.wgsl`).
/// SkSL for the effects that work on sRGB-encoded values: `lin` is 1 where the surface holds linear light.
const SKSL_SRGB: &str = "uniform float lin;
    float3 toS(float3 v) { v = clamp(v, 0.0, 1.0); return mix(1.055 * pow(v, float3(1.0 / 2.4)) - 0.055, v * 12.92, step(v, float3(0.0031308))); }
    float3 toL(float3 v) { v = clamp(v, 0.0, 1.0); return mix(pow((v + 0.055) / 1.055, float3(2.4)), v / 12.92, step(v, float3(0.04045))); }
";

fn transfer(f: &crate::filter::ResolvedTransfer, c: f32) -> f32 {
    let n = f.table.len();
    match f.kind {
        1 if n == 1 => f.table[0],
        1 if n > 1 => {
            let pos = c.clamp(0.0, 1.0) * (n - 1) as f32;
            let k = (pos.floor() as usize).min(n - 2);
            f.table[k] + (pos - k as f32) * (f.table[k + 1] - f.table[k])
        }
        2 if n > 0 => f.table[((c.clamp(0.0, 1.0) * n as f32).floor() as usize).min(n - 1)],
        3 => f.p[0] * c + f.p[1],
        4 => f.p[0] * c.max(0.0).powf(f.p[1]) + f.p[2],
        _ => c,
    }
}

fn data_uri_bytes(src: &str) -> Option<Vec<u8>> {
    let rest = src.strip_prefix("data:")?;
    let (head, body) = rest.split_once(',')?;
    if head.ends_with(";base64") {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.decode(body.trim()).ok()
    } else {
        None
    }
}

fn effect_name(e: &ResolvedEffect) -> &'static str {
    match e {
        ResolvedEffect::Blur { .. } => "blur",
        ResolvedEffect::BackdropBlur { .. } => "backdropBlur",
        ResolvedEffect::Glow(_) => "glow",
        ResolvedEffect::ChromaticAberration { .. } => "chromaticAberration",
        ResolvedEffect::DropShadow(_) => "dropShadow",
        ResolvedEffect::InsetShadow(_) => "insetShadow",
        ResolvedEffect::ColorMatrix(_) => "colorMatrix",
        ResolvedEffect::GradientMap(_) => "gradientMap",
        ResolvedEffect::Lut { .. } => "lut",
        ResolvedEffect::Grain(_) => "grain",
        ResolvedEffect::Dither(_) => "dither",
        ResolvedEffect::Halftone(_) => "halftone",
        ResolvedEffect::DotMatrix(_) => "dotMatrix",
        ResolvedEffect::Displace(_) => "displace",
        ResolvedEffect::CornerPin(_) => "cornerPin",
        ResolvedEffect::FilterGraph(_) => "filterGraph",
        ResolvedEffect::ColorGrade(_) => "colorGrade",
        ResolvedEffect::Shader(_) => "shader",
    }
}

/// The font a run's glyphs are drawn with (and their outlines taken from).
fn text_font(tf: Typeface, run: &crate::text::LaidOutRun) -> Font {
    let mut f = Font::from_typeface(tf, run.font_size);
    f.set_subpixel(true);
    f.set_hinting(skia_safe::FontHinting::None);
    f.set_edging(skia_safe::font::Edging::AntiAlias);
    f.set_linear_metrics(true);
    if run.skew != 0.0 {
        f.set_skew_x(-run.skew.to_radians().tan());
    }
    if run.embolden > 0.0 {
        f.set_embolden(true);
    }
    f
}

fn blends_outside(layer: &ResolvedLayer) -> bool {
    layer.blend_mode != BlendMode::Normal
        || matches!(&layer.kind, ResolvedKind::Group { children, pass_through: true, .. } if children.iter().any(blends_outside))
}

fn is_hidden(layer: &ResolvedLayer) -> bool {
    if layer.motion.is_empty() {
        layer.opacity <= 0.0
    } else {
        layer.motion.iter().all(|sub| sub.opacity <= 0.0)
    }
}

fn is_matte_source(layers: &[ResolvedLayer], layer: &ResolvedLayer) -> bool {
    layers.iter().any(|l| l.matte.as_ref().is_some_and(|m| m.layer == layer.id))
}

/// A gradient as a Skia shader, following `render::gradient_brush_in`: the span between the first and last stop is
/// what repeats, and a gradient with no extent is its last stop's colour.
/// `linear`: the surface holds linear light, but stops blend in sRGB-encoded values (as CSS does).
/// `premul`: stops blend in premultiplied alpha (CSS gradients, CSS Images 4); canvas 2D gradients blend unpremultiplied
/// (HTML canvas spec, and Chrome and Firefox), so a stop of `transparent black` darkens the colour next to it.
fn gradient_shader_for(g: &ResolvedGradient, layer_box: Option<Rect>, linear: bool, premul: bool) -> Option<Shader> {
    let last = g.stops[g.stops.len() - 1];
    let solid = || Some(skia_safe::shaders::color(Color::from_argb(last.1.a, last.1.r, last.1.g, last.1.b)));
    let (lo, hi) = match g.extend {
        Extend::Pad => (0.0, 1.0),
        _ => (g.stops[0].0, last.0),
    };
    if hi - lo < 1e-6 {
        return solid();
    }
    // Stops remapped onto 0..=1 with end stops added.
    let mut colors: Vec<Color4f> = Vec::new();
    let mut pos: Vec<f32> = Vec::new();
    let (first, lastp) = (g.stops[0], g.stops[g.stops.len() - 1]);
    if first.0 > lo {
        colors.push(color4(first.1));
        pos.push(0.0);
    }
    for &(o, c) in &g.stops {
        colors.push(color4(c));
        pos.push((((o - lo) / (hi - lo)).clamp(0.0, 1.0)) as f32);
    }
    if lastp.0 < hi {
        colors.push(color4(lastp.1));
        pos.push(1.0);
    }
    // Strictly increasing positions are not required by Skia, only sorted.
    let tile = match g.extend {
        Extend::Pad => TileMode::Clamp,
        Extend::Repeat => TileMode::Repeat,
        Extend::Reflect => TileMode::Mirror,
    };
    let mut turn = Affine::IDENTITY;
    let shader = match g.geometry {
        ResolvedGradientGeometry::Linear { x0, y0, x1, y1 } => {
            let (p0, p1) = ((x0, y0), (x1, y1));
            let d = ((x1 - x0).powi(2) + (y1 - y0).powi(2)).sqrt();
            if d < 1e-6 {
                return solid();
            }
            let a = Point::new((p0.0 + (p1.0 - p0.0) * lo) as f32, (p0.1 + (p1.1 - p0.1) * lo) as f32);
            let b = Point::new((p0.0 + (p1.0 - p0.0) * hi) as f32, (p0.1 + (p1.1 - p0.1) * hi) as f32);
            (0, Some((a, b, Point::new(0.0, 0.0), 0.0f32, 0.0f32)))
        }
        ResolvedGradientGeometry::Radial { cx, cy, r } => {
            if r < 1e-6 {
                return solid();
            }
            (1, Some((Point::new(cx as f32, cy as f32), Point::new(cx as f32, cy as f32), Point::new(0.0, 0.0), (r * lo) as f32, (r * hi) as f32)))
        }
        ResolvedGradientGeometry::FocalRadial { cx, cy, r, fx, fy, fr } => {
            let at = |t: f64| (Point::new((fx + (cx - fx) * t) as f32, (fy + (cy - fy) * t) as f32), (fr + (r - fr) * t) as f32);
            let ((c0, r0), (c1, r1)) = (at(lo), at(hi));
            (1, Some((c0, c1, Point::new(0.0, 0.0), r0, r1)))
        }
        ResolvedGradientGeometry::Conic { cx, cy, angle } => {
            // Skia's sweep starts at 3 o'clock; CSS starts at 12.
            turn = Affine::rotate_about((angle - 90.0).to_radians(), kurbo::Point::new(cx, cy));
            (2, Some((Point::new(cx as f32, cy as f32), Point::new(0.0, 0.0), Point::new(0.0, 0.0), (lo * 360.0) as f32, (hi * 360.0) as f32)))
        }
    };
    let (kind, Some((a, b, _c, r0, r1))) = shader else { return None };
    let mut local = g.transform * turn;
    if g.units == Units::Box {
        let bx = layer_box?;
        if !(bx.width() > 0.0 && bx.height() > 0.0) {
            return solid();
        }
        local = Affine::translate((bx.left as f64, bx.top as f64)) * Affine::scale_non_uniform(bx.width() as f64, bx.height() as f64) * local;
    }
    let lm = mat(local);
    let lm = if local == Affine::IDENTITY { None } else { Some(&lm) };
    let flags = if premul { gradient_shader::Flags::INTERPOLATE_COLORS_IN_PREMUL } else { gradient_shader::Flags::empty() };
    let mut interp = gradient_shader::Interpolation::from(flags);
    if linear {
        interp.color_space = gradient_shader::interpolation::ColorSpace::SRGB;
    }
    match kind {
        0 => gradient_shader::linear_with_interpolation((a, b), (&colors[..], None), Some(&pos[..]), tile, interp, lm),
        1 => gradient_shader::two_point_conical_with_interpolation((a, r0), (b, r1), (&colors[..], None), Some(&pos[..]), tile, interp, lm),
        _ => gradient_shader::sweep_with_interpolation(a, (&colors[..], None), Some(&pos[..]), tile, Some((r0, r1)), interp, lm),
    }
}

/// Why Skia cannot draw `layer` (and what is under it) itself, if it cannot: the wgpu path draws it then. A group's
/// children are not looked at: each is a layer of its own to draw or to hand over.
fn gaps(layer: &ResolvedLayer, siblings: &[ResolvedLayer]) -> Option<&'static str> {
    own_gaps(layer, siblings).or_else(|| layer.motion.iter().find_map(|sub| own_gaps(sub, siblings)))
}

fn own_gaps(layer: &ResolvedLayer, siblings: &[ResolvedLayer]) -> Option<&'static str> {
    match &layer.kind {
        ResolvedKind::Group { preserve3d: true, .. } => return Some("preserve3d group"),
        ResolvedKind::Group { glsl: Some(_), .. } => return Some("glsl group"),
        ResolvedKind::Group { canvas: Some(_), .. } => return Some("canvas group"),
        ResolvedKind::Glsl { .. } => return Some("glsl layer"),
        ResolvedKind::Scene3d { .. } => return Some("scene3d layer"),
        ResolvedKind::MeshGradient { .. } => return Some("meshGradient layer"),
        _ => {}
    }
    for e in &layer.effects {
        match e {
            ResolvedEffect::Blur { .. }
            | ResolvedEffect::BackdropBlur { .. }
            | ResolvedEffect::Glow(_)
            | ResolvedEffect::DropShadow(_)
            | ResolvedEffect::InsetShadow(_)
            | ResolvedEffect::ColorMatrix(_)
            | ResolvedEffect::GradientMap(_)
            | ResolvedEffect::Grain(_)
            | ResolvedEffect::FilterGraph(_) => {}
            other => return Some(effect_name(other)),
        }
    }
    if let Some(m) = &layer.matte {
        if m.mode == MatteMode::LuminanceInverted {
            return Some("luminanceInverted matte");
        }
        if let Some(src) = siblings.iter().find(|l| l.id == m.layer)
            && gaps(src, siblings).is_some()
        {
            return Some("matte source");
        }
    }
    None
}

impl Translator {
    /// Asks the wgpu path for `layer` (its effects, clip, mask and matte on, at full opacity and `Normal`) as a texture
    /// of the canvas, and draws that over the canvas with `comp`'s opacity and blend.
    fn draw_fallback(&mut self, canvas: &Canvas, layer: &ResolvedLayer, siblings: &[ResolvedLayer], comp: Comp, why: &'static str) {
        *self.stats.fallbacks.entry(why.to_string()).or_default() += 1;
        if self.error.is_some() || self.host.is_null() {
            return;
        }
        let m = canvas.local_to_device_as_3x3();
        let parent = Affine::new([
            m.scale_x() as f64,
            m.skew_y() as f64,
            m.skew_x() as f64,
            m.scale_y() as f64,
            m.translate_x() as f64,
            m.translate_y() as f64,
        ]);
        // SAFETY: `host` is the renderer `draw_scene` was given; this translator is not part of it.
        let host = unsafe { &mut *self.host };
        let tex = match host.skia_fallback(layer, siblings, parent) {
            Ok(Some(tex)) => tex,
            Ok(None) => return,
            Err(e) => {
                self.error = Some(e);
                return;
            }
        };
        let image = self.wrap(host, &tex);
        let b = tex.bounds;
        if let Some(ref image) = image
            && !b.is_empty()
        {
            let src = Rect::new(
                (b.x0 - tex.origin[0]) as f32,
                (b.y0 - tex.origin[1]) as f32,
                (b.x1 - tex.origin[0]) as f32,
                (b.y1 - tex.origin[1]) as f32,
            );
            let dst = Rect::new(b.x0 as f32, b.y0 as f32, b.x1 as f32, b.y1 as f32);
            let mut p = Paint::default();
            p.set_alpha_f(comp.alpha);
            p.set_blend_mode(comp.blend);
            canvas.save();
            canvas.reset_matrix();
            canvas.draw_image_rect(image, Some((&src, skia_safe::canvas::SrcRectConstraint::Strict)), dst, &p);
            canvas.restore();
            self.stats.draws += 1;
        } else if image.is_none() {
            self.stats.no("fallback texture (wrap failed)");
        }
        self.held.push(tex);
    }
}

const WHITE: crate::color::Color = crate::color::Color { r: 255, g: 255, b: 255, a: 255 };

/// What the wgpu path asks Skia to draw into a texture (`Renderer::skia_leaf` and its kin): the 2D
/// content of one layer, with no effect, clip, mask or matte (the compositor applies those), under the matrix the
/// path rasterised it with.
impl Translator {
    /// The renderer whose Lottie and GIF pictures this draws, for the length of one call.
    pub fn set_host(&mut self, host: *mut Renderer) {
        self.host = host;
    }

    /// The leaf `layer` at full opacity, `Normal`, under `matrix` (layer space to canvas pixels). A noise layer is its
    /// box in opaque white: the noise pass fills its coverage.
    pub fn raster_leaf(&mut self, canvas: &Canvas, layer: &ResolvedLayer, matrix: Affine) {
        canvas.save();
        canvas.concat(&mat(matrix));
        match &layer.kind {
            ResolvedKind::Noise { width, height, .. } => {
                let mut p = Self::base_paint(Comp { alpha: 1.0, blend: SkBlend::SrcOver });
                p.set_color4f(Color4f::new(1.0, 1.0, 1.0, 1.0), None);
                canvas.draw_rect(Rect::new(0.0, 0.0, *width as f32, *height as f32), &p);
                self.stats.draws += 1;
            }
            _ => self.draw_content(canvas, layer, Comp { alpha: 1.0, blend: SkBlend::SrcOver }, 1.0),
        }
        canvas.restore();
    }

    /// The canvas layer `layer` (a canvas pass: its commands) under `matrix`, with the children `pictures` (by id) as the
    /// pictures its `layer` sources name. Each child is a compositor texture of the canvas, drawn through the inverse of
    /// `matrix`, so a picture is the child in the pass's own space.
    pub fn raster_canvas_pass(&mut self, canvas: &Canvas, layer: &ResolvedLayer, matrix: Affine, pictures: &[(&str, &Tex)]) {
        let ResolvedKind::Canvas { width, height, .. } = &layer.kind else {
            return;
        };
        let mut images = HashMap::new();
        if !self.host.is_null() {
            // SAFETY: `host` is the renderer `raster_leaf`'s caller holds; this translator is not part of it.
            let host = unsafe { &*self.host };
            for (id, tex) in pictures {
                let b = tex.bounds;
                if b.is_empty() {
                    continue;
                }
                match self.wrap(host, tex) {
                    Some(img) => {
                        let src = Rect::new(
                            (b.x0 - tex.origin[0]) as f32,
                            (b.y0 - tex.origin[1]) as f32,
                            (b.x1 - tex.origin[0]) as f32,
                            (b.y1 - tex.origin[1]) as f32,
                        );
                        images.insert((*id).to_string(), (img, src, tex.origin));
                    }
                    None => self.stats.no("canvas layer picture (wrap failed)"),
                }
            }
        }
        // The pass's picture of a child is a buffer of the pass's size, rounded, that `matrix` puts on the canvas.
        let side = |v: f64| v.round().clamp(1.0, 16384.0);
        self.layer_pics = Some(LayerPictures { size: (side(*width), side(*height)), from_canvas: matrix.inverse(), images });
        self.raster_leaf(canvas, layer, matrix);
        self.layer_pics = None;
    }

    /// The fill and stroke of the shape `layer` in opaque white, whatever their colours and alphas.
    pub fn raster_coverage(&mut self, canvas: &Canvas, layer: &ResolvedLayer, matrix: Affine) {
        let ResolvedKind::Shape { geometry, fill, stroke, style } = &layer.kind else {
            return;
        };
        canvas.save();
        canvas.concat(&mat(matrix));
        let white = ResolvedPaint::Solid(WHITE);
        let stroke = stroke.as_ref().map(|(_, width)| (WHITE, *width));
        self.draw_shape(
            canvas,
            layer,
            geometry,
            fill.as_ref().map(|_| &white),
            stroke.as_ref(),
            style,
            Comp { alpha: 1.0, blend: SkBlend::SrcOver },
        );
        canvas.restore();
    }

    /// `path` (layer space) in opaque white: its alpha is the clip's coverage.
    pub fn raster_clip(&mut self, canvas: &Canvas, path: &BezPath, matrix: Affine) {
        canvas.save();
        canvas.concat(&mat(matrix));
        let mut p = Paint::default();
        p.set_anti_alias(true);
        p.set_color4f(Color4f::new(1.0, 1.0, 1.0, 1.0), None);
        canvas.draw_path(&bez_to_path(path, false), &p);
        self.stats.draws += 1;
        canvas.restore();
    }

    /// The mask's gradient over the whole clip, laid out in the layer's box (or in layer space) under `matrix`.
    pub fn raster_mask(&mut self, canvas: &Canvas, layer: &ResolvedLayer, mask: &crate::resolve::ResolvedMask, matrix: Affine) {
        canvas.save();
        canvas.concat(&mat(matrix));
        let mut p = Paint::default();
        let layer_box = self.layer_box(layer);
        p.set_shader(gradient_shader_for(&mask.gradient, layer_box, self.linear(), true));
        canvas.draw_paint(&p);
        self.stats.draws += 1;
        canvas.restore();
    }

    /// Starts a group's clip: what follows, up to the matching `raster_pop`, is cut by `path`.
    pub fn raster_push_clip(&mut self, canvas: &Canvas, path: &BezPath, matrix: Affine) {
        canvas.save();
        canvas.concat(&mat(matrix));
        canvas.clip_path(&bez_to_path(path, false), ClipOp::Intersect, true);
    }

    pub fn raster_pop(&mut self, canvas: &Canvas) {
        canvas.restore();
    }
}
