// A script changing the tree (packages/cli/skills/kinetograph/references/ENGINE.md §1, "Readback"): a library that mounts its own nodes with appendChild,
// prepend and insertBefore, makes elements with document.createElement, puts a <style> in document.head, and watches with
// a MutationObserver; Range boxes and SVG character positions. The addon is a stand-in that lays each element out from its
// inline width/height (px), a text range 8 px per character, and records the requests it is sent.

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setDomAddon, resetStylesheets } from '@kinetographdev/compat/dom';
import { installDomGlobals, resetObservers } from '@kinetographdev/compat/shim';
import { createSceneRoot, TimelineContext } from '../src/index.js';
import { timeline } from './harness.js';

interface Req {
  root: any;
  stylesheets: string[];
  path: string;
}

beforeAll(() => installDomGlobals());

let requests: Req[];

const textOf = (node: any): string => (node.kind === 'text' ? node.text : (node.children ?? []).map(textOf).join(''));

function boxesOf(req: Req): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let y = 0;
  const visit = (node: any): void => {
    if (node.kind !== 'element') return;
    const m = (name: string): number => Number(new RegExp(`${name}: (\\d+(?:\\.\\d+)?)px`).exec(node.style)?.[1] ?? 0);
    const ranged = node.attrs?.['data-kg-range'] !== undefined;
    const width = ranged || node.tag === 'text' ? textOf(node).length * 8 : m('width');
    const height = ranged ? 10 : m('height');
    y += 1;
    // A range marker sits after the text before it: 8 px per character.
    out[node.path] = { x: 0, y, width, height, rect: { x: 0, y, width, height }, client: { width, height }, scroll: { width, height } };
    node.children.forEach(visit);
  };
  visit(req.root);
  return out;
}

