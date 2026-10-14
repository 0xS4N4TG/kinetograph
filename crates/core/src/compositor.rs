//! Blends layer textures in linear light.
//!
//! Every intermediate image is a `Rgba16Float` texture holding linear,
//! premultiplied colour. It covers the canvas plus a margin on every side
//! (`Scene::margin`, 0 unless an effect paints outside its layer). The
//! passes live in `shaders/composite.wgsl`:
//!
//! - `to_linear`: Vello's sRGB-encoded Rgba8 output -> linear texture
//! - `blend`: backdrop + source + opacity + blend mode -> new texture
//! - `mask`: layer x the alpha or luminance of a Vello-drawn clip or gradient
//! - `matte`: layer x the alpha or luminance of another layer's texture
//! - `encode`: linear texture -> sRGB 8-bit, read back to the CPU
//!
//! A scene's custom shader effects (`shader.rs`) have a pipeline each, made
//! when the compositor is, on a bind group layout of their own.
//!
//! Passes that resample the layer (a warp, a displacement) need a bilinear
//! sampler, which the layout below does not have (it only `textureLoad`s).
//! They use `filtered_layout` instead: the layer, a sampler and one uniform
//! block, run by `run_filtered_pass`.
//!
//! The halftone pass (`shaders/halftone.wgsl`) reads the layer at cell
//! centres through the filtered layout, with the layer's matrix.
//!
//! Shaders that draw seeded noise (`shaders/grain.wgsl`, `dither.wgsl`) are
//! compiled with `shaders/hash.wgsl` in front of them (`shader_module`).
//!
//! The `lut` pass (`shaders/lut.wgsl`) reads a 3D texture as well, so it has
//! a bind group layout of its own (`lut_layout`) and the scene's tables are
//! uploaded once, when the compositor is made.
//!
//! `shaders/shadow.wgsl` holds the shadow effects' passes,
//! `shaders/color.wgsl` the colour filter pass, `shaders/glow.wgsl` the glow
//! pass, `shaders/aberration.wgsl` the chromatic aberration pass and
//! `shaders/gradient_map.wgsl` the gradient map pass; they
//! share the bind group layout, so their passes go through the same
//! `run_pass`.
//!
//! Adding a blend mode: add a case to `blend_fn` in the shader and a
//! mapping in `mode_index`. Adding an effect: add a variant to
//! `scene::Effect` and `resolve::ResolvedEffect`, write its pass, and call it
//! from `apply_effects`.

use std::collections::HashMap;

use vello::kurbo::Affine;
use vello::wgpu::{self, util::DeviceExt};

use crate::blur::{self, Blur};
use crate::color::ColorMatrix;
use crate::error::{Error, Result};
use crate::lut::Lut;
use crate::resolve::{
    ResolvedDither, ResolvedEffect, ResolvedGlow, ResolvedGradientMap, ResolvedGrain,
    ResolvedHalftone, ResolvedShader, ResolvedShadow,
};
use crate::scene::{
    BlendMode, DitherMode, HalftoneShape, MAX_GRADIENT_MAP_STOPS, MaskMode, MatteMode,
};

pub const LINEAR_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
const READBACK_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// A linear premultiplied texture the size of the canvas plus its margin.
pub struct Tex {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
}

/// A LUT on the GPU.
struct LutTexture {
    view: wgpu::TextureView,
    /// What `Params` in `shaders/lut.wgsl` holds besides the amount: points
    /// per axis and the input domain.
    size: f32,
    domain_min: [f32; 3],
    domain_max: [f32; 3],
}

pub struct Compositor {
    device: wgpu::Device,
    queue: wgpu::Queue,
    /// Size of every pooled texture: the canvas plus twice the margin.
    width: u32,
    height: u32,
    /// The canvas, which `read_rgba8` copies out of the middle of a texture.
    canvas: (u32, u32),
    margin: u32,
    layout: wgpu::BindGroupLayout,
    to_linear: wgpu::RenderPipeline,
    blend: wgpu::RenderPipeline,
    mask: wgpu::RenderPipeline,
    matte: wgpu::RenderPipeline,
    encode: wgpu::RenderPipeline,
    spread: wgpu::RenderPipeline,
    drop_shadow: wgpu::RenderPipeline,
    inset_shadow: wgpu::RenderPipeline,
    color: wgpu::RenderPipeline,
    glow: wgpu::RenderPipeline,
    aberration: wgpu::RenderPipeline,
    gradient_map: wgpu::RenderPipeline,
    grain: wgpu::RenderPipeline,
    dither: wgpu::RenderPipeline,
    /// On `filtered_layout`: it reads the layer between texels.
    halftone: wgpu::RenderPipeline,
    /// For `lut`: the layer, a 3D texture and the pass's uniforms.
    lut_layout: wgpu::BindGroupLayout,
    lut: wgpu::RenderPipeline,
    /// The scene's tables, by the `src` the scene spells them with.
    luts: HashMap<String, LutTexture>,
    /// For custom shaders: the layer, a sampler, the frame clock and the
    /// scene's named uniforms.
    shader_layout: wgpu::BindGroupLayout,
    shader_sampler: wgpu::Sampler,
    /// For passes that resample the layer: the layer (filterable), a
    /// bilinear sampler and a uniform block.
    filtered_layout: wgpu::BindGroupLayout,
    #[expect(dead_code, reason = "used by the first resampling pass (warp)")]
    filtered_pipeline_layout: wgpu::PipelineLayout,
    filtered_sampler: wgpu::Sampler,
    /// One pipeline per distinct custom shader, by `shader::compose` text.
    shaders: HashMap<String, wgpu::RenderPipeline>,
    blur: Blur,
    pool: Vec<Tex>,
}

