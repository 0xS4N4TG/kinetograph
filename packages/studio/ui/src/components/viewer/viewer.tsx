import { useCallback, useEffect, useRef, useState } from 'react';
import { CrosshairIcon, GridIcon, LockIcon, Maximize2Icon, MenuIcon, TriangleAlertIcon } from 'lucide-react';

import type { CompositionInfo, InspectResult, ReceivedFrame, StudioError } from '@/api';
import { PanelHeader } from '@/components/shell/panel-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { fitSize } from '@/lib/format';
import { findLayer } from '@/lib/inspect';
import { useElementSize } from '@/lib/use-element-size';
import { cn } from '@/lib/utils';

interface ViewerProps {
  comp: CompositionInfo | null;
  onImage(listener: (frame: ReceivedFrame) => void): () => void;
  lastImage(): ReceivedFrame | null;
  /** The latest build's error: covers the preview until the next good build. */
  buildError: StudioError | null;
  /** The last frame request that failed. */
  frameError: StudioError | null;
  inspect?: InspectResult | null;
  selectedLayer?: string | null;
  compositions?: CompositionInfo[];
  onSelectComp?(id: string): void;
}

/** The frames the server renders, drawn on a canvas that scales to fit, over a checkerboard for transparency. */
export function Viewer({
  comp,
  onImage,
  lastImage,
  buildError,
  frameError,
  inspect = null,
  selectedLayer = null,
  compositions = [],
  onSelectComp,
}: ViewerProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const box = useElementSize(boxRef);
  /** Decoding is async: a frame that finishes after a newer one started must not be drawn. */
  const drawn = useRef(0);
  const [frameMs, setFrameMs] = useState<number | null>(null);
  const [showGuides, setShowGuides] = useState(true);
  const [showSafeZones, setShowSafeZones] = useState(false);

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

  const shown = comp ? fitSize(box.width - 32, box.height - 32, comp.width, comp.height) : null;
  const scalePct = comp && shown && comp.width > 0 ? Math.round((shown.width / comp.width) * 100) : 100;
  const scaleRatio = comp && shown && comp.width > 0 ? shown.width / comp.width : 1;

  const activeLayer = inspect && selectedLayer ? findLayer(inspect.layers, selectedLayer) : null;
  const layerBounds = activeLayer?.bounds ?? activeLayer?.box ?? null;

  return (
    <div className="bg-card flex min-h-0 flex-1 flex-col select-none">
      <PanelHeader
        title={
          <div className="flex h-full items-center gap-4">
            <div className="border-primary text-foreground flex h-full items-center gap-1.5 border-b-2 px-1 font-medium">
              <span>Composition {comp ? comp.id : ''}</span>
              <MenuIcon className="text-muted-foreground size-3" aria-hidden="true" />
            </div>
            <span className="text-muted-foreground text-[11px]">Program Monitor</span>
          </div>
        }
      >
        <div className="flex items-center gap-2 font-mono text-[10px]">
          <span className="text-muted-foreground flex items-center gap-1 rounded-xs bg-white/[0.04] px-1.5 py-0.5">
            <LockIcon className="size-2.5 text-amber-400/80" aria-hidden="true" />
            <span>Preview Only</span>
          </span>
          {frameMs !== null && <span className="text-muted-foreground">{frameMs.toFixed(0)} ms</span>}
        </div>
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
              onClick={() => setShowSafeZones((v) => !v)}
              title="Toggle Title/Action Safe Guides"
              className={cn(
                'flex items-center gap-1 rounded-xs px-1.5 py-0.5 text-[10px] transition-colors',
                showSafeZones ? 'bg-nle-blue/25 text-sky-300' : 'text-muted-foreground hover:text-foreground',
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
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#101013] p-4"
      >
        {comp && shown ? (
          <div
            className="relative overflow-hidden bg-[repeating-conic-gradient(#18181c_0%_25%,#202026_0%_50%)] bg-[length:16px_16px] shadow-[0_12px_40px_rgba(0,0,0,0.65)] ring-1 ring-white/15"
            style={{ width: shown.width, height: shown.height }}
          >
            <canvas
              ref={canvasRef}
              data-testid="preview-canvas"
              className="block size-full"
              width={comp.width}
              height={comp.height}
            />

            {/* Optional Broadcast Action/Title Safe Overlay */}
            {showSafeZones && (
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
                <span className="absolute -top-5 left-0 rounded-xs bg-rose-500 px-1.5 py-0.5 font-mono text-[9px] leading-none font-medium text-white shadow">
                  {activeLayer.id}
                </span>
              </div>
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

        {/* Bottom-left & bottom-right subtle viewport HUD badges */}
        {comp && shown && (
          <div className="pointer-events-none absolute inset-x-3 bottom-2 flex items-center justify-between font-mono text-[10px] text-white/50" aria-hidden="true">
            <span className="flex items-center gap-1 rounded-xs bg-black/50 px-1.5 py-0.5 backdrop-blur-xs">
              <Maximize2Icon className="size-2.5" />
              Fit ({scalePct}%)
            </span>
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
