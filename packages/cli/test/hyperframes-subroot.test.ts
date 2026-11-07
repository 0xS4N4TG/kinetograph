// A sub-composition's script finds the root its file wrote by that id (#109), through the planner and the runtime's
// scoped document: the plan keeps the id as `data-hf-root-id` on the host, and the script's lookups resolve it.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import '@kinetographdev/core/web/install';
import { runScopedScript, type HfNode, type ScopeEnv } from '@kinetographdev/core/hyperframes';
import { buildPlan } from '../src/hyperframes/plan.js';

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kg-hf-subroot-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

function mount(node: HfNode, parent: any, doc: any): void {
  if (node.t === 'text') return void parent.appendChild(doc.createTextNode(node.text));
  const el = node.svg ? doc.createElementNS('http://www.w3.org/2000/svg', node.tag) : doc.createElement(node.tag);
  for (const [name, value] of node.attrs) if (name !== 'style') el.setAttribute(name, value);
  for (const child of node.children) mount(child, el, doc);
  parent.appendChild(el);
}

const index = `<!doctype html><html><body>
  <div id="root" data-composition-id="main" data-start="0" data-duration="2" data-width="640" data-height="360">
    <div id="host" data-composition-id="sub" data-composition-src="compositions/sub.html" data-start="0" data-duration="2"></div>
  </div></body></html>`;
const sub = `<template>
  <div id="sub-root" data-composition-id="sub" data-width="640" data-height="360"><div id="mark" class="m"></div><svg><use href="#sub-root"></use></svg></div>
  <script>
    const root = document.getElementById('sub-root');
    window.seen = {
      root: root && root.getAttribute('data-composition-id'),
      byQuery: document.querySelector('#sub-root > .m') !== null,
      byAttr: document.querySelectorAll('use[href="#sub-root"]').length,
      byGsap: gsap.utils.selector(root)('#sub-root').length,
    };
  </script></template>`;

describe('a sub-composition root found by the id its file gave it', () => {
  it('is the host, for getElementById, #id selectors and gsap.utils.selector', async () => {
    const dir = project({ 'index.html': index, 'compositions/sub.html': sub });
    const { plan } = await buildPlan(join(dir, 'index.html'), { probeDuration: () => 2 });
    const doc: any = (globalThis as any).document;
    const top = doc.createElement('div');
    doc.body.appendChild(top);
    for (const node of plan.body) mount(node, top, doc);
    const script = plan.scripts.find((s) => s.scope === 'sub')!;
    const win: Record<string, unknown> = {};
    const base = { utils: { selector: () => undefined, toArray: (v: unknown) => v } };
    const env: ScopeEnv = {
      document: doc,
      window: win,
      gsap: () => base,
      root: () => doc.querySelector('[data-composition-id="sub"]'),
      hyperframes: {},
    };
    const failures: string[] = [];
    runScopedScript(script.code, script.file, env, (m) => failures.push(m));
    expect(failures).toEqual([]);
    expect(win.seen).toEqual({ root: 'sub', byQuery: true, byAttr: 1, byGsap: 1 });
  });
});
