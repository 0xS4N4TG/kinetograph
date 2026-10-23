import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** Section headline. Leading 1.1 and a bottom reserve keep italic descenders (g, p, y) from clipping. */
export function H2({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h2 className={cn('pb-1 font-serif text-[clamp(36px,4.4vw,60px)] leading-[1.1] font-normal tracking-[-0.01em] text-balance', className)}>
      {children}
    </h2>
  );
}

export const shell = 'mx-auto max-w-[1320px] px-[clamp(16px,4vw,44px)]';
export const body = 'text-[15px] leading-relaxed';
