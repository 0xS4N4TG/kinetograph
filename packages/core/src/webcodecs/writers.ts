// `bufferWriter` of `@remotion/webcodecs/buffer`, which keeps what it is given in memory, and `webFsWriter` of
// `/web-fs`, which keeps it in the browser's origin-private file system (there is none here).

import { Log } from '../media-parser/log.js';
import type { WriterInterface } from '../media-parser/index.js';
import { UnsupportedApiError } from '../unsupported.js';

export const bufferWriter: WriterInterface = {
  createContent: async ({ logLevel }) => {
    let bytes = new Uint8Array(1 << 16);
    let size = 0;
    const room = (end: number) => {
      if (end <= bytes.length) return;
      const grown = new Uint8Array(Math.max(end, bytes.length * 2));
      grown.set(bytes.subarray(0, size));
      bytes = grown;
    };
    return {
      write: async (data) => {
        room(size + data.length);
        bytes.set(data, size);
        size += data.length;
        Log.verbose(logLevel, 'Wrote', data.length, 'bytes to a buffer');
      },
      updateDataAt: async (position, data) => {
        room(position + data.length);
        bytes.set(data, position);
        size = Math.max(size, position + data.length);
      },
      getWrittenByteCount: () => size,
      finish: async () => {},
      remove: async () => {
        size = 0;
      },
      getBlob: async () => new Blob([bytes.slice(0, size)]),
    };
  },
};

export const webFsWriter: WriterInterface = {
  createContent: async () => {
    throw new UnsupportedApiError('@remotion/webcodecs', 'webFsWriter', "the browser's file system does not exist here; use bufferWriter or nodeWriter()");
  },
};

/** Whether the origin-private file system can be written to: it cannot. */
export const canUseWebFsWriter = async (): Promise<boolean> => false;
