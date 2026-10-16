import { describe, expect, it } from 'vitest';
import type { Renderer } from '@kinetograph/native';
import type { SceneJson, Unsupported } from '@kinetograph/scene';
import { renderSource } from '../src/render-job.js';
import type { Source } from '../src/source.js';
import { fakeNative } from './helpers.js';

const issue: Unsupported = { path: '$0.1 <div>', element: 'div', property: 'transform', value: 'skewX(10deg)', reason: 'skew is not supported' };

/** A project whose frames in `unsupported` hold something the engine cannot draw. */
function project(unsupported: number[], extra: Partial<Source> = {}): Source {
  return {
    kind: 'project',
    entry: '/work/index.tsx',
    baseDir: '/work',
    composition: { id: 'Main', width: 64, height: 36, fps: 30, durationInFrames: 12, defaultProps: {} },
    async frame(frame) {
      const scene: SceneJson = { width: 64, height: 36, fps: 30, durationInFrames: 12, background: '#000', layers: [{ id: `f${frame}`, type: 'group', children: [] }] };
      return { sceneJson: JSON.stringify(scene), audio: [], unsupported: unsupported.includes(frame) ? [issue] : [], jsMs: 1, stringifyMs: 0 };
    },
    dispose() {},
    ...extra,
  };
}

function setup() {
  const { native, calls } = fakeNative();
  return { renderer: new native.Renderer() as unknown as Renderer, calls };
}

describe('renderSource with unsupported content', () => {
  it('pushes every frame to the writer in order and lists what it left out', async () => {
    const { renderer, calls } = setup();
    const result = await renderSource(project([3, 4, 8]), renderer, { output: 'out.mp4', range: '0..10' });
    // 0..10 is frames 0 to 9.
    expect(calls.pushed.map((p) => p.frame)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(calls.finished).toHaveLength(1);
    expect(calls.aborted).toBe(0);
    expect(result.compat).toEqual({
      unsupportedFrames: 3,
      leftOut: [
        { element: 'div', property: 'transform', reason: 'skew is not supported', values: ['skewX(10deg)'], frames: 3, firstFrame: 3, lastFrame: 8 },
      ],
    });
  });

  it('reports nothing left out for a project with nothing unsupported', async () => {
    const { renderer, calls } = setup();
    const result = await renderSource(project([]), renderer, { output: 'out.mp4' });
    expect(calls.pushed).toHaveLength(12);
    expect(result.compat).toEqual({ unsupportedFrames: 0, leftOut: [] });
  });

  it('fails on the first frame with unsupported content under strict, and aborts the video', async () => {
    const { renderer, calls } = setup();
    await expect(renderSource(project([3, 4]), renderer, { output: 'out.mp4', strict: true })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT',
      message: expect.stringContaining('frame 3 holds content the engine cannot draw'),
    });
    await expect(renderSource(project([3]), renderer, { output: 'out.mp4', strict: true })).rejects.toThrow(
      'div { transform: skewX(10deg) }: skew is not supported',
    );
    expect(calls.pushed.map((p) => p.frame)).toEqual([0, 1, 2, 0, 1, 2]);
    expect(calls.aborted).toBe(2);
    expect(calls.finished).toHaveLength(0);
  });

  it('renders a project without unsupported content under strict', async () => {
    const { renderer, calls } = setup();
    await renderSource(project([]), renderer, { output: 'out.mp4', strict: true, range: '0..3' });
    expect(calls.pushed).toHaveLength(3);
  });

  it('cancels between frames', async () => {
    const { renderer, calls } = setup();
    let seen = 0;
    await expect(
      renderSource(project([0, 1, 2, 3]), renderer, { output: 'out.mp4', shouldCancel: () => ++seen > 2 }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(calls.pushed.map((p) => p.frame)).toEqual([0, 1]);
    expect(calls.aborted).toBe(1);
  });

  it('lists what a .json scene holds that the engine cannot draw on every frame of the range, and fails under strict', async () => {
    const note: Unsupported = { path: 's <Model>', element: 'Model', property: 'KHR_materials_clearcoat', value: 'car.glb', reason: 'this glTF extension is not read' };
    const scene = project([], { kind: 'scene', frame: async () => ({ sceneJson: '{}', audio: [], unsupported: [note], jsMs: 0, stringifyMs: 0 }) });
    const { renderer, calls } = setup();
    const result = await renderSource(scene, renderer, { output: 'out.mp4', range: '2..6' });
    expect(calls.render).toHaveLength(1);
    expect(result.compat).toEqual({
      unsupportedFrames: 4,
      leftOut: [{ element: 'Model', property: 'KHR_materials_clearcoat', reason: note.reason, values: ['car.glb'], frames: 4, firstFrame: 2, lastFrame: 5 }],
    });
    await expect(renderSource(scene, renderer, { output: 'out.mp4', strict: true })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' });
    expect(calls.render).toHaveLength(1);
  });

  it('leaves a .json scene to the addon whole', async () => {
    const { renderer, calls } = setup();
    const result = await renderSource(project([], { kind: 'scene' }), renderer, { output: 'out.mp4', strict: true });
    expect(calls.render).toHaveLength(1);
    expect(result.compat).toEqual({ unsupportedFrames: 0, leftOut: [] });
  });
});
