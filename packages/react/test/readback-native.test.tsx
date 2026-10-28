// Readback against the real addon (packages/cli/skills/kinetograph/references/ENGINE.md §1): the paths the TS side numbers must be the ones Rust answers
// for, and a measure-then-render component must see CSS-correct sizes. Skipped where the addon is not built.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setDomAddon, setDomEnvironment, resetStylesheets, registerStylesheet } from '@kinetographdev/compat/dom';
import { installDomGlobals, resetObservers, setPathMeasure } from '@kinetographdev/compat/shim';
import { createSceneRoot, Layer, Rect, SequenceHost, TimelineContext } from '../src/index.js';
import { timeline } from './harness.js';

const font = fileURLToPath(new URL('../../../assets/fonts/DMSans-Medium.ttf', import.meta.url));

function loadAddon(): Record<string, unknown> | null {
  try {
    const native = createRequire(import.meta.url)('@kinetographdev/native') as Record<string, unknown>;
    return typeof native.domLayoutBoxes === 'function' && typeof native.domComputedStyle === 'function' ? native : null;
  } catch {
    return null;
  }
}
const addon = loadAddon();

beforeAll(() => {
  installDomGlobals();
  setDomAddon(addon);
  setDomEnvironment({ baseDir: '/tmp' });
});
afterAll(() => {
  setDomAddon(null);
  resetObservers();
  resetStylesheets();
});

function render(node: ReactNode, frame = 0) {
  const root = createSceneRoot({ viewport: { width: 1000, height: 800 }, fonts: () => ({ 'DM Sans': font }), time: () => frame / 30 });
  root.render(<TimelineContext.Provider value={timeline(frame)}>{node}</TimelineContext.Provider>);
  return root;
}

