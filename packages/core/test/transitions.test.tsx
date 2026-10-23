import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createSceneRoot, Rect, TimelineContext } from '@kinetographdev/react';
import type { LayerJson } from '@kinetographdev/scene';
import { useCurrentFrame, useVideoConfig } from '../src/timeline.js';
import { TransitionSeries, linearTiming, springTiming } from '../src/transitions/index.js';
import { fade } from '../src/transitions/fade.js';
import { slide } from '../src/transitions/slide.js';
import { wipe } from '../src/transitions/wipe.js';
import { flip } from '../src/transitions/flip.js';
import { clockWipe } from '../src/transitions/clock-wipe.js';
import { iris } from '../src/transitions/iris.js';
import { none } from '../src/transitions/none.js';
import type { PresentationComponentProps, TransitionPresentation } from '../src/transitions/types.js';
import { Easing } from '../src/easing.js';
import { expectClose, fixture } from './helpers.js';
import { renderAt, timeline } from './scene-harness.js';

const data = fixture('transitions.json');

describe('timings', () => {
  it('match the recorded durations and progress', () => {
    for (const t of data.timings) {
      let timing;
      const label = t.label;
      if (label === 'linear 20') timing = linearTiming({ durationInFrames: 20 });
      else if (label === 'linear 1') timing = linearTiming({ durationInFrames: 1 });
      else if (label === 'linear 20 quad easing') timing = linearTiming({ durationInFrames: 20, easing: (x) => x * x });
      else if (label === 'spring default') timing = springTiming();
      else if (label === 'spring damping 200') timing = springTiming({ config: { damping: 200 } });
      else if (label === 'spring bouncy') timing = springTiming({ config: { damping: 5, stiffness: 120 } });
      else if (label === 'spring duration 30') timing = springTiming({ durationInFrames: 30 });
      else if (label === 'spring duration 12 threshold') timing = springTiming({ durationInFrames: 12, durationRestThreshold: 0.05 });
      else if (label === 'spring reverse') timing = springTiming({ reverse: true, config: { damping: 200 } });
      else if (label === 'spring threshold') timing = springTiming({ durationRestThreshold: 0.1 });
      else throw new Error(`unknown timing ${label}`);
      expect(timing.getDurationInFrames({ fps: t.fps }), `${label} @${t.fps} duration`).toBe(t.duration);
      for (const [frame, progress] of t.progress) {
        expectClose(timing.getProgress({ frame, fps: t.fps }), progress, 1e-9, `${label} @${t.fps} frame ${frame}`);
      }
    }
    void Easing;
  });
});

// ---- presentations ----

const W = 1280;
const H = 720;

function layerOf(pres: TransitionPresentation<any>, direction: 'entering' | 'exiting', progress: number, extra: Record<string, unknown> = {}) {
  const Presentation = pres.component;
  const tree = renderAt(
    <Presentation presentationProgress={progress} presentationDirection={direction} presentationDurationInFrames={20} passedProps={{ ...pres.props, ...extra }}>
      <Rect id="c" width={1} height={1} fill="#fff" />
    </Presentation>,
  );
  return tree.layers[0] as any;
}

const percentage = (text: string) => Number(text.replace('%', ''));
const makePresentation = (name: string, options: any): TransitionPresentation<any> =>
  ({ fade, slide, wipe, flip, clockWipe, iris, none } as any)[name](options);