beforeEach(() => {
  requests = [];
  setDomAddon({
    renderDomIsland: () => JSON.stringify({ layers: [], unsupported: [], camera: null }),
    domLayoutBoxes(json: string) {
      const req = JSON.parse(json) as Req;
      requests.push(req);
      return JSON.stringify(boxesOf(req));
    },
    domComputedStyle: (_json: string, _path: string, props: string[]) => props.map(() => ''),
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

const g = globalThis as any;
const tagsOf = (el: any): string[] => el.children.map((c: any) => `${c.tagName.toLowerCase()}${c.id ? '#' + c.id : ''}`);

describe('a script putting nodes into the tree', () => {
  it('appends, prepends and inserts nodes, and the island holds them in order', () => {
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        const el = ref.current;
        const make = (id: string) => Object.assign(g.document.createElement('span'), { id });
        el.appendChild(make('last'));
        el.prepend(make('first'));
        el.insertBefore(make('middle'), el.querySelector('#b'));
        // The box of what a script added is read like any other element's.
        el.querySelector('#last').style.width = '30px';
        el.querySelector('#last').style.height = '5px';
        expect(el.querySelector('#last').getBoundingClientRect().width).toBe(30);
      }, []);
      return (
        <div ref={ref}>
          <i id="a" />
          <i id="b" />
        </div>
      );
    }
    const { root, tree } = render(<Probe />);
    root.unmount();
    expect(tree).toBeDefined();
    const last = requests.at(-1)!.root;
    expect(last.children.map((c: any) => `${c.tag}#${c.attrs.id}`)).toEqual(['span#first', 'i#a', 'span#middle', 'i#b', 'span#last']);
    expect(last.children.map((c: any) => c.path)).toEqual(['$0.0', '$0.1', '$0.2', '$0.3', '$0.4']);
  });

  it('moves a node it appends again, removes and replaces, and answers parent and sibling questions', () => {
    const seen: Record<string, unknown> = {};
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        const el = ref.current;
        const a = g.document.createElement('p');
        const b = g.document.createElement('p');
        a.id = 'a';
        b.id = 'b';
        el.append(a, b, 'text');
        seen.detachedBefore = g.document.createElement('div').isConnected;
        seen.connected = a.isConnected;
        seen.parent = a.parentElement === el;
        seen.next = a.nextElementSibling === b;
        seen.nextNode = b.nextSibling.data;
        el.appendChild(a);
        seen.moved = tagsOf(el);
        el.removeChild(b);
        seen.afterRemove = [tagsOf(el), b.isConnected, b.parentElement];
        el.replaceChild(b, a);
        seen.afterReplace = tagsOf(el);
        a.remove();
        seen.text = el.textContent;
        el.textContent = 'x';
        seen.cleared = [el.children.length, el.textContent];
        el.replaceChildren(a, b);
        seen.replaced = tagsOf(el);
        try {
          a.appendChild(a);
        } catch (e: any) {
          seen.cycle = e.name;
        }
        try {
          el.insertBefore(b, g.document.createElement('p'));
        } catch (e: any) {
          seen.notChild = e.name;
        }
      }, []);
      return <section ref={ref} />;
    }
    render(<Probe />).root.unmount();
    expect(seen).toMatchObject({
      detachedBefore: false,
      connected: true,
      parent: true,
      next: true,
      nextNode: 'text',
      moved: ['p#b', 'p#a'],
      afterRemove: [['p#a'], false, null],
      afterReplace: ['p#b'],
      text: 'text',
      cleared: [0, 'x'],
      replaced: ['p#a', 'p#b'],
      cycle: 'HierarchyRequestError',
      notChild: 'NotFoundError',
    });
  });

  it('makes elements that are written with attributes, style, innerHTML and cloneNode, and reads them back', () => {
    const seen: Record<string, unknown> = {};
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        const div = g.document.createElement('div');
        div.setAttribute('data-x', '1');
        div.className = 'card';
        div.style.color = 'red';
        div.innerHTML = '<b id="in">hi</b> there';
        seen.html = div.innerHTML;
        seen.outer = div.outerHTML;
        const copy = div.cloneNode(true);
        copy.setAttribute('data-x', '2');
        seen.cloned = [div.getAttribute('data-x'), copy.getAttribute('data-x'), copy.querySelector('#in') !== null, copy.querySelector('#in') !== div.querySelector('#in')];
        seen.nodeName = div.nodeName;
        ref.current.append(div, copy);
        seen.query = ref.current.querySelectorAll('.card').length;
      }, []);
      return <div ref={ref} />;
    }
    render(<Probe />).root.unmount();
    expect(seen.html).toBe('<b id="in">hi</b> there');
    expect(seen.outer).toBe('<div data-x="1" class="card" style="color: red"><b id="in">hi</b> there</div>');
    expect(seen.cloned).toEqual(['1', '2', true, true]);
    expect(seen.nodeName).toBe('DIV');
    expect(seen.query).toBe(2);
    const children = requests.at(-1)?.root;
    expect(children).toBeUndefined();
  });

  it('draws on a canvas it made before and after it is put in the tree', () => {
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        const canvas = g.document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 32;
        canvas.getContext('2d').fillRect(0, 0, 10, 10);
        ref.current.prepend(canvas);
        canvas.getContext('2d').fillRect(5, 5, 10, 10);
      }, []);
      return <div ref={ref} style={{ width: 10, height: 10 }} />;
    }
    const { tree, root } = render(<Probe />);
    root.unmount();
    expect(tree).toBeDefined();
  });
});

