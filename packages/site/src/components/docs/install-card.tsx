import { DownloadIcon } from 'lucide-react';

import { CopyButton } from '@/components/docs/copy-button';

/**
 * A prominent install card: a title, a line of text, the command with a copy button, and a small link.
 *
 * ```mdx
 * <InstallCard title="Install Kinetograph" command="npx kinetograph skills update" href="/docs/check-your-setup/" link="Check your setup">
 *   One command installs the skills.
 * </InstallCard>
 * ```
 */
export function InstallCard({ title, command, href, link, children }: { title: string; command: string; href: string; link: string; children?: React.ReactNode }) {
  return (
    <div className="not-prose my-6 rounded-2xl border border-[var(--kg-box-border)] bg-fd-card p-5">
      <div className="flex items-start gap-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-fd-accent text-fd-primary">
          <DownloadIcon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold text-fd-foreground">{title}</p>
          <p className="mt-1 text-sm text-fd-muted-foreground">{children}</p>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-2 rounded-xl bg-fd-background px-4 py-2.5 font-mono text-[0.8125rem] text-fd-foreground">
        <span className="select-none text-fd-primary">$</span>
        <code className="min-w-0 flex-1 overflow-x-auto">{command}</code>
        <CopyButton text={command} label="Copy command" />
      </div>
      <p className="mt-3 text-xs">
        <a href={href} className="text-fd-muted-foreground underline underline-offset-4 hover:text-fd-foreground">
          {link}
        </a>
      </p>
    </div>
  );
}
