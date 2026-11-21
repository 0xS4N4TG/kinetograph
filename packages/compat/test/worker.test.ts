import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setDomEnvironment } from '../src/environment.js';
import { cloneMessage, installDomGlobals, resetWorkers, setWorkerHold, setWorkerModuleLoader, whenWorkersIdle } from '../src/shim/index.js';

installDomGlobals();
const dir = mkdtempSync(join(tmpdir(), 'kg-worker-'));
setDomEnvironment({ baseDir: dir });

afterEach(() => {
  resetWorkers();
  setWorkerHold(null);
  setWorkerModuleLoader(null);
});

/** The messages `worker` posts back, after `send` has run, once the queue is idle. */
async function collect(worker: Worker, send: () => void = () => {}): Promise<unknown[]> {
  const got: unknown[] = [];
  worker.onmessage = (event) => got.push(event.data);
  send();
  await whenWorkersIdle();
  return got;
}

const ECHO = 'onmessage = (e) => postMessage({ twice: e.data * 2 });';

describe('Worker sources', () => {
  it('runs a classic script from a project file', async () => {
    writeFileSync(join(dir, 'echo.js'), ECHO);
    const worker = new Worker('echo.js');
    expect(await collect(worker, () => worker.postMessage(21))).toEqual([{ twice: 42 }]);
  });

  it('runs a script from a blob: URL and from a data: URL', async () => {
    const blob = new Worker(URL.createObjectURL(new Blob([ECHO], { type: 'text/javascript' })));
    expect(await collect(blob, () => blob.postMessage(2))).toEqual([{ twice: 4 }]);
    const data = new Worker(`data:text/javascript,${encodeURIComponent(ECHO)}`);
    expect(await collect(data, () => data.postMessage(3))).toEqual([{ twice: 6 }]);
  });

  it('runs a module worker; one with imports needs the bundler the host sets', async () => {
    writeFileSync(join(dir, 'plain-module.js'), 'self.addEventListener("message", (e) => self.postMessage(e.data + "!"));');
    const plain = new Worker('plain-module.js', { type: 'module' });
    expect(await collect(plain, () => plain.postMessage('hi'))).toEqual(['hi!']);

    writeFileSync(join(dir, 'imports.js'), 'import { x } from "./x.js"; self.postMessage(x);');
    const failures: string[] = [];
    const without = new Worker('imports.js', { type: 'module' });
    without.onerror = (event) => failures.push(event.message);
    await collect(without);
    expect(failures[0]).toMatch(/no bundler/);

    // A minified module ends with `export{a as default}`, no space after `export`.
    writeFileSync(join(dir, 'minified.js'), 'self.postMessage(1);export{self as default};');
    const minified = new Worker('minified.js', { type: 'module' });
    const refused: string[] = [];
    minified.onerror = (event) => refused.push(event.message);
    await collect(minified);
    expect(refused[0]).toMatch(/no bundler/);

    setWorkerModuleLoader((_file, code) => code.replace(/^import.*?;/, 'const x = 7;'));
    const bundled = new Worker('imports.js', { type: 'module' });
    expect(await collect(bundled)).toEqual([7]);
  });

  it('reports a script that cannot be read as an error event on the Worker', async () => {
    const worker = new Worker('missing.js');
    const failures: string[] = [];
    worker.onerror = (event) => failures.push(event.message);
    await collect(worker);
    expect(failures[0]).toMatch(/no such file in the project/);
  });
});

