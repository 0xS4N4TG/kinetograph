/**
 * Every number on the Speed page. The charts, the tables and the summary line read this file, so a re-measure is an
 * edit here and nothing else. Put the measured value in, never a rounded or friendlier one.
 */

/** One engine's result on one scene: median of the timed runs, then the best and worst of them. */
export interface Run {
  /** Wall seconds, median. */
  s: number;
  min: number;
  max: number;
  /** Frames per second of wall time. */
  fps: number;
  /** Peak resident memory, MB. */
  rssMb: number;
}

/** How many times faster Kinetograph is, as the page states it: median over median, then best against worst and worst against best. */
export interface Ratio {
  x: number;
  lo: number;
  hi: number;
}

export type Kind = 'port' | 'page' | 'project';

export interface Scene {
  /** The stable key: the name the benchmark folders use. Shown only as a small reference in the tables. */
  id: string;
  /** What a newcomer calls it: two to four plain words. */
  title: string;
  /** One short line: what the video shows and what makes it hard to draw. */
  summary: string;
  /** Length in seconds, rounded to a whole second. */
  seconds: number;
  frames: number;
  /** Width x height in pixels. */
  size: string;
  /** A still under `public/speed/`, when there is one. */
  thumb?: string;
  /** `port`: a HyperFrames page with a Remotion port. `page`: a HyperFrames page only. `project`: a Remotion project both engines run unchanged. */
  kind: Kind;
  kinetograph: Run;
  hyperframes?: Run;
  remotion?: Run;
  vsHyperframes?: Ratio;
  vsRemotion?: Ratio;
}

/** The 2026-11-09 per-scene benchmark. */
export const BENCH = {
  date: '2026-11-09',
  machine: 'Apple M4 (10 cores)',
  os: 'macOS 26.5.2',
  node: 'v26.7.0',
  kinetographCommit: '3eb93eaa',
  hyperframes: '0.9.26',
  remotion: '4.0.542',
  /** Timed renders per cell, after one warm-up render. */
  n: 3,
  warmups: 1,
  /** The 1-minute load average was under this before every run. */
  loadUnder: 3.0,
  settings: {
    kinetograph: 'default 4 workers',
    remotion: '--concurrency 5, headless shell',
    hyperframes: 'defaults of hyperframes render, headless Chrome shell',
  },
} as const;

