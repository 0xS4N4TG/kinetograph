import { Streamdown } from 'streamdown';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowUpIcon,
  CheckIcon,
  FileTextIcon,
  ImageIcon,
  LoaderCircleIcon,
  PencilIcon,
  SearchIcon,
  SparklesIcon,
  SquareIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WrenchIcon,
  XIcon,
} from 'lucide-react';

import type { AgentInfo, CompositionInfo, InspectResult, ProjectInfo, ReceivedFrame, TimelineData } from '@/api';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { ChatItem } from '@/lib/chat';
import { buildChatContext } from '@/lib/chat-context';
import { cropToPng } from '@/lib/crop';
import { findLayer, type InspectLayer } from '@/lib/inspect';
import { chipText, layerRect, unionRect } from '@/lib/selection';
import type { Chat } from '@/lib/use-chat';
import { cn } from '@/lib/utils';

interface AgentPanelProps {
  comp: CompositionInfo | null;
  project: ProjectInfo | null;
  inspect: InspectResult | null;
  selectedLayers: string[];
  selectLayers(ids: string[]): void;
  lastImage(): ReceivedFrame | null;
  chat: Chat;
  timeline: TimelineData | null;
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

const basename = (path: string) => path.split('/').pop() ?? path;

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

const SUGGESTIONS = ['Make the title bigger', 'Try a warmer colour palette', 'Slow down the intro'];

function ToolIcon({ kind }: { kind: string }) {
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return <PencilIcon aria-hidden="true" />;
  if (kind === 'read') return <FileTextIcon aria-hidden="true" />;
  if (kind === 'search') return <SearchIcon aria-hidden="true" />;
  if (kind === 'execute') return <TerminalIcon aria-hidden="true" />;
  return <WrenchIcon aria-hidden="true" />;
}

const Item = memo(function Item({ item, onAnswer }: { item: ChatItem; onAnswer(id: string, optionId: string | null): void }) {
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
          <p className="bg-primary text-primary-foreground max-w-[90%] rounded-2xl rounded-br-md px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap">{item.text}</p>
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
    case 'tool': {
      const done = item.status === 'completed';
      const failed = item.status === 'failed';
      return (
        <div
          className="bg-muted/70 text-muted-foreground flex items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] [&_svg]:size-3.5 [&_svg]:shrink-0"
          data-testid="chat-tool"
        >
          <span className="bg-card text-foreground/80 flex size-6 shrink-0 items-center justify-center rounded-lg">
            <ToolIcon kind={item.toolKind} />
          </span>
          <span className="text-foreground min-w-0 truncate font-medium">{item.title || 'Working'}</span>
          {item.files.length > 0 && (
            <span className="truncate font-mono text-[11px]" title={item.files.join(', ')}>
              {item.files.map(basename).join(', ')}
            </span>
          )}
          <span className="ml-auto shrink-0">
            {done ? (
              <CheckIcon className="text-success" aria-label="done" />
            ) : failed ? (
              <XIcon className="text-destructive" aria-label="failed" />
            ) : (
              <LoaderCircleIcon className="animate-spin" aria-label="working" />
            )}
          </span>
        </div>
      );
    }
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
export const AgentPanel = memo(function AgentPanel({ comp, project, inspect, selectedLayers, selectLayers, lastImage, chat, timeline }: AgentPanelProps) {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [text, setText] = useState('');
  const [withPicture, setWithPicture] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
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
  const chips = layers.map((layer) => chipText(layer, frame, cwd));

  const send = async (override?: string) => {
    const message = (override ?? text).trim();
    if (message === '' || busy) return;
    let image: { data: string; mimeType: string } | undefined;
    if (withPicture && comp && layers.length > 0) {
      const rect = unionRect(layers.flatMap((l: InspectLayer) => layerRect(l) ?? []), 24, comp.width, comp.height);
      const last: ReceivedFrame | null = lastImage();
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
  const unavailable = noAgent || !!info?.disabled;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agent-panel">
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
        {state.items.map((item) => (
          <Item key={item.id} item={item} onAnswer={chat.answer} />
        ))}
        {busy && state.items.at(-1)?.kind === 'user' && <p className="text-muted-foreground text-xs">Thinking…</p>}
      </div>

      <div className="shrink-0 p-3 pt-0">
        <div className="bg-background/60 border-input has-[textarea:focus-visible]:border-ring has-[textarea:focus-visible]:ring-ring/20 rounded-2xl border p-2.5 transition-[box-shadow,border-color] has-[textarea:focus-visible]:ring-[3px]">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5 px-0.5" data-testid="selection-chips">
            {chips.length === 0 ? (
              <span className="text-muted-foreground text-xs">Nothing selected: the agent only knows the frame.</span>
            ) : (
              layers.map((layer, index) => (
                <span key={layer.id} className="bg-accent text-accent-foreground flex max-w-full items-center gap-1 rounded-full py-0.5 pr-1 pl-2.5 text-xs">
                  <span className="truncate">{chips[index]}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${chips[index]}`}
                    onClick={() => selectLayers(selectedLayers.filter((id) => id !== layer.id))}
                    className="hover:bg-foreground/10 rounded-full p-0.5"
                  >
                    <XIcon className="size-3" aria-hidden="true" />
                  </button>
                </span>
              ))
            )}
          </div>
          <textarea
            ref={inputRef}
            aria-label="Message for the agent"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask the agent to change something"
            rows={2}
            className="placeholder:text-muted-foreground/70 block max-h-40 min-h-[52px] w-full resize-none bg-transparent px-1 py-1 text-[13.5px] leading-relaxed outline-none"
          />
          <div className="mt-1 flex items-center gap-2">
            <label className="text-muted-foreground flex items-center gap-2 text-xs select-none">
              <Switch aria-label="Include a picture of the selection" checked={withPicture} onCheckedChange={(checked) => setWithPicture(checked)} className="sm:[--thumb-size:--spacing(3.5)]" />
              <ImageIcon className="size-3.5" aria-hidden="true" />
              Picture
            </label>
            <div className="ml-auto">
              {busy ? (
                <Button size="sm" variant="outline" onClick={chat.stop} className="rounded-full px-3.5">
                  <SquareIcon className="size-3 fill-current" aria-hidden="true" />
                  Stop
                </Button>
              ) : (
                <Button size="icon" onClick={() => void send()} aria-label="Send" disabled={text.trim() === '' || unavailable} className="rounded-full">
                  <ArrowUpIcon />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
