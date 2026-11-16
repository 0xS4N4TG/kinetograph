'use client';

import { Children, isValidElement, useState, useSyncExternalStore, type ReactNode } from 'react';
import { siApple, siLinux, siUbuntu } from 'simple-icons';

import { isEngineIcon, pickTab, readEngine, subscribeEngine, writeEngine } from '@/lib/tab-memory';
import { cn } from '@/lib/utils';

/**
 * Logos for a tab. Apple, Ubuntu and Linux come from simple-icons (CC0). simple-icons has no Windows logo, so that tab shows
 * its name alone. The Remotion and HyperFrames marks are each project's own, kept as small SVG files in public/docs-media/brands
 * (the sources are noted inside each file) and used only to label a tab.
 */
const ICONS = {
  macos: { path: siApple.path },
  ubuntu: { path: siUbuntu.path },
  linux: { path: siLinux.path },
  remotion: { src: '/docs-media/brands/remotion.svg' },
  hyperframes: { src: '/docs-media/brands/hyperframes.svg' },
} as const;

export type TabIcon = keyof typeof ICONS;

/** One tab of an `<IconTabs>`: a `label`, an optional `icon`, and the content. Put a code block in it for a copy button. */
export function Tab({ children }: { label: string; icon?: TabIcon; children?: ReactNode }) {
  return <>{children}</>;
}

/**
 * Tabs for any group of alternatives: the system a command is for, Remotion or HyperFrames, two ways to install. The tab row sits
 * above the content, each tab with an optional logo and an underline for the open one.
 *
 * ```mdx
 * <IconTabs>
 *   <Tab label="macOS" icon="macos">a code block</Tab>
 *   <Tab label="Windows">a code block</Tab>
 * </IconTabs>
 * ```
 *
 * `icon` is `macos`, `ubuntu`, `linux`, `remotion` or `hyperframes`. A group with a `remotion` or `hyperframes` tab opens on the
 * type the reader picked last, on any page (lib/tab-memory.ts); other groups start on their first tab.
 */
export function IconTabs({ children }: { children?: ReactNode }) {
  const tabs = Children.toArray(children).filter(isValidElement) as { props: { label: string; icon?: TabIcon; children?: ReactNode } }[];
  const icons = tabs.map((t) => t.props.icon);
  const isEngine = icons.some(isEngineIcon);
  const [local, setLocal] = useState(0);
  const remembered = useSyncExternalStore(subscribeEngine, readEngine, () => null);
  const active = isEngine ? pickTab(icons, remembered) : local;
  const select = (i: number) => (isEngine && isEngineIcon(icons[i]) ? writeEngine(icons[i]!) : setLocal(i));
  return (
    <div className="not-prose my-6">
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-[var(--kg-box-border)]">
        {tabs.map((t, i) => {
          const icon = t.props.icon ? ICONS[t.props.icon] : null;
          return (
            <button
              key={t.props.label}
              type="button"
              role="tab"
              aria-selected={active === i}
              onClick={() => select(i)}
              className={cn(
                '-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors',
                active === i ? 'border-fd-primary text-fd-foreground' : 'border-transparent text-fd-muted-foreground hover:text-fd-foreground',
              )}
            >
              {icon && 'path' in icon ? (
                <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 fill-current">
                  <path d={icon.path} />
                </svg>
              ) : icon ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={icon.src} alt="" width={16} height={16} className="size-4" />
              ) : null}
              {t.props.label}
            </button>
          );
        })}
      </div>
      {tabs.map((t, i) => (
        <div key={t.props.label} role="tabpanel" hidden={active !== i} className="[&>figure]:my-3 [&>p]:my-3">
          {t.props.children}
        </div>
      ))}
    </div>
  );
}
