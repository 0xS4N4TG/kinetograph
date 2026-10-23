// Readback (packages/cli/skills/kinetograph/references/ENGINE.md §1): refs to DOM host elements answer for measurement from the addon's boxes, a layout effect
// that measures and sets state settles within the frame, observers fire after layout. The addon is a stand-in that
// lays each element out from its inline width/height (px) and answers computed styles from the request.

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setDomAddon, resetStylesheets } from '@kinetograph/compat/dom';
import { installDomGlobals, resetObservers } from '@kinetograph/compat/shim';
import { createSceneRoot, TimelineContext } from '../src/index.js';
import { timeline } from './harness.js';

interface Req {
  root: any;
  stylesheets: string[];
  path: string;
}

beforeAll(() => installDomGlobals());

let calls: { boxes: number; styles: number; requests: Req[] };
let sizeOf: (node: any) => { width: number; height: number };

/** A box per element: its style's width/height, text 8 px per character wide and 10 high. */
function boxesOf(req: Req): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let y = 0;
  const visit = (node: any): void => {
    if (node.kind !== 'element') return;
    const { width, height } = sizeOf(node);
    y += 1;
    out[node.path] = {
      x: 0, y, width, height,
      rect: { x: 0, y, width, height },
      client: { width, height },
      scroll: { width, height: height + 5 },
    };
    node.children.forEach(visit);
  };
  visit(req.root);
  return out;
}

beforeEach(() => {
  calls = { boxes: 0, styles: 0, requests: [] };
  sizeOf = (node) => {
    const m = (name: string): number => Number(new RegExp(`${name}: (\\d+(?:\\.\\d+)?)px`).exec(node.style)?.[1] ?? 0);
    return { width: m('width'), height: m('height') };
  };
  setDomAddon({
    renderDomIsland: () => JSON.stringify({ layers: [], unsupported: [], camera: null }),
    domLayoutBoxes(json: string) {
      calls.boxes++;
      const req = JSON.parse(json) as Req;
      calls.requests.push(req);
      return JSON.stringify(boxesOf(req));
    },
    domComputedStyle(json: string, path: string, props: string[]) {
      calls.styles++;
      return props.map((p) => `${p}@${path}`);
    },
  });
});
afterEach(() => {
  setDomAddon(null);
  resetObservers();
  resetStylesheets();
});

function render(node: ReactNode, frame = 0) {
  const root = createSceneRoot({ viewport: { width: 1000, height: 800 }, fonts: () => ({}), time: () => frame / 30 });
  const wrap = (n: ReactNode) => <TimelineContext.Provider value={timeline(frame)}>{n}</TimelineContext.Provider>;
  return { root, tree: root.render(wrap(node)), wrap };
}

