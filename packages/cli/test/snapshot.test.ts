import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng, diffPng } from '../src/png.js';
import { compareSnapshot, snapshotPath } from '../src/commands/snapshot.js';
import type { Source } from '../src/source.js';
import { encodePng, solidPng } from './helpers.js';

describe('decodePng', () => {
  it('reads back what was written', () => {
    const data = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 40]);
    const decoded = decodePng(encodePng(2, 2, data));
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect(Array.from(decoded.data)).toEqual(Array.from(data));
  });

  it('undoes the Sub, Up, Average and Paeth filters', async () => {
    const { deflateSync, crc32 } = await import('node:zlib');
    // A 3x4 grey image with each row using a different filter.
    const grey = [
      [10, 20, 30],
      [40, 50, 60],
      [70, 80, 90],
      [100, 110, 120],
    ];
    const raw: number[] = [];
    const previous = (y: number, x: number): number => (y > 0 ? grey[y - 1]![x]! : 0);
    for (let y = 0; y < 4; y++) {
      raw.push(y + 1); // filters 1..4
      for (let x = 0; x < 3; x++) {
        const left = x > 0 ? grey[y]![x - 1]! : 0;
        const up = previous(y, x);
        const upLeft = x > 0 ? previous(y, x - 1) : 0;
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        const predicted = [left, up, (left + up) >> 1, paeth][y]!;
        raw.push((grey[y]![x]! - predicted) & 255);
      }
    }
    const chunk = (type: string, body: Buffer): Buffer => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(body.length, 0);
      head.write(type, 4, 'latin1');
      const tail = Buffer.alloc(4);
      tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
      return Buffer.concat([head, body, tail]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(3, 0);
    ihdr.writeUInt32BE(4, 4);
    ihdr[8] = 8; // 8-bit
    ihdr[9] = 0; // grey
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.from(raw))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    const decoded = decodePng(png);
    expect(Array.from(decoded.data).filter((_, i) => i % 4 === 0)).toEqual(grey.flat());
    expect(decoded.data[3]).toBe(255);
  });

  it('refuses what is not a PNG', () => {
    expect(() => decodePng(Buffer.from('nope'))).toThrow(/not a PNG/);
  });
});

describe('diffPng', () => {
  it('reports the largest channel difference and the pixels beyond the tolerance', () => {
    const a = decodePng(solidPng(2, 1, [100, 100, 100, 255]));
    const b = decodePng(encodePng(2, 1, Uint8Array.from([101, 100, 100, 255, 110, 100, 100, 255])));
    expect(diffPng(a, b, 2)).toEqual({ sameSize: true, maxDiff: 10, differingPixels: 1 });
    expect(diffPng(a, decodePng(solidPng(3, 1, [0, 0, 0, 0])), 2).sameSize).toBe(false);
  });
});

describe('compareSnapshot', () => {
  const dir = () => join(mkdtempSync(join(tmpdir(), 'kinetograph-snap-')), '__snapshots__', 's.f0.png');

  it('reports a missing snapshot and writes the render beside it, then approves it with update', () => {
    const file = dir();
    const png = solidPng(4, 4, [10, 20, 30, 255]);
    const missing = compareSnapshot(png, 0, file, false);
    expect(missing.status).toBe('missing');
    expect(existsSync(missing.actual!)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(compareSnapshot(png, 0, file, true).status).toBe('created');
    expect(compareSnapshot(png, 0, file, false).status).toBe('match');
  });

  it('accepts a difference of 2 in a channel and refuses 3', () => {
    const file = dir();
    compareSnapshot(solidPng(4, 4, [100, 100, 100, 255]), 0, file, true);
    expect(compareSnapshot(solidPng(4, 4, [102, 98, 100, 255]), 0, file, false)).toMatchObject({ status: 'match', maxDiff: 2 });
    const bad = compareSnapshot(solidPng(4, 4, [103, 100, 100, 255]), 0, file, false);
    expect(bad).toMatchObject({ status: 'mismatch', maxDiff: 3, differingPixels: 16 });
    expect(existsSync(bad.actual!)).toBe(true);
    // The approved file is untouched; update replaces it and clears the actual.
    expect(Array.from(decodePng(readFileSync(file)).data.subarray(0, 4))).toEqual([100, 100, 100, 255]);
    expect(compareSnapshot(solidPng(4, 4, [103, 100, 100, 255]), 0, file, true).status).toBe('updated');
    expect(existsSync(bad.actual!)).toBe(false);
  });

  it('is a mismatch when the size differs', () => {
    const file = dir();
    compareSnapshot(solidPng(4, 4, [1, 2, 3, 255]), 0, file, true);
    expect(compareSnapshot(solidPng(5, 4, [1, 2, 3, 255]), 0, file, false).status).toBe('mismatch');
  });

  it('puts snapshots next to the entry, per composition for a project', () => {
    const project = { kind: 'project', entry: '/p/src/index.tsx', composition: { id: 'Main' } } as unknown as Source;
    const scene = { kind: 'scene', entry: '/p/scene.json', composition: { id: 'scene' } } as unknown as Source;
    expect(snapshotPath(project, 30)).toBe('/p/src/__snapshots__/index.Main.f30.png');
    expect(snapshotPath(scene, 0)).toBe('/p/__snapshots__/scene.f0.png');
  });
});
