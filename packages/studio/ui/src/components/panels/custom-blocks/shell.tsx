import type { ReactNode } from 'react';

import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

import type { Block } from '../types';

/** A block's label, its help line and (for a required one) the mark, around the block's own control. */
export function BlockShell({ block, htmlFor, children, className }: { block: Block; htmlFor?: string; children: ReactNode; className?: string }) {
  return (
    <div data-testid={`block-${block.id}`} data-block={block.type} className={cn('flex min-w-0 flex-col gap-2', className)}>
      {block.label ? (
        <div className="flex items-baseline gap-1.5">
          <Label htmlFor={htmlFor}>{block.label}</Label>
          {block.required ? (
            <span className="text-muted-foreground text-[11px]" title="Required">
              required
            </span>
          ) : null}
        </div>
      ) : null}
      {children}
      {block.help ? <p className="text-muted-foreground text-xs">{block.help}</p> : null}
    </div>
  );
}
