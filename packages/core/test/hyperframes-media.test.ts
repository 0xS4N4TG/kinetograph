import { describe, expect, it } from 'vitest';
import {
  cutToSlots,
  curveFunction,
  gradeFilter,
  laneGain,
  localTimelineTime,
  normalizeGrade,
  parseAutomation,
  rateAt,
  rateSpecOf,
  sampleLane,
  sourceTimeAt,
  timeAtSourceTime,
  TimingResolver,
  type GradeStep,
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

/** The shader's primary grade (runtime/colorGrading.ts: applyPrimaryGrade) for one colour, written out, as the reference. */
function shaderPrimary(c: number[], a: Record<string, number>): number[] {
  const luma = (v: number[]): number => 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
  const smooth = (lo: number, hi: number, x: number): number => {
    const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
    return t * t * (3 - 2 * t);
  };
  let v = c.map((x) => x * 2 ** a.exposure!);
  const y = luma(v);
  v = v.map((x) => x + a.shadows! * 0.35 * (1 - smooth(0, 0.65, y)) + a.highlights! * 0.35 * smooth(0.35, 1, y));
  const bp = Math.min(0.18, Math.max(-0.18, a.blacks! * 0.18));
  const wp = Math.min(1.18, Math.max(0.82, 1 - a.whites! * 0.18));
  v = v.map((x) => (x - bp) / Math.max(wp - bp, 0.2));
  v = [v[0]! + a.temperature! * 0.08 + a.tint! * 0.04, v[1]! - a.tint! * 0.08, v[2]! - (a.temperature! * 0.08 - a.tint! * 0.04)];
  v = v.map((x) => (x - 0.5) * Math.max(0, 1 + a.contrast!) + 0.5);
  const l = luma(v);
  v = v.map((x) => l + (x - l) * Math.max(0, 1 + a.saturation!));
  return v.map((x) => Math.min(1, Math.max(0, x)));
}

const applyMatrix = (m: number[], c: number[]): number[] =>
  [0, 1, 2].map((r) => Math.min(1, Math.max(0, m[r * 5]! * c[0]! + m[r * 5 + 1]! * c[1]! + m[r * 5 + 2]! * c[2]! + m[r * 5 + 4]!)));

describe('data-color-grading', () => {
  const samples = [[0.1, 0.2, 0.3], [0.8, 0.5, 0.2], [0.5, 0.5, 0.5], [1, 0.9, 0.1], [0, 0, 0]];

  it('reads a preset name, JSON, a variable and the animated values', () => {
    expect(normalizeGrade('warm-daylight')!.adjust.temperature).toBe(0.18);
    expect(normalizeGrade('{"adjust":{"exposure":5}}')!.adjust.exposure).toBe(2);
    expect(normalizeGrade('$look', { look: { preset: 'mono-clean' } })!.adjust.saturation).toBe(-1);
    expect(normalizeGrade('{"enabled":false}')).toBeNull();
    expect(normalizeGrade('')).toBeNull();
    expect(normalizeGrade('creator-camcorder')!.intensity).toBe(0.72);
    expect(normalizeGrade('{"preset":"neutral","intensity":0.4}', {}, { intensity: 0.9, exposure: 1 })).toMatchObject({ intensity: 0.9, adjust: { exposure: 1 } });
  });

  it('is exactly one colour matrix when nothing is luma-weighted', () => {
    const adjust = { exposure: 0.3, contrast: 0.2, whites: 0.1, blacks: -0.2, temperature: 0.25, tint: -0.1, saturation: 0.4 };
    const f = gradeFilter(normalizeGrade({ adjust } as unknown as string)!)!;
    expect(f.steps).toHaveLength(1);
    expect(f.approximated).toEqual([]);
    const full = { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, temperature: 0, tint: 0, vibrance: 0, saturation: 0, ...adjust };
    for (const c of samples) {
      const got = applyMatrix((f.steps[0] as Extract<GradeStep, { kind: 'matrix' }>).values, c);
      const want = shaderPrimary(c, full);
      got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 9));
    }
  });

  it('draws shadows and highlights as per-channel tables, exact for greys, and says so', () => {
    const adjust = { shadows: 0.3, highlights: -0.2, contrast: 0.1 };
    const f = gradeFilter(normalizeGrade({ adjust } as unknown as string)!)!;
    expect(f.approximated).toContain('adjust.shadows/highlights');
    const step = f.steps[0] as Extract<GradeStep, { kind: 'tables' }>;
    expect(step.r).toHaveLength(32);
    const full = { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, temperature: 0, tint: 0, vibrance: 0, saturation: 0, ...adjust };
    for (const g of [0, 0.25, 0.5, 1]) {
      const i = g * 31;
      const interp = (t: number[]): number => t[Math.floor(i)]! + ((t[Math.min(31, Math.ceil(i))]! - t[Math.floor(i)]!) * (i - Math.floor(i)));
      expect(interp(step.g)).toBeCloseTo(shaderPrimary([g, g, g], full)[1]!, 2);
    }
  });

  it('applies a curve through its points', () => {
    const f = curveFunction([[0, 0], [0.5, 0.7], [1, 1]]);
    expect(f(0)).toBe(0);
    expect(f(0.5)).toBeCloseTo(0.7, 12);
    expect(f(1)).toBe(1);
    expect(f(0.25)).toBeGreaterThan(0.25);
    const g = gradeFilter(normalizeGrade('{"curves":{"master":[[0,0],[0.5,0.7],[1,1]]}}')!)!;
    const t = (g.steps[0] as Extract<GradeStep, { kind: 'tables' }>).g;
    expect(t[0]).toBe(0);
    expect(t[31]).toBe(1);
    expect(t[16]!).toBeGreaterThan(0.5);
  });

  it('mixes the grade with the source by intensity and lists what it cannot draw', () => {
    const f = gradeFilter(normalizeGrade('{"preset":"night-lift","intensity":0.5,"lut":{"src":"a.cube"},"effects":{"halftone":0.5}}')!)!;
    expect(f.intensity).toBe(0.5);
    expect(f.left).toEqual(expect.arrayContaining(['lut', 'details.vignette', 'effects.halftone']));
    expect(gradeFilter(normalizeGrade('neutral')!)).toBeNull();
  });
});
