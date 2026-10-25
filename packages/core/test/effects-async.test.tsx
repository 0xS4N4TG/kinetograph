// An `async` effect, `onInit` or `onPaint` holds the frame until its promise settles, so what it draws after an `await`
// is in the frame, the same alone as in a sequence; a rejection is reported for the frame (effect-chain.tsx).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasCommand, GroupLayer, LayerJson } from '@kinetographdev/scene';
import { resetRenderState } from '../src/assets.js';
import { Composition, registerRoot, resetCompositions } from '../src/compositions.js';
import { installDeterminism, realTimers, resetVirtualClock, uninstallDeterminism } from '../src/determinism.js';
import { createEffect, HtmlInCanvas, Solid, useCurrentFrame } from '../src/index.js';
import { createFrameRenderer } from '../src/frame-loop.js';
import { resetWarnings } from '../src/warn.js';

const later = () => new Promise<void>((resolve) => realTimers.setImmediate(resolve));

let calls = 0;
const mark = createEffect<{ color: string; fail?: boolean }, object>({
  type: 'test/async-mark',
  label: 'AsyncMark',
  documentationLink: null,
  backend: '2d',
  calculateKey: ({ color, fail }) => `async-mark-${color}-${fail ?? false}`,
  setup: () => ({}),
  apply: async ({ source, target, params, width, height }) => {
    calls++;
    const ctx = target.getContext('2d') as any;
    ctx.drawImage(source, 0, 0, width, height);
    await later();
    if (params.fail) throw new Error('the device was lost');
    ctx.fillStyle = params.color;
    ctx.fillRect(0, 0, 4, 4);
  },
  cleanup: () => undefined,
  schema: { color: { type: 'string', default: '#000', description: 'Colour' } },
  validateParams: () => undefined,
});

function passes(layers: LayerJson[], out: GroupLayer[] = []): GroupLayer[] {
  for (const layer of layers) {
    if (layer.type === 'group') {
      if (layer.canvas !== undefined || layer.glsl !== undefined) out.push(layer);
      passes(layer.children, out);
    }
  }
  return out;
}

const commandsOf = (layers: LayerJson[]): CanvasCommand[] => passes(layers).flatMap((g) => (g.canvas?.commands ?? []) as CanvasCommand[]);
/** The paints of the fills (what `fillRect` recorded). */
const fills = (layers: LayerJson[]): string[] => commandsOf(layers).filter((c) => c.op === 'fill').map((c) => JSON.stringify((c as { paint: unknown }).paint));
/** The tree without the ids React's `useId` gave the layers: they count the components mounted in the process. */
const plain = (layers: LayerJson[]): unknown => JSON.parse(JSON.stringify(layers).replace(/fx_kgr_\d+_/g, 'fx'));

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetCompositions();
  resetRenderState();
  resetVirtualClock();
  resetWarnings();
  installDeterminism();
  calls = 0;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  uninstallDeterminism();
  resetRenderState();
});

function Tinted({ fail = false }: { fail?: boolean }) {
  const frame = useCurrentFrame();
  return <Solid width={16} height={16} color="#f00" effects={[mark({ color: `rgb(${frame}, 0, 0)`, fail })]} />;
}

function register(fail = false) {
  registerRoot(() => <Composition id="A" component={Tinted} defaultProps={{ fail }} width={16} height={16} fps={30} durationInFrames={20} />);
}

describe('an async effect', () => {
  it('has what it draws after an await in the frame, and runs once for the frame', async () => {
    register();
    const r = createFrameRenderer('A');
    const frame = await r.renderFrame(7);
    expect(fills(frame.scene.layers).join('')).toContain('#070000');
    // Once for the frame, and once for the mount at frame 0 that a scene starting at frame 7 renders first.
    expect(calls).toBe(2);
    expect(frame.unsupported).toEqual([]);
  });

  it('is the same alone as in a sequence', async () => {
    register();
    const sequence = createFrameRenderer('A');
    const inSequence: LayerJson[][] = [];
    for (let f = 0; f < 12; f++) inSequence.push((await sequence.renderFrame(f)).scene.layers);
    sequence.dispose();
    for (const f of [0, 5, 11]) {
      const alone = createFrameRenderer('A');
      const layers = (await alone.renderFrame(f)).scene.layers;
      expect(fills(layers)).toEqual(fills(inSequence[f]!));
      expect(plain(layers)).toEqual(plain(inSequence[f]!));
      alone.dispose();
    }
  });

  it('reports a rejection for the frame and draws the picture without the effect', async () => {
    register(true);
    const r = createFrameRenderer('A');
    const frame = await r.renderFrame(3);
    expect(frame.unsupported).toEqual([expect.objectContaining({ element: 'Solid', property: 'effects', value: 'async', reason: expect.stringContaining('the device was lost') })]);
    expect(fills(frame.scene.layers)).toEqual([]);
    // The next frame is reported on its own.
    expect((await r.renderFrame(4)).unsupported).toHaveLength(1);
  });
});

describe('an async HtmlInCanvas program', () => {
  it('runs onInit, then onPaint, then the cleanup, and waits for each', async () => {
    const order: string[] = [];
    function Program() {
      const frame = useCurrentFrame();
      return (
        <HtmlInCanvas
          width={16}
          height={16}
          onInit={async () => {
            order.push('init');
            await later();
            order.push('init done');
            return () => order.push('cleanup');
          }}
          onPaint={async ({ canvas, elementImage }) => {
            order.push('paint');
            const ctx = canvas.getContext('2d');
            ctx.drawElementImage(elementImage, 0, 0);
            await later();
            ctx.fillStyle = `rgb(${frame}, 1, 1)`;
            ctx.fillRect(0, 0, 2, 2);
            order.push('paint done');
          }}
        >
          <div style={{ width: 16, height: 16, background: '#0f0' }} />
        </HtmlInCanvas>
      );
    }
    registerRoot(() => <Composition id="H" component={Program} width={16} height={16} fps={30} durationInFrames={20} />);
    const r = createFrameRenderer('H');
    // A scene that starts at a later frame renders frame 0 first, as its mount.
    await r.renderFrame(0);
    order.length = 0;
    const frame = await r.renderFrame(9);
    expect(order).toEqual(['init', 'init done', 'paint', 'paint done', 'cleanup']);
    expect(fills(frame.scene.layers).join('')).toContain('#090101');
    expect(frame.unsupported).toEqual([]);
  });
});
