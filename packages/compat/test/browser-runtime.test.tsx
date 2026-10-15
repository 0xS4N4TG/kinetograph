// @vitest-environment jsdom
/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Camera,
  Layer,
  Rect,
  TimelineContext,
  createSceneRoot,
  installBrowserRuntime,
  isTransparentColor,
  resetWarnings,
  warnOnce,
  type BrowserFrameRenderer,
  type TimelineState,
} from '../src/browser/index.js';

const config = { id: 'Main', width: 320, height: 180, fps: 30, durationInFrames: 60, defaultProps: {}, props: {} };
const state = (frame: number): TimelineState => ({ frame, absoluteFrame: frame, durationInFrames: 60, config, frozen: false });

beforeEach(() => {
  resetWarnings();
  document.body.innerHTML = '<div id="kg-stage"></div>';
  document.head.innerHTML = '';
  delete window.__kinetograph;
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('createSceneRoot', () => {
  it('renders into the stage and returns an empty tree for the frame loop', () => {
    const root = createSceneRoot();
    const tree = root.render(
      <TimelineContext.Provider value={state(0)}>
        <Layer>
          <Rect width={10} height={10} fill="#f00" />
        </Layer>
      </TimelineContext.Provider>,
    );
    expect(tree).toEqual({ layers: [], camera: null, audio: [], sequences: [], unsupported: [] });
    expect(root.snapshot()).toEqual(tree);
    expect(document.getElementById('kg-stage')!.querySelectorAll('svg')).toHaveLength(1);
    root.unmount();
    expect(document.getElementById('kg-stage')!.innerHTML).toBe('');
  });

  it('throws what a component throws, which React 19 would only report', () => {
    const root = createSceneRoot();
    const Broken = () => {
      throw new Error('boom in a component');
    };
    expect(() => root.render(<Broken />)).toThrow('boom in a component');
    // The root is still usable.
    expect(() => root.render(<div id="after" />)).not.toThrow();
    expect(document.getElementById('after')).not.toBeNull();
    root.unmount();
  });

  it('does not let the throw-away root that finds the compositions take the stage', () => {
    const discovery = createSceneRoot();
    discovery.render(<div id="discovery" />);
    discovery.unmount();
    expect(document.getElementById('discovery')).toBeNull();
    const drawing = createSceneRoot();
    drawing.render(<div id="frame" />);
    expect(document.getElementById('kg-stage')!.querySelector('#frame')).not.toBeNull();
    // While the stage is taken, another root draws elsewhere.
    const other = createSceneRoot();
    other.render(<div id="elsewhere" />);
    expect(document.getElementById('elsewhere')).toBeNull();
    other.unmount();
    drawing.unmount();
  });
});

describe('installBrowserRuntime', () => {
  const fakeRenderer = (background: string | undefined, on?: (frame: number) => void): BrowserFrameRenderer => {
    const root = createSceneRoot();
    return {
      ready: async () => ({ width: 320, height: 180, fps: 30, durationInFrames: 60 }),
      renderFrame: async (frame) => {
        on?.(frame);
        root.render(
          <TimelineContext.Provider value={state(frame)}>
            <Layer>
              <Rect width={10} height={10} fill="#f00" />
              <Camera perspective={900} x={100} y={50} />
            </Layer>
          </TimelineContext.Provider>,
        );
        return { scene: { background } };
      },
    };
  };

  it('defines window.__kinetograph.setFrame and sizes the stage to the composition', async () => {
    const runtime = installBrowserRuntime(fakeRenderer('#14161c'));
    expect(window.__kinetograph).toBe(runtime);
    const report = await window.__kinetograph!.setFrame(7);
    expect(report).toMatchObject({ frame: 7, background: '#14161c', transparent: false, warnings: [] });
    const stage = document.getElementById('kg-stage')!;
    expect(stage.style.width).toBe('320px');
    expect(stage.style.height).toBe('180px');
    expect(stage.style.getPropertyValue('--kg-w')).toBe('320px');
    expect(stage.classList.contains('kg-layer')).toBe(true);
    expect(stage.style.background).toContain('rgb(20, 22, 28)');
    expect(document.getElementById('kg-style')!.textContent).toContain('.kg-layer');
    // The camera marker became the stage's perspective.
    expect(stage.style.perspective).toBe('900px');
    expect(stage.style.perspectiveOrigin).toBe('100px 50px');
  });

  it('reports a transparent background, and the warnings raised while drawing', async () => {
    installBrowserRuntime(
      fakeRenderer(undefined, () => {
        warnOnce('a', 'something was left out');
      }),
    );
    const first = await window.__kinetograph!.setFrame(0);
    expect(first.transparent).toBe(true);
    expect(first.background).toBe('transparent');
    expect(first.warnings).toEqual(['something was left out']);
    expect((await window.__kinetograph!.setFrame(1)).warnings).toEqual([]);
  });

  it('draws one frame at a time, in the order asked', async () => {
    const order: string[] = [];
    const renderer: BrowserFrameRenderer = {
      ready: async () => ({ width: 10, height: 10, fps: 30, durationInFrames: 5 }),
      renderFrame: async (frame) => {
        order.push(`start ${frame}`);
        await new Promise((resolve) => setTimeout(resolve, frame === 1 ? 20 : 0));
        order.push(`end ${frame}`);
        return { scene: {} };
      },
    };
    installBrowserRuntime(renderer);
    await Promise.all([1, 2, 3].map((f) => window.__kinetograph!.setFrame(f)));
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
  });

  it('fails clearly with no composition, and a failed frame does not stop the next', async () => {
    installBrowserRuntime();
    await expect(window.__kinetograph!.setFrame(0)).rejects.toThrow(/attach/);
    let calls = 0;
    window.__kinetograph!.attach({
      ready: async () => ({ width: 10, height: 10, fps: 30, durationInFrames: 5 }),
      renderFrame: async () => {
        if (calls++ === 0) throw new Error('frame 0 failed');
        return { scene: {} };
      },
    });
    await expect(window.__kinetograph!.setFrame(0)).rejects.toThrow('frame 0 failed');
    await expect(window.__kinetograph!.setFrame(1)).resolves.toMatchObject({ frame: 1 });
  });
});

describe('isTransparentColor', () => {
  it('reads computed backgrounds', () => {
    for (const c of ['transparent', 'rgba(0, 0, 0, 0)', 'rgba(255, 0, 0, 0)', 'color(srgb 1 0 0 / 0)']) expect(isTransparentColor(c), c).toBe(true);
    for (const c of ['rgb(20, 22, 28)', 'rgba(0, 0, 0, 0.5)', 'rgba(1, 2, 3, 1)']) expect(isTransparentColor(c), c).toBe(false);
  });
});