describe.skipIf(addon === null)('readback with the addon', () => {
  it('measures a box with padding, a border and a stylesheet class', () => {
    registerStylesheet('.card { width: 200px; padding: 10px; border: 3px solid red; margin-left: 7px }');
    const seen: Record<string, unknown> = {};
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        const el = ref.current;
        seen.rect = el.getBoundingClientRect().toJSON();
        seen.offset = [el.offsetWidth, el.offsetHeight, el.offsetLeft, el.offsetTop];
        seen.client = [el.clientWidth, el.clientHeight];
        seen.width = (globalThis as any).getComputedStyle(el).width;
        seen.pad = (globalThis as any).getComputedStyle(el).paddingLeft;
      }, []);
      return (
        <div>
          <div ref={ref} className="card" style={{ height: 50 }} />
        </div>
      );
    }
    render(<Probe />).unmount();
    expect(seen.offset).toEqual([226, 76, 7, 0]);
    expect(seen.client).toEqual([220, 70]);
    expect(seen.rect).toMatchObject({ x: 7, y: 0, width: 226, height: 76 });
    expect(seen.width).toBe('200px');
    expect(seen.pad).toBe('10px');
  });

  it('lets a component fit its text: measure, set state, render again in the same frame', () => {
    let finalSize = 0;
    function FitText() {
      const ref = useRef<any>(null);
      const [size, setSize] = useState(100);
      useLayoutEffect(() => {
        const width = ref.current.getBoundingClientRect().width;
        // The text is 300 px wide at the size it has; scale it to 300 px at 1000 px of room.
        if (width > 300) setSize((s) => (s * 300) / width);
        else finalSize = size;
      });
      return (
        <div style={{ fontFamily: 'DM Sans', fontSize: size }}>
          <span ref={ref}>Kinetograph</span>
        </div>
      );
    }
    render(<FitText />).unmount();
    expect(finalSize).toBeGreaterThan(0);
    expect(finalSize).toBeLessThan(100);
    // The size it settled on makes the text 300 px wide (within the text engine's rounding).
    let measured = 0;
    function Check() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        measured = ref.current.getBoundingClientRect().width;
      }, []);
      return (
        <div style={{ fontFamily: 'DM Sans', fontSize: finalSize }}>
          <span ref={ref}>Kinetograph</span>
        </div>
      );
    }
    render(<Check />).unmount();
    expect(Math.abs(measured - 300)).toBeLessThan(1);
  });

  it('numbers elements as the addon does, through a Sequence and a native element', () => {
    const entry = { key: '/Sequence@0+10', name: null, from: 0, durationInFrames: 10, parent: null };
    let width = 0;
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        width = ref.current.getBoundingClientRect().width;
      }, []);
      return (
        <>
          <Rect width={1} height={1} />
          <div style={{ width: 100 }}>
            <SequenceHost sequence={entry} wrapped={false}>
              <i style={{ display: 'block', width: 11 }} />
            </SequenceHost>
            <Layer layout={{ width: 5, height: 5 }}>
              <b ref={ref} style={{ display: 'block', width: 77 }} />
            </Layer>
          </div>
        </>
      );
    }
    render(<Probe />).unmount();
    // <b> is inside a Layer (a native element) inside the div: its own island, at the Layer's place in the path.
    expect(width).toBe(77);
  });

  it('delivers a ResizeObserver entry with the content box', () => {
    const sizes: number[][] = [];
    function Watch() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        const ro = new (globalThis as any).ResizeObserver((entries: any[]) => {
          const e = entries[0];
          sizes.push([e.contentRect.width, e.contentRect.height, e.borderBoxSize[0].inlineSize]);
        });
        ro.observe(ref.current);
      }, []);
      return <div ref={ref} style={{ width: 100, height: 40, padding: 5 }} />;
    }
    render(<Watch />).unmount();
    expect(sizes).toEqual([[100, 40, 110]]);
  });
  it('answers the usual properties of an element from one native call', () => {
    const real = addon!.domComputedStyle as (...a: unknown[]) => string[];
    let calls = 0;
    setDomAddon({ ...addon!, domComputedStyle: (...a: unknown[]) => (calls++, real(...a)) } as any);
    const seen: string[] = [];
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        const cs = (globalThis as any).getComputedStyle(ref.current);
        seen.push(cs.display, cs.opacity, cs.width, cs.paddingLeft, cs.position);
      }, []);
      return <div ref={ref} style={{ width: 80, padding: 4, opacity: 0.5 }} />;
    }
    render(<Probe />).unmount();
    setDomAddon(addon);
    expect(calls).toBe(1);
    expect(seen).toEqual(['block', '0.5', '80px', '4px', 'static']);
  });

  // Chrome for Testing 154's getBoundingClientRect for the same page (body margin 0): the geometry box through the
  // transforms (the corners of the box, so a rotated circle is the rotated square around it), the CSS transform, the
  // `viewBox` with its `preserveAspectRatio`, and nested `<svg>` viewports. Strokes, markers and filters are not in it.
  it("measures SVG shapes as Chrome's getBoundingClientRect does", async () => {
    // The path maths core hands the shim (packages/core/src/web-install.ts).
    const paths = (await import('@kinetographdev/core/paths' as string)) as Parameters<typeof setPathMeasure>[0] & object;
    setPathMeasure({ getLength: paths.getLength, getPointAtLength: paths.getPointAtLength, getBoundingBox: paths.getBoundingBox });
    const chrome: Record<string, number[]> = {
      stroke: [15, 27, 30, 40],
      filter: [15, 27, 30, 40],
      rot: [5.2513, 22.2513, 49.4975, 49.4975],
      circlerot: [77.6795, 29.6795, 54.641, 54.641],
      curve: [15, 34.5, 85, 52.5],
      g: [10, 12, 55, 55],
      line: [15, 97, 140, 0],
      marked: [15, 17, 40, 0],
      css: [25, 47, 60, 80],
      vb: [65, 117, 20, 30],
      vbnone: [25, 217, 40, 30],
      vbslice: [25, 327, 40, 60],
      inner: [129, 411, 8, 12],
      nested: [129, 411, 8, 12],
    };
    const seen: Record<string, number[]> = {};
    function Probe() {
      useLayoutEffect(() => {
        const doc = (globalThis as any).document;
        for (const id of Object.keys(chrome)) {
          const r = doc.getElementById(id).getBoundingClientRect();
          seen[id] = [r.x, r.y, r.width, r.height].map((v: number) => Math.round(v * 1e4) / 1e4);
        }
      }, []);
      return (
        <div style={{ position: 'absolute', left: 5, top: 7 }}>
          <svg width={200} height={100} style={{ display: 'block' }}>
            <defs>
              <filter id="f">
                <feGaussianBlur stdDeviation={5} />
              </filter>
              <marker id="m" markerWidth={10} markerHeight={10} refX={0} refY={5}>
                <rect width={10} height={10} />
              </marker>
            </defs>
            <rect id="stroke" x={10} y={20} width={30} height={40} stroke="black" strokeWidth={10} fill="red" />
            <rect id="filter" x={10} y={20} width={30} height={40} filter="url(#f)" />
            <rect id="rot" x={10} y={20} width={30} height={40} transform="rotate(45 25 40)" />
            <circle id="circlerot" cx={100} cy={50} r={20} transform="rotate(30 100 50)" />
            <path id="curve" d="M10 80 C 40 10, 65 10, 95 80" stroke="black" strokeWidth={6} fill="none" />
            <g id="g" transform="translate(5 5)">
              <rect x={0} y={0} width={10} height={10} stroke="black" strokeWidth={4} />
              <circle cx={50} cy={50} r={5} />
            </g>
            <line id="line" x1={10} y1={90} x2={150} y2={90} stroke="black" strokeWidth={8} strokeLinecap="square" />
            <polyline id="marked" points="10,10 50,10" stroke="black" markerEnd="url(#m)" />
            <rect id="css" x={10} y={20} width={30} height={40} style={{ transform: 'scale(2)', transformOrigin: '0 0' }} />
          </svg>
          <svg width={200} height={100} viewBox="0 0 100 100" style={{ display: 'block' }}>
            <rect id="vb" x={10} y={10} width={20} height={30} stroke="black" strokeWidth={10} />
          </svg>
          <svg width={200} height={100} viewBox="0 0 100 100" preserveAspectRatio="none" style={{ display: 'block' }}>
            <rect id="vbnone" x={10} y={10} width={20} height={30} />
          </svg>
          <svg width={200} height={100} viewBox="0 0 100 100" preserveAspectRatio="xMinYMin slice" style={{ display: 'block' }}>
            <rect id="vbslice" x={10} y={10} width={20} height={30} />
            <svg id="inner" x={50} y={50} width={40} height={20} viewBox="0 0 10 10">
              <rect id="nested" x={1} y={1} width={2} height={3} />
            </svg>
          </svg>
        </div>
      );
    }
    render(<Probe />).unmount();
    setPathMeasure(null);
    const wrong = Object.entries(chrome)
      .filter(([id, want]) => want.some((v, i) => Math.abs(seen[id]![i]! - v) >= 0.01))
      .map(([id, want]) => `${id}: ${seen[id]} vs Chrome ${want}`);
    expect(wrong).toEqual([]);
  });
});
