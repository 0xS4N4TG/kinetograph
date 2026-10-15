//! Blends layer textures in linear light.
//!
//! Every intermediate image is a `Rgba16Float` texture holding linear,
//! premultiplied colour. The canvas is the canvas plus a margin on every side
//! (`Scene::margin`, 0 unless an effect paints outside its layer), and the
//! buffer of a group is the same size, because what is blended into it can
//! be anywhere. A layer's texture holds only the part of that its pixels need
//! (`Tex::origin`, `Tex::size`), rounded up to a size class
//! (`bounds::size_class`) and pooled by size (`pool.rs`). A texture also says
//! where it can be non-zero (`Tex::bounds`, see `bounds.rs`), and a pass
//! draws only where its result can be: the input's box grown by what the pass
//! reads around a pixel. Every pass clears its target all over first, so
//! what it does not draw is transparent, which is what the pass would have
//! written there, and what a pass reads outside a texture is transparent
//! too.
//!
//! A pass finds its pixels on the canvas through `Place` (put in front of its
//! shader by `shader_source`, `shaders/place.wgsl`): the canvas pixel of the
//! fragment, and where each input sits. Everything a shader works out from
//! a position, a seeded pattern, a layer's own coordinates, uses the canvas
//! pixel, so it does not depend on the size of the texture.
//!
//! The passes that read the layer through the hardware's bilinear filter
//! (halftone, warp, a custom shader, and the blur's pyramid) are
//! the exception. The weights of a filtered read are worked out from the
//! texture's size, so they must read a texture of the size they always did:
//! `full_copy` puts a smaller layer into one first, and they write textures
//! of the canvas's size (the blur keeps the pyramid of a blur of the whole
//! canvas, and only draws part of it). The passes live in
//! `shaders/composite.wgsl`:
//!
//! - `to_linear`: Vello's sRGB-encoded Rgba8 output -> linear texture
//! - `blend`: backdrop + source + opacity + blend mode -> new texture
//! - `mask`: layer x the alpha or luminance of a Vello-drawn clip or gradient
//! - `matte`: layer x the alpha or luminance of another layer's texture
//! - `accumulate`: running sum + sample x weight, to average a motion-blurred
//!   layer's sub-frames
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
//! The warp pass (`shaders/warp.wgsl`) moves a finished layer by a 3x3
//! homography (`warp.rs`), through the same layout: a layer turned in 3D, or
//! a corner pin.
//!
//! Shaders that draw seeded noise (`shaders/grain.wgsl`, `dither.wgsl`,
//! `dot_matrix.wgsl`) are compiled with `shaders/hash.wgsl` in front of them
//! (`shader_module`), and those that evaluate turbulence with
//! `shaders/turbulence.wgsl`.
//!
//! The displace pass (`shaders/displace.wgsl`) also sits on the filtered
//! layout and the canvas-sized textures, but filters in the shader on
//! `textureLoad` from canvas positions, so the margin cannot change a pixel of
//! it. It takes the noise tables of its seed (built on first use,
//! `turbulence_tables`) as a second bind group. So does the noise layer's pass (`shaders/noise.wgsl`), on the shared layout, which fills a box's
//! coverage with the raw noise.
//!
//! A mesh gradient layer (`shaders/mesh.wgsl`) is not a full-screen pass: its
//! triangles are tessellated on the CPU (`mesh.rs`) and drawn with vertex
//! colours into a 4x multisampled target that resolves into a pooled texture.
//!
//! The `lut` pass (`shaders/lut.wgsl`) reads a 3D texture as well, so it has
//! a bind group layout of its own (`lut_layout`) and the scene's tables are
//! uploaded once, when the compositor is made.
//!
//! `shaders/shadow.wgsl` holds the shadow effects' passes. A drop shadow of
//! a rectangle, rounded rectangle or ellipse that `box_shadow::BoxShadow`
//! covers skips them: `shaders/shadow_box.wgsl` draws the layer over its
//! blurred shadow, worked out from a formula, in one pass.
//! `shaders/color.wgsl` holds the colour filter pass, `shaders/glow.wgsl` the glow
//! pass, `shaders/aberration.wgsl` the chromatic aberration pass and
//! `shaders/gradient_map.wgsl` the gradient map pass; they
//! share the bind group layout, so their passes go through the same
//! `run_pass`.
//!
//! Adding a blend mode: add a case to `blend_fn` in the shader and a
//! mapping in `mode_index`. Adding an effect: add a variant to
//! `scene::Effect` and `resolve::ResolvedEffect`, write its pass, and call it
//! from `apply_effects`.

use std::cell::{RefCell, RefMut};
use std::collections::HashMap;

use glam::DMat3;
use vello::kurbo::{Affine, Rect};
use vello::wgpu::{self, util::DeviceExt};

use crate::blur::{self, Blur};
use crate::bounds::{self, PixelRect};
use crate::box_shadow::BoxShadow;
use crate::color::ColorMatrix;
use crate::error::{Error, Result};
use crate::lut::Lut;
use crate::mesh;
use crate::pool::{Pool, Pooled};
use crate::resolve::{
    ResolvedCornerPin, ResolvedDisplace, ResolvedDither, ResolvedDotMatrix, ResolvedEffect,
    ResolvedGlow, ResolvedGradientMap, ResolvedGrain, ResolvedHalftone, ResolvedShader,
    ResolvedShadow, ResolvedTurbulence,
};
use crate::scene::{
    BlendMode, DitherMode, DotOrder, DotShape, HalftoneShape, MAX_GRADIENT_MAP_STOPS, MaskMode,
    MatteMode, NoiseChannels,
};
use crate::turbulence::{self, Tables};
use crate::uniforms::{Block, Uniforms};
use crate::warp;

mod filter_graph;

pub const LINEAR_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
const READBACK_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// A linear premultiplied texture that holds some of the canvas plus its
/// margin: the pixels from `origin` to `origin + size` of it. Textures come in
/// the sizes of `bounds::size_class`, and in the size of the whole canvas,
/// which is the size the canvas and the buffers of groups have.
pub struct Tex {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    /// The canvas pixel that texel (0, 0) is.
    pub origin: [i32; 2],
    /// Texels across and down.
    pub size: [u32; 2],
    /// Where the texture can be non-zero, in canvas pixels: outside this box
    /// it is exactly transparent, and the box is inside the texture. A
    /// texture from the pool holds whatever it held before until a pass
    /// clears it, so the producer of a texture sets this to what it drew.
    pub bounds: PixelRect,
}

impl Tex {
    /// The canvas pixels the texture covers.
    pub fn rect(&self) -> PixelRect {
        PixelRect::new(
            self.origin[0],
            self.origin[1],
            self.origin[0] + self.size[0] as i32,
            self.origin[1] + self.size[1] as i32,
        )
    }

    /// The texture as the input of a pass.
    pub fn input(&self) -> Input<'_> {
        Input {
            view: &self.view,
            origin: self.origin,
            size: self.size,
        }
    }
}

impl Pooled for Tex {
    fn dims(&self) -> [u32; 2] {
        self.size
    }

    fn bytes(&self) -> u64 {
        // Rgba16Float: eight bytes a texel.
        u64::from(self.size[0]) * u64::from(self.size[1]) * 8
    }
}

/// A texture a pass reads, and where it sits on the canvas (the `a` or `b` of
/// `Place` in `shaders/place.wgsl`). What a pass reads outside it is
/// transparent.
#[derive(Clone, Copy)]
pub struct Input<'a> {
    pub view: &'a wgpu::TextureView,
    pub origin: [i32; 2],
    pub size: [u32; 2],
}

/// How many bytes of released textures the compositor keeps for reuse. More
/// than a frame of a busy scene holds, so that a scene whose textures are
/// the same from frame to frame never allocates after the first; a scene
/// that keeps changing their sizes lets the oldest go.
const POOL_BYTES: u64 = 1 << 30;

/// Samples per pixel of a mesh gradient, whose outer edge is anti-aliased by
/// multisampling.
const MESH_SAMPLES: u32 = 4;

/// A LUT on the GPU.
struct LutTexture {
    view: wgpu::TextureView,
    /// What `Params` in `shaders/lut.wgsl` holds besides the amount: points
    /// per axis and the input domain.
    size: f32,
    domain_min: [f32; 3],
    domain_max: [f32; 3],
}

/// A frame's pixels on their way back from the GPU (`start_readback`).
pub struct Readback {
    buffer: wgpu::Buffer,
    /// Says when the buffer is mapped.
    mapped: std::sync::mpsc::Receiver<std::result::Result<(), wgpu::BufferAsyncError>>,
    /// The submit the copy went in.
    submission: Option<wgpu::SubmissionIndex>,
    row_bytes: u32,
    padded_row: u32,
    height: u32,
}

