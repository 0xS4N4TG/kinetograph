import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  CheckIcon,
  FileTextIcon,
  LoaderCircleIcon,
  MousePointerClickIcon,
  PencilIcon,
  RotateCcwIcon,
  SearchIcon,
  SendIcon,
  SquareIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WrenchIcon,
  XIcon,
} from 'lucide-react';

import type { AgentInfo, ReceivedFrame, TimelineData } from '@/api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { ChatItem } from '@/lib/chat';
import { buildChatContext } from '@/lib/chat-context';
import { cropToPng } from '@/lib/crop';
import { findLayer, type InspectLayer } from '@/lib/inspect';
import { chipText, layerRect, unionRect } from '@/lib/selection';
import type { Chat } from '@/lib/use-chat';
import { cn } from '@/lib/utils';
import type { Studio } from '@/studio';

interface AgentPanelProps {
  studio: Pick<Studio, 'comp' | 'project' | 'inspect' | 'selectedLayers' | 'selectLayers' | 'lastImage'> & { frame: number };
  chat: Chat;
  timeline: TimelineData | null;
}

const basename = (path: string) => path.split('/').pop() ?? path;

/** The words for a status of the connection to the agent. */
function statusText(chat: Chat['state']): string {
  switch (chat.status) {
    case 'starting':
      return 'Starting the agent…';
    case 'busy':
      return 'Working…';
    case 'ready':
      return 'Ready';
    default:
      return 'Not started';
  }
}

function ToolIcon({ kind }: { kind: string }) {
  const cls = 'size-3 shrink-0';
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return <PencilIcon className={cls} aria-hidden="true" />;
  if (kind === 'read') return <FileTextIcon className={cls} aria-hidden="true" />;
  if (kind === 'search') return <SearchIcon className={cls} aria-hidden="true" />;
  if (kind === 'execute') return <TerminalIcon className={cls} aria-hidden="true" />;
  return <WrenchIcon className={cls} aria-hidden="true" />;
}

