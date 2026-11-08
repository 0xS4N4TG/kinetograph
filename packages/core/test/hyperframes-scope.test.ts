// A mounted sub-composition's script finds the file's own root element by the id it was written with (#109): the host
// stands in for that root, so the planner records the id as `data-hf-root-id` and the scoped document resolves it.

import { describe, expect, it } from 'vitest';
import '../src/web-install.js';
import { rewriteRootId, scopedDocument, scopedGsap } from '../src/hyperframes/scope.js';

declare const DOMParser: any;

const markup =(hostAttrs: string): any =>
  new DOMParser().parseFromString(
    `<!doctype html><html><body><div id="outside"></div><div ${hostAttrs} data-composition-id="sub" data-hf-root-id="sub-root"><div id="mark" class="m"></div></div></body></html>`,
    'text/html',
  );

const scopeOf = (doc: any): any => scopedDocument({ document: doc, window: {}, gsap: () => undefined, hyperframes: {}, root: () => doc.querySelector('[data-composition-id="sub"]') });

describe.each([
  ['a host with its own id', 'id="host"'],
  ['a host without an id', ''],
])('the root of a sub-composition on %s', (_name, hostAttrs) => {
  it('is found by getElementById with the id its file gave it', () => {
    const doc = markup(hostAttrs);
    const host = doc.querySelector('[data-composition-id="sub"]');
    const scoped = scopeOf(doc);
    expect(scoped.getElementById('sub-root')).toBe(host);
    expect(scoped.getElementById('mark')).toBe(doc.getElementById('mark'));
    expect(scoped.getElementById('outside')).toBeNull();
    if (hostAttrs !== '') expect(scoped.getElementById('host')).toBe(host);
  });

  it('is found by querySelector and querySelectorAll with #id, alone or as an ancestor', () => {
    const doc = markup(hostAttrs);
    const host = doc.querySelector('[data-composition-id="sub"]');
    const scoped = scopeOf(doc);
    expect(scoped.querySelector('#sub-root')).toBe(host);
    expect(Array.from(scoped.querySelectorAll('#sub-root'))).toEqual([host]);
    expect(scoped.querySelector('#sub-root > .m')).toBe(doc.getElementById('mark'));
    expect(scoped.querySelector('#sub-root-not')).toBeNull();
    if (hostAttrs !== '') expect(scoped.querySelector('#host')).toBe(host);
  });
});

// A selector that merely mentions the id (in a quoted attribute value) is not a lookup by it; an id written with CSS
// escapes, or holding replacement-string metacharacters, is still the same id.
describe('rewriting #id for the sub-composition root', () => {
  const withInner = (rootId: string): any => {
    const doc = new DOMParser().parseFromString(
      '<!doctype html><html><body><div data-composition-id="sub"><div id="mark" class="m"></div><svg><use id="u" href="#sub-root"></use></svg></div></body></html>',
      'text/html',
    );
    doc.querySelector('[data-composition-id="sub"]').setAttribute('data-hf-root-id', rootId);
    return doc;
  };

  it('leaves a quoted attribute value alone, so the selector stays valid', () => {
    const doc = withInner('sub-root');
    const scoped = scopeOf(doc);
    expect(scoped.querySelector('use[href="#sub-root"]')).toBe(doc.getElementById('u'));
    expect(scoped.querySelector("use[href='#sub-root']")).toBe(doc.getElementById('u'));
    expect(Array.from(scoped.querySelectorAll('[data-x="a\\"#sub-root"]'))).toEqual([]);
    expect(scoped.querySelector('use:not(#other)')).toBe(doc.getElementById('u'));
    expect(scoped.querySelector('#sub-root use[href="#sub-root"]')).toBe(doc.getElementById('u'));
  });

  it.each([
    ['a.b', '#a\\.b'],
    ['a:b', '#a\\:b'],
    ['x$&y', '#x\\$\\&y'],
    ['x$$y', '#x\\$\\$y'],
    ['1a', '#\\31 a'],
  ])('finds the root with id %s by %s, and by getElementById', (rootId, selector) => {
    const doc = withInner(rootId);
    const host = doc.querySelector('[data-composition-id="sub"]');
    const scoped = scopeOf(doc);
    expect(scoped.querySelector(selector)).toBe(host);
    expect(scoped.querySelector(`${selector} > .m`)).toBe(doc.getElementById('mark'));
    expect(scoped.getElementById(rootId)).toBe(host);
  });

  it('writes the attribute value with quotes and backslashes escaped, and never as a replacement pattern', () => {
    expect(rewriteRootId('#a\\"b > .m', 'a"b')).toBe('[data-hf-root-id="a\\"b"] > .m');
    expect(rewriteRootId('#p\\\\q', 'p\\q')).toBe('[data-hf-root-id="p\\\\q"]');
    expect(rewriteRootId('#x\\$\\&y, #x\\$\\$y', 'x$&y')).toBe('[data-hf-root-id="x$&y"], #x\\$\\$y');
    expect(rewriteRootId('.a\\#sub-root, [title="]#sub-root"] #sub-root', 'sub-root')).toBe('.a\\#sub-root, [title="]#sub-root"] [data-hf-root-id="sub-root"]');
  });

  it('gsap.utils.selector finds the root by its id and keeps to the composition', () => {
    const doc = withInner('sub-root');
    const host = doc.querySelector('[data-composition-id="sub"]');
    const base = { utils: { selector: () => undefined, toArray: (v: unknown) => v } };
    const gsap = scopedGsap({ document: doc, window: {}, gsap: () => base, hyperframes: {}, root: () => host })!;
    const q = gsap.utils.selector(host);
    expect(q('#sub-root')).toEqual([host]);
    expect(q('#sub-root > .m')).toEqual([doc.getElementById('mark')]);
    expect(q('use[href="#sub-root"]')).toEqual([doc.getElementById('u')]);
    expect(q('#outside')).toEqual([]);
  });
});
