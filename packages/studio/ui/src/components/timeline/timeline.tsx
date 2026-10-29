import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { ChevronUpIcon, SearchIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-react';

import type { CompositionInfo } from '@/api';
import { Bar, EmptyRow, LABEL_WIDTH, ROW_HEIGHT, Row, THUMB_HEIGHT, TimelineNotice } from '@/components/timeline/timeline-row';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { Slider } from '@/components/ui/slider';
import { formatTimecode } from '@/lib/format';
import { layerColors } from '@/lib/layer-colors';
import { fullSource, secondLine } from '@/lib/names';
import type { Player } from '@/lib/player';
import { useFrame, usePlayerState } from '@/lib/player-hooks';
import type { TimelineStatus } from '@/studio';
import { cn } from '@/lib/utils';
import { buildTimeline, seekTarget, visibleRows, type TimelineNode } from '@/lib/timeline-model';
import { useElementSize } from '@/lib/use-element-size';

const MIN_TICK_SPACING = 64;
const STEPS = [1, 2, 5, 10, 15, 30, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const MIN_ZOOM = 1;
const MAX_ZOOM = 24;
const ZOOM_FACTOR = 1.25;
/** The space after the last frame, px. */
const GUTTER = 16;

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

interface TimelineProps {
  comp: CompositionInfo | null;
  status: TimelineStatus;
  player: Player;
  /** The layers picked anywhere in the studio. */
  selectedLayers: string[];
  /** A row was clicked: the layers it stands for (all the pieces of a folded row). */
  onSelectLayers(ids: string[]): void;
  /** The address of a small picture of a frame, for the clips; none when left out. */
  thumbnailUrl?: (frame: number, height: number) => string | null;
  /** Slim scrubber (false) or the layer rows. */
  expanded: boolean;
  onExpandedChange(expanded: boolean): void;
  /** The raw pieces under each instance, and a second line per row. */
  details: boolean;
  onDetailsChange(details: boolean): void;
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

/** The playhead across the lanes; it alone follows the frame, and keeps itself in view while zoomed. */
const Playhead = memo(function Playhead({
  player,
  left,
  pxPerFrame,
  scrollerRef,
  zoom,
  labelWidth,
}: {
  player: Player;
  left: number;
  pxPerFrame: number;
  scrollerRef: RefObject<HTMLDivElement | null>;
  zoom: number;
  labelWidth: number;
}) {
  const frame = useFrame(player);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || zoom === 1) return;
    const x = left + frame * pxPerFrame;
    if (x < scroller.scrollLeft + labelWidth || x > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = Math.max(0, x - scroller.clientWidth / 2);
    }
  }, [frame, pxPerFrame, zoom, left, labelWidth, scrollerRef]);
  return (
    <div
      data-testid="playhead"
      className="bg-playhead pointer-events-none absolute inset-y-0 z-30 w-px"
      style={{ left: left + frame * pxPerFrame }}
    >
      <div className="bg-playhead absolute top-1 -left-[5px] size-[11px] rounded-full ring-2 ring-[var(--card)]" />
    </div>
  );
});

/** The height of the film strip, px. */
const STRIP_HEIGHT = 56;

/**
 * The composition frame by frame: small pictures of evenly spaced frames laid along the time axis, so the timeline shows
 * what is on screen where. More of them as the lane gets wider; the server draws each as it is asked for.
 */
const Filmstrip = memo(function Filmstrip({ comp, laneWidth, thumbnailUrl }: { comp: CompositionInfo; laneWidth: number; thumbnailUrl: TimelineProps['thumbnailUrl'] }) {
  const tileWidth = Math.max(24, Math.round(STRIP_HEIGHT * (comp.width / Math.max(1, comp.height))));
  const count = Math.max(1, Math.min(80, Math.round(laneWidth / tileWidth)));
  const duration = Math.max(1, comp.durationInFrames);
  return (
    <div data-testid="filmstrip" className="bg-muted/60 flex overflow-hidden rounded-xl" style={{ width: laneWidth, height: STRIP_HEIGHT }} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => {
        const frame = Math.min(duration - 1, Math.floor(((i + 0.5) / count) * duration));
        const src = thumbnailUrl?.(frame, STRIP_HEIGHT * 2);
        return (
          <div key={i} className="relative h-full min-w-0 flex-1 overflow-hidden">
            {src && <img data-testid="filmstrip-frame" src={src} alt="" loading="lazy" decoding="async" draggable={false} className="size-full object-cover" onError={(event) => { event.currentTarget.style.display = 'none'; }} />}
          </div>
        );
      })}
    </div>
  );
});

