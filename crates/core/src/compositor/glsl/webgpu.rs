//! WebGPU layers (`crate::webgpu`): the steps a page submitted (render and compute passes, uploads and copies) run on
//! the device with the page's own WGSL, and the passes into its canvas land in the same Rgba8 drawing buffer a WebGL
//! layer draws into (`glsl_place` then puts it on the canvas).
//!
//! The recording is replayed in a command buffer of its own, submitted inside a validation error scope, so a page's
//! mistake (a module naga refuses, a bind group that does not fit its layout, a draw wgpu rejects) is a warning on
//! stderr and a transparent layer, never a panic. The command buffer before it is submitted first: the drawing buffer is
//! shared by every glsl layer, and the place pass that reads it for an earlier layer is already recorded.
//!
//! Modules, bind group layouts, pipelines and samplers are kept by their ids, which the page side makes from their
//! content; buffers and textures are made again for each frame, from the bytes and the uploads the recording holds. A
//! buffer a compute pass writes is zeroed and, like a texture, a function of the steps that wrote it. A texture is a
//! function of the steps that wrote it, in order: an upload goes through a staging buffer inside the
//! command buffer (not `queue.write_texture`, which would run before every pass of the frame), so a pass that samples
//! a texture sees what the page had written when it submitted. Pictures are decoded (and video frames read) here, so a
//! recording holds a path or a time, not pixels. Every size, level and origin was checked by `crate::webgpu::validate`
//! before anything is made.

use std::num::NonZeroU64;
use std::sync::Arc;

use super::*;
use crate::video::{VideoDecoder, VideoInfo};
use crate::webgpu::{self as wg, Command, Source, Step, WebGpuContent};

/// Most pipelines, modules and layouts kept before the cache starts over.
const MAX_CACHED: usize = 128;
/// The most commands and vertices a recording may ask for.
const MAX_COMMANDS: usize = 1 << 16;
const MAX_VERTICES: u32 = 1 << 24;
/// The decoded pictures kept from one frame to the next, and the video files kept open.
const MAX_PICTURE_BYTES: usize = 256 << 20;
const MAX_VIDEOS: usize = 8;
/// A copy into a buffer is aligned to this many bytes a row.
const ROW_ALIGN: u32 = 256;

/// A decoded picture: straight RGBA8.
pub(super) struct Picture {
    rgba: Vec<u8>,
    width: u32,
    height: u32,
}

/// A video file, open, and the last frame it gave.
struct Clip {
    info: Arc<VideoInfo>,
    decoder: VideoDecoder,
    last: Option<(i64, Arc<Picture>)>,
}

#[derive(Default)]
pub(super) struct WebGpuCache {
    modules: HashMap<String, wgpu::ShaderModule>,
    layouts: HashMap<String, wgpu::BindGroupLayout>,
    /// By the pipeline's id and whether it draws into the canvas (a canvas is drawn as rgba8unorm whatever it is
    /// configured with) or into a texture.
    pipelines: HashMap<String, wgpu::RenderPipeline>,
    compute: HashMap<String, wgpu::ComputePipeline>,
    samplers: HashMap<String, wgpu::Sampler>,
    /// Pictures by file (or `data:` URL), kept across frames.
    pictures: HashMap<String, Arc<Picture>>,
    picture_bytes: usize,
    videos: HashMap<String, Clip>,
    warned: HashSet<String>,
}

type Fail<T> = std::result::Result<T, String>;

/// What a frame's steps work on: the resources made from the recording.
struct Resources<'r> {
    buffers: HashMap<&'r str, wgpu::Buffer>,
    /// The buffers the GPU writes, zeroed.
    gpu_buffers: HashMap<&'r str, wgpu::Buffer>,
    textures: HashMap<&'r str, wgpu::Texture>,
    samplers: HashMap<&'r str, wgpu::Sampler>,
    pipelines: HashMap<(&'r str, bool), wgpu::RenderPipeline>,
    compute: HashMap<&'r str, wgpu::ComputePipeline>,
    groups: HashMap<&'r str, wgpu::BindGroup>,
}

