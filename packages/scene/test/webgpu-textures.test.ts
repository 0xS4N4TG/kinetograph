import { describe, expect, it } from 'vitest';
import {
  CANVAS_SOURCE,
  createGpu,
  createGpuCanvasContext,
  GPU_BUFFER_USAGE,
  GPU_SHADER_STAGE,
  GPU_TEXTURE_USAGE,
  ImageData,
  layerPicture,
  VIDEO_FRAME,
  WebGpuUnsupportedError,
  type GPUDeviceShim,
  type GPUCanvasContextShim,
  type GPUTextureShim,
  type WebGpuContent,
  type WebGpuUpload,
} from '../src/index.js';

const { COPY_DST, COPY_SRC, TEXTURE_BINDING, RENDER_ATTACHMENT } = GPU_TEXTURE_USAGE;
const ALL = COPY_DST | COPY_SRC | TEXTURE_BINDING | RENDER_ATTACHMENT;

const WGSL = `
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[i], 0, 1);
}
@fragment fn fs(@builtin(position) at: vec4f) -> @location(0) vec4f { return textureSample(tex, smp, at.xy / 8.0); }`;

async function setup(options: ConstructorParameters<typeof Object>[0] = {}): Promise<{ device: GPUDeviceShim; context: GPUCanvasContextShim }> {
  const gpu = createGpu(options as never);
  const adapter = await gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const context = createGpuCanvasContext({ size: () => ({ width: 8, height: 8 }) });
  context.configure({ device, format: 'rgba8unorm', alphaMode: 'premultiplied' });
  return { device, context };
}

function texture(device: GPUDeviceShim, extra: Partial<Parameters<GPUDeviceShim['createTexture']>[0]> = {}): GPUTextureShim {
  return device.createTexture({ size: [8, 4], format: 'rgba8unorm', usage: ALL, ...extra });
}

function uploads(content: WebGpuContent): WebGpuUpload[] {
  return content.passes.filter((p): p is WebGpuUpload => p.k === 'upload');
}

const px = (...bytes: number[]): Uint8Array => new Uint8Array(bytes);

