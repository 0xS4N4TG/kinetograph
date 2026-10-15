import { describe, expect, it } from 'vitest';
import { parseStyle } from '../src/css/index.js';

const px = (value: number) => ({ unit: 'px' as const, value });
const pct = (value: number) => ({ unit: '%' as const, value });
const rgba = (r: number, g: number, b: number, a = 1) => ({ r, g, b, a });

describe('parseStyle: values as React passes them', () => {
  it('reads a number as px, except for the unitless properties', () => {
    const { style, unsupported } = parseStyle({
      width: 100, marginTop: 0, fontSize: 40, opacity: 0.5, zIndex: 3, fontWeight: 700, lineHeight: 1.4, flexGrow: 2, order: 1,
      aspectRatio: 1.5,
    });
    expect(unsupported).toEqual([]);
    expect(style).toMatchObject({
      width: px(100), margin: [px(0), px(0), px(0), px(0)], fontSize: px(40), opacity: 0.5, zIndex: 3, fontWeight: 700,
      lineHeight: 1.4, flexGrow: 2, order: 1, aspectRatio: 1.5,
    });
  });

  it('skips null, undefined, booleans and the empty string, as React does', () => {
    const { style, unsupported } = parseStyle({ width: undefined, height: null, color: '', display: false, opacity: true, className: undefined });
    expect(style).toEqual({});
    expect(unsupported).toEqual([]);
  });

  it('refuses values React would not pass to the browser as a length', () => {
    const { style, unsupported } = parseStyle({ width: NaN, height: Infinity, left: {}, top: () => 1 });
    expect(style).toEqual({});
    expect(unsupported.map((d) => d.property)).toEqual(['width', 'height', 'left', 'top']);
    expect(unsupported[0]).toEqual({ property: 'width', value: 'NaN', reason: 'NaN is not a finite number' });
    expect(unsupported[2]!.reason).toMatch(/object is not a style value/);
  });

  it('ignores !important and surrounding space, and reads uppercase keywords', () => {
    expect(parseStyle({ color: ' RED !important ', display: 'FLEX', width: '10PX !IMPORTANT' }).style).toEqual({
      color: rgba(255, 0, 0), display: 'flex', width: px(10),
    });
  });

  it('clamps opacity and reads a percentage', () => {
    expect(parseStyle({ opacity: 1.5 }).style.opacity).toBe(1);
    expect(parseStyle({ opacity: -1 }).style.opacity).toBe(0);
    expect(parseStyle({ opacity: '50%' }).style.opacity).toBe(0.5);
    expect(parseStyle({ opacity: '.25' }).style.opacity).toBe(0.25);
    expect(parseStyle({ opacity: 'half' }).unsupported[0]!.reason).toMatch(/number or percentage/);
  });
});

describe('parseStyle: names', () => {
  it('folds Webkit-prefixed names into the unprefixed one', () => {
    expect(parseStyle({ WebkitMaskImage: 'url(m.png)', WebkitBackgroundClip: 'text', WebkitTransform: 'scale(2)', WebkitFilter: 'blur(2px)' }).style).toEqual({
      maskImage: [{ kind: 'url', url: 'm.png' }],
      backgroundClip: 'text',
      transform: [{ op: 'scale', x: 2, y: 2, z: 1 }],
      filter: [{ op: 'blur', radius: px(2) }],
    });
  });

  it('reports a prefixed name with no unprefixed counterpart under its own name', () => {
    const { unsupported } = parseStyle({ WebkitBoxReflect: 'below', MozAppearance: 'none', msTransform: 'none' });
    expect(unsupported.map((d) => d.property)).toEqual(['WebkitBoxReflect', 'MozAppearance', 'msTransform']);
  });

  it('lets a prefixed and an unprefixed name override each other in key order', () => {
    expect(parseStyle({ transform: 'scale(2)', WebkitTransform: 'scale(3)' }).style.transform).toEqual([{ op: 'scale', x: 3, y: 3, z: 1 }]);
    expect(parseStyle({ WebkitTransform: 'scale(3)', transform: 'scale(2)' }).style.transform).toEqual([{ op: 'scale', x: 2, y: 2, z: 1 }]);
  });

  it('reads kebab-case names as the browser would', () => {
    expect(parseStyle({ 'background-color': 'red', '-webkit-mask-image': 'none' }).style).toEqual({
      backgroundColor: rgba(255, 0, 0), maskImage: [],
    });
  });

  it('ignores the properties COMPAT.md §4.1 lists, without a diagnostic', () => {
    const ignored = {
      pointerEvents: 'none', cursor: 'pointer', userSelect: 'none', willChange: 'transform', contain: 'paint', isolation: 'isolate',
      backfaceVisibility: 'hidden', fontDisplay: 'swap', WebkitFontSmoothing: 'antialiased', MozOsxFontSmoothing: 'grayscale',
      textRendering: 'optimizeLegibility', imageRendering: 'pixelated', WebkitUserSelect: 'none',
    };
    expect(parseStyle(ignored)).toEqual({ style: {}, unsupported: [] });
  });

  it('ignores custom properties on their own', () => {
    expect(parseStyle({ '--accent': '#f00', color: 'red' })).toEqual({ style: { color: rgba(255, 0, 0) }, unsupported: [] });
  });

  it('reports every other property as not supported, with the value as written', () => {
    const { style, unsupported } = parseStyle({
      outline: '1px solid red', float: 'left', cssFloat: 'left', transition: 'all 1s', animation: 'spin 1s', backdropFilter: 'blur(4px)',
      translate: '10px', rotate: '10deg', scale: 2, mask: 'none', gridTemplateColumns: '1fr 1fr', clip: 'rect(0,0,0,0)', content: '"x"',
    });
    expect(style).toEqual({});
    expect(unsupported.map((d) => d.property)).toEqual([
      'outline', 'float', 'cssFloat', 'transition', 'animation', 'backdropFilter', 'translate', 'rotate', 'scale', 'mask',
      'gridTemplateColumns', 'clip', 'content',
    ]);
    expect(unsupported.every((d) => d.reason === 'not supported')).toBe(true);
    expect(unsupported[0]).toEqual({ property: 'outline', value: '1px solid red', reason: 'not supported' });
    expect(unsupported[8]!.value).toBe('2');
  });
});

