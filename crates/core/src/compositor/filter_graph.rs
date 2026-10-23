//! The passes of a `filterGraph` effect (`filter.rs`, `shaders/filter.wgsl`).
//!
//! The graph is evaluated primitive by primitive on the layer's texture, in the
//! canvas, with the layer's matrix taking the filter's space (SVG user space:
//! lengths, the filter region, subregions, the noise) to pixels. So a filter
//! on a turned or scaled layer is the filter in the layer's own space, drawn
//! through the layer's matrix, as in a browser: a blur is as wide as the
//! layer's scale makes it, an offset turns with the layer, the noise sticks to
//! the layer.
//!
//! Every result is a texture of its subregion's box. Each is tagged with the
//! colour space its pixels are in: the layer is in linear light, and a
//! primitive that works in sRGB (`color-interpolation-filters`) gets its inputs
//! converted (`fs_convert`), once per input. The last result is converted back
//! to linear light.

use std::collections::HashMap;

use kurbo::{Affine, Rect};

use super::{Compositor, Tex, mode_index, shader_module};
use crate::bounds::{self, PixelRect};
use crate::filter::{
    CompositeOp, EdgeMode, FeInput, FeOp, Plan, PlanNode, ResolvedFilterGraph, ResolvedLight,
    ResolvedTransfer,
};

/// The entry points of `shaders/filter.wgsl`.
const ENTRIES: [&str; 16] = [
    "fs_convert",
    "fs_copy",
    "fs_source_alpha",
    "fs_flood",
    "fs_offset",
    "fs_composite",
    "fs_color_matrix",
    "fs_component_transfer",
    "fs_morph",
    "fs_blur",
    "fs_displace",
    "fs_turbulence",
    "fs_displace_turbulence",
    "fs_tile",
    "fs_convolve",
    "fs_lighting",
];

/// Floats in a pass's uniform block: the header (five vec4) and `v` (64).
const PARAM_FLOATS: usize = 20 + 64 * 4;

/// The pipelines of the filter passes, made the first time a scene draws a
/// filter graph.
pub(super) struct FilterPipelines {
    passes: HashMap<&'static str, wgpu::RenderPipeline>,
}

/// Standard deviation, in canvas pixels, from which an isotropic blur uses
/// the pyramid of the `blur` effect instead of two direct passes.
const WIDE_BLUR: f64 = 12.0;

/// A rectangle so large that nothing is cut by it.
fn everywhere() -> Rect {
    Rect::new(-1e9, -1e9, 1e9, 1e9)
}

/// The layer's matrix as the passes need it.
struct Fe {
    /// Layer space to the padded canvas.
    matrix: Affine,
    /// Canvas (margin taken out) to layer space.
    inverse: [f32; 6],
    margin: f32,
    /// The length of the matrix's columns: how many pixels a layer unit is
    /// along the layer's x and y axes.
    column: [f64; 2],
    /// The most the matrix lengthens a vector.
    stretch: f64,
}

impl Fe {
    fn new(matrix: Affine, margin: u32) -> Option<Fe> {
        let m = Affine::translate((-f64::from(margin), -f64::from(margin))) * matrix;
        if m.determinant().abs().partial_cmp(&1e-12) != Some(std::cmp::Ordering::Greater) {
            return None;
        }
        let inv = m.inverse().as_coeffs();
        let [a, b, c, d, _, _] = matrix.as_coeffs();
        Some(Fe {
            matrix,
            inverse: inv.map(|v| v as f32),
            margin: margin as f32,
            column: [a.hypot(b), c.hypot(d)],
            stretch: bounds::max_stretch(matrix),
        })
    }

    /// The pixels the layer-space rectangle `r` touches, on the canvas.
    fn px(&self, r: Rect, whole: PixelRect) -> PixelRect {
        bounds::pixel_rect(bounds::transformed(self.matrix, r))
            .unwrap_or(whole)
            .intersect(whole)
    }

