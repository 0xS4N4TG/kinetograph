import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { ChevronUpIcon, ListTreeIcon, SearchIcon, Volume2Icon, ZoomInIcon, ZoomOutIcon } from 'lucide-react';

import type { CompositionInfo, TimelineAudio, Waveform } from '@/api';
import { Bar, EmptyRow, LABEL_WIDTH, LANE_INSET, ROW_HEIGHT, Row, THUMB_HEIGHT, TimelineNotice } from '@/components/timeline/timeline-row';
import { bucketsFor, useWaveform, VideoStrip, WaveformLine } from '@/components/timeline/timeline-media';
import { Button } from '@/components/ui/button';
import { RangeGrip } from '@/components/inspector/trim-bar';
import { Hint } from '@/components/ui/hint';
import { LoadingImage, Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import { clock } from '@/lib/format';
import { layerColors } from '@/lib/layer-colors';
import { fullSource, secondLine } from '@/lib/names';
import { extendRange, makeRange, type FrameRange } from '@/lib/selection';
import type { Player } from '@/lib/player';
import { useFrame, usePlayerState } from '@/lib/player-hooks';
import type { TimelineStatus } from '@/studio';
import { cn } from '@/lib/utils';
import { buildTimeline, seekTarget, visibleRows, type Range, type TimelineNode } from '@/lib/timeline-model';
import { buildRuler } from '@/lib/ruler';
import { useReviewMarks } from '@/lib/review-marks';
import { numberOf, useMarkup, useMarkupStore } from '@/lib/markup';
import { useElementSize } from '@/lib/use-element-size';

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
  /** The span of time picked on the timeline, or null. */
  selectedRange: FrameRange | null;
  onSelectRange(range: FrameRange | null): void;
  /** The address of a small picture of a frame, for the clips; none when left out. */
  thumbnailUrl?: (frame: number, height: number) => string | null;
  /** Peaks of one sound (or of the mix); none when left out. */
  waveform?: (clip: string | undefined, buckets: number) => Promise<Waveform>;
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
      className="bg-primary pointer-events-none absolute top-10 bottom-0 z-30 w-[1.5px] -translate-x-1/2"
      style={{ left: left + frame * pxPerFrame }}
    >
      <span className="bg-primary ring-card absolute top-0 left-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2" />
    </div>
  );
});

/**
 * The picked span over every row, ruler included: a tinted region with a grip at each end, the look of the export
 * dialog's trim bar. The grips sit in the ruler band; drag one, or focus it and use the arrow keys.
 */
const RangeOverlay = memo(function RangeOverlay({
  range,
  left,
  pxPerFrame,
  duration,
  frameAt,
  onChange,
}: {
  range: FrameRange;
  left: number;
  pxPerFrame: number;
  duration: number;
  frameAt(clientX: number): number;
  onChange(range: FrameRange): void;
}) {
  const x = left + range.start * pxPerFrame;
  const width = (range.end + 1 - range.start) * pxPerFrame;
  const last = Math.max(0, duration - 1);
  const grip = (which: 'start' | 'end') => (
    <RangeGrip
      which={which}
      value={which === 'start' ? range.start : range.end}
      last={last}
      frameAt={(event) => frameAt(event.clientX)}
      onMove={(frame) => {
        const next = which === 'start' ? makeRange(frame, range.end, duration) : makeRange(range.start, frame, duration);
        if (next) onChange(next);
      }}
      className="inset-y-auto top-0 z-[35] h-10"
      style={which === 'start' ? { left: -14 } : { left: width }}
    />
  );
  return (
    <div data-testid="time-range" className="pointer-events-none absolute inset-y-0 z-[25]" style={{ left: x, width }}>
      <div className="bg-primary/10 border-primary/60 absolute inset-0 border-x" />
      <div className="bg-primary/20 absolute inset-x-0 top-0 h-10" />
      <div className="pointer-events-auto">{grip('start')}</div>
      <div className="pointer-events-auto">{grip('end')}</div>
    </div>
  );
});

