// The frame clock and the components that bend it: useCurrentFrame,
// useVideoConfig, Sequence, Series, Loop and Freeze (docs/AUTHORING.md §7.1).
// The state they all read and write is the `TimelineContext` that
// `@kinetograph/react` owns, so the native elements (`<Audio>`, `<Lottie>`) and
// the motion-blur sub-frames agree with them on time.

import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Layer, SequenceHost, TimelineContext, useTimeline, type TimelineState, type VideoConfig } from '@kinetograph/react';

/** The frame, relative to the enclosing Sequences (fractional on a motion-blur sub-frame). */
export function useCurrentFrame(): number {
  return useTimeline().frame;
}

/**
 * The composition's config. As in Remotion, `durationInFrames` is that of the
 * innermost Sequence or Loop, so a component sees how long it will be on screen.
 */
export function useVideoConfig(): VideoConfig {
  const { config, durationInFrames } = useTimeline();
  return durationInFrames === config.durationInFrames ? config : { ...config, durationInFrames };
}

type LayoutProp = 'absolute-fill' | 'none';

function checkNumber(component: string, prop: string, value: unknown, { allowInfinity = false } = {}): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError(`The "${prop}" prop of <${component}> must be a number, but got ${JSON.stringify(value)}`);
  }
  if (!allowInfinity && !Number.isFinite(value)) {
    throw new TypeError(`The "${prop}" prop of <${component}> must be finite, but got ${value}`);
  }
  return value;
}

function Scoped({ state, layout, children }: { state: TimelineState; layout?: LayoutProp; children: ReactNode }) {
  // `layout="none"` is Remotion's "no wrapper": the children go straight into the parent. The wrapper is Remotion's
  // AbsoluteFill: with DOM elements inside it is that `div` (docs/ENGINE.md §10), else a plain layer.
  const inner =
    layout === 'none' ? (
      <>{children}</>
    ) : (
      // Not a stacking context, as the AbsoluteFill it stands for is not: a child's `mixBlendMode` blends with what is behind.
      <Layer passThrough domFill={{ style: {}, background: false }}>
        {children}
      </Layer>
    );
  return <TimelineContext.Provider value={state}>{inner}</TimelineContext.Provider>;
}

/** The absolute frame a Sequence key says its Sequence starts at: the number after the key's last `@`. */
function keyStart(key: string): number {
  const at = key.lastIndexOf('@');
  return Number(key.slice(at + 1, key.indexOf('+', at)));
}

/**
 * The absolute frame at which `parent`'s frame 0 falls. A motion-blur sub-frame's two numbers carry rounding noise, so
 * a start within a hair of a whole frame is that frame. Inside a `<Freeze>` the frame is pinned and says nothing about
 * the start, so the enclosing Sequence's key does.
 */
function startOf(parent: TimelineState): number {
  if (parent.frozen) return parent.sequence ? keyStart(parent.sequence) : 0;
  const start = parent.absoluteFrame - parent.frame;
  const whole = Math.round(start);
  return Math.abs(start - whole) < 1e-6 ? whole : start;
}

/**
 * What the timeline records for a Sequence or Loop (docs/AUTHORING.md §11.4): rendered whether or not the Sequence is
 * showing. `from` is relative to the enclosing Sequence and `duration` already clamped.
 */
function recorded(parent: TimelineState, name: string | undefined, label: 'Sequence' | 'Loop', from: number, duration: number) {
  const parentKey = parent.sequence ?? null;
  const absoluteFrom = startOf(parent) + from;
  const key = `${parentKey ?? ''}/${name ?? label}@${absoluteFrom}+${duration}`;
  return {
    key,
    sequence: { key, name: name ?? (label === 'Loop' ? label : null), from: absoluteFrom, durationInFrames: duration, parent: parentKey },
  };
}

export interface SequenceProps {
  from?: number;
  /** In the children's own frames (what `useVideoConfig` gives them); the Sequence is on screen for this over `playbackRate`. */
  durationInFrames?: number;
  /** Frames of the children's clock skipped: their frame 0 is this. Default 0. */
  trimBefore?: number;
  /** How much faster the children's clock runs than the Sequence's. Default 1. */
  playbackRate?: number;
  /** Plays the children over and over for as long as the enclosing Sequence lasts; needs a finite `durationInFrames`. */
  loop?: boolean;
  name?: string;
  layout?: LayoutProp;
  children?: ReactNode;
}

