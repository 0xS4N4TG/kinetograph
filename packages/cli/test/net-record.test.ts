// `fetch-deps --record`: every frame runs with the network open for the named hosts and the responses the page fetched (a
// URL it builds from the frame) are kept in `.kinetograph/net`; `doctor` then answers them from there with the server gone,
// and a request that was never recorded is an error that names it and the frame. A local server stands in for the web.
// Both run the built CLI (skipped without `npm run build`): the project's bundle and the CLI must share one copy of the shim,
// which they do not inside vitest. The server is in this process, so the CLI is spawned without blocking it.

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 90_000 });

const TOKEN = 'pk.FAKE-TOKEN-123';
let server: Server;
let base: string;
let requests: string[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url!);
    res.writeHead(200, { 'content-type': 'application/x-protobuf' });
    res.end(Buffer.from([1, 2, 3, 4, 5]));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const page = (tile: (frame: string) => string) => `
import { useEffect, useState } from 'react';
import { Composition, registerRoot, AbsoluteFill, cancelRender, continueRender, delayRender, useCurrentFrame } from 'remotion';

const Tile = () => {
  const frame = useCurrentFrame();
  const [handle] = useState(() => delayRender('tile'));
  useEffect(() => {
    fetch(${tile('frame')}).then((r) => r.arrayBuffer()).then(() => continueRender(handle), (e) => cancelRender(e));
  }, [frame]);
  return <AbsoluteFill style={{ background: '#000' }} />;
};
registerRoot(() => <Composition id="T" component={Tile} durationInFrames={3} fps={24} width={64} height={64} />);
`;

const here = dirname(fileURLToPath(import.meta.url));
const built = join(here, '..', 'dist', 'cli.js');

const kinetograph = (...argv: string[]) =>
  new Promise<{ status: number; text: string }>((resolve) => {
    execFile(process.execPath, [built, ...argv], { encoding: 'utf8', timeout: 80_000 }, (error, stdout, stderr) =>
      resolve({ status: error === null ? 0 : ((error as { code?: number }).code ?? 1), text: stdout + stderr }),
    );
  });

describe.skipIf(!existsSync(built))('fetch-deps --record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinetograph-net-'));
  writeFileSync(join(dir, 'package.json'), '{"name":"p","private":true}');
  const entry = join(dir, 'index.tsx');
  const missEntry = join(dir, 'miss.tsx');
  const tileUrl = (path: string) => (f: string) => `\`${base}/${path}/\${${f}}.pbf?access_token=${TOKEN}\``;

  it('needs the hosts it may reach', async () => {
    writeFileSync(entry, page(tileUrl('tile')));
    const r = await kinetograph('fetch-deps', entry, '--record');
    expect(r.status).toBe(1);
    expect(r.text).toContain('--allow-host');
  });

  it('keeps what every frame fetched, pins the index in the lock, and writes no token', async () => {
    const r = await kinetograph('fetch-deps', entry, '--record', '--allow-host', '127.0.0.1', '--json');
    expect(r.text).not.toContain('"error"');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.text).entries).toBe(3);
    expect(requests.length).toBe(3);
    expect(requests.every((u) => u.includes(TOKEN))).toBe(true);
    const lock = JSON.parse(readFileSync(join(dir, 'kinetograph.lock.json'), 'utf8'));
    expect(Object.keys(lock.files)).toEqual(['net:index']);
    const net = join(dir, '.kinetograph', 'net');
    const index = readFileSync(join(net, 'index.json'), 'utf8');
    expect(Object.keys(JSON.parse(index).entries)).toEqual([0, 1, 2].map((f) => `GET ${base}/tile/${f}.pbf`));
    expect(index + JSON.stringify(lock)).not.toContain(TOKEN);
    // Three equal bodies are one file.
    expect(readdirSync(net).filter((n) => n !== 'index.json').length).toBe(1);
  });

  it('a later step draws every frame from the store without a request', async () => {
    requests = [];
    const r = await kinetograph('doctor', entry, '--json');
    expect(r.status).toBe(0);
    expect(requests).toEqual([]);
  });

  it('a request that was never recorded fails, naming it, the frame and the command that records it', async () => {
    writeFileSync(missEntry, page(tileUrl('other')));
    requests = [];
    const r = await kinetograph('doctor', missEntry, '--json');
    expect(r.status).toBe(1);
    expect(r.text).toContain('not in the recorded network store');
    expect(r.text).toContain(`${base}/other/0.pbf`);
    expect(r.text).toContain('frame 0');
    expect(r.text).not.toContain(TOKEN);
    expect(r.text).toContain('--record --allow-host 127.0.0.1');
    expect(requests).toEqual([]);
  });
});
