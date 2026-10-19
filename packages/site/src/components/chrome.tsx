import { ArrowUpRightIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export const GITHUB = 'https://github.com/';

/** The brand mark: a film-frame glyph and the serif wordmark. */
export function Brand({ className }: { className?: string }) {
  return (
    <a href="#" className={cn('text-cobalt flex items-center gap-2.5 font-serif text-[19px] whitespace-nowrap', className)}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <rect x="3" y="4" width="18" height="16" rx="1.5" />
        <path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
      </svg>
      Kinetograph
    </a>
  );
}

const links = [
  { label: 'Features', href: '#features' },
  { label: 'How it works', href: '#how' },
  { label: 'Benchmark', href: '#benchmark' },
  { label: 'Docs', href: '#/docs' },
];

export function SiteNav({ active }: { active?: 'docs' }) {
  return (
    <header className="bg-paper/95 sticky top-0 z-40 border-b border-transparent backdrop-blur-md [&:not(:first-child)]:border-border">
      <div className="mx-auto flex h-16 max-w-[1320px] items-center gap-8 px-[clamp(16px,4vw,44px)]">
        <Brand />
        <nav className="ml-2 hidden items-center gap-8 md:flex">
          {links.map((l) => (
            <a
              key={l.label}
              href={l.href}
              aria-current={active === 'docs' && l.label === 'Docs' ? 'true' : undefined}
              className="text-foreground/90 font-bold hover:text-cobalt aria-[current=true]:text-cobalt text-[12px] tracking-[0.2em] uppercase transition-colors"
            >
              {l.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" render={<a href={GITHUB} target="_blank" rel="noreferrer" />}>
            GitHub <ArrowUpRightIcon />
          </Button>
          <Button render={<a href="#/docs/quickstart" />}>Get started</Button>
        </div>
      </div>
    </header>
  );
}

const cols = [
  { title: 'Product', items: [['Features', '#features'], ['How it works', '#how'], ['Benchmark', '#benchmark']] },
  { title: 'Docs', items: [['Introduction', '#/docs'], ['Quickstart', '#/docs/quickstart'], ['Studio', '#/docs/studio']] },
  { title: 'Project', items: [['GitHub', GITHUB], ['License', '#/docs/license'], ['Roadmap', '#/docs/roadmap']] },
];

export function SiteFooter() {
  return (
    <footer className="bg-paper border-t">
      <div className="mx-auto grid max-w-[1320px] gap-10 px-[clamp(16px,4vw,44px)] py-14 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div>
          <Brand />
          <p className="text-muted-foreground mt-4 max-w-xs text-sm leading-relaxed">
            A programmatic video engine with no browser in it. Written in Rust and TypeScript.
          </p>
        </div>
        {cols.map((c) => (
          <div key={c.title}>
            <h4 className="text-cobalt text-[11px] font-semibold tracking-[0.2em] uppercase">{c.title}</h4>
            <ul className="mt-4 space-y-2.5 text-sm">
              {c.items.map(([label, href]) => (
                <li key={label}>
                  <a className="text-foreground/80 hover:text-cobalt transition-colors" href={href}>
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="text-muted-foreground mx-auto flex max-w-[1320px] flex-wrap justify-between gap-3 border-t px-[clamp(16px,4vw,44px)] py-5 text-xs">
        <span>© 2026 Kinetograph. PolyForm Small Business 1.0.0.</span>
        <a href="#" className="hover:text-cobalt">Top ↑</a>
      </div>
    </footer>
  );
}
