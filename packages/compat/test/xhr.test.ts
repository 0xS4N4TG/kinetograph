import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setDomEnvironment } from '../src/environment.js';
import { installDomGlobals, setRefusedFetchHandler } from '../src/shim/index.js';

installDomGlobals();
const dir = mkdtempSync(join(tmpdir(), 'kg-xhr-'));
setDomEnvironment({ baseDir: dir });
afterEach(() => setRefusedFetchHandler(null));

function request(url: string, type: XMLHttpRequestResponseType = ''): Promise<{ xhr: XMLHttpRequest; events: string[] }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const events: string[] = [];
    xhr.responseType = type;
    xhr.onreadystatechange = () => events.push(`state${xhr.readyState}`);
    xhr.onload = () => events.push('load');
    xhr.onerror = () => events.push('error');
    xhr.onloadend = () => {
      events.push('loadend');
      resolve({ xhr, events });
    };
    xhr.open('GET', url);
    xhr.send();
  });
}

describe('XMLHttpRequest', () => {
  it('reads a project file through fetch, as text, json and arraybuffer', async () => {
    writeFileSync(join(dir, 'a.json'), '{"n":3}');
    const text = await request('a.json');
    expect(text.xhr.status).toBe(200);
    expect(text.xhr.responseText).toBe('{"n":3}');
    expect(text.xhr.getResponseHeader('content-type')).toBe('application/json');
    expect(text.events).toEqual(['state1', 'state2', 'state3', 'state4', 'load', 'loadend']);
    expect((await request('a.json', 'json')).xhr.response).toEqual({ n: 3 });
    expect(((await request('a.json', 'arraybuffer')).xhr.response as ArrayBuffer).byteLength).toBe(7);
  });

  it('fails as fetch fails: a missing file, a remote URL fetch refuses (and tells the handler)', async () => {
    expect((await request('nope.json')).events).toContain('error');
    const refused: string[] = [];
    setRefusedFetchHandler((u) => refused.push(u));
    const remote = await request('https://example.com/tile.pbf');
    expect(remote.events).toContain('error');
    expect(refused).toEqual(['https://example.com/tile.pbf']);
  });

  it('refuses a synchronous request', () => {
    expect(() => new XMLHttpRequest().open('GET', 'a.json', false)).toThrow(/Synchronous/);
  });
});
