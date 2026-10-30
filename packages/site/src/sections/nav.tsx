import { GITHUB } from '@/sections/links';
import { Label, shell, Wordmark } from '@/sections/shared';

export function Nav() {
  return (
    <header className="relative z-40">
      <div className={`${shell} flex h-20 items-center justify-between`}>
        <a href="#" aria-label="Kinetograph">
          <Wordmark className="text-[22px] text-ink" />
        </a>
        <nav className="flex items-center gap-7">
          <a href="/plugins/" className="transition-colors hover:text-cobalt"><Label className="text-ink">Plugins</Label></a>
          <a href="/plugins/#templates" className="transition-colors hover:text-cobalt"><Label className="text-ink">Templates</Label></a>
          <a href="/docs/" className="transition-colors hover:text-cobalt"><Label className="text-ink">Docs</Label></a>
          <a href={GITHUB} target="_blank" rel="noreferrer" className="transition-colors hover:text-cobalt"><Label className="text-ink">GitHub</Label></a>
        </nav>
      </div>
    </header>
  );
}
