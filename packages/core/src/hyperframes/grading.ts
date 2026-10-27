// `data-color-grading` on a `<video>`, `<img>` or `<canvas>`: HyperFrames' colour grade (Apache-2.0,
// heygen-com/hyperframes; packages/core/src/colorGrading.ts for the contract and the presets, runtime/colorGrading.ts for
// the shader the numbers go through). This module reads the attribute the way HyperFrames does and writes the grade of
// one frame as the `colorGrade` effect (`crates/core/src/grade.rs`), which one GPU pass applies: the whole shader, with
// no browser. The runtime writes it as the element's `data-kg-grade` attribute.
//
// What is drawn, against HyperFrames' own shader: `adjust` (all ten controls), `wheels`, `curves`, `hueCurves`,
// `secondaries`, `lut` (a `.cube` file of the project), `intensity`, `details.vignette` and `details.grain` (seeded by the
// element and the frame, so a frame is the same alone or in a sequence). What is not drawn is reported per frame: the
// `effects` (see `EFFECT_CONTROLS`): the engine draws all 18 and their 64 controls.

export interface Grade {
  intensity: number;
  adjust: Record<(typeof ADJUST_KEYS)[number], number>;
  wheels: Record<'shadows' | 'midtones' | 'highlights', { hue: number; amount: number; level: number }>;
  curves: Record<'master' | 'red' | 'green' | 'blue', [number, number][]>;
  hueCurves: Record<'hueVsHue' | 'hueVsSaturation' | 'hueVsLuma', [number, number][]>;
  /** The enabled secondaries, at most four, as the shader reads them. */
  secondaries: Secondary[];
  details: Record<(typeof DETAIL_KEYS)[number], number>;
  /** Every control of `effects` (EFFECT_CONTROLS), at its default when the grade leaves it out. */
  effects: Record<string, number>;
  /** The palette the print and drawing effects use: two to six `#rrggbb`, or null for the effect's own. */
  palette: string[] | null;
  lut: { src: string; intensity: number } | null;
}

export interface Secondary {
  key: {
    hue: { center: number; range: number; softness: number };
    saturation: { min: number; max: number; softness: number };
    luma: { min: number; max: number; softness: number };
  };
  correction: { hueShift: number; saturation: number; luma: number; temperature: number; tint: number };
}

const ADJUST_KEYS = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temperature', 'tint', 'vibrance', 'saturation'] as const;
type AdjustKey = (typeof ADJUST_KEYS)[number];
type Adjust = Record<AdjustKey, number>;
const LIMITS: Record<AdjustKey, [number, number]> = {
  exposure: [-2, 2], contrast: [-1, 1], highlights: [-1, 1], shadows: [-1, 1], whites: [-1, 1], blacks: [-1, 1],
  temperature: [-1, 1], tint: [-1, 1], vibrance: [-1, 1], saturation: [-1, 1],
};
const ZERO: Adjust = { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, temperature: 0, tint: 0, vibrance: 0, saturation: 0 };
const DETAIL_KEYS = ['vignette', 'vignetteMidpoint', 'vignetteRoundness', 'vignetteFeather', 'grain', 'grainSize', 'grainRoughness'] as const;
type DetailKey = (typeof DETAIL_KEYS)[number];
const DETAIL_DEFAULTS: Record<DetailKey, number> = { vignette: 0, vignetteMidpoint: 0.5, vignetteRoundness: 0, vignetteFeather: 0.65, grain: 0, grainSize: 0.25, grainRoughness: 0.5 };
const DETAIL_LIMITS: Record<DetailKey, [number, number]> = {
  vignette: [0, 1], vignetteMidpoint: [0, 1], vignetteRoundness: [-1, 1], vignetteFeather: [0, 1], grain: [0, 1], grainSize: [0, 1], grainRoughness: [0, 1],
};
const MAX_CURVE_POINTS = 16;
const MAX_SECONDARIES = 4;

