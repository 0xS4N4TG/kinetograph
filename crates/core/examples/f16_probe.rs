//! Scratch: does a render target's float -> half store round like
//! pack2x16float and like round-to-nearest-even?
use vello::util::RenderContext;
use vello::wgpu;

const SHADER: &str = r#"
struct Out {
    @location(0) hw: vec4<f32>,
    @location(1) pk: vec4<f32>,
}
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32(i32(i) / 2) * 4.0 - 1.0;
    let y = f32(i32(i) % 2) * 4.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}
fn store_f16(x: f32) -> f32 {
    let h = pack2x16float(vec2<f32>(x, 0.0)) & 0xffffu;
    let r = unpack2x16float(h).x;
    if abs(r) > abs(x) {
        return unpack2x16float(h - 1u).x;
    }
    return r;
}
fn hash(v: u32) -> u32 {
    var x = v * 747796405u + 2891336453u;
    x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
    return (x >> 22u) ^ x;
}
@fragment
fn fs(@builtin(position) p: vec4<f32>) -> Out {
    let idx = u32(p.y) * 1024u + u32(p.x);
    let h = hash(idx);
    let h2 = hash(h ^ 0x9e3779b9u);
    // exponent in [-27, 2], random mantissa
    let e = h % 30u;
    let bits = ((127u - 27u + e) << 23u) | (h2 & 0x7fffffu);
    let x = bitcast<f32>(bits);
    var o: Out;
    o.hw = vec4<f32>(x, x, x, x);
    let r = store_f16(x);
    o.pk = vec4<f32>(r, r, r, r);
    return o;
}
"#;

fn half_rte(x: f32) -> f32 {
    // Reference round-to-nearest-even to half, back to f32 (x > 0).
    let exp = ((x.to_bits() >> 23) & 0xff) as i32 - 127;
    // The spacing of half floats around x.
    let ulp_exp = if exp < -14 { -24 } else { exp - 10 };
    let scale = 2f32.powi(-ulp_exp);
    (x * scale).round_ties_even() / scale
}

fn main() {
    let context = RenderContext::new();
    let adapter = pollster::block_on(wgpu::util::initialize_adapter_from_env_or_default(
        &context.instance,
        None,
    ))
    .unwrap();
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).unwrap();
    let (w, h) = (1024u32, 1024u32);
    let make = |format| {
        device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        })
    };
    let hw = make(wgpu::TextureFormat::Rgba16Float);
    let pk = make(wgpu::TextureFormat::Rgba32Float);
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: None,
        source: wgpu::ShaderSource::Wgsl(SHADER.into()),
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: None,
        layout: None,
        vertex: wgpu::VertexState {
            module: &module,
            entry_point: Some("vs"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("fs"),
            compilation_options: Default::default(),
            targets: &[
                Some(wgpu::TextureFormat::Rgba16Float.into()),
                Some(wgpu::TextureFormat::Rgba32Float.into()),
            ],
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    });
    let hw_view = hw.create_view(&Default::default());
    let pk_view = pk.create_view(&Default::default());
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: None,
            color_attachments: &[
                Some(wgpu::RenderPassColorAttachment {
                    view: &hw_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                }),
                Some(wgpu::RenderPassColorAttachment {
                    view: &pk_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                }),
            ],
            ..Default::default()
        });
        pass.set_pipeline(&pipeline);
        pass.draw(0..3, 0..1);
    }
    let read = |tex: &wgpu::Texture, bpp: u32, encoder: &mut wgpu::CommandEncoder| {
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: u64::from(w * h * bpp),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        encoder.copy_texture_to_buffer(
            tex.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(w * bpp),
                    rows_per_image: Some(h),
                },
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        buffer
    };
    let hw_buf = read(&hw, 8, &mut encoder);
    let pk_buf = read(&pk, 16, &mut encoder);
    queue.submit([encoder.finish()]);
    for b in [&hw_buf, &pk_buf] {
        b.slice(..).map_async(wgpu::MapMode::Read, |r| r.unwrap());
    }
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let hw_data = hw_buf.slice(..).get_mapped_range().expect("range").to_vec();
    let pk_data = pk_buf.slice(..).get_mapped_range().expect("range").to_vec();
    let to_f32 = |h: u16| -> f32 {
        let sign = u32::from(h >> 15) << 31;
        let exp = u32::from((h >> 10) & 0x1f);
        let man = u32::from(h & 0x3ff);
        if exp == 0 {
            let v = man as f32 * 2f32.powi(-24);
            return if sign != 0 { -v } else { v };
        }
        f32::from_bits(sign | ((exp + 112) << 23) | (man << 13))
    };
    let (mut hw_vs_pk, mut hw_vs_rte, mut pk_vs_rte, mut sub_hw_vs_rte) = (0, 0, 0, 0);
    let mut shown = 0;
    // Regenerate x on the CPU with the same hash.
    fn hash(v: u32) -> u32 {
        let mut x = v.wrapping_mul(747796405).wrapping_add(2891336453);
        x = ((x >> ((x >> 28) + 4)) ^ x).wrapping_mul(277803737);
        (x >> 22) ^ x
    }
    let total = (w * h) as usize;
    for i in 0..total {
        let hh = hash(i as u32);
        let h2 = hash(hh ^ 0x9e37_79b9);
        let e = hh % 30;
        let bits = ((127 - 27 + e) << 23) | (h2 & 0x7f_ffff);
        let x = f32::from_bits(bits);
        let hwv = to_f32(u16::from_le_bytes([hw_data[i * 8], hw_data[i * 8 + 1]]));
        let pkv = f32::from_le_bytes(pk_data[i * 16..i * 16 + 4].try_into().unwrap());
        let rte = half_rte(x);
        if hwv != pkv {
            hw_vs_pk += 1;
        }
        if hwv != rte {
            hw_vs_rte += 1;
            if x < 6.1e-5 {
                sub_hw_vs_rte += 1;
            }
        }
        if pkv != rte {
            pk_vs_rte += 1;
        }
        if (hwv != pkv || hwv != rte) && shown < 12 {
            shown += 1;
            println!("x={x:e} bits={bits:08x} hw={hwv:e} pack={pkv:e} rte={rte:e}");
        }
    }
    println!(
        "{total} values: hw!=pack {hw_vs_pk}, hw!=rte {hw_vs_rte} (of which below the half normal range {sub_hw_vs_rte}), pack!=rte {pk_vs_rte}"
    );
}
