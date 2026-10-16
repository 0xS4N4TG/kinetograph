// The readers of `@remotion/media-parser` (`nodeReader` from `/node`, `webReader` from `/web`, `universalReader` from
// `/universal`) and the one place a `src` becomes a file. Kinetograph renders offline, so there is one kind of source,
// a file on disk: the three readers are the same reader, and a URL is the "renders offline" error (`remoteMessage`).

import { createReadStream, existsSync, promises as fs, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { remoteMessage } from '@kinetograph/compat/shim';
import { UnsupportedApiError } from '../unsupported.js';
import type { MediaParserReaderInterface, ParseMediaSrc } from './types.js';

const REMOTE = /^(https?|wss?|ftp):\/\//i;

/** The path a `src` names: a path, a `file:` URL or a `URL` of one. Anything remote, or a `Blob`, is an error. */
export function sourcePath(src: ParseMediaSrc, api = 'parseMedia'): string {
  if (typeof src === 'string') {
    if (REMOTE.test(src)) throw new Error(remoteMessage(api, src));
    return src.startsWith('file:') ? fileURLToPath(src) : src;
  }
  if (src instanceof URL) {
    if (src.protocol === 'file:') return fileURLToPath(src);
    throw new Error(remoteMessage(api, src.href));
  }
  throw new UnsupportedApiError('@remotion/media-parser', `${api}() with a Blob as src`, 'only the path of a file on disk can be read');
}

const readContent: MediaParserReaderInterface['read'] = async ({ src, range, controller }) => {
  const path = sourcePath(src);
  if (!existsSync(path)) throw new Error(`File does not exist: ${path}`);
  const start = range === null ? 0 : typeof range === 'number' ? range : range[0];
  const end = range === null || typeof range === 'number' ? Infinity : range[1];
  const stream = createReadStream(path, { start, end });
  const reader = (Readable.toWeb(stream) as ReadableStream<Uint8Array>).getReader();
  controller._internals.signal.addEventListener('abort', () => void reader.cancel().catch(() => {}), { once: true });
  return {
    reader: {
      reader,
      abort: async () => {
        try {
          stream.destroy();
          await reader.cancel();
        } catch {
          // Already closed.
        }
      },
    },
    contentLength: statSync(path).size,
    contentType: null,
    name: basename(path),
    supportsContentRange: true,
    needsContentRange: true,
  };
};

const reader: MediaParserReaderInterface = {
  read: readContent,
  readWholeAsText: (src) => fs.readFile(sourcePath(src), 'utf8'),
  createAdjacentFileSource: (relativePath, src) => {
    const path = sourcePath(src);
    const result = join(dirname(path), relativePath);
    if (relative(dirname(path), result).startsWith('..')) {
      throw new Error('Path is outside of the parent directory - not allowing reading of arbitrary files');
    }
    return result;
  },
  preload: () => {},
};

export const nodeReadContent = reader.read;
export const nodeReadWholeAsText = reader.readWholeAsText;
export const nodeCreateAdjacentFileSource = reader.createAdjacentFileSource;
export const nodeReader: MediaParserReaderInterface = reader;
export const webReader: MediaParserReaderInterface = reader;
export const universalReader: MediaParserReaderInterface = reader;
