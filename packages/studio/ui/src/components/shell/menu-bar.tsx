import { LockIcon } from 'lucide-react';

import type { ProjectInfo } from '@/api';
import { Badge } from '@/components/ui/badge';

const MENUS = ['File', 'Edit', 'Composition', 'Layer', 'Effect', 'Animation', 'View', 'Window'];

interface MenuBarProps {
  project: ProjectInfo | null;
  buildId: number;
  connected: boolean;
}

export function MenuBar({ project, buildId, connected }: MenuBarProps) {
  const entry = project?.entry.split(/[\\/]/).pop();

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

      <nav className="text-muted-foreground hidden items-center gap-3 text-[11px] lg:flex" aria-hidden="true">
        {MENUS.map((item) => (
          <span key={item} className="hover:text-foreground cursor-default transition-colors">
            {item}
          </span>
        ))}
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
        <span
          className="hidden items-center gap-1 rounded-xs border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-300 sm:inline-flex"
          title="Currently in Read-Only Inspect Mode; interactive canvas & keyframe editing coming soon"
        >
          <LockIcon className="size-2.5" aria-hidden="true" />
          <span>View-Only Mode</span>
        </span>
        {project && (
          <Badge variant="outline" className="h-4 rounded-xs px-1.5 font-mono text-[10px]">
            v{project.version}
          </Badge>
        )}
        <Badge variant="outline" className="h-4 rounded-xs px-1.5 font-mono text-[10px]">
          build {buildId}
        </Badge>
        <Badge variant={connected ? 'secondary' : 'destructive'} className="h-4 rounded-xs px-1.5 font-mono text-[10px]">
          <span className={`size-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-current'}`} />
          {connected ? 'connected' : 'offline'}
        </Badge>
      </div>
    </div>
  );
}