pub struct Compositor {
    device: wgpu::Device,
    queue: wgpu::Queue,
    /// Size of the canvas texture: the canvas plus twice the margin.
    width: u32,
    height: u32,
    /// The canvas, which `read_rgba8` copies out of the middle of a texture.
    canvas: (u32, u32),
    margin: u32,
    /// Blend and composite layers on sRGB-encoded values (`Scene::blend_space`).
    srgb_blend: bool,
    layout: wgpu::BindGroupLayout,
    to_linear: wgpu::RenderPipeline,
    blend: wgpu::RenderPipeline,
    mask: wgpu::RenderPipeline,
    matte: wgpu::RenderPipeline,
    accumulate: wgpu::RenderPipeline,
    encode: wgpu::RenderPipeline,
    spread: wgpu::RenderPipeline,
    drop_shadow: wgpu::RenderPipeline,
    /// The layer over its shadow in closed form (`shaders/shadow_box.wgsl`).
    drop_box: wgpu::RenderPipeline,
    inset_shadow: wgpu::RenderPipeline,
    color: wgpu::RenderPipeline,
    glow: wgpu::RenderPipeline,
    aberration: wgpu::RenderPipeline,
    gradient_map: wgpu::RenderPipeline,
    grain: wgpu::RenderPipeline,
    dither: wgpu::RenderPipeline,
    /// On `filtered_layout`: it reads the layer between texels.
    halftone: wgpu::RenderPipeline,
    dot_matrix: wgpu::RenderPipeline,
    /// On `filtered_layout`: it reads the layer between texels.
    warp: wgpu::RenderPipeline,
    /// On `filtered_layout` and then `turbulence_layout`.
    displace: wgpu::RenderPipeline,
    /// On the shared layout and then `turbulence_layout`.
    noise: wgpu::RenderPipeline,
    /// The passes of `filterGraph`, made the first time one is drawn.
    filter: Option<filter_graph::FilterPipelines>,
    /// Vertex-colour triangles, for mesh gradients (`mesh_size` at group 0).
    mesh: wgpu::RenderPipeline,
    /// The padded texture size, which the mesh's vertex shader needs.
    mesh_size: wgpu::BindGroup,
    mesh_layout: wgpu::BindGroupLayout,
    /// The multisampled target the mesh is drawn into, made the first time
    /// a mesh is drawn and kept.
    mesh_samples: Option<Tex>,
    /// For passes that evaluate turbulence: the storage buffer of one seed's
    /// tables, at bind group 1.
    turbulence_layout: wgpu::BindGroupLayout,
    /// The tables' bind groups by `turbulence::setup_seed`, made the first
    /// time a seed is drawn with.
    turbulence_tables: HashMap<i64, wgpu::BindGroup>,
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
    filtered_sampler: wgpu::Sampler,
    /// One pipeline per distinct custom shader, by `shader::compose` text.
    shaders: HashMap<String, wgpu::RenderPipeline>,
    shader_pipeline_layout: wgpu::PipelineLayout,
    blur: Blur,
    pool: Pool<Tex>,
    /// What the passes have recorded since the last `submit`. Passes record
    /// here instead of submitting one by one, which costs the driver far
    /// more than the passes themselves.
    pending: RefCell<Option<wgpu::CommandEncoder>>,
    /// The passes' uniform blocks.
    uniforms: RefCell<Uniforms>,
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
        let shadow_box_shader = shader_module(
            device,
            "shadow box",
            include_str!("shaders/shadow_box.wgsl"),
        );
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
        let dot_matrix_shader = shader_module(
            device,
            "dot matrix",
            include_str!("shaders/dot_matrix.wgsl"),
        );
        let halftone_shader =
            shader_module(device, "halftone", include_str!("shaders/halftone.wgsl"));
        let lut_shader = shader_module(device, "lut", include_str!("shaders/lut.wgsl"));
        let warp_shader = shader_module(device, "warp", include_str!("shaders/warp.wgsl"));
        let displace_shader =
            shader_module(device, "displace", include_str!("shaders/displace.wgsl"));
        let noise_shader = shader_module(device, "noise", include_str!("shaders/noise.wgsl"));
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
        let uniform_entry = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        // The two inputs, the pass's own uniforms and the placement.
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("composite"),
            entries: &[
                texture_entry(0),
                texture_entry(1),
                uniform_entry(2),
                uniform_entry(3),
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
        let warp = fullscreen_pipeline(
            device,
            &filtered_pipeline_layout,
            &warp_shader,
            "fs_warp",
            LINEAR_FORMAT,
        );
        let turbulence_layout = turbulence_bind_group_layout(device);
        let displace_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("displace"),
                bind_group_layouts: &[Some(&filtered_layout), Some(&turbulence_layout)],
                immediate_size: 0,
            });
        let displace = fullscreen_pipeline(
            device,
            &displace_pipeline_layout,
            &displace_shader,
            "fs_displace",
            LINEAR_FORMAT,
        );
        let noise_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("noise"),
                bind_group_layouts: &[Some(&layout), Some(&turbulence_layout)],
                immediate_size: 0,
            });
        let noise = fullscreen_pipeline(
            device,
            &noise_pipeline_layout,
            &noise_shader,
            "fs_noise",
            LINEAR_FORMAT,
        );
        let (mesh, mesh_layout) = mesh_pipeline(
            device,
            &shader_module(device, "mesh", include_str!("shaders/mesh.wgsl")),
        );
        let mesh_size = mesh_size_group(
            device,
            &mesh_layout,
            (width + 2 * margin, height + 2 * margin),
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
                (
                    source.clone(),
                    shader_effect_pipeline(device, &shader_pipeline_layout, source),
                )
            })
            .collect();
        Compositor {
            device: device.clone(),
            queue: queue.clone(),
            width: width + 2 * margin,
            height: height + 2 * margin,
            canvas: (width, height),
            margin,
            srgb_blend: false,
            to_linear: pipeline(&shader, "fs_to_linear", LINEAR_FORMAT),
            blend: pipeline(&shader, "fs_blend", LINEAR_FORMAT),
            mask: pipeline(&shader, "fs_mask", LINEAR_FORMAT),
            matte: pipeline(&shader, "fs_matte", LINEAR_FORMAT),
            accumulate: pipeline(&shader, "fs_accumulate", LINEAR_FORMAT),
            encode: pipeline(&shader, "fs_encode", READBACK_FORMAT),
            spread: pipeline(&shadow_shader, "fs_spread", LINEAR_FORMAT),
            drop_shadow: pipeline(&shadow_shader, "fs_drop", LINEAR_FORMAT),
            drop_box: pipeline(&shadow_box_shader, "fs_drop_box", LINEAR_FORMAT),
            inset_shadow: pipeline(&shadow_shader, "fs_inset", LINEAR_FORMAT),
            color: pipeline(&color_shader, "fs_color", LINEAR_FORMAT),
            glow: pipeline(&glow_shader, "fs_glow", LINEAR_FORMAT),
            aberration: pipeline(&aberration_shader, "fs_aberration", LINEAR_FORMAT),
            gradient_map: pipeline(&gradient_map_shader, "fs_gradient_map", LINEAR_FORMAT),
            grain: pipeline(&grain_shader, "fs_grain", LINEAR_FORMAT),
            dither: pipeline(&dither_shader, "fs_dither", LINEAR_FORMAT),
            halftone,
            dot_matrix: pipeline(&dot_matrix_shader, "fs_dot_matrix", LINEAR_FORMAT),
            warp,
            displace,
            noise,
            filter: None,
            mesh,
            mesh_size,
            mesh_layout,
            mesh_samples: None,
            turbulence_layout,
            turbulence_tables: HashMap::new(),
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
            shader_pipeline_layout,
            filtered_layout,
            filtered_sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("filtered"),
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            }),
            blur: Blur::new(device),
            layout,
            pool: Pool::new(POOL_BYTES),
            pending: RefCell::new(None),
            uniforms: RefCell::new(Uniforms::new(device, queue)),
        }
    }

    /// Makes the textures `width` x `height` (the canvas) plus `margin` on
    /// every side, keeping the pipelines, tables and the rest of what the
    /// compositor holds. The pool is emptied: its textures are the old size.
    /// The caller gives back the textures it holds (the layer cache's) first.
    /// Composite layers on sRGB-encoded values (`Scene::blend_space`) or in
    /// linear light.
    pub fn set_srgb_blend(&mut self, srgb: bool) {
        self.srgb_blend = srgb;
    }

    pub fn resize(&mut self, width: u32, height: u32, margin: u32) {
        self.width = width + 2 * margin;
        self.height = height + 2 * margin;
        self.canvas = (width, height);
        self.margin = margin;
        self.mesh_size =
            mesh_size_group(&self.device, &self.mesh_layout, (self.width, self.height));
        self.mesh_samples = None;
        self.pool = Pool::new(POOL_BYTES);
    }

    /// Adds a pipeline for each custom shader module that has none yet
    /// (`Scene::shader_sources`).
    pub fn add_shaders(&mut self, sources: &[String]) {
        for source in sources {
            if !self.shaders.contains_key(source) {
                let pipeline =
                    shader_effect_pipeline(&self.device, &self.shader_pipeline_layout, source);
                self.shaders.insert(source.clone(), pipeline);
            }
        }
    }

    /// Uploads `luts`, replacing a table that has the same `src`.
    pub fn set_luts(&mut self, luts: &HashMap<String, Lut>) {
        for (src, lut) in luts {
            let texture = upload_lut(&self.device, &self.queue, lut);
            self.luts.insert(src.clone(), texture);
        }
    }

    /// The encoder the passes record into, until the next `submit`.
    fn encoder(&self) -> RefMut<'_, wgpu::CommandEncoder> {
        RefMut::map(self.pending.borrow_mut(), |pending| {
            pending.get_or_insert_with(|| self.device.create_command_encoder(&Default::default()))
        })
    }

    /// Submits what the passes have recorded. Whatever else writes to the
    /// textures they read (Vello drawing into its target) must come after,
    /// and whatever waits for their results (a readback) too.
    pub fn submit(&self) -> Option<wgpu::SubmissionIndex> {
        self.uniforms.borrow_mut().upload();
        let encoder = self.pending.borrow_mut().take()?;
        Some(self.queue.submit([encoder.finish()]))
    }

    /// Starts a frame: the uniform blocks of the last one are no longer
    /// needed once it is submitted, which it is by its readback.
    pub fn begin_frame(&self) {
        self.submit();
        self.uniforms.borrow_mut().rewind();
    }

    /// A uniform block holding `bytes`, for a pass about to be recorded.
    fn uniform(&self, bytes: &[u8]) -> Block {
        self.uniforms.borrow_mut().push(bytes)
    }

    /// A texture of exactly `size` texels, from the pool when possible, with
    /// undefined contents and empty bounds.
    fn acquire_sized(&mut self, size: [u32; 2]) -> Tex {
        let mut tex = self
            .pool
            .take(size)
            .unwrap_or_else(|| new_texture(&self.device, size[0], size[1]));
        tex.origin = [0, 0];
        tex.bounds = PixelRect::EMPTY;
        tex
    }

    pub fn release(&mut self, tex: Tex) {
        self.pool.put(tex);
    }

    /// The box of the whole canvas texture.
    fn whole(&self) -> PixelRect {
        PixelRect::whole(self.width, self.height)
    }

    /// A texture for a pass to draw the box `region` of (cut to the canvas):
    /// the box is the texture's bounds, and the pass draws it. The texture is
    /// the smallest class (`bounds::placement`) that holds it, placed on the
    /// canvas at the box's corner. Its contents are undefined until the
    /// pass clears it.
    fn target(&mut self, region: PixelRect) -> Tex {
        let region = region.intersect(self.whole());
        let (origin, size) = bounds::placement(region, (self.width, self.height));
        let mut tex = self.acquire_sized(size);
        tex.origin = origin;
        tex.bounds = region;
        tex
    }

    /// Like `target`, but a texture the size of the whole canvas at its
    /// origin, whatever `region` is. The passes that read through a filter
    /// (and the mesh's multisampled draw) work on this size only.
    fn target_full(&mut self, region: PixelRect) -> Tex {
        let mut tex = self.acquire_sized([self.width, self.height]);
        tex.bounds = region.intersect(self.whole());
        tex
    }

    /// `src` as a texture the size of the canvas at its origin, for a pass
    /// that reads it through a bilinear filter: the hardware works out the
    /// weights of a filtered read from the texture's size, so a pass that is
    /// to give what it always gave must read a texture of that size. `None`
    /// if `src` is one already; otherwise a copy of what `src` holds in a
    /// cleared pooled texture, for the caller to release.
    fn full_copy(&mut self, src: &Tex) -> Option<Tex> {
        if src.origin == [0, 0] && src.size == [self.width, self.height] {
            return None;
        }
        let full = self.target_full(src.bounds);
        let mut encoder = self.encoder();
        encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("clear"),
            color_attachments: &[Some(clear_attachment(&full.view, wgpu::Color::TRANSPARENT))],
            ..Default::default()
        });
        copy_box(&mut encoder, src, &full, src.bounds);
        drop(encoder);
        Some(full)
    }

    /// The Vello output texture, which is the size of the canvas, as a pass
    /// input.
    fn vello_input<'a>(&self, view: &'a wgpu::TextureView) -> Input<'a> {
        Input {
            view,
            origin: [0, 0],
            size: [self.width, self.height],
        }
    }

    /// A texture filled with `color` (linear, premultiplied), the size of
    /// the canvas: the canvas itself, or the buffer a group's children are
    /// blended into, which they may go anywhere in.
    pub fn filled(&mut self, color: [f64; 4]) -> Tex {
        // Transparent black is zero everywhere, which is what empty bounds
        // promise.
        let region = if color == [0.0; 4] {
            PixelRect::EMPTY
        } else {
            self.whole()
        };
        let tex = self.target_full(region);
        self.clear(
            &tex,
            wgpu::Color {
                r: color[0],
                g: color[1],
                b: color[2],
                a: color[3],
            },
        );
        tex
    }

    /// A transparent texture of the smallest class, for a layer that draws
    /// nothing.
    pub fn empty(&mut self) -> Tex {
        let tex = self.target(PixelRect::EMPTY);
        self.clear(&tex, wgpu::Color::TRANSPARENT);
        tex
    }

    fn clear(&self, tex: &Tex, color: wgpu::Color) {
        self.encoder()
            .begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("clear"),
                color_attachments: &[Some(clear_attachment(&tex.view, color))],
                ..Default::default()
            });
    }

    /// Converts the box `region` of a Vello output texture (Rgba8,
    /// sRGB-encoded, straight alpha) to a linear premultiplied texture.
    /// Vello leaves what it did not draw transparent, so `region` is the box
    /// of what it drew. Vello drew `area` of the canvas (the whole canvas, or
    /// a smaller box from `bounds::vello_area`) into the texture's top left
    /// corner, so the canvas pixel (`area.x0`, `area.y0`) is the texel
    /// (0, 0); `region` is inside `area`, and what is read outside `area`
    /// is transparent, never what an earlier draw left in the texture.
    pub fn from_srgb8(
        &mut self,
        vello_output: &wgpu::TextureView,
        area: PixelRect,
        region: PixelRect,
    ) -> Tex {
        let target = self.target(region);
        let input = Input {
            view: vello_output,
            origin: [area.x0, area.y0],
            size: [area.width(), area.height()],
        };
        self.pass(&self.to_linear, input, input, 0.0, 0, &target);
        target
    }

    /// `from_srgb8` for each of `regions` of a Vello output that was drawn
    /// over the whole canvas, as one texture each.
    pub fn from_srgb8_many(
        &mut self,
        vello_output: &wgpu::TextureView,
        regions: &[PixelRect],
    ) -> Vec<Tex> {
        let input = self.vello_input(vello_output);
        regions
            .iter()
            .map(|&region| {
                let target = self.target(region);
                let bind_group = self.composite_bind_group(input, input, &[0u8; 16], &target);
                self.encode_draw(&mut self.encoder(), &self.to_linear, &bind_group, &target);
                target
            })
            .collect()
    }

    /// Composites `src` over `dst` with the layer's opacity and blend mode.
    /// `src` is only read, and stays its owner's (the layer cache keeps one
    /// for the next frame); the result is `dst`, changed under the box of
    /// `src` only.
    ///
    /// Where `src` is transparent the pass gives back the pixel of `dst`
    /// exactly: the source is `0 * opacity = 0`, so the result is
    /// `0 * (1 - b.a) + b.rgb * 1 + 0 * b.a * B(cb, 0) = b.rgb` and the alpha
    /// `0 + b.a * 1`, provided `B(cb, 0)` is finite. It is for every
    /// separable mode. The four non-separable modes (hue, saturation, color,
    /// luminosity) divide in `clip_color`, which a backdrop outside 0..1 or a
    /// grey that rounds a hair below zero can make a division by zero, so
    /// they are drawn over the whole texture as they always were.
    ///
    /// `dst` must hold the box drawn.
    pub fn blend(&mut self, mut dst: Tex, src: &Tex, opacity: f32, mode: BlendMode) -> Tex {
        let mode = mode_index(mode);
        // Bit 16 of the pass's mode says to composite in sRGB.
        let space_bit = if self.srgb_blend { 1 << 16 } else { 0 };
        let region = if mode >= FIRST_NON_SEPARABLE_MODE {
            self.whole()
        } else {
            src.bounds
        };
        self.update(&mut dst, region, |c, dst, temp| {
            c.pass(&c.blend, dst.input(), src.input(), opacity, mode | space_bit, temp);
        });
        dst.bounds = dst.bounds.union(src.bounds);
        dst
    }

    /// Draws `region` of a new texture with `draw`, which is given `dst` and
    /// that texture, and copies the result over the same box of `dst`, which
    /// must hold it. It is how a pass that reads `dst` changes it in place:
    /// it cannot be its own target. The copy is exact.
    fn update(
        &mut self,
        dst: &mut Tex,
        region: PixelRect,
        draw: impl FnOnce(&Compositor, &Tex, &Tex),
    ) {
        let region = region.intersect(self.whole());
        if region.is_empty() {
            return;
        }
        assert!(
            dst.rect().intersect(region) == region,
            "a texture over {:?} cannot take {region:?}",
            dst.rect()
        );
        let temp = self.target(region);
        draw(self, dst, &temp);
        copy_box(&mut self.encoder(), &temp, dst, region);
        self.release(temp);
    }

    /// Multiplies `src` by the alpha or luminance of a Vello output texture
    /// (Rgba8): a clip shape drawn in opaque white, or a gradient. `keep` is
    /// the box outside which that is zero (the whole texture for a gradient).
    /// `src` goes back to the pool; the result is a new texture.
    pub fn mask(
        &mut self,
        src: Tex,
        vello_output: &wgpu::TextureView,
        mode: MaskMode,
        keep: PixelRect,
    ) -> Tex {
        let mode = match mode {
            MaskMode::Alpha => 0,
            MaskMode::Luminance => 2,
        };
        let target = self.target(src.bounds.intersect(keep));
        let vello = self.vello_input(vello_output);
        self.pass(&self.mask, src.input(), vello, 0.0, mode, &target);
        self.release(src);
        target
    }

    /// Multiplies `src` by what the matte source `matte` keeps, after
    /// scaling the matte by `matte_opacity`. Both inputs go back to the pool;
    /// the result is a new texture.
    pub fn matte(&mut self, src: Tex, matte: Tex, matte_opacity: f32, mode: MatteMode) -> Tex {
        // Outside the matte source it keeps nothing, unless the matte is
        // inverted: then it keeps all.
        let inverted = matches!(
            mode,
            MatteMode::AlphaInverted | MatteMode::LuminanceInverted
        );
        let mode = match mode {
            MatteMode::Alpha => 0,
            MatteMode::AlphaInverted => 1,
            MatteMode::Luminance => 2,
            MatteMode::LuminanceInverted => 3,
        };
        let region = if inverted {
            src.bounds
        } else {
            src.bounds.intersect(matte.bounds)
        };
        let target = self.target(region);
        self.pass(
            &self.matte,
            src.input(),
            matte.input(),
            matte_opacity,
            mode,
            &target,
        );
        self.release(src);
        self.release(matte);
        target
    }

    /// Adds `src` times `weight` to `sum`, for averaging a motion-blurred
    /// layer's sub-frames. `src` goes back to the pool; the result is `sum`,
    /// changed under the box of `src` only (anywhere else `src` adds nothing).
    /// `sum` must hold that box. Callers add in a fixed order, so the result
    /// is the same every time.
    pub fn accumulate(&mut self, mut sum: Tex, src: Tex, weight: f32) -> Tex {
        self.update(&mut sum, src.bounds, |c, sum, temp| {
            c.pass(&c.accumulate, sum.input(), src.input(), weight, 0, temp);
        });
        sum.bounds = sum.bounds.union(src.bounds);
        self.release(src);
        sum
    }

    /// Composites `above` over `below` (normal blend, full opacity) into a new
    /// texture. Neither input is released.
    pub fn over(&mut self, below: &Tex, above: &Tex) -> Tex {
        let target = self.target(below.bounds.union(above.bounds));
        self.pass(&self.blend, below.input(), above.input(), 1.0, 0, &target);
        target
    }

    /// Runs a layer's effects, in order, on its own texture before it is
    /// blended. Each effect should read `src`, draw into a texture from
    /// `target`, release `src` and return the new one, whose bounds are
    /// where the effect can make it non-zero.
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
    /// `layer_box` is the layer's own box in layer space (none for a group),
    /// which effects that measure across the layer need; the caller only has
    /// to work it out when one does (`needs_box`).
    ///
    /// `box_shadow` is `BoxShadow::plan` of the layer, which is only ever
    /// the first effect's: that drop shadow is drawn in closed form.
    #[allow(clippy::too_many_arguments)]
    pub fn apply_effects(
        &mut self,
        mut src: Tex,
        layer_matrix: Affine,
        layer_box: Option<Rect>,
        effects: &[ResolvedEffect],
        backdrop: Option<&Tex>,
        coverage: Option<&Tex>,
        box_shadow: Option<&BoxShadow>,
    ) -> Tex {
        for (i, effect) in effects.iter().enumerate() {
            match *effect {
                ResolvedEffect::Blur { radius } if radius >= blur::MIN_RADIUS => {
                    src = self.blur_layer(src, radius);
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
                ResolvedEffect::DropShadow(shadow) => {
                    src = match box_shadow {
                        Some(closed) if i == 0 => self.box_shadow(src, closed),
                        _ => self.shadow(src, &shadow, false),
                    };
                }
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
                ResolvedEffect::DotMatrix(dots) if dots.progress < 1.0 => {
                    src = self.dot_matrix(src, layer_matrix, layer_box, &dots);
                }
                ResolvedEffect::DotMatrix(_) => {}
                ResolvedEffect::Displace(displace) if displace.scale != 0.0 => {
                    src = self.displace(src, layer_matrix, &displace);
                }
                ResolvedEffect::Displace(_) => {}
                ResolvedEffect::CornerPin(ref pin) => {
                    src = self.corner_pin(src, layer_matrix, layer_box, pin);
                }
                ResolvedEffect::FilterGraph(ref graph) => {
                    src = self.filter_graph(src, layer_matrix, layer_box, graph);
                }
                ResolvedEffect::Shader(ref shader) => src = self.custom_shader(src, shader),
            }
        }
        src
    }

    /// Blurs `src`, which gains a halo up to the blur's reach. `src` goes
    /// back to the pool; the result is a new texture.
    fn blur_layer(&mut self, src: Tex, radius: f32) -> Tex {
        if src.bounds.is_empty() {
            return src;
        }
        let size = (self.width, self.height);
        let reach = Blur::reach(size, radius, src.bounds);
        let dst = self.target(reach);
        self.blur.run(
            &self.device,
            self.pending
                .get_mut()
                .get_or_insert_with(|| self.device.create_command_encoder(&Default::default())),
            self.uniforms.get_mut(),
            src.input(),
            dst.input(),
            size,
            radius,
            src.bounds,
            dst.bounds,
        );
        self.release(src);
        dst
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
        // The blurred backdrop is kept to the box of what keeps it, and
        // is only worked out there.
        let frost = coverage.map_or(src.bounds, |t| t.bounds);
        if frost.is_empty() {
            // Nothing of it is kept: `src` over nothing is `src`.
            return src;
        }
        let blurred = self.target(frost);
        let size = (self.width, self.height);
        self.blur.run(
            &self.device,
            self.pending
                .get_mut()
                .get_or_insert_with(|| self.device.create_command_encoder(&Default::default())),
            self.uniforms.get_mut(),
            backdrop.input(),
            blurred.input(),
            size,
            radius,
            backdrop.bounds,
            blurred.bounds,
        );
        // The matte pass with opacity 1 and alpha mode multiplies its first
        // input by the alpha of its second. `src` is blended over the result
        // in place, so the texture holds its box as well as the frost.
        let mut frosted = self.target(frost.union(src.bounds));
        frosted.bounds = frost;
        let coverage = coverage.map_or_else(|| src.input(), |t| t.input());
        self.pass(&self.matte, blurred.input(), coverage, 1.0, 0, &frosted);
        self.release(blurred);
        let frosted = self.blend(frosted, &src, 1.0, BlendMode::Normal);
        self.release(src);
        frosted
    }

    /// Draws a halo under `src`: a blurred copy of it, tinted if asked. `src`
    /// goes back to the pool; the result is a new texture.
    fn glow(&mut self, src: Tex, glow: &ResolvedGlow) -> Tex {
        if glow.radius < blur::MIN_RADIUS || glow.intensity <= 0.0 || src.bounds.is_empty() {
            return src;
        }
        let size = (self.width, self.height);
        let halo = self.target(Blur::reach(size, glow.radius, src.bounds));
        self.blur.run(
            &self.device,
            self.pending
                .get_mut()
                .get_or_insert_with(|| self.device.create_command_encoder(&Default::default())),
            self.uniforms.get_mut(),
            src.input(),
            halo.input(),
            size,
            glow.radius,
            src.bounds,
            halo.bounds,
        );
        let target = self.target(src.bounds.union(halo.bounds));
        self.run_pass(
            &self.glow,
            src.input(),
            halo.input(),
            &floats(&glow_values(glow)),
            &target,
        );
        self.release(halo);
        self.release(src);
        target
    }

    /// Splits the colour channels of `src` apart in one pass: red is read
    /// `offset` pixels away, blue the same distance the other way. `src` goes
    /// back to the pool; the result is a new texture.
    fn chromatic_aberration(&mut self, src: Tex, offset: [f32; 2]) -> Tex {
        if src.bounds.is_empty() {
            return src;
        }
        let (dx, dy) = bounds::aberration_growth(offset);
        let target = self.target(src.bounds.grow(dx, dy));
        let params = floats(&[offset[0], offset[1], 0.0, 0.0]);
        self.run_pass(&self.aberration, src.input(), src.input(), &params, &target);
        self.release(src);
        target
    }

    /// Runs a colour filter over `src` in one pass. `src` goes back to the
    /// pool; the result is a new texture.
    fn color_matrix(&mut self, src: Tex, matrix: &ColorMatrix) -> Tex {
        if src.bounds.is_empty() {
            return src;
        }
        let target = self.target(src.bounds);
        self.run_pass(
            &self.color,
            src.input(),
            src.input(),
            &floats(&matrix_values(matrix)),
            &target,
        );
        self.release(src);
        target
    }

    /// Recolours `src` by luminance in one pass. `src` goes back to the pool;
    /// the result is a new texture.
    fn gradient_map(&mut self, src: Tex, map: &ResolvedGradientMap) -> Tex {
        if src.bounds.is_empty() {
            return src;
        }
        let target = self.target(src.bounds);
        self.run_pass(
            &self.gradient_map,
            src.input(),
            src.input(),
            &floats(&gradient_map_values(map)),
            &target,
        );
        self.release(src);
        target
    }

    /// Adds seeded grain to `src` in one pass. `src` goes back to the pool;
    /// the result is a new texture.
    fn grain(&mut self, src: Tex, grain: &ResolvedGrain) -> Tex {
        if src.bounds.is_empty() {
            return src;
        }
        let target = self.target(src.bounds);
        self.run_pass(
            &self.grain,
            src.input(),
            src.input(),
            &grain_values(grain, self.margin),
            &target,
        );
        self.release(src);
        target
    }

    /// Quantises `src` to a few levels per channel in one pass. `src` goes
    /// back to the pool; the result is a new texture.
    fn dither(&mut self, src: Tex, dither: &ResolvedDither) -> Tex {
        if src.bounds.is_empty() {
            return src;
        }
        let target = self.target(src.bounds);
        self.run_pass(
            &self.dither,
            src.input(),
            src.input(),
            &dither_values(dither, self.margin),
            &target,
        );
        self.release(src);
        target
    }

    /// Replaces `src` with a halftone screen of it, laid out in the layer's
    /// space (`layer_matrix` takes that to texels). `src` goes back to the
    /// pool; the result is a new texture.
    fn halftone(&mut self, src: Tex, layer_matrix: Affine, halftone: &ResolvedHalftone) -> Tex {
        if src.bounds.is_empty() {
            return src;
        }
        let region = match bounds::halftone_growth(halftone.size, layer_matrix) {
            Some(g) => src.bounds.grow(g, g),
            None => self.whole(),
        };
        let scratch = self.full_copy(&src);
        let input = scratch.as_ref().unwrap_or(&src);
        let target = self.target_full(region);
        self.run_filtered_pass(
            &self.halftone,
            &input.view,
            &floats(&halftone_values(halftone, layer_matrix)),
            &target,
        );
        if let Some(scratch) = scratch {
            self.release(scratch);
        }
        self.release(src);
        target
    }

    /// Shows `src` through a grid of growing dots (see
    /// `shaders/dot_matrix.wgsl`). `src` goes back to the pool; the result is
    /// a new texture.
    fn dot_matrix(
        &mut self,
        src: Tex,
        layer_matrix: Affine,
        layer_box: Option<Rect>,
        dots: &ResolvedDotMatrix,
    ) -> Tex {
        if src.bounds.is_empty() {
            return src;
        }
        let target = self.target(src.bounds);
        self.run_pass(
            &self.dot_matrix,
            src.input(),
            src.input(),
            &dot_matrix_values(dots, layer_matrix, layer_box),
            &target,
        );
        self.release(src);
        target
    }

    /// Pins the corners of the layer's box (`layer_box`, in the space
    /// `layer_matrix` takes to texels) to the points of `pin`, with the warp
    /// pass. `src` goes back to the pool; the result is a new texture. A pin
    /// that leaves the box alone costs nothing, and one that squeezes it to a
    /// line or a point (or a layer with no area) leaves nothing to draw.
    fn corner_pin(
        &mut self,
        src: Tex,
        layer_matrix: Affine,
        layer_box: Option<Rect>,
        pin: &ResolvedCornerPin,
    ) -> Tex {
        let Some(b) = layer_box else {
            return src;
        };
        let points = pin.points(b);
        if points == warp::rect_corners(b) {
            return src;
        }
        match warp::corner_pin_homography(b, points).and_then(|h| warp::in_texels(layer_matrix, h))
        {
            Some(h) => self.warp(src, h),
            None => {
                self.release(src);
                self.empty()
            }
        }
    }

    /// Moves `src` by the homography `h` of texels (see
    /// `shaders/warp.wgsl`). `src` goes back to the pool; the result is a new
    /// texture.
    pub fn warp(&mut self, src: Tex, h: DMat3) -> Tex {
        if src.bounds.is_empty() {
            return src;
        }
        let region = bounds::warped(h, src.bounds).unwrap_or(self.whole());
        let scratch = self.full_copy(&src);
        let input = scratch.as_ref().unwrap_or(&src);
        let target = self.target_full(region);
        self.run_filtered_pass(
            &self.warp,
            &input.view,
            &floats(&warp_values(h.inverse())),
            &target,
        );
        if let Some(scratch) = scratch {
            self.release(scratch);
        }
        self.release(src);
        target
    }

    /// Displaces `src` by turbulence noise in the layer's space
    /// (`layer_matrix` takes that to texels). `src` goes back to the pool; the
    /// result is a new texture.
    fn displace(&mut self, src: Tex, layer_matrix: Affine, displace: &ResolvedDisplace) -> Tex {
        if src.bounds.is_empty() {
            return src;
        }
        let region = match bounds::displace_growth(displace.scale, layer_matrix) {
            Some(g) => src.bounds.grow(g, g),
            None => self.whole(),
        };
        let key = self.turbulence_tables(displace.turbulence.seed);
        let scratch = self.full_copy(&src);
        let input = scratch.as_ref().unwrap_or(&src);
        let target = self.target_full(region);
        self.run_filtered_pass_with(
            &self.displace,
            &input.view,
            &displace_values(displace, layer_matrix, self.margin),
            Some(&self.turbulence_tables[&key]),
            &target,
        );
        if let Some(scratch) = scratch {
            self.release(scratch);
        }
        self.release(src);
        target
    }

    /// Fills the box whose coverage is `coverage` (opaque white where the box
    /// is, anti-aliased at its edge) with the raw turbulence image, in the
    /// layer's space (`layer_matrix` takes that to texels). `coverage` goes
    /// back to the pool; the result is a new texture.
    pub fn noise(
        &mut self,
        coverage: Tex,
        layer_matrix: Affine,
        turbulence: &ResolvedTurbulence,
        channels: NoiseChannels,
    ) -> Tex {
        let key = self.turbulence_tables(turbulence.seed);
        let target = self.target(coverage.bounds);
        self.run_pass_with(
            &self.noise,
            coverage.input(),
            coverage.input(),
            &noise_values(turbulence, channels, layer_matrix),
            Some(&self.turbulence_tables[&key]),
            &target,
        );
        self.release(coverage);
        target
    }

    /// Draws a mesh gradient's `vertices` (triangles in texels, from
    /// `mesh::tessellate`) into a new texture. The triangles are drawn with
    /// multisampling, so the mesh's outer edge is anti-aliased. The target is
    /// the size of the canvas: a multisampled target resolves into a texture
    /// of its own size.
    pub fn mesh_gradient(&mut self, vertices: &[mesh::Vertex]) -> Tex {
        let mut target = self.target_full(PixelRect::EMPTY);
        if self.mesh_samples.is_none() {
            let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("mesh samples"),
                size: wgpu::Extent3d {
                    width: self.width,
                    height: self.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: MESH_SAMPLES,
                dimension: wgpu::TextureDimension::D2,
                format: LINEAR_FORMAT,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            });
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            self.mesh_samples = Some(Tex {
                texture,
                view,
                origin: [0, 0],
                size: [self.width, self.height],
                bounds: PixelRect::EMPTY,
            });
        }
        let samples = self.mesh_samples.as_ref().expect("made above");
        let buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("mesh vertices"),
                contents: &mesh_vertex_bytes(vertices),
                usage: wgpu::BufferUsages::VERTEX,
            });
        {
            let mut encoder = self.encoder();
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("mesh"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &samples.view,
                    depth_slice: None,
                    resolve_target: Some(&target.view),
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        // Only the resolved image is wanted.
                        store: wgpu::StoreOp::Discard,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.mesh);
            pass.set_bind_group(0, &self.mesh_size, &[]);
            pass.set_vertex_buffer(0, buffer.slice(..));
            pass.draw(0..vertices.len() as u32, 0..1);
        }
        // Nothing is drawn outside the triangles, and a pixel they touch
        // only partly is inside the box of their corners grown by a pixel.
        target.bounds = mesh_bounds(vertices).intersect(self.whole());
        target
    }

    /// Makes sure the noise tables of `seed` are on the GPU and returns the
    /// key of their bind group in `turbulence_tables`.
    fn turbulence_tables(&mut self, seed: i64) -> i64 {
        let key = turbulence::setup_seed(seed);
        if !self.turbulence_tables.contains_key(&key) {
            let buffer = self
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("turbulence tables"),
                    contents: &Tables::new(seed).to_bytes(),
                    usage: wgpu::BufferUsages::STORAGE,
                });
            let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("turbulence tables"),
                layout: &self.turbulence_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: buffer.as_entire_binding(),
                }],
            });
            self.turbulence_tables.insert(key, bind_group);
        }
        key
    }

    /// Grades `src` through the table loaded for `key`, faded in by `amount`.
    /// `src` goes back to the pool; the result is a new texture. A table the
    /// compositor was not given at creation is skipped.
    fn lut(&mut self, src: Tex, key: &str, amount: f32) -> Tex {
        if !self.luts.contains_key(key) || src.bounds.is_empty() {
            return src;
        }
        let target = self.target(src.bounds);
        let lut = &self.luts[key];
        let [rx, ry, rz] = lut.domain_min;
        let [sx, sy, sz] = lut.domain_max;
        let params = floats(&[rx, ry, rz, 0.0, sx, sy, sz, 0.0, lut.size, amount, 0.0, 0.0]);
        let uniform = self.uniform(&params);
        let place = self.place_buffer(&target, src.input(), src.input());
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
                    resource: uniform.binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: place.binding(),
                },
            ],
        });
        self.draw(&self.lut, &bind_group, &target);
        self.release(src);
        target
    }

    /// Runs a scene's own fragment shader over `src`. `src` goes back to the
    /// pool; the result is a new texture. A shader the compositor was not
    /// given at creation is skipped.
    ///
    /// The shader may paint anywhere (`padding` only sizes the margin), even
    /// where `src` is transparent, so it runs over the whole texture and
    /// its result is bounded by nothing. It reads the layer through a
    /// bilinear filter, so, like the other filtered passes, from a texture the
    /// size of the canvas.
    fn custom_shader(&mut self, src: Tex, shader: &ResolvedShader) -> Tex {
        if !self.shaders.contains_key(&shader.source) {
            return src;
        }
        let scratch = self.full_copy(&src);
        let input = scratch.as_ref().unwrap_or(&src);
        let target = self.target_full(self.whole());
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
        let globals = self.uniform(&globals);
        let uniforms = self.uniform(&floats(&values));
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("shader effect"),
            layout: &self.shader_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&input.view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.shader_sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: globals.binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: uniforms.binding(),
                },
            ],
        });
        self.draw(pipeline, &bind_group, &target);
        if let Some(scratch) = scratch {
            self.release(scratch);
        }
        self.release(src);
        target
    }

    /// Adds a drop shadow under `src`, a layer that `closed` plans in closed
    /// form: `src` is the shape itself, and one pass composites it over its
    /// shadow, which is drawn where the shadow can be non-zero and not
    /// blurred. `src` goes back to the pool; the result is a new texture.
    fn box_shadow(&mut self, src: Tex, closed: &BoxShadow) -> Tex {
        // As `shadow`: a layer with nothing in it casts nothing.
        if src.bounds.is_empty() {
            return src;
        }
        let target = self.target(src.bounds.union(closed.extent().intersect(self.whole())));
        let params = floats(&closed.uniform());
        self.run_pass(&self.drop_box, src.input(), src.input(), &params, &target);
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
        if src.bounds.is_empty() {
            return src;
        }
        let spread = if inset { -shadow.spread } else { shadow.spread };
        // The shadow of a drop shadow is wherever it is non-zero. An inset
        // shadow is only seen inside the layer, where the shadow alpha is
        // read around the layer by the offset.
        let wanted = if inset {
            bounds::shadow_source(src.bounds, shadow.x, shadow.y)
        } else {
            self.whole()
        };
        let alpha = self.shadow_alpha(&src, spread, shadow.blur, inset, wanted);
        let alpha_bounds = alpha.as_ref().map_or(src.bounds, |t| t.bounds);
        let [r, g, b, a] = shadow.color.linear_premultiplied();
        let params = floats(&[
            0.0, 0.0, 0.0, 0.0, shadow.x, shadow.y, 0.0, 0.0, r as f32, g as f32, b as f32,
            a as f32,
        ]);
        // Outside the layer an inset shadow is nothing (it is multiplied by
        // the layer's alpha), and a drop shadow is the layer and its shadow.
        let region = if inset {
            src.bounds
        } else {
            src.bounds
                .union(bounds::shadow_cast(alpha_bounds, shadow.x, shadow.y))
        };
        let target = self.target(region);
        let pipeline = if inset {
            &self.inset_shadow
        } else {
            &self.drop_shadow
        };
        // With no spread, inversion or blur the shadow is just `src`'s alpha.
        let alpha_input = alpha.as_ref().map_or_else(|| src.input(), |t| t.input());
        self.run_pass(pipeline, src.input(), alpha_input, &params, &target);
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
    ///
    /// A texture that is not inverted is right everywhere, and its bounds
    /// are where it is non-zero. The inverted alpha is 1 all over the
    /// texture but where the layer is, so that one is only worked out in
    /// `wanted` (and what the passes before it must read to give that), which
    /// is also its bounds. `shadow_plan` says which box each pass draws.
    fn shadow_alpha(
        &mut self,
        src: &Tex,
        spread: f32,
        blur: f32,
        invert: bool,
        wanted: PixelRect,
    ) -> Option<Tex> {
        let size = (self.width, self.height);
        let plan = shadow_plan(size, src.bounds, spread, blur, invert, wanted);
        let mut current: Option<Tex> = None;
        if let Some(region) = plan.horizontal {
            let horizontal = self.target(region);
            self.spread_pass(src.input(), spread, [1.0, 0.0], false, &horizontal);
            current = Some(horizontal);
        }
        if let Some(region) = plan.vertical {
            let target = self.target(region);
            let input = current.as_ref().map_or_else(|| src.input(), |t| t.input());
            self.spread_pass(input, spread, [0.0, 1.0], invert, &target);
            if let Some(done) = current.replace(target) {
                self.release(done);
            }
        }
        if let Some((input, output)) = plan.blur {
            let target = self.target(output);
            let from = current.as_ref().map_or_else(|| src.input(), |t| t.input());
            self.blur.run(
                &self.device,
                self.pending
                    .get_mut()
                    .get_or_insert_with(|| self.device.create_command_encoder(&Default::default())),
                self.uniforms.get_mut(),
                from,
                target.input(),
                size,
                blur,
                input,
                target.bounds,
            );
            if let Some(done) = current.replace(target) {
                self.release(done);
            }
        }
        current
    }

    /// One axis of the spread filter (see `shaders/shadow.wgsl`).
    fn spread_pass(&self, input: Input, spread: f32, axis: [f32; 2], invert: bool, target: &Tex) {
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
        let readback = self.start_readback(image);
        self.finish_readback(readback)
    }

    /// `read_rgba8` up to the copy, which is submitted with everything
    /// recorded before it: the pixels are fetched by `finish_readback`, and
    /// the GPU can work on them while other passes are recorded.
    pub fn start_readback(&mut self, image: &Tex) -> Readback {
        let (canvas_width, canvas_height) = self.canvas;
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
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
        let target = Tex {
            view: texture.create_view(&wgpu::TextureViewDescriptor::default()),
            texture,
            origin: [0, 0],
            size: [self.width, self.height],
            bounds: self.whole(),
        };
        assert!(
            image.origin == [0, 0] && image.size == [self.width, self.height],
            "the image to read back is the size of the canvas"
        );
        self.pass(&self.encode, image.input(), image.input(), 0.0, 0, &target);

        let row_bytes = canvas_width * 4;
        let padded_row = row_bytes.next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: u64::from(padded_row) * u64::from(canvas_height),
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = self.encoder();
        // Only the canvas, which sits in the middle of the margin.
        let mut source = target.texture.as_image_copy();
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
        drop(encoder);
        let submission = self.submit();

        let (tx, rx) = std::sync::mpsc::channel();
        buffer.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        Readback {
            buffer,
            mapped: rx,
            submission,
            row_bytes,
            padded_row,
            height: canvas_height,
        }
    }

    /// Waits for the GPU to finish what `readback` needs (not anything
    /// submitted since) and returns its pixels.
    pub fn finish_readback(&self, readback: Readback) -> Result<Vec<u8>> {
        let Readback {
            buffer,
            mapped: rx,
            submission,
            row_bytes,
            padded_row,
            height: canvas_height,
        } = readback;
        self.device
            .poll(wgpu::PollType::Wait {
                submission_index: submission,
                timeout: None,
            })
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

    /// The `Place` uniform of a pass (`shaders/place.wgsl`).
    fn place_buffer(&self, target: &Tex, a: Input, b: Input) -> Block {
        self.uniform(&place_bytes(
            target.origin,
            (a.origin, a.size),
            (b.origin, b.size),
        ))
    }

    /// The bind group of a pass on the shared layout that draws into
    /// `target` with `a` and `b` as inputs and `params` as its uniforms.
    fn composite_bind_group(
        &self,
        a: Input,
        b: Input,
        params: &[u8],
        target: &Tex,
    ) -> wgpu::BindGroup {
        let uniform = self.uniform(params);
        let place = self.place_buffer(target, a, b);
        self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("composite"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(a.view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(b.view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: uniform.binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: place.binding(),
                },
            ],
        })
    }

    /// One full-screen pass over `target` with `a` and `b` as inputs. Only
    /// the target's bounds are drawn (see `draw_with`).
    fn pass(
        &self,
        pipeline: &wgpu::RenderPipeline,
        a: Input,
        b: Input,
        opacity: f32,
        mode: u32,
        target: &Tex,
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
        a: Input,
        b: Input,
        params: &[u8],
        target: &Tex,
    ) {
        self.run_pass_with(pipeline, a, b, params, None, target);
    }

    /// Like `run_pass`, with a second bind group (at group 1) for the passes
    /// that have one.
    fn run_pass_with(
        &self,
        pipeline: &wgpu::RenderPipeline,
        a: Input,
        b: Input,
        params: &[u8],
        extra: Option<&wgpu::BindGroup>,
        target: &Tex,
    ) {
        let uniform = self.uniform(params);
        let place = self.place_buffer(target, a, b);
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("composite"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(a.view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(b.view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: uniform.binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: place.binding(),
                },
            ],
        });
        self.draw_with(pipeline, &bind_group, extra, target);
    }

    /// Like `run_pass`, for a pipeline on `filtered_layout`: `input` is read
    /// through a bilinear sampler, so it and the target are the size of the
    /// canvas (see `full_copy`) and no placement is needed.
    fn run_filtered_pass(
        &self,
        pipeline: &wgpu::RenderPipeline,
        input: &wgpu::TextureView,
        params: &[u8],
        target: &Tex,
    ) {
        self.run_filtered_pass_with(pipeline, input, params, None, target);
    }

    /// Like `run_filtered_pass`, with a second bind group (at group 1) for
    /// the passes that have one.
    fn run_filtered_pass_with(
        &self,
        pipeline: &wgpu::RenderPipeline,
        input: &wgpu::TextureView,
        params: &[u8],
        extra: Option<&wgpu::BindGroup>,
        target: &Tex,
    ) {
        assert!(
            target.origin == [0, 0] && target.size == [self.width, self.height],
            "a filtered pass draws on a texture the size of the canvas"
        );
        let uniform = self.uniform(params);
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
                    resource: uniform.binding(),
                },
            ],
        });
        self.draw_with(pipeline, &bind_group, extra, target);
    }

    /// One full-screen triangle with `bind_group`, written over the bounds
    /// of `target`.
    fn draw(&self, pipeline: &wgpu::RenderPipeline, bind_group: &wgpu::BindGroup, target: &Tex) {
        self.draw_with(pipeline, bind_group, None, target);
    }

    /// Like `draw`, with `extra` set as bind group 1 when given.
    ///
    /// The whole of `target` is cleared first and then only its bounds are
    /// drawn, by a scissor rectangle: it keeps the pixels whose centres are
    /// inside it (`x0 <= x < x1`), so the first and last row and column of
    /// the box are drawn and the pixel just past them is not. What is not
    /// drawn is transparent, which is what the full pass writes outside the
    /// bounds. The box is in canvas pixels, and the scissor rectangle in
    /// texels of the target.
    fn draw_with(
        &self,
        pipeline: &wgpu::RenderPipeline,
        bind_group: &wgpu::BindGroup,
        extra: Option<&wgpu::BindGroup>,
        target: &Tex,
    ) {
        self.encode_draw_with(&mut self.encoder(), pipeline, bind_group, extra, target);
    }

    /// `draw`, recorded into `encoder` to be submitted with other work.
    fn encode_draw(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        pipeline: &wgpu::RenderPipeline,
        bind_group: &wgpu::BindGroup,
        target: &Tex,
    ) {
        self.encode_draw_with(encoder, pipeline, bind_group, None, target);
    }

    /// `draw_with`, recorded into `encoder`.
    fn encode_draw_with(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        pipeline: &wgpu::RenderPipeline,
        bind_group: &wgpu::BindGroup,
        extra: Option<&wgpu::BindGroup>,
        target: &Tex,
    ) {
        let region = target
            .bounds
            .translate(-target.origin[0], -target.origin[1])
            .intersect(PixelRect::new(
                0,
                0,
                target.size[0] as i32,
                target.size[1] as i32,
            ));
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("composite"),
            color_attachments: &[Some(clear_attachment(
                &target.view,
                wgpu::Color::TRANSPARENT,
            ))],
            ..Default::default()
        });
        if !region.is_empty() {
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, bind_group, &[]);
            if let Some(extra) = extra {
                pass.set_bind_group(1, extra, &[]);
            }
            pass.set_scissor_rect(
                region.x0 as u32,
                region.y0 as u32,
                region.width(),
                region.height(),
            );
            pass.draw(0..3, 0..1);
        }
    }
}

