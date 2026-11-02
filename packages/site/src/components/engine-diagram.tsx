'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import localFont from 'next/font/local';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { buildDiagram } from '@/lib/engine-diagram';

// Kalam (SIL OFL 1.1), self-hosted from the @fontsource package.
const sketch = localFont({
  src: [
    { path: '../../node_modules/@fontsource/kalam/files/kalam-latin-300-normal.woff2', weight: '300' },
    { path: '../../node_modules/@fontsource/kalam/files/kalam-latin-400-normal.woff2', weight: '400' },
    { path: '../../node_modules/@fontsource/kalam/files/kalam-latin-700-normal.woff2', weight: '700' },
  ],
  display: 'swap',
});

const diagram = buildDiagram();
const COUNT = diagram.steps.length;

// An uneven corner radius gives the button a drawn outline; the hard shadow is the offset ink.
const BUTTON =
  'inline-flex h-10 items-center justify-center gap-1.5 border-2 border-(--ink) bg-(--paper) px-2.5 sm:px-3 text-[17px] leading-none text-(--ink) ' +
  '[border-radius:255px_14px_225px_14px/14px_225px_14px_255px] shadow-[3px_3px_0_0_var(--ink)] ' +
  'transition-[transform,box-shadow] duration-100 motion-reduce:transition-none ' +
  'hover:-translate-x-px hover:-translate-y-px hover:shadow-[4px_4px_0_0_var(--ink)] ' +
  'active:translate-x-0.5 active:translate-y-0.5 active:shadow-[1px_1px_0_0_var(--ink)] ' +
  'focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-(--ink) ' +
  'disabled:pointer-events-none disabled:opacity-35';

/**
 * "How Kinetograph makes a frame": a hand-sketched diagram of the render path with a stepper that highlights one stage
 * at a time. Step 0 is the overview; steps 1 to 6 are the six stages of "How one frame is made" on this page.
 */
export function EngineDiagram() {
  const [step, setStep] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const active = step > 0 ? diagram.steps[step - 1] : undefined;

  const go = useCallback((n: number) => setStep(Math.max(0, Math.min(COUNT, n))), []);

  // On a narrow screen the diagram scrolls inside its frame; bring the active box into view.
  useEffect(() => {
    const box = scroller.current;
    if (!box || !active) return;
    const target = box.querySelector<SVGGElement>(`[data-hatch="${active.node}"]`);
    if (!target) return;
    const frame = box.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const left = box.scrollLeft + rect.left - frame.left - (frame.width - rect.width) / 2;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    box.scrollTo({ left: Math.max(0, left), behavior: reduce ? 'auto' : 'smooth' });
  }, [active]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'ArrowRight') go(step + 1);
    else if (e.key === 'ArrowLeft') go(step - 1);
    else return;
    e.preventDefault();
  };

  return (
    <figure
      className={`${sketch.className} not-prose my-8 rounded-xl border border-fd-border bg-(--paper) text-(--ink) [--hatch:#d9a400] [--ink:#1d1b18] [--muted:#6a6459] [--paper:#fbf8f0] dark:[--hatch:#f0c43a] dark:[--ink:#ecebe8] dark:[--muted:#9d9a93] dark:[--paper:#17171a]`}
    >
      <div
        role="group"
        aria-label="How Kinetograph makes a frame: step through the six stages"
        onKeyDown={onKeyDown}
      >
        <div ref={scroller} className="overflow-x-auto overscroll-x-contain">
          <svg
            viewBox={`0 0 ${diagram.width} ${diagram.height}`}
            role="img"
            aria-label={diagram.alt}
            className="block h-auto w-full min-w-[820px]"
          >
            {diagram.steps.map(({ node }) => (
              <g
                key={node}
                data-hatch={node}
                className="transition-opacity duration-200 motion-reduce:transition-none"
                opacity={active?.node === node ? 1 : 0}
              >
                <path d={diagram.wash[node]} fill="#fff3b8" stroke="none" />
                <g fill="none" stroke="#e2a900" strokeLinecap="round" opacity={0.55}>
                  {diagram.hatch[node].map((p, i) => (
                    <path key={i} d={p.d} strokeWidth={p.w} />
                  ))}
                </g>
              </g>
            ))}
            <g fill="none" stroke="var(--ink)" strokeLinecap="round" strokeLinejoin="round">
              {diagram.ink.map((p, i) => (
                <path key={i} d={p.d} strokeWidth={p.w} strokeDasharray={p.dash} />
              ))}
            </g>
            {active && (
              <g fill="none" stroke="#1d1b18" strokeLinecap="round" strokeLinejoin="round">
                {diagram.outline[active.node].map((p, i) => (
                  <path key={i} d={p.d} strokeWidth={p.w} />
                ))}
              </g>
            )}
            <g aria-hidden="true" textAnchor="start">
              {diagram.labels.map((l, i) => (
                <text
                  key={i}
                  x={l.x}
                  y={l.y}
                  fontSize={l.size}
                  fontWeight={l.weight}
                  textAnchor={l.anchor}
                  fill={l.node && l.node === active?.node ? '#1d1b18' : l.tone === 'ink' ? 'var(--ink)' : 'var(--muted)'}
                  transform={`rotate(${l.rot} ${l.x} ${l.y})`}
                >
                  {l.text}
                </text>
              ))}
            </g>
          </svg>
        </div>

        <div className="mx-4 border-t-2 border-dotted border-(--muted)/60 pt-4 pb-4 sm:mx-6">
          <div className="flex items-center justify-between gap-3">
            <button type="button" className={BUTTON} onClick={() => go(step - 1)} disabled={step === 0} aria-label="Previous step">
              <ChevronLeft className="size-5" strokeWidth={2.5} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`${BUTTON} min-w-0 whitespace-nowrap px-3 sm:px-5`}
              onClick={() => go(step === COUNT ? 0 : step + 1)}
            >
              {step === 0 ? `Walk through ${COUNT} steps` : step === COUNT ? 'Start over' : `Step ${step} of ${COUNT}`}
              {step < COUNT && <ChevronRight className="size-5" strokeWidth={2.5} aria-hidden="true" />}
            </button>
            <button type="button" className={BUTTON} onClick={() => go(step + 1)} disabled={step === COUNT} aria-label="Next step">
              <ChevronRight className="size-5" strokeWidth={2.5} aria-hidden="true" />
            </button>
          </div>

          <div className="mt-3 flex justify-center">
            {diagram.steps.map((s, i) => (
              <button
                key={s.node}
                type="button"
                onClick={() => go(i + 1)}
                aria-label={`Step ${i + 1}: ${s.title}`}
                aria-current={step === i + 1 ? 'step' : undefined}
                className="group p-2 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-(--ink)"
              >
                <span
                  className={`block h-2.5 rounded-full border-2 border-(--ink) transition-[width,background-color] duration-200 motion-reduce:transition-none ${
                    step === i + 1 ? 'w-7 bg-(--hatch)' : 'w-2.5 bg-transparent group-hover:bg-(--hatch)/50'
                  }`}
                />
              </button>
            ))}
          </div>

          <p aria-live="polite" className="mx-auto mt-2 min-h-14 max-w-xl text-center text-[17px] leading-snug text-(--ink) sm:min-h-12">
            {active ? (
              <>
                <b className="font-bold">{step}. {active.title}.</b> {active.caption}
              </>
            ) : (
              <span className="text-(--muted)">Walk through the six stages to follow one frame from project to MP4.</span>
            )}
          </p>
        </div>
      </div>
    </figure>
  );
}
