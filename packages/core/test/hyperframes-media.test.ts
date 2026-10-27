import { describe, expect, it } from 'vitest';
import {
  cutToSlots,
  gradeAttribute,
  gradeNotDrawn,
  laneGain,
  localTimelineTime,
  normalizeGrade,
  parseAutomation,
  rateAt,
  rateSpecOf,
  sampleLane,
  seedOf,
  sourceTimeAt,
  timeAtSourceTime,
  TimingResolver,
  type TimedElement,
} from '../src/hyperframes/index.js';

class El implements TimedElement {
  parentElement: El | null = null;
  children: El[] = [];
  id = '';
  constructor(
    public tagName: string,
    public attrs: Record<string, string> = {},
  ) {
    if (attrs.id) this.id = attrs.id;
  }
  add(child: El): El {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  hasAttribute(name: string): boolean {
    return name in this.attrs;
  }
  all(): El[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  querySelectorAll(selector: string): El[] {
    const m = /^\[id="(.*)"\]$/.exec(selector);
    return this.all().filter((e) => m !== null && e.id === m[1]);
  }
}

const resolver = (root: El, media: Record<string, number> = {}): TimingResolver =>
  new TimingResolver({
    mediaDuration: (el) => media[el.id] ?? null,
    timelineDuration: () => null,
    byId: (id) => root.all().find((e) => e.id === id) ?? null,
    byComposition: (id) => [root, ...root.all()].find((e) => e.attrs['data-composition-id'] === id) ?? null,
  });

const automation = (lanes: unknown[]): string => JSON.stringify({ version: 1, lanes });

describe('data-automation lanes', () => {
  it('reads the volume and rate lanes, clamped, sorted, later point winning a tie', () => {
    const a = parseAutomation(
      automation([
        { target: 'volume', points: [{ t: 2, v: 9 }, { t: 0, v: 0.5 }, { t: 2, v: 0.25 }] },
        { target: 'rate', points: [{ t: 0, v: 50 }, { t: 1, v: 0.01 }] },
        { target: 'fx.n1.cutoff', points: [{ t: 0, v: 3 }] },
      ]),
    )!;
    expect(a.volume!.points).toEqual([{ t: 0, v: 0.5 }, { t: 2, v: 0.25 }]);
    expect(a.rate!.points.map((p) => p.v)).toEqual([10, 0.1]);
    expect(parseAutomation('not json')).toBeNull();
    expect(parseAutomation(JSON.stringify({ version: 2, lanes: [] }))).toBeNull();
    expect(parseAutomation(null)).toBeNull();
  });

  it('holds its ends and is linear between points', () => {
    const lane = parseAutomation(automation([{ target: 'volume', points: [{ t: 1, v: 0 }, { t: 3, v: 1 }] }]))!.volume!;
    expect(sampleLane(lane, 0)).toBe(0);
    expect(sampleLane(lane, 2)).toBeCloseTo(0.5, 12);
    expect(sampleLane(lane, 9)).toBe(1);
  });

  it('bends a segment by curve and through a via point', () => {
    const curved = parseAutomation(automation([{ target: 'volume', points: [{ t: 0, v: 0, curve: 0.5 }, { t: 1, v: 1 }] }]))!.volume!;
    // x ^ 2^(2 * 0.5) = x ^ 2
    expect(sampleLane(curved, 0.5)).toBeCloseTo(0.25, 12);
    const via = parseAutomation(automation([{ target: 'volume', points: [{ t: 0, v: 0, viaX: 0.5, viaY: 0.8 }, { t: 1, v: 1 }] }]))!.volume!;
    // The arc passes through its via point and rises monotonically.
    expect(sampleLane(via, 0.5)).toBeCloseTo(0.8, 6);
    let last = -1;
    for (let i = 0; i <= 20; i++) {
      const v = sampleLane(via, i / 20);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });

  it('multiplies the clip gain and caps at +12 dB', () => {
    const lane = parseAutomation(automation([{ target: 'volume', points: [{ t: 0, v: 2 }] }]))!.volume!;
    expect(laneGain(lane, 1, 0)).toBeCloseTo(2, 12);
    expect(laneGain(lane, 3, 0)).toBeCloseTo(10 ** (12 / 20), 12);
    expect(laneGain(lane, 0, 0)).toBe(0);
  });
});

describe('speed ramps', () => {
  const lane = parseAutomation(automation([{ target: 'rate', points: [{ t: 0, v: 1 }, { t: 2, v: 2 }] }]))!.rate!;

  it('integrates the rate to the file time and back', () => {
    // Log-interpolated rate 2^(t/2): the integral is (2^(t/2) - 1) * 2 / ln 2.
    const exact = (t: number): number => ((2 ** (t / 2) - 1) * 2) / Math.LN2;
    expect(sourceTimeAt(lane, 2)).toBeCloseTo(exact(2), 3);
    expect(sourceTimeAt(lane, 1)).toBeCloseTo(exact(1), 3);
    expect(rateAt(lane, 1)).toBeCloseTo(Math.SQRT2, 12);
    for (const t of [0.3, 1, 1.9, 2]) expect(timeAtSourceTime(lane, sourceTimeAt(lane, t))).toBeCloseTo(t, 9);
    // Past the last point the last rate carries on.
    expect(sourceTimeAt(lane, 3)).toBeCloseTo(sourceTimeAt(lane, 2) + 2, 9);
    expect(sourceTimeAt(5, 2)).toBe(10);
  });

  it('is the length a clip has on the timeline', () => {
    const root = new El('div', { 'data-composition-id': 'main', 'data-duration': '30' });
    const ramped = root.add(new El('video', { id: 'v', 'data-start': '1', 'data-automation': automation([{ target: 'rate', points: [{ t: 0, v: 2 }] }]) }));
    const media = new El('video', { id: 'm', 'data-start': '0', 'data-playback-rate': '2x' });
    root.add(ramped);
    root.add(media);
    const r = resolver(root, { v: 10, m: 10 });
    // A constant lane of 2: 10 s of file take 5 s.
    expect(r.duration(ramped)).toBeCloseTo(5, 6);
    // "2x" is 2, as the browser reads a rate.
    expect(rateSpecOf(media)).toBe(2);
    expect(r.duration(media)).toBe(5);
    expect(rateSpecOf(new El('video', { 'data-playback-rate': '99' }))).toBe(10);
    expect(rateSpecOf(new El('video', { 'data-playback-rate': '-1' }))).toBe(1);
  });

  it('moves a nested composition through its host rate lane', () => {
    const clock = { start: 2, hiddenFrom: Infinity, playbackStart: 1, rate: lane };
    expect(localTimelineTime(clock, 2, null)).toBeCloseTo(1, 12);
    expect(localTimelineTime(clock, 4, null)).toBeCloseTo(1 + sourceTimeAt(lane, 2), 9);
    expect(localTimelineTime(clock, 4, 2)).toBe(2);
  });
});

describe('media inside a composition with an in-point', () => {
  it('has its origin at the host start less the in-point, and is cut to the host window', () => {
    const root = new El('div', { 'data-composition-id': 'main', 'data-duration': '30' });
    const host = root.add(new El('div', { 'data-composition-id': 'inner', 'data-start': '5', 'data-duration': '4', 'data-playback-start': '2' }));
    const clip = host.add(new El('audio', { id: 'a', 'data-start': '3', 'data-duration': '10' }));
    const early = host.add(new El('audio', { id: 'b', 'data-start': '0', 'data-duration': '1' }));
    const r = resolver(root);
    // Local 0 of the host is at 5 - 2 = 3 on the project's clock.
    expect(r.start(clip)).toBe(6);
    expect(r.start(early)).toBe(3);
    expect(r.hostSlots(clip)).toEqual([{ start: 5, end: 9 }]);
    expect(cutToSlots({ start: 6, end: 16 }, r.hostSlots(clip))).toEqual({ start: 6, end: 9 });
    // `early` ends before the host's window: nothing is left.
    const cut = cutToSlots({ start: 3, end: 4 }, r.hostSlots(early));
    expect(cut.end).toBeLessThanOrEqual(cut.start);
  });

  it('keeps a root-global media start when the element says so', () => {
    const root = new El('div', { 'data-composition-id': 'main', 'data-duration': '30' });
    const host = root.add(new El('div', { 'data-composition-id': 'inner', 'data-start': '5', 'data-duration': '9' }));
    const local = host.add(new El('video', { id: 'l', 'data-start': '2' }));
    const global = host.add(new El('video', { id: 'g', 'data-start': '7', 'data-hf-media-start-basis': 'global' }));
    const r = resolver(root);
    expect(r.start(local)).toBe(7);
    expect(r.start(global)).toBe(7);
  });
});

describe('data-color-grading', () => {
  it('reads a preset name, JSON, a variable and the animated values', () => {
    expect(normalizeGrade('warm-daylight')!.adjust.temperature).toBe(0.18);
    expect(normalizeGrade('{"adjust":{"exposure":5}}')!.adjust.exposure).toBe(2);
    expect(normalizeGrade('$look', { look: { preset: 'mono-clean' } })!.adjust.saturation).toBe(-1);
    expect(normalizeGrade('{"enabled":false}')).toBeNull();
    expect(normalizeGrade('')).toBeNull();
    expect(normalizeGrade('creator-camcorder')!.intensity).toBe(0.72);
    expect(normalizeGrade('{"preset":"neutral","intensity":0.4}', {}, { intensity: 0.9, exposure: 1 })).toMatchObject({ intensity: 0.9, adjust: { exposure: 1 } });
  });

  it('normalises the advanced controls the way HyperFrames does', () => {
    const g = normalizeGrade(
      JSON.stringify({
        curves: { master: [[0.25, 0.2], [0.75, 0.8]], red: [[0, 0], [0.5, 0.5], [0.5, 0.6], [1, 1]] },
        hueCurves: { hueVsHue: [[400, 90], [120, 300], [240, -10]], hueVsLuma: [[0, 0.5], [90, 0.5]] },
        secondaries: [
          { key: { hue: { center: -30, range: 90, softness: 200 }, saturation: { min: 0.9, max: 0.1 } }, correction: { hueShift: 500, tint: 0.3 } },
          { enabled: false, key: {}, correction: { luma: 1 } },
          { key: {} },
        ],
        wheels: { shadows: { hue: -90, amount: 2, level: -3 } },
        details: { vignette: 0.4, grainSize: 3 },
      }),
    )!;
    // The ends of a curve are added; a curve with a repeated input is the identity.
    expect(g.curves.master).toEqual([[0, 0], [0.25, 0.2], [0.75, 0.8], [1, 1]]);
    expect(g.curves.red).toEqual([[0, 0], [1, 1]]);
    // A hue curve is sorted, wrapped and clamped; fewer than three points is none.
    expect(g.hueCurves.hueVsHue).toEqual([[40, 90], [120, 180], [240, -10]]);
    expect(g.hueCurves.hueVsLuma).toEqual([]);
    // Only the enabled secondaries with a key and a correction are kept, within their limits.
    expect(g.secondaries).toHaveLength(1);
    expect(g.secondaries[0]).toEqual({
      key: { hue: { center: 330, range: 90, softness: 90 }, saturation: { min: 0.1, max: 0.9, softness: 0.05 }, luma: { min: 0, max: 1, softness: 0.05 } },
      correction: { hueShift: 180, saturation: 0, luma: 0, temperature: 0, tint: 0.3 },
    });
    expect(g.wheels.shadows).toEqual({ hue: 270, amount: 1, level: -1 });
    expect(g.details).toMatchObject({ vignette: 0.4, vignetteMidpoint: 0.5, vignetteFeather: 0.65, grainSize: 1, grainRoughness: 0.5 });
  });

  it('writes the grade of a frame as the attribute the painter reads, and nothing for a grade that changes nothing', () => {
    expect(gradeAttribute(normalizeGrade('neutral')!, 0, 0)).toBeNull();
    expect(gradeAttribute(normalizeGrade('{"adjust":{"exposure":0.5},"intensity":0}')!, 0, 0)).toBeNull();
    const attr = JSON.parse(gradeAttribute(normalizeGrade('{"adjust":{"exposure":0.5},"details":{"grain":0.2},"lut":"look.cube"}')!, 1234, 0.5)!);
    expect(attr.adjust.exposure).toBe(0.5);
    expect(attr.grain).toEqual({ amount: 0.2, size: 0.25, roughness: 0.5, seed: 1234 });
    expect(attr.lut).toEqual({ src: 'look.cube', intensity: 1 });
    expect(attr.vignette.amount).toBe(0);
    // A vignette alone is a grade, even at intensity 0.
    expect(gradeAttribute(normalizeGrade('{"intensity":0,"details":{"vignette":0.3}}')!, 0, 0)).not.toBeNull();
  });

  it('seeds the grain like HyperFrames (FNV-1a modulo 10000)', () => {
    expect(seedOf('')).toBe(2166136261 % 10000);
    expect(seedOf('clip')).toBe(seedOf('clip'));
    expect(seedOf('clip')).not.toBe(seedOf('clop'));
    expect(seedOf('a')).toBe(Number(BigInt.asUintN(32, (2166136261n ^ 97n) * 16777619n) % 10000n));
  });

  it('draws all 18 effects, so it lists nothing it cannot draw', () => {
    const g = normalizeGrade('{"preset":"vhs-playback","effects":{"halftone":0.5}}')!;
    expect(gradeNotDrawn(g)).toEqual([]);
    expect(gradeNotDrawn(normalizeGrade('{"adjust":{"exposure":1}}')!)).toEqual([]);
  });

  it('reads the effect controls with their defaults, limits, presets, palette and animated values', () => {
    const g = normalizeGrade('{"effects":{"bloom":9,"bloomRadius":0,"asciiStyle":3.4,"tapeNoise":-1},"palette":["#AABBCC","#000000"]}')!;
    expect(Object.keys(g.effects)).toHaveLength(64);
    expect(g.effects).toMatchObject({ bloom: 3, bloomRadius: 1, asciiStyle: 3.4, tapeNoise: 0, tapeSpeed: 0.5, asciiColor: 1, engravingSpacing: 7 / 17 });
    expect(g.palette).toEqual(['#aabbcc', '#000000']);
    expect(normalizeGrade('{"palette":["#fff","#000000"]}')!.palette).toBeNull();
    // A preset sets its effects and details, an authored control wins.
    const vhs = normalizeGrade('{"preset":"vhs-playback","effects":{"scanlines":0.1}}')!;
    expect(vhs.effects).toMatchObject({ tapeDamage: 0.82, tapeTracking: 0.85, scanlines: 0.1, scanlineCount: 0.17, digitalGlitchLineTear: 0.08 });
    expect(vhs.details).toMatchObject({ grain: 0.16, grainSize: 0.12, grainRoughness: 0.72 });
    // Only blur, bloom, kuwahara, pixelate, ascii and dither follow a tween.
    const tweened = normalizeGrade('{"effects":{"blur":0.1,"halftone":0.2}}', {}, { effects: { blur: 0.7, bloom: 2, halftone: 0.9 } })!;
    expect(tweened.effects).toMatchObject({ blur: 0.7, bloom: 2, halftone: 0.2 });
  });

  it('writes the effect controls that are not at their defaults, with the palette and the time', () => {
    const g = normalizeGrade('{"effects":{"halftone":0.9,"asciiSize":0.2},"palette":["#000000","#ffffff"]}')!;
    const attr = JSON.parse(gradeAttribute(g, 7, 1.5)!);
    expect(attr.effects).toEqual({ halftone: 0.9, asciiSize: 0.2 });
    expect(attr.palette).toEqual(['#000000', '#ffffff']);
    expect(attr.time).toBe(1.5);
    // An effect alone makes a grade active, even at intensity 0; a control without its effect does not.
    expect(gradeAttribute(normalizeGrade('{"intensity":0,"effects":{"scanlines":0.3}}')!, 0, 0)).not.toBeNull();
    expect(gradeAttribute(normalizeGrade('{"effects":{"halftoneSize":0.9}}')!, 0, 0)).toBeNull();
  });
});
