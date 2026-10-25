// Gaps Vega-Lite and Mermaid hit: namespaced attributes, document lookups of nodes appended to body, SVG text measurement and
// the computed font size of SVG text.

import { useLayoutEffect, useRef } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setDomAddon, resetStylesheets } from '@kinetographdev/compat/dom';
import { installDomGlobals, resetObservers } from '@kinetographdev/compat/shim';
import { createSceneRoot, TimelineContext } from '../src/index.js';
import { timeline } from './harness.js';

beforeAll(() => installDomGlobals());
beforeEach(() => {
  setDomAddon({
    renderDomIsland: () => JSON.stringify({ layers: [], unsupported: [], camera: null }),
    domLayoutBoxes: () => '{}',
    domComputedStyle: (_json: string, _path: string, props: string[]) => props.map(() => ''),
    // 8 px a character, 20 px a line with the baseline at 16.
    layoutText: (req: { text: string }) => ({
      width: req.text.length * 8,
      height: 20,
      lines: [{ top: 0, bottom: 20, baseline: 16, start: 0, end: req.text.length }],
      glyphs: [],
    }),
  });
});
afterEach(() => {
  setDomAddon(null);
  resetObservers();
  resetStylesheets();
});

const g = globalThis as any;
const SVG = 'http://www.w3.org/2000/svg';
const XLINK = 'http://www.w3.org/1999/xlink';

describe('namespaced attributes', () => {
  it('map onto the attribute by its qualified name, and xlink:href answers as href', () => {
    const use = g.document.createElementNS(SVG, 'use');
    use.setAttributeNS(XLINK, 'xlink:href', '#a');
    expect(use.getAttributeNS(XLINK, 'href')).toBe('#a');
    expect(use.getAttribute('xlink:href')).toBe('#a');
    expect(use.getAttribute('href')).toBe('#a');
    expect(use.hasAttributeNS(XLINK, 'href')).toBe(true);
    use.removeAttributeNS(XLINK, 'href');
    expect(use.getAttribute('href')).toBeNull();
    expect(use.hasAttributeNS(XLINK, 'href')).toBe(false);
    const svg = g.document.createElementNS(SVG, 'svg');
    svg.setAttributeNS(null, 'width', '10');
    svg.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:xlink', XLINK);
    expect(svg.getAttributeNS(null, 'width')).toBe('10');
    expect(svg.getAttribute('xmlns:xlink')).toBe(XLINK);
  });
});

describe('document lookups', () => {
  it('find a node appended to body outside any React root, and body.contains says so', () => {
    const div = g.document.createElement('div');
    div.id = 'outside-root';
    const inner = g.document.createElement('span');
    inner.className = 'inner';
    div.appendChild(inner);
    g.document.body.appendChild(div);
    expect(g.document.getElementById('outside-root')).toBe(div);
    expect(g.document.querySelector('#outside-root')).toBe(div);
    expect(g.document.querySelectorAll('#outside-root .inner').length).toBe(1);
    expect(g.document.body.contains(div)).toBe(true);
    expect(g.document.body.contains(inner)).toBe(true);
    expect(g.document.body.contains(g.document.createElement('p'))).toBe(false);
    expect(g.document.body.contains(g.document.head)).toBe(false);
    div.remove();
    expect(g.document.getElementById('outside-root')).toBeNull();
    expect(g.document.body.contains(div)).toBe(false);
  });
});

describe('SVG text', () => {
  it('measures with the text engine and reports the font size getComputedStyle would', () => {
    const seen: Record<string, any> = {};
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        const t = ref.current as any;
        seen.length = t.getComputedTextLength();
        const b = t.getBBox();
        seen.bbox = [b.x, b.y, b.width, b.height];
        seen.size = g.getComputedStyle(t).fontSize;
        seen.inherited = g.getComputedStyle(t.parentNode).fontSize;
      });
      return (
        <svg width={200} height={100} fontSize={12}>
          <text ref={ref} x={50} y={30} textAnchor="middle" fontSize={20}>
            hello
          </text>
        </svg>
      );
    }
    const root = createSceneRoot({ viewport: { width: 200, height: 100 }, fonts: () => ({}), time: () => 0 });
    root.render(
      <TimelineContext.Provider value={timeline(0)}>
        <Probe />
      </TimelineContext.Provider>,
    );
    root.unmount();
    expect(seen.length).toBe(40);
    // middle-anchored at x = 50: 20 either side; the baseline (y = 30) is 16 below the top.
    expect(seen.bbox).toEqual([30, 14, 40, 20]);
    expect(seen.size).toBe('20px');
    expect(seen.inherited).toBe('12px');
  });
});
