import { highlight } from 'fumadocs-core/highlight';
import type { ReactNode } from 'react';

import { TerminalCopy } from '@/components/docs/terminal-copy';

const BASE = '/docs-media/';

/** One command line, coloured by the same shell highlighter as the docs' ```bash blocks, as bare `.line` spans. */
function shell(line: string) {
  return highlight(line, { lang: 'bash', components: { pre: ({ children }) => <>{children}</>, code: ({ children }) => <>{children}</> } });
}

/**
 * A terminal-style figure: a command and, optionally, what it prints. Written as text, not a screenshot. The commands are
 * coloured like a ```bash block and a copy button copies them (without the `$` and the output).
 *
 * ```mdx
 * <Terminal command="npx kinetograph render src/index.tsx">out/renders/Main.mp4</Terminal>
 * ```
 *
 * `command` can hold several lines separated by `\n`. The children are the output lines. Use it for a command shown with its
 * output or as a page's lead visual; a plain command inside a tab or a list is a ```bash block.
 */
export async function Terminal({ command, children }: { command: string; children?: ReactNode }) {
  const lines = command.split('\\n');
  const highlighted = await Promise.all(lines.map(shell));
  return (
    <figure className="kg-terminal not-prose my-6 overflow-hidden rounded-2xl border border-[var(--kg-box-border)] bg-[var(--kg-box-bg)]">
      <div className="flex items-center justify-between border-b border-[var(--kg-box-border)] py-1.5 pr-2 pl-4">
        <div className="flex items-center gap-1.5" aria-hidden="true">
          <span className="size-2.5 rounded-full bg-fd-muted-foreground/30" />
          <span className="size-2.5 rounded-full bg-fd-muted-foreground/30" />
          <span className="size-2.5 rounded-full bg-fd-muted-foreground/30" />
        </div>
        <TerminalCopy text={lines.join('\n')} />
      </div>
      <pre tabIndex={0} className="overflow-x-auto px-4 py-4 font-mono text-[0.8125rem] leading-relaxed text-fd-foreground focus-visible:ring-2 focus-visible:ring-fd-ring focus-visible:outline-none focus-visible:ring-inset">
        <code>
          {highlighted.map((line, i) => (
            <div key={i}>
              <span className="select-none text-fd-primary">$ </span>
              {line}
            </div>
          ))}
          {children ? <div className="mt-2 whitespace-pre-wrap text-fd-muted-foreground">{children}</div> : null}
        </code>
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
