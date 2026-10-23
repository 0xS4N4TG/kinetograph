import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** Wordmark as in the launch film: DM Sans 700, tight tracking, the full stop in red. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-dm font-bold tracking-[-0.05em]', className)}>
      kinetograph<span className="text-flag">.</span>
    </span>
  );
}

/** Small uppercase label with the film's wide tracking. */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('font-jb text-[11px] font-medium tracking-[0.24em] text-mute uppercase', className)}>{children}</p>;
}

export const shell = 'mx-auto w-full max-w-[1200px] px-[clamp(20px,5vw,64px)]';
export const section = 'pb-[clamp(88px,13vw,200px)]';
export const body = 'font-dm text-[17px] leading-[1.6] font-normal tracking-[-0.01em] text-ink/75';
export const link = 'text-cobalt underline decoration-cobalt/30 underline-offset-4 transition-colors hover:decoration-cobalt';
/** Heading size for the hand-written section headings. */
export const h2Size = 'text-[clamp(38px,4.6vw,64px)]';
