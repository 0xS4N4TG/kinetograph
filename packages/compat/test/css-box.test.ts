import { describe, expect, it } from 'vitest';
import { parseStyle } from '../src/css/index.js';

const px = (value: number) => ({ unit: 'px' as const, value });
const pct = (value: number) => ({ unit: '%' as const, value });
const rgba = (r: number, g: number, b: number, a = 1) => ({ r, g, b, a });
const parse = (style: Record<string, unknown>) => parseStyle(style);
const reasonOf = (property: string, value: unknown): string => {
  const { unsupported } = parseStyle({ [property]: value });
  if (unsupported.length !== 1) throw new Error(`${property}: ${String(value)} gave ${JSON.stringify(unsupported)}`);
  return unsupported[0]!.reason;
};

describe('margin, padding and inset', () => {
  it('expands 1 to 4 values', () => {
    expect(parse({ margin: 10 }).style.margin).toEqual([px(10), px(10), px(10), px(10)]);
    expect(parse({ margin: '1px 2px' }).style.margin).toEqual([px(1), px(2), px(1), px(2)]);
    expect(parse({ margin: '1px 2px 3px' }).style.margin).toEqual([px(1), px(2), px(3), px(2)]);
    expect(parse({ margin: '1px 2px 3px 4px' }).style.margin).toEqual([px(1), px(2), px(3), px(4)]);
    expect(parse({ padding: '1em 2%' }).style.padding).toEqual([
      { unit: 'em', value: 1 }, pct(2), { unit: 'em', value: 1 }, pct(2),
    ]);
    expect(parse({ inset: 0 }).style.inset).toEqual([px(0), px(0), px(0), px(0)]);
  });

  it('allows auto in margin and inset but not padding, and negative margins but not padding', () => {
    expect(parse({ margin: '0 auto' }).style.margin).toEqual([px(0), 'auto', px(0), 'auto']);
    expect(parse({ inset: 'auto 10px' }).style.inset).toEqual(['auto', px(10), 'auto', px(10)]);
    expect(parse({ margin: -20 }).style.margin).toEqual([px(-20), px(-20), px(-20), px(-20)]);
    expect(reasonOf('padding', 'auto')).toMatch(/expected a length, found `auto`/);
    expect(reasonOf('padding', -1)).toMatch(/negative/);
  });

  it('applies longhands over the shorthand in key order, with the initial value for the rest', () => {
    expect(parse({ marginLeft: 8 }).style.margin).toEqual([px(0), px(0), px(0), px(8)]);
    expect(parse({ margin: 10, marginTop: 'auto' }).style.margin).toEqual(['auto', px(10), px(10), px(10)]);
    expect(parse({ marginTop: 1, margin: 5 }).style.margin).toEqual([px(5), px(5), px(5), px(5)]);
    expect(parse({ paddingTop: 4, paddingBottom: '2em' }).style.padding).toEqual([px(4), px(0), { unit: 'em', value: 2 }, px(0)]);
    expect(parse({ top: 10, left: '50%' }).style.inset).toEqual([px(10), 'auto', 'auto', pct(50)]);
    expect(parse({ inset: 0, bottom: 'auto' }).style.inset).toEqual([px(0), px(0), 'auto', px(0)]);
  });

  it('gives a reason for bad values', () => {
    expect(reasonOf('margin', '1px 2px 3px 4px 5px')).toMatch(/1 to 4 values/);
    expect(reasonOf('margin', 'big')).toMatch(/expected a length/);
    expect(reasonOf('margin', '10')).toMatch(/needs a unit/);
    expect(reasonOf('marginTop', '1px 2px')).toMatch(/expected one value/);
    expect(reasonOf('top', 'calc(100% - 10px)')).toBe('calc() is not supported');
    expect(reasonOf('left', 'var(--x)')).toBe('var() is not supported');
  });
});

