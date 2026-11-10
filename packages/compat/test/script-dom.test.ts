// What a classic page script sees of its own document: `document.currentScript` while it runs.

import { describe, expect, it } from 'vitest';
import { installDomGlobals, setPathMeasure, withCurrentScript } from '../src/shim/index.js';

installDomGlobals();
const doc = (): any => (globalThis as any).document;

describe('document.currentScript', () => {
  it('is null outside a script', () => {
    expect(doc().currentScript).toBeNull();
  });

  it('is the running <script>, inside the element it sits in, and null again after', () => {
    const root = doc().createElement('div');
    root.id = 'root';
    root.innerHTML = '<p class="x">hi</p>';
    doc().body.appendChild(root);
    let seen: any = null;
    withCurrentScript(root, () => {
      seen = doc().currentScript;
      // The component idiom: the script finds its own root through `closest`.
      doc().currentScript.closest('#root').querySelector('.x').style.color = 'red';
    });
    expect(seen.tagName).toBe('SCRIPT');
    expect(root.querySelector('.x').style.color).toBe('red');
    expect(doc().currentScript).toBeNull();
    // The tree is as it was: the marker is not left behind.
    expect(root.children.length).toBe(1);
  });

  it('leaves the tree alone when the script replaced its parent\'s content', () => {
    const root = doc().createElement('div');
    root.id = 'root';
    doc().body.appendChild(root);
    withCurrentScript(root, () => {
      doc().currentScript.closest('#root').innerHTML = '<p>new</p>';
    });
    expect(root.innerHTML).toBe('<p>new</p>');
    expect(doc().currentScript).toBeNull();
  });

  it('is null again when the script throws', () => {
    expect(() =>
      withCurrentScript(null, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(doc().currentScript).toBeNull();
  });
});

describe('XMLSerializer', () => {
  const HTML = 'http://www.w3.org/1999/xhtml';
  const SVG = 'http://www.w3.org/2000/svg';
  it('is a global that writes an element as XML, with its namespaces', () => {
    const wrap = doc().createElement('div');
    wrap.className = 'a b';
    wrap.setAttribute('data-x', 'a&b "q"');
    wrap.innerHTML = '<p>1 &lt; 2 &amp; 3</p><br><img src="x.png"><span></span>';
    const xml = new (globalThis as any).XMLSerializer().serializeToString(wrap);
    expect(xml).toBe(`<div xmlns="${HTML}" class="a b" data-x="a&amp;b &quot;q&quot;"><p>1 &lt; 2 &amp; 3</p><br /><img src="x.png" /><span></span></div>`);
    // Read back through innerHTML it is the markup it came from.
    const back = doc().createElement('div');
    back.innerHTML = xml;
    expect(back.firstElementChild.children.length).toBe(4);
    expect(back.firstElementChild.lastElementChild.children.length).toBe(0);
  });

  it('declares a nested svg and the html inside a foreignObject once each', () => {
    const wrap = doc().createElement('div');
    wrap.innerHTML = '<svg viewBox="0 0 10 10"><rect width="5"/><foreignObject><div>t</div></foreignObject></svg>';
    const xml = new (globalThis as any).XMLSerializer().serializeToString(wrap);
    expect(xml).toBe(
      `<div xmlns="${HTML}"><svg xmlns="${SVG}" viewBox="0 0 10 10"><rect width="5"/><foreignObject><div xmlns="${HTML}">t</div></foreignObject></svg></div>`,
    );
  });

  it('writes a document as its root element, and a text node as its text', () => {
    const s = new (globalThis as any).XMLSerializer();
    expect(s.serializeToString(doc())).toMatch(/^<html xmlns="http:\/\/www.w3.org\/1999\/xhtml"/);
    expect(s.serializeToString(doc().createTextNode('a<b'))).toBe('a&lt;b');
  });
});

describe('SVG viewBox, points and matrices', () => {
  const svgIn = (html: string): any => {
    const host = doc().createElement('div');
    host.innerHTML = html;
    doc().body.appendChild(host);
    return host.querySelector('svg');
  };

  it('svg.viewBox.baseVal is the viewBox attribute as a rect', () => {
    const svg = svgIn('<svg id="s" viewBox="10 20 520 220"></svg>');
    const vb = svg.viewBox.baseVal;
    expect([vb.x, vb.y, vb.width, vb.height]).toEqual([10, 20, 520, 220]);
    // No attribute: a browser gives an empty rect, not undefined.
    const bare = svgIn('<svg></svg>');
    expect([bare.viewBox.baseVal.width, bare.viewBox.baseVal.height]).toEqual([0, 0]);
    // An HTML element has none.
    expect(doc().createElement('div').viewBox).toBeUndefined();
  });

  it('a point from getPointAtLength or createSVGPoint goes through a matrix', () => {
    // The path functions core hands over, here a stand-in for a straight line along x.
    setPathMeasure({ getLength: () => 50, getPointAtLength: (_d, length) => ({ x: length, y: 0 }), getBoundingBox: () => ({ x1: 0, y1: 0, x2: 50, y2: 0, width: 50, height: 0 }) });
    const svg = svgIn('<svg><path id="p" d="M0 0 L50 0"/></svg>');
    const p = svg.querySelector('#p').getPointAtLength(10).matrixTransform({ a: 1, b: 0, c: 0, d: 1, e: 5, f: 5 });
    expect([p.x, p.y]).toEqual([15, 5]);
    const q = svg.createSVGPoint();
    q.x = 2;
    q.y = 3;
    const r = q.matrixTransform({ a: 2, b: 0, c: 0, d: 4, e: 1, f: 0 });
    expect([r.x, r.y]).toEqual([5, 12]);
    // The point is not changed.
    expect([q.x, q.y]).toEqual([2, 3]);
    setPathMeasure(null);
  });

  it('getCTM and getScreenCTM are matrices that invert and multiply', () => {
    const svg = svgIn('<svg width="100" height="100"><g transform="translate(10 20) scale(2)"><rect id="r" width="5" height="5"/></g></svg>');
    const m = svg.querySelector('#r').getCTM();
    expect([m.a, m.d, m.e, m.f]).toEqual([2, 2, 10, 20]);
    const back = m.inverse().multiply(m);
    expect([back.a, back.b, back.c, back.d, back.e, back.f].map((v: number) => Math.round(v * 1e9) / 1e9)).toEqual([1, 0, 0, 1, 0, 0]);
    // Unlaid out, the svg sits at the page origin: the screen matrix is the transforms, and its inverse maps a page point back.
    const screen = svg.querySelector('#r').getScreenCTM();
    const pt = svg.createSVGPoint();
    pt.x = 20;
    pt.y = 30;
    const inUser = pt.matrixTransform(screen.inverse());
    expect([inUser.x, inUser.y]).toEqual([5, 5]);
    // The svg itself has one too (the usual pointer-to-user-space pattern).
    expect(svg.getScreenCTM().inverse()).toBeDefined();
  });
});

describe('inline style priority', () => {
  it('getPropertyPriority says important for what was written important, and reads the value without it', () => {
    const el = doc().createElement('div');
    doc().body.appendChild(el);
    el.setAttribute('style', 'visibility:hidden');
    expect(el.style.getPropertyPriority('visibility')).toBe('');
    el.style.setProperty('display', 'none', 'important');
    expect(el.style.getPropertyPriority('display')).toBe('important');
    expect(el.style.getPropertyValue('display')).toBe('none');
    expect(el.style.display).toBe('none');
    el.style.setProperty('display', 'block');
    expect(el.style.getPropertyPriority('display')).toBe('');
    expect(el.style.getPropertyPriority('missing')).toBe('');
  });
});