interface Preset {
  adjust: Partial<Adjust>;
  details?: Partial<Record<DetailKey, number>>;
  effects?: Record<string, number>;
  intensity?: number;
}

const VINTAGE: Preset = { adjust: { exposure: 0.03, contrast: -0.12, highlights: -0.1, shadows: 0.16, whites: -0.04, blacks: 0.08, temperature: 0.13, vibrance: -0.08, saturation: -0.08 }, details: { vignette: 0.18 } };

/** colorGrading.ts: HF_COLOR_GRADING_PRESETS (the numbers of each grade, with the details and effect controls the preset sets). */
export const PRESETS: Record<string, Preset> = {
  neutral: { adjust: {} },
  'warm-daylight': { adjust: { exposure: 0.06, contrast: 0.07, highlights: -0.06, shadows: 0.08, temperature: 0.18, saturation: 0.08 } },
  'clean-studio': { adjust: { contrast: 0.08, highlights: -0.08, shadows: 0.06, temperature: -0.08, tint: 0.03, saturation: 0.04 } },
  'skin-soft': { adjust: { exposure: 0.04, contrast: -0.03, highlights: -0.12, shadows: 0.12, temperature: 0.08, tint: 0.02, saturation: 0.04 } },
  'food-pop': { adjust: { exposure: 0.06, contrast: 0.1, shadows: 0.06, temperature: 0.14, vibrance: 0.1, saturation: 0.18 } },
  'night-lift': { adjust: { exposure: 0.08, contrast: 0.08, highlights: -0.18, shadows: 0.2, blacks: -0.08, saturation: 0.04 }, details: { vignette: 0.12 } },
  'muted-editorial': { adjust: { exposure: -0.02, contrast: 0.08, highlights: -0.08, shadows: 0.06, blacks: -0.05, temperature: -0.03, saturation: -0.12 }, details: { vignette: 0.1 } },
  'vintage-wash': VINTAGE,
  'mono-clean': { adjust: { contrast: 0.12, highlights: -0.04, shadows: 0.04, blacks: -0.08, saturation: -1 } },
  'mono-fade': { adjust: { contrast: -0.04, highlights: -0.06, shadows: 0.1, blacks: 0.12, saturation: -1 }, details: { vignette: 0.08 } },
  'soft-boost': { adjust: { exposure: 0.06, contrast: -0.04, highlights: -0.14, shadows: 0.16, vibrance: 0.08, saturation: 0.1 } },
  'bright-pop': { adjust: { exposure: 0.12, contrast: 0.12, whites: 0.08, blacks: -0.04, vibrance: 0.08, saturation: 0.14 } },
  'deep-contrast': { adjust: { exposure: -0.03, contrast: 0.2, highlights: -0.08, shadows: -0.08, blacks: -0.12, saturation: 0.06 } },
  'creator-camcorder': {
    adjust: { contrast: 0.08, highlights: -0.05, shadows: 0.02, whites: 0.03, blacks: -0.04, temperature: -0.03, tint: -0.015, vibrance: -0.03, saturation: -0.06 },
    details: { vignette: 0.06, grain: 0.08, grainSize: 0.18, grainRoughness: 0.58 },
    effects: { chromaBleed: 0.55 },
    intensity: 0.72,
  },
  'vhs-playback': {
    adjust: { contrast: -0.04, saturation: -0.08 },
    details: { grain: 0.16, grainSize: 0.12, grainRoughness: 0.72 },
    effects: {
      tapeDamage: 0.82, tapeTracking: 0.85, tapeNoise: 0.3, tapeSpeed: 0.5, chromaBleed: 0.5, chromaticAberration: 0.18,
      scanlines: 0.35, scanlineCount: 0.17, scanlineSoftness: 1, digitalGlitch: 0.32, digitalGlitchLineTear: 0.08, digitalGlitchSpeed: 0.5,
    },
  },
  'home-movie-8mm': {
    adjust: VINTAGE.adjust,
    details: { vignette: 0.28, vignetteMidpoint: 0.54, vignetteFeather: 0.72, grain: 0.34, grainSize: 0.18, grainRoughness: 0.72 },
    effects: { filmArtifacts: 0.62 },
    intensity: 0.72,
  },
  'editorial-halftone': { adjust: { contrast: 0.04, saturation: 0.04 }, effects: { halftone: 0.94, halftoneSize: 0.36 } },
  'two-ink-print': { adjust: { contrast: 0.08, highlights: -0.06, shadows: 0.04 }, effects: { twoInkPrint: 1, twoInkPrintSize: 0.42 } },
};

