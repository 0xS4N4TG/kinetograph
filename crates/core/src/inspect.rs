//! A scene resolved at one frame, as plain data for agents that cannot look
//! at pixels: every layer's resolved transform, where it sits on the canvas,
//! what is applied to it and, for text, how it was laid out. Nothing here
//! touches the GPU; the fonts are loaded because text boxes need them, and
//! images and tables are not.
//!
//! The shape of the result is `InspectResult` in `docs/AUTHORING.md` §3.

use std::fmt::Debug;

use glam::{DMat3, DMat4, DVec3};
use serde::Serialize;
use vello::kurbo::{Affine, BezPath, Point, Rect, Shape, Vec2};

use crate::bounds;
use crate::error::Result;
use crate::resolve::{
    ResolvedClip, ResolvedEffect, ResolvedGeometry, ResolvedKind, ResolvedLayer, ResolvedScene,
};
use crate::scene::{Effect, Layer, LayerKind, Scene};
use crate::text::{LaidOutText, TextEngine};
use crate::warp;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectResult {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration_in_frames: u32,
    pub frame: u32,
    pub margin: u32,
    pub camera: Option<InspectCamera>,
    /// Bottom first, as in the scene.
    pub layers: Vec<InspectLayer>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct InspectCamera {
    pub perspective: f64,
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct InspectRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectTransform {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub rotation: f64,
    pub anchor_x: f64,
    pub anchor_y: f64,
    pub rotate_x: f64,
    pub rotate_y: f64,
    pub z: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct InspectMatte {
    pub layer: String,
    pub mode: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct InspectMotionBlur {
    pub samples: u32,
    pub shutter: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct InspectLine {
    pub text: String,
    pub top: f64,
    pub bottom: f64,
    pub baseline: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectText {
    pub text: String,
    pub font: String,
    pub size: f64,
    /// Of the laid-out text. The layer's `box` is `maxWidth` wide when there
    /// is one.
    pub width: f64,
    pub height: f64,
    pub max_width: Option<f64>,
    pub lines: Vec<InspectLine>,
}

/// Where in its file a video or GIF layer is.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct InspectMedia {
    /// Seconds: for a video the source time of `docs/SCENE.md`'s "video"
    /// rules (from the stream's first picture), for a GIF its `time`.
    pub time: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectLayer {
    pub id: String,
    /// `shape`, `text`, `image`, `group`, `noise`, `meshGradient`, `lottie`,
    /// `video` or `gif`.
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub opacity: f64,
    pub blend_mode: String,
    pub transform: InspectTransform,
    /// Layer space to canvas pixels: `a b c d e f` of the 2D matrix, the
    /// product of the layer's and its ancestors'. Does not include the 3D
    /// turn (`transform.rotateX`, `rotateY`, `z`), which `bounds` does.
    pub matrix: [f64; 6],
    /// The layer's own box in layer space, the one `inset` clips are measured
    /// from. A group has none.
    #[serde(rename = "box")]
    pub layer_box: Option<InspectRect>,
    /// Where the layer's pixels can be, in canvas pixels: its box through
    /// its matrix (a group's children's bounds together), grown by the reach
    /// of its effects, then through its 3D placement and the camera. A
    /// stroke counts; a clip, mask and matte do not cut it. `None` for an
    /// empty group or a layer seen edge on.
    pub bounds: Option<InspectRect>,
    /// The type of each effect, in order.
    pub effects: Vec<&'static str>,
    pub clip: Option<&'static str>,
    /// Where the clip keeps pixels, as a box in canvas pixels placed like
    /// `bounds` (the shape's bounding box: a zero-area box when it keeps
    /// nothing). `None` without a clip, or for a clip seen edge on.
    pub clip_bounds: Option<InspectRect>,
    pub mask: bool,
    pub matte: Option<InspectMatte>,
    /// Another layer in the same list uses this one as its matte.
    pub matte_source: bool,
    pub motion_blur: Option<InspectMotionBlur>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<InspectText>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    /// A video's or GIF's time in the file (computed, nothing is decoded).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<InspectMedia>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<InspectLayer>>,
}

/// Resolves `scene` at `frame` and describes every layer. Errors if the frame
/// is out of range or a font cannot be loaded.
pub fn inspect(scene: &Scene, frame: u32) -> Result<InspectResult> {
    let mut text = TextEngine::new(&scene.fonts, &scene.base_dir)?;
    // The renderer's own resolve, flex layout included, so the transforms
    // and boxes reported are the laid-out ones.
    let resolved = scene.resolve_with_text(frame, &mut text)?;
    Ok(describe(scene, &resolved, &mut text))
}

/// The walk over the scene's layers and their resolved copies, which have
/// the same shape.
struct Walk<'a> {
    text: &'a mut TextEngine,
    /// The camera as a matrix on canvas pixels (no margin).
    projection: DMat4,
    t: f64,
}

/// Where a `preserve3d` group's children are (`render::Space3d`).
#[derive(Clone, Copy)]
struct Space {
    parent: Affine,
    flat: Affine,
    world: DMat4,
}

/// A layer's 3D placement: the matrix of the space it sits in and its `W`
/// (`warp.rs`).
#[derive(Clone, Copy)]
struct Placement {
    parent: Affine,
    world: DMat4,
}

fn describe(scene: &Scene, resolved: &ResolvedScene, text: &mut TextEngine) -> InspectResult {
    let mut walk = Walk {
        text,
        projection: warp::projection(resolved.camera.as_ref(), 0),
        t: f64::from(resolved.frame),
    };
    InspectResult {
        width: scene.width,
        height: scene.height,
        fps: scene.fps,
        duration_in_frames: scene.duration_in_frames,
        frame: resolved.frame,
        margin: scene.margin(),
        camera: resolved.camera.map(|c| InspectCamera {
            perspective: finite(c.perspective),
            x: finite(c.x),
            y: finite(c.y),
        }),
        layers: walk.layers(&scene.layers, &resolved.layers, Affine::IDENTITY, None),
    }
}

impl Walk<'_> {
    /// `layers` and their resolved copies, drawn under `parent` (the matrix
    /// of the enclosing groups); `space` is set when they are the children of
    /// a `preserve3d` group.
    fn layers(
        &mut self,
        layers: &[Layer],
        resolved: &[ResolvedLayer],
        parent: Affine,
        space: Option<Space>,
    ) -> Vec<InspectLayer> {
        layers
            .iter()
            .zip(resolved)
            .map(|(layer, r)| self.layer(layer, r, resolved, parent, space))
            .collect()
    }

    fn layer(
        &mut self,
        layer: &Layer,
        r: &ResolvedLayer,
        siblings: &[ResolvedLayer],
        parent: Affine,
        space: Option<Space>,
    ) -> InspectLayer {
        let matrix = parent * r.transform.matrix();
        let boxes = self.boxes(&r.kind);

        let (mut children, group_bounds) = match (&layer.kind, &r.kind) {
            (
                LayerKind::Group(g),
                ResolvedKind::Group {
                    children,
                    preserve3d,
                    ..
                },
            ) => {
                // A `preserve3d` group places its children itself.
                let inner = preserve3d.then(|| match space {
                    Some(space) => Space {
                        parent: space.parent,
                        flat: space.flat * r.transform.matrix(),
                        world: placement(r, parent, Some(space)).map_or(space.world, |p| p.world),
                    },
                    None => Space {
                        parent,
                        flat: r.transform.matrix(),
                        world: warp::layer_world(&r.transform).unwrap_or(DMat4::IDENTITY),
                    },
                });
                let nodes = self.layers(&g.children, children, matrix, inner);
                let union = nodes
                    .iter()
                    .filter_map(|n| n.bounds)
                    .map(Rect::from)
                    .reduce(|a, b| a.union(b));
                (Some(nodes), Some((union, *preserve3d)))
            }
            _ => (None, None),
        };

        let mut bounds = self.bounds(layer, r, matrix, &boxes, group_bounds, parent, space);
        let clip_bounds = self.clip_bounds(r, matrix, &boxes, parent, space);
        // A blurred layer is smeared over the places its samples are.
        for sample in &r.motion {
            let b = self.sample_bounds(layer, sample, parent, space);
            bounds = union_option(bounds, b);
        }
        // An ordinary group draws its children flat into its buffer and then
        // turns the buffer, so its children are seen where the turn takes
        // them. (A `preserve3d` group's children are placed one by one, which
        // `space` already did.)
        if let (Some(nodes), Some((_, false))) = (&mut children, group_bounds)
            && let Some(p) = placement(r, parent, space)
        {
            let h = warp::plane_homography(self.projection, p.parent, p.world);
            if !h.is_some_and(|h| warp::is_identity(&h)) {
                for node in nodes.iter_mut() {
                    warp_subtree(node, h);
                }
            }
        }

        InspectLayer {
            id: r.id.clone(),
            kind: kind_name(&layer.kind),
            opacity: finite(f64::from(r.opacity)),
            blend_mode: unit_name(&r.blend_mode),
            transform: InspectTransform {
                x: finite(r.transform.x),
                y: finite(r.transform.y),
                scale: finite(r.transform.scale),
                rotation: finite(r.transform.rotation),
                anchor_x: finite(r.transform.anchor_x),
                anchor_y: finite(r.transform.anchor_y),
                rotate_x: finite(r.transform.rotate_x),
                rotate_y: finite(r.transform.rotate_y),
                z: finite(r.transform.z),
            },
            matrix: matrix.as_coeffs().map(finite),
            layer_box: boxes.layer.and_then(rect_json),
            bounds: bounds.and_then(rect_json),
            effects: layer.effects.iter().map(effect_name).collect(),
            clip: r.clip.as_ref().map(|c| match c {
                ResolvedClip::Polygon { .. } => "polygon",
                ResolvedClip::Inset { .. } => "inset",
                ResolvedClip::Ellipse { .. } => "ellipse",
                ResolvedClip::Path { .. } => "path",
            }),
            clip_bounds: clip_bounds.and_then(rect_json),
            mask: r.mask.is_some(),
            matte: r.matte.as_ref().map(|m| InspectMatte {
                layer: m.layer.clone(),
                mode: unit_name(&m.mode),
            }),
            matte_source: siblings
                .iter()
                .any(|l| l.matte.as_ref().is_some_and(|m| m.layer == r.id)),
            motion_blur: layer.motion_blur.as_ref().map(|mb| InspectMotionBlur {
                samples: u32::try_from(mb.samples).unwrap_or(0),
                shutter: finite(
                    mb.shutter
                        .at(self.t)
                        .clamp(0.0, crate::resolve::MAX_SHUTTER),
                ),
            }),
            text: match (&r.kind, &boxes.laid_out) {
                (
                    ResolvedKind::Text {
                        text,
                        font,
                        size,
                        max_width,
                        ..
                    },
                    Some(laid_out),
                ) => Some(InspectText {
                    text: text.clone(),
                    font: font.clone(),
                    size: finite(f64::from(*size)),
                    width: finite(f64::from(laid_out.width)),
                    height: finite(f64::from(laid_out.height)),
                    max_width: max_width.map(|w| finite(f64::from(w))),
                    lines: laid_out
                        .lines
                        .iter()
                        .map(|line| InspectLine {
                            text: text
                                .get(line.text_range.clone())
                                .unwrap_or_default()
                                .trim_end_matches(['\n', '\r'])
                                .to_string(),
                            top: finite(f64::from(line.top)),
                            bottom: finite(f64::from(line.bottom)),
                            baseline: finite(f64::from(line.baseline)),
                        })
                        .collect(),
                }),
                _ => None,
            },
            src: match &r.kind {
                ResolvedKind::Image { src, .. }
                | ResolvedKind::Lottie { src, .. }
                | ResolvedKind::Video { src, .. }
                | ResolvedKind::Gif { src, .. } => Some(src.clone()),
                _ => None,
            },
            media: match &r.kind {
                ResolvedKind::Video { time, .. } => Some(InspectMedia {
                    time: finite(time.seconds),
                }),
                ResolvedKind::Gif { time, .. } => Some(InspectMedia {
                    time: finite(*time),
                }),
                _ => None,
            },
            children,
        }
    }

    /// The boxes of a leaf layer in layer space (and its text, laid out):
    /// `layer` is what `inset` clips use, `ink` also holds a stroke's width.
    fn boxes(&mut self, kind: &ResolvedKind) -> Boxes {
        match kind {
            ResolvedKind::Shape {
                geometry, stroke, ..
            } => {
                let shape = match geometry {
                    ResolvedGeometry::Rect { width, height }
                    | ResolvedGeometry::RoundedRect { width, height, .. }
                    | ResolvedGeometry::Ellipse { width, height } => {
                        Some(Rect::new(0.0, 0.0, *width, *height))
                    }
                    ResolvedGeometry::Path { d } => {
                        BezPath::from_svg(d).ok().map(|p| p.bounding_box())
                    }
                };
                let half = stroke.map_or(0.0, |(_, width)| width.max(0.0) / 2.0);
                Boxes {
                    layer: shape,
                    ink: shape.map(|b| b.inflate(half, half)),
                    laid_out: None,
                }
            }
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
                let width = max_width.unwrap_or(laid_out.width);
                let b = Rect::new(0.0, 0.0, f64::from(width), f64::from(laid_out.height));
                Boxes {
                    layer: Some(b),
                    ink: Some(b),
                    laid_out: Some(laid_out),
                }
            }
            ResolvedKind::Image { width, height, .. }
            | ResolvedKind::Noise { width, height, .. }
            | ResolvedKind::MeshGradient { width, height, .. }
            | ResolvedKind::Lottie { width, height, .. }
            | ResolvedKind::Video { width, height, .. }
            | ResolvedKind::Gif { width, height, .. } => {
                let b = Rect::new(0.0, 0.0, *width, *height);
                Boxes {
                    layer: Some(b),
                    ink: Some(b),
                    laid_out: None,
                }
            }
            // A group with a flex layout has the box the layout gave it.
            ResolvedKind::Group { size, .. } => {
                let b = size.map(|(width, height)| Rect::new(0.0, 0.0, width, height));
                Boxes {
                    layer: b,
                    ink: None,
                    laid_out: None,
                }
            }
        }
    }

    /// Where `r`'s pixels can be on the canvas (see `InspectLayer::bounds`).
    /// `group` is a group's children's bounds together and whether it is a
    /// `preserve3d` group, which has no placement or effects of its own.
    #[allow(clippy::too_many_arguments)]
    fn bounds(
        &self,
        layer: &Layer,
        r: &ResolvedLayer,
        matrix: Affine,
        boxes: &Boxes,
        group: Option<(Option<Rect>, bool)>,
        parent: Affine,
        space: Option<Space>,
    ) -> Option<Rect> {
        let flat = match (boxes.ink, group) {
            (Some(ink), _) => Some(bounds::transformed(matrix, ink)),
            (None, Some((_, true))) => return group.and_then(|(union, _)| union),
            (None, Some((union, false))) => union,
            (None, None) => None,
        }?;
        let grown = self.grow_by_effects(flat, layer, r, matrix);
        match placement(r, parent, space) {
            Some(p) => {
                let h = warp::plane_homography(self.projection, p.parent, p.world)?;
                if warp::is_identity(&h) {
                    Some(grown)
                } else {
                    warped(h, grown)
                }
            }
            None => Some(grown),
        }
    }

    /// Where `r`'s clip keeps pixels on the canvas (see
    /// `InspectLayer::clip_bounds`): the clip shape's bounding box in layer
    /// space, through the matrix and the 3D placement as `bounds` is.
    fn clip_bounds(
        &self,
        r: &ResolvedLayer,
        matrix: Affine,
        boxes: &Boxes,
        parent: Affine,
        space: Option<Space>,
    ) -> Option<Rect> {
        let local = match r.clip.as_ref()? {
            ResolvedClip::Polygon { points } => points
                .iter()
                .map(|&(x, y)| Point::new(x, y))
                .fold(None, |r: Option<Rect>, p| {
                    Some(r.map_or(Rect::from_points(p, p), |r| r.union_pt(p)))
                })?,
            ResolvedClip::Inset {
                top,
                right,
                bottom,
                left,
                ..
            } => {
                let b = boxes.layer?;
                let (x0, y0) = (b.x0 + left, b.y0 + top);
                // Sides that cross keep nothing.
                Rect::new(x0, y0, (b.x1 - right).max(x0), (b.y1 - bottom).max(y0))
            }
            ResolvedClip::Ellipse { cx, cy, rx, ry } => {
                if *rx <= 0.0 || *ry <= 0.0 {
                    Rect::new(*cx, *cy, *cx, *cy)
                } else {
                    Rect::new(cx - rx, cy - ry, cx + rx, cy + ry)
                }
            }
            ResolvedClip::Path { d } => BezPath::from_svg(d).ok()?.bounding_box(),
        };
        let flat = bounds::transformed(matrix, local);
        match placement(r, parent, space) {
            Some(p) => {
                let h = warp::plane_homography(self.projection, p.parent, p.world)?;
                if warp::is_identity(&h) {
                    Some(flat)
                } else {
                    warped(h, flat)
                }
            }
            None => Some(flat),
        }
    }

    /// `bounds` for one sample of a motion-blurred layer, whole subtree
    /// included.
    fn sample_bounds(
        &mut self,
        layer: &Layer,
        r: &ResolvedLayer,
        parent: Affine,
        space: Option<Space>,
    ) -> Option<Rect> {
        let matrix = parent * r.transform.matrix();
        let boxes = self.boxes(&r.kind);
        let group = match (&layer.kind, &r.kind) {
            (
                LayerKind::Group(g),
                ResolvedKind::Group {
                    children,
                    preserve3d,
                    ..
                },
            ) => {
                let mut union = None;
                for (child, rc) in g.children.iter().zip(children) {
                    // The children of a `preserve3d` group are placed by it;
                    // a sample is taken flat there.
                    let b = self.sample_bounds(child, rc, matrix, None);
                    union = union_option(union, b);
                }
                Some((union, *preserve3d))
            }
            _ => None,
        };
        self.bounds(layer, r, matrix, &boxes, group, parent, space)
    }

    /// `b` grown to hold what `r`'s effects paint outside it.
    fn grow_by_effects(&self, b: Rect, layer: &Layer, r: &ResolvedLayer, matrix: Affine) -> Rect {
        let mut b = b;
        for effect in &r.effects {
            b = match effect {
                // A blur's tails: three standard deviations.
                ResolvedEffect::Blur { radius } => inflate(b, 3.0 * f64::from(*radius)),
                ResolvedEffect::Glow(glow) => inflate(b, 3.0 * f64::from(glow.radius)),
                ResolvedEffect::ChromaticAberration { amount, .. } => {
                    inflate(b, f64::from(amount.abs()))
                }
                ResolvedEffect::DropShadow(shadow) => {
                    let reach = f64::from(shadow.spread.max(0.0)) + 3.0 * f64::from(shadow.blur);
                    let cast =
                        inflate(b, reach) + Vec2::new(f64::from(shadow.x), f64::from(shadow.y));
                    b.union(cast)
                }
                ResolvedEffect::Displace(d) => inflate(
                    b,
                    bounds::max_stretch(matrix) * f64::from(d.scale.abs()) / 2.0,
                ),
                // Painted inside the layer, or recolouring what is there.
                ResolvedEffect::BackdropBlur { .. }
                | ResolvedEffect::InsetShadow(_)
                | ResolvedEffect::ColorMatrix(_)
                | ResolvedEffect::GradientMap(_)
                | ResolvedEffect::Lut { .. }
                | ResolvedEffect::Grain(_)
                | ResolvedEffect::Dither(_)
                | ResolvedEffect::Halftone(_)
                | ResolvedEffect::DotMatrix(_)
                | ResolvedEffect::CornerPin(_)
                | ResolvedEffect::FilterGraph(_)
                | ResolvedEffect::Shader(_) => b,
            };
        }
        // A shader says how far it paints (its `padding`); the resolved
        // effect does not keep it.
        for effect in &layer.effects {
            if let Effect::Shader(shader) = effect {
                b = inflate(b, shader.padding.at(self.t).max(0.0));
            }
            // A filter graph moves pixels as far as its offsets and
            // displacements say; its region is not known without the box.
            if let Effect::FilterGraph(graph) = effect {
                b = inflate(b, graph.reach(bounds::max_stretch(matrix)));
            }
        }
        b
    }
}

#[derive(Default)]
struct Boxes {
    layer: Option<Rect>,
    ink: Option<Rect>,
    laid_out: Option<LaidOutText>,
}

/// How `r` is moved in 3D: by its own turn in a flat list, and, in a
/// `preserve3d` group's, by the accumulated one (`render::collect_preserve3d`).
fn placement(r: &ResolvedLayer, parent: Affine, space: Option<Space>) -> Option<Placement> {
    match space {
        Some(space) => Some(Placement {
            parent: space.parent,
            world: match warp::layer_world(&r.transform) {
                Some(own) => warp::child_world(space.world, space.flat, own),
                None => space.world,
            },
        }),
        None => warp::layer_world(&r.transform).map(|world| Placement { parent, world }),
    }
}

/// Moves the bounds of `node` and everything in it through `h`, the turn of
/// a group it is drawn inside; `None` (the group is seen edge on) leaves
/// nothing to see.
fn warp_subtree(node: &mut InspectLayer, h: Option<DMat3>) {
    node.bounds = match (node.bounds, h) {
        (Some(b), Some(h)) => warped(h, b.into()).and_then(rect_json),
        _ => None,
    };
    node.clip_bounds = match (node.clip_bounds, h) {
        (Some(b), Some(h)) => warped(h, b.into()).and_then(rect_json),
        _ => None,
    };
    for child in node.children.iter_mut().flatten() {
        warp_subtree(child, h);
    }
}

/// The box of `r` seen through the homography `h`, or `None` if any corner is
/// at or behind the eye.
fn warped(h: DMat3, r: Rect) -> Option<Rect> {
    let mut out: Option<Rect> = None;
    for (x, y) in [(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1)] {
        let v = h * DVec3::new(x, y, 1.0);
        if v.z.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
            return None;
        }
        let p = Point::new(v.x / v.z, v.y / v.z);
        out = Some(match out {
            Some(r) => r.union_pt(p),
            None => Rect::from_points(p, p),
        });
    }
    out
}

fn inflate(r: Rect, by: f64) -> Rect {
    r.inflate(by, by)
}

fn union_option(a: Option<Rect>, b: Option<Rect>) -> Option<Rect> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.union(b)),
        (a, None) => a,
        (None, b) => b,
    }
}