describe('sizes', () => {
  it('reads lengths, percentages and auto', () => {
    const { style } = parse({ width: 1920, height: '100%', minWidth: 'auto', minHeight: '10vh', maxWidth: 'none', maxHeight: '50rem' });
    expect(style).toEqual({
      width: px(1920),
      height: pct(100),
      minWidth: 'auto',
      minHeight: { unit: 'vh', value: 10 },
      maxWidth: 'none',
      maxHeight: { unit: 'rem', value: 50 },
    });
  });

  it('refuses intrinsic sizes, negatives and keywords of the other kind', () => {
    expect(reasonOf('width', 'fit-content')).toMatch(/not supported/);
    expect(reasonOf('width', 'max-content')).toMatch(/not supported/);
    expect(reasonOf('height', 'stretch')).toMatch(/not supported/);
    expect(reasonOf('width', -5)).toMatch(/negative/);
    expect(reasonOf('width', 'none')).toMatch(/not a valid size/);
    expect(reasonOf('maxWidth', 'auto')).toMatch(/not a valid size/);
    expect(reasonOf('width', 'calc(100% - 20px)')).toBe('calc() is not supported');
  });

  it('reads aspect-ratio, boxSizing, order and zIndex as plain numbers', () => {
    expect(parse({ aspectRatio: 1.5 }).style.aspectRatio).toBe(1.5);
    expect(parse({ aspectRatio: '16 / 9' }).style.aspectRatio).toBeCloseTo(16 / 9);
    expect(parse({ aspectRatio: '16/9' }).style.aspectRatio).toBeCloseTo(16 / 9);
    expect(parse({ aspectRatio: 'auto' }).style).toEqual({});
    expect(parse({ aspectRatio: 1, boxSizing: 'border-box', order: -2, zIndex: 5 }).style).toEqual({
      aspectRatio: 1,
      boxSizing: 'border-box',
      order: -2,
      zIndex: 5,
    });
    expect(parse({ zIndex: 'auto' }).style.zIndex).toBe('auto');
    expect(reasonOf('aspectRatio', 'auto 16 / 9')).toMatch(/not supported/);
    expect(reasonOf('aspectRatio', '1 / 0')).toMatch(/denominator/);
    expect(reasonOf('aspectRatio', '1px')).toMatch(/ratio/);
    expect(reasonOf('zIndex', 1.5)).toMatch(/integer/);
    expect(reasonOf('order', '2px')).toMatch(/integer/);
    expect(reasonOf('boxSizing', 'padding-box')).toMatch(/not one of/);
  });
});

describe('display, position and the other keywords', () => {
  it('reads the supported values', () => {
    expect(parse({ display: 'flex', position: 'absolute', visibility: 'hidden' }).style).toEqual({
      display: 'flex',
      position: 'absolute',
      visibility: 'hidden',
    });
    for (const d of ['block', 'inline-block', 'inline-flex', 'inline', 'none']) expect(parse({ display: d }).style.display).toBe(d);
    for (const p of ['static', 'relative', 'fixed']) expect(parse({ position: p }).style.position).toBe(p);
  });

  it('names the values that are valid CSS but not read', () => {
    expect(reasonOf('display', 'grid')).toMatch(/grid.*not supported/);
    expect(reasonOf('display', 'inline-grid')).toMatch(/not supported/);
    expect(reasonOf('display', 'table')).toMatch(/not supported/);
    expect(reasonOf('display', 'contents')).toMatch(/not supported/);
    expect(reasonOf('position', 'sticky')).toMatch(/sticky.*not supported/);
    expect(reasonOf('display', 'sideways')).toMatch(/not one of/);
  });

  it('reads overflow in one or two values, and the longhands', () => {
    expect(parse({ overflow: 'hidden' }).style).toEqual({ overflowX: 'hidden', overflowY: 'hidden' });
    expect(parse({ overflow: 'hidden auto' }).style).toEqual({ overflowX: 'hidden', overflowY: 'auto' });
    expect(parse({ overflow: 'clip', overflowY: 'scroll' }).style).toEqual({ overflowX: 'clip', overflowY: 'scroll' });
    expect(parse({ overflowX: 'visible' }).style).toEqual({ overflowX: 'visible' });
    expect(parse({ overflow: 'overlay' }).style).toEqual({ overflowX: 'auto', overflowY: 'auto' });
    expect(reasonOf('overflow', 'hidden auto scroll')).toMatch(/1 or 2 values/);
    expect(reasonOf('overflow', 'sideways')).toMatch(/not an overflow value/);
  });
});

