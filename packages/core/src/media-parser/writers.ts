// `nodeWriter` of `@remotion/media-parser/node-writer`: a writer that puts the bytes it is given into a file.

import { promises as fs } from 'node:fs';
import { Log } from './log.js';
import type { CreateContent, Writer } from './types.js';

export const nodeWriter = (path: string): { createContent: CreateContent } => ({
  createContent: async ({ logLevel }) => {
    Log.verbose(logLevel, 'Creating file', path);
    await fs.rm(path, { force: true });
    const handle = await fs.open(path, 'w');
    let written = 0;
    // Writes go one after the other, whatever order they are asked for in.
    let queue: Promise<unknown> = Promise.resolve();
    const enqueue = (work: () => Promise<unknown>): Promise<void> => {
      queue = queue.then(work);
      return queue as Promise<void>;
    };

    const writer: Writer = {
      write: (data) =>
        enqueue(async () => {
          await handle.write(data, 0, data.length, null);
          written += data.byteLength;
          Log.verbose(logLevel, 'Wrote', data.length, 'bytes to', path);
        }),
      updateDataAt: (position, data) =>
        enqueue(async () => {
          await handle.write(data, 0, data.length, position);
          Log.verbose(logLevel, 'Wrote', data.length, 'bytes to', path, 'at position', position);
        }),
      getWrittenByteCount: () => written,
      remove: async () => {
        Log.verbose(logLevel, 'Removing file', path);
        await fs.rm(path, { force: true });
      },
      finish: async () => {
        await queue;
        Log.verbose(logLevel, 'Closing file', path);
        await handle.close();
      },
      getBlob: async () => new Blob([await fs.readFile(path)]),
    };
    return writer;
  },
});
