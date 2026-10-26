import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { CrosshairIcon, GridIcon, Maximize2Icon, TriangleAlertIcon } from 'lucide-react';

import type { CompositionInfo, InspectResult, ReceivedFrame, StudioError } from '@/api';
import { PanelHeader } from '@/components/shell/panel-header';
import type { Tool } from '@/components/shell/tool-bar';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { fitSize, stepZoom } from '@/lib/format';
import { displayName } from '@/lib/names';
import { findLayer, hitTest } from '@/lib/inspect';
import { boxResult, boxSelect, clickSelection, layerRect, rectFrom, type Rect } from '@/lib/selection';
import { useElementSize } from '@/lib/use-element-size';
import { cn } from '@/lib/utils';

/** Fit the frame to the viewer, or show it at a scale where 1 is 100%. */
export type Zoom = 'fit' | number;

/** How the frame is shown: its zoom, and where a hand-tool drag has moved it (CSS pixels from the centre). */
export interface View {
  zoom: Zoom;
  pan: { x: number; y: number };
}

interface ViewerProps {
  comp: CompositionInfo | null;
  onImage(listener: (frame: ReceivedFrame) => void): () => void;
  lastImage(): ReceivedFrame | null;
  /** The latest build's error: covers the preview until the next good build. */
  buildError: StudioError | null;
  /** The last frame request that failed. */
  frameError: StudioError | null;
  inspect?: InspectResult | null;
  /** The layers picked: outlined on the frame, the first with its handles. */
  selectedLayers?: string[];
  compositions?: CompositionInfo[];
  onSelectComp?(id: string): void;
  tool: Tool;
  view: View;
  onViewChange(view: View): void;
  safeZones: boolean;
  onSafeZonesChange(on: boolean): void;
  /** A click picked one layer (shift: added), or a dragged box picked the layers inside it. */
  onSelectLayers(ids: string[]): void;
}