/** A thin line under the ruler while a newer timeline is read; the one on show stays. */
function ReadingLine({ progress }: { progress: number | null }) {
  return (
    <div data-testid="timeline-refreshing" role="progressbar" aria-label="Reading the timeline" className="bg-primary/15 sticky left-0 h-0.5 w-full overflow-hidden">
      <div className={cn('bg-primary h-full', progress === null && 'w-1/4 animate-pulse')} style={progress === null ? undefined : { width: `${Math.round(progress * 100)}%` }} />
    </div>
  );
}

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
            {src && <LoadingImage data-testid="filmstrip-frame" src={src} alt="" loading="lazy" decoding="async" draggable={false} className="size-full object-cover" onError={(event) => { event.currentTarget.style.display = 'none'; }} />}
          </div>
        );
      })}
    </div>
  );
});

/** The timecode, large, in the box at the top left of the layers. */
const BigTimecode = memo(function BigTimecode({ player, fps }: { player: Player; fps: number }) {
  const frame = useFrame(player);
  return (
    <span className="bg-muted flex h-8 items-center rounded-lg px-2.5 font-mono text-base leading-none font-medium whitespace-nowrap tabular-nums" title={`frame ${frame}`}>
      {clock(frame, fps)}
    </span>
  );
});

/** The time and frame under the playhead, in the header. */
const FrameReadout = memo(function FrameReadout({ player, fps }: { player: Player; fps: number }) {
  const frame = useFrame(player);
  return (
    <span className="text-muted-foreground font-mono text-xs whitespace-nowrap tabular-nums" title={`frame ${frame}`}>
      {clock(frame, fps)}
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
  onPick(node: TimelineNode, seek: boolean, span?: Range, extend?: boolean): void;
}

interface AudioRowProps {
  sound: TimelineAudio;
  pxPerFrame: number;
  laneWidth: number;
  fps: number;
  waveform: NonNullable<TimelineProps['waveform']>;
}

/** The row of one sound: a bar over each stretch it plays, and its waveform, a thin line of peaks. */
const AudioRow = memo(function AudioRow({ sound, pxPerFrame, laneWidth, waveform }: AudioRowProps) {
  const colors = layerColors('text');
  const name = sound.src.split('/').pop() ?? sound.src;
  const wide = Math.max(...sound.ranges.map(([a, b]) => (b + 1 - a) * pxPerFrame), 1);
  const peaks = useWaveform(waveform, sound.id, bucketsFor(wide));
  const extent = peaks && peaks.startFrame !== undefined && peaks.endFrame !== undefined ? ([peaks.startFrame, peaks.endFrame] as const) : null;
  const title = `${name}\nframes ${sound.ranges[0]![0]}..${sound.ranges[sound.ranges.length - 1]![1]}`;
  return (
    <Row
      data-testid="audio-row"
      icon={Volume2Icon}
      tile={colors.tile}
      label={sound.video ? `Sound of ${name}` : name}
      title={title}
      depth={0}
      expanded={undefined}
      selected={false}
      current={false}
      onSelect={() => {}}
      laneWidth={laneWidth}
    >
      {sound.ranges.map(([a, b]) => (
        <Bar key={a} from={a} to={b + 1} pxPerFrame={pxPerFrame} title={title} className="bg-foreground/[0.04] border-border text-foreground" />
      ))}
      {!peaks &&
        sound.ranges.map(([a, b]) => (
          <Skeleton key={a} data-testid="waveform-skeleton" className="pointer-events-none absolute inset-y-2.5 rounded-md" style={{ left: a * pxPerFrame, width: Math.max(4, (b + 1 - a) * pxPerFrame) }} />
        ))}
      {peaks && extent && (
        <div className="pointer-events-none absolute inset-y-1.5" style={{ left: extent[0] * pxPerFrame, width: Math.max(1, (extent[1] - extent[0]) * pxPerFrame) }}>
          <WaveformLine peaks={peaks.peaks} width={Math.max(1, (extent[1] - extent[0]) * pxPerFrame)} height={ROW_HEIGHT - 12} />
        </div>
      )}
    </Row>
  );
});

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
      icon={colors.icon}
      tile={colors.tile}
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
          onClick={(event) => onPick(node, false, [a, b], event.shiftKey)}
          thumbnail={thumbnailUrl?.(a, THUMB_HEIGHT * 2)}
          strip={node.type === 'video' && thumbnailUrl ? <VideoStrip first={a} end={b + 1} width={(b + 1 - a) * pxPerFrame} height={THUMB_HEIGHT + 12} thumbnailUrl={thumbnailUrl} /> : undefined}
          icon={colors.icon}
          tile={colors.tile}
          word={colors.word}
          selected={selected}
          className={cn(colors.bar, 'text-foreground')}
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
export const Timeline = memo(function Timeline({ comp, status, player, selectedLayers, onSelectLayers, selectedRange, onSelectRange, thumbnailUrl, waveform, expanded: open, onExpandedChange, details, onDetailsChange }: TimelineProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  /** The notes of an open review, marked on the ruler. */
  const reviewMarks = useReviewMarks();
  /** The notes of markup mode: a tick each on the ruler, and with the Range tool a drag on the ruler makes one. */
  const markupStore = useMarkupStore();
  const markup = useMarkup();
  /** What a press in the ruler or a lane is doing: scrubbing, or (for a press that may become a drag) waiting to see. */
  const drag = useRef<{ kind: 'scrub' } | { kind: 'pending'; anchor: number; x: number } | { kind: 'range'; anchor: number; base: FrameRange | null } | null>(null);
  const rangeRef = useRef(selectedRange);
  rangeRef.current = selectedRange;
  /** A Ctrl or Cmd wheel zoom keeps the frame under the pointer where it was: `x` px from the scroller's left edge. */
  const anchor = useRef<{ frame: number; x: number } | null>(null);
  const size = useElementSize(scrollerRef);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [filter, setFilter] = useState('');

  const labelWidth = open ? LABEL_WIDTH : 0;
  const lead = open ? LABEL_WIDTH + LANE_INSET : GUTTER;
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
    (node: TimelineNode, seek: boolean, span?: Range, extend?: boolean) => {
      if (seek) {
        const target = seekTarget(node, player.getState().frame);
        if (target !== null) player.seek(target);
      }
      setClicked(node.id);
      onSelectLayers(node.layerIds);
      // A clip selects its span; Shift widens the span already picked.
      if (span) onSelectRange(extend ? extendRange(rangeRef.current, span[0], span[1], duration) : makeRange(span[0], span[1], duration));
    },
    [player, onSelectLayers, onSelectRange, duration],
  );

  // Only the rows in (or near) view are drawn; before the scroller is measured, all of them.
  const viewport = size.height;
  const firstRow = viewport > 0 ? Math.max(0, Math.floor(Math.max(0, scrollTop - 36) / ROW_HEIGHT) - 8) : 0;
  const lastRow = viewport > 0 ? Math.min(rows.length, firstRow + Math.ceil(viewport / ROW_HEIGHT) + 16) : rows.length;

  const ruler = useMemo(() => buildRuler(fps, duration, pxPerFrame), [fps, duration, pxPerFrame]);

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
  /** The whole frame under a pointer, in or out of the lane (the span clamps it). */
  const frameAtX = (clientX: number) => {
    const rect = rulerRef.current?.getBoundingClientRect();
    return rect && duration > 0 ? Math.floor(((clientX - rect.left) / (rect.width || laneWidth)) * duration) : 0;
  };
  // The ruler and every lane share one horizontal scale. A press seeks, as it always did; in the ruler and the empty
  // part of a row it becomes a span once the pointer moves, and with Shift it extends the span at once. The film strip
  // only scrubs, and a clip takes the click itself.
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    const lane = target.closest<HTMLElement>('[data-lane]');
    if (!lane || event.button > 0 || duration === 0 || target.closest('[data-testid=bar]')) return;
    lane.setPointerCapture?.(event.pointerId);
    const frame = frameAtX(event.clientX);
    const spans = lane === rulerRef.current || lane.closest('[data-testid$="-row"]') !== null;
    if (spans && event.shiftKey) {
      drag.current = { kind: 'range', anchor: frame, base: rangeRef.current };
      onSelectRange(extendRange(rangeRef.current, frame, frame, duration));
      return;
    }
    player.beginScrub();
    seekTo(event.clientX);
    drag.current = spans ? { kind: 'pending', anchor: frame, x: event.clientX } : { kind: 'scrub' };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'scrub') return seekTo(event.clientX);
    if (d.kind === 'pending') {
      if (Math.abs(event.clientX - d.x) < 4) return seekTo(event.clientX);
      player.endScrub();
      drag.current = { kind: 'range', anchor: d.anchor, base: null };
      return onSelectRange(makeRange(d.anchor, frameAtX(event.clientX), duration));
    }
    const now = frameAtX(event.clientX);
    onSelectRange(d.base ? extendRange(d.base, d.anchor, now, duration) : makeRange(d.anchor, now, duration));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && d.kind !== 'range') player.endScrub();
    // With the Range tool of markup mode, the span just dragged becomes a note (its bubble opens on the preview).
    const picked = rangeRef.current;
    if (d?.kind === 'range' && picked && comp && markupStore && markup.active && markup.tool === 'range') {
      markupStore.add({ comp: comp.id, frame: picked.start, endFrame: picked.end, geom: { type: 'range' } });
      onSelectRange(null);
    }
  };

  const roots = model?.roots ?? [];

  return (
    <div data-testid="timeline" className="flex h-full min-h-0 flex-col select-none">
      <div className="@container/tl flex h-12 min-w-0 shrink-0 items-center gap-2 px-4">
        <Hint label={open ? 'Fold the timeline' : 'Show the layers'}>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-label={open ? 'Fold the timeline' : 'Expand the timeline'}
            onClick={() => onExpandedChange(!open)}
            className="-ml-2 shrink-0 gap-2 rounded-full px-3 font-semibold"
          >
            <ChevronUpIcon className={cn('transition-transform', open && 'rotate-180')} />
            Timeline
          </Button>
        </Hint>
                <FrameReadout player={player} fps={fps} />
        <span className="text-muted-foreground/80 hidden font-mono text-xs whitespace-nowrap @2xl/tl:inline" title="Length in frames">{duration} f</span>

        <div className="ml-auto flex min-w-0 shrink items-center gap-2">
          {open && (
            <>
              <div className="bg-input/40 hidden h-8 w-44 shrink-0 items-center gap-2 rounded-full px-3 @3xl/tl:flex">
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
              <Button variant={details ? 'secondary' : 'ghost'} size="sm" aria-pressed={details} onClick={() => onDetailsChange(!details)} aria-label="Show details" title="Show details" className="shrink-0 rounded-full px-3 whitespace-nowrap">
                <ListTreeIcon />
                <span className="hidden @3xl/tl:inline">Show details</span>
              </Button>
            </>
          )}
          <div className="flex shrink-0 items-center gap-1 [&_[data-slot=slider-control]]:min-w-0">
            <Button variant="ghost" size="icon-sm" aria-label="Zoom out timeline" disabled={zoom <= MIN_ZOOM} onClick={() => setZoom((z) => clampZoom(z / ZOOM_FACTOR))} className="shrink-0 rounded-full">
              <ZoomOutIcon />
            </Button>
            <div className="hidden w-[72px] shrink-0 @xl/tl:block"><Slider className="w-full min-w-0" aria-label="Zoom" min={MIN_ZOOM} max={MAX_ZOOM} step={0.5} value={[zoom]} onValueChange={(value) => setZoom(clampZoom(Array.isArray(value) ? (value[0] ?? MIN_ZOOM) : value))} /></div>
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
            <div className="bg-card sticky top-0 z-20 flex h-10">
              {open && (
                <div className="bg-card sticky left-0 z-40 flex shrink-0 items-center px-4" style={{ width: LABEL_WIDTH }}>
                  <BigTimecode player={player} fps={fps} />
                </div>
              )}
              {open ? <div className="bg-card shrink-0" style={{ width: LANE_INSET }} /> : <div style={{ width: GUTTER }} />}
              <div ref={rulerRef} data-lane data-testid="timeline-ruler" className="relative h-full cursor-pointer touch-none select-none" style={{ width: laneWidth }}>
                {/* Labels sit in the upper band, to the right of their tick; ticks and dots in the lower one, so they never meet. */}
                {ruler.labels.map((mark) => (
                  <Fragment key={`l${mark.frame}`}>
                    <span aria-hidden="true" data-testid="ruler-tick" className="bg-muted-foreground/60 absolute bottom-1 h-2.5 w-px" style={{ left: mark.x }} />
                    <span
                      data-testid="ruler-label"
                      title={`frame ${Math.round(mark.frame)}`}
                      className={cn('absolute top-1.5 -translate-x-1/2 font-mono whitespace-nowrap tabular-nums', mark.whole ? 'text-muted-foreground text-[11px]' : 'text-muted-foreground/60 text-[10px]')}
                      style={{ left: Math.min(Math.max(mark.x, 18), Math.max(18, laneWidth - 18)) }}
                    >
                      {mark.text}
                    </span>
                  </Fragment>
                ))}
                {ruler.minor.map((mark) => (
                  <span key={`m${mark.frame}`} aria-hidden="true" data-testid="ruler-dot" className="bg-muted-foreground/40 absolute bottom-1 h-1 w-px" style={{ left: mark.x }} />
                ))}
                {reviewMarks?.comp === comp.id &&
                  reviewMarks.frames.map((frame, index) => (
                    <span
                      key={`n${index}`}
                      aria-hidden="true"
                      data-testid="review-mark"
                      title={`Note at frame ${frame}`}
                      className="pointer-events-none absolute top-0 h-3 w-[3px] -translate-x-1/2 rounded-b-sm bg-amber-400"
                      style={{ left: frame * pxPerFrame }}
                    />
                  ))}
                {markup.notes
                  .filter((n) => n.comp === comp.id)
                  .map((note) => (
                    <span
                      key={`k${note.id}`}
                      aria-hidden="true"
                      data-testid="markup-tick"
                      data-state={note.resolved ? 'resolved' : note.status}
                      title={`Note ${numberOf(note, markup.notes) ?? ''} at frame ${note.frame}${note.endFrame > note.frame ? `-${note.endFrame}` : ''}`}
                      className={cn('pointer-events-none absolute top-0 h-3 -translate-x-1/2 rounded-b-sm', note.status === 'sent' && 'opacity-50', note.resolved && 'opacity-40 grayscale')}
                      style={{ left: note.frame * pxPerFrame, width: Math.max(3, (note.endFrame - note.frame) * pxPerFrame), background: note.color, ...(note.endFrame > note.frame ? { transform: 'none' } : {}) }}
                    />
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

            {status.state === 'ready' && status.refreshing && (
              <ReadingLine progress={status.refreshing.total > 0 ? status.refreshing.done / status.refreshing.total : null} />
            )}
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
                <div className="bg-card text-muted-foreground sticky left-0 z-40 flex shrink-0 items-center self-stretch px-4 text-xs font-medium" style={{ width: LABEL_WIDTH }}>
                  Frames
                </div>
              )}
              {open && <div className="shrink-0" style={{ width: LANE_INSET }} />}
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
            {status.state === 'ready' && open && waveform && (status.data.audio ?? []).map((sound) => (
              <AudioRow key={sound.id} sound={sound} pxPerFrame={pxPerFrame} laneWidth={laneWidth} fps={fps} waveform={waveform} />
            ))}

            {selectedRange && (
              <RangeOverlay range={selectedRange} left={lead} pxPerFrame={pxPerFrame} duration={duration} frameAt={frameAtX} onChange={onSelectRange} />
            )}
            <Playhead player={player} left={lead} pxPerFrame={pxPerFrame} scrollerRef={scrollerRef} zoom={zoom} labelWidth={labelWidth} />
          </div>
        )}
      </div>
    </div>
  );
});