/**
 * The controls of `effects`: name, default, lowest and highest value, in the order of the engine's table
 * (`crates/core/src/grade.rs`: EFFECT_KEYS). colorGrading.ts: EFFECT_DEFAULTS and the limits of the contract.
 */
const EFFECT_CONTROLS: readonly (readonly [string, number, number, number])[] = [
  ['blur', 0, 0, 1], ['pixelate', 0, 0, 1], ['chromaBleed', 0, 0, 1], ['tapeDamage', 0, 0, 1], ['tapeTracking', 0, 0, 1],
  ['tapeNoise', 1, 0, 1], ['tapeSpeed', 0.5, 0, 1], ['filmArtifacts', 0, 0, 1], ['halftone', 0, 0, 1], ['halftoneSize', 0, 0, 1],
  ['twoInkPrint', 0, 0, 1], ['twoInkPrintSize', 0, 0, 1], ['ascii', 0, 0, 1], ['asciiSize', 5 / 76, 0, 1], ['asciiInvert', 0, 0, 1],
  ['asciiStyle', 0, 0, 7], ['asciiColor', 1, 0, 1], ['asciiRotation', 0, 0, 1], ['dither', 0, 0, 1], ['ditherSize', 0, 0, 1],
  ['bloom', 0, 0, 3], ['bloomRadius', 8, 1, 100], ['monoScreen', 0, 0, 1], ['monoScreenSize', 0, 0, 1], ['monoScreenAngle', 0, 0, 1],
  ['monoScreenSpread', 0, 0, 1], ['monoScreenShape', 0, 0, 4], ['monoScreenInvert', 0, 0, 1], ['scanlines', 0, 0, 1],
  ['scanlineCount', 0, 0, 1], ['scanlineSoftness', 0, 0, 1], ['chromaticAberration', 0, 0, 1], ['chromaticAngle', 0, 0, 1],
  ['crtCurvature', 0, 0, 1], ['digitalGlitch', 0, 0, 1], ['digitalGlitchColorSplit', 0, 0, 1], ['digitalGlitchLineTear', 0, 0, 1],
  ['digitalGlitchPixelate', 0, 0, 1], ['digitalGlitchBlockAmount', 0, 0, 1], ['digitalGlitchBlockDisplacement', 0, 0, 1],
  ['digitalGlitchBlockOpacity', 0, 0, 1], ['digitalGlitchSpeed', 0, 0, 1], ['engraving', 0, 0, 1], ['engravingSpacing', 7 / 17, 0, 1],
  ['engravingMinThickness', 0.2, 0, 1], ['engravingMaxThickness', 3.2 / 7, 0, 1], ['engravingAngle', 0.25, 0, 1],
  ['engravingContrast', 7 / 15, 0, 1], ['engravingSharpness', 0.59, 0, 1], ['engravingWave', 0.2, 0, 1],
  ['engravingWaveFrequency', 2 / 9, 0, 1], ['crosshatch', 0, 0, 1], ['crosshatchSpacing', 7 / 25, 0, 1], ['crosshatchThickness', 0.25, 0, 1],
  ['crosshatchAngle', 0.25, 0, 1], ['crosshatchContrast', 1 / 3, 0, 1], ['crosshatchEdges', 0.5, 0, 1], ['crosshatchLineWeight', 0, 0, 1],
  ['crosshatchWave', 0.33, 0, 1], ['crosshatchWaveFrequency', 2 / 9, 0, 1], ['kuwahara', 0, 0, 1], ['kuwaharaRadius', 1 / 7, 0, 1],
  ['kuwaharaSharpness', 5 / 16, 0, 1], ['kuwaharaSaturation', 0.5, 0, 1],
];