describe('parseStyle: values that are not read', () => {
  it('refuses calc(), var(), env() and attr() in any property', () => {
    const { style, unsupported } = parseStyle({
      width: 'calc(100% - 20px)', color: 'var(--c)', top: 'env(safe-area-inset-top)', content: 'attr(x)', margin: '0 calc(1px)',
      transform: 'translate(calc(50% - 1px), 0)', background: 'linear-gradient(red, var(--b))', fontSize: 'clamp(1rem, 2vw, 3rem)',
    });
    expect(style).toEqual({});
    expect(unsupported.map((d) => d.reason)).toEqual([
      'calc() is not supported', 'var() is not supported', 'env() is not supported', 'not supported', 'calc() is not supported',
      'calc() is not supported', 'var() is not supported', 'clamp() is not supported',
    ]);
  });

  it('refuses the CSS-wide keywords', () => {
    const { style, unsupported } = parseStyle({ color: 'inherit', width: 'initial', display: 'unset', margin: 'revert' });
    expect(style).toEqual({});
    expect(unsupported.map((d) => d.reason)).toEqual([
      'the CSS-wide keyword `inherit` is not supported', 'the CSS-wide keyword `initial` is not supported',
      'the CSS-wide keyword `unset` is not supported', 'the CSS-wide keyword `revert` is not supported',
    ]);
  });

  it('keeps going after a bad value, and keeps what was set before it', () => {
    const { style, unsupported } = parseStyle({ color: 'red', width: 'wide', height: 50, color2: 1 });
    expect(style).toEqual({ color: rgba(255, 0, 0), height: px(50) });
    expect(unsupported.map((d) => d.property)).toEqual(['width', 'color2']);
  });

  it('keeps the earlier value when a later declaration is invalid, as CSS does', () => {
    const { style, unsupported } = parseStyle({ width: 10, WebkitTransform: 'scale(2)', transform: 'wiggle(1)' });
    expect(style).toEqual({ width: px(10), transform: [{ op: 'scale', x: 2, y: 2, z: 1 }] });
    expect(unsupported).toHaveLength(1);
  });
});