/** The time and frame under the playhead, in the header. */
const FrameReadout = memo(function FrameReadout({ player, fps }: { player: Player; fps: number }) {
  const frame = useFrame(player);
  return (
    <span className="text-muted-foreground font-mono text-xs tabular-nums">
      {formatTimecode(frame, fps)} · {frame}
    </span>
  );
});

interface RowItemProps {
  node: TimelineNode;
  depth: number;
  expandable: boolean;
  open: boolean;
  details: boolean;
  selectedLayers: string[];
  clicked: string | null;
  pxPerFrame: number;
  laneWidth: number;
  player: Player;
  thumbnailUrl: TimelineProps['thumbnailUrl'];
  onToggle(id: string): void;
  onPick(node: TimelineNode, seek: boolean): void;
}

/** One row. It watches whether the playhead is inside its bars, so only rows whose answer flips re-render with the frame. */
const RowItem = memo(function RowItem({ node, depth, expandable, open, details, selectedLayers, clicked, pxPerFrame, laneWidth, player, thumbnailUrl, onToggle, onPick }: RowItemProps) {
  const current = usePlayerState(player, (s) => node.bars.some(([a, b]) => s.frame >= a && s.frame <= b));
  const isSequence = node.kind === 'sequence';
  const colors = layerColors(isSequence ? 'sequence' : (node.type ?? 'group'));
  const selected =
    selectedLayers.length > 0 && (clicked === node.id || (!isSequence && current && node.layerIds.some((id) => selectedLayers.includes(id))));
  const title = nodeTitle(node);
  return (
    <Row
      data-testid={isSequence ? 'sequence-row' : 'component-row'}
      swatch={colors.swatch}
      label={node.label}
      count={node.count}
      {...(details && secondLine(node) ? { detail: secondLine(node)! } : {})}
      {...(details && node.type ? { badge: node.type } : {})}
      title={title}
      depth={depth}
      expanded={expandable ? open : undefined}
      onToggle={() => onToggle(node.id)}
      selected={selected}
      current={current}
      onSelect={() => onPick(node, true)}
      laneWidth={laneWidth}
    >
      {node.bars.map(([a, b]) => (
        <Bar
          key={a}
          from={a}
          to={b + 1}
          pxPerFrame={pxPerFrame}
          title={title}
          onClick={() => onPick(node, false)}
          thumbnail={thumbnailUrl?.(a, THUMB_HEIGHT * 2)}
          className={cn(colors.bar, !isSequence && 'opacity-90', current && 'ring-foreground/50 opacity-100 ring-2')}
        >
          {node.count > 1 ? `${node.label} ×${node.count}` : node.label}
        </Bar>
      ))}
    </Row>
  );
});

/**
 * The timeline. Slim by default: a ruler, the Sequences as one strip with a marker where each starts, and the playhead.
 * Expanded: a row per Sequence nested under its parent, then a row per layer. Pressing and dragging in the ruler or a
 * lane scrubs; a row's click selects its layer. Only the rows in view are drawn.
 */
