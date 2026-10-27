import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Rect } from '@kinetographdev/react';
import { resetRenderState } from '../src/assets.js';
import { Composition, registerRoot, resetCompositions } from '../src/compositions.js';
import { resetVirtualClock, uninstallDeterminism } from '../src/determinism.js';
import { createFrameRenderer } from '../src/frame-loop.js';
import { installPageErrors, takePageErrors } from '../src/page-errors.js';
import { useCurrentFrame } from '../src/timeline.js';

beforeEach(() => {
  resetCompositions();
  resetRenderState();
  resetVirtualClock();
  takePageErrors();
  installPageErrors();
});
afterEach(() => {
  uninstallDeterminism();
  resetRenderState();
});

describe('errors the page raises and survives', () => {
  it('reports console.error, deduplicated, on the frame that made it', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    function Noisy() {
      const frame = useCurrentFrame();
      if (frame === 1) {
        console.error('mermaid failed: %s', 'no svg');
        console.error('mermaid failed: %s', 'no svg');
      }
      return <Rect id="r" width={4} height={4} fill="#fff" />;
    }
    registerRoot(() => <Composition id="N" component={Noisy} width={8} height={8} fps={30} durationInFrames={3} />);
    const renderer = createFrameRenderer('N');
    await renderer.ready();
    const frames = [];
    for (let f = 0; f < 3; f++) frames.push((await renderer.renderFrame(f)).unsupported);
    spy.mockRestore();
    renderer.dispose();
    expect(frames[0]).toEqual([]);
    expect(frames[1]).toHaveLength(1);
    expect(frames[1]![0]).toMatchObject({ element: 'page script', property: 'console.error', value: 'mermaid failed: no svg' });
    expect(frames[2]).toEqual([]);
  });

  it('reports an unhandled rejection', async () => {
    function Rejects() {
      const frame = useCurrentFrame();
      if (frame === 0) void Promise.reject(new TypeError('Cannot read properties of null'));
      return <Rect id="r" width={4} height={4} fill="#fff" />;
    }
    registerRoot(() => <Composition id="R" component={Rejects} width={8} height={8} fps={30} durationInFrames={2} />);
    const renderer = createFrameRenderer('R');
    await renderer.ready();
    const first = (await renderer.renderFrame(0)).unsupported;
    const rest = [...first, ...(await renderer.renderFrame(1)).unsupported];
    renderer.dispose();
    expect(rest.map((i) => [i.property, i.value])).toContainEqual(['unhandled rejection', 'TypeError: Cannot read properties of null']);
  });
});
