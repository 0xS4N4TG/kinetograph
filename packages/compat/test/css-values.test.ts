import { describe, expect, it } from 'vitest';
import { parseColor, parseLength, parseRgba, resolveLength } from '../src/css/index.js';

const px = (value: number) => ({ unit: 'px' as const, value });

describe('parseColor', () => {
  it('reads named colours, case-insensitively', () => {
    expect(parseColor('red')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor('RebeccaPurple')).toEqual({ r: 102, g: 51, b: 153, a: 1 });
    expect(parseColor('  white ')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('lightgoldenrodyellow')).toEqual({ r: 250, g: 250, b: 210, a: 1 });
  });

  it('knows all 148 named colours plus transparent', () => {
    const names =
      'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'.split(
        ' ',
      );
    expect(names).toHaveLength(148);
    for (const n of names) expect(parseColor(n), n).not.toBeNull();
  });

  it('reads transparent and currentcolor', () => {
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseColor('currentColor')).toBe('currentcolor');
    expect(parseRgba('currentcolor')).toBeNull();
    expect(parseRgba('blue')).toEqual({ r: 0, g: 0, b: 255, a: 1 });
  });

  it('reads hex in 3, 4, 6 and 8 digits', () => {
    expect(parseColor('#f80')).toEqual({ r: 255, g: 136, b: 0, a: 1 });
    expect(parseColor('#f808')).toEqual({ r: 255, g: 136, b: 0, a: 136 / 255 });
    expect(parseColor('#FF8800')).toEqual({ r: 255, g: 136, b: 0, a: 1 });
    expect(parseColor('#ff880080')).toEqual({ r: 255, g: 136, b: 0, a: 128 / 255 });
  });

  it('rejects bad hex', () => {
    for (const bad of ['#12', '#12345', '#1234567', '#ggg', '#', 'ff0000']) expect(parseColor(bad), bad).toBeNull();
  });

  it('reads rgb() and rgba() with commas', () => {
    expect(parseColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseColor('rgba(10, 20, 30, 0.5)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor('rgb(10,20,30,50%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor('rgb(100%, 0%, 50%)')).toEqual({ r: 255, g: 0, b: 128, a: 1 });
  });

  it('reads rgb() with spaces and a slash alpha', () => {
    expect(parseColor('rgb(10 20 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseColor('rgb(10 20 30 / 0.25)')).toEqual({ r: 10, g: 20, b: 30, a: 0.25 });
    expect(parseColor('rgba(10 20 30 / 25%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.25 });
    expect(parseColor('rgb(10% 20 30)')).toEqual({ r: 26, g: 20, b: 30, a: 1 });
    expect(parseColor('rgb(none 20 30)')).toEqual({ r: 0, g: 20, b: 30, a: 1 });
  });

  it('clamps and rounds channels', () => {
    expect(parseColor('rgb(300, -5, 127.5)')).toEqual({ r: 255, g: 0, b: 128, a: 1 });
    expect(parseColor('rgba(0, 0, 0, 2)')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseColor('rgba(0, 0, 0, -1)')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it('rejects malformed rgb()', () => {
    for (const bad of ['rgb(1, 2)', 'rgb(1 2)', 'rgb(1, 2, 3, 4, 5)', 'rgb(10%, 20, 30)', 'rgb(1 2 3 4)', 'rgb(1, 2, 3 / 0.5)', 'rgb(a, b, c)', 'rgb()']) {
      expect(parseColor(bad), bad).toBeNull();
    }
  });

  it('reads hsl() and hsla()', () => {
    expect(parseColor('hsl(0, 100%, 50%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor('hsl(120, 100%, 25%)')).toEqual({ r: 0, g: 128, b: 0, a: 1 });
    expect(parseColor('hsla(240, 100%, 50%, 0.5)')).toEqual({ r: 0, g: 0, b: 255, a: 0.5 });
    expect(parseColor('hsl(210 50% 40% / 80%)')).toEqual({ r: 51, g: 102, b: 153, a: 0.8 });
    expect(parseColor('hsl(0.5turn 100% 50%)')).toEqual({ r: 0, g: 255, b: 255, a: 1 });
    expect(parseColor('hsl(-120deg, 100%, 50%)')).toEqual({ r: 0, g: 0, b: 255, a: 1 });
    expect(parseColor('hsl(480, 100%, 50%)')).toEqual({ r: 0, g: 255, b: 0, a: 1 });
    expect(parseColor('hsl(0, 0%, 100%)')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it('wants percentages in the comma form of hsl()', () => {
    expect(parseColor('hsl(120, 100, 50)')).toBeNull();
    expect(parseColor('hsl(120 100 50)')).toEqual({ r: 0, g: 255, b: 0, a: 1 });
  });

  it('reads hwb()', () => {
    expect(parseColor('hwb(0 0% 0%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor('hwb(0 100% 0%)')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('hwb(0 50% 50%)')).toEqual({ r: 128, g: 128, b: 128, a: 1 });
    expect(parseColor('hwb(120 20% 20% / 0.5)')).toEqual({ r: 51, g: 204, b: 51, a: 0.5 });
  });

  it('is null for what is not a colour', () => {
    for (const bad of ['', 'notacolour', 'red blue', '10px', 'rgb', 'calc(1)', 'var(--x)', 'oklch(0.5 0.1 20)', 'inherit', '12']) {
      expect(parseColor(bad), bad).toBeNull();
    }
  });
});

describe('parseLength', () => {
  it('takes a number as px, as React does', () => {
    expect(parseLength(12)).toEqual(px(12));
    expect(parseLength(0)).toEqual(px(0));
    expect(parseLength(-4.5)).toEqual(px(-4.5));
  });

  it('reads the supported units', () => {
    expect(parseLength('10px')).toEqual(px(10));
    expect(parseLength('50%')).toEqual({ unit: '%', value: 50 });
    expect(parseLength('1.5em')).toEqual({ unit: 'em', value: 1.5 });
    expect(parseLength('2rem')).toEqual({ unit: 'rem', value: 2 });
    expect(parseLength('100vw')).toEqual({ unit: 'vw', value: 100 });
    expect(parseLength('50vh')).toEqual({ unit: 'vh', value: 50 });
    expect(parseLength('.5px')).toEqual(px(0.5));
    expect(parseLength('-3PX')).toEqual(px(-3));
    expect(parseLength('1e2px')).toEqual(px(100));
  });

  it('converts absolute units to px', () => {
    expect(parseLength('1in')).toEqual(px(96));
    expect(parseLength('72pt')).toEqual(px(96));
    expect(parseLength('1pc')).toEqual(px(16));
    expect(parseLength('2.54cm')?.value).toBeCloseTo(96);
    expect(parseLength('25.4mm')?.value).toBeCloseTo(96);
  });

  it('maps small, large and dynamic viewport units to the plain ones', () => {
    expect(parseLength('10dvh')).toEqual({ unit: 'vh', value: 10 });
    expect(parseLength('10svw')).toEqual({ unit: 'vw', value: 10 });
  });

  it('takes a bare 0, but no other bare number in a string', () => {
    expect(parseLength('0')).toEqual(px(0));
    expect(parseLength('10')).toBeNull();
  });

  it('is null for what is not a length', () => {
    for (const bad of ['', 'auto', 'px', '10 px', '10px 20px', '10deg', '10s', '10vmin', '10ch', 'calc(10px + 1em)', 'var(--w)', NaN, Infinity, null, undefined, {}, true]) {
      expect(parseLength(bad), String(bad)).toBeNull();
    }
  });
});

describe('resolveLength', () => {
  const context = { percentOf: 400, fontSize: 20, rootFontSize: 16, viewport: { width: 1920, height: 1080 } };
  it('resolves every unit against the context', () => {
    expect(resolveLength({ unit: 'px', value: 7 }, context)).toBe(7);
    expect(resolveLength({ unit: '%', value: 25 }, context)).toBe(100);
    expect(resolveLength({ unit: 'em', value: 1.5 }, context)).toBe(30);
    expect(resolveLength({ unit: 'rem', value: 2 }, context)).toBe(32);
    expect(resolveLength({ unit: 'vw', value: 50 }, context)).toBe(960);
    expect(resolveLength({ unit: 'vh', value: 10 }, context)).toBe(108);
    expect(resolveLength({ unit: '%', value: -50 }, context)).toBe(-200);
  });
});