impl Compositor {
    /// Draws the recording into the drawing buffer of `size`. A recording that cannot be drawn leaves it empty.
    /// `layers` are the textures of a group's children, by `input_key`, which a `layer` upload names.
    pub(super) fn webgpu_draw(
        &mut self,
        content: &GlslContent,
        recording: &WebGpuContent,
        size: (u32, u32),
        base_dir: &Path,
        layers: &HashMap<String, wgpu::Texture>,
    ) {
        self.drawing_buffer(size);
        // The earlier layers' passes read the drawing buffer; they run before this one overwrites it.
        self.submit();
        let initial = if content.alpha { [0.0; 4] } else { [0.0, 0.0, 0.0, 1.0] };
        let drawn = self.webgpu_replay(recording, initial, size, base_dir, layers);
        if let Err(message) = drawn {
            self.webgpu_warn(&message);
            // Whatever a half-run left is not the picture.
            let target = self.glsl.target.as_ref().expect("made above");
            let mut encoder = self.device.create_command_encoder(&Default::default());
            drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("webgpu empty"),
                color_attachments: &[Some(clear_attachment(&target.view, color(initial)))],
                ..Default::default()
            }));
            self.queue.submit([encoder.finish()]);
        }
    }

    fn webgpu_warn(&mut self, message: &str) {
        if self.glsl.webgpu.warned.insert(message.to_string()) {
            eprintln!("kinetograph: webgpu: {message}");
        }
    }

    fn webgpu_replay(
        &mut self,
        recording: &WebGpuContent,
        initial: [f64; 4],
        size: (u32, u32),
        base_dir: &Path,
        layers: &HashMap<String, wgpu::Texture>,
    ) -> Fail<()> {
        let limits = wg::device_limits(&self.device);
        let problems = wg::check_with(recording, &limits);
        if let Some(first) = problems.first() {
            return Err(first.clone());
        }
        wg::validate_with(recording, &limits)?;
        let commands = |s: &Step| match s {
            Step::Render(p) => p.commands.len(),
            Step::Compute(p) => p.commands.len(),
            _ => 1,
        };
        if recording.passes.iter().map(commands).sum::<usize>() > MAX_COMMANDS {
            return Err(format!("more than {MAX_COMMANDS} commands in a frame"));
        }
        if self.glsl.webgpu.pipelines.len() > MAX_CACHED || self.glsl.webgpu.compute.len() > MAX_CACHED || self.glsl.webgpu.modules.len() > MAX_CACHED {
            self.glsl.webgpu.pipelines.clear();
            self.glsl.webgpu.compute.clear();
            self.glsl.webgpu.modules.clear();
            self.glsl.webgpu.layouts.clear();
        }
        if self.glsl.webgpu.samplers.len() > MAX_CACHED {
            self.glsl.webgpu.samplers.clear();
        }
        let device = self.device.clone();
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let built = self.webgpu_encode(recording, initial, size, base_dir, layers);
        let error = pollster::block_on(scope.pop());
        // The scope above held the pipelines' creation; the command buffer is checked in its own.
        let encoded = built?;
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        self.queue.submit([encoded]);
        let submit_error = pollster::block_on(scope.pop());
        if let Some(e) = error.or(submit_error) {
            return Err(format!("the passes were not accepted: {e}"));
        }
        Ok(())
    }

    /// The resources and the command buffer of the recording.
    fn webgpu_encode(
        &mut self,
        recording: &WebGpuContent,
        initial: [f64; 4],
        size: (u32, u32),
        base_dir: &Path,
        layers: &HashMap<String, wgpu::Texture>,
    ) -> Fail<wgpu::CommandBuffer> {
        let device = self.device.clone();
        let mut res = Resources {
            buffers: HashMap::new(),
            gpu_buffers: HashMap::new(),
            textures: HashMap::new(),
            samplers: HashMap::new(),
            pipelines: HashMap::new(),
            compute: HashMap::new(),
            groups: HashMap::new(),
        };
        // Buffers, from the bytes of the recording.
        for (id, base64) in &recording.buffers {
            let mut bytes = decode_blob(base64).map_err(|e| format!("buffer {id}: {e}"))?;
            while bytes.len() < 4 || bytes.len() % 4 != 0 {
                bytes.push(0);
            }
            res.buffers.insert(
                id,
                device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("webgpu buffer"),
                    contents: &bytes,
                    usage: wgpu::BufferUsages::UNIFORM
                        | wgpu::BufferUsages::STORAGE
                        | wgpu::BufferUsages::VERTEX
                        | wgpu::BufferUsages::INDEX
                        | wgpu::BufferUsages::COPY_DST,
                }),
            );
        }
        // Buffers the GPU writes: zeroed, the steps fill them.
        for (id, b) in &recording.gpu_buffers {
            res.gpu_buffers.insert(
                id,
                device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("webgpu gpu buffer"),
                    size: b.size.max(4).div_ceil(4) * 4,
                    usage: wgpu::BufferUsages::UNIFORM
                        | wgpu::BufferUsages::STORAGE
                        | wgpu::BufferUsages::VERTEX
                        | wgpu::BufferUsages::INDEX
                        | wgpu::BufferUsages::COPY_SRC
                        | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                }),
            );
        }
        // Textures: empty (zero), the steps fill them. A storage binding only where the recording has one, and only
        // where the format has it.
        let storage = !recording.compute_pipelines.is_empty()
            || recording.layouts.values().flatten().any(|l| l.ty == "storage-texture")
            || recording.modules.values().any(|m| m.contains("texture_storage_"));
        for (id, t) in &recording.textures {
            let format = texture_format(&t.format)?;
            let mut usage = wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::COPY_DST;
            if storage {
                usage |= wgpu::TextureUsages::STORAGE_BINDING;
            }
            // A format keeps to the usages it has (rgba32float cannot be blended, rgba8unorm-srgb is not a storage format).
            usage &= format.guaranteed_format_features(device.features()).allowed_usages;
            res.textures.insert(
                id,
                device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("webgpu texture"),
                    size: wgpu::Extent3d {
                        width: t.width,
                        height: t.height,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: t.mips,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format,
                    usage,
                    view_formats: &[],
                }),
            );
        }
        for (id, s) in &recording.samplers {
            let sampler = self.webgpu_sampler(id, s);
            res.samplers.insert(id, sampler);
        }
        // Pipelines that some pass sets, once for the canvas and once for a texture if both draw with it.
        for step in &recording.passes {
            let Step::Render(pass) = step else { continue };
            let canvas = pass.target.is_none();
            for command in &pass.commands {
                if let Command::Pipeline { id } = command
                    && !res.pipelines.contains_key(&(id.as_str(), canvas))
                {
                    let pipeline = self.webgpu_pipeline(recording, id, canvas)?;
                    res.pipelines.insert((id, canvas), pipeline);
                }
            }
        }
        for step in &recording.passes {
            let Step::Compute(pass) = step else { continue };
            for command in &pass.commands {
                if let wg::ComputeCommand::Pipeline { id } = command
                    && !res.compute.contains_key(id.as_str())
                {
                    let pipeline = self.webgpu_compute_pipeline(recording, id)?;
                    res.compute.insert(id, pipeline);
                }
            }
        }
        // Bind groups, as the passes bind them.
        for step in &recording.passes {
            let groups: Vec<&String> = match step {
                Step::Render(pass) => pass.commands.iter().filter_map(|c| if let Command::Bind { group, .. } = c { Some(group) } else { None }).collect(),
                Step::Compute(pass) => pass.commands.iter().filter_map(|c| if let wg::ComputeCommand::Bind { group, .. } = c { Some(group) } else { None }).collect(),
                _ => continue,
            };
            for group in groups {
                if !res.groups.contains_key(group.as_str()) {
                    let made = self.webgpu_bind_group(recording, group, &res)?;
                    res.groups.insert(group, made);
                }
            }
        }

        let canvas_view = self.glsl.target.as_ref().expect("made by webgpu_draw").view.clone();
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("webgpu"),
        });
        drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("webgpu start"),
            color_attachments: &[Some(clear_attachment(&canvas_view, color(initial)))],
            ..Default::default()
        }));
        for step in &recording.passes {
            match step {
                Step::Render(pass) => self.webgpu_pass(&mut encoder, recording, &res, pass, &canvas_view, size)?,
                Step::Compute(pass) => webgpu_compute(&mut encoder, &res, pass)?,
                Step::WriteBuffer(w) => {
                    let buffer = res.gpu_buffers.get(w.buffer.as_str()).ok_or("a write into a buffer that was not made")?;
                    let bytes = decode_blob(recording.blobs.get(&w.data).ok_or("data that is not in the recording")?)?;
                    if !bytes.is_empty() {
                        let staging = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                            label: Some("webgpu buffer write"),
                            contents: &bytes,
                            usage: wgpu::BufferUsages::COPY_SRC,
                        });
                        encoder.copy_buffer_to_buffer(&staging, 0, buffer, w.offset, bytes.len() as u64);
                    }
                }
                Step::CopyBuffer(c) => {
                    let from = res.gpu_buffers.get(c.from.as_str()).ok_or("a copy from a buffer that was not made")?;
                    let to = res.gpu_buffers.get(c.to.as_str()).ok_or("a copy into a buffer that was not made")?;
                    if c.size > 0 {
                        encoder.copy_buffer_to_buffer(from, c.from_offset, to, c.to_offset, c.size);
                    }
                }
                Step::ClearBuffer(c) => {
                    let buffer = res.gpu_buffers.get(c.buffer.as_str()).ok_or("a clear of a buffer that was not made")?;
                    if c.size > 0 {
                        encoder.clear_buffer(buffer, c.offset, Some(c.size));
                    }
                }
                Step::Upload(upload) => self.webgpu_upload(&mut encoder, recording, &res, upload, size, base_dir, layers)?,
                Step::Copy(copy) => {
                    let from = res.textures.get(copy.from.texture.as_str()).ok_or("a copy from a texture that was not made")?;
                    let to = res.textures.get(copy.to.texture.as_str()).ok_or("a copy to a texture that was not made")?;
                    encoder.copy_texture_to_texture(
                        texel_info(from, copy.from.mip, copy.from.x, copy.from.y),
                        texel_info(to, copy.to.mip, copy.to.x, copy.to.y),
                        extent(copy.width, copy.height),
                    );
                }
            }
        }
        Ok(encoder.finish())
    }

    /// One render pass, into the canvas or into a level of a texture.
    fn webgpu_pass(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        recording: &WebGpuContent,
        res: &Resources<'_>,
        pass: &wg::Pass,
        canvas_view: &wgpu::TextureView,
        canvas_size: (u32, u32),
    ) -> Fail<()> {
        let (view, bounds) = match &pass.target {
            None => (canvas_view.clone(), canvas_size),
            Some(target) => {
                let texture = res.textures.get(target.texture.as_str()).ok_or("a pass into a texture that was not made")?;
                let described = recording.textures.get(&target.texture).ok_or("a pass into a texture that is not in the recording")?;
                let view = texture.create_view(&wgpu::TextureViewDescriptor {
                    base_mip_level: target.mip,
                    mip_level_count: Some(1),
                    ..Default::default()
                });
                (view, wg::mip_extent(described, target.mip))
            }
        };
        let canvas = pass.target.is_none();
        let load = match pass.clear {
            Some(c) => wgpu::LoadOp::Clear(color(c)),
            None => wgpu::LoadOp::Load,
        };
        let mut rp = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("webgpu"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load,
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        let mut has_pipeline = false;
        let mut index_size: Option<u64> = None;
        for command in &pass.commands {
            match command {
                Command::Pipeline { id } => {
                    let pipeline = res.pipelines.get(&(id.as_str(), canvas)).ok_or("a pipeline that was not made")?;
                    rp.set_pipeline(pipeline);
                    has_pipeline = true;
                }
                Command::Bind { index, group, offsets } => {
                    let group = res.groups.get(group.as_str()).ok_or("a bind group that was not made")?;
                    rp.set_bind_group(*index, group, offsets);
                }
                Command::Vertex { slot, buffer, offset, size } => {
                    let b = buffer_in(res, buffer)?;
                    rp.set_vertex_buffer(*slot, slice(b, *offset, *size, 4)?);
                }
                Command::Index { buffer, format, offset, size } => {
                    let b = buffer_in(res, buffer)?;
                    let format = match format.as_str() {
                        "uint16" => wgpu::IndexFormat::Uint16,
                        "uint32" => wgpu::IndexFormat::Uint32,
                        other => return Err(format!("index format {other}")),
                    };
                    index_size = Some(if format == wgpu::IndexFormat::Uint16 { 2 } else { 4 });
                    rp.set_index_buffer(slice(b, *offset, *size, index_size.unwrap_or(4))?, format);
                }
                Command::Draw { vertices, instances, first, first_instance } => {
                    if !has_pipeline {
                        return Err("draw before setPipeline".into());
                    }
                    check_count(*vertices, *instances)?;
                    rp.draw(*first..first.saturating_add(*vertices), *first_instance..first_instance.saturating_add(*instances));
                }
                Command::DrawIndexed { indices, instances, first, base, first_instance } => {
                    if !has_pipeline || index_size.is_none() {
                        return Err("drawIndexed before setPipeline and setIndexBuffer".into());
                    }
                    check_count(*indices, *instances)?;
                    rp.draw_indexed(*first..first.saturating_add(*indices), *base, *first_instance..first_instance.saturating_add(*instances));
                }
                Command::Viewport { x, y, width, height, min_depth, max_depth } => {
                    check_viewport([*x, *y, *width, *height, *min_depth, *max_depth])?;
                    rp.set_viewport(*x, *y, *width, *height, *min_depth, *max_depth);
                }
                Command::Scissor { x, y, width, height } => {
                    check_scissor(bounds, *x, *y, *width, *height)?;
                    rp.set_scissor_rect(*x, *y, *width, *height);
                }
                Command::Blend { color: c } => rp.set_blend_constant(color(*c)),
            }
        }
        Ok(())
    }

    /// An upload, copied into the texture from a staging buffer, in order with the passes.
    #[allow(clippy::too_many_arguments)]
    fn webgpu_upload(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        recording: &WebGpuContent,
        res: &Resources<'_>,
        u: &wg::Upload,
        size: (u32, u32),
        base_dir: &Path,
        layers: &HashMap<String, wgpu::Texture>,
    ) -> Fail<()> {
        if u.width == 0 || u.height == 0 {
            return Ok(());
        }
        let texture = res.textures.get(u.texture.as_str()).ok_or("an upload into a texture that was not made")?;
        let described = recording.textures.get(&u.texture).ok_or("an upload into a texture that is not in the recording")?;
        let texel = wg::texel_bytes(&described.format).ok_or("an upload into a texture of an unknown format")?;
        let bytes = match &u.source {
            Source::Layer(id) => {
                // The child's picture, already turned over and premultiplied the way this upload asks.
                let key = input_key(id, u.flip_y, u.premultiply);
                let from = layers.get(&key).ok_or_else(|| format!("the layer {id:?} was not drawn, or is not a child of this group"))?;
                if !matches!(described.format.as_str(), "rgba8unorm" | "rgba8unorm-srgb") {
                    return Err(format!("a layer copied into a texture of format {}; use rgba8unorm", described.format));
                }
                // A turned-over picture counts its rows from the other end.
                let sy = if u.flip_y {
                    size.1.checked_sub(u.sy.checked_add(u.height).ok_or("a layer rectangle overflows")?).ok_or("a layer rectangle is outside the layer")?
                } else {
                    u.sy
                };
                wg::rect_in("an upload from a layer", size, u.sx, sy, u.width, u.height)?;
                encoder.copy_texture_to_texture(
                    texel_info(from, 0, u.sx, sy),
                    texel_info(texture, u.mip, u.x, u.y),
                    extent(u.width, u.height),
                );
                return Ok(());
            }
            Source::Raw(id) => {
                let bytes = decode_blob(recording.blobs.get(id).ok_or("data that is not in the recording")?)?;
                let want = wg::packed_len(u.width, u.height, texel)?;
                if bytes.len() != want {
                    return Err(format!("an upload of {} x {} texels needs {want} bytes, the recording holds {}", u.width, u.height, bytes.len()));
                }
                bytes
            }
            Source::Pixels { id, width, height } => {
                let all = decode_blob(recording.blobs.get(id).ok_or("pixels that are not in the recording")?)?;
                let want = wg::packed_len(*width, *height, 4)?;
                if all.len() != want {
                    return Err(format!("pixels of {width} x {height} need {want} bytes, the recording holds {}", all.len()));
                }
                picture_pixels(&all, (*width, *height), u, described)?
            }
            Source::Src(src) => {
                let picture = self.webgpu_picture(src, base_dir)?;
                picture_pixels(&picture.rgba, (picture.width, picture.height), u, described)?
            }
            Source::Video { src, time } => {
                let picture = self.webgpu_video_frame(src, *time, base_dir)?;
                picture_pixels(&picture.rgba, (picture.width, picture.height), u, described)?
            }
        };
        let (padded, bytes_per_row) = pad_rows(&bytes, (u.width as usize) * texel as usize, u.height as usize)?;
        let staging = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("webgpu upload"),
            contents: &padded,
            usage: wgpu::BufferUsages::COPY_SRC,
        });
        encoder.copy_buffer_to_texture(
            wgpu::TexelCopyBufferInfo {
                buffer: &staging,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bytes_per_row),
                    rows_per_image: Some(u.height),
                },
            },
            texel_info(texture, u.mip, u.x, u.y),
            extent(u.width, u.height),
        );
        Ok(())
    }

    /// A picture file (or `data:` URL) decoded, kept while it is used.
    fn webgpu_picture(&mut self, src: &str, base_dir: &Path) -> Fail<Arc<Picture>> {
        let stamp = if src.starts_with("data:") { String::new() } else { file_stamp(&base_dir.join(src)) };
        let key = format!("{src}|{stamp}");
        if let Some(p) = self.glsl.webgpu.pictures.get(&key) {
            return Ok(p.clone());
        }
        let texture = GlslTexture {
            src: Some(src.to_string()),
            pixels: None,
            layer: None,
            width: 0,
            height: 0,
            flip_y: false,
            premultiply: false,
            mipmaps: false,
            target: false,
        };
        let (rgba, width, height) = gl::decode_texture(&texture, base_dir)?;
        let limit = self.device.limits().max_texture_dimension_2d;
        if width > limit || height > limit {
            return Err(format!("a {width} x {height} picture; the device holds {limit} across"));
        }
        if self.glsl.webgpu.picture_bytes + rgba.len() > MAX_PICTURE_BYTES {
            self.glsl.webgpu.pictures.clear();
            self.glsl.webgpu.picture_bytes = 0;
        }
        self.glsl.webgpu.picture_bytes += rgba.len();
        let picture = Arc::new(Picture { rgba, width, height });
        self.glsl.webgpu.pictures.insert(key, picture.clone());
        Ok(picture)
    }

    /// The frame of a video `time` seconds after its first picture: the last picture at or before that instant, as a
    /// video layer shows it, so it does not depend on the frames drawn before.
    fn webgpu_video_frame(&mut self, src: &str, time: f64, base_dir: &Path) -> Fail<Arc<Picture>> {
        if !self.glsl.webgpu.videos.contains_key(src) {
            if self.glsl.webgpu.videos.len() >= MAX_VIDEOS {
                self.glsl.webgpu.videos.clear();
            }
            crate::video::init();
            let path = base_dir.join(src);
            let info = crate::video::probe(&path).map_err(|e| format!("video {}: {e}", path.display()))?;
            let decoder = VideoDecoder::open(&path, info.clone()).map_err(|e| format!("video {}: {e}", path.display()))?;
            self.glsl.webgpu.videos.insert(src.to_string(), Clip { info, decoder, last: None });
        }
        let clip = self.glsl.webgpu.videos.get_mut(src).expect("opened above");
        let at = clip.info.media_time(time, clip.info.duration);
        if let Some((ts, picture)) = &clip.last
            && *ts == at.ts
        {
            return Ok(picture.clone());
        }
        let image = clip.decoder.picture(at.ts).map_err(|e| format!("video {src:?} at {time:.3} s: {e}"))?;
        let picture = Arc::new(Picture {
            rgba: image.data.data().to_vec(),
            width: image.width,
            height: image.height,
        });
        clip.last = Some((at.ts, picture.clone()));
        Ok(picture)
    }

    fn webgpu_sampler(&mut self, id: &str, s: &wg::SamplerDesc) -> wgpu::Sampler {
        if let Some(cached) = self.glsl.webgpu.samplers.get(id) {
            return cached.clone();
        }
        let address = |mode: &Option<String>| match mode.as_deref() {
            Some("repeat") => wgpu::AddressMode::Repeat,
            Some("mirror-repeat") => wgpu::AddressMode::MirrorRepeat,
            _ => wgpu::AddressMode::ClampToEdge,
        };
        let filter = |f: &Option<String>| match f.as_deref() {
            Some("linear") => wgpu::FilterMode::Linear,
            _ => wgpu::FilterMode::Nearest,
        };
        let sampler = self.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("webgpu sampler"),
            address_mode_u: address(&s.address_mode_u),
            address_mode_v: address(&s.address_mode_v),
            address_mode_w: address(&s.address_mode_w),
            mag_filter: filter(&s.mag_filter),
            min_filter: filter(&s.min_filter),
            mipmap_filter: match s.mipmap_filter.as_deref() {
                Some("linear") => wgpu::MipmapFilterMode::Linear,
                _ => wgpu::MipmapFilterMode::Nearest,
            },
            lod_min_clamp: s.lod_min_clamp.unwrap_or(0.0) as f32,
            lod_max_clamp: s.lod_max_clamp.unwrap_or(32.0) as f32,
            anisotropy_clamp: s.max_anisotropy.unwrap_or(1).clamp(1, 16) as u16,
            ..Default::default()
        });
        self.glsl.webgpu.samplers.insert(id.to_string(), sampler.clone());
        sampler
    }

    fn webgpu_module(&mut self, recording: &WebGpuContent, id: &str) -> Fail<wgpu::ShaderModule> {
        let code = recording.modules.get(id).ok_or_else(|| format!("module {id} is not in the recording"))?;
        if let Some(m) = self.glsl.webgpu.modules.get(code) {
            return Ok(m.clone());
        }
        let module = self.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("webgpu"),
            source: wgpu::ShaderSource::Wgsl(Cow::Owned(code.clone())),
        });
        self.glsl.webgpu.modules.insert(code.clone(), module.clone());
        Ok(module)
    }

    fn webgpu_layout(&mut self, recording: &WebGpuContent, id: &str) -> Fail<wgpu::BindGroupLayout> {
        if let Some(l) = self.glsl.webgpu.layouts.get(id) {
            return Ok(l.clone());
        }
        let entries = recording.layouts.get(id).ok_or_else(|| format!("bind group layout {id} is not in the recording"))?;
        let mut made = Vec::with_capacity(entries.len());
        for e in entries {
            let mut visibility = wgpu::ShaderStages::empty();
            if e.visibility & 1 != 0 {
                visibility |= wgpu::ShaderStages::VERTEX;
            }
            if e.visibility & 2 != 0 {
                visibility |= wgpu::ShaderStages::FRAGMENT;
            }
            if e.visibility & 4 != 0 {
                visibility |= wgpu::ShaderStages::COMPUTE;
            }
            let ty = match e.ty.as_str() {
                "uniform" => buffer_binding(wgpu::BufferBindingType::Uniform, e.dynamic_offset),
                "storage" => buffer_binding(wgpu::BufferBindingType::Storage { read_only: false }, e.dynamic_offset),
                "read-only-storage" => buffer_binding(wgpu::BufferBindingType::Storage { read_only: true }, e.dynamic_offset),
                "storage-texture" => wgpu::BindingType::StorageTexture {
                    access: match e.access.as_deref().unwrap_or("write-only") {
                        "write-only" => wgpu::StorageTextureAccess::WriteOnly,
                        "read-only" => wgpu::StorageTextureAccess::ReadOnly,
                        "read-write" => wgpu::StorageTextureAccess::ReadWrite,
                        other => return Err(format!("storage texture access {other}")),
                    },
                    format: texture_format(e.format.as_deref().ok_or("a storage texture without a format")?)?,
                    view_dimension: wgpu::TextureViewDimension::D2,
                },
                "texture" => wgpu::BindingType::Texture {
                    sample_type: match e.sample_type.as_deref().unwrap_or("float") {
                        "float" => wgpu::TextureSampleType::Float { filterable: true },
                        "unfilterable-float" => wgpu::TextureSampleType::Float { filterable: false },
                        "sint" => wgpu::TextureSampleType::Sint,
                        "uint" => wgpu::TextureSampleType::Uint,
                        other => return Err(format!("texture sample type {other}")),
                    },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                "sampler" => wgpu::BindingType::Sampler(match e.sampler_type.as_deref().unwrap_or("filtering") {
                    "filtering" => wgpu::SamplerBindingType::Filtering,
                    "non-filtering" => wgpu::SamplerBindingType::NonFiltering,
                    other => return Err(format!("sampler binding type {other}")),
                }),
                other => return Err(format!("binding type {other}")),
            };
            made.push(wgpu::BindGroupLayoutEntry {
                binding: e.binding,
                visibility,
                ty,
                count: None,
            });
        }
        let layout = self.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("webgpu"),
            entries: &made,
        });
        self.glsl.webgpu.layouts.insert(id.to_string(), layout.clone());
        Ok(layout)
    }

    fn webgpu_pipeline(&mut self, recording: &WebGpuContent, id: &str, canvas: bool) -> Fail<wgpu::RenderPipeline> {
        let key = format!("{id}|{}", u8::from(canvas));
        if let Some(p) = self.glsl.webgpu.pipelines.get(&key) {
            return Ok(p.clone());
        }
        let spec = recording.pipelines.get(id).ok_or_else(|| format!("pipeline {id} is not in the recording"))?;
        let vertex = self.webgpu_module(recording, &spec.vertex.module)?;
        let fragment = match &spec.fragment {
            Some(f) => Some(self.webgpu_module(recording, &f.module)?),
            None => None,
        };
        let layout = match &spec.layout {
            Some(ids) => {
                let layouts: Vec<wgpu::BindGroupLayout> = ids
                    .iter()
                    .map(|l| self.webgpu_layout(recording, l))
                    .collect::<Fail<_>>()?;
                let refs: Vec<Option<&wgpu::BindGroupLayout>> = layouts.iter().map(Some).collect();
                Some(self.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("webgpu"),
                    bind_group_layouts: &refs,
                    immediate_size: 0,
                }))
            }
            None => None,
        };
        let mut attributes: Vec<Vec<wgpu::VertexAttribute>> = Vec::new();
        for b in &spec.vertex.buffers {
            attributes.push(
                b.attributes
                    .iter()
                    .map(|a| {
                        Ok(wgpu::VertexAttribute {
                            format: vertex_format(&a.format)?,
                            offset: a.offset,
                            shader_location: a.location,
                        })
                    })
                    .collect::<Fail<_>>()?,
            );
        }
        let buffers: Vec<Option<wgpu::VertexBufferLayout>> = spec
            .vertex
            .buffers
            .iter()
            .zip(&attributes)
            .map(|(b, attributes)| {
                Some(wgpu::VertexBufferLayout {
                    array_stride: b.stride,
                    step_mode: if b.step_mode.as_deref() == Some("instance") {
                        wgpu::VertexStepMode::Instance
                    } else {
                        wgpu::VertexStepMode::Vertex
                    },
                    attributes,
                })
            })
            .collect();
        let mut targets = Vec::new();
        if let Some(f) = &spec.fragment {
            for t in &f.targets {
                targets.push(match t {
                    None => None,
                    Some(t) => Some(wgpu::ColorTargetState {
                        format: if canvas {
                            // The drawing buffer is Rgba8: a bgra8 canvas holds the same colours.
                            match t.format.as_str() {
                                "rgba8unorm" | "bgra8unorm" | "rgba8unorm-srgb" | "bgra8unorm-srgb" => wgpu::TextureFormat::Rgba8Unorm,
                                other => return Err(format!("a render target of format {other}; the canvas is drawn as rgba8unorm")),
                            }
                        } else {
                            texture_format(&t.format)?
                        },
                        blend: t.blend.as_ref().map(blend_state).transpose()?,
                        write_mask: wgpu::ColorWrites::from_bits_truncate(t.write_mask.unwrap_or(15)),
                    }),
                });
            }
        }
        let p = &spec.primitive;
        let topology = match p.topology.as_str() {
            "point-list" => wgpu::PrimitiveTopology::PointList,
            "line-list" => wgpu::PrimitiveTopology::LineList,
            "line-strip" => wgpu::PrimitiveTopology::LineStrip,
            "triangle-list" => wgpu::PrimitiveTopology::TriangleList,
            "triangle-strip" => wgpu::PrimitiveTopology::TriangleStrip,
            other => return Err(format!("topology {other}")),
        };
        let pipeline = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("webgpu"),
            layout: layout.as_ref(),
            vertex: wgpu::VertexState {
                module: &vertex,
                entry_point: spec.vertex.entry_point.as_deref(),
                compilation_options: Default::default(),
                buffers: &buffers,
            },
            fragment: match (&spec.fragment, &fragment) {
                (Some(f), Some(module)) => Some(wgpu::FragmentState {
                    module,
                    entry_point: f.entry_point.as_deref(),
                    compilation_options: Default::default(),
                    targets: &targets,
                }),
                _ => None,
            },
            primitive: wgpu::PrimitiveState {
                topology,
                strip_index_format: match p.strip_index_format.as_deref() {
                    Some("uint16") => Some(wgpu::IndexFormat::Uint16),
                    Some("uint32") => Some(wgpu::IndexFormat::Uint32),
                    _ => None,
                },
                front_face: if p.front_face == "cw" { wgpu::FrontFace::Cw } else { wgpu::FrontFace::Ccw },
                cull_mode: match p.cull_mode.as_str() {
                    "front" => Some(wgpu::Face::Front),
                    "back" => Some(wgpu::Face::Back),
                    _ => None,
                },
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        self.glsl.webgpu.pipelines.insert(key, pipeline.clone());
        Ok(pipeline)
    }

    fn webgpu_compute_pipeline(&mut self, recording: &WebGpuContent, id: &str) -> Fail<wgpu::ComputePipeline> {
        if let Some(p) = self.glsl.webgpu.compute.get(id) {
            return Ok(p.clone());
        }
        let spec = recording.compute_pipelines.get(id).ok_or_else(|| format!("compute pipeline {id} is not in the recording"))?;
        let module = self.webgpu_module(recording, &spec.module)?;
        let layout = match &spec.layout {
            Some(ids) => {
                let layouts: Vec<wgpu::BindGroupLayout> = ids.iter().map(|l| self.webgpu_layout(recording, l)).collect::<Fail<_>>()?;
                let refs: Vec<Option<&wgpu::BindGroupLayout>> = layouts.iter().map(Some).collect();
                Some(self.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("webgpu compute"),
                    bind_group_layouts: &refs,
                    immediate_size: 0,
                }))
            }
            None => None,
        };
        let pipeline = self.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("webgpu compute"),
            layout: layout.as_ref(),
            module: &module,
            entry_point: spec.entry_point.as_deref(),
            compilation_options: Default::default(),
            cache: None,
        });
        self.glsl.webgpu.compute.insert(id.to_string(), pipeline.clone());
        Ok(pipeline)
    }

    fn webgpu_bind_group(&mut self, recording: &WebGpuContent, id: &str, res: &Resources<'_>) -> Fail<wgpu::BindGroup> {
        let spec = recording.bind_groups.get(id).ok_or_else(|| format!("bind group {id} is not in the recording"))?;
        let layout = if let Some(rest) = spec.layout.strip_prefix("auto:") {
            let (pipeline, index) = rest.rsplit_once(':').ok_or("a malformed automatic layout")?;
            let index: u32 = index.parse().map_err(|_| "a malformed automatic layout")?;
            // The layout is the pipeline's whichever target it draws into.
            match res.pipelines.get(&(pipeline, true)).or_else(|| res.pipelines.get(&(pipeline, false))) {
                Some(p) => p.get_bind_group_layout(index),
                None => match res.compute.get(pipeline) {
                    Some(p) => p.get_bind_group_layout(index),
                    None => return Err(format!("the bind group {id} uses the layout of a pipeline no pass sets")),
                },
            }
        } else {
            self.webgpu_layout(recording, &spec.layout)?
        };
        // The views are made first, so that the entries can borrow them.
        let mut views: Vec<Option<wgpu::TextureView>> = Vec::with_capacity(spec.entries.len());
        for e in &spec.entries {
            views.push(match &e.texture {
                Some(v) => {
                    let texture = res.textures.get(v.id.as_str()).ok_or_else(|| format!("texture {} was not made", v.id))?;
                    Some(texture.create_view(&wgpu::TextureViewDescriptor {
                        base_mip_level: v.base_mip,
                        mip_level_count: Some(v.mips),
                        dimension: Some(wgpu::TextureViewDimension::D2),
                        ..Default::default()
                    }))
                }
                None => None,
            });
        }
        let mut entries = Vec::with_capacity(spec.entries.len());
        for (e, view) in spec.entries.iter().zip(&views) {
            let resource = if let Some(buffer) = &e.buffer {
                wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: buffer_in(res, buffer)?,
                    offset: e.offset,
                    size: NonZeroU64::new(e.size),
                })
            } else if let Some(view) = view {
                wgpu::BindingResource::TextureView(view)
            } else if let Some(sampler) = &e.sampler {
                wgpu::BindingResource::Sampler(res.samplers.get(sampler.as_str()).ok_or_else(|| format!("sampler {sampler} was not made"))?)
            } else {
                return Err(format!("binding {} of the bind group {id} holds nothing", e.binding));
            };
            entries.push(wgpu::BindGroupEntry {
                binding: e.binding,
                resource,
            });
        }
        Ok(self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("webgpu"),
            layout: &layout,
            entries: &entries,
        }))
    }
}

