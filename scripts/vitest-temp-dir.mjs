// A vitest globalSetup: the run's temp dir. Each run gets a fresh directory under /tmp, given to the tests and to the
// processes they start as TMPDIR, and removed when the run ends. Not the OS temp dir on macOS (/var/folders/.../T):
// esbuild reads the whole listing of every directory above a project it builds, and that per-user dir can hold tens
// of thousands of entries (every suite's leftovers); builds in parallel test files then wait on each other's reads of
// it, and tests time out. /tmp is what Linux uses anyway, and like the OS temp dir it has no package.json or
// node_modules above it, so a test project resolves as it would there. Windows keeps its own temp dir.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default function setup() {
  const dir = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'kinetograph-test-run-'));
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = dir;
  return () => rmSync(dir, { recursive: true, force: true });
}
