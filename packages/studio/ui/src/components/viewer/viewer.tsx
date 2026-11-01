import { useCallback, useEffect, useLayoutEffect, useRef, useState, memo, type MouseEvent, type PointerEvent } from 'react';
import { EyeIcon, HandIcon, MaximizeIcon, MousePointerIcon, TriangleAlertIcon, ZoomInIcon, type LucideIcon } from 'lucide-react';

import type { CompositionInfo, InspectResult, ReceivedFrame, StudioError } from '@/api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { Skeleton } from '@/components/ui/skeleton';
import { Menu, MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from '@/components/ui/menu';
import { fitSize, stepZoom } from '@/lib/format';
import { displayName } from '@/lib/names';
import { findLayer, hitTest } from '@/lib/inspect';
import { boxResult, boxSelect, clickSelection, layerRect, rectFrom, type Rect } from '@/lib/selection';
import { useElementSize } from '@/lib/use-element-size';
import { cn } from '@/lib/utils';

export type Tool = 'select' | 'hand' | 'zoom';

const TOOLS: { id: Tool; label: string; key: string; icon: LucideIcon }[] = [
  { id: 'select', label: 'Selection', key: 'V', icon: MousePointerIcon },
  { id: 'hand', label: 'Hand', key: 'H', icon: HandIcon },
  { id: 'zoom', label: 'Zoom', key: 'Z', icon: ZoomInIcon },
];

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
  tool: Tool;
  onToolChange(tool: Tool): void;
  view: View;
  onViewChange(view: View): void;
  safeZones: boolean;
  onSafeZonesChange(on: boolean): void;
  /** Selection outlines, handles and the anchor mark. */
  guides: boolean;
  onGuidesChange(on: boolean): void;
  /** Receives the element plugin panels draw their preview overlays in (null when there is no frame). */
  onOverlayHost?(el: HTMLElement | null): void;
  /** A click picked one layer (shift: added), or a dragged box picked the layers inside it. */
  onSelectLayers(ids: string[]): void;
}