/// What the `Place` of `shaders/place.wgsl` holds: the canvas pixel of the
/// target's texel (0, 0), then the pixel and size of each of the two inputs
/// (`(origin, size)`), as little-endian `i32`s.
fn place_bytes(
    target_origin: [i32; 2],
    a: ([i32; 2], [u32; 2]),
    b: ([i32; 2], [u32; 2]),
) -> Vec<u8> {
    let vec4 = |(origin, size): ([i32; 2], [u32; 2])| {
        [origin[0], origin[1], size[0] as i32, size[1] as i32]
    };
    [[target_origin[0], target_origin[1], 0, 0], vec4(a), vec4(b)]
        .iter()
        .flatten()
        .flat_map(|v| v.to_le_bytes())
        .collect()
}

/// A colour attachment that is cleared to `color` and kept.
fn clear_attachment(
    view: &wgpu::TextureView,
    color: wgpu::Color,
) -> wgpu::RenderPassColorAttachment<'_> {
    wgpu::RenderPassColorAttachment {
        view,
        depth_slice: None,
        resolve_target: None,
        ops: wgpu::Operations {
            load: wgpu::LoadOp::Clear(color),
            store: wgpu::StoreOp::Store,
        },
    }
}

/// Copies the canvas pixels `region` of `from` over the same pixels of `to`,
/// both of which must hold them. Exact.
fn copy_box(encoder: &mut wgpu::CommandEncoder, from: &Tex, to: &Tex, region: PixelRect) {
    if region.is_empty() {
        return;
    }
    let at = |tex: &Tex| wgpu::Origin3d {
        x: (region.x0 - tex.origin[0]) as u32,
        y: (region.y0 - tex.origin[1]) as u32,
        z: 0,
    };
    let (mut source, mut destination) = (from.texture.as_image_copy(), to.texture.as_image_copy());
    source.origin = at(from);
    destination.origin = at(to);
    encoder.copy_texture_to_texture(
        source,
        destination,
        wgpu::Extent3d {
            width: region.width(),
            height: region.height(),
            depth_or_array_layers: 1,
        },
    );
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

/// The pipeline of one custom shader module (`shader::compose`).
fn shader_effect_pipeline(
    device: &wgpu::Device,
    layout: &wgpu::PipelineLayout,
    source: &str,
) -> wgpu::RenderPipeline {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("shader effect"),
        source: wgpu::ShaderSource::Wgsl(source.into()),
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("shader effect"),
        layout: Some(layout),
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
    })
}

