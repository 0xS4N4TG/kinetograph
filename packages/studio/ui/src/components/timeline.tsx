import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';

import type { CompositionInfo, TimelineData } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { useElementSize } from '@/lib/use-element-size';
import type { Player, PlayerState } from '@/lib/player';
import { cn } from '@/lib/utils';
import { indent, layerRows, sequenceRows } from '@/lib/tree';

/** Width of the sticky label column, px. */
const LABEL_WIDTH = 208;
const MIN_TICK_SPACING = 56;
const STEPS = [1, 2, 5, 10, 15, 30, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

interface TimelineProps {
  comp: CompositionInfo | null;
  data: TimelineData | null;
  state: PlayerState;
  player: Player;
  selectedLayer: string | null;
  onSelectLayer(id: string): void;
}

/**
 * The timeline: a ruler in frames you drag to scrub, one row per Sequence nested under its parent, then a row per
 * layer, and the playhead across them. A row's click selects its layer.
 */
export function Timeline({ comp, data, state, player, selectedLayer, onSelectLayer }: TimelineProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const size = useElementSize(scrollerRef);
  const [zoom, setZoom] = useState(1);

  const duration = comp?.durationInFrames ?? 0;
  const fit = Math.max(0.1, ((size.width || 900) - LABEL_WIDTH - 16) / Math.max(1, duration));
  const pxPerFrame = fit * zoom;
  const laneWidth = duration * pxPerFrame;

  const sequences = useMemo(() => sequenceRows(data?.sequences ?? []), [data]);
  const layers = useMemo(() => layerRows(data?.layers ?? []), [data]);

  const tickStep = STEPS.find((step) => step * pxPerFrame >= MIN_TICK_SPACING) ?? STEPS[STEPS.length - 1]!;
  const ticks: number[] = [];
  for (let f = 0; f < duration; f += tickStep) ticks.push(f);

  // Keep the playhead in view while it moves.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || zoom === 1) return;
    const x = LABEL_WIDTH + state.frame * pxPerFrame;
    if (x < scroller.scrollLeft + LABEL_WIDTH || x > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = Math.max(0, x - scroller.clientWidth / 2);
    }
  }, [state.frame, pxPerFrame, zoom]);

  const seekTo = (event: PointerEvent<HTMLDivElement>) => {
    const rect = rulerRef.current?.getBoundingClientRect();
    if (!rect || duration === 0) return;
    const span = rect.width || laneWidth;
    player.seek(((event.clientX - rect.left) / span) * duration);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (duration === 0) return;
    dragging.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    player.beginScrub();
    seekTo(event);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) seekTo(event);
  };
  const onPointerUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    player.endScrub();
  };

  return (
    <div data-testid="timeline" className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b px-3">
        <span className="text-sm font-medium">Timeline</span>
        <div className="ml-auto flex w-56 items-center gap-2">
          <span className="text-muted-foreground text-xs">Zoom</span>
          <Slider
            aria-label="Zoom"
            min={1}
            max={24}
            step={0.5}
            value={[zoom]}
            onValueChange={([value]) => setZoom(value ?? 1)}
          />
        </div>
      </div>
      <div ref={scrollerRef} className="relative min-h-0 flex-1 overflow-auto">
        {comp === null ? (
          <p className="text-muted-foreground p-4 text-sm">No composition selected.</p>
        ) : (
          <div className="relative min-w-max" style={{ width: LABEL_WIDTH + laneWidth + 16 }}>
            {/* ruler */}
            <div className="bg-background sticky top-0 z-20 flex h-7 border-b">
              <div className="bg-background text-muted-foreground sticky left-0 z-40 flex shrink-0 items-center border-r px-2 text-xs" style={{ width: LABEL_WIDTH }}>
                Frames
              </div>
              <div
                ref={rulerRef}
                data-testid="timeline-ruler"
                className="relative h-full cursor-col-resize touch-none select-none"
                style={{ width: laneWidth }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                {ticks.map((f) => (
                  <div key={f} className="absolute inset-y-0 border-l" style={{ left: f * pxPerFrame }}>
                    <span className="text-muted-foreground absolute top-1 left-1 font-mono text-[10px]">{f}</span>
                  </div>
                ))}
              </div>
            </div>

            <SectionLabel>Sequences</SectionLabel>
            {sequences.length === 0 && <EmptyRow>No Sequences</EmptyRow>}
            {sequences.map((row) => (
              <Row
                key={row.key}
                data-testid="sequence-row"
                label={row.label}
                title={`${row.label}: frames ${row.from}..${row.end - 1}`}
                depth={row.depth}
                selected={row.layer !== null && row.layer === selectedLayer}
                onSelect={row.layer !== null ? () => onSelectLayer(row.layer!) : undefined}
                laneWidth={laneWidth}
              >
                <Bar from={row.from} to={row.end} pxPerFrame={pxPerFrame} className="bg-secondary border">
                  {row.label}
                </Bar>
              </Row>
            ))}

            <SectionLabel>Layers</SectionLabel>
            {layers.length === 0 && <EmptyRow>No layers</EmptyRow>}
            {layers.map((row) => (
              <Row
                key={row.id}
                data-testid="layer-row"
                label={row.id}
                badge={row.type}
                title={`${row.id} (${row.type})`}
                depth={row.depth}
                selected={row.id === selectedLayer}
                onSelect={() => onSelectLayer(row.id)}
                laneWidth={laneWidth}
              >
                {row.ranges.map(([first, last]) => (
                  <Bar key={first} from={first} to={last + 1} pxPerFrame={pxPerFrame} className="bg-primary/50" />
                ))}
              </Row>
            ))}

            {/* playhead */}
            <div
              data-testid="playhead"
              className="pointer-events-none absolute inset-y-0 z-30 w-px bg-sky-400"
              style={{ left: LABEL_WIDTH + state.frame * pxPerFrame }}
            >
              <div className="absolute top-0 -left-1 size-2.5 rounded-b-sm bg-sky-400" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="bg-muted/40 text-muted-foreground sticky left-0 flex h-5 items-center border-b px-2 text-[10px] font-medium tracking-wide uppercase">
      {children}
    </div>
  );
}

function EmptyRow({ children }: { children: string }) {
  return <div className="text-muted-foreground sticky left-0 h-7 px-2 py-1.5 text-xs">{children}</div>;
}

interface RowProps {
  label: string;
  badge?: string;
  title: string;
  depth: number;
  selected: boolean;
  onSelect: (() => void) | undefined;
  laneWidth: number;
  children: ReactNode;
  'data-testid': string;
}

function Row({ label, badge, title, depth, selected, onSelect, laneWidth, children, ...rest }: RowProps) {
  return (
    <div
      {...rest}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-pressed={onSelect ? selected : undefined}
      title={title}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (onSelect && event.key === 'Enter') onSelect();
      }}
      className={cn('group flex h-7 border-b text-xs', onSelect && 'cursor-pointer', selected && 'bg-accent/60')}
    >
      <div
        className={cn(
          'sticky left-0 z-40 flex shrink-0 items-center gap-2 border-r pr-2',
          selected ? 'bg-accent' : 'bg-background',
          indent(depth),
        )}
        style={{ width: LABEL_WIDTH }}
      >
        <span className="truncate">{label}</span>
        {badge && (
          <Badge variant="outline" className="ml-auto px-1 py-0 text-[10px]">
            {badge}
          </Badge>
        )}
      </div>
      <div className="relative h-full" style={{ width: laneWidth }}>
        {children}
      </div>
    </div>
  );
}

function Bar({
  from,
  to,
  pxPerFrame,
  className,
  children,
}: {
  from: number;
  to: number;
  pxPerFrame: number;
  className: string;
  children?: string;
}) {
  return (
    <div
      className={cn('absolute inset-y-1 overflow-hidden rounded-sm px-1 text-[10px] leading-5 whitespace-nowrap', className)}
      style={{ left: from * pxPerFrame, width: Math.max(2, (to - from) * pxPerFrame) }}
    >
      {children}
    </div>
  );
}
