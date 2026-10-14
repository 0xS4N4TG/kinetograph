//! Gaussian blur on the GPU (`shaders/blur.wgsl`).
//!
//! The layer is copied into the middle of a transparent texture that is
//! `3 * radius` larger on every side, so the blur fades out past the layer's
//! edge instead of smearing the border pixels. That texture is shrunk `n`
//! times by a `[1 3 3 1] / 8` filter, blurred by a separable Gaussian, and
//! enlarged back by bilinear upsampling; the last upsample writes the
//! original canvas-sized region.
//!
//! `plan` picks the largest `n` that leaves the Gaussian at least
//! `MIN_SIGMA` texels wide, so the coarse grid is invisible. Both the shrink
//! and the enlarge keep the centre of mass, and the Gaussian is smooth at that
//! scale, so a blurred layer tracks its position to a small fraction of a
//! pixel (`tests/blur.rs` sweeps it). The two resampling filters add
//! `(4^n - 1) / 2` pixels squared of variance, which `plan` subtracts.
//!
//! A blur is given the box its input can be non-zero in and the box of the
//! result that is wanted, and draws each of its passes only where that
//! matters (`regions`). The textures keep the sizes of a blur of the whole
//! canvas, so every pixel that is drawn is computed from the same texels, in
//! the same order, at the same grid phase, and with the same filtered reads
//! (whose sub-texel weights depend on the texture's size) as in a full blur;
//! the pixels that are not drawn are the ones a full blur leaves at zero, or
//! that nothing drawn reads.

use vello::wgpu::{self, util::DeviceExt};

use crate::bounds::PixelRect;
use crate::compositor::{Input, LINEAR_FORMAT, Tex, new_texture};
use crate::pool::Pool;

/// Blurs below this many pixels are skipped: the smallest chain already
/// spreads by about one pixel.
pub const MIN_RADIUS: f32 = 1.0;

/// How many bytes of the pyramid textures of finished blurs are kept for the
/// next. Their sizes follow the radius, so a blur whose radius changes every
/// frame lets the oldest go.
const SCRATCH_BYTES: u64 = 512 << 20;

pub struct Blur {
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    pad: wgpu::RenderPipeline,
    down: wgpu::RenderPipeline,
    gauss: wgpu::RenderPipeline,
    up: wgpu::RenderPipeline,
    /// The images of the pyramid, by size.
    scratch: Pool<Tex>,
}

