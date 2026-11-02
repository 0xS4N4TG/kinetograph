import localFont from 'next/font/local';

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

/** "How Kinetograph makes a frame": a hand-sketched diagram of the render path. The numbers match the six stages of "How one frame is made" on this page. */
export function EngineDiagram() {
  return (
    <figure
      className={`${sketch.className} not-prose my-8 rounded-xl border border-fd-border bg-(--paper) text-(--ink) [--ink:#1d1b18] [--muted:#6a6459] [--paper:#fbf8f0] dark:[--ink:#ecebe8] dark:[--muted:#9d9a93] dark:[--paper:#17171a]`}
    >
      <div className="overflow-x-auto overscroll-x-contain">
        <svg
          viewBox={`0 0 ${diagram.width} ${diagram.height}`}
          role="img"
          aria-label={diagram.alt}
          className="block h-auto w-full min-w-[820px]"
        >
          <g fill="none" stroke="var(--ink)" strokeLinecap="round" strokeLinejoin="round">
            {diagram.ink.map((p, i) => (
              <path key={i} d={p.d} strokeWidth={p.w} strokeDasharray={p.dash} />
            ))}
          </g>
          <g aria-hidden="true" textAnchor="start">
            {diagram.labels.map((l, i) => (
              <text
                key={i}
                x={l.x}
                y={l.y}
                fontSize={l.size}
                fontWeight={l.weight}
                textAnchor={l.anchor}
                fill={l.tone === 'ink' ? 'var(--ink)' : 'var(--muted)'}
                transform={`rotate(${l.rot} ${l.x} ${l.y})`}
              >
                {l.text}
              </text>
            ))}
          </g>
        </svg>
      </div>
    </figure>
  );
}
