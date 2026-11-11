import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** The wordmark: lowercase kinetograph in Geist Serif 600 with no tracking, the full stop in red (its only use of red). */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-wordmark font-semibold tracking-normal', className)}>
      kinetograph<span className="text-flag">.</span>
    </span>
  );
}

/** Small condensed label, uppercase and tracked, for captions, step names and buttons. */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('font-display text-[16px] leading-none font-medium tracking-[0.08em] text-mute uppercase', className)}>{children}</p>;
}

/** The condensed face as a class, for nav links and buttons. */
export const labelText = 'font-display text-[16px] leading-none font-medium tracking-[0.08em] uppercase';

export const shell = 'mx-auto w-full max-w-[1320px] px-[clamp(20px,4.5vw,64px)]';
export const section = 'pt-[var(--kg-gap)]';
export const body = 'font-dm text-[17px] leading-[1.6] font-normal tracking-[-0.005em] text-ink/80';
export const link = 'text-cobalt underline decoration-cobalt/40 underline-offset-4 transition-colors hover:decoration-cobalt';