describe('the worker scope', () => {
  it('is a global scope of its own, not the page', async () => {
    const source = `
      postMessage({
        window: typeof window, document: typeof document, self: self === globalThis, scope: self instanceof WorkerGlobalScope,
        cores: navigator.hardwareConcurrency, href: location.href.slice(0, 5), importScripts: typeof importScripts,
      });
    `;
    const worker = new Worker(URL.createObjectURL(new Blob([source])));
    const [seen] = await collect(worker);
    expect(seen).toEqual({ window: 'undefined', document: 'undefined', self: true, scope: true, cores: 4, href: 'blob:', importScripts: 'function' });
    expect((globalThis as { window?: unknown }).window).toBeDefined();
  });

  it('makes a top-level function or var a property of the scope, as a browser does', async () => {
    const declared = new Worker(URL.createObjectURL(new Blob(['function onmessage(e) { postMessage(e.data * 2); }'])));
    expect(await collect(declared, () => declared.postMessage(21))).toEqual([42]);
    const shared = new Worker(URL.createObjectURL(new Blob(['var k = 2; self.onmessage = (e) => postMessage([e.data * self.k, globalThis.k, typeof k]);'])));
    expect(await collect(shared, () => shared.postMessage(21))).toEqual([[42, 2, 'number']]);
  });

  it('gives the page its values as the page\'s own types, and keeps the page\'s timers, URL and console', async () => {
    const source = `
      const buffer = new Uint8Array([1, 2, 3]).buffer;
      postMessage({ date: new Date(5), map: new Map([[1, 2]]), floats: new Float32Array([1.5]), list: [1, [2]], buffer, error: new RangeError('bad') }, [buffer]);
      setTimeout(() => postMessage(['timer', typeof URL, typeof console.log, typeof TextEncoder]), 0);
    `;
    const worker = new Worker(URL.createObjectURL(new Blob([source])));
    const got = await collect(worker);
    // The timer is the page's, so it is not part of what the idle wait covers.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const [first, second] = got;
    expect(first).toMatchObject({ date: new Date(5), map: new Map([[1, 2]]), floats: new Float32Array([1.5]), list: [1, [2]] });
    const message = first as { date: unknown; map: unknown; floats: unknown; buffer: ArrayBuffer; error: unknown };
    expect(message.date).toBeInstanceOf(Date);
    expect(message.map).toBeInstanceOf(Map);
    expect(message.floats).toBeInstanceOf(Float32Array);
    expect(message.buffer).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(message.buffer)]).toEqual([1, 2, 3]);
    expect(message.error).toBeInstanceOf(RangeError);
    expect(second).toEqual(['timer', 'function', 'function', 'function']);
  });

  it('looks like a browser worker to a script that asks where it runs: no Node globals, and a global object that holds the language', async () => {
    writeFileSync(join(dir, 'where.js'), 'postMessage({ node: typeof process, load: typeof require, buffer: typeof Buffer, math: globalThis.Math === Math, self: self === globalThis });');
    const worker = new Worker('where.js');
    expect(await collect(worker)).toEqual([{ node: 'undefined', load: 'undefined', buffer: 'undefined', math: true, self: true }]);
  });

  it('importScripts runs a project file in the same scope', async () => {
    writeFileSync(join(dir, 'lib.js'), 'self.answer = 41;');
    const worker = new Worker(URL.createObjectURL(new Blob(['importScripts("lib.js"); postMessage(self.answer + 1);'])));
    expect(await collect(worker)).toEqual([42]);
  });

  it('close() and terminate() stop the delivery of messages', async () => {
    const closing = new Worker(URL.createObjectURL(new Blob(['onmessage = (e) => { postMessage(e.data); close(); };'])));
    expect(await collect(closing, () => { closing.postMessage(1); closing.postMessage(2); })).toEqual([1]);
    const terminated = new Worker(URL.createObjectURL(new Blob([ECHO])));
    expect(await collect(terminated, () => { terminated.postMessage(1); terminated.terminate(); })).toEqual([]);
  });

  it('a handler that throws is an error event on the Worker', async () => {
    const worker = new Worker(URL.createObjectURL(new Blob(['onmessage = () => { throw new Error("boom"); };'])));
    const failures: string[] = [];
    worker.onerror = (event) => failures.push(event.message);
    await collect(worker, () => worker.postMessage(0));
    expect(failures).toEqual(['boom']);
  });

  it('reads a project file with fetch, and the idle wait covers the reply', async () => {
    writeFileSync(join(dir, 'data.json'), '{"n":5}');
    const source = 'onmessage = async () => { const r = await fetch("data.json"); postMessage((await r.json()).n); };';
    const worker = new Worker(URL.createObjectURL(new Blob([source])));
    expect(await collect(worker, () => worker.postMessage(0))).toEqual([5]);
  });
});

