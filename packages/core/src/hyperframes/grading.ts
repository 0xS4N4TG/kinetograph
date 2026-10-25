// `data-color-grading` on a `<video>`, `<img>` or `<canvas>`: HyperFrames' colour grade (Apache-2.0,
// heygen-com/hyperframes; packages/core/src/colorGrading.ts for the contract and the presets, runtime/colorGrading.ts for
// the shader the numbers go through), lowered here to an SVG filter the DOM engine draws natively, with no browser.
//
// What is drawn, and how exactly:
//   - `adjust.exposure`, `contrast`, `blacks`, `whites`, `temperature`, `tint`, `saturation`: exact. In the shader they are
//     one affine map of the colour followed by a mix with its luma, so they are one `feColorMatrix` in sRGB.
//   - `adjust.shadows`, `highlights` and the three `wheels`: the shader weights them by the pixel's luma. A filter has no
//     luma-weighted add, so they are drawn as one curve per channel, taking the channel for the luma (exact for greys).
//   - `adjust.vibrance`: weighted by the pixel's saturation and skin tones in the shader; drawn as a saturation of the
//     weight a mid-saturated pixel gets (0.64).
//   - `curves` (master, red, green, blue): exact up to the 32 values a filter table holds.
//   - `intensity`: the mix of the grade with the source, as `feComposite`.
// What is not drawn (reported, per frame): `lut` (the engine has a `.cube` look-up effect, but a DOM node cannot reach it),
// `hueCurves`, `secondaries`, `details` (vignette, grain) and `effects` (blur, bloom, halftone, scanlines, ...).

export interface Grade {
  intensity: number;
  adjust: Record<(typeof ADJUST_KEYS)[number], number>;
  wheels: Record<'shadows' | 'midtones' | 'highlights', { hue: number; amount: number; level: number }>;
  curves: Record<'master' | 'red' | 'green' | 'blue', [number, number][]>;
  details: { vignette: number; grain: number };
  /** The effects that are on (above 0.0001), by name. */
  effects: string[];
  lut: { src: string; intensity: number } | null;
  hueCurves: boolean;
  secondaries: boolean;
}

const ADJUST_KEYS = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temperature', 'tint', 'vibrance', 'saturation'] as const;
type AdjustKey = (typeof ADJUST_KEYS)[number];
type Adjust = Record<AdjustKey, number>;
const LIMITS: Record<AdjustKey, [number, number]> = {
  exposure: [-2, 2], contrast: [-1, 1], highlights: [-1, 1], shadows: [-1, 1], whites: [-1, 1], blacks: [-1, 1],
  temperature: [-1, 1], tint: [-1, 1], vibrance: [-1, 1], saturation: [-1, 1],
};
const ZERO: Adjust = { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, temperature: 0, tint: 0, vibrance: 0, saturation: 0 };

interface Preset {
  adjust: Partial<Adjust>;
  vignette?: number;
  grain?: number;
  effects?: string[];
  intensity?: number;
}

const VINTAGE: Preset = { adjust: { exposure: 0.03, contrast: -0.12, highlights: -0.1, shadows: 0.16, whites: -0.04, blacks: 0.08, temperature: 0.13, vibrance: -0.08, saturation: -0.08 }, vignette: 0.18 };

