import { describe, expect, it } from 'vitest';
import { decodePng, encodePng } from '../src/png.js';

describe('encodePng', () => {
  it('round-trips straight-alpha pixels through the CLI\'s own decoder', () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 40, 1, 2, 3, 4, 5, 6, 7, 8]);
    const png = encodePng(3, 2, rgba);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    const back = decodePng(png);
    expect([back.width, back.height]).toEqual([3, 2]);
    expect(Array.from(back.data)).toEqual(Array.from(rgba));
  });

  it('refuses a buffer of the wrong length', () => {
    expect(() => encodePng(2, 2, new Uint8Array(15))).toThrow(/16 bytes/);
  });
});
