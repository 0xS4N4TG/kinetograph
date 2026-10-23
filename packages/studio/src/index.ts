// @kinetographdev/studio: the studio server (packages/cli/skills/kinetograph/references/AUTHORING.md §11.5). The UI is `ui/` (stream 4), whose built files the
// server serves.

export type * from './protocol.js';
export { decodeFrameMessage, encodeFrameMessage } from './protocol.js';
export { startStudio } from './server.js';
export type { Engine, EngineOptions, CreateEngine, FrameScene, RenderSpec } from './engine.js';
export { openerCommand } from './open-browser.js';

export interface StudioOptions {
  /** The project entry (`.tsx`, `.ts`, `.jsx`, `.js`) or a `.json` scene. */
  entry: string;
  /** Default 3000; 0 picks a free port. */
  port?: number;
  /** Default `127.0.0.1`. */
  host?: string;
  /** Open the browser. Default true. */
  open?: boolean;
  /** Merged over each composition's `defaultProps`, as `--props`. */
  props?: Record<string, unknown>;
  /** The engine module the workers load (default: the real one, which drives the CLI and the addon). Tests name a
   * stub that opens no GPU; see `engine.ts`. */
  engine?: string;
  /** Receives one line for each build, build failure and warning. */
  log?: (message: string) => void;
}

export interface StudioServer {
  /** `http://host:port/`. */
  url: string;
  /** Stops watching, closes the sockets and the workers. */
  close(): Promise<void>;
}
