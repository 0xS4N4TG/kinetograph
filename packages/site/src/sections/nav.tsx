import { ThemeSwitch } from 'fumadocs-ui/layouts/shared/slots/theme-switch';

import { GithubMark, GithubStars } from '@/components/github-stars';
import { repoCounts } from '@/lib/repo';
import { cn } from '@/lib/utils';
import { GITHUB } from '@/sections/links';
import { MobileMenu } from '@/sections/mobile-menu';
import { Label, shell, Wordmark } from '@/sections/shared';

const LINKS = [
  { href: '/plugins/', label: 'Plugins' },
  { href: '/plugins/#components', label: 'Components' },
  { href: '/docs/', label: 'Docs' },
];

/** `themeSwitch` adds the light, dark and system toggle; only pages under a theme provider can have it. */
export async function Nav({ themeSwitch = false }: { themeSwitch?: boolean }) {
  const counts = await repoCounts();
  return (
    <header className="relative z-40">
      <div className={cn(shell, 'flex h-20 items-center justify-between')}>
        <a href="#" aria-label="Kinetograph">
          <Wordmark className="text-[22px] text-ink" />
        </a>
        <nav className="flex items-center gap-7 max-md:hidden">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} className="transition-colors hover:text-cobalt">
              <Label className="text-ink">{l.label}</Label>
            </a>
          ))}
          <GithubStars initial={counts} className="font-jb text-[11px] font-medium tracking-[0.24em] text-ink uppercase" />
          {themeSwitch && <ThemeSwitch mode="light-dark-system" />}
        </nav>
        <div className="flex items-center gap-3 md:hidden">
          <a
            href={GITHUB}
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub"
            className="inline-flex size-10 items-center justify-center text-ink transition-colors hover:text-cobalt"
          >
            <GithubMark className="size-5" />
          </a>
          <MobileMenu links={LINKS} counts={counts} extra={themeSwitch && <ThemeSwitch mode="light-dark-system" />} />
        </div>
      </div>
    </header>
  );
}
