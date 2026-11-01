import { Streamdown } from 'streamdown';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { ArrowUpIcon, ChevronRightIcon, FrameIcon, ImagePlusIcon, SparklesIcon, SquareIcon, TriangleAlertIcon, XIcon } from 'lucide-react';

import type { AgentAttachment, AgentInfo, CompositionInfo, InspectResult, PluginSummary, ProjectInfo, ReceivedFrame, TimelineData } from '@/api';
import { AttachmentChips, MessageImages } from '@/components/agent/attachments';
import { UpNext } from '@/components/agent/up-next';
import { ToolGroup } from '@/components/agent/tool-rows';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { Popover, PopoverPopup } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { ACCEPT_IMAGES, MAX_ATTACHMENTS, acceptImages, attachmentUrl, dragHasFiles, filesOf, prepareAttachments, restoreAttachment, type Attachment } from '@/lib/attachments';
import type { ChatItem } from '@/lib/chat';
import { buildChatContext } from '@/lib/chat-context';
import { MAX_CHIPS, selectionChips, type Chip } from '@/lib/chips';
import { cropToPng } from '@/lib/crop';
import { findLayer, type InspectLayer } from '@/lib/inspect';
import { contactSheet } from '@/lib/contact-sheet';
import { chipText, contactFrames, layerRect, rangeLabel, unionRect, type FrameRange } from '@/lib/selection';
import type { ToolItem } from '@/lib/tool-summary';
import type { Chat } from '@/lib/use-chat';
import { cn } from '@/lib/utils';

interface AgentPanelProps {
  comp: CompositionInfo | null;
  project: ProjectInfo | null;
  inspect: InspectResult | null;
  selectedLayers: string[];
  selectLayers(ids: string[]): void;
  lastImage(): ReceivedFrame | null;
  /** The span of time picked on the timeline, or null: the agent is told about it and shown a contact sheet of it. */
  range?: FrameRange | null;
  onClearRange?(): void;
  /** The address of a frame as a JPEG at a scale of the composition's size; the tiles of the contact sheet. */
  thumbnailFrameUrl?: (frame: number, scale: number) => string | null;
  chat: Chat;
  timeline: TimelineData | null;
  /** The installed plugins, so the selection can name the plugin that drew a layer. */
  plugins?: PluginSummary[];
  /** A message to put in the box for the user to send (a new `id` puts it there again). */
  draft?: { text: string; id: number } | null;
}

/**
 * Agent text can be steered by what is in the project's files, so its markdown is held tight: links are https, http or
 * mailto only (and ask before they open); an image is drawn only from this page's own origin, a data: or a blob: address,
 * never from a remote one, whose query string could carry something out; raw HTML is not rendered.
 */
function safeUrl(url: string, key: string): string {
  if (/^(data:|blob:)/i.test(url)) return key === 'src' ? url : '';
  if (/^(https?:|mailto:)/i.test(url)) {
    if (key === 'src') {
      try {
        return new URL(url).origin === window.location.origin ? url : '';
      } catch {
        return '';
      }
    }
    return url;
  }
  // relative addresses stay on this origin
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? '' : url;
}

const MD_COMPONENTS = {
  /** A picture that is not allowed shows its alt text, as text. */
  img: ({ src, alt }: { src?: string | Blob; alt?: string }) =>
    typeof src === 'string' && src !== '' ? <img src={src} alt={alt ?? ''} className="max-w-full rounded-lg" /> : <span className="text-muted-foreground">{alt ? `[${alt}]` : '[image]'}</span>,
};

/** The words for a status of the connection to the agent. */
function statusText(chat: Chat['state']): string {
  switch (chat.status) {
    case 'starting':
      return 'Starting';
    case 'busy':
      return 'Working';
    case 'ready':
      return 'Ready';
    default:
      return 'Not started';
  }
}

