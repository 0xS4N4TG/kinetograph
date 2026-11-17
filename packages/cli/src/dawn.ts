// WebGPU through Dawn (KINETOGRAPH_WEBGPU=dawn): the CLI's side. The library is the CLI's optional dependency, found from here and not from
// the folder of a project's bundle; `doctor` says which adapter it gives.

import { createRequire } from 'node:module';
import { dawnRequested, describeDawn, setDawnLoader, type DawnStatus } from '@kinetographdev/compat/shim';

/** Sets how the compat module (a copy of it sits in each project's bundle) finds the library; before a bundle runs, which installs `navigator.gpu` as it loads. */
export function useCliDawn(): void {
  setDawnLoader(() => createRequire(import.meta.url)('webgpu'));
}

/** What `doctor` says of Dawn: null unless it is the provider. */
export async function dawnReport(): Promise<{ data: DawnStatus; lines: string[] } | null> {
  if (!dawnRequested()) return null;
  useCliDawn();
  const status = await describeDawn();
  if (!status.ok) return { data: status, lines: [`webgpu: Dawn cannot be used: ${status.error}`] };
  const { adapter, flags } = status;
  const name = [adapter.vendor, adapter.device].filter(Boolean).join(' ') || 'an adapter with no name';
  return {
    data: status,
    lines: [
      `webgpu: Dawn on ${adapter.backend ?? 'the backend it chose'}: ${name}${adapter.software ? ' (software, on the CPU)' : ''}${adapter.description ? `, ${adapter.description}` : ''}`,
      `  flags: ${flags.length === 0 ? 'none' : flags.join(' ')}; KINETOGRAPH_DAWN_BACKEND and KINETOGRAPH_DAWN_ADAPTER change them`,
    ],
  };
}
