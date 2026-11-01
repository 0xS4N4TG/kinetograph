import { SquareDashedIcon, Trash2Icon, XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { clock } from '@/lib/format';

import type { DraftNote } from './review-model';

interface ReviewNoteProps {
  note: DraftNote;
  fps: number;
  focus: boolean;
  onSeek(frame: number): void;
  onText(text: string): void;
  onDropArea(): void;
  onDelete(): void;
}

/** One note: its time (click to go there), the text, and the area it is tied to when it has one. */
export function ReviewNote({ note, fps, focus, onSeek, onText, onDropArea, onDelete }: ReviewNoteProps) {
  return (
    <li data-testid="review-note" data-frame={note.frame} className={'border-border/60 flex flex-col gap-1.5 rounded-lg border p-2'}>
      <div className="flex items-center gap-1.5">
        <Button variant="secondary" size="xs" className="font-mono tabular-nums" aria-label={`Go to ${clock(note.frame, fps)}`} onClick={() => onSeek(note.frame)}>
          {clock(note.frame, fps)}
        </Button>
        <span className="text-muted-foreground font-mono text-[11px]">frame {note.frame}</span>
        {note.box && (
          <span
            data-testid="review-note-area"
            title={`${note.layer ? `${note.layer}: ` : ''}${note.box.x}, ${note.box.y}, ${note.box.w} x ${note.box.h}`}
            className="bg-accent text-accent-foreground flex min-w-0 items-center gap-1 rounded-full py-0.5 pr-0.5 pl-2 text-[11px]"
          >
            <SquareDashedIcon className="size-3 shrink-0" />
            <span className="truncate">{note.layer ?? 'Area'}</span>
            <button type="button" aria-label="Remove the area" onClick={onDropArea} className="hover:bg-background/60 rounded-full p-0.5">
              <XIcon className="size-3" />
            </button>
          </span>
        )}
        <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label="Delete the note" onClick={onDelete}>
          <Trash2Icon />
        </Button>
      </div>
      <Textarea
        aria-label={`Note at ${clock(note.frame, fps)}`}
        size="sm"
        autoFocus={focus}
        placeholder="What should change here?"
        value={note.text}
        onChange={(event) => onText(event.target.value)}
        className="text-sm"
      />
    </li>
  );
}
