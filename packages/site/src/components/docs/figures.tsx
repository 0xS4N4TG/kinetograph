import type { ReactNode } from 'react';

const BASE = '/docs-media/';

/**
 * A terminal-style figure: a command and, optionally, what it prints. Written as text, not a screenshot.
 *
 * ```mdx
 * <Terminal command="npx kinetograph render src/index.tsx">out/renders/Main.mp4</Terminal>
 * ```
 *
 * `command` can hold several lines separated by `\n`. The children are the output lines.
 */
export function Terminal({ command, children }: { command: string; children?: ReactNode }) {
  return (
    <figure className="not-prose my-6 overflow-hidden rounded-2xl border border-[var(--kg-box-border)] bg-fd-card">
      <div className="flex items-center gap-1.5 border-b border-[var(--kg-box-border)] px-4 py-2" aria-hidden="true">
        <span className="size-2.5 rounded-full bg-fd-muted-foreground/30" />
        <span className="size-2.5 rounded-full bg-fd-muted-foreground/30" />
        <span className="size-2.5 rounded-full bg-fd-muted-foreground/30" />
      </div>
      <pre className="overflow-x-auto px-4 py-4 font-mono text-[0.8125rem] leading-relaxed text-fd-foreground">
        {command.split('\\n').map((line, i) => (
          <div key={i}>
            <span className="select-none text-fd-primary">$ </span>
            {line}
          </div>
        ))}
        {children ? <div className="mt-2 whitespace-pre-wrap text-fd-muted-foreground">{children}</div> : null}
      </pre>
    </figure>
  );
}

function Window({ title, src, alt }: { title: string; src: string; alt: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--kg-box-border)] bg-fd-card">
      <div className="flex items-center gap-1.5 border-b border-[var(--kg-box-border)] px-3 py-1.5 text-xs text-fd-muted-foreground">
        <span className="size-2 rounded-full bg-fd-muted-foreground/30" aria-hidden="true" />
        <span className="size-2 rounded-full bg-fd-muted-foreground/30" aria-hidden="true" />
        <span className="ml-2 font-medium">{title}</span>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={BASE + src} alt={alt} width={1280} height={720} loading="lazy" className="block aspect-video w-full object-cover" />
    </div>
  );
}

/**
 * Two windows side by side showing the same frame: your tool on the left, the Kinetograph render on the right.
 *
 * ```mdx
 * <TwoUp left="Remotion Studio" right="Kinetograph render" src="making-videos/animation-example.webp" alt="..." />
 * ```
 */
export function TwoUp({ left, right, src, alt }: { left: string; right: string; src: string; alt: string }) {
  return (
    <figure className="not-prose my-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Window title={left} src={src} alt={`${alt} (${left})`} />
      <Window title={right} src={src} alt={`${alt} (${right})`} />
    </figure>
  );
}