/** The frames the server renders, drawn on a canvas that scales to fit, over a checkerboard for transparency. */
export function Viewer({
  comp,
  onImage,
  lastImage,
  buildError,
  frameError,
  inspect = null,
  selectedLayers = [],
  compositions = [],
  onSelectComp,
  tool,
  view,
  onViewChange,
  safeZones,
  onSafeZonesChange,
  onSelectLayers,
}: ViewerProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const box = useElementSize(boxRef);
  /** Decoding is async: a frame that finishes after a newer one started must not be drawn. */
  const drawn = useRef(0);
  /** Where a hand-tool drag began: the pointer and the pan then. */
  const dragFrom = useRef<{ x: number; y: number; pan: View['pan'] } | null>(null);
  const [frameMs, setFrameMs] = useState<number | null>(null);
  const [showGuides, setShowGuides] = useState(true);
  /** A drag with the select tool: where it began and whether it has gone far enough to be a box and not a click. */
  const boxFrom = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  /** The click that ends a box drag must not also pick a layer. */
  const swallowClick = useRef(false);

  const draw = useCallback(async (frame: ReceivedFrame) => {
    const ticket = ++drawn.current;
    setFrameMs(frame.header.ms);
    const bitmap = await createImageBitmap(new Blob([frame.image as Uint8Array<ArrayBuffer>], { type: frame.header.mime }));
    const canvas = canvasRef.current;
    if (ticket === drawn.current && canvas) {
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    }
    bitmap.close();
  }, []);

  useEffect(() => {
    const last = lastImage();
    if (last) void draw(last);
    return onImage((frame) => void draw(frame));
  }, [draw, lastImage, onImage]);

  const zoom = view.zoom;
  const shown = comp
    ? zoom === 'fit'
      ? fitSize(box.width - 32, box.height - 32, comp.width, comp.height)
      : { width: Math.round(comp.width * zoom), height: Math.round(comp.height * zoom) }
    : null;
  const scaleRatio = comp && shown && comp.width > 0 ? shown.width / comp.width : 1;
  const scalePct = Math.round(scaleRatio * 100);

  const activeLayer = inspect && selectedLayers[0] ? findLayer(inspect.layers, selectedLayers[0]) : null;
  const layerBounds = activeLayer?.bounds ?? activeLayer?.box ?? null;
  const otherRects: Rect[] = [];
  if (inspect) {
    for (const id of selectedLayers.slice(1)) {
      const rect = (() => {
        const found = findLayer(inspect.layers, id);
        return found ? layerRect(found) : null;
      })();
      if (rect) otherRects.push(rect);
    }
  }

  /** The composition pixel under the pointer, or null off the frame. */
  const pixelAt = (event: MouseEvent<HTMLElement>) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!comp || !rect || rect.width === 0 || rect.height === 0) return null;
    const x = ((event.clientX - rect.left) / rect.width) * comp.width;
    const y = ((event.clientY - rect.top) / rect.height) * comp.height;
    return x >= 0 && y >= 0 && x < comp.width && y < comp.height ? { x, y } : null;
  };

  /** The composition pixel under the pointer, kept to the frame (a drag may leave it). */
  const clampedPixelAt = (event: MouseEvent<HTMLElement>) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!comp || !rect || rect.width === 0 || rect.height === 0) return null;
    const x = ((event.clientX - rect.left) / rect.width) * comp.width;
    const y = ((event.clientY - rect.top) / rect.height) * comp.height;
    return { x: Math.min(comp.width, Math.max(0, x)), y: Math.min(comp.height, Math.max(0, y)) };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (tool === 'select' && comp && !buildError && event.button === 0) {
      const at = clampedPixelAt(event);
      boxFrom.current = at ? { ...at, px: event.clientX, py: event.clientY, moved: false } : null;
      return;
    }
    if (tool !== 'hand' || !comp || buildError) return;
    dragFrom.current = { x: event.clientX, y: event.clientY, pan: view.pan };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const box = boxFrom.current;
    if (box) {
      if (!box.moved && Math.hypot(event.clientX - box.px, event.clientY - box.py) < 4) return;
      box.moved = true;
      const at = clampedPixelAt(event);
      if (at) setMarquee(rectFrom(box, at));
      return;
    }
    const from = dragFrom.current;
    if (!from) return;
    onViewChange({ zoom, pan: { x: from.pan.x + event.clientX - from.x, y: from.pan.y + event.clientY - from.y } });
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    dragFrom.current = null;
    const box = boxFrom.current;
    boxFrom.current = null;
    if (box?.moved) {
      const at = clampedPixelAt(event);
      swallowClick.current = true;
      setMarquee(null);
      if (at && inspect) onSelectLayers(boxResult(selectedLayers, boxSelect(inspect.layers, rectFrom(box, at)), event.shiftKey));
    }
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    if (!comp || buildError) return;
    if (tool === 'zoom') {
      onViewChange({ zoom: stepZoom(scaleRatio, event.altKey ? -1 : 1), pan: view.pan });
    } else if (tool === 'select' && inspect) {
      const point = pixelAt(event);
      onSelectLayers(clickSelection(selectedLayers, (point && hitTest(inspect.layers, point.x, point.y)?.id) ?? null, event.shiftKey));
    }
  };

  const fitMode = zoom === 'fit';

  return (
    <div className="bg-card flex min-h-0 flex-1 flex-col select-none">
      <PanelHeader
        title={
          <div className="border-primary text-foreground flex h-full items-center border-b-2 px-1 font-medium">
            <span>Composition {comp ? comp.id : ''}</span>
          </div>
        }
      >
        {frameMs !== null && <span className="text-muted-foreground font-mono text-[10px]">{frameMs.toFixed(0)} ms</span>}
      </PanelHeader>

      {/* Composition pills and overlay toggles */}
      {compositions.length > 0 && (
        <div className="bg-background/60 flex h-7 shrink-0 items-center gap-1.5 border-b px-3 text-[11px]">
          {compositions.map((c) => {
            const active = c.id === comp?.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onSelectComp?.(c.id)}
                className={cn(
                  'rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors',
                  active
                    ? 'bg-nle-blue/25 text-sky-300 ring-1 ring-nle-blue/50'
                    : 'text-muted-foreground hover:bg-white/[0.05] hover:text-foreground',
                )}
              >
                {c.id}
              </button>
            );
          })}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              aria-pressed={showGuides}
              onClick={() => setShowGuides((v) => !v)}
              title="Toggle Layer Transform Box Overlay"
              className={cn(
                'flex items-center gap-1 rounded-xs px-1.5 py-0.5 text-[10px] transition-colors',
                showGuides ? 'bg-nle-blue/25 text-sky-300' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <CrosshairIcon className="size-3" aria-hidden="true" />
              <span>Layer Controls</span>
            </button>
            <button
              type="button"
              aria-pressed={safeZones}
              onClick={() => onSafeZonesChange(!safeZones)}
              title="Toggle Title/Action Safe Guides"
              className={cn(
                'flex items-center gap-1 rounded-xs px-1.5 py-0.5 text-[10px] transition-colors',
                safeZones ? 'bg-nle-blue/25 text-sky-300' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <GridIcon className="size-3" aria-hidden="true" />
              <span>Safe Zones</span>
            </button>
          </div>
        </div>
      )}

      {/* Main Viewport Canvas Area */}
      <div
        ref={boxRef}
        data-testid="preview"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onClick}
        className={cn(
          'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#101013] p-4',
          tool === 'hand' ? 'cursor-grab' : tool === 'zoom' ? 'cursor-zoom-in' : 'cursor-default',
        )}
      >
        {comp && shown ? (
          <div
            ref={frameRef}
            data-testid="frame"
            className="relative overflow-hidden bg-[repeating-conic-gradient(#18181c_0%_25%,#202026_0%_50%)] bg-[length:16px_16px] shadow-[0_12px_40px_rgba(0,0,0,0.65)] ring-1 ring-white/15"
            style={{
              width: shown.width,
              height: shown.height,
              transform: `translate(${view.pan.x}px, ${view.pan.y}px)`,
            }}
          >
            <canvas
              ref={canvasRef}
              data-testid="preview-canvas"
              className="block size-full"
              width={comp.width}
              height={comp.height}
            />

            {/* Optional Broadcast Action/Title Safe Overlay */}
            {safeZones && (
              <div className="pointer-events-none absolute inset-0" aria-hidden="true">
                <div className="absolute inset-[5%] border border-cyan-400/30" />
                <div className="absolute inset-[10%] border border-dashed border-cyan-400/25" />
                <div className="absolute inset-x-0 top-1/2 h-px bg-cyan-400/15" />
                <div className="absolute inset-y-0 left-1/2 w-px bg-cyan-400/15" />
              </div>
            )}

            {/* Selected layer bounds overlay (read-only) */}
            {showGuides && activeLayer && layerBounds && (
              <div
                className="pointer-events-none absolute border border-rose-500/90 shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
                aria-hidden="true"
                style={{
                  left: layerBounds.x * scaleRatio,
                  top: layerBounds.y * scaleRatio,
                  width: Math.max(2, layerBounds.width * scaleRatio),
                  height: Math.max(2, layerBounds.height * scaleRatio),
                }}
              >
                {/* 8 transform handles */}
                <span className="absolute -top-1 -left-1 size-2 border border-white bg-rose-500" />
                <span className="absolute -top-1 left-1/2 size-2 -translate-x-1/2 border border-white bg-rose-500" />
                <span className="absolute -top-1 -right-1 size-2 border border-white bg-rose-500" />
                <span className="absolute top-1/2 -left-1 size-2 -translate-y-1/2 border border-white bg-rose-500" />
                <span className="absolute top-1/2 -right-1 size-2 -translate-y-1/2 border border-white bg-rose-500" />
                <span className="absolute -bottom-1 -left-1 size-2 border border-white bg-rose-500" />
                <span className="absolute -bottom-1 left-1/2 size-2 -translate-x-1/2 border border-white bg-rose-500" />
                <span className="absolute -bottom-1 -right-1 size-2 border border-white bg-rose-500" />

                {/* Layer label pill */}
                <span
                  className="pointer-events-auto absolute -top-5 left-0 rounded-xs bg-rose-500 px-1.5 py-0.5 font-mono text-[9px] leading-none font-medium text-white shadow"
                  title={activeLayer.id}
                  data-testid="selection-label"
                >
                  {displayName(activeLayer)}
                </span>
              </div>
            )}

            {/* The other selected layers: an outline each */}
            {showGuides &&
              otherRects.map((rect, index) => (
                <div
                  key={index}
                  data-testid="selection-outline"
                  className="pointer-events-none absolute border border-rose-500/90"
                  aria-hidden="true"
                  style={{ left: rect.x * scaleRatio, top: rect.y * scaleRatio, width: Math.max(2, rect.width * scaleRatio), height: Math.max(2, rect.height * scaleRatio) }}
                />
              ))}

            {/* The box being dragged */}
            {marquee && (
              <div
                data-testid="marquee"
                className="pointer-events-none absolute border border-dashed border-sky-300 bg-sky-400/10"
                aria-hidden="true"
                style={{ left: marquee.x * scaleRatio, top: marquee.y * scaleRatio, width: marquee.width * scaleRatio, height: marquee.height * scaleRatio }}
              />
            )}

            {/* Anchor Point Reticle */}
            {showGuides && activeLayer && (
              <div
                className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/90 bg-rose-500/30"
                aria-hidden="true"
                style={{
                  left: activeLayer.transform.x * scaleRatio,
                  top: activeLayer.transform.y * scaleRatio,
                }}
              >
                <span className="absolute inset-x-0 top-1/2 h-px bg-white/90" />
                <span className="absolute inset-y-0 left-1/2 w-px bg-white/90" />
              </div>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">No composition selected.</p>
        )}

        {/* Bottom-left & bottom-right viewport HUD: the zoom readout toggles fit and 100%. */}
        {comp && shown && (
          <div className="pointer-events-none absolute inset-x-3 bottom-2 flex items-center justify-between font-mono text-[10px] text-white/50">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onViewChange({ zoom: fitMode ? 1 : 'fit', pan: { x: 0, y: 0 } });
              }}
              title={fitMode ? 'Show at 100% (1)' : 'Fit to viewer (0)'}
              className="pointer-events-auto hover:text-foreground flex items-center gap-1 rounded-xs bg-black/50 px-1.5 py-0.5 backdrop-blur-xs"
            >
              <Maximize2Icon className="size-2.5" aria-hidden="true" />
              {fitMode ? `Fit (${scalePct}%)` : `${scalePct}%`}
            </button>
            <span className="rounded-xs bg-black/50 px-1.5 py-0.5 backdrop-blur-xs">
              {comp.width} × {comp.height} · {comp.fps} fps
            </span>
          </div>
        )}

        {frameError && !buildError && (
          <Alert variant="destructive" className="absolute inset-x-4 bottom-4 w-auto">
            <TriangleAlertIcon />
            <AlertTitle>Frame failed ({frameError.code})</AlertTitle>
            <AlertDescription>{frameError.message}</AlertDescription>
          </Alert>
        )}
        {buildError && (
          <div
            role="alertdialog"
            aria-label="Build error"
            className="bg-background/90 absolute inset-0 z-10 flex items-center justify-center p-6"
          >
            <Alert variant="destructive" className="max-h-full max-w-3xl overflow-auto">
              <TriangleAlertIcon />
              <AlertTitle>Build failed ({buildError.code})</AlertTitle>
              <AlertDescription>
                <pre className="font-mono text-xs break-words whitespace-pre-wrap">{buildError.message}</pre>
                <p>The last good build keeps running; this clears when a build succeeds.</p>
              </AlertDescription>
            </Alert>
          </div>
        )}
      </div>
    </div>
  );
}