impl Blur {
    pub fn new(device: &wgpu::Device) -> Blur {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("blur"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/blur.wgsl").into()),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("blur"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("blur"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = |entry: &str| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(entry),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs"),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(entry),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: LINEAR_FORMAT,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        Blur {
            sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            }),
            pad: pipeline("fs_pad"),
            down: pipeline("fs_down"),
            gauss: pipeline("fs_gauss"),
            up: pipeline("fs_up"),
            layout,
            scratch: Pool::new(SCRATCH_BYTES),
        }
    }

    /// Blurs `src` into `dst`, linear textures that hold parts of the
    /// `size` canvas (`Input`: where each sits). `input` is the box `src` can
    /// be non-zero in (the box of the whole canvas for one that is not), and
    /// `output` the part of the result that is wanted, which `dst` must hold;
    /// the rest of `dst` is left transparent, as is all of it where `src` is
    /// transparent and the blur could not reach.
    #[allow(clippy::too_many_arguments)]
    pub fn run(
        &mut self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        src: Input,
        dst: Input,
        size: (u32, u32),
        radius: f32,
        input: PixelRect,
        output: PixelRect,
    ) {
        let plan = Plan::new(size, radius);
        let levels = plan.levels;
        let regions = plan.regions(size, input, output);
        let (padded, sigma) = (plan.padded, plan.sigma);
        let origin = plan.pad as f32;
        // `dst` holds some of the canvas, and the passes that write it work
        // in its texels: a canvas pixel is the texel at `p - dst.origin`, and
        // the pixel of the padded image that it stands for is `p + pad`.
        let to_dst = |r: PixelRect| r.translate(-dst.origin[0], -dst.origin[1]);
        let dst_shift = [origin + dst.origin[0] as f32, origin + dst.origin[1] as f32];

        // chain[k] is the padded image shrunk 2^k times; `spare` takes the
        // horizontal Gaussian pass at the smallest size. They have the
        // sizes of a blur of the whole canvas whatever the boxes are.
        let chain: Vec<Tex> = (0..=levels)
            .map(|k| self.scratch_texture(device, padded.0 >> k, padded.1 >> k))
            .collect();
        let spare = self.scratch_texture(device, padded.0 >> levels, padded.1 >> levels);
        let size = |k: u32| [(padded.0 >> k) as f32, (padded.1 >> k) as f32];

        let mut draw = |pipeline, input, target, params, source, region| {
            self.draw(
                device,
                &mut *encoder,
                pipeline,
                input,
                target,
                params,
                source,
                region,
            );
        };
        let [w0, h0] = size(0);
        let source = [
            src.origin[0],
            src.origin[1],
            src.size[0] as i32,
            src.size[1] as i32,
        ];
        draw(
            &self.pad,
            src.view,
            &chain[0].view,
            [0.0, origin, origin, 0.0, w0, h0, 0.0, 0.0],
            source,
            regions.pad,
        );
        for k in 1..=levels {
            let [w, h] = size(k);
            let input = &chain[k as usize - 1].view;
            let params = [0.0, 0.0, 0.0, 0.0, w, h, 0.0, 0.0];
            draw(
                &self.down,
                input,
                &chain[k as usize].view,
                params,
                NO_SOURCE,
                regions.down[k as usize - 1],
            );
        }
        // At level 0 the vertical pass is the one that writes `dst`.
        let (last, shift, region) = if levels == 0 {
            (dst.view, dst_shift, to_dst(regions.vertical))
        } else {
            (&chain[levels as usize].view, [0.0, 0.0], regions.vertical)
        };
        let [w, h] = size(levels);
        let horizontal = [sigma, 0.0, 0.0, 0.0, w, h, 1.0, 0.0];
        draw(
            &self.gauss,
            &chain[levels as usize].view,
            &spare.view,
            horizontal,
            NO_SOURCE,
            regions.horizontal,
        );
        let vertical = [sigma, shift[0], shift[1], 0.0, w, h, 0.0, 1.0];
        draw(&self.gauss, &spare.view, last, vertical, NO_SOURCE, region);
        for k in (1..=levels).rev() {
            let [w, h] = size(k - 1);
            let input = &chain[k as usize].view;
            if k == 1 {
                draw(
                    &self.up,
                    input,
                    dst.view,
                    [0.0, dst_shift[0], dst_shift[1], 0.0, w, h, 0.0, 0.0],
                    NO_SOURCE,
                    to_dst(regions.up[0]),
                );
            } else {
                let params = [0.0, 0.0, 0.0, 0.0, w, h, 0.0, 0.0];
                draw(
                    &self.up,
                    input,
                    &chain[k as usize - 1].view,
                    params,
                    NO_SOURCE,
                    regions.up[k as usize - 1],
                );
            }
        }
        for texture in chain.into_iter().chain([spare]) {
            self.scratch.put(texture);
        }
    }

    /// Where a blur of `radius` over a `size` texture is non-zero when its
    /// input is non-zero only inside `input`: the box to ask `run` for.
    pub fn reach(size: (u32, u32), radius: f32, input: PixelRect) -> PixelRect {
        let plan = Plan::new(size, radius);
        plan.regions(size, input, PixelRect::whole(size.0, size.1))
            .written
    }

    /// The box of a texture's pixels that a blur of `radius` must read to
    /// give the pixels `output`: the input texture outside it makes no
    /// difference to them.
    pub fn source_for(size: (u32, u32), radius: f32, output: PixelRect) -> PixelRect {
        let plan = Plan::new(size, radius);
        let whole = PixelRect::whole(size.0, size.1);
        plan.regions(size, whole, output).read
    }

    /// An image of the pyramid of exactly this size, from the last blur's if
    /// it left one. Its contents are whatever that blur wrote, which no
    /// pass reads: each clears its target all over first.
    fn scratch_texture(&mut self, device: &wgpu::Device, width: u32, height: u32) -> Tex {
        self.scratch
            .take([width, height])
            .unwrap_or_else(|| new_texture(device, width, height))
    }

    /// One full-screen pass over the box `region` (in texels) of `target`,
    /// which is cleared all over first. `params` and `source` fill the
    /// shader's `Params`.
    #[allow(clippy::too_many_arguments)]
    fn draw(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        pipeline: &wgpu::RenderPipeline,
        input: &wgpu::TextureView,
        target: &wgpu::TextureView,
        params: [f32; 8],
        source: [i32; 4],
        region: PixelRect,
    ) {
        let mut bytes: Vec<u8> = params.iter().flat_map(|v| v.to_le_bytes()).collect();
        bytes.extend(source.iter().flat_map(|v| v.to_le_bytes()));
        let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("blur params"),
            contents: &bytes,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("blur"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(input),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: uniform.as_entire_binding(),
                },
            ],
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("blur"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        if region.is_empty() {
            return;
        }
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.set_scissor_rect(
            region.x0 as u32,
            region.y0 as u32,
            region.width(),
            region.height(),
        );
        pass.draw(0..3, 0..1);
    }
}

