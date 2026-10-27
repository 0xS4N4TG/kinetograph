// ES module scripts and import maps of a HyperFrames page (filled in by the module support).

import type { FetchedDep, FetchOptions } from './deps.js';

/** A `<script type="importmap">`: bare names and prefixes to URLs, and per-referrer overrides. */
export interface ImportMap {
  imports: Record<string, string>;
  scopes: Record<string, Record<string, string>>;
}

/** A `<script type="module">` of the page. */
export interface ModuleScript {
  /** The source of an inline script, or null for a `src`. */
  code: string | null;
  /** The script's URL (https) or absolute file path, or the HTML file for an inline script. */
  url: string;
  /** The directory relative imports resolve from, for a local script. */
  dir: string;
}

export async function fetchModuleGraph(_modules: ModuleScript[], _map: ImportMap, _options: FetchOptions): Promise<FetchedDep[]> {
  return [];
}
