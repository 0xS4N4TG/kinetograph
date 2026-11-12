import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** Sizes carry their own leading: tailwind-merge drops a leading class when a later font-size class comes in. */
const SIZES = {
  section: 'text-[clamp(46px,6.4vw,96px)] leading-[0.92]',
  cell: 'text-[clamp(38px,4.4vw,64px)] leading-[0.94]',
  page: 'text-[clamp(48px,6vw,80px)] leading-[0.92]',
} as const;

/** Headings: the condensed display face at regular weight, sentence case, trimmed to the capitals. */
export function Heading({
  children,
  as: Tag = 'h2',
  size = 'section',
  className,
}: {
  children: ReactNode;
  as?: 'h1' | 'h2' | 'h3';
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return <Tag className={cn('font-display font-normal text-balance text-ink [text-box:trim-both_cap_alphabetic]', SIZES[size], className)}>{children}</Tag>;
}
