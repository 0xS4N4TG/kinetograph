// Readback against the real addon (packages/cli/skills/kinetograph/references/ENGINE.md §1): the paths the TS side numbers must be the ones Rust answers
// for, and a measure-then-render component must see CSS-correct sizes. Skipped where the addon is not built.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setDomAddon, setDomEnvironment, resetStylesheets, registerStylesheet } from '@kinetographdev/compat/dom';
import { installDomGlobals, resetObservers } from '@kinetographdev/compat/shim';
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
});