/**
 * Shows its children from frame `from` for `durationInFrames`, with time shifted so their frame 0 is `from`. The
 * children sit in a plain `<Layer>`. `trimBefore` starts their clock later, `playbackRate` runs it faster or slower, and
 * `loop` repeats it. An `<Audio>` or `<Video>` inside follows that clock: its clip starts where the children's frame 0
 * falls, plays at this `playbackRate` times its own (nested rates multiply), and restarts with each loop iteration.
 */
export function Sequence({
  from = 0,
  durationInFrames = Infinity,
  trimBefore = 0,
  playbackRate = 1,
  loop = false,
  name,
  layout,
  children,
}: SequenceProps): ReactNode {
  const parent = useTimeline();
  checkNumber('Sequence', 'from', from);
  checkNumber('Sequence', 'durationInFrames', durationInFrames, { allowInfinity: true });
  if (durationInFrames < 0) {
    throw new TypeError(`The "durationInFrames" prop of <Sequence> must not be negative, but got ${durationInFrames}`);
  }
  if (typeof trimBefore !== 'number' || Number.isNaN(trimBefore)) {
    throw new TypeError(`The "trimBefore" prop of <Sequence /> must be a number, but got ${JSON.stringify(trimBefore)}.`);
  }
  if (!Number.isFinite(trimBefore)) throw new TypeError(`The "trimBefore" prop of <Sequence /> must be finite, but it is ${trimBefore}.`);
  if (trimBefore < 0) {
    throw new TypeError(`The "trimBefore" prop of <Sequence /> must be greater than or equal to 0, but got ${trimBefore}.`);
  }
  if (typeof playbackRate !== 'number' || !Number.isFinite(playbackRate) || playbackRate <= 0) {
    throw new TypeError(`The "playbackRate" prop of <Sequence /> must be a positive finite number, but got ${playbackRate}.`);
  }
  if (typeof loop !== 'boolean') {
    throw new TypeError(`The "loop" prop of <Sequence /> must be a boolean, but is of type ${typeof loop}.`);
  }
  if (loop && !Number.isFinite(durationInFrames)) {
    throw new Error('The "loop" prop of <Sequence /> requires a finite "durationInFrames" prop, because a <Sequence /> has no intrinsic duration.');
  }
  // On screen for `durationInFrames` of the children's clock, which runs `playbackRate` times as fast; a loop lasts as
  // long as the enclosing Sequence does. A Sequence cannot outlast what is left of the one around it.
  const window = loop ? Infinity : durationInFrames / playbackRate;
  const actualDuration = Math.min(window, parent.durationInFrames - from);
  const relative = parent.frame - from;
  const showing = relative >= 0 && relative < actualDuration;
  // A loop's iterations: each lasts `period` parent frames and starts the children again at `trimBefore`.
  let local = relative;
  let clockEnd = actualDuration * playbackRate + trimBefore;
  if (loop) {
    const period = durationInFrames / playbackRate;
    const elapsed = relative / period;
    const nearest = Math.round(elapsed);
    // An iteration boundary a few floating point units short of the next iteration is that iteration.
    const atBoundary = Math.abs(elapsed - nearest) <= Number.EPSILON * Math.max(1, Math.abs(elapsed)) * 4;
    const last = Math.max(0, Math.ceil(actualDuration / period) - 1);
    const iteration = Math.max(0, Math.min(last, atBoundary ? nearest : Math.floor(elapsed)));
    local = relative - iteration * period;
    clockEnd = Math.min(period, actualDuration - iteration * period) * playbackRate + trimBefore;
  }
  const frame = local * playbackRate + trimBefore;
  const { key, sequence } = recorded(parent, name, 'Sequence', from, Math.max(0, actualDuration));
  return (
    <SequenceHost sequence={sequence} wrapped={layout !== 'none'}>
      {showing ? (
        <Scoped state={{ ...parent, frame, durationInFrames: clockEnd, sequence: key, rate: (parent.rate ?? 1) * playbackRate }} layout={layout}>
          {children}
        </Scoped>
      ) : undefined}
    </SequenceHost>
  );
}

