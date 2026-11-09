// Island edits (packages/cli/skills/kinetograph/references/ENGINE.md §2): after a script writes to the tree it reads,
// the addon is sent what changed instead of the whole request. The stand-in addon keeps the state it was sent and makes
// the edits to it; every state it reads must be the request a whole build gives (an addon without edits is sent those).

import { useLayoutEffect, useRef } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { beginSamplePass, breakSamplePasses, endSamplePass, resetStylesheets, setDomAddon } from '@kinetographdev/compat/dom';
import { installDomGlobals, resetObservers } from '@kinetographdev/compat/shim';
import { createSceneRoot } from '../src/index.js';
import { at } from './harness.js';

beforeAll(() => installDomGlobals());
afterEach(() => {
  setDomAddon(null);
  resetObservers();
  resetStylesheets();
});

/** `NodeEdit` made to a request's tree (`patch` of crates/dom/src/document.rs). */
function applyEdits(request: any, edits: any): any {
  const next = structuredClone(request);
  next.time = edits.time;
  const find = (node: any, path: string): any => {
    if (node.kind !== 'element') return null;
    if (node.path === path) return node;
    for (const child of node.children) {
      const found = find(child, path);
      if (found !== null) return found;
    }
    return null;
  };
  for (const edit of edits.set) {
    const node = find(next.root, edit.path);
    if (node === null) throw new Error(`no element at ${edit.path}`);
    if (edit.attrs !== undefined) node.attrs = edit.attrs;
    if (edit.style !== undefined) node.style = edit.style;
    for (const [i, text] of edit.texts ?? []) {
      if (node.children[i]?.kind !== 'text') throw new Error(`no text at ${i} of ${edit.path}`);
      node.children[i] = { kind: 'text', text };
    }
  }
  return next;
}

interface Seen {
  /** The state each read was answered from. */
  states: string[];
  /** What each call was sent as: a whole request, or edits. */
  kinds: ('whole' | 'numbered' | 'edits' | 'stale')[];
}

/** A stand-in addon; with `edits`, one that takes island edits (and refuses edits to a state when `stale` says so). */
function addon(edits: boolean, stale: (n: number) => boolean = () => false): Seen {
  const seen: Seen = { states: [], kinds: [] };
  let held: { stamp: number; request: any } | null = null;
  let calls = 0;
  const read = (json: string): void => {
    calls++;
    let request: any;
    if (!json.startsWith('{"stamp":')) {
      request = JSON.parse(json);
      seen.kinds.push('whole');
    } else {
      const message = JSON.parse(json);
      if (message.request !== undefined) {
        held = { stamp: message.stamp, request: message.request };
        seen.kinds.push('numbered');
      } else if (held !== null && held.stamp === message.stamp) {
        seen.kinds.push('edits');
      } else {
        if (held === null || held.stamp !== message.base || stale(calls)) {
          held = null;
          seen.kinds.push('stale');
          throw Object.assign(new Error('not kept'), { code: 'STALE_BASE' });
        }
        held = { stamp: message.stamp, request: applyEdits(held.request, message) };
        seen.kinds.push('edits');
      }
      request = held!.request;
    }
    seen.states.push(JSON.stringify(request));
  };
  const box = { x: 0, y: 0, width: 1, height: 1, rect: { x: 0, y: 0, width: 1, height: 1 }, client: { width: 1, height: 1 }, scroll: { width: 1, height: 1 } };
  setDomAddon({
    renderDomIsland: () => JSON.stringify({ layers: [], unsupported: [], camera: null }),
    domLayoutBoxes(json: string) {
      read(json);
      return JSON.stringify({ $0: box });
    },
    domComputedStyle(json: string, _path: string, props: string[]) {
      read(json);
      return props.map(() => '');
    },
    ...(edits ? { domIslandEdits: () => 1 } : {}),
  });
  return seen;
}

/** A script that reads, writes and reads again: styles, attributes, SVG attributes, texts, then a new child. */
function Script() {
  const ref = useRef<any>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const read = () => el.getBoundingClientRect();
    read();
    el.style.width = '50px';
    el.style.transform = 'translateX(4px)';
    read();
    el.setAttribute('class', 'b');
    el.querySelector('span').style.color = 'red';
    read();
    el.removeAttribute('data-x');
    el.querySelector('rect').setAttribute('stroke-width', '3');
    read();
    el.querySelector('span').firstChild.data = 'two';
    el.childNodes[0].data = 'ONE ';
    read();
    el.style.removeProperty('width');
    read();
    read();
    // A new child changes the structure: the whole request again, then edits from it.
    el.appendChild((globalThis as any).document.createElement('i'));
    read();
    el.style.opacity = '0.5';
    read();
  }, []);
  return (
    <div ref={ref} data-x="1" style={{ width: 10, height: 10 }}>
      one <span>two</span> three
      <svg viewBox="0 0 10 10">
        <rect width={4} height={4} />
      </svg>
    </div>
  );
}

function run(node = <Script />, frame = 0) {
  const root = createSceneRoot({ viewport: { width: 400, height: 300 }, fonts: () => ({}), time: () => frame / 30 });
  root.render(at(node, frame));
  root.unmount();
}

describe('island edits', () => {
  it('read the states a whole request gives, sending what scripts changed', () => {
    const whole = addon(false);
    run();
    const edited = addon(true);
    run();
    expect(edited.states).toEqual(whole.states);
    expect(whole.kinds.every((k) => k === 'whole')).toBe(true);
    // The first read and the one after the structure changed are numbered requests; the rest edits.
    expect(edited.kinds).toEqual(['numbered', 'edits', 'edits', 'edits', 'edits', 'edits', 'numbered', 'edits']);
  });

  it('send the whole request when the addon does not hold the state the edits are made to', () => {
    const whole = addon(false);
    run();
    const edited = addon(true, (n) => n === 3);
    run();
    expect(edited.states).toEqual(whole.states);
    expect(edited.kinds.slice(0, 4)).toEqual(['numbered', 'edits', 'stale', 'numbered']);
  });

  it('are not sent with KINETOGRAPH_NO_INCREMENTAL', () => {
    process.env.KINETOGRAPH_NO_INCREMENTAL = '1';
    try {
      const edited = addon(true);
      run();
      expect(edited.kinds.every((k) => k === 'numbered')).toBe(true);
    } finally {
      delete process.env.KINETOGRAPH_NO_INCREMENTAL;
    }
  });

  it('send the whole request after a commit, and in a pass that does not follow the last', () => {
    function Probe() {
      const ref = useRef<any>(null);
      useLayoutEffect(() => {
        ref.current.style.width = '5px';
        ref.current.getBoundingClientRect();
      });
      return <div ref={ref} style={{ width: 1 }} />;
    }
    const edited = addon(true);
    const root = createSceneRoot({ viewport: { width: 400, height: 300 }, fonts: () => ({}), time: () => 0 });
    beginSamplePass();
    root.render(at(<Probe />, 0));
    endSamplePass();
    breakSamplePasses();
    beginSamplePass();
    root.render(at(<Probe />, 1));
    endSamplePass();
    root.unmount();
    expect(edited.kinds.filter((k) => k !== 'edits')).toEqual(['numbered', 'numbered']);
  });
});
