// The "Up next" tray docked above the prompt box: the messages waiting for the agent's turn to end (the server keeps the
// queue) and the panel answers waiting to be told. Collapsed it is one slim bar; opened, a card for each message.

import {
  ChevronUpIcon,
  ClipboardCheckIcon,
  CornerDownRightIcon,
  FileTextIcon,
  GripVerticalIcon,
  LayoutGridIcon,
  LayoutPanelTopIcon,
  PaletteIcon,
  PencilIcon,
  PuzzleIcon,
  ScrollTextIcon,
  XIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import type { ComponentType } from 'react';

import type { QueuedMessage } from '@/api';
import { MessageImages } from '@/components/agent/attachments';
import { cn } from '@/lib/utils';

/** How long "Send now" can be taken back, ms. */
export const UNDO_MS = 4000;

const PANEL_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  brief: FileTextIcon,
  script: ScrollTextIcon,
  storyboard: LayoutGridIcon,
  styleframes: PaletteIcon,
  review: ClipboardCheckIcon,
  custom: PuzzleIcon,
};

/** The first `lines` lines of a message, for a card. */
export const firstLines = (text: string, lines: number): string => text.split('\n').filter((l) => l.trim() !== '').slice(0, lines).join('\n');

/** What a card says about the selection that went with the message: the first chip and how many more. */
export const chipSummary = (chips: string[]): string => (chips.length === 0 ? '' : chips.length === 1 ? chips[0]! : `${chips[0]} +${chips.length - 1}`);

/** `ids` with `id` moved to where `target` is (or one step, for the keyboard). */
export function moved(ids: string[], id: string, to: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0 || to < 0 || to >= ids.length || to === from) return ids;
  const next = ids.filter((x) => x !== id);
  next.splice(to, 0, id);
  return next;
}

interface UpNextProps {
  items: QueuedMessage[];
  take(id: string): void;
  remove(id: string): void;
  requeue(order: string[]): void;
  sendNow(id: string): void;
}

