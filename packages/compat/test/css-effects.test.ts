import { describe, expect, it } from 'vitest';
import {
  parseBoxShadow,
  parseClipPath,
  parseFilter,
  parseStyle,
  parseTextShadow,
  type BoxShadow,
  type ClipShape,
  type Diagnostic,
  type FilterOp,
} from '../src/css/index.js';

const px = (value: number) => ({ unit: 'px' as const, value });
const pct = (value: number) => ({ unit: '%' as const, value });
const rgba = (r: number, g: number, b: number, a = 1) => ({ r, g, b, a });
const must = <T>(r: T | Diagnostic): T => {
  if (r && typeof r === 'object' && 'reason' in r) throw new Error((r as Diagnostic).reason);
  return r as T;
};
const reason = (r: unknown): string => {
  if (r && typeof r === 'object' && 'reason' in r) return (r as Diagnostic).reason;
  throw new Error(`parsed: ${JSON.stringify(r)}`);
};

describe('parseBoxShadow', () => {
  it('reads a drop shadow with the colour last', () => {
    expect(must(parseBoxShadow('0 4px 12px rgba(0,0,0,0.3)'))).toEqual([
      { inset: false, x: px(0), y: px(4), blur: px(12), spread: px(0), color: rgba(0, 0, 0, 0.3) },
    ]);
  });

  it('reads the colour first, with spread, and inset anywhere', () => {
    const expected: BoxShadow = { inset: true, x: px(1), y: px(2), blur: px(3), spread: px(4), color: rgba(255, 0, 0) };
    expect(must(parseBoxShadow('inset 1px 2px 3px 4px red'))).toEqual([expected]);
    expect(must(parseBoxShadow('red 1px 2px 3px 4px inset'))).toEqual([expected]);
    expect(must(parseBoxShadow('1px 2px 3px 4px inset red'))).toEqual([expected]);
    expect(must(parseBoxShadow('red inset 1px 2px 3px 4px'))).toEqual([expected]);
  });

  it('defaults the colour to currentcolor and the blur and spread to 0', () => {
    expect(must(parseBoxShadow('5px 6px'))).toEqual([
      { inset: false, x: px(5), y: px(6), blur: px(0), spread: px(0), color: 'currentcolor' },
    ]);
  });

  it('reads comma lists, keeping their order', () => {
    const r = must(parseBoxShadow('0 0 0 2px #fff, 0 10px 30px -5px rgba(0, 0, 0, .5), inset 0 1px #0004'));
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ spread: px(2), color: rgba(255, 255, 255) });
    expect(r[1]).toMatchObject({ y: px(10), blur: px(30), spread: px(-5), color: rgba(0, 0, 0, 0.5) });
    expect(r[2]).toMatchObject({ inset: true, y: px(1), color: rgba(0, 0, 0, 68 / 255) });
  });

  it('reads none as the empty list, and em lengths', () => {
    expect(must(parseBoxShadow('none'))).toEqual([]);
    expect(must(parseBoxShadow('0.1em 0.2em black'))[0]).toMatchObject({ x: { unit: 'em', value: 0.1 } });
  });

  it('gives a reason for bad shadows', () => {
    expect(reason(parseBoxShadow('1px'))).toMatch(/needs 2 to 4 lengths/);
    expect(reason(parseBoxShadow('1px 2px 3px 4px 5px'))).toMatch(/at most 4/);
    expect(reason(parseBoxShadow('1px red 2px'))).toMatch(/next to each other/);
    expect(reason(parseBoxShadow('1px 2px -3px'))).toMatch(/negative/);
    expect(reason(parseBoxShadow('1px 2px red blue'))).toMatch(/one colour/);
    expect(reason(parseBoxShadow('inset inset 1px 2px'))).toMatch(/twice/);
    expect(reason(parseBoxShadow('1 2 red'))).toMatch(/needs a unit/);
    expect(reason(parseBoxShadow('1px 2px 3px glow'))).toMatch(/unexpected `glow`/);
    expect(reason(parseBoxShadow('1px 2px, '))).toMatch(/empty item/);
    expect(reason(parseBoxShadow('1px 2px var(--c)'))).toBe('var() is not supported');
    expect(reason(parseBoxShadow('1px 2px 50%'))).toMatch(/percentage/);
  });
});

