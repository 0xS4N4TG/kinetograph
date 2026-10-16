// `@remotion/media-parser/server-worker`: `parseMedia` in a Node worker thread. It parses in place.
export type { ParseMediaOnWorker, ParseMediaOnWorkerOptions } from './types.js';
export { parseMedia as parseMediaOnServerWorker } from './parse-media.js';
