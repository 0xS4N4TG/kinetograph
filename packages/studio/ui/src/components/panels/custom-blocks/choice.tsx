import { CheckIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

import type { Block } from '../types';
import { FrameImage } from './picture';
import { BlockShell } from './shell';

type Choice = Extract<Block, { type: 'choice' }>;

/** Options as cards (a picture, a label, a line of text); one is picked, or several with `multiple`. */
export function ChoiceBlock({ block, value, onChange }: { block: Choice; value: unknown; onChange(value: unknown): void }) {
  const multiple = block.multiple === true;
  const picked = new Set(Array.isArray(value) ? (value as string[]) : typeof value === 'string' ? [value] : []);
  const withPictures = block.options.some((o) => o.still);
  const toggle = (id: string) => {
    if (!multiple) return onChange(id);
    const next = new Set(picked);
    if (!next.delete(id)) next.add(id);
    onChange(block.options.filter((o) => next.has(o.id)).map((o) => o.id));
  };
  return (
    <BlockShell block={block}>
      <div
        role={multiple ? 'group' : 'radiogroup'}
        aria-label={block.label ?? block.id}
        className={cn('grid gap-2', withPictures ? 'grid-cols-[repeat(auto-fill,minmax(min(100%,9rem),1fr))]' : 'grid-cols-1')}
      >
        {block.options.map((option) => {
          const on = picked.has(option.id);
          const name = option.label ?? option.text ?? option.id;
          return (
            <button
              key={option.id}
              type="button"
              role={multiple ? 'checkbox' : 'radio'}
              aria-checked={on}
              aria-label={name}
              data-option={option.id}
              onClick={() => toggle(option.id)}
              className={cn(
                'focus-visible:ring-ring flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-lg border p-2 text-left outline-none transition-colors focus-visible:ring-2',
                on ? 'border-primary bg-primary/4' : 'border-border/60 hover:bg-accent/50',
              )}
            >
              {option.still ? <FrameImage comp={option.still.comp} frame={option.still.frame} alt={`${name}: ${option.still.comp} at frame ${option.still.frame}`} /> : null}
              <span className="flex items-start gap-2">
                <span
                  aria-hidden
                  className={cn(
                    'mt-0.5 flex size-4 shrink-0 items-center justify-center border',
                    multiple ? 'rounded-sm' : 'rounded-full',
                    on ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                  )}
                >
                  {on ? <CheckIcon className="size-3" /> : null}
                </span>
                <span className="min-w-0 text-sm">
                  {option.label ? <span className="block font-medium break-words">{option.label}</span> : null}
                  {option.text ? <span className={cn('block break-words', option.label && 'text-muted-foreground text-xs')}>{option.text}</span> : null}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </BlockShell>
  );
}
