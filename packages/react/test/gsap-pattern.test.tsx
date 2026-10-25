// What a Remotion project that animates with GSAP does to the host tree (CSSPlugin's probes and writes): a paused
// timeline built in a layout effect on refs, seeked in another. The addon is a stand-in that answers only for paths
// the island holds, as the real one does; the patterns are the ones GSAP 3.13 uses, written out without the library.

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setDomAddon, resetStylesheets } from '@kinetographdev/compat/dom';
import { installDomGlobals, resetObservers, setPathMeasure } from '@kinetographdev/compat/shim';
import { createSceneRoot, Layer, Rect, TimelineContext } from '../src/index.js';
import { timeline } from './harness.js';

beforeAll(() => installDomGlobals());

// The globals the shim installs (this package's tests have no DOM types).
const computedStyle = (el: unknown): Record<string, string> => (globalThis as any).getComputedStyle(el);
const doc = (): any => (globalThis as any).document;

let requests: any[];
let styleAnswer: (path: string, property: string) => string;
let failComputed = false;

/** The paths of the elements in an island request. */
function pathsOf(node: any, out = new Set<string>()): Set<string> {
  if (node.kind !== 'element') return out;
  out.add(node.path);
  node.children.forEach((c: any) => pathsOf(c, out));
  return out;
}

beforeEach(() => {
  requests = [];
  failComputed = false;
  styleAnswer = () => '';
  setDomAddon({
    renderDomIsland(json: string) {
      requests.push(JSON.parse(json));
      return JSON.stringify({ layers: [], unsupported: [], camera: null });
    },
    domLayoutBoxes(json: string) {
      const out: Record<string, unknown> = {};
      for (const path of pathsOf(JSON.parse(json).root)) {
        out[path] = { x: 0, y: 0, width: 10, height: 10, rect: { x: 0, y: 0, width: 10, height: 10 }, client: { width: 10, height: 10 }, scroll: { width: 10, height: 10 } };
      }
      return JSON.stringify(out);
    },
    domComputedStyle(json: string, path: string, props: string[]) {
      if (failComputed || !pathsOf(JSON.parse(json).root).has(path)) throw new Error(`no element at path "${path}" in the island`);
      return props.map((p) => styleAnswer(path, p));
    },
  });
});
afterEach(() => {
  setDomAddon(null);
  resetObservers();
  resetStylesheets();
});

function render(node: ReactNode) {
  const root = createSceneRoot({ viewport: { width: 1000, height: 800 }, fonts: () => ({}) });
  try {
    return root.render(<TimelineContext.Provider value={timeline(0)}>{node}</TimelineContext.Provider>);
  } finally {
    root.unmount();
  }
}

/** An `<AbsoluteFill>` with a background, as the layer mapping builds it: the background rectangle first. */
const Fill = ({ children }: { children: ReactNode }) => (
  <Layer passThrough domFill={{ style: { background: '#fff' }, background: true }}>
    <Rect width={1000} height={800} fill="#ffffff" />
    {children}
  </Layer>
);

describe('a ref inside an AbsoluteFill with a background', () => {
  it('is asked for by the path the island has, not one past the background rectangle', () => {
    let seen = '';
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        styleAnswer = (path, property) => (property === 'opacity' ? `at ${path}` : '');
        seen = computedStyle(ref.current).opacity;
      }, []);
      return (
        <Fill>
          <div style={{ width: 5, height: 5 }} />
          <div ref={ref} style={{ width: 5, height: 5 }} />
        </Fill>
      );
    }
    const tree = render(<Probe />);
    expect(seen).toBe('at $0.1');
    expect(tree.unsupported).toEqual([]);
  });

  it('has the fill as its parent, a div, so a library takes it for attached', () => {
    const seen: Record<string, unknown> = {};
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        const el = ref.current;
        seen.parent = el.parentNode?.tagName;
        seen.offsetParent = el.offsetParent?.tagName;
        seen.connected = el.isConnected;
      }, []);
      return (
        <Fill>
          <div ref={ref} style={{ width: 5, height: 5 }} />
        </Fill>
      );
    }
    render(<Probe />);
    expect(seen).toEqual({ parent: 'DIV', offsetParent: 'BODY', connected: true });
  });
});

