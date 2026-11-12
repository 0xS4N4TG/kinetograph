// A page whose fetch settles and whose timeout re-arms itself (a tween restarting) rendered for ever: each settled load
// held the frame, and every timeout the page made while it was held was fired at once, the next one too. A still must finish.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000 });
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');
const addon = (() => {
  try {
    createRequire(import.meta.url)('@kinetographdev/native');
    return true;
  } catch {
    return false;
  }
})();
const ready = addon && existsSync(join(here, '..', 'dist', 'hyperframes', 'entry.js'));

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kg-hold-chain-'));
  writeFileSync(join(dir, 'a.txt'), 'x');
  writeFileSync(
    join(dir, 'index.html'),
    `<!doctype html><html><body><div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="64" data-height="36" style="width:64px;height:36px;background:#00f"></div>
<script>
const tick = () => setTimeout(tick, 500);
fetch('a.txt').then((r) => r.text()).then(() => tick());
</script></body></html>`,
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!ready)('a page with a timeout that re-arms itself after a fetch', () => {
  it('renders a still instead of firing its timers for ever', () => {
    const out = spawnSync(process.execPath, [cli, 'still', join(dir, 'index.html'), '0', '-o', join(dir, 'o.png')], { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
    expect(out.status, out.stderr).toBe(0);
    expect(existsSync(join(dir, 'o.png'))).toBe(true);
  });
});