/// One compute pass: the pipeline, the bind groups and the dispatches, in order.
fn webgpu_compute(encoder: &mut wgpu::CommandEncoder, res: &Resources<'_>, pass: &wg::ComputePass) -> Fail<()> {
    let mut cp = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
        label: Some("webgpu compute"),
        timestamp_writes: None,
    });
    let mut has_pipeline = false;
    for command in &pass.commands {
        match command {
            wg::ComputeCommand::Pipeline { id } => {
                cp.set_pipeline(res.compute.get(id.as_str()).ok_or("a compute pipeline that was not made")?);
                has_pipeline = true;
            }
            wg::ComputeCommand::Bind { index, group, offsets } => {
                let group = res.groups.get(group.as_str()).ok_or("a bind group that was not made")?;
                cp.set_bind_group(*index, group, offsets);
            }
            wg::ComputeCommand::Dispatch { x, y, z } => {
                if !has_pipeline {
                    return Err("dispatchWorkgroups before setPipeline".into());
                }
                cp.dispatch_workgroups(*x, *y, *z);
            }
        }
    }
    Ok(())
}

fn buffer_binding(ty: wgpu::BufferBindingType, has_dynamic_offset: bool) -> wgpu::BindingType {
    wgpu::BindingType::Buffer {
        ty,
        has_dynamic_offset,
        min_binding_size: None,
    }
}

