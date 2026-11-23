// A Remotion-style project with two devices: the first draws a canvas every frame, the second has no canvas, so nothing waits for its
// work. At frame 5 the page makes an invalid buffer on the second, in the last step the frame waits for (after its queue's work is done):
// a validation error nobody catches, which the library says after the frame has been waited for. It belongs to frame 5 all the same:
// `--strict` names frame 5, also when that is the last frame drawn (WebGPU through Dawn).
import React, { useLayoutEffect, useRef, useState } from 'react';
import { Composition, continueRender, delayRender, registerRoot, useCurrentFrame } from 'remotion';

const SIZE = 32;

const Scene = () => {
  const frame = useCurrentFrame();
  const canvas = useRef<HTMLCanvasElement>(null);
  const gpu = useRef<any>(null);
  const [handle] = useState(() => delayRender('webgpu devices'));
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    void (async () => {
      const gpuApi = (navigator as any).gpu;
      const device = await (await gpuApi.requestAdapter()).requestDevice();
      const other = await (await gpuApi.requestAdapter()).requestDevice();
      const context = canvas.current!.getContext('webgpu') as any;
      context.configure({ device, format: 'rgba8unorm', alphaMode: 'opaque' });
      gpu.current = { device, other, context };
      setReady(true);
      continueRender(handle);
    })();
  }, [handle]);
  useLayoutEffect(() => {
    const g = gpu.current;
    if (!ready || g === null) return;
    const encoder = g.device.createCommandEncoder();
    encoder.beginRenderPass({ colorAttachments: [{ view: g.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: frame / 12, g: 0.2, b: 0.4, a: 1 } }] }).end();
    g.device.queue.submit([encoder.finish()]);
    if (frame === 5) void g.other.queue.onSubmittedWorkDone().then(() => g.other.createBuffer({ size: 4, usage: 0xffff }));
  }, [ready, frame]);
  return <canvas ref={canvas} width={SIZE} height={SIZE} style={{ display: 'block' }} />;
};

registerRoot(() => <Composition id="Main" component={Scene} width={SIZE} height={SIZE} fps={30} durationInFrames={12} />);
