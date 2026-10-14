//! Scene -> pixels. Vello rasterises each leaf layer into an sRGB texture;
//! the compositor blends them in linear light.

use std::collections::HashMap;
use std::time::Instant;

use image::{ExtendedColorType, ImageEncoder, codecs::png::PngEncoder};
use vello::kurbo::{Affine, BezPath, Ellipse, Point, Rect, RoundedRect, Shape, Stroke};
use vello::peniko::{self, Blob, Fill, ImageAlphaType, ImageData, ImageFormat};
use vello::util::RenderContext;
use vello::wgpu;
use vello::{AaConfig, AaSupport, RenderParams, RendererOptions};

use crate::color::Color;
use crate::compositor::{Compositor, Tex};
use crate::error::{Error, Result};
use crate::resolve::{
    ResolvedClip, ResolvedGeometry, ResolvedGradient, ResolvedGradientGeometry, ResolvedKind,
    ResolvedLayer, ResolvedMask, ResolvedPaint, ResolvedScene,
};
use crate::scene::{Extend, LayerKind, MaskMode, Scene};
use crate::text::TextEngine;

/// Curve flattening tolerance when converting shapes to paths.
const SHAPE_TOLERANCE: f64 = 0.1;

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

/// GPU state for one scene. Reuse it to render more than one frame.
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
    compositor: Compositor,
    text: TextEngine,
    images: HashMap<String, ImageData>,
    /// `Some` while `render_timed` runs.
    timings: Option<Timings>,
}