fn color(c: [f64; 4]) -> wgpu::Color {
    wgpu::Color {
        r: c[0],
        g: c[1],
        b: c[2],
        a: c[3],
    }
}

fn extent(width: u32, height: u32) -> wgpu::Extent3d {
    wgpu::Extent3d {
        width,
        height,
        depth_or_array_layers: 1,
    }
}

fn texel_info(texture: &wgpu::Texture, mip_level: u32, x: u32, y: u32) -> wgpu::TexelCopyTextureInfo<'_> {
    wgpu::TexelCopyTextureInfo {
        texture,
        mip_level,
        origin: wgpu::Origin3d { x, y, z: 0 },
        aspect: wgpu::TextureAspect::All,
    }
}

fn texture_format(name: &str) -> Fail<wgpu::TextureFormat> {
    use wgpu::TextureFormat as F;
    Ok(match name {
        "r8unorm" => F::R8Unorm,
        "r8uint" => F::R8Uint,
        "r8sint" => F::R8Sint,
        "rg8unorm" => F::Rg8Unorm,
        "rg8uint" => F::Rg8Uint,
        "rg8sint" => F::Rg8Sint,
        "rgba8unorm" => F::Rgba8Unorm,
        "rgba8unorm-srgb" => F::Rgba8UnormSrgb,
        "rgba8snorm" => F::Rgba8Snorm,
        "rgba8uint" => F::Rgba8Uint,
        "rgba8sint" => F::Rgba8Sint,
        "bgra8unorm" => F::Bgra8Unorm,
        "bgra8unorm-srgb" => F::Bgra8UnormSrgb,
        "rgb10a2unorm" => F::Rgb10a2Unorm,
        "r16uint" => F::R16Uint,
        "r16sint" => F::R16Sint,
        "r16float" => F::R16Float,
        "rg16uint" => F::Rg16Uint,
        "rg16sint" => F::Rg16Sint,
        "rg16float" => F::Rg16Float,
        "rgba16uint" => F::Rgba16Uint,
        "rgba16sint" => F::Rgba16Sint,
        "rgba16float" => F::Rgba16Float,
        "r32uint" => F::R32Uint,
        "r32sint" => F::R32Sint,
        "r32float" => F::R32Float,
        "rg32uint" => F::Rg32Uint,
        "rg32sint" => F::Rg32Sint,
        "rg32float" => F::Rg32Float,
        "rgba32uint" => F::Rgba32Uint,
        "rgba32sint" => F::Rgba32Sint,
        "rgba32float" => F::Rgba32Float,
        other => return Err(format!("a texture of format {other}")),
    })
}

