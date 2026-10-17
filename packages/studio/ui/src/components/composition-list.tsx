import type { CompositionInfo } from '@/api';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

interface CompositionListProps {
  compositions: CompositionInfo[];
  selected: string | null;
  onSelect(id: string): void;
}

export function CompositionList({ compositions, selected, onSelect }: CompositionListProps) {
  return (
    <div className="flex h-full flex-col" data-testid="composition-list">
      <div className="flex h-9 shrink-0 items-center border-b px-3 text-sm font-medium">Compositions</div>
      <ScrollArea className="min-h-0 flex-1">
        {compositions.length === 0 ? (
          <p className="text-muted-foreground p-3 text-sm">No compositions.</p>
        ) : (
          <ul className="flex flex-col gap-1 p-2">
            {compositions.map((comp) => (
              <li key={comp.id}>
                <button
                  type="button"
                  aria-pressed={comp.id === selected}
                  onClick={() => onSelect(comp.id)}
                  className={cn(
                    'hover:bg-white/5 focus-visible:ring-ring/50 flex w-full flex-col items-start gap-0.5 rounded-lg border border-transparent px-3 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-[3px]',
                    comp.id === selected && 'bg-primary/10 border-primary/40 text-foreground',
                  )}
                >
                  <span className="w-full truncate font-medium">{comp.id}</span>
                  <span className="text-muted-foreground font-mono text-xs">
                    {comp.width}x{comp.height} · {comp.fps} fps · {comp.durationInFrames} f
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}
