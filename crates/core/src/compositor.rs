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
//! Shaders that draw seeded noise (`shaders/grain.wgsl`, `dither.wgsl`) are
//! compiled with `shaders/hash.wgsl` in front of them (`shader_module`).
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
use crate::resolve::{
    ResolvedEffect, ResolvedGlow, ResolvedGradientMap, ResolvedShader, ResolvedShadow,
};
use crate::scene::{BlendMode, MAX_GRADIENT_MAP_STOPS, MaskMode, MatteMode};

pub const LINEAR_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
const READBACK_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// A linear premultiplied texture the size of the canvas plus its margin.
pub struct Tex {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
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
    /// For custom shaders: the layer, a sampler, the frame clock and the
    /// scene's named uniforms.
    shader_layout: wgpu::BindGroupLayout,
    shader_sampler: wgpu::Sampler,
    /// For passes that resample the layer: the layer (filterable), a
    /// bilinear sampler and a uniform block.
    #[expect(dead_code, reason = "used by the first resampling pass (warp)")]
    filtered_layout: wgpu::BindGroupLayout,
    #[expect(dead_code, reason = "used by the first resampling pass (warp)")]
    filtered_pipeline_layout: wgpu::PipelineLayout,
    #[expect(dead_code, reason = "used by the first resampling pass (warp)")]
    filtered_sampler: wgpu::Sampler,
    /// One pipeline per distinct custom shader, by `shader::compose` text.
    shaders: HashMap<String, wgpu::RenderPipeline>,
    blur: Blur,
    pool: Vec<Tex>,
}

impl Compositor {
    /// `width` x `height` is the canvas; textures are `margin` pixels larger
    /// on every side. `shaders` are the scene's custom shader modules
    /// (`Scene::shader_sources`).
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        width: u32,
        height: u32,
        margin: u32,
        shaders: &[String],
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
        _layer_matrix: Affine,
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
    #[expect(dead_code, reason = "used by the first resampling pass (warp)")]
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
