// The markup notes of the composition, docked above the prompt box like the Up next tray: in time order, each with
// jump-to, edit, resolve and delete, and one button that sends the ones still to send.

import { CheckIcon, ChevronUpIcon, CrosshairIcon, PencilIcon, PenLineIcon, XIcon } from 'lucide-react';
import { useState } from 'react';

import type { CompositionInfo } from '@/api';
import { Button } from '@/components/ui/button';
import { describeMark, inTimeOrder, numberOf, timecode, toSend, useMarkup, useMarkupStore, type Note } from '@/lib/markup';
import type { Player } from '@/lib/player';
import { cn } from '@/lib/utils';

export function NotesTray({ comp, player }: { comp: CompositionInfo | null; player: Player | null }) {
  const store = useMarkupStore();
  const markup = useMarkup();
  const [open, setOpen] = useState(false);
  if (!store || !comp) return null;
  const notes = inTimeOrder(markup.notes, comp.id).filter((n) => n.status !== 'draft');
  if (notes.length === 0) return null;
  const waiting = toSend(markup.notes, comp.id).length;
  const sentCount = notes.filter((n) => n.status === 'sent').length;

  const jump = (note: Note) => {
    player?.pause();
    player?.seek(note.frame);
  };
  const edit = (note: Note) => {
    jump(note);
    store.open(note.id);
  };

  return (
    <div className="border-input bg-muted/40 mx-3 -mb-px flex flex-col overflow-hidden rounded-t-2xl border border-b-0" data-testid="notes-tray">
      <div className="flex items-center gap-1 pr-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${notes.length} markup note${notes.length === 1 ? '' : 's'}`}
          onClick={() => setOpen(!open)}
          data-testid="notes-toggle"
          className="hover:bg-accent/50 focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-xs outline-none focus-visible:ring-2"
        >
          <PenLineIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
          <span className="text-foreground shrink-0 font-medium">
            {notes.length} note{notes.length === 1 ? '' : 's'}
          </span>
          {!open && <span className="text-muted-foreground min-w-0 flex-1 truncate">{notes[0]!.text || describeMark(notes[0]!)}</span>}
          <ChevronUpIcon className={cn('text-muted-foreground ml-auto size-3.5 shrink-0 transition-transform motion-reduce:transition-none', !open && 'rotate-180')} aria-hidden="true" />
        </button>
        {open && sentCount > 0 && (
          <button type="button" onClick={() => store.clearSent()} className="text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring rounded-md px-2 py-1 text-xs outline-none focus-visible:ring-2">
            Clear sent
          </button>
        )}
        <Button size="xs" className="rounded-full" disabled={waiting === 0 || markup.busy} onClick={() => store.requestSend()} data-testid="send-notes">
          {markup.busy ? 'Sending…' : `Send ${waiting} note${waiting === 1 ? '' : 's'}`}
        </Button>
      </div>
      {markup.problem && (
        <p role="alert" className="text-destructive-foreground px-3 pb-1.5 text-xs" data-testid="notes-problem">
          {markup.problem}
        </p>
      )}
      {open && (
        <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto px-1.5 pb-1.5" aria-label="Markup notes">
          {notes.map((note) => {
            const no = numberOf(note, markup.notes);
            const span = note.endFrame > note.frame;
            return (
              <li key={note.id} data-testid="note-card" data-state={note.resolved ? 'resolved' : note.status} className={cn('bg-background/70 border-border/70 flex items-start gap-1.5 rounded-xl border px-2 py-1.5', (note.resolved || note.status === 'sent') && 'opacity-60')}>
                <span
                  className="mt-0.5 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-white"
                  style={{ background: note.resolved ? '#9ca3af' : note.color }}
                  aria-hidden="true"
                >
                  {note.resolved ? '✓' : (no ?? '•')}
                </span>
                <div className="flex min-w-0 flex-1 flex-col text-[12.5px] leading-snug">
                  <span className="text-muted-foreground text-[11px]">
                    {span ? `frames ${note.frame}-${note.endFrame}` : `frame ${note.frame}`} · {timecode(note.frame, comp.fps)} · {describeMark(note)}
                    {note.status === 'sent' ? ' · sent' : ''}
                  </span>
                  {note.layers.length > 0 && <span className="text-muted-foreground truncate text-[11px]">over {note.layers.join(', ')}</span>}
                  <p className={cn('line-clamp-2 whitespace-pre-wrap', note.resolved && 'line-through')}>{note.text || <span className="text-muted-foreground">No comment</span>}</p>
                </div>
                <div className="flex shrink-0 items-center">
                  <NoteButton label={`Go to frame ${note.frame}`} onClick={() => jump(note)}>
                    <CrosshairIcon className="size-3" aria-hidden="true" />
                  </NoteButton>
                  <NoteButton label="Edit this note" onClick={() => edit(note)}>
                    <PencilIcon className="size-3" aria-hidden="true" />
                  </NoteButton>
                  <NoteButton label={note.resolved ? 'Mark as not resolved' : 'Mark as resolved'} pressed={note.resolved} onClick={() => store.toggleResolved(note.id)}>
                    <CheckIcon className="size-3" aria-hidden="true" />
                  </NoteButton>
                  <NoteButton label="Delete this note" onClick={() => store.remove(note.id)}>
                    <XIcon className="size-3" aria-hidden="true" />
                  </NoteButton>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function NoteButton({ label, onClick, pressed, children }: { label: string; onClick(): void; pressed?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      onClick={onClick}
      className={cn('text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring rounded-full p-1.5 outline-none focus-visible:ring-2', pressed && 'text-foreground bg-accent')}
    >
      {children}
    </button>
  );
}
