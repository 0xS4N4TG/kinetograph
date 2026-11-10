'use client';

import { CheckIcon, CopyIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

/** A small icon button that copies `text`, with a short check mark as confirmation. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="shrink-0 text-fd-muted-foreground"
      aria-label={copied ? 'Copied' : label}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}
