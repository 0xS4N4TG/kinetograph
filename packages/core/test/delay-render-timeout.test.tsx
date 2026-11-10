// A delayRender() that nothing clears fails the frame with its label (issue #101), and what the frame held when it
// gave up (an <iframe> whose onLoad never fires) travels with the error, so `doctor` can list it.

import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { delayRender, resetRenderState } from '../src/assets.js';
import { Composition, registerRoot, resetCompositions } from '../src/compositions.js';
import { resetVirtualClock, uninstallDeterminism } from '../src/determinism.js';
import { createFrameRenderer } from '../src/frame-loop.js';
import { AbsoluteFill } from '../src/fill.js';
import { useFakeDom } from './dom-harness.js';

useFakeDom(['iframe']);

beforeEach(() => {
  resetCompositions();
  resetRenderState();
  resetVirtualClock();
});
afterEach(() => {
  uninstallDeterminism();
  resetRenderState();
});

function Page() {
  useState(() => delayRender('waiting for the page', { timeoutInMilliseconds: 40 }));
  return (
    <AbsoluteFill>
      <iframe src="https://example.com" onLoad={() => undefined} />
    </AbsoluteFill>
  );
}

describe('a delayRender() that is never cleared', () => {
  it('fails the frame with the DELAY_RENDER_TIMEOUT code and the label', async () => {
    registerRoot(() => <Composition id="T" component={Page} width={64} height={64} fps={24} durationInFrames={2} />);
    await expect(createFrameRenderer('T').renderFrame(0)).rejects.toMatchObject({
      code: 'DELAY_RENDER_TIMEOUT',
      message: expect.stringContaining('A delayRender() "waiting for the page" was called but not cleared after 40ms'),
    });
  });

  it('carries what the frame drew when it gave up, the <iframe> among it', async () => {
    registerRoot(() => <Composition id="T" component={Page} width={64} height={64} fps={24} durationInFrames={2} />);
    const error = await createFrameRenderer('T')
      .renderFrame(0)
      .then(
        () => null,
        (e: Error & { unsupported?: { element: string }[] }) => e,
      );
    expect(error?.unsupported?.map((item) => item.element)).toEqual(['iframe']);
  });
});
