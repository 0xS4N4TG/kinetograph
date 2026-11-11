import { ChevronRightIcon } from 'lucide-react';
import localFont from 'next/font/local';
import { Fragment, useId, type ReactNode } from 'react';

import { BENCH, PAPERCUT, SCENES, SHOW_WORKER_SCALING, WORKERS, speedUp, type Kind } from '@/data/speed';
import { barsChart, frameChart, lanesChart, spreadChart, workersChart, type Chart, type Paint } from '@/lib/speed-charts';
import type { Diagram } from '@/lib/sketch';

// Kalam (SIL OFL 1.1), as in the engine diagram: the hand-lettered labels.
const sketch = localFont({
  src: [
    { path: '../../../node_modules/@fontsource/kalam/files/kalam-latin-400-normal.woff2', weight: '400' },
    { path: '../../../node_modules/@fontsource/kalam/files/kalam-latin-700-normal.woff2', weight: '700' },
  ],
  display: 'swap',
});

const PAINT: Record<Paint, string> = {
  accent: 'var(--cobalt)',
  ink: 'var(--ink)',
  muted: 'var(--muted)',
  paper: 'var(--paper)',
};

function Strokes({ diagram, color }: { diagram: Diagram; color: string }) {
  return (
    <g fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round">
      {diagram.ink.map((p, i) => (
        <path key={i} d={p.d} strokeWidth={p.w} strokeDasharray={p.dash} stroke={p.tone === 'muted' ? 'var(--muted)' : color} />
      ))}
    </g>
  );
}

/** Labels: the words in Kalam, the numbers in the site's mono, which keeps a 1 from looking like an l. */
function Labels({ diagram, color }: { diagram: Diagram; color: string }) {
  return (
    <g aria-hidden="true">
      {diagram.labels.map((l, i) => (
        <text
          key={i}
          x={l.x}
          y={l.y}
          fontSize={l.size}
          fontWeight={l.weight}
          textAnchor={l.anchor}
          fill={color === 'var(--cobalt)' ? color : l.tone === 'ink' ? 'var(--ink)' : 'var(--muted)'}
          transform={`rotate(${l.rot} ${l.x} ${l.y})`}
        >
          {l.text.split(/(\d[\d.]*)/).map((part, j) =>
            /^\d/.test(part) ? (
              <tspan key={j} fontFamily="var(--font-jb)" fontSize={l.size * 0.88} fontWeight={l.weight === 700 ? 700 : 400}>
                {part}
              </tspan>
            ) : (
              part
            ),
          )}
        </text>
      ))}
    </g>
  );
}

function FillShapes({ fills }: { fills: Chart['fills'] }) {
  return (
    <g aria-hidden="true">
      {fills.map((f, i) =>
        f.shape === 'dot' ? (
          <circle key={i} cx={f.x} cy={f.y} r={f.r} fill={PAINT[f.paint]} fillOpacity={f.opacity} />
        ) : (
          <rect key={i} x={f.x} y={f.y} width={f.w} height={f.h} fill={PAINT[f.paint]} fillOpacity={f.opacity} />
        ),
      )}
    </g>
  );
}

/** The paper card of the engine diagram, holding one drawing, with a collapsed table of its data under it. */
function Figure({ chart, caption, table }: { chart: Chart; caption?: ReactNode; table?: ReactNode }) {
  const id = useId();
  return (
    <div className="not-prose my-6">
      <figure
        className={`${sketch.className} overflow-hidden rounded-xl border border-fd-border bg-(--paper) text-(--ink) [--ink:#1d1b18] [--muted:#6a6459] [--paper:#fbf8f0] dark:[--ink:#ecebe8] dark:[--muted:#9d9a93] dark:[--paper:#17171a]`}
      >
        <svg
          viewBox={`0 0 ${chart.width} ${chart.height}`}
          role="img"
          aria-labelledby={`${id}t ${id}d`}
          className="block h-auto w-full"
        >
          <title id={`${id}t`}>{chart.title}</title>
          <desc id={`${id}d`}>{chart.desc}</desc>
          <FillShapes fills={chart.fills.filter((f) => !f.cover)} />
          <Strokes diagram={chart.ink} color="var(--ink)" />
          <Strokes diagram={chart.accent} color="var(--cobalt)" />
          <FillShapes fills={chart.fills.filter((f) => f.cover)} />
          <Labels diagram={chart.ink} color="var(--ink)" />
          <Labels diagram={chart.accent} color="var(--cobalt)" />
        </svg>
      </figure>
      {caption ? <p className="mt-2 text-xs leading-relaxed text-fd-muted-foreground">{caption}</p> : null}
      {table ? (
        <details className="group mt-2">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs font-medium text-fd-muted-foreground hover:text-fd-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
            Data table
          </summary>
          <div className="mt-2 overflow-x-auto rounded-lg border border-[var(--kg-box-border)]">{table}</div>
        </details>
      ) : null}
    </div>
  );
}