export const Timeline = memo(function Timeline({ comp, status, player, selectedLayers, onSelectLayers, thumbnailUrl, expanded: open, onExpandedChange, details, onDetailsChange }: TimelineProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  /** A Ctrl or Cmd wheel zoom keeps the frame under the pointer where it was: `x` px from the scroller's left edge. */
  const anchor = useRef<{ frame: number; x: number } | null>(null);
  const size = useElementSize(scrollerRef);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [filter, setFilter] = useState('');

  const labelWidth = open ? LABEL_WIDTH : 0;
  const lead = open ? LABEL_WIDTH : GUTTER;
  const duration = comp?.durationInFrames ?? 0;
  const fps = comp?.fps ?? 30;
  const fit = Math.max(0.1, ((size.width || 900) - lead - GUTTER) / Math.max(1, duration));
  const pxPerFrame = fit * zoom;
  const laneWidth = duration * pxPerFrame;

  const data = status.state === 'ready' ? status.data : null;
  // Grouped once per payload: the tree does not depend on what is open or searched.
  const model = useMemo(() => (data ? buildTimeline(data.sequences, data.layers, data.fps) : null), [data]);
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(() => new Set());
  /** The row last clicked: a Sequence's group id is a path other Sequences share, so rows are told apart by this. */
  const [clicked, setClicked] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const q = filter.trim().toLowerCase();
  const rows = useMemo(() => (model && open ? visibleRows(model.roots, expandedRows, q, details) : []), [model, open, expandedRows, q, details]);
  const toggle = useCallback(
    (id: string) =>
      setExpandedRows((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  /** A click on a row's name: the playhead goes to where the item first shows (unless it is on it already). */
  const pick = useCallback(
    (node: TimelineNode, seek: boolean) => {
      if (seek) {
        const target = seekTarget(node, player.getState().frame);
        if (target !== null) player.seek(target);
      }
      setClicked(node.id);
      onSelectLayers(node.layerIds);
    },
    [player, onSelectLayers],
  );

  // Only the rows in (or near) view are drawn; before the scroller is measured, all of them.
  const viewport = size.height;
  const firstRow = viewport > 0 ? Math.max(0, Math.floor(Math.max(0, scrollTop - 36) / ROW_HEIGHT) - 8) : 0;
  const lastRow = viewport > 0 ? Math.min(rows.length, firstRow + Math.ceil(viewport / ROW_HEIGHT) + 16) : rows.length;

  const tickStep = STEPS.find((step) => step * pxPerFrame >= MIN_TICK_SPACING) ?? STEPS[STEPS.length - 1]!;
  const ticks: number[] = [];
  for (let f = 0; f < duration; f += tickStep) ticks.push(f);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const kept = anchor.current;
    if (!scroller || !kept) return;
    anchor.current = null;
    scroller.scrollLeft = Math.max(0, lead + kept.frame * pxPerFrame - kept.x);
  }, [pxPerFrame, lead]);

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
      anchor.current = { frame: (scroller.scrollLeft + x - lead) / pxPerFrame, x };
      setZoom(next);
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', onWheel);
  }, [zoom, pxPerFrame, lead]);

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

  const roots = model?.roots ?? [];

  return (
    <div data-testid="timeline" className="flex h-full min-h-0 flex-col select-none">
      <div className="flex h-12 shrink-0 items-center gap-3 px-4">
        <Hint label={open ? 'Fold the timeline' : 'Show the layers'}>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-label={open ? 'Fold the timeline' : 'Expand the timeline'}
            onClick={() => onExpandedChange(!open)}
            className="-ml-2 gap-2 rounded-full px-3 font-semibold"
          >
            <ChevronUpIcon className={cn('transition-transform', open && 'rotate-180')} />
            Timeline
          </Button>
        </Hint>
        <span className="text-muted-foreground hidden text-sm sm:inline">{comp?.id ?? ''}</span>
        <FrameReadout player={player} fps={fps} />
        <span className="text-muted-foreground/80 font-mono text-xs">{duration} f</span>

        <div className="ml-auto flex items-center gap-3">
          {open && (
            <>
              <div className="bg-input/40 hidden h-8 w-48 items-center gap-2 rounded-full px-3 md:flex">
                <SearchIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
                <input
                  type="search"
                  placeholder="Search layers"
                  aria-label="Search timeline"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="placeholder:text-muted-foreground/70 w-full bg-transparent text-sm outline-none"
                />
              </div>
              <Button variant={details ? 'secondary' : 'ghost'} size="sm" aria-pressed={details} onClick={() => onDetailsChange(!details)} className="rounded-full px-3">
                Show details
              </Button>
            </>
          )}
          <div className="flex w-44 items-center gap-1.5">
            <Button variant="ghost" size="icon-sm" aria-label="Zoom out timeline" disabled={zoom <= MIN_ZOOM} onClick={() => setZoom((z) => clampZoom(z / ZOOM_FACTOR))} className="shrink-0 rounded-full">
              <ZoomOutIcon />
            </Button>
            <Slider aria-label="Zoom" min={MIN_ZOOM} max={MAX_ZOOM} step={0.5} value={[zoom]} onValueChange={(value) => setZoom(clampZoom(Array.isArray(value) ? (value[0] ?? MIN_ZOOM) : value))} />
            <Button variant="ghost" size="icon-sm" aria-label="Zoom in timeline" disabled={zoom >= MAX_ZOOM} onClick={() => setZoom((z) => clampZoom(z * ZOOM_FACTOR))} className="shrink-0 rounded-full">
              <ZoomInIcon />
            </Button>
          </div>
        </div>
      </div>

      <div ref={scrollerRef} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} className="relative min-h-0 flex-1 overflow-auto">
        {comp === null ? (
          <p className="text-muted-foreground p-6 text-center text-sm">No composition selected.</p>
        ) : (
          <div
            className="relative min-w-max"
            style={{ width: lead + laneWidth + GUTTER }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {/* The frame ruler, sticky at the top; in the slim timeline the Sequences sit under it as one strip. */}
            <div className="bg-card sticky top-0 z-20 flex h-8">
              {open && (
                <div className="bg-card text-muted-foreground sticky left-0 z-40 flex shrink-0 items-center px-4 text-xs font-medium" style={{ width: LABEL_WIDTH }}>
                  Layers
                </div>
              )}
              {!open && <div style={{ width: GUTTER }} />}
              <div ref={rulerRef} data-lane data-testid="timeline-ruler" className="relative h-full cursor-pointer touch-none select-none" style={{ width: laneWidth }}>
                {ticks.map((f) => (
                  <div key={f} className="bg-border absolute bottom-0 h-2 w-px" style={{ left: f * pxPerFrame }}>
                    <span className="text-muted-foreground absolute -top-4 left-1.5 font-mono text-[10px] tabular-nums">{f}</span>
                  </div>
                ))}
                {!open &&
                  roots.map((node) => {
                    const first = node.bars[0]?.[0];
                    return first === undefined ? null : (
                      <span
                        key={node.id}
                        data-testid="marker"
                        title={`${node.label} · frame ${first}`}
                        className="bg-primary absolute top-1 size-2 -translate-x-1/2 rotate-45 rounded-[2px]"
                        style={{ left: first * pxPerFrame }}
                      />
                    );
                  })}
              </div>
            </div>

            {status.state === 'loading' && (
              <TimelineNotice testId="timeline-loading" progress={status.total > 0 ? status.done / status.total : null}>
                {status.total > 0 ? `Reading the timeline: frame ${status.done} of ${status.total}` : 'Reading the timeline...'}
              </TimelineNotice>
            )}
            {status.state === 'error' && (
              <TimelineNotice testId="timeline-error" error>
                {`Could not read the timeline: ${status.error.message}`}
              </TimelineNotice>
            )}
            {/* The film strip: always there, in both the slim and the expanded timeline. */}
            <div className="flex items-center py-1.5" style={{ paddingLeft: open ? 0 : GUTTER }}>
              {open && (
                <div className="bg-card text-muted-foreground sticky left-0 z-40 flex shrink-0 items-center px-4 text-xs font-medium" style={{ width: LABEL_WIDTH }}>
                  Frames
                </div>
              )}
              <div data-lane className="relative" style={{ width: laneWidth, height: STRIP_HEIGHT }}>
                <Filmstrip comp={comp} laneWidth={laneWidth} thumbnailUrl={thumbnailUrl} />
                {!open && status.state === 'ready' &&
                  roots.flatMap((node) =>
                    node.bars.map(([a, b]) => (
                      <div
                        key={`${node.id}-${a}`}
                        title={nodeTitle(node)}
                        className="bg-card/75 text-foreground pointer-events-none absolute bottom-1 h-5 overflow-hidden rounded-full px-2 text-[11px] leading-5 font-medium whitespace-nowrap backdrop-blur-sm"
                        style={{ left: a * pxPerFrame + 4, maxWidth: Math.max(8, (b + 1 - a) * pxPerFrame - 8) }}
                      >
                        {node.label}
                      </div>
                    )),
                  )}
              </div>
            </div>
            {status.state === 'ready' && open && rows.length === 0 && <EmptyRow>{q ? 'Nothing matches the search.' : 'No Sequences'}</EmptyRow>}
            {status.state === 'ready' && open && rows.length > 0 && (
              <>
                <div aria-hidden="true" style={{ height: firstRow * ROW_HEIGHT }} />
                {rows.slice(firstRow, lastRow).map(({ node, depth, expandable, expanded: rowOpen }) => (
                  <RowItem
                    key={node.id}
                    node={node}
                    depth={depth}
                    expandable={expandable}
                    open={rowOpen}
                    details={details}
                    selectedLayers={selectedLayers}
                    clicked={clicked}
                    pxPerFrame={pxPerFrame}
                    laneWidth={laneWidth}
                    player={player}
                    thumbnailUrl={thumbnailUrl}
                    onToggle={toggle}
                    onPick={pick}
                  />
                ))}
                <div aria-hidden="true" style={{ height: (rows.length - lastRow) * ROW_HEIGHT }} />
              </>
            )}

            <Playhead player={player} left={lead} pxPerFrame={pxPerFrame} scrollerRef={scrollerRef} zoom={zoom} labelWidth={labelWidth} />
          </div>
        )}
      </div>
    </div>
  );
});