/** The frames the server renders, drawn on a canvas that scales to fit, over a checkerboard for transparency. */
export const Viewer = memo(function Viewer({
  comp,
  onImage,
  lastImage,
  buildError,
  frameError,
  inspect = null,
  selectedLayers = [],
  tool,
  onToolChange,
  view,
  onViewChange,
  safeZones,
  onSafeZonesChange,
  guides: showGuides,
  onGuidesChange,
  onOverlayHost,
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
      ? fitSize(box.width - 48, box.height - 112, comp.width, comp.height)
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
  const frameScale = scaleRatio;
  const overlayHost = useRef<HTMLDivElement | null>(null);
  const setOverlayHost = useCallback(
    (el: HTMLDivElement | null) => {
      overlayHost.current = el;
      onOverlayHost?.(el);
    },
    [onOverlayHost],
  );
  // Plugin overlays are laid in composition pixels and scaled by this one variable.
  useLayoutEffect(() => {
    overlayHost.current?.style.setProperty('--kg-preview-scale', String(frameScale));
  }, [frameScale, comp]);
  const stop = (event: { stopPropagation(): void }) => event.stopPropagation();

  return (
    <div className="bg-stage relative min-h-0 flex-1 select-none">
      <div
        ref={boxRef}
        data-testid="preview"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onClick}
        className={cn(
          'absolute inset-0 flex items-center justify-center overflow-hidden p-6 pb-[88px]',
          tool === 'hand' ? 'cursor-grab' : tool === 'zoom' ? 'cursor-zoom-in' : 'cursor-default',
        )}
      >
        {comp && shown ? (
          <div
            ref={frameRef}
            data-testid="frame"
            className="relative overflow-hidden rounded-lg bg-[repeating-conic-gradient(#1d1d1d_0%_25%,#262626_0%_50%)] bg-[length:16px_16px] shadow-[0_24px_60px_-12px_rgba(0,0,0,0.6)] ring-1 ring-white/10"
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
            {/* Until the first frame has arrived the canvas is blank: a skeleton of the frame stands in. */}
            {frameMs === null && <Skeleton data-testid="preview-skeleton" className="absolute inset-0 rounded-none" />}

            {safeZones && (
              <div className="pointer-events-none absolute inset-0" aria-hidden="true">
                <div className="absolute inset-[5%] rounded-sm border border-cyan-300/35" />
                <div className="absolute inset-[10%] rounded-sm border border-dashed border-cyan-300/30" />
                <div className="absolute inset-x-0 top-1/2 h-px bg-cyan-300/20" />
                <div className="absolute inset-y-0 left-1/2 w-px bg-cyan-300/20" />
              </div>
            )}

            {showGuides && activeLayer && layerBounds && (
              <div
                className="border-primary pointer-events-none absolute rounded-[3px] border-[1.5px] shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
                aria-hidden="true"
                style={{
                  left: layerBounds.x * scaleRatio,
                  top: layerBounds.y * scaleRatio,
                  width: Math.max(2, layerBounds.width * scaleRatio),
                  height: Math.max(2, layerBounds.height * scaleRatio),
                }}
              >
                {['-top-1 -left-1', '-top-1 left-1/2 -translate-x-1/2', '-top-1 -right-1', 'top-1/2 -left-1 -translate-y-1/2', 'top-1/2 -right-1 -translate-y-1/2', '-bottom-1 -left-1', '-bottom-1 left-1/2 -translate-x-1/2', '-bottom-1 -right-1'].map((place) => (
                  <span key={place} className={cn('bg-primary absolute size-2 rounded-[3px] border border-white', place)} />
                ))}
                <span
                  className="bg-primary text-primary-foreground pointer-events-auto absolute -top-6 left-0 rounded-full px-2 py-0.5 font-mono text-[10px] leading-none font-medium shadow"
                  title={activeLayer.id}
                  data-testid="selection-label"
                >
                  {displayName(activeLayer)}
                </span>
              </div>
            )}

            {showGuides &&
              otherRects.map((rect, index) => (
                <div
                  key={index}
                  data-testid="selection-outline"
                  className="border-primary pointer-events-none absolute rounded-[3px] border-[1.5px]"
                  aria-hidden="true"
                  style={{ left: rect.x * scaleRatio, top: rect.y * scaleRatio, width: Math.max(2, rect.width * scaleRatio), height: Math.max(2, rect.height * scaleRatio) }}
                />
              ))}

            {marquee && (
              <div
                data-testid="marquee"
                className="border-primary bg-primary/10 pointer-events-none absolute rounded-[3px] border border-dashed"
                aria-hidden="true"
                style={{ left: marquee.x * scaleRatio, top: marquee.y * scaleRatio, width: marquee.width * scaleRatio, height: marquee.height * scaleRatio }}
              />
            )}

            {showGuides && activeLayer && (
              <div
                className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/90 bg-white/20"
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

            {/* Where plugin panels draw on the picture: each gets an element in composition pixels (CONTRACT.md section 10). */}
            <div
              ref={setOverlayHost}
              data-testid="plugin-overlays"
              className="absolute inset-0 overflow-hidden"
              style={{ pointerEvents: 'none' }}
              onPointerDown={stop}
              onPointerUp={stop}
              onClick={stop}
            />
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">No composition selected.</p>
        )}
      </div>

      {/* Floating controls: the tools top left, the view menu top right, the zoom readout bottom right. */}
      <div className="pointer-events-none absolute inset-x-4 top-4 flex items-start justify-between">
        <div className="bg-card/80 border-border/60 pointer-events-auto flex items-center gap-0.5 rounded-full border p-1 shadow-sm backdrop-blur-md" role="toolbar" aria-label="Tools">
          {TOOLS.map(({ id, label, key, icon: Icon }) => (
            <Hint key={id} label={`${label} (${key})`}>
              <Button
                variant={tool === id ? 'secondary' : 'ghost'}
                size="icon-sm"
                aria-label={label}
                aria-pressed={tool === id}
                onClick={() => onToolChange(id)}
                className={cn('rounded-full', tool === id && 'bg-accent text-accent-foreground')}
              >
                <Icon />
              </Button>
            </Hint>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {frameMs !== null && <span className="text-muted-foreground/80 pointer-events-none font-mono text-[11px]">{frameMs.toFixed(0)} ms</span>}
          <Menu>
            <MenuTrigger
              render={
                <Button variant="ghost" size="sm" aria-label="View options" className="bg-card/80 border-border/60 pointer-events-auto rounded-full border px-3 shadow-sm backdrop-blur-md">
                  <EyeIcon />
                  View
                </Button>
              }
            />
            <MenuPopup align="end" className="min-w-56">
              <MenuGroup>
                <MenuGroupLabel>Overlays</MenuGroupLabel>
                <MenuCheckboxItem checked={showGuides} onCheckedChange={(on) => onGuidesChange(on === true)}>
                  Layer controls
                </MenuCheckboxItem>
                <MenuCheckboxItem checked={safeZones} onCheckedChange={(on) => onSafeZonesChange(on === true)}>
                  Safe zones
                </MenuCheckboxItem>
              </MenuGroup>
              <MenuSeparator />
              <MenuGroup>
              <MenuGroupLabel>Zoom</MenuGroupLabel>
              <MenuItem disabled={!comp} onClick={() => onViewChange({ zoom: 'fit', pan: { x: 0, y: 0 } })}>
                Fit
                <MenuShortcut>0</MenuShortcut>
              </MenuItem>
              <MenuItem disabled={!comp} onClick={() => onViewChange({ zoom: 0.5, pan: { x: 0, y: 0 } })}>
                50%
              </MenuItem>
              <MenuItem disabled={!comp} onClick={() => onViewChange({ zoom: 1, pan: { x: 0, y: 0 } })}>
                100%
                <MenuShortcut>1</MenuShortcut>
              </MenuItem>
              <MenuItem disabled={!comp} onClick={() => onViewChange({ zoom: 2, pan: { x: 0, y: 0 } })}>
                200%
              </MenuItem>
              </MenuGroup>
            </MenuPopup>
          </Menu>
        </div>
      </div>

      {comp && shown && (
        <div className="pointer-events-none absolute top-14 right-4 flex items-center gap-2 text-xs">
          <Hint label={fitMode ? 'Show at 100% (1)' : 'Fit to the preview (0)'}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onViewChange({ zoom: fitMode ? 1 : 'fit', pan: { x: 0, y: 0 } })}
              className="bg-card/80 border-border/60 pointer-events-auto rounded-full border px-3 font-mono text-xs shadow-sm backdrop-blur-md"
            >
              <MaximizeIcon />
              {fitMode ? `Fit (${scalePct}%)` : `${scalePct}%`}
            </Button>
          </Hint>
        </div>
      )}

      {frameError && !buildError && (
        <Alert variant="error" className="absolute inset-x-6 bottom-24 w-auto">
          <TriangleAlertIcon />
          <AlertTitle>Frame failed ({frameError.code})</AlertTitle>
          <AlertDescription>{frameError.message}</AlertDescription>
        </Alert>
      )}
      {buildError && (
        <div role="alertdialog" aria-label="Build error" className="bg-stage/90 absolute inset-0 z-10 flex items-center justify-center p-6 backdrop-blur-sm">
          <Alert variant="error" className="bg-card max-h-full max-w-3xl overflow-auto">
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
  );
});