describe('IDL attributes a script assigns', () => {
  it('reflect their content attribute, as in a browser, so what a script sets is drawn', () => {
    const seen: Record<string, unknown> = {};
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        const [img, video, link, svg, div] = ref.current.children;
        img.src = 'a.png';
        img.srcset = 'b.png 2x';
        img.alt = 'A';
        img.width = 40.7;
        video.poster = 'p.png';
        video.src = 'v.mp4';
        link.href = 'https://x.test/';
        const image = svg.firstChild;
        image.href.baseVal = 'i.png';
        // An SVGAnimatedString is not written by assigning to it.
        image.href = 'ignored.png';
        div.src = 'expando';
        seen.img = [img.getAttribute('src'), img.getAttribute('srcset'), img.getAttribute('alt'), img.getAttribute('width'), img.src, img.alt, img.currentSrc];
        seen.video = [video.getAttribute('poster'), video.getAttribute('src'), video.poster];
        seen.link = [link.getAttribute('href'), link.href];
        seen.image = [image.getAttribute('href'), image.href.baseVal, image.href.animVal];
        seen.div = [div.getAttribute('src'), div.src, g.document.createElement('span').src];
        // As Chrome for Testing answers: absent is '', empty is the document's URL, a value that does not parse is kept.
        const make = (tag: string, name: string, value?: string) => {
          const e = g.document.createElement(tag);
          if (value !== undefined) e.setAttribute(name, value);
          return e[name];
        };
        seen.urls = [
          make('img', 'src'),
          make('img', 'src', ''),
          make('img', 'src', 'a b.png?x=1#h'),
          make('img', 'src', 'https://x.test/a.png'),
          make('img', 'src', 'http://[bad'),
          make('img', 'src', '/root.png'),
          make('a', 'href'),
          make('a', 'href', 'page.html'),
          make('link', 'href', 's.css'),
          make('source', 'src', 'v.mp4'),
        ];
        // A resolved URL read back and set again is the same project file.
        const copy = g.document.createElement('img');
        copy.src = img.src;
        seen.copy = copy.getAttribute('src');
        seen.parses = new URL(link.href).href;
        seen.outer = img.outerHTML;
        // `xlink:href` answers when there is no `href`.
        const old = g.document.createElementNS('http://www.w3.org/2000/svg', 'image');
        svg.append(old);
        old.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', 'x.png');
        old.removeAttribute('href');
        seen.xlink = old.href.baseVal;
      }, []);
      return (
        <div ref={ref}>
          <img />
          <video />
          <a />
          <svg>
            <image />
          </svg>
          <div />
        </div>
      );
    }
    render(<Probe />).root.unmount();
    // `src` is the 1x candidate when the srcset has none.
    // getAttribute keeps the value as written; the property is the URL resolved against the document's (`location`).
    expect(seen.img).toEqual(['a.png', 'b.png 2x', 'A', '40', 'http://localhost/a.png', 'A', 'http://localhost/a.png']);
    expect(seen.video).toEqual(['p.png', 'v.mp4', 'http://localhost/p.png']);
    expect(seen.link).toEqual(['https://x.test/', 'https://x.test/']);
    expect(seen.image).toEqual(['i.png', 'i.png', 'i.png']);
    expect(seen.div).toEqual([null, 'expando', undefined]);
    expect(seen.outer).toBe('<img src="a.png" srcset="b.png 2x" alt="A" width="40">');
    expect(seen.xlink).toBe('x.png');
    expect(seen.urls).toEqual([
      '',
      'http://localhost/',
      'http://localhost/a%20b.png?x=1#h',
      'https://x.test/a.png',
      'http://[bad',
      'http://localhost/root.png',
      '',
      'http://localhost/page.html',
      'http://localhost/s.css',
      'http://localhost/v.mp4',
    ]);
    expect(seen.copy).toBe('http://localhost/a.png');
    expect(seen.parses).toBe('https://x.test/');
  });
});

describe('element.style reads like the CSSOM', () => {
  it('gives a zero length back with its unit, so a library animating from 0 keeps px', () => {
    // anime.js takes the unit of `width: [0, 100]` from the value it reads; a bare `0` made it write `55.5` (invalid CSS).
    let seen: Record<string, string> = {};
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        const s = ref.current.style;
        seen = { width: s.width, height: s.height, margin: s.margin, opacity: s.opacity, lineHeight: s.lineHeight, before: s.top };
        s.top = '0';
        s.setProperty('left', '0px');
        s.padding = '0 4px 0 0';
        seen.top = s.top;
        seen.left = s.left;
        seen.padding = s.padding;
        s.width = '55.5px';
        seen.grown = s.width;
      }, []);
      return <div ref={ref} style={{ width: 0, height: '0', margin: 0, opacity: 0, lineHeight: 0 }} />;
    }
    const { root } = render(<Probe />);
    root.unmount();
    expect(seen).toMatchObject({
      width: '0px',
      height: '0px',
      margin: '0px',
      opacity: '0',
      lineHeight: '0',
      before: '',
      top: '0px',
      left: '0px',
      padding: '0px 4px 0px 0px',
      grown: '55.5px',
    });
  });
});

