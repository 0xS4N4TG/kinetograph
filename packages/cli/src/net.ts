// The network store of a project (`.kinetograph/net` beside its entry): `fetch-deps --record` fills it by running every frame
// with the network open for named hosts; every other step reads it back and never reaches the network (compat's net-store.ts).
// `kinetograph.lock.json` pins its index in one entry, so the lock does not grow with the number of responses.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { INDEX_FILE, type NetConfig } from '@kinetographdev/compat/shim';
import { lockPathOf, readLock, recordInLock } from '@kinetographdev/core/lock';

/** The key of the store's index in the lock. */
export const NET_LOCK_KEY = 'net:index';

export const netDirOf = (entry: string): string => join(dirname(entry), '.kinetograph', 'net');

/** What a project's bundle exports of the shim: its own copy, the one the page's `fetch` reads. */
export interface NetShim {
  setNetStore(config: NetConfig | null): void;
  setNetFrame(frame: number | null): void;
  finishNetRecord(): { sha256: string; size: number; entries: number; hosts: string[] };
  whenFetchesSettle(): Promise<void>;
}

let shim: NetShim | null = null;
let recording: { allowHosts: string[]; secretParams: string[]; keepParams: string[]; onWarn?: (message: string) => void } | null = null;

/**
 * Called as a project loads: a record pass in progress records, otherwise a store beside the entry is replayed (checked
 * against the lock), and with none the shim refuses a remote `fetch` as before. `warn` hears of a store recorded for another bundle.
 */
export function installNet(entry: string, bundleFile: string, mod: NetShim, warn?: (message: string) => void): void {
  shim = mod;
  const dir = netDirOf(entry);
  const bundleSha = createHash('sha256').update(readFileSync(bundleFile)).digest('hex');
  const shown = relative(process.cwd(), entry) || entry;
  const common: Pick<NetConfig, 'dir' | 'bundleSha' | 'hint'> = {
    dir,
    bundleSha,
    hint: (host) => `kinetograph fetch-deps ${shown} --record --allow-host ${host}`,
  };
  if (recording !== null) {
    mod.setNetStore({ ...common, mode: 'record', ...recording });
  } else if (existsSync(join(dir, INDEX_FILE))) {
    const pinned = readLock(lockPathOf(entry)).files[NET_LOCK_KEY];
    mod.setNetStore({ ...common, mode: 'replay', indexSha256: pinned?.sha256, onStale: warn });
  } else {
    mod.setNetStore(null);
  }
}

/** Runs every frame of the project with the network open for `allowHosts`, then writes the store and pins its index. */
export async function recordNet(
  entry: string,
  options: { allowHosts: string[]; secretParams: string[]; keepParams: string[]; progress?: (message: string) => void },
): Promise<{ dir: string; entries: number; hosts: string[]; frames: number }> {
  const { openSource } = await import('./source.js');
  recording = { allowHosts: options.allowHosts, secretParams: options.secretParams, keepParams: options.keepParams, onWarn: options.progress };
  try {
    const source = await openSource(entry, { progress: options.progress });
    try {
      const frames = source.composition.durationInFrames;
      for (let frame = 0; frame < frames; frame++) {
        await source.frame(frame);
        await shim!.whenFetchesSettle();
      }
      const done = shim!.finishNetRecord();
      recordInLock(lockPathOf(entry), NET_LOCK_KEY, { sha256: done.sha256, size: done.size });
      return { dir: netDirOf(entry), entries: done.entries, hosts: done.hosts, frames };
    } finally {
      source.dispose();
    }
  } finally {
    recording = null;
    shim?.setNetStore(null);
    shim?.setNetFrame(null);
  }
}