export interface SeriesSequenceProps {
  durationInFrames: number;
  offset?: number;
  name?: string;
  layout?: LayoutProp;
  children?: ReactNode;
}

function SeriesSequence({ children }: SeriesSequenceProps): ReactNode {
  return <>{children}</>;
}

/** Plays its `Series.Sequence` children one after another. */
function SeriesImpl({ children }: { children?: ReactNode }): ReactNode {
  let startFrame = 0;
  const items: ReactNode[] = [];
  Children.forEach(children, (child, index) => {
    if (child === null || child === undefined || typeof child === 'boolean') return;
    if (!isValidElement(child) || child.type !== SeriesSequence) {
      const got = isValidElement(child)
        ? `<${typeof child.type === 'string' ? child.type : ((child.type as { name?: string }).name ?? 'Component')} />`
        : JSON.stringify(child);
      throw new Error(
        `The <Series /> component only accepts a list of <Series.Sequence /> components as its children, but got ${got} instead`,
      );
    }
    const element = child as ReactElement<SeriesSequenceProps>;
    const { durationInFrames, offset = 0, layout, name, children: content } = element.props;
    checkNumber('Series.Sequence', 'durationInFrames', durationInFrames, { allowInfinity: true });
    checkNumber('Series.Sequence', 'offset', offset);
    const from = startFrame + offset;
    startFrame += durationInFrames + offset;
    if (durationInFrames <= 0) return;
    items.push(
      <Sequence key={element.key ?? `series-${index}`} from={from} durationInFrames={durationInFrames} layout={layout} name={name}>
        {content}
      </Sequence>,
    );
  });
  return <>{items}</>;
}

export const Series: ((props: { children?: ReactNode }) => ReactNode) & {
  Sequence: typeof SeriesSequence;
} = Object.assign(SeriesImpl, { Sequence: SeriesSequence });

export interface LoopProps {
  durationInFrames: number;
  times?: number;
  layout?: LayoutProp;
  name?: string;
  children?: ReactNode;
}

/** Plays its children over and over, `times` times (forever by default). */
export function Loop({ durationInFrames, times = Infinity, layout, name, children }: LoopProps): ReactNode {
  const parent = useTimeline();
  checkNumber('Loop', 'durationInFrames', durationInFrames);
  checkNumber('Loop', 'times', times, { allowInfinity: true });
  if (durationInFrames <= 0) {
    throw new TypeError(`The "durationInFrames" prop of <Loop> must be greater than 0, but got ${durationInFrames}`);
  }
  if (times <= 0) throw new TypeError(`The "times" prop of <Loop> must be greater than 0, but got ${times}`);
  const total = Math.min(durationInFrames * times, parent.durationInFrames);
  const showing = parent.frame >= 0 && parent.frame < total;
  const { key, sequence } = recorded(parent, name, 'Loop', 0, total);
  return (
    <SequenceHost sequence={sequence} wrapped={layout !== 'none'}>
      {showing ? (
        <Scoped state={{ ...parent, frame: parent.frame % durationInFrames, durationInFrames, sequence: key }} layout={layout}>
          {children}
        </Scoped>
      ) : undefined}
    </SequenceHost>
  );
}

export interface FreezeProps {
  frame: number;
  active?: boolean | ((frame: number) => boolean);
  children?: ReactNode;
}

/** Shows its children as they are at `frame`, whatever frame it really is. */
export function Freeze({ frame, active = true, children }: FreezeProps): ReactNode {
  const parent = useTimeline();
  checkNumber('Freeze', 'frame', frame);
  const frozen = typeof active === 'function' ? active(parent.frame) : active;
  // Always a provider, so toggling `active` does not change the tree's shape (and with it the automatic ids).
  const state = frozen ? { ...parent, frame, frozen: true } : parent;
  return <TimelineContext.Provider value={state}>{children}</TimelineContext.Provider>;
}

/** Whether the component is inside an active `<Freeze>`. (Remotion leaves out the freeze of a premount; nothing premounts here.) */
export function useIsInsideNonPremountFreeze(): boolean {
  return useTimeline().frozen;
}
