// HyperFrames' audio effects through the built CLI: `data-fx-chain` on an element, its `fx.*` lanes, an
// `<hf-audio-group>` bus and the master bus on the root change what `audio analyze` measures. Needs `npm run build`
// and the built addon (the project is opened through it); no GPU.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000 });

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');
const addon = (() => {
  try {
    createRequire(import.meta.url)('@kinetographdev/native');
    return true;
  } catch {
    return false;
  }
})();
const ready = addon && existsSync(join(here, '..', 'dist', 'hyperframes', 'entry.js'));

/** One second of a 440 Hz sine at -6 dBFS, mono 16-bit 48 kHz. */
function tone(): Buffer {
  const n = 48000;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(48000, 24);
  h.writeUInt32LE(96000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const attr = (value: object): string => JSON.stringify(value).replace(/"/g, '&quot;');
const gain = (db: number, id = 'n1') => ({ version: 1, nodes: [{ type: 'gain', id, params: { gain: db } }] });

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kg-hf-audio-fx-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The project with `body` in its root (which carries `root` attributes), measured by `audio analyze`. */
function measure(name: string, body: string, root = ''): { integratedLufs: number; truePeakDb: number } {
  const project = join(dir, name);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'tone.wav'), tone());
  writeFileSync(
    join(project, 'index.html'),
    `<!doctype html><html><body><div id="root" data-composition-id="main" data-width="64" data-height="64" data-start="0" data-duration="1" ${root}>${body}</div></body></html>`,
  );
  const run = spawnSync(process.execPath, [cli, 'audio', 'analyze', project, '--json'], { encoding: 'utf8' });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout).data ?? JSON.parse(run.stdout);
}

describe.skipIf(!ready)('HyperFrames audio effects', () => {
  it('plays an element, a group and the whole mix through their chains', () => {
    const plain = measure('plain', '<audio id="a" src="tone.wav" data-start="0" data-duration="1"></audio>');
    const own = measure('own', `<audio id="a" src="tone.wav" data-start="0" data-duration="1" data-fx-chain="${attr(gain(-12))}"></audio>`);
    expect(own.integratedLufs - plain.integratedLufs).toBeCloseTo(-12, 0);
    // A lane holds the knob at -20 dB for the whole clip.
    const lane = measure(
      'lane',
      `<audio id="a" src="tone.wav" data-start="0" data-duration="1" data-fx-chain="${attr(gain(0))}"
        data-automation="${attr({ version: 1, lanes: [{ target: 'fx.n1.gain', points: [{ t: 0, v: -20 }] }] })}"></audio>`,
    );
    expect(lane.integratedLufs - plain.integratedLufs).toBeCloseTo(-20, 0);
    const group = measure(
      'group',
      `<hf-audio-group id="g" data-volume="0.5" data-fx-chain="${attr(gain(-6))}"></hf-audio-group>
       <audio id="a" src="tone.wav" data-start="0" data-duration="1" data-audio-group="g"></audio>`,
    );
    expect(group.integratedLufs - plain.integratedLufs).toBeCloseTo(-12, 0);
    const master = measure('master', '<audio id="a" src="tone.wav" data-start="0" data-duration="1"></audio>', `data-fx-chain="${attr(gain(-3))}"`);
    expect(master.integratedLufs - plain.integratedLufs).toBeCloseTo(-3, 0);
  });
});
