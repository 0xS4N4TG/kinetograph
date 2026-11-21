import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { bundleModuleScript, emptyImportMap } from '../src/hyperframes/modules.js';

describe('a module script is evaluated as a browser evaluates it', () => {
  it('runs the top-level code of a module whose export nothing uses, as three.js has (new Texture() draws Math.random for its uuid)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kg-module-eval-'));
    try {
      writeFileSync(join(dir, 'lib.js'), 'export class Texture { constructor() { globalThis.draws = (globalThis.draws ?? 0) + 4; } }\nexport const empty = /*@__PURE__*/ new Texture();\nexport const used = 1;\n');
      const file = join(dir, 'page.html');
      const { code } = await bundleModuleScript({ code: 'import { used } from "./lib.js"; globalThis.used = used;', file, base: pathToFileURL(file).href, scope: null, sourceFile: null, root: dir }, emptyImportMap());
      const sandbox: Record<string, unknown> = {};
      sandbox.globalThis = sandbox;
      vm.runInNewContext(code, sandbox);
      expect(sandbox.used).toBe(1);
      // A bundle that drops the unused `empty` leaves a page's Math.random sequence shorter than a browser's.
      expect(sandbox.draws).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
