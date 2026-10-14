import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createSceneRoot, Layer, Rect, Text, useTimeline, type SceneRoot } from '../src/index.js';
import { at, timeline } from './harness.js';

let root: SceneRoot | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
});
const open = () => (root = createSceneRoot());

const textOf = (tree: { layers: { type: string }[] }, index = 0) => (tree.layers[index] as { text?: string }).text;
const T = ({ children }: { children: string | number }) => (
  <Text id="t" font="Inter" size={10}>
    {children}
  </Text>
);

describe('SceneRoot', () => {
  it('renders synchronously and returns the tree', () => {
    const tree = open().render(at(<Rect id="a" width={1} height={1} />));
    expect(tree.layers).toHaveLength(1);
  });

  it('keeps one tree across frames: a re-render updates props in place', () => {
    const r = open();
    const Box = () => <Rect id="box" width={10} height={10} x={useTimeline().frame * 2} />;
    expect(r.render(at(<Box />, 0)).layers[0]).toMatchObject({ transform: { x: 0 } });
    expect(r.render(at(<Box />, 10)).layers[0]).toMatchObject({ transform: { x: 20 } });
    expect(r.render(at(<Box />, 20)).layers[0]).toMatchObject({ transform: { x: 40 } });
  });

  it('keeps component state between renders, as a tab keeps its page', () => {
    const r = open();
    function Counter() {
      const [n] = useState(() => Math.round(Math.PI * 100));
      const ref = useRef(0);
      ref.current += 1;
      return <T>{`${n}:${ref.current}`}</T>;
    }
    expect(textOf(r.render(at(<Counter />, 0)))).toBe('314:1');
    expect(textOf(r.render(at(<Counter />, 1)))).toBe('314:2');
  });

  it('adds and removes layers as the element changes', () => {
    const r = open();
    expect(r.render(at(<Layer id="g"><Rect id="a" width={1} height={1} /></Layer>)).layers[0]).toMatchObject({ children: [{ id: 'a' }] });
    expect(r.render(at(<Layer id="g" />)).layers[0]).toMatchObject({ children: [] });
    expect(r.render(null).layers).toEqual([]);
    expect(r.render(at(<Rect id="back" width={1} height={1} />)).layers.map((l) => l.id)).toEqual(['back']);
  });

  it('updates text when its children change', () => {
    const r = open();
    expect(textOf(r.render(at(<T>one</T>)))).toBe('one');
    expect(textOf(r.render(at(<T>two</T>)))).toBe('two');
    expect(textOf(r.render(at(<T>{3}</T>)))).toBe('3');
  });

  it('returns a fresh tree each time, so callers may keep or change it', () => {
    const r = open();
    const a = r.render(at(<Rect id="a" width={1} height={1} />));
    const b = r.snapshot();
    expect(b).toEqual(a);
    expect(b).not.toBe(a);
    expect(b.layers[0]).not.toBe(a.layers[0]);
  });
});

describe('effects and state updates', () => {
  it('runs effects before render() returns, and shows the state they set', () => {
    const r = open();
    function Loaded() {
      const [text, setText] = useState('loading');
      useEffect(() => {
        setText('ready');
      }, []);
      return <T>{text}</T>;
    }
    expect(textOf(r.render(at(<Loaded />)))).toBe('ready');
  });

  it('runs layout effects and chains of effects too', () => {
    const r = open();
    function Chain() {
      const [n, setN] = useState(0);
      useLayoutEffect(() => {
        if (n < 3) setN(n + 1);
      }, [n]);
      useEffect(() => {
        if (n === 3) setN(10);
      }, [n]);
      return <T>{n}</T>;
    }
    expect(textOf(r.render(at(<Chain />)))).toBe('10');
  });

  it('shows an update made outside React through snapshot()', () => {
    const r = open();
    let set: (value: string) => void = () => {};
    function Live() {
      const [value, setValue] = useState('before');
      set = setValue;
      return <T>{value}</T>;
    }
    expect(textOf(r.render(at(<Live />)))).toBe('before');
    set('after');
    expect(textOf(r.snapshot())).toBe('after');
  });

  it('shows data that arrives later, as a delayRender would let it (a promise settling)', async () => {
    const r = open();
    function Fetching() {
      const [data, setData] = useState<string | null>(null);
      useEffect(() => {
        let alive = true;
        new Promise<string>((resolve) => setTimeout(() => resolve('fetched'), 5)).then((value) => {
          if (alive) setData(value);
        });
        return () => {
          alive = false;
        };
      }, []);
      return <T>{data ?? 'waiting'}</T>;
    }
    expect(textOf(r.render(at(<Fetching />)))).toBe('waiting');
    expect(textOf(r.snapshot())).toBe('waiting');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(textOf(r.snapshot())).toBe('fetched');
  });

  it('keeps the data that arrived when the next frame renders', async () => {
    const r = open();
    function Fetching() {
      const [data, setData] = useState('waiting');
      useEffect(() => {
        queueMicrotask(() => setData('fetched'));
      }, []);
      return (
        <Text id="t" font="Inter" size={10} x={useTimeline().frame}>
          {data}
        </Text>
      );
    }
    r.render(at(<Fetching />, 0));
    await Promise.resolve();
    const next = r.render(at(<Fetching />, 1));
    expect(next.layers[0]).toMatchObject({ text: 'fetched', transform: { x: 1 } });
  });

  it('reports an effect that never stops updating state, instead of hanging', () => {
    const r = open();
    function Loop() {
      const [n, setN] = useState(0);
      useEffect(() => {
        setN(n + 1);
      });
      return <T>{n}</T>;
    }
    // React stops such a loop itself (Maximum update depth); either way render() throws rather than spins.
    expect(() => r.render(at(<Loop />))).toThrow();
  });

  it('memoises across renders like any React tree', () => {
    const r = open();
    let computed = 0;
    function Memo() {
      const value = useMemo(() => {
        computed += 1;
        return 'memo';
      }, []);
      return <T>{value}</T>;
    }
    r.render(at(<Memo />, 0));
    r.render(at(<Memo />, 1));
    expect(computed).toBe(1);
  });

  it('is a pure function of the element and the timeline: equal inputs, equal trees', () => {
    const render = () => {
      const r = createSceneRoot();
      const tree = r.render(at(<Layer id="g"><Text id="t" font="Inter" size={10}>x</Text></Layer>, timeline(12)));
      r.unmount();
      return JSON.stringify(tree);
    };
    expect(render()).toBe(render());
  });
});

describe('unmount', () => {
  it('empties the tree and refuses further use', () => {
    const r = createSceneRoot();
    r.render(at(<Rect id="a" width={1} height={1} />));
    r.unmount();
    expect(() => r.render(null)).toThrow(/unmounted/);
    expect(() => r.snapshot()).toThrow(/unmounted/);
    expect(() => r.unmount()).not.toThrow();
  });

  it('runs effect cleanups', () => {
    const r = createSceneRoot();
    let cleaned = false;
    function WithCleanup() {
      useEffect(() => () => {
        cleaned = true;
      }, []);
      return null;
    }
    r.render(at(<WithCleanup />));
    r.unmount();
    expect(cleaned).toBe(true);
  });
});