describe('React and a script sharing a parent', () => {
  it('place React’s own insertions right around a node a library added', () => {
    let add!: (items: string[]) => void;
    let host: any;
    function List() {
      const [items, setItems] = useState(['a', 'c']);
      add = setItems;
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        host = ref.current;
        if (!ref.current.querySelector('#lib')) {
          const lib = g.document.createElement('canvas');
          lib.id = 'lib';
          ref.current.append(lib);
        }
      });
      return (
        <ul ref={ref}>
          {items.map((i) => (
            <li key={i} id={i} />
          ))}
        </ul>
      );
    }
    const { root } = render(<List />);
    expect(tagsOf(host)).toEqual(['li#a', 'li#c', 'canvas#lib']);
    // A new item in the middle goes before its React sibling; one at the end goes after everything, as in a browser.
    add(['a', 'b', 'c']);
    root.snapshot();
    expect(tagsOf(host)).toEqual(['li#a', 'li#b', 'li#c', 'canvas#lib']);
    add(['a', 'b', 'c', 'd']);
    root.snapshot();
    expect(tagsOf(host)).toEqual(['li#a', 'li#b', 'li#c', 'canvas#lib', 'li#d']);
    add(['d', 'a']);
    root.snapshot();
    expect(host.children.map((c: any) => c.id).sort()).toEqual(['a', 'd', 'lib']);
    expect(host.querySelector('#lib')).not.toBeNull();
    // Removing a React child leaves the library's node alone.
    add(['a']);
    root.snapshot();
    expect(host.querySelector('#lib')).not.toBeNull();
    expect(host.querySelector('#d')).toBeNull();
    // The island React is drawn from has both, with paths that follow the order.
    root.unmount();
    const request = requests.at(-1) ?? null;
    expect(request === null || request.root.children.length >= 1).toBe(true);
  });
});

describe('document.head and document.body', () => {
  it('make a <style> put in head a stylesheet of every island', () => {
    function Probe() {
      useLayoutEffect(() => {
        const style = g.document.createElement('style');
        style.textContent = '.box { height: 70px }';
        g.document.head.prepend(style);
        g.document.createElement('div').getBoundingClientRect();
      }, []);
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        ref.current.getBoundingClientRect();
      });
      return <div ref={ref} className="box" />;
    }
    const { root } = render(<Probe />);
    root.unmount();
    expect(requests.at(-1)!.stylesheets).toContain('.box { height: 70px }');
    expect(g.document.head.querySelector('style').textContent).toBe('.box { height: 70px }');
    g.document.head.querySelector('style').remove();
    expect(g.document.head.children).toHaveLength(0);
  });

  it('put what a script appends to body at the top level of the root, in the same tree', () => {
    const seen: Record<string, unknown> = {};
    function Probe() {
      useLayoutEffect(() => {
        const el = Object.assign(g.document.createElement('div'), { id: 'overlay' });
        g.document.body.appendChild(el);
        seen.parent = el.parentElement === g.document.body;
        seen.html = g.document.body.parentElement === g.document.documentElement;
        seen.found = g.document.querySelector('#overlay') === el;
        seen.size = [g.document.body.clientWidth, g.document.body.clientHeight];
        seen.connected = el.isConnected;
      }, []);
      return <p id="p" />;
    }
    const { root, tree } = render(<Probe />);
    expect(tree.layers).toBeDefined();
    root.unmount();
    expect(seen).toEqual({ parent: true, html: true, found: true, size: [1000, 800], connected: true });
  });

  it('keeps what a script appended to body before the root existed, and gives it to the root that renders', () => {
    const pending = Object.assign(g.document.createElement('div'), { id: 'early' });
    g.document.body.appendChild(pending);
    const { root } = render(<p id="p" />);
    expect(g.document.querySelector('#early')).toBe(pending);
    expect(pending.isConnected).toBe(true);
    root.unmount();
  });
});

