import { ThemeSwitch } from 'fumadocs-ui/layouts/shared/slots/theme-switch';

import { GithubStars } from '@/components/github-stars';
import { repoCounts } from '@/lib/repo';
import { cn } from '@/lib/utils';
import { Label, shell, Wordmark } from '@/sections/shared';

/** `themeSwitch` adds the light, dark and system toggle; only pages under a theme provider can have it. */
export async function Nav({ themeSwitch = false }: { themeSwitch?: boolean }) {
  const counts = await repoCounts();
  return (
    <header className="relative z-40">
      <div className={cn(shell, 'flex items-center justify-between', themeSwitch ? 'min-h-20 flex-wrap gap-y-2 py-2' : 'h-20')}>
        <a href="#" aria-label="Kinetograph">
          <Wordmark className="text-[22px] text-ink" />
        </a>
        <nav className={cn('flex items-center', themeSwitch ? 'gap-4 sm:gap-7' : 'gap-7')}>
          <a href="/plugins/" className="transition-colors hover:text-cobalt"><Label className="text-ink">Plugins</Label></a>
          <a href="/plugins/#components" className="transition-colors hover:text-cobalt"><Label className="text-ink">Components</Label></a>
          <a href="/docs/" className="transition-colors hover:text-cobalt"><Label className="text-ink">Docs</Label></a>
          <GithubStars initial={counts} className={cn('font-jb text-[11px] font-medium tracking-[0.24em] text-ink uppercase', themeSwitch && 'max-sm:hidden')} />
          {themeSwitch && <ThemeSwitch mode="light-dark-system" />}
        </nav>
      </div>
    </header>
  );
}
