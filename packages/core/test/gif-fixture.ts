// A GIF whose structure is real (header, colour table, graphic control extensions, image descriptors) and whose
// pictures are one pixel of data each: enough for code that reads a GIF's timing, not for decoding it.

/** `delaysCs` are the pictures' delays in hundredths of a second, as the file stores them. */
export function makeGif(delaysCs: number[], width = 4, height = 3): Uint8Array {
  const bytes: number[] = [...Buffer.from('GIF89a'), width & 255, width >> 8, height & 255, height >> 8, 0x80, 0, 0, 0, 0, 0, 255, 255, 255];
  for (const delay of delaysCs) {
    bytes.push(0x21, 0xf9, 4, 0, delay & 255, delay >> 8, 0, 0);
    bytes.push(0x2c, 0, 0, 0, 0, width & 255, width >> 8, height & 255, height >> 8, 0);
    bytes.push(2, 2, 0x44, 0x01, 0);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}

function u16be(n: number): number[] {
  return [(n >>> 8) & 255, n & 255];
}

function u32be(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

export function pngChunk(type: string, data: number[]): number[] {
  return [...u32be(data.length), ...Buffer.from(type), ...data, 0, 0, 0, 0];
}

/** `delays` are `[delay_num, delay_den]` pairs in seconds; `defaultImage` adds an `IDAT` not preceded by `fcTL`. */
export function makeApng(delays: Array<[number, number]>, width = 4, height = 3, defaultImage = false): Uint8Array {
  const bytes: number[] = [
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...pngChunk('IHDR', [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]),
    ...pngChunk('acTL', [...u32be(delays.length), 0, 0, 0, 0]),
  ];
  if (defaultImage) bytes.push(...pngChunk('IDAT', [0]));
  for (let i = 0; i < delays.length; i++) {
    const [num, den] = delays[i]!;
    bytes.push(
      ...pngChunk('fcTL', [...u32be(i), ...u32be(width), ...u32be(height), 0, 0, 0, 0, 0, 0, 0, 0, ...u16be(num), ...u16be(den), 0, 0]),
      ...pngChunk(i === 0 && !defaultImage ? 'IDAT' : 'fdAT', [0, 0, 0, 0]),
    );
  }
  bytes.push(...pngChunk('IEND', []));
  return Uint8Array.from(bytes);
}

function u24le(n: number): number[] {
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
}

function u32le(n: number): number[] {
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
}

function riffChunk(fourcc: string, data: number[]): number[] {
  return [...Buffer.from(fourcc), ...u32le(data.length), ...data, ...(data.length & 1 ? [0] : [])];
}

/** `delaysMs` are the `ANMF` frame durations in milliseconds. */
export function makeWebp(delaysMs: number[], width = 4, height = 3): Uint8Array {
  const body: number[] = [...riffChunk('VP8X', [0x02, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)])];
  for (const delay of delaysMs) {
    body.push(...riffChunk('ANMF', [0, 0, 0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1), ...u24le(delay), 0, 0]));
  }
  return Uint8Array.from([...Buffer.from('RIFF'), ...u32le(4 + body.length), ...Buffer.from('WEBP'), ...body]);
}