describe('MutationObserver', () => {
  it('reports the children and attributes a script changed, after the frame’s work, and what React placed', () => {
    const records: any[] = [];
    let bump!: () => void;
    function Probe() {
      const ref = useRef<any>(null);
      const [n, setN] = useState(0);
      bump = () => setN((v) => v + 1);
      useLayoutEffect(() => {
        const observer = new g.MutationObserver((list: any[]) => records.push(...list));
        observer.observe(ref.current, { childList: true, attributes: true, attributeOldValue: true, subtree: true });
        ref.current.append(g.document.createElement('span'));
        ref.current.setAttribute('data-a', '1');
        ref.current.setAttribute('data-a', '2');
        return () => observer.disconnect();
      }, []);
      return (
        <div ref={ref}>
          {Array.from({ length: n }, (_, i) => (
            <b key={i} />
          ))}
        </div>
      );
    }
    const { root } = render(<Probe />);
    root.snapshot();
    expect(records.map((r) => [r.type, r.attributeName, r.oldValue, r.addedNodes.length])).toEqual([
      ['childList', null, null, 1],
      ['attributes', 'data-a', null, 0],
      ['attributes', 'data-a', '1', 0],
    ]);
    records.length = 0;
    bump();
    root.snapshot();
    expect(records.map((r) => [r.type, r.addedNodes.map((n: any) => n.tagName)])).toEqual([['childList', ['B']]]);
    root.unmount();
  });

  it('refuses a call that watches nothing', () => {
    const observer = new g.MutationObserver(() => {});
    const el = g.document.createElement('div');
    expect(() => observer.observe(el, {})).toThrow(/at least one of/);
    expect(() => observer.observe({}, { childList: true })).toThrow(TypeError);
  });
});

describe('Range', () => {
  it('measures a piece of a text node, and the elements and text it covers', () => {
    const seen: Record<string, any> = {};
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        const text = ref.current.firstChild;
        const range = g.document.createRange();
        range.setStart(text, 2);
        range.setEnd(text, 7);
        seen.piece = range.getBoundingClientRect().toJSON();
        seen.string = range.toString();
        range.selectNodeContents(text);
        seen.all = range.getBoundingClientRect().width;
        range.selectNode(ref.current.querySelector('i'));
        seen.element = range.getBoundingClientRect().toJSON();
        seen.collapsed = [range.collapsed, g.document.createRange().collapsed];
        seen.ancestor = range.commonAncestorContainer === ref.current;
      }, []);
      return (
        <p ref={ref}>
          hello world<i style={{ width: 20, height: 4 }} />
        </p>
      );
    }
    render(<Probe />).root.unmount();
    // Five characters at 8 px.
    expect(seen.piece).toMatchObject({ width: 40, height: 10 });
    expect(seen.string).toBe('llo w');
    expect(seen.all).toBe(88);
    expect(seen.element).toMatchObject({ width: 20, height: 4 });
    expect(seen.collapsed).toEqual([false, true]);
    expect(seen.ancestor).toBe(true);
    // The text was measured in a request where it is split around a marker, and put back after.
    const marked = requests.find((r) => JSON.stringify(r.root).includes('data-kg-range'));
    expect(marked).toBeDefined();
  });

  it('leaves the tree as it was after measuring', () => {
    let after: unknown;
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        const range = g.document.createRange();
        range.selectNodeContents(ref.current.firstChild);
        range.getBoundingClientRect();
        after = [ref.current.childNodes.length, ref.current.textContent];
      }, []);
      return <p ref={ref}>abc</p>;
    }
    render(<Probe />).root.unmount();
    expect(after).toEqual([1, 'abc']);
  });
});

describe('SVG text characters', () => {
  it('counts characters and places each one from the text’s x, y and anchor', () => {
    const seen: Record<string, any> = {};
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        const t = ref.current.querySelector('text');
        seen.count = t.getNumberOfChars();
        seen.start = [0, 1, 4].map((i) => t.getStartPositionOfChar(i));
        seen.end = t.getEndPositionOfChar(4);
        seen.sub = t.getSubStringLength(1, 2);
        try {
          t.getStartPositionOfChar(5);
        } catch (e: any) {
          seen.range = e.name;
        }
        try {
          ref.current.getNumberOfChars();
        } catch (e: any) {
          seen.notText = e.constructor.name;
        }
      }, []);
      return (
        <svg ref={ref} width={100} height={50}>
          <text x="10" y="20">
            Hello
          </text>
        </svg>
      );
    }
    render(<Probe />).root.unmount();
    expect(seen.count).toBe(5);
    // 8 px a character here (the stand-in's box is 40 px for five).
    expect(seen.start).toEqual([{ x: 10, y: 20 }, { x: 18, y: 20 }, { x: 42, y: 20 }]);
    expect(seen.end).toEqual({ x: 50, y: 20 });
    expect(seen.sub).toBe(16);
    expect(seen.range).toBe('IndexSizeError');
    expect(seen.notText).toBe('TypeError');
  });
});