/// Bytes from a recording's base64, refusing what could not fit the frame's texture memory anyway.
fn decode_blob(base64: &str) -> Fail<Vec<u8>> {
    if (base64.len() / 4) as u64 * 3 > wg::MAX_TEXTURE_BYTES {
        return Err(format!("{} bytes of data in a frame; the textures may hold {}", base64.len() / 4 * 3, wg::MAX_TEXTURE_BYTES));
    }
    base64::engine::general_purpose::STANDARD.decode(base64).map_err(|e| format!("data that is not base64: {e}"))
}

/// What an upload from a picture of `picture` pixels writes: the rectangle `sx`, `sy` of it, turned over when asked,
/// multiplied by its alpha when asked, and in the byte order of the texture's format.
fn picture_pixels(rgba: &[u8], picture: (u32, u32), u: &wg::Upload, texture: &wg::Texture) -> Fail<Vec<u8>> {
    wg::rect_in("an upload from a picture", picture, u.sx, u.sy, u.width, u.height)?;
    if rgba.len() != wg::packed_len(picture.0, picture.1, 4)? {
        return Err("a picture's pixels are not its width x height x 4 bytes".into());
    }
    let mut out = crop(rgba, picture.0, u.sx, u.sy, u.width, u.height);
    if u.flip_y {
        flip_rows(&mut out, u.width as usize * 4);
    }
    if u.premultiply {
        premultiply(&mut out);
    }
    if texture.format.starts_with("bgra") {
        swap_red_blue(&mut out);
    }
    Ok(out)
}

