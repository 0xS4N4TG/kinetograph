import { ThemeSwitch } from 'fumadocs-ui/layouts/shared/slots/theme-switch';

import { GithubMark, GithubStars } from '@/components/github-stars';
import { repoCounts } from '@/lib/repo';
import { GITHUB } from '@/sections/links';
import { MobileMenu } from '@/sections/mobile-menu';
import { NavShell } from '@/sections/nav-shell';
import { labelText, Wordmark } from '@/sections/shared';

const LINKS = [
  { href: '/catalog/', label: 'Library' },
  { href: '/docs/', label: 'Docs' },
  { href: '#studio', label: 'Studio' },
];

const linkClass = `${labelText} transition-colors hover:text-cobalt`;

/** The floating nav, with the light, dark and system toggle; every page that uses it is under a theme provider. */
export async function Nav() {
  const counts = await repoCounts();
  const full = (
    <div className="flex h-14 items-center gap-8 pr-2 pl-7">
      <a href="#" aria-label="Kinetograph">
        <Wordmark className="text-[24px] text-ink" />
      </a>
      <nav className="flex items-center gap-7">
        {LINKS.map((l) => (
          <a key={l.href} href={l.href} className={linkClass}>
            {l.label}
          </a>
        ))}
        <GithubStars initial={counts} className={`${labelText} text-ink`} />
      </nav>
      <ThemeSwitch mode="light-dark-system" />
    </div>
  );
  const compact = (
    <div className="flex h-12 items-center gap-5 pr-1.5 pl-5">
      <a href="#" aria-label="Kinetograph">
        <Wordmark className="text-[20px] text-ink" />
      </a>
      <nav className="flex items-center gap-5 max-md:hidden">
        {LINKS.map((l) => (
          <a key={l.href} href={l.href} className={linkClass}>
            {l.label}
          </a>
        ))}
      </nav>
      <a
        href={GITHUB}
        target="_blank"
        rel="noreferrer"
        aria-label="GitHub"
        className="inline-flex size-9 items-center justify-center rounded-full text-ink transition-colors hover:text-cobalt"
      >
        <GithubMark className="size-[18px]" />
      </a>
      <div className="max-md:hidden">
        <ThemeSwitch mode="light-dark-system" />
      </div>
      <div className="md:hidden">
        <MobileMenu links={LINKS} counts={counts} />
      </div>
    </div>
  );
  return <NavShell full={full} compact={compact} />;
}
