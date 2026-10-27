import { describe, expect, it } from 'vitest';
import { effectCatalog, type Effect, type EffectOf, type EffectType, type SceneJson } from '../src/index.js';

/** One effect of every type with every field set. The `Required` makes the compiler insist on each field, so adding a
 *  field to a type here without the catalog (below) noticing fails the build or the test. */
const fullEffects: { [T in EffectType]: Required<EffectOf<T>> } = {
  blur: { type: 'blur', radius: 24 },
  backdropBlur: { type: 'backdropBlur', radius: 16 },
  glow: { type: 'glow', radius: 24, color: '#ffcc66', intensity: 1.5 },
  chromaticAberration: { type: 'chromaticAberration', amount: 4, angle: 45 },
  dropShadow: { type: 'dropShadow', x: 0, y: 8, blur: 12, spread: 0, color: '#00000080' },
  insetShadow: { type: 'insetShadow', x: 0, y: 6, blur: 10, spread: 0, color: '#000000b3' },
  saturate: { type: 'saturate', amount: 1.5 },
  contrast: { type: 'contrast', amount: 1.2 },
  brightness: { type: 'brightness', amount: 0.8 },
  grayscale: { type: 'grayscale', amount: 1 },
  sepia: { type: 'sepia', amount: 1 },
  invert: { type: 'invert', amount: 1 },
  hueRotate: { type: 'hueRotate', angle: 90 },
  gradientMap: {
    type: 'gradientMap',
    stops: [
      { offset: 0, color: '#0a0030' },
      { offset: 1, color: '#fff8c4' },
    ],
    amount: [
      { frame: 0, value: 0 },
      { frame: 30, value: 1 },
    ],
  },
  lut: { type: 'lut', src: 'looks/thermal.cube', amount: 1, interpolation: 'tetrahedral' },
  colorGrade: {
    type: 'colorGrade',
    intensity: 0.8,
    adjust: { exposure: 0.1 },
    wheels: { shadows: { hue: 220, amount: 0.3, level: 0 } },
    curves: { master: [[0, 0], [1, 1]] },
    hueCurves: { hueVsHue: [[0, 0], [120, 10], [240, 0]] },
    secondaries: [{ key: { hue: { center: 120 } }, correction: { saturation: 0.2 } }],
    lut: { src: 'looks/thermal.cube' },
    vignette: { amount: 0.2 },
    grain: { amount: 0.1, seed: 3 },
    effects: { halftone: 0.9, halftoneSize: 0.4 },
    palette: ['#000000', '#ffffff'],
    time: 1,
    box: [0, 0, 64, 48],
  },
  grain: { type: 'grain', amount: 0.3, size: 3, seed: 21, animate: false, monochrome: false },
  dither: { type: 'dither', mode: 'random', levels: 4, size: 2, seed: 3, animate: true },
  halftone: { type: 'halftone', size: 5, angle: 0, shape: 'line', color: '#ffcc00', invert: true },
  dotMatrix: { type: 'dotMatrix', size: 10, progress: 0.5, order: 'sweep', angle: 45, stagger: 0.4, seed: 1, shape: 'square' },
  displace: {
    type: 'displace',
    scale: 10,
    xChannelSelector: 'B',
    yChannelSelector: 'A',
    turbulence: { type: 'turbulence', baseFrequency: [0.02, 0.08], numOctaves: 2, seed: 11 },
  },
  cornerPin: { type: 'cornerPin', topLeft: [20, 0], topRight: [150, 0], bottomRight: [150, 92], bottomLeft: [0, 80] },
  shader: { type: 'shader', code: 'fn effect(px: vec2<f32>) -> vec4<f32> { return layer(px); }', uniforms: { strength: 12 }, padding: 16 },
};

describe('the 23 effect types', () => {
  it('are all in the union and the catalog', () => {
    const types = Object.keys(fullEffects);
    expect(types).toHaveLength(23);
    expect(effectCatalog.map((e) => e.type).sort()).toEqual([...types].sort());
  });

  it('have catalog entries naming exactly the fields of the type, with their defaults', () => {
    for (const info of effectCatalog) {
      const full = fullEffects[info.type as EffectType] as Record<string, unknown>;
      const fields = Object.keys(full).filter((k) => k !== 'type');
      expect(info.fields.map((f) => f.name).sort(), info.type).toEqual(fields.sort());
      expect(info.description.length, info.type).toBeGreaterThan(10);
      for (const field of info.fields) {
        expect(field.type, `${info.type}.${field.name}`).not.toBe('');
        expect(field.description.length, `${info.type}.${field.name}`).toBeGreaterThan(5);
        // A field is either required or has a default or is a plain optional.
        expect(field.required === true && 'default' in field, `${info.type}.${field.name}`).toBe(false);
      }
    }
  });

  it('mark as required exactly the fields a bare effect cannot do without', () => {
    const required = Object.fromEntries(
      effectCatalog.map((e) => [e.type, e.fields.filter((f) => f.required).map((f) => f.name)]),
    );
    expect(required).toMatchObject({
      blur: ['radius'],
      backdropBlur: ['radius'],
      glow: ['radius'],
      chromaticAberration: ['amount'],
      gradientMap: ['stops'],
      lut: ['src'],
      colorGrade: [],
      grain: ['amount', 'seed'],
      dotMatrix: ['progress'],
      displace: ['scale', 'turbulence'],
      shader: ['code'],
      dropShadow: [],
      saturate: [],
      halftone: [],
    });
  });

  it("carry SCENE.md's defaults", () => {
    const defaults = (type: string) =>
      Object.fromEntries(
        (effectCatalog.find((e) => e.type === type)?.fields ?? []).filter((f) => 'default' in f).map((f) => [f.name, f.default]),
      );
    expect(defaults('dropShadow')).toEqual({ x: 0, y: 0, blur: 0, spread: 0, color: '#000000' });
    expect(defaults('glow')).toEqual({ intensity: 1 });
    expect(defaults('halftone')).toEqual({ size: 8, angle: 45, shape: 'circle', invert: false });
    expect(defaults('dotMatrix')).toEqual({ size: 12, order: 'random', angle: 0, stagger: 0.6, shape: 'circle' });
    expect(defaults('displace')).toEqual({ xChannelSelector: 'R', yChannelSelector: 'G' });
    expect(defaults('grain')).toEqual({ size: 1, animate: true, monochrome: true });
    expect(defaults('dither')).toEqual({ mode: 'ordered', levels: 2, size: 1, animate: false });
    expect(defaults('saturate')).toEqual({ amount: 1 });
    expect(defaults('hueRotate')).toEqual({ angle: 0 });
  });
});