/// What `fs_pad` is told of the texture it copies from when no pass reads
/// one.
const NO_SOURCE: [i32; 4] = [0; 4];

/// Smallest Gaussian width, in texels, that hides the coarse grid.
const MIN_SIGMA: f32 = 4.0;

/// Number of down/up levels and the Gaussian's sigma (in texels of the
/// smallest level) for a radius, keeping the sigma at least `MIN_SIGMA`.
fn plan(radius: f32) -> (u32, f32) {
    let mut levels = 0;
    while radius / (2u32 << levels) as f32 >= MIN_SIGMA {
        levels += 1;
    }
    let scale = 4f32.powi(levels as i32);
    let resampling = (scale - 1.0) / 2.0;
    (levels, ((radius * radius - resampling) / scale).sqrt())
}

/// The textures of a blur of a texture of some size and the numbers its
/// passes are made with.
struct Plan {
    levels: u32,
    /// Of the Gaussian, in texels of the smallest level.
    sigma: f32,
    /// Transparent texels around the layer in the level-0 image.
    pad: i32,
    /// The size of the level-0 image, a multiple of `1 << levels`.
    padded: (u32, u32),
    /// How many texels either side of a texel the Gaussian reads, as the
    /// shader works it out from `sigma`.
    reach: i32,
}

/// The box each pass of a blur draws. Boxes are in the texels of the pass's
/// own target, except that those of the passes that write `dst` are in its
/// pixels.
struct Regions {
    /// The pass that copies the layer into `chain[0]`.
    pad: PixelRect,
    /// The pass that makes `chain[k]` from `chain[k - 1]`, at `down[k - 1]`.
    down: Vec<PixelRect>,
    /// The first Gaussian pass, into `spare`.
    horizontal: PixelRect,
    /// The second Gaussian pass: into `chain[levels]`, or into `dst` when
    /// there are no levels.
    vertical: PixelRect,
    /// The pass that makes the image at level `j` from the one at `j + 1`, at
    /// `up[j]`; `up[0]` writes `dst`.
    up: Vec<PixelRect>,
    /// The part of `dst` the last pass draws.
    written: PixelRect,
    /// The part of the source the first pass copies, in the source's pixels.
    read: PixelRect,
}

impl Plan {
    fn new(size: (u32, u32), radius: f32) -> Plan {
        let (levels, sigma) = plan(radius);
        let step = 1u32 << levels;
        let pad = (3.0 * radius).ceil() as u32;
        // Rounded up so every level is exactly half the size of the last.
        let padded = (
            (size.0 + 2 * pad).next_multiple_of(step),
            (size.1 + 2 * pad).next_multiple_of(step),
        );
        Plan {
            levels,
            sigma,
            pad: pad as i32,
            padded,
            reach: (3.0 * sigma).ceil() as i32,
        }
    }

