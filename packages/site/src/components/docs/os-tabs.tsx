'use client';

import { Children, isValidElement, useState, type ReactNode } from 'react';
import { siApple, siLinux, siUbuntu } from 'simple-icons';

import { cn } from '@/lib/utils';

/** The brand logos come from simple-icons (CC0). It has no Windows logo, so that tab shows its name alone. */
const OS = {
  macos: { label: 'macOS', icon: siApple },
  ubuntu: { label: 'Debian or Ubuntu', icon: siUbuntu },
  linux: { label: 'Linux', icon: siLinux },
  windows: { label: 'Windows', icon: null },
} as const;

export type OsName = keyof typeof OS;

/** One system's commands inside `<OsTabs>`. Put a code block in it, so it gets a copy button. */
export function Os({ children }: { name: OsName; children?: ReactNode }) {
  return <>{children}</>;
}

/**
 * Commands per operating system as tabs, each labelled with the system's logo. Use a code block in each `Os`.
 *
 * ```mdx
 * <OsTabs>
 *   <Os name="macos">```sh brew install ffmpeg ```</Os>
 *   <Os name="ubuntu">```sh sudo apt-get install ffmpeg ```</Os>
 * </OsTabs>
 * ```
 *
 * `name` is `macos`, `ubuntu`, `linux` or `windows`.
 */
export function OsTabs({ children }: { children?: ReactNode }) {
  const panels = Children.toArray(children).filter(isValidElement) as { props: { name: OsName; children?: ReactNode } }[];
  const [active, setActive] = useState(0);
  return (
    <div className="not-prose my-6">
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-[var(--kg-box-border)]">
        {panels.map((p, i) => {
          const os = OS[p.props.name];
          return (
            <button
              key={p.props.name}
              type="button"
              role="tab"
              aria-selected={active === i}
              onClick={() => setActive(i)}
              className={cn(
                '-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors',
                active === i ? 'border-fd-primary text-fd-foreground' : 'border-transparent text-fd-muted-foreground hover:text-fd-foreground',
              )}
            >
              {os.icon ? (
                <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 fill-current">
                  <path d={os.icon.path} />
                </svg>
              ) : null}
              {os.label}
            </button>
          );
        })}
      </div>
      {panels.map((p, i) => (
        <div key={p.props.name} role="tabpanel" hidden={active !== i} className="prose-pre:my-3 [&>figure]:my-3">
          {p.props.children}
        </div>
      ))}
    </div>
  );
}
