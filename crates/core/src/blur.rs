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

use std::sync::Arc;


use crate::bounds::PixelRect;
use crate::compositor::{Input, LINEAR_FORMAT, Tex, new_texture};
use crate::pass_timer::{self, PassTimer};
use crate::pool::Pool;
use crate::uniforms::Uniforms;

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
    /// The compositor's pass timer, when it is on.
    pub(crate) timer: Option<Arc<PassTimer>>,
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
            timer: None,
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
        uniforms: &mut Uniforms,
        src: Input,
        dst: Input,
        size: (u32, u32),
        radius: f32,
        input: PixelRect,
        output: PixelRect,
    ) {
        let pad = PadSource {
            rect: [
                src.origin[0],
                src.origin[1],
                src.size[0] as i32,
                src.size[1] as i32,
            ],
            texel: [0, 0],
            mirror: NO_SOURCE,
            shrink: 1,
        };
        self.run_with(
            device, encoder, uniforms, src.view, pad, dst, size, radius, input, output,
        );
    }

    /// A blur as a browser draws `backdrop-filter: blur()`: `src` (which
    /// has content only inside `bounds`, the canvas's pixels; transparent
    /// outside) read only inside `frost`, mirrored past its edges, blurred,
    /// into `dst`, which must hold `frost`.
    ///
    /// The blur runs on a canvas of its own: `frost` with the blur's reach on
    /// every side, all of it the box mirrored. When that canvas would be
    /// larger than a texture can be (`MAX_SIDE`), it is drawn shrunk by a
    /// power of two (each texel the mean of a square of the mirrored
    /// source), blurred by the radius shrunk the same, and enlarged into
    /// `dst` bilinearly: the blur is then at least `MIN_SIGMA` texels wide
    /// at that size, so the enlarging cannot show.
    #[allow(clippy::too_many_arguments)]
    pub fn run_mirrored(
        &mut self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        uniforms: &mut Uniforms,
        src: Input,
        bounds: PixelRect,
        dst: Input,
        frost: PixelRect,
        radius: f32,
    ) {
        let m = MirrorPlan::new(frost, radius);
        let s = m.shrink as i32;
        // Canvas pixel `c` is pixel `c + shift` of the mirrored canvas at
        // full size, and its pixel `l` is texel `l / s` of the shrunk one.
        let shift = [m.room - frost.x0, m.room - frost.y0];
        let source = bounds.intersect(PixelRect::new(
            src.origin[0],
            src.origin[1],
            src.origin[0] + src.size[0] as i32,
            src.origin[1] + src.size[1] as i32,
        ));
        let pad = PadSource {
            rect: [
                source.x0 + shift[0],
                source.y0 + shift[1],
                source.width() as i32,
                source.height() as i32,
            ],
            texel: [source.x0 - src.origin[0], source.y0 - src.origin[1]],
            mirror: [
                m.room,
                m.room,
                m.room + frost.width() as i32,
                m.room + frost.height() as i32,
            ],
            shrink: m.shrink,
        };
        let whole = PixelRect::whole(m.size.0, m.size.1);
        if s == 1 {
            let mut dst = dst;
            dst.origin = [dst.origin[0] + shift[0], dst.origin[1] + shift[1]];
            let inner = frost.translate(shift[0], shift[1]);
            self.run_with(
                device, encoder, uniforms, src.view, pad, dst, m.size, radius, whole, inner,
            );
            return;
        }
        // Shrunk: blur into a texture of the texels the enlarging reads,
        // then enlarge it into `dst` over `frost`.
        let inner = m.inner;
        let temp = self.scratch_texture(device, inner.width(), inner.height());
        let temp_input = Input {
            view: &temp.view,
            origin: [inner.x0, inner.y0],
            size: [inner.width(), inner.height()],
        };
        self.run_with(
            device,
            encoder,
            uniforms,
            src.view,
            pad,
            temp_input,
            m.size,
            radius / s as f32,
            whole,
            inner,
        );
        // `fs_up` reads texel `(p + a) / b * size` of `temp` for the texel `p`
        // of `dst`: its full-size mirrored pixel is `p + dst.origin + shift`,
        // the shrunk one that over `s`, and `temp` starts at `inner`.
        let a = [
            (dst.origin[0] + shift[0] - s * inner.x0) as f32,
            (dst.origin[1] + shift[1] - s * inner.y0) as f32,
        ];
        let b = [
            (s as u32 * inner.width()) as f32,
            (s as u32 * inner.height()) as f32,
        ];
        let region = frost.translate(-dst.origin[0], -dst.origin[1]);
        self.draw(
            device,
            encoder,
            uniforms,
            &self.up,
            &temp.view,
            dst.view,
            [0.0, a[0], a[1], 0.0, b[0], b[1], 0.0, 0.0],
            NO_INTS,
            region,
        );
        self.scratch.put(temp);
    }

    /// `run`, reading the source as `pad` says (`fs_pad`), from `src`.
    #[allow(clippy::too_many_arguments)]
    fn run_with(
        &mut self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        uniforms: &mut Uniforms,
        src: &wgpu::TextureView,
        pad_source: PadSource,
        dst: Input,
        size: (u32, u32),
        radius: f32,
        input: PixelRect,
        output: PixelRect,
    ) {
        let plan = Plan::new(size, radius);
        let levels = plan.levels;
        let regions = plan.regions(size, input, output);
        let (sigma, pad) = (plan.sigma, plan.pad);
        let win = &plan.windows;
        // Each image of the pyramid holds the window `win[k]` of its level
        // (`spare` holds `plan.spare`); a pass is told where its target's
        // and its input's texel (0, 0) are in the level's texels. `dst`
        // holds some of the canvas: its texel `p` is the texel `p +
        // dst.origin + pad` of level 0.
        let at = |r: PixelRect| [r.x0 as f32, r.y0 as f32];
        let local = |r: PixelRect, w: PixelRect| r.translate(-w.x0, -w.y0);
        let to_dst = |r: PixelRect| r.translate(-dst.origin[0], -dst.origin[1]);
        let dst_at = [(pad + dst.origin[0]) as f32, (pad + dst.origin[1]) as f32];

        let chain: Vec<Tex> = win
            .iter()
            .map(|w| self.scratch_texture(device, w.width(), w.height()))
            .collect();
        let spare = self.scratch_texture(device, plan.spare.width(), plan.spare.height());
        let dims = |w: PixelRect| [w.width() as f32, w.height() as f32];

        let mut draw = |pipeline, input, target, params, ints, region| {
            self.draw(
                device,
                &mut *encoder,
                &mut *uniforms,
                pipeline,
                input,
                target,
                params,
                ints,
                region,
            );
        };
        let [w0, h0] = dims(win[0]);
        let o0 = at(win[0]);
        draw(
            &self.pad,
            src,
            &chain[0].view,
            [
                0.0,
                pad as f32 - o0[0],
                pad as f32 - o0[1],
                pad_source.shrink as f32,
                w0,
                h0,
                pad_source.texel[0] as f32,
                pad_source.texel[1] as f32,
            ],
            [pad_source.rect, pad_source.mirror],
            local(regions.pad, win[0]),
        );
        for k in 1..=levels as usize {
            let (wk, wi) = (at(win[k]), at(win[k - 1]));
            let [w, h] = dims(win[k]);
            let params = [
                0.0,
                2.0 * wk[0] - wi[0],
                2.0 * wk[1] - wi[1],
                0.0,
                w,
                h,
                0.0,
                0.0,
            ];
            draw(
                &self.down,
                &chain[k - 1].view,
                &chain[k].view,
                params,
                NO_INTS,
                local(regions.down[k - 1], win[k]),
            );
        }
        let n = levels as usize;
        let (on, os) = (at(win[n]), at(plan.spare));
        let [w, h] = dims(win[n]);
        let horizontal = [sigma, os[0] - on[0], os[1] - on[1], 0.0, w, h, 1.0, 0.0];
        draw(
            &self.gauss,
            &chain[n].view,
            &spare.view,
            horizontal,
            NO_INTS,
            local(regions.horizontal, plan.spare),
        );
        // At level 0 the vertical pass is the one that writes `dst`.
        let (last, shift, region) = if levels == 0 {
            (
                dst.view,
                [dst_at[0] - os[0], dst_at[1] - os[1]],
                to_dst(regions.vertical),
            )
        } else {
            (
                &chain[n].view,
                [on[0] - os[0], on[1] - os[1]],
                local(regions.vertical, win[n]),
            )
        };
        let vertical = [sigma, shift[0], shift[1], 0.0, w, h, 0.0, 1.0];
        draw(&self.gauss, &spare.view, last, vertical, NO_INTS, region);
        for k in (1..=n).rev() {
            let wk = at(win[k]);
            let [w, h] = dims(win[k]);
            let (target, out_at, region) = if k == 1 {
                (dst.view, dst_at, to_dst(regions.up[0]))
            } else {
                (
                    &chain[k - 1].view,
                    at(win[k - 1]),
                    local(regions.up[k - 1], win[k - 1]),
                )
            };
            let params = [
                0.0,
                out_at[0] - 2.0 * wk[0],
                out_at[1] - 2.0 * wk[1],
                0.0,
                2.0 * w,
                2.0 * h,
                0.0,
                0.0,
            ];
            draw(&self.up, &chain[k].view, target, params, NO_INTS, region);
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
    /// which is cleared all over first. `params` and `ints` (the source and
    /// the mirror box) fill the shader's `Params`.
    #[allow(clippy::too_many_arguments)]
    fn draw(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        uniforms: &mut Uniforms,
        pipeline: &wgpu::RenderPipeline,
        input: &wgpu::TextureView,
        target: &wgpu::TextureView,
        params: [f32; 8],
        ints: [[i32; 4]; 2],
        region: PixelRect,
    ) {
        let mut bytes: Vec<u8> = params.iter().flat_map(|v| v.to_le_bytes()).collect();
        bytes.extend(ints.iter().flatten().flat_map(|v| v.to_le_bytes()));
        let uniform = uniforms.push(&bytes);
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
                    resource: uniform.binding(),
                },
            ],
        });
        let name = if std::ptr::eq(pipeline, &self.pad) {
            "blur pad"
        } else if std::ptr::eq(pipeline, &self.down) {
            "blur down"
        } else if std::ptr::eq(pipeline, &self.gauss) {
            "blur gaussian"
        } else {
            "blur up"
        };
        let stamp = self.timer.as_ref().map(|t| t.stamp(name, target));
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
            timestamp_writes: pass_timer::writes(&stamp),
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
/// one, and of the box it mirrors when it mirrors none.
const NO_SOURCE: [i32; 4] = [0; 4];

