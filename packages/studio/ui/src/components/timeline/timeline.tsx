import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { SearchIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-react';

import type { CompositionInfo } from '@/api';
import { PanelHeader } from '@/components/shell/panel-header';
import { Bar, EmptyRow, LABEL_WIDTH, ROW_HEIGHT, Row, TimelineNotice } from '@/components/timeline/timeline-row';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { formatTimecode } from '@/lib/format';
import { layerColors } from '@/lib/layer-colors';
import { fullSource, secondLine } from '@/lib/names';
import type { Player, PlayerState } from '@/lib/player';
import type { TimelineStatus } from '@/studio';
import { cn } from '@/lib/utils';
import { buildTimeline, seekTarget, visibleRows, type TimelineNode } from '@/lib/timeline-model';
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
  /** A row was clicked: the layers it stands for (all the pieces of a folded row). */
  onSelectLayers(ids: string[]): void;
}

const DETAILS_KEY = 'kinetograph.studio.timeline.details';
function readDetails(): boolean {
  try {
    return window.localStorage.getItem(DETAILS_KEY) === '1';
  } catch {
    return false;
  }
}
function writeDetails(on: boolean): void {
  try {
    window.localStorage.setItem(DETAILS_KEY, on ? '1' : '0');
  } catch {
    // No storage: the choice lasts until reload.
  }
}

/** The hover text of a row or bar: name, component and where it is written. */
function nodeTitle(node: TimelineNode): string {
  let head = node.label;
  if (node.count > 1) head += ` ×${node.count}`;
  if (node.component && node.component !== node.label) head += ` · ${node.component}`;
  if (node.source) head += ` · ${fullSource(node.source)}`;
  const first = node.bars[0]?.[0];
  const last = node.bars[node.bars.length - 1]?.[1];
  return first !== undefined && last !== undefined ? `${head}\nframes ${first}..${last}` : head;
}

/**
 * The timeline: a ruler in frames, one row per Sequence nested under its parent, then a row per layer, and the playhead
 * across them. Pressing and dragging in the ruler or a lane scrubs; a row's click selects its layer.
 */
export function Timeline({ comp, status, state, player, selectedLayers, onSelectLayers }: TimelineProps) {
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
  // Grouped once per payload: the tree does not depend on what is open or searched.
  const model = useMemo(() => (data ? buildTimeline(data.sequences, data.layers, data.fps) : null), [data]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [details, setDetails] = useState(readDetails);
  /** The row last clicked: a Sequence's group id is a path other Sequences share, so rows are told apart by this. */
  const [clicked, setClicked] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const q = filter.trim().toLowerCase();
  const rows = useMemo(() => (model ? visibleRows(model.roots, expanded, q, details) : []), [model, expanded, q, details]);
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleDetails = () =>
    setDetails((on) => {
      writeDetails(!on);
      return !on;
    });
  /** A click on a row's name: the playhead goes to where the item first shows (unless it is on it already). */
  const pick = (node: TimelineNode, seek: boolean) => {
    if (seek) {
      const target = seekTarget(node, state.frame);
      if (target !== null) player.seek(target);
    }
    setClicked(node.id);
    onSelectLayers(node.layerIds);
  };

  // Only the rows in (or near) view are drawn; before the scroller is measured, all of them.
  const viewport = size.height;
  const firstRow = viewport > 0 ? Math.max(0, Math.floor(Math.max(0, scrollTop - 36) / ROW_HEIGHT) - 8) : 0;
  const lastRow = viewport > 0 ? Math.min(rows.length, firstRow + Math.ceil(viewport / ROW_HEIGHT) + 16) : rows.length;

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

        <Button
          variant={details ? 'secondary' : 'ghost'}
          size="sm"
          aria-pressed={details}
          onClick={toggleDetails}
          className="h-6 px-2 text-[11px]"
        >
          Show details
        </Button>

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

      <div
        ref={scrollerRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        className="relative min-h-0 flex-1 overflow-auto bg-[#141417]"
      >
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
                <span>Name</span>
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
            {status.state === 'ready' && rows.length === 0 && <EmptyRow>{q ? 'Nothing matches the search.' : 'No Sequences'}</EmptyRow>}
            {status.state === 'ready' && rows.length > 0 && (
              <>
                <div aria-hidden="true" style={{ height: firstRow * ROW_HEIGHT }} />
                {rows.slice(firstRow, lastRow).map(({ node, depth, expandable, expanded: open }) => {
                  const isSequence = node.kind === 'sequence';
                  const colors = layerColors(isSequence ? 'sequence' : node.type ?? 'group');
                  const current = node.bars.some(([a, b]) => state.frame >= a && state.frame <= b);
                  const selected =
                    selectedLayers.length > 0 &&
                    (clicked === node.id || (!isSequence && current && node.layerIds.some((id) => selectedLayers.includes(id))));
                  const title = nodeTitle(node);
                  return (
                    <Row
                      key={node.id}
                      data-testid={isSequence ? 'sequence-row' : 'component-row'}
                      swatch={colors.swatch}
                      label={node.label}
                      count={node.count}
                      {...(details && secondLine(node) ? { detail: secondLine(node)! } : {})}
                      {...(details && node.type ? { badge: node.type } : {})}
                      title={title}
                      depth={depth}
                      expanded={expandable ? open : undefined}
                      onToggle={() => toggle(node.id)}
                      selected={selected}
                      current={current}
                      onSelect={() => pick(node, true)}
                      laneWidth={laneWidth}
                    >
                      {node.bars.map(([a, b]) => (
                        <Bar
                          key={a}
                          from={a}
                          to={b + 1}
                          pxPerFrame={pxPerFrame}
                          title={title}
                          onClick={() => pick(node, false)}
                          className={cn(
                            'border',
                            colors.bar,
                            !isSequence && 'opacity-80',
                            current && 'opacity-100 ring-2 ring-white/60',
                          )}
                        >
                          {node.count > 1 ? `${node.label} ×${node.count}` : node.label}
                        </Bar>
                      ))}
                    </Row>
                  );
                })}
                <div aria-hidden="true" style={{ height: (rows.length - lastRow) * ROW_HEIGHT }} />
              </>
            )}

            {/* Playhead */}
            <div
              data-testid="playhead"
              className="pointer-events-none absolute inset-y-0 z-30 w-0.5 bg-nle-blue shadow-[0_0_10px_rgba(38,128,235,0.9)]"
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
