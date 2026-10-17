import { useCallback, useEffect, useRef } from 'react';
import { TriangleAlertIcon } from 'lucide-react';

import type { CompositionInfo, ReceivedFrame, StudioError } from '@/api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { fitSize } from '@/lib/format';
import { useElementSize } from '@/lib/use-element-size';

interface PreviewProps {
  comp: CompositionInfo | null;
  onImage(listener: (frame: ReceivedFrame) => void): () => void;
  lastImage(): ReceivedFrame | null;
  /** The latest build's error: covers the preview until the next good build. */
  buildError: StudioError | null;
  /** The last frame request that failed. */
  frameError: StudioError | null;
}

/** The frames the server renders, drawn on a canvas that scales to fit, over a checkerboard for transparency. */
export function Preview({ comp, onImage, lastImage, buildError, frameError }: PreviewProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const box = useElementSize(boxRef);
  /** Decoding is async: a frame that finishes after a newer one started must not be drawn. */
  const drawn = useRef(0);

  const draw = useCallback(async (frame: ReceivedFrame) => {
    const ticket = ++drawn.current;
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

  return (
    <div ref={boxRef} data-testid="preview" className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
      {comp && shown ? (
        <div
          className="overflow-hidden rounded-xl bg-[repeating-conic-gradient(var(--background)_0%_25%,var(--secondary)_0%_50%)] bg-[length:16px_16px] shadow-2xl ring-1 ring-white/10"
          style={{ width: shown.width, height: shown.height }}
        >
          <canvas
            ref={canvasRef}
            data-testid="preview-canvas"
            className="block size-full"
            width={comp.width}
            height={comp.height}
          />
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">No composition selected.</p>
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
  );
}
