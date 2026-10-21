import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface PanelHeaderProps {
  /** The left side: the panel's tab, or a tab list. */
  title: ReactNode;
  /** The right side. */
  children?: ReactNode;
  className?: string;
}

/** The bar across the top of a panel: `title` on the left, `children` on the right. */
export function PanelHeader({ title, children, className }: PanelHeaderProps) {
  return (
    <div
      className={cn('bg-secondary/60 flex h-7 shrink-0 items-center justify-between border-b px-2.5 text-[11px]', className)}
    >
      {title}
      {children}
    </div>
  );
}
