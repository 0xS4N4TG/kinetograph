// A `<canvas>` a frame draws on starts that frame empty, so a frame is the same alone (`still 45`, a worker that starts
// mid-way) and after the frames before it; one nobody draws on in a frame keeps its pixels (drawn once in an effect). See `resetCanvasStates` in packages/compat/src/shim/canvas.ts.
import { useEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetRenderState } from '../src/assets.js';
import { Composition, registerRoot, resetCompositions } from '../src/compositions.js';
import { installDeterminism, resetVirtualClock, uninstallDeterminism } from '../src/determinism.js';
import { createFrameRenderer } from '../src/frame-loop.js';
import { useCurrentFrame } from '../src/timeline.js';

let drawn: { commands: unknown[] } | null = null;

function Trail() {
  const frame = useCurrentFrame();
  const ref = useRef<any>(null);
  useEffect(() => {
    const ctx = ref.current.getContext('2d');
    drawn = ctx;
    ctx.fillStyle = '#0cf';
    ctx.beginPath();
    ctx.arc(40 + frame * 6, 180, 14, 0, Math.PI * 2);
    ctx.fill();
  }, [frame]);
  return <canvas ref={ref} width={640} height={360} />;
}

function Static() {
  const ref = useRef<any>(null);
  useEffect(() => {
    const ctx = ref.current.getContext('2d');
    drawn = ctx;
    ctx.fillStyle = '#f00';
    ctx.fillRect(10, 10, 50, 50);
  }, []);
  return <canvas ref={ref} width={640} height={360} />;
}

beforeEach(() => {
  resetCompositions();
  resetRenderState();
  resetVirtualClock();
  installDeterminism();
  drawn = null;
  registerRoot(() => (
    <>
      <Composition id="Trail" component={Trail} width={640} height={360} fps={30} durationInFrames={60} />
      <Composition id="Static" component={Static} width={640} height={360} fps={30} durationInFrames={60} />
    </>
  ));
});
afterEach(() => {
  uninstallDeterminism();
  resetRenderState();
});

async function commandsAt(frames: number[], id = 'Trail'): Promise<string> {
  const renderer = createFrameRenderer(id);
  for (const frame of frames) await renderer.renderFrame(frame);
  const commands = JSON.stringify(drawn?.commands);
  renderer.dispose();
  return commands;
}

describe('a canvas in a component', () => {
  it('draws frame N the same alone and after the frames before it', async () => {
    const sequential = await commandsAt([0, 1, 2, 3, 4, 5]);
    resetVirtualClock();
    drawn = null;
    const alone = await commandsAt([5]);
    expect(alone).toBe(sequential);
    expect(JSON.parse(alone)).not.toHaveLength(0);
  });

  it('keeps a canvas drawn once, in a sequential render and in a frame rendered alone', async () => {
    const sequential = await commandsAt([0, 1, 2, 3, 4, 5], 'Static');
    resetVirtualClock();
    drawn = null;
    const alone = await commandsAt([5], 'Static');
    expect(JSON.parse(sequential)).toHaveLength(1);
    expect(alone).toBe(sequential);
  });
});