function Item({ item, onAnswer }: { item: ChatItem; onAnswer(id: string, optionId: string | null): void }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex flex-col items-end gap-1" data-testid="chat-user">
          {item.chips.length > 0 && (
            <div className="flex max-w-full flex-wrap justify-end gap-1">
              {item.chips.map((chip, index) => (
                <span key={index} className="bg-nle-blue/15 text-sky-300 max-w-full truncate rounded-full px-2 py-0.5 text-[10px]">
                  {chip}
                </span>
              ))}
            </div>
          )}
          <p className="bg-nle-blue/25 max-w-[92%] rounded-md px-2.5 py-1.5 text-xs whitespace-pre-wrap">{item.text}</p>
        </div>
      );
    case 'agent':
      return (
        <p className="text-xs leading-relaxed break-words whitespace-pre-wrap" data-testid="chat-agent">
          {item.text}
        </p>
      );
    case 'tool': {
      const done = item.status === 'completed';
      const failed = item.status === 'failed';
      return (
        <div className="text-muted-foreground flex items-center gap-1.5 text-[11px]" data-testid="chat-tool">
          <ToolIcon kind={item.toolKind} />
          <span className="min-w-0 truncate">{item.title || 'Working'}</span>
          {item.files.length > 0 && (
            <span className="text-foreground/80 truncate font-mono text-[10px]" title={item.files.join(', ')}>
              {item.files.map(basename).join(', ')}
            </span>
          )}
          <span className="ml-auto shrink-0">
            {done ? (
              <CheckIcon className="size-3 text-emerald-400" aria-label="done" />
            ) : failed ? (
              <XIcon className="text-destructive size-3" aria-label="failed" />
            ) : (
              <LoaderCircleIcon className="size-3 animate-spin" aria-label="working" />
            )}
          </span>
        </div>
      );
    }
    case 'permission': {
      const chosen = item.answered === null ? null : (item.options.find((o) => o.id === item.answered)?.name ?? 'Cancelled');
      return (
        <div className="border-amber-400/40 bg-amber-400/10 flex flex-col gap-1.5 rounded-md border p-2" data-testid="chat-permission" role="group" aria-label="The agent asks">
          <p className="text-xs font-medium">{item.title}</p>
          {item.files.length > 0 && <p className="text-muted-foreground truncate font-mono text-[10px]">{item.files.join(', ')}</p>}
          {chosen === null ? (
            <div className="flex flex-wrap gap-1.5">
              {item.options.map((option) => (
                <Button
                  key={option.id}
                  size="sm"
                  variant={option.kind.startsWith('allow') ? 'default' : 'outline'}
                  className="h-6 rounded-xs px-2 text-[11px]"
                  onClick={() => onAnswer(item.permissionId, option.id)}
                >
                  {option.name}
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-[11px]">{chosen}</p>
          )}
        </div>
      );
    }
    case 'error':
      return (
        <div role="alert" className="border-destructive/50 bg-destructive/10 flex items-start gap-1.5 rounded-md border p-2 text-xs" data-testid="chat-error">
          <TriangleAlertIcon className="text-destructive mt-0.5 size-3 shrink-0" aria-hidden="true" />
          <span>{item.text}</span>
        </div>
      );
  }
}

/** The Agent tab: chat with the user's own coding agent about what is selected in the preview. */
export function AgentPanel({ studio, chat, timeline }: AgentPanelProps) {
  const { comp, project, inspect, selectedLayers, frame } = studio;
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [text, setText] = useState('');
  const [withPicture, setWithPicture] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const { state } = chat;
  const busy = state.status === 'busy';

  useEffect(() => {
    let live = true;
    void chat.loadInfo().then((found) => live && setInfo(found));
    return () => {
      live = false;
    };
  }, [chat.loadInfo]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [state.items]);

  const layers = useMemo(() => {
    if (!inspect) return [];
    return selectedLayers.flatMap((id) => {
      const found = findLayer(inspect.layers, id);
      return found ? [found] : [];
    });
  }, [inspect, selectedLayers]);
  const cwd = project?.cwd ?? '';
  const chips = layers.map((layer) => chipText(layer, frame, cwd));

  const send = async () => {
    const message = text.trim();
    if (message === '' || busy) return;
    let image: { data: string; mimeType: string } | undefined;
    if (withPicture && comp && layers.length > 0) {
      const rect = unionRect(layers.flatMap((l: InspectLayer) => layerRect(l) ?? []), 24, comp.width, comp.height);
      const last: ReceivedFrame | null = studio.lastImage();
      if (rect && last) image = (await cropToPng(last, comp.width, rect)) ?? undefined;
    }
    const context = comp && project ? buildChatContext({ entry: project.entry, cwd, comp, frame, layers, timeline }) : '';
    if (chat.send(message, context, chips, image)) setText('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const presets = info?.presets ?? [];
  const noAgent = info !== null && presets.length === 0 && state.command === null;

  return (
    <div className="bg-card flex h-full min-h-0 flex-col" data-testid="agent-panel">
      <div className="bg-background/50 flex h-7 shrink-0 items-center gap-2 border-b px-2 text-[11px]">
        <label className="flex min-w-0 items-center gap-1.5">
          <span className="text-muted-foreground">Agent</span>
          <select
            aria-label="Coding agent"
            value={state.command ?? ''}
            disabled={busy || presets.length === 0}
            onChange={(event) => chat.chooseAgent(event.target.value === '' ? null : event.target.value)}
            className="bg-background min-w-0 truncate rounded-xs border px-1 py-0.5 text-[11px]"
          >
            {state.command === null && <option value="">None</option>}
            {presets.map((preset) => (
              <option key={preset.id} value={preset.command}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>
        <span className="text-muted-foreground ml-auto shrink-0" role="status">
          {statusText(state)}
        </span>
        <Button variant="ghost" size="sm" onClick={chat.restart} disabled={state.items.length === 0 && state.status === 'idle'} className="h-5 gap-1 rounded-xs px-1.5 text-[10px]" title="Clear the conversation and start again">
          <RotateCcwIcon className="size-3" aria-hidden="true" />
          New chat
        </Button>
      </div>

      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-2.5" data-testid="chat-list" aria-live="polite">
        {info?.disabled && (
          <div role="alert" className="border-destructive/50 bg-destructive/10 rounded-md border p-2 text-xs">
            {info.disabled}
          </div>
        )}
        {noAgent && !info?.disabled && (
          <div role="alert" className="border-destructive/50 bg-destructive/10 rounded-md border p-2 text-xs">
            No coding agent was found on this computer. Install Claude Code, Codex or Gemini CLI, or start the studio with{' '}
            <code className="font-mono">--agent &quot;your command&quot;</code>.
          </div>
        )}
        {state.items.length === 0 && !noAgent && !info?.disabled && (
          <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
            <MousePointerClickIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            <span>
              Click a layer in the preview, or drag a box around several (hold Shift to add), then tell your coding agent what to
              change. It sees what you selected.
            </span>
          </p>
        )}
        {state.items.map((item) => (
          <Item key={item.id} item={item} onAnswer={chat.answer} />
        ))}
        {busy && state.items.at(-1)?.kind === 'user' && <p className="text-muted-foreground text-[11px]">Thinking…</p>}
      </div>

      <div className="shrink-0 border-t p-2">
        <div className="mb-1.5 flex flex-wrap items-center gap-1" data-testid="selection-chips">
          {chips.length === 0 ? (
            <span className="text-muted-foreground text-[10px]">Nothing selected: the agent only knows the frame.</span>
          ) : (
            layers.map((layer, index) => (
              <span
                key={layer.id}
                className="bg-nle-blue/15 text-sky-300 flex max-w-full items-center gap-1 rounded-full py-0.5 pr-1 pl-2 text-[10px]"
              >
                <span className="truncate">{chips[index]}</span>
                <button
                  type="button"
                  aria-label={`Remove ${chips[index]}`}
                  onClick={() => studio.selectLayers(selectedLayers.filter((id) => id !== layer.id))}
                  className="hover:bg-white/10 rounded-full p-0.5"
                >
                  <XIcon className="size-2.5" aria-hidden="true" />
                </button>
              </span>
            ))
          )}
        </div>
        <div className="flex items-end gap-1.5">
          <Textarea
            aria-label="Message for the agent"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="What should change?"
            rows={2}
            className={cn('max-h-32 min-h-0 resize-none px-2 py-1.5 text-xs md:text-xs')}
          />
          {busy ? (
            <Button size="sm" variant="outline" onClick={chat.stop} className="h-8 gap-1 rounded-xs px-2 text-[11px]">
              <SquareIcon className="size-3" aria-hidden="true" />
              Stop
            </Button>
          ) : (
            <Button size="sm" onClick={() => void send()} disabled={text.trim() === '' || noAgent || !!info?.disabled} className="h-8 gap-1 rounded-xs px-2 text-[11px]">
              <SendIcon className="size-3" aria-hidden="true" />
              Send
            </Button>
          )}
        </div>
        <label className="text-muted-foreground mt-1.5 flex items-center gap-1.5 text-[10px]">
          <input type="checkbox" checked={withPicture} onChange={(event) => setWithPicture(event.target.checked)} />
          Include a picture of the selection (if the agent can see pictures)
        </label>
      </div>
    </div>
  );
}