    /// The uniform block of a pass: the header, then `v` zero-padded.
    fn params(&self, sub: Rect, v: &[f32]) -> Vec<u8> {
        assert!(v.len() <= 64 * 4, "a filter pass takes at most 64 vec4");
        let [a, b, c, d, e, f] = self.matrix.as_coeffs();
        let i = &self.inverse;
        let mut floats = Vec::with_capacity(PARAM_FLOATS);
        floats.extend([i[0], i[1], i[2], i[3]]);
        floats.extend([i[4], i[5], self.margin, 0.0]);
        floats.extend([a as f32, b as f32, c as f32, d as f32]);
        floats.extend([e as f32, f as f32, 0.0, 0.0]);
        floats.extend([sub.x0 as f32, sub.y0 as f32, sub.x1 as f32, sub.y1 as f32]);
        floats.extend_from_slice(v);
        floats.resize(PARAM_FLOATS, 0.0);
        floats.iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    /// A layer-space vector as a canvas vector (the matrix's linear part).
    fn vector(&self, x: f64, y: f64) -> [f64; 2] {
        let [a, b, c, d, _, _] = self.matrix.as_coeffs();
        [a * x + c * y, b * x + d * y]
    }
}

/// One finished result: a texture, and whether its colour is sRGB-encoded.
struct Slot {
    tex: Tex,
    srgb: bool,
    /// Holds nothing that depends on the colour space (SourceAlpha, empty).
    neutral: bool,
}

/// The results of a graph and the conversions made of them. The layer is slot
/// 0, its alpha slot 1, primitive `i` slot `2 + i`, the empty image the one
/// after the last primitive.
struct Graph {
    slots: Vec<Option<Slot>>,
    /// The result in the other colour space, if it was asked for.
    alt: Vec<Option<Tex>>,
}

/// Which texture: a slot's own, or its conversion.
#[derive(Clone, Copy)]
struct Sel(usize, bool);

impl Graph {
    fn tex(&self, sel: Sel) -> &Tex {
        if sel.1 {
            self.alt[sel.0].as_ref().expect("converted")
        } else {
            &self.slots[sel.0].as_ref().expect("made").tex
        }
    }

