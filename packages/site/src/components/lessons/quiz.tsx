'use client';

import { useState } from 'react';

import type { QuizQuestion } from '@/lib/lessons';
import { cn } from '@/lib/utils';

/**
 * A multiple-choice quiz, one question at a time: pick an answer, press "Check answer", then go on. The answers
 * are checked in the browser and nothing is stored.
 */
export function Quiz({ questions }: { questions: QuizQuestion[] }) {
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [checked, setChecked] = useState(false);
  const [right, setRight] = useState(0);
  const done = index >= questions.length;
  if (done) {
    return (
      <div className="rounded-2xl border border-ink/15 p-6">
        <p className="text-lg font-semibold text-ink">
          {right} of {questions.length} right
        </p>
        <button
          type="button"
          onClick={() => {
            setIndex(0);
            setPicked(null);
            setChecked(false);
            setRight(0);
          }}
          className="mt-3 text-sm text-cobalt underline underline-offset-4"
        >
          Try again
        </button>
      </div>
    );
  }
  const q = questions[index];
  return (
    <div className="rounded-2xl border border-ink/15 p-6">
      <p className="font-jb text-[11px] tracking-[0.24em] text-mute uppercase">
        Question {index + 1} of {questions.length}
      </p>
      <p className="mt-3 text-lg font-semibold text-ink">{q.question}</p>
      <ul className="mt-4 grid gap-2">
        {q.options.map((o, i) => {
          const isRight = checked && i === q.answer;
          const isWrong = checked && picked === i && i !== q.answer;
          return (
            <li key={o}>
              <button
                type="button"
                disabled={checked}
                aria-pressed={picked === i}
                onClick={() => setPicked(i)}
                className={cn(
                  'w-full rounded-xl border px-4 py-3 text-left text-[15px] text-ink transition-colors',
                  picked === i ? 'border-cobalt' : 'border-ink/15 hover:border-ink/40',
                  isRight && 'border-green-600 bg-green-600/10',
                  isWrong && 'border-flag bg-flag/10',
                )}
              >
                {o}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-4 min-h-6 text-sm text-ink/75" aria-live="polite">
        {checked ? (picked === q.answer ? `Right. ${q.why}` : `Not quite. ${q.why}`) : 'Pick an answer, then check it.'}
      </p>
      <div className="mt-3">
        {!checked ? (
          <button
            type="button"
            disabled={picked === null}
            onClick={() => {
              setChecked(true);
              if (picked === q.answer) setRight((n) => n + 1);
            }}
            className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-ground disabled:opacity-40"
          >
            Check answer
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              setIndex(index + 1);
              setPicked(null);
              setChecked(false);
            }}
            className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-ground"
          >
            {index + 1 < questions.length ? 'Next question' : 'See result'}
          </button>
        )}
      </div>
    </div>
  );
}