describe('parseStyle: a Remotion-style component', () => {
  const title = {
    position: 'absolute',
    left: '50%',
    top: '50%',
    transform: 'translate(-50%, -50%) rotate(-3deg) scale(1.08)',
    transformOrigin: 'center center',
    width: 1400,
    padding: '24px 48px',
    margin: 0,
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    overflow: 'hidden',
    opacity: 0.92,
    zIndex: 4,
    background: 'linear-gradient(135deg, #ff6a3d 0%, #ffb347 55%, rgba(255, 255, 255, 0.9) 100%)',
    borderRadius: 32,
    border: '4px solid #111',
    boxShadow: '0 30px 60px -12px rgba(0, 0, 0, 0.45), 0 0 0 8px rgba(255, 255, 255, 0.12), inset 0 2px 0 rgba(255, 255, 255, 0.6)',
    filter: 'drop-shadow(0 8px 16px rgba(0,0,0,0.3)) saturate(1.2)',
    clipPath: 'inset(0 round 32px)',
    WebkitMaskImage: 'linear-gradient(to bottom, #000 80%, transparent 100%)',
    maskSize: '100% 100%',
    mixBlendMode: 'normal',
    fontFamily: '"Space Grotesk", -apple-system, sans-serif',
    fontSize: 96,
    fontWeight: 800,
    fontStyle: 'normal',
    lineHeight: 1.05,
    letterSpacing: '-0.02em',
    textAlign: 'center',
    textTransform: 'uppercase',
    color: '#fff',
    textShadow: '0 4px 24px rgba(0,0,0,0.5)',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    willChange: 'transform',
  };

  it('reads every property', () => {
    const { style, unsupported } = parseStyle(title);
    expect(unsupported).toEqual([]);
    expect(style.position).toBe('absolute');
    expect(style.inset).toEqual([pct(50), 'auto', 'auto', pct(50)]);
    expect(style.transform).toEqual([
      { op: 'translate', x: pct(-50), y: pct(-50), z: px(0) },
      { op: 'rotate', axis: 'z', angle: -3 },
      { op: 'scale', x: 1.08, y: 1.08, z: 1 },
    ]);
    expect(style.transformOrigin).toEqual([pct(50), pct(50), px(0)]);
    expect(style.width).toEqual(px(1400));
    expect(style.padding).toEqual([px(24), px(48), px(24), px(48)]);
    expect(style.margin).toEqual([px(0), px(0), px(0), px(0)]);
    expect(style).toMatchObject({
      boxSizing: 'border-box', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      rowGap: px(16), columnGap: px(16), overflowX: 'hidden', overflowY: 'hidden', opacity: 0.92, zIndex: 4,
    });
    expect(style.backgroundImage).toEqual([
      {
        kind: 'linear',
        angle: 135,
        repeating: false,
        stops: [
          { color: rgba(255, 106, 61), position: pct(0) },
          { color: rgba(255, 179, 71), position: pct(55) },
          { color: rgba(255, 255, 255, 0.9), position: pct(100) },
        ],
      },
    ]);
    expect(style.backgroundColor).toEqual(rgba(0, 0, 0, 0));
    expect(style.borderRadius).toEqual(Array(4).fill([px(32), px(32)]));
    expect(style.borderWidth).toEqual(Array(4).fill(px(4)));
    expect(style.borderStyle).toEqual(Array(4).fill('solid'));
    expect(style.borderColor).toEqual(Array(4).fill(rgba(17, 17, 17)));
    expect(style.boxShadow).toHaveLength(3);
    expect(style.boxShadow![0]).toMatchObject({ inset: false, y: px(30), blur: px(60), spread: px(-12), color: rgba(0, 0, 0, 0.45) });
    expect(style.boxShadow![1]).toMatchObject({ inset: false, blur: px(0), spread: px(8) });
    expect(style.boxShadow![2]).toMatchObject({ inset: true, y: px(2) });
    expect(style.filter).toEqual([
      { op: 'drop-shadow', x: px(0), y: px(8), blur: px(16), color: rgba(0, 0, 0, 0.3) },
      { op: 'saturate', amount: 1.2 },
    ]);
    expect(style.clipPath).toMatchObject({ kind: 'inset', radius: Array(4).fill([px(32), px(32)]) });
    expect(style.maskImage).toHaveLength(1);
    expect(style.maskImage![0]).toMatchObject({ kind: 'linear', angle: 180 });
    expect(style.maskSize).toEqual([[pct(100), pct(100)]]);
    expect(style.mixBlendMode).toBe('normal');
    expect(style.fontFamily).toEqual(['Space Grotesk', '-apple-system', 'sans-serif']);
    expect(style).toMatchObject({
      fontSize: px(96), fontWeight: 800, fontStyle: 'normal', lineHeight: 1.05, letterSpacing: { unit: 'em', value: -0.02 },
      textAlign: 'center', textTransform: 'uppercase', color: rgba(255, 255, 255), whiteSpace: 'nowrap',
    });
    expect(style.textShadow).toEqual([{ x: px(0), y: px(4), blur: px(24), color: rgba(0, 0, 0, 0.5) }]);
    expect('pointerEvents' in style).toBe(false);
  });

  it('reports exactly the properties that are not drawn', () => {
    const { unsupported } = parseStyle({ ...title, textDecoration: 'underline', outline: '2px solid red', backdropFilter: 'blur(8px)', width: 'fit-content' });
    expect(unsupported.map((d) => d.property)).toEqual(['width', 'outline', 'backdropFilter']);
  });
});
