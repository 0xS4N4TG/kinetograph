// A load the page starts while a frame is prepared holds the frame (images, fetches, bitmaps); a Suspense of the page's own
// that the load was for is revealed before the frame is read; a canvas draws after the loads (canvas-draws.ts); a load that
// fails is reported with its URL.

import { Suspense, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Rect } from '@kinetographdev/react';
import { PAGE_LOAD_LABEL, continueRender, delayRender, resetRenderState } from '../src/assets.js';
import { drawWhenSettled } from '../src/canvas-draws.js';
import { Composition, registerRoot, resetCompositions } from '../src/compositions.js';
import { installDeterminism, realTimers, resetVirtualClock, uninstallDeterminism } from '../src/determinism.js';
import { createFrameRenderer } from '../src/frame-loop.js';
import '../src/web-install.js';

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

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

type Picture = { onload: (() => void) | null; src: string; complete: boolean };
const Img = (globalThis as unknown as { Image: new () => Picture }).Image;

/** The ids of the layers of a frame. */
async function ids(frame = 0) {
  const result = await createFrameRenderer('T').renderFrame(frame);
  return { result, ids: JSON.stringify(result) };
}

function root(component: React.FC) {
  registerRoot(() => <Composition id="T" component={component} width={16} height={16} fps={30} durationInFrames={5} />);
}

describe('loads the page starts', () => {
  it('reveals a Suspense of the page whose image finished loading, in the frame it was started', async () => {
    let done = false;
    let promise: Promise<void> | null = null;
    const Reveal = () => {
      promise ??= new Promise<void>((resolve) => {
        const img = new Img();
        img.onload = () => ((done = true), resolve());
        img.src = PIXEL;
      });
      if (!done) throw promise;
      return <Rect id="revealed" width={4} height={4} fill="#fff" />;
    };
    root(() => (
      <Suspense fallback={null}>
        <Reveal />
      </Suspense>
    ));
    expect((await ids()).ids).toContain('revealed');
  });

  it('runs a draw asked for by a canvas after the images the frame loads are there', async () => {
    const seen: boolean[] = [];
    const Canvas = () => {
      useEffect(() => {
        const img = new Img();
        img.src = PIXEL;
        drawWhenSettled(Symbol('c'), () => seen.push(img.complete));
      });
      return <Rect id="r" width={4} height={4} fill="#fff" />;
    };
    root(Canvas);
    await ids();
    expect(seen).toEqual([true]);
  });

  it('reports a load that failed, with its URL', async () => {
    const Missing = () => {
      useEffect(() => {
        const img = new Img();
        img.src = 'no-such-picture.png';
      }, []);
      return <Rect id="r" width={4} height={4} fill="#fff" />;
    };
    root(Missing);
    const { result } = await ids();
    expect(result.unsupported.some((u) => u.property === 'load' && String(u.value).includes('no-such-picture.png'))).toBe(true);
  });

  it('gives the animation-frame callbacks of a frame one run while the page scripts load, however long that takes', async () => {
    let runs = 0;
    const Page = () => {
      useEffect(() => {
        const handle = delayRender(PAGE_LOAD_LABEL);
        const loop = () => {
          runs++;
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
        // A read of a file that takes some turns of the event loop: the number of turns is not the page's clock.
        realTimers.setTimeout(() => continueRender(handle), 60);
      }, []);
      return <Rect id="r" width={4} height={4} fill="#fff" />;
    };
    root(Page);
    await ids();
    expect(runs).toBe(1);
  });
});