impl From<InspectRect> for Rect {
    fn from(r: InspectRect) -> Rect {
        Rect::new(r.x, r.y, r.x + r.width, r.y + r.height)
    }
}

/// `None` when a side is not a number.
fn rect_json(r: Rect) -> Option<InspectRect> {
    [r.x0, r.y0, r.x1, r.y1]
        .iter()
        .all(|v| v.is_finite())
        .then(|| InspectRect {
            x: r.x0,
            y: r.y0,
            width: r.width(),
            height: r.height(),
        })
}

/// JSON has no infinities or NaN.
fn finite(v: f64) -> f64 {
    if v.is_finite() { v } else { 0.0 }
}

/// A unit variant's name as the scene spells it: camelCase.
fn unit_name(value: &impl Debug) -> String {
    let name = format!("{value:?}");
    let mut chars = name.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().chain(chars).collect(),
        None => name,
    }
}

fn kind_name(kind: &LayerKind) -> &'static str {
    match kind {
        LayerKind::Shape(_) => "shape",
        LayerKind::Text(_) => "text",
        LayerKind::Image(_) => "image",
        LayerKind::Group(_) => "group",
        LayerKind::Noise(_) => "noise",
        LayerKind::MeshGradient(_) => "meshGradient",
        LayerKind::Lottie(_) => "lottie",
        LayerKind::Video(_) => "video",
        LayerKind::Gif(_) => "gif",
    }
}

