import { describe, expect, it } from 'vitest';
import type { LayerJson } from '@kinetograph/scene';
import { CameraMotionBlur, Trail, type TrailProps } from '../src/motion-blur.js';
import { probe, renderAt, type Seen } from './scene-harness.js';

/** Probe frames and the opacity of the layer around each, bottom (oldest) first. */
function trail(props: { layers: number; lagInFrames: number; trailOpacity: number }, frame: number) {
  const seen: Seen[] = [];
  // (explicit ids would be repeated in every copy)
  const P = probe('p', seen, false);
  const tree = renderAt(
    <Trail {...props}>
      <P />
    </Trail>,
    frame,
  );
  const opacities = (tree.layers as LayerJson[]).map((l) => (typeof l.opacity === 'number' ? l.opacity : 1));
  return { frames: seen.map((s) => s.frame), opacities };
}

describe('Trail', () => {
  // Values recorded from @remotion/motion-blur@4.0.535 rendered in a Player: the live copy and `layers`
  // copies behind it, the oldest invisible (and so not drawn here), clamped at frame 0.
  it('shows copies lagging behind, fainter the older they are', () => {
    const at20 = trail({ layers: 3, lagInFrames: 2, trailOpacity: 0.5 }, 20);
    expect(at20.frames).toEqual([16, 18, 20]);
    expect(at20.opacities[0]).toBeCloseTo(0.16666666666666669, 12);
    expect(at20.opacities[1]).toBeCloseTo(0.33333333333333337, 12);
    expect(at20.opacities[2]).toBe(1);
  });

  it('does not go before frame 0', () => {
    expect(trail({ layers: 3, lagInFrames: 2, trailOpacity: 0.5 }, 0).frames).toEqual([0, 0, 0]);
    expect(trail({ layers: 3, lagInFrames: 2, trailOpacity: 0.5 }, 5).frames).toEqual([1, 3, 5]);
  });

  it('takes a lag of a fraction of a frame', () => {
    const t = trail({ layers: 3, lagInFrames: 0.5, trailOpacity: 1 }, 5);
    expect(t.frames).toEqual([4, 4.5, 5]);
    expect(t.opacities[0]).toBeCloseTo(0.3333333333333333, 12);
    expect(t.opacities[1]).toBeCloseTo(0.6666666666666667, 12);
  });

  it('is only the live copy with one layer', () => {
    expect(trail({ layers: 1, lagInFrames: 2, trailOpacity: 1 }, 5)).toEqual({ frames: [5], opacities: [1] });
  });

  it('needs all three numbers, as the published component does', () => {
    expect(() => renderAt(<Trail {...({ layers: 3 } as unknown as TrailProps)} />)).toThrow('"lagInFrames" must be a number, but got undefined');
    expect(() => renderAt(<Trail {...({ layers: 3, lagInFrames: 1 } as unknown as TrailProps)} />)).toThrow('"trailOpacity" must be a number, but got undefined');
  });

  it('is silent for audio: the lagging copies are frozen', () => {
    // A frozen timeline mutes <Audio>; the live copy is not frozen.
    const seen: boolean[] = [];
    const tree = renderAt(
      <Trail layers={2} lagInFrames={1} trailOpacity={1}>
        <Probe2 seen={seen} />
      </Trail>,
      10,
    );
    expect(tree.layers).toBeDefined();
    expect(seen).toEqual([true, false]);
  });
});

import { useTimeline } from '@kinetograph/react';
function Probe2({ seen }: { seen: boolean[] }) {
  seen.push(useTimeline().frozen);
  return null;
}

describe('CameraMotionBlur', () => {
  it('is a layer with motion blur: samples and a shutter as a fraction of 360 degrees', () => {
    const [layer] = renderAt(<CameraMotionBlur samples={8} shutterAngle={180} />).layers as any[];
    expect(layer.type).toBe('group');
    expect(layer.motionBlur).toMatchObject({ samples: 8, shutter: 0.5 });
  });

  it('defaults to 10 samples and a 180 degree shutter', () => {
    const [layer] = renderAt(<CameraMotionBlur />).layers as any[];
    expect(layer.motionBlur).toMatchObject({ samples: 10, shutter: 0.5 });
  });

  it('keeps samples within what the engine takes', () => {
    expect((renderAt(<CameraMotionBlur samples={1} />).layers[0] as any).motionBlur.samples).toBe(2);
    expect((renderAt(<CameraMotionBlur samples={500} shutterAngle={360} />).layers[0] as any).motionBlur).toMatchObject({ samples: 64, shutter: 1 });
  });
});