/** The selection as chips: three at most, the rest behind "+N more" (and a kind with many layers as one chip) in a popover that lists every layer. */
function SelectionChips({ chips, rangeChip, onClearRange, remove, clearAll }: { chips: Chip[]; rangeChip: string | null; onClearRange?(): void; remove(ids: string[]): void; clearAll(): void }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const anchor = useRef<HTMLDivElement>(null);
  const shown = chips.slice(0, MAX_CHIPS);
  const hidden = chips.slice(MAX_CHIPS).reduce((n, c) => n + c.ids.length, 0);
  const total = chips.reduce((n, c) => n + c.ids.length, 0);
  const pill = 'bg-accent text-accent-foreground flex max-w-full items-center gap-1 rounded-full py-0.5 pr-1 pl-2.5 text-xs';
  const removeButton = (label: string, ids: string[]) => (
    <button type="button" aria-label={`Remove ${label}`} onClick={() => remove(ids)} className="hover:bg-foreground/10 shrink-0 rounded-full p-0.5">
      <XIcon className="size-3" aria-hidden="true" />
    </button>
  );
  return (
    <div ref={anchor} className="mb-1.5 flex max-h-[3.4rem] flex-wrap items-center gap-1.5 overflow-y-auto px-0.5" data-testid="selection-chips">
      {rangeChip && (
        <span className={pill}>
          <span className="truncate">{rangeChip}</span>
          <button type="button" aria-label={`Remove ${rangeChip}`} onClick={onClearRange} className="hover:bg-foreground/10 rounded-full p-0.5">
            <XIcon className="size-3" aria-hidden="true" />
          </button>
        </span>
      )}
      {chips.length === 0 && !rangeChip ? (
        <span className="text-muted-foreground text-xs">Nothing selected: the agent only knows the frame.</span>
      ) : (
        shown.map((chip) => (
          <span key={chip.key} className={pill} data-testid={chip.kind === 'group' ? 'chip-group' : 'chip-layer'}>
            {chip.kind === 'group' ? (
              <button type="button" onClick={() => setOpen(true)} title={chip.text} className="min-w-0 truncate">
                {chip.text}
              </button>
            ) : (
              <span className="truncate" title={chip.text}>
                {chip.text}
              </span>
            )}
            {removeButton(chip.text, chip.ids)}
          </span>
        ))
      )}
      {chips.length > MAX_CHIPS && (
        <button type="button" onClick={() => setOpen(true)} data-testid="chip-more" className="bg-muted text-muted-foreground hover:text-foreground rounded-full px-2.5 py-0.5 text-xs">
          +{hidden} more
        </button>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverPopup anchor={anchor} side="top" align="start" className="w-80 max-w-[90vw]">
          <div data-testid="chip-popover" className="flex w-full flex-col gap-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">{total} selected</span>
              <button
                type="button"
                onClick={() => {
                  clearAll();
                  setOpen(false);
                }}
                className="text-foreground hover:bg-accent rounded-md px-2 py-1"
              >
                Clear all
              </button>
            </div>
            <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
              {chips.map((chip) => {
                const isOpen = expanded.has(chip.key);
                return (
                  <li key={chip.key} className="flex flex-col">
                    <div className="hover:bg-accent/60 flex items-center gap-1 rounded-md px-1.5 py-1 text-xs">
                      {chip.kind === 'group' ? (
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          onClick={() => setExpanded((prev) => (prev.has(chip.key) ? new Set([...prev].filter((k) => k !== chip.key)) : new Set(prev).add(chip.key)))}
                          className="flex min-w-0 flex-1 items-center gap-1 text-left"
                        >
                          <ChevronRightIcon className={cn('size-3 shrink-0 transition-transform motion-reduce:transition-none', isOpen && 'rotate-90')} aria-hidden="true" />
                          <span className="truncate">{chip.text}</span>
                        </button>
                      ) : (
                        <span className="min-w-0 flex-1 truncate" title={chip.text}>
                          {chip.text}
                        </span>
                      )}
                      {removeButton(chip.text, chip.ids)}
                    </div>
                    {chip.kind === 'group' && isOpen && (
                      <ul className="border-border/60 ml-3 flex flex-col border-l pl-1.5">
                        {chip.entries.map((entry) => (
                          <li key={entry.id} className="hover:bg-accent/60 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs">
                            <span className="min-w-0 flex-1 truncate" title={entry.text}>
                              {entry.text}
                            </span>
                            {removeButton(entry.text, [entry.id])}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}

const SUGGESTIONS = ['Make the title bigger', 'Try a warmer colour palette', 'Slow down the intro'];

type PlainItem = Exclude<ChatItem, { kind: 'tool' }>;
type Segment = { kind: 'item'; item: PlainItem } | { kind: 'tools'; tools: ToolItem[]; last: boolean };

/** The chat as it is drawn: consecutive tool calls become one group. */
function segments(items: ChatItem[]): Segment[] {
  const out: Segment[] = [];
  items.forEach((item, index) => {
    if (item.kind !== 'tool') return void out.push({ kind: 'item', item });
    const tail = out.at(-1);
    if (tail?.kind === 'tools') tail.tools.push(item);
    else out.push({ kind: 'tools', tools: [item], last: false });
    if (index === items.length - 1) (out.at(-1) as Extract<Segment, { kind: 'tools' }>).last = true;
  });
  return out;
}

const Item = memo(function Item({ item, onAnswer }: { item: PlainItem; onAnswer(id: string, optionId: string | null): void }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex flex-col items-end gap-1.5" data-testid="chat-user">
          {item.chips.length > 0 && (
            <div className="flex max-w-full flex-wrap justify-end gap-1.5">
              {item.chips.map((chip, index) => (
                <span key={index} className="bg-accent text-accent-foreground max-w-full truncate rounded-full px-2.5 py-0.5 text-xs">
                  {chip}
                </span>
              ))}
            </div>
          )}
          {item.images && <MessageImages names={item.images} className="justify-end" />}
          {item.text !== '' && (
            <p className="bg-primary text-primary-foreground max-w-[90%] rounded-2xl rounded-br-md px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap">{item.text}</p>
          )}
        </div>
      );
    case 'agent':
      return (
        <div className="kg-md" data-testid="chat-agent">
          <Streamdown components={MD_COMPONENTS} urlTransform={safeUrl}>
            {item.text}
          </Streamdown>
        </div>
      );
    case 'permission': {
      const chosen = item.answered === null ? null : (item.options.find((o) => o.id === item.answered)?.name ?? 'Cancelled');
      return (
        <div
          className="bg-warning/10 border-warning/30 flex flex-col gap-2.5 rounded-xl border p-3.5"
          data-testid="chat-permission"
          role="group"
          aria-label="The agent asks"
        >
          <p className="text-[13.5px] font-medium">{item.title}</p>
          {item.files.length > 0 && <p className="text-muted-foreground truncate font-mono text-[11px]">{item.files.join(', ')}</p>}
          {chosen === null ? (
            <div className="flex flex-wrap gap-2">
              {item.options.map((option) => (
                <Button
                  key={option.id}
                  size="sm"
                  variant={option.kind.startsWith('allow') ? 'default' : 'outline'}
                  className="rounded-full px-3.5"
                  onClick={() => onAnswer(item.permissionId, option.id)}
                >
                  {option.name}
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">{chosen}</p>
          )}
        </div>
      );
    }
    case 'error':
      return (
        <div role="alert" className="bg-destructive/10 text-destructive-foreground flex items-start gap-2 rounded-xl p-3 text-[13px]" data-testid="chat-error">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{item.text}</span>
        </div>
      );
  }
});

/** The conversation with the user's own coding agent about what is selected in the preview. */
export const AgentPanel = memo(function AgentPanel({ comp, project, inspect, selectedLayers, selectLayers, lastImage, range = null, onClearRange, thumbnailFrameUrl, chat, timeline, plugins, draft }: AgentPanelProps) {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [text, setText] = useState('');
  const [withPicture, setWithPicture] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  // Pictures dropped or pasted, kept until the message goes. The ref is the latest list, so two drops in a row count right.
  const [attached, setAttached] = useState<Attachment[]>([]);
  const attachedRef = useRef<Attachment[]>([]);
  const nextAttachment = useRef(1);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const { state } = chat;
  const busy = state.status === 'busy';
  const frame = inspect?.frame ?? 0;

  useEffect(() => {
    let live = true;
    void chat.loadInfo().then((found) => live && setInfo(found));
    return () => {
      live = false;
    };
  }, [chat.loadInfo]);

  const setAttachments = useCallback((next: Attachment[]) => {
    attachedRef.current = next;
    setAttached(next);
  }, []);
  const addImages = useCallback(
    (files: File[]) => {
      const { files: taken, error } = acceptImages(files, attachedRef.current.length);
      setAttachError(error);
      if (taken.length === 0) return;
      const added = taken.map((file): Attachment => ({ id: nextAttachment.current++, file, preview: typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : '' }));
      setAttachments([...attachedRef.current, ...added]);
    },
    [setAttachments],
  );
  const removeImage = (id: number) => {
    const gone = attachedRef.current.find((a) => a.id === id);
    if (gone?.preview && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(gone.preview);
    setAttachError(null);
    setAttachments(attachedRef.current.filter((a) => a.id !== id));
  };
  useEffect(
    () => () => {
      if (typeof URL.revokeObjectURL === 'function') for (const a of attachedRef.current) if (a.preview) URL.revokeObjectURL(a.preview);
    },
    [],
  );

  // A queued message taken out to be edited comes back here: its words (before what is already typed) and its pictures.
  const takenN = state.taken?.n ?? 0;
  const seenTaken = useRef(takenN);
  useEffect(() => {
    const taken = state.taken?.item;
    // The panel can mount again (a tab switch) with a message taken long ago: only a new one counts.
    if (!taken || takenN === seenTaken.current) return;
    seenTaken.current = takenN;
    setText((now) => (now.trim() === '' ? taken.text : `${taken.text}\n${now}`));
    inputRef.current?.focus();
    const names = taken.images ?? [];
    if (names.length === 0) return;
    void Promise.all(names.map((name) => restoreAttachment(name))).then((restored) => {
      const room = Math.max(0, MAX_ATTACHMENTS - attachedRef.current.length);
      const added = restored.slice(0, room).map(({ file, stored }): Attachment => ({ id: nextAttachment.current++, file, stored, preview: attachmentUrl(stored) }));
      setAttachments([...attachedRef.current, ...added]);
    });
  }, [takenN]);

  useEffect(() => {
    if (!draft) return;
    setText(draft.text);
    inputRef.current?.focus();
  }, [draft?.id]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [state.items]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const layers = useMemo(() => {
    if (!inspect) return [];
    return selectedLayers.flatMap((id) => {
      const found = findLayer(inspect.layers, id);
      return found ? [found] : [];
    });
  }, [inspect, selectedLayers]);
  const cwd = project?.cwd ?? '';
  const paths = useMemo(() => ({ cwd: project?.cwd ?? info?.cwd ?? '', home: info?.home ?? '' }), [project?.cwd, info?.cwd, info?.home]);
  const rows = useMemo(() => segments(state.items), [state.items]);
  const span = comp && range ? rangeLabel(range, comp.fps) : undefined;
  const chips = layers.map((layer) => chipText(layer, frame, cwd, span));
  const chipList = useMemo(() => selectionChips(layers, chips, comp?.id ?? '', span ? ` · ${span}` : ` · frame ${frame}`), [layers, chips.join('\n'), comp?.id, span, frame]);
  /** With a span and no layer, the span has a chip of its own. */
  const rangeChip = span && layers.length === 0 ? `${comp!.id} · ${span}` : null;

  const send = async () => {
    const message = text.trim();
    if ((message === '' && attached.length === 0) || sending) return;
    setSending(true);
    setAttachError(null);
    try {
      // The originals are stored in the project first; the agent gets a smaller copy and the paths.
      let attachments: AgentAttachment[] = [];
      if (attachedRef.current.length > 0) {
        try {
          attachments = await prepareAttachments(attachedRef.current, (id, name) => setAttachments(attachedRef.current.map((a) => (a.id === id ? { ...a, stored: name } : a))));
        } catch (error) {
          setAttachError(error instanceof Error ? error.message : 'The images could not be stored.');
          return;
        }
      }
      let image: { data: string; mimeType: string } | undefined;
      if (withPicture && comp && range && thumbnailFrameUrl) {
        image = (await contactSheet(contactFrames(range), comp.fps, comp.width, comp.height, thumbnailFrameUrl)) ?? undefined;
      } else if (withPicture && comp && layers.length > 0) {
        const rect = unionRect(layers.flatMap((l: InspectLayer) => layerRect(l) ?? []), 24, comp.width, comp.height);
        const last: ReceivedFrame | null = lastImage();
        if (rect && last) image = (await cropToPng(last, comp.width, rect)) ?? undefined;
      }
      const context = comp && project ? buildChatContext({ entry: project.entry, cwd, comp, frame, layers, timeline, range, ...(plugins ? { plugins } : {}) }) : '';
      if (chat.send(message, context, chips, image, attachments)) {
        setText('');
        for (const a of attachedRef.current) if (a.preview && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(a.preview);
        setAttachments([]);
      }
    } finally {
      setSending(false);
    }
  };
  const onDragEnter = (event: DragEvent) => {
    if (unavailable || !dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth.current++;
    setDragging(true);
  };
  const onDragOver = (event: DragEvent) => {
    if (unavailable || !dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (event: DragEvent) => {
    if (!dragHasFiles(event.dataTransfer)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent) => {
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!unavailable) addImages(filesOf(event.dataTransfer));
  };
  const onPaste = (event: ClipboardEvent) => {
    const files = filesOf(event.clipboardData);
    // Text pastes as it always did; only a picture on the clipboard is taken.
    if (unavailable || !files.some((f) => f.type.startsWith('image/'))) return;
    event.preventDefault();
    addImages(files);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const presets = info?.presets ?? [];
  const noAgent = info !== null && presets.length === 0 && state.command === null;
  const unavailable = noAgent || !!info?.disabled;

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      data-testid="agent-panel"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onPaste={onPaste}
    >
      {dragging && (
        <div
          className="bg-background/80 border-primary text-primary pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed text-sm font-medium backdrop-blur-[2px]"
          data-testid="drop-overlay"
        >
          Drop images to attach
        </div>
      )}
      <div className="flex h-14 shrink-0 items-center gap-2 px-4">
        <SparklesIcon className="text-primary size-4 shrink-0" aria-hidden="true" />
        <h2 className="text-sm font-semibold">Agent</h2>
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs" role="status">
          <span className={cn('size-1.5 rounded-full', busy ? 'bg-warning animate-pulse' : state.status === 'ready' ? 'bg-success' : 'bg-muted-foreground/50')} aria-hidden="true" />
          {statusText(state)}
        </span>
      </div>

      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-1 pb-4" data-testid="chat-list" aria-live="polite">
        {info?.disabled && (
          <div role="alert" className="bg-destructive/10 text-destructive-foreground rounded-xl p-3 text-[13px]">
            {info.disabled}
          </div>
        )}
        {noAgent && !info?.disabled && (
          <div role="alert" className="bg-destructive/10 text-destructive-foreground rounded-xl p-3 text-[13px] leading-relaxed">
            No coding agent was found on this computer. Install Claude Code, Codex or Gemini CLI, or start the studio with{' '}
            <code className="font-mono">--agent &quot;your command&quot;</code>.
          </div>
        )}
        {state.items.length === 0 && !unavailable && (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-2 text-center">
            <span className="bg-accent text-accent-foreground flex size-11 items-center justify-center rounded-2xl">
              <SparklesIcon className="size-5" aria-hidden="true" />
            </span>
            <div className="flex flex-col gap-1">
              <p className="text-[15px] font-semibold">What should change?</p>
              <p className="text-muted-foreground text-[13px] leading-relaxed">
                Click a layer in the preview, or drag a box around several (Shift adds). Your agent sees what you picked.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => {
                    setText(suggestion);
                    inputRef.current?.focus();
                  }}
                  className="bg-muted hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-full px-3 py-1.5 text-xs transition-colors outline-none focus-visible:ring-2"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}
        {rows.map((row) =>
          row.kind === 'item' ? (
            <Item key={row.item.id} item={row.item} onAnswer={chat.answer} />
          ) : (
            <ToolGroup key={row.tools[0]!.id} tools={row.tools} live={busy && (row.last || row.tools.some((t) => t.status !== 'completed' && t.status !== 'failed'))} ctx={paths} />
          ),
        )}
        {busy && state.items.at(-1)?.kind === 'user' && <p className="text-muted-foreground text-xs">Thinking…</p>}
      </div>

      <UpNext items={state.queue} take={chat.take} remove={chat.unqueue} requeue={chat.requeue} sendNow={chat.sendNow} />

      <div className="shrink-0 p-3 pt-0">
        <div className="bg-background/60 border-input has-[textarea:focus-visible]:border-ring has-[textarea:focus-visible]:ring-ring/20 rounded-2xl border p-2.5 transition-[box-shadow,border-color] has-[textarea:focus-visible]:ring-[3px]">
          <AttachmentChips items={attached} remove={removeImage} />
          {attachError && (
            <p role="alert" className="text-destructive-foreground mb-1.5 px-1 text-xs" data-testid="attach-error">
              {attachError}
            </p>
          )}
          <SelectionChips
            chips={chipList}
            rangeChip={rangeChip}
            {...(onClearRange ? { onClearRange } : {})}
            remove={(ids) => selectLayers(selectedLayers.filter((id) => !ids.includes(id)))}
            clearAll={() => selectLayers([])}
          />
          <textarea
            ref={inputRef}
            aria-label="Message for the agent"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={busy ? 'Queue a message for when the agent is done' : 'Ask the agent to change something \u2014 drop or paste images too'}
            rows={2}
            className="placeholder:text-muted-foreground/70 block max-h-40 min-h-[52px] w-full resize-none bg-transparent px-1 py-1 text-[13.5px] leading-relaxed outline-none"
          />
          <div className="mt-1 flex items-center gap-2">
            <Hint label="Send a picture of the current frame with the message">
              <label className="text-muted-foreground flex items-center gap-2 text-xs select-none">
                <Switch aria-label="Send a picture of the current frame with the message" checked={withPicture} onCheckedChange={(checked) => setWithPicture(checked)} className="sm:[--thumb-size:--spacing(3.5)]" />
                <FrameIcon className="size-3.5" aria-hidden="true" />
                Frame
              </label>
            </Hint>
            <div className="ml-auto flex items-center gap-2">
              <input
                ref={pickerRef}
                type="file"
                multiple
                accept={ACCEPT_IMAGES}
                hidden
                data-testid="attach-input"
                onChange={(event) => {
                  addImages(Array.from(event.target.files ?? []));
                  // the same file can be chosen again
                  event.target.value = '';
                }}
              />
              <Hint label="Attach images (or drop / paste)">
                <Button size="icon" variant="ghost" aria-label="Attach images" disabled={unavailable} onClick={() => pickerRef.current?.click()} className="text-muted-foreground rounded-full">
                  <ImagePlusIcon />
                </Button>
              </Hint>
              {busy && (
                <Button size="sm" variant="outline" onClick={chat.stop} className="rounded-full px-3.5">
                  <SquareIcon className="size-3 fill-current" aria-hidden="true" />
                  Stop
                </Button>
              )}
              <Button
                size="icon"
                onClick={() => void send()}
                aria-label={state.queue.length > 0 ? `Send (${state.queue.length} queued)` : 'Send'}
                disabled={(text.trim() === '' && attached.length === 0) || unavailable || sending}
                className="relative rounded-full"
              >
                <ArrowUpIcon />
                {state.queue.length > 0 && (
                  <span
                    data-testid="queue-count"
                    className="bg-foreground text-background absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full text-[10px] leading-none font-medium"
                  >
                    {state.queue.length}
                  </span>
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
