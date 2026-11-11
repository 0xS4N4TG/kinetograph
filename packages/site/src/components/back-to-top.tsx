'use client';

import { ArrowUpIcon } from 'lucide-react';

import { scrollToTop } from '@/lib/smooth-scroll';
import { labelText } from '@/sections/shared';

/** Back to the top, eased by Lenis; a pill with the arrow in its own circle, like the page's other buttons. */
export function BackToTop() {
  return (
    <button
      type="button"
      onClick={scrollToTop}
      className={`${labelText} group inline-flex h-12 items-center gap-3 rounded-full bg-on-field pr-1.5 pl-6 text-[17px] text-[#111113] transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] active:scale-[0.98]`}
    >
      Back to top
      <span className="grid size-9 place-items-center rounded-full bg-field text-on-field transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:-translate-y-0.5 group-hover:scale-105">
        <ArrowUpIcon className="size-[18px]" strokeWidth={1.75} />
      </span>
    </button>
  );
}