/// The rectangle `x`, `y`, `width` x `height` of RGBA pixels `stride_px` wide (the caller has checked it is inside).
fn crop(rgba: &[u8], stride_px: u32, x: u32, y: u32, width: u32, height: u32) -> Vec<u8> {
    let (stride, row) = (stride_px as usize * 4, width as usize * 4);
    let mut out = Vec::with_capacity(row * height as usize);
    for r in 0..height as usize {
        let start = (y as usize + r) * stride + x as usize * 4;
        out.extend_from_slice(&rgba[start..start + row]);
    }
    out
}

/// Turns rows of `row` bytes over.
fn flip_rows(bytes: &mut [u8], row: usize) {
    if row == 0 {
        return;
    }
    let rows = bytes.len() / row;
    for r in 0..rows / 2 {
        let (top, bottom) = bytes.split_at_mut((rows - 1 - r) * row);
        top[r * row..(r + 1) * row].swap_with_slice(&mut bottom[..row]);
    }
}

/// Colour times alpha, rounded, for straight RGBA8.
fn premultiply(rgba: &mut [u8]) {
    let (pixels, _) = rgba.as_chunks_mut::<4>();
    for px in pixels {
        let a = u32::from(px[3]);
        for c in &mut px[..3] {
            *c = ((u32::from(*c) * a + 127) / 255) as u8;
        }
    }
}

