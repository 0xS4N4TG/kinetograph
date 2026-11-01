// The tool calls of a turn in the chat: one quiet block per run of consecutive calls ("Ran 3 commands · read 2 files"), open
// while the agent is working on it and folded when it is done, with a thin row per call that opens to the command, its
// output and the diffs.

import { useState } from 'react';
import {
  CheckIcon,
  ChevronRightIcon,
  FileTextIcon,
  GlobeIcon,
  LightbulbIcon,
  MoveRightIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  Trash2Icon,
  WrenchIcon,
  XIcon,
} from 'lucide-react';

import { formatDuration, groupLabel, middleTruncate, stripAnsi, summarize, tidyPaths, displayPath, type PathContext, type ToolItem } from '@/lib/tool-summary';
import { cn } from '@/lib/utils';

const ICONS: Record<string, typeof WrenchIcon> = {
  execute: TerminalIcon,
  read: FileTextIcon,
  edit: PencilIcon,
  delete: Trash2Icon,
  move: MoveRightIcon,
  search: SearchIcon,
  fetch: GlobeIcon,
  think: LightbulbIcon,
};

/** Pulsing dot while it runs (still under reduced motion), a check when done, a red cross when it failed. */
function Status({ status }: { status: string }) {
  if (status === 'completed') return <CheckIcon className="text-success size-3 shrink-0" aria-label="done" />;
  if (status === 'failed') return <XIcon className="text-destructive size-3 shrink-0" aria-label="failed" />;
  return <span role="img" aria-label="running" className="bg-warning size-1.5 shrink-0 animate-pulse rounded-full motion-reduce:animate-none" />;
}

const finished = (status: string) => status === 'completed' || status === 'failed';

function Detail({ tool, ctx }: { tool: ToolItem; ctx: PathContext }) {
  const input = tool.input;
  const output = tool.output ? stripAnsi(tool.output).trimEnd() : '';
  const paths = tool.files.length > 0 ? tool.files : input?.path ? [input.path] : [];
  const pre = 'bg-muted/60 text-foreground/90 max-h-48 overflow-auto rounded-md px-2.5 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all';
  return (
    <div className="flex flex-col gap-1.5 pt-1 pb-2" data-testid="chat-tool-detail">
      {input?.command && (
        <pre className={pre} data-testid="tool-command">
          {input.command}
        </pre>
      )}
      {input?.pattern && tool.toolKind !== 'execute' && <p className="font-mono text-[11px] break-all">{input.pattern}</p>}
      {input?.url && <p className="font-mono text-[11px] break-all">{input.url}</p>}
      {paths.length > 0 && (
        <ul className="text-muted-foreground flex flex-col font-mono text-[11px]">
          {paths.map((p) => (
            <li key={p} className="break-all" title={p}>
              {displayPath(p, ctx)}
            </li>
          ))}
        </ul>
      )}
      {(tool.diffs ?? []).map((diff) => (
        <div key={diff.path} className="flex flex-col gap-0.5" data-testid="tool-diff">
          <p className="text-muted-foreground font-mono text-[11px]">
            {displayPath(diff.path, ctx)} <span className="text-success">+{diff.added}</span> <span className="text-destructive">−{diff.removed}</span>
          </p>
          <pre className="bg-muted/60 max-h-48 overflow-auto rounded-md py-1 font-mono text-[11px] leading-relaxed">
            {diff.lines.map((line, index) => (
              <span
                key={index}
                className={cn('block px-2.5 whitespace-pre', line[0] === '+' && 'bg-success/15', line[0] === '-' && 'bg-destructive/15', line[0] === ' ' && 'text-muted-foreground')}
              >
                {line || ' '}
              </span>
            ))}
          </pre>
        </div>
      ))}
      {output !== '' && (
        <pre className={pre} data-testid="tool-output">
          {output}
        </pre>
      )}
      {!input?.command && output === '' && paths.length === 0 && !(tool.diffs ?? []).length && !input?.pattern && !input?.url && (
        <p className="text-muted-foreground text-[11px]">{tidyPaths(tool.title, ctx) || 'No details.'}</p>
      )}
    </div>
  );
}

function Row({ tool, ctx }: { tool: ToolItem; ctx: PathContext }) {
  const [open, setOpen] = useState(false);
  const Icon = ICONS[tool.toolKind] ?? WrenchIcon;
  const summary = summarize(tool, ctx);
  const text = summary.isPath ? middleTruncate(summary.text) : summary.text;
  return (
    <li data-testid="chat-tool" data-kind={tool.toolKind} data-status={tool.status}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={summary.text}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex w-full min-w-0 items-center gap-2 rounded-md py-1 text-left text-xs outline-none focus-visible:ring-2"
      >
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        {summary.verb && <span className="shrink-0">{summary.verb}</span>}
        <span className={cn('min-w-0 truncate', summary.mono ? 'text-foreground/80 font-mono text-[11px]' : 'text-foreground/80')} data-testid="tool-summary">
          {text}
        </span>
        {summary.added !== undefined && (
          <span className="shrink-0 font-mono text-[11px]">
            <span className="text-success">+{summary.added}</span> <span className="text-destructive">−{summary.removed}</span>
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {tool.ms !== undefined && finished(tool.status) && tool.ms > 0 && <span className="text-[11px] tabular-nums">{formatDuration(tool.ms)}</span>}
          <Status status={tool.status} />
        </span>
      </button>
      {open && <Detail tool={tool} ctx={ctx} />}
    </li>
  );
}

/**
 * A run of consecutive tool calls. `live` says the agent is still on it: it shows open then, and folds when it is not live
 * any more, unless the person has opened or closed it themselves.
 */
export function ToolGroup({ tools, live, ctx }: { tools: ToolItem[]; live: boolean; ctx: PathContext }) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? live;
  const failed = tools.some((t) => t.status === 'failed');
  const running = tools.some((t) => !finished(t.status));
  return (
    <div data-testid="chat-tool-group" className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setChosen(!open)}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex w-full items-center gap-1.5 rounded-md py-0.5 text-left text-xs outline-none focus-visible:ring-2"
      >
        <ChevronRightIcon className={cn('size-3.5 shrink-0 transition-transform motion-reduce:transition-none', open && 'rotate-90')} aria-hidden="true" />
        <span data-testid="tool-group-label">{groupLabel(tools)}</span>
        {running ? <Status status="in_progress" /> : failed ? <Status status="failed" /> : null}
      </button>
      {open && (
        <ul className="border-border/60 mt-0.5 ml-[7px] flex flex-col border-l pl-3">
          {tools.map((tool) => (
            <Row key={tool.id} tool={tool} ctx={ctx} />
          ))}
        </ul>
      )}
    </div>
  );
}
