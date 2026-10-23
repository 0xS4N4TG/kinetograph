import { CliError } from '../errors.js';
import { parseProps } from '../source.js';
import { ENTRY, type Command } from './types.js';

/** What the command needs of `@kinetograph/studio` (its `startStudio`, packages/cli/skills/kinetograph/references/AUTHORING.md §11.5). */
export interface StudioModule {
  startStudio(options: {
    entry: string;
    port?: number;
    host?: string;
    open?: boolean;
    props?: Record<string, unknown>;
    log?: (message: string) => void;
  }): Promise<{ url: string; close(): Promise<void> }>;
}

// The studio depends on this package (its types and its bundling), so this package cannot depend on the studio: it
// is loaded by name when the command runs, and the specifier is not a literal so that the compiler does not look
// for its types.
const STUDIO = '@kinetograph/studio';

async function loadStudio(): Promise<StudioModule> {
  try {
    return (await import(/* @vite-ignore */ STUDIO)) as StudioModule;
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') {
      throw new CliError(
        'STUDIO_UNAVAILABLE',
        `cannot load ${STUDIO}: ${(error as Error).message}. Install it next to kinetograph (npm install ${STUDIO}).`,
      );
    }
    throw error;
  }
}

/** Resolves when the process is asked to stop (Ctrl-C, SIGTERM). */
function untilStopped(): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

const hooks = { load: loadStudio, waitForStop: untilStopped };

/** Tests put a stand-in studio, and a way to stop it, here. */
export function setStudioForTests(stub: Partial<typeof hooks> | undefined): void {
  hooks.load = stub?.load ?? loadStudio;
  hooks.waitForStop = stub?.waitForStop ?? untilStopped;
}

function port(value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 65535)) {
    throw new CliError('INVALID_ARG', `--port must be a whole number from 0 to 65535, got ${value}`);
  }
  return value;
}

export const studio: Command = {
  name: 'studio',
  summary: 'Open the studio: preview, timeline, scene tree, props and render queue in a browser',
  project: false,
  positionals: [ENTRY],
  options: [
    { name: 'port', type: 'number', description: 'Port to listen on (default 3000; 0 picks a free one)' },
    { name: 'host', type: 'string', description: 'Address to listen on (default 127.0.0.1)' },
    { name: 'no-open', type: 'boolean', description: 'Do not open the browser' },
    { name: 'props', type: 'string', description: 'Input props as a JSON object, merged over each composition\'s defaultProps' },
  ],
  async run(args, context) {
    // Everything that can be wrong with the arguments is reported before anything starts.
    const listenPort = port(args.options.port as number | undefined);
    const props = args.options.props === undefined ? undefined : parseProps(args.options.props as string);
    const host = args.options.host as string | undefined;
    if (host === '') throw new CliError('INVALID_ARG', '--host must not be empty');

    const { startStudio } = await hooks.load();
    const server = await startStudio({
      entry: String(args.positionals.entry),
      port: listenPort,
      host,
      open: args.options['no-open'] !== true,
      props,
      log: context.progress,
    });
    context.announce({ url: server.url }, `kinetograph studio: ${server.url} (Ctrl-C to stop)`);
    await hooks.waitForStop();
    await server.close();
    return { data: { url: server.url }, text: 'studio stopped' };
  },
};
