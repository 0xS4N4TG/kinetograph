// measureText and fitText through the DOM engine (packages/cli/skills/kinetograph/references/ENGINE.md §10): the box of a `span`, as Remotion asks Chrome.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setDomAddon } from '@kinetograph/compat/dom';
import { clearFonts, registerFont } from '../src/font-registry.js';
import { fitText, measureText, setDomTextMeasure } from '../src/layout-utils.js';
import '../src/web-install.js';

const font = fileURLToPath(new URL('../../../assets/fonts/DMSans-Medium.ttf', import.meta.url));

function loadAddon(): Record<string, unknown> | null {
  try {
    const native = createRequire(import.meta.url)('@kinetograph/native') as Record<string, unknown>;
    return typeof native.domLayoutBoxes === 'function' ? native : null;
  } catch {
    return null;
  }
}
const addon = loadAddon();

describe.skipIf(addon === null)('measureText with the DOM engine', () => {
  beforeAll(() => {
    setDomAddon(addon);
    clearFonts();
    registerFont({ family: 'DM Sans', path: font });
  });
  afterAll(() => setDomAddon(null));

  it('gives the width and height of a span, as Chrome rounds the line', () => {
    const { width, height } = measureText({ text: 'Kinetograph', fontFamily: 'DM Sans', fontSize: 100 });
    expect(width).toBeCloseTo(571.9, 1);
    expect(height).toBe(130);
  });

  it('applies letterSpacing and textTransform with CSS, and counts spaces at the ends', () => {
    const plain = measureText({ text: 'Spaced', fontFamily: 'DM Sans', fontSize: 50 }).width;
    // Letter spacing is added after every character, the last one too.
    expect(measureText({ text: 'Spaced', fontFamily: 'DM Sans', fontSize: 50, letterSpacing: 5 }).width).toBeCloseTo(plain + 30, 1);
    expect(measureText({ text: 'Spaced', fontFamily: 'DM Sans', fontSize: 50, letterSpacing: '0.1em' }).width).toBeCloseTo(plain + 30, 1);
    const upper = measureText({ text: 'spaced', fontFamily: 'DM Sans', fontSize: 50, textTransform: 'uppercase' }).width;
    expect(upper).toBeCloseTo(measureText({ text: 'SPACED', fontFamily: 'DM Sans', fontSize: 50 }).width, 3);
    const padded = measureText({ text: '  Spaced  ', fontFamily: 'DM Sans', fontSize: 50 }).width;
    expect(padded).toBeGreaterThan(plain + 20);
  });

  it('takes additionalStyles', () => {
    const plain = measureText({ text: 'Hello big world', fontFamily: 'DM Sans', fontSize: 40 });
    const spaced = measureText({ text: 'Hello big world', fontFamily: 'DM Sans', fontSize: 40, additionalStyles: { wordSpacing: 10 } });
    expect(spaced.width).toBeCloseTo(plain.width + 20, 3);
  });

  it('fits text to a width: the size at which it is that wide', () => {
    const { fontSize } = fitText({ text: 'Kinetograph', fontFamily: 'DM Sans', withinWidth: 400 });
    expect(measureText({ text: 'Kinetograph', fontFamily: 'DM Sans', fontSize }).width).toBeCloseTo(400, 0);
  });

  it('still says a font is not registered', () => {
    expect(() => measureText({ text: 'x', fontFamily: 'Nope', fontSize: 10 })).toThrow('not registered');
  });
});

afterAll(() => setDomTextMeasure(null));