describe('presentations', () => {
  it('fade: the new scene fades in over the old, which stays opaque', () => {
    for (const c of data.presentations.filter((x: any) => x.name === 'fade')) {
      const layer = layerOf(fade(), c.direction, c.progress);
      expect(layer.opacity ?? 1, `${c.direction} ${c.progress}`).toBeCloseTo(c.style.opacity, 12);
    }
  });

  it('slide: moves by a fraction of the composition size', () => {
    for (const c of data.presentations.filter((x: any) => x.name === 'slide')) {
      const layer = layerOf(makePresentation('slide', c.options), c.direction, c.progress);
      const match = /translate([XY])\(([-\d.]+%)\)/.exec(c.style.transform)!;
      const fraction = percentage(match[2]!) / 100;
      const expected = fraction * (match[1] === 'X' ? W : H);
      const actual = (match[1] === 'X' ? layer.transform?.x : layer.transform?.y) ?? 0;
      // the published package nudges the leaving scene by 0.01% so the two never leave a seam
      expect(Math.abs(actual - expected), `${JSON.stringify(c.options)} ${c.direction} ${c.progress}`).toBeLessThanOrEqual(0.0002 * (match[1] === 'X' ? W : H));
      const other = (match[1] === 'X' ? layer.transform?.y : layer.transform?.x) ?? 0;
      expect(other).toBe(0);
    }
  });

  it('wipe: clips with the recorded polygon, in pixels', () => {
    let checked = 0;
    for (const c of data.presentations.filter((x: any) => x.name === 'wipe')) {
      const layer = layerOf(makePresentation('wipe', c.options), c.direction, c.progress);
      const points = /polygon\((.*)\)/.exec(c.style.clip)![1]!.split(',').map((pair: string) => pair.trim().split(/\s+/).map(percentage));
      expect(layer.clip.kind).toBe('polygon');
      expect(layer.clip.points.length).toBe(points.length);
      layer.clip.points.forEach(([x, y]: [number, number], i: number) => {
        expect(Math.abs(x - (points[i]![0]! / 100) * W), `${JSON.stringify(c.options)} ${c.direction} ${c.progress} #${i}`).toBeLessThan(1e-6);
        expect(Math.abs(y - (points[i]![1]! / 100) * H)).toBeLessThan(1e-6);
      });
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('flip: turns about the middle, hides a face turned away, and brings a camera while under way', () => {
    for (const c of data.presentations.filter((x: any) => x.name === 'flip')) {
      const layer = layerOf(makePresentation('flip', c.options), c.direction, c.progress);
      const match = /rotate([XY])\((-?[\d.]+)deg\)/.exec(c.style.transform)!;
      const axis = match[1] === 'Y' ? 'rotateY' : 'rotateX';
      const angle = Number(match[2]);
      expect(Math.abs((layer.transform?.[axis] ?? 0) - angle), `${JSON.stringify(c.options)} ${c.direction} ${c.progress}`).toBeLessThan(1e-9);
      const otherAxis = axis === 'rotateY' ? 'rotateX' : 'rotateY';
      expect(layer.transform?.[otherAxis] ?? 0).toBe(0);
      expect(layer.transform).toMatchObject({ x: W / 2, y: H / 2, anchorX: W / 2, anchorY: H / 2 });
      expect(layer.opacity ?? 1).toBe(Math.abs(angle) > 90 ? 0 : 1);
    }
  });

  it('flip: only the entering side adds the camera, and only mid-flip', () => {
    const cameraOf = (direction: 'entering' | 'exiting', p: number, options = {}) => {
      const Presentation = flip(options).component;
      return renderAt(
        <Presentation presentationProgress={p} presentationDirection={direction} presentationDurationInFrames={20} passedProps={flip(options).props}>
          <Rect id="c" width={1} height={1} fill="#fff" />
        </Presentation>,
      ).camera;
    };
    expect(cameraOf('entering', 0.5)).toEqual({ perspective: 1000 });
    expect(cameraOf('entering', 0.5, { perspective: 500 })).toEqual({ perspective: 500 });
    expect(cameraOf('entering', 0.5, { perspective: null })).toBeNull();
    expect(cameraOf('exiting', 0.5)).toBeNull();
    expect(cameraOf('entering', 0)).toBeNull();
    expect(cameraOf('entering', 1)).toBeNull();
  });

  it('clockWipe: reveals the new scene with a pie slice that matches the recorded path', () => {
    const num = (s: string) => (s.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi) ?? []).map(Number);
    for (const c of data.presentations.filter((x: any) => x.name === 'clockWipe')) {
      const { width, height } = c.options;
      const config = { id: 'Main', width, height, fps: 30, durationInFrames: 90, defaultProps: {}, props: {} };
      const Presentation = clockWipe(c.options).component;
      const layers = renderAt(
        <Presentation presentationProgress={c.progress} presentationDirection={c.direction} presentationDurationInFrames={20} passedProps={c.options}>
          <Rect id="c" width={1} height={1} fill="#fff" />
        </Presentation>,
        0,
        { config },
      ).layers as any[];
      if (c.direction === 'exiting') {
        expect(layers[0].clip).toBeUndefined();
        continue;
      }
      const recorded = /path\("(.*)"\)/.exec(c.style.clip)![1]!;
      const mine = layers[0].clip.d as string;
      expect(mine.replace(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi, '#'), `${width}x${height} ${c.progress}`).toBe(recorded.replace(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi, '#'));
      num(mine).forEach((v, i) => expect(Math.abs(v - num(recorded)[i]!), `${mine} vs ${recorded}`).toBeLessThan(1e-4));
    }
  });

  it('iris: opens a circle from the middle that matches the recorded one', () => {
    for (const c of data.presentations.filter((x: any) => x.name === 'iris')) {
      const { width, height } = c.options;
      const config = { id: 'Main', width, height, fps: 30, durationInFrames: 90, defaultProps: {}, props: {} };
      const Presentation = iris(c.options).component;
      const layers = renderAt(
        <Presentation presentationProgress={c.progress} presentationDirection={c.direction} presentationDurationInFrames={20} passedProps={c.options}>
          <Rect id="c" width={1} height={1} fill="#fff" />
        </Presentation>,
        0,
        { config },
      ).layers as any[];
      if (c.direction === 'exiting') {
        expect(layers[0].clip).toBeUndefined();
        continue;
      }
      const radius = Number(/a ([\d.e+-]+) /.exec(c.style.clip)![1]);
      expect(layers[0].clip).toMatchObject({ kind: 'ellipse', cx: width / 2, cy: height / 2 });
      expect(Math.abs(layers[0].clip.rx - radius)).toBeLessThan(1e-9);
      expect(layers[0].clip.ry).toBe(layers[0].clip.rx);
    }
  });

  it('none: only a wrapper', () => {
    const layer = layerOf(none(), 'entering', 0.3);
    expect(layer.type).toBe('group');
    expect(layer.opacity).toBeUndefined();
    expect(layer.clip).toBeUndefined();
  });
});

// ---- the timeline ----

interface Seen {
  name: string;
  frame: number;
  duration: number;
  wrappers: { dir: string; progress: number; duration: number }[];
}

const seenLog: Seen[] = [];
const wrapperStack: { dir: string; progress: number; duration: number }[] = [];

// A presentation that reports its direction and progress; wrappers are tracked by rendering order.
function Recorder({ children, presentationProgress, presentationDirection, presentationDurationInFrames }: PresentationComponentProps<Record<string, never>>): ReactNode {
  return (
    <Marker value={{ dir: presentationDirection, progress: presentationProgress, duration: presentationDurationInFrames }}>
      {children}
    </Marker>
  );
}
const recorder: TransitionPresentation<Record<string, never>> = { component: Recorder, props: {} };

import { createContext, useContext } from 'react';
const MarkerContext = createContext<{ dir: string; progress: number; duration: number }[]>([]);
function Marker({ value, children }: { value: { dir: string; progress: number; duration: number }; children: ReactNode }) {
  const parents = useContext(MarkerContext);
  return <MarkerContext.Provider value={[...parents, value]}>{children}</MarkerContext.Provider>;
}

function Probe({ name }: { name: string }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const wrappers = useContext(MarkerContext);
  seenLog.push({ name, frame, duration: durationInFrames, wrappers: [...wrappers] });
  return null;
}

const S = (name: string, props: Record<string, unknown> = {}) => (
  <TransitionSeries.Sequence key={name} durationInFrames={60} {...props}>
    <Probe name={name} />
  </TransitionSeries.Sequence>
);
const Tr = (n = 30, key = 't', timing = linearTiming({ durationInFrames: n })) => (
  <TransitionSeries.Transition key={key} presentation={recorder} timing={timing} />
);
const O = (name: string, props: Record<string, unknown> = {}) => (
  <TransitionSeries.Overlay key={name} durationInFrames={20} {...props}>
    <Probe name={name} />
  </TransitionSeries.Overlay>
);

function observe(children: ReactNode, frame: number, duration: number): Seen[] {
  seenLog.length = 0;
  const root = createSceneRoot();
  try {
    root.render(
      <TimelineContext.Provider value={timeline(frame, { durationInFrames: duration, config: { id: 'T', width: W, height: H, fps: 30, durationInFrames: duration, defaultProps: {}, props: {} } })}>
        <TransitionSeries>{children}</TransitionSeries>
      </TimelineContext.Provider>,
    );
  } finally {
    root.unmount();
  }
  return [...seenLog];
}

const childrenOf = (title: string): ReactNode[] => {
  switch (title) {
    case 'A T B': return [S('A'), Tr(30, 't1'), S('B')];
    case 'three scenes': return [S('A'), Tr(30, 't1'), S('B'), Tr(20, 't2'), S('C')];
    case 'offset +10': return [S('A'), Tr(30, 't1'), S('B', { offset: 10 })];
    case 'offset -10': return [S('A'), Tr(30, 't1'), S('B', { offset: -10 })];
    case 'no transition': return [S('A'), S('B', { offset: 5 })];
    case 'B between two transitions, short': return [S('A'), Tr(30, 't1'), S('B', { durationInFrames: 50 }), Tr(30, 't2'), S('C')];
    case 'equal duration': return [S('A', { durationInFrames: 30 }), Tr(30, 't1'), S('B')];
    case 'spring': return [S('A'), Tr(0, 't', springTiming({ config: { damping: 200 } })), S('B')];
    case 'overlay': return [S('A'), O('O'), S('B')];
    case 'overlay offset': return [S('A'), O('O', { offset: 5 }), S('B')];
    case 'overlay odd': return [S('A'), O('O', { durationInFrames: 21 }), S('B')];
    case 'error: transition longer than previous': return [S('A', { durationInFrames: 20 }), Tr(30), S('B')];
    case 'error: transition longer than next': return [S('A'), Tr(30), S('B', { durationInFrames: 20 })];
    case 'error: two transitions': return [S('A'), Tr(30, 't1'), Tr(30, 't2'), S('B')];
    case 'error: transition then overlay': return [S('A'), Tr(30), O('O'), S('B')];
    case 'error: overlay then transition': return [S('A'), O('O'), Tr(30), S('B')];
    case 'error: overlay before frame 0': return [S('A'), O('O', { durationInFrames: 140 }), S('B')];
    case 'error: wrong child': return [S('A'), <div key="x" />, S('B')];
    default: throw new Error(`unknown scenario ${title}`);
  }
};

describe('TransitionSeries', () => {
  it('lays out scenes, offsets, transitions and overlays as the published package does', () => {
    let checkedFrames = 0;
    for (const scenario of data.scenarios) {
      if (scenario.error) continue;
      const children = childrenOf(scenario.title);
      for (const recorded of scenario.frames) {
        const got = observe(children, recorded.frame, scenario.duration);
        const label = `${scenario.title} @${recorded.frame}`;
        expect(got.map((p) => p.name).sort(), label).toEqual(recorded.probes.map((p: Seen) => p.name).sort());
        for (const want of recorded.probes as Seen[]) {
          const have = got.find((p) => p.name === want.name)!;
          expect(have.frame, `${label} ${want.name} frame`).toBeCloseTo(want.frame, 9);
          expect(have.duration, `${label} ${want.name} duration`).toBe(want.duration);
          // As in the published package, a scene is wrapped by a transition's presentation only while it runs.
          const active = have.wrappers;
          expect(active.length, `${label} ${want.name} wrappers`).toBe(want.wrappers.length);
          // Which transition wraps it is the same; the order they are nested in is not part of the behaviour.
          const key = (w: { dir: string }) => w.dir;
          const sortedHave = [...active].sort((a, b) => key(a).localeCompare(key(b)));
          const sortedWant = [...want.wrappers].sort((a, b) => key(a).localeCompare(key(b)));
          sortedWant.forEach((w, i) => {
            expect(sortedHave[i]!.dir, label).toBe(w.dir);
            expectClose(sortedHave[i]!.progress, w.progress, 1e-9, `${label} ${want.name} ${w.dir} progress`);
            expect(sortedHave[i]!.duration, label).toBe(w.duration);
          });
        }
        checkedFrames++;
      }
    }
    expect(checkedFrames).toBeGreaterThan(500);
  });

  it('refuses what the published package refuses, with its messages', () => {
    for (const scenario of data.scenarios) {
      if (!scenario.error) continue;
      expect(() => observe(childrenOf(scenario.title), 0, scenario.duration), scenario.title).toThrow(scenario.error);
    }
  });

  it('mounts a presentation only while its transition runs, so one that draws something at rest is not on the scene all along', () => {
    // A tape strip like papercut's `tapePull`: it draws at every progress, including 0.
    const Strip = ({ children }: PresentationComponentProps<Record<string, never>>): ReactNode => (
      <>
        {children}
        <Rect width={10} height={10} fill="#fff" />
      </>
    );
    const strip: TransitionPresentation<Record<string, never>> = { component: Strip, props: {} };
    const stripsAt = (frame: number) => {
      const root = createSceneRoot();
      try {
        const tree = root.render(
          <TimelineContext.Provider value={timeline(frame, { config: { id: 'T', width: W, height: H, fps: 30, durationInFrames: 90, defaultProps: {}, props: {} } })}>
            <TransitionSeries>
              <TransitionSeries.Sequence durationInFrames={60}>
                <Probe name="A" />
              </TransitionSeries.Sequence>
              <TransitionSeries.Transition presentation={strip} timing={linearTiming({ durationInFrames: 30 })} />
              <TransitionSeries.Sequence durationInFrames={60}>
                <Probe name="B" />
              </TransitionSeries.Sequence>
            </TransitionSeries>
          </TimelineContext.Provider>,
        );
        const count = (layers: LayerJson[]): number =>
          layers.reduce((n, l) => n + (l.type === 'shape' ? 1 : 0) + (l.type === 'group' ? count(l.children) : 0), 0);
        return count(tree.layers as LayerJson[]);
      } finally {
        root.unmount();
      }
    };
    // Scene A runs from 0 to 60 and B from 30 to 90; the transition is frames 30 to 60.
    expect(stripsAt(10)).toBe(0);
    expect(stripsAt(29)).toBe(0);
    expect(stripsAt(45)).toBe(2);
    expect(stripsAt(75)).toBe(0);
  });
});
