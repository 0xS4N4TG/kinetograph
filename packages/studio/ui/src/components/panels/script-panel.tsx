import { ArrowDownIcon, ArrowUpIcon, MessageSquareIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

import { BeatStrip } from './script-beats';
import { TrackPlayer } from './script-track';
import { DEFAULT_RATE, formatSeconds, lineSeconds, overrun, totalSeconds, wordCount } from './script-math';
import type { PanelProps, ScriptLine } from './types';

/** The draft may carry the brief's length so the panel can show a difference; the shared type does not name it. */
type DraftWithTarget = { targetSeconds?: number };

/** The script panel (docs/proposals/studio-panels.md): edit the lines, read the time, comment, approve. */
export function ScriptPanel({ panel, onSubmit, onDismiss }: PanelProps<'script'>) {
  const draft = panel.data;
  const rate = typeof draft.rate === 'number' && draft.rate > 0 ? draft.rate : DEFAULT_RATE;
  const target = (draft as DraftWithTarget).targetSeconds;
  const track = draft.track;

  const [lines, setLines] = useState<ScriptLine[]>(() => draft.lines.map((line) => ({ ...line })));
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [keepTrack, setKeepTrack] = useState(true);
  const nextId = useRef(0);

  const freshId = (taken: ScriptLine[]) => {
    let id: string;
    do id = `line-new-${++nextId.current}`;
    while (taken.some((line) => line.id === id));
    return id;
  };

  const edit = (id: string, text: string) =>
    // The voiceover's own length no longer matches the words, so an edited line goes back to an estimate.
    setLines((all) => all.map((line) => (line.id === id ? { id, text } : line)));
  const insertBelow = (index: number) =>
    setLines((all) => {
      const next = [...all];
      next.splice(index + 1, 0, { id: freshId(all), text: '' });
      return next;
    });
  const remove = (id: string) => setLines((all) => all.filter((line) => line.id !== id));
  const move = (index: number, by: -1 | 1) =>
    setLines((all) => {
      const to = index + by;
      if (to < 0 || to >= all.length) return all;
      const next = [...all];
      [next[index], next[to]] = [next[to]!, next[index]!];
      return next;
    });

  const total = totalSeconds(lines, rate);
  const diff = overrun(total, target);
  const over = diff !== null && diff > 0;

  const answer = (approved: boolean) => {
    const ids = new Set(lines.map((line) => line.id));
    const kept = lines.flatMap((line) => {
      const text = notes[line.id]?.trim();
      return text && ids.has(line.id) ? [{ line: line.id, text }] : [];
    });
    onSubmit({
      lines,
      notes: kept,
      approved,
      ...(track && keepTrack ? { track: { src: track.src, beats: track.beats } } : {}),
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="script-panel">
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {track && (
          <section className="space-y-2 rounded-lg border p-3" aria-label="Track">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium" title={track.src}>
                  {track.src.split('/').pop()}
                </div>
                <div className="text-muted-foreground text-xs">{track.beats.length} beats</div>
              </div>
              <label className="flex shrink-0 items-center gap-2 text-sm">
                <input type="checkbox" checked={keepTrack} onChange={(e) => setKeepTrack(e.target.checked)} />
                Keep this track
              </label>
            </div>
            <TrackPlayer src={track.src} name={track.src.split('/').pop() ?? track.src} />
            <BeatStrip beats={track.beats} total={total} />
          </section>
        )}

        <ol className="space-y-2">
          {lines.map((line, index) => {
            const { seconds, estimated } = lineSeconds(line, rate);
            const noted = Boolean(notes[line.id]?.trim());
            return (
              <li key={line.id} className="space-y-2 rounded-lg border p-2" data-testid="script-line">
                <div className="flex items-start gap-2">
                  <span className="text-muted-foreground w-5 shrink-0 pt-1.5 text-right text-xs">{index + 1}</span>
                  <Textarea
                    aria-label={`Line ${index + 1}`}
                    value={line.text}
                    rows={2}
                    onChange={(e) => edit(line.id, e.target.value)}
                  />
                  <div className="w-16 shrink-0 pt-1 text-right text-sm tabular-nums" data-testid="line-seconds">
                    {formatSeconds(seconds)}
                    {estimated && <div className="text-muted-foreground text-xs">est.</div>}
                  </div>
                </div>
                <div className="flex items-center justify-end gap-0.5">
                  <Button
                    variant={noted ? 'secondary' : 'ghost'}
                    size="icon-xs"
                    aria-label={`Comment on line ${index + 1}`}
                    aria-pressed={Boolean(open[line.id])}
                    onClick={() => setOpen((o) => ({ ...o, [line.id]: !o[line.id] }))}
                  >
                    <MessageSquareIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Move line ${index + 1} up`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Move line ${index + 1} down`}
                    disabled={index === lines.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDownIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Insert a line below line ${index + 1}`}
                    onClick={() => insertBelow(index)}
                  >
                    <PlusIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove line ${index + 1}`}
                    onClick={() => remove(line.id)}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
                {open[line.id] && (
                  <Input
                    aria-label={`Note on line ${index + 1}`}
                    placeholder="What should change here?"
                    value={notes[line.id] ?? ''}
                    onChange={(e) => setNotes((n) => ({ ...n, [line.id]: e.target.value }))}
                  />
                )}
              </li>
            );
          })}
        </ol>

        {lines.length === 0 && <p className="text-muted-foreground text-sm">No lines left.</p>}
        <Button variant="outline" size="sm" onClick={() => insertBelow(lines.length - 1)}>
          <PlusIcon /> Add a line
        </Button>
      </div>

      <div className="space-y-3 border-t p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm" data-testid="script-total">
          <span>
            <span className="font-medium tabular-nums">{formatSeconds(total)}</span>
            <span className="text-muted-foreground">
              {' '}
              total, {lines.reduce((n, line) => n + wordCount(line.text), 0)} words
              {target !== undefined && diff !== null ? ` of ${formatSeconds(target)}` : ''}
            </span>
          </span>
          {diff !== null && (
            <Badge variant={over ? 'warning' : 'success'} className={cn(over && 'font-semibold')}>
              {over ? `${formatSeconds(diff)} over` : `${formatSeconds(-diff)} under`}
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
          <Button variant="outline" onClick={() => answer(false)}>
            Rewrite and show me again
          </Button>
          <Button onClick={() => answer(true)}>Approve</Button>
        </div>
      </div>
    </div>
  );
}
