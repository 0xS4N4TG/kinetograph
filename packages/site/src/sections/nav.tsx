import { GithubStars } from '@/components/github-stars';
import { repoCounts } from '@/lib/repo';
import { Label, shell, Wordmark } from '@/sections/shared';

export async function Nav() {
  const counts = await repoCounts();
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
          <GithubStars initial={counts} className="font-jb text-[11px] font-medium tracking-[0.24em] text-ink uppercase" />
        </nav>
      </div>
    </header>
  );
}
