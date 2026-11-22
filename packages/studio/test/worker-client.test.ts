import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { WorkerClient } from '../src/worker-client.js';
import { cleanup, tempDir } from './helpers.js';

afterAll(cleanup);

/** An engine module whose `compositions` never answers and whose `dispose` leaves a file behind. */
function engine(dir: string): string {
  const file = join(dir, 'engine.mjs');
  const disposed = JSON.stringify(join(dir, 'disposed'));
  writeFileSync(
    file,
    `import { writeFileSync } from 'node:fs';\n` +
      `export function createEngine() {\n` +
      `  return { compositions: () => new Promise(() => {}), dispose: () => writeFileSync(${disposed}, '') };\n` +
      `}\n`,
  );
  return file;
}

describe('WorkerClient.close', () => {
  it('stops a worker whose call never answers', async () => {
    const dir = tempDir();
    const client = new WorkerClient({ role: 'project', engine: engine(dir), options: { entry: join(dir, 'p.ts'), bundleFile: null } });
    const call = client.call({ op: 'compositions' });
    call.catch(() => undefined);
    await client.close(200);
    await expect(call).rejects.toThrow();
    expect(existsSync(join(dir, 'disposed'))).toBe(false);
  });

  it("disposes an idle worker's engine on its thread before stopping it", async () => {
    const dir = tempDir();
    const client = new WorkerClient({ role: 'project', engine: engine(dir), options: { entry: join(dir, 'p.ts'), bundleFile: null } });
    // The engine is made on the first call; this one answers with an error (no composition by that name is asked).
    await client.call({ op: 'plan', comp: 'none', props: {} }).catch(() => undefined);
    await client.close(5_000);
    expect(existsSync(join(dir, 'disposed'))).toBe(true);
  });
});
