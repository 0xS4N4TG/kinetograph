// An effect that reads the pixels of its picture (`drawImage(source)`, then `getImageData`): the picture is a layer of a
// tree that is not committed while the effect runs, so the stage waits for the commit, the layer is emitted from the tree
// and handed to the addon with the commands, and the stage runs again with the pixels. The addon is a stand-in here: it
// keeps the requests and answers with a grey picture; the real one is in the parity harness (scripts/remotion-effects).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDomAddon } from '@kinetographdev/compat/dom';
import type { CanvasCommand, GroupLayer, LayerJson } from '@kinetographdev/scene';
import { Composition, Solid, createEffect, registerRoot } from '../src/index.js';
import { resetCompositions } from '../src/compositions.js';
import { createFrameRenderer } from '../src/frame-loop.js';
import { installDeterminism, realTimers, resetVirtualClock, uninstallDeterminism } from '../src/determinism.js';
import { openRenderHandles, resetRenderState } from '../src/assets.js';
import { clearReportedUnsupported, reportedUnsupported } from '../src/unsupported.js';
import { resetWarnings } from '../src/warn.js';
import { renderDom } from './dom-harness.js';

interface Request {
  width: number;
  height: number;
  commands: CanvasCommand[];
  layers?: LayerJson[];
  frame?: number;
  fps?: number;
  durationInFrames?: number;
}

/** A DOM island (a `<Solid>` is one) that draws nothing of its own: the native elements in it are placeholders at its corner. */
const island = {
  renderDomIsland(json: string): string {
    const request = JSON.parse(json);
    const natives: unknown[] = [];
    const place = (node: any): void => {
      if (node.kind === 'native') natives.push({ type: 'native', path: node.path, x: 0, y: 0, width: node.width ?? 0, height: node.height ?? 0 });
      if (node.kind === 'element') node.children.forEach(place);
    };
    place(request.root);
    return JSON.stringify({ layers: [{ id: request.path, type: 'group', children: natives }], unsupported: [], camera: null });
  },
};

let requests: Request[] = [];
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  requests = [];
  resetWarnings();
  clearReportedUnsupported();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  setDomAddon({
    ...island,
    renderCanvas(json: string) {
      const request = JSON.parse(json) as Request;
      requests.push(request);
      return new Uint8Array(request.width * request.height * 4).fill(100);
    },
  });
});
afterEach(() => {
  setDomAddon(null);
  warn.mockRestore();
});

function groupsOf(layers: LayerJson[], out: GroupLayer[] = []): GroupLayer[] {
  for (const layer of layers) {
    if (layer.type === 'group') {
      out.push(layer);
      groupsOf(layer.children, out);
    }
  }
  return out;
}

const passes = (layers: LayerJson[]): GroupLayer[] => groupsOf(layers).filter((g) => g.canvas !== undefined);

/** 2D: draws the picture, reads it back, and writes it again with the red channel set to what was read, plus one. */
const reads = createEffect<{ n?: number }, object>({
  type: 'test/reads',
  label: 'Reads',
  documentationLink: null,
  backend: '2d',
  calculateKey: ({ n }) => `reads-${n ?? 0}`,
  setup: () => ({}),
  apply: ({ source, target, width, height }) => {
    const ctx = target.getContext('2d') as unknown as {
      clearRect(x: number, y: number, w: number, h: number): void;
      drawImage(image: unknown, x: number, y: number, w: number, h: number): void;
      getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
      putImageData(image: unknown, x: number, y: number): void;
    };
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    for (let i = 0; i < image.data.length; i += 4) image.data[i] = image.data[i]! + 1;
    ctx.putImageData(image, 0, 0);
  },
  cleanup: () => undefined,
  schema: {},
  validateParams: () => undefined,
});

