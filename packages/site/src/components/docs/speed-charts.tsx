import { ChevronRightIcon } from 'lucide-react';
import localFont from 'next/font/local';
import { Fragment, useId, type CSSProperties, type ReactNode } from 'react';

import { BENCH, PAPERCUT, SHOW_WORKER_SCALING, WORKERS, type Ratio, type Scene } from '@/data/speed';
import { frameChart, lanesChart, ruleDiagram, workersChart, type Chart, type Mark, type Paint } from '@/lib/speed-charts';
import { FRAME_HEAD, SCENE_HEAD, SCENE_LEFT, WORKER_HEAD, fact, frameCells, cap, groupedScenes, length, methodRows, papercutHead, sceneCells, status, summaryText, workerCells } from '@/lib/speed-markdown';

// Kalam (SIL OFL 1.1), as in the engine diagram: the hand-lettered words.
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

const MONO = 'var(--font-jb)';

/** The paper card of the engine diagram. Its figures are crisp; only the frame is sketched. */
const CARD =
  'overflow-hidden rounded-xl border border-fd-border bg-(--paper) text-(--ink) [--ink:#1d1b18] [--muted:#6a6459] [--paper:#fbf8f0] dark:[--ink:#ecebe8] dark:[--muted:#9d9a93] dark:[--paper:#17171a]';

/** A hand-sketched rule, stretched to the width of its box. */
function Rule() {
  const d = ruleDiagram();
  return (
    <svg viewBox={`0 0 ${d.width} ${d.height}`} preserveAspectRatio="none" aria-hidden="true" className="block h-2 w-full">
      <g fill="none" stroke="var(--ink)" strokeLinecap="round">
        {d.ink.map((p, i) => (
          <path key={i} d={p.d} strokeWidth={p.w} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
    </svg>
  );
}

/** Words in Kalam; a run of digits in the site's mono, so a 1 never looks like an l. */
function Words({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\d[\d.]*)/).map((part, i) => (/^\d/.test(part) ? <tspan key={i} fontFamily={MONO}>{part}</tspan> : part))}
    </>
  );
}

