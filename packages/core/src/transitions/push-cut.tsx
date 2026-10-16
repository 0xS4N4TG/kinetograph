// `@remotion/transitions/push-cut`: a hard editorial cut. Both scenes punch in (the one going out before the cut, the
// one coming in after it) and a brief flash of colour marks the edit point. Made of the same CSS boxes as the published
// package's, so the styles it takes are CSS.

import type { CSSProperties, ReactNode } from 'react';
import { Easing } from '../easing.js';
import { AbsoluteFill } from '../fill.js';
import { interpolate } from '../interpolate.js';
import type { PresentationComponentProps, TransitionPresentation } from './types.js';

export interface PushCutProps extends Record<string, unknown> {
  /** Where in the transition the cut falls, 0 to 1 exclusive. Default 5 / 11. */
  cutProgress?: number;
  /** How far the scene going out is scaled at the cut. Default 1.04. */
  outgoingScale?: number;
  /** How far the scene coming in is scaled just after the cut. Default 1.04. */
  incomingStartScale?: number;
  /** How far the scene coming in is scaled at the end of the transition. Default 1.07. */
  incomingEndScale?: number;
  /** Default `50% 50%`. */
  transformOrigin?: CSSProperties['transformOrigin'];
  /** The colour of the flash. Default `#f5f2ed`. */
  flashColor?: string;
  /** The opacity of the flash at its brightest, 0 to 1. Default 0.2. */
  flashOpacity?: number;
  /** How many frames the flash fades out over after the cut. Default 2. */
  flashFrames?: number;
  /** Style laid over the outer or the inner box of the scene coming in or going out. */
  outerEnterStyle?: CSSProperties;
  outerExitStyle?: CSSProperties;
  innerEnterStyle?: CSSProperties;
  innerExitStyle?: CSSProperties;
}

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

const DEFAULT_CUT_PROGRESS = 5 / 11;
const DEFAULT_OUTGOING_SCALE = 1.04;
const DEFAULT_INCOMING_START_SCALE = 1.04;
const DEFAULT_INCOMING_END_SCALE = 1.07;
const DEFAULT_FLASH_OPACITY = 0.2;
const DEFAULT_FLASH_FRAMES = 2;

function validateFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new TypeError(`${name} passed to pushCut() must be finite, received ${value}`);
}

function validateProps(props: PushCutProps): void {
  const {
    cutProgress = DEFAULT_CUT_PROGRESS,
    outgoingScale = DEFAULT_OUTGOING_SCALE,
    incomingStartScale = DEFAULT_INCOMING_START_SCALE,
    incomingEndScale = DEFAULT_INCOMING_END_SCALE,
    flashOpacity = DEFAULT_FLASH_OPACITY,
    flashFrames = DEFAULT_FLASH_FRAMES,
  } = props;
  validateFinite('cutProgress', cutProgress);
  if (cutProgress <= 0 || cutProgress >= 1) {
    throw new TypeError(`cutProgress passed to pushCut() must be greater than 0 and less than 1, received ${cutProgress}`);
  }
  for (const [name, value] of [
    ['outgoingScale', outgoingScale],
    ['incomingStartScale', incomingStartScale],
    ['incomingEndScale', incomingEndScale],
  ] as const) {
    validateFinite(name, value);
    if (value <= 0) throw new TypeError(`${name} passed to pushCut() must be greater than 0, received ${value}`);
  }
  validateFinite('flashOpacity', flashOpacity);
  if (flashOpacity < 0 || flashOpacity > 1) {
    throw new TypeError(`flashOpacity passed to pushCut() must be between 0 and 1, received ${flashOpacity}`);
  }
  validateFinite('flashFrames', flashFrames);
  if (flashFrames < 0) {
    throw new TypeError(`flashFrames passed to pushCut() must be greater than or equal to 0, received ${flashFrames}`);
  }
}

function PushCutPresentation({
  children,
  presentationDirection,
  presentationDurationInFrames,
  presentationProgress,
  passedProps,
}: PresentationComponentProps<PushCutProps>): ReactNode {
  const {
    cutProgress = DEFAULT_CUT_PROGRESS,
    outgoingScale = DEFAULT_OUTGOING_SCALE,
    incomingStartScale = DEFAULT_INCOMING_START_SCALE,
    incomingEndScale = DEFAULT_INCOMING_END_SCALE,
    transformOrigin = '50% 50%',
    flashColor = '#f5f2ed',
    flashOpacity: peakFlashOpacity = DEFAULT_FLASH_OPACITY,
    flashFrames = DEFAULT_FLASH_FRAMES,
    outerEnterStyle,
    outerExitStyle,
    innerEnterStyle,
    innerExitStyle,
  } = passedProps;
  const isEntering = presentationDirection === 'entering';

  const outgoingProgress = interpolate(presentationProgress, [0, cutProgress], [0, 1], { ...clamp, easing: Easing.in(Easing.quad) });
  const incomingProgress = interpolate(presentationProgress, [cutProgress, 1], [0, 1], { ...clamp, easing: Easing.out(Easing.quad) });
  const scale = isEntering
    ? interpolate(incomingProgress, [0, 1], [incomingStartScale, incomingEndScale])
    : interpolate(outgoingProgress, [0, 1], [1, outgoingScale]);

  // The flash lights up on the frame before the cut for the scene going out and fades after it for the one coming in.
  const oneFrame = 1 / Math.max(1, presentationDurationInFrames);
  const flashTail = flashFrames / Math.max(1, presentationDurationInFrames);
  const flashOpacity = isEntering
    ? interpolate(presentationProgress, [cutProgress, cutProgress + flashTail], [peakFlashOpacity, 0], clamp)
    : interpolate(presentationProgress, [cutProgress - oneFrame, cutProgress], [0, peakFlashOpacity], clamp);

  const outerStyle: CSSProperties = {
    opacity: isEntering && presentationProgress < cutProgress ? 0 : 1,
    overflow: 'hidden',
    ...(isEntering ? outerEnterStyle : outerExitStyle),
  };
  const innerStyle: CSSProperties = {
    transform: `scale(${scale})`,
    transformOrigin,
    willChange: 'transform',
    ...(isEntering ? innerEnterStyle : innerExitStyle),
  };
  return (
    <AbsoluteFill style={outerStyle as Record<string, string | number>}>
      <AbsoluteFill style={innerStyle as Record<string, string | number>}>{children}</AbsoluteFill>
      {flashOpacity > 0 ? (
        <AbsoluteFill style={{ backgroundColor: flashColor, opacity: flashOpacity, pointerEvents: 'none' }} />
      ) : null}
    </AbsoluteFill>
  );
}

export function pushCut(props: PushCutProps = {}): TransitionPresentation<PushCutProps> {
  validateProps(props);
  return { component: PushCutPresentation, props };
}
