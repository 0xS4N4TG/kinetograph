// `@remotion/motion-blur`: `Trail` and `CameraMotionBlur`.
//
// `Trail` stacks copies of its children that are a little behind in time, each
// fainter the further back it is, so a moving thing leaves a tail.
// `CameraMotionBlur` is the engine's own motion blur: the layer is drawn at
// several moments inside the time the shutter is open and the pictures are
// averaged (SCENE.md, "Motion blur"; the frame loop renders the sub-frames).

import type { ReactNode } from 'react';
import { Layer } from '@kinetographdev/react';
import { Freeze, useCurrentFrame } from './timeline.js';

function requireNumber(name: string, value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError(`"${name}" must be a number, but got ${value}`);
  }
  return value;
}

/**
 * The children are drawn once per copy, so give them no explicit `id` (the same id twice in one tree is an error).
 */
export interface TrailProps {
  /** How many fainter copies trail behind the live one. */
  layers: number;
  /** How many frames each copy is behind the one in front of it. */
  lagInFrames: number;
  /** Opacity of the copy just behind the live one is `trailOpacity * (layers - 1) / layers`; the oldest fades to nothing. */
  trailOpacity: number;
  children?: ReactNode;
}

export function Trail({ layers, lagInFrames, trailOpacity, children }: TrailProps): ReactNode {
  requireNumber('layers', layers);
  requireNumber('lagInFrames', lagInFrames);
  requireNumber('trailOpacity', trailOpacity);
  const frame = useCurrentFrame();
  const copies: ReactNode[] = [];
  // The oldest copy (k = 0) would have opacity 0, so it is not drawn.
  for (let k = 1; k < layers; k++) {
    const behind = (layers - k) * lagInFrames;
    copies.push(
      <Layer key={k} opacity={(trailOpacity * k) / layers}>
        <Freeze frame={Math.max(0, frame - behind)}>{children}</Freeze>
      </Layer>,
    );
  }
  return (
    <>
      {copies}
      <Layer key="live">{children}</Layer>
    </>
  );
}

export interface CameraMotionBlurProps {
  /** Moments averaged. Default 10; the engine takes 2 to 64. */
  samples?: number;
  /** Degrees of a 360 degree shutter that are open. Default 180, half a frame. */
  shutterAngle?: number;
  children?: ReactNode;
}

export function CameraMotionBlur({ samples = 10, shutterAngle = 180, children }: CameraMotionBlurProps): ReactNode {
  requireNumber('samples', samples);
  requireNumber('shutterAngle', shutterAngle);
  return (
    <Layer motionBlur={{ samples: Math.min(64, Math.max(2, Math.round(samples))), shutter: shutterAngle / 360 }}>{children}</Layer>
  );
}