fn swap_red_blue(rgba: &mut [u8]) {
    let (pixels, _) = rgba.as_chunks_mut::<4>();
    for px in pixels {
        px.swap(0, 2);
    }
}

/// `bytes` of rows of `row` bytes, each padded to the alignment a buffer to texture copy needs, and the padded row's size.
fn pad_rows(bytes: &[u8], row: usize, height: usize) -> Fail<(Vec<u8>, u32)> {
    let align = ROW_ALIGN as usize;
    let padded = row.checked_add(align - 1).ok_or("a row's size overflows")? / align * align;
    let total = padded.checked_mul(height).ok_or("an upload's size overflows")?;
    if bytes.len() != row.checked_mul(height).ok_or("an upload's size overflows")? {
        return Err("an upload does not hold width x height texels".into());
    }
    let mut out = vec![0u8; total];
    for r in 0..height {
        out[r * padded..r * padded + row].copy_from_slice(&bytes[r * row..(r + 1) * row]);
    }
    Ok((out, u32::try_from(padded).map_err(|_| "a row is too long")?))
}

/// A buffer of the recording, whether the page's bytes made it or the GPU writes it.
fn buffer_in<'a>(res: &'a Resources<'_>, id: &str) -> Fail<&'a wgpu::Buffer> {
    res.buffers.get(id).or_else(|| res.gpu_buffers.get(id)).ok_or_else(|| format!("buffer {id} is not in the recording"))
}

/// A range of a buffer to bind. wgpu panics on an empty slice, so it is refused here, with offsets that are not
/// aligned (`align`: 4 for a vertex buffer, the index size for an index buffer).
fn slice(buffer: &wgpu::Buffer, offset: u64, size: Option<u64>, align: u64) -> Fail<wgpu::BufferSlice<'_>> {
    let end = checked_range(buffer.size(), offset, size, align)?;
    Ok(buffer.slice(offset..end))
}

/// The end of the range `offset` and `size` name in a buffer of `length` bytes, if it is a range wgpu accepts.
fn checked_range(length: u64, offset: u64, size: Option<u64>, align: u64) -> Fail<u64> {
    if !offset.is_multiple_of(align) {
        return Err(format!("the offset {offset} of a bound buffer is not a multiple of {align}"));
    }
    let end = match size {
        Some(s) => offset.checked_add(s).ok_or("a buffer range overflows")?,
        None => length,
    };
    if offset >= end {
        return Err(format!("the range {offset}..{end} of a bound buffer is empty"));
    }
    if end > length {
        return Err(format!("the range {offset}..{end} is outside a buffer of {length} bytes"));
    }
    Ok(end)
}

/// A scissor rectangle is inside the attachment and not empty.
fn check_scissor(bounds: (u32, u32), x: u32, y: u32, width: u32, height: u32) -> Fail<()> {
    if width == 0 || height == 0 {
        return Err("setScissorRect with an empty rectangle".into());
    }
    wg::rect_in("setScissorRect", bounds, x, y, width, height)
}

/// A viewport has finite numbers and a size.
fn check_viewport(v: [f32; 6]) -> Fail<()> {
    if !v.iter().all(|n| n.is_finite()) || v[2] <= 0.0 || v[3] <= 0.0 {
        return Err(format!("setViewport({}, {}, {}, {}, {}, {}) is not a viewport", v[0], v[1], v[2], v[3], v[4], v[5]));
    }
    Ok(())
}

fn check_count(vertices: u32, instances: u32) -> Fail<()> {
    if vertices > MAX_VERTICES || instances > MAX_VERTICES || u64::from(vertices) * u64::from(instances) > u64::from(MAX_VERTICES) {
        return Err(format!("a draw of {vertices} vertices and {instances} instances is too large"));
    }
    Ok(())
}

fn factor(name: Option<&str>) -> Fail<wgpu::BlendFactor> {
    Ok(match name.unwrap_or("one") {
        "zero" => wgpu::BlendFactor::Zero,
        "one" => wgpu::BlendFactor::One,
        "src" => wgpu::BlendFactor::Src,
        "one-minus-src" => wgpu::BlendFactor::OneMinusSrc,
        "src-alpha" => wgpu::BlendFactor::SrcAlpha,
        "one-minus-src-alpha" => wgpu::BlendFactor::OneMinusSrcAlpha,
        "dst" => wgpu::BlendFactor::Dst,
        "one-minus-dst" => wgpu::BlendFactor::OneMinusDst,
        "dst-alpha" => wgpu::BlendFactor::DstAlpha,
        "one-minus-dst-alpha" => wgpu::BlendFactor::OneMinusDstAlpha,
        "src-alpha-saturated" => wgpu::BlendFactor::SrcAlphaSaturated,
        "constant" => wgpu::BlendFactor::Constant,
        "one-minus-constant" => wgpu::BlendFactor::OneMinusConstant,
        other => return Err(format!("blend factor {other}")),
    })
}

fn component(c: &wg::BlendComponent) -> Fail<wgpu::BlendComponent> {
    Ok(wgpu::BlendComponent {
        src_factor: factor(c.src_factor.as_deref())?,
        dst_factor: match c.dst_factor.as_deref() {
            None => wgpu::BlendFactor::Zero,
            other => factor(other)?,
        },
        operation: match c.operation.as_deref().unwrap_or("add") {
            "add" => wgpu::BlendOperation::Add,
            "subtract" => wgpu::BlendOperation::Subtract,
            "reverse-subtract" => wgpu::BlendOperation::ReverseSubtract,
            "min" => wgpu::BlendOperation::Min,
            "max" => wgpu::BlendOperation::Max,
            other => return Err(format!("blend operation {other}")),
        },
    })
}

fn blend_state(b: &wg::BlendState) -> Fail<wgpu::BlendState> {
    Ok(wgpu::BlendState {
        color: component(&b.color)?,
        alpha: component(&b.alpha)?,
    })
}

