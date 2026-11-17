// A timeout set while a frame is held open fires when nothing else is moving, at the frame's own time (frame-loop.tsx,
// `whenReleased`): React's 300 ms throttle of a Suspense reveal is such a timeout.

import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Rect } from '@kinetographdev/react';
import { continueRender, delayRender, resetRenderState } from '../src/assets.js';
import { Composition, registerRoot, resetCompositions } from '../src/compositions.js';
import { installDeterminism, resetVirtualClock, uninstallDeterminism, virtualNow } from '../src/determinism.js';
import { createFrameRenderer } from '../src/frame-loop.js';

beforeEach(() => {
  resetCompositions();
  resetRenderState();
  installDeterminism();
  resetVirtualClock();
});
afterEach(() => {
  uninstallDeterminism();
  resetRenderState();
});

const log: string[] = [];
beforeEach(() => {
  log.length = 0;
});

/** Sets a timeout when it first renders, before any hold is open. */
function Early() {
  useState(() => setTimeout(() => log.push('early'), 100));
  return null;
}

/** Holds the frame, and releases it from the last of timeouts made while it is held. */
function Held({ delays }: { delays: number[] }) {
  useState(() => {
    const handle = delayRender('waiting on timeouts');
    delays.forEach((ms, i) =>
      setTimeout(() => {
        log.push(`hold${i}:${ms}`);
        if (i === delays.length - 1) continueRender(handle);
      }, ms),
    );
  });
  return <Rect id="r" width={4} height={4} fill="#fff" />;
}

function root(children: React.ReactNode) {
  registerRoot(() => <Composition id="T" component={() => <>{children}</>} width={16} height={16} fps={30} durationInFrames={20} />);
}

describe('a timeout set while the frame is held open', () => {
  it('releases a hold that waits on a 300 ms timeout in the same frame, with no real waiting and the clock still', async () => {
    root(<Held delays={[300]} />);
    const started = process.hrtime.bigint();
    await createFrameRenderer('T').renderFrame(0);
    expect(log).toEqual(['hold0:300']);
    expect(virtualNow()).toBe(0);
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(250);
  });

  it('does not fire a timeout made before the hold, and fires the held ones in due order, then creation order', async () => {
    root(
      <>
        <Early />
        <Held delays={[200, 100, 100, 150]} />
      </>,
    );
    // The last created (150 ms) releases the hold before the 200 ms one is due: that one stays queued, and so does `early`.
    await createFrameRenderer('T').renderFrame(0);
    expect(log).toEqual(['hold1:100', 'hold2:100', 'hold3:150']);
  });

  it('leaves a timeout made outside a hold to the frame clock', async () => {
    root(
      <>
        <Early />
        <Rect id="r" width={4} height={4} fill="#fff" />
      </>,
    );
    const renderer = createFrameRenderer('T');
    await renderer.renderFrame(0);
    expect(log).toEqual([]);
    await renderer.renderFrame(3);
    expect(log).toEqual(['early']);
  });

  it('runs the animation frames a held frame asks for and fires the hold timers they set, in one frame', async () => {
    // The release waits on a timeout that only an animation-frame callback sets (a repaint that schedules the next step):
    // neither the frame callbacks alone nor the hold timers alone release it.
    function Both() {
      useState(() => {
        const handle = delayRender('waiting on a frame callback and a timeout');
        requestAnimationFrame(() => {
          log.push('raf');
          setTimeout(() => {
            log.push('hold:300');
            continueRender(handle);
          }, 300);
        });
      });
      return <Rect id="r" width={4} height={4} fill="#fff" />;
    }
    root(<Both />);
    await createFrameRenderer('T').renderFrame(0);
    expect(log).toEqual(['raf', 'hold:300']);
    expect(virtualNow()).toBe(0);
  });
});
