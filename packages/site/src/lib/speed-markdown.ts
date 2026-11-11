import { BENCH, PAPERCUT, SCENES, SHOW_WORKER_SCALING, WORKERS, speedUp, type Ratio, type Scene } from '../data/speed.ts';

/**
 * The Speed page as text. The page's components draw charts, which a Markdown reader cannot see, so this file writes
 * the same numbers as plain tables from `data/speed.ts`. The docs components use its row helpers too, and
 * `llms.mdx/[...slug]/route.ts` swaps each component tag in the exported page for `speedExport()`.
 */

export const range = (a: number, b: number) => `${a.toFixed(2)}–${b.toFixed(2)}`;
export const ratio = (r?: Ratio) => (r ? `${r.x.toFixed(1)}× (${r.lo.toFixed(1)}–${r.hi.toFixed(1)}×)` : '');

/** "Unreleased build, to be re-measured" at the start of a sentence. */
export const status = () => WORKERS.status[0].toUpperCase() + WORKERS.status.slice(1);

/** One row per engine for a scene: Kinetograph first, then the engines it was compared with. */
export function sceneRows(s: Scene) {
  return [
    { engine: 'Kinetograph', run: s.kinetograph, ratio: undefined as Ratio | undefined },
    ...(s.hyperframes ? [{ engine: `HyperFrames ${BENCH.hyperframes}`, run: s.hyperframes, ratio: s.vsHyperframes }] : []),
    ...(s.remotion ? [{ engine: `Remotion ${BENCH.remotion}`, run: s.remotion, ratio: s.vsRemotion }] : []),
  ];
}

export const SCENE_HEAD = ['scene', 'engine', 'median s', 'min–max', 'fps', 'peak RSS MB', 'Kinetograph faster by'];
export const sceneCells = (s: Scene) =>
  sceneRows(s).map((r, i) => [i ? '' : s.id, r.engine, r.run.s.toFixed(2), range(r.run.min, r.run.max), r.run.fps.toFixed(1), String(r.run.rssMb), ratio(r.ratio)]);

export const SPREAD_HEAD = ['scene', 'vs HyperFrames', 'vs Remotion'];
export const spreadCells = (s: Scene) => [s.id, ratio(s.vsHyperframes) || '–', ratio(s.vsRemotion) || '–'];

export const WORKER_HEAD = ['workers', 'wall s', 'speed-up vs 1 worker'];
export const workerCells = () => WORKERS.points.map((p) => [String(p.workers), p.s.toFixed(2), `${speedUp(p.s).toFixed(2)}×`]);

export const FRAME_HEAD = ['part of a frame', 'ms'];
export const frameCells = () => [...WORKERS.frameMs.map((p) => [p.label, p.ms.toFixed(1)]), ['total', WORKERS.frameMsTotal.toFixed(1)]];

/** The worker numbers the prose quotes. */
export function fact(k: 'gain' | 'replay' | 'slow'): string {
  const four = WORKERS.points.find((p) => p.workers === 4)!;
  return { gain: `${speedUp(four.s).toFixed(2)}×`, replay: `${Math.round(WORKERS.replayShare * 100)}%`, slow: `${WORKERS.slowCoreFactor.toFixed(1)}×` }[k];
}

export const summary = () => {
  const span = (key: 'vsHyperframes' | 'vsRemotion') => {
    const xs = SCENES.flatMap((s) => (s[key] ? [s[key].x] : []));
    return { n: xs.length, lo: Math.min(...xs), hi: Math.max(...xs) };
  };
  return { hf: span('vsHyperframes'), rm: span('vsRemotion') };
};

export const workerCaption = () =>
  `${WORKERS.scene} scene, ${WORKERS.frames} frames at ${WORKERS.size}, ${WORKERS.machine}, ${WORKERS.protocol}, ${WORKERS.date}. Build ${WORKERS.branch} ${WORKERS.commit}: ${WORKERS.status}.`;

