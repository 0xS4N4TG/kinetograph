// A page that paints from requestAnimationFrame and waits for what it painted (a map that asks for its `idle` event, which
// a repaint brings) is not stuck behind its own delayRender: callbacks run while a handle is open, and a frame whose
// callbacks started more work (tiles from a worker) waits for it and runs the callbacks its end asked for.

import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { continueRender, delayRender, resetRenderState } from '../src/assets.js';
import { Composition, registerRoot, resetCompositions } from '../src/compositions.js';
import { resetVirtualClock, uninstallDeterminism, installDeterminism } from '../src/determinism.js';
import { createFrameRenderer } from '../src/frame-loop.js';
import { AbsoluteFill } from '../src/fill.js';

beforeEach(() => {
  installDeterminism();
  resetCompositions();
  resetRenderState();
  resetVirtualClock();
});
afterEach(() => {
  uninstallDeterminism();
  resetRenderState();
});

const compose = (component: () => JSX.Element) =>
  registerRoot(() => <Composition id="T" component={component} width={64} height={64} fps={24} durationInFrames={2} />);

describe('animation frames and delayRender', () => {
  it('a handle that an animation-frame callback closes does not hold the frame forever', async () => {
    const log: string[] = [];
    function Page() {
      useState(() => {
        const handle = delayRender('idle', { timeoutInMilliseconds: 2000 });
        requestAnimationFrame(() => {
          log.push('painted');
          continueRender(handle);
        });
      });
      return <AbsoluteFill />;
    }
    compose(Page);
    await createFrameRenderer('T').renderFrame(0);
    expect(log).toEqual(['painted']);
  });

  it('a callback that starts async work gets the callbacks its end asks for, in the same frame', async () => {
    const log: string[] = [];
    function Page() {
      useState(() => {
        let loaded = false;
        const paint = () => {
          log.push(loaded ? 'painted with data' : 'painted without');
          if (loaded) return;
          const handle = delayRender('tiles', { timeoutInMilliseconds: 2000 });
          setImmediate(() => {
            loaded = true;
            requestAnimationFrame(paint);
            continueRender(handle);
          });
        };
        requestAnimationFrame(paint);
      });
      return <AbsoluteFill />;
    }
    compose(Page);
    await createFrameRenderer('T').renderFrame(0);
    expect(log).toEqual(['painted without', 'painted with data']);
  });

  it('a frame with callbacks and nothing pending runs them once, as before', async () => {
    let runs = 0;
    function Page() {
      useState(() => {
        const again = () => {
          runs++;
          requestAnimationFrame(again);
        };
        requestAnimationFrame(again);
      });
      return <AbsoluteFill />;
    }
    compose(Page);
    await createFrameRenderer('T').renderFrame(0);
    expect(runs).toBe(1);
  });
});