/** The 18 effects themselves (colorGrading.ts: HF_COLOR_GRADING_ACTIVE_EFFECT_KEYS): a grade with any above 0.0001 is active. */
const ACTIVE_EFFECTS = [
  'blur', 'pixelate', 'chromaBleed', 'tapeDamage', 'filmArtifacts', 'halftone', 'twoInkPrint', 'ascii', 'dither', 'bloom',
  'monoScreen', 'scanlines', 'chromaticAberration', 'crtCurvature', 'digitalGlitch', 'engraving', 'crosshatch', 'kuwahara',
] as const;

/** The effects of HyperFrames' list that the engine draws: all of them. */
export const EFFECTS_DRAWN: readonly string[] = ACTIVE_EFFECTS;

const isRecord = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
/** colorGrading.ts: readLimitedValue. */
const limited = (v: unknown, lo: number, hi: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? clamp(n, lo, hi) : 0;
};
const unit = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? clamp(n, 0, 1) : fallback;
};
const wrapDegrees = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? ((n % 360) + 360) % 360 : fallback;
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

const identityCurve = (): [number, number][] => [[0, 0], [1, 1]];

/** The effect controls a tween can animate (`--hf-color-grading-blur` and so on; colorGrading.ts: HF_COLOR_GRADING_ANIMATABLE_PROPERTIES). */
export const ANIMATED_EFFECT_LIMITS: Record<string, number> = { blur: 1, bloom: 3, kuwahara: 1, pixelate: 1, ascii: 1, dither: 1 };

/** colorGrading.ts: normalizeCurve. */
function normalizeCurve(value: unknown): [number, number][] {
  if (!Array.isArray(value) || value.length < 2) return identityCurve();
  const points: [number, number][] = [];
  for (const p of value) {
    if (!Array.isArray(p) || p.length !== 2) return identityCurve();
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return identityCurve();
    points.push([clamp(x, 0, 1), clamp(y, 0, 1)]);
  }
  points.sort((a, b) => a[0] - b[0]);
  if (points.some((p, i) => i > 0 && p[0] === points[i - 1]![0])) return identityCurve();
  if (points[0]![0] > 0) points.unshift([0, 0]);
  if (points[points.length - 1]![0] < 1) points.push([1, 1]);
  return points.length > MAX_CURVE_POINTS ? identityCurve() : points;
}

/** colorGrading.ts: normalizeHueCurve. */
function normalizeHueCurve(value: unknown, lo: number, hi: number): [number, number][] {
  if (!Array.isArray(value) || value.length < 3 || value.length > MAX_CURVE_POINTS) return [];
  const points: [number, number][] = [];
  for (const p of value) {
    if (!Array.isArray(p) || p.length !== 2) return [];
    const hue = Number(p[0]);
    const delta = Number(p[1]);
    if (!Number.isFinite(hue) || !Number.isFinite(delta)) return [];
    points.push([wrapDegrees(hue), clamp(delta, lo, hi)]);
  }
  points.sort((a, b) => a[0] - b[0]);
  return points.some((p, i) => i > 0 && p[0] === points[i - 1]![0]) ? [] : points;
}