impl Compositor {
    /// `width` x `height` is the canvas; textures are `margin` pixels larger
    /// on every side. `shaders` are the scene's custom shader modules
    /// (`Scene::shader_sources`); `luts` its tables (`lut::load_luts`).
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        width: u32,
        height: u32,
        margin: u32,
        shaders: &[String],
        luts: &HashMap<String, Lut>,
    ) -> Compositor {
        let shader = shader_module(device, "composite", include_str!("shaders/composite.wgsl"));
        let shadow_shader = shader_module(device, "shadow", include_str!("shaders/shadow.wgsl"));
        let color_shader = shader_module(device, "color", include_str!("shaders/color.wgsl"));
        let glow_shader = shader_module(device, "glow", include_str!("shaders/glow.wgsl"));
        let aberration_shader = shader_module(
            device,
            "aberration",
            include_str!("shaders/aberration.wgsl"),
        );
        let gradient_map_shader = shader_module(
            device,
            "gradient map",
            include_str!("shaders/gradient_map.wgsl"),
        );
        let grain_shader = shader_module(device, "grain", include_str!("shaders/grain.wgsl"));
        let dither_shader = shader_module(device, "dither", include_str!("shaders/dither.wgsl"));
        let halftone_shader =
            shader_module(device, "halftone", include_str!("shaders/halftone.wgsl"));
        let lut_shader = shader_module(device, "lut", include_str!("shaders/lut.wgsl"));
        let texture_entry = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("composite"),
            entries: &[
                texture_entry(0),
                texture_entry(1),
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
            label: Some("composite"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = |shader: &wgpu::ShaderModule, entry: &str, format| {
            fullscreen_pipeline(device, &pipeline_layout, shader, entry, format)
        };
        let filtered_layout = filtered_bind_group_layout(device);
        let filtered_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("filtered"),
                bind_group_layouts: &[Some(&filtered_layout)],
                immediate_size: 0,
            });
        let halftone = fullscreen_pipeline(
            device,
            &filtered_pipeline_layout,
            &halftone_shader,
            "fs_halftone",
            LINEAR_FORMAT,
        );
        let lut_layout = lut_bind_group_layout(device);
        let lut_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("lut"),
            bind_group_layouts: &[Some(&lut_layout)],
            immediate_size: 0,
        });
        let lut = fullscreen_pipeline(
            device,
            &lut_pipeline_layout,
            &lut_shader,
            "fs_lut",
            LINEAR_FORMAT,
        );
        let luts = luts
            .iter()
            .map(|(src, lut)| (src.clone(), upload_lut(device, queue, lut)))
            .collect();
        let shader_layout = shader_bind_group_layout(device);
        let shader_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("shader effect"),
                bind_group_layouts: &[Some(&shader_layout)],
                immediate_size: 0,
            });
        let shaders = shaders
            .iter()
            .map(|source| {
                let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("shader effect"),
                    source: wgpu::ShaderSource::Wgsl(source.as_str().into()),
                });
                let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some("shader effect"),
                    layout: Some(&shader_pipeline_layout),
                    vertex: wgpu::VertexState {
                        module: &module,
                        entry_point: Some("kg_vs"),
                        compilation_options: Default::default(),
                        buffers: &[],
                    },
                    fragment: Some(wgpu::FragmentState {
                        module: &module,
                        entry_point: Some("kg_fs"),
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
                });
                (source.clone(), pipeline)
            })
            .collect();
        Compositor {
            device: device.clone(),
            queue: queue.clone(),
            width: width + 2 * margin,
            height: height + 2 * margin,
            canvas: (width, height),
            margin,
            to_linear: pipeline(&shader, "fs_to_linear", LINEAR_FORMAT),
            blend: pipeline(&shader, "fs_blend", LINEAR_FORMAT),
            mask: pipeline(&shader, "fs_mask", LINEAR_FORMAT),
            matte: pipeline(&shader, "fs_matte", LINEAR_FORMAT),
            encode: pipeline(&shader, "fs_encode", READBACK_FORMAT),
            spread: pipeline(&shadow_shader, "fs_spread", LINEAR_FORMAT),
            drop_shadow: pipeline(&shadow_shader, "fs_drop", LINEAR_FORMAT),
            inset_shadow: pipeline(&shadow_shader, "fs_inset", LINEAR_FORMAT),
            color: pipeline(&color_shader, "fs_color", LINEAR_FORMAT),
            glow: pipeline(&glow_shader, "fs_glow", LINEAR_FORMAT),
            aberration: pipeline(&aberration_shader, "fs_aberration", LINEAR_FORMAT),
            gradient_map: pipeline(&gradient_map_shader, "fs_gradient_map", LINEAR_FORMAT),
            grain: pipeline(&grain_shader, "fs_grain", LINEAR_FORMAT),
            dither: pipeline(&dither_shader, "fs_dither", LINEAR_FORMAT),
            halftone,
            lut_layout,
            lut,
            luts,
            shader_layout,
            shader_sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("shader effect"),
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            }),
            shaders,
            filtered_layout,
            filtered_pipeline_layout,
            filtered_sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("filtered"),
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            }),
            blur: Blur::new(device),
            layout,
            pool: Vec::new(),
        }
    }

    /// A texture with undefined contents, from the pool when possible.
    pub fn acquire(&mut self) -> Tex {
        self.pool
            .pop()
            .unwrap_or_else(|| new_texture(&self.device, self.width, self.height))
    }

    pub fn release(&mut self, tex: Tex) {
        self.pool.push(tex);
    }

    /// A texture filled with `color` (linear, premultiplied).
    pub fn filled(&mut self, color: [f64; 4]) -> Tex {
        let tex = self.acquire();
        let mut encoder = self.device.create_command_encoder(&Default::default());
        encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("clear"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &tex.view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color {
                        r: color[0],
                        g: color[1],
                        b: color[2],
                        a: color[3],
                    }),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        self.queue.submit([encoder.finish()]);
        tex
    }

    /// Converts a Vello output texture (Rgba8, sRGB-encoded, straight alpha)
    /// to a linear premultiplied texture.
    pub fn from_srgb8(&mut self, vello_output: &wgpu::TextureView) -> Tex {
        let target = self.acquire();
        self.pass(
            &self.to_linear,
            vello_output,
            vello_output,
            0.0,
            0,
            &target.view,
        );
        target
    }

    /// Composites `src` over `dst` with the layer's opacity and blend mode.
    /// Both inputs go back to the pool; the result is a new texture.
    pub fn blend(&mut self, dst: Tex, src: Tex, opacity: f32, mode: BlendMode) -> Tex {
        let mode = mode_index(mode);
        let target = self.acquire();
        self.pass(
            &self.blend,
            &dst.view,
            &src.view,
            opacity,
            mode,
            &target.view,
        );
        self.release(dst);
        self.release(src);
        target
    }

    /// Multiplies `src` by the alpha or luminance of a Vello output texture
    /// (Rgba8): a clip shape drawn in opaque white, or a gradient. `src`
    /// goes back to the pool; the result is a new texture.
    pub fn mask(&mut self, src: Tex, vello_output: &wgpu::TextureView, mode: MaskMode) -> Tex {
        let mode = match mode {
            MaskMode::Alpha => 0,
            MaskMode::Luminance => 2,
        };
        let target = self.acquire();
        self.pass(&self.mask, &src.view, vello_output, 0.0, mode, &target.view);
        self.release(src);
        target
    }

    /// Multiplies `src` by what the matte source `matte` keeps, after
    /// scaling the matte by `matte_opacity`. Both inputs go back to the pool;
    /// the result is a new texture.
    pub fn matte(&mut self, src: Tex, matte: Tex, matte_opacity: f32, mode: MatteMode) -> Tex {
        let mode = match mode {
            MatteMode::Alpha => 0,
            MatteMode::AlphaInverted => 1,
            MatteMode::Luminance => 2,
            MatteMode::LuminanceInverted => 3,
        };
        let target = self.acquire();
        self.pass(
            &self.matte,
            &src.view,
            &matte.view,
            matte_opacity,
            mode,
            &target.view,
        );
        self.release(src);
        self.release(matte);
        target
    }

    /// Composites `above` over `below` (normal blend, full opacity) into a new
    /// texture. Neither input is released.
    pub fn over(&mut self, below: &Tex, above: &Tex) -> Tex {
        let target = self.acquire();
        self.pass(&self.blend, &below.view, &above.view, 1.0, 0, &target.view);
        target
    }

    /// Runs a layer's effects, in order, on its own texture before it is
    /// blended. Each effect should read `src`, draw into a texture from
    /// `acquire`, release `src` and return the new one.
    ///
    /// `backdrop` is the canvas as it is behind the layer; it is `Some`
    /// whenever the effects include a backdrop blur. `coverage` is a texture
    /// whose alpha says where the layer is solid for that blur; without it
    /// the layer's own alpha does. Neither is released.
    ///
    /// `layer_matrix` takes layer space to pixels of the padded textures
    /// (the product of the enclosing groups' matrices and the layer's own,
    /// with the margin offset), for effects that work in layer space: they
    /// pass its inverse to their shader to map a texel back to the layer.
    pub fn apply_effects(
        &mut self,
        mut src: Tex,
        layer_matrix: Affine,
        effects: &[ResolvedEffect],
        backdrop: Option<&Tex>,
        coverage: Option<&Tex>,
    ) -> Tex {
        for effect in effects {
            match *effect {
                ResolvedEffect::Blur { radius } if radius >= blur::MIN_RADIUS => {
                    let dst = self.acquire();
                    self.blur.run(
                        &self.device,
                        &self.queue,
                        &src.view,
                        &dst.view,
                        (self.width, self.height),
                        radius,
                    );
                    self.release(src);
                    src = dst;
                }
                ResolvedEffect::Blur { .. } => {}
                ResolvedEffect::BackdropBlur { radius } if radius >= blur::MIN_RADIUS => {
                    if let Some(backdrop) = backdrop {
                        src = self.backdrop_blur(src, radius, backdrop, coverage);
                    }
                }
                ResolvedEffect::BackdropBlur { .. } => {}
                ResolvedEffect::Glow(glow) => src = self.glow(src, &glow),
                ResolvedEffect::ChromaticAberration { amount, angle } if amount != 0.0 => {
                    src = self.chromatic_aberration(src, aberration_offset(amount, angle));
                }
                ResolvedEffect::ChromaticAberration { .. } => {}
                ResolvedEffect::DropShadow(shadow) => src = self.shadow(src, &shadow, false),
                ResolvedEffect::InsetShadow(shadow) => src = self.shadow(src, &shadow, true),
                ResolvedEffect::ColorMatrix(matrix) if matrix == ColorMatrix::IDENTITY => {}
                ResolvedEffect::ColorMatrix(matrix) => src = self.color_matrix(src, &matrix),
                ResolvedEffect::GradientMap(ref map) if map.amount > 0.0 => {
                    src = self.gradient_map(src, map);
                }
                ResolvedEffect::GradientMap(_) => {}
                ResolvedEffect::Lut {
                    src: ref key,
                    amount,
                } if amount > 0.0 => {
                    src = self.lut(src, key, amount);
                }
                ResolvedEffect::Lut { .. } => {}
                ResolvedEffect::Grain(grain) if grain.amount > 0.0 => {
                    src = self.grain(src, &grain);
                }
                ResolvedEffect::Grain(_) => {}
                ResolvedEffect::Dither(dither) => src = self.dither(src, &dither),
                ResolvedEffect::Halftone(halftone) => {
                    src = self.halftone(src, layer_matrix, &halftone);
                }
                ResolvedEffect::Shader(ref shader) => src = self.custom_shader(src, shader),
            }
        }
        src
    }

    /// Puts the blurred `backdrop` under `src`, kept to where `coverage`'s
    /// alpha is (`src`'s own alpha if none). `src` goes back to the pool; the
    /// result is a new texture.
    fn backdrop_blur(
        &mut self,
        src: Tex,
        radius: f32,
        backdrop: &Tex,
        coverage: Option<&Tex>,
    ) -> Tex {
        let blurred = self.acquire();
        let size = (self.width, self.height);
        self.blur.run(
            &self.device,
            &self.queue,
            &backdrop.view,
            &blurred.view,
            size,
            radius,
        );
        // The matte pass with opacity 1 and alpha mode multiplies its first
        // input by the alpha of its second.
        let frosted = self.acquire();
        let coverage = coverage.map_or(&src.view, |t| &t.view);
        self.pass(&self.matte, &blurred.view, coverage, 1.0, 0, &frosted.view);
        self.release(blurred);
        self.blend(frosted, src, 1.0, BlendMode::Normal)
    }

    /// Draws a halo under `src`: a blurred copy of it, tinted if asked. `src`
    /// goes back to the pool; the result is a new texture.
    fn glow(&mut self, src: Tex, glow: &ResolvedGlow) -> Tex {
        if glow.radius < blur::MIN_RADIUS || glow.intensity <= 0.0 {
            return src;
        }
        let halo = self.acquire();
        let size = (self.width, self.height);
        self.blur.run(
            &self.device,
            &self.queue,
            &src.view,
            &halo.view,
            size,
            glow.radius,
        );
        let target = self.acquire();
        self.run_pass(
            &self.glow,
            &src.view,
            &halo.view,
            &floats(&glow_values(glow)),
            &target.view,
        );
        self.release(halo);
        self.release(src);
        target
    }

    /// Splits the colour channels of `src` apart in one pass: red is read
    /// `offset` pixels away, blue the same distance the other way. `src` goes
    /// back to the pool; the result is a new texture.
    fn chromatic_aberration(&mut self, src: Tex, offset: [f32; 2]) -> Tex {
        let target = self.acquire();
        let params = floats(&[offset[0], offset[1], 0.0, 0.0]);
        self.run_pass(
            &self.aberration,
            &src.view,
            &src.view,
            &params,
            &target.view,
        );
        self.release(src);
        target
    }

    /// Runs a colour filter over `src` in one pass. `src` goes back to the
    /// pool; the result is a new texture.
    fn color_matrix(&mut self, src: Tex, matrix: &ColorMatrix) -> Tex {
        let target = self.acquire();
        self.run_pass(
            &self.color,
            &src.view,
            &src.view,
            &floats(&matrix_values(matrix)),
            &target.view,
        );
        self.release(src);
        target
    }

    /// Recolours `src` by luminance in one pass. `src` goes back to the pool;
    /// the result is a new texture.
    fn gradient_map(&mut self, src: Tex, map: &ResolvedGradientMap) -> Tex {
        let target = self.acquire();
        self.run_pass(
            &self.gradient_map,
            &src.view,
            &src.view,
            &floats(&gradient_map_values(map)),
            &target.view,
        );
        self.release(src);
        target
    }

    /// Adds seeded grain to `src` in one pass. `src` goes back to the pool;
    /// the result is a new texture.
    fn grain(&mut self, src: Tex, grain: &ResolvedGrain) -> Tex {
        let target = self.acquire();
        self.run_pass(
            &self.grain,
            &src.view,
            &src.view,
            &grain_values(grain, self.margin),
            &target.view,
        );
        self.release(src);
        target
    }

    /// Quantises `src` to a few levels per channel in one pass. `src` goes
    /// back to the pool; the result is a new texture.
    fn dither(&mut self, src: Tex, dither: &ResolvedDither) -> Tex {
        let target = self.acquire();
        self.run_pass(
            &self.dither,
            &src.view,
            &src.view,
            &dither_values(dither, self.margin),
            &target.view,
        );
        self.release(src);
        target
    }

    /// Replaces `src` with a halftone screen of it, laid out in the layer's
    /// space (`layer_matrix` takes that to texels). `src` goes back to the
    /// pool; the result is a new texture.
    fn halftone(&mut self, src: Tex, layer_matrix: Affine, halftone: &ResolvedHalftone) -> Tex {
        let target = self.acquire();
        self.run_filtered_pass(
            &self.halftone,
            &src.view,
            &floats(&halftone_values(halftone, layer_matrix)),
            &target.view,
        );
        self.release(src);
        target
    }

    /// Grades `src` through the table loaded for `key`, faded in by `amount`.
    /// `src` goes back to the pool; the result is a new texture. A table the
    /// compositor was not given at creation is skipped.
    fn lut(&mut self, src: Tex, key: &str, amount: f32) -> Tex {
        if !self.luts.contains_key(key) {
            return src;
        }
        let target = self.acquire();
        let lut = &self.luts[key];
        let [rx, ry, rz] = lut.domain_min;
        let [sx, sy, sz] = lut.domain_max;
        let params = floats(&[rx, ry, rz, 0.0, sx, sy, sz, 0.0, lut.size, amount, 0.0, 0.0]);
        let uniform = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("lut params"),
                contents: &params,
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("lut"),
            layout: &self.lut_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&src.view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&lut.view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: uniform.as_entire_binding(),
                },
            ],
        });
        self.draw(&self.lut, &bind_group, &target.view);
        self.release(src);
        target
    }

    /// Runs a scene's own fragment shader over `src`. `src` goes back to the
    /// pool; the result is a new texture. A shader the compositor was not
    /// given at creation is skipped.
    fn custom_shader(&mut self, src: Tex, shader: &ResolvedShader) -> Tex {
        if !self.shaders.contains_key(&shader.source) {
            return src;
        }
        let target = self.acquire();
        let pipeline = &self.shaders[&shader.source];
        // `Globals` in `shader.rs`: the canvas, frame, time and margin.
        let globals = floats(&[
            self.canvas.0 as f32,
            self.canvas.1 as f32,
            shader.frame,
            shader.time,
            self.margin as f32,
            0.0,
            0.0,
            0.0,
        ]);
        // `U`: one f32 each. The buffer is at least 16 bytes, which WGSL
        // wants of a uniform block.
        let mut values = shader.values.clone();
        values.resize(values.len().next_multiple_of(4).max(4), 0.0);
        let buffer = |label, contents: &[u8]| {
            self.device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some(label),
                    contents,
                    usage: wgpu::BufferUsages::UNIFORM,
                })
        };
        let globals = buffer("shader globals", &globals);
        let uniforms = buffer("shader uniforms", &floats(&values));
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("shader effect"),
            layout: &self.shader_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&src.view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.shader_sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: globals.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: uniforms.as_entire_binding(),
                },
            ],
        });
        self.draw(pipeline, &bind_group, &target.view);
        self.release(src);
        target
    }

    /// Adds a drop shadow under `src`, or an inset shadow over it. `src`
    /// goes back to the pool; the result is a new texture.
    ///
    /// Both are built from the layer's alpha: grown by the spread, blurred,
    /// then shifted by the offset and tinted in the last pass. An inset
    /// shadow comes from the alpha inverted, so the spread there shrinks the
    /// layer's opaque area instead of growing it.
    fn shadow(&mut self, src: Tex, shadow: &ResolvedShadow, inset: bool) -> Tex {
        let spread = if inset { -shadow.spread } else { shadow.spread };
        let alpha = self.shadow_alpha(&src, spread, shadow.blur, inset);
        let [r, g, b, a] = shadow.color.linear_premultiplied();
        let params = floats(&[
            0.0, 0.0, 0.0, 0.0, shadow.x, shadow.y, 0.0, 0.0, r as f32, g as f32, b as f32,
            a as f32,
        ]);
        let target = self.acquire();
        let pipeline = if inset {
            &self.inset_shadow
        } else {
            &self.drop_shadow
        };
        // With no spread, inversion or blur the shadow is just `src`'s alpha.
        let alpha_view = alpha.as_ref().map_or(&src.view, |t| &t.view);
        self.run_pass(pipeline, &src.view, alpha_view, &params, &target.view);
        if let Some(alpha) = alpha {
            self.release(alpha);
        }
        self.release(src);
        target
    }

    /// The alpha of `src` grown by `spread` pixels (shrunk when negative),
    /// inverted if asked, then blurred, in the alpha channel of a new
    /// texture. `None` when none of that changes anything: the alpha of
    /// `src` itself is what is wanted.
    fn shadow_alpha(&mut self, src: &Tex, spread: f32, blur: f32, invert: bool) -> Option<Tex> {
        let blurred = blur >= blur::MIN_RADIUS;
        let mut current: Option<Tex> = None;
        if spread != 0.0 {
            let horizontal = self.acquire();
            self.spread_pass(&src.view, spread, [1.0, 0.0], false, &horizontal.view);
            current = Some(horizontal);
        }
        if spread != 0.0 || invert {
            let target = self.acquire();
            let input = current.as_ref().map_or(&src.view, |t| &t.view);
            self.spread_pass(input, spread, [0.0, 1.0], invert, &target.view);
            if let Some(done) = current.replace(target) {
                self.release(done);
            }
        }
        if blurred {
            let target = self.acquire();
            let input = current.as_ref().map_or(&src.view, |t| &t.view);
            let size = (self.width, self.height);
            self.blur
                .run(&self.device, &self.queue, input, &target.view, size, blur);
            if let Some(done) = current.replace(target) {
                self.release(done);
            }
        }
        current
    }

    /// One axis of the spread filter (see `shaders/shadow.wgsl`).
    fn spread_pass(
        &self,
        input: &wgpu::TextureView,
        spread: f32,
        axis: [f32; 2],
        invert: bool,
        target: &wgpu::TextureView,
    ) {
        let params = floats(&[
            spread,
            axis[0],
            axis[1],
            f32::from(u8::from(invert)),
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
        ]);
        self.run_pass(&self.spread, input, input, &params, target);
    }

    /// Encodes a linear texture to sRGB and reads it back as tightly packed
    /// RGBA8 with straight alpha.
    pub fn read_rgba8(&mut self, image: &Tex) -> Result<Vec<u8>> {
        let (canvas_width, canvas_height) = self.canvas;
        let target = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("readback"),
            size: wgpu::Extent3d {
                width: self.width,
                height: self.height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: READBACK_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());
        self.pass(&self.encode, &image.view, &image.view, 0.0, 0, &target_view);

        let row_bytes = canvas_width * 4;
        let padded_row = row_bytes.next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: u64::from(padded_row) * u64::from(canvas_height),
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        // Only the canvas, which sits in the middle of the margin.
        let mut source = target.as_image_copy();
        source.origin = wgpu::Origin3d {
            x: self.margin,
            y: self.margin,
            z: 0,
        };
        encoder.copy_texture_to_buffer(
            source,
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_row),
                    rows_per_image: Some(canvas_height),
                },
            },
            wgpu::Extent3d {
                width: canvas_width,
                height: canvas_height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit([encoder.finish()]);

        let (tx, rx) = std::sync::mpsc::channel();
        buffer.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|e| Error::Render(format!("GPU poll failed: {e}")))?;
        rx.recv()
            .map_err(|e| Error::Render(format!("readback channel closed: {e}")))?
            .map_err(|e| Error::Render(format!("readback map failed: {e}")))?;

        let mapped = buffer
            .slice(..)
            .get_mapped_range()
            .map_err(|e| Error::Render(format!("readback range failed: {e}")))?;
        let mut pixels = Vec::with_capacity((row_bytes * canvas_height) as usize);
        for row in mapped.chunks(padded_row as usize) {
            pixels.extend_from_slice(&row[..row_bytes as usize]);
        }
        drop(mapped);
        buffer.unmap();
        Ok(pixels)
    }

    /// One full-screen pass over `target` with `a` and `b` as inputs.
    fn pass(
        &self,
        pipeline: &wgpu::RenderPipeline,
        a: &wgpu::TextureView,
        b: &wgpu::TextureView,
        opacity: f32,
        mode: u32,
        target: &wgpu::TextureView,
    ) {
        let mut bytes = [0u8; 16];
        bytes[0..4].copy_from_slice(&opacity.to_le_bytes());
        bytes[4..8].copy_from_slice(&mode.to_le_bytes());
        self.run_pass(pipeline, a, b, &bytes, target);
    }

    /// Like `pass`, with the shader's whole uniform block given as bytes.
    fn run_pass(
        &self,
        pipeline: &wgpu::RenderPipeline,
        a: &wgpu::TextureView,
        b: &wgpu::TextureView,
        params: &[u8],
        target: &wgpu::TextureView,
    ) {
        let uniform = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("params"),
                contents: params,
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("composite"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(a),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(b),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: uniform.as_entire_binding(),
                },
            ],
        });
        self.draw(pipeline, &bind_group, target);
    }

    /// Like `run_pass`, for a pipeline on `filtered_layout`: `input` is read
    /// through a bilinear sampler.
    fn run_filtered_pass(
        &self,
        pipeline: &wgpu::RenderPipeline,
        input: &wgpu::TextureView,
        params: &[u8],
        target: &wgpu::TextureView,
    ) {
        let uniform = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("params"),
                contents: params,
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("filtered"),
            layout: &self.filtered_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(input),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.filtered_sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: uniform.as_entire_binding(),
                },
            ],
        });
        self.draw(pipeline, &bind_group, target);
    }

    /// One full-screen triangle with `bind_group`, written over all of
    /// `target`.
    fn draw(
        &self,
        pipeline: &wgpu::RenderPipeline,
        bind_group: &wgpu::BindGroup,
        target: &wgpu::TextureView,
    ) {
        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("composite"),
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
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
        self.queue.submit([encoder.finish()]);
    }
}