export const SCENES: Scene[] = [
  {
    id: 'film',
    title: '60-second film',
    summary: '8 parts: a title, charts, maps, a shader orb and a light flare',
    seconds: 60,
    frames: 1800,
    size: '1920x1080',
    thumb: '/speed/film.webp',
    kind: 'port',
    kinetograph: { s: 10.26, min: 10.17, max: 10.28, fps: 175.4, rssMb: 2708 },
    hyperframes: { s: 23.25, min: 23.08, max: 23.7, fps: 77.4, rssMb: 3810 },
    remotion: { s: 35.94, min: 35.89, max: 36.24, fps: 50.1, rssMb: 3946 },
    vsHyperframes: { x: 2.3, lo: 2.2, hi: 2.3 },
    vsRemotion: { x: 3.5, lo: 3.5, hi: 3.6 },
  },
  {
    id: 'dm4',
    title: 'US adoption map',
    summary: 'US states coloured by adoption rate, with animated arcs between cities',
    seconds: 12,
    frames: 360,
    size: '1920x1080',
    thumb: '/speed/dm4.webp',
    kind: 'port',
    kinetograph: { s: 2.77, min: 2.76, max: 2.81, fps: 130.1, rssMb: 1880 },
    hyperframes: { s: 6.58, min: 6.56, max: 6.87, fps: 54.8, rssMb: 3264 },
    remotion: { s: 5.87, min: 5.87, max: 5.91, fps: 61.3, rssMb: 3122 },
    vsHyperframes: { x: 2.4, lo: 2.3, hi: 2.5 },
    vsRemotion: { x: 2.1, lo: 2.1, hi: 2.1 },
  },
  {
    id: 'mg1',
    title: 'Terminal that shatters',
    summary: 'Typing in a terminal, which breaks into 72 shards, then big kinetic text',
    seconds: 8,
    frames: 240,
    size: '1920x1080',
    thumb: '/speed/mg1.webp',
    kind: 'port',
    kinetograph: { s: 4.07, min: 3.99, max: 4.1, fps: 58.9, rssMb: 2597 },
    hyperframes: { s: 51.51, min: 51.42, max: 51.68, fps: 4.7, rssMb: 5528 },
    remotion: { s: 5.39, min: 5.38, max: 5.41, fps: 44.6, rssMb: 3083 },
    vsHyperframes: { x: 12.6, lo: 12.5, hi: 12.9 },
    vsRemotion: { x: 1.3, lo: 1.3, hi: 1.4 },
  },
  {
    id: 'mg2',
    title: 'Revenue counter',
    summary: 'A glowing dollar figure counting up under a label',
    seconds: 6,
    frames: 180,
    size: '1920x1080',
    thumb: '/speed/mg2.webp',
    kind: 'port',
    kinetograph: { s: 1.19, min: 1.18, max: 1.19, fps: 151.0, rssMb: 1694 },
    hyperframes: { s: 4.14, min: 4.05, max: 4.15, fps: 43.4, rssMb: 3130 },
    remotion: { s: 3.72, min: 3.71, max: 3.72, fps: 48.4, rssMb: 2601 },
    vsHyperframes: { x: 3.5, lo: 3.4, hi: 3.5 },
    vsRemotion: { x: 3.1, lo: 3.1, hi: 3.2 },
  },
  {
    id: 'dm1',
    title: 'Language bar chart',
    summary: 'Bars for the most-used programming languages in a survey',
    seconds: 12,
    frames: 360,
    size: '1920x1080',
    kind: 'page',
    kinetograph: { s: 1.58, min: 1.58, max: 1.62, fps: 227.3, rssMb: 1864 },
    hyperframes: { s: 7.57, min: 7.52, max: 7.58, fps: 47.6, rssMb: 2966 },
    vsHyperframes: { x: 4.8, lo: 4.6, hi: 4.8 },
  },
  {
    id: 'dm2',
    title: 'Hand-drawn bar race',
    summary: 'Wobbly hand-drawn bars swap places as language shares change',
    seconds: 10,
    frames: 300,
    size: '1920x1080',
    thumb: '/speed/dm2.webp',
    kind: 'page',
    kinetograph: { s: 1.65, min: 1.65, max: 1.69, fps: 181.8, rssMb: 1736 },
    hyperframes: { s: 5.01, min: 4.99, max: 5.04, fps: 59.9, rssMb: 4268 },
    vsHyperframes: { x: 3.0, lo: 3.0, hi: 3.1 },
  },
  {
    id: 'dm5',
    title: 'Flight to Paris',
    summary: 'A plane flies a glowing arc from New York to Paris across a map',
    seconds: 6,
    frames: 180,
    size: '1920x1080',
    thumb: '/speed/dm5.webp',
    kind: 'page',
    kinetograph: { s: 1.91, min: 1.89, max: 1.92, fps: 94.0, rssMb: 1654 },
    hyperframes: { s: 6.64, min: 6.63, max: 6.66, fps: 27.1, rssMb: 3956 },
    vsHyperframes: { x: 3.5, lo: 3.5, hi: 3.5 },
  },
  {
    id: 'mg4',
    title: 'Social post card',
    summary: 'A post card tilting in 3D over a colour gradient (portrait)',
    seconds: 7,
    frames: 210,
    size: '1080x1350',
    thumb: '/speed/mg4.webp',
    kind: 'page',
    kinetograph: { s: 1.33, min: 1.31, max: 1.34, fps: 157.7, rssMb: 1523 },
    hyperframes: { s: 4.72, min: 4.7, max: 4.82, fps: 44.5, rssMb: 3725 },
    vsHyperframes: { x: 3.5, lo: 3.5, hi: 3.7 },
  },
  {
    id: 'mg5',
    title: 'Map route to Tokyo',
    summary: 'A glowing route from San Francisco to Tokyo on a world map',
    seconds: 8,
    frames: 240,
    size: '1920x1080',
    thumb: '/speed/mg5.webp',
    kind: 'page',
    kinetograph: { s: 1.89, min: 1.88, max: 1.89, fps: 127.3, rssMb: 2088 },
    hyperframes: { s: 5.16, min: 5.08, max: 5.29, fps: 46.5, rssMb: 4433 },
    vsHyperframes: { x: 2.7, lo: 2.7, hi: 2.8 },
  },
  {
    id: 'pr1',
    title: 'Code change announcement',
    summary: 'A code diff, then key points and numbers for a merged change',
    seconds: 30,
    frames: 900,
    size: '1920x1080',
    thumb: '/speed/pr1.webp',
    kind: 'page',
    kinetograph: { s: 2.7, min: 2.69, max: 2.74, fps: 333.3, rssMb: 1928 },
    hyperframes: { s: 12.51, min: 12.39, max: 12.66, fps: 72.0, rssMb: 3243 },
    vsHyperframes: { x: 4.6, lo: 4.5, hi: 4.7 },
  },
  {
    id: 'compat',
    title: 'Three-card explainer',
    summary: 'Paper-style cards over a blurred colour background, with a headline',
    seconds: 5,
    frames: 150,
    size: '1200x1000',
    thumb: '/speed/compat.webp',
    kind: 'project',
    kinetograph: { s: 1.09, min: 1.08, max: 1.09, fps: 138.1, rssMb: 1227 },
    remotion: { s: 4.26, min: 4.24, max: 4.28, fps: 35.2, rssMb: 2470 },
    vsRemotion: { x: 3.9, lo: 3.9, hi: 4.0 },
  },
  {
    id: 'papercut',
    title: 'Paper cut-out explainer',
    summary: 'A vertical video in a paper cut-out style, textured and shadowed',
    seconds: 33,
    frames: 988,
    size: '1080x1920',
    kind: 'project',
    kinetograph: { s: 20.46, min: 20.45, max: 20.48, fps: 48.3, rssMb: 3240 },
    remotion: { s: 646.13, min: 644.35, max: 654.4, fps: 1.5, rssMb: 10599 },
    vsRemotion: { x: 31.6, lo: 31.5, hi: 32.0 },
  },
];

