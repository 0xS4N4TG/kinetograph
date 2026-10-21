import { HandIcon, MousePointerIcon, ZoomInIcon, type LucideIcon } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export const WORKSPACES = ['Default', 'Animation', 'Color & Inspect', 'Export'] as const;
export type Workspace = (typeof WORKSPACES)[number];

export type Tool = 'select' | 'hand' | 'zoom';

const TOOLS: { id: Tool; label: string; key: string; icon: LucideIcon }[] = [
  { id: 'select', label: 'Selection', key: 'V', icon: MousePointerIcon },
  { id: 'hand', label: 'Hand', key: 'H', icon: HandIcon },
  { id: 'zoom', label: 'Zoom', key: 'Z', icon: ZoomInIcon },
];

interface ToolBarProps {
  tool: Tool;
  onSelectTool(tool: Tool): void;
  workspace: Workspace;
  onSelectWorkspace(workspace: Workspace): void;
}

export function ToolBar({ tool, onSelectTool, workspace, onSelectWorkspace }: ToolBarProps) {
  return (
    <div className="flex h-8 items-center justify-between px-3 text-xs">
      <div className="flex items-center gap-1">
        {TOOLS.map(({ id, label, key, icon: Icon }) => {
          const active = tool === id;
          return (
            <Tooltip key={id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={label}
                  aria-pressed={active}
                  onClick={() => onSelectTool(id)}
                  className={cn(
                    'flex size-6 items-center justify-center rounded-xs transition-colors',
                    active ? 'bg-nle-blue text-white shadow-xs' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{`${label} (${key})`}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      {/* Workspace switcher */}
      <div className="flex h-full items-center gap-1">
        {WORKSPACES.map((ws) => {
          const active = workspace === ws;
          return (
            <button
              key={ws}
              type="button"
              aria-pressed={active}
              onClick={() => onSelectWorkspace(ws)}
              className={cn(
                'flex h-full items-center border-b-2 px-2.5 text-[11px] font-medium transition-colors',
                active ? 'border-nle-blue text-nle-value' : 'text-muted-foreground hover:text-foreground border-transparent',
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