export function methodRows(): [string, string][] {
  return [
    ['Machine', `${BENCH.machine}, ${BENCH.os}`],
    ['Node', BENCH.node],
    ['Date', BENCH.date],
    ['Kinetograph', `commit ${BENCH.kinetographCommit}`],
    ['HyperFrames', BENCH.hyperframes],
    ['Remotion', BENCH.remotion],
    ['Protocol', `${BENCH.warmups} warm-up render, then ${BENCH.n} timed renders; median and min–max of the ${BENCH.n}`],
    ['Load', `1-minute load average under ${BENCH.loadUnder.toFixed(1)} before every run, machine otherwise idle`],
    ['Timed', 'the whole render command, start to finished H.264 file'],
    ['Kinetograph run', BENCH.settings.kinetograph],
    ['Remotion run', BENCH.settings.remotion],
    ['HyperFrames run', BENCH.settings.hyperframes],
    ['Ratio', `the other engine’s median over Kinetograph’s; the bracket is best over worst and worst over best of the ${BENCH.n} runs`],
    ['Scenes', 'no version has audio; each Remotion port rewrites the HyperFrames page (GSAP tweens as frame maths); compat and papercut are Remotion projects both engines run unchanged'],
    ['Not measured', 'any other machine; Remotion on the six pages with no port; HyperFrames on compat and papercut; steady-state fps'],
  ];
}

function table(head: string[], rows: string[][], left = 1): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [line(head), line(head.map((_, i) => (i < left ? '---' : '---:'))), ...rows.map(line)].join('\n');
}

/** The Markdown for one component tag of the Speed page. */
export function speedExport(tag: string, props: { k?: string } = {}): string | undefined {
  switch (tag) {
    case 'SpeedSummary': {
      const { hf, rm } = summary();
      return `On one Apple M4, Kinetograph rendered ${hf.n} scenes ${hf.lo}× to ${hf.hi}× faster than HyperFrames, and ${rm.n} scenes ${rm.lo}× to ${rm.hi}× faster than Remotion. Each scene is the median of ${BENCH.n} timed renders. The factor depends on the scene, so there is no single number.`;
    }
    case 'SpeedBars':
      return `${table(SCENE_HEAD, SCENES.flatMap(sceneCells), 2)}\n\n**papercut.** ${PAPERCUT.note} ${PAPERCUT.cause}`;
    case 'SpeedSpread':
      return table(SPREAD_HEAD, SCENES.map(spreadCells));
    case 'WorkerScaling':
      return `${table(WORKER_HEAD, workerCells())}\n\n${workerCaption()}`;
    case 'FrameTime':
      return `${table(FRAME_HEAD, frameCells())}\n\nOne worker, ${WORKERS.scene} scene, same build. ${status()}.`;
    case 'SpeedMethod':
      return methodRows().map(([k, v]) => `- ${k}: ${v}`).join('\n');
    case 'WorkerLanes':
      return '';
    case 'Fact':
      return fact(props.k as 'gain' | 'replay' | 'slow');
  }
}

/** Swaps the Speed page's component tags in exported Markdown for text, and drops the worker section when it is hidden. */
export function expandSpeed(text: string): string {
  let out = text;
  const open = out.indexOf('<WorkerSection>');
  const close = out.indexOf('</WorkerSection>');
  if (open >= 0 && close > open) {
    const inner = out.slice(open + '<WorkerSection>'.length, close).replace(/^ {2}/gm, '');
    out = out.slice(0, open) + (SHOW_WORKER_SCALING ? inner.trim() : '') + out.slice(close + '</WorkerSection>'.length);
  }
  return out.replace(/<(Speed\w+|Worker\w+|FrameTime|Fact)(?: k="(\w+)")? \/>/g, (whole, tag: string, k?: string) => speedExport(tag, { k }) ?? whole).replace(/\n{3,}/g, '\n\n');
}