/// The mesh gradient pipeline, drawing `mesh::Vertex` triangles into a
/// multisampled target, and the layout of the bind group (`mesh_size_group`)
/// that its vertex shader turns positions into clip space with. The output
/// is premultiplied, so triangles that overlap (a folded mesh) blend with
/// "over".
fn mesh_pipeline(
    device: &wgpu::Device,
    shader: &wgpu::ShaderModule,
) -> (wgpu::RenderPipeline, wgpu::BindGroupLayout) {
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("mesh"),
        entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::VERTEX,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        }],
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("mesh"),
        bind_group_layouts: &[Some(&layout)],
        immediate_size: 0,
    });
    let attributes = wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x4];
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("mesh"),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vs_mesh"),
            compilation_options: Default::default(),
            buffers: &[Some(wgpu::VertexBufferLayout {
                array_stride: MESH_VERTEX_BYTES,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &attributes,
            })],
        },
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some("fs_mesh"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: LINEAR_FORMAT,
                blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState {
            count: MESH_SAMPLES,
            mask: !0,
            alpha_to_coverage_enabled: false,
        },
        multiview_mask: None,
        cache: None,
    });
    (pipeline, layout)
}

/// The padded texture size as the mesh's vertex shader reads it.
fn mesh_size_group(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    size: (u32, u32),
) -> wgpu::BindGroup {
    let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("mesh size"),
        contents: &floats(&[size.0 as f32, size.1 as f32, 0.0, 0.0]),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("mesh"),
        layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: uniform.as_entire_binding(),
        }],
    })
}