/** colorGrading.ts: HF_COLOR_GRADING_PRESETS (the numbers of each grade; `effects` lists the effects the preset turns on). */
export const PRESETS: Record<string, Preset> = {
  neutral: { adjust: {} },
  'warm-daylight': { adjust: { exposure: 0.06, contrast: 0.07, highlights: -0.06, shadows: 0.08, temperature: 0.18, saturation: 0.08 } },
  'clean-studio': { adjust: { contrast: 0.08, highlights: -0.08, shadows: 0.06, temperature: -0.08, tint: 0.03, saturation: 0.04 } },
  'skin-soft': { adjust: { exposure: 0.04, contrast: -0.03, highlights: -0.12, shadows: 0.12, temperature: 0.08, tint: 0.02, saturation: 0.04 } },
  'food-pop': { adjust: { exposure: 0.06, contrast: 0.1, shadows: 0.06, temperature: 0.14, vibrance: 0.1, saturation: 0.18 } },
  'night-lift': { adjust: { exposure: 0.08, contrast: 0.08, highlights: -0.18, shadows: 0.2, blacks: -0.08, saturation: 0.04 }, vignette: 0.12 },
  'muted-editorial': { adjust: { exposure: -0.02, contrast: 0.08, highlights: -0.08, shadows: 0.06, blacks: -0.05, temperature: -0.03, saturation: -0.12 }, vignette: 0.1 },
  'vintage-wash': VINTAGE,
  'mono-clean': { adjust: { contrast: 0.12, highlights: -0.04, shadows: 0.04, blacks: -0.08, saturation: -1 } },
  'mono-fade': { adjust: { contrast: -0.04, highlights: -0.06, shadows: 0.1, blacks: 0.12, saturation: -1 }, vignette: 0.08 },
  'soft-boost': { adjust: { exposure: 0.06, contrast: -0.04, highlights: -0.14, shadows: 0.16, vibrance: 0.08, saturation: 0.1 } },
  'bright-pop': { adjust: { exposure: 0.12, contrast: 0.12, whites: 0.08, blacks: -0.04, vibrance: 0.08, saturation: 0.14 } },
  'deep-contrast': { adjust: { exposure: -0.03, contrast: 0.2, highlights: -0.08, shadows: -0.08, blacks: -0.12, saturation: 0.06 } },
  'creator-camcorder': {
    adjust: { contrast: 0.08, highlights: -0.05, shadows: 0.02, whites: 0.03, blacks: -0.04, temperature: -0.03, tint: -0.015, vibrance: -0.03, saturation: -0.06 },
    vignette: 0.06, grain: 0.08, effects: ['chromaBleed'], intensity: 0.72,
  },
  'vhs-playback': {
    adjust: { contrast: -0.04, saturation: -0.08 }, grain: 0.16,
    effects: ['tapeDamage', 'chromaBleed', 'chromaticAberration', 'scanlines', 'digitalGlitch'],
  },
  'home-movie-8mm': { adjust: VINTAGE.adjust, vignette: 0.28, grain: 0.34, effects: ['filmArtifacts'], intensity: 0.72 },
  'editorial-halftone': { adjust: { contrast: 0.04, saturation: 0.04 }, effects: ['halftone'] },
  'two-ink-print': { adjust: { contrast: 0.08, highlights: -0.06, shadows: 0.04 }, effects: ['twoInkPrint'] },
};

const EFFECT_KEYS = [
  'blur', 'pixelate', 'chromaBleed', 'tapeDamage', 'filmArtifacts', 'halftone', 'twoInkPrint', 'ascii', 'dither', 'bloom',
  'monoScreen', 'scanlines', 'chromaticAberration', 'crtCurvature', 'digitalGlitch', 'engraving', 'crosshatch', 'kuwahara',
];

const isRecord = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, lo: number, hi: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? clamp(n, lo, hi) : 0;
};
const unit = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? clamp(n, 0, 1) : fallback;
};

const VARIABLE_REF = /^\$(?:\{([A-Za-z0-9_.:-]+)\}|([A-Za-z0-9_.:-]+))$/;

/** A `$name` (or `${name}`) string is the composition's variable of that name (colorGrading.ts: resolveHfColorGradingVariables). */
function resolveVariables(raw: unknown, variables: Record<string, unknown>): unknown {
  if (typeof raw === 'string') {
    const m = VARIABLE_REF.exec(raw.trim());
    if (m) {
      const key = m[1] ?? m[2] ?? '';
      return key !== '' && Object.hasOwn(variables, key) ? variables[key] : raw;
    }
    if (raw.trim().startsWith('{')) {
      try {
        return resolveVariables(JSON.parse(raw), variables);
      } catch {
        return raw;
      }
    }
    return raw;
  }
  if (Array.isArray(raw)) return raw.map((v) => resolveVariables(v, variables));
  if (isRecord(raw)) return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, resolveVariables(v, variables)]));
  return raw;
}

function normalizeCurve(value: unknown): [number, number][] {
  const identity: [number, number][] = [[0, 0], [1, 1]];
  if (!Array.isArray(value) || value.length < 2) return identity;
  const points: [number, number][] = [];
  for (const p of value) {
    if (!Array.isArray(p) || p.length !== 2) return identity;
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return identity;
    points.push([clamp(x, 0, 1), clamp(y, 0, 1)]);
  }
  points.sort((a, b) => a[0] - b[0]);
  if (points.some((p, i) => i > 0 && p[0] === points[i - 1]![0])) return identity;
  if (points[0]![0] > 0) points.unshift([0, 0]);
  if (points[points.length - 1]![0] < 1) points.push([1, 1]);
  return points.length > 16 ? identity : points;
}

