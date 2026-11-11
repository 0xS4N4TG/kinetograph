//! The canvas as yuv420p planes, converted on the GPU before the readback (`shaders/yuv420.wgsl`), so a video frame
//! comes back as 1.5 bytes a pixel instead of 4 and the CPU does not convert it.
//!
//! The planes are byte for byte what the encoder's own converter makes of the RGBA frame (`kinetograph_cli::encode::
//! rgba_to_planes`: swscale, bicubic, accurate rounding, BT.709 into limited range), in integers as it computes them:
//!
//!   - luma, per pixel: `y14 = (5983 r + 20127 g + 2032 b + (16 << 15) + 256) >> 9`, then `(2 y14 + 64) >> 7`;
//!   - chroma of each pair of pixels across (their sums, sited between them): `u14 = (-3298 r - 11094 g + 14392 b +
//!     (256 << 15) + 512) >> 10` (V: 14392, -13073, -1320), doubled to 15 bits;
//!   - each chroma row is the bicubic (B = 0, C = 0.6) filter of the 15-bit rows down to half the height, weights out of
//!     4096 (`chroma_filter`), plus 64 << 12, shifted down by 19 and clipped.
//!
//! The coefficients and the filter are swscale's as its initialisation makes them for this conversion; the test in
//! `crates/cli` compares the planes with its output.

use wgpu::util::DeviceExt;

use super::{Compositor, Readback, Tex, shader_module};

const WORKGROUP: u32 = 256;
/// Workgroups in a row of the dispatch (WebGPU's least `maxComputeWorkgroupsPerDimension`).
const MAX_GROUPS_WIDE: u32 = 65535;

/// The vertical chroma filter for a picture `src_h` rows high (even): for each of its `src_h / 2` chroma rows, the first
/// source row and `taps` weights that sum to 4096. It is swscale's `initFilter` for a bicubic 2:1 reduction with both
/// sitings at the centre, its near-zero trimming, its edges folded onto the first and last rows, and its rounding of the
/// weights (each carries the error of the one before).
pub(crate) fn chroma_filter(src_h: u32) -> (u32, Vec<i32>) {
    let (src_h, dst_h) = (i64::from(src_h), i64::from(src_h / 2));
    let x_inc = ((src_h << 16) + (dst_h >> 1)) / dst_h;
    let fone: i64 = 1 << (54 - (src_h / dst_h).ilog2().min(8));
    let size = (1 + (4 * src_h + dst_h - 1) / dst_h).min(src_h - 2).max(1) as usize;
    let c: i64 = (0.6 * f64::from(1 << 24)) as i64;
    let mut x_dst = ((128 * x_inc) >> 7) - ((128 * 0x10000) >> 7);
    let mut rows: Vec<(i64, Vec<i64>)> = Vec::with_capacity(dst_h as usize);
    for _ in 0..dst_h {
        let mut xx = (x_dst - (size as i64 - 2) * (1 << 16)) / (1 << 17);
        let pos = xx;
        let mut f = Vec::with_capacity(size);
        for _ in 0..size {
            let mut d = (xx * (1 << 17) - x_dst).abs() << 13;
            if x_inc > 1 << 16 {
                d = d * dst_h / src_h;
            }
            let coeff = if d >= 1 << 31 {
                0
            } else {
                let dd = (d * d) >> 30;
                let ddd = (dd * d) >> 30;
                if d < 1 << 30 {
                    (12 * (1 << 24) - 6 * c) * ddd
                        + (-18 * (1 << 24) + 6 * c) * dd
                        + 6 * (1 << 24) * (1 << 30)
                } else {
                    (-6 * c) * ddd + (30 * c) * dd + (-48 * c) * d + (24 * c) * (1 << 30)
                }
            };
            f.push(coeff / ((1 << 54) / fone));
            xx += 1;
        }
        rows.push((pos, f));
        x_dst += 2 * x_inc;
    }
    // Near-zero weights: dropped on the left (the row moves on), counted on the right.
    let cut = fone * 2 / 1000;
    let mut min_size = 0;
    for i in (0..rows.len()).rev() {
        let next_pos = rows.get(i + 1).map(|r| r.0);
        let (pos, f) = &mut rows[i];
        let mut acc = 0;
        for _ in 0..size {
            acc += f[0].abs();
            if acc > cut || next_pos.is_some_and(|next| *pos >= next) {
                break;
            }
            f.remove(0);
            f.push(0);
            *pos += 1;
        }
        let (mut min, mut acc) = (size, 0);
        for j in (1..size).rev() {
            acc += f[j].abs();
            if acc > cut {
                break;
            }
            min -= 1;
        }
        min_size = min_size.max(min);
    }
    let taps = min_size;
    let mut out = Vec::with_capacity(rows.len() * (taps + 1));
    for (mut pos, mut f) in rows {
        f.resize(taps, 0);
        // The edges: what falls above the first row is the first row's, below the last the last's.
        if pos < 0 {
            for j in 1..taps {
                let left = (j as i64 + pos).max(0) as usize;
                f[left] += f[j];
                f[j] = 0;
            }
            pos = 0;
        }
        if pos + taps as i64 > src_h {
            let shift = pos + (taps as i64 - src_h).min(0);
            let mut acc = 0;
            for j in (0..taps).rev() {
                if pos + j as i64 >= src_h {
                    acc += f[j];
                    f[j] = 0;
                }
            }
            for j in (0..taps).rev() {
                f[j] = if (j as i64) < shift {
                    0
                } else {
                    f[j - shift as usize]
                };
            }
            pos -= shift;
            f[(src_h - 1 - pos) as usize] += acc;
        }
        let one = 4096;
        let sum = match (f.iter().sum::<i64>() + one / 2) / one {
            0 => 1,
            s => s,
        };
        out.push(pos as i32);
        let mut error = 0;
        for c in f {
            let v = c + error;
            let w = if v >= 0 {
                (v + sum / 2) / sum
            } else {
                (v - sum / 2) / sum
            };
            error = v - w * sum;
            out.push(w as i32);
        }
    }
    (taps as u32, out)
}

