import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { SearchIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-react';

import type { CompositionInfo } from '@/api';
import { PanelHeader } from '@/components/shell/panel-header';
import { Bar, EmptyRow, LABEL_WIDTH, Row, SectionLabel, TimelineNotice } from '@/components/timeline/timeline-row';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { formatTimecode } from '@/lib/format';
import { layerColors } from '@/lib/layer-colors';
import type { Player, PlayerState } from '@/lib/player';
import type { TimelineStatus } from '@/studio';
import { cn } from '@/lib/utils';
import { layerRows, sequenceRows } from '@/lib/tree';
import { useElementSize } from '@/lib/use-element-size';

const MIN_TICK_SPACING = 64;
const STEPS = [1, 2, 5, 10, 15, 30, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const MIN_ZOOM = 1;
const MAX_ZOOM = 24;
const ZOOM_FACTOR = 1.25;

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

interface TimelineProps {
  comp: CompositionInfo | null;
  status: TimelineStatus;
  state: PlayerState;
  player: Player;
  /** The layers picked anywhere in the studio. */
  selectedLayers: string[];
  onSelectLayer(id: string): void;
}

/**
 * The timeline: a ruler in frames, one row per Sequence nested under its parent, then a row per layer, and the playhead
 * across them. Pressing and dragging in the ruler or a lane scrubs; a row's click selects its layer.
 */
export function Timeline({ comp, status, state, player, selectedLayers, onSelectLayer }: TimelineProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  /** A Ctrl or Cmd wheel zoom keeps the frame under the pointer where it was: `x` px from the scroller's left edge. */
  const anchor = useRef<{ frame: number; x: number } | null>(null);
  const size = useElementSize(scrollerRef);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [filter, setFilter] = useState('');

  const duration = comp?.durationInFrames ?? 0;
  const fps = comp?.fps ?? 30;
  const fit = Math.max(0.1, ((size.width || 900) - LABEL_WIDTH - 16) / Math.max(1, duration));
  const pxPerFrame = fit * zoom;
  const laneWidth = duration * pxPerFrame;

  const data = status.state === 'ready' ? status.data : null;
  const allSequences = useMemo(() => sequenceRows(data?.sequences ?? []), [data]);
  const allLayers = useMemo(() => layerRows(data?.layers ?? []), [data]);

  // Row numbers count the whole list, so a row keeps its number while the filter narrows it.
  const q = filter.trim().toLowerCase();
  const sequences = useMemo(
    () =>
      allSequences
        .map((row, index) => ({ row, number: index + 1 }))
        .filter(({ row }) => !q || row.label.toLowerCase().includes(q)),
    [allSequences, q],
  );
  const layers = useMemo(
    () =>
      allLayers
        .map((row, index) => ({ row, number: index + 1 }))
        .filter(({ row }) => !q || row.id.toLowerCase().includes(q) || row.type.toLowerCase().includes(q)),
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

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const kept = anchor.current;
    if (!scroller || !kept) return;
    anchor.current = null;
    scroller.scrollLeft = Math.max(0, LABEL_WIDTH + kept.frame * pxPerFrame - kept.x);
  }, [pxPerFrame]);

  // A native listener, because React's wheel listeners are passive and cannot cancel the page's own zoom.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const next = clampZoom(event.deltaY < 0 ? zoom * ZOOM_FACTOR : zoom / ZOOM_FACTOR);
      if (next === zoom) return;
      const x = event.clientX - scroller.getBoundingClientRect().left;
      anchor.current = { frame: (scroller.scrollLeft + x - LABEL_WIDTH) / pxPerFrame, x };
      setZoom(next);
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', onWheel);
  }, [zoom, pxPerFrame]);

  const seekTo = (clientX: number) => {
    const rect = rulerRef.current?.getBoundingClientRect();
    if (!rect || duration === 0) return;
    const span = rect.width || laneWidth;
    player.seek(((clientX - rect.left) / span) * duration);
  };
  // The ruler and every lane share one horizontal scale, so a press in any lane seeks the same way.
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const lane = (event.target as Element).closest<HTMLElement>('[data-lane]');
    if (!lane || event.button > 0 || duration === 0) return;
    dragging.current = true;
    lane.setPointerCapture?.(event.pointerId);
    player.beginScrub();
    seekTo(event.clientX);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) seekTo(event.clientX);
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
          <div className="border-primary text-foreground flex h-full items-center border-b-2 px-1 text-[11px] font-medium">
            <span>{comp ? comp.id : 'Timeline'}</span>
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

        <div className="ml-auto flex w-64 items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom out timeline"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => setZoom((z) => clampZoom(z / ZOOM_FACTOR))}
            className="size-6 shrink-0"
          >
            <ZoomOutIcon className="size-3.5" />
          </Button>
          <Slider
            aria-label="Zoom"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.5}
            value={[zoom]}
            onValueChange={([value]) => setZoom(clampZoom(value ?? MIN_ZOOM))}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom in timeline"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => setZoom((z) => clampZoom(z * ZOOM_FACTOR))}
            className="size-6 shrink-0"
          >
            <ZoomInIcon className="size-3.5" />
          </Button>
        </div>
      </PanelHeader>

      <div ref={scrollerRef} className="relative min-h-0 flex-1 overflow-auto bg-[#141417]">
        {comp === null ? (
          <p className="text-muted-foreground p-6 text-center text-xs">No composition selected.</p>
        ) : (
          <div
            className="relative min-w-max"
            style={{ width: LABEL_WIDTH + laneWidth + 16 }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {/* Sticky column header and frame ruler */}
            <div className="bg-card/95 sticky top-0 z-20 flex h-9 border-b backdrop-blur">
              <div
                className="bg-card text-muted-foreground sticky left-0 z-40 flex shrink-0 items-center gap-2 border-r px-2.5 text-[10px] font-medium tracking-wider"
                style={{ width: LABEL_WIDTH }}
              >
                <span className="w-4 text-center opacity-60">#</span>
                <span>Layer Name</span>
                <span className="ml-auto opacity-60">Type</span>
              </div>
              <div
                ref={rulerRef}
                data-lane
                data-testid="timeline-ruler"
                className="relative h-full cursor-pointer touch-none select-none bg-[#18181c]"
                style={{ width: laneWidth }}
              >
                {ticks.map((f) => (
                  <div key={f} className="absolute bottom-0 h-2.5 border-l border-white/25" style={{ left: f * pxPerFrame }}>
                    <span className="text-muted-foreground absolute -top-3.5 left-1 font-mono text-[9px] tabular-nums">
                      {f}f
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {status.state === 'loading' && (
              <TimelineNotice testId="timeline-loading" progress={status.total > 0 ? status.done / status.total : null}>
                {status.total > 0
                  ? `Reading the timeline: frame ${status.done} of ${status.total}`
                  : 'Reading the timeline...'}
              </TimelineNotice>
            )}
            {status.state === 'error' && (
              <TimelineNotice testId="timeline-error" error>
                {`Could not read the timeline: ${status.error.message}`}
              </TimelineNotice>
            )}
            {status.state === 'ready' && (
              <>
                <SectionLabel>Sequences</SectionLabel>
                {sequences.length === 0 && <EmptyRow>No Sequences</EmptyRow>}
                {sequences.map(({ row, number }) => {
                  const colors = layerColors('sequence');
                  return (
                    <Row
                      key={row.key}
                      data-testid="sequence-row"
                      index={number}
                      swatch={colors.swatch}
                      label={row.label}
                      title={`${row.label}: frames ${row.from}..${row.end - 1}`}
                      depth={row.depth}
                      selected={row.layer !== null && selectedLayers.includes(row.layer)}
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
                {layers.map(({ row, number }) => {
                  const colors = layerColors(row.type);
                  return (
                    <Row
                      key={row.id}
                      data-testid="layer-row"
                      index={number}
                      swatch={colors.swatch}
                      label={row.id}
                      badge={row.type}
                      title={`${row.id} (${row.type})`}
                      depth={row.depth}
                      selected={selectedLayers.includes(row.id)}
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
              </>
            )}

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
    </div>
  );
}
