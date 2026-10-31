import { ChevronsUpDownIcon, DownloadIcon, MessageSquareIcon, MoonIcon, SlidersHorizontalIcon, SunIcon } from 'lucide-react';
import { memo, useState, type ReactNode } from 'react';

import type { CompositionInfo, ProjectInfo } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import type { Theme } from '@/lib/theme';
import { cn } from '@/lib/utils';

interface TopBarProps {
  project: ProjectInfo | null;
  buildId: number;
  connected: boolean;
  compositions: CompositionInfo[];
  comp: CompositionInfo | null;
  onSelectComp(id: string): void;
  theme: Theme;
  onTheme(theme: Theme): void;
  chatOpen: boolean;
  onToggleChat(): void;
  inspectorOpen: boolean;
  onToggleInspector(): void;
  onExport(): void;
  /** Renders still running (count and the first one's percent), or null. */
  exporting: { count: number; percent: number } | null;
  onShowRenders(): void;
  /** The command menu's trigger, in the middle. */
  launcher: ReactNode;
}

export const specs = (c: CompositionInfo) => `${c.width}x${c.height} · ${c.fps} fps · ${c.durationInFrames} f`;

/** Project and composition on the left, the command menu in the middle, export and the panel toggles on the right. */
export const TopBar = memo(function TopBar({
  project,
  buildId,
  connected,
  compositions,
  comp,
  onSelectComp,
  theme,
  onTheme,
  chatOpen,
  onToggleChat,
  inspectorOpen,
  onToggleInspector,
  onExport,
  exporting,
  onShowRenders,
  launcher,
}: TopBarProps) {
  const entry = project?.entry.split(/[\\/]/).pop();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  return (
    <header className="grid h-10 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 select-none">
      <div className="flex min-w-0 items-center gap-2">
        <Hint label={chatOpen ? 'Hide the agent' : 'Show the agent'}>
          <Button variant="ghost" size="icon" aria-label={chatOpen ? 'Hide the agent' : 'Show the agent'} aria-pressed={chatOpen} onClick={onToggleChat}>
            <MessageSquareIcon />
          </Button>
        </Hint>
        <span
          className="bg-primary text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-[9px] text-[13px] font-bold shadow-sm"
          aria-hidden="true"
        >
          K
        </span>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-muted-foreground hidden truncate text-sm lg:inline" title={project?.entry}>
            {entry ?? 'Kinetograph'}
          </span>
          <span className="text-muted-foreground/50 hidden lg:inline">/</span>
          <Popover open={switcherOpen} onOpenChange={setSwitcherOpen}>
            <PopoverTrigger
              render={
                <Button variant="ghost" data-testid="composition-switcher" className="max-w-56 gap-1.5 rounded-full px-3 font-semibold">
                  <span className="truncate">{comp?.id ?? 'No composition'}</span>
                  <ChevronsUpDownIcon className="text-muted-foreground" />
                </Button>
              }
            />
            <PopoverPopup align="start" className="w-80" sideOffset={8}>
              <div data-testid="composition-list" className="-m-1 flex flex-col gap-0.5">
                {compositions.length === 0 && <p className="text-muted-foreground px-3 py-2 text-sm">No compositions.</p>}
                {compositions.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={c.id === comp?.id}
                    onClick={() => {
                      onSelectComp(c.id);
                      setSwitcherOpen(false);
                    }}
                    className={cn(
                      'flex flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left outline-none transition-colors',
                      'hover:bg-accent focus-visible:ring-ring focus-visible:ring-2',
                      c.id === comp?.id && 'bg-accent text-accent-foreground',
                    )}
                  >
                    <span className="text-sm font-medium">{c.id}</span>
                    <span className="text-muted-foreground font-mono text-[11px]">{specs(c)}</span>
                  </button>
                ))}
              </div>
            </PopoverPopup>
          </Popover>
        </div>
      </div>

      <div className="w-[min(36vw,360px)]">{launcher}</div>

      <div className="flex items-center justify-end gap-1.5">
        {!connected && (
          <Badge variant="error" className="rounded-full">
            offline
          </Badge>
        )}
        <span className="text-muted-foreground hidden items-center gap-1.5 font-mono text-[11px] xl:flex">
          {project && <span>v{project.version}</span>}
          <span>build {buildId}</span>
        </span>
        <Hint label={theme === 'dark' ? 'Light theme' : 'Dark theme'}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={theme === 'dark' ? 'Use the light theme' : 'Use the dark theme'}
            onClick={() => onTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </Button>
        </Hint>
        <Hint label={inspectorOpen ? 'Hide the inspector' : 'Show the inspector'}>
          <Button variant="ghost" size="icon" aria-label={inspectorOpen ? 'Hide the inspector' : 'Show the inspector'} aria-pressed={inspectorOpen} onClick={onToggleInspector}>
            <SlidersHorizontalIcon />
          </Button>
        </Hint>
        {exporting && (
          <button
            type="button"
            onClick={onShowRenders}
            data-testid="exporting"
            title="Show the render queue"
            className="bg-muted hover:bg-accent text-foreground focus-visible:ring-ring flex h-8 items-center gap-2 rounded-full px-3 text-xs font-medium tabular-nums outline-none focus-visible:ring-2"
          >
            <span className="relative block h-1.5 w-12 overflow-hidden rounded-full bg-foreground/15" aria-hidden="true">
              <span className="bg-playhead absolute inset-y-0 left-0 rounded-full" style={{ width: `${exporting.percent}%` }} />
            </span>
            Exporting {exporting.percent}%{exporting.count > 1 ? ` · ${exporting.count}` : ''}
          </button>
        )}
        <Button onClick={onExport} className="rounded-full px-4" disabled={!comp}>
          <DownloadIcon />
          Export
        </Button>
      </div>
    </header>
  );
});