describe('the style a library probes and writes', () => {
  it('answers `in` for CSS properties, not for vendor-prefixed ones', () => {
    let result: boolean[] = [];
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        const s = ref.current.style;
        result = ['transform' in s, 'perspective' in s, 'opacity' in s, 'WebkitTransform' in s, 'notACssProperty' in s];
      }, []);
      return <div ref={ref} />;
    }
    render(<Probe />);
    expect(result).toEqual([true, true, true, false, false]);
  });

  it('takes transform, opacity, colours, cssText and the individual transform properties, writing none as nothing', () => {
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        const s = ref.current.style;
        s.transform = 'translate(10px, 0px) rotate(45deg)';
        s.opacity = '0.5';
        s.backgroundColor = 'rgb(224, 38, 27)';
        s.translate = s.rotate = s.scale = 'none';
        s.cssText += 'letter-spacing: 3px; clip-path: inset(10% 20% 10% 20%); translate: none';
      }, []);
      return <div ref={ref} style={{ width: 5, height: 5 }} />;
    }
    render(<Probe />);
    const style: string = requests.at(-1)?.root.style ?? '';
    expect(style).toContain('transform: translate(10px, 0px) rotate(45deg)');
    expect(style).toContain('opacity: 0.5');
    expect(style).toContain('background-color: rgb(224, 38, 27)');
    expect(style).toContain('letter-spacing: 3px');
    expect(style).toContain('clip-path: inset(10% 20% 10% 20%)');
    expect(style).not.toMatch(/(^|; )(translate|rotate|scale):/);
  });

  it('survives hundreds of writes each followed by a read, which is not a loop of renders', () => {
    function Probe() {
      const refs = useRef<any[]>([]);
      useLayoutEffect(() => {
        for (let i = 0; i < 40; i++) {
          const el = refs.current[i % 12];
          el.getBoundingClientRect();
          el.style.transform = `translate(${i}px, 0px)`;
          computedStyle(el).opacity;
        }
      }, []);
      return (
        <div>
          {Array.from({ length: 12 }, (_, i) => (
            <span key={i} ref={(el) => void (refs.current[i] = el)} style={{ display: 'inline-block' }} />
          ))}
        </div>
      );
    }
    expect(() => render(<Probe />)).not.toThrow();
  });
});

describe('nodes a script makes', () => {
  it('lets a helper element be appended into the tree, measured and removed again', () => {
    let measured = -1;
    let afterwards = -1;
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        const parent = ref.current.parentNode;
        const helper = doc().createElement('div');
        helper.style.cssText = 'border-width:0;line-height:0;position:absolute;padding:0';
        helper.style.width = '100px';
        parent.appendChild(helper);
        measured = helper.offsetWidth;
        computedStyle(helper).opacity;
        parent.removeChild(helper);
        afterwards = parent.children.length;
      }, []);
      return (
        <Fill>
          <div ref={ref} style={{ width: 5, height: 5 }} />
        </Fill>
      );
    }
    expect(() => render(<Probe />)).not.toThrow();
    expect(measured).toBe(10);
    expect(afterwards).toBe(1);
  });

  it('answers for a node never attached, and one appended to document.documentElement', () => {
    const seen: Record<string, unknown> = {};
    function Probe() {
      useLayoutEffect(() => {
        const loose = doc().createElement('div');
        loose.style.opacity = '0.25';
        seen.loose = [computedStyle(loose).opacity, loose.offsetWidth, loose.getBoundingClientRect().width, loose.offsetParent];
        const svg = doc().createElementNS('http://www.w3.org/2000/svg', 'svg');
        doc().documentElement.appendChild(svg);
        seen.svg = svg.getBBox().width;
        doc().documentElement.removeChild(svg);
      }, []);
      return <div />;
    }
    expect(() => render(<Probe />)).not.toThrow();
    expect(seen.loose).toEqual(['0.25', 0, 0, null]);
  });
});

