import { describe, expect, it } from 'vitest';
import {
  createGpu,
  createGpuCanvasContext,
  GPU_BUFFER_USAGE,
  type GPUDeviceShim,
  type GPUCanvasContextShim,
  type WebGpuPass,
} from '../src/index.js';

const WGSL = `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[i], 0.5, 1);
}
struct U { v: vec4f }
@group(0) @binding(0) var<uniform> u: U;
@fragment fn fs() -> @location(0) vec4f { return u.v; }`;

async function setup(): Promise<{ device: GPUDeviceShim; context: GPUCanvasContextShim }> {
  const adapter = await createGpu().requestAdapter();
  const device = await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] });
  const context = createGpuCanvasContext({ size: () => ({ width: 8, height: 8 }) });
  context.configure({ device, format: 'rgba8unorm', alphaMode: 'premultiplied' });
  return { device, context };
}

const { QUERY_RESOLVE, COPY_SRC, UNIFORM, COPY_DST } = GPU_BUFFER_USAGE;

/** A pass over the canvas that draws one triangle with the colour in `colour`, with `extra` in its descriptor. */
function draw(device: GPUDeviceShim, context: GPUCanvasContextShim, colour: GPUBufferLike, extra: object, inside?: (pass: never) => void) {
  const module = device.createShaderModule({ code: WGSL });
  const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module }, fragment: { module, targets: [{ format: 'rgba8unorm' }] } });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    ...extra,
  } as never);
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: colour } }] }));
  inside?.(pass as never);
  pass.draw(3);
  pass.end();
  return { encoder, submit: () => device.queue.submit([encoder.finish()]) };
}

type GPUBufferLike = ReturnType<GPUDeviceShim['createBuffer']>;

function colourBuffer(device: GPUDeviceShim): GPUBufferLike {
  const buffer = device.createBuffer({ size: 16, usage: UNIFORM | COPY_DST });
  device.queue.writeBuffer(buffer, 0, new Float32Array([1, 0, 0, 1]));
  return buffer;
}

