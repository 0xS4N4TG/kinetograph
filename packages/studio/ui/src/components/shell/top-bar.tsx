import { ChevronsUpDownIcon, MoonIcon, PanelLeftIcon, PanelRightIcon, SunIcon, UploadIcon } from 'lucide-react';
import { memo, type ReactNode } from 'react';

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
  launcher,
}: TopBarProps) {
  const entry = project?.entry.split(/[\\/]/).pop();
  return (
    <header className="grid h-10 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 select-none">
      <div className="flex min-w-0 items-center gap-2">
        <Hint label={chatOpen ? 'Hide the agent' : 'Show the agent'}>
          <Button variant="ghost" size="icon" aria-label={chatOpen ? 'Hide the agent' : 'Show the agent'} aria-pressed={chatOpen} onClick={onToggleChat}>
            <PanelLeftIcon />
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
          <Popover>
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
                    onClick={() => onSelectComp(c.id)}
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
        <span className="text-muted-foreground hidden font-mono text-[11px] xl:inline">
          {project ? `v${project.version} · ` : ''}build {buildId}
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
            <PanelRightIcon />
          </Button>
        </Hint>
        <Button onClick={onExport} className="rounded-full px-4" disabled={!comp}>
          <UploadIcon />
          Export
        </Button>
      </div>
    </header>
  );
});
