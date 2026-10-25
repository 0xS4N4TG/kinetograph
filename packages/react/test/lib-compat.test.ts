// The small DOM gaps that blocked popular libraries (anime.js, Motion, d3-selection, Paper.js, Chart.js): each is one describe.

import { beforeAll, describe, expect, it } from 'vitest';
import { installDomGlobals } from '@kinetographdev/compat/shim';

beforeAll(() => installDomGlobals());

const g = globalThis as any;

describe('NodeList and HTMLCollection', () => {
  it('are the classes querySelectorAll, childNodes, children and getElementsBy* return', () => {
    const root = g.document.createElement('div');
    root.append(g.document.createElement('p'), g.document.createElement('p'), 'text');
    expect(root.querySelectorAll('p') instanceof g.NodeList).toBe(true);
    expect(root.childNodes instanceof g.NodeList).toBe(true);
    expect(root.children instanceof g.HTMLCollection).toBe(true);
    expect(root.getElementsByTagName('p') instanceof g.HTMLCollection).toBe(true);
    expect(root.getElementsByClassName('x') instanceof g.HTMLCollection).toBe(true);
    expect(g.document.querySelectorAll('nothing-here') instanceof g.NodeList).toBe(true);
    expect(root.children instanceof g.NodeList).toBe(false);
  });

  it('iterate, index and answer item()', () => {
    const root = g.document.createElement('div');
    root.append(g.document.createElement('p'), g.document.createElement('span'));
    const list = root.querySelectorAll('p, span');
    expect(list.length).toBe(2);
    expect([...list].map((e: any) => e.tagName)).toEqual(['P', 'SPAN']);
    expect(list.item(1)).toBe(list[1]);
    expect(list.item(5)).toBeNull();
    expect(Array.from(root.children).length).toBe(2);
  });
});

describe('HTMLElement and SVGElement', () => {
  it('tell an HTML element from an SVG one', () => {
    const div = g.document.createElement('div');
    const rect = g.document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    const svg = g.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    expect(div instanceof g.HTMLElement).toBe(true);
    expect(div instanceof g.SVGElement).toBe(false);
    expect(svg instanceof g.SVGElement).toBe(true);
    expect(rect instanceof g.HTMLElement).toBe(false);
    expect(rect instanceof g.Element).toBe(true);
  });
});
