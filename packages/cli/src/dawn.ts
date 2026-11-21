// WebGPU through Dawn (the default; KINETOGRAPH_WEBGPU=builtin picks the built-in layer): the CLI's side. dawn.node is in the addon's platform package, found from here and not from
// the folder of a project's bundle; `doctor` says which adapter it gives.

import { isMainThread } from 'node:worker_threads';
import { dawnRequested, describeDawn, loadDawnBinary, setDawnLoader, type DawnAdapter, type DawnStatus } from '@kinetographdev/compat/shim';

/** Sets how the compat module (a copy of it sits in each project's bundle) finds the library; before a bundle runs, which installs `navigator.gpu` as it loads. */
export function useCliDawn(): void {
  setDawnLoader(() => loadDawnBinary(import.meta.url));
}

/**
 * Dawn as the provider, decided once before a project runs: when no adapter can be had (no GPU and no software fallback, no binary for this
 * platform) the built-in WebGPU layer draws instead, with one warning, because `KINETOGRAPH_WEBGPU` is set to `builtin` in the environment the render's
 * threads and processes inherit. Only the main thread decides; a worker takes what the environment says.
 */
export async function prepareCliDawn(say: (message: string) => void = (message) => process.stderr.write(`${message}\n`)): Promise<void> {
  useCliDawn();
  if (!dawnRequested() || !isMainThread) return;
  const status = await describeDawn();
  if (status.ok) return;
  process.env.KINETOGRAPH_WEBGPU = 'builtin';
  say(`warning: WebGPU through Dawn cannot be used here, so the built-in WebGPU layer draws this render instead: ${status.error.replace(/^Dawn: /, '').replace(/\s*KINETOGRAPH_WEBGPU=builtin uses the built-in WebGPU\.?$/, '')}`);
}

const VIA: Record<DawnAdapter['via'], string> = {
  hardware: 'a hardware adapter',
  swiftshader: 'SwiftShader, the software Vulkan driver of the platform package',
  warp: 'WARP, the software Direct3D 12 adapter of Windows',
  'system-software': 'a software adapter the system has',
};

/** What `doctor` says of Dawn: null when KINETOGRAPH_WEBGPU=builtin picks the built-in layer. */
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
      `webgpu: Dawn on ${adapter.backend ?? 'the backend it chose'}: ${name}${adapter.software ? ` (software, on the CPU: ${VIA[adapter.via]})` : ''}${adapter.description ? `, ${adapter.description}` : ''}`,
      `  flags: ${flags.length === 0 ? 'none' : flags.join(' ')}; KINETOGRAPH_DAWN_BACKEND and KINETOGRAPH_DAWN_ADAPTER change them`,
    ],
  };
}
