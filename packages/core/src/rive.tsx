// `@remotion/rive` (docs/AUTHORING.md §7.6): `<RemotionRiveCanvas>`. Remotion plays the file with Rive's WebAssembly
// runtime in a `<canvas>`; this plays it with Rive's own C++ runtime inside the addon (docs/AUTHORING.md §7.6) and
// draws what it asks for on the same `<canvas>`, so the element is laid out and styled as the DOM element it is in
// Remotion. A frame is played from the file's start to the frame's time, never from what was played before.

import { forwardRef, useImperativeHandle, useLayoutEffect, useMemo, useRef, type ForwardedRef, type ReactNode } from 'react';
import { addonFunction, getDomEnvironment, resolveProjectFile } from '@kinetograph/compat/dom';
import type { CanvasCommand } from '@kinetograph/scene';
import { reportUnsupported } from './unsupported.js';
import { Sequence, useCurrentFrame, useVideoConfig } from './timeline.js';

export type RemotionRiveCanvasFit = 'contain' | 'cover' | 'fill' | 'fit-height' | 'fit-width' | 'none' | 'scale-down';

export type RemotionRiveCanvasAlignment =
  | 'center'
  | 'bottom-center'
  | 'bottom-left'
  | 'bottom-right'
  | 'center-left'
  | 'center-right'
  | 'top-center'
  | 'top-left'
  | 'top-right';

export interface RemotionRiveCanvasProps {
  /** A `.riv` file: a path, or `staticFile(...)`. A URL cannot be fetched; download the file. */
  src: string;
  fit?: RemotionRiveCanvasFit;
  alignment?: RemotionRiveCanvasAlignment;
  /** By name or position; the file's default artboard when left out. */
  artboard?: string | number;
  /** A linear animation, by name or position; the artboard's first when left out. */
  animation?: string | number;
  /** Plays a state machine instead of an animation (not in Remotion's props): from its start, with its inputs at their defaults. */
  stateMachine?: string | number;
  className?: string;
  style?: Record<string, string | number | undefined>;
  /** Not drawn: reported as unsupported when given. */
  onLoad?: unknown;
  assetLoader?: unknown;
  effects?: unknown;
  effectsOutputSize?: unknown;
  /** Accepted: the file's embedded pictures are used, a referenced one is not fetched. */
  enableRiveAssetCdn?: boolean;
  /** As `<Sequence>`'s. */
  from?: number;
  durationInFrames?: number;
  name?: string;
}

/**
 * What Remotion's `ref` gives: the runtime's own objects. The runtime here is in the addon and does not hand those
 * out, so each answers `null`.
 */
export interface RiveCanvasRef {
  getAnimationInstance: () => null;
  getArtboard: () => null;
  getRenderer: () => null;
  getCanvas: () => null;
}

/** What the `<canvas>` element's ref is: the DOM shim's element, whose 2D context records its commands. */
interface CanvasHost {
  getContext(type: '2d'): { reset(): void; commands: CanvasCommand[] } | null;
}

/** The properties Remotion's component has and this does not draw. */
const NOT_DRAWN: [keyof RemotionRiveCanvasProps, string][] = [
  ['onLoad', 'the callback is not called: the runtime lives in the addon and has no File object to give it'],
  ['assetLoader', 'a custom loader for assets outside the file is not called; use pictures and fonts embedded in the file'],
  ['effects', 'effects over the canvas are not applied'],
  ['effectsOutputSize', 'effects over the canvas are not applied'],
];

function Content(props: RemotionRiveCanvasProps, ref: ForwardedRef<RiveCanvasRef>): ReactNode {
  const { src, fit = 'contain', alignment = 'center', artboard, animation, stateMachine, className, style } = props;
  const { width, height, fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const canvas = useRef<CanvasHost | null>(null);
  useImperativeHandle(ref, () => ({ getAnimationInstance: () => null, getArtboard: () => null, getRenderer: () => null, getCanvas: () => null }), []);

  for (const [key, reason] of NOT_DRAWN) {
    if (props[key] !== undefined && props[key] !== null) reportUnsupported('RemotionRiveCanvas', key, null, reason);
  }

  const commands = useMemo(() => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src)) {
      throw new Error(`<RemotionRiveCanvas src="${src}">: a URL cannot be fetched while rendering; download the file and use staticFile()`);
    }
    const request = {
      src: resolveProjectFile(src) ?? src,
      baseDir: getDomEnvironment().baseDir,
      artboard,
      animation,
      stateMachine,
      time: frame / fps,
      width,
      height,
      fit,
      alignment,
    };
    return JSON.parse(addonFunction('riveFrame')(JSON.stringify(request))) as CanvasCommand[];
  }, [src, artboard, animation, stateMachine, frame, fps, width, height, fit, alignment]);

  useLayoutEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    context.reset();
    context.commands.push(...commands);
  }, [commands]);

  return <canvas ref={canvas as never} width={width} height={height} className={className} style={{ height, width, ...style }} />;
}

const Canvas = forwardRef<RiveCanvasRef, RemotionRiveCanvasProps>(Content);

/** Plays a Rive file in a `<canvas>` as large as the composition, as Remotion's does. */
export const RemotionRiveCanvas = forwardRef<RiveCanvasRef, RemotionRiveCanvasProps>(function RemotionRiveCanvas(props, ref) {
  const { from, durationInFrames, name } = props;
  return (
    <Sequence layout="none" from={from} durationInFrames={durationInFrames} name={name ?? '<RemotionRiveCanvas>'}>
      <Canvas ref={ref} {...props} />
    </Sequence>
  );
});
RemotionRiveCanvas.displayName = 'RemotionRiveCanvas';