/// A pipeline that draws one full-screen triangle (`vs`) and runs the
/// fragment function `entry` into a `format` target, with no blending.
fn fullscreen_pipeline(
    device: &wgpu::Device,
    layout: &wgpu::PipelineLayout,
    shader: &wgpu::ShaderModule,
    entry: &str,
    format: wgpu::TextureFormat,
) -> wgpu::RenderPipeline {
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(entry),
        layout: Some(layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vs"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some(entry),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format,
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
}

/// The bind group of passes that resample the layer: the layer as a
/// filterable texture, a filtering sampler and one uniform block.
fn filtered_bind_group_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("filtered"),
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
    })
}

/// The bind group of the `lut` pass: the layer, the table as a 3D texture
/// (read with `textureLoad`, so not filterable) and one uniform block.
fn lut_bind_group_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    let texture = |binding, view_dimension| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: false },
            view_dimension,
            multisampled: false,
        },
        count: None,
    };
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("lut"),
        entries: &[
            texture(0, wgpu::TextureViewDimension::D2),
            texture(1, wgpu::TextureViewDimension::D3),
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
    })
}

/// Uploads a table as an Rgba32Float 3D texture: x is the red index, y green
/// and z blue, which is the order of the file's rows.
fn upload_lut(device: &wgpu::Device, queue: &wgpu::Queue, lut: &Lut) -> LutTexture {
    let texture = device.create_texture_with_data(
        queue,
        &wgpu::TextureDescriptor {
            label: Some("lut"),
            size: wgpu::Extent3d {
                width: lut.size,
                height: lut.size,
                depth_or_array_layers: lut.size,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D3,
            format: wgpu::TextureFormat::Rgba32Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        },
        wgpu::util::TextureDataOrder::LayerMajor,
        &floats(&lut.rgba()),
    );
    LutTexture {
        view: texture.create_view(&wgpu::TextureViewDescriptor::default()),
        size: lut.size as f32,
        domain_min: lut.domain_min,
        domain_max: lut.domain_max,
    }
}

/// A shader module for a built-in pass. Passes that call `hash` or
/// `cell_hash` get `shaders/hash.wgsl` put in front of their source.
fn shader_module(device: &wgpu::Device, label: &str, source: &str) -> wgpu::ShaderModule {
    let source = if source.contains("hash(") {
        format!("{}{source}", include_str!("shaders/hash.wgsl"))
    } else {
        source.to_string()
    };
    device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(label),
        source: wgpu::ShaderSource::Wgsl(source.into()),
    })
}

