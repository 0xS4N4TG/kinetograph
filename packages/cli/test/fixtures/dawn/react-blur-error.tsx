// A Remotion-style project in a layer with motion blur: frame 5 is also rendered at the sub-frame times around it, and the page makes an
// invalid buffer (a validation error nobody catches) in one of those only. The error belongs to frame 5, which asked for the sub-frame:
// `--strict` names frame 5, not the frame after it (WebGPU through Dawn).
import React, { useLayoutEffect, useRef, useState } from 'react';
import { Composition, continueRender, delayRender, registerRoot, useCurrentFrame } from 'remotion';
import { Layer } from '@kinetographdev/react';

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
    if (frame !== 5 && Math.abs(frame - 5) < 0.4) g.other.createBuffer({ size: 4, usage: 0xffff });
  }, [ready, frame]);
  return <Layer id="blur" x={frame * 0.5} motionBlur={{ samples: 3, shutter: 1 }}><canvas ref={canvas} width={SIZE} height={SIZE} style={{ display: 'block' }} /></Layer>;
};

registerRoot(() => <Composition id="Main" component={Scene} width={SIZE} height={SIZE} fps={30} durationInFrames={12} />);
