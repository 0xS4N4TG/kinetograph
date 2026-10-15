import { inflateSync } from 'node:zlib';

export interface Rgba {
  width: number;
  height: number;
  /** `width * height * 4` bytes, straight alpha. */
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Decodes the PNGs the engine writes: 8 bits per channel, grey, grey with alpha, RGB or RGBA, not interlaced. That is
 * all `snapshot` needs to compare two of them.
 */
export function decodePng(bytes: Uint8Array): Rgba {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file');
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  for (let pos = 8; pos + 8 <= buf.length; ) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8]!;
      colorType = body[9]!;
      if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth} (need 8)`);
      if (body[12] !== 0) throw new Error('interlaced PNGs are not supported');
      if (![0, 2, 4, 6].includes(colorType)) throw new Error(`unsupported PNG colour type ${colorType}`);
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }
  if (width === 0 || height === 0) throw new Error('PNG has no IHDR');

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]!;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error('PNG image data is truncated');

  // Undo the per-row filters.
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x]!;
      const left = x >= channels ? pixels[row + x - channels]! : 0;
      const up = y > 0 ? pixels[row - stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? pixels[row - stride + x - channels]! : 0;
      let predicted: number;
      switch (filter) {
        case 0: predicted = 0; break;
        case 1: predicted = left; break;
        case 2: predicted = up; break;
        case 3: predicted = (left + up) >> 1; break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          break;
        }
        default: throw new Error(`bad PNG filter ${filter}`);
      }
      pixels[row + x] = (value + predicted) & 0xff;
    }
  }

  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    if (channels === 1 || channels === 2) {
      data[d] = data[d + 1] = data[d + 2] = pixels[s]!;
      data[d + 3] = channels === 2 ? pixels[s + 1]! : 255;
    } else {
      data[d] = pixels[s]!;
      data[d + 1] = pixels[s + 1]!;
      data[d + 2] = pixels[s + 2]!;
      data[d + 3] = channels === 4 ? pixels[s + 3]! : 255;
    }
  }
  return { width, height, data };
}

export interface PngDiff {
  /** False if the sizes differ, in which case nothing else is meaningful. */
  sameSize: boolean;
  /** The largest difference in any one channel of any pixel, 0..255. */
  maxDiff: number;
  /** Pixels with any channel differing by more than `tolerance`. */
  differingPixels: number;
}

export function diffPng(a: Rgba, b: Rgba, tolerance: number): PngDiff {
  if (a.width !== b.width || a.height !== b.height) return { sameSize: false, maxDiff: 255, differingPixels: 0 };
  let maxDiff = 0;
  let differingPixels = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let pixelMax = 0;
    for (let c = 0; c < 4; c++) pixelMax = Math.max(pixelMax, Math.abs(a.data[i + c]! - b.data[i + c]!));
    if (pixelMax > maxDiff) maxDiff = pixelMax;
    if (pixelMax > tolerance) differingPixels++;
  }
  return { sameSize: true, maxDiff, differingPixels };
}
