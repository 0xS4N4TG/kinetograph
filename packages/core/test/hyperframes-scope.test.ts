// A mounted sub-composition's script finds the file's own root element by the id it was written with (#109): the host
// stands in for that root, so the planner records the id as `data-hf-root-id` and the scoped document resolves it.

import { describe, expect, it } from 'vitest';
import '../src/web-install.js';
import { scopedDocument } from '../src/hyperframes/scope.js';

const markup = (hostAttrs: string): any =>
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