describe('an effect that reads the pixels of its picture', () => {
  it('is run again once its layer is known, and reads what the addon draws of that layer', () => {
    const tree = renderDom(<Solid width={4} height={2} color="#f00" effects={[reads({})]} />);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request).toMatchObject({ width: 4, height: 2, frame: 0, fps: 30, durationInFrames: 90 });
    // The commands the script had recorded when it read: the picture of the layer, drawn.
    expect(request!.commands.map((c) => c.op)).toEqual(['image']);
    const [pass] = passes(tree.layers);
    const picture = request!.commands[0] as Extract<CanvasCommand, { op: 'image' }>;
    expect(picture.source).toMatchObject({ kind: 'layer', id: pass!.children[0]!.id });
    // The layer is the one the picture names, as it stands in the tree.
    expect(request!.layers!.map((l) => l.id)).toEqual([pass!.children[0]!.id]);
    // The pixels the script wrote are in the pass: the grey plus one, as an image.
    const written = (pass!.canvas!.commands as CanvasCommand[]).at(-1)! as Extract<CanvasCommand, { op: 'image' }>;
    expect(written.source.kind).toBe('pixels');
    if (written.source.kind === 'pixels') expect(Buffer.from(written.source.data, 'base64')[0]).toBe(101);
    expect(openRenderHandles()).toBe(0);
    expect(reportedUnsupported()).toEqual([]);
  });

  it('is asked for the frame it is drawn at', () => {
    renderDom(<Solid width={4} height={2} color="#f00" effects={[reads({})]} />, 7);
    expect(requests.at(-1)).toMatchObject({ frame: 7, fps: 30, durationInFrames: 90 });
  });

  it('does not run the addon for an effect that does not read', () => {
    const plain = createEffect<object, object>({
      type: 'test/plain',
      label: 'Plain',
      documentationLink: null,
      backend: '2d',
      calculateKey: () => 'plain',
      setup: () => ({}),
      apply: ({ source, target, width, height }) => {
        (target.getContext('2d') as unknown as { drawImage(i: unknown, x: number, y: number, w: number, h: number): void }).drawImage(source, 0, 0, width, height);
      },
      cleanup: () => undefined,
      schema: {},
      validateParams: () => undefined,
    });
    renderDom(<Solid width={4} height={2} color="#f00" effects={[plain({})]} />);
    expect(requests).toEqual([]);
  });

  it('reads the group of the effect before it when it is second in the chain', () => {
    const tree = renderDom(<Solid width={4} height={2} color="#f00" effects={[reads({ n: 1 }), reads({ n: 2 })]} />);
    const [outer, inner] = passes(tree.layers);
    const last = requests.at(-1)!;
    // The second effect read the first one's group, which holds the first one's pass and, inside it, the source.
    expect(last.layers!.map((l) => l.id)).toEqual([inner!.id]);
    const first = last.layers![0] as GroupLayer;
    expect(first.canvas).toBeDefined();
    expect(first.children.map((c) => c.id)).toEqual([inner!.children[0]!.id]);
    expect(outer!.children[0]!.id).toBe(inner!.id);
    expect(openRenderHandles()).toBe(0);
    // It read the first one's final pass (its pixels written), not the empty one it had while it waited.
    expect(JSON.stringify(first.canvas!.commands)).toContain('"pixels"');
  });

  it('draws the picture without the effect, with the reason reported, when the addon cannot draw', () => {
    setDomAddon(island);
    const tree = renderDom(<Solid width={4} height={2} color="#f00" effects={[reads({})]} />);
    expect(passes(tree.layers)).toHaveLength(0);
    expect(reportedUnsupported()).toEqual([expect.objectContaining({ element: 'Solid', property: 'effects', value: 'error', reason: expect.stringContaining('renderCanvas') })]);
    expect(openRenderHandles()).toBe(0);
  });
});

describe('an async effect that reads the pixels of its picture', () => {
  const later = () => new Promise<void>((resolve) => realTimers.setImmediate(resolve));
  const asyncReads = createEffect<object, object>({
    type: 'test/async-reads',
    label: 'AsyncReads',
    documentationLink: null,
    backend: '2d',
    calculateKey: () => 'async-reads',
    setup: () => ({}),
    apply: async ({ source, target, width, height }) => {
      const ctx = target.getContext('2d') as any;
      ctx.drawImage(source, 0, 0, width, height);
      await later();
      const image = ctx.getImageData(0, 0, width, height);
      image.data[0] = image.data[0] + 2;
      ctx.putImageData(image, 0, 0);
    },
    cleanup: () => undefined,
    schema: {},
    validateParams: () => undefined,
  });

  beforeEach(() => {
    resetCompositions();
    resetRenderState();
    resetVirtualClock();
    installDeterminism();
  });
  afterEach(() => {
    uninstallDeterminism();
    resetRenderState();
  });

  it('holds the frame until the pixels are read, and draws them', async () => {
    registerRoot(() => <Composition id="R" component={() => <Solid width={4} height={2} color="#f00" effects={[asyncReads({})]} />} width={4} height={2} fps={30} durationInFrames={10} />);
    // The real addon draws the island; only the canvas is a stand-in (it needs the GPU).
    const native = (await import('node:module')).createRequire(import.meta.url)('@kinetographdev/native') as Record<string, never>;
    setDomAddon({ ...native, renderDomIsland: native.renderDomIsland, domLayoutBoxes: native.domLayoutBoxes, domComputedStyle: native.domComputedStyle, renderCanvas: (json: string) => { const r = JSON.parse(json) as Request; requests.push(r); return new Uint8Array(r.width * r.height * 4).fill(100); } } as never);
    const renderer = createFrameRenderer('R');
    const frame = await renderer.renderFrame(3);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.at(-1)).toMatchObject({ frame: 3, width: 4, height: 2 });
    expect(frame.unsupported).toEqual([]);
    const pass = passes(frame.scene.layers)[0]!;
    const written = (pass.canvas!.commands as CanvasCommand[]).at(-1)! as Extract<CanvasCommand, { op: 'image' }>;
    expect(written.source.kind === 'pixels' && Buffer.from(written.source.data, 'base64')[0]).toBe(102);
    expect(openRenderHandles()).toBe(0);
    renderer.dispose();
  });
});
