import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  backdropBlur,
  blur,
  brightness,
  chromaticAberration,
  contrast,
  cornerPin,
  displace,
  dither,
  dotMatrix,
  dropShadow,
  glow,
  gradientMap,
  grain,
  grayscale,
  halftone,
  hueRotate,
  insetShadow,
  invert,
  colorGrade,
  lut,
  motionBlur,
  saturate,
  sepia,
  shader,
  type Effect,
  type Keyframe,
} from '../src/index.js';

const ramp: Keyframe[] = [
  { frame: 0, value: 0 },
  { frame: 30, value: 40, easing: 'easeOut' },
];

describe('effect helpers', () => {
  it('take their one required number bare', () => {
    expect(blur(24)).toEqual({ type: 'blur', radius: 24 });
    expect(backdropBlur(16)).toEqual({ type: 'backdropBlur', radius: 16 });
    expect(glow(16)).toEqual({ type: 'glow', radius: 16 });
    expect(chromaticAberration(4)).toEqual({ type: 'chromaticAberration', amount: 4 });
    expect(saturate(1.5)).toEqual({ type: 'saturate', amount: 1.5 });
    expect(contrast(1.2)).toEqual({ type: 'contrast', amount: 1.2 });
    expect(brightness(0.8)).toEqual({ type: 'brightness', amount: 0.8 });
    expect(grayscale(1)).toEqual({ type: 'grayscale', amount: 1 });
    expect(sepia(1)).toEqual({ type: 'sepia', amount: 1 });
    expect(invert(1)).toEqual({ type: 'invert', amount: 1 });
    expect(hueRotate(90)).toEqual({ type: 'hueRotate', angle: 90 });
  });

  it('keep a bare zero (zero is a value, not a missing argument)', () => {
    expect(blur(0)).toEqual({ type: 'blur', radius: 0 });
    expect(grayscale(0)).toEqual({ type: 'grayscale', amount: 0 });
    expect(hueRotate(0)).toEqual({ type: 'hueRotate', angle: 0 });
  });

  it('take keyframes bare as well', () => {
    expect(blur(ramp)).toEqual({ type: 'blur', radius: ramp });
    expect(hueRotate(ramp)).toEqual({ type: 'hueRotate', angle: ramp });
    expect(saturate(ramp)).toEqual({ type: 'saturate', amount: ramp });
  });

  it('take the object form too', () => {
    expect(blur({ radius: 8 })).toEqual({ type: 'blur', radius: 8 });
    expect(glow({ radius: 24, color: '#ffcc66', intensity: 1.5 })).toEqual({
      type: 'glow',
      radius: 24,
      color: '#ffcc66',
      intensity: 1.5,
    });
    expect(chromaticAberration({ amount: ramp, angle: 45 })).toEqual({
      type: 'chromaticAberration',
      amount: ramp,
      angle: 45,
    });
    expect(hueRotate({ angle: 180 })).toEqual({ type: 'hueRotate', angle: 180 });
    expect(saturate({ amount: 2 })).toEqual({ type: 'saturate', amount: 2 });
  });

  it('leave the amount out of a colour filter called with nothing, so the default of 1 applies', () => {
    expect(grayscale()).toEqual({ type: 'grayscale' });
    expect(sepia()).toEqual({ type: 'sepia' });
    expect(invert()).toEqual({ type: 'invert' });
    expect(hueRotate()).toEqual({ type: 'hueRotate' });
  });

  it('build the shadows from their fields', () => {
    expect(dropShadow({ y: 12, blur: 24 })).toEqual({ type: 'dropShadow', y: 12, blur: 24 });
    expect(dropShadow({ x: 0, y: 8, blur: 12, spread: 0, color: '#00000080' })).toEqual({
      type: 'dropShadow',
      x: 0,
      y: 8,
      blur: 12,
      spread: 0,
      color: '#00000080',
    });
    expect(dropShadow()).toEqual({ type: 'dropShadow' });
    expect(insetShadow({ y: 6, blur: 10, color: '#000000b3' })).toEqual({
      type: 'insetShadow',
      y: 6,
      blur: 10,
      color: '#000000b3',
    });
  });

  it('build gradientMap and lut', () => {
    const stops = [
      { offset: 0, color: '#000' },
      { offset: 1, color: '#3cf' },
    ];
    expect(gradientMap({ stops, amount: ramp })).toEqual({ type: 'gradientMap', stops, amount: ramp });
    expect(lut({ src: 'looks/thermal.cube' })).toEqual({ type: 'lut', src: 'looks/thermal.cube' });
    expect(lut({ src: 'a.cube', amount: 0.5 })).toEqual({ type: 'lut', src: 'a.cube', amount: 0.5 });
  });

  it('build colorGrade', () => {
    expect(colorGrade()).toEqual({ type: 'colorGrade' });
    expect(colorGrade({ effects: { halftone: 0.9 }, palette: ['#000', '#fff'] })).toEqual({
      type: 'colorGrade',
      effects: { halftone: 0.9 },
      palette: ['#000', '#fff'],
    });
  });

  it('take the main field of grain and dither first', () => {
    expect(grain(0.15, { seed: 7 })).toEqual({ type: 'grain', amount: 0.15, seed: 7 });
    expect(grain(0.3, { size: 3, seed: 21, animate: false, monochrome: false })).toEqual({
      type: 'grain',
      amount: 0.3,
      size: 3,
      seed: 21,
      animate: false,
      monochrome: false,
    });
    expect(dither(2)).toEqual({ type: 'dither', levels: 2 });
    expect(dither(4, { mode: 'random', size: 2, seed: 3, animate: true })).toEqual({
      type: 'dither',
      levels: 4,
      mode: 'random',
      size: 2,
      seed: 3,
      animate: true,
    });
    expect(dither()).toEqual({ type: 'dither' });
    expect(dither(undefined, { mode: 'random', seed: 1 })).toEqual({ type: 'dither', mode: 'random', seed: 1 });
  });

  it('build halftone, dotMatrix, displace, cornerPin and shader', () => {
    expect(halftone()).toEqual({ type: 'halftone' });
    expect(halftone({ size: 5, angle: 0, shape: 'line', color: '#ffcc00', invert: true })).toEqual({
      type: 'halftone',
      size: 5,
      angle: 0,
      shape: 'line',
      color: '#ffcc00',
      invert: true,
    });
    expect(dotMatrix({ progress: ramp, seed: 1 })).toEqual({ type: 'dotMatrix', progress: ramp, seed: 1 });
    const turbulence = { type: 'fractalNoise', baseFrequency: 0.04, numOctaves: 4, seed: 7 } as const;
    expect(displace({ scale: 10, turbulence })).toEqual({ type: 'displace', scale: 10, turbulence });
    expect(
      displace({ scale: 5, xChannelSelector: 'B', yChannelSelector: 'A', turbulence }),
    ).toEqual({ type: 'displace', scale: 5, xChannelSelector: 'B', yChannelSelector: 'A', turbulence });
    expect(cornerPin({ topRight: [200, 22], bottomRight: [180, 128] })).toEqual({
      type: 'cornerPin',
      topRight: [200, 22],
      bottomRight: [180, 128],
    });
    expect(shader({ code: 'fn effect(px: vec2<f32>) -> vec4<f32> { return layer(px); }', uniforms: { strength: ramp }, padding: 16 })).toEqual({
      type: 'shader',
      code: 'fn effect(px: vec2<f32>) -> vec4<f32> { return layer(px); }',
      uniforms: { strength: ramp },
      padding: 16,
    });
  });

  it('drop undefined fields, so the emitted JSON has no holes', () => {
    const effect = dropShadow({ x: undefined, y: 4 });
    expect(Object.keys(effect)).toEqual(['type', 'y']);
    expect(Object.keys(blur({ radius: 3 }))).toEqual(['type', 'radius']);
    expect(Object.keys(motionBlur({ samples: undefined }))).toEqual(['type']);
  });

  it('return a value of the Effect union', () => {
    expectTypeOf(blur(1)).toExtend<Effect>();
    expectTypeOf(dropShadow()).toExtend<Effect>();
    expectTypeOf(grain(0.1, { seed: 1 })).toExtend<Effect>();
    const all: Effect[] = [blur(1), dither(2), shader({ code: '' })];
    expect(all.map((e) => e.type)).toEqual(['blur', 'dither', 'shader']);
  });
});

describe('motionBlur marker', () => {
  it('is a plain marker object', () => {
    expect(motionBlur()).toEqual({ type: 'motionBlur' });
    expect(motionBlur({ samples: 8 })).toEqual({ type: 'motionBlur', samples: 8 });
    expect(motionBlur({ samples: 12, shutter: 1 })).toEqual({ type: 'motionBlur', samples: 12, shutter: 1 });
  });
});
