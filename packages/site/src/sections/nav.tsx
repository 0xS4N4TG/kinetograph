import { GITHUB } from '@/sections/links';
import { Label, shell, Wordmark } from '@/sections/shared';

/** The film-strip mark; the docs layout imports it. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className={className} aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="1" />
      <path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
    </svg>
  );
}

export function Nav() {
  return (
    <header className="relative z-40">
      <div className={`${shell} flex h-20 items-center justify-between`}>
        <a href="#" aria-label="Kinetograph">
          <Wordmark className="text-[22px] text-ink" />
        </a>
        <nav className="flex items-center gap-7">
          <a href="/docs/" className="transition-colors hover:text-cobalt"><Label className="text-ink">Docs</Label></a>
          <a href={GITHUB} target="_blank" rel="noreferrer" className="transition-colors hover:text-cobalt"><Label className="text-ink">GitHub</Label></a>
        </nav>
      </div>
    </header>
  );
}
