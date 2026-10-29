// The timeline ruler's marks. Every position is `frame * pxPerFrame`, the mapping the clips and the playhead use, with
// the frame a fraction when a mark falls between two frames (0.25 s at 30 fps is frame 7.5), so a clip that starts at
// 1.0 s starts exactly under the 00:01 tick.

/** The least room a label gets, px: "00:01.5" and a gap. */
export const MIN_LABEL_PX = 68;
/** The least distance between two minor marks, px. */
export const MIN_MINOR_PX = 10;

/** Label steps, seconds (the one-frame step is added per composition). */
const LABEL_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
/** How many gaps a label step may be cut into, tried from the finest. */
const SUBDIVISIONS = [30, 20, 10, 5, 4, 3, 2];

export interface RulerMark {
  /** Fractional frame. */
  frame: number;
  x: number;
}

export interface RulerLabel extends RulerMark {
  text: string;
  /** A whole second: drawn at full strength; the others (0.5, 1.5, ...) smaller and muted. */
  whole: boolean;
}

export interface Ruler {
  /** Seconds between labels. */
  step: number;
  labels: RulerLabel[];
  /** The marks between the labels (never at a label). */
  minor: RulerMark[];
}

/** `mm:ss`, with the fraction when the time is not a whole second. */
export function rulerLabel(seconds: number): string {
  const rounded = Math.round(seconds * 1000) / 1000;
  const m = Math.floor(rounded / 60);
  const s = rounded - m * 60;
  const whole = Math.abs(s - Math.round(s)) < 1e-6;
  const mm = String(m).padStart(2, '0');
  if (whole) return `${mm}:${String(Math.round(s)).padStart(2, '0')}`;
  const digits = Math.abs(s * 10 - Math.round(s * 10)) < 1e-6 ? 1 : 2;
  return `${mm}:${s.toFixed(digits).padStart(digits + 3, '0')}`;
}

/** The label step (seconds) for a zoom: the finest that leaves each label `MIN_LABEL_PX`. */
export function chooseStep(fps: number, pxPerFrame: number): number {
  const steps = [1 / fps, ...LABEL_STEPS];
  return steps.find((step) => step * fps * pxPerFrame >= MIN_LABEL_PX) ?? steps[steps.length - 1]!;
}

/** The number of gaps a label step is cut into for the minor marks; 1 when there is no room for any. */
export function chooseSubdivisions(step: number, fps: number, pxPerFrame: number): number {
  const frames = step * fps;
  // A mark for every frame, where the step is a whole number of them and there is room.
  const perFrame = Math.round(frames);
  const candidates = Math.abs(frames - perFrame) < 1e-6 && perFrame > 1 && perFrame <= 60 ? [perFrame, ...SUBDIVISIONS] : SUBDIVISIONS;
  for (const n of candidates) {
    // Whole frames apart at the finest, and room enough between marks.
    if (n <= frames + 1e-6 && (frames / n) * pxPerFrame >= MIN_MINOR_PX) return n;
  }
  return 1;
}

export function buildRuler(fps: number, durationInFrames: number, pxPerFrame: number): Ruler {
  const step = chooseStep(fps, pxPerFrame);
  const n = chooseSubdivisions(step, fps, pxPerFrame);
  const labels: RulerLabel[] = [];
  const minor: RulerMark[] = [];
  const seconds = durationInFrames / fps;
  // Counted by integers, so a step like 0.1 does not drift.
  const total = Math.floor(seconds / step + 1e-9);
  for (let i = 0; i <= total; i++) {
    const t = i * step;
    const frame = t * fps;
    if (frame < durationInFrames) {
      labels.push({ frame, x: frame * pxPerFrame, text: rulerLabel(t), whole: Math.abs(t - Math.round(t)) < 1e-6 });
    }
    for (let j = 1; j < n; j++) {
      const f = (t + (j * step) / n) * fps;
      if (f < durationInFrames) minor.push({ frame: f, x: f * pxPerFrame });
    }
  }
  return { step, labels, minor };
}
