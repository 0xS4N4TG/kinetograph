import { ChevronLeftIcon, ChevronRightIcon, GripVerticalIcon, MessageSquareIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useState, type PointerEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

import type { Shot, Transition } from './types';

export const TRANSITIONS: { value: Transition; label: string }[] = [
  { value: 'cut', label: 'cut' },
  { value: 'match-cut', label: 'match cut' },
  { value: 'whip', label: 'whip' },
  { value: 'dissolve', label: 'dissolve' },
  { value: 'wipe', label: 'wipe' },
  { value: 'other', label: 'other' },
];

/** A length in seconds typed as text: a value that is not a positive number waits, and the last good one comes back on blur. */
function SecondsInput({ value, label, onChange }: { value: number; label: string; onChange: (seconds: number) => void }) {
  const [text, setText] = useState(String(value));
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Input
        nativeInput
        size="sm"
        type="number"
        min={0.1}
        step={0.5}
        aria-label={label}
        className="w-16"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const seconds = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isFinite(seconds) && seconds > 0) onChange(seconds);
        }}
        onBlur={() => setText(String(value))}
      />
      s
    </span>
  );
}

/** The transition out of a shot, shown between its card and the next. */
export function TransitionChip({ index, shot, onChange }: { index: number; shot: Shot; onChange: (transition: Transition) => void }) {
  return (
    <div className="flex w-20 shrink-0 flex-col items-center justify-center self-center" data-testid="transition-chip">
      <div aria-hidden="true" className="h-px w-full bg-border" />
      <select
        aria-label={`Transition after shot ${index + 1}`}
        value={shot.transition}
        onChange={(e) => onChange(e.target.value as Transition)}
        className="my-1 max-w-full cursor-pointer rounded-full border border-input bg-secondary px-2 py-0.5 text-center text-xs font-medium text-secondary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {TRANSITIONS.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
      <div aria-hidden="true" className="h-px w-full bg-border" />
    </div>
  );
}

export interface ShotCardProps {
  shot: Shot;
  index: number;
  count: number;
  /** The address of a small picture of the shot's frame. */
  thumbnail: string;
  note: string;
  dragging: boolean;
  dropTarget: boolean;
  registerRef: (el: HTMLElement | null) => void;
  onChange: (patch: Partial<Shot>) => void;
  onNote: (text: string) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  onAddAfter: () => void;
  onDragStart: (e: PointerEvent<HTMLButtonElement>) => void;
  onDragMove: (e: PointerEvent<HTMLButtonElement>) => void;
  onDragEnd: (e: PointerEvent<HTMLButtonElement>) => void;
  onDragCancel: () => void;
}

export function ShotCard(props: ShotCardProps) {
  const { shot, index, count, note, dragging, dropTarget } = props;
  const n = index + 1;
  const [commenting, setCommenting] = useState(false);
  const showNote = commenting || note !== '';
  return (
    <article
      ref={props.registerRef}
      aria-label={`Shot ${n}`}
      data-shot={shot.id}
      className={cn(
        'flex w-64 shrink-0 flex-col gap-2 rounded-xl border bg-card p-2.5 text-card-foreground shadow-xs/5',
        dragging && 'opacity-50',
        dropTarget && 'ring-2 ring-ring',
      )}
    >
      <div className="relative aspect-video overflow-hidden rounded-lg bg-muted">
        <img
          src={props.thumbnail}
          alt={`Frame ${shot.frame} for shot ${n}`}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="size-full object-contain"
          onError={(e) => {
            e.currentTarget.style.visibility = 'hidden';
          }}
        />
        <span className="absolute top-1.5 left-1.5 rounded-md bg-background/80 px-1.5 text-xs font-semibold tabular-nums backdrop-blur-sm">{n}</span>
      </div>

      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Drag shot ${n}`}
          title="Drag to reorder"
          className="cursor-grab touch-none active:cursor-grabbing"
          onPointerDown={props.onDragStart}
          onPointerMove={props.onDragMove}
          onPointerUp={props.onDragEnd}
          onPointerCancel={props.onDragCancel}
        >
          <GripVerticalIcon />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label={`Move shot ${n} left`} disabled={index === 0} onClick={() => props.onMove(-1)}>
          <ChevronLeftIcon />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label={`Move shot ${n} right`} disabled={index === count - 1} onClick={() => props.onMove(1)}>
          <ChevronRightIcon />
        </Button>
        <span className="flex-1" />
        <SecondsInput value={shot.seconds} label={`Length of shot ${n} in seconds`} onChange={(seconds) => props.onChange({ seconds })} />
        <Button variant="ghost" size="icon-xs" aria-label={`Comment on shot ${n}`} aria-pressed={showNote} onClick={() => setCommenting((v) => !v)}>
          <MessageSquareIcon />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label={`Add a shot after shot ${n}`} onClick={props.onAddAfter}>
          <PlusIcon />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label={`Remove shot ${n}`} onClick={props.onRemove}>
          <Trash2Icon />
        </Button>
      </div>

      <label className="grid gap-0.5 text-xs text-muted-foreground">
        What
        <Input size="sm" aria-label={`What is on screen in shot ${n}`} value={shot.what} onChange={(e) => props.onChange({ what: e.target.value })} />
      </label>
      <label className="grid gap-0.5 text-xs text-muted-foreground">
        Moves
        <Input size="sm" aria-label={`What moves in shot ${n}`} value={shot.moves} onChange={(e) => props.onChange({ moves: e.target.value })} />
      </label>
      <label className="grid gap-0.5 text-xs text-muted-foreground">
        Line
        <Textarea
          size="sm"
          rows={2}
          aria-label={`Script line of shot ${n}`}
          placeholder="No line"
          value={shot.line ?? ''}
          onChange={(e) => props.onChange({ line: e.target.value })}
        />
      </label>
      {shot.transition === 'other' && index < count - 1 && (
        <Input
          size="sm"
          aria-label={`Transition note for shot ${n}`}
          placeholder="Describe the transition"
          value={shot.transitionNote ?? ''}
          onChange={(e) => props.onChange({ transitionNote: e.target.value })}
        />
      )}
      {showNote && (
        <Textarea size="sm" rows={2} aria-label={`Your comment on shot ${n}`} placeholder="Your comment for the agent" value={note} onChange={(e) => props.onNote(e.target.value)} />
      )}
    </article>
  );
}