/// The `type` of an effect, as the scene spells it.
fn effect_name(effect: &Effect) -> &'static str {
    match effect {
        Effect::Blur { .. } => "blur",
        Effect::BackdropBlur { .. } => "backdropBlur",
        Effect::Glow { .. } => "glow",
        Effect::ChromaticAberration { .. } => "chromaticAberration",
        Effect::DropShadow(_) => "dropShadow",
        Effect::InsetShadow(_) => "insetShadow",
        Effect::Saturate { .. } => "saturate",
        Effect::Contrast { .. } => "contrast",
        Effect::Brightness { .. } => "brightness",
        Effect::Grayscale { .. } => "grayscale",
        Effect::Sepia { .. } => "sepia",
        Effect::Invert { .. } => "invert",
        Effect::HueRotate { .. } => "hueRotate",
        Effect::GradientMap { .. } => "gradientMap",
        Effect::Lut { .. } => "lut",
        Effect::Grain { .. } => "grain",
        Effect::Dither { .. } => "dither",
        Effect::Halftone { .. } => "halftone",
        Effect::DotMatrix { .. } => "dotMatrix",
        Effect::Displace { .. } => "displace",
        Effect::CornerPin { .. } => "cornerPin",
        Effect::FilterGraph(_) => "filterGraph",
        Effect::Shader(_) => "shader",
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::{Value, json};

    use super::*;

    fn scene(layers: Value) -> Scene {
        scene_with(json!({}), layers)
    }

    fn scene_with(extra: Value, layers: Value) -> Scene {
        let mut doc = json!({
            "width": 400, "height": 300, "fps": 30, "durationInFrames": 60,
            "fonts": { "DM Sans": "assets/fonts/DMSans-Medium.ttf" },
            "layers": layers,
        });
        for (k, v) in extra.as_object().unwrap() {
            doc[k] = v.clone();
        }
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        Scene::from_json(&doc.to_string(), root).unwrap()
    }

    fn rect(id: &str, extra: Value) -> Value {
        let mut layer = json!({
            "id": id, "type": "shape",
            "shape": { "kind": "rect", "width": 100, "height": 50 },
            "fill": "#ffffff",
        });
        for (k, v) in extra.as_object().unwrap() {
            layer[k] = v.clone();
        }
        layer
    }

    fn bounds_of(l: &InspectLayer) -> (f64, f64, f64, f64) {
        let b = l.bounds.expect("bounds");
        (b.x, b.y, b.width, b.height)
    }

    fn close(a: (f64, f64, f64, f64), b: (f64, f64, f64, f64)) {
        let near = |x: f64, y: f64| (x - y).abs() < 1e-6;
        assert!(
            near(a.0, b.0) && near(a.1, b.1) && near(a.2, b.2) && near(a.3, b.3),
            "{a:?} vs {b:?}"
        );
    }

    #[test]
    fn describes_a_shape_under_its_transform() {
        let s = scene(json!([rect(
            "card",
            json!({ "transform": { "x": 40, "y": 30, "scale": 2 }, "opacity": 0.5,
                    "blendMode": "softLight" })
        )]));
        let result = inspect(&s, 0).unwrap();
        assert_eq!(
            (result.width, result.height, result.frame, result.margin),
            (400, 300, 0, 0)
        );
        assert!(result.camera.is_none());
        let card = &result.layers[0];
        assert_eq!((card.id.as_str(), card.kind), ("card", "shape"));
        assert_eq!((card.opacity, card.blend_mode.as_str()), (0.5, "softLight"));
        assert_eq!(card.matrix, [2.0, 0.0, 0.0, 2.0, 40.0, 30.0]);
        let b = card.layer_box.unwrap();
        assert_eq!((b.x, b.y, b.width, b.height), (0.0, 0.0, 100.0, 50.0));
        close(bounds_of(card), (40.0, 30.0, 200.0, 100.0));
        assert!(card.effects.is_empty() && card.clip.is_none() && !card.mask);
    }

    #[test]
    fn a_frame_out_of_range_is_an_error() {
        let s = scene(json!([rect("a", json!({}))]));
        assert!(matches!(
            inspect(&s, 60),
            Err(crate::Error::FrameOutOfRange { frame: 60, .. })
        ));
    }

    #[test]
    fn animated_values_are_resolved_at_the_frame() {
        let s = scene(json!([rect(
            "a",
            json!({ "transform": { "x": [
                { "frame": 0, "value": 0 }, { "frame": 20, "value": 100 }] } })
        )]));
        let at = |frame| inspect(&s, frame).unwrap().layers[0].transform.x;
        assert_eq!((at(0), at(10), at(20), at(40)), (0.0, 50.0, 100.0, 100.0));
    }

    #[test]
    fn groups_compose_matrices_and_union_their_children() {
        let s = scene(json!([{
            "id": "g", "type": "group", "transform": { "x": 100, "y": 10 },
            "children": [
                rect("a", json!({})),
                rect("b", json!({ "transform": { "x": 200, "y": 100 } })),
            ]
        }]));
        let result = inspect(&s, 0).unwrap();
        let g = &result.layers[0];
        assert_eq!(g.kind, "group");
        assert!(g.layer_box.is_none());
        let children = g.children.as_ref().unwrap();
        assert_eq!(children[1].matrix, [1.0, 0.0, 0.0, 1.0, 300.0, 110.0]);
        close(bounds_of(&children[0]), (100.0, 10.0, 100.0, 50.0));
        close(bounds_of(g), (100.0, 10.0, 300.0, 150.0));
    }

    #[test]
    fn effects_widen_the_bounds() {
        let shadow = json!({ "type": "dropShadow", "x": 10, "y": 20, "blur": 4, "spread": 2,
                             "color": "#000000" });
        let s = scene(json!([
            rect("shadowed", json!({ "effects": [shadow] })),
            rect(
                "blurred",
                json!({ "effects": [{ "type": "blur", "radius": 5 }] })
            ),
            rect(
                "graded",
                json!({ "effects": [{ "type": "saturate", "amount": 0.5 }] })
            ),
        ]));
        let result = inspect(&s, 0).unwrap();
        // The shadow is the layer inflated by spread + 3 blur = 14 and moved
        // by (10, 20): x from -4 to 124, y from 6 to 84; with the layer
        // itself, which starts at 0.
        close(bounds_of(&result.layers[0]), (-4.0, 0.0, 128.0, 84.0));
        close(bounds_of(&result.layers[1]), (-15.0, -15.0, 130.0, 80.0));
        close(bounds_of(&result.layers[2]), (0.0, 0.0, 100.0, 50.0));
        assert_eq!(result.layers[0].effects, ["dropShadow"]);
        assert_eq!(result.layers[1].effects, ["blur"]);
        assert_eq!(result.layers[2].effects, ["saturate"]);
        // The shadow's reach is also the scene's margin.
        assert!(result.margin > 0);
    }

    #[test]
    fn strokes_clips_masks_mattes_and_motion_blur_are_reported() {
        let s = scene(json!([
            rect("source", json!({})),
            rect(
                "kept",
                json!({
                    "stroke": { "color": "#ff0000", "width": 10 },
                    "clip": { "kind": "inset", "top": 1, "right": 1, "bottom": 1, "left": 1 },
                    "mask": { "gradient": { "type": "linear", "x0": 0, "y0": 0, "x1": 0, "y1": 50,
                        "stops": [{ "offset": 0, "color": "#ffffff" },
                                  { "offset": 1, "color": "#00000000" }] },
                        "mode": "luminance" },
                    "matte": { "layer": "source", "mode": "alphaInverted" },
                    "motionBlur": { "samples": 4, "shutter": 0.5 },
                })
            ),
        ]));
        let result = inspect(&s, 0).unwrap();
        assert!(result.layers[0].matte_source && !result.layers[1].matte_source);
        let kept = &result.layers[1];
        // The box is the shape's; the bounds include half the stroke.
        assert_eq!(kept.layer_box.unwrap().width, 100.0);
        close(bounds_of(kept), (-5.0, -5.0, 110.0, 60.0));
        assert_eq!(kept.clip, Some("inset"));
        assert!(kept.mask);
        let matte = kept.matte.as_ref().unwrap();
        assert_eq!(
            (matte.layer.as_str(), matte.mode.as_str()),
            ("source", "alphaInverted")
        );
        let blur = kept.motion_blur.unwrap();
        assert_eq!((blur.samples, blur.shutter), (4, 0.5));
    }

    #[test]
    fn a_clip_reports_where_it_keeps_pixels_on_the_canvas() {
        let s = scene(json!([
            rect("none", json!({})),
            rect(
                "inset",
                json!({
                    "transform": { "x": 200, "y": 100 },
                    "clip": { "kind": "inset", "left": 10, "top": 5, "right": 20, "bottom": 5 },
                })
            ),
            rect(
                "crossed",
                json!({ "clip": { "kind": "inset", "left": 60, "right": 60 } })
            ),
            rect(
                "empty",
                json!({ "clip": { "kind": "ellipse", "cx": 50, "cy": 25, "rx": 0, "ry": 10 } })
            ),
            {
                "id": "group", "type": "group",
                "transform": { "x": 300, "y": 10 },
                "clip": { "kind": "polygon", "points": [[0, 0], [40, 0], [20, 30]] },
                "children": [rect("inner", json!({}))],
            },
        ]));
        let layers = inspect(&s, 0).unwrap().layers;
        let clip = |l: &InspectLayer| {
            let b = l.clip_bounds.expect("clip bounds");
            (b.x, b.y, b.width, b.height)
        };
        assert!(layers[0].clip_bounds.is_none());
        close(clip(&layers[1]), (210.0, 105.0, 70.0, 40.0));
        assert_eq!(clip(&layers[2]).2, 0.0);
        assert_eq!(clip(&layers[3]).2, 0.0);
        close(clip(&layers[4]), (300.0, 10.0, 40.0, 30.0));
        assert!(
            layers[4].children.as_ref().unwrap()[0]
                .clip_bounds
                .is_none()
        );
    }

    #[test]
    fn a_clip_inside_a_turned_group_is_seen_where_the_group_turns_it() {
        let group = json!({
            "id": "card", "type": "group",
            "transform": { "x": 100, "y": 100, "anchorX": 50, "anchorY": 50, "rotateY": 60 },
            "children": [rect("face", json!({
                "shape": { "kind": "rect", "width": 100, "height": 100 },
                "clip": { "kind": "inset" } }))],
        });
        let result = inspect(&scene(json!([group])), 0).unwrap();
        let face = &result.layers[0].children.as_ref().unwrap()[0];
        let b = face.clip_bounds.unwrap();
        close((b.x, b.y, b.width, b.height), bounds_of(face));
    }

    #[test]
    fn a_motion_blurred_layer_covers_where_its_samples_are() {
        let s = scene(json!([rect(
            "fast",
            json!({
                "transform": { "x": [{ "frame": 0, "value": 0 }, { "frame": 10, "value": 100 }] },
                "motionBlur": { "samples": 2, "shutter": 2 },
            })
        )]));
        let result = inspect(&s, 5).unwrap();
        // Frame 5 is x = 50; the two samples are a frame apart around it, at
        // x = 45 and 55, and the layer is 100 wide.
        let b = result.layers[0].bounds.unwrap();
        assert!(
            (b.x - 45.0).abs() < 1e-6 && (b.x + b.width - 155.0).abs() < 1e-6,
            "{b:?}"
        );
    }

    #[test]
    fn text_comes_with_its_lines() {
        let s = scene(json!([{
            "id": "title", "type": "text", "text": "alpha beta\ngamma", "font": "DM Sans",
            "size": 32, "color": "#ffffff", "maxWidth": 300,
        }]));
        let result = inspect(&s, 0).unwrap();
        let title = &result.layers[0];
        assert_eq!(title.kind, "text");
        let text = title.text.as_ref().unwrap();
        assert_eq!(
            (text.text.as_str(), text.font.as_str(), text.size),
            ("alpha beta\ngamma", "DM Sans", 32.0)
        );
        assert_eq!(text.max_width, Some(300.0));
        let lines: Vec<&str> = text.lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(lines, ["alpha beta", "gamma"]);
        assert!(text.lines[1].top >= text.lines[0].bottom - 1e-3);
        assert!(text.lines[0].baseline > text.lines[0].top && text.height > 0.0);
        // The box is as wide as the wrap width; the text inside is narrower.
        let b = title.layer_box.unwrap();
        assert_eq!((b.width, b.height), (300.0, text.height));
        assert!(text.width <= 300.0 && text.width > 0.0);
    }

    #[test]
    fn images_report_their_source() {
        let s = scene(json!([{
            "id": "photo", "type": "image", "src": "examples/card-art.png",
            "width": 80, "height": 60,
        }]));
        let photo = inspect(&s, 0).unwrap().layers.remove(0);
        assert_eq!(
            (photo.kind, photo.src.as_deref()),
            ("image", Some("examples/card-art.png"))
        );
        close(bounds_of(&photo), (0.0, 0.0, 80.0, 60.0));
    }

    #[test]
    fn video_and_gif_report_their_source_and_media_time() {
        const MEDIA: &str = "crates/core/tests/scenes/media";
        let s = scene_with(
            json!({ "fps": 24 }),
            json!([
                { "id": "clip", "type": "video", "src": format!("{MEDIA}/clip.mp4"),
                  "width": 64, "height": 36, "from": 6, "trimBefore": 12, "playbackRate": 2 },
                { "id": "end", "type": "video", "src": format!("{MEDIA}/clip.mp4"),
                  "width": 64, "height": 36, "trimAfter": 36 },
                { "id": "spin", "type": "gif", "src": format!("{MEDIA}/spinner.gif"),
                  "width": 32, "height": 24, "time": 0.4 },
                { "id": "spin-frame", "type": "gif", "src": format!("{MEDIA}/spinner.gif") },
            ]),
        );
        let at = |frame| inspect(&s, frame).unwrap().layers;
        let layers = at(12);
        // (12 - 6) * 2 = 12 clip frames after `trimBefore` 12: 24 frames, 1 s.
        assert_eq!(
            (layers[0].kind, layers[0].media),
            ("video", Some(InspectMedia { time: 1.0 }))
        );
        assert_eq!(
            layers[0].src.as_deref(),
            Some("crates/core/tests/scenes/media/clip.mp4")
        );
        close(bounds_of(&layers[0]), (0.0, 0.0, 64.0, 36.0));
        // `trimAfter` 36 frames ends the clip at 1.5 s.
        assert_eq!(layers[1].media, Some(InspectMedia { time: 0.5 }));
        assert_eq!(at(59)[1].media, Some(InspectMedia { time: 1.5 }));
        // A GIF's time is its `time`, or the frame's.
        assert_eq!(
            (layers[2].kind, layers[2].media),
            ("gif", Some(InspectMedia { time: 0.4 }))
        );
        assert_eq!(layers[3].media, Some(InspectMedia { time: 0.5 }));
        close(bounds_of(&layers[3]), (0.0, 0.0, 32.0, 24.0));
        // Other layers have none, and it serialises as `media: { time }`.
        let shape = scene(json!([rect("r", json!({}))]));
        assert_eq!(inspect(&shape, 0).unwrap().layers[0].media, None);
        let json = serde_json::to_value(&layers[0]).unwrap();
        assert_eq!(json["type"], "video");
        assert_eq!(json["media"]["time"], 1.0);
        assert!(
            serde_json::to_value(&inspect(&shape, 0).unwrap().layers[0])
                .unwrap()
                .get("media")
                .is_none()
        );
    }

    #[test]
    fn a_turned_layer_is_bounded_where_the_camera_sees_it() {
        // Turned 60 degrees about the vertical axis through its position
        // (100, 100), with no camera, a square spanning 50..150 is half as
        // wide, still centred there.
        let turned = rect(
            "card",
            json!({
                "shape": { "kind": "rect", "width": 100, "height": 100 },
                "transform": { "x": 100, "y": 100, "anchorX": 50, "anchorY": 50, "rotateY": 60 },
            }),
        );
        let s = scene(json!([turned.clone()]));
        let card = &inspect(&s, 0).unwrap().layers[0];
        close(bounds_of(card), (75.0, 50.0, 50.0, 100.0));
        // The 2D matrix is the flat one.
        assert_eq!(card.matrix, [1.0, 0.0, 0.0, 1.0, 50.0, 50.0]);

        // With a camera the near edge is magnified and the far one shrunk,
        // so the box is not symmetric about the position any more.
        let s = scene_with(json!({ "camera": { "perspective": 400 } }), json!([turned]));
        let result = inspect(&s, 0).unwrap();
        let cam = result.camera.unwrap();
        assert_eq!((cam.perspective, cam.x, cam.y), (400.0, 200.0, 150.0));
        let b = result.layers[0].bounds.unwrap();
        assert!(b.height > 100.0 - 1e-6 && b.width < 100.0, "{b:?}");
    }

    #[test]
    fn children_of_a_turned_group_are_seen_where_it_turns_them() {
        // The group is drawn flat and turned 60 degrees about the vertical
        // through (100, 100), so its one child, a square spanning 50..150,
        // shows where the group does: half as wide, centred there.
        let group = json!({
            "id": "card", "type": "group",
            "transform": { "x": 100, "y": 100, "anchorX": 50, "anchorY": 50, "rotateY": 60 },
            "children": [rect("face", json!({ "shape": { "kind": "rect", "width": 100, "height": 100 } }))],
        });
        let result = inspect(&scene(json!([group])), 0).unwrap();
        let card = &result.layers[0];
        let face = &card.children.as_ref().unwrap()[0];
        close(bounds_of(card), (75.0, 50.0, 50.0, 100.0));
        close(bounds_of(face), (75.0, 50.0, 50.0, 100.0));
        // The 2D matrix stays the flat one.
        assert_eq!(face.matrix, [1.0, 0.0, 0.0, 1.0, 50.0, 50.0]);
    }

    #[test]
    fn children_of_a_preserve3d_group_are_placed_by_it() {
        let s = scene(json!([{
            "id": "stack", "type": "group", "preserve3d": true,
            "transform": { "x": 100, "y": 100, "rotateY": 60 },
            "children": [rect("a", json!({
                "shape": { "kind": "rect", "width": 100, "height": 100 },
                "transform": { "x": -50, "y": -50 } }))],
        }]));
        let result = inspect(&s, 0).unwrap();
        let stack = &result.layers[0];
        // The child spans -50..50 about the group's origin, which is
        // turned about the vertical axis there: half as wide, centred on 100.
        close(
            bounds_of(&stack.children.as_ref().unwrap()[0]),
            (75.0, 50.0, 50.0, 100.0),
        );
        close(bounds_of(stack), (75.0, 50.0, 50.0, 100.0));
    }

    #[test]
    fn the_result_serialises_with_the_documented_names() {
        let s = scene(json!([
            rect("a", json!({})),
            { "id": "g", "type": "group", "children": [] },
        ]));
        let value = serde_json::to_value(inspect(&s, 3).unwrap()).unwrap();
        for key in [
            "width",
            "height",
            "fps",
            "durationInFrames",
            "frame",
            "margin",
            "camera",
            "layers",
        ] {
            assert!(value.get(key).is_some(), "{key}");
        }
        assert_eq!(value["frame"], 3);
        let a = &value["layers"][0];
        for key in [
            "id",
            "type",
            "opacity",
            "blendMode",
            "transform",
            "matrix",
            "box",
            "bounds",
            "effects",
            "clip",
            "clipBounds",
            "mask",
            "matte",
            "matteSource",
            "motionBlur",
        ] {
            assert!(a.get(key).is_some(), "{key}");
        }
        for key in [
            "x", "y", "scale", "rotation", "anchorX", "anchorY", "rotateX", "rotateY", "z",
        ] {
            assert!(a["transform"].get(key).is_some(), "transform.{key}");
        }
        assert!(a.get("children").is_none() && a.get("text").is_none() && a.get("src").is_none());
        // An empty group has children (none) but no box and no bounds.
        let g = &value["layers"][1];
        assert_eq!(g["children"], json!([]));
        assert!(g["box"].is_null() && g["bounds"].is_null());
    }
}
