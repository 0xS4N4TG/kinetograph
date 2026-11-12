// `@remotion/three`, written from its public documentation: `<ThreeCanvas>` takes `width`, `height` and the props of React
// Three Fiber's `<Canvas>`, and what is inside it is drawn for the frame being rendered. `three` and `@react-three/fiber` are
// the project's own dependencies (peer dependencies of this package): the bundle finds them in the project.
//
// There is no render loop: the canvas is a `frameloop="never"` one that this component advances once for each frame, to the
// frame's time (`advance` takes seconds). `useFrame` therefore runs once per frame with the delta since the last frame
// drawn; a scene that moves is written from `useCurrentFrame()` as in Remotion, which works inside the canvas.
//
// A `<Sequence>` inside the canvas works (Remotion tells to give it `layout="none"`); it takes its place in the scene as a
// `THREE.Group`, so it is not recorded in the timeline the way a Sequence of the page is.

import { Suspense, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Canvas, extend, useThree, type CanvasProps } from '@react-three/fiber';
import { Group } from 'three';
import { continueRender, delayRender } from './assets.js';
import { cancelDraw, drawWhenSettled } from './canvas-draws.js';
import { useCurrentFrame, useVideoConfig } from './timeline.js';

// The host elements that `<Sequence>` and `<Layer>` render, which R3F looks up by name in its catalogue ("Kg-sequence").
extend({ 'Kg-sequence': Group, 'Kg-layer': Group });

export type ThreeCanvasProps = Omit<CanvasProps, 'frameloop' | 'style' | 'children'> & {
  width: number;
  height: number;
  style?: CSSProperties;
  children?: ReactNode;
};

/**
 * Draws the scene for the current frame, once the frame has settled: the children are in place, every Suspense has revealed
 * and the loads are done. It is the last child and asks in a passive effect, as the children's own passive effects run first:
 * drei's `<Environment>` sets `scene.environment` in one, and a draw before it would show the frame without the lighting.
 */
function Advance({ seconds }: { seconds: number }) {
  const advance = useThree((state) => state.advance);
  const key = useRef(Symbol('ThreeCanvas'));
  useEffect(() => {
    // Not now: the frame loop draws when what the frame loads has settled (canvas-draws.ts), so a texture a loader or a
    // Suspense of the page's own was still reading is in the frame.
    drawWhenSettled(key.current, () => advance(seconds));
    return () => cancelDraw(key.current);
  }, [advance, seconds]);
  return null;
}

/** The fallback of the canvas's Suspense: the frame waits for what the scene loads (a texture, a model) while it is shown. */
function HoldFrame() {
  const [handle] = useState(() => delayRender('ThreeCanvas: waiting for what the scene loads'));
  useEffect(() => () => continueRender(handle), [handle]);
  return null;
}

/**
 * A React Three Fiber canvas of `width` x `height` that shows the scene at the current frame. The frame is held while
 * anything under it suspends (`useTexture`, `useGLTF`), so a frame is never drawn before its textures are there.
 */
export function ThreeCanvas({ width, height, style, children, ...canvas }: ThreeCanvasProps) {
  const rest: Record<string, unknown> = canvas;
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    // The size of the canvas is known: the measuring library's own debounce would be a timer that only fires frames later.
    <Canvas resize={{ scroll: false, debounce: 0 }} {...rest} frameloop="never" style={{ width, height, ...style }}>
      <Suspense fallback={<HoldFrame />}>
        {children}
        <Advance seconds={frame / fps} />
      </Suspense>
    </Canvas>
  );
}