/// The bytes of one `mesh::Vertex`: position, then colour, as `f32`s.
const MESH_VERTEX_BYTES: u64 = 24;

fn mesh_vertex_bytes(vertices: &[mesh::Vertex]) -> Vec<u8> {
    let flat: Vec<f32> = vertices
        .iter()
        .flat_map(|v| [v.position[0], v.position[1]].into_iter().chain(v.color))
        .collect();
    floats(&flat)
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
/// (read with `textureLoad`, so not filterable), one uniform block and the
/// placement.
fn lut_bind_group_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
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
            uniform(2),
            uniform(3),
        ],
    })
}

/// The bind group of a pass that evaluates turbulence, at group 1: one
/// seed's tables as a read-only storage buffer (`turbulence::Tables`).
fn turbulence_bind_group_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("turbulence"),
        entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only: true },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        }],
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

/// The source of a built-in pass as the compositor compiles it. Passes that
/// call `hash` or `cell_hash` get `shaders/hash.wgsl` put in front of their
/// source, those that call `turbulence_value` get `shaders/turbulence.wgsl`,
/// and those that place their textures on the canvas (`canvas_xy`,
/// `canvas_pos` or `load_a`) get `shaders/place.wgsl`.
pub(crate) fn shader_source(source: &str) -> String {
    let mut full = String::new();
    if source.contains("hash(") {
        full.push_str(include_str!("shaders/hash.wgsl"));
    }
    if source.contains("turbulence_value(") {
        full.push_str(include_str!("shaders/turbulence.wgsl"));
    }
    if ["canvas_xy(", "canvas_pos(", "load_a("]
        .iter()
        .any(|name| source.contains(name))
    {
        full.push_str(include_str!("shaders/place.wgsl"));
    }
    full.push_str(source);
    full
}

