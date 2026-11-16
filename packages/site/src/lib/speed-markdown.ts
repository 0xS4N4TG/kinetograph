import { BENCH, GROUPS, PAPERCUT, SCENES, SHOW_WORKER_SCALING, WORKERS, speedUp, type Ratio, type Scene } from '../data/speed.ts';

/**
 * The Speed page as text. The page's components draw charts, which a Markdown reader cannot see, so this file writes
 * the same numbers as plain tables from `data/speed.ts`. The docs components use its row helpers too, and
 * `llms.mdx/[...slug]/route.ts` swaps each component tag in the exported page for `speedExport()`.
 */

export const range = (a: number, b: number) => `${a.toFixed(2)}–${b.toFixed(2)}`;
export const ratio = (r?: Ratio) => (r ? `${r.x.toFixed(1)}× (${r.lo.toFixed(1)}–${r.hi.toFixed(1)}×)` : '');

/** "Unreleased build, to be re-measured" at the start of a sentence. */
export const status = () => WORKERS.status[0].toUpperCase() + WORKERS.status.slice(1);

/**
 * The videos in page order inside one group: the ones compared with HyperFrames first, by how much faster Kinetograph is
 * (largest first, from the printed medians), then the Remotion-only ones, smallest factor first.
 */
export function sortedScenes(): Scene[] {
  const vsHf = (s: Scene) => (s.hyperframes ? s.hyperframes.s / s.kinetograph.s : 0);
  const vsRem = (s: Scene) => (s.remotion ? s.remotion.s / s.kinetograph.s : 0);
  return [...SCENES].sort((a, b) => (vsHf(a) || vsHf(b) ? vsHf(b) - vsHf(a) : vsRem(a) - vsRem(b)));
}

/** The chart's groups, each with its videos in the order above. */
export function groupedScenes() {
  const all = sortedScenes();
  return GROUPS.map((g) => ({ ...g, scenes: all.filter((s) => s.kind === g.kind) })).filter((g) => g.scenes.length);
}

/** One row per engine for a scene: Kinetograph first, then the engines it was compared with. */
export function sceneRows(s: Scene) {
  return [
    { engine: 'Kinetograph', run: s.kinetograph, ratio: undefined as Ratio | undefined },
    ...(s.hyperframes ? [{ engine: `HyperFrames ${BENCH.hyperframes}`, run: s.hyperframes, ratio: s.vsHyperframes }] : []),
    ...(s.remotion ? [{ engine: `Remotion ${BENCH.remotion}`, run: s.remotion, ratio: s.vsRemotion }] : []),
  ];
}

/** "8 s" for the length of a video, as the rows show it. */
export const length = (s: Scene) => `${s.seconds} s`;

/** The columns before the engine name hold the video: its title, its internal id, its size and its frames. The page's own table folds the id into the title. */
export const SCENE_HEAD = ['video', 'id', 'size', 'frames', 'engine', 'median s', 'min–max', 'fps', 'peak RSS MB', 'Kinetograph faster by'];
export const SCENE_LEFT = 5;
export const sceneCells = (s: Scene) =>
  sceneRows(s).map((r, i) => [
    ...(i ? ['', '', '', ''] : [s.title, s.id, s.size, String(s.frames)]),
    r.engine,
    r.run.s.toFixed(2),
    range(r.run.min, r.run.max),
    r.run.fps.toFixed(1),
    String(r.run.rssMb),
    ratio(r.ratio),
  ]);

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
  return { videos: SCENES.length, hf: span('vsHyperframes'), rm: span('vsRemotion') };
};

/** The summary line, in plain words, from the data. */
export const summaryText = () => {
  const { videos, hf, rm } = summary();
  return `On one Apple M4, Kinetograph rendered ${videos} videos, from short motion graphics to data charts, maps and a 60-second film. HyperFrames and Remotion, two other programs that make video from code, rendered the ones they have a version of. Kinetograph was ${hf.lo}× to ${hf.hi}× faster than HyperFrames on ${hf.n} videos and ${rm.lo}× to ${rm.hi}× faster than Remotion on ${rm.n}. Each time is the median of ${BENCH.n} timed renders. The factor depends on the video, so there is no single number.`;
};

/** The note under the chart about the video that is far from the rest: its lead-in, then the note. */
export const papercutHead = () => `Why “${PAPERCUT.scene.title}” is so far apart.`;

/** A sentence that starts with the video's name. */
export const cap = (t: string) => t[0].toUpperCase() + t.slice(1);

export const workerCaption = () =>
  `${cap(WORKERS.video)}, ${WORKERS.frames} frames at ${WORKERS.size}, ${WORKERS.machine}, ${WORKERS.protocol}, ${WORKERS.date}. Build ${WORKERS.branch} ${WORKERS.commit}: ${WORKERS.status}.`;

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
    ['Videos', 'none has audio; each Remotion port redraws a HyperFrames page by hand (GSAP tweens as frame maths); the two Remotion projects (compat and papercut) run unchanged in both engines'],
    ['Not measured', 'any other machine; Remotion on the six HyperFrames pages with no port; HyperFrames on the two Remotion projects; steady-state fps'],
  ];
}

function table(head: string[], rows: string[][], left = 1): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [line(head), line(head.map((_, i) => (i < left ? '---' : '---:'))), ...rows.map(line)].join('\n');
}

/** The Markdown for one component tag of the Speed page. */
export function speedExport(tag: string, props: { k?: string } = {}): string | undefined {
  switch (tag) {
    case 'SpeedSummary':
      return summaryText();
    case 'SpeedBars': {
      const groups = groupedScenes()
        .map((g) => `**${g.title}.** ${g.blurb}\n\n${g.scenes.map((s) => `- ${s.title} (${s.id}): ${s.summary}. ${length(s)}, ${s.frames} frames, ${s.size}.`).join('\n')}`)
        .join('\n\n');
      const rows = groupedScenes().flatMap((g) => g.scenes.flatMap(sceneCells));
      return `${groups}\n\n${table(SCENE_HEAD, rows, SCENE_LEFT)}\n\n**${papercutHead()}** ${PAPERCUT.note}\n\n${PAPERCUT.detail}`;
    }
    case 'WorkerScaling':
      return `${table(WORKER_HEAD, workerCells())}\n\n${workerCaption()}`;
    case 'FrameTime':
      return `${table(FRAME_HEAD, frameCells())}\n\nOne worker, ${WORKERS.video}, same build. ${status()}.`;
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