/** The groups the chart is divided into, each with the plain line that says what its rows compare. */
export const GROUPS: { kind: Kind; title: string; blurb: string }[] = [
  {
    kind: 'port',
    title: 'The same video in all three engines',
    blurb: 'Written for HyperFrames, then redrawn by hand for Remotion, so each engine draws the same animation.',
  },
  {
    kind: 'page',
    title: 'HyperFrames pages',
    blurb: 'Written for HyperFrames only, so there is no Remotion bar. Kinetograph and HyperFrames play the same page.',
  },
  {
    kind: 'project',
    title: 'Remotion projects',
    blurb: 'Written for Remotion. Kinetograph and Remotion run the same project, untouched. HyperFrames cannot run it.',
  },
];

const papercut = SCENES.find((s) => s.id === 'papercut')!;

/** Why the Paper cut-out explainer is so far apart: the plain note, the technical names behind it, and the video it is about. */
export const PAPERCUT = {
  scene: papercut,
  note: `In every frame the video lays paper-grain texture and soft shadows over the whole picture. Remotion drew it at ${papercut.remotion!.fps} frames per second from the first frame, so the time is Chrome\u2019s own: Chrome works those effects out on the processor. Kinetograph draws them on the graphics card.`,
  detail:
    'The texture is full-frame SVG filters (feTurbulence into feDisplacementMap) and the shadows are drop-shadows. Chrome\u2019s cost was not profiled any further than that steady rate.',
};

/**
 * Worker scaling. Measured after the benchmark above, on a later build that is not released yet. Set `SHOW_WORKER_SCALING`
 * to `false` to hide the section (the text, the three drawings and the heading's table of contents entry); delete the
 * heading in `speed.mdx` too if it stays hidden.
 */
export const SHOW_WORKER_SCALING = true;

export const WORKERS = {
  status: 'unreleased build, to be re-measured',
  date: '2026-11-11',
  machine: 'Apple M4 (4 fast + 6 slow cores)',
  /** The video, as the page calls it. */
  video: 'the 60-second film',
  frames: 1800,
  size: '1920x1080',
  protocol: 'median of 3 after a warm-up',
  branch: 'fix/integration',
  commit: 'f73959cf',
  /** Wall seconds for the whole render, by worker count. */
  points: [
    { workers: 1, s: 11.39 },
    { workers: 2, s: 9.75 },
    { workers: 3, s: 8.54 },
    { workers: 4, s: 8.56 },
    { workers: 6, s: 8.93 },
  ],
  /** Share of a worker's time spent playing the animation through frames other workers drew. */
  replayShare: 0.42,
  /** How much longer each frame takes once the extra workers land on slow cores. */
  slowCoreFactor: 1.8,
  /** Where one frame's time goes at 1 worker, in milliseconds. */
  frameMs: [
    { label: 'Waiting for layout and paint', ms: 3.5 },
    { label: 'Seeking timelines and clips', ms: 1.1 },
    { label: 'Packing and unpacking page data', ms: 0.7 },
    { label: 'React update and the rest', ms: 0.9 },
  ],
  frameMsTotal: 6.2,
} as const;

/** Speed-up against one worker, from the measured times. */
export function speedUp(s: number): number {
  return WORKERS.points[0].s / s;
}
