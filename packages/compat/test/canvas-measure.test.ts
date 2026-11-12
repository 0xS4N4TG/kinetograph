import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canvasEnvironment } from '../src/shim/canvas.js';

describe('canvas measureText', () => {
  it('counts the white space at the ends of the text', () => {
    const { measure } = canvasEnvironment(() => ({ 'DM Sans': fileURLToPath(new URL('../../../assets/fonts/DMSans-Medium.ttf', import.meta.url)) }));
    const width = (text: string): number => measure!(text, 'monospace', 20)!.width;
    // In a monospace font every character is as wide as another, a space included.
    expect(width('ab')).toBeGreaterThan(0);
    expect(width('ab ')).toBeCloseTo(width('abc'), 1);
    expect(width(' ab')).toBeCloseTo(width('cab'), 1);
    expect(width('  ')).toBeCloseTo(width('ab'), 1);
  });
});
