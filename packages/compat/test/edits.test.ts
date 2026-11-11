// Island edits (request/edits.ts): a kept request changed in place to the tree as scripts left it, or null when the
// edits cannot say what changed.

import { describe, expect, it } from 'vitest';
import { buildIslandRequest } from '../src/request/build.js';
import { editableRequest, islandEdits } from '../src/request/edits.js';
import type { DomNode } from '../src/types.js';

type El = Extract<DomNode, { kind: 'element' }>;
const node = (type: string, props: Record<string, any> = {}, children: DomNode[] = []): El => ({ kind: 'element', type, props, children });
const text = (t: string): DomNode => ({ kind: 'text', text: t });
const build = (root: El) => buildIslandRequest(root, { path: '$0', viewport: { width: 100, height: 100 }, fonts: {}, baseDir: '/p', time: 0, stylesheets: [] }).request;
const texts = (el: El) => el.children.map((c) => (c.kind === 'text' ? c.text : null));

describe('islandEdits', () => {
  const tree = (style: Record<string, unknown>, className: string, label: string) =>
    node('div', { className, style }, [text(label), node('svg', { viewBox: '0 0 1 1' }, [node('rect', { strokeWidth: 2 })])]);

  it('changes the kept request to the one a build gives, and says only what changed', () => {
    const kept = editableRequest(build(tree({ width: 10 }, 'a', 'one')))!;
    const now = tree({ width: 20, opacity: 0.5 }, 'a', 'two');
    const set = islandEdits(kept, [{ path: '$0', node: now, children: texts(now) }], 1.5);
    expect(set).toEqual([{ path: '$0', style: 'width: 20px; opacity: 0.5', texts: [[0, 'two']] }]);
    expect(kept.request).toEqual({ ...build(now), time: 1.5 });
    // An SVG attribute, named as inside an svg.
    const rect = node('rect', { strokeWidth: 3 });
    expect(islandEdits(kept, [{ path: '$0.0.0', node: rect, children: [] }], 1.5)).toEqual([{ path: '$0.0.0', attrs: { 'stroke-width': '3' } }]);
    // Nothing changed: no edits.
    expect(islandEdits(kept, [{ path: '$0.0.0', node: rect, children: [] }], 1.5)).toEqual([]);
  });

  it('cannot say a change it does not follow, and changes nothing then', () => {
    const kept = editableRequest(build(tree({ width: 10 }, 'a', 'one')))!;
    const before = JSON.stringify(kept.request);
    const now = tree({ width: 20 }, 'a', 'one');
    const cases = [
      [{ path: '$0', node: now, children: texts(now) }, { path: '$0.7', node: now, children: [] }],
      [{ path: '$0', node: node('span', {}, now.children), children: texts(now) }],
      [{ path: '$0', node: now, children: [null, null] }],
      [{ path: '$0', node: now, children: ['one'] }],
      [{ path: '$0', node: { ...now, props: { ...now.props, dangerouslySetInnerHTML: { __html: 'x' } } }, children: texts(now) }],
    ];
    for (const changed of cases) expect(islandEdits(kept, changed, 0)).toBeNull();
    expect(JSON.stringify(kept.request)).toBe(before);
  });

  it('does not keep a request that holds a canvas', () => {
    expect(editableRequest(build(node('div', {}, [node('canvas')])))).toBeNull();
  });
});