/**
 * The attribute's value as a grade: a JSON object, or a preset's name; null when it is off or unreadable (colorGrading.ts:
 * normalizeHfColorGrading). `overrides` are the animated values (`--hf-color-grading-intensity`, `-lut-intensity`, `-exposure`).
 */
export function normalizeGrade(
  raw: unknown,
  variables: Record<string, unknown> = {},
  overrides: { intensity?: number | null; exposure?: number | null; lutIntensity?: number | null } = {},
): Grade | null {
  let value = resolveVariables(raw, variables);
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return null;
    if (text.startsWith('{')) {
      try {
        value = JSON.parse(text);
      } catch {
        return null;
      }
    } else value = { preset: text };
  }
  if (!isRecord(value) || value.enabled === false) return null;
  const preset = typeof value.preset === 'string' ? PRESETS[value.preset.trim()] : undefined;
  const rawAdjust = isRecord(value.adjust) ? value.adjust : {};
  const adjust = { ...ZERO };
  for (const key of ADJUST_KEYS) {
    const [lo, hi] = LIMITS[key];
    adjust[key] = num(rawAdjust[key] ?? preset?.adjust[key] ?? 0, lo, hi);
  }
  if (overrides.exposure != null) adjust.exposure = clamp(overrides.exposure, -2, 2);
  const rawWheels = isRecord(value.wheels) ? value.wheels : {};
  const wheel = (name: string): Grade['wheels']['shadows'] => {
    const w = isRecord(rawWheels[name]) ? rawWheels[name] : {};
    const hue = Number(w.hue);
    return { hue: Number.isFinite(hue) ? ((hue % 360) + 360) % 360 : 0, amount: num(w.amount ?? 0, 0, 1), level: num(w.level ?? 0, -1, 1) };
  };
  const rawCurves = isRecord(value.curves) ? value.curves : {};
  const rawDetails = isRecord(value.details) ? value.details : {};
  const rawEffects = isRecord(value.effects) ? value.effects : {};
  const lutRaw = value.lut;
  const lutSrc = typeof lutRaw === 'string' ? lutRaw.trim() : isRecord(lutRaw) && typeof lutRaw.src === 'string' ? lutRaw.src.trim() : '';
  const lutIntensity = overrides.lutIntensity ?? (isRecord(lutRaw) ? unit(lutRaw.intensity, 1) : 1);
  const effects = EFFECT_KEYS.filter((key) => (num(rawEffects[key] ?? 0, 0, key === 'bloom' ? 3 : 1) || (preset?.effects?.includes(key) ? 1 : 0)) > 0.0001);
  const hueCurveActive = isRecord(value.hueCurves) && Object.values(value.hueCurves).some((c) => Array.isArray(c) && c.some((p) => Array.isArray(p) && Math.abs(Number(p[1])) > 0.0001));
  const secondaryActive =
    Array.isArray(value.secondaries) && value.secondaries.some((s) => isRecord(s) && s.enabled !== false && isRecord(s.correction) && Object.values(s.correction).some((v) => Math.abs(Number(v)) > 0.0001));
  return {
    intensity: overrides.intensity != null ? clamp(overrides.intensity, 0, 1) : unit(value.intensity, preset?.intensity ?? 1),
    adjust,
    wheels: { shadows: wheel('shadows'), midtones: wheel('midtones'), highlights: wheel('highlights') },
    curves: { master: normalizeCurve(rawCurves.master), red: normalizeCurve(rawCurves.red), green: normalizeCurve(rawCurves.green), blue: normalizeCurve(rawCurves.blue) },
    details: { vignette: unit(rawDetails.vignette ?? preset?.vignette ?? 0, 0), grain: unit(rawDetails.grain ?? preset?.grain ?? 0, 0) },
    effects,
    lut: lutSrc === '' ? null : { src: lutSrc, intensity: lutIntensity },
    hueCurves: hueCurveActive,
    secondaries: secondaryActive,
  };
}

// ---- curves ----