    /// Which pixels of each pass to draw to get the pixels `output` of the
    /// result of a source of `size` that is transparent outside `input`.
    ///
    /// Each image gets the pixels that can be non-zero in it (found from
    /// `input`, forwards through the passes) that the pixels wanted at the
    /// end read (found from `output`, backwards). Where the first is false
    /// the full blur has zero, which is what an undrawn pixel holds; where
    /// the second is false nothing drawn looks at it. Each step grows a box
    /// by the texels the pass reads for one pixel, as the shader's sampling
    /// works out: the samplers clamp to the edge, which is why the boxes are
    /// cut to the texture only after the step, and the Gaussian's reach gets
    /// one texel more than it computes, in case the shader's `ceil` and
    /// ours differ in the last place of a float.
    fn regions(&self, size: (u32, u32), input: PixelRect, output: PixelRect) -> Regions {
        let n = self.levels as usize;
        let (pad, reach) = (self.pad, self.reach + 1);
        let canvas = PixelRect::whole(size.0, size.1);
        let level = |k: usize| PixelRect::whole(self.padded.0 >> k, self.padded.1 >> k);
        let to_canvas = |r: PixelRect| r.translate(-pad, -pad).intersect(canvas);

        // Forwards: where each image can be non-zero.
        let f_pad = input
            .intersect(canvas)
            .translate(pad, pad)
            .intersect(level(0));
        let mut f_down = Vec::with_capacity(n);
        let mut last = f_pad;
        for k in 1..=n {
            last = halve(last).intersect(level(k));
            f_down.push(last);
        }
        let f_horizontal = last.grow(reach, 0).intersect(level(n));
        let f_vertical = f_horizontal.grow(0, reach).intersect(level(n));
        let mut f_up = vec![PixelRect::EMPTY; n];
        let mut last = f_vertical;
        for j in (0..n).rev() {
            last = double(last).intersect(level(j));
            f_up[j] = last;
        }

        // Backwards: what is read to make the pixels wanted.
        let wanted = output
            .intersect(canvas)
            .translate(pad, pad)
            .intersect(level(0));
        let mut n_up = vec![PixelRect::EMPTY; n];
        let n_vertical = if n == 0 {
            wanted
        } else {
            let mut need = wanted;
            n_up[0] = need;
            for (j, slot) in n_up.iter_mut().enumerate().skip(1) {
                need = halve(need).intersect(level(j));
                *slot = need;
            }
            halve(need).intersect(level(n))
        };
        let n_horizontal = n_vertical.grow(0, reach).intersect(level(n));
        let mut need = n_horizontal.grow(reach, 0).intersect(level(n));
        let mut n_down = vec![PixelRect::EMPTY; n];
        for k in (1..=n).rev() {
            n_down[k - 1] = need;
            need = double(need).intersect(level(k - 1));
        }
        let n_pad = need;

        let both = |f: PixelRect, n: PixelRect| f.intersect(n);
        let mut up: Vec<_> = (0..n).map(|j| both(f_up[j], n_up[j])).collect();
        let vertical = both(f_vertical, n_vertical);
        let written = if n == 0 {
            to_canvas(vertical)
        } else {
            up[0] = to_canvas(up[0]);
            up[0]
        };
        Regions {
            pad: both(f_pad, n_pad),
            down: (0..n).map(|k| both(f_down[k], n_down[k])).collect(),
            horizontal: both(f_horizontal, n_horizontal),
            vertical: if n == 0 { written } else { vertical },
            up,
            written,
            read: to_canvas(n_pad),
        }
    }
}

/// The texels of the image half the size that read a texel of `r` (what
/// `fs_down` reads: texel `t` takes `2t - 1` to `2t + 2` of the finer one),
/// and the texels of the coarser image that the finer texels `r` read (what
/// `fs_up` reads: texel `p` takes `(p - 1) / 2` and `(p + 1) / 2`, rounded
/// down).
fn halve(r: PixelRect) -> PixelRect {
    if r.is_empty() {
        return PixelRect::EMPTY;
    }
    PixelRect::new(
        (r.x0 - 1).div_euclid(2),
        (r.y0 - 1).div_euclid(2),
        r.x1.div_euclid(2) + 1,
        r.y1.div_euclid(2) + 1,
    )
}

