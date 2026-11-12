import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The lockup: the pixel mark (a cobalt rounded square with the mechanism in white dots, drawn on its own grid per screen density (40, 80, 120, 160 dots, shown at 40px) so each dot is
 * one device pixel; scripts/mark.py draws it from the engine picture) to the left of the wordmark, which is lowercase kinetograph in DM Sans 700 at -0.05em, the full stop
 * in red (its only use of red).
 */
export function Wordmark({ className, mark = true }: { className?: string; mark?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-[0.4em] font-wordmark font-bold tracking-[-0.05em]', className)}>
      {mark && (
        <img
          src="/retro/mark-40.png"
          srcSet="/retro/mark-40.png 1x, /retro/mark-40@2x.png 2x, /retro/mark-40@3x.png 3x, /retro/mark-40@4x.png 4x"
          width={40}
          height={40}
          alt=""
          className="size-10 shrink-0 rounded-[22%] [image-rendering:pixelated]"
        />
      )}
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
