// jsdom has neither a 2D canvas nor createImageBitmap. These stand-ins record what the preview draws: a decoded frame is
// `{ size, type }` of the Blob it came from, and the mock server makes a frame's byte length say which request it answers.

export interface FakeBitmap {
  size: number;
  type: string;
  closed: boolean;
  width: number;
  height: number;
  close(): void;
}

export const draws: FakeBitmap[] = [];

/** How long decoding takes, ms; tests raise it to make decodes finish out of order. */
export const decode = { delay: (_size: number): number => 0 };

export function installCanvasStubs(): void {
  globalThis.createImageBitmap = ((blob: Blob) =>
    new Promise<FakeBitmap>((resolve) => {
      const bitmap: FakeBitmap = {
        size: blob.size,
        type: blob.type,
        closed: false,
        width: 1,
        height: 1,
        close() {
          bitmap.closed = true;
        },
      };
      const ms = decode.delay(blob.size);
      if (ms > 0) setTimeout(() => resolve(bitmap), ms);
      else resolve(bitmap);
    })) as unknown as typeof createImageBitmap;

  HTMLCanvasElement.prototype.getContext = function getContext() {
    return {
      drawImage: (bitmap: FakeBitmap) => {
        draws.push(bitmap);
      },
    };
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
}
