// Progress Events (https://xhr.spec.whatwg.org/#interface-progressevent): `new ProgressEvent(type, init)` is a global
// of every browser; a loader that reports how much of a file it has read (three.js's FileLoader) builds one.
import { describe, expect, it } from 'vitest';
import { installDomGlobals } from '../src/shim/web.js';

describe('ProgressEvent', () => {
  it('is an Event that carries lengthComputable, loaded and total, 0 and false by default', () => {
    installDomGlobals();
    const P = (globalThis as any).ProgressEvent;
    expect(typeof P).toBe('function');
    const bare = new P('progress');
    expect(bare).toBeInstanceOf(Event);
    expect(bare.type).toBe('progress');
    expect([bare.lengthComputable, bare.loaded, bare.total]).toEqual([false, 0, 0]);
    const full = new P('progress', { lengthComputable: true, loaded: 5, total: 10 });
    expect([full.lengthComputable, full.loaded, full.total]).toEqual([true, 5, 10]);
  });
});
