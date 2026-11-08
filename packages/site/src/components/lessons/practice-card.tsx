'use client';

import { useState } from 'react';

/** A practice card: a title, one line, and a prompt for your agent that you can copy. */
export function PracticeCard({ title, text, prompt }: { title: string; text: string; prompt: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col rounded-2xl border border-ink/15 p-5">
      <p className="text-base font-semibold text-ink">{title}</p>
      <p className="mt-1 text-sm text-ink/75">{text}</p>
      <p className="mt-3 flex-1 rounded-xl bg-ink/5 p-3 text-[13px] leading-relaxed text-ink/80">{prompt}</p>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(prompt).then(() => setCopied(true));
        }}
        className="mt-3 self-start text-sm text-cobalt underline underline-offset-4"
      >
        {copied ? 'Copied' : 'Ask your agent'}
      </button>
    </div>
  );
}
