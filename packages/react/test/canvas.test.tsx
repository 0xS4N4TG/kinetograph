// Canvas 2D in the reconciler (packages/cli/skills/kinetograph/references/SCENE.md, "canvas"): the native `<Canvas draw>` becomes a canvas layer whose
// commands the draw function made, and a DOM `<canvas>` that a project draws on through a ref reaches the addon as
// the commands in its `data-kg-canvas` attribute. The addon is a stand-in that records the request.

import { useEffect, useRef } from 'react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setDomAddon, setDomEnvironment } from '@kinetographdev/compat/dom';
import { installDomGlobals, resetCanvasStates } from '@kinetographdev/compat/shim';
import type { CanvasCommand, CanvasContext2D, CanvasLayer } from '@kinetographdev/scene';
import { Canvas, createSceneRoot, Layer, TimelineContext } from '../src/index.js';
import { layersOf, timeline } from './harness.js';

const requests: { root: { tag?: string; attrs?: Record<string, string>; children?: any[] } }[] = [];

beforeAll(() => {
  installDomGlobals();
  setDomEnvironment({ baseDir: '/tmp' });
  setDomAddon({
    renderDomIsland(json: string) {
      requests.push(JSON.parse(json));
      return JSON.stringify({ layers: [], unsupported: [], camera: null });
    },
  });
});
afterAll(() => setDomAddon(null));

const canvasOf = (layer: unknown): CanvasLayer => layer as CanvasLayer;

describe('<Canvas>', () => {
  it('is a canvas layer holding what draw drew', () => {
    const [layer] = layersOf(
      <Canvas
        id="chart"
        width={200}
        height={100}
        x={10}
        draw={(ctx) => {
          ctx.fillStyle = '#336699';
          ctx.fillRect(0, 0, 50, 20);
        }}
      />,
    );
    expect(layer).toEqual({
      id: 'chart',
      type: 'canvas',
      width: 200,
      height: 100,
      commands: [{ op: 'fill', path: 'M0 0L50 0L50 20L0 20Z', paint: { type: 'color', color: '#336699' } }],
      transform: { x: 10 },
    });
  });

  it('writes shadows and filters on the commands and reports a url() filter, which a <Canvas> has no page to find', () => {
    const root = createSceneRoot();
    const tree = root.render(
      <TimelineContext.Provider value={timeline(0)}>
        <Canvas
          id="c"
          width={40}
          height={40}
          draw={(ctx) => {
            ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
            ctx.shadowBlur = 6;
            ctx.filter = 'url(#rough) blur(2px)';
            ctx.fillRect(0, 0, 10, 10);
          }}
        />
      </TimelineContext.Provider>,
    );
    root.unmount();
    expect(canvasOf(tree.layers[0]).commands![0]).toMatchObject({
      shadow: { color: '#00000080', blur: 6 },
      filter: [{ type: 'url', url: 'url(#rough)' }, { type: 'blur', radius: 2 }],
    });
    expect(tree.unsupported).toEqual([
      { path: expect.stringContaining('<Canvas>'), element: 'Canvas', property: 'filter', value: 'url(#rough)', reason: expect.stringContaining('url()') },
    ]);
  });

  it('draws on a new, empty context each time the tree is read', () => {
    let calls = 0;
    const draw = (ctx: CanvasContext2D) => {
      calls += 1;
      ctx.globalAlpha = 0.5;
      ctx.fillRect(0, 0, 1, 1);
    };
    const root = createSceneRoot();
    const element = <Canvas id="c" width={4} height={4} draw={draw} />;
    const first = canvasOf(root.render(<TimelineContext.Provider value={timeline(0)}>{element}</TimelineContext.Provider>).layers[0]);
    const second = canvasOf(root.snapshot().layers[0]);
    root.unmount();
    expect(calls).toBe(2);
    // The second read did not draw on top of the first, and did not start from its alpha.
    expect(second.commands).toEqual(first.commands);
    expect(first.commands).toHaveLength(1);
  });

  it('draws from the frame it closes over', () => {
    const at = (frame: number) => canvasOf(layersOf(<Canvas id="c" width={100} height={10} draw={(ctx) => ctx.fillRect(frame, 0, 5, 5)} />, frame)[0]);
    expect((at(3).commands![0] as { path: string }).path).toBe('M3 0L8 0L8 5L3 5Z');
    expect((at(40).commands![0] as { path: string }).path).toBe('M40 0L45 0L45 5L40 5Z');
  });

  it('matches a font against the registered ones and measures text with the engine', () => {
    const root = createSceneRoot({ fonts: () => ({ 'DM Sans': '/f/dm.ttf', 'DM Sans:700': '/f/dm-bold.ttf' }) });
    const tree = root.render(
      <TimelineContext.Provider value={timeline(0)}>
        <Canvas
          id="c"
          width={100}
          height={30}
          draw={(ctx) => {
            ctx.font = 'bold 20px "DM Sans"';
            ctx.fillText('Hi', 0, 20);
          }}
        />
      </TimelineContext.Provider>,
    );
    root.unmount();
    expect((canvasOf(tree.layers[0]).commands![0] as { font: string }).font).toBe('DM Sans:700');
  });

  it('takes a layer around it and a place in a group', () => {
    const [group] = layersOf(
      <Layer id="g">
        <Canvas id="c" width={10} height={10} draw={() => {}} opacity={0.5} />
      </Layer>,
    );
    expect(group).toMatchObject({ children: [{ id: 'c', type: 'canvas', opacity: 0.5, commands: [] }] });
  });

  it('refuses a size that is not pixels and a draw that is not a function', () => {
    expect(() => layersOf(<Canvas id="c" width={-1} height={10} draw={() => {}} />)).toThrow(/width must be a number of pixels/);
    expect(() => layersOf(<Canvas id="c" width={10} height={NaN as number} draw={() => {}} />)).toThrow(/height must be a number of pixels/);
    expect(() => layersOf(<Canvas id="c" width={10} height={10} draw={undefined as never} />)).toThrow(/needs a draw/);
  });
});