describe('SceneJson', () => {
  it('accepts a scene using every layer kind and the AUTHORING.md §4 additions', () => {
    const effects: Effect[] = Object.values(fullEffects);
    const scene = {
      width: 1280,
      height: 720,
      fps: 30,
      durationInFrames: 90,
      background: '#10131a',
      margin: 44,
      fonts: { 'DM Sans': 'fonts/DMSans-Medium.ttf' },
      camera: { perspective: 700, x: 640, y: 360 },
      layers: [
        {
          id: 'row',
          type: 'group',
          preserve3d: false,
          layout: {
            display: 'flex',
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'space-evenly',
            alignItems: 'baseline',
            alignContent: 'stretch',
            gap: [8, 16],
            padding: [0, 40, 0, 40],
            width: 1080,
            height: 400,
          },
          transform: { x: 1, y: 2, scale: 1, rotation: 3, anchorX: 4, anchorY: 5, originX: 0.5, originY: 0.5, rotateX: 6, rotateY: 7, z: 8 },
          opacity: 0.8,
          blendMode: 'softLight',
          effects,
          clip: { kind: 'inset', top: 1, right: 2, bottom: 3, left: 4, radius: 5 },
          mask: { mode: 'luminance', gradient: { type: 'radial', cx: 0.5, cy: 0.5, r: 0.5, units: 'box', stops: [{ offset: 0, color: '#fff' }, { offset: 1, color: '#000' }] } },
          matte: { layer: 'word', mode: 'luminanceInverted' },
          motionBlur: { samples: 8, shutter: 0.5, frames: [] },
          layoutItem: { position: 'absolute', flexGrow: 1, flexShrink: 0, flexBasis: 'auto', alignSelf: 'center', margin: 8, width: 10, height: 20 },
          children: [
            { id: 'a', type: 'shape', shape: { kind: 'roundedRect', width: 200, height: 120, radius: 12 }, fill: '#f00', stroke: { color: '#fff', width: 2 } },
            { id: 'b', type: 'shape', shape: { kind: 'ellipse', width: 20, height: 20 } },
            { id: 'c', type: 'shape', shape: { kind: 'path', d: 'M0 0L10 10' } },
            { id: 'd', type: 'shape', shape: { kind: 'rect', width: 20, height: 20 } },
            {
              id: 'word',
              type: 'text',
              text: 'hi',
              font: 'DM Sans',
              size: 64,
              color: { type: 'conic', cx: 0.5, cy: 0.5, angle: 90, units: 'box', extend: 'repeat', stops: [{ offset: 0, color: '#fff' }, { offset: 1, color: '#000' }] },
              lineHeight: 1.2,
              maxWidth: 600,
              align: 'center',
              chars: [{ x: 1, y: 2, scale: 1, rotation: 5, opacity: 0.5, color: '#f00' }, null],
            },
            { id: 'img', type: 'image', src: 'a.png', width: 10, height: 10, fit: 'cover' },
            { id: 'img2', type: 'image', src: 'a.png' },
            { id: 'n', type: 'noise', width: 480, height: 270, channels: 'gray', turbulence: { type: 'fractalNoise', baseFrequency: 0.01, numOctaves: 4, seed: 3 } },
            { id: 'm', type: 'meshGradient', width: 480, height: 270, columns: 2, rows: 2, points: [[0, 0], [480, 0], [0, 270], [[{ frame: 0, value: 240 }], 270]], colors: ['#f00', '#0f0', '#00f', '#fff'] },
            { id: 'l', type: 'lottie', src: 'anims/confetti.json', width: 400, height: 400, time: 1.2, loop: true },
          ],
        },
      ],
    } satisfies SceneJson;
    expect(JSON.parse(JSON.stringify(scene))).toEqual(scene);
  });

  it('rejects mistakes at compile time', () => {
    // These lines are checked by `tsc` (npm test runs it first); at runtime they only build values.
    const bad: SceneJson[] = [
      // @ts-expect-error an unknown layer type
      { width: 1, height: 1, fps: 30, durationInFrames: 1, layers: [{ id: 'x', type: 'video' }] },
      // @ts-expect-error a blur needs its radius
      { width: 1, height: 1, fps: 30, durationInFrames: 1, layers: [{ id: 'x', type: 'group', children: [], effects: [{ type: 'blur' }] }] },
      // @ts-expect-error an unknown effect type
      { width: 1, height: 1, fps: 30, durationInFrames: 1, layers: [{ id: 'x', type: 'group', children: [], effects: [{ type: 'wobble' }] }] },
      // @ts-expect-error a literal outside the union
      { width: 1, height: 1, fps: 30, durationInFrames: 1, layers: [{ id: 'x', type: 'group', children: [], blendMode: 'plusLighter' }] },
    ];
    expect(bad).toHaveLength(4);
  });
});