/** colorGrading.ts: normalizeSecondary. */
function normalizeSecondary(value: unknown): (Secondary & { enabled: boolean }) | null {
  if (!isRecord(value) || !isRecord(value.key) || !isRecord(value.correction)) return null;
  const soft = (v: unknown): Secondary['key']['saturation'] => {
    const r = isRecord(v) ? v : {};
    const first = limited(r.min ?? 0, 0, 1);
    const second = limited(r.max ?? 1, 0, 1);
    return { min: Math.min(first, second), max: Math.max(first, second), softness: limited(r.softness ?? 0.05, 0, 0.5) };
  };
  const hueSource = isRecord(value.key.hue) ? value.key.hue : {};
  const range = limited(hueSource.range ?? 180, 0, 180);
  return {
    enabled: value.enabled !== false,
    key: {
      hue: { center: wrapDegrees(hueSource.center, 0), range, softness: limited(hueSource.softness ?? 0, 0, 180 - range) },
      saturation: soft(value.key.saturation),
      luma: soft(value.key.luma),
    },
    correction: {
      hueShift: limited(value.correction.hueShift ?? 0, -180, 180),
      saturation: limited(value.correction.saturation ?? 0, -1, 1),
      luma: limited(value.correction.luma ?? 0, -1, 1),
      temperature: limited(value.correction.temperature ?? 0, -1, 1),
      tint: limited(value.correction.tint ?? 0, -1, 1),
    },
  };
}

/**
 * The attribute's value as a grade: a JSON object, or a preset's name; null when it is off or unreadable (colorGrading.ts:
 * normalizeHfColorGrading). `overrides` are the animated values (`--hf-color-grading-intensity`, `-lut-intensity`, `-exposure`).
 */
export function normalizeGrade(
  raw: unknown,
  variables: Record<string, unknown> = {},
  overrides: { intensity?: number | null; exposure?: number | null; lutIntensity?: number | null; effects?: Record<string, number | null> } = {},
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
    adjust[key] = limited(rawAdjust[key] ?? preset?.adjust[key] ?? 0, lo, hi);
  }
  if (overrides.exposure != null) adjust.exposure = clamp(overrides.exposure, -2, 2);
  const rawWheels = isRecord(value.wheels) ? value.wheels : {};
  const wheel = (name: string): Grade['wheels']['shadows'] => {
    const w = isRecord(rawWheels[name]) ? rawWheels[name] : {};
    return { hue: wrapDegrees(w.hue, 0), amount: limited(w.amount ?? 0, 0, 1), level: limited(w.level ?? 0, -1, 1) };
  };
  const rawCurves = isRecord(value.curves) ? value.curves : {};
  const rawHueCurves = isRecord(value.hueCurves) ? value.hueCurves : {};
  const rawDetails = isRecord(value.details) ? value.details : {};
  const presetDetails: Partial<Record<DetailKey, number>> = preset?.details ?? {};
  const details = { ...DETAIL_DEFAULTS };
  for (const key of DETAIL_KEYS) {
    const [lo, hi] = DETAIL_LIMITS[key];
    details[key] = limited(rawDetails[key] ?? presetDetails[key] ?? DETAIL_DEFAULTS[key], lo, hi);
  }
  const rawEffects = isRecord(value.effects) ? value.effects : {};
  const effects: Record<string, number> = {};
  for (const [key, fallback, lo, hi] of EFFECT_CONTROLS) {
    effects[key] = limited(rawEffects[key] ?? preset?.effects?.[key] ?? fallback, lo, hi);
    const animated = overrides.effects?.[key];
    if (animated != null && key in ANIMATED_EFFECT_LIMITS) effects[key] = clamp(animated, 0, hi);
  }
  const rawPalette = value.palette;
  const palette =
    Array.isArray(rawPalette) && rawPalette.length >= 2 && rawPalette.length <= 6 && rawPalette.every((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c))
      ? rawPalette.map((c: string) => c.toLowerCase())
      : null;
  const lutRaw = value.lut;
  const lutSrc = typeof lutRaw === 'string' ? lutRaw.trim() : isRecord(lutRaw) && typeof lutRaw.src === 'string' ? lutRaw.src.trim() : '';
  const lutIntensity = overrides.lutIntensity ?? (isRecord(lutRaw) ? unit(lutRaw.intensity, 1) : 1);
  const secondaries: Secondary[] = [];
  if (Array.isArray(value.secondaries)) {
    for (const candidate of value.secondaries.slice(0, MAX_SECONDARIES)) {
      const secondary = normalizeSecondary(candidate);
      if (secondary?.enabled) secondaries.push({ key: secondary.key, correction: secondary.correction });
    }
  }
  return {
    intensity: overrides.intensity != null ? clamp(overrides.intensity, 0, 1) : unit(value.intensity, preset?.intensity ?? 1),
    adjust,
    wheels: { shadows: wheel('shadows'), midtones: wheel('midtones'), highlights: wheel('highlights') },
    curves: { master: normalizeCurve(rawCurves.master), red: normalizeCurve(rawCurves.red), green: normalizeCurve(rawCurves.green), blue: normalizeCurve(rawCurves.blue) },
    hueCurves: {
      hueVsHue: normalizeHueCurve(rawHueCurves.hueVsHue, -180, 180),
      hueVsSaturation: normalizeHueCurve(rawHueCurves.hueVsSaturation, -1, 1),
      hueVsLuma: normalizeHueCurve(rawHueCurves.hueVsLuma, -1, 1),
    },
    secondaries,
    details,
    effects,
    palette,
    lut: lutSrc === '' ? null : { src: lutSrc, intensity: lutIntensity },
  };
}