export function UpNext({ items, take, remove, requeue, sendNow }: UpNextProps) {
  const [open, setOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  // "Send now" waits UNDO_MS before it stops the turn, so that it can be taken back.
  const [pending, setPending] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editable = items.filter((i) => !i.panel).map((i) => i.id);

  const cancelPending = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setPending(null);
  };
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  // The message was sent (or removed) by other means: nothing left to undo.
  useEffect(() => {
    if (pending !== null && !items.some((i) => i.id === pending)) cancelPending();
  }, [items, pending]);

  if (items.length === 0 && pending === null) return null;
  const first = items[0];
  const FirstIcon = first?.panel ? (PANEL_ICONS[first.panel] ?? LayoutPanelTopIcon) : null;

  const startSendNow = (id: string) => {
    if (timer.current) clearTimeout(timer.current);
    setPending(id);
    timer.current = setTimeout(() => {
      timer.current = null;
      setPending(null);
      sendNow(id);
    }, UNDO_MS);
  };
  const dropOn = (targetId: string) => {
    if (dragId && dragId !== targetId) requeue(moved(editable, dragId, editable.indexOf(targetId)));
    setDragId(null);
  };
  const keyMove = (event: KeyboardEvent, id: string) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const at = editable.indexOf(id);
    const next = moved(editable, id, at + (event.key === 'ArrowUp' ? -1 : 1));
    if (next !== editable) requeue(next);
  };

  return (
    <div className="border-input bg-muted/40 mx-3 -mb-px flex flex-col overflow-hidden rounded-t-2xl border border-b-0" data-testid="up-next">
      {pending !== null && (
        <div role="status" className="bg-foreground text-background flex items-center gap-2 px-3 py-1.5 text-xs" data-testid="send-now-toast">
          <span className="flex-1">Stopping the turn to send that next</span>
          <button type="button" onClick={cancelPending} className="font-medium underline underline-offset-2 outline-none focus-visible:ring-2">
            Undo
          </button>
        </div>
      )}
      {items.length > 0 && (
        <div className="flex items-center gap-1 pr-1.5">
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${items.length} up next`}
            onClick={() => setOpen(!open)}
            data-testid="queue-toggle"
            className="hover:bg-accent/50 focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-xs outline-none focus-visible:ring-2"
          >
            <span className="text-foreground shrink-0 font-medium">{items.length} up next</span>
            {!open && first && (
              <>
                {first.images && <MessageImages names={first.images.slice(0, 3)} small className="shrink-0 flex-nowrap" />}
                {FirstIcon && <FirstIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />}
                <span className="text-muted-foreground min-w-0 flex-1 truncate" data-testid="queue-first">
                  {firstLines(first.text, 1) || (first.images ? 'Images' : '')}
                </span>
              </>
            )}
            <ChevronUpIcon className={cn('text-muted-foreground ml-auto size-3.5 shrink-0 transition-transform motion-reduce:transition-none', !open && 'rotate-180')} aria-hidden="true" />
          </button>
          {open && editable.length > 0 && (
            <button
              type="button"
              onClick={() => editable.forEach(remove)}
              className="text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring rounded-md px-2 py-1 text-xs outline-none focus-visible:ring-2"
            >
              Clear
            </button>
          )}
        </div>
      )}
      {open && items.length > 0 && (
        <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto px-1.5 pb-1.5" data-testid="chat-queue" aria-label="Messages waiting for the agent">
          {items.map((item) => {
            const PanelIcon = item.panel ? (PANEL_ICONS[item.panel] ?? LayoutPanelTopIcon) : null;
            const label = firstLines(item.text, 1).slice(0, 40) || 'images';
            const chips = chipSummary(item.chips);
            return (
              <li
                key={item.id}
                data-testid={item.panel ? 'chat-queued-panel' : 'chat-queued'}
                draggable={!item.panel}
                onDragStart={(event: DragEvent) => {
                  setDragId(item.id);
                  event.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(event: DragEvent) => {
                  if (dragId && !item.panel) event.preventDefault();
                }}
                onDrop={(event: DragEvent) => {
                  event.preventDefault();
                  if (!item.panel) dropOn(item.id);
                }}
                onDragEnd={() => setDragId(null)}
                className={cn(
                  'bg-background/70 border-border/70 flex items-start gap-1 rounded-xl border px-1.5 py-1.5',
                  dragId === item.id && 'opacity-50',
                  pending === item.id && 'border-primary/60',
                )}
              >
                {PanelIcon ? (
                  <span className="text-muted-foreground mt-0.5 flex size-5 shrink-0 items-center justify-center" title={`Panel answer: ${item.panel}`} data-testid="panel-mark">
                    <PanelIcon className="size-3.5" aria-hidden="true" />
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={`Move queued message: ${label}. Arrow up or down to reorder`}
                    onKeyDown={(event) => keyMove(event, item.id)}
                    className="text-muted-foreground hover:text-foreground focus-visible:ring-ring mt-0.5 flex size-5 shrink-0 cursor-grab items-center justify-center rounded outline-none focus-visible:ring-2"
                  >
                    <GripVerticalIcon className="size-3.5" aria-hidden="true" />
                  </button>
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-1 text-[12.5px] leading-snug">
                  {item.images && <MessageImages names={item.images} small />}
                  {item.text !== '' && <p className="line-clamp-2 whitespace-pre-wrap">{firstLines(item.text, 2)}</p>}
                  {chips !== '' && (
                    <span className="bg-accent text-accent-foreground max-w-full self-start truncate rounded-full px-2 py-0.5 text-[11px]" title={item.chips.join(', ')} data-testid="queued-chips">
                      {chips}
                    </span>
                  )}
                  {item.panel && <span className="text-muted-foreground text-[11px]">Panel answer, told with the next message</span>}
                </div>
                {!item.panel && (
                  <div className="flex shrink-0 items-center">
                    <CardButton label={`Edit queued message: ${label}`} onClick={() => take(item.id)}>
                      <PencilIcon className="size-3" aria-hidden="true" />
                    </CardButton>
                    <CardButton label={`Send now: ${label}`} onClick={() => startSendNow(item.id)}>
                      <CornerDownRightIcon className="size-3" aria-hidden="true" />
                    </CardButton>
                    <CardButton label={`Remove queued message: ${label}`} onClick={() => remove(item.id)}>
                      <XIcon className="size-3" aria-hidden="true" />
                    </CardButton>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function CardButton({ label, onClick, children }: { label: string; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label.split(':')[0]}
      onClick={onClick}
      className="text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring rounded-full p-1.5 outline-none focus-visible:ring-2"
    >
      {children}
    </button>
  );
}
