import { ArrowDownIcon, ArrowUpRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { labelText } from '@/sections/shared';

/**
 * A link as a pill with the arrow in its own circle at the right (button in button). It presses to 0.98 and the circle
 * nudges up and right on hover; both are transforms only.
 */
export function PillLink({
  href,
  children,
  tone = 'solid',
  icon = 'out',
  className,
}: {
  href: string;
  children: ReactNode;
  tone?: 'solid' | 'ghost' | 'paper';
  icon?: 'out' | 'down';
  className?: string;
}) {
  const Icon = icon === 'down' ? ArrowDownIcon : ArrowUpRightIcon;
  return (
    <a
      href={href}
      className={cn(
        labelText,
        'group inline-flex h-14 items-center gap-4 rounded-full pr-2 pl-7 text-[18px] whitespace-nowrap transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.98]',
        tone === 'solid' && 'bg-field text-on-field',
        tone === 'paper' && 'bg-on-field text-[#111113]',
        tone === 'ghost' && 'text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--foreground)_22%,transparent)]',
        className,
      )}
    >
      {children}
      <span
        className={cn(
          'grid size-10 place-items-center rounded-full transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-0.5 group-hover:-translate-y-px group-hover:scale-105',
          tone === 'solid' && 'bg-on-field/18',
          tone === 'paper' && 'bg-field text-on-field',
          tone === 'ghost' && 'bg-foreground/8',
        )}
      >
        <Icon className="size-5" strokeWidth={1.75} />
      </span>
    </a>
  );
}
