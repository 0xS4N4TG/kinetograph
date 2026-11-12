import { describe, expect, it } from 'vitest';
import { createGpu, createGpuCanvasContext, GPU_SHADER_STAGE, GPU_TEXTURE_USAGE, WebGpuUnsupportedError, type GPUDeviceShim } from '../src/index.js';

const { RENDER_ATTACHMENT, TEXTURE_BINDING } = GPU_TEXTURE_USAGE;

async function setup(): Promise<GPUDeviceShim> {
  const adapter = await createGpu().requestAdapter();
  return adapter.requestDevice();
}

const faces = (device: GPUDeviceShim, count = 6, width = 4, height = 4) => device.createTexture({ size: [width, height, count], format: 'rgba8unorm', usage: RENDER_ATTACHMENT | TEXTURE_BINDING });

describe('cube texture views', () => {
  it('makes a cube view of six layers, and a cube-array view of a multiple of six', async () => {
    const device = await setup();
    expect(faces(device).createView({ dimension: 'cube' })).toMatchObject({ dimension: 'cube', baseLayer: 0, layers: 6 });
    expect(faces(device, 12).createView({ dimension: 'cube', baseArrayLayer: 6 })).toMatchObject({ baseLayer: 6, layers: 6 });
    expect(faces(device, 12).createView({ dimension: 'cube-array' })).toMatchObject({ dimension: 'cube-array', layers: 12 });
  });

  it('refuses a cube view of a texture or layer count that cannot be a cube', async () => {
    const device = await setup();
    expect(() => faces(device, 5).createView({ dimension: 'cube' })).toThrow(/layers 0..6 of a texture with 5/);
    expect(() => faces(device, 12).createView({ dimension: 'cube', arrayLayerCount: 5 })).toThrow(/six layers/);
    expect(() => faces(device, 8).createView({ dimension: 'cube-array' })).toThrow(/multiple of six/);
    expect(() => faces(device, 6, 4, 8).createView({ dimension: 'cube' })).toThrow(/square/);
    expect(() => faces(device).createView({ dimension: '1d' })).toThrow(WebGpuUnsupportedError);
  });

  it('binds a cube view to a cube layout entry and to nothing else, and says so in the recording', async () => {
    const device = await setup();
    const entry = (viewDimension?: string) => device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPU_SHADER_STAGE.FRAGMENT, texture: { viewDimension } }] } as never);
    const texture = faces(device);
    const view = texture.createView({ dimension: 'cube' });
    expect(() => device.createBindGroup({ layout: entry('2d-array'), entries: [{ binding: 0, resource: view }] })).toThrow(/is a 2d-array texture in the layout and the view is a cube view/);
    const layout = entry('cube');
    expect(layout.entries[0]).toMatchObject({ type: 'texture', viewDimension: 'cube' });
    const group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: view }] });
    expect(group.entries[0]).toMatchObject({ view });
    expect(entry('cube-array').entries[0]).toMatchObject({ viewDimension: 'cube-array' });
  });

  it('is a texture attachment of one layer only, never a cube view', async () => {
    const device = await setup();
    const texture = faces(device);
    const encoder = device.createCommandEncoder();
    expect(() => encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView({ dimension: 'cube' }), loadOp: 'clear', storeOp: 'store' }] })).toThrow(/one array layer/);
  });
});
