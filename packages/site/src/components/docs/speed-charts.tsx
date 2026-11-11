import { ChevronRightIcon } from 'lucide-react';
import localFont from 'next/font/local';
import { Fragment, useId, type ReactNode } from 'react';

import { BENCH, PAPERCUT, SCENES, SHOW_WORKER_SCALING, WORKERS } from '@/data/speed';
import { barsChart, frameChart, lanesChart, spreadChart, workersChart, type Chart, type Paint } from '@/lib/speed-charts';
import type { Diagram } from '@/lib/sketch';
import { FRAME_HEAD, SCENE_HEAD, SPREAD_HEAD, WORKER_HEAD, fact, frameCells, methodRows, sceneCells, spreadCells, status, summary, workerCells } from '@/lib/speed-markdown';

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

function Table({ head, left = 1, children }: { head: string[]; left?: number; children: ReactNode }) {
  return (
    <table className="w-full border-collapse font-jb text-xs text-fd-foreground">
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={h} className={`${th} ${i >= left ? 'text-right' : ''}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/** A table of cell text; `lead` marks the first row of a group, which gets a rule above it. */
function Cells({ rows, left = 1 }: { rows: string[][]; left?: number }) {
  return (
    <>
      {rows.map((cells, r) => (
        <tr key={r} className={cells[0] ? 'border-t border-[var(--kg-box-border)]' : ''}>
          {cells.map((c, i) => (
            <td key={i} className={`${td} ${i >= left ? 'text-right' : 'text-left'} ${i === 0 ? 'font-medium' : ''}`}>
              {c}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** Render time per scene: the bar chart, the cause of the papercut gap, and the per-scene table. */
export function SpeedBars() {
  return (
    <>
      <Figure
        chart={barsChart()}
        caption={`Shorter is faster. Each bar is the median of ${BENCH.n} timed renders. Bars are cut at 60 s, with the time written beside them. The blue factors are how many times faster Kinetograph is: vs HF is against HyperFrames, vs Rem. against Remotion.`}
        table={
          <Table head={SCENE_HEAD} left={2}>
            <Cells rows={SCENES.flatMap(sceneCells)} left={2} />
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
        <Table head={SPREAD_HEAD}>
          <Cells rows={SCENES.map(spreadCells)} />
        </Table>
      }
    />
  );
}

/** The summary line, written from the data. */
export function SpeedSummary() {
  const { hf, rm } = summary();
  return (
    <p className="text-base leading-relaxed">
      On one Apple M4, Kinetograph rendered {hf.n} scenes {hf.lo}&times; to {hf.hi}&times; faster than HyperFrames, and {rm.n} scenes {rm.lo}&times; to {rm.hi}&times; faster than Remotion.
      Each scene is the median of {BENCH.n} timed renders. The factor depends on the scene, so there is no single number.
    </p>
  );
}

/** A worker number for the text, so the prose follows the data. */
export function Fact({ k }: { k: 'gain' | 'replay' | 'slow' }) {
  return <>{fact(k)}</>;
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
        <Table head={WORKER_HEAD}>
          <Cells rows={workerCells()} />
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
      caption={`One worker, ${WORKERS.scene} scene, same build. ${status()}.`}
      table={
        <Table head={FRAME_HEAD}>
          <Cells rows={frameCells()} />
        </Table>
      }
    />
  );
}

/** How it was measured, as a collapsed list. */
export function SpeedMethod() {
  return (
    <details className="group not-prose my-6 rounded-xl border border-[var(--kg-box-border)] bg-[var(--kg-box-bg)] px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-fd-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />
        Machine, versions and protocol
      </summary>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        {methodRows().map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-fd-muted-foreground">{k}</dt>
            <dd className="font-jb text-xs leading-relaxed text-fd-foreground sm:text-[0.8125rem]">{v}</dd>
          </Fragment>
        ))}
      </dl>
    </details>
  );
}
