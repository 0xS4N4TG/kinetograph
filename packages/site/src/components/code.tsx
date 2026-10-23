'use client';

import { CheckIcon, CopyIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Copy to clipboard with a short "copied" confirmation. */
function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return { copied, copy };
}

/** A single-line install command with a copy button (the pattern the Hermes Agent site opens with). */
export function CommandBar({ command, className, tone = 'paper' }: { command: string; className?: string; tone?: 'paper' | 'ink' }) {
  const { copied, copy } = useCopy(command);
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-md border py-1.5 pr-1.5 pl-4 font-mono text-[13px]',
        tone === 'ink' ? 'border-white/30 bg-white/10 text-paper backdrop-blur' : 'bg-card',
        className,
      )}
    >
      <span className={tone === 'ink' ? 'text-paper/60' : 'text-muted-foreground'}>$</span>
      <code className="min-w-0 flex-1 truncate text-left">{command}</code>
      <Button
        size="icon-sm"
        variant={tone === 'ink' ? 'ghost' : 'outline'}
        className={tone === 'ink' ? 'text-paper hover:bg-white/15' : undefined}
        aria-label="Copy command"
        onClick={copy}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

/** A code block with a filename tab and a copy button. */
export function CodeBlock({ code, title, className }: { code: string; title?: string; className?: string }) {
  const { copied, copy } = useCopy(code);
  return (
    <div className={cn('bg-night text-paper overflow-hidden rounded-lg border border-white/10', className)}>
      <div className="flex h-10 items-center justify-between border-b border-white/10 pr-2 pl-4">
        <span className="text-paper/60 font-mono text-xs">{title ?? ''}</span>
        <Button size="icon-xs" variant="ghost" className="text-paper hover:bg-white/10" aria-label="Copy code" onClick={copy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}
