// @kinetograph/studio: the studio server (docs/AUTHORING.md §11.5). Stream 3
// writes the server under `src/server/`; the UI is `ui/` (stream 4), whose
// built files the server serves.

export type * from './protocol.js';
export { decodeFrameMessage, encodeFrameMessage } from './protocol.js';

export interface StudioOptions {
  /** The project entry (`.tsx`, `.ts`, `.jsx`, `.js`) or a `.json` scene. */
  entry: string;
  /** Default 3000. */
  port?: number;
  /** Default `127.0.0.1`. */
  host?: string;
  /** Open the browser. Default true. */
  open?: boolean;
  /** Merged over each composition's `defaultProps`, as `--props`. */
  props?: Record<string, unknown>;
}

export interface StudioServer {
  /** `http://host:port/`. */
  url: string;
  /** Stops watching, closes the sockets and the workers. */
  close(): Promise<void>;
}

export function startStudio(_options: StudioOptions): Promise<StudioServer> {
  throw new Error('not implemented: startStudio (docs/AUTHORING.md §11.5)');
}
