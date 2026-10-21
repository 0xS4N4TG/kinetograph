import { useState } from 'react';
import { FilmIcon, FolderIcon, LockIcon, MenuIcon, SearchIcon } from 'lucide-react';

import type { CompositionInfo } from '@/api';
import { PanelHeader } from '@/components/shell/panel-header';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatTimecode } from '@/lib/format';
import { cn } from '@/lib/utils';

interface ProjectPanelProps {
  compositions: CompositionInfo[];
  selected: string | null;
  onSelect(id: string): void;
}

const SWATCHES = ['bg-amber-400', 'bg-sky-400', 'bg-rose-400', 'bg-emerald-400', 'bg-violet-400'];

export function ProjectPanel({ compositions, selected, onSelect }: ProjectPanelProps) {
  const [query, setQuery] = useState('');
  const activeComp = compositions.find((c) => c.id === selected) ?? null;
  const filtered = query.trim()
    ? compositions.filter((c) => c.id.toLowerCase().includes(query.trim().toLowerCase()))
    : compositions;

  return (
    <div className="bg-card flex h-full flex-col select-none" data-testid="composition-list">
      <PanelHeader
        title={
          <div className="border-primary text-foreground flex h-full items-center gap-1.5 border-b-2 px-1 font-medium">
            <span>Project</span>
            <MenuIcon className="text-muted-foreground size-3" aria-hidden="true" />
          </div>
        }
      >
        <span className="text-muted-foreground font-mono text-[10px]">{compositions.length} items</span>
      </PanelHeader>

      {/* Selected item summary */}
      <div className="bg-background/40 flex items-center gap-3 border-b p-2.5">
        <div
          className="bg-background border-border relative flex h-11 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xs border shadow-inner"
          aria-hidden="true"
        >
          <div className="border-primary/40 bg-primary/10 flex size-full items-center justify-center">
            <FilmIcon className="text-primary/80 size-4" />
          </div>
        </div>
        {activeComp ? (
          <div className="min-w-0 flex-1 text-[11px] leading-tight">
            <div className="text-foreground truncate font-semibold">{activeComp.id}</div>
            <div className="text-muted-foreground mt-0.5 font-mono text-[10px]">
              {activeComp.width} × {activeComp.height} ({(activeComp.width / Math.max(1, activeComp.height)).toFixed(2)})
            </div>
            <div className="text-muted-foreground font-mono text-[10px]">
              {formatTimecode(activeComp.durationInFrames, activeComp.fps)} · {activeComp.fps} fps · 8 bpc
            </div>
          </div>
        ) : (
          <div className="text-muted-foreground text-[11px]">Select an item to see its details</div>
        )}
      </div>

      {/* Search bar */}
      <div className="border-b px-2 py-1.5">
        <div className="bg-background/70 border-border flex h-6 items-center gap-1.5 rounded-xs border px-2">
          <SearchIcon className="text-muted-foreground size-3 shrink-0" aria-hidden="true" />
          <input
            type="search"
            placeholder="Search project"
            aria-label="Search project"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="placeholder:text-muted-foreground/70 w-full bg-transparent text-[11px] outline-none"
          />
        </div>
      </div>

      {/* Table Column Header */}
      <div className="bg-secondary/30 text-muted-foreground grid shrink-0 grid-cols-[1fr_auto] items-center border-b px-2.5 py-1 text-[10px] font-medium tracking-wide">
        <span>Name</span>
        <span>Specs</span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {compositions.length === 0 ? (
          <p className="text-muted-foreground p-3 text-xs">No compositions.</p>
        ) : (
          <ul className="flex flex-col py-0.5">
            {filtered.map((comp, idx) => {
              const isSelected = comp.id === selected;
              const swatch = SWATCHES[idx % SWATCHES.length];
              return (
                <li key={comp.id}>
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => onSelect(comp.id)}
                    className={cn(
                      'hover:bg-white/[0.04] focus-visible:ring-ring/50 flex w-full flex-col items-start gap-0.5 border-b border-white/[0.04] px-2.5 py-1.5 text-left text-xs outline-none transition-colors focus-visible:ring-2',
                      isSelected && 'bg-nle-blue/25 hover:bg-nle-blue/30 text-foreground shadow-[inset_2px_0_0_var(--nle-blue)]',
                    )}
                  >
                    <div className="flex w-full items-center gap-1.5">
                      <FilmIcon className="text-sky-400 size-3.5 shrink-0" aria-hidden="true" />
                      <span className={cn('size-2 shrink-0 rounded-[2px]', swatch)} aria-hidden="true" />
                      <span className=" truncate font-medium">{comp.id}</span>
                    </div>
                    <span className="text-muted-foreground pl-7 font-mono text-[10px]">
                      {comp.width}x{comp.height} · {comp.fps} fps · {comp.durationInFrames} f
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </ScrollArea>

      {/* Footer */}
      <div className="bg-secondary/40 text-muted-foreground flex h-6 shrink-0 items-center justify-between border-t px-2.5 font-mono text-[10px]">
        <div className="flex items-center gap-2">
          <FolderIcon className="size-3 opacity-70" aria-hidden="true" />
          <span>8 bpc</span>
        </div>
        <div className="flex items-center gap-1 text-[10px] opacity-80" title="Compositions are defined in code">
          <LockIcon className="size-2.5" aria-hidden="true" />
          <span>Read-only bin</span>
        </div>
      </div>
    </div>
  );
}