/// The conversion's pipeline, and the chroma filter of the last height it was used for.
pub(super) struct Yuv420 {
    pipeline: wgpu::ComputePipeline,
    layout: wgpu::BindGroupLayout,
    filter: Option<(u32, u32, wgpu::Buffer)>,
}

impl Yuv420 {
    pub(super) fn new(device: &wgpu::Device) -> Yuv420 {
        let shader = shader_module(device, "yuv420", include_str!("../shaders/yuv420.wgsl"));
        let buffer = |binding, ty| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("yuv420"),
            entries: &[
                buffer(0, wgpu::BufferBindingType::Uniform),
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                buffer(2, wgpu::BufferBindingType::Storage { read_only: true }),
                buffer(3, wgpu::BufferBindingType::Storage { read_only: false }),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("yuv420"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("yuv420"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: Some("convert"),
            compilation_options: Default::default(),
            cache: None,
        });
        Yuv420 {
            pipeline,
            layout,
            filter: None,
        }
    }
}

impl Compositor {
    /// `start_readback`, but the canvas comes back as yuv420p planes (Y, U, V, rows packed; the canvas's sides even), as
    /// the encoder's converter makes them of the RGBA `start_readback` returns.
    pub fn start_readback_yuv420(&mut self, image: &Tex) -> Readback {
        let (width, height) = self.canvas;
        let target = self.encoded(image);
        let device = self.device.clone();
        let yuv = self.yuv.get_or_insert_with(|| Yuv420::new(&device));
        if yuv.filter.as_ref().is_none_or(|(h, _, _)| *h != height) {
            let (taps, weights) = chroma_filter(height);
            let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("yuv420 chroma filter"),
                contents: &weights
                    .iter()
                    .flat_map(|w| w.to_le_bytes())
                    .collect::<Vec<u8>>(),
                usage: wgpu::BufferUsages::STORAGE,
            });
            yuv.filter = Some((height, taps, buffer));
        }
        let (_, taps, filter) = yuv.filter.as_ref().expect("made above");
        let total = width * height * 3 / 2;
        let words = total.div_ceil(4);
        let groups = words.div_ceil(WORKGROUP);
        let (wide, rows) = (
            groups.min(MAX_GROUPS_WIDE),
            groups.div_ceil(MAX_GROUPS_WIDE),
        );
        let params: [u32; 8] = [
            width,
            height,
            self.margin,
            *taps,
            total,
            wide * WORKGROUP,
            0,
            0,
        ];
        let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("yuv420 params"),
            contents: &params
                .iter()
                .flat_map(|w| w.to_le_bytes())
                .collect::<Vec<u8>>(),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let bytes = u64::from(words) * 4;
        let planes = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("yuv420 planes"),
            size: bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("yuv420"),
            layout: &yuv.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&target.view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: filter.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: planes.as_entire_binding(),
                },
            ],
        });
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("yuv420 readback"),
            size: bytes,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let pipeline = yuv.pipeline.clone();
        {
            let mut encoder = self.encoder();
            {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("yuv420"),
                    timestamp_writes: None,
                });
                pass.set_pipeline(&pipeline);
                pass.set_bind_group(0, &group, &[]);
                pass.dispatch_workgroups(wide, rows, 1);
            }
            encoder.copy_buffer_to_buffer(&planes, 0, &buffer, 0, bytes);
        }
        // One row of the planes' bytes, cut to their length.
        self.submit_readback(buffer, total, bytes as u32, 1)
    }
}