function Marks({ marks, hatch }: { marks: Mark[]; hatch: string }) {
  return (
    <>
      {marks.map((m, i) => {
        if (m.t === 'rect') {
          return (
            <rect
              key={i}
              x={m.x}
              y={m.y}
              width={m.w}
              height={m.h}
              fill={m.fill === 'hatch' ? `url(#${hatch})` : m.fill ? PAINT[m.fill] : 'none'}
              fillOpacity={m.opacity}
              stroke={m.stroke ? PAINT[m.stroke] : undefined}
              strokeWidth={m.sw}
              strokeDasharray={m.dash}
            />
          );
        }
        if (m.t === 'dot') return <circle key={i} cx={m.x} cy={m.y} r={m.r} fill={PAINT[m.fill]} stroke={m.stroke ? PAINT[m.stroke] : undefined} strokeWidth={m.sw} />;
        if (m.t === 'line') {
          return (
            <polyline key={i} points={m.pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={PAINT[m.stroke]} strokeWidth={m.sw} strokeDasharray={m.dash} strokeOpacity={m.opacity} strokeLinejoin="round" strokeLinecap="round" />
          );
        }
        return (
          <text
            key={i}
            x={m.x}
            y={m.y}
            fontSize={m.size}
            fontWeight={m.bold ? 700 : 400}
            textAnchor={m.anchor ?? 'start'}
            fill={PAINT[m.paint]}
            fontFamily={m.mono ? MONO : undefined}
            style={m.mono ? { fontVariantNumeric: 'tabular-nums' } : undefined}
          >
            {m.mono ? m.text : <Words text={m.text} />}
          </text>
        );
      })}
    </>
  );
}

/** A collapsed block under a card, opened by a plain-worded toggle. */
function Fold({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="group mt-2">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs font-medium text-fd-muted-foreground hover:text-fd-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
        {label}
      </summary>
      <div className="mt-2 overflow-x-auto rounded-lg border border-[var(--kg-box-border)]">{children}</div>
    </details>
  );
}

/** The toggle's words, on every table of the page. */
const NUMBERS = 'Boring detailed numbers';

/** A caption, an optional note and a collapsed table under a card. */
function Frame({ caption, note, table, children }: { caption?: ReactNode; note?: ReactNode; table?: ReactNode; children: ReactNode }) {
  return (
    <div className="not-prose my-6">
      {children}
      {caption ? <p className="mt-2 text-xs leading-relaxed text-fd-muted-foreground">{caption}</p> : null}
      {note}
      {table ? <Fold label={NUMBERS}>{table}</Fold> : null}
    </div>
  );
}

/** One SVG drawing in a card, with an optional legend line under it. */
function Figure({ chart, legend, caption, table }: { chart: Chart; legend?: ReactNode; caption?: ReactNode; table?: ReactNode }) {
  const id = useId();
  const hatch = `${id}h`;
  return (
    <Frame caption={caption} table={table}>
      <figure className={`${sketch.className} ${CARD}`}>
        <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-labelledby={`${id}t ${id}d`} className="mx-auto block h-auto w-full max-w-[560px]">
          <title id={`${id}t`}>{chart.title}</title>
          <desc id={`${id}d`}>{chart.desc}</desc>
          <defs>
            <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--muted)" strokeWidth="1.5" />
            </pattern>
          </defs>
          <g fill="none" stroke="var(--ink)" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {chart.frame.ink.map((p, i) => (
              <path key={i} d={p.d} strokeWidth={p.w} strokeDasharray={p.dash} />
            ))}
          </g>
          <g aria-hidden="true">
            <Marks marks={chart.marks} hatch={hatch} />
          </g>
        </svg>
        {legend ? <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 pb-4 pt-2 text-[0.9375rem] leading-tight sm:px-6">{legend}</div> : null}
      </figure>
    </Frame>
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

/** Rows of cells; a row whose first cell is set starts a group and gets a rule above it. */
function Cells({ rows, left = 1 }: { rows: ReactNode[][]; left?: number }) {
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

/** A square swatch for the legend: the same fill or outline as the bar it names. */
function Swatch({ kind }: { kind: 'kg' | 'hf' | 'rm' | 'replay' }) {
  const style: Record<typeof kind, CSSProperties> = {
    kg: { background: 'var(--cobalt)' },
    hf: { border: '1px solid var(--ink)' },
    rm: { border: '1px dashed color-mix(in oklab, var(--ink) 60%, transparent)' },
    replay: { border: '1px solid var(--muted)', backgroundImage: 'repeating-linear-gradient(45deg, var(--muted) 0 1.5px, transparent 1.5px 6px)' },
  };
  return <span aria-hidden="true" className="inline-block h-2.5 w-6 shrink-0" style={style[kind]} />;
}

const Mono = ({ children }: { children: ReactNode }) => <span className="font-jb text-[0.8125rem]">{children}</span>;

/* ------------------------------------------------------------------ render time per video */

/**
 * The grid of one row. Below `sm`: the title and the two factors share a line, the summary runs under them, then the
 * bars and the times. From `sm` up the picture sits in a column of its own and the text and bars start after it.
 */
const ROW = 'grid grid-cols-[minmax(0,1fr)_4.25rem_4.25rem] gap-x-3 sm:grid-cols-[6rem_minmax(0,1fr)_5rem_5.5rem_5.5rem]';

const BAR_STYLE: Record<'kg' | 'hf' | 'rm', CSSProperties> = {
  kg: { background: 'var(--cobalt)' },
  hf: { border: '1px solid var(--ink)' },
  rm: { border: '1px dashed color-mix(in oklab, var(--ink) 60%, transparent)' },
};

function Factor({ r }: { r?: Ratio }) {
  return r ? (
    <span className="font-jb text-sm font-bold tabular-nums text-(--cobalt)">{r.x.toFixed(1)}&times;</span>
  ) : (
    <span aria-hidden="true" className="font-jb text-sm text-(--muted) opacity-50">
      &ndash;
    </span>
  );
}

const THUMB_BOX = 'hidden h-[3.375rem] w-24 items-center justify-center overflow-hidden rounded-md border border-[color-mix(in_oklab,var(--ink)_16%,transparent)] bg-[color-mix(in_oklab,var(--ink)_5%,transparent)] sm:flex';

/** A still from the video, or an outline of its shape when there is no still. Not shown on a phone. */
function Thumb({ s }: { s: Scene }) {
  if (s.thumb) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={s.thumb} alt={`A still from ${s.title}`} width={192} height={108} loading="lazy" decoding="async" className={`${THUMB_BOX} object-contain`} />;
  }
  const [w, h] = s.size.split('x').map(Number);
  return (
    <span aria-hidden="true" className={THUMB_BOX}>
      <span className="block rounded-[2px] border border-dashed border-[color-mix(in_oklab,var(--ink)_45%,transparent)]" style={{ aspectRatio: `${w} / ${h}`, height: '70%' }} />
    </span>
  );
}

function BarRow({ s }: { s: Scene }) {
  const runs = [
    { kind: 'kg' as const, name: 'Kinetograph', run: s.kinetograph },
    ...(s.hyperframes ? [{ kind: 'hf' as const, name: 'HyperFrames', run: s.hyperframes }] : []),
    ...(s.remotion ? [{ kind: 'rm' as const, name: 'Remotion', run: s.remotion }] : []),
  ];
  // Each row is scaled to its own slowest engine.
  const slowest = Math.max(...runs.map((r) => r.run.s));
  // The size is said only where it is not the usual landscape frame.
  const shape = s.size === '1920x1080' ? '' : `, ${s.size}`;
  return (
    <div className={`${ROW} items-start py-3`}>
      <div className="col-start-1 row-span-3 row-start-1 hidden pt-0.5 sm:block">
        <Thumb s={s} />
      </div>
      <span className="col-start-1 row-start-1 text-[1.0625rem] font-bold leading-tight sm:col-start-2">{s.title}</span>
      <span className="col-span-3 col-start-1 row-start-2 mt-0.5 text-[0.8125rem] leading-snug text-(--muted) sm:col-span-4 sm:col-start-2">
        {s.summary}. <span className="font-jb text-xs">{length(s)}{shape}</span>
      </span>
      <div aria-hidden="true" className="col-start-1 row-start-3 mt-2.5 flex flex-col gap-1 sm:col-start-2">
        {runs.map((r) => (
          <div key={r.kind} className="box-border h-2.5" style={{ ...BAR_STYLE[r.kind], width: `${Math.max((r.run.s / slowest) * 100, 1.5)}%` }} />
        ))}
      </div>
      <div className="col-span-2 col-start-2 row-start-3 mt-2.5 flex flex-col gap-1 text-right font-jb text-xs tabular-nums sm:col-span-1 sm:col-start-3">
        {runs.map((r) => (
          <span key={r.kind} className={`flex h-2.5 items-center justify-end ${r.kind === 'kg' ? 'font-bold text-(--cobalt)' : ''}`}>
            <span className="sr-only">{r.name} </span>
            {r.run.s.toFixed(2)} s
          </span>
        ))}
      </div>
      <span className="col-start-2 row-start-1 text-right leading-none sm:col-start-4 sm:pt-0.5">
        <span className="sr-only">Kinetograph faster than HyperFrames by </span>
        <Factor r={s.vsHyperframes} />
      </span>
      <span className="col-start-3 row-start-1 text-right leading-none sm:col-start-5 sm:pt-0.5">
        <span className="sr-only">Kinetograph faster than Remotion by </span>
        <Factor r={s.vsRemotion} />
      </span>
    </div>
  );
}

/** The columns the page's table drops from the export's: the id (it rides on the title) and the size (the rows already say it). */
const DROPPED = [1, 2];

/** The rows of the details table: the title carries the internal id as a small reference. */
function sceneTableRows(): ReactNode[][] {
  return groupedScenes()
    .flatMap((g) => g.scenes)
    .flatMap(sceneCells)
    .map(([title, id, , ...rest]) => [
      title ? (
        <>
          {title} <span className="ml-1 font-normal text-fd-muted-foreground opacity-80">{id}</span>
        </>
      ) : (
        ''
      ),
      ...rest,
    ]);
}

/** Render time per video: the rows in their groups, the reason for the far-off one, and the table behind it. */
export function SpeedBars() {
  const groups = groupedScenes();
  return (
    <>
      <Frame
        caption={`Each video's bars are scaled to its slowest engine; times are written beside them. Median of ${BENCH.n} timed renders. The blue factors say how many times faster Kinetograph is.`}
        note={
          <>
            <p className="mt-3 text-sm leading-relaxed text-fd-muted-foreground">
              <b className="font-medium text-fd-foreground">{papercutHead()}</b> {PAPERCUT.note}
            </p>
            <Fold label="Boring technical detail">
              <p className="px-3 py-2.5 text-xs leading-relaxed text-fd-muted-foreground">{PAPERCUT.detail}</p>
            </Fold>
          </>
        }
        table={
          <Table head={SCENE_HEAD.filter((_, i) => !DROPPED.includes(i))} left={SCENE_LEFT - DROPPED.length}>
            <Cells rows={sceneTableRows()} left={SCENE_LEFT - DROPPED.length} />
          </Table>
        }
      >
        <figure className={`${sketch.className} ${CARD} px-4 pb-3 pt-4 sm:px-6`}>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[0.9375rem] leading-tight">
            <span className="inline-flex items-center gap-2">
              <Swatch kind="kg" /> Kinetograph
            </span>
            <span className="inline-flex items-center gap-2">
              <Swatch kind="hf" /> HyperFrames
            </span>
            <span className="inline-flex items-center gap-2">
              <Swatch kind="rm" /> Remotion
            </span>
          </div>
          <div className="mb-1 mt-3">
            <Rule />
          </div>
          <div role="group" aria-label="Render time per video">
            <div className={`${ROW} items-end pb-1 pt-1 text-[0.8125rem] leading-tight text-(--muted)`}>
              <span className="col-start-2 text-right sm:col-start-4">
                vs <span className="inline-block">HyperFrames</span>
              </span>
              <span className="col-start-3 text-right sm:col-start-5">vs Remotion</span>
            </div>
            {groups.map((g, i) => (
              <section key={g.kind} aria-label={g.title}>
                <div className={i ? 'pt-4' : 'pt-1'}>
                  {i ? <Rule /> : null}
                  <h3 className="mt-2 text-[1.1875rem] font-bold leading-tight">{g.title}</h3>
                  <p className="mt-0.5 text-[0.8125rem] leading-snug text-(--muted)">{g.blurb}</p>
                </div>
                <div className="divide-y divide-[color-mix(in_oklab,var(--ink)_10%,transparent)]">
                  {g.scenes.map((s) => (
                    <BarRow key={s.id} s={s} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </figure>
      </Frame>
    </>
  );
}

/** The summary line, written from the data. */
export function SpeedSummary() {
  return <p className="text-base leading-relaxed">{summaryText()}</p>;
}

/* ------------------------------------------------------------------ worker scaling */

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
          {cap(WORKERS.video)}, {WORKERS.frames} frames at {WORKERS.size}, {WORKERS.machine}, {WORKERS.protocol}, {WORKERS.date}. Build {WORKERS.branch} {WORKERS.commit}:{' '}
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
  return (
    <Figure
      chart={lanesChart()}
      legend={
        <>
          <span className="inline-flex items-center gap-2">
            <Swatch kind="replay" /> replaying frames other workers drew, <Mono>{fact('replay')}</Mono>
          </span>
          <span className="inline-flex items-center gap-2">
            <Swatch kind="kg" /> drawing its own frames, each <Mono>{fact('slow')}</Mono> slower
          </span>
        </>
      }
      caption="Lengths are to scale; how each lane is split is schematic."
    />
  );
}

export function FrameTime() {
  return (
    <Figure
      chart={frameChart()}
      caption={`One worker, ${WORKERS.video}, same build. ${status()}.`}
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
        The boring details: machine, versions, settings
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
