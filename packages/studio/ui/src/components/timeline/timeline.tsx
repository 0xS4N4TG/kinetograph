import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { EyeIcon, LockIcon, MenuIcon, MountainIcon, SearchIcon, SlidersHorizontalIcon } from 'lucide-react';

import type { CompositionInfo, TimelineData } from '@/api';
import { PanelHeader } from '@/components/shell/panel-header';
import { Bar, EmptyRow, LABEL_WIDTH, Row, SectionLabel } from '@/components/timeline/timeline-row';
import { Slider } from '@/components/ui/slider';
import { formatTimecode } from '@/lib/format';
import { layerColors } from '@/lib/layer-colors';
import { useElementSize } from '@/lib/use-element-size';
import type { Player, PlayerState } from '@/lib/player';
import { cn } from '@/lib/utils';
import { layerRows, sequenceRows } from '@/lib/tree';

const MIN_TICK_SPACING = 64;
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
  const [filter, setFilter] = useState('');

  const duration = comp?.durationInFrames ?? 0;
  const fps = comp?.fps ?? 30;
  const fit = Math.max(0.1, ((size.width || 900) - LABEL_WIDTH - 16) / Math.max(1, duration));
  const pxPerFrame = fit * zoom;
  const laneWidth = duration * pxPerFrame;

  const allSequences = useMemo(() => sequenceRows(data?.sequences ?? []), [data]);
  const allLayers = useMemo(() => layerRows(data?.layers ?? []), [data]);

  const q = filter.trim().toLowerCase();
  const sequences = useMemo(
    () => (q ? allSequences.filter((r) => r.label.toLowerCase().includes(q)) : allSequences),
    [allSequences, q],
  );
  const layers = useMemo(
    () => (q ? allLayers.filter((r) => r.id.toLowerCase().includes(q) || r.type.toLowerCase().includes(q)) : allLayers),
    [allLayers, q],
  );

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
    <div data-testid="timeline" className="bg-card flex h-full flex-col select-none">
      <PanelHeader
        className="h-8 justify-normal gap-3 px-3 text-xs"
        title={
          <div className="border-primary text-foreground flex h-full items-center gap-1.5 border-b-2 px-1 text-[11px] font-medium">
            <span>{comp ? comp.id : 'Timeline'}</span>
            <MenuIcon className="text-muted-foreground size-3" aria-hidden="true" />
          </div>
        }
      >
        {/* Timecode and frame readout */}
        <div className="flex items-baseline gap-2 border-l border-white/10 pl-3 font-mono">
          <span className="text-sm font-bold tracking-wider text-nle-value tabular-nums">
            {formatTimecode(state.frame, fps)}
          </span>
          <span className="text-muted-foreground text-[10px] tabular-nums">
            {String(state.frame).padStart(5, '0')} ({fps} fps)
          </span>
        </div>

        <span className="text-muted-foreground bg-background/60 rounded-xs border border-white/10 px-1.5 py-0.5 font-mono text-[10px]">
          {duration} f
        </span>

        {/* Search layers input */}
        <div className="bg-background/70 border-border ml-2 hidden h-5 w-44 items-center gap-1.5 rounded-xs border px-2 md:flex">
          <SearchIcon className="text-muted-foreground size-3 shrink-0" aria-hidden="true" />
          <input
            type="search"
            placeholder="Search timeline"
            aria-label="Search timeline"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="placeholder:text-muted-foreground/70 w-full bg-transparent text-[11px] outline-none"
          />
        </div>

        <div className="ml-auto flex w-56 items-center gap-2">
          <MountainIcon className="text-muted-foreground size-3 shrink-0" aria-hidden="true" />
          <span className="text-muted-foreground sr-only text-xs">Zoom</span>
          <Slider
            aria-label="Zoom"
            min={1}
            max={24}
            step={0.5}
            value={[zoom]}
            onValueChange={([value]) => setZoom(value ?? 1)}
          />
          <MountainIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
        </div>
      </PanelHeader>

      <div ref={scrollerRef} className="relative min-h-0 flex-1 overflow-auto bg-[#141417]">
        {comp === null ? (
          <p className="text-muted-foreground p-6 text-center text-xs">No composition selected.</p>
        ) : (
          <div className="relative min-w-max" style={{ width: LABEL_WIDTH + laneWidth + 16 }}>
            {/* Sticky column header and frame ruler */}
            <div className="bg-card/95 sticky top-0 z-20 flex h-9 border-b backdrop-blur">
              <div
                className="bg-card text-muted-foreground sticky left-0 z-40 flex shrink-0 items-center gap-2 border-r px-2.5 text-[10px] font-medium tracking-wider"
                style={{ width: LABEL_WIDTH }}
              >
                <EyeIcon className="size-3 opacity-60" aria-hidden="true" />
                <LockIcon className="size-3 opacity-60" aria-hidden="true" />
                <span className="w-4 text-center opacity-60">#</span>
                <span>Layer Name</span>
                <span className="ml-auto opacity-60">Type</span>
              </div>
              <div
                ref={rulerRef}
                data-testid="timeline-ruler"
                className="relative h-full cursor-col-resize touch-none select-none bg-[#18181c]"
                style={{ width: laneWidth }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                {/* Work area bar and cache line */}
                <div className="absolute inset-x-0 top-0 h-2.5 border-b border-white/10 bg-white/[0.04]" aria-hidden="true">
                  <div className="h-full w-full border-x-2 border-nle-blue bg-white/[0.05]" />
                  <div className="absolute inset-x-0 bottom-0 h-[2px] bg-emerald-500/60" />
                </div>

                {ticks.map((f) => (
                  <div key={f} className="absolute bottom-0 h-2.5 border-l border-white/25" style={{ left: f * pxPerFrame }}>
                    <span className="text-muted-foreground absolute -top-3.5 left-1 font-mono text-[9px] tabular-nums">
                      {f}f
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <SectionLabel>Sequences</SectionLabel>
            {sequences.length === 0 && <EmptyRow>No Sequences</EmptyRow>}
            {sequences.map((row, index) => {
              const colors = layerColors('sequence');
              return (
                <Row
                  key={row.key}
                  data-testid="sequence-row"
                  index={index + 1}
                  swatch={colors.swatch}
                  label={row.label}
                  title={`${row.label}: frames ${row.from}..${row.end - 1}`}
                  depth={row.depth}
                  selected={row.layer !== null && row.layer === selectedLayer}
                  onSelect={row.layer !== null ? () => onSelectLayer(row.layer!) : undefined}
                  laneWidth={laneWidth}
                >
                  <Bar from={row.from} to={row.end} pxPerFrame={pxPerFrame} className={cn('border', colors.bar)}>
                    {row.label}
                  </Bar>
                </Row>
              );
            })}

            <SectionLabel>Layers</SectionLabel>
            {layers.length === 0 && <EmptyRow>No layers</EmptyRow>}
            {layers.map((row, index) => {
              const colors = layerColors(row.type);
              return (
                <Row
                  key={row.id}
                  data-testid="layer-row"
                  index={index + 1}
                  swatch={colors.swatch}
                  label={row.id}
                  badge={row.type}
                  title={`${row.id} (${row.type})`}
                  depth={row.depth}
                  selected={row.id === selectedLayer}
                  onSelect={() => onSelectLayer(row.id)}
                  laneWidth={laneWidth}
                >
                  {row.ranges.map(([first, last]) => (
                    <Bar key={first} from={first} to={last + 1} pxPerFrame={pxPerFrame} className={cn('border shadow-xs', colors.bar)}>
                      {row.id}
                    </Bar>
                  ))}
                </Row>
              );
            })}

            {/* Playhead */}
            <div
              data-testid="playhead"
              className="pointer-events-none absolute inset-y-0 z-30 w-px bg-nle-blue shadow-[0_0_8px_rgba(38,128,235,0.8)]"
              style={{ left: LABEL_WIDTH + state.frame * pxPerFrame }}
            >
              <div className="absolute top-0 -left-[6px] h-[13px] w-[13px] bg-nle-blue [clip-path:polygon(0_0,100%_0,100%_58%,50%_100%,0_58%)]" />
            </div>
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="bg-secondary/50 text-muted-foreground flex h-6 shrink-0 items-center justify-between border-t px-3 font-mono text-[10px]">
        <div className="flex items-center gap-2">
          <SlidersHorizontalIcon className="size-3 opacity-70" aria-hidden="true" />
          <span>Toggle Switches / Modes</span>
        </div>
        <div className="flex items-center gap-1.5 opacity-80">
          <LockIcon className="size-2.5 text-amber-400/80" aria-hidden="true" />
          <span>Read-Only Timeline · Code-Driven</span>
        </div>
        <span>Zoom {zoom.toFixed(1)}x</span>
      </div>
    </div>
  );
}
