// @kinetographdev/studio: the studio server (packages/cli/skills/kinetograph/references/AUTHORING.md §11.5). The UI is `ui/`, whose built files the
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
  /** The command that starts the coding agent the chat panel talks to (it must speak ACP on stdio), as `--agent`. */
  agent?: string;
  /** The directory the agent works in and may read and write; default the directory the studio was started in. */
  agentCwd?: string;
  /** Allow the agent although the studio listens on an address other computers can reach. Default false. */
  allowRemoteAgent?: boolean;
  /** How long a conversation waits for its window to come back (a reload) before the agent stops, in ms. Default 30 000. */
  agentReclaimMs?: number;
  /**
   * The plugin catalog Studio lists under "Available". `url` defaults to `KINETOGRAPH_CATALOG_URL`, else the site's
   * `/api/catalog`; `cacheFile` to `~/.cache/kinetograph/plugin-catalog.json`; `offline` to `KINETOGRAPH_OFFLINE=1`
   * (then nothing is fetched). Tests replace `fetch` and `cacheFile`.
   */
  catalog?: { url?: string; cacheFile?: string; offline?: boolean; fetch?: typeof fetch; timeoutMs?: number; bundledFile?: string };
  /** Receives one line for each build, build failure and warning. */
  log?: (message: string) => void;
}

export interface StudioServer {
  /** `http://host:port/?token=…`: the address to open. The token is made for each launch and is needed for the agent. */
  url: string;
  /** Stops watching, closes the sockets and the workers. */
  close(): Promise<void>;
}