/// The largest side of a texture a blur makes: the device's limit
/// (`wgpu::Limits::default`), which is also the largest canvas.
const MAX_SIDE: u32 = crate::scene::MAX_SIDE;

/// What `fs_pad` reads: the box `rect` (`x, y, width, height`, in the blur's
/// canvas pixels) of the source, whose corner is the source's texel `texel`;
/// the box `mirror` (`x0, y0, x1, y1`) mirrored past its edges, if not
/// empty; each texel the mean of a `shrink` x `shrink` square of those
/// pixels.
#[derive(Clone, Copy)]
struct PadSource {
    rect: [i32; 4],
    texel: [i32; 2],
    mirror: [i32; 4],
    shrink: u32,
}

/// The canvas of a mirrored blur (`Blur::run_mirrored`) of a box `frost`.
#[derive(Debug, PartialEq)]
struct MirrorPlan {
    /// The blur's reach past the box, at full size.
    room: i32,
    /// How many times the canvas is shrunk on each side, a power of two.
    shrink: u32,
    /// The size of the (shrunk) canvas.
    size: (u32, u32),
    /// The texels of the shrunk canvas that the enlarging into the box reads.
    inner: PixelRect,
}

impl MirrorPlan {
    fn new(frost: PixelRect, radius: f32) -> MirrorPlan {
        let room = (3.0 * f64::from(radius)).ceil() as i32 + 2;
        let full = (
            frost.width() + 2 * room as u32,
            frost.height() + 2 * room as u32,
        );
        // Room for the windows' border of texels (`Plan::windows`).
        let mut shrink = 1u32;
        while full.0.div_ceil(shrink).max(full.1.div_ceil(shrink)) + 8 > MAX_SIDE {
            shrink *= 2;
        }
        let size = (full.0.div_ceil(shrink), full.1.div_ceil(shrink));
        let s = shrink as i32;
        // The box in shrunk texels, grown by one for the bilinear reads.
        let inner = PixelRect::new(
            room.div_euclid(s) - 1,
            room.div_euclid(s) - 1,
            (room + frost.width() as i32 + s - 1).div_euclid(s) + 1,
            (room + frost.height() as i32 + s - 1).div_euclid(s) + 1,
        )
        .intersect(PixelRect::whole(size.0, size.1));
        MirrorPlan {
            room,
            shrink,
            size,
            inner,
        }
    }
}