fn shader_module(device: &wgpu::Device, label: &str, source: &str) -> wgpu::ShaderModule {
    device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(label),
        source: wgpu::ShaderSource::Wgsl(shader_source(source).into()),
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

/// A linear texture of any size that can be drawn to, read and copied, with
/// empty bounds.
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
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    Tex {
        texture,
        view,
        origin: [0, 0],
        size: [width, height],
        bounds: PixelRect::EMPTY,
    }
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

/// The inverse of a warp's homography as `shaders/warp.wgsl` reads it: its
/// three rows, each padded to four floats.
fn warp_values(inverse: DMat3) -> [f32; 12] {
    let mut values = [0.0; 12];
    for (i, row) in [inverse.row(0), inverse.row(1), inverse.row(2)]
        .into_iter()
        .enumerate()
    {
        values[i * 4] = row.x as f32;
        values[i * 4 + 1] = row.y as f32;
        values[i * 4 + 2] = row.z as f32;
    }
    values
}

/// A displacement as `shaders/displace.wgsl` reads it: the inverse of the
/// layer matrix (linear part, then translation), the scale and the margin, the
/// matrix's linear part, the base frequency, then the octaves, the two
/// channels and whether the noise is fractal, as u32s. A matrix that cannot be
/// inverted has nothing to draw, so its inverse is zeros.
///
/// `layer_matrix` takes the layer to the padded textures; the shader wants it
/// to the canvas, so the margin is taken out of it here and passed on its own,
/// which keeps every number but the margin the same at any margin.
fn displace_values(displace: &ResolvedDisplace, layer_matrix: Affine, margin: u32) -> Vec<u8> {
    let layer_matrix = Affine::translate((-f64::from(margin), -f64::from(margin))) * layer_matrix;
    let m = layer_matrix.as_coeffs();
    let inverse = if layer_matrix.determinant().abs() > f64::EPSILON {
        layer_matrix.inverse().as_coeffs()
    } else {
        [0.0; 6]
    };
    let t = &displace.turbulence;
    let mut bytes = floats(&[
        inverse[0] as f32,
        inverse[1] as f32,
        inverse[2] as f32,
        inverse[3] as f32,
        inverse[4] as f32,
        inverse[5] as f32,
        displace.scale,
        margin as f32,
        m[0] as f32,
        m[1] as f32,
        m[2] as f32,
        m[3] as f32,
        t.frequency[0],
        t.frequency[1],
        0.0,
        0.0,
    ]);
    bytes.extend(
        [
            t.octaves,
            displace.x_channel.index(),
            displace.y_channel.index(),
            u32::from(t.fractal),
        ]
        .iter()
        .flat_map(|v| v.to_le_bytes()),
    );
    bytes
}

/// A noise layer as `shaders/noise.wgsl` reads it: the inverse of the layer
/// matrix (linear part, then translation), the base frequency, then the
/// octaves, whether the noise is fractal and whether it is gray, as u32s. A
/// matrix that cannot be inverted has nothing to draw, so its inverse is zeros.
fn noise_values(
    turbulence: &ResolvedTurbulence,
    channels: NoiseChannels,
    layer_matrix: Affine,
) -> Vec<u8> {
    let inverse = if layer_matrix.determinant().abs() > f64::EPSILON {
        layer_matrix.inverse().as_coeffs()
    } else {
        [0.0; 6]
    };
    let mut bytes = floats(&[
        inverse[0] as f32,
        inverse[1] as f32,
        inverse[2] as f32,
        inverse[3] as f32,
        inverse[4] as f32,
        inverse[5] as f32,
        0.0,
        0.0,
        turbulence.frequency[0],
        turbulence.frequency[1],
        0.0,
        0.0,
    ]);
    bytes.extend(
        [
            turbulence.octaves,
            u32::from(turbulence.fractal),
            u32::from(channels == NoiseChannels::Gray),
            0,
        ]
        .iter()
        .flat_map(|v| v.to_le_bytes()),
    );
    bytes
}

/// A dot matrix as `shaders/dot_matrix.wgsl` reads it: the inverse of the
/// layer matrix (linear part, then translation), the cell size, progress,
/// stagger, shape and order, the sweep (direction, start and 1 / extent), then
/// the seed as a u32.
fn dot_matrix_values(
    dots: &ResolvedDotMatrix,
    layer_matrix: Affine,
    layer_box: Option<Rect>,
) -> Vec<u8> {
    let inverse = if layer_matrix.determinant().abs() > f64::EPSILON {
        layer_matrix.inverse().as_coeffs()
    } else {
        [0.0; 6]
    };
    let sweep = sweep_axis(layer_box, f64::from(dots.angle));
    let shape = match dots.shape {
        DotShape::Circle => 0.0,
        DotShape::Square => 1.0,
    };
    let order = match dots.order {
        DotOrder::Random => 0.0,
        DotOrder::Sweep => 1.0,
    };
    let mut bytes = floats(&[
        inverse[0] as f32,
        inverse[1] as f32,
        inverse[2] as f32,
        inverse[3] as f32,
        inverse[4] as f32,
        inverse[5] as f32,
        dots.size,
        0.0,
        dots.progress,
        dots.stagger,
        shape,
        order,
        sweep[0],
        sweep[1],
        sweep[2],
        sweep[3],
    ]);
    bytes.extend([dots.seed, 0, 0, 0].iter().flat_map(|v| v.to_le_bytes()));
    bytes
}

/// What a sweep along `angle` degrees (clockwise from +x, 0 is left to right)
/// needs to turn a cell's position into 0..1 across `bounds`: the direction's
/// cosine and sine, the nearest box corner's distance along it, and 1 over the
/// box's extent along it. No box, or one with no extent along the direction,
/// gives an inverse extent of 0, so every cell starts at once.
fn sweep_axis(bounds: Option<Rect>, angle: f64) -> [f32; 4] {
    let (sin, cos) = angle.to_radians().sin_cos();
    let Some(b) = bounds else {
        return [cos as f32, sin as f32, 0.0, 0.0];
    };
    let along =
        [(b.x0, b.y0), (b.x1, b.y0), (b.x0, b.y1), (b.x1, b.y1)].map(|(x, y)| x * cos + y * sin);
    let near = along.into_iter().fold(f64::INFINITY, f64::min);
    let far = along.into_iter().fold(f64::NEG_INFINITY, f64::max);
    let extent = far - near;
    [
        cos as f32,
        sin as f32,
        near as f32,
        if extent > 1e-9 {
            (1.0 / extent) as f32
        } else {
            0.0
        },
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

/// The first of the non-separable blend modes (hue, saturation, color,
/// luminosity), whose `blend_fn` divides by quantities that are zero for
/// some inputs: see `Compositor::blend`.
const FIRST_NON_SEPARABLE_MODE: u32 = 12;

/// The boxes that the passes of `Compositor::shadow_alpha` draw, in order:
/// the spread along x, the spread along y (which also inverts), and the blur
/// with the box its input can be non-zero in and the box it draws. A pass
/// that does not run is `None`.
#[derive(Debug, PartialEq)]
struct ShadowPlan {
    horizontal: Option<PixelRect>,
    vertical: Option<PixelRect>,
    blur: Option<(PixelRect, PixelRect)>,
}

/// Which box each pass of a shadow's alpha draws, for a layer that is
/// transparent outside `src`, and, if `invert`, the pixels `wanted` of the
/// result (see `Compositor::shadow_alpha`).
///
/// Not inverted, the alpha is zero where the layer is far away, so each pass
/// draws the box its input is non-zero in, grown by what it reads when it
/// spreads outwards (a pass that shrinks, or the blur, is non-zero where its
/// input is or by the blur's reach). Inverted it is 1 far from the layer, so
/// the passes are worked out backwards from `wanted`: the blur draws it, the
/// pass before draws what the blur reads of it (`Blur::source_for`), and the
/// one before that what that reads of its input, a spread either side along
/// its axis more.
fn shadow_plan(
    size: (u32, u32),
    src: PixelRect,
    spread: f32,
    blur: f32,
    invert: bool,
    wanted: PixelRect,
) -> ShadowPlan {
    let whole = PixelRect::whole(size.0, size.1);
    let blurred = blur >= blur::MIN_RADIUS;
    // How many pixels either side a spread pass reads along its axis.
    let reach = spread.abs().ceil() as i32;
    let needed = match (invert, blurred) {
        (false, _) => PixelRect::EMPTY,
        (true, true) => Blur::source_for(size, blur, wanted),
        (true, false) => wanted,
    }
    .intersect(whole);
    let horizontal = (spread != 0.0).then(|| {
        match (invert, spread > 0.0) {
            (true, _) => needed.grow(0, reach),
            (false, true) => src.grow(reach, 0),
            (false, false) => src,
        }
        .intersect(whole)
    });
    let from_horizontal = horizontal.unwrap_or(src);
    let vertical = (spread != 0.0 || invert).then(|| {
        match (invert, spread > 0.0) {
            (true, _) => needed,
            (false, true) => from_horizontal.grow(0, reach),
            (false, false) => from_horizontal,
        }
        .intersect(whole)
    });
    let from_vertical = vertical.unwrap_or(from_horizontal);
    let blur = blurred.then(|| {
        if invert {
            // The inverted alpha is non-zero everywhere.
            (whole, wanted.intersect(whole))
        } else {
            (from_vertical, Blur::reach(size, blur, from_vertical))
        }
    });
    ShadowPlan {
        horizontal,
        vertical,
        blur,
    }
}

/// The pixels a mesh's `vertices` can touch: their box, and a pixel more
/// for the multisampled edge. All of the texture if a position is not a
/// number.
fn mesh_bounds(vertices: &[mesh::Vertex]) -> PixelRect {
    let mut corners: Option<Rect> = None;
    for v in vertices {
        let p = vello::kurbo::Point::new(f64::from(v.position[0]), f64::from(v.position[1]));
        corners = Some(match corners {
            Some(r) => r.union_pt(p),
            None => Rect::from_points(p, p),
        });
    }
    let Some(corners) = corners else {
        return PixelRect::EMPTY;
    };
    bounds::pixel_rect(corners.inflate(1.0, 1.0)).unwrap_or(PixelRect::new(
        i32::MIN / 4,
        i32::MIN / 4,
        i32::MAX / 4,
        i32::MAX / 4,
    ))
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
    use crate::blur::tests::{Axis, blur_axis};
    use crate::color::Color;
    use crate::hash::{cell_hash, unit_float};

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

    fn dots(order: DotOrder, shape: DotShape) -> ResolvedDotMatrix {
        ResolvedDotMatrix {
            size: 12.0,
            progress: 0.5,
            order,
            angle: 0.0,
            stagger: 0.6,
            seed: 41,
            shape,
        }
    }

    #[test]
    fn displace_values_carry_the_matrix_the_noise_and_the_channels() {
        use crate::resolve::ResolvedTurbulence;
        use crate::scene::Channel;
        use vello::kurbo::Point;

        let displace = ResolvedDisplace {
            scale: 12.0,
            x_channel: Channel::B,
            y_channel: Channel::A,
            turbulence: ResolvedTurbulence {
                fractal: true,
                frequency: [0.04, 0.5],
                octaves: 4,
                seed: 7,
            },
        };
        // The layer's matrix on the canvas, and in the textures with a margin.
        let matrix = Affine::translate((10.0, 20.0)) * Affine::rotate(0.5) * Affine::scale(2.0);
        let padded = Affine::translate((6.0, 6.0)) * matrix;
        let bytes = displace_values(&displace, padded, 6);
        assert_eq!(bytes.len(), 80);
        let float = |i: usize| f32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap());
        let word = |i: usize| u32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap());
        assert_eq!([6, 7].map(float), [12.0, 6.0]);
        assert_eq!([12, 13].map(float), [0.04, 0.5]);
        // Octaves, the two channels, fractalNoise.
        assert_eq!([16, 17, 18, 19].map(word), [4, 2, 3, 1]);

        // The shader's two mappings, written out: a canvas pixel to the layer
        // by the inverse, and a displacement in layer space to pixels by the
        // linear part. Together they take the pixel to where the matrix puts
        // the displaced layer point.
        let pixel = Point::new(123.5, 77.5);
        let layer = Point::new(
            f64::from(float(0)) * pixel.x + f64::from(float(2)) * pixel.y + f64::from(float(4)),
            f64::from(float(1)) * pixel.x + f64::from(float(3)) * pixel.y + f64::from(float(5)),
        );
        let want = matrix.inverse() * pixel;
        assert!((layer.x - want.x).abs() < 1e-4 && (layer.y - want.y).abs() < 1e-4);
        let shift = (3.0_f64, -1.5_f64);
        let texel = Point::new(
            pixel.x + f64::from(float(8)) * shift.0 + f64::from(float(10)) * shift.1,
            pixel.y + f64::from(float(9)) * shift.0 + f64::from(float(11)) * shift.1,
        );
        let want = matrix * (matrix.inverse() * pixel + vello::kurbo::Vec2::new(shift.0, shift.1));
        assert!((texel.x - want.x).abs() < 1e-4 && (texel.y - want.y).abs() < 1e-4);

        // Turbulence type, and a layer scaled to nothing has no inverse.
        let plain = ResolvedDisplace {
            turbulence: ResolvedTurbulence {
                fractal: false,
                ..displace.turbulence
            },
            ..displace
        };
        assert_eq!(word(19), 1);
        let flat = displace_values(&plain, Affine::scale(0.0), 0);
        assert!(flat[..24].iter().all(|b| *b == 0));
        assert_eq!(u32::from_le_bytes(flat[76..80].try_into().unwrap()), 0);
    }

    #[test]
    fn displace_values_are_the_same_at_any_margin_but_the_margin() {
        use crate::resolve::ResolvedTurbulence;
        use crate::scene::Channel;

        let displace = ResolvedDisplace {
            scale: 9.0,
            x_channel: Channel::R,
            y_channel: Channel::G,
            turbulence: ResolvedTurbulence {
                fractal: false,
                frequency: [0.013, 0.021],
                octaves: 2,
                seed: 3,
            },
        };
        // A layer matrix whose translation is not a whole number.
        let matrix = Affine::translate((100.3, 41.7)) * Affine::rotate(0.2) * Affine::scale(1.5);
        let at = |margin: u32| {
            let m = f64::from(margin);
            displace_values(&displace, Affine::translate((m, m)) * matrix, margin)
        };
        let (a, b) = (at(43), at(44));
        assert_eq!(a.len(), b.len());
        // Only the margin, the fourth float of the second vec4, differs.
        let differing: Vec<usize> = (0..a.len()).filter(|&i| a[i] != b[i]).collect();
        assert!(!differing.is_empty());
        assert!(
            differing.iter().all(|i| (28..32).contains(i)),
            "{differing:?}"
        );
        assert_eq!(f32::from_le_bytes(a[28..32].try_into().unwrap()), 43.0);
    }

    #[test]
    fn mesh_vertices_are_position_then_colour() {
        let vertices = [
            mesh::Vertex {
                position: [1.0, 2.0],
                color: [0.1, 0.2, 0.3, 0.4],
            },
            mesh::Vertex {
                position: [5.0, 6.0],
                color: [0.5, 0.6, 0.7, 0.8],
            },
        ];
        let bytes = mesh_vertex_bytes(&vertices);
        assert_eq!(bytes.len() as u64, 2 * MESH_VERTEX_BYTES);
        let float = |i: usize| f32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap());
        assert_eq!(
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(float),
            [1.0, 2.0, 0.1, 0.2, 0.3, 0.4, 5.0, 6.0, 0.5, 0.6, 0.7, 0.8]
        );
    }

    #[test]
    fn noise_values_carry_the_inverse_the_frequency_and_the_options() {
        use crate::resolve::ResolvedTurbulence;

        let turbulence = ResolvedTurbulence {
            fractal: false,
            frequency: [0.25, 0.5],
            octaves: 3,
            seed: 7,
        };
        let matrix = Affine::translate((10.0, 20.0)) * Affine::scale(2.0);
        let bytes = noise_values(&turbulence, NoiseChannels::Gray, matrix);
        assert_eq!(bytes.len(), 64);
        let float = |i: usize| f32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap());
        let word = |i: usize| u32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap());
        // The inverse (linear part, then translation): x / 2 - 5.
        assert_eq!(
            [0, 1, 2, 3, 4, 5].map(float),
            [0.5, 0.0, 0.0, 0.5, -5.0, -10.0]
        );
        assert_eq!([8, 9].map(float), [0.25, 0.5]);
        // Octaves, not fractal, gray.
        assert_eq!([12, 13, 14].map(word), [3, 0, 1]);
        let rgba = noise_values(
            &ResolvedTurbulence {
                fractal: true,
                ..turbulence
            },
            NoiseChannels::Rgba,
            matrix,
        );
        assert_eq!(u32::from_le_bytes(rgba[52..56].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(rgba[56..60].try_into().unwrap()), 0);
        // Nothing to invert for a layer scaled to nothing.
        let flat = noise_values(&turbulence, NoiseChannels::Rgba, Affine::scale(0.0));
        assert!(flat[..24].iter().all(|b| *b == 0));
    }

    #[test]
    fn dot_matrix_values_carry_the_matrix_the_sweep_and_the_seed() {
        let matrix = Affine::translate((10.0, 20.0)) * Affine::scale(2.0);
        let bounds = Some(Rect::new(0.0, 0.0, 100.0, 50.0));
        let bytes = dot_matrix_values(&dots(DotOrder::Sweep, DotShape::Square), matrix, bounds);
        assert_eq!(bytes.len(), 80);
        let float = |i: usize| f32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap());
        // The inverse (linear part, then translation): x / 2 - 5.
        assert_eq!(
            [0, 1, 2, 3, 4, 5].map(float),
            [0.5, 0.0, 0.0, 0.5, -5.0, -10.0]
        );
        // Size, progress, stagger, square, sweep.
        assert_eq!([6, 8, 9, 10, 11].map(float), [12.0, 0.5, 0.6, 1.0, 1.0]);
        // A left-to-right sweep over a box 100 wide.
        assert_eq!([12, 13, 14, 15].map(float), [1.0, 0.0, 0.0, 0.01]);
        assert_eq!(u32::from_le_bytes(bytes[64..68].try_into().unwrap()), 41);
        let random = dot_matrix_values(&dots(DotOrder::Random, DotShape::Circle), matrix, None);
        let float = |i: usize| f32::from_le_bytes(random[i * 4..i * 4 + 4].try_into().unwrap());
        assert_eq!([10, 11].map(float), [0.0, 0.0]);
        // Nothing to invert for a layer scaled to nothing.
        let flat = dot_matrix_values(
            &dots(DotOrder::Random, DotShape::Circle),
            Affine::scale(0.0),
            None,
        );
        assert!(flat[..24].iter().all(|b| *b == 0));
    }

    #[test]
    fn a_sweep_runs_from_the_nearest_corner_to_the_farthest() {
        let near = |got: [f32; 4], want: [f32; 4]| {
            assert!(
                got.iter().zip(want).all(|(a, b)| (a - b).abs() < 1e-6),
                "{got:?} {want:?}"
            );
        };
        let b = Some(Rect::new(10.0, 20.0, 110.0, 70.0));
        // Left to right: from x = 10 over 100.
        near(sweep_axis(b, 0.0), [1.0, 0.0, 10.0, 0.01]);
        // Top to bottom (90 degrees clockwise): from y = 20 over 50.
        near(sweep_axis(b, 90.0), [0.0, 1.0, 20.0, 0.02]);
        // Right to left starts at the right edge: along -x that is -110.
        near(sweep_axis(b, 180.0), [-1.0, 0.0, -110.0, 0.01]);
        // The diagonal: the extent is (width + height) / sqrt 2.
        let diagonal = sweep_axis(b, 45.0);
        let h = std::f32::consts::FRAC_1_SQRT_2;
        near(diagonal, [h, h, (10.0 + 20.0) * h, 1.0 / (150.0 * h)]);
        // No box, or a box with no extent along the sweep: every cell at once.
        assert_eq!(sweep_axis(None, 0.0)[3], 0.0);
        assert_eq!(
            sweep_axis(Some(Rect::new(5.0, 5.0, 5.0, 40.0)), 0.0)[3],
            0.0
        );
    }

    /// The `grown` of shaders/dot_matrix.wgsl.
    fn grown(progress: f32, delay: f32, stagger: f32) -> f32 {
        ((progress - delay) / (1.0 - stagger)).clamp(0.0, 1.0)
    }

    /// The delay of a random cell in shaders/dot_matrix.wgsl.
    fn random_delay(seed: u32, ix: i32, iy: i32, stagger: f32) -> f32 {
        stagger * unit_float(cell_hash(seed, ix as u32, iy as u32, 0))
    }

    /// The coverage at `(x, y)` from the centre of a unit cell, as
    /// `fs_dot_matrix` works it out for a pixel `aa` of a cell wide.
    fn dot_coverage(shape: DotShape, grown: f64, aa: f64, x: f64, y: f64) -> f64 {
        match shape {
            DotShape::Circle => coverage(x.hypot(y), grown * (0.5 * 2.0_f64.sqrt() + 0.5 * aa), aa),
            DotShape::Square => coverage(x.abs().max(y.abs()), grown * (0.5 + 0.5 * aa), aa),
        }
    }

    #[test]
    fn every_cell_is_empty_at_progress_0_and_solid_at_progress_1() {
        let stagger = 0.6;
        // Random delays over a patch of cells, including negative cell
        // indices, where content above or left of the layer's origin lives.
        let delays: Vec<f32> = (-20..20)
            .flat_map(|j| (-20..20).map(move |i| random_delay(1, i, j, stagger)))
            .collect();
        assert!(delays.iter().all(|d| (0.0..stagger).contains(d)));
        // They are spread over the whole range, not bunched.
        let (min, max) = delays
            .iter()
            .fold((1.0_f32, 0.0_f32), |(a, b), d| (a.min(*d), b.max(*d)));
        assert!(min < 0.03 && max > stagger - 0.03, "{min} {max}");
        for d in delays.iter().copied().chain([0.0, stagger]) {
            // The last delay possible is still fully grown at progress 1,
            // and the first cell has not started at progress 0.
            assert_eq!(grown(1.0, d, stagger), 1.0);
            assert_eq!(grown(0.0, d, stagger), 0.0);
            // A cell does not start before its delay and is done after its
            // growth time.
            assert_eq!(grown(d, d, stagger), 0.0);
            assert!(grown(d + (1.0 - stagger), d, stagger) > 0.9999);
        }
        for shape in [DotShape::Circle, DotShape::Square] {
            for i in 0..=40 {
                for j in 0..=40 {
                    let (x, y) = (f64::from(i) / 40.0 - 0.5, f64::from(j) / 40.0 - 0.5);
                    assert_eq!(
                        dot_coverage(shape, 1.0, 0.01, x, y),
                        1.0,
                        "{shape:?} {x} {y}"
                    );
                    assert_eq!(
                        dot_coverage(shape, 0.0, 0.01, x, y),
                        0.0,
                        "{shape:?} {x} {y}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_random_reveal_follows_the_seed_and_a_sweep_runs_along_its_angle() {
        let pattern = |seed| -> Vec<f32> {
            (0..64)
                .map(|i| random_delay(seed, i % 8, i / 8, 0.6))
                .collect()
        };
        assert_eq!(pattern(1), pattern(1));
        assert_ne!(pattern(1), pattern(2));
        // A sweep at 90 degrees: delay grows with the cell's y, and does not
        // depend on x. 10 cells of 10 px over a box 100 px tall.
        let [dx, dy, p0, inv] = sweep_axis(Some(Rect::new(0.0, 0.0, 100.0, 100.0)), 90.0);
        let delay = |cx: f32, cy: f32| 0.6 * ((cx * dx + cy * dy - p0) * inv).clamp(0.0, 1.0);
        let column: Vec<f32> = (0..10).map(|j| delay(5.0, 5.0 + 10.0 * j as f32)).collect();
        assert!(column.windows(2).all(|w| w[1] > w[0]), "{column:?}");
        assert_eq!(delay(5.0, 5.0), delay(95.0, 5.0));
        // Cell centres sit half a cell in from the box, so a sweep over
        // exactly the box never reaches delay 0 or the stagger itself.
        assert!(column[0] > 0.0 && column[9] < 0.6);
        // A cell off the box (a layer that hangs over) is clamped.
        assert_eq!(delay(5.0, -50.0), 0.0);
        assert!((delay(5.0, 500.0) - 0.6).abs() < 1e-6);
        let wgsl = include_str!("shaders/dot_matrix.wgsl");
        for want in [
            "clamp((params.options.x - delay) / (1.0 - params.options.y), 0.0, 1.0)",
            "unit_float(cell_hash(params.seed.x, bitcast<u32>(i32(cell.x)), bitcast<u32>(i32(cell.y)), 0u))",
            "clamp((along - params.sweep.z) * params.sweep.w, 0.0, 1.0)",
            "grown * (0.5 * size * sqrt(2.0) + 0.5 * aa)",
            "grown * (0.5 * size + 0.5 * aa)",
        ] {
            assert!(wgsl.contains(want), "dot_matrix.wgsl lacks {want}");
        }
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

    #[test]
    fn warp_values_are_the_rows_of_the_inverse() {
        let inverse = DMat3::from_cols_array(&[
            1.0, 4.0, 7.0, //
            2.0, 5.0, 8.0, //
            3.0, 6.0, 9.0,
        ]);
        // The columns (1 4 7), (2 5 8), (3 6 9) make the rows (1 2 3), (4 5 6), (7 8 9).
        assert_eq!(
            warp_values(inverse),
            [
                1.0, 2.0, 3.0, 0.0, //
                4.0, 5.0, 6.0, 0.0, //
                7.0, 8.0, 9.0, 0.0,
            ]
        );
    }

    // The alpha chain of a shadow in one dimension: the spread along x, the
    // spread along y with the inversion, and the blur, each as its shader
    // works it out (the pass along the other axis leaves a row alone), and
    // drawing only where `ShadowPlan` says.

    /// `fs_spread` along the row; what is outside it is transparent.
    fn spread_row(a: &[f64], spread: f32, drawn: &dyn Fn(usize) -> bool) -> Vec<f64> {
        let grow = spread > 0.0;
        let radius = f64::from(spread.abs());
        let whole = radius.floor() as i64;
        let at = |i: i64| {
            if i < 0 || i >= a.len() as i64 {
                0.0
            } else {
                a[i as usize]
            }
        };
        let extreme = |x: f64, y: f64| if grow { x.max(y) } else { x.min(y) };
        (0..a.len())
            .map(|x| {
                if !drawn(x) {
                    return 0.0;
                }
                let x = x as i64;
                let mut v = at(x);
                for i in 1..=whole {
                    v = extreme(v, extreme(at(x + i), at(x - i)));
                }
                let part = radius - whole as f64;
                if part > 0.0 {
                    let next = extreme(at(x + whole + 1), at(x - whole - 1));
                    v = v * (1.0 - part) + extreme(v, next) * part;
                }
                v
            })
            .collect()
    }

    fn keep(a: &[f64], drawn: &dyn Fn(usize) -> bool) -> Vec<f64> {
        a.iter()
            .enumerate()
            .map(|(i, v)| if drawn(i) { *v } else { 0.0 })
            .collect()
    }

    #[allow(clippy::too_many_arguments)]
    fn shadow_row(
        size: (u32, u32),
        src: &[f64],
        axis: Axis,
        spread: f32,
        blur: f32,
        invert: bool,
        plan: Option<&ShadowPlan>,
    ) -> Vec<f64> {
        let span = |r: PixelRect| match axis {
            Axis::X => (r.x0, r.x1),
            Axis::Y => (r.y0, r.y1),
        };
        let inside = |r: Option<PixelRect>| {
            move |t: usize| {
                r.is_none_or(|r| {
                    let (lo, hi) = span(r);
                    (t as i32) >= lo && (t as i32) < hi
                })
            }
        };
        let mut v = src.to_vec();
        let pick = |f: fn(&ShadowPlan) -> Option<PixelRect>| plan.and_then(f);
        if spread != 0.0 {
            let drawn = inside(pick(|p| p.horizontal));
            v = match axis {
                Axis::X => spread_row(&v, spread, &drawn),
                Axis::Y => keep(&v, &drawn),
            };
        }
        if spread != 0.0 || invert {
            let drawn = inside(pick(|p| p.vertical));
            v = match axis {
                Axis::X => keep(&v, &drawn),
                Axis::Y => spread_row(&v, spread, &drawn),
            };
            if invert {
                for (t, x) in v.iter_mut().enumerate() {
                    if drawn(t) {
                        *x = 1.0 - *x;
                    }
                }
            }
        }
        if blur >= blur::MIN_RADIUS {
            let (input, output) = plan
                .and_then(|p| p.blur)
                .unwrap_or((PixelRect::EMPTY, PixelRect::EMPTY));
            v = blur_axis(size, blur, &v, axis, input, output, plan.is_some());
        }
        v
    }

    #[test]
    fn a_shadows_alpha_drawn_in_its_boxes_is_the_full_alpha_where_it_is_read() {
        let size = (53u32, 47u32);
        let whole = PixelRect::whole(size.0, size.1);
        let src_box = PixelRect::new(20, 15, 31, 30);
        let mut cases = 0;
        for spread in [0.0_f32, 2.5, -3.0, 7.0, 1.0, -0.5] {
            for blur in [0.0_f32, 0.5, 6.0, 20.0] {
                for invert in [false, true] {
                    for wanted in [
                        whole,
                        PixelRect::new(18, 10, 36, 24),
                        PixelRect::new(0, 0, 5, 5),
                        PixelRect::new(45, 40, 53, 47),
                        PixelRect::new(30, 29, 31, 30),
                    ] {
                        if !invert && wanted != whole {
                            continue;
                        }
                        let plan = shadow_plan(size, src_box, spread, blur, invert, wanted);
                        for axis in [Axis::X, Axis::Y] {
                            let (len, lo, hi, wlo, whi) = match axis {
                                Axis::X => (53, src_box.x0, src_box.x1, wanted.x0, wanted.x1),
                                Axis::Y => (47, src_box.y0, src_box.y1, wanted.y0, wanted.y1),
                            };
                            let src: Vec<f64> = (0..len)
                                .map(|i| {
                                    if (lo..hi).contains(&i) {
                                        0.3 + 0.07 * f64::from((i * 7 % 11) as u32)
                                    } else {
                                        0.0
                                    }
                                })
                                .collect();
                            let full = shadow_row(size, &src, axis, spread, blur, invert, None);
                            let drawn =
                                shadow_row(size, &src, axis, spread, blur, invert, Some(&plan));
                            let case = format!(
                                "spread {spread}, blur {blur}, invert {invert}, wanted {wanted:?}, {axis:?}"
                            );
                            for t in wlo.max(0)..whi.min(len) {
                                let t = t as usize;
                                assert_eq!(full[t], drawn[t], "{case}: pixel {t}");
                            }
                            cases += 1;
                        }
                    }
                }
            }
        }
        assert_eq!(cases, 2 * (6 * 4 * (1 + 5)));
    }

    #[test]
    fn a_shadows_alpha_is_zero_outside_the_box_the_last_pass_draws() {
        let size = (53u32, 47u32);
        let src_box = PixelRect::new(20, 15, 31, 30);
        for spread in [0.0_f32, 2.5, -3.0, 7.0] {
            for blur in [0.0_f32, 6.0, 20.0] {
                if spread == 0.0 && blur == 0.0 {
                    continue;
                }
                let plan =
                    shadow_plan(size, src_box, spread, blur, false, PixelRect::whole(53, 47));
                // The box of the texture the plan ends with.
                let last = match (plan.blur, plan.vertical) {
                    (Some((_, output)), _) => output,
                    (None, Some(vertical)) => vertical,
                    (None, None) => unreachable!(),
                };
                for axis in [Axis::X, Axis::Y] {
                    let (len, lo, hi, a, b) = match axis {
                        Axis::X => (53, src_box.x0, src_box.x1, last.x0, last.x1),
                        Axis::Y => (47, src_box.y0, src_box.y1, last.y0, last.y1),
                    };
                    let src: Vec<f64> = (0..len)
                        .map(|i| if (lo..hi).contains(&i) { 1.0 } else { 0.0 })
                        .collect();
                    let full = shadow_row(size, &src, axis, spread, blur, false, None);
                    for (t, v) in full.iter().enumerate() {
                        if (t as i32) < a || (t as i32) >= b {
                            assert_eq!(*v, 0.0, "spread {spread}, blur {blur}, {axis:?}: {t}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn a_shadow_plan_skips_the_passes_that_would_change_nothing() {
        let size = (100u32, 80u32);
        let src = PixelRect::new(10, 10, 30, 30);
        let whole = PixelRect::whole(100, 80);
        let none = shadow_plan(size, src, 0.0, 0.0, false, whole);
        assert_eq!(
            none,
            ShadowPlan {
                horizontal: None,
                vertical: None,
                blur: None
            }
        );
        // Growing by 2.5 reaches 3 pixels along each axis in turn.
        let grown = shadow_plan(size, src, 2.5, 0.0, false, whole);
        assert_eq!(grown.horizontal, Some(PixelRect::new(7, 10, 33, 30)));
        assert_eq!(grown.vertical, Some(PixelRect::new(7, 7, 33, 33)));
        assert_eq!(grown.blur, None);
        // Shrinking stays inside the layer.
        let shrunk = shadow_plan(size, src, -2.5, 0.0, false, whole);
        assert_eq!(shrunk.horizontal, Some(src));
        assert_eq!(shrunk.vertical, Some(src));
        // The inverted alpha with nothing else is a pass over what is wanted.
        let want = PixelRect::new(5, 5, 20, 20);
        let inverted = shadow_plan(size, src, 0.0, 0.0, true, want);
        assert_eq!(inverted.horizontal, None);
        assert_eq!(inverted.vertical, Some(want));
        assert_eq!(inverted.blur, None);
        // And with a blur the pass before it draws what the blur reads, which
        // is more than is wanted, and the blur's input is everywhere.
        let blurred = shadow_plan(size, src, 0.0, 6.0, true, want);
        let (input, output) = blurred.blur.unwrap();
        assert_eq!((input, output), (whole, want));
        let read = blurred.vertical.unwrap();
        assert!(read.x0 <= 0 && read.y0 <= 0 && read.x1 > 20 + 10 && read.y1 > 20 + 10);
        // The box is cut to the texture.
        let off = shadow_plan(size, src, 0.0, 0.0, true, PixelRect::new(-50, -50, 400, 20));
        assert_eq!(off.vertical, Some(PixelRect::new(0, 0, 100, 20)));
    }

    #[test]
    fn place_is_the_target_origin_then_each_inputs_origin_and_size() {
        let bytes = place_bytes([3, -4], ([10, 20], [30, 40]), ([0, 0], [7, 8]));
        assert_eq!(bytes.len(), 48);
        let word = |i: usize| i32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap());
        let words: Vec<i32> = (0..12).map(word).collect();
        assert_eq!(words, [3, -4, 0, 0, 10, 20, 30, 40, 0, 0, 7, 8]);
        // The struct in the shader: three vec4<i32>s in that order.
        let wgsl = include_str!("shaders/place.wgsl");
        let fields: Vec<_> = wgsl
            .lines()
            .filter(|l| {
                l.trim_start().starts_with("target_origin:")
                    || l.trim_start().starts_with("a:")
                    || l.trim_start().starts_with("b:")
            })
            .map(str::trim)
            .collect();
        assert_eq!(
            fields,
            [
                "target_origin: vec4<i32>,",
                "a: vec4<i32>,",
                "b: vec4<i32>,"
            ]
        );
    }

    #[test]
    fn shaders_that_place_their_textures_get_the_helper_and_the_others_do_not() {
        let place = include_str!("shaders/place.wgsl");
        let hash = include_str!("shaders/hash.wgsl");
        assert_eq!(shader_source("fn f() {}"), "fn f() {}");
        assert!(shader_source("fn f() { load_a(xy); }").starts_with(place));
        assert!(shader_source("fn f() { canvas_pos(p); }").starts_with(place));
        // After the other helpers, before the shader itself.
        let both = shader_source("fn f() { hash(1u); canvas_xy(p); }");
        assert!(both.starts_with(hash) && both.contains(place) && both.ends_with("}"));
        assert!(both.find(place).unwrap() < both.find("fn f()").unwrap());

        // The shaders on the shared layouts, which have the placement at
        // binding 3...
        let on_layout = [
            include_str!("shaders/composite.wgsl"),
            include_str!("shaders/shadow.wgsl"),
            include_str!("shaders/shadow_box.wgsl"),
            include_str!("shaders/color.wgsl"),
            include_str!("shaders/glow.wgsl"),
            include_str!("shaders/aberration.wgsl"),
            include_str!("shaders/gradient_map.wgsl"),
            include_str!("shaders/grain.wgsl"),
            include_str!("shaders/dither.wgsl"),
            include_str!("shaders/dot_matrix.wgsl"),
            include_str!("shaders/noise.wgsl"),
            include_str!("shaders/lut.wgsl"),
        ];
        for source in on_layout {
            assert!(
                shader_source(source).contains("@group(0) @binding(3) var<uniform> place: Place;"),
                "{}",
                source.lines().next().unwrap()
            );
        }
        // ...and those on layouts that do not.
        let off_layout = [
            include_str!("shaders/halftone.wgsl"),
            include_str!("shaders/warp.wgsl"),
            include_str!("shaders/displace.wgsl"),
            include_str!("shaders/mesh.wgsl"),
            include_str!("shaders/blur.wgsl"),
        ];
        for source in off_layout {
            assert!(
                !shader_source(source).contains("place: Place"),
                "{}",
                source.lines().next().unwrap()
            );
        }
    }
}
