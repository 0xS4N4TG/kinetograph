// Reads back the 8-bit RGBA PNGs the Skia addon writes (non-interlaced, any filter), for pixel checks.

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

export interface Picture {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export function readPng(file: string): Picture {
  const png = readFileSync(file);
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('only 8-bit RGBA, non-interlaced PNGs are read');
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i += 1) {
      const x = raw[y * (stride + 1) + 1 + i]!;
      const left = i >= 4 ? rgba[y * stride + i - 4]! : 0;
      const up = y > 0 ? rgba[(y - 1) * stride + i]! : 0;
      const upLeft = y > 0 && i >= 4 ? rgba[(y - 1) * stride + i - 4]! : 0;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter]!;
      rgba[y * stride + i] = (x + predicted) & 255;
    }
  }
  return { width, height, rgba };
}

export const pixel = (picture: Picture, x: number, y: number): [number, number, number, number] => {
  const at = (y * picture.width + x) * 4;
  return [picture.rgba[at]!, picture.rgba[at + 1]!, picture.rgba[at + 2]!, picture.rgba[at + 3]!];
};