    fn srgb(&self, sel: Sel) -> bool {
        let slot = self.slots[sel.0].as_ref().expect("made");
        slot.srgb != sel.1
    }
}

impl Compositor {
    fn filter_pipeline(&mut self, entry: &str) -> wgpu::RenderPipeline {
        if self.filter.is_none() {
            let shader = shader_module(
                &self.device,
                "filter",
                include_str!("../shaders/filter.wgsl"),
            );
            let one = self
                .device
                .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("filter"),
                    bind_group_layouts: &[Some(&self.layout)],
                    immediate_size: 0,
                });
            let two = self
                .device
                .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("filter turbulence"),
                    bind_group_layouts: &[Some(&self.layout), Some(&self.turbulence_layout)],
                    immediate_size: 0,
                });
            let passes = ENTRIES
                .iter()
                .map(|&entry| {
                    let layout = if entry == "fs_turbulence" || entry == "fs_displace_turbulence" {
                        &two
                    } else {
                        &one
                    };
                    (
                        entry,
                        super::fullscreen_pipeline(
                            &self.device,
                            layout,
                            &shader,
                            entry,
                            super::LINEAR_FORMAT,
                        ),
                    )
                })
                .collect();
            self.filter = Some(FilterPipelines { passes });
        }
        self.filter.as_ref().expect("made").passes[entry].clone()
    }

    /// One pass of `shaders/filter.wgsl` over `region`, reading `a` and `b`.
    #[allow(clippy::too_many_arguments)]
    fn fe_pass(
        &mut self,
        entry: &str,
        a: &Tex,
        b: &Tex,
        params: Vec<u8>,
        region: PixelRect,
        tables: Option<i64>,
    ) -> Tex {
        let pipeline = self.filter_pipeline(entry);
        let target = self.target(region);
        let extra = tables.map(|key| &self.turbulence_tables[&key]);
        self.run_pass_with(&pipeline, a.input(), b.input(), &params, extra, &target);
        target
    }

    /// Runs a `filterGraph` on a layer's texture `src`. `src` goes back to the
    /// pool; the result is a new texture in linear light.
    pub(super) fn filter_graph(
        &mut self,
        src: Tex,
        layer_matrix: Affine,
        layer_box: Option<Rect>,
        graph: &ResolvedFilterGraph,
    ) -> Tex {
        let plan = graph.plan(layer_box);
        let fe = Fe::new(layer_matrix, self.margin);
        let (Some(plan), Some(fe)) = (plan, fe) else {
            self.release(src);
            return self.empty();
        };
        let whole = self.whole();
        let region_px = fe.px(plan.region, whole);
        if region_px.is_empty() || plan.nodes.is_empty() {
            self.release(src);
            return self.empty();
        }
        if self.is_fused()
            && let Some(done) = self.displace_by_turbulence(&src, &fe, &plan, region_px)
        {
            self.release(src);
            return done;
        }
        let n = plan.nodes.len();
        let mut g = Graph {
            slots: (0..n + 3).map(|_| None).collect(),
            alt: (0..n + 3).map(|_| None).collect(),
        };
        // The layer, cut to the filter region.
        let source = self.fe_pass(
            "fs_copy",
            &src,
            &src,
            fe.params(plan.region, &[]),
            region_px.intersect(src.bounds),
            None,
        );
        self.release(src);
        g.slots[0] = Some(Slot {
            tex: source,
            srgb: false,
            neutral: false,
        });

        for (i, node) in plan.nodes.iter().enumerate() {
            let (tex, srgb) = self.run_node(&fe, &plan, node, &mut g, region_px);
            g.slots[2 + i] = Some(Slot {
                tex,
                srgb,
                neutral: false,
            });
        }

        let last = g.slots[1 + n].take().expect("made");
        let result = if last.srgb {
            let params = fe.params(everywhere(), &[1.0]);
            let converted = self.fe_pass(
                "fs_convert",
                &last.tex,
                &last.tex,
                params,
                last.tex.bounds,
                None,
            );
            self.release(last.tex);
            converted
        } else {
            last.tex
        };
        for slot in g.slots.into_iter().flatten() {
            self.release(slot.tex);
        }
        for tex in g.alt.into_iter().flatten() {
            self.release(tex);
        }
        result
    }

    /// A graph of a turbulence and a displacement of the layer by it, over the
    /// whole filter region, in the same colour space, in one pass: the passes of
    /// the copy of the layer, of the noise and of the displacement make the same
    /// pixels (`fs_displace_turbulence`). `None` if the graph is anything else.
    fn displace_by_turbulence(
        &mut self,
        src: &Tex,
        fe: &Fe,
        plan: &Plan,
        region_px: PixelRect,
    ) -> Option<Tex> {
        let [noise, shift] = &plan.nodes[..] else {
            return None;
        };
        let FeOp::Turbulence {
            fractal,
            frequency,
            octaves,
            seed,
            stitch,
        } = &noise.op
        else {
            return None;
        };
        let FeOp::DisplacementMap {
            scale,
            x_channel,
            y_channel,
        } = &shift.op
        else {
            return None;
        };
        if !matches!(shift.inputs[..], [FeInput::Source, FeInput::Node(0)])
            || noise.sub != plan.region
            || shift.sub != plan.region
            || noise.linear != shift.linear
        {
            return None;
        }
        // What the copy of the layer holds, and what the displacement draws.
        let copy = region_px.intersect(src.bounds);
        if copy.is_empty() {
            return None;
        }
        let reach = (fe.stretch * f64::from(scale.abs()) * 0.5).ceil() as i32 + 2;
        let region = copy.grow(reach, reach).intersect(region_px);
        let sub = plan.region;
        let key = self.turbulence_tables(*seed);
        let mut v = [0.0f32; 28];
        let mut freq = [f64::from(frequency[0]), f64::from(frequency[1])];
        if *stitch {
            let (tx, ty, tw, th) = (sub.x0, sub.y0, sub.width(), sub.height());
            let adjust = |f: f64, size: f64| -> f64 {
                if f == 0.0 || size <= 0.0 {
                    return f;
                }
                let lo = (size * f).floor() / size;
                let hi = (size * f).ceil() / size;
                if f / lo < hi / f { lo } else { hi }
            };
            freq = [adjust(freq[0], tw), adjust(freq[1], th)];
            let width = (tw * freq[0] + 0.5) as i32;
            let height = (th * freq[1] + 0.5) as i32;
            let wrap_x = (tx * freq[0] + 4096.0 + f64::from(width)) as i32;
            let wrap_y = (ty * freq[1] + 4096.0 + f64::from(height)) as i32;
            v[20] = width as f32;
            v[21] = wrap_x as f32;
            v[22] = height as f32;
            v[23] = wrap_y as f32;
            v[24] = 1.0;
        }
        v[0] = *scale;
        v[4] = *x_channel as f32;
        v[5] = *y_channel as f32;
        v[16] = freq[0] as f32;
        v[17] = freq[1] as f32;
        v[18] = f32::from(u8::from(*fractal));
        v[19] = *octaves as f32;
        let pipeline = self.filter_pipeline("fs_displace_turbulence");
        let target = self.target(region);
        let params = fe.params(sub, &v);
        let extra = &self.turbulence_tables[&key];
        self.run_pass_with(&pipeline, src.input(), src.input(), &params, Some(extra), &target);
        Some(target)
    }

    /// The slot `input` reads, converted to `want` (sRGB if true, linear if
    /// false; `None` takes it as it is).
    fn fe_input(
        &mut self,
        fe: &Fe,
        plan: &Plan,
        g: &mut Graph,
        input: FeInput,
        want: Option<bool>,
        region_px: PixelRect,
    ) -> Sel {
        let n = plan.nodes.len();
        let index = match input {
            FeInput::Source => 0,
            FeInput::SourceAlpha => 1,
            FeInput::Node(i) => 2 + i,
            FeInput::Empty => 2 + n,
        };
        if g.slots[index].is_none() {
            let (tex, neutral) = match input {
                FeInput::SourceAlpha => {
                    let source = &g.slots[0].as_ref().expect("made").tex;
                    let params = fe.params(plan.region, &[]);
                    (
                        self.fe_pass(
                            "fs_source_alpha",
                            source,
                            source,
                            params,
                            source.bounds.intersect(region_px),
                            None,
                        ),
                        true,
                    )
                }
                _ => (self.empty(), true),
            };
            g.slots[index] = Some(Slot {
                tex,
                srgb: false,
                neutral,
            });
        }
        let slot = g.slots[index].as_ref().expect("made");
        match want {
            Some(srgb) if slot.srgb != srgb && !slot.neutral => {
                if g.alt[index].is_none() {
                    let params = fe.params(everywhere(), &[if srgb { 0.0 } else { 1.0 }]);
                    // `fs_convert` reads v[0].x = 1 for sRGB -> linear.
                    let bounds = slot.tex.bounds;
                    let alt =
                        self.fe_pass("fs_convert", &slot.tex, &slot.tex, params, bounds, None);
                    g.alt[index] = Some(alt);
                }
                Sel(index, true)
            }
            _ => Sel(index, false),
        }
    }

    /// Draws one primitive. Returns its texture and whether it is sRGB.
    fn run_node(
        &mut self,
        fe: &Fe,
        plan: &Plan,
        node: &PlanNode,
        g: &mut Graph,
        region_px: PixelRect,
    ) -> (Tex, bool) {
        let whole = self.whole();
        let sub_px = fe.px(node.sub, whole);
        let srgb = !node.linear;
        let sub = node.sub;
        let clip_needed = node.sub != plan.region;
        // Reads the inputs in this primitive's colour space.
        let take = |c: &mut Compositor, g: &mut Graph, k: usize, convert: bool| -> Sel {
            let input = node.inputs.get(k).copied().unwrap_or(FeInput::Empty);
            c.fe_input(fe, plan, g, input, convert.then_some(srgb), region_px)
        };
        // A texture to bind where a pass reads nothing: the layer's.
        let spare = |c: &mut Compositor, g: &mut Graph| -> Sel {
            c.fe_input(fe, plan, g, FeInput::Source, None, region_px)
        };
        match &node.op {
            FeOp::Flood { color } => {
                let a = spare(self, g);
                let ta = g.tex(a);
                let mut rgb = [color[0], color[1], color[2]];
                if node.linear {
                    rgb = rgb.map(srgb_to_linear);
                }
                let alpha = color[3];
                let v = [rgb[0] * alpha, rgb[1] * alpha, rgb[2] * alpha, alpha];
                let t = self.fe_pass("fs_flood", ta, ta, fe.params(sub, &v), sub_px, None);
                (t, srgb)
            }
            FeOp::Turbulence {
                fractal,
                frequency,
                octaves,
                seed,
                stitch,
            } => {
                let a = spare(self, g);
                let ta = g.tex(a);
                let key = self.turbulence_tables(*seed);
                let mut v = [0.0f32; 12];
                let mut freq = [f64::from(frequency[0]), f64::from(frequency[1])];
                if *stitch {
                    let (tx, ty, tw, th) = (sub.x0, sub.y0, sub.width(), sub.height());
                    let adjust = |f: f64, size: f64| -> f64 {
                        if f == 0.0 || size <= 0.0 {
                            return f;
                        }
                        let lo = (size * f).floor() / size;
                        let hi = (size * f).ceil() / size;
                        if f / lo < hi / f { lo } else { hi }
                    };
                    freq = [adjust(freq[0], tw), adjust(freq[1], th)];
                    let width = (tw * freq[0] + 0.5) as i32;
                    let height = (th * freq[1] + 0.5) as i32;
                    let wrap_x = (tx * freq[0] + 4096.0 + f64::from(width)) as i32;
                    let wrap_y = (ty * freq[1] + 4096.0 + f64::from(height)) as i32;
                    v[4] = width as f32;
                    v[5] = wrap_x as f32;
                    v[6] = height as f32;
                    v[7] = wrap_y as f32;
                    v[8] = 1.0;
                }
                v[0] = freq[0] as f32;
                v[1] = freq[1] as f32;
                v[2] = f32::from(u8::from(*fractal));
                v[3] = *octaves as f32;
                let t = self.fe_pass(
                    "fs_turbulence",
                    ta,
                    ta,
                    fe.params(sub, &v),
                    sub_px,
                    Some(key),
                );
                (t, srgb)
            }
            FeOp::Offset { dx, dy } => {
                let a = take(self, g, 0, false);
                let ta = g.tex(a);
                let shift = fe.vector(f64::from(*dx), f64::from(*dy));
                let region = PixelRect::new(
                    ta.bounds.x0 + shift[0].floor() as i32 - 1,
                    ta.bounds.y0 + shift[1].floor() as i32 - 1,
                    ta.bounds.x1 + shift[0].ceil() as i32 + 1,
                    ta.bounds.y1 + shift[1].ceil() as i32 + 1,
                );
                let region = if ta.bounds.is_empty() {
                    PixelRect::EMPTY
                } else {
                    region.intersect(sub_px)
                };
                let v = [shift[0] as f32, shift[1] as f32];
                let t = self.fe_pass("fs_offset", ta, ta, fe.params(sub, &v), region, None);
                let srgb = g.srgb(a);
                (t, srgb)
            }
            FeOp::GaussianBlur { std } => {
                let a = take(self, g, 0, true);
                let ta = g.tex(a);
                // The variance along each canvas axis of the filter's Gaussian.
                let [m0, m1] = [
                    fe.vector(f64::from(std[0]), 0.0),
                    fe.vector(0.0, f64::from(std[1])),
                ];
                let sx = m0[0].hypot(m1[0]);
                let sy = m0[1].hypot(m1[1]);
                let t = self.blur_passes(fe, ta, sx, sy, sub, sub_px);
                (t, srgb)
            }
            FeOp::ColorMatrix { rows } => {
                let a = take(self, g, 0, true);
                let ta = g.tex(a);
                let mut v = [0.0f32; 20];
                for (i, row) in rows.iter().enumerate() {
                    v[i * 4..i * 4 + 4].copy_from_slice(&row[..4]);
                    v[16 + i] = row[4];
                }
                // Nothing from nothing, unless an offset adds some.
                let region = if rows.iter().all(|r| r[4] == 0.0) {
                    ta.bounds.intersect(sub_px)
                } else {
                    sub_px
                };
                let t = self.fe_pass("fs_color_matrix", ta, ta, fe.params(sub, &v), region, None);
                (t, srgb)
            }
            FeOp::ComponentTransfer { funcs } => {
                let a = take(self, g, 0, true);
                let ta = g.tex(a);
                let mut v = vec![0.0f32; 40 * 4];
                for (k, f) in funcs.iter().enumerate() {
                    pack_transfer(&mut v[k * 40..k * 40 + 40], f);
                }
                let region = if transfer_at_zero(&funcs[3]) == 0.0 {
                    ta.bounds.intersect(sub_px)
                } else {
                    sub_px
                };
                let t = self.fe_pass(
                    "fs_component_transfer",
                    ta,
                    ta,
                    fe.params(sub, &v),
                    region,
                    None,
                );
                (t, srgb)
            }
            FeOp::Composite { operator, k } => {
                let a = take(self, g, 0, true);
                let b = take(self, g, 1, true);
                let (ta, tb) = (g.tex(a), g.tex(b));
                let op = match operator {
                    CompositeOp::Over => 0.0,
                    CompositeOp::In => 1.0,
                    CompositeOp::Out => 2.0,
                    CompositeOp::Atop => 3.0,
                    CompositeOp::Xor => 4.0,
                    CompositeOp::Arithmetic => 5.0,
                };
                let region = match operator {
                    CompositeOp::In => ta.bounds.intersect(tb.bounds),
                    CompositeOp::Out => ta.bounds,
                    CompositeOp::Arithmetic if k[3] != 0.0 => sub_px,
                    _ => ta.bounds.union(tb.bounds),
                }
                .intersect(sub_px);
                let v = [op, 0.0, 0.0, 0.0, k[0], k[1], k[2], k[3]];
                let t = self.fe_pass("fs_composite", ta, tb, fe.params(sub, &v), region, None);
                (t, srgb)
            }
            FeOp::Blend { mode } => {
                let a = take(self, g, 0, true);
                let b = take(self, g, 1, true);
                let (ta, tb) = (g.tex(a), g.tex(b));
                // `in` is on top of `in2`.
                let region = ta.bounds.union(tb.bounds).intersect(sub_px);
                let target = self.target(region);
                self.pass(
                    &self.blend,
                    tb.input(),
                    ta.input(),
                    1.0,
                    mode_index(*mode),
                    &target,
                );
                (self.clip_to(fe, target, sub, clip_needed), srgb)
            }
            FeOp::Merge => {
                let sels: Vec<Sel> = (0..node.inputs.len())
                    .map(|k| take(self, g, k, true))
                    .collect();
                let mut acc: Option<Tex> = None;
                for &s in &sels {
                    let t = g.tex(s);
                    acc = Some(match acc.take() {
                        None => {
                            let target = self.target(t.bounds.intersect(sub_px));
                            let pipeline = self.filter_pipeline("fs_copy");
                            let params = fe.params(everywhere(), &[]);
                            self.run_pass_with(
                                &pipeline,
                                t.input(),
                                t.input(),
                                &params,
                                None,
                                &target,
                            );
                            target
                        }
                        Some(below) => {
                            let over = self.over(&below, t);
                            self.release(below);
                            over
                        }
                    });
                }
                let merged = acc.unwrap_or_else(|| self.empty());
                (self.clip_to(fe, merged, sub, clip_needed), srgb)
            }
            FeOp::Morphology { dilate, radius } => {
                let a = take(self, g, 0, true);
                let ta = g.tex(a);
                let rx = (f64::from(radius[0]) * fe.column[0]).round().min(200.0);
                let ry = (f64::from(radius[1]) * fe.column[1]).round().min(200.0);
                let t = self.morph_passes(fe, ta, rx as i32, ry as i32, *dilate, sub, sub_px);
                (t, srgb)
            }
            FeOp::Tile => {
                let a = take(self, g, 0, true);
                let ta = g.tex(a);
                let rect = match node.inputs.first() {
                    Some(FeInput::Node(i)) => plan.nodes[*i].sub,
                    _ => plan.region,
                };
                let v = [
                    rect.x0 as f32,
                    rect.y0 as f32,
                    rect.x1 as f32,
                    rect.y1 as f32,
                ];
                let region = if ta.bounds.is_empty() {
                    PixelRect::EMPTY
                } else {
                    sub_px
                };
                let t = self.fe_pass("fs_tile", ta, ta, fe.params(sub, &v), region, None);
                (t, g.srgb(a))
            }
            FeOp::DisplacementMap {
                scale,
                x_channel,
                y_channel,
            } => {
                // The map is in this primitive's colour space, the image is not
                // converted.
                let a = take(self, g, 0, false);
                let b = take(self, g, 1, true);
                let (ta, tb) = (g.tex(a), g.tex(b));
                let reach = (fe.stretch * f64::from(scale.abs()) * 0.5).ceil() as i32 + 2;
                let region = ta.bounds.grow(reach, reach).intersect(sub_px);
                let v = [*scale, 0.0, 0.0, 0.0, *x_channel as f32, *y_channel as f32];
                let t = self.fe_pass("fs_displace", ta, tb, fe.params(sub, &v), region, None);
                (t, g.srgb(a))
            }
            FeOp::ConvolveMatrix {
                order,
                kernel,
                divisor,
                bias,
                target,
                edge,
                preserve_alpha,
            } => {
                let a = take(self, g, 0, true);
                let ta = g.tex(a);
                let input_px = match node.inputs.first() {
                    Some(FeInput::Node(i)) => fe.px(plan.nodes[*i].sub, whole),
                    _ => region_px,
                };
                let mut v = vec![0.0f32; 19 * 4];
                v[0] = order[0] as f32;
                v[1] = order[1] as f32;
                v[2] = target[0] as f32;
                v[3] = target[1] as f32;
                v[4] = *divisor;
                v[5] = *bias;
                v[6] = match edge {
                    EdgeMode::Duplicate => 0.0,
                    EdgeMode::Wrap => 1.0,
                    EdgeMode::None => 2.0,
                };
                v[7] = f32::from(u8::from(*preserve_alpha));
                v[8] = input_px.x0 as f32;
                v[9] = input_px.y0 as f32;
                v[10] = input_px.x1 as f32;
                v[11] = input_px.y1 as f32;
                v[12..12 + kernel.len()].copy_from_slice(kernel);
                let t = self.fe_pass("fs_convolve", ta, ta, fe.params(sub, &v), sub_px, None);
                (t, srgb)
            }
            FeOp::Lighting {
                specular,
                surface_scale,
                constant,
                exponent,
                color,
                light,
            } => {
                let a = take(self, g, 0, true);
                let ta = g.tex(a);
                let mut rgb = *color;
                if node.linear {
                    rgb = rgb.map(srgb_to_linear);
                }
                let mut v = vec![0.0f32; 16];
                v[0] = *surface_scale;
                v[1] = *constant;
                v[2] = *exponent;
                v[3] = f32::from(u8::from(*specular));
                v[4..7].copy_from_slice(&rgb);
                let stretch = fe.stretch.max(1e-9);
                match light {
                    ResolvedLight::Distant { azimuth, elevation } => {
                        let (az, el) = (
                            f64::from(*azimuth).to_radians(),
                            f64::from(*elevation).to_radians(),
                        );
                        let flat = fe.vector(az.cos() * el.cos(), az.sin() * el.cos());
                        let len = flat[0].hypot(flat[1]);
                        let want = el.cos().abs();
                        let k = if len > 1e-12 { want / len } else { 0.0 };
                        v[7] = 0.0;
                        v[8] = (flat[0] * k) as f32;
                        v[9] = (flat[1] * k) as f32;
                        v[10] = el.sin() as f32;
                    }
                    ResolvedLight::Point { position } => {
                        let p = fe.matrix
                            * kurbo::Point::new(
                                f64::from(position[0]),
                                f64::from(position[1]),
                            );
                        v[7] = 1.0;
                        v[8] = p.x as f32;
                        v[9] = p.y as f32;
                        v[10] = (f64::from(position[2]) * stretch) as f32;
                        v[11] = -2.0;
                    }
                    ResolvedLight::Spot {
                        position,
                        points_at,
                        exponent,
                        cone,
                    } => {
                        let p = fe.matrix
                            * kurbo::Point::new(
                                f64::from(position[0]),
                                f64::from(position[1]),
                            );
                        v[7] = 2.0;
                        v[8] = p.x as f32;
                        v[9] = p.y as f32;
                        v[10] = (f64::from(position[2]) * stretch) as f32;
                        v[11] = cone.map_or(-2.0, |c| f64::from(c).to_radians().cos() as f32);
                        let d = fe.vector(
                            f64::from(points_at[0] - position[0]),
                            f64::from(points_at[1] - position[1]),
                        );
                        let dz = f64::from(points_at[2] - position[2]) * stretch;
                        let len = (d[0] * d[0] + d[1] * d[1] + dz * dz).sqrt().max(1e-12);
                        v[12] = (d[0] / len) as f32;
                        v[13] = (d[1] / len) as f32;
                        v[14] = (dz / len) as f32;
                        v[15] = *exponent;
                    }
                }
                let t = self.fe_pass("fs_lighting", ta, ta, fe.params(sub, &v), sub_px, None);
                (t, srgb)
            }
        }
    }

    /// Cuts `tex` to the subregion with a copy pass, if `needed`.
    fn clip_to(&mut self, fe: &Fe, tex: Tex, sub: Rect, needed: bool) -> Tex {
        if !needed {
            return tex;
        }
        let whole = self.whole();
        let region = tex.bounds.intersect(fe.px(sub, whole));
        let out = self.fe_pass("fs_copy", &tex, &tex, fe.params(sub, &[]), region, None);
        self.release(tex);
        out
    }

    /// A Gaussian blur of `input` with standard deviations `sx`, `sy` canvas
    /// pixels, one axis at a time.
    fn blur_passes(
        &mut self,
        fe: &Fe,
        input: &Tex,
        sx: f64,
        sy: f64,
        sub: Rect,
        sub_px: PixelRect,
    ) -> Tex {
        let axes: Vec<([f32; 2], f64)> = [([1.0, 0.0], sx), ([0.0, 1.0], sy)]
            .into_iter()
            .filter(|(_, s)| *s > 1e-3)
            .collect();
        if axes.is_empty() {
            return self.fe_pass(
                "fs_copy",
                input,
                input,
                fe.params(sub, &[]),
                input.bounds.intersect(sub_px),
                None,
            );
        }
        // A wide round blur goes through the pyramid the `blur` effect uses,
        // which costs the same at any radius.
        if axes.len() == 2 && sx >= WIDE_BLUR && (sx - sy).abs() <= 0.01 * sx {
            let copy = self.fe_pass(
                "fs_copy",
                input,
                input,
                fe.params(everywhere(), &[]),
                input.bounds,
                None,
            );
            let blurred = self.blur_layer(copy, ((sx + sy) / 2.0) as f32);
            return self.clip_to(fe, blurred, sub, true);
        }
        let mut current: Option<Tex> = None;
        let last = axes.len() - 1;
        for (k, (axis, sigma)) in axes.into_iter().enumerate() {
            let reach = (3.0 * sigma).ceil();
            let stride = (reach / 48.0).ceil().max(1.0);
            let from = current.as_ref().unwrap_or(input);
            let grow = reach as i32 + 1;
            let region = if axis[0] > 0.0 {
                from.bounds.grow(grow, 0)
            } else {
                from.bounds.grow(0, grow)
            };
            let region = if k == last {
                region.intersect(sub_px)
            } else {
                region
            };
            let cut = if k == last { sub } else { everywhere() };
            let v = [axis[0], axis[1], sigma as f32, stride as f32];
            let next = self.fe_pass("fs_blur", from, from, fe.params(cut, &v), region, None);
            if let Some(done) = current.replace(next) {
                self.release(done);
            }
        }
        current.expect("one axis at least")
    }

    /// Erodes or dilates `input` by a box of `rx` x `ry` pixels either way.
    #[allow(clippy::too_many_arguments)]
    fn morph_passes(
        &mut self,
        fe: &Fe,
        input: &Tex,
        rx: i32,
        ry: i32,
        dilate: bool,
        sub: Rect,
        sub_px: PixelRect,
    ) -> Tex {
        let axes: Vec<([f32; 2], i32)> = [([1.0, 0.0], rx), ([0.0, 1.0], ry)]
            .into_iter()
            .filter(|(_, r)| *r > 0)
            .collect();
        if axes.is_empty() {
            return self.fe_pass(
                "fs_copy",
                input,
                input,
                fe.params(sub, &[]),
                input.bounds.intersect(sub_px),
                None,
            );
        }
        let mut current: Option<Tex> = None;
        let last = axes.len() - 1;
        for (k, (axis, radius)) in axes.into_iter().enumerate() {
            let from = current.as_ref().unwrap_or(input);
            let region = if !dilate {
                from.bounds
            } else if axis[0] > 0.0 {
                from.bounds.grow(radius, 0)
            } else {
                from.bounds.grow(0, radius)
            };
            let region = if k == last {
                region.intersect(sub_px)
            } else {
                region
            };
            let cut = if k == last { sub } else { everywhere() };
            let v = [axis[0], axis[1], radius as f32, f32::from(u8::from(dilate))];
            let next = self.fe_pass("fs_morph", from, from, fe.params(cut, &v), region, None);
            if let Some(done) = current.replace(next) {
                self.release(done);
            }
        }
        current.expect("one axis at least")
    }
}

fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// A transfer function as the block `shaders/filter.wgsl` reads: (kind, table
/// length, p0, p1), (p2, ...), then the table.
fn pack_transfer(block: &mut [f32], f: &ResolvedTransfer) {
    block[0] = f.kind as f32;
    block[1] = f.table.len() as f32;
    match f.kind {
        3 => {
            block[2] = f.p[0];
            block[3] = f.p[1];
        }
        4 => {
            block[2] = f.p[0];
            block[3] = f.p[1];
            block[4] = f.p[2];
        }
        _ => {}
    }
    let table = &f.table[..f.table.len().min(crate::filter::MAX_TABLE_VALUES)];
    block[8..8 + table.len()].copy_from_slice(table);
}

/// What a transfer function makes of 0.
fn transfer_at_zero(f: &ResolvedTransfer) -> f32 {
    match f.kind {
        1 | 2 => f.table.first().copied().unwrap_or(0.0),
        3 => f.p[1],
        4 => f.p[2],
        _ => 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_transfer_function_packs_its_table_after_the_header() {
        let mut block = [0.0f32; 40];
        pack_transfer(
            &mut block,
            &ResolvedTransfer {
                kind: 1,
                table: vec![0.0, 0.5, 1.0],
                p: [0.0; 3],
            },
        );
        assert_eq!(&block[..2], &[1.0, 3.0]);
        assert_eq!(&block[8..11], &[0.0, 0.5, 1.0]);
        let mut block = [0.0f32; 40];
        pack_transfer(
            &mut block,
            &ResolvedTransfer {
                kind: 4,
                table: vec![],
                p: [2.0, 3.0, 0.25],
            },
        );
        // gamma: amplitude and exponent in the head, the offset in the next vec4.
        assert_eq!(&block[..4], &[4.0, 0.0, 2.0, 3.0]);
        assert_eq!(block[4], 0.25);
    }

    #[test]
    fn the_header_carries_the_matrix_both_ways_and_the_subregion() {
        let m = Affine::translate((10.0, 20.0)) * Affine::scale(2.0);
        let fe = Fe::new(m, 4).unwrap();
        let bytes = fe.params(Rect::new(1.0, 2.0, 3.0, 4.0), &[7.0]);
        assert_eq!(bytes.len(), PARAM_FLOATS * 4);
        let f = |i: usize| f32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap());
        // The inverse of the matrix on the canvas (margin out): (x - 6 - 10) / 2.
        assert_eq!(f(0), 0.5);
        assert_eq!(f(3), 0.5);
        assert_eq!(f(4), -(10.0 - 4.0) / 2.0);
        assert_eq!(f(6), 4.0);
        // The matrix to the padded canvas.
        assert_eq!(f(8), 2.0);
        assert_eq!(f(12), 10.0);
        assert_eq!([f(16), f(17), f(18), f(19)], [1.0, 2.0, 3.0, 4.0]);
        assert_eq!(f(20), 7.0);
        assert_eq!(f(21), 0.0);
        assert!(Fe::new(Affine::scale(0.0), 0).is_none());
    }

    #[test]
    fn a_vector_turns_with_the_layer() {
        let fe = Fe::new(
            Affine::rotate(std::f64::consts::FRAC_PI_2) * Affine::scale(2.0),
            0,
        )
        .unwrap();
        let v = fe.vector(1.0, 0.0);
        assert!(v[0].abs() < 1e-9 && (v[1] - 2.0).abs() < 1e-9);
        assert!((fe.column[0] - 2.0).abs() < 1e-9);
    }
}
