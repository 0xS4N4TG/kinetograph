import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/** A floating surface on the canvas: rounded, lifted by a soft shadow rather than split off by hard lines. */
export function Panel({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      className={cn('bg-card border-border/60 shadow-panel rounded-panel relative flex min-h-0 min-w-0 flex-col overflow-hidden border', className)}
      {...props}
    />
  );
}

/** The row at the top of a panel: a title on the left, controls on the right. */
export function PanelBar({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex h-12 shrink-0 items-center gap-2 px-4', className)} {...props} />;
}