fn vertex_format(name: &str) -> Fail<wgpu::VertexFormat> {
    use wgpu::VertexFormat as F;
    Ok(match name {
        "uint8x2" => F::Uint8x2,
        "uint8x4" => F::Uint8x4,
        "sint8x2" => F::Sint8x2,
        "sint8x4" => F::Sint8x4,
        "unorm8x2" => F::Unorm8x2,
        "unorm8x4" => F::Unorm8x4,
        "snorm8x2" => F::Snorm8x2,
        "snorm8x4" => F::Snorm8x4,
        "uint16x2" => F::Uint16x2,
        "uint16x4" => F::Uint16x4,
        "sint16x2" => F::Sint16x2,
        "sint16x4" => F::Sint16x4,
        "unorm16x2" => F::Unorm16x2,
        "unorm16x4" => F::Unorm16x4,
        "snorm16x2" => F::Snorm16x2,
        "snorm16x4" => F::Snorm16x4,
        "float16x2" => F::Float16x2,
        "float16x4" => F::Float16x4,
        "float32" => F::Float32,
        "float32x2" => F::Float32x2,
        "float32x3" => F::Float32x3,
        "float32x4" => F::Float32x4,
        "uint32" => F::Uint32,
        "uint32x2" => F::Uint32x2,
        "uint32x3" => F::Uint32x3,
        "uint32x4" => F::Uint32x4,
        "sint32" => F::Sint32,
        "sint32x2" => F::Sint32x2,
        "sint32x3" => F::Sint32x3,
        "sint32x4" => F::Sint32x4,
        other => return Err(format!("vertex format {other}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_misaligned_or_outside_range_is_refused_not_a_panic() {
        assert_eq!(checked_range(64, 0, None, 4), Ok(64));
        assert_eq!(checked_range(64, 16, Some(16), 4), Ok(32));
        assert!(checked_range(64, 64, None, 4).unwrap_err().contains("empty"));
        assert!(checked_range(64, 8, Some(0), 4).unwrap_err().contains("empty"));
        assert!(checked_range(64, 2, Some(8), 4).unwrap_err().contains("multiple of 4"));
        assert!(checked_range(64, 2, Some(8), 2).is_ok());
        assert!(checked_range(64, 1, Some(8), 2).unwrap_err().contains("multiple of 2"));
        assert!(checked_range(64, 60, Some(8), 4).unwrap_err().contains("outside"));
        assert!(checked_range(64, 8, Some(u64::MAX), 4).unwrap_err().contains("overflows"));
    }

    #[test]
    fn a_scissor_and_a_viewport_are_checked_against_the_attachment() {
        assert!(check_scissor((8, 4), 0, 0, 8, 4).is_ok());
        assert!(check_scissor((8, 4), 7, 3, 1, 1).is_ok());
        assert!(check_scissor((8, 4), 7, 3, 2, 1).unwrap_err().contains("outside"));
        assert!(check_scissor((8, 4), 0, 0, 0, 1).unwrap_err().contains("empty"));
        assert!(check_scissor((8, 4), u32::MAX, 0, 2, 1).unwrap_err().contains("overflows"));
        assert!(check_viewport([0.0, 0.0, 8.0, 4.0, 0.0, 1.0]).is_ok());
        assert!(check_viewport([0.0, 0.0, 0.0, 4.0, 0.0, 1.0]).is_err());
        assert!(check_viewport([f32::NAN, 0.0, 8.0, 4.0, 0.0, 1.0]).is_err());
        assert!(check_viewport([0.0, 0.0, f32::INFINITY, 4.0, 0.0, 1.0]).is_err());
    }

    #[test]
    fn rows_are_padded_to_the_copy_alignment_and_only_whole_uploads_are_padded() {
        // Two texels of 4 bytes a row: 8 bytes, padded to 256.
        let (padded, row) = pad_rows(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 8, 2).unwrap();
        assert_eq!(row, 256);
        assert_eq!(padded.len(), 512);
        assert_eq!(&padded[..8], &[1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(&padded[256..264], &[9, 10, 11, 12, 13, 14, 15, 16]);
        assert!(padded[8..256].iter().all(|b| *b == 0));
        // A row of exactly 256 bytes needs none.
        assert_eq!(pad_rows(&[0; 512], 256, 2).unwrap().1, 256);
        assert!(pad_rows(&[0; 7], 8, 1).unwrap_err().contains("width x height"));
        assert!(pad_rows(&[], usize::MAX, 2).unwrap_err().contains("overflows"));
    }

    #[test]
    fn a_picture_is_cropped_turned_over_premultiplied_and_swizzled_in_that_order() {
        // 2 x 2: red, green / blue, half-transparent white.
        let rgba = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128];
        let texture = |format: &str| wg::Texture { width: 4, height: 4, mips: 1, format: format.into() };
        let upload = |x, y, w, h, flip_y, premultiply| wg::Upload {
            texture: "t".into(),
            mip: 0,
            x: 0,
            y: 0,
            width: w,
            height: h,
            source: Source::Layer(String::new()),
            sx: x,
            sy: y,
            flip_y,
            premultiply,
        };
        // The bottom row only.
        assert_eq!(picture_pixels(&rgba, (2, 2), &upload(0, 1, 2, 1, false, false), &texture("rgba8unorm")).unwrap(), rgba[8..]);
        // The right column, turned over: white then green.
        assert_eq!(
            picture_pixels(&rgba, (2, 2), &upload(1, 0, 1, 2, true, false), &texture("rgba8unorm")).unwrap(),
            [255, 255, 255, 128, 0, 255, 0, 255]
        );
        // Premultiplied: 255 * 128 / 255 rounds to 128.
        assert_eq!(picture_pixels(&rgba, (2, 2), &upload(1, 1, 1, 1, false, true), &texture("rgba8unorm")).unwrap(), [128, 128, 128, 128]);
        // bgra puts blue first.
        assert_eq!(picture_pixels(&rgba, (2, 2), &upload(0, 0, 1, 1, false, false), &texture("bgra8unorm")).unwrap(), [0, 0, 255, 255]);
        // Outside the picture, or with pixels that are not the size it says, is an error and not an index panic.
        assert!(picture_pixels(&rgba, (2, 2), &upload(1, 1, 2, 1, false, false), &texture("rgba8unorm")).unwrap_err().contains("outside"));
        assert!(picture_pixels(&rgba[..12], (2, 2), &upload(0, 0, 1, 1, false, false), &texture("rgba8unorm")).unwrap_err().contains("not its width"));
        assert!(picture_pixels(&rgba, (2, 2), &upload(u32::MAX, 0, 2, 1, false, false), &texture("rgba8unorm")).unwrap_err().contains("overflows"));
    }

    #[test]
    fn data_that_could_never_fit_is_refused_before_it_is_decoded() {
        assert!(decode_blob("AAAA").is_ok());
        assert!(decode_blob("!!!!").unwrap_err().contains("base64"));
        let huge = "A".repeat((wg::MAX_TEXTURE_BYTES / 3 * 4 + 8) as usize);
        assert!(decode_blob(&huge).unwrap_err().contains("bytes of data"));
    }

    #[test]
    fn the_formats_the_page_names_map_to_the_device_and_others_are_refused() {
        assert_eq!(texture_format("bgra8unorm-srgb"), Ok(wgpu::TextureFormat::Bgra8UnormSrgb));
        assert_eq!(texture_format("rgba16float"), Ok(wgpu::TextureFormat::Rgba16Float));
        assert!(texture_format("depth24plus").is_err());
        for name in wg::TEXTURE_FORMATS.replace(" and ", ", ").split(", ") {
            assert!(wg::texel_bytes(name).is_some() && texture_format(name).is_ok(), "{name}");
        }
    }
}
