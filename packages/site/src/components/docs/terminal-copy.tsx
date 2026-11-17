'use client';

import { buttonVariants } from 'fumadocs-ui/components/ui/button';
import { useCopyButton } from 'fumadocs-ui/utils/use-copy-button';
import { Check, Clipboard } from 'lucide-react';

import { cn } from '@/lib/utils';

/** The copy button of a `<Terminal>`: the same icon, size and "copied" check as a code block's, copying `text` (the commands only). */
export function TerminalCopy({ text, className }: { text: string; className?: string }) {
  const [checked, onClick] = useCopyButton(() => navigator.clipboard.writeText(text));
  return (
    <button
      type="button"
      data-checked={checked || undefined}
      aria-live="polite"
      onClick={onClick}
      className={cn(
        buttonVariants({ className: 'hover:text-fd-accent-foreground data-checked:text-fd-accent-foreground', size: 'icon-xs' }),
        className,
      )}
    >
      {checked ? <Check /> : <Clipboard />}
      <span className="sr-only">{checked ? 'Copied Text' : 'Copy Text'}</span>
    </button>
  );
}
