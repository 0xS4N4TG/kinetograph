import { describe, expect, it } from 'vitest';
import { parseStyle } from '../src/css/index.js';

const px = (value: number) => ({ unit: 'px' as const, value });
const rgba = (r: number, g: number, b: number, a = 1) => ({ r, g, b, a });
const parse = (style: Record<string, unknown>) => parseStyle(style);
const reasonOf = (property: string, value: unknown): string => {
  const { unsupported } = parseStyle({ [property]: value });
  if (unsupported.length !== 1) throw new Error(`${property}: ${String(value)} gave ${JSON.stringify(unsupported)}`);
  return unsupported[0]!.reason;
};

describe('font-family', () => {
  it('reads quoted and unquoted names', () => {
    expect(parse({ fontFamily: 'Inter, sans-serif' }).style.fontFamily).toEqual(['Inter', 'sans-serif']);
    expect(parse({ fontFamily: '"Helvetica Neue", Arial' }).style.fontFamily).toEqual(['Helvetica Neue', 'Arial']);
    expect(parse({ fontFamily: "'Space Grotesk'" }).style.fontFamily).toEqual(['Space Grotesk']);
    expect(parse({ fontFamily: 'Helvetica   Neue,  Segoe UI' }).style.fontFamily).toEqual(['Helvetica Neue', 'Segoe UI']);
    expect(parse({ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, SANS-SERIF' }).style.fontFamily).toEqual([
      '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'system-ui', 'sans-serif',
    ]);
  });

  it('gives a reason for bad lists', () => {
    expect(reasonOf('fontFamily', 'Inter,')).toMatch(/empty item/);
    expect(reasonOf('fontFamily', '12px')).toMatch(/not a font family name/);
    expect(reasonOf('fontFamily', '""')).toMatch(/empty/);
    expect(reasonOf('fontFamily', 'Inter, 3d')).toMatch(/not a font family name/);
  });
});

describe('font-size, weight, style and line-height', () => {
  it('reads sizes as lengths, keeping keywords as keywords', () => {
    expect(parse({ fontSize: 48 }).style.fontSize).toEqual(px(48));
    expect(parse({ fontSize: '2rem' }).style.fontSize).toEqual({ unit: 'rem', value: 2 });
    expect(parse({ fontSize: '120%' }).style.fontSize).toEqual({ unit: '%', value: 120 });
    expect(parse({ fontSize: 'x-large' }).style.fontSize).toBe('x-large');
    expect(parse({ fontSize: 'Smaller' }).style.fontSize).toBe('smaller');
    expect(parse({ fontSize: '12pt' }).style.fontSize).toEqual(px(16));
    expect(reasonOf('fontSize', -1)).toMatch(/negative/);
    expect(reasonOf('fontSize', 'huge')).toMatch(/not a font size/);
    expect(reasonOf('fontSize', '12')).toMatch(/needs a unit/);
    expect(reasonOf('fontSize', 'calc(1rem + 2px)')).toBe('calc() is not supported');
  });

  it('reads weights as numbers, keeping bolder and lighter', () => {
    expect(parse({ fontWeight: 700 }).style.fontWeight).toBe(700);
    expect(parse({ fontWeight: '600' }).style.fontWeight).toBe(600);
    expect(parse({ fontWeight: 'normal' }).style.fontWeight).toBe(400);
    expect(parse({ fontWeight: 'bold' }).style.fontWeight).toBe(700);
    expect(parse({ fontWeight: 'bolder' }).style.fontWeight).toBe('bolder');
    expect(parse({ fontWeight: 'lighter' }).style.fontWeight).toBe('lighter');
    expect(parse({ fontWeight: 350 }).style.fontWeight).toBe(350);
    expect(reasonOf('fontWeight', 0)).toMatch(/not a font weight/);
    expect(reasonOf('fontWeight', 1001)).toMatch(/not a font weight/);
    expect(reasonOf('fontWeight', 'heavy')).toMatch(/not a font weight/);
  });

  it('reads font style', () => {
    expect(parse({ fontStyle: 'italic' }).style.fontStyle).toBe('italic');
    expect(parse({ fontStyle: 'normal' }).style.fontStyle).toBe('normal');
    expect(parse({ fontStyle: 'oblique' }).style.fontStyle).toBe('oblique');
    expect(reasonOf('fontStyle', 'oblique 10deg')).toMatch(/oblique angle/);
    expect(reasonOf('fontStyle', 'slanted')).toMatch(/not a font style/);
  });

  it('reads line-height as a multiple, a length or normal', () => {
    expect(parse({ lineHeight: 1.2 }).style.lineHeight).toBe(1.2);
    expect(parse({ lineHeight: '1.5' }).style.lineHeight).toBe(1.5);
    expect(parse({ lineHeight: 0 }).style.lineHeight).toBe(0);
    expect(parse({ lineHeight: '24px' }).style.lineHeight).toEqual(px(24));
    expect(parse({ lineHeight: '150%' }).style.lineHeight).toEqual({ unit: '%', value: 150 });
    expect(parse({ lineHeight: '1.2em' }).style.lineHeight).toEqual({ unit: 'em', value: 1.2 });
    expect(parse({ lineHeight: 'normal' }).style.lineHeight).toBe('normal');
    expect(reasonOf('lineHeight', -1)).toMatch(/negative/);
    expect(reasonOf('lineHeight', 'tall')).toMatch(/expected a length/);
  });
});

describe('font shorthand', () => {
  it('expands size, line-height and family', () => {
    expect(parse({ font: '16px Arial' }).style).toEqual({
      fontStyle: 'normal', fontWeight: 400, fontSize: px(16), lineHeight: 'normal', fontFamily: ['Arial'],
    });
    expect(parse({ font: 'italic 700 48px/1.2 "Helvetica Neue", sans-serif' }).style).toEqual({
      fontStyle: 'italic', fontWeight: 700, fontSize: px(48), lineHeight: 1.2, fontFamily: ['Helvetica Neue', 'sans-serif'],
    });
    expect(parse({ font: 'bold large/150% serif' }).style).toMatchObject({
      fontWeight: 700, fontSize: 'large', lineHeight: { unit: '%', value: 150 },
    });
    expect(parse({ font: 'normal normal 14px/20px monospace' }).style).toMatchObject({ lineHeight: px(20), fontFamily: ['monospace'] });
    expect(parse({ font: 'oblique lighter 1em Inter' }).style).toMatchObject({ fontStyle: 'oblique', fontWeight: 'lighter' });
  });

  it('resets what it leaves out, and is overridden by later longhands', () => {
    const { style } = parse({ fontWeight: 900, lineHeight: 2, font: '20px Inter', fontSize: 30 });
    expect(style).toMatchObject({ fontWeight: 400, lineHeight: 'normal', fontSize: px(30), fontFamily: ['Inter'] });
  });

  it('gives a reason for what it cannot read', () => {
    expect(reasonOf('font', '16px')).toMatch(/needs a font family/);
    expect(reasonOf('font', 'Arial')).toMatch(/not a font size/);
    expect(reasonOf('font', 'bold 700 16px Arial')).toMatch(/weight appears twice/);
    expect(reasonOf('font', 'italic oblique 16px Arial')).toMatch(/style appears twice/);
    expect(reasonOf('font', 'small-caps 16px Arial')).toMatch(/small-caps/);
    expect(reasonOf('font', 'condensed 16px Arial')).toMatch(/stretch/);
    expect(reasonOf('font', 'caption')).toMatch(/system font/);
    expect(reasonOf('font', 'oblique 10deg 16px Arial')).toMatch(/oblique angle/);
    expect(reasonOf('font', '16px/ Arial')).toMatch(/length|number|expected/);
  });
});

describe('text properties', () => {
  it('reads colour, alignment, transform, white-space and spacing', () => {
    expect(
      parse({
        color: '#fff', textAlign: 'center', textTransform: 'uppercase', whiteSpace: 'pre-line', letterSpacing: '0.05em', wordSpacing: 4,
      }).style,
    ).toEqual({
      color: rgba(255, 255, 255),
      textAlign: 'center',
      textTransform: 'uppercase',
      whiteSpace: 'pre-line',
      letterSpacing: { unit: 'em', value: 0.05 },
      wordSpacing: px(4),
    });
    expect(parse({ color: 'currentColor' }).style.color).toBe('currentcolor');
    expect(parse({ letterSpacing: 'normal' }).style.letterSpacing).toBe('normal');
    expect(parse({ letterSpacing: -2 }).style.letterSpacing).toEqual(px(-2));
    for (const a of ['left', 'right', 'justify', 'start', 'end']) expect(parse({ textAlign: a }).style.textAlign).toBe(a);
    for (const w of ['normal', 'nowrap', 'pre', 'pre-wrap', 'break-spaces']) expect(parse({ whiteSpace: w }).style.whiteSpace).toBe(w);
  });

  it('gives a reason for bad values', () => {
    expect(reasonOf('color', 'reddish')).toMatch(/expected a colour/);
    expect(reasonOf('color', 'rgb(1, 2)')).toMatch(/rgb\(\) takes 3 or 4/);
    expect(reasonOf('textAlign', 'match-parent')).toMatch(/not one of/);
    expect(reasonOf('textTransform', 'full-width')).toMatch(/not one of/);
    expect(reasonOf('whiteSpace', 'wrap')).toMatch(/not one of/);
    expect(reasonOf('letterSpacing', '2')).toMatch(/needs a unit/);
  });

  it('reads textDecoration as its words', () => {
    expect(parse({ textDecoration: 'none' }).style.textDecoration).toBe('none');
    expect(parse({ textDecoration: 'underline wavy red 2px' }).style.textDecoration).toBe('underline wavy red 2px');
    expect(reasonOf('textDecoration', 'underlined')).toMatch(/unexpected `underlined`/);
  });

  it('reads textShadow', () => {
    expect(parse({ textShadow: '0 2px 8px rgba(0,0,0,.4)' }).style.textShadow).toEqual([
      { x: px(0), y: px(2), blur: px(8), color: rgba(0, 0, 0, 0.4) },
    ]);
  });

  it('reports the text properties the mapping does not draw as not supported', () => {
    const { style, unsupported } = parse({
      textOverflow: 'ellipsis', WebkitTextStroke: '1px red', WebkitLineClamp: 2, writingMode: 'vertical-rl', direction: 'rtl',
      fontVariantNumeric: 'tabular-nums', fontFeatureSettings: '"tnum"', textIndent: 10, verticalAlign: 'middle',
    });
    expect(style).toEqual({});
    expect(unsupported.map((d) => d.property)).toEqual([
      'textOverflow', 'WebkitTextStroke', 'WebkitLineClamp', 'writingMode', 'direction', 'fontVariantNumeric',
      'fontFeatureSettings', 'textIndent', 'verticalAlign',
    ]);
    expect(unsupported.every((d) => d.reason === 'not supported')).toBe(true);
    expect(unsupported[2]!.value).toBe('2');
  });
});

describe('SVG presentation properties', () => {
  it('reads paints, opacities and stroke settings', () => {
    expect(
      parse({
        fill: '#ff0', stroke: 'url(#grad) red', fillOpacity: 0.5, strokeOpacity: '25%', strokeWidth: 3,
        strokeLinecap: 'round', strokeLinejoin: 'bevel', fillRule: 'evenodd', strokeDasharray: '4, 2 1',
      }).style,
    ).toEqual({
      fill: rgba(255, 255, 0),
      stroke: { url: '#grad', fallback: rgba(255, 0, 0) },
      fillOpacity: 0.5,
      strokeOpacity: 0.25,
      strokeWidth: px(3),
      strokeLinecap: 'round',
      strokeLinejoin: 'bevel',
      fillRule: 'evenodd',
      strokeDasharray: [px(4), px(2), px(1)],
    });
    expect(parse({ fill: 'none', stroke: 'currentColor' }).style).toEqual({ fill: 'none', stroke: 'currentcolor' });
    expect(parse({ fill: 'url(#a)' }).style.fill).toEqual({ url: '#a' });
    expect(parse({ strokeDasharray: 'none' }).style.strokeDasharray).toBe('none');
    expect(parse({ strokeWidth: '2px' }).style.strokeWidth).toEqual(px(2));
  });

  it('gives a reason for bad values', () => {
    expect(reasonOf('fill', 'context-fill')).toMatch(/not supported/);
    expect(reasonOf('fill', 'red blue')).toMatch(/one paint value/);
    expect(reasonOf('fill', 'url(#a) url(#b)')).toMatch(/not a colour|expected a colour/);
    expect(reasonOf('strokeWidth', -1)).toMatch(/negative/);
    expect(reasonOf('strokeLinecap', 'pointy')).toMatch(/not one of/);
  });
});