describe('parseTextShadow', () => {
  it('reads one or more shadows', () => {
    expect(must(parseTextShadow('2px 2px 4px rgba(0,0,0,.5), -1px -1px white'))).toEqual([
      { x: px(2), y: px(2), blur: px(4), color: rgba(0, 0, 0, 0.5) },
      { x: px(-1), y: px(-1), blur: px(0), color: rgba(255, 255, 255) },
    ]);
    expect(must(parseTextShadow('none'))).toEqual([]);
    expect(must(parseTextShadow('red 1px 2px'))[0]).toMatchObject({ color: rgba(255, 0, 0), x: px(1), y: px(2) });
  });

  it('refuses inset and spread', () => {
    expect(reason(parseTextShadow('inset 1px 2px'))).toMatch(/not allowed/);
    expect(reason(parseTextShadow('1px 2px 3px 4px'))).toMatch(/at most 3/);
  });
});

describe('parseFilter', () => {
  it('reads blur and angle and amount functions', () => {
    expect(must(parseFilter('blur(8px)'))).toEqual([{ op: 'blur', radius: px(8) }]);
    expect(must(parseFilter('blur()'))).toEqual([{ op: 'blur', radius: px(0) }]);
    expect(must(parseFilter('hue-rotate(90deg)'))).toEqual([{ op: 'hue-rotate', angle: 90 }]);
    expect(must(parseFilter('hue-rotate(0.5turn)'))).toEqual([{ op: 'hue-rotate', angle: 180 }]);
    expect(must(parseFilter('brightness(1.2) contrast(110%) saturate(0.5)'))).toEqual([
      { op: 'brightness', amount: 1.2 },
      { op: 'contrast', amount: 1.1 },
      { op: 'saturate', amount: 0.5 },
    ]);
    expect(must(parseFilter('grayscale(100%) sepia(0.4) invert(1) opacity(50%)'))).toEqual([
      { op: 'grayscale', amount: 1 },
      { op: 'sepia', amount: 0.4 },
      { op: 'invert', amount: 1 },
      { op: 'opacity', amount: 0.5 },
    ]);
  });

  it('defaults an omitted amount to 1 and clamps the ones that stop at 1', () => {
    expect(must(parseFilter('brightness()'))).toEqual([{ op: 'brightness', amount: 1 }]);
    expect(must(parseFilter('grayscale(250%)'))).toEqual([{ op: 'grayscale', amount: 1 }]);
    expect(must(parseFilter('brightness(250%)'))).toEqual([{ op: 'brightness', amount: 2.5 }]);
  });

  it('reads drop-shadow', () => {
    const r: FilterOp[] = must(parseFilter('drop-shadow(0 4px 8px rgba(0,0,0,0.4))'));
    expect(r).toEqual([{ op: 'drop-shadow', x: px(0), y: px(4), blur: px(8), color: rgba(0, 0, 0, 0.4) }]);
    expect(must(parseFilter('drop-shadow(red 1px 2px)'))).toEqual([
      { op: 'drop-shadow', x: px(1), y: px(2), blur: px(0), color: rgba(255, 0, 0) },
    ]);
    expect(must(parseFilter('drop-shadow(1px 2px)'))).toEqual([
      { op: 'drop-shadow', x: px(1), y: px(2), blur: px(0), color: 'currentcolor' },
    ]);
  });

  it('keeps the order of a list; none is empty', () => {
    expect(must(parseFilter('none'))).toEqual([]);
    const r = must(parseFilter('blur(2px) drop-shadow(1px 1px red) brightness(1.1)'));
    expect(r.map((f) => f.op)).toEqual(['blur', 'drop-shadow', 'brightness']);
  });

  it('gives a reason for bad filters', () => {
    expect(reason(parseFilter('blur(-1px)'))).toMatch(/negative/);
    expect(reason(parseFilter('blur(10%)'))).toMatch(/percentage/);
    expect(reason(parseFilter('blur(10)'))).toMatch(/needs a unit/);
    expect(reason(parseFilter('brightness(-1)'))).toMatch(/negative/);
    expect(reason(parseFilter('brightness(1 2)'))).toMatch(/one argument/);
    expect(reason(parseFilter('hue-rotate(10)'))).toMatch(/angle/);
    expect(reason(parseFilter('url(#f)'))).toMatch(/url\(\)/);
    expect(reason(parseFilter('url("a.svg#f")'))).toMatch(/url\(\)/);
    expect(reason(parseFilter('sparkle(1)'))).toMatch(/sparkle\(\) is not supported/);
    expect(reason(parseFilter('blur(2px) banana'))).toMatch(/expected a filter function/);
    expect(reason(parseFilter('blur(calc(1px + 2px))'))).toBe('calc() is not supported');
  });
});

