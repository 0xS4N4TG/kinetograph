import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundleWorkerModule } from '../src/worker-module.js';

describe('bundleWorkerModule', () => {
  it('bundles a module worker and what it imports into one classic script', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-worker-module-'));
    writeFileSync(join(dir, 'shared.ts'), 'export const double = (n: number): number => n * 2;');
    const file = join(dir, 'worker.js');
    const code = 'import { double } from "./shared.ts"; self.postMessage(double(21));';
    writeFileSync(file, code);
    const script = bundleWorkerModule(file, code, `file://${file}`);
    expect(script).not.toMatch(/^\s*import /m);
    const posted: unknown[] = [];
    new Function('self', script)({ postMessage: (value: unknown) => posted.push(value) });
    expect(posted).toEqual([42]);
  });
});
