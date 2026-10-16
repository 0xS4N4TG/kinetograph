// `@remotion/media-parser/worker`: `parseMedia` in a Web Worker. There is no worker here, so it parses in place.
export { hasBeenAborted, IsAnImageError, IsAnUnsupportedFileTypeError, IsAPdfError, MediaParserAbortError } from './errors.js';
export type { ParseMediaOnWorker, ParseMediaOnWorkerOptions } from './types.js';
export { parseMedia as parseMediaOnWebWorker } from './parse-media.js';
