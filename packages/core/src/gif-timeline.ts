// When each picture of an animated GIF, APNG or WebP shows. `<AnimatedImage>` picks a picture by Remotion's rule (the
// one whose start is nearest the time, not the one showing at it), which needs the starts; the native `gif` layer takes
// a time and finds the picture itself. The delays are read straight from the file, with the rule browsers and the `gif`
// layer share: a delay of 10 ms or less shows for 100 ms.

export interface GifTimeline {
  /** The logical screen. */
  width: number;
  height: number;
  /** Where each picture starts, in microseconds (a browser's `ImageDecoder` timestamps). */
  startsUs: number[];
  /** The sum of the delays, in microseconds. */
  durationUs: number;
}

/** Whether `bytes` start with the signature of a GIF. */
export function isGif(bytes: Uint8Array): boolean {
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  return signature === 'GIF87a' || signature === 'GIF89a';
}

/** Skips a run of data sub-blocks (a size byte and that many bytes, ending in a size of 0); returns the offset after it. */
function skipSubBlocks(bytes: Uint8Array, at: number): number {
  let pos = at;
  while (pos < bytes.length && bytes[pos] !== 0) pos += bytes[pos]! + 1;
  return pos + 1;
}

/** The pictures' timing in the GIF `bytes`, or an error naming what is wrong with the file. */
export function readGifTimeline(bytes: Uint8Array): GifTimeline {
  if (!isGif(bytes)) throw new Error('not a GIF (no GIF87a or GIF89a signature)');
  const width = bytes[6]! | (bytes[7]! << 8);
  const height = bytes[8]! | (bytes[9]! << 8);
  const globalColors = bytes[10]! & 0x80 ? 3 << ((bytes[10]! & 7) + 1) : 0;
  let pos = 13 + globalColors;
  let delayMs = 0;
  const startsUs: number[] = [];
  let endUs = 0;
  while (pos < bytes.length && bytes[pos] !== 0x3b) {
    const block = bytes[pos]!;
    if (block === 0x21) {
      // An extension: the graphic control one (0xF9) holds the delay, in hundredths of a second, of the picture after it.
      if (bytes[pos + 1] === 0xf9) delayMs = (bytes[pos + 4]! | (bytes[pos + 5]! << 8)) * 10;
      pos = skipSubBlocks(bytes, pos + 2);
    } else if (block === 0x2c) {
      const localColors = bytes[pos + 9]! & 0x80 ? 3 << ((bytes[pos + 9]! & 7) + 1) : 0;
      // The descriptor is 10 bytes, then the colour table, then the LZW code size, then the image data.
      pos = skipSubBlocks(bytes, pos + 10 + localColors + 1);
      startsUs.push(endUs);
      endUs += (delayMs <= 10 ? 100 : delayMs) * 1000;
      delayMs = 0;
    } else {
      throw new Error(`unexpected block 0x${block.toString(16)} at byte ${pos}`);
    }
  }
  if (startsUs.length === 0) throw new Error('it has no pictures');
  return { width, height, startsUs, durationUs: endUs };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(bytes: Uint8Array, from: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(from, from + length));
}

function u24le(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
}

/** The pictures' timing in the animated PNG `bytes`, or an error naming what is wrong with the file. */
export function readApngTimeline(bytes: Uint8Array): GifTimeline {
  if (bytes.length < 8 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let animated = false;
  const startsUs: number[] = [];
  let endUs = 0;
  for (let pos = 8; pos + 8 <= bytes.length; ) {
    const length = view.getUint32(pos);
    const type = ascii(bytes, pos + 4, 4);
    const data = pos + 8;
    if (data + length > bytes.length) break;
    if (type === 'IHDR') {
      width = view.getUint32(data);
      height = view.getUint32(data + 4);
    } else if (type === 'acTL') {
      animated = true;
    } else if (type === 'IDAT') {
      if (!animated) throw new Error('it is not animated');
    } else if (type === 'fcTL') {
      const num = view.getUint16(data + 20);
      const den = view.getUint16(data + 22) || 100;
      const delayMs = Math.round((num / den) * 1000);
      startsUs.push(endUs);
      endUs += (delayMs <= 10 ? 100 : delayMs) * 1000;
    } else if (type === 'IEND') {
      break;
    }
    pos = data + length + 4;
  }
  if (!animated) throw new Error('it is not animated');
  if (startsUs.length === 0) throw new Error('it has no pictures');
  return { width, height, startsUs, durationUs: endUs };
}

/** The pictures' timing in the animated WebP `bytes`, or an error naming what is wrong with the file. */
export function readWebpTimeline(bytes: Uint8Array): GifTimeline {
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') throw new Error('not a WebP');
  if (bytes.length < 30 || ascii(bytes, 12, 4) !== 'VP8X' || (bytes[20]! & 0x02) === 0) throw new Error('it is not animated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = u24le(bytes, 24) + 1;
  const height = u24le(bytes, 27) + 1;
  const startsUs: number[] = [];
  let endUs = 0;
  for (let pos = 12; pos + 8 <= bytes.length; ) {
    const type = ascii(bytes, pos, 4);
    const size = view.getUint32(pos + 4, true);
    const data = pos + 8;
    if (type === 'ANMF' && data + 15 <= bytes.length) {
      const delayMs = u24le(bytes, data + 12);
      startsUs.push(endUs);
      endUs += (delayMs <= 10 ? 100 : delayMs) * 1000;
    }
    pos = data + size + (size & 1);
  }
  if (startsUs.length === 0) throw new Error('it has no pictures');
  return { width, height, startsUs, durationUs: endUs };
}

/**
 * The index of the picture a browser's `ImageDecoder` hands `<AnimatedImage>` at `seconds`: of the picture that has
 * started and the one that starts next, the one whose start is nearer (the next one when they are equally near).
 */
export function nearestPicture(timeline: GifTimeline, seconds: number): number {
  const { startsUs } = timeline;
  let started = 0;
  while (started + 1 < startsUs.length && startsUs[started + 1]! / 1e6 <= seconds) started++;
  const next = started + 1;
  if (next >= startsUs.length) return started;
  return seconds - startsUs[started]! / 1e6 < startsUs[next]! / 1e6 - seconds ? started : next;
}
