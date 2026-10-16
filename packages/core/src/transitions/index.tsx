// `@remotion/transitions`: `TransitionSeries` plays scenes one after another and
// lets a transition overlap the end of one with the start of the next. The
// presentations (`fade`, `slide`, `wipe`, `flip`, `clockWipe`, `iris`, `none`, and
// the shader ones, `crossZoom`, `ripple`, ...) are in their own modules, as in the
// package. Written from the documented
// behaviour; the timing, the overlap arithmetic and the error messages are
// checked against what the published package does (test/fixtures/transitions.json).

import { Children, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import { interpolate } from '../interpolate.js';
import type { EasingFunction } from '../easing.js';
import { measureSpring, spring, type SpringConfig } from '../spring.js';
import { Sequence, useCurrentFrame, useVideoConfig } from '../timeline.js';
import { EnteringContext, ExitingContext, TransitionIdContext } from './context.js';
import { slide } from './slide.js';
import type { PresentationDirection, TransitionPresentation, TransitionTiming } from './types.js';

export type {
  PresentationComponentProps,
  PresentationDirection,
  TransitionPresentation,
  TransitionPresentationComponentProps,
  TransitionTiming,
} from './types.js';
export { useTransitionProgress } from './context.js';
export type { TransitionState } from './context.js';
export { makeHtmlInCanvasPresentation } from './html-in-canvas.js';
export type { HtmlInCanvasShader, HtmlInCanvasShaderDraw, HtmlInCanvasShaderDrawParams, ShaderCanvas } from './html-in-canvas.js';
export { blurSlide } from './blur-slide.js';
export type { BlurSlideDirection, BlurSlideProps } from './blur-slide.js';
export { crossZoom } from './cross-zoom.js';
export type { CrossZoomProps } from './cross-zoom.js';
export { dreamyZoom } from './dreamy-zoom.js';
export type { DreamyZoomProps } from './dreamy-zoom.js';
export { filmBurn } from './film-burn.js';
export type { FilmBurnProps } from './film-burn.js';
export { linearBlur } from './linear-blur.js';
export type { LinearBlurProps } from './linear-blur.js';
export { pushCut } from './push-cut.js';
export type { PushCutProps } from './push-cut.js';

// ---- timings ----

/** The transition's progress goes from 0 to 1 in a straight line (or eased) over `durationInFrames`. */
export function linearTiming({
  durationInFrames,
  easing,
}: {
  durationInFrames: number;
  easing?: EasingFunction;
}): TransitionTiming {
  return {
    getDurationInFrames: () => durationInFrames,
    getProgress: ({ frame }) =>
      interpolate(frame, [0, durationInFrames], [0, 1], {
        easing,
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      }),
  };
}

/** The transition's progress follows a spring. It lasts as long as the spring takes to settle unless a duration is given. */
export function springTiming({
  config,
  durationInFrames,
  durationRestThreshold,
  reverse,
}: {
  config?: Partial<SpringConfig>;
  durationInFrames?: number;
  durationRestThreshold?: number;
  reverse?: boolean;
} = {}): TransitionTiming {
  return {
    getDurationInFrames: ({ fps }) =>
      durationInFrames ?? measureSpring({ fps, config, threshold: durationRestThreshold }),
    // A reversed spring runs from 1 down to 0; as a transition's progress it is turned back to rise from 0.
    getProgress: ({ frame, fps }) => {
      const value = spring({ frame, fps, config, durationInFrames, durationRestThreshold, reverse });
      return reverse ? 1 - value : value;
    },
  };
}

// ---- children of a TransitionSeries ----

type LayoutProp = 'absolute-fill' | 'none';

export interface TransitionSeriesSequenceProps {
  durationInFrames: number;
  /** Frames to move the start by: positive leaves a gap, negative overlaps the scene before. */
  offset?: number;
  name?: string;
  layout?: LayoutProp;
  children?: ReactNode;
}

export interface TransitionSeriesTransitionProps<P extends Record<string, unknown> = Record<string, unknown>> {
  /** Default `slide()`. */
  presentation?: TransitionPresentation<P>;
  timing: TransitionTiming;
}

export interface TransitionSeriesOverlayProps {
  durationInFrames: number;
  offset?: number;
  children?: ReactNode;
}

// These render nothing themselves: TransitionSeries reads their props.
function TransitionSeriesSequence(_props: TransitionSeriesSequenceProps): ReactNode {
  return null;
}
function TransitionSeriesTransition<P extends Record<string, unknown>>(_props: TransitionSeriesTransitionProps<P>): ReactNode {
  return null;
}
function TransitionSeriesOverlay(_props: TransitionSeriesOverlayProps): ReactNode {
  return null;
}

interface TransitionInfo {
  presentation: TransitionPresentation<any>;
  timing: TransitionTiming;
  duration: number;
  /** Shared by the presentations of the scene going out and the one coming in (`TransitionIdContext`). */
  id: string;
}

function Scene({
  enter,
  exit,
  duration,
  children,
}: {
  enter: TransitionInfo | null;
  exit: TransitionInfo | null;
  duration: number;
  children: ReactNode;
}): ReactNode {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // The scene leaves during its last frames of the transition and arrives during the first. Its presentation wraps it
  // only while that transition runs, as the published package does: a presentation need not draw nothing at rest (the
  // tape strip of a papercut `tapePull` would sit on the scene for the whole of it).
  const leaving = frame - (duration - (exit?.duration ?? 0));
  const exiting = exit !== null && leaving >= 0 && leaving < exit.duration;
  const entering = enter !== null && frame >= 0 && frame < enter.duration;
  const wrap = (info: TransitionInfo, direction: PresentationDirection, progressFrame: number, content: ReactNode) => {
    const Presentation = info.presentation.component;
    const presentationProgress = info.timing.getProgress({ frame: progressFrame, fps });
    return (
      <TransitionIdContext.Provider value={info.id}>
        <Presentation
          presentationProgress={presentationProgress}
          presentationDirection={direction}
          presentationDurationInFrames={info.duration}
          passedProps={info.presentation.props}
          bothEnteringAndExiting={entering && exiting}
        >
          {direction === 'entering' ? (
            <EnteringContext.Provider value={{ enteringProgress: presentationProgress }}>{content}</EnteringContext.Provider>
          ) : (
            <ExitingContext.Provider value={{ exitingProgress: presentationProgress }}>{content}</ExitingContext.Provider>
          )}
        </Presentation>
      </TransitionIdContext.Provider>
    );
  };
  let node = children;
  // The presentation of the transition going out is the outer one, as in the published package.
  if (entering) node = wrap(enter, 'entering', frame, node);
  if (exiting) node = wrap(exit, 'exiting', leaving, node);
  return <>{node}</>;
}

function describe(child: unknown): string {
  return `${child}`;
}

function TransitionSeriesImpl({ children }: { children?: ReactNode }): ReactNode {
  const { fps } = useVideoConfig();
  const series = useId().replace(/[^A-Za-z0-9]/g, '');
  const items = Children.toArray(children) as ReactNode[];

  const scenes: ReactNode[] = [];
  const overlays: ReactNode[] = [];
  let previousEnd = 0;
  let pending: TransitionInfo | null = null;
  const sceneProps: {
    start: number;
    duration: number;
    enter: TransitionInfo | null;
    exit: TransitionInfo | null;
    element: ReactElement<TransitionSeriesSequenceProps>;
    index: number;
  }[] = [];

  items.forEach((item, index) => {
    if (!isValidElement(item)) {
      throw new TypeError(
        `The <TransitionSeries /> component only accepts a list of <TransitionSeries.Sequence />, <TransitionSeries.Transition />, and <TransitionSeries.Overlay /> components as its children, but got ${describe(item)} instead`,
      );
    }
    const type = item.type;
    const next = items[index + 1];
    const nextType = isValidElement(next) ? next.type : undefined;

    if (type === TransitionSeriesTransition) {
      if (nextType === TransitionSeriesTransition) {
        throw new TypeError(
          `A <TransitionSeries.Transition /> component must not be followed by another <TransitionSeries.Transition /> component (nth children = ${index} and ${index + 1})`,
        );
      }
      if (nextType === TransitionSeriesOverlay) {
        throw new TypeError(
          `A <TransitionSeries.Transition /> component must not be followed by a <TransitionSeries.Overlay /> component (nth children = ${index} and ${index + 1})`,
        );
      }
      const { presentation = slide(), timing } = (item as ReactElement<TransitionSeriesTransitionProps>).props;
      pending = { presentation, timing, duration: timing.getDurationInFrames({ fps }), id: `transition-${series}-${index}` };
      return;
    }

    if (type === TransitionSeriesOverlay) {
      if (nextType === TransitionSeriesTransition) {
        throw new TypeError(
          `A <TransitionSeries.Overlay /> component must not be followed by a <TransitionSeries.Transition /> component (nth children = ${index} and ${index + 1})`,
        );
      }
      const { durationInFrames, offset = 0, children: content } = (item as ReactElement<TransitionSeriesOverlayProps>).props;
      // An overlay sits across the cut between the scenes around it.
      const start = previousEnd - Math.floor(durationInFrames / 2) + offset;
      if (start < 0) {
        throw new TypeError(
          `A <TransitionSeries.Overlay /> extends before frame 0. The overlay starts at frame ${start}. Reduce the duration or adjust the offset.`,
        );
      }
      overlays.push(
        <Sequence key={`overlay-${index}`} from={start} durationInFrames={durationInFrames}>
          {content}
        </Sequence>,
      );
      return;
    }

    if (type === TransitionSeriesSequence) {
      const element = item as ReactElement<TransitionSeriesSequenceProps>;
      const { durationInFrames, offset = 0 } = element.props;
      if (pending && durationInFrames < pending.duration) {
        throw new TypeError(
          `The duration of a <TransitionSeries.Sequence /> must not be shorter than the duration of the previous <TransitionSeries.Transition />. The transition is ${pending.duration} frames long, but the sequence is only ${durationInFrames} frames long (index = ${index}, duration = ${durationInFrames})`,
        );
      }
      const transitionAfter = isValidElement(next) && nextType === TransitionSeriesTransition ? (next as ReactElement<TransitionSeriesTransitionProps>) : null;
      if (transitionAfter) {
        const duration = transitionAfter.props.timing.getDurationInFrames({ fps });
        if (durationInFrames < duration) {
          throw new TypeError(
            `The duration of a <TransitionSeries.Sequence /> must not be shorter than the duration of the next <TransitionSeries.Transition />. The transition is ${duration} frames long, but the sequence is only ${durationInFrames} frames long (index = ${index}, duration = ${durationInFrames})`,
          );
        }
      }
      const start = previousEnd - (pending?.duration ?? 0) + offset;
      sceneProps.push({ start, duration: durationInFrames, enter: pending, exit: null, element, index });
      previousEnd = start + durationInFrames;
      pending = null;
      return;
    }

    throw new TypeError(
      `The <TransitionSeries /> component only accepts a list of <TransitionSeries.Sequence />, <TransitionSeries.Transition />, and <TransitionSeries.Overlay /> components as its children, but got ${describe(item)} instead`,
    );
  });

  // A scene leaves through the transition that arrives with the next one.
  sceneProps.forEach((scene, i) => {
    const following = sceneProps[i + 1];
    if (following?.enter) scene.exit = following.enter;
  });

  sceneProps.forEach((scene) => {
    const { layout, name } = scene.element.props;
    scenes.push(
      <Sequence key={`scene-${scene.index}`} from={scene.start} durationInFrames={scene.duration} name={name} layout={layout}>
        <Scene enter={scene.enter} exit={scene.exit} duration={scene.duration}>
          {scene.element.props.children}
        </Scene>
      </Sequence>,
    );
  });

  return (
    <>
      {scenes}
      {overlays}
    </>
  );
}

/** The stub's name for the component, kept as an export. */
export { TransitionSeriesImpl };

export const TransitionSeries: ((props: { children?: ReactNode }) => ReactNode) & {
  Sequence: typeof TransitionSeriesSequence;
  Transition: typeof TransitionSeriesTransition;
  Overlay: typeof TransitionSeriesOverlay;
} = Object.assign(TransitionSeriesImpl, {
  Sequence: TransitionSeriesSequence,
  Transition: TransitionSeriesTransition,
  Overlay: TransitionSeriesOverlay,
});
