import type { ReactNode } from 'react';

import type { CompositionInfo, ProjectInfo } from '@/api';
import type { Zoom } from '@/components/viewer/viewer';
import { WORKSPACES, type Workspace } from '@/components/shell/tool-bar';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Player, PlayerState } from '@/lib/player';

interface MenuBarProps {
  project: ProjectInfo | null;
  buildId: number;
  connected: boolean;
  compositions: CompositionInfo[];
  comp: CompositionInfo | null;
  onSelectComp(id: string): void;
  player: Player;
  playback: PlayerState;
  onZoom(zoom: Zoom): void;
  safeZones: boolean;
  onSafeZonesChange(on: boolean): void;
  workspace: Workspace;
  onSelectWorkspace(workspace: Workspace): void;
  onRender(): void;
  onReload(): void;
  onShowShortcuts(): void;
}

function Menu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="hover:text-foreground data-[state=open]:text-foreground cursor-default rounded-xs px-1 py-0.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50">
        {label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MenuBar({
  project,
  buildId,
  connected,
  compositions,
  comp,
  onSelectComp,
  player,
  playback,
  onZoom,
  safeZones,
  onSafeZonesChange,
  workspace,
  onSelectWorkspace,
  onRender,
  onReload,
  onShowShortcuts,
}: MenuBarProps) {
  const entry = project?.entry.split(/[\\/]/).pop();
  const lastFrame = comp ? comp.durationInFrames - 1 : 0;

  return (
    <div className="bg-background/80 flex h-7 items-center gap-3 border-b border-white/[0.06] px-3 text-[11px]">
      <div className="flex items-center gap-1.5 font-semibold tracking-tight">
        <span
          className="flex size-4 items-center justify-center rounded-[3px] bg-gradient-to-br from-nle-value to-nle-blue text-[9px] font-bold text-white shadow-xs"
          aria-hidden="true"
        >
          K
        </span>
        <span>Kinetograph studio</span>
      </div>

      <nav aria-label="Menus" className="text-muted-foreground flex items-center gap-1">
        <Menu label="File">
          <DropdownMenuItem onSelect={onRender}>Render…</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onReload}>Reload</DropdownMenuItem>
        </Menu>

        <Menu label="Composition">
          {compositions.length === 0 ? (
            <DropdownMenuItem disabled>No compositions</DropdownMenuItem>
          ) : (
            <DropdownMenuRadioGroup value={comp?.id ?? ''} onValueChange={onSelectComp}>
              {compositions.map((c) => (
                <DropdownMenuRadioItem key={c.id} value={c.id}>
                  {c.id}
                  <DropdownMenuShortcut>
                    {c.width}×{c.height}
                  </DropdownMenuShortcut>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          )}
        </Menu>

        <Menu label="View">
          <DropdownMenuItem disabled={!comp} onSelect={() => onZoom('fit')}>
            Fit
            <DropdownMenuShortcut>0</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!comp} onSelect={() => onZoom(1)}>
            100%
            <DropdownMenuShortcut>1</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked={safeZones} onCheckedChange={(on) => onSafeZonesChange(on === true)}>
            Safe zones
          </DropdownMenuCheckboxItem>
        </Menu>

        <Menu label="Playback">
          <DropdownMenuItem disabled={!comp} onSelect={() => player.toggle()}>
            {playback.playing ? 'Pause' : 'Play'}
            <DropdownMenuShortcut>Space</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!comp} onSelect={() => player.seek(0)}>
            Go to start
            <DropdownMenuShortcut>Home</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!comp} onSelect={() => player.seek(lastFrame)}>
            Go to end
            <DropdownMenuShortcut>End</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!comp} onSelect={() => player.step(-1)}>
            Step back
            <DropdownMenuShortcut>←</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!comp} onSelect={() => player.step(1)}>
            Step forward
            <DropdownMenuShortcut>→</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            disabled={!comp}
            checked={playback.loop}
            onCheckedChange={(on) => player.setLoop(on === true)}
          >
            Loop
            <DropdownMenuShortcut>L</DropdownMenuShortcut>
          </DropdownMenuCheckboxItem>
        </Menu>

        <Menu label="Window">
          <DropdownMenuLabel>Workspace</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={workspace} onValueChange={(next) => onSelectWorkspace(next as Workspace)}>
            {WORKSPACES.map((ws) => (
              <DropdownMenuRadioItem key={ws} value={ws}>
                {ws}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </Menu>

        <Menu label="Help">
          <DropdownMenuItem onSelect={onShowShortcuts}>
            Keyboard shortcuts
            <DropdownMenuShortcut>?</DropdownMenuShortcut>
          </DropdownMenuItem>
        </Menu>
      </nav>

      {entry && (
        <span
          className="text-muted-foreground bg-secondary/80 mx-auto rounded-xs border border-white/[0.06] px-2 py-0.5 font-mono text-[10px]"
          title={project?.entry}
        >
          {entry}
        </span>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        {!connected && (
          <Badge variant="destructive" className="h-4 rounded-xs px-1.5 font-mono text-[10px]">
            <span className="size-1.5 rounded-full bg-current" />
            offline
          </Badge>
        )}
        {project && (
          <Badge variant="outline" className="h-4 rounded-xs px-1.5 font-mono text-[10px]">
            v{project.version}
          </Badge>
        )}
        <Badge variant="outline" className="h-4 rounded-xs px-1.5 font-mono text-[10px]">
          build {buildId}
        </Badge>
      </div>
    </div>
  );
}