/// The texels of the image twice the size that read a texel of `r` (what
/// `fs_up` reads, the other way round), and the texels of the finer image
/// that the texels `r` of the half-size one read (what `fs_down` reads).
fn double(r: PixelRect) -> PixelRect {
    if r.is_empty() {
        return PixelRect::EMPTY;
    }
    PixelRect::new(2 * r.x0 - 1, 2 * r.y0 - 1, 2 * r.x1 + 1, 2 * r.y1 + 1)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::{MIN_SIGMA, Plan, double, halve, plan};
    use crate::bounds::PixelRect;

    #[test]
    fn gaussian_stays_wide_enough() {
        for radius in [1.0, 2.0, 7.9, 8.0, 12.0, 44.0, 64.0, 127.0, 128.0] {
            let (levels, sigma) = plan(radius);
            let narrowest = if levels == 0 { 1.0 } else { MIN_SIGMA - 0.1 };
            assert!(sigma >= narrowest, "radius {radius}: {sigma}");
            assert!(sigma < 2.0 * MIN_SIGMA, "radius {radius}: {sigma}");
        }
    }

    // One row of a texture, read the way the shaders' sampler reads: texel
    // `i` has its centre at `i + 0.5`, reads are bilinear and clamp to the
    // edge. These functions are the shaders' arithmetic in one dimension.
    fn sample(row: &[f64], x: f64) -> f64 {
        let q = x - 0.5;
        let i = q.floor();
        let f = q - i;
        let at = |i: f64| row[(i as i64).clamp(0, row.len() as i64 - 1) as usize];
        at(i) * (1.0 - f) + at(i + 1.0) * f
    }

    /// `fs_down`: the output texel's centre is at `2t + 1` in the finer
    /// image, and it reads 0.75 either side of it.
    fn shrink(row: &[f64], drawn: impl Fn(usize) -> bool) -> Vec<f64> {
        (0..row.len() / 2)
            .map(|t| {
                let c = 2.0 * t as f64 + 1.0;
                if drawn(t) {
                    0.5 * (sample(row, c - 0.75) + sample(row, c + 0.75))
                } else {
                    0.0
                }
            })
            .collect()
    }

    /// `fs_gauss` along the row.
    fn gauss(row: &[f64], sigma: f32, drawn: impl Fn(usize) -> bool) -> Vec<f64> {
        let sigma = f64::from(sigma);
        let reach = (3.0 * sigma).ceil() as i32;
        let weight = |i: i32| (-0.5 * f64::from(i * i) / (sigma * sigma)).exp();
        (0..row.len())
            .map(|q| {
                if !drawn(q) {
                    return 0.0;
                }
                let centre = q as f64 + 0.5;
                let (mut sum, mut weights) = (row[q], 1.0);
                for i in (1..=reach).step_by(2) {
                    let w1 = weight(i);
                    let w2 = if i < reach { weight(i + 1) } else { 0.0 };
                    let w = w1 + w2;
                    let offset = f64::from(i) + w2 / w;
                    sum += w * (sample(row, centre + offset) + sample(row, centre - offset));
                    weights += 2.0 * w;
                }
                sum / weights
            })
            .collect()
    }

    /// `fs_up`: texel `p` of the finer image reads the coarser one at
    /// `(p + 0.5) / 2`.
    fn enlarge(coarse: &[f64], drawn: impl Fn(usize) -> bool) -> Vec<f64> {
        (0..coarse.len() * 2)
            .map(|p| {
                if drawn(p) {
                    sample(coarse, (p as f64 + 0.5) / 2.0)
                } else {
                    0.0
                }
            })
            .collect()
    }

    #[derive(Clone, Copy, Debug)]
    pub(crate) enum Axis {
        X,
        Y,
    }

    /// A blur of one row of a `size` canvas along `axis`, as `blur_row`
    /// works it out: with the boxes `Blur::run` would be given for a source
    /// that is zero outside `input` and the pixels `output` wanted, drawing
    /// only those if `restricted`, or everywhere.
    pub(crate) fn blur_axis(
        size: (u32, u32),
        radius: f32,
        src: &[f64],
        axis: Axis,
        input: PixelRect,
        output: PixelRect,
        restricted: bool,
    ) -> Vec<f64> {
        let plan = Plan::new(size, radius);
        let regions = restricted.then(|| plan.regions(size, input, output));
        blur_row(&plan, src, axis, regions.as_ref())
    }

    /// A blur of one row (`src`, along `axis` of the canvas), drawing only
    /// where `regions` says, or everywhere without them. The Gaussian pass
    /// along the other axis leaves a row as it is. Returns the canvas pixels.
    fn blur_row(
        plan: &Plan,
        src: &[f64],
        axis: Axis,
        regions: Option<&super::Regions>,
    ) -> Vec<f64> {
        let n = plan.levels as usize;
        let span = |r: PixelRect| match axis {
            Axis::X => (r.x0, r.x1),
            Axis::Y => (r.y0, r.y1),
        };
        let inside = |regions: Option<&super::Regions>,
                      pick: &dyn Fn(&super::Regions) -> PixelRect,
                      shift: i32,
                      t: usize| {
            regions.is_none_or(|r| {
                let (lo, hi) = span(pick(r));
                let t = t as i32 + shift;
                t >= lo && t < hi
            })
        };
        let dim = |k: usize| {
            (match axis {
                Axis::X => plan.padded.0,
                Axis::Y => plan.padded.1,
            } >> k) as usize
        };
        let mut image: Vec<f64> = (0..dim(0))
            .map(|p| {
                let c = p as i32 - plan.pad;
                let there = c >= 0 && (c as usize) < src.len();
                if there && inside(regions, &|r| r.pad, 0, p) {
                    src[c as usize]
                } else {
                    0.0
                }
            })
            .collect();
        for k in 1..=n {
            image = shrink(&image, |t| inside(regions, &|r| r.down[k - 1], 0, t));
        }
        // The horizontal pass is the Gaussian along x and a plain copy
        // along y; the vertical pass the other way round. With no levels
        // the vertical pass is also where the result goes, and its box is in
        // canvas pixels.
        let copy = |row: &[f64], drawn: &dyn Fn(usize) -> bool| -> Vec<f64> {
            row.iter()
                .enumerate()
                .map(|(t, v)| if drawn(t) { *v } else { 0.0 })
                .collect()
        };
        let horizontal = |t: usize| inside(regions, &|r| r.horizontal, 0, t);
        let shift = if n == 0 { -plan.pad } else { 0 };
        let vertical = |t: usize| inside(regions, &|r| r.vertical, shift, t);
        image = match axis {
            Axis::X => {
                let h = gauss(&image, plan.sigma, horizontal);
                copy(&h, &vertical)
            }
            Axis::Y => {
                let h = copy(&image, &horizontal);
                gauss(&h, plan.sigma, vertical)
            }
        };
        for j in (0..n).rev() {
            let shift = if j == 0 { -plan.pad } else { 0 };
            image = enlarge(&image, |p| inside(regions, &|r| r.up[j], shift, p));
        }
        (0..src.len())
            .map(|c| image[c + plan.pad as usize])
            .collect()
    }

    /// Deterministic values in 0.25..1.
    fn values(seed: u32, n: usize) -> Vec<f64> {
        let mut state = seed.wrapping_mul(2_654_435_761).wrapping_add(12345);
        (0..n)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                0.25 + 0.75 * f64::from(state >> 8) / f64::from(1u32 << 24)
            })
            .collect()
    }

    /// Blurring only the drawn boxes gives the full blur's pixels in the
    /// wanted box, and the full blur is zero outside the box `written`.
    #[test]
    fn blurring_the_boxes_gives_the_pixels_of_the_full_blur() {
        let size = (53usize, 47usize);
        for radius in [1.0, 3.0, 5.5, 9.0, 12.0, 17.0, 33.0, 70.0] {
            let plan = Plan::new((size.0 as u32, size.1 as u32), radius);
            // The layer sits in `input`; the pixels wanted are `output`,
            // or all of them.
            for (seed, input, output) in [
                (1, PixelRect::new(20, 15, 31, 30), None),
                (2, PixelRect::new(0, 0, 53, 47), None),
                (3, PixelRect::new(40, 30, 53, 47), None),
                (4, PixelRect::new(0, 0, 4, 3), None),
                (5, PixelRect::new(22, 21, 23, 22), None),
                (
                    6,
                    PixelRect::new(0, 0, 53, 47),
                    Some(PixelRect::new(30, 2, 41, 19)),
                ),
                (
                    7,
                    PixelRect::new(0, 0, 53, 47),
                    Some(PixelRect::new(0, 0, 3, 47)),
                ),
                (
                    8,
                    PixelRect::new(10, 10, 40, 35),
                    Some(PixelRect::new(18, 20, 36, 24)),
                ),
            ] {
                let canvas = PixelRect::whole(53, 47);
                let wanted = output.unwrap_or(canvas);
                let regions = plan.regions((53, 47), input, wanted);
                for axis in [Axis::X, Axis::Y] {
                    let (len, lo, hi, wlo, whi, rlo, rhi) = match axis {
                        Axis::X => (
                            size.0,
                            input.x0,
                            input.x1,
                            wanted.x0,
                            wanted.x1,
                            regions.written.x0,
                            regions.written.x1,
                        ),
                        Axis::Y => (
                            size.1,
                            input.y0,
                            input.y1,
                            wanted.y0,
                            wanted.y1,
                            regions.written.y0,
                            regions.written.y1,
                        ),
                    };
                    let mut src = values(seed, len);
                    for (i, v) in src.iter_mut().enumerate() {
                        if (i as i32) < lo || (i as i32) >= hi {
                            *v = 0.0;
                        }
                    }
                    let full = blur_row(&plan, &src, axis, None);
                    let drawn = blur_row(&plan, &src, axis, Some(&regions));
                    let case = format!(
                        "radius {radius}, seed {seed}, \
                             {} levels",
                        plan.levels
                    );
                    for c in wlo.max(0)..whi.min(len as i32) {
                        let c = c as usize;
                        assert_eq!(full[c], drawn[c], "{case}: pixel {c}");
                    }
                    // The full blur is zero where no pass draws.
                    for (c, v) in full.iter().enumerate() {
                        let outside = (c as i32) < rlo || (c as i32) >= rhi;
                        if outside && output.is_none() {
                            assert_eq!(*v, 0.0, "{case}: pixel {c} is {v}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn what_a_blur_reads_and_where_it_reaches() {
        let size = (200u32, 100u32);
        let canvas = PixelRect::whole(200, 100);
        // A small layer in the middle: the blur reaches past it by about
        // three radii, and no further than the padding of the full blur.
        let input = PixelRect::new(90, 40, 110, 60);
        let reach = super::Blur::reach(size, 10.0, input);
        assert!(reach.x0 < 90 - 20 && reach.x0 > 90 - 50, "{reach:?}");
        assert!(reach.x1 > 110 + 20 && reach.x1 < 110 + 50, "{reach:?}");
        assert!(reach.y0 < 40 - 20 && reach.y1 > 60 + 20, "{reach:?}");
        assert_eq!(reach, reach.intersect(canvas));
        // Nothing in, nothing out.
        assert_eq!(
            super::Blur::reach(size, 10.0, PixelRect::EMPTY),
            PixelRect::EMPTY
        );
        // A layer at the edge: the reach is cut to the texture.
        let corner = super::Blur::reach(size, 10.0, PixelRect::new(0, 0, 5, 5));
        assert_eq!((corner.x0, corner.y0), (0, 0));
        // What a blur reads to make a few pixels: those and the radius's
        // worth of neighbours, never more than the pad around them.
        let read = super::Blur::source_for(size, 10.0, PixelRect::new(100, 50, 104, 54));
        assert!(read.x0 < 100 - 20 && read.x0 > 100 - 50, "{read:?}");
        assert!(read.x1 > 104 + 20 && read.x1 < 104 + 50, "{read:?}");
    }

    #[test]
    fn halving_and_doubling_take_the_texels_the_shaders_read() {
        // fs_down: texel t reads 2t - 1 ..= 2t + 2. Which texels read texel
        // x? The ones with 2t - 1 <= x <= 2t + 2.
        for x in -6..40 {
            let r = PixelRect::new(x, 0, x + 1, 1);
            let readers: Vec<i32> = (-30..30)
                .filter(|t| 2 * t - 1 <= x && x <= 2 * t + 2)
                .collect();
            let h = halve(r);
            assert_eq!(
                (h.x0, h.x1 - 1),
                (readers[0], readers[readers.len() - 1]),
                "{x}"
            );
        }
        // Coarse texels t0..t1 read finer 2 t0 - 1 ..= 2 (t1 - 1) + 2.
        let d = double(PixelRect::new(3, 0, 8, 1));
        assert_eq!((d.x0, d.x1), (5, 17));
        // fs_up: finer texel p reads coarse (p - 1) / 2 and (p + 1) / 2,
        // rounded down; which coarse texels do a run of finer texels read?
        for lo in -4..20 {
            for len in 1..6 {
                let hi = lo + len;
                let reads: Vec<i32> = (lo..hi)
                    .flat_map(|p: i32| [(p - 1).div_euclid(2), (p + 1).div_euclid(2)])
                    .collect();
                let h = halve(PixelRect::new(lo, 0, hi, 1));
                assert_eq!(
                    (h.x0, h.x1 - 1),
                    (*reads.iter().min().unwrap(), *reads.iter().max().unwrap()),
                    "{lo}..{hi}"
                );
            }
        }
    }
}
