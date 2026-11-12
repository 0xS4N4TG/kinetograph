import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The lockup: the pixel mark (a cobalt rounded square with the mechanism in white dots, drawn on a 24-dot grid so each dot is a
 * whole pixel) to the left of the wordmark, which is lowercase kinetograph in Geist Serif 600 with no tracking, the full stop
 * in red (its only use of red).
 */
export function Wordmark({ className, mark = true }: { className?: string; mark?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-[0.4em] font-wordmark font-semibold tracking-normal', className)}>
      {mark && <img src="/retro/mark-28.png" width={28} height={28} alt="" className="size-7 shrink-0 [image-rendering:pixelated]" />}
      <span>
        kinetograph<span className="text-flag">.</span>
      </span>
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