describe('messages', () => {
  it('are delivered after the current task, never synchronously', async () => {
    const worker = new Worker(URL.createObjectURL(new Blob([ECHO])));
    const order: string[] = [];
    worker.onmessage = () => order.push('reply');
    worker.postMessage(1);
    order.push('posted');
    await whenWorkersIdle();
    expect(order).toEqual(['posted', 'reply']);
  });

  it('arrive in the order they were sent, across workers', async () => {
    const make = (tag: string) => new Worker(URL.createObjectURL(new Blob([`onmessage = (e) => postMessage("${tag}" + e.data);`])));
    const a = make('a');
    const b = make('b');
    const order: unknown[] = [];
    a.onmessage = b.onmessage = (event) => order.push(event.data);
    for (let i = 0; i < 3; i++) {
      b.postMessage(i);
      a.postMessage(i);
    }
    await whenWorkersIdle();
    expect(order).toEqual(['b0', 'a0', 'b1', 'a1', 'b2', 'a2']);
  });

  it('are cloned: nothing is shared, a transferred ArrayBuffer is detached, a function cannot be sent', async () => {
    const worker = new Worker(URL.createObjectURL(new Blob(['onmessage = (e) => { e.data.obj.x = 9; postMessage(e.data.bytes.byteLength); };'])));
    const obj = { x: 1 };
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(await collect(worker, () => worker.postMessage({ obj, bytes }, [bytes.buffer]))).toEqual([4]);
    expect(obj.x).toBe(1);
    expect(bytes.byteLength).toBe(0);
    expect(() => worker.postMessage({ f() {} })).toThrow(/could not be cloned/);
    const shared = new Uint8Array([1, 2]);
    const { value } = cloneMessage({ shared, again: shared, map: new Map([[1, new Set([2])]]), date: new Date(5) });
    const copy = value as { shared: Uint8Array; again: Uint8Array; map: Map<number, Set<number>>; date: Date };
    expect(copy.shared).not.toBe(shared);
    expect(copy.again).toBe(copy.shared);
    expect([...copy.map.get(1)!]).toEqual([2]);
    expect(copy.date.getTime()).toBe(5);
  });

  it('pass a MessagePort to the worker, which answers on it', async () => {
    const worker = new Worker(URL.createObjectURL(new Blob(['onmessage = (e) => { const port = e.ports[0]; port.onmessage = (m) => port.postMessage(m.data + 1); };'])));
    const { port1, port2 } = new MessageChannel();
    const got: unknown[] = [];
    port1.onmessage = (event) => got.push(event.data);
    worker.postMessage('here', [port2]);
    port1.postMessage(1);
    await whenWorkersIdle();
    expect(got).toEqual([2]);
    expect(() => worker.postMessage('x', [{}] as never)).toThrow(/not transferable/);
  });
});

describe('the frame hold', () => {
  it('is open from the first queued message until none is left', async () => {
    const events: string[] = [];
    setWorkerHold(() => {
      events.push('hold');
      return () => events.push('release');
    });
    const worker = new Worker(URL.createObjectURL(new Blob([ECHO])));
    worker.onmessage = () => events.push('message');
    worker.postMessage(1);
    expect(events).toEqual(['hold']);
    await whenWorkersIdle();
    expect(events).toEqual(['hold', 'message', 'release']);
  });
});

describe('navigator.hardwareConcurrency', () => {
  it('is 4 whatever the machine has', () => {
    expect(navigator.hardwareConcurrency).toBe(4);
  });
});
