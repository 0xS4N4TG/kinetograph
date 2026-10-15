import { crc32, deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

/**
 * An 8-bit RGBA PNG of straight-alpha pixels, `width * height * 4` bytes. Rows are unfiltered and deflated quickly:
 * the Chrome fallback uses it for pictures that are looked at or decoded again at once, so speed counts more than size.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4;
  if (rgba.length !== stride * height) {
    throw new RangeError(`a ${width}x${height} picture is ${stride * height} bytes of RGBA, got ${rgba.length}`);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    rows[at] = 0;
    rows.set(rgba.subarray(y * stride, (y + 1) * stride), at + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