const th = 'whitespace-nowrap border-b border-[var(--kg-box-border)] px-3 py-2 text-left font-medium text-fd-muted-foreground';
const td = 'whitespace-nowrap px-3 py-1.5 tabular-nums';

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <table className="w-full border-collapse font-jb text-xs text-fd-foreground">
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={h} className={`${th} ${i ? 'text-right' : ''}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

const range = (a: number, b: number) => `${a}–${b}`;
const ratio = (r?: { x: number; lo: number; hi: number }) => (r ? `${r.x}× (${r.lo}–${r.hi}×)` : '');

function SceneRows({ kind }: { kind?: Kind }) {
  return (
    <>
      {SCENES.filter((s) => !kind || s.kind === kind).flatMap((s) => {
        const rows = [
          { name: 'Kinetograph', run: s.kinetograph, ratio: undefined },
          ...(s.hyperframes ? [{ name: `HyperFrames ${BENCH.hyperframes}`, run: s.hyperframes, ratio: s.vsHyperframes }] : []),
          ...(s.remotion ? [{ name: `Remotion ${BENCH.remotion}`, run: s.remotion, ratio: s.vsRemotion }] : []),
        ];
        return rows.map((r, i) => (
          <tr key={`${s.id}${r.name}`} className={i === 0 ? 'border-t border-[var(--kg-box-border)]' : ''}>
            <td className={`${td} text-left font-medium`}>{i === 0 ? s.id : ''}</td>
            <td className={`${td} text-left`}>{r.name}</td>
            <td className={`${td} text-right`}>{r.run.s.toFixed(2)}</td>
            <td className={`${td} text-right`}>{range(r.run.min, r.run.max)}</td>
            <td className={`${td} text-right`}>{r.run.fps.toFixed(1)}</td>
            <td className={`${td} text-right`}>{r.run.rssMb}</td>
            <td className={`${td} text-right`}>{ratio(r.ratio)}</td>
          </tr>
        ));
      })}
    </>
  );
}

/** Render time per scene: the bar chart, the cause of the papercut gap, and the per-scene table. */
export function SpeedBars() {
  return (
    <>
      <Figure
        chart={barsChart()}
        caption={`Shorter is faster. Each bar is the median of ${BENCH.n} timed renders. Bars are cut at 60 s, with the time written beside them.`}
        table={
          <Table head={['scene', 'engine', 'median s', 'min–max', 'fps', 'peak RSS MB', 'Kinetograph faster by']}>
            <SceneRows />
          </Table>
        }
      />
      <p className="text-sm text-fd-muted-foreground">
        <b className="font-medium text-fd-foreground">papercut.</b> {PAPERCUT.note} {PAPERCUT.cause}
      </p>
    </>
  );
}

/** Speed-up per scene: the dot chart and its table. */
export function SpeedSpread() {
  return (
    <Figure
      chart={spreadChart()}
      caption={`One dot per scene, median of ${BENCH.n} renders over median of ${BENCH.n}. Run-to-run ranges are in the table under the bar chart.`}
      table={
        <Table head={['scene', 'vs HyperFrames', 'vs Remotion']}>
          {SCENES.map((s) => (
            <tr key={s.id} className="border-t border-[var(--kg-box-border)]">
              <td className={`${td} text-left font-medium`}>{s.id}</td>
              <td className={`${td} text-right`}>{ratio(s.vsHyperframes) || '–'}</td>
              <td className={`${td} text-right`}>{ratio(s.vsRemotion) || '–'}</td>
            </tr>
          ))}
        </Table>
      }
    />
  );
}

/** The summary line, written from the data. */
export function SpeedSummary() {
  const span = (key: 'vsHyperframes' | 'vsRemotion') => {
    const xs = SCENES.flatMap((s) => (s[key] ? [s[key].x] : []));
    return { n: xs.length, lo: Math.min(...xs), hi: Math.max(...xs) };
  };
  const hf = span('vsHyperframes');
  const rm = span('vsRemotion');
  return (
    <p className="text-base leading-relaxed">
      On one Apple M4, Kinetograph rendered {hf.n} scenes {hf.lo}&times; to {hf.hi}&times; faster than HyperFrames, and {rm.n} scenes {rm.lo}&times; to {rm.hi}&times; faster than Remotion.
      Each scene is the median of {BENCH.n} timed renders. The factor depends on the scene, so there is no single number.
    </p>
  );
}

/** A worker number for the text, so the prose follows the data. */
export function Fact({ k }: { k: 'gain' | 'replay' | 'slow' }) {
  const four = WORKERS.points.find((p) => p.workers === 4)!;
  const text = { gain: `${speedUp(four.s).toFixed(2)}\u00d7`, replay: `${Math.round(WORKERS.replayShare * 100)}%`, slow: `${WORKERS.slowCoreFactor.toFixed(1)}\u00d7` }[k];
  return <>{text}</>;
}

/** The worker section, hidden when `SHOW_WORKER_SCALING` is false. */
export function WorkerSection({ children }: { children: ReactNode }) {
  return SHOW_WORKER_SCALING ? <>{children}</> : null;
}

export function WorkerScaling() {
  return (
    <Figure
      chart={workersChart()}
      caption={
        <>
          {WORKERS.scene} scene, {WORKERS.frames} frames at {WORKERS.size}, {WORKERS.machine}, {WORKERS.protocol}, {WORKERS.date}. Build {WORKERS.branch} {WORKERS.commit}:{' '}
          <b className="font-medium text-fd-foreground">{WORKERS.status}</b>.
        </>
      }
      table={
        <Table head={['workers', 'wall s', 'speed-up vs 1 worker']}>
          {WORKERS.points.map((p) => (
            <tr key={p.workers} className="border-t border-[var(--kg-box-border)]">
              <td className={`${td} text-left font-medium`}>{p.workers}</td>
              <td className={`${td} text-right`}>{p.s.toFixed(2)}</td>
              <td className={`${td} text-right`}>{speedUp(p.s).toFixed(2)}&times;</td>
            </tr>
          ))}
        </Table>
      }
    />
  );
}

export function WorkerLanes() {
  return <Figure chart={lanesChart()} caption="A sketch of one render. Lane lengths are drawn to scale; what the lanes hold is not." />;
}

export function FrameTime() {
  return (
    <Figure
      chart={frameChart()}
      caption={`One worker, ${WORKERS.scene} scene, same build. ${WORKERS.status}.`}
      table={
        <Table head={['part of a frame', 'ms']}>
          {WORKERS.frameMs.map((s) => (
            <tr key={s.label} className="border-t border-[var(--kg-box-border)]">
              <td className={`${td} text-left`}>{s.label}</td>
              <td className={`${td} text-right`}>{s.ms.toFixed(1)}</td>
            </tr>
          ))}
          <tr className="border-t border-[var(--kg-box-border)] font-medium">
            <td className={`${td} text-left`}>total</td>
            <td className={`${td} text-right`}>{WORKERS.frameMsTotal.toFixed(1)}</td>
          </tr>
        </Table>
      }
    />
  );
}

/** How it was measured, as a collapsed list. */
export function SpeedMethod() {
  const rows: [string, string][] = [
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
  return (
    <details className="group not-prose my-6 rounded-xl border border-[var(--kg-box-border)] bg-[var(--kg-box-bg)] px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-fd-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />
        Machine, versions and protocol
      </summary>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-fd-muted-foreground">{k}</dt>
            <dd className="font-jb text-xs leading-relaxed text-fd-foreground sm:text-[0.8125rem]">{v}</dd>
          </Fragment>
        ))}
      </dl>
    </details>
  );
}
