import type { Metadata } from 'next';

import { LESSONS } from '@/lib/lessons';
import { CatalogPage } from '@/sections/catalog';
import { Label } from '@/sections/shared';

export const metadata: Metadata = {
  title: 'Lessons | Kinetograph',
  description: 'Short lessons that teach you to make videos with your coding agent: watch, recap, learn the words, take a quiz and make one.',
};

export default function LessonsPage() {
  return (
    <CatalogPage>
      <Label>Learn</Label>
      <h1 className="mt-3 text-[clamp(36px,4.2vw,56px)] leading-[1.05] font-bold tracking-[-0.04em] text-ink">Learn Kinetograph</h1>
      <p className="mt-5 max-w-[62ch] font-dm text-[17px] leading-[1.6] text-ink/75">
        Short lessons for making videos with your coding agent. Each has five steps: watch a short video, recap it, learn the words, take a quiz, then make something.
      </p>
      <h2 className="mt-12 text-2xl font-bold tracking-tight text-ink">Basics</h2>
      <ul className="mt-4 grid gap-4 sm:grid-cols-2">
        {LESSONS.map((l, i) => (
          <li key={l.slug}>
            <a href={`/lessons/${l.slug}/`} className="block h-full rounded-2xl border border-ink/15 p-5 transition-colors hover:border-ink/40">
              <span className="font-jb text-xs text-cobalt">Lesson {i + 1}</span>
              <span className="mt-2 block text-lg font-semibold text-ink">{l.title}</span>
              <span className="mt-1 block text-sm text-ink/75">{l.intro}</span>
              <span className="mt-3 block font-jb text-[11px] tracking-[0.2em] text-mute uppercase">{l.minutes} min</span>
            </a>
          </li>
        ))}
      </ul>
    </CatalogPage>
  );
}
