import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { StyleframeCard, type DraftNote } from './styleframes-card';
import type { Box, PanelProps, StyleframesAnswer } from './types';

/** The styleframes panel (docs/proposals/studio-panels.md): compare the stills, pick one or mix, pin notes, approve. */
export function StyleframesPanel({ panel, onSubmit, onDismiss }: PanelProps<'styleframes'>) {
  const frames = panel.data.frames;
  const saved = panel.answer;

  const nextKey = useMemo(() => ({ n: 0 }), []);
  const [pick, setPick] = useState<string | null>(saved?.pick ?? null);
  const [mix, setMix] = useState(saved?.mix ?? '');
  const [notes, setNotes] = useState<DraftNote[]>(() => (saved?.notes ?? []).map((n) => ({ key: nextKey.n++, ...n })));
  const [focusKey, setFocusKey] = useState<number | null>(null);

  const canApprove = pick !== null || mix.trim() !== '';

  const choose = (id: string) => {
    setPick(id);
    setMix('');
  };

  const changeMix = (value: string) => {
    setMix(value);
    if (value.trim() !== '') setPick(null);
  };

  const addNote = (frame: string, box?: Box) => {
    const key = nextKey.n++;
    setNotes((all) => [...all, { key, frame, text: '', ...(box ? { box } : {}) }]);
    setFocusKey(key);
  };

  const submit = (approved: boolean) => {
    const answer: StyleframesAnswer = {
      pick: mix.trim() !== '' ? null : pick,
      ...(mix.trim() !== '' ? { mix: mix.trim() } : {}),
      notes: notes
        .filter((n) => n.text.trim() !== '')
        .map((n) => ({ frame: n.frame, text: n.text.trim(), ...(n.box ? { box: n.box } : {}) })),
      approved,
    };
    onSubmit(answer);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div role="radiogroup" aria-label="Styleframes" className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-3">
          {frames.map((frame, index) => (
            <StyleframeCard
              key={frame.id}
              frame={frame}
              letter={String.fromCharCode(65 + index)}
              picked={pick === frame.id}
              notes={notes.filter((n) => n.frame === frame.id)}
              focusKey={focusKey}
              onPick={() => choose(frame.id)}
              onAddNote={(box) => addNote(frame.id, box)}
              onEditNote={(key, text) => setNotes((all) => all.map((n) => (n.key === key ? { ...n, text } : n)))}
              onRemoveNote={(key) => setNotes((all) => all.filter((n) => n.key !== key))}
            />
          ))}
        </div>
        <div className="mt-4 flex flex-col gap-1.5">
          <Label htmlFor={`mix-${panel.id}`}>Or mix them</Label>
          <Input id={`mix-${panel.id}`} value={mix} placeholder="A's type, B's colours" onChange={(event) => changeMix(event.target.value)} />
        </div>
      </div>
      <div className="border-border/60 flex shrink-0 items-center justify-between gap-2 border-t px-4 py-3">
        <Button variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
        <div className="flex items-center gap-2">
          {!canApprove ? <span className="text-muted-foreground text-xs">Pick a frame or describe a mix to approve.</span> : null}
          <Button variant="outline" onClick={() => submit(false)}>
            Another round
          </Button>
          <Button disabled={!canApprove} onClick={() => submit(true)}>
            Approve
          </Button>
        </div>
      </div>
    </div>
  );
}