describe('createTexture, createView and createSampler', () => {
  it('makes 2D textures of the formats that are drawn', async () => {
    const { device } = await setup();
    for (const format of ['rgba8unorm', 'rgba8unorm-srgb', 'bgra8unorm', 'bgra8unorm-srgb', 'r8unorm', 'rg8unorm', 'rgba16float']) {
      const t = device.createTexture({ size: { width: 4, height: 2 }, format, usage: TEXTURE_BINDING });
      expect(t).toMatchObject({ width: 4, height: 2, format, mipLevelCount: 1, dimension: '2d', sampleCount: 1 });
    }
  });

  it('refuses sizes, levels, formats and usages that are out of range', async () => {
    const { device } = await setup();
    const make = (descriptor: Partial<Parameters<GPUDeviceShim['createTexture']>[0]>) => () => texture(device, descriptor);
    expect(make({ size: [0, 4] })).toThrow(/sides run from 1 to 8192/);
    expect(make({ size: [8, 8193] })).toThrow(/sides run from 1/);
    expect(make({ size: [1.5, 4] })).toThrow(/not a whole number/);
    expect(make({ size: [-1, 4] })).toThrow(/not a whole number/);
    expect(make({ mipLevelCount: 0 })).toThrow(/not a whole number from 1/);
    expect(make({ mipLevelCount: 5 })).toThrow(/at most 4/);
    expect(make({ mipLevelCount: 4 })).not.toThrow();
    expect(make({ usage: 0 })).toThrow(/usage 0/);
    expect(make({ usage: 32 })).toThrow(/usage 32/);
    expect(make({ usage: -4 })).toThrow(/usage/);
  });

  it('says what is not drawn: formats, dimensions, layers, multisampling', async () => {
    const { device, context } = await setup();
    expect(() => texture(device, { format: 'depth24plus' })).toThrow(WebGpuUnsupportedError);
    expect(() => texture(device, { format: 'bc1-rgba-unorm' })).toThrow(/^unsupported: a texture of format bc1-rgba-unorm/);
    expect(() => texture(device, { format: 'rgba32float' })).not.toThrow();
    expect(() => texture(device, { dimension: '3d' })).toThrow(/3d texture/);
    expect(() => texture(device, { size: [8, 4, 2] })).toThrow(/array layer/);
    expect(() => texture(device, { sampleCount: 4 })).toThrow(/multisampled/);
    expect(() => texture(device, { viewFormats: ['rgba8unorm-srgb'] })).toThrow(/viewFormats/);
    expect(() => texture(device, { usage: GPU_TEXTURE_USAGE.STORAGE_BINDING })).not.toThrow();
    expect(() => texture(device, { usage: GPU_TEXTURE_USAGE.STORAGE_BINDING, format: 'rgba8unorm-srgb' })).toThrow(/STORAGE_BINDING/);
    expect(context.content().webgpu!.notes).toHaveLength(6);
  });

  it('holds all the levels of all the textures to a cap', async () => {
    const { device } = await setup();
    // 8192 x 8192 x 4 is 256 MiB: two fit, a third does not, and destroying one makes room.
    const a = device.createTexture({ size: [8192, 8192], format: 'rgba8unorm', usage: TEXTURE_BINDING });
    device.createTexture({ size: [8192, 8192], format: 'rgba8unorm', usage: TEXTURE_BINDING });
    expect(() => device.createTexture({ size: [8192, 8192], format: 'rgba8unorm', usage: TEXTURE_BINDING })).toThrow(/together would exceed/);
    a.destroy();
    expect(() => device.createTexture({ size: [8192, 8192], format: 'rgba8unorm', usage: TEXTURE_BINDING })).not.toThrow();
  });

  it('checks the levels of a view', async () => {
    const { device } = await setup();
    const t = texture(device, { mipLevelCount: 3 });
    expect(t.createView()).toMatchObject({ baseMip: 0, mips: 3 });
    expect(t.createView({ baseMipLevel: 1 })).toMatchObject({ baseMip: 1, mips: 2 });
    expect(t.createView({ baseMipLevel: 2, mipLevelCount: 1 })).toMatchObject({ baseMip: 2, mips: 1 });
    expect(() => t.createView({ baseMipLevel: 3 })).toThrow(/baseMipLevel 3/);
    expect(() => t.createView({ baseMipLevel: 1, mipLevelCount: 3 })).toThrow(/levels 1..4/);
    expect(() => t.createView({ mipLevelCount: 0 })).toThrow(/not a whole number from 1/);
    expect(() => t.createView({ baseMipLevel: -1 })).toThrow(/not a whole number/);
    expect(() => t.createView({ arrayLayerCount: 2 })).toThrow(/one layer/);
    expect(() => t.createView({ dimension: '2d-array' })).toThrow(WebGpuUnsupportedError);
    expect(() => t.createView({ format: 'rgba8unorm-srgb' })).toThrow(WebGpuUnsupportedError);
  });

  it('checks a sampler, and gives the same descriptor the same id', async () => {
    const { device } = await setup();
    expect(device.createSampler().id).toBe(device.createSampler({ addressModeU: 'clamp-to-edge', magFilter: 'nearest', lodMaxClamp: 32 }).id);
    expect(device.createSampler({ magFilter: 'linear' }).id).not.toBe(device.createSampler().id);
    expect(device.createSampler({ addressModeU: 'repeat', magFilter: 'linear' }).descriptor).toEqual({ addressModeU: 'repeat', magFilter: 'linear' });
    expect(() => device.createSampler({ addressModeV: 'wrap' })).toThrow(/addressModeV/);
    expect(() => device.createSampler({ minFilter: 'cubic' })).toThrow(/minFilter/);
    expect(() => device.createSampler({ lodMinClamp: -1 })).toThrow(/lodMinClamp/);
    expect(() => device.createSampler({ lodMinClamp: 4, lodMaxClamp: 2 })).toThrow(/lodMinClamp/);
    expect(() => device.createSampler({ lodMaxClamp: Infinity })).toThrow(/lodMaxClamp/);
    expect(() => device.createSampler({ maxAnisotropy: 0 })).toThrow(/maxAnisotropy/);
    expect(() => device.createSampler({ maxAnisotropy: 17, magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' })).toThrow(/more than 16/);
    expect(() => device.createSampler({ maxAnisotropy: 4 })).toThrow(/linear/);
    expect(() => device.createSampler({ maxAnisotropy: 4, magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' })).not.toThrow();
    expect(() => device.createSampler({ compare: 'less' })).toThrow(/comparison sampler/);
  });
});

describe('queue.writeTexture', () => {
  it('records the rows tightly packed, from the offset and the row stride it was given', async () => {
    const { device, context } = await setup();
    const t = texture(device);
    // 2 x 2 texels of 4 bytes in rows 12 bytes apart, from byte 4.
    const data = new Uint8Array(40).map((_, i) => i);
    device.queue.writeTexture({ texture: t, origin: [1, 2] }, data, { offset: 4, bytesPerRow: 12 }, [2, 2]);
    const content = context.content().webgpu!;
    const [up] = uploads(content);
    expect(up).toMatchObject({ texture: t.id, x: 1, y: 2, width: 2, height: 2 });
    const id = (up!.source as { raw: string }).raw;
    expect([...Buffer.from(content.blobs![id]!, 'base64')]).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23]);
    expect(content.textures![t.id]).toEqual({ width: 8, height: 4, mips: 1, format: 'rgba8unorm' });
  });

  it('writes a level above 0 and a texel format of another size', async () => {
    const { device, context } = await setup();
    const t = texture(device, { mipLevelCount: 3, format: 'rgba16float' });
    device.queue.writeTexture({ texture: t, mipLevel: 2 }, new Uint8Array(8), {}, [1, 1]);
    expect(uploads(context.content().webgpu!)[0]).toMatchObject({ mip: 2, width: 1, height: 1 });
    const r = device.createTexture({ size: [2, 2], format: 'r8unorm', usage: COPY_DST });
    device.queue.writeTexture({ texture: r }, new Uint8Array([1, 2, 3, 4]), { bytesPerRow: 2 }, { width: 2, height: 2 });
    expect(uploads(context.content().webgpu!)).toHaveLength(2);
  });

  it('checks the level, the origin, the rows and the data', async () => {
    const { device } = await setup();
    const t = texture(device, { mipLevelCount: 3 });
    const write = (destination: object, bytes: number, layout: object, size: unknown) => () =>
      device.queue.writeTexture({ texture: t, ...destination }, new Uint8Array(bytes), layout, size as never);
    expect(write({ mipLevel: 3 }, 4, {}, [1, 1])).toThrow(/mip level 3/);
    expect(write({ mipLevel: -1 }, 4, {}, [1, 1])).toThrow(/not a whole number/);
    expect(write({ origin: [8, 0] }, 4, {}, [1, 1])).toThrow(/outside the 8 x 4/);
    expect(write({ origin: [0, 3] }, 8, {}, [1, 2])).toThrow(/outside/);
    expect(write({ origin: [0, 0, 1] }, 4, {}, [1, 1])).toThrow(/one layer/);
    expect(write({ origin: [Number.MAX_SAFE_INTEGER, 0] }, 4, {}, [1, 1])).toThrow(/outside/);
    expect(write({ origin: [1.5, 0] }, 4, {}, [1, 1])).toThrow(/not a whole number/);
    expect(write({ mipLevel: 1 }, 100, {}, [5, 1])).toThrow(/outside the 4 x 2/);
    expect(write({}, 16, {}, [1, 2])).toThrow(/bytesPerRow is needed/);
    expect(write({}, 64, { bytesPerRow: 3 }, [2, 2])).toThrow(/less than the 8 bytes/);
    expect(write({}, 11, { bytesPerRow: 8 }, [2, 2])).toThrow(/reads past the 11 bytes/);
    expect(write({}, 15, { offset: 8 }, [2, 1])).toThrow(/reads past the 15 bytes/);
    expect(write({}, 16, { offset: 8, bytesPerRow: 8 }, [2, 1])).not.toThrow();
    expect(write({}, 4, {}, [1, 1, 2])).toThrow(/one layer/);
    // An empty copy is allowed and writes nothing.
    expect(write({}, 0, {}, [0, 1])).not.toThrow();
    const noCopy = device.createTexture({ size: [2, 2], format: 'rgba8unorm', usage: TEXTURE_BINDING });
    expect(() => device.queue.writeTexture({ texture: noCopy }, new Uint8Array(16), { bytesPerRow: 8 }, [2, 2])).toThrow(/COPY_DST/);
    t.destroy();
    expect(write({}, 4, {}, [1, 1])).toThrow(/destroyed/);
    expect(() => device.queue.writeTexture({ texture: {} as never }, new Uint8Array(4), {}, [1, 1])).toThrow(/not a GPUTexture/);
  });

  it('keeps one copy of the same bytes', async () => {
    const { device, context } = await setup();
    const a = texture(device);
    const b = texture(device);
    const bytes = new Uint8Array(8 * 4 * 4).fill(7);
    for (const t of [a, b]) device.queue.writeTexture({ texture: t }, bytes, { bytesPerRow: 32 }, [8, 4]);
    const content = context.content().webgpu!;
    expect(Object.keys(content.blobs!)).toHaveLength(1);
    expect(uploads(content)).toHaveLength(2);
  });
});

describe('copyBufferToTexture and copyTextureToTexture', () => {
  it('copies the bytes the buffer held when the command buffer was submitted', async () => {
    const { device, context } = await setup();
    const t = texture(device);
    const buffer = device.createBuffer({ size: 512, usage: GPU_BUFFER_USAGE.COPY_SRC | GPU_BUFFER_USAGE.COPY_DST });
    device.queue.writeBuffer(buffer, 0, new Uint8Array(512).fill(1));
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToTexture({ buffer, offset: 4, bytesPerRow: 256 }, { texture: t, origin: [1, 0] }, [2, 2]);
    const commands = encoder.finish();
    // Written after the encoder recorded the copy, before the submit: the submit's bytes are the ones copied.
    device.queue.writeBuffer(buffer, 0, new Uint8Array(512).fill(9));
    device.queue.submit([commands]);
    const content = context.content().webgpu!;
    const [up] = uploads(content);
    expect(up).toMatchObject({ x: 1, y: 0, width: 2, height: 2 });
    expect([...Buffer.from(content.blobs![(up!.source as { raw: string }).raw]!, 'base64')]).toEqual(new Array(16).fill(9));
  });

  it('checks the rows, the offset and the buffer of a copy from a buffer', async () => {
    const { device } = await setup();
    const t = texture(device);
    const buffer = device.createBuffer({ size: 600, usage: GPU_BUFFER_USAGE.COPY_SRC });
    const copy = (source: object, destination: object, size: unknown) => () =>
      device.createCommandEncoder().copyBufferToTexture({ buffer, ...source }, { texture: t, ...destination }, size as never);
    expect(copy({ bytesPerRow: 256 }, {}, [2, 2])).not.toThrow();
    expect(copy({}, {}, [2, 1])).not.toThrow();
    expect(copy({}, {}, [2, 2])).toThrow(/bytesPerRow is needed/);
    expect(copy({ bytesPerRow: 128 }, {}, [2, 2])).toThrow(/multiple of 256/);
    expect(copy({ bytesPerRow: 0 }, {}, [2, 1])).toThrow(/less than the 8 bytes/);
    expect(copy({ offset: 2 }, {}, [2, 1])).toThrow(/multiple of the texel size 4/);
    expect(copy({ offset: 600 }, {}, [1, 1])).toThrow(/past the 600 bytes/);
    expect(copy({ offset: 4, bytesPerRow: 256 }, {}, [2, 4])).toThrow(/past the 600 bytes/);
    expect(copy({ offset: Number.MAX_SAFE_INTEGER - 3 }, {}, [1, 1])).toThrow(/past/);
    expect(copy({}, { mipLevel: 1 }, [1, 1])).toThrow(/mip level 1/);
    expect(copy({}, { origin: [7, 0] }, [2, 1])).toThrow(/outside/);
    expect(copy({}, { origin: [0, 4] }, [1, 1])).toThrow(/outside/);
    const noSrc = device.createBuffer({ size: 600, usage: GPU_BUFFER_USAGE.COPY_DST });
    expect(() => device.createCommandEncoder().copyBufferToTexture({ buffer: noSrc }, { texture: t }, [1, 1])).toThrow(/COPY_SRC/);
    expect(() => device.createCommandEncoder().copyTextureToBuffer()).toThrow(WebGpuUnsupportedError);
  });

  it('copies between textures and levels, with the step in the order the queue ran it', async () => {
    const { device, context } = await setup();
    const a = texture(device, { mipLevelCount: 2 });
    const b = texture(device, { format: 'rgba8unorm-srgb' });
    device.queue.writeTexture({ texture: a }, new Uint8Array(128), { bytesPerRow: 32 }, [8, 4]);
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToTexture({ texture: a }, { texture: b, origin: [0, 1] }, [8, 3]);
    encoder.copyTextureToTexture({ texture: a }, { texture: a, mipLevel: 1 }, [4, 2]);
    device.queue.submit([encoder.finish()]);
    const steps = context.content().webgpu!.passes;
    expect(steps.map((s) => s.k)).toEqual(['upload', 'copy', 'copy']);
    expect(steps[1]).toMatchObject({ from: { texture: a.id, x: 0, y: 0 }, to: { texture: b.id, y: 1 }, width: 8, height: 3 });
    expect(steps[2]).toMatchObject({ to: { texture: a.id, mip: 1 }, width: 4, height: 2 });
  });

  it('checks both ends of a copy between textures', async () => {
    const { device } = await setup();
    const a = texture(device, { mipLevelCount: 3 });
    const b = texture(device);
    const copy = (source: object, destination: object, size: unknown, from = a, to = b) => () =>
      device.createCommandEncoder().copyTextureToTexture({ texture: from, ...source }, { texture: to, ...destination }, size as never);
    expect(copy({}, {}, [8, 4])).not.toThrow();
    expect(copy({}, {}, [9, 4])).toThrow(/outside the 8 x 4/);
    expect(copy({ origin: [1, 0] }, {}, [8, 4])).toThrow(/source rectangle/);
    expect(copy({}, { origin: [0, 1] }, [8, 4])).toThrow(/destination rectangle/);
    expect(copy({ mipLevel: 3 }, {}, [1, 1])).toThrow(/mip level 3/);
    expect(copy({ mipLevel: 2 }, {}, [3, 1])).toThrow(/outside the 2 x 1/);
    expect(copy({ origin: [Number.MAX_SAFE_INTEGER, 0] }, {}, [1, 1])).toThrow(/outside/);
    expect(copy({}, {}, [1, 1], a, a)).toThrow(/one level of one texture/);
    expect(copy({ mipLevel: 1 }, { mipLevel: 2 }, [1, 1], a, a)).not.toThrow();
    expect(copy({}, {}, [1, 1], a, texture(device, { format: 'bgra8unorm' }))).toThrow(/differ by more than -srgb/);
    expect(copy({}, {}, [1, 1], texture(device, { usage: COPY_DST }), b)).toThrow(/COPY_SRC/);
    expect(copy({}, {}, [1, 1], a, texture(device, { usage: COPY_SRC }))).toThrow(/COPY_DST/);
  });
});

describe('queue.copyExternalImageToTexture', () => {
  const external = (source: unknown, extra: object = {}) => ({ source, ...extra });

  it('records the pixels of ImageData by content, with the rectangle, flipY and premultiplied alpha it was given', async () => {
    const { device, context } = await setup();
    const t = texture(device);
    const image = new ImageData(new Uint8ClampedArray(4 * 4 * 4).fill(200), 4, 4);
    device.queue.copyExternalImageToTexture(external(image, { origin: [1, 2], flipY: true }), { texture: t, origin: [3, 1], premultipliedAlpha: true }, [2, 2]);
    const content = context.content().webgpu!;
    const [up] = uploads(content);
    expect(up).toMatchObject({ texture: t.id, x: 3, y: 1, width: 2, height: 2, sx: 1, sy: 2, flipY: true, premultiply: true });
    const source = up!.source as { pixels: { id: string; width: number; height: number } };
    expect(source.pixels).toMatchObject({ width: 4, height: 4 });
    expect(Buffer.from(content.blobs![source.pixels.id]!, 'base64')).toHaveLength(64);
  });

  it('records an image by its file, a video by its file and instant, and a layer by its id', async () => {
    const { device, context } = await setup();
    const image = { width: 16, height: 8, [CANVAS_SOURCE]: () => ({ source: { kind: 'src', src: '/p/a.png' }, width: 16, height: 8 }) };
    device.queue.copyExternalImageToTexture(external(image), { texture: texture(device) }, [8, 4]);
    const video = { [VIDEO_FRAME]: () => ({ src: '/p/v.mp4', time: 1.25, width: 640, height: 360 }) };
    device.queue.copyExternalImageToTexture(external(video), { texture: texture(device) }, [8, 4]);
    device.queue.copyExternalImageToTexture(external(layerPicture('child', 8, 4)), { texture: texture(device) }, [8, 4]);
    const steps = uploads(context.content().webgpu!);
    expect(steps.map((s) => s.source)).toEqual([{ src: '/p/a.png' }, { video: { src: '/p/v.mp4', time: 1.25 } }, { layer: 'child' }]);
  });

  it('draws a 2D canvas through the rasteriser it was given, and says when it has none', async () => {
    const canvas = { width: 2, height: 2, [CANVAS_SOURCE]: () => ({ source: { kind: 'canvas', width: 2, height: 2, commands: [] }, width: 2, height: 2 }) };
    const { device, context } = await setup({ rasterize: () => new Uint8Array(16).fill(5) });
    device.queue.copyExternalImageToTexture(external(canvas), { texture: texture(device) }, [2, 2]);
    const content = context.content().webgpu!;
    const source = uploads(content)[0]!.source as { pixels: { id: string } };
    expect([...Buffer.from(content.blobs![source.pixels.id]!, 'base64')]).toEqual(new Array(16).fill(5));
    const bare = await setup();
    expect(() => bare.device.queue.copyExternalImageToTexture(external(canvas), { texture: texture(bare.device) }, [2, 2])).toThrow(/need the addon/);
  });

  it('checks the source rectangle, the destination and the usage', async () => {
    const { device } = await setup();
    const t = texture(device);
    const image = new ImageData(new Uint8ClampedArray(4 * 4 * 4), 4, 4);
    const copy = (source: object, destination: object, size: unknown) => () =>
      device.queue.copyExternalImageToTexture(external(image, source), { texture: t, ...destination }, size as never);
    expect(copy({}, {}, [4, 4])).not.toThrow();
    expect(copy({}, {}, [5, 1])).toThrow(/source rectangle/);
    expect(copy({ origin: [1, 0] }, {}, [4, 1])).toThrow(/source rectangle/);
    expect(copy({ origin: [0, 3] }, {}, [1, 2])).toThrow(/source rectangle/);
    expect(copy({ origin: [Number.MAX_SAFE_INTEGER, 0] }, {}, [1, 1])).toThrow(/source rectangle/);
    expect(copy({ origin: [-1, 0] }, {}, [1, 1])).toThrow(/not a whole number/);
    expect(copy({}, { origin: [5, 0] }, [4, 1])).toThrow(/destination rectangle/);
    expect(copy({}, { mipLevel: 1 }, [1, 1])).toThrow(/mip level 1/);
    expect(copy({}, { colorSpace: 'display-p3' }, [1, 1])).toThrow(WebGpuUnsupportedError);
    expect(() => device.queue.copyExternalImageToTexture(external(image), { texture: texture(device, { format: 'r8unorm' }) }, [1, 1])).toThrow(/r8unorm texture/);
    expect(() => device.queue.copyExternalImageToTexture(external(image), { texture: texture(device, { usage: COPY_DST | TEXTURE_BINDING }) }, [1, 1])).toThrow(/RENDER_ATTACHMENT/);
    expect(() => device.queue.copyExternalImageToTexture(external(image), { texture: texture(device, { usage: RENDER_ATTACHMENT }) }, [1, 1])).toThrow(/COPY_DST/);
    expect(() => device.queue.copyExternalImageToTexture(external({}), { texture: t }, [1, 1])).toThrow(/use an image/);
    expect(() => device.queue.copyExternalImageToTexture(external(null), { texture: t }, [1, 1])).toThrow(/from null/);
    expect(() => device.queue.copyExternalImageToTexture(external({ [VIDEO_FRAME]: () => ({ src: 'v.mp4', time: 0, width: 0, height: 0 }) }), { texture: t }, [1, 1])).toThrow(/video has no size/);
  });
});

describe('render passes into textures and sampling them', () => {
  async function twoPass(device: GPUDeviceShim, context: GPUCanvasContextShim, offscreen: GPUTextureShim, time = 0) {
    const module = device.createShaderModule({ code: WGSL });
    const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module }, fragment: { module, targets: [{ format: 'rgba8unorm' }] } });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: offscreen.createView() },
        { binding: 1, resource: sampler },
      ],
    });
    const encoder = device.createCommandEncoder();
    const first = encoder.beginRenderPass({ colorAttachments: [{ view: offscreen.createView(), loadOp: 'clear', clearValue: [time, 0, 0, 1], storeOp: 'store' }] });
    first.end();
    const second = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
    second.setPipeline(pipeline);
    second.setBindGroup(0, group);
    second.draw(3);
    second.end();
    device.queue.submit([encoder.finish()]);
  }

  it('records the pass into the texture before the pass that samples it, with the view and the sampler', async () => {
    const { device, context } = await setup();
    const offscreen = texture(device, { size: [8, 8] });
    await twoPass(device, context, offscreen);
    const content = context.content().webgpu!;
    expect(content.passes.map((p) => (p.k === 'render' ? (p.target ? 'texture' : 'canvas') : p.k))).toEqual(['texture', 'canvas']);
    expect(content.passes[0]).toMatchObject({ k: 'render', target: { texture: offscreen.id, mip: 0 }, clear: [0, 0, 0, 1] });
    const canvasPass = content.passes[1]!;
    if (canvasPass.k !== 'render') throw new Error('not a pass');
    const bind = canvasPass.commands.find((c) => c.c === 'bind')!;
    if (bind.c !== 'bind') throw new Error('not a bind');
    expect(content.bindGroups[bind.group]!.entries).toEqual([
      { binding: 0, texture: { id: offscreen.id, baseMip: 0, mips: 1 } },
      { binding: 1, sampler: expect.stringMatching(/^s/) },
    ]);
    expect(content.bindGroups[bind.group]!.layout).toMatch(/^auto:p/);
    expect(Object.values(content.samplers!)).toEqual([{ magFilter: 'linear', minFilter: 'linear' }]);
    expect(Object.keys(content.textures!)).toEqual([offscreen.id]);
  });

  it('a texture drawn again each frame stays one pass, and the frame is the same alone and after other frames', async () => {
    const sequence = await setup();
    const t = texture(sequence.device, { size: [8, 8] });
    for (const time of [0.1, 0.2, 0.3, 0.4, 0.5]) {
      sequence.context.resetState();
      await twoPass(sequence.device, sequence.context, t, time);
    }
    expect(sequence.context.content().webgpu!.passes).toHaveLength(2);
    const alone = await setup();
    await twoPass(alone.device, alone.context, texture(alone.device, { size: [8, 8] }), 0.5);
    expect(JSON.stringify(sequence.context.content())).toBe(JSON.stringify(alone.context.content()));
  });

  it('keeps what an earlier frame wrote into a texture that a later frame only samples', async () => {
    const { device, context } = await setup();
    const t = texture(device, { size: [8, 8] });
    // Frame 0 draws the texture and samples it; frame 1 only samples.
    await twoPass(device, context, t, 0.25);
    context.resetState();
    const module = device.createShaderModule({ code: WGSL });
    const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module }, fragment: { module, targets: [{ format: 'rgba8unorm' }] } });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: t.createView() }, { binding: 1, resource: device.createSampler() }] }));
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    const steps = context.content().webgpu!.passes;
    expect(steps.map((s) => s.k)).toEqual(['render', 'render']);
    expect(steps[0]).toMatchObject({ target: { texture: t.id }, clear: [0.25, 0, 0, 1] });
  });

  it('drops a step that a later whole write covered, and keeps one that something read, or that is a partial write', async () => {
    const { device, context } = await setup();
    const a = texture(device, { size: [4, 4] });
    const b = texture(device, { size: [4, 4] });
    const write = (t: GPUTextureShim, size: [number, number] = [4, 4]) => device.queue.writeTexture({ texture: t }, new Uint8Array(size[0] * size[1] * 4), { bytesPerRow: size[0] * 4 }, size);
    write(a);
    write(a);
    expect(uploads(context.content().webgpu!)).toHaveLength(1);
    // A copy read the first write: it stays, and so does the one it read.
    write(b);
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToTexture({ texture: b }, { texture: a }, [4, 4]);
    device.queue.submit([encoder.finish()]);
    write(b);
    // The copy covered the first write of a; the second write of b leaves the first, which the copy read.
    expect(context.content().webgpu!.passes.map((s) => s.k)).toEqual(['upload', 'copy', 'upload']);
    // A partial write does not cover.
    write(a, [2, 2]);
    expect(uploads(context.content().webgpu!)).toHaveLength(3);
  });

  it('refuses a pass whose texture, level or pipeline do not fit', async () => {
    const { device } = await setup();
    const module = device.createShaderModule({ code: WGSL });
    const pipeline = (format: string) => device.createRenderPipeline({ layout: 'auto', vertex: { module }, fragment: { module, targets: [{ format }] } });
    const begin = (view: unknown) => () => device.createCommandEncoder().beginRenderPass({ colorAttachments: [{ view: view as never, loadOp: 'clear', storeOp: 'store' }] });
    const t = texture(device, { mipLevelCount: 2 });
    expect(begin(t.createView({ mipLevelCount: 1 }))).not.toThrow();
    expect(begin(t.createView())).toThrow(/one mip level/);
    expect(begin(texture(device, { usage: TEXTURE_BINDING }).createView())).toThrow(/RENDER_ATTACHMENT/);
    const gone = texture(device);
    gone.destroy();
    expect(begin(gone.createView())).toThrow(/destroyed/);
    expect(begin({})).toThrow(/no view/);
    const pass = device.createCommandEncoder().beginRenderPass({ colorAttachments: [{ view: texture(device).createView(), loadOp: 'clear', storeOp: 'store' }] });
    expect(() => pass.setPipeline(pipeline('bgra8unorm'))).toThrow(/draws bgra8unorm and the pass draws into a rgba8unorm/);
    expect(() => pass.setPipeline(pipeline('rgba8unorm'))).not.toThrow();
    expect(() => pass.setScissorRect(0, 0, 9, 4)).toThrow(/outside the 8 x 4/);
    expect(() => pass.setScissorRect(7, 3, 2, 1)).toThrow(/outside/);
    expect(() => pass.setScissorRect(-1, 0, 1, 1)).toThrow(/not a whole number/);
    expect(() => pass.setScissorRect(0, 0, 8, 4)).not.toThrow();
  });

  it('refuses a pass that samples the level it draws into, and a canvas texture that is bound', async () => {
    const { device, context } = await setup();
    const t = texture(device, { size: [8, 8] });
    const module = device.createShaderModule({ code: WGSL });
    const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module }, fragment: { module, targets: [{ format: 'rgba8unorm' }] } });
    const group = (view: unknown) =>
      device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: view as never }, { binding: 1, resource: device.createSampler() }] });
    const pass = device.createCommandEncoder().beginRenderPass({ colorAttachments: [{ view: t.createView(), loadOp: 'clear', storeOp: 'store' }] });
    expect(() => pass.setBindGroup(0, group(t.createView()))).toThrow(/samples the level/);
    expect(() => group(context.getCurrentTexture().createView())).toThrow(WebGpuUnsupportedError);
    const noBinding = texture(device, { usage: RENDER_ATTACHMENT });
    expect(() => group(noBinding.createView())).toThrow(/TEXTURE_BINDING/);
  });

  it('checks the entries of a bind group against the layout the page made', async () => {
    const { device } = await setup();
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPU_SHADER_STAGE.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPU_SHADER_STAGE.FRAGMENT, sampler: { type: 'non-filtering' } },
      ],
    });
    expect(layout.entries).toEqual([
      { binding: 0, visibility: 2, type: 'texture' },
      { binding: 1, visibility: 2, type: 'sampler', samplerType: 'non-filtering' },
    ]);
    const view = texture(device).createView();
    const sampler = device.createSampler();
    expect(() => device.createBindGroup({ layout, entries: [{ binding: 0, resource: view }, { binding: 1, resource: sampler }] })).not.toThrow();
    expect(() => device.createBindGroup({ layout, entries: [{ binding: 0, resource: sampler }, { binding: 1, resource: view }] })).toThrow(/binding 0 is a texture/);
    expect(() => device.createBindGroup({ layout, entries: [{ binding: 0, resource: view }] })).toThrow(/binding 1 is a sampler/);
    expect(() => device.createBindGroup({ layout, entries: [{ binding: 0, resource: view }, { binding: 1, resource: sampler }, { binding: 2, resource: sampler }] })).toThrow(/no binding 2/);
    expect(() => device.createBindGroup({ layout, entries: [{ binding: 0, resource: {} as never }, { binding: 1, resource: sampler }] })).toThrow(/not a buffer binding/);
  });

  it('says what a layout may not hold', async () => {
    const { device } = await setup();
    const layout = (entry: object) => () => device.createBindGroupLayout({ entries: [{ binding: 0, visibility: 2, ...entry }] as never });
    expect(layout({ storageTexture: { format: 'rgba8unorm', viewDimension: '2d-array' } })).toThrow(WebGpuUnsupportedError);
    expect(layout({ externalTexture: {} })).toThrow(WebGpuUnsupportedError);
    expect(layout({ texture: { viewDimension: '2d-array' } })).toThrow(/view dimension/);
    expect(layout({ texture: { multisampled: true } })).toThrow(/multisampled/);
    expect(layout({ texture: { sampleType: 'depth' } })).toThrow(/sample type depth/);
    expect(layout({ sampler: { type: 'comparison' } })).toThrow(/comparison/);
    expect(layout({ texture: {}, sampler: {} })).toThrow(/exactly one/);
    expect(layout({})).toThrow(/exactly one/);
    expect(layout({ texture: { sampleType: 'unfilterable-float' } })).not.toThrow();
    expect(() => device.importExternalTexture()).toThrow(/copyExternalImageToTexture/);
  });
});