describe('flex', () => {
  const flex = (v: unknown) => {
    const { style, unsupported } = parse({ flex: v });
    if (unsupported.length) throw new Error(unsupported[0]!.reason);
    return [style.flexGrow, style.flexShrink, style.flexBasis];
  };

  it('expands the shorthand', () => {
    expect(flex(1)).toEqual([1, 1, pct(0)]);
    expect(flex(2)).toEqual([2, 1, pct(0)]);
    expect(flex('none')).toEqual([0, 0, 'auto']);
    expect(flex('auto')).toEqual([1, 1, 'auto']);
    expect(flex('1 0 auto')).toEqual([1, 0, 'auto']);
    expect(flex('0 0 100px')).toEqual([0, 0, px(100)]);
    expect(flex('1 1 0')).toEqual([1, 1, px(0)]);
    expect(flex('1 1 0%')).toEqual([1, 1, pct(0)]);
    expect(flex('2 3')).toEqual([2, 3, pct(0)]);
    expect(flex('1 200px')).toEqual([1, 1, px(200)]);
    expect(flex('200px 2')).toEqual([2, 1, px(200)]);
    expect(flex('30%')).toEqual([1, 1, pct(30)]);
    expect(flex('0.5')).toEqual([0.5, 1, pct(0)]);
    expect(flex('content')).toEqual([1, 1, 'content']);
  });

  it('refuses malformed flex values', () => {
    expect(reasonOf('flex', '1 1 1')).toMatch(/at most two flex factors/);
    expect(reasonOf('flex', '1 1 1px 1')).toMatch(/at most three/);
    expect(reasonOf('flex', '1 100px 2')).toMatch(/next to each other/);
    expect(reasonOf('flex', '1 auto auto')).toMatch(/one basis/);
    expect(reasonOf('flex', -1)).toMatch(/negative/);
    expect(reasonOf('flex', 'fit-content')).toMatch(/not supported/);
  });

  it('lets longhands override it', () => {
    expect(parse({ flex: 1, flexBasis: 'auto', flexShrink: 0 }).style).toMatchObject({ flexGrow: 1, flexShrink: 0, flexBasis: 'auto' });
    expect(parse({ flexGrow: 3, flexBasis: 0 }).style).toEqual({ flexGrow: 3, flexBasis: px(0) });
    expect(parse({ flexBasis: 'content' }).style.flexBasis).toBe('content');
  });

  it('reads direction, wrap and the alignment properties', () => {
    expect(parse({ flexDirection: 'column-reverse', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', alignSelf: 'flex-end', alignContent: 'stretch' }).style).toEqual({
      flexDirection: 'column-reverse',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      alignItems: 'center',
      alignSelf: 'flex-end',
      alignContent: 'stretch',
    });
    expect(parse({ alignSelf: 'auto', justifyContent: 'safe center', alignItems: 'first baseline' }).style).toEqual({
      alignSelf: 'auto',
      justifyContent: 'safe center',
      alignItems: 'first baseline',
    });
    expect(reasonOf('flexDirection', 'diagonal')).toMatch(/not one of/);
    expect(reasonOf('justifyContent', 'middle')).toMatch(/not an alignment value/);
    expect(reasonOf('alignItems', 'auto')).toMatch(/not an alignment value/);
  });

  it('reads gap in one or two values, and the longhands', () => {
    expect(parse({ gap: 20 }).style).toEqual({ rowGap: px(20), columnGap: px(20) });
    expect(parse({ gap: '10px 2em' }).style).toEqual({ rowGap: px(10), columnGap: { unit: 'em', value: 2 } });
    expect(parse({ gap: 8, columnGap: 0 }).style).toEqual({ rowGap: px(8), columnGap: px(0) });
    expect(parse({ rowGap: '5%' }).style).toEqual({ rowGap: pct(5) });
    expect(parse({ gap: 'normal' }).style).toEqual({ rowGap: px(0), columnGap: px(0) });
    expect(reasonOf('gap', '1px 2px 3px')).toMatch(/1 or 2 values/);
    expect(reasonOf('gap', -1)).toMatch(/negative/);
  });
});

describe('border', () => {
  it('expands the border shorthand to all sides', () => {
    const { style, unsupported } = parse({ border: '2px solid #ff0000' });
    expect(unsupported).toEqual([]);
    expect(style.borderWidth).toEqual([px(2), px(2), px(2), px(2)]);
    expect(style.borderStyle).toEqual(['solid', 'solid', 'solid', 'solid']);
    expect(style.borderColor).toEqual(Array(4).fill(rgba(255, 0, 0)));
  });

  it('takes the parts in any order, with currentcolor and medium as the defaults', () => {
    const { style } = parse({ border: 'solid' });
    expect(style.borderWidth).toEqual(Array(4).fill(px(3)));
    expect(style.borderColor).toEqual(Array(4).fill('currentcolor'));
    expect(parse({ border: 'blue dashed thick' }).style).toMatchObject({
      borderWidth: Array(4).fill(px(5)),
      borderStyle: Array(4).fill('dashed'),
      borderColor: Array(4).fill(rgba(0, 0, 255)),
    });
    expect(parse({ border: 1 }).style.borderWidth).toEqual(Array(4).fill(px(0)));
  });

  it('computes a side with no style, or none, as 0 wide', () => {
    expect(parse({ border: 'none' }).style).toEqual({
      borderWidth: Array(4).fill(px(0)),
      borderStyle: Array(4).fill('none'),
      borderColor: Array(4).fill('currentcolor'),
    });
    expect(parse({ borderWidth: 4 }).style.borderWidth).toEqual(Array(4).fill(px(0)));
    expect(parse({ border: '4px hidden' }).style.borderWidth).toEqual(Array(4).fill(px(0)));
    expect(parse({ borderStyle: 'solid', borderWidth: 4 }).style.borderWidth).toEqual(Array(4).fill(px(4)));
    expect(parse({ borderWidth: 4, borderStyle: 'solid' }).style.borderWidth).toEqual(Array(4).fill(px(4)));
  });

  it('reads per-side shorthands and longhands in key order', () => {
    const { style } = parse({ border: '1px solid red', borderTop: '3px dashed blue', borderLeftColor: 'green', borderBottomWidth: 0 });
    expect(style.borderWidth).toEqual([px(3), px(1), px(0), px(1)]);
    expect(style.borderStyle).toEqual(['dashed', 'solid', 'solid', 'solid']);
    expect(style.borderColor).toEqual([rgba(0, 0, 255), rgba(255, 0, 0), rgba(255, 0, 0), rgba(0, 128, 0)]);
    const only = parse({ borderBottom: '2px solid white' }).style;
    expect(only.borderWidth).toEqual([px(0), px(0), px(2), px(0)]);
    expect(only.borderStyle).toEqual(['none', 'none', 'solid', 'none']);
  });

  it('expands borderWidth, borderStyle and borderColor in 1 to 4 values', () => {
    const { style } = parse({ borderStyle: 'solid dashed', borderWidth: '1px 2px 3px', borderColor: 'red blue green white' });
    expect(style.borderStyle).toEqual(['solid', 'dashed', 'solid', 'dashed']);
    expect(style.borderWidth).toEqual([px(1), px(2), px(3), px(2)]);
    expect(style.borderColor).toEqual([rgba(255, 0, 0), rgba(0, 0, 255), rgba(0, 128, 0), rgba(255, 255, 255)]);
    expect(parse({ borderStyle: 'solid', borderWidth: 'thin' }).style.borderWidth).toEqual(Array(4).fill(px(1)));
  });

  it('gives a reason for bad borders', () => {
    expect(reasonOf('border', '1px solid red blue')).toMatch(/colour appears twice/);
    expect(reasonOf('border', '1px 2px solid')).toMatch(/width appears twice/);
    expect(reasonOf('border', 'solid dashed')).toMatch(/style appears twice/);
    expect(reasonOf('border', '1px wavy red')).toMatch(/unexpected `wavy`/);
    expect(reasonOf('borderWidth', '1px 2px 3px 4px 5px')).toMatch(/1 to 4/);
    expect(reasonOf('borderWidth', 'huge')).toMatch(/not a border width/);
    expect(reasonOf('borderWidth', -1)).toMatch(/negative/);
    expect(reasonOf('borderTopStyle', 'wavy')).toMatch(/not a border style/);
    expect(reasonOf('borderLeftColor', 'nope')).toMatch(/not a colour/);
    expect(reasonOf('border', 'var(--b)')).toBe('var() is not supported');
  });

  it('does not touch a style without borders', () => {
    expect(parse({ width: 1 }).style.borderWidth).toBeUndefined();
  });
});

describe('borderRadius', () => {
  it('reads 1 to 4 values, top-left first', () => {
    expect(parse({ borderRadius: 12 }).style.borderRadius).toEqual(Array(4).fill([px(12), px(12)]));
    expect(parse({ borderRadius: '10px 20px' }).style.borderRadius).toEqual([[px(10), px(10)], [px(20), px(20)], [px(10), px(10)], [px(20), px(20)]]);
    expect(parse({ borderRadius: '1px 2px 3px' }).style.borderRadius).toEqual([[px(1), px(1)], [px(2), px(2)], [px(3), px(3)], [px(2), px(2)]]);
    expect(parse({ borderRadius: '1px 2px 3px 4px' }).style.borderRadius).toEqual([[px(1), px(1)], [px(2), px(2)], [px(3), px(3)], [px(4), px(4)]]);
    expect(parse({ borderRadius: '50%' }).style.borderRadius).toEqual(Array(4).fill([pct(50), pct(50)]));
  });

  it('reads elliptical radii after a slash', () => {
    expect(parse({ borderRadius: '10px / 20px' }).style.borderRadius).toEqual(Array(4).fill([px(10), px(20)]));
    expect(parse({ borderRadius: '10px 20px / 1px 2px 3px 4px' }).style.borderRadius).toEqual([
      [px(10), px(1)], [px(20), px(2)], [px(10), px(3)], [px(20), px(4)],
    ]);
  });

  it('reads the corner longhands, in key order', () => {
    expect(parse({ borderTopLeftRadius: 8 }).style.borderRadius).toEqual([[px(8), px(8)], [px(0), px(0)], [px(0), px(0)], [px(0), px(0)]]);
    expect(parse({ borderRadius: 4, borderBottomRightRadius: '10px 20px' }).style.borderRadius).toEqual([
      [px(4), px(4)], [px(4), px(4)], [px(10), px(20)], [px(4), px(4)],
    ]);
    expect(parse({ borderBottomLeftRadius: 5, borderRadius: 1 }).style.borderRadius).toEqual(Array(4).fill([px(1), px(1)]));
  });

  it('gives a reason for bad radii', () => {
    expect(reasonOf('borderRadius', -1)).toMatch(/negative/);
    expect(reasonOf('borderRadius', '1px 2px 3px 4px 5px')).toMatch(/1 to 4 values/);
    expect(reasonOf('borderRadius', '1px /')).toMatch(/expected a radius/);
    expect(reasonOf('borderRadius', 'round')).toMatch(/expected a length/);
    expect(reasonOf('borderTopLeftRadius', '1px 2px 3px')).toMatch(/1 or 2 values/);
    expect(reasonOf('borderRadius', '5')).toMatch(/needs a unit/);
  });
});
