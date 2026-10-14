//! Scene -> pixels. Vello rasterises each leaf layer into an sRGB texture;
//! the compositor blends them in linear light.

use std::collections::HashMap;
use std::time::Instant;

use image::{ExtendedColorType, ImageEncoder, codecs::png::PngEncoder};
use vello::kurbo::{Affine, BezPath, Ellipse, Rect, RoundedRect, Shape, Stroke};
use vello::peniko::{self, Blob, Fill, ImageAlphaType, ImageData, ImageFormat};
use vello::util::RenderContext;
use vello::wgpu;
use vello::{AaConfig, AaSupport, RenderParams, RendererOptions};

use crate::color::Color;
use crate::compositor::{Compositor, Tex};
use crate::error::{Error, Result};
use crate::resolve::{ResolvedClip, ResolvedGeometry, ResolvedKind, ResolvedLayer, ResolvedScene};
use crate::scene::{LayerKind, Scene};
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
        let vello_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("vello target"),
            size: wgpu::Extent3d {
                width: scene.width,
                height: scene.height,
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
        let compositor = Compositor::new(&device, &queue, scene.width, scene.height);

        Ok(Renderer {
            scene,
            _context: context,
            device,
            queue,
            vello,
            vello_images,
            vello_scene: vello::Scene::new(),
            vello_view,
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
        let color = linear_premultiplied(scene.background);
        let background = self.timed(Stage::Composite, |s| s.compositor.filled(color));
        let canvas = self.draw_layers(&scene.layers, Affine::IDENTITY, background)?;
        let rgba = self.timed(Stage::Readback, |s| s.compositor.read_rgba8(&canvas))?;
        self.compositor.release(canvas);
        Ok(Frame {
            width: scene.width,
            height: scene.height,
            rgba,
        })
    }

    /// Blends `layers` (bottom first) onto `canvas`. `parent` is the product
    /// of the enclosing groups' matrices.
    fn draw_layers(
        &mut self,
        layers: &[ResolvedLayer],
        parent: Affine,
        mut canvas: Tex,
    ) -> Result<Tex> {
        for layer in layers {
            if layer.opacity <= 0.0 {
                continue;
            }
            let src = self.layer_texture(layer, parent)?;
            canvas = self.timed(Stage::Composite, |s| {
                s.compositor
                    .blend(canvas, src, layer.opacity, layer.blend_mode)
            });
        }
        Ok(canvas)
    }

    /// One layer's own pixels, ready to blend: drawn, then run through its
    /// effects and its clip, in that order.
    fn layer_texture(&mut self, layer: &ResolvedLayer, parent: Affine) -> Result<Tex> {
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
                s.compositor.mask_with_alpha(src, &s.vello_view)
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
                if let Some(color) = fill {
                    self.vello_scene
                        .fill(Fill::NonZero, matrix, to_peniko(*color), None, &path);
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
                for run in &laid_out.runs {
                    self.vello_scene
                        .draw_glyphs(&run.font)
                        .transform(matrix)
                        .font_size(run.font_size)
                        .hint(false)
                        .brush(to_peniko(*color))
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
                    width: self.scene.width,
                    height: self.scene.height,
                    antialiasing_method: AaConfig::Msaa16,
                },
            )
            .map_err(|e| Error::Render(format!("Vello render failed: {e}")))
    }
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

/// sRGB 8-bit colour to linear, premultiplied RGBA for the compositor.
fn linear_premultiplied(c: Color) -> [f64; 4] {
    let lin = |v: u8| {
        let v = f64::from(v) / 255.0;
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    };
    let a = f64::from(c.a) / 255.0;
    [lin(c.r) * a, lin(c.g) * a, lin(c.b) * a, a]
}

/// Decodes every image the scene refers to, so a missing file fails early.
fn load_images(scene: &Scene) -> Result<HashMap<String, ImageData>> {
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
}
