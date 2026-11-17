import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finishNetRecord, installDomGlobals, isSecretParam, looksLikeCredential, netKey, setNetFrame, setNetStore } from '../src/shim/index.js';

installDomGlobals();

const TOKEN = 'pk.FAKE-TOKEN-123';
const tile = Buffer.from([0x1a, 0x2f, 0x00, 0xff, 0x80, 0x7e, 0x01]);
const plain = Buffer.from('plain tile body '.repeat(20));

let server: Server;
let base: string;
let seen: string[];
beforeEach(async () => {
  seen = [];
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} range=${req.headers.range ?? ''}`);
    const path = new URL(req.url!, 'http://x').pathname;
    if (path.endsWith('.pbf')) {
      res.writeHead(200, { 'content-type': 'application/x-protobuf' });
      res.end(tile);
    } else if (path.endsWith('.gz')) {
      res.writeHead(200, { 'content-type': 'application/vnd.mapbox-vector-tile', 'content-encoding': 'gzip' });
      res.end(gzipSync(plain));
    } else if (path.endsWith('.pmtiles')) {
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
      if (m === null) {
        res.writeHead(200).end(plain);
        return;
      }
      const [from, to] = [Number(m[1]), Number(m[2])];
      res.writeHead(206, { 'content-range': `bytes ${from}-${to}/${plain.length}`, 'accept-ranges': 'bytes', 'content-type': 'application/octet-stream' });
      res.end(plain.subarray(from, to + 1));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  setNetStore(null);
  setNetFrame(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const dirOf = () => mkdtempSync(join(tmpdir(), 'kg-net-'));
const record = async (dir: string, run: () => Promise<void>) => {
  setNetStore({ dir, mode: 'record', allowHosts: ['127.0.0.1'] });
  await run();
  const done = finishNetRecord();
  setNetStore(null);
  return done;
};
const allText = (dir: string): string => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else out.push(readFileSync(join(d, e.name)).toString('latin1'), e.name);
    }
  };
  walk(dir);
  return out.join('\n');
};

describe('netKey', () => {
  it('removes secret parameters (default, user-named, any case) and the fragment, keeps the rest in order', () => {
    expect(netKey('get', 'https://t.example/a/1/2/3.pbf?v=2&access_token=abc&z=1#frag')).toBe('GET https://t.example/a/1/2/3.pbf?v=2&z=1');
    expect(netKey('GET', 'https://t.example/s.json?Key=abc&API_KEY=1&token=2&apikey=3')).toBe('GET https://t.example/s.json');
    expect(netKey('GET', 'https://t.example/s.json?sig=abc&k=1', null, ['sig'])).toBe('GET https://t.example/s.json?k=1');
    expect(netKey('GET', 'https://u:p@t.example/f.pmtiles', 'bytes=0-9')).toBe('GET https://t.example/f.pmtiles bytes=0-9');
  });
});

describe('what counts as a secret', () => {
  it('matches names in any case: the defaults, signed-URL families and prefixes, and a user list', () => {
    for (const name of ['access_token', 'TOKEN', 'Key', 'api-key', 'ApiKey', 'auth', 'Authorization', 'client_secret', 'secret', 'password', 'sig', 'Signature', 'sv', 'se', 'sp', 'SR', 'X-Amz-Credential', 'x-goog-signature', 'X-MS-foo']) {
      expect(isSecretParam(name), name).toBe(true);
    }
    for (const name of ['z', 'x', 'y', 'v', 'layer', 'size', 'x-other']) expect(isSecretParam(name), name).toBe(false);
    expect(isSecretParam('Sess', ['sess'])).toBe(true);
    expect(netKey('GET', 'https://t.example/a.png?X-Amz-Date=1&X-Amz-Signature=fake&sv=1&Sig=fake&w=2')).toBe('GET https://t.example/a.png?w=2');
  });

  it('flags long mixed values and long base64 or hex runs, never a coordinate or a short value', () => {
    expect(looksLikeCredential('Ab3dE6gH9jK2mN5pQ8sT1vX4yZ7')).toBe(true);
    expect(looksLikeCredential('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(looksLikeCredential('a'.repeat(40))).toBe(true);
    for (const value of ['12', '4096', '2026-11-11', 'streets-v2', 'pk.short', 'abcdefghijklmnopqrstuvwx', '1234567890123456789012345']) expect(looksLikeCredential(value), value).toBe(false);
  });
});

describe('record then replay', () => {
  it('replays a URL the page built at run time without a request reaching the server, and writes no secret anywhere', async () => {
    const dir = dirOf();
    const url = (z: number, x: number) => `${base}/tiles/${z}/${x}.pbf?access_token=${TOKEN}`;
    const done = await record(dir, async () => {
      // Built from state at run time; the page's real request carries the token.
      for (const x of [3, 1, 2]) expect(Buffer.from(await (await fetch(url(4, x))).arrayBuffer())).toEqual(tile);
    });
    expect(done.entries).toBe(3);
    expect(seen.every((s) => s.includes(TOKEN))).toBe(true);
    expect(allText(dir)).not.toContain(TOKEN);
    setNetStore({ dir, mode: 'replay', indexSha256: done.sha256 });
    seen.length = 0;
    for (const x of [2, 3, 1]) {
      const response = await fetch(url(4, x));
      expect(response.headers.get('content-type')).toBe('application/x-protobuf');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(tile);
    }
    expect(seen).toEqual([]);
    // Another token is the same request.
    expect((await fetch(`${base}/tiles/4/1.pbf?access_token=other`)).status).toBe(200);
  });

  it('a miss throws, names the URL without its secret and the frame, says how to record, and never reaches the network', async () => {
    const dir = dirOf();
    const done = await record(dir, async () => void (await fetch(`${base}/tiles/1.pbf`)));
    setNetStore({ dir, mode: 'replay', indexSha256: done.sha256, hint: (host) => `kinetograph fetch-deps main.ts --record --allow-host ${host}` });
    setNetFrame(17);
    seen.length = 0;
    const error = await fetch(`${base}/tiles/9.pbf?access_token=${TOKEN}`).then(() => null, (e: Error) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error!.message).toContain(`${base}/tiles/9.pbf`);
    expect(error!.message).not.toContain(TOKEN);
    expect(error!.message).toContain('frame 17');
    expect(error!.message).toContain('kinetograph fetch-deps main.ts --record --allow-host 127.0.0.1');
    expect(seen).toEqual([]);
  });

  it('refuses a host that is not on the record list, and a replay of an index that is not the pinned one', async () => {
    const dir = dirOf();
    setNetStore({ dir, mode: 'record', allowHosts: ['example.invalid'] });
    await expect(fetch(`${base}/tiles/1.pbf`)).rejects.toThrow(/remote URLs are not available/);
    expect(seen).toEqual([]);
    setNetStore(null);
    const done = await record(dir, async () => void 0);
    expect(() => setNetStore({ dir, mode: 'replay', indexSha256: '0'.repeat(64) })).toThrow(/does not match/);
    expect(done.entries).toBe(0);
  });

  it('keys a Range request by its bytes and replays 206 with Content-Range', async () => {
    const dir = dirOf();
    const get = (range: string) => fetch(`${base}/world.pmtiles?key=${TOKEN}`, { headers: { Range: range } });
    const done = await record(dir, async () => {
      await get('bytes=0-9');
      await get('bytes=10-19');
    });
    expect(done.entries).toBe(2);
    setNetStore({ dir, mode: 'replay', indexSha256: done.sha256 });
    const first = await get('bytes=0-9');
    expect(first.status).toBe(206);
    expect(first.headers.get('content-range')).toBe(`bytes 0-9/${plain.length}`);
    expect(Buffer.from(await first.arrayBuffer())).toEqual(plain.subarray(0, 10));
    const second = await get('bytes=10-19');
    expect(Buffer.from(await second.arrayBuffer())).toEqual(plain.subarray(10, 20));
    // A range nobody recorded, and the whole file, are misses.
    await expect(get('bytes=20-29')).rejects.toThrow(/not in the recorded network store/);
    await expect(fetch(`${base}/world.pmtiles`)).rejects.toThrow(/not in the recorded network store/);
  });

  it('round-trips binary bytes and Content-Type, and a gzip body arrives inflated with its Content-Encoding as in a browser', async () => {
    const dir = dirOf();
    const done = await record(dir, async () => {
      await fetch(`${base}/a.pbf`);
      await fetch(`${base}/b.gz`);
    });
    setNetStore({ dir, mode: 'replay', indexSha256: done.sha256 });
    const bin = await fetch(`${base}/a.pbf`);
    expect(bin.headers.get('content-type')).toBe('application/x-protobuf');
    expect(Buffer.from(await bin.arrayBuffer())).toEqual(tile);
    const gz = await fetch(`${base}/b.gz`);
    expect(gz.headers.get('content-type')).toBe('application/vnd.mapbox-vector-tile');
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(gz.headers.get('content-length')).toBeNull();
    expect(Buffer.from(await gz.arrayBuffer())).toEqual(plain);
  });

  it('answers two workers from one store the same, whatever order they ask in', async () => {
    const dir = dirOf();
    const urls = [1, 2, 3, 4].map((x) => `${base}/t/${x}.pbf?access_token=${TOKEN}`);
    const done = await record(dir, async () => {
      await Promise.all(urls.map((u) => fetch(u)));
      await Promise.all(urls.map((u) => fetch(u)));
    });
    expect(done.entries).toBe(4);
    expect(seen.length).toBe(4);
    const module = pathToFileURL(join(import.meta.dirname, '../dist/shim/net-store.js')).href;
    const code = `
      const { parentPort, workerData } = require('node:worker_threads');
      import(${JSON.stringify(module)}).then(async (m) => {
        m.setNetStore({ dir: workerData.dir, mode: 'replay', indexSha256: workerData.sha });
        const real = async () => { throw new Error('network'); };
        const out = [];
        for (const url of workerData.urls) {
          const r = await m.netFetch(real, url, undefined, url, 'GET');
          out.push(Buffer.from(await r.arrayBuffer()).toString('hex'));
        }
        parentPort.postMessage(out);
      });`;
    const run = (list: string[]) =>
      new Promise<string[]>((resolve, reject) => {
        const w = new Worker(code, { eval: true, workerData: { dir, sha: done.sha256, urls: list } });
        w.once('message', resolve);
        w.once('error', reject);
      });
    const [a, b] = await Promise.all([run(urls), run([...urls].reverse())]);
    expect(a).toEqual(urls.map(() => tile.toString('hex')));
    expect(b).toEqual(a);
  });

  describe('redirects in a record pass', () => {
    let other: Server;
    let otherBase: string;
    let otherSeen: { url: string; authorization: string | undefined }[];
    let bounce: string;
    beforeEach(async () => {
      otherSeen = [];
      other = createServer((req, res) => {
        otherSeen.push({ url: req.url!, authorization: req.headers.authorization });
        res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end(tile);
      });
      await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
      otherBase = `http://localhost:${(other.address() as AddressInfo).port}`;
      bounce = otherBase;
      // The page's server redirects by path: /to-other goes to the second host, /loop to itself.
      server.removeAllListeners('request');
      server.on('request', (req, res) => {
        seen.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? ''}`);
        if (req.url!.startsWith('/to-other')) res.writeHead(302, { location: `${bounce}/final.pbf?access_token=${TOKEN}&sig=abc` }).end();
        else if (req.url!.startsWith('/loop')) res.writeHead(302, { location: '/loop' }).end();
        else res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end(tile);
      });
    });
    afterEach(() => new Promise<void>((resolve) => other.close(() => resolve())));

    it('follows a redirect between allowed hosts, keys the entry by the asked URL, and replays the final answer', async () => {
      const dir = dirOf();
      setNetStore({ dir, mode: 'record', allowHosts: ['127.0.0.1', 'localhost'] });
      const asked = `${base}/to-other?access_token=${TOKEN}`;
      const response = await fetch(asked, { headers: { Authorization: 'Bearer FAKE' } });
      expect(Buffer.from(await response.arrayBuffer())).toEqual(tile);
      const done = finishNetRecord();
      setNetStore(null);
      expect(done.entries).toBe(1);
      expect(seen[0]).toContain('auth=Bearer FAKE');
      // The second host gets neither the page's token nor its Authorization header (its own `sig` is its own).
      expect(otherSeen).toEqual([{ url: '/final.pbf?sig=abc', authorization: undefined }]);
      expect(allText(dir)).not.toContain(TOKEN);
      setNetStore({ dir, mode: 'replay', indexSha256: done.sha256 });
      otherSeen.length = 0;
      expect(Buffer.from(await (await fetch(asked)).arrayBuffer())).toEqual(tile);
      expect(otherSeen).toEqual([]);
    });

    it('refuses a redirect to a host that is not allowed, names it without the secret, and stores nothing', async () => {
      const dir = dirOf();
      setNetStore({ dir, mode: 'record', allowHosts: ['127.0.0.1'] });
      const error = await fetch(`${base}/to-other?access_token=${TOKEN}`).then(() => null, (e: Error) => e);
      expect(error).toBeInstanceOf(TypeError);
      expect(error!.message).toContain('localhost');
      expect(error!.message).toContain('--allow-host localhost');
      expect(error!.message).not.toContain(TOKEN);
      expect(otherSeen).toEqual([]);
      expect(finishNetRecord().entries).toBe(0);
      setNetStore(null);
      expect(allText(dir)).not.toContain(TOKEN);
    });

    it('stops after 5 redirects', async () => {
      setNetStore({ dir: dirOf(), mode: 'record', allowHosts: ['127.0.0.1'] });
      await expect(fetch(`${base}/loop`)).rejects.toThrow(/redirected more than 5 times/);
      expect(seen.length).toBe(6);
    });
  });

  describe('credential-looking values in a record pass', () => {
    const fake = 'Ab3dE6gH9jK2mN5pQ8sT1vX4yZ7';

    it('fails the pass before the request, naming the parameter and the two ways out, never the value; tile numbers pass', async () => {
      const dir = dirOf();
      setNetStore({ dir, mode: 'record', allowHosts: ['127.0.0.1'] });
      await fetch(`${base}/tiles/4/1/2.pbf?v=2&layer=streets-v2`);
      seen.length = 0;
      const error = await fetch(`${base}/tiles/9.pbf?session=${fake}`).then(() => null, (e: Error) => e);
      expect(error!.message).toContain('"session"');
      expect(error!.message).toContain('--secret-param session');
      expect(error!.message).toContain('--keep-param session');
      expect(error!.message).not.toContain(fake);
      expect(seen).toEqual([]);
      // The page may swallow the error; the pass still fails, and writes no index.
      expect(() => finishNetRecord()).toThrow(/looks like a credential/);
      expect(readdirSync(dir).includes('index.json')).toBe(false);
    });

    it('lets a named parameter through with --keep-param, and strips one named with --secret-param', async () => {
      const dir = dirOf();
      setNetStore({ dir, mode: 'record', allowHosts: ['127.0.0.1'], keepParams: ['Session'], secretParams: ['other'] });
      await fetch(`${base}/a.pbf?session=${fake}`);
      await fetch(`${base}/b.pbf?other=${fake}`);
      const done = finishNetRecord();
      setNetStore(null);
      expect(done.entries).toBe(2);
      const text = allText(dir);
      expect(text).toContain(`a.pbf?session=${fake}`);
      expect(text).not.toContain('other=');
    });

    it('warns, without the value, about a path segment that looks like a credential, and still records it', async () => {
      const warnings: string[] = [];
      setNetStore({ dir: dirOf(), mode: 'record', allowHosts: ['127.0.0.1'], onWarn: (m) => warnings.push(m) });
      await fetch(`${base}/${fake}/tiles/4/1.pbf`);
      await fetch(`${base}/${fake}/tiles/4/2.pbf`);
      expect(finishNetRecord().entries).toBe(2);
      expect(warnings).toEqual([expect.stringContaining('127.0.0.1')]);
      expect(warnings[0]).toContain('segment 1');
      expect(warnings[0]).not.toContain(fake);
    });

    it('keeps user info out of the key and the error of a miss', () => {
      expect(netKey('GET', 'https://user:pass@t.example/a.pbf')).toBe('GET https://t.example/a.pbf');
    });
  });
});