/** The shape-preserving cubic through a curve's points, at `x` (colorGradingCurves.ts: pointSlopes, interpolateCurveSegment). */
export function curveFunction(points: readonly [number, number][]): (x: number) => number {
  const n = points.length;
  const spans: number[] = [];
  const slopes: number[] = [];
  for (let i = 1; i < n; i++) {
    spans.push(points[i]![0] - points[i - 1]![0]);
    slopes.push((points[i]![1] - points[i - 1]![1]) / spans[i - 1]!);
  }
  const endpoint = (s0: number, s1: number, m0: number, m1: number): number => {
    const slope = ((2 * s0 + s1) * m0 - s0 * m1) / (s0 + s1);
    if (Math.sign(slope) !== Math.sign(m0)) return 0;
    if (Math.sign(m0) !== Math.sign(m1) && Math.abs(slope) > 3 * Math.abs(m0)) return 3 * m0;
    return slope;
  };
  const tangents = new Array<number>(n);
  if (n === 2) {
    tangents[0] = tangents[1] = slopes[0]!;
  } else {
    tangents[0] = endpoint(spans[0]!, spans[1]!, slopes[0]!, slopes[1]!);
    tangents[n - 1] = endpoint(spans[n - 2]!, spans[n - 3]!, slopes[n - 2]!, slopes[n - 3]!);
    for (let i = 1; i < n - 1; i++) {
      const before = slopes[i - 1]!;
      const after = slopes[i]!;
      if (before === 0 || after === 0 || Math.sign(before) !== Math.sign(after)) {
        tangents[i] = 0;
        continue;
      }
      const bw = 2 * spans[i]! + spans[i - 1]!;
      const aw = spans[i]! + 2 * spans[i - 1]!;
      tangents[i] = (bw + aw) / (bw / before + aw / after);
    }
  }
  return (x) => {
    let seg = 0;
    while (seg < n - 2 && x > points[seg + 1]![0]) seg++;
    const a = points[seg]!;
    const b = points[seg + 1]!;
    const span = b[0] - a[0];
    const t = clamp((x - a[0]) / span, 0, 1);
    const t2 = t * t;
    const t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * a[1] + (t3 - 2 * t2 + t) * span * tangents[seg]! + (-2 * t3 + 3 * t2) * b[1] + (t3 - t2) * span * tangents[seg + 1]!;
    return clamp(y, 0, 1);
  };
}

const isIdentityCurve = (p: readonly [number, number][]): boolean => p.every(([x, y]) => Math.abs(x - y) <= 0.0001);

// ---- the filter ----

export type GradeStep =
  | { kind: 'matrix'; values: number[] }
  | { kind: 'tables'; r: number[]; g: number[]; b: number[] };

export interface GradeFilter {
  steps: GradeStep[];
  /** The mix of the grade with the source (1: all grade). */
  intensity: number;
  /** What was asked for and is not drawn. */
  left: string[];
  /** What is drawn by approximation. */
  approximated: string[];
}

const LUMA = [0.2126, 0.7152, 0.0722];
const TABLE_SIZE = 32;
const smoothstep = (lo: number, hi: number, x: number): number => {
  const t = clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
};
/** The vibrance weight of a mid-saturated, non-skin pixel: (1 - 0.72 * 0.5). */
const VIBRANCE_WEIGHT = 0.64;

/** hsvToRgb of (h, 1, 1) less its luma, scaled so the largest channel is 1 (the shader's wheelDirection). */
function wheelDirection(hueDegrees: number): number[] {
  const h = hueDegrees / 360;
  const bands = [0, 2 / 3, 1 / 3].map((o) => Math.abs((((h + o) % 1) + 1) % 1 * 6 - 3));
  const rgb = bands.map((b) => clamp(b - 1, 0, 1));
  const l = LUMA[0]! * rgb[0]! + LUMA[1]! * rgb[1]! + LUMA[2]! * rgb[2]!;
  const d = rgb.map((c) => c - l);
  const m = Math.max(...d.map(Math.abs), 0.0001);
  return d.map((c) => c / m);
}