/// The bind group of a custom shader (`shader::compose` declares the
/// matching variables): the layer, a sampler for it, then the `Globals` and
/// `U` uniform blocks.
fn shader_bind_group_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    let uniform = |binding| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    };
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("shader effect"),
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
            uniform(2),
            uniform(3),
        ],
    })
}

/// A linear texture of any size that can be drawn to and read.
pub(crate) fn new_texture(device: &wgpu::Device, width: u32, height: u32) -> Tex {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("layer"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: LINEAR_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    Tex { texture, view }
}

/// Grain as `shaders/grain.wgsl` reads it: four floats (amount, size,
/// monochrome, unused), then four u32s (seed, frame, margin, unused).
fn grain_values(grain: &ResolvedGrain, margin: u32) -> Vec<u8> {
    let mut bytes = floats(&[
        grain.amount,
        grain.size,
        f32::from(u8::from(grain.monochrome)),
        0.0,
    ]);
    bytes.extend(
        [grain.seed, grain.frame, margin, 0]
            .iter()
            .flat_map(|v| v.to_le_bytes()),
    );
    bytes
}

/// A dither as `shaders/dither.wgsl` reads it: four floats (levels, size,
/// 1 for random, unused), then four u32s (seed, frame, margin, unused).
fn dither_values(dither: &ResolvedDither, margin: u32) -> Vec<u8> {
    let random = dither.mode == DitherMode::Random;
    let mut bytes = floats(&[
        dither.levels as f32,
        dither.size,
        f32::from(u8::from(random)),
        0.0,
    ]);
    bytes.extend(
        [dither.seed, dither.frame, margin, 0]
            .iter()
            .flat_map(|v| v.to_le_bytes()),
    );
    bytes
}

/// A halftone as `shaders/halftone.wgsl` reads it: the inverse of the layer
/// matrix (its linear part, then its translation), the cell size and grid
/// angle, the matrix's linear part, the options (shape, invert, whether
/// there is a tint) and the tint as linear straight colour plus alpha. A
/// matrix that cannot be inverted (a layer scaled to nothing) has nothing to
/// draw, so its inverse is zeros.
fn halftone_values(halftone: &ResolvedHalftone, layer_matrix: Affine) -> [f32; 20] {
    let m = layer_matrix.as_coeffs();
    let inverse = if layer_matrix.determinant().abs() > f64::EPSILON {
        layer_matrix.inverse().as_coeffs()
    } else {
        [0.0; 6]
    };
    let tint = halftone.color.map(|c| {
        let [r, g, b, a] = c.linear_premultiplied();
        // Back to straight: the shader scales by the alpha itself.
        if a > 0.0 {
            [r / a, g / a, b / a, a]
        } else {
            [0.0; 4]
        }
    });
    let shape = match halftone.shape {
        HalftoneShape::Circle => 0.0,
        HalftoneShape::Square => 1.0,
        HalftoneShape::Line => 2.0,
    };
    let [tr, tg, tb, ta] = tint.unwrap_or([0.0; 4]);
    [
        inverse[0] as f32,
        inverse[1] as f32,
        inverse[2] as f32,
        inverse[3] as f32,
        inverse[4] as f32,
        inverse[5] as f32,
        halftone.size,
        halftone.angle.to_radians(),
        m[0] as f32,
        m[1] as f32,
        m[2] as f32,
        m[3] as f32,
        shape,
        f32::from(u8::from(halftone.invert)),
        f32::from(u8::from(tint.is_some())),
        0.0,
        tr as f32,
        tg as f32,
        tb as f32,
        ta as f32,
    ]
}

/// Little-endian bytes of a uniform block made of `f32`s.
fn floats(values: &[f32]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// A colour matrix as `shaders/color.wgsl` reads it: the four rows of
/// coefficients, then the four offsets.
fn matrix_values(matrix: &ColorMatrix) -> [f32; 20] {
    let mut values = [0.0; 20];
    for (i, row) in matrix.0.iter().enumerate() {
        for (j, value) in row[..4].iter().enumerate() {
            values[i * 4 + j] = *value as f32;
        }
        values[16 + i] = row[4] as f32;
    }
    values
}

/// A gradient map as `shaders/gradient_map.wgsl` reads it: the stop count
/// and amount, the 16 offsets, then the 16 straight sRGB colours. Unused
/// slots repeat the last stop.
fn gradient_map_values(map: &ResolvedGradientMap) -> Vec<f32> {
    let last = map.stops.len() - 1;
    let stop = |i: usize| map.stops[i.min(last)];
    let mut values = vec![map.stops.len() as f32, map.amount, 0.0, 0.0];
    values.extend((0..MAX_GRADIENT_MAP_STOPS).map(|i| stop(i).0 as f32));
    for i in 0..MAX_GRADIENT_MAP_STOPS {
        let color = stop(i).1;
        values.extend([color.r, color.g, color.b, color.a].map(|v| f32::from(v) / 255.0));
    }
    values
}

/// A glow as `shaders/glow.wgsl` reads it: intensity and whether to tint,
/// then the linear premultiplied tint.
fn glow_values(glow: &ResolvedGlow) -> [f32; 8] {
    let tint = glow.color.map(|c| c.linear_premultiplied());
    let [r, g, b, a] = tint.unwrap_or([0.0; 4]);
    [
        glow.intensity,
        f32::from(u8::from(tint.is_some())),
        0.0,
        0.0,
        r as f32,
        g as f32,
        b as f32,
        a as f32,
    ]
}

/// Where the red channel is read from: `amount` pixels along `angle` degrees,
/// clockwise from the +x axis (y points down).
fn aberration_offset(amount: f32, angle: f32) -> [f32; 2] {
    let (sin, cos) = angle.to_radians().sin_cos();
    [amount * cos, amount * sin]
}

/// The number the shader's `blend_fn` switches on.
fn mode_index(mode: BlendMode) -> u32 {
    match mode {
        BlendMode::Normal => 0,
        BlendMode::Multiply => 1,
        BlendMode::Screen => 2,
        BlendMode::Overlay => 3,
        BlendMode::Darken => 4,
        BlendMode::Lighten => 5,
        BlendMode::ColorDodge => 6,
        BlendMode::ColorBurn => 7,
        BlendMode::HardLight => 8,
        BlendMode::SoftLight => 9,
        BlendMode::Difference => 10,
        BlendMode::Exclusion => 11,
        BlendMode::Hue => 12,
        BlendMode::Saturation => 13,
        BlendMode::Color => 14,
        BlendMode::Luminosity => 15,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::Color;

    #[test]
    fn aberration_angles_run_clockwise_from_the_x_axis() {
        let near =
            |got: [f32; 2], want: [f32; 2]| got.iter().zip(want).all(|(a, b)| (a - b).abs() < 1e-5);
        assert!(near(aberration_offset(4.0, 0.0), [4.0, 0.0]));
        assert!(near(aberration_offset(4.0, 90.0), [0.0, 4.0]));
        assert!(near(aberration_offset(-3.0, 180.0), [3.0, 0.0]));
        assert!(near(aberration_offset(0.0, 33.0), [0.0, 0.0]));
    }

    #[test]
    fn glow_values_say_whether_to_tint() {
        let glow = ResolvedGlow {
            radius: 8.0,
            color: None,
            intensity: 2.5,
        };
        assert_eq!(glow_values(&glow), [2.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
        let tinted = ResolvedGlow {
            color: Some(Color::parse("#ff000080").unwrap()),
            ..glow
        };
        let values = glow_values(&tinted);
        assert_eq!((values[0], values[1]), (2.5, 1.0));
        // Premultiplied: red at half alpha is (0.5, 0, 0, 0.5) in linear
        // light, since 0 and 1 are the same in both encodings.
        let alpha = 128.0 / 255.0;
        assert!((values[4] - alpha).abs() < 1e-6 && values[5] == 0.0);
        assert!((values[7] - alpha).abs() < 1e-6);
    }

    #[test]
    fn gradient_map_values_pad_with_the_last_stop() {
        let map = ResolvedGradientMap {
            stops: vec![
                (0.0, Color::parse("#000000").unwrap()),
                (0.25, Color::parse("#ff000080").unwrap()),
                (0.75, Color::parse("#ffffff").unwrap()),
            ],
            amount: 0.5,
        };
        let values = gradient_map_values(&map);
        // header, 16 offsets, 16 colours of 4: 21 vec4s.
        assert_eq!(values.len(), 4 + 16 + 64);
        assert_eq!(&values[..4], [3.0, 0.5, 0.0, 0.0]);
        assert_eq!(&values[4..8], [0.0, 0.25, 0.75, 0.75]);
        assert!(values[8..20].iter().all(|v| *v == 0.75));
        // The second colour is red at half alpha.
        assert_eq!(&values[24..28], [1.0, 0.0, 0.0, 128.0 / 255.0]);
        // A padded colour is the last stop's.
        assert_eq!(&values[20 + 15 * 4..], [1.0; 4]);
    }

    #[test]
    fn grain_values_mix_floats_and_integers() {
        let grain = ResolvedGrain {
            amount: 0.25,
            size: 3.0,
            seed: u32::MAX,
            frame: 12,
            monochrome: true,
        };
        let bytes = grain_values(&grain, 40);
        assert_eq!(bytes.len(), 32);
        let word = |i: usize| <[u8; 4]>::try_from(&bytes[i * 4..i * 4 + 4]).unwrap();
        assert_eq!(f32::from_le_bytes(word(0)), 0.25);
        assert_eq!(f32::from_le_bytes(word(1)), 3.0);
        assert_eq!(f32::from_le_bytes(word(2)), 1.0);
        assert_eq!(u32::from_le_bytes(word(4)), u32::MAX);
        assert_eq!(u32::from_le_bytes(word(5)), 12);
        assert_eq!(u32::from_le_bytes(word(6)), 40);
        let colour = grain_values(
            &ResolvedGrain {
                monochrome: false,
                ..grain
            },
            0,
        );
        assert_eq!(
            f32::from_le_bytes(<[u8; 4]>::try_from(&colour[8..12]).unwrap()),
            0.0
        );
    }

    fn halftone(shape: HalftoneShape) -> ResolvedHalftone {
        ResolvedHalftone {
            size: 8.0,
            angle: 90.0,
            shape,
            color: None,
            invert: false,
        }
    }

    #[test]
    fn halftone_values_carry_the_matrix_both_ways() {
        let matrix = Affine::translate((10.0, 20.0)) * Affine::scale(2.0);
        let values = halftone_values(
            &ResolvedHalftone {
                color: Some(Color {
                    r: 255,
                    g: 0,
                    b: 0,
                    a: 128,
                }),
                invert: true,
                ..halftone(HalftoneShape::Line)
            },
            matrix,
        );
        // The inverse (linear part, then translation): x / 2 - 5.
        assert_eq!(values[..6], [0.5, 0.0, 0.0, 0.5, -5.0, -10.0]);
        assert_eq!(values[6], 8.0);
        assert!((values[7] - std::f32::consts::FRAC_PI_2).abs() < 1e-6);
        assert_eq!(values[8..12], [2.0, 0.0, 0.0, 2.0]);
        // Line, inverted, tinted; the tint is straight, so only its alpha
        // is 128/255.
        assert_eq!(values[12..15], [2.0, 1.0, 1.0]);
        assert_eq!(values[16..19], [1.0, 0.0, 0.0]);
        assert!((values[19] - 128.0 / 255.0).abs() < 1e-6);
        let plain = halftone_values(&halftone(HalftoneShape::Circle), matrix);
        assert_eq!(plain[12..15], [0.0, 0.0, 0.0]);
        // Nothing to invert for a layer scaled to nothing.
        let flat = halftone_values(&halftone(HalftoneShape::Circle), Affine::scale(0.0));
        assert_eq!(flat[..6], [0.0; 6]);
    }

    /// `circle_radius` in shaders/halftone.wgsl, in units of the cell.
    fn circle_radius(v: f64) -> f64 {
        if v <= std::f64::consts::FRAC_PI_4 {
            return (v / std::f64::consts::PI).sqrt();
        }
        let (mut lo, mut hi) = (0.5_f64, 0.5_f64.sqrt());
        for _ in 0..10 {
            let r = 0.5 * (lo + hi);
            let segments = r * r * (0.5 / r).acos() - 0.5 * (r * r - 0.25).sqrt();
            if std::f64::consts::PI * r * r - 4.0 * segments < v {
                lo = r;
            } else {
                hi = r;
            }
        }
        hi
    }

    /// `coverage` in shaders/halftone.wgsl.
    fn coverage(dist: f64, r: f64, aa: f64) -> f64 {
        ((r - dist) / aa + 0.5).clamp(0.0, 1.0) * (2.0 * r / aa).clamp(0.0, 1.0)
    }

    /// The coverage of a unit cell at `(x, y)` from its centre, as
    /// `fs_halftone` works it out for a pixel `aa` of a cell wide.
    fn dot(shape: HalftoneShape, v: f64, aa: f64, x: f64, y: f64) -> f64 {
        let grow = 0.5 * aa * v;
        match shape {
            HalftoneShape::Circle => coverage(x.hypot(y), circle_radius(v) + grow, aa),
            HalftoneShape::Square => coverage(x.abs().max(y.abs()), 0.5 * v.sqrt() + grow, aa),
            HalftoneShape::Line => coverage(y.abs(), 0.5 * v + grow, aa),
        }
    }

    /// The mean of `dot` over the cell on an n x n grid.
    fn dot_area(shape: HalftoneShape, v: f64, aa: f64) -> f64 {
        let n = 400;
        let at = |i: usize| (i as f64 + 0.5) / n as f64 - 0.5;
        let sum: f64 = (0..n * n)
            .map(|i| dot(shape, v, aa, at(i % n), at(i / n)))
            .sum();
        sum / (n * n) as f64
    }

    #[test]
    fn dots_cover_the_fraction_of_the_cell_that_the_value_asks_for() {
        // Pixels a thousandth of a cell wide, so the soft edge is negligible.
        let aa = 0.001;
        for shape in [
            HalftoneShape::Circle,
            HalftoneShape::Square,
            HalftoneShape::Line,
        ] {
            // The circle's area is exact on both sides of the point where
            // neighbouring dots touch (pi/4 = 0.785).
            for v in [0.05, 0.25, 0.5, 0.78, 0.8, 0.9, 0.97] {
                let area = dot_area(shape, v, aa);
                assert!((area - v).abs() < 0.004, "{shape:?} {v}: {area}");
            }
        }
    }

    #[test]
    fn full_value_is_solid_and_zero_is_empty() {
        // A pixel a hundredth of a cell wide: every point of the cell,
        // corners included, must be fully covered at v = 1, and nothing at
        // v = 0, not even a faint speck at the centre.
        for shape in [
            HalftoneShape::Circle,
            HalftoneShape::Square,
            HalftoneShape::Line,
        ] {
            for i in 0..=40 {
                for j in 0..=40 {
                    let (x, y) = (i as f64 / 40.0 - 0.5, j as f64 / 40.0 - 0.5);
                    assert_eq!(dot(shape, 1.0, 0.01, x, y), 1.0, "{shape:?} {x} {y}");
                    assert_eq!(dot(shape, 0.0, 0.01, x, y), 0.0, "{shape:?} {x} {y}");
                }
            }
        }
        // And the circle's radius is the half diagonal there.
        assert_eq!(circle_radius(1.0), 0.5_f64.sqrt());
    }

    #[test]
    fn dots_grow_smoothly_and_the_edge_is_one_pixel_wide() {
        let mut last = 0.0;
        for i in 0..=100 {
            let r = circle_radius(f64::from(i) / 100.0);
            assert!(r >= last, "{i}: {r} < {last}");
            last = r;
        }
        // Either side of the touching point the radius is continuous.
        let touch = std::f64::consts::FRAC_PI_4;
        assert!((circle_radius(touch - 1e-6) - circle_radius(touch + 1e-6)).abs() < 5e-4);
        // A dot of radius 0.25 fades from full to nothing over one pixel
        // (aa = 0.02 of a cell) around its edge.
        let edge = |d: f64| coverage(d, 0.25, 0.02);
        assert_eq!(edge(0.25 - 0.01), 1.0);
        assert_eq!(edge(0.25 + 0.01), 0.0);
        assert!((edge(0.25) - 0.5).abs() < 1e-12);
        // A speck narrower than half a pixel dims instead of holding at half.
        assert!(coverage(0.0, 0.001, 0.02) < 0.1);
        // The shader solves the same equation the same number of times.
        let wgsl = include_str!("shaders/halftone.wgsl");
        assert!(
            wgsl.contains("PI * r * r - 4.0 * (r * r * acos(0.5 / r) - 0.5 * sqrt(r * r - 0.25))")
        );
        assert!(wgsl.contains("i < 10"));
        assert!(
            wgsl.contains("clamp((r - dist) / aa + 0.5, 0.0, 1.0) * clamp(2.0 * r / aa, 0.0, 1.0)")
        );
    }

    #[test]
    fn dither_values_say_which_threshold_to_use() {
        let dither = ResolvedDither {
            mode: DitherMode::Random,
            levels: 5,
            size: 2.0,
            seed: 77,
            frame: 4,
        };
        let word = |bytes: &[u8], i: usize| <[u8; 4]>::try_from(&bytes[i * 4..i * 4 + 4]).unwrap();
        let bytes = dither_values(&dither, 9);
        assert_eq!(bytes.len(), 32);
        assert_eq!(f32::from_le_bytes(word(&bytes, 0)), 5.0);
        assert_eq!(f32::from_le_bytes(word(&bytes, 1)), 2.0);
        assert_eq!(f32::from_le_bytes(word(&bytes, 2)), 1.0);
        assert_eq!(u32::from_le_bytes(word(&bytes, 4)), 77);
        assert_eq!(u32::from_le_bytes(word(&bytes, 5)), 4);
        assert_eq!(u32::from_le_bytes(word(&bytes, 6)), 9);
        let ordered = dither_values(
            &ResolvedDither {
                mode: DitherMode::Ordered,
                ..dither
            },
            0,
        );
        assert_eq!(f32::from_le_bytes(word(&ordered, 2)), 0.0);
    }

    #[test]
    fn matrix_values_put_coefficients_first_and_offsets_last() {
        let values = matrix_values(&ColorMatrix::invert(1.0));
        assert_eq!(
            values,
            [
                -1.0, 0.0, 0.0, 0.0, //
                0.0, -1.0, 0.0, 0.0, //
                0.0, 0.0, -1.0, 0.0, //
                0.0, 0.0, 0.0, 1.0, //
                1.0, 1.0, 1.0, 0.0,
            ]
        );
    }
}
