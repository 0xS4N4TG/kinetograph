'use client';

import { useState } from 'react';

import { PracticeCard } from '@/components/lessons/practice-card';
import { Quiz } from '@/components/lessons/quiz';
import { LESSONS, type Lesson } from '@/lib/lessons';
import { cn } from '@/lib/utils';
import { VIDEO_BASE } from '@/sections/links';

const STEPS = ['Watch', 'Recap', 'Words', 'Quiz', 'Make it'] as const;

/** The five steps of a lesson as tabs, with "Step X of 5" above the panel and a link to the next lesson below. */
export function LessonSteps({ lesson }: { lesson: Lesson }) {
  const [step, setStep] = useState(0);
  const next = LESSONS.find((l) => l.slug === lesson.next);
  return (
    <div>
      <div role="tablist" aria-label="Lesson steps" className="flex flex-wrap gap-2">
        {STEPS.map((name, i) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={step === i}
            onClick={() => setStep(i)}
            className={cn(
              'flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm transition-colors',
              step === i ? 'border-ink bg-ink text-ground' : 'border-ink/15 text-ink hover:border-ink/40',
            )}
          >
            <span className="font-jb text-xs">{i + 1}</span>
            {name}
          </button>
        ))}
      </div>
      <p className="mt-6 font-jb text-[11px] tracking-[0.24em] text-mute uppercase">
        Step {step + 1} of 5 · {STEPS[step]}
      </p>
      <div role="tabpanel" className="mt-4">
        {step === 0 && <Watch lesson={lesson} />}
        {step === 1 && <Recap lesson={lesson} />}
        {step === 2 && <Words lesson={lesson} />}
        {step === 3 && <Quiz questions={lesson.quiz} />}
        {step === 4 && <MakeIt lesson={lesson} />}
      </div>
      <div className="mt-8 flex items-center justify-between">
        <button type="button" disabled={step === 0} onClick={() => setStep(step - 1)} className="text-sm text-ink underline underline-offset-4 disabled:opacity-30">
          Back
        </button>
        {step < 4 ? (
          <button type="button" onClick={() => setStep(step + 1)} className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-ground">
            Continue
          </button>
        ) : next ? (
          <a href={`/lessons/${next.slug}/`} className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-ground">
            Next lesson · {next.minutes} min
          </a>
        ) : null}
      </div>
    </div>
  );
}

function Watch({ lesson }: { lesson: Lesson }) {
  return (
    <div>
      <h2 className="text-2xl font-bold tracking-tight text-ink">Watch</h2>
      {VIDEO_BASE ? (
        <video
          src={`${VIDEO_BASE}lesson-${lesson.slug}.mp4`}
          aria-label={lesson.title}
          controls
          playsInline
          preload="metadata"
          className="mt-4 block aspect-video w-full rounded-2xl border border-ink/15 bg-black"
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src="/docs-media/video-placeholder.svg"
          alt={`${lesson.title} (video not published yet)`}
          width={1280}
          height={720}
          className="mt-4 block aspect-video w-full rounded-2xl border border-ink/15"
        />
      )}
      <p className="mt-2 text-sm text-mute">
        {lesson.length} · Captions on by default
      </p>
      <h3 className="mt-8 text-lg font-semibold text-ink">What the video said</h3>
      <ol className="mt-3 grid gap-3">
        {lesson.takeaways.map((t, i) => (
          <li key={t} className="flex gap-3 text-[15px] leading-relaxed text-ink/80">
            <span className="font-jb text-xs text-cobalt">{i + 1}</span>
            {t}
          </li>
        ))}
      </ol>
      <h3 className="mt-8 text-lg font-semibold text-ink">Words to know</h3>
      <Glossary lesson={lesson} />
    </div>
  );
}

function Glossary({ lesson }: { lesson: Lesson }) {
  return (
    <dl className="mt-3 grid gap-3">
      {lesson.words.map((w) => (
        <div key={w.term}>
          <dt className="text-[15px] font-semibold text-ink">{w.term}</dt>
          <dd className="text-[15px] text-ink/75">{w.meaning}</dd>
        </div>
      ))}
    </dl>
  );
}

function Recap({ lesson }: { lesson: Lesson }) {
  return (
    <div>
      <h2 className="text-2xl font-bold tracking-tight text-ink">Recap</h2>
      <p className="mt-3 max-w-[62ch] text-[17px] leading-relaxed text-ink/80">{lesson.recap}</p>
      <ol className="mt-5 grid gap-3">
        {lesson.takeaways.map((t, i) => (
          <li key={t} className="flex gap-3 text-[15px] text-ink/80">
            <span className="font-jb text-xs text-cobalt">{i + 1}</span>
            {t}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Words({ lesson }: { lesson: Lesson }) {
  return (
    <div>
      <h2 className="text-2xl font-bold tracking-tight text-ink">Words</h2>
      <Glossary lesson={lesson} />
    </div>
  );
}

function MakeIt({ lesson }: { lesson: Lesson }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <h2 className="text-2xl font-bold tracking-tight text-ink">Make it</h2>
      <p className="mt-2 text-[15px] text-ink/75">Ask your agent. Here is the request.</p>
      <div className="mt-4 rounded-2xl border border-ink/15 p-5">
        <p className="font-jb text-[11px] tracking-[0.24em] text-mute uppercase">To your agent</p>
        <p className="mt-2 text-[15px] leading-relaxed text-ink">{lesson.prompt}</p>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(lesson.prompt).then(() => setCopied(true));
          }}
          className="mt-3 text-sm text-cobalt underline underline-offset-4"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <h3 className="mt-8 text-lg font-semibold text-ink">Practice it</h3>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        {lesson.practice.map((p) => (
          <PracticeCard key={p.title} {...p} />
        ))}
      </div>
    </div>
  );
}
