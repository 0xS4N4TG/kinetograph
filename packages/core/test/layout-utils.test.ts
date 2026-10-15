import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TextLayoutRequest } from '@kinetograph/native';
import { clearFonts, registerFont, trackFontLoad } from '../src/font-registry.js';
import { fillTextBox, fitText, measureText, setLayoutText } from '../src/layout-utils.js';

// A stand-in for the text engine: every character is 0.5 em wide, a line is 1.2 em tall, '|' is 0.25 em, and
// spaces at the ends are trimmed as the real one does.
const requests: TextLayoutRequest[] = [];
function fakeLayout(request: TextLayoutRequest) {
  requests.push(request);
  const rows = request.text.split('\n');
  const widthOf = (row: string) => {
    const trimmed = row.trim();
    return [...trimmed].reduce((sum, ch) => sum + (ch === '|' ? 0.25 : 0.5) * request.size, 0);
  };
  return {
    width: Math.max(...rows.map(widthOf)),
    height: rows.length * request.size * 1.2,
    lines: [],
    glyphs: [],
  };
}

beforeEach(() => {
  requests.length = 0;
  clearFonts();
  registerFont({ family: 'Inter', path: '/f/Inter.ttf' });
  registerFont({ family: 'Inter', path: '/f/Inter-Bold.ttf', weight: 700 });
  setLayoutText(fakeLayout);
});
afterEach(() => setLayoutText(null));

describe('measureText', () => {
  it('measures with the registered font and its key', () => {
    expect(measureText({ text: 'Hello', fontFamily: 'Inter', fontSize: 40 })).toEqual({ width: 100, height: 48 });
    const request = requests[0]!;
    expect(request).toMatchObject({ text: 'Hello', font: 'Inter', size: 40, fonts: { Inter: '/f/Inter.ttf', 'Inter:700': '/f/Inter-Bold.ttf' } });
    measureText({ text: 'Hi', fontFamily: 'Inter', fontSize: 10, fontWeight: 'bold' });
    expect(requests[1]!.font).toBe('Inter:700');
  });

  it('counts a newline as another line', () => {
    expect(measureText({ text: 'ab\nabcd', fontFamily: 'Inter', fontSize: 10 })).toEqual({ width: 20, height: 24 });
  });

  it('counts spaces at the ends of the text', () => {
    // "a b " is 4 characters wide even though the engine trims the trailing one
    expect(measureText({ text: 'a b ', fontFamily: 'Inter', fontSize: 10 }).width).toBeCloseTo(10 + 0.5 * 10 * 2 + 0, 9);
    expect(measureText({ text: ' a', fontFamily: 'Inter', fontSize: 10 }).width).toBeCloseTo(10, 9);
  });

  it('applies textTransform and letterSpacing', () => {
    measureText({ text: 'abc', fontFamily: 'Inter', fontSize: 10, textTransform: 'uppercase' });
    expect(requests[0]!.text).toBe('ABC');
    measureText({ text: 'ab cd', fontFamily: 'Inter', fontSize: 10, textTransform: 'capitalize' });
    expect(requests[1]!.text).toBe('Ab Cd');
    expect(measureText({ text: 'abcd', fontFamily: 'Inter', fontSize: 10, letterSpacing: 2 }).width).toBe(20 + 8);
    expect(measureText({ text: 'abcd', fontFamily: 'Inter', fontSize: 10, letterSpacing: '0.1em' }).width).toBe(20 + 4);
  });

  it('never measures with a font that is not registered', () => {
    expect(() => measureText({ text: 'x', fontFamily: 'Nope', fontSize: 10 })).toThrow(/"Nope": it is not registered.*Registered: "Inter", "Inter:700"/);
    expect(() => measureText({ text: 'x', fontFamily: 'Inter', fontSize: 10, fontWeight: 300 })).toThrow(/"Inter:300"/);
    expect(requests).toHaveLength(0);
  });

  it('never measures while a font is still downloading', async () => {
    let finish!: () => void;
    const download = trackFontLoad(new Promise<void>((resolve) => (finish = resolve)));
    expect(() => measureText({ text: 'x', fontFamily: 'Inter', fontSize: 10 })).toThrow(/still downloading/);
    finish();
    await download;
    expect(measureText({ text: 'x', fontFamily: 'Inter', fontSize: 10 }).width).toBe(5);
  });

  it('rejects a bad size', () => {
    expect(() => measureText({ text: 'x', fontFamily: 'Inter', fontSize: 0 })).toThrow(/fontSize/);
  });
});

describe('fitText', () => {
  it('returns the font size at which the text is as wide as asked', () => {
    // "Hello" is 2.5 em wide
    expect(fitText({ text: 'Hello', fontFamily: 'Inter', withinWidth: 500 }).fontSize).toBeCloseTo(200, 9);
    expect(fitText({ text: 'Hello', fontFamily: 'Inter', withinWidth: 100 }).fontSize).toBeCloseTo(40, 9);
  });

  it('measures once, at a round size', () => {
    fitText({ text: 'Hello', fontFamily: 'Inter', withinWidth: 100 });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.size).toBe(100);
  });
});

describe('fillTextBox', () => {
  const piece = (text: string) => ({ text, fontFamily: 'Inter', fontSize: 10 });

  it('reports where a line breaks', () => {
    const box = fillTextBox({ maxBoxWidth: 50, maxLines: 3 });
    // each character 5 wide: 'aaaa ' = 25, so two fit on a line
    expect(box.add(piece('aaaa '))).toEqual({ exceedsBox: false, newLine: false });
    expect(box.add(piece('bbbb '))).toEqual({ exceedsBox: false, newLine: false });
    expect(box.add(piece('cccc '))).toEqual({ exceedsBox: false, newLine: true });
    expect(box.add(piece('dddd '))).toEqual({ exceedsBox: false, newLine: false });
    expect(box.add(piece('eeee '))).toEqual({ exceedsBox: false, newLine: true });
  });

  it('says when the box is overfull', () => {
    const box = fillTextBox({ maxBoxWidth: 30, maxLines: 2 });
    expect(box.add(piece('aaaaa'))).toEqual({ exceedsBox: false, newLine: false });
    expect(box.add(piece('bbbbb'))).toEqual({ exceedsBox: false, newLine: true });
    expect(box.add(piece('ccccc'))).toEqual({ exceedsBox: true, newLine: true });
  });

  it('says a piece wider than the box does not fit', () => {
    const box = fillTextBox({ maxBoxWidth: 20, maxLines: 5 });
    expect(box.add(piece('aaaaaaaa')).exceedsBox).toBe(true);
  });
});
