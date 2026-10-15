import { describe, expect, it } from 'vitest';
import {
  parseBackgroundImage,
  parseBackgroundPosition,
  parseBackgroundRepeat,
  parseBackgroundSize,
  parseStyle,
  type BackgroundImage,
  type Diagnostic,
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
const one = (value: string): BackgroundImage => must(parseBackgroundImage(value))[0]!;

describe('linear-gradient', () => {
  it('defaults to 180deg (to bottom)', () => {
    expect(one('linear-gradient(red, blue)')).toEqual({
      kind: 'linear',
      angle: 180,
      repeating: false,
      stops: [
        { color: rgba(255, 0, 0), position: null },
        { color: rgba(0, 0, 255), position: null },
      ],
    });
  });

  it('reads a single colour stop, as Chrome does', () => {
    expect(one('linear-gradient(red)')).toMatchObject({ stops: [{ color: rgba(255, 0, 0), position: null }] });
  });

  it('reads angles in every unit', () => {
    expect(one('linear-gradient(45deg, red, blue)')).toMatchObject({ angle: 45 });
    expect(one('linear-gradient(0.25turn, red, blue)')).toMatchObject({ angle: 90 });
    expect(one('linear-gradient(100grad, red, blue)')).toMatchObject({ angle: 90 });
    expect(one('linear-gradient(0, red, blue)')).toMatchObject({ angle: 0 });
    expect((one('linear-gradient(1.5707963267948966rad, red, blue)') as { angle: number }).angle).toBeCloseTo(90);
    expect(one('linear-gradient(-30deg, red, blue)')).toMatchObject({ angle: -30 });
  });

  it('reads sides and corners', () => {
    expect(one('linear-gradient(to top, red, blue)')).toMatchObject({ angle: 0 });
    expect(one('linear-gradient(to right, red, blue)')).toMatchObject({ angle: 90 });
    expect(one('linear-gradient(to bottom, red, blue)')).toMatchObject({ angle: 180 });
    expect(one('linear-gradient(to left, red, blue)')).toMatchObject({ angle: 270 });
    expect(one('linear-gradient(to top right, red, blue)')).toMatchObject({ angle: 'top right' });
    expect(one('linear-gradient(to right top, red, blue)')).toMatchObject({ angle: 'top right' });
    expect(one('linear-gradient(to left bottom, red, blue)')).toMatchObject({ angle: 'bottom left' });
    expect(one('linear-gradient(to bottom left, red, blue)')).toMatchObject({ angle: 'bottom left' });
  });

  it('reads one or two positions per colour', () => {
    expect(one('linear-gradient(90deg, #000 0%, #fff 50% 75%, rgba(0,0,0,0) 100%)')).toMatchObject({
      stops: [
        { color: rgba(0, 0, 0), position: pct(0) },
        { color: rgba(255, 255, 255), position: pct(50) },
        { color: rgba(255, 255, 255), position: pct(75) },
        { color: rgba(0, 0, 0, 0), position: pct(100) },
      ],
    });
    expect(one('linear-gradient(red 10px, blue 2em)')).toMatchObject({
      stops: [{ position: px(10) }, { position: { unit: 'em', value: 2 } }],
    });
    expect(one('linear-gradient(red 0, blue)')).toMatchObject({ stops: [{ position: px(0) }, { position: null }] });
  });

  it('keeps currentcolor, transparent and function colours as stops', () => {
    expect(one('linear-gradient(currentColor, transparent)')).toMatchObject({
      stops: [{ color: 'currentcolor' }, { color: rgba(0, 0, 0, 0) }],
    });
    expect(one('linear-gradient(hsl(0 100% 50%), rgb(0 0 255 / .5))')).toMatchObject({
      stops: [{ color: rgba(255, 0, 0) }, { color: rgba(0, 0, 255, 0.5) }],
    });
  });

  it('reads the repeating form', () => {
    expect(one('repeating-linear-gradient(45deg, red 0 10px, blue 10px 20px)')).toMatchObject({
      kind: 'linear',
      repeating: true,
      angle: 45,
    });
  });

  it('gives a reason for bad gradients', () => {
    expect(reason(parseBackgroundImage('linear-gradient(45deg)'))).toMatch(/needs a colour stop/);
    expect(reason(parseBackgroundImage('linear-gradient()'))).toMatch(/needs colour stops/);
    expect(reason(parseBackgroundImage('linear-gradient(red, 50%, blue)'))).toMatch(/colour hints/);
    expect(reason(parseBackgroundImage('linear-gradient(red 1 2 3, blue)'))).toMatch(/at most two positions/);
    expect(reason(parseBackgroundImage('linear-gradient(to, red, blue)'))).toMatch(/one side or one vertical/);
    expect(reason(parseBackgroundImage('linear-gradient(to top bottom, red, blue)'))).toMatch(/vertical and one horizontal/);
    expect(reason(parseBackgroundImage('linear-gradient(to north, red, blue)'))).toMatch(/side or corner/);
    expect(reason(parseBackgroundImage('linear-gradient(45, red, blue)'))).toMatch(/before the colour stops/);
    expect(reason(parseBackgroundImage('linear-gradient(red, notacolour)'))).toMatch(/expected a colour stop/);
    expect(reason(parseBackgroundImage('linear-gradient(in oklab, red, blue)'))).toMatch(/interpolation/);
    expect(reason(parseBackgroundImage('linear-gradient(red calc(10px + 5%), blue)'))).toBe('calc() is not supported');
    expect(reason(parseBackgroundImage('linear-gradient(var(--a), blue)'))).toBe('var() is not supported');
    expect(reason(parseBackgroundImage('-webkit-linear-gradient(left, red, blue)'))).toMatch(/prefixed/);
    expect(reason(parseBackgroundImage('linear-gradient(red, blue'))).toMatch(/unclosed/);
  });
});

describe('radial-gradient', () => {
  const stops = [
    { color: rgba(255, 0, 0), position: null },
    { color: rgba(0, 0, 255), position: null },
  ];

  it('defaults to an ellipse, farthest-corner, centred', () => {
    expect(one('radial-gradient(red, blue)')).toEqual({
      kind: 'radial',
      shape: 'ellipse',
      size: 'farthest-corner',
      cx: pct(50),
      cy: pct(50),
      repeating: false,
      stops,
    });
  });

  it('reads shape, size keywords and position', () => {
    expect(one('radial-gradient(circle, red, blue)')).toMatchObject({ shape: 'circle', size: 'farthest-corner' });
    expect(one('radial-gradient(circle closest-side at 25% 75%, red, blue)')).toMatchObject({
      shape: 'circle',
      size: 'closest-side',
      cx: pct(25),
      cy: pct(75),
    });
    expect(one('radial-gradient(farthest-side circle, red, blue)')).toMatchObject({ shape: 'circle', size: 'farthest-side' });
    expect(one('radial-gradient(ellipse closest-corner at top, red, blue)')).toMatchObject({
      shape: 'ellipse',
      size: 'closest-corner',
      cx: pct(50),
      cy: pct(0),
    });
    expect(one('radial-gradient(at left bottom, red, blue)')).toMatchObject({ cx: pct(0), cy: pct(100) });
  });

  it('reads explicit sizes: one length is a circle, two an ellipse', () => {
    expect(one('radial-gradient(100px, red, blue)')).toMatchObject({ shape: 'circle', size: [px(100), px(100)] });
    expect(one('radial-gradient(circle 40px at 10px 20px, red, blue)')).toMatchObject({
      shape: 'circle',
      size: [px(40), px(40)],
      cx: px(10),
      cy: px(20),
    });
    expect(one('radial-gradient(50% 30%, red, blue)')).toMatchObject({ shape: 'ellipse', size: [pct(50), pct(30)] });
    expect(one('radial-gradient(ellipse 100px 50px at center, red, blue)')).toMatchObject({ size: [px(100), px(50)] });
  });

  it('reads the repeating form and stop positions', () => {
    expect(one('repeating-radial-gradient(circle, red 0 10px, blue 10px 20px)')).toMatchObject({
      repeating: true,
      stops: [{ position: px(0) }, { position: px(10) }, { position: px(10) }, { position: px(20) }],
    });
  });

  it('gives a reason for bad gradients', () => {
    expect(reason(parseBackgroundImage('radial-gradient(circle 10px 20px, red, blue)'))).toMatch(/one radius/);
    expect(reason(parseBackgroundImage('radial-gradient(ellipse 10px, red, blue)'))).toMatch(/two radii/);
    expect(reason(parseBackgroundImage('radial-gradient(10px 20px 30px, red, blue)'))).toMatch(/at most two/);
    expect(reason(parseBackgroundImage('radial-gradient(circle closest-side farthest-side, red, blue)'))).toMatch(/twice/);
    expect(reason(parseBackgroundImage('radial-gradient(circle ellipse, red, blue)'))).toMatch(/twice/);
    expect(reason(parseBackgroundImage('radial-gradient(10%, red, blue)'))).toMatch(/percentage/);
    expect(reason(parseBackgroundImage('radial-gradient(-10px, red, blue)'))).toMatch(/negative/);
    expect(reason(parseBackgroundImage('radial-gradient(at left 10px top 20px, red, blue)'))).toMatch(/edge-offset/);
    expect(reason(parseBackgroundImage('radial-gradient(sphere, red, blue)'))).toMatch(/unexpected `sphere`/);
    expect(reason(parseBackgroundImage('radial-gradient(in srgb, red, blue)'))).toMatch(/interpolation/);
  });
});

describe('conic-gradient', () => {
  it('defaults to from 0deg at the centre', () => {
    expect(one('conic-gradient(red, blue)')).toEqual({
      kind: 'conic',
      angle: 0,
      cx: pct(50),
      cy: pct(50),
      repeating: false,
      stops: [
        { color: rgba(255, 0, 0), position: null },
        { color: rgba(0, 0, 255), position: null },
      ],
    });
  });

  it('reads from, at and angle stops (as percentages of a turn)', () => {
    expect(one('conic-gradient(from 90deg at 25% 75%, red 0deg, blue 180deg, red 360deg)')).toMatchObject({
      angle: 90,
      cx: pct(25),
      cy: pct(75),
      stops: [{ position: pct(0) }, { position: pct(50) }, { position: pct(100) }],
    });
    expect(one('conic-gradient(from 0.25turn, red 25%, blue 0.5turn)')).toMatchObject({
      angle: 90,
      stops: [{ position: pct(25) }, { position: pct(50) }],
    });
    expect(one('conic-gradient(at top left, red, blue)')).toMatchObject({ cx: pct(0), cy: pct(0) });
    expect(one('repeating-conic-gradient(red 0 10%, blue 10% 20%)')).toMatchObject({ repeating: true });
  });

  it('gives a reason for bad gradients', () => {
    expect(reason(parseBackgroundImage('conic-gradient(red 10px, blue)'))).toMatch(/angle or percentage/);
    expect(reason(parseBackgroundImage('conic-gradient(from, red, blue)'))).toMatch(/angle/);
    expect(reason(parseBackgroundImage('conic-gradient(sideways, red, blue)'))).toMatch(/unexpected `sideways`/);
  });
});

describe('url() and image lists', () => {
  it('reads quoted and bare urls', () => {
    expect(must(parseBackgroundImage('url(a.png)'))).toEqual([{ kind: 'url', url: 'a.png' }]);
    expect(must(parseBackgroundImage('url("b c.png")'))).toEqual([{ kind: 'url', url: 'b c.png' }]);
    expect(must(parseBackgroundImage("URL( 'x.svg#y' )"))).toEqual([{ kind: 'url', url: 'x.svg#y' }]);
    expect(must(parseBackgroundImage('url(data:image/png;base64,AAA=)'))).toEqual([{ kind: 'url', url: 'data:image/png;base64,AAA=' }]);
  });

  it('reads a comma list, first layer on top, and none as empty', () => {
    const r = must(parseBackgroundImage('linear-gradient(red, blue), url(a.png), radial-gradient(red, blue)'));
    expect(r.map((i) => i.kind)).toEqual(['linear', 'url', 'radial']);
    expect(must(parseBackgroundImage('none'))).toEqual([]);
  });

  it('refuses none among layers, and other image functions', () => {
    expect(reason(parseBackgroundImage('none, url(a.png)'))).toMatch(/none/);
    expect(reason(parseBackgroundImage('image-set(url(a.png) 1x)'))).toMatch(/image-set\(\) is not supported/);
    expect(reason(parseBackgroundImage('cross-fade(url(a.png), url(b.png))'))).toMatch(/cross-fade/);
    expect(reason(parseBackgroundImage('red'))).toMatch(/expected an image/);
    expect(reason(parseBackgroundImage('url(a.png) url(b.png)'))).toMatch(/one image per layer/);
    expect(reason(parseBackgroundImage('url("a.png'))).toMatch(/unterminated/);
  });
});

describe('background-size, position and repeat', () => {
  it('reads sizes', () => {
    expect(must(parseBackgroundSize('cover'))).toEqual(['cover']);
    expect(must(parseBackgroundSize('contain, auto'))).toEqual(['contain', ['auto', 'auto']]);
    expect(must(parseBackgroundSize('50%'))).toEqual([[pct(50), 'auto']]);
    expect(must(parseBackgroundSize('100px auto'))).toEqual([[px(100), 'auto']]);
    expect(must(parseBackgroundSize('10% 20%, 5px 6px'))).toEqual([[pct(10), pct(20)], [px(5), px(6)]]);
  });

  it('refuses bad sizes', () => {
    expect(reason(parseBackgroundSize('cover cover'))).toMatch(/invalid|not a|expected/i);
    expect(reason(parseBackgroundSize('-10px'))).toMatch(/negative/);
    expect(reason(parseBackgroundSize('10px 20px 30px'))).toMatch(/1 to 2 sizes/);
    expect(reason(parseBackgroundSize('big'))).toMatch(/expected a length/);
  });

  it('reads positions', () => {
    expect(must(parseBackgroundPosition('center'))).toEqual([[pct(50), pct(50)]]);
    expect(must(parseBackgroundPosition('left top'))).toEqual([[pct(0), pct(0)]]);
    expect(must(parseBackgroundPosition('right 20px'))).toEqual([[pct(100), px(20)]]);
    expect(must(parseBackgroundPosition('10px 20px, bottom'))).toEqual([[px(10), px(20)], [pct(50), pct(100)]]);
    expect(reason(parseBackgroundPosition('right 10px bottom 20px'))).toMatch(/edge-offset/);
  });

  it('reads repeat styles and normalises them', () => {
    expect(must(parseBackgroundRepeat('no-repeat'))).toEqual(['no-repeat']);
    expect(must(parseBackgroundRepeat('repeat-x, repeat-y'))).toEqual(['repeat-x', 'repeat-y']);
    expect(must(parseBackgroundRepeat('repeat no-repeat'))).toEqual(['repeat-x']);
    expect(must(parseBackgroundRepeat('no-repeat repeat'))).toEqual(['repeat-y']);
    expect(must(parseBackgroundRepeat('space round'))).toEqual(['space round']);
    expect(must(parseBackgroundRepeat('round round'))).toEqual(['round']);
    expect(reason(parseBackgroundRepeat('repeat-x no-repeat'))).toMatch(/not a repeat style/);
    expect(reason(parseBackgroundRepeat('sometimes'))).toMatch(/not a repeat style/);
  });
});

describe('background properties in parseStyle', () => {
  it('reads the longhands', () => {
    const { style, unsupported } = parseStyle({
      backgroundColor: '#112233',
      backgroundImage: 'url(a.png)',
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
      backgroundClip: 'padding-box',
      backgroundOrigin: 'content-box',
    });
    expect(unsupported).toEqual([]);
    expect(style).toEqual({
      backgroundColor: rgba(17, 34, 51),
      backgroundImage: [{ kind: 'url', url: 'a.png' }],
      backgroundSize: ['cover'],
      backgroundPosition: [[pct(50), pct(50)]],
      backgroundRepeat: ['no-repeat'],
      backgroundClip: 'padding-box',
      backgroundOrigin: 'content-box',
    });
  });

  it('expands the shorthand: colour, image, position / size, repeat', () => {
    const { style, unsupported } = parseStyle({ background: '#102030 url(a.png) 10px 20% / 50% auto no-repeat' });
    expect(unsupported).toEqual([]);
    expect(style).toEqual({
      backgroundColor: rgba(16, 32, 48),
      backgroundImage: [{ kind: 'url', url: 'a.png' }],
      backgroundSize: [[pct(50), 'auto']],
      backgroundPosition: [[px(10), pct(20)]],
      backgroundRepeat: ['no-repeat'],
      backgroundOrigin: 'padding-box',
      backgroundClip: 'border-box',
    });
  });

  it('resets what the shorthand leaves out', () => {
    const { style } = parseStyle({ backgroundImage: 'url(a.png)', backgroundSize: 'cover', background: 'red' });
    expect(style).toEqual({
      backgroundColor: rgba(255, 0, 0),
      backgroundImage: [],
      backgroundSize: [['auto', 'auto']],
      backgroundPosition: [[pct(0), pct(0)]],
      backgroundRepeat: ['repeat'],
      backgroundOrigin: 'padding-box',
      backgroundClip: 'border-box',
    });
  });

  it('lets a longhand after the shorthand override it, in key order', () => {
    const { style } = parseStyle({ background: 'red url(a.png)', backgroundColor: 'blue', backgroundSize: 'contain' });
    expect(style.backgroundColor).toEqual(rgba(0, 0, 255));
    expect(style.backgroundSize).toEqual(['contain']);
    expect(style.backgroundImage).toEqual([{ kind: 'url', url: 'a.png' }]);
    const reversed = parseStyle({ backgroundColor: 'blue', background: 'red' });
    expect(reversed.style.backgroundColor).toEqual(rgba(255, 0, 0));
  });

  it('reads a shorthand with gradients, several layers, boxes and function colours', () => {
    const { style, unsupported } = parseStyle({
      background: 'linear-gradient(to right, red, blue) top left / 100% 50% no-repeat, radial-gradient(circle, #fff, #000) center / cover, rgba(0, 0, 0, 0.5)',
    });
    expect(unsupported).toEqual([]);
    expect(style.backgroundImage!.map((i) => i.kind)).toEqual(['linear', 'radial']);
    expect(style.backgroundPosition).toEqual([[pct(0), pct(0)], [pct(50), pct(50)]]);
    expect(style.backgroundSize).toEqual([[pct(100), pct(50)], 'cover']);
    expect(style.backgroundRepeat).toEqual(['no-repeat', 'repeat']);
    expect(style.backgroundColor).toEqual(rgba(0, 0, 0, 0.5));
    const boxes = parseStyle({ background: 'url(a.png) padding-box content-box' }).style;
    expect(boxes.backgroundOrigin).toBe('padding-box');
    expect(boxes.backgroundClip).toBe('content-box');
    expect(parseStyle({ background: 'url(a.png) content-box' }).style).toMatchObject({
      backgroundOrigin: 'content-box',
      backgroundClip: 'content-box',
    });
    expect(parseStyle({ background: 'red text' }).style.backgroundClip).toBe('text');
  });

  it('reports what the shorthand cannot hold', () => {
    const reasons = (v: string) => parseStyle({ background: v }).unsupported.map((d) => d.reason);
    expect(reasons('url(a.png) fixed')[0]).toMatch(/fixed/);
    expect(reasons('red, url(a.png)')[0]).toMatch(/only the last/);
    expect(reasons('none, url(a.png)')[0]).toMatch(/none/);
    expect(reasons('url(a.png) url(b.png)')[0]).toMatch(/twice/);
    expect(reasons('red blue')[0]).toMatch(/twice/);
    expect(reasons('url(a.png) no-repeat repeat-x')[0]).toMatch(/twice/);
    expect(reasons('url(a.png) 10px 20px 30px')[0]).toMatch(/edge-offset/);
    expect(reasons('url(a.png) border-box, url(b.png) padding-box')[0]).toMatch(/per layer/);
    expect(reasons('text content-box')[0]).toMatch(/only be the background clip/);
    expect(reasons('banana')[0]).toMatch(/unexpected `banana`/);
    expect(reasons('calc(1px)')[0]).toBe('calc() is not supported');
    expect(parseStyle({ background: 'red fixed' }).style).toEqual({});
  });

  it('refuses longhand clip and origin that differ per layer', () => {
    expect(parseStyle({ backgroundClip: 'border-box, text' }).unsupported[0]!.reason).toMatch(/per layer/);
    expect(parseStyle({ backgroundClip: 'text, text' }).style.backgroundClip).toBe('text');
    expect(parseStyle({ backgroundOrigin: 'text' }).unsupported[0]!.reason).toMatch(/not one of/);
  });

  it('reads the mask properties, and folds the Webkit prefix', () => {
    const { style, unsupported } = parseStyle({
      WebkitMaskImage: 'linear-gradient(to bottom, #000 60%, transparent)',
      maskSize: '100% 100%',
      WebkitMaskRepeat: 'no-repeat',
      maskPosition: 'center top',
    });
    expect(unsupported).toEqual([]);
    expect(style.maskImage![0]).toMatchObject({ kind: 'linear', angle: 180 });
    expect(style.maskSize).toEqual([[pct(100), pct(100)]]);
    expect(style.maskRepeat).toEqual(['no-repeat']);
    expect(style.maskPosition).toEqual([[pct(50), pct(0)]]);
    expect(parseStyle({ maskImage: 'url(m.png)' }).style.maskImage).toEqual([{ kind: 'url', url: 'm.png' }]);
    expect(parseStyle({ maskImage: 'none' }).style.maskImage).toEqual([]);
  });

  it('does not read the mask shorthand, maskMode or maskComposite', () => {
    const { unsupported } = parseStyle({ mask: 'url(m.png) no-repeat', WebkitMask: 'url(m.png)', maskMode: 'luminance', maskComposite: 'exclude' });
    expect(unsupported.map((d) => d.property)).toEqual(['mask', 'WebkitMask', 'maskMode', 'maskComposite']);
    expect(unsupported.every((d) => d.reason === 'not supported')).toBe(true);
  });
});