impl Renderer {
    pub fn new(scene: Scene) -> Result<Renderer> {
        // Fonts first: nothing is measured before they are registered.
        let text = TextEngine::new(&scene.fonts, &scene.base_dir)?;
        let images = load_images(&scene)?;

        let mut context = RenderContext::new();
        let id = pollster::block_on(context.device(None))
            .ok_or_else(|| Error::Render("no compatible GPU adapter found".into()))?;
        let device = context.devices[id].device.clone();
        let queue = context.devices[id].queue.clone();

        let vello = new_vello(&device)?;
        let vello_images = if images.is_empty() {
            None
        } else {
            Some(new_vello(&device)?)
        };
        let margin = scene.margin();
        let target_size = (scene.width + 2 * margin, scene.height + 2 * margin);
        let vello_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("vello target"),
            size: wgpu::Extent3d {
                width: target_size.0,
                height: target_size.1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let vello_view = vello_texture.create_view(&wgpu::TextureViewDescriptor::default());
        let compositor = Compositor::new(&device, &queue, scene.width, scene.height, margin);

        Ok(Renderer {
            scene,
            _context: context,
            device,
            queue,
            vello,
            vello_images,
            vello_scene: vello::Scene::new(),
            vello_view,
            target_size,
            margin,
            compositor,
            text,
            images,
            timings: None,
        })
    }

    pub fn render_frame(&mut self, frame: u32) -> Result<Frame> {
        let resolved = self.scene.resolve(frame)?;
        self.render_resolved(&resolved)
    }

    /// Like `render_frame`, but also reports where the time went. To make
    /// each stage's number include the GPU's work and not just the submit,
    /// this waits for the GPU after every step, so it is slower than
    /// `render_frame`; use `render_frame` to time the whole frame.
    pub fn render_timed(&mut self, frame: u32) -> Result<(Frame, Timings)> {
        let start = Instant::now();
        let resolved = self.scene.resolve(frame)?;
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
        let color = scene.background.linear_premultiplied();
        let background = self.timed(Stage::Composite, |s| s.compositor.filled(color));
        let canvas = self.draw_layers(&scene.layers, margin_origin(self.margin), background)?;
        let rgba = self.timed(Stage::Readback, |s| s.compositor.read_rgba8(&canvas))?;
        self.compositor.release(canvas);
        Ok(Frame {
            width: scene.width,
            height: scene.height,
            rgba,
        })
    }

    /// Blends `layers` (bottom first) onto `canvas`. `parent` is the product
    /// of the enclosing groups' matrices, starting from the margin offset.
    fn draw_layers(
        &mut self,
        layers: &[ResolvedLayer],
        parent: Affine,
        mut canvas: Tex,
    ) -> Result<Tex> {
        for layer in layers {
            // A matte source is only drawn through the layer it mattes.
            if layer.opacity <= 0.0 || is_matte_source(layers, layer) {
                continue;
            }
            let src = self.layer_texture(layer, layers, parent)?;
            canvas = self.timed(Stage::Composite, |s| {
                s.compositor
                    .blend(canvas, src, layer.opacity, layer.blend_mode)
            });
        }
        Ok(canvas)
    }

    /// One layer's own pixels, ready to blend: drawn, then run through its
    /// effects, clip, mask and matte, in that order. `siblings` is the list
    /// `layer` is in, where its matte source is found.
    fn layer_texture(
        &mut self,
        layer: &ResolvedLayer,
        siblings: &[ResolvedLayer],
        parent: Affine,
    ) -> Result<Tex> {
        let src = match &layer.kind {
            ResolvedKind::Group { children } => {
                let empty = self.timed(Stage::Composite, |s| s.compositor.filled([0.0; 4]));
                self.draw_layers(children, parent * layer.transform.matrix(), empty)?
            }
            _ => {
                self.timed(Stage::Raster, |s| s.rasterise(layer, parent))?;
                self.timed(Stage::Composite, |s| s.compositor.from_srgb8(&s.vello_view))
            }
        };
        let mut src = self.timed(Stage::Composite, |s| {
            s.compositor.apply_effects(src, &layer.effects)
        });
        if let Some(clip) = &layer.clip {
            let matrix = parent * layer.transform.matrix();
            self.timed(Stage::Raster, |s| s.rasterise_clip(clip, layer, matrix))?;
            src = self.timed(Stage::Composite, |s| {
                s.compositor.mask(src, &s.vello_view, MaskMode::Alpha)
            });
        }
        if let Some(mask) = &layer.mask {
            let matrix = parent * layer.transform.matrix();
            self.timed(Stage::Raster, |s| s.rasterise_mask(mask, matrix))?;
            src = self.timed(Stage::Composite, |s| {
                s.compositor.mask(src, &s.vello_view, mask.mode)
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
            // The source cannot have a matte (checked at load), so this
            // recursion is one level deep.
            let matte_tex = self.layer_texture(source, siblings, parent)?;
            src = self.timed(Stage::Composite, |s| {
                s.compositor
                    .matte(src, matte_tex, source.opacity, matte.mode)
            });
        }
        Ok(src)
    }

    /// Draws one leaf layer, with all transforms applied, into the Vello
    /// target texture.
    fn rasterise(&mut self, layer: &ResolvedLayer, parent: Affine) -> Result<()> {
        let matrix = parent * layer.transform.matrix();
        self.vello_scene.reset();
        match &layer.kind {
            ResolvedKind::Shape {
                geometry,
                fill,
                stroke,
            } => {
                let path = geometry_path(geometry)?;
                if let Some(paint) = fill {
                    let (brush, brush_transform) = paint_brush(paint);
                    self.vello_scene
                        .fill(Fill::NonZero, matrix, &brush, brush_transform, &path);
                }
                if let Some((color, width)) = stroke {
                    self.vello_scene.stroke(
                        &Stroke::new(*width),
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
            } => {
                let laid_out = self
                    .text
                    .layout(text, font, *size, *line_height, *max_width);
                let (brush, brush_transform) = paint_brush(color);
                for run in &laid_out.runs {
                    self.vello_scene
                        .draw_glyphs(&run.font)
                        .transform(matrix)
                        .brush_transform(brush_transform)
                        .font_size(run.font_size)
                        .hint(false)
                        .brush(&brush)
                        .draw(
                            Fill::NonZero,
                            run.glyphs.iter().map(|g| vello::Glyph {
                                id: g.id,
                                x: g.x,
                                y: g.y,
                            }),
                        );
                }
            }
            ResolvedKind::Image { src, width, height } => {
                let image = &self.images[src];
                let fit = Affine::scale_non_uniform(
                    width / f64::from(image.width),
                    height / f64::from(image.height),
                );
                self.vello_scene.draw_image(image, matrix * fit);
            }
            ResolvedKind::Group { .. } => unreachable!("groups are composited, not rasterised"),
        }
        self.render_vello_scene(matches!(layer.kind, ResolvedKind::Image { .. }))
    }

    /// Draws the layer's clip shape in opaque white into the Vello target;
    /// its alpha is then the clip's coverage.
    fn rasterise_clip(
        &mut self,
        clip: &ResolvedClip,
        layer: &ResolvedLayer,
        matrix: Affine,
    ) -> Result<()> {
        let path = self.clip_path(clip, layer)?;
        self.vello_scene.reset();
        self.vello_scene
            .fill(Fill::NonZero, matrix, peniko::Color::WHITE, None, &path);
        self.render_vello_scene(false)
    }

    /// Fills the whole target (canvas and margin) with the mask's gradient,
    /// which lives in layer space, into the Vello target.
    fn rasterise_mask(&mut self, mask: &ResolvedMask, matrix: Affine) -> Result<()> {
        let (brush, brush_transform) = gradient_brush(&mask.gradient);
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
        self.render_vello_scene(false)
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
    /// from. A group has none.
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
                ..
            } => {
                let laid_out = self
                    .text
                    .layout(text, font, *size, *line_height, *max_width);
                let width = max_width.unwrap_or(laid_out.width);
                Some(Rect::new(
                    0.0,
                    0.0,
                    f64::from(width),
                    f64::from(laid_out.height),
                ))
            }
            ResolvedKind::Image { width, height, .. } => Some(Rect::new(0.0, 0.0, *width, *height)),
            ResolvedKind::Group { .. } => None,
        })
    }

    /// Renders `vello_scene` into the Vello target texture. Image layers
    /// use their own renderer (see `vello_images`).
    fn render_vello_scene(&mut self, has_images: bool) -> Result<()> {
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
                &self.vello_view,
                &RenderParams {
                    base_color: peniko::Color::TRANSPARENT,
                    width: self.target_size.0,
                    height: self.target_size.1,
                    antialiasing_method: AaConfig::Msaa16,
                },
            )
            .map_err(|e| Error::Render(format!("Vello render failed: {e}")))
    }
}

/// Where the canvas's top-left corner sits in the padded textures: `margin`
/// pixels in from the corner. Every layer is drawn inside this transform. At
/// margin 0 it is bit for bit `Affine::IDENTITY`.
fn margin_origin(margin: u32) -> Affine {
    Affine::translate((f64::from(margin), f64::from(margin)))
}

/// Whether another layer in `layers` uses `layer` as its matte.
fn is_matte_source(layers: &[ResolvedLayer], layer: &ResolvedLayer) -> bool {
    layers
        .iter()
        .any(|l| l.matte.as_ref().is_some_and(|m| m.layer == layer.id))
}

/// The brush for a fill or text colour, and the transform to apply to it on
/// top of the transform of whatever it paints (`None` for a solid colour).
fn paint_brush(paint: &ResolvedPaint) -> (peniko::Brush, Option<Affine>) {
    match paint {
        ResolvedPaint::Solid(color) => (peniko::Brush::Solid(to_peniko(*color)), None),
        ResolvedPaint::Gradient(g) => {
            let (brush, brush_transform) = gradient_brush(g);
            (brush, Some(brush_transform))
        }
    }
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
fn gradient_brush(g: &ResolvedGradient) -> (peniko::Brush, Affine) {
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

fn to_peniko(c: Color) -> peniko::Color {
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

/// Decodes every image the scene refers to, so a missing file fails early.
pub(crate) fn load_images(scene: &Scene) -> Result<HashMap<String, ImageData>> {
    fn walk(layers: &[crate::scene::Layer], out: &mut Vec<String>) {
        for layer in layers {
            match &layer.kind {
                LayerKind::Image(i) => out.push(i.src.clone()),
                LayerKind::Group(g) => walk(&g.children, out),
                _ => {}
            }
        }
    }
    let mut sources = Vec::new();
    walk(&scene.layers, &mut sources);

    let mut images = HashMap::new();
    for src in sources {
        if images.contains_key(&src) {
            continue;
        }
        let path = scene.base_dir.join(&src);
        let decoded = image::open(&path)
            .map_err(|e| Error::Render(format!("cannot decode {}: {e}", path.display())))?
            .to_rgba8();
        let (width, height) = decoded.dimensions();
        images.insert(
            src,
            ImageData {
                data: Blob::from(decoded.into_raw()),
                format: ImageFormat::Rgba8,
                alpha_type: ImageAlphaType::Alpha,
                width,
                height,
            },
        );
    }
    Ok(images)
}

#[cfg(test)]
mod tests {
    use super::*;
    use vello::peniko::GradientKind;

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
    fn no_margin_is_the_identity() {
        let bits = |a: Affine| a.as_coeffs().map(f64::to_bits);
        assert_eq!(bits(margin_origin(0)), bits(Affine::IDENTITY));
        assert_eq!(
            margin_origin(7) * Point::new(1.0, 2.0),
            Point::new(8.0, 9.0)
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
        let (brush, transform) = paint_brush(&ResolvedPaint::Solid(RED));
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
        let (brush, transform) = paint_brush(&ResolvedPaint::Gradient(g));
        assert!(matches!(brush, peniko::Brush::Gradient(_)));
        // The conic turn about its centre leaves the centre where it is.
        let moved = transform.unwrap() * Point::new(10.0, 20.0);
        assert!(moved.distance(Point::new(10.0, 20.0)) < 1e-9);
    }
}