describe('parseClipPath', () => {
  it('reads inset() with 1 to 4 sides', () => {
    const zero = [[px(0), px(0)], [px(0), px(0)], [px(0), px(0)], [px(0), px(0)]];
    expect(must(parseClipPath('inset(10px)'))).toEqual({ kind: 'inset', sides: [px(10), px(10), px(10), px(10)], radius: zero });
    expect(must(parseClipPath('inset(10px 20%)'))).toMatchObject({ sides: [px(10), pct(20), px(10), pct(20)] });
    expect(must(parseClipPath('inset(1px 2px 3px)'))).toMatchObject({ sides: [px(1), px(2), px(3), px(2)] });
    expect(must(parseClipPath('inset(1px 2px 3px 4px)'))).toMatchObject({ sides: [px(1), px(2), px(3), px(4)] });
    expect(must(parseClipPath('INSET(0 0 0 0)'))).toMatchObject({ kind: 'inset' });
  });

  it('reads inset() with round', () => {
    expect(must(parseClipPath('inset(0 round 12px)'))).toMatchObject({
      radius: [[px(12), px(12)], [px(12), px(12)], [px(12), px(12)], [px(12), px(12)]],
    });
    expect(must(parseClipPath('inset(5% 10% round 10px 20px 30px 40px)'))).toMatchObject({
      sides: [pct(5), pct(10), pct(5), pct(10)],
      radius: [[px(10), px(10)], [px(20), px(20)], [px(30), px(30)], [px(40), px(40)]],
    });
    expect(must(parseClipPath('inset(0 round 10px / 20px)'))).toMatchObject({
      radius: [[px(10), px(20)], [px(10), px(20)], [px(10), px(20)], [px(10), px(20)]],
    });
  });

  it('reads circle() with defaults, radius and position', () => {
    expect(must(parseClipPath('circle()'))).toEqual({ kind: 'circle', r: 'closest-side', cx: pct(50), cy: pct(50) });
    expect(must(parseClipPath('circle(50%)'))).toEqual({ kind: 'circle', r: pct(50), cx: pct(50), cy: pct(50) });
    expect(must(parseClipPath('circle(100px at 20% 30%)'))).toEqual({ kind: 'circle', r: px(100), cx: pct(20), cy: pct(30) });
    expect(must(parseClipPath('circle(farthest-side at top left)'))).toEqual({
      kind: 'circle',
      r: 'farthest-side',
      cx: pct(0),
      cy: pct(0),
    });
    expect(must(parseClipPath('circle(at center)'))).toMatchObject({ r: 'closest-side', cx: pct(50), cy: pct(50) });
  });

  it('reads ellipse()', () => {
    expect(must(parseClipPath('ellipse()'))).toEqual({
      kind: 'ellipse',
      rx: 'closest-side',
      ry: 'closest-side',
      cx: pct(50),
      cy: pct(50),
    });
    expect(must(parseClipPath('ellipse(40% 20% at 50% 0)'))).toEqual({ kind: 'ellipse', rx: pct(40), ry: pct(20), cx: pct(50), cy: px(0) });
    expect(must(parseClipPath('ellipse(closest-side farthest-side)'))).toMatchObject({ rx: 'closest-side', ry: 'farthest-side' });
  });

  it('reads polygon() and path()', () => {
    expect(must(parseClipPath('polygon(50% 0%, 100% 100%, 0% 100%)'))).toEqual({
      kind: 'polygon',
      points: [[pct(50), pct(0)], [pct(100), pct(100)], [pct(0), pct(100)]],
    });
    expect(must(parseClipPath('polygon(nonzero, 0 0, 10px 0, 0 10px)'))).toMatchObject({ kind: 'polygon' });
    expect(must(parseClipPath('polygon(evenodd, 0 0, 10px 0, 0 10px)'))).toMatchObject({ fillRule: 'evenodd' });
    expect(must(parseClipPath("path('M0 0 L 100 0 L 50 80 Z')"))).toEqual({ kind: 'path', d: 'M0 0 L 100 0 L 50 80 Z' });
    expect(must(parseClipPath('path(evenodd, "M0 0h10v10z")'))).toEqual({ kind: 'path', d: 'M0 0h10v10z', fillRule: 'evenodd' });
  });

  it('accepts a border-box reference box', () => {
    expect(must<ClipShape>(parseClipPath('circle(50%) border-box'))).toMatchObject({ kind: 'circle' });
    expect(must<ClipShape>(parseClipPath('border-box inset(0)'))).toMatchObject({ kind: 'inset' });
  });

  it('gives a reason for what is not supported or does not parse', () => {
    expect(reason(parseClipPath('circle(50%) padding-box'))).toMatch(/padding-box.*not supported/);
    expect(reason(parseClipPath('inset(0) content-box'))).toMatch(/content-box/);
    expect(reason(parseClipPath('fill-box'))).toMatch(/fill-box/);
    expect(reason(parseClipPath('border-box'))).toMatch(/without a shape/);
    expect(reason(parseClipPath('url(#clip)'))).toMatch(/url\(\)/);
    expect(reason(parseClipPath('none'))).toMatch(/none/);
    expect(reason(parseClipPath('rect(0 10px 10px 0)'))).toMatch(/rect\(\) is not supported/);
    expect(reason(parseClipPath('xywh(0 0 10px 10px)'))).toMatch(/xywh/);
    expect(reason(parseClipPath('star(5)'))).toMatch(/star\(\)/);
    expect(reason(parseClipPath('inset()'))).toMatch(/1 to 4 lengths/);
    expect(reason(parseClipPath('inset(1px 2px 3px 4px 5px)'))).toMatch(/1 to 4 lengths/);
    expect(reason(parseClipPath('circle(1px 2px)'))).toMatch(/one radius/);
    expect(reason(parseClipPath('circle(-5px)'))).toMatch(/negative/);
    expect(reason(parseClipPath('ellipse(1px)'))).toMatch(/two radii/);
    expect(reason(parseClipPath('polygon()'))).toMatch(/at least one point/);
    expect(reason(parseClipPath('polygon(0 0, 10px)'))).toMatch(/two lengths/);
    expect(reason(parseClipPath('polygon(sideways, 0 0)'))).toMatch(/not a fill rule/);
    expect(reason(parseClipPath('path()'))).toMatch(/needs path data/);
    expect(reason(parseClipPath('path(M0 0)'))).toMatch(/quoted/);
    expect(reason(parseClipPath('circle(50%) circle(50%)'))).toMatch(/one shape/);
    expect(reason(parseClipPath('circle(50% at 10px 20px 30px 40px)'))).toMatch(/edge-offset/);
    expect(reason(parseClipPath('inset(calc(10px + 1%))'))).toBe('calc() is not supported');
  });
});

describe('effect properties in parseStyle', () => {
  it('stores none as an empty list, and clipPath none as the string', () => {
    const { style, unsupported } = parseStyle({ boxShadow: 'none', filter: 'none', textShadow: 'none', clipPath: 'none', transform: 'none' });
    expect(unsupported).toEqual([]);
    expect(style).toEqual({ boxShadow: [], filter: [], textShadow: [], clipPath: 'none', transform: [] });
  });

  it('reports the property name as written', () => {
    const { unsupported } = parseStyle({ boxShadow: '1px', WebkitMaskImage: 'image-set(url(a.png) 1x)' });
    expect(unsupported.map((d) => d.property)).toEqual(['boxShadow', 'WebkitMaskImage']);
    expect(unsupported[0]).toEqual({ property: 'boxShadow', value: '1px', reason: 'a shadow needs 2 to 4 lengths, found 1' });
  });
});