describe('a DOM <canvas> drawn on through a ref', () => {
  function Chart({ frame }: { frame: number }) {
    const ref = useRef<any>(null);
    useEffect(() => {
      const ctx = ref.current!.getContext('2d')!;
      ctx.clearRect(0, 0, 100, 50);
      ctx.fillStyle = 'red';
      ctx.fillRect(frame, 0, 10, 10);
      // State left behind by the effect must not leak into the next frame.
      ctx.globalAlpha = 0.25;
      ctx.translate(5, 5);
    });
    return (
      <div>
        <canvas ref={ref} id="c" width={100} height={50} />
      </div>
    );
  }

  const render = (root: ReturnType<typeof createSceneRoot>, frame: number) => {
    requests.length = 0;
    root.update(
      <TimelineContext.Provider value={timeline(frame)}>
        <Chart frame={frame} />
      </TimelineContext.Provider>,
    );
    root.snapshot();
    const canvas = requests.at(-1)!.root.children!.find((c) => c.tag === 'canvas');
    return JSON.parse(canvas.attrs['data-kg-canvas']) as CanvasCommand[];
  };

  it('hands the commands to the painter in data-kg-canvas, with its size attributes', () => {
    const root = createSceneRoot({ viewport: { width: 200, height: 100 } });
    const commands = render(root, 4);
    const canvas = requests.at(-1)!.root.children!.find((c) => c.tag === 'canvas');
    expect(canvas.attrs).toMatchObject({ width: '100', height: '50', id: 'c' });
    expect(commands).toEqual([{ op: 'fill', path: 'M4 0L14 0L14 10L4 10Z', paint: { type: 'color', color: '#ff0000' } }]);
    root.unmount();
  });

  it('draws each frame from the state of a new canvas once the frame loop resets it', () => {
    const root = createSceneRoot({ viewport: { width: 200, height: 100 } });
    render(root, 1);
    resetCanvasStates();
    const commands = render(root, 2);
    // The clear emptied the commands; the fill has the default alpha and no transform.
    expect(commands).toEqual([{ op: 'fill', path: 'M2 0L12 0L12 10L2 10Z', paint: { type: 'color', color: '#ff0000' } }]);
    root.unmount();
  });

  it('leaves a canvas nothing was drawn on without the attribute', () => {
    const root = createSceneRoot({ viewport: { width: 200, height: 100 } });
    requests.length = 0;
    root.update(
      <TimelineContext.Provider value={timeline(0)}>
        <canvas width={10} height={10} />
      </TimelineContext.Provider>,
    );
    root.snapshot();
    expect(requests.at(-1)!.root.attrs).not.toHaveProperty('data-kg-canvas');
    root.unmount();
  });
});