const FLAT = 0.0001;

/** colorGrading.ts: isHfColorGradingActive. A grade that is not active leaves the picture as it is. */
export function isGradeActive(grade: Grade): boolean {
  if (grade.details.vignette > FLAT || grade.details.grain > FLAT || ACTIVE_EFFECTS.some((key) => Math.abs(grade.effects[key] ?? 0) > FLAT)) return true;
  if (grade.intensity === 0) return false;
  if (grade.lut && grade.lut.intensity !== 0) return true;
  return (
    ADJUST_KEYS.some((key) => Math.abs(grade.adjust[key]) > FLAT) ||
    Object.values(grade.wheels).some((w) => Math.abs(w.amount) > FLAT || Math.abs(w.level) > FLAT) ||
    Object.values(grade.curves).some((c) => c.some(([x, y]) => Math.abs(x - y) > FLAT)) ||
    Object.values(grade.hueCurves).some((c) => c.some(([, d]) => Math.abs(d) > FLAT)) ||
    grade.secondaries.some((s) => Object.values(s.correction).some((v) => Math.abs(v) > FLAT))
  );
}

/** The runtime's `hashStringSeed` (FNV-1a, modulo 10000). */
export function seedOf(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 10000;
}

/**
 * The `colorGrade` effect of the grade (the attribute the DOM painter reads; it adds the `type` and the picture's box),
 * or null when the grade changes nothing. `seed` is the grain's: the element's seed plus the whole 60ths of a second of
 * the time, as the runtime's shader gets it; `time` is the time in seconds the time-varying effects run at. Only the effect
 * controls that differ from their defaults are written.
 */
export function gradeAttribute(grade: Grade, seed: number, time: number): string | null {
  if (!isGradeActive(grade)) return null;
  const d = grade.details;
  const effects: Record<string, number> = {};
  for (const [key, fallback] of EFFECT_CONTROLS) if (grade.effects[key] !== fallback) effects[key] = grade.effects[key]!;
  return JSON.stringify({
    intensity: grade.intensity,
    adjust: grade.adjust,
    wheels: grade.wheels,
    curves: grade.curves,
    hueCurves: grade.hueCurves,
    secondaries: grade.secondaries,
    lut: grade.lut,
    vignette: { amount: d.vignette, midpoint: d.vignetteMidpoint, roundness: d.vignetteRoundness, feather: d.vignetteFeather },
    grain: { amount: d.grain, size: d.grainSize, roughness: d.grainRoughness, seed },
    effects,
    palette: grade.palette,
    time,
  });
}

/** What the grade asks for and is not drawn: the effects of its `effects` list the engine has no pass for (none now). */
export function gradeNotDrawn(grade: Grade): string[] {
  return ACTIVE_EFFECTS.filter((name) => (grade.effects[name] ?? 0) > FLAT && !EFFECTS_DRAWN.includes(name)).map((name) => `effects.${name}`);
}
