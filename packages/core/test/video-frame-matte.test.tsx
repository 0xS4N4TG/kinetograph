// The way an effect reads a matte's alpha per frame with `onVideoFrame`: draw the frame at the size wanted on an
// `OffscreenCanvas`, read its alpha with `getImageData`, keep it in state, and draw the frame from it. A frame rendered
// alone gives what the same frame gives in a full render (the state holds what the frame's own handler made).
import { createRequire } from 'node:module';
import { useMemo, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Rect, Video } from '@kinetographdev/react';
import { fileURLToPath } from 'node:url';
import { resetRenderState } from '../src/assets.js';
import { Composition, registerRoot, resetCompositions } from '../src/compositions.js';
import { installDeterminism, resetVirtualClock, uninstallDeterminism } from '../src/determinism.js';
import '../src/web-install.js';
import '../src/video-frame.js';
import { createFrameRenderer } from '../src/frame-loop.js';

const MATTE = fileURLToPath(new URL('../../../crates/core/tests/scenes/media/matte-4444.mkv', import.meta.url));
const hasAddon = (() => {
  try {
    return typeof (createRequire(import.meta.url)('@kinetographdev/native') as Record<string, unknown>).readCanvasPicture === 'function';
  } catch {
    return false;
  }
})();

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

// A quarter of the matte's size: 16 x 9. The disc of radius 10 (40% of the height) is centred at x = 8 + 4n, y = 18 of 64 x 36.
const W = 16;
const H = 9;

function Matte() {
  const surface = useMemo(() => new (globalThis as any).OffscreenCanvas(W, H) as { getContext(type: '2d', options?: unknown): any }, []);
  const [alpha, setAlpha] = useState<Uint8Array | null>(null);
  return (
    <>
      <Video
        src={MATTE}
        width={64}
        height={36}
        onVideoFrame={(frame) => {
          const ctx = surface.getContext('2d', { willReadFrequently: true })!;
          ctx.clearRect(0, 0, W, H); // an OffscreenCanvas keeps its pixels, as in a browser: a matte must not pile up
          ctx.drawImage(frame, 0, 0, W, H);
          const { data } = ctx.getImageData(0, 0, W, H);
          setAlpha(Uint8Array.from({ length: W * H }, (_, i) => data[i * 4 + 3]!));
        }}
      />
      {Array.from(alpha ?? [], (a, i) => ({ a, i }))
        .filter(({ a }) => a > 127)
        .map(({ i }) => <Rect key={i} id={`px${i}`} x={(i % W) * 4} y={Math.floor(i / W) * 4} width={4} height={4} fill="#fff" />)}
    </>
  );
}

describe.skipIf(!hasAddon)('a matte read per frame', () => {
  const covered = async (frames: number[]): Promise<number[][]> => {
    registerRoot(() => <Composition id="Matte" component={Matte} width={64} height={36} fps={12} durationInFrames={12} />);
    const renderer = createFrameRenderer('Matte');
    const out: number[][] = [];
    for (const frame of frames) {
      const { scene } = await renderer.renderFrame(frame);
      const ids = JSON.stringify(scene.layers).match(/px\d+/g) ?? [];
      out.push(ids.map((id) => Number(id.slice(2))).sort((a, b) => a - b));
    }
    renderer.dispose();
    return out;
  };

  it('draws the disc where the matte has alpha, and moves it with the frame', async () => {
    const [first, later] = await covered([0, 5]);
    const columns = (ids: number[]) => [Math.min(...ids.map((i) => i % W)), Math.max(...ids.map((i) => i % W))];
    // At quarter size the disc's centre is x = 2 + n (of 16), its radius 2.5.
    expect(columns(first!)).toEqual([0, 4]);
    expect(columns(later!)).toEqual([5, 9]);
  });

  it('gives a frame rendered alone the picture it has in a full render', async () => {
    const [, , inOrder] = await covered([0, 1, 5]);
    resetCompositions();
    resetVirtualClock();
    const [alone] = await covered([5]);
    expect(alone).toEqual(inOrder);
    expect(alone!.length).toBeGreaterThan(0);
  });
});