describe('SVG elements a library animates', () => {
  it('have an owner svg and a CTM, and a transform attribute that reads back as a matrix', () => {
    const seen: Record<string, unknown> = {};
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        const el = ref.current;
        seen.owner = el.ownerSVGElement?.tagName;
        seen.hasCtm = typeof el.getCTM === 'function' && el.getCTM() !== null;
        el.setAttribute('transform', 'matrix(0,1,-1,0,30,40)');
        const m = el.transform.baseVal.consolidate().matrix;
        seen.matrix = [m.a, m.b, m.c, m.d, m.e, m.f];
        el.setAttribute('stroke-dashoffset', '12');
        el.setAttribute('cx', '50');
      }, []);
      return (
        <svg width={100} height={100}>
          <circle ref={ref} cx={10} cy={10} r={5} />
        </svg>
      );
    }
    render(<Probe />);
    expect(seen).toEqual({ owner: 'svg', hasCtm: true, matrix: [0, 1, -1, 0, 30, 40] });
    const circle = requests.at(-1)?.root.children[0];
    expect(circle.attrs).toMatchObject({ transform: 'matrix(0,1,-1,0,30,40)', 'stroke-dashoffset': '12', cx: '50' });
  });
});

describe('a read the engine cannot answer', () => {
  it('is an unsupported warning on the tree and a value from the element’s own style, not an error', () => {
    let seen = '';
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        failComputed = true;
        seen = computedStyle(ref.current).opacity;
      }, []);
      return <div ref={ref} style={{ opacity: 0.5 }} />;
    }
    const tree = render(<Probe />);
    expect(seen).toBe('0.5');
    expect(tree.unsupported).toHaveLength(1);
    expect(tree.unsupported[0]).toMatchObject({ element: 'div' });
    expect(tree.unsupported[0]!.reason).toContain('computed style');
  });
});

describe('what GSAP plugins do at load and to text', () => {
  it('lets a script add to and remove from document.body before any root holds it', () => {
    const probe = doc().createElement('div');
    doc().body.appendChild(probe);
    expect(() => doc().body.removeChild(probe)).not.toThrow();
  });

  it('normalizes adjacent and empty text nodes (SplitText calls it on what it split)', () => {
    let texts: string[] = [];
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        const el = ref.current;
        el.appendChild(doc().createTextNode('b'));
        el.appendChild(doc().createTextNode(''));
        el.appendChild(doc().createTextNode('c'));
        el.normalize();
        texts = [...el.childNodes].map((n: any) => n.textContent);
      }, []);
      return <div ref={ref}>a</div>;
    }
    render(<Probe />);
    expect(texts).toEqual(['abc']);
  });

  it('gives an SVG shape a client rect from its bbox, transform and the svg’s viewBox', () => {
    let rect: any;
    // The path functions core hands over, here a stand-in that knows the one rect.
    setPathMeasure({ getLength: () => 40, getPointAtLength: () => ({ x: 0, y: 0 }), getBoundingBox: () => ({ x1: 5, y1: 5, x2: 15, y2: 15, width: 10, height: 10 }) });
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        ref.current.setAttribute('transform', 'translate(10,20)');
        rect = ref.current.getBoundingClientRect().toJSON();
      }, []);
      return (
        <svg width={200} height={200} viewBox="0 0 100 100">
          <rect ref={ref} x={5} y={5} width={10} height={10} />
        </svg>
      );
    }
    render(<Probe />);
    // The stand-in addon gives the svg a 10 x 10 box at the origin: a 100 x 100 viewBox scales by 0.1.
    setPathMeasure(null);
    expect(rect).toMatchObject({ x: 1.5, y: 2.5, width: 1, height: 1 });
  });
});