/// The integers of a pass that is not `fs_pad`.
const NO_INTS: [[i32; 4]; 2] = [NO_SOURCE; 2];

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
    /// The texels of each level's image that a blur of anything in the
    /// canvas draws, with a border of untouched ones (`windows`): only these
    /// are kept, so a large radius needs no texture larger than the canvas
    /// but at the smallest level.
    windows: Vec<PixelRect>,
    /// The same for `spare`, the horizontal Gaussian's image.
    spare: PixelRect,
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
        let mut plan = Plan {
            levels,
            sigma,
            pad: pad as i32,
            padded,
            reach: (3.0 * sigma).ceil() as i32,
            windows: Vec::new(),
            spare: PixelRect::EMPTY,
        };
        (plan.windows, plan.spare) = plan.windows(size);
        plan
    }

    /// The part of each level's image (and of `spare`) that is ever drawn,
    /// for any input and output in the canvas, grown by two texels and cut
    /// to the level. A pass reads only texels its draws can reach, and a
    /// texel of the full image outside these is never drawn, so zero: the
    /// border is zero too, and a read past it, clamped to it, is zero as well
    /// (where a window meets the edge of the level, the clamp is the full
    /// image's). So a blur in the windows draws the pixels of a blur in the
    /// full images.
    fn windows(&self, size: (u32, u32)) -> (Vec<PixelRect>, PixelRect) {
        let n = self.levels as usize;
        let whole = PixelRect::whole(size.0, size.1);
        let r = self.regions(size, whole, whole);
        let level = |k: usize| PixelRect::whole(self.padded.0 >> k, self.padded.1 >> k);
        // Level 0 gets the pad pass, level k the down pass that makes it, the
        // smallest level the vertical Gaussian too, and the ones between the
        // up pass that makes them.
        let mut drawn: Vec<PixelRect> = std::iter::once(r.pad)
            .chain(r.down.iter().copied())
            .collect();
        if n > 0 {
            drawn[n] = drawn[n].union(r.vertical);
        }
        for (d, up) in drawn.iter_mut().zip(&r.up).take(n).skip(1) {
            *d = d.union(*up);
        }
        // No wider than a texture can be: a window that would be (the
        // whole of a canvas of `MAX_SIDE`) loses some of its border, and the
        // reads past its edge clamp to drawn texels there.
        let fit = |lo: i32, hi: i32, d0: i32, d1: i32| {
            let max = MAX_SIDE as i32;
            if hi - lo <= max {
                return (lo, hi);
            }
            let lo = lo.max(d0 - (max - (d1 - d0)).max(0) / 2);
            (lo, hi.min(lo + max))
        };
        let window = |d: PixelRect, k: usize| {
            if d.is_empty() {
                return PixelRect::new(0, 0, 1, 1);
            }
            let w = d.grow(2, 2).intersect(level(k));
            let (x0, x1) = fit(w.x0, w.x1, d.x0, d.x1);
            let (y0, y1) = fit(w.y0, w.y1, d.y0, d.y1);
            PixelRect::new(x0, y0, x1, y1)
        };
        let windows = drawn
            .iter()
            .enumerate()
            .map(|(k, d)| window(*d, k))
            .collect();
        (windows, window(r.horizontal, n))
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
    use super::{MAX_SIDE, MIN_SIGMA, MirrorPlan, Plan, double, halve, plan};
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

    /// Every pass of a blur of anything in the canvas draws inside the
    /// windows the images keep, a texel in from their edge unless the edge is
    /// the level's; and a wide blur keeps no image much larger than the
    /// canvas but the smallest.
    /// No texture of a blur is wider than a texture can be: a mirrored blur's
    /// canvas is shrunk until it fits, and a canvas of the largest size keeps
    /// its windows within it.
    #[test]
    fn no_blur_texture_passes_the_largest_side() {
        let fits = |plan: &Plan| {
            plan.windows
                .iter()
                .chain([&plan.spare])
                .all(|w| w.width() <= MAX_SIDE && w.height() <= MAX_SIDE)
        };
        for (side, radius) in [(1920, 1100.0), (8192, 16384.0), (8192, 1.0), (100, 16384.0)] {
            let frost = PixelRect::new(5, 7, 5 + side, 7 + side / 2);
            let m = MirrorPlan::new(frost, radius);
            assert!(
                m.size.0 + 8 <= MAX_SIDE && m.size.1 + 8 <= MAX_SIDE,
                "{m:?}"
            );
            let plan = Plan::new(m.size, radius / m.shrink as f32);
            assert!(
                fits(&plan),
                "mirrored {side} at {radius}: {:?}",
                plan.windows
            );
            // The texels the enlarging reads hold the whole box.
            let s = m.shrink as i32;
            assert!(m.inner.x0 * s <= m.room, "{m:?}");
            assert!(m.inner.x1 * s >= m.room + side, "{m:?}");
        }
        // 1920 + 6 * 1100 does not fit: half size.
        let wide = MirrorPlan::new(PixelRect::new(0, 0, 1920, 200), 1100.0);
        assert_eq!(wide.shrink, 2);
        let small = MirrorPlan::new(PixelRect::new(0, 0, 400, 100), 10.0);
        assert_eq!(small.shrink, 1);
        for radius in [1.0, 128.0, 1000.0, 16384.0] {
            assert!(fits(&Plan::new((MAX_SIDE, MAX_SIDE), radius)), "{radius}");
        }
    }

    #[test]
    fn the_windows_hold_every_draw_and_stay_small() {
        let size = (1920u32, 1080u32);
        let canvas = PixelRect::whole(size.0, size.1);
        for radius in [1.0, 9.0, 64.0, 128.0, 300.0, 1000.0, 16384.0] {
            let plan = Plan::new(size, radius);
            let n = plan.levels as usize;
            let level = |k: usize| PixelRect::whole(plan.padded.0 >> k, plan.padded.1 >> k);
            let inside = |r: PixelRect, w: PixelRect, k: usize| {
                let l = level(k);
                r.is_empty()
                    || (r.intersect(w) == r
                        && (w.x0 == l.x0 || r.x0 - w.x0 >= 1)
                        && (w.y0 == l.y0 || r.y0 - w.y0 >= 1)
                        && (w.x1 == l.x1 || w.x1 - r.x1 >= 1)
                        && (w.y1 == l.y1 || w.y1 - r.y1 >= 1))
            };
            for (input, output) in [
                (canvas, canvas),
                (PixelRect::new(0, 0, 10, 10), canvas),
                (
                    PixelRect::new(1900, 1000, 1920, 1080),
                    PixelRect::new(0, 0, 50, 50),
                ),
                (
                    PixelRect::new(900, 500, 1000, 600),
                    PixelRect::new(950, 550, 960, 560),
                ),
            ] {
                let r = plan.regions(size, input, output);
                let case = format!("radius {radius}, {input:?} to {output:?}");
                assert!(inside(r.pad, plan.windows[0], 0), "{case}: pad");
                for k in 1..=n {
                    assert!(
                        inside(r.down[k - 1], plan.windows[k], k),
                        "{case}: down {k}"
                    );
                }
                assert!(inside(r.horizontal, plan.spare, n), "{case}: horizontal");
                if n > 0 {
                    assert!(inside(r.vertical, plan.windows[n], n), "{case}: vertical");
                }
                for j in 1..n {
                    assert!(inside(r.up[j], plan.windows[j], j), "{case}: up {j}");
                }
            }
            // Below the smallest level, the canvas and a few texels.
            for (k, w) in plan.windows.iter().enumerate().take(n) {
                assert!(
                    w.width() <= (size.0 >> k) + 16 && w.height() <= (size.1 >> k) + 16,
                    "radius {radius}: level {k} {w:?}"
                );
            }
            // The smallest level holds the canvas and the blur's reach past
            // it: a few thousand texels.
            let w = plan.windows[n];
            assert!(
                u64::from(w.width()) * u64::from(w.height()) < 1 << 22,
                "radius {radius}: {w:?}"
            );
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
