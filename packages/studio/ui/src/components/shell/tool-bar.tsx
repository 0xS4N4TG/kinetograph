import {
  BoxSelectIcon,
  CrosshairIcon,
  HandIcon,
  MoveIcon,
  MousePointerIcon,
  PenToolIcon,
  RotateCwIcon,
  SearchIcon,
  SparklesIcon,
  TypeIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

const WORKSPACES = ['Default', 'Animation', 'Color & Inspect', 'Export'] as const;
export type Workspace = (typeof WORKSPACES)[number];

interface ToolBarProps {
  workspace: Workspace;
  onSelectWorkspace(workspace: Workspace): void;
}

export function ToolBar({ workspace, onSelectWorkspace }: ToolBarProps) {
  return (
    <div className="flex h-8 items-center justify-between px-3 text-xs">
      <div className="flex items-center gap-1" aria-hidden="true">
        <span
          className="flex size-6 items-center justify-center rounded-xs bg-nle-blue text-white shadow-xs"
          title="Selection Tool (V) — Inspect Only"
        >
          <MousePointerIcon className="size-3.5" />
        </span>
        <span className="text-muted-foreground/70 flex size-6 items-center justify-center rounded-xs">
          <HandIcon className="size-3.5" />
        </span>
        <span className="text-muted-foreground/70 flex size-6 items-center justify-center rounded-xs">
          <SearchIcon className="size-3.5" />
        </span>
        <div className="bg-border mx-1 h-4 w-px" />
        <span className="text-muted-foreground/50 flex size-6 items-center justify-center rounded-xs" title="Rotation Tool (Planned)">
          <RotateCwIcon className="size-3.5" />
        </span>
        <span className="text-muted-foreground/50 flex size-6 items-center justify-center rounded-xs" title="Pan Behind / Anchor Point Tool (Planned)">
          <CrosshairIcon className="size-3.5" />
        </span>
        <span className="text-muted-foreground/50 flex size-6 items-center justify-center rounded-xs" title="Move / Transform Tool (Planned)">
          <MoveIcon className="size-3.5" />
        </span>
        <div className="bg-border mx-1 h-4 w-px" />
        <span className="text-muted-foreground/50 flex size-6 items-center justify-center rounded-xs" title="Rectangle / Shape Tool (Planned)">
          <BoxSelectIcon className="size-3.5" />
        </span>
        <span className="text-muted-foreground/50 flex size-6 items-center justify-center rounded-xs" title="Pen / Mask Tool (Planned)">
          <PenToolIcon className="size-3.5" />
        </span>
        <span className="text-muted-foreground/50 flex size-6 items-center justify-center rounded-xs" title="Text Tool (Planned)">
          <TypeIcon className="size-3.5" />
        </span>
        <div className="bg-border mx-1.5 h-4 w-px" />
        <span className="text-muted-foreground flex items-center gap-1 text-[11px]">
          <SparklesIcon className="size-3 text-nle-value" />
          <span>Snapping</span>
        </span>
      </div>

      {/* Workspace switcher */}
      <div className="flex h-full items-center gap-1" aria-hidden="true">
        {WORKSPACES.map((ws) => {
          const active = workspace === ws;
          return (
            <button
              key={ws}
              type="button"
              tabIndex={-1}
              onClick={() => onSelectWorkspace(ws)}
              className={cn(
                'flex h-full items-center border-b-2 px-2.5 text-[11px] font-medium transition-colors',
                active
                  ? 'border-nle-blue text-nle-value'
                  : 'text-muted-foreground hover:text-foreground border-transparent',
              )}
            >
              {ws}
            </button>
          );
        })}
      </div>
    </div>
  );
}
