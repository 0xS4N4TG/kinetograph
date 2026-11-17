import { ArrowUpRightIcon, DownloadIcon, GraduationCapIcon, PlayIcon, RouteIcon, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

const ICONS: Record<string, LucideIcon> = { play: PlayIcon, route: RouteIcon, download: DownloadIcon, learn: GraduationCapIcon };

/**
 * A card that links to a page: an icon in the accent colour, a title, a line of text and an arrow in the corner.
 *
 * ```mdx
 * <LinkCard title="Make your first video" icon="play" href="/docs/getting-started/first-video/">
 *   Paste one prompt, or run three commands.
 * </LinkCard>
 * ```
 *
 * `icon` is one of `play`, `route`, `download` or `learn`.
 */
export function LinkCard({ title, href, icon = 'play', children }: { title: string; href: string; icon?: string; children?: ReactNode }) {
  const Icon = ICONS[icon] ?? PlayIcon;
  return (
    <a
      href={href}
      className="not-prose group relative my-6 flex items-start gap-4 rounded-2xl border border-[var(--kg-box-border)] bg-fd-card p-5 no-underline transition-colors hover:border-fd-primary"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-fd-accent text-fd-primary">
        <Icon className="size-4 fill-current" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 pr-6">
        <span className="block text-base font-semibold text-fd-foreground">{title}</span>
        <span className="mt-1 block text-sm leading-relaxed text-fd-muted-foreground">{children}</span>
      </span>
      <ArrowUpRightIcon className="absolute top-4 right-4 size-4 text-fd-muted-foreground transition-colors group-hover:text-fd-primary" aria-hidden />
    </a>
  );
}