describe('refs to DOM elements', () => {
  it('measure with getBoundingClientRect, offset*, client* and scroll* from the island’s boxes', () => {
    const seen: Record<string, unknown> = {};
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        const el = ref.current;
        seen.rect = el.getBoundingClientRect().toJSON();
        seen.offset = [el.offsetWidth, el.offsetHeight];
        seen.client = [el.clientWidth, el.clientHeight];
        seen.scroll = [el.scrollWidth, el.scrollHeight];
        seen.tag = el.tagName;
        seen.id = el.id;
      }, []);
      return (
        <div>
          <div ref={ref} id="box" style={{ width: 120.4, height: 30 }} />
        </div>
      );
    }
    const { root } = render(<Probe />);
    root.unmount();
    expect(seen.rect).toMatchObject({ x: 0, width: 120.4, height: 30, right: 120.4 });
    expect(seen.offset).toEqual([120, 30]);
    expect(seen.client).toEqual([120, 30]);
    expect(seen.scroll).toEqual([120, 35]);
    expect(seen.tag).toBe('DIV');
    expect(seen.id).toBe('box');
  });

  it('ask the addon once per tree generation, with the island that holds the element', () => {
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        ref.current.getBoundingClientRect();
        ref.current.offsetWidth;
        ref.current.parentElement.getBoundingClientRect();
      }, []);
      return (
        <div className="outer">
          <span ref={ref} style={{ width: 5, height: 5 }} />
        </div>
      );
    }
    const { root } = render(<Probe />);
    root.unmount();
    expect(calls.boxes).toBe(1);
    expect(calls.requests[0]!.path).toBe('$0');
    expect(calls.requests[0]!.root.attrs.class).toBe('outer');
  });

  it('settle a measure-then-render layout effect within the frame', () => {
    function Fit() {
      const ref = useRef<any>(null);
      const [width, setWidth] = useState(0);
      useLayoutEffect(() => {
        setWidth(ref.current.getBoundingClientRect().width * 2);
      }, []);
      return (
        <div>
          <div ref={ref} style={{ width: 50, height: 10 }} />
          <div id="out" style={{ width, height: 10 }} />
        </div>
      );
    }
    const { root } = render(<Fit />);
    const rendered = calls.requests.at(-1)!;
    root.unmount();
    // The second render saw the measured width; the island handed to the addon last had it.
    expect(JSON.stringify(rendered.root)).toContain('width: 50px');
  });

  it('throw, naming the cause, when a measure loop never settles', () => {
    function Grow() {
      const ref = useRef<any>(null);
      const [n, setN] = useState(1);
      sizeOf = () => ({ width: 10, height: 10 });
      useLayoutEffect(() => {
        ref.current.getBoundingClientRect();
        setN((x) => x + 1);
      });
      return <div ref={ref} style={{ width: n, height: 1 }} />;
    }
    expect(() => render(<Grow />)).toThrow(/did not settle after 8 passes/);
  });

  it('read computed styles through domComputedStyle for the element’s path', () => {
    let value = '';
    let padding = '';
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        const cs = (globalThis as any).getComputedStyle(ref.current);
        value = cs.getPropertyValue('font-size');
        padding = cs.paddingLeft;
      }, []);
      return (
        <div>
          <p ref={ref} />
        </div>
      );
    }
    const { root } = render(<Probe />);
    root.unmount();
    expect(value).toBe('font-size@$0.0');
    expect(padding).toBe('padding-left@$0.0');
  });

  it('turn a script’s writes to style and attributes into part of the island', () => {
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        ref.current.style.backgroundColor = 'red';
        ref.current.style.setProperty('--k', '3');
        ref.current.setAttribute('data-x', '1');
        ref.current.classList.add('on');
        ref.current.getBoundingClientRect();
      }, []);
      return <div ref={ref} style={{ width: 4, height: 4 }} />;
    }
    const { root } = render(<Probe />);
    const last = calls.requests.at(-1)!;
    root.unmount();
    expect(last.root.style).toContain('background-color: red');
    expect(last.root.style).toContain('--k: 3');
    expect(last.root.attrs['data-x']).toBe('1');
    expect(last.root.attrs.class).toBe('on');
  });

  it('find elements with querySelector and closest over the host tree', () => {
    let found = '';
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        const el = ref.current;
        found = [
          el.matches('.b > i'),
          el.closest('.a')?.id,
          el.parentElement.querySelectorAll('i').length,
          (globalThis as any).document.querySelector('#second')?.tagName,
          (globalThis as any).document.getElementById('first')?.className,
        ].join(',');
      }, []);
      return (
        <div className="a" id="top">
          <div className="b">
            <i ref={ref} id="first" className="x" />
            <i id="second" />
          </div>
        </div>
      );
    }
    const { root } = render(<Probe />);
    root.unmount();
    expect(found).toBe('true,top,2,I,x');
  });
});

describe('ResizeObserver and IntersectionObserver', () => {
  it('call back after layout with the size, and again when it changes, rendering again in the same frame', () => {
    const sizes: number[] = [];
    function Watch({ wide }: { wide: boolean }) {
      const ref = useRef<any>(null);
      const [seen, setSeen] = useState(-1);
      useLayoutEffect(() => {
        const ro = new (globalThis as any).ResizeObserver((entries: any[]) => {
          sizes.push(entries[0].contentRect.width);
          setSeen(entries[0].contentRect.width);
        });
        ro.observe(ref.current);
        return () => ro.disconnect();
      }, []);
      return (
        <div>
          <div ref={ref} style={{ width: wide ? 200 : 100, height: 10 }} />
          <div style={{ width: Math.max(seen, 0), height: 1 }} />
        </div>
      );
    }
    const { root, wrap } = render(<Watch wide={false} />);
    expect(sizes).toEqual([100]);
    root.render(wrap(<Watch wide={true} />));
    expect(sizes).toEqual([100, 200]);
    // Unchanged: no further call.
    root.render(wrap(<Watch wide={true} />));
    expect(sizes).toEqual([100, 200]);
    root.unmount();
  });

  it('report an element once as intersecting, wholly', () => {
    const entries: any[] = [];
    function Watch() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        const io = new (globalThis as any).IntersectionObserver((list: any[]) => entries.push(...list));
        io.observe(ref.current);
      }, []);
      return <div ref={ref} style={{ width: 30, height: 20 }} />;
    }
    const { root } = render(<Watch />);
    root.unmount();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ isIntersecting: true, intersectionRatio: 1 });
    expect(entries[0].boundingClientRect.width).toBe(30);
  });
});

describe('the request a root sends', () => {
  it('carries the clock, the viewport and every <style> element of the tree', () => {
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        ref.current.getBoundingClientRect();
      }, []);
      return (
        <>
          <style>{'.a { color: red }'}</style>
          <div ref={ref} style={{ width: 1, height: 1 }} />
        </>
      );
    }
    const { root } = render(<Probe />, 45);
    root.unmount();
    const req = calls.requests[0] as any;
    expect(req.time).toBe(1.5);
    expect(req.viewport).toEqual({ width: 1000, height: 800 });
    expect(req.stylesheets).toEqual(['.a { color: red }']);
    expect(req.path).toBe('$1');
  });
});
