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
import { Layer, TimelineContext, useTimeline, type TimelineState, type VideoConfig } from '@kinetograph/react';

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
  // `layout="none"` is Remotion's "no wrapper": the children go straight into the parent.
  const inner = layout === 'none' ? <>{children}</> : <Layer>{children}</Layer>;
  return <TimelineContext.Provider value={state}>{inner}</TimelineContext.Provider>;
}

export interface SequenceProps {
  from?: number;
  durationInFrames?: number;
  name?: string;
  layout?: LayoutProp;
  children?: ReactNode;
}

/**
 * Shows its children from frame `from` for `durationInFrames`, with time
 * shifted so their frame 0 is `from`. The children sit in a plain `<Layer>`.
 */
export function Sequence({ from = 0, durationInFrames = Infinity, layout, children }: SequenceProps): ReactNode {
  const parent = useTimeline();
  checkNumber('Sequence', 'from', from);
  checkNumber('Sequence', 'durationInFrames', durationInFrames, { allowInfinity: true });
  if (durationInFrames < 0) {
    throw new TypeError(`The "durationInFrames" prop of <Sequence> must not be negative, but got ${durationInFrames}`);
  }
  // A Sequence cannot outlast what is left of the one around it.
  const actualDuration = Math.min(durationInFrames, parent.durationInFrames - from);
  const relative = parent.frame - from;
  if (relative < 0 || relative >= actualDuration) return null;
  return (
    <Scoped state={{ ...parent, frame: relative, durationInFrames: actualDuration }} layout={layout}>
      {children}
    </Scoped>
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
export function Loop({ durationInFrames, times = Infinity, layout, children }: LoopProps): ReactNode {
  const parent = useTimeline();
  checkNumber('Loop', 'durationInFrames', durationInFrames);
  checkNumber('Loop', 'times', times, { allowInfinity: true });
  if (durationInFrames <= 0) {
    throw new TypeError(`The "durationInFrames" prop of <Loop> must be greater than 0, but got ${durationInFrames}`);
  }
  if (times <= 0) throw new TypeError(`The "times" prop of <Loop> must be greater than 0, but got ${times}`);
  const total = Math.min(durationInFrames * times, parent.durationInFrames);
  if (parent.frame < 0 || parent.frame >= total) return null;
  return (
    <Scoped state={{ ...parent, frame: parent.frame % durationInFrames, durationInFrames }} layout={layout}>
      {children}
    </Scoped>
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
