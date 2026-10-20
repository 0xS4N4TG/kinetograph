import { ArrowUpRightIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { GITHUB } from '@/sections/links';

export function Mark({ className }: { className?: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className={className} aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="1" />
      <path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
    </svg>
  );
}

const LINKS = [
  ['Film', '#film'],
  ['Engine', '#engine'],
  ['Remotion', '#remotion'],
  ['Agents', '#agents'],
  ['FAQ', '#faq'],
] as const;

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-cobalt/10 bg-paper/95 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-8 px-[clamp(16px,3vw,44px)]">
        <a href="#" className="flex items-center gap-2.5 font-serif text-[21px] text-cobalt">
          <Mark />
          Kinetograph
        </a>
        <nav className="ml-4 hidden items-center gap-8 md:flex">
          {LINKS.map(([label, href]) => (
            <a key={label} href={href} className="text-[12px] font-semibold tracking-[0.2em] text-night/80 uppercase transition-colors hover:text-cobalt">
              {label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" className="hidden sm:inline-flex" render={<a href={GITHUB} target="_blank" rel="noreferrer" />}>
            GitHub <ArrowUpRightIcon />
          </Button>
          <Button render={<a href="#start" />}>Get started</Button>
        </div>
      </div>
    </header>
  );
}