describe('query sets', () => {
  it('accepts occlusion and timestamp sets, and a pass that uses them draws as it would without', async () => {
    const { device, context } = await setup();
    const occlusion = device.createQuerySet({ type: 'occlusion', count: 4 });
    const timestamps = device.createQuerySet({ type: 'timestamp', count: 2 });
    expect(occlusion).toMatchObject({ type: 'occlusion', count: 4 });
    const { submit } = draw(device, context, colourBuffer(device), { occlusionQuerySet: occlusion, timestampWrites: { querySet: timestamps, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } }, (pass: any) => {
      pass.beginOcclusionQuery(2);
      pass.endOcclusionQuery();
    });
    submit();
    const webgpu = context.content().webgpu!;
    expect(webgpu.notes).toBeUndefined();
    const pass = webgpu.passes[0] as WebGpuPass;
    expect(pass.commands.map((c) => c.c)).toEqual(['pipeline', 'bind', 'draw']);
  });

  it('writes zeros where it resolves, in the order the queue ran it', async () => {
    const { device, context } = await setup();
    const timestamps = device.createQuerySet({ type: 'timestamp', count: 4 });
    const destination = device.createBuffer({ size: 16, usage: QUERY_RESOLVE | COPY_SRC | UNIFORM | COPY_DST });
    device.queue.writeBuffer(destination, 0, new Float32Array([1, 1, 1, 1]));
    const encoder = device.createCommandEncoder();
    encoder.resolveQuerySet(timestamps, 0, 1, destination, 0);
    device.queue.submit([encoder.finish()]);
    // The destination now reads as the colour of the triangle: 8 bytes of zeros, then the 1.0 that was there.
    draw(device, context, destination, {}).submit();
    const webgpu = context.content().webgpu!;
    const bytes = Buffer.from(Object.values(webgpu.buffers)[0]!, 'base64');
    expect([...new Float32Array(bytes.buffer, bytes.byteOffset, 4)]).toEqual([0, 0, 1, 1]);
  });

  it('refuses what a browser refuses', async () => {
    const { device } = await setup();
    expect(() => device.createQuerySet({ type: 'pipeline-statistics', count: 1 } as never)).toThrow(/type/);
    expect(() => device.createQuerySet({ type: 'occlusion', count: 0 })).toThrow(/count/);
    expect(() => device.createQuerySet({ type: 'occlusion', count: 4097 })).toThrow(/count/);
    const plain = await (await createGpu().requestAdapter()).requestDevice();
    expect(() => plain.createQuerySet({ type: 'timestamp', count: 1 })).toThrow(/timestamp-query/);
    const set = device.createQuerySet({ type: 'timestamp', count: 2 });
    const buffer = device.createBuffer({ size: 4096, usage: QUERY_RESOLVE });
    const encoder = device.createCommandEncoder();
    expect(() => encoder.resolveQuerySet(set, 1, 2, buffer, 0)).toThrow(/query/);
    expect(() => encoder.resolveQuerySet(set, 0, 2, buffer, 8)).toThrow(/256/);
    expect(() => encoder.resolveQuerySet(set, 0, 2, device.createBuffer({ size: 16, usage: COPY_SRC }), 0)).toThrow(/QUERY_RESOLVE/);
    expect(() => encoder.resolveQuerySet(set, 0, 2, device.createBuffer({ size: 8, usage: QUERY_RESOLVE }), 0)).toThrow(/past the end/);
  });

  it('checks a pass the way the spec does', async () => {
    const { device, context } = await setup();
    const colour = colourBuffer(device);
    const occlusion = device.createQuerySet({ type: 'occlusion', count: 2 });
    const timestamps = device.createQuerySet({ type: 'timestamp', count: 2 });
    expect(() => draw(device, context, colour, { occlusionQuerySet: timestamps })).toThrow(/occlusion/);
    expect(() => draw(device, context, colour, { timestampWrites: { querySet: occlusion, endOfPassWriteIndex: 0 } })).toThrow(/timestamp/);
    expect(() => draw(device, context, colour, { timestampWrites: { querySet: timestamps, endOfPassWriteIndex: 2 } })).toThrow(/index/);
    expect(() => draw(device, context, colour, { timestampWrites: { querySet: timestamps, beginningOfPassWriteIndex: 1, endOfPassWriteIndex: 1 } })).toThrow(/same/);
    expect(() => draw(device, context, colour, { occlusionQuerySet: occlusion }, (pass: any) => pass.beginOcclusionQuery(2))).toThrow(/index/);
    expect(() => draw(device, context, colour, {}, (pass: any) => pass.beginOcclusionQuery(0))).toThrow(/occlusionQuerySet/);
    expect(() => draw(device, context, colour, { occlusionQuerySet: occlusion }, (pass: any) => pass.endOcclusionQuery())).toThrow(/begin/);
    expect(() =>
      draw(device, context, colour, { occlusionQuerySet: occlusion }, (pass: any) => {
        pass.beginOcclusionQuery(0);
        pass.beginOcclusionQuery(1);
      }),
    ).toThrow(/already/);
    // A query left open when the pass ends is an error of the pass.
    expect(() => draw(device, context, colour, { occlusionQuerySet: occlusion }, (pass: any) => pass.beginOcclusionQuery(0))).toThrow(/still open/);
  });

  it('records writeTimestamp of the command encoder as an accepted call', async () => {
    const { device } = await setup();
    const set = device.createQuerySet({ type: 'timestamp', count: 2 });
    const encoder = device.createCommandEncoder();
    encoder.writeTimestamp(set, 1);
    expect(() => encoder.writeTimestamp(set, 2)).toThrow(/index/);
    expect(() => encoder.writeTimestamp(device.createQuerySet({ type: 'occlusion', count: 1 }), 0)).toThrow(/timestamp/);
    const pass = encoder.beginComputePass({ timestampWrites: { querySet: set, beginningOfPassWriteIndex: 0 } });
    pass.end();
    expect(device.notes.size).toBe(0);
  });
});
