// createPortal into a DOM element a ref gave (Recharts' z-index layers draw their marks that way) and into document.body.

import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
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
  });
});
afterEach(() => {
  setDomAddon(null);
  resetObservers();
  resetStylesheets();
});

const g = globalThis as any;

function mount(node: ReactNode) {
  const root = createSceneRoot({ viewport: { width: 400, height: 300 }, fonts: () => ({}), time: () => 0 });
  root.render(<TimelineContext.Provider value={timeline(0)}>{node}</TimelineContext.Provider>);
  return root;
}

describe('createPortal', () => {
  it('puts children into the element a ref gave, in order, and takes them out again', () => {
    function Layer({ show }: { show: boolean }) {
      const [target, setTarget] = useState<any>(null);
      return (
        <div id="host">
          <g id="layer" ref={setTarget} />
          {target && show ? createPortal(<><i id="a" /><b id="b" /></>, target) : null}
        </div>
      );
    }
    const root = mount(<Layer show />);
    const layer = g.document.getElementById('layer');
    expect(layer.children.length).toBe(2);
    expect([...layer.children].map((c: any) => c.id)).toEqual(['a', 'b']);
    expect(g.document.getElementById('a').parentElement).toBe(layer);
    root.update(<TimelineContext.Provider value={timeline(0)}><Layer show={false} /></TimelineContext.Provider>);
    expect(g.document.getElementById('layer').children.length).toBe(0);
    root.unmount();
  });

  it('puts children on document.body', () => {
    function Modal() {
      return createPortal(<p id="modal" />, g.document.body);
    }
    const root = mount(<Modal />);
    expect(g.document.getElementById('modal')?.parentElement).toBe(g.document.body);
    root.unmount();
    expect(g.document.getElementById('modal')).toBeNull();
  });
});
