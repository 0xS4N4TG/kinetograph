import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TextLayoutRequest } from '@kinetographdev/native';
import { clearFonts, registerFont, trackFontLoad } from '../src/font-registry.js';
import { fillTextBox, fitText, fitTextOnNLines, measureText, setLayoutText } from '../src/layout-utils.js';
import { fixture } from './helpers.js';

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
  it('keeps an answer, and drops it when a font is registered', () => {
    const wide = (request: TextLayoutRequest) => ({ ...fakeLayout(request), width: request.fonts['Inter']!.includes('Wide') ? 999 : 100 });
    setLayoutText(wide);
    const options = { text: 'Hello', fontFamily: 'Inter', fontSize: 40 };
    expect(measureText(options).width).toBe(100);
    expect(measureText({ ...options }).width).toBe(100);
    expect(requests).toHaveLength(1);
    // Another size or style is another measurement.
    measureText({ ...options, fontSize: 41 });
    measureText({ ...options, additionalStyles: { wordSpacing: 3 } });
    expect(requests).toHaveLength(3);
    // A font registered after a measurement changes the next one.
    registerFont({ family: 'Inter', path: '/f/Inter-Wide.ttf' });
    expect(measureText(options).width).toBe(999);
    expect(requests).toHaveLength(4);
    // Mutating an answer does not change the next.
    measureText(options).width = 1;
    expect(measureText(options).width).toBe(999);
  });

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

  it('says when the box is overfull, and then leaves it as it was', () => {
    const box = fillTextBox({ maxBoxWidth: 30, maxLines: 2 });
    expect(box.add(piece('aaaaa'))).toEqual({ exceedsBox: false, newLine: false });
    expect(box.add(piece('bbbbb'))).toEqual({ exceedsBox: false, newLine: true });
    expect(box.add(piece('ccccc'))).toEqual({ exceedsBox: true, newLine: false });
    expect(box.add(piece('d'))).toEqual({ exceedsBox: false, newLine: false });
  });

  it('says a piece wider than the box does not fit', () => {
    const box = fillTextBox({ maxBoxWidth: 20, maxLines: 5 });
    expect(box.add(piece('aaaaaaaa')).exceedsBox).toBe(true);
  });

  it('measures a line rounded up, and drops the leading space of a piece that starts a line', () => {
    // ' bb' is 15 wide; with the space dropped on a new line it is 10
    const box = fillTextBox({ maxBoxWidth: 20, maxLines: 3 });
    expect(box.add(piece('aaaa'))).toEqual({ exceedsBox: false, newLine: false });
    expect(box.add(piece(' bb'))).toEqual({ exceedsBox: false, newLine: true });
    expect(box.add(piece(' c'))).toEqual({ exceedsBox: false, newLine: false });
    // 10.1 wide pieces: the line is 20.2 wide, rounded up to 21
    const wide = fillTextBox({ maxBoxWidth: 20, maxLines: 2 });
    expect(wide.add({ text: 'ab', fontFamily: 'Inter', fontSize: 10.1 })).toEqual({ exceedsBox: false, newLine: false });
    expect(wide.add({ text: 'cd', fontFamily: 'Inter', fontSize: 10.1 })).toEqual({ exceedsBox: false, newLine: true });
  });

  it('matches the published package on every recorded sequence of pieces', () => {
    for (const c of fixture('layout-utils.json').box) {
      const box = fillTextBox({ maxBoxWidth: c.maxBoxWidth, maxLines: c.maxLines });
      const results = c.pieces.map((p: any) => box.add(p));
      expect(results, JSON.stringify(c.pieces)).toEqual(c.results);
    }
  });
});

describe('fitTextOnNLines', () => {
  it('matches the published package on every recorded text, box and size limit', () => {
    const { fit } = fixture('layout-utils.json');
    expect(fit.length).toBeGreaterThan(20);
    for (const c of fit) {
      const label = JSON.stringify(c.options);
      expect(fitTextOnNLines({ fontFamily: 'Inter', ...c.options }), label).toEqual(c.output);
    }
  });

  it('finds the largest hundredth of a pixel at which the words fit', () => {
    // 'ab cd' on one line: 5 characters at half the size each, so 200 wide fits at 80
    expect(fitTextOnNLines({ text: 'ab cd', fontFamily: 'Inter', maxLines: 1, maxBoxWidth: 200 })).toEqual({ fontSize: 80, lines: ['ab cd'] });
    // on two lines the longer word, 2 characters, sets it: 200 wide fits at 200
    expect(fitTextOnNLines({ text: 'ab cd', fontFamily: 'Inter', maxLines: 2, maxBoxWidth: 200 }).lines).toEqual(['ab', 'cd']);
  });

  it('stops at maxFontSize', () => {
    expect(fitTextOnNLines({ text: 'ab', fontFamily: 'Inter', maxLines: 1, maxBoxWidth: 10000, maxFontSize: 30 })).toEqual({ fontSize: 30, lines: ['ab'] });
  });

  it('gives the smallest size and no lines when nothing fits', () => {
    expect(fitTextOnNLines({ text: 'ab', fontFamily: 'Inter', maxLines: 1, maxBoxWidth: 0.01 })).toEqual({ fontSize: 0.1, lines: [] });
  });
});