/** The filter that draws a grade, or null when the grade changes nothing that can be drawn. */
export function gradeFilter(grade: Grade): GradeFilter | null {
  const a = grade.adjust;
  const left: string[] = [];
  const approximated: string[] = [];
  if (grade.lut && grade.lut.intensity > 0) left.push('lut');
  if (grade.hueCurves) left.push('hueCurves');
  if (grade.secondaries) left.push('secondaries');
  if (grade.details.vignette > 0.0001) left.push('details.vignette');
  if (grade.details.grain > 0.0001) left.push('details.grain');
  for (const e of grade.effects) left.push(`effects.${e}`);

  const bp = clamp(a.blacks * 0.18, -0.18, 0.18);
  const wp = clamp(1 - a.whites * 0.18, 0.82, 1.18);
  const k = 1 / Math.max(wp - bp, 0.2);
  const cf = Math.max(0, 1 + a.contrast);
  const s = 2 ** a.exposure;
  const off = [a.temperature * 0.08 + a.tint * 0.04, -a.tint * 0.08, -(a.temperature * 0.08 - a.tint * 0.04)];
  const q = Math.max(0, 1 + a.vibrance * VIBRANCE_WEIGHT) * Math.max(0, 1 + a.saturation);
  if (Math.abs(a.vibrance) > 0.0001) approximated.push('adjust.vibrance');
  // out = S_q * v, S_q = q * I + (1 - q) * 1 luma^T
  const sat = [0, 1, 2].map((r) => [0, 1, 2].map((c) => (r === c ? q : 0) + (1 - q) * LUMA[c]!));

  const toneStage = a.shadows !== 0 || a.highlights !== 0;
  const wheelsOn = (['shadows', 'midtones', 'highlights'] as const).some((z) => grade.wheels[z].amount > 0.0001 || Math.abs(grade.wheels[z].level) > 0.0001);
  const curvesOn = (['master', 'red', 'green', 'blue'] as const).some((c) => !isIdentityCurve(grade.curves[c]));
  const steps: GradeStep[] = [];

  const matrix = (m: number[][], t: number[]): GradeStep => ({
    kind: 'matrix',
    values: [...m[0]!, 0, t[0]!, ...m[1]!, 0, t[1]!, ...m[2]!, 0, t[2]!, 0, 0, 0, 1, 0],
  });
  const needSat = Math.abs(q - 1) > 1e-9;
  if (!toneStage) {
    // Everything before the saturation is one affine map per channel: fold the saturation into it (exact).
    const aa = s * k * cf;
    const b = [0, 1, 2].map((c) => ((-bp * k + off[c]!) - 0.5) * cf + 0.5);
    const identity = Math.abs(aa - 1) < 1e-9 && b.every((v) => Math.abs(v) < 1e-9) && !needSat;
    if (!identity) {
      const m = sat.map((row) => row.map((v) => v * aa));
      const t = sat.map((row) => row[0]! * b[0]! + row[1]! * b[1]! + row[2]! * b[2]!);
      steps.push(matrix(m, t));
    }
  } else {
    approximated.push('adjust.shadows/highlights');
    const table = (c: number): number[] =>
      Array.from({ length: TABLE_SIZE }, (_, i) => {
        let v = (i / (TABLE_SIZE - 1)) * s;
        v += a.shadows * 0.35 * (1 - smoothstep(0, 0.65, v)) + a.highlights * 0.35 * smoothstep(0.35, 1, v);
        v = (v - bp) * k + off[c]!;
        return clamp((v - 0.5) * cf + 0.5, 0, 1);
      });
    steps.push({ kind: 'tables', r: table(0), g: table(1), b: table(2) });
    if (needSat) steps.push(matrix(sat, [0, 0, 0]));
  }

  if (wheelsOn || curvesOn) {
    if (wheelsOn) approximated.push('wheels');
    const master = curveFunction(grade.curves.master);
    const channel = [curveFunction(grade.curves.red), curveFunction(grade.curves.green), curveFunction(grade.curves.blue)];
    const dirs = (['shadows', 'midtones', 'highlights'] as const).map((z) => wheelDirection(grade.wheels[z].hue));
    const table = (c: number): number[] =>
      Array.from({ length: TABLE_SIZE }, (_, i) => {
        let v = i / (TABLE_SIZE - 1);
        if (wheelsOn) {
          const sh = 1 - smoothstep(0, 0.6, v);
          const hl = smoothstep(0.4, 1, v);
          const mid = Math.max(0, 1 - sh - hl);
          const total = Math.max(sh + mid + hl, 0.0001);
          const w = [sh / total, mid / total, hl / total];
          (['shadows', 'midtones', 'highlights'] as const).forEach((z, zi) => {
            v += dirs[zi]![c]! * grade.wheels[z].amount * w[zi]! * 0.18 + grade.wheels[z].level * w[zi]! * 0.25;
          });
        }
        return curvesOn ? channel[c]!(master(clamp(v, 0, 1))) : clamp(v, 0, 1);
      });
    steps.push({ kind: 'tables', r: table(0), g: table(1), b: table(2) });
  }
  if (steps.length === 0) return left.length > 0 ? { steps, intensity: grade.intensity, left, approximated } : null;
  return { steps, intensity: grade.intensity, left, approximated };
}
