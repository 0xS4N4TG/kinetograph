// Dawn on a machine with no GPU. macOS has Metal on every Mac. Windows has Direct3D 12's software adapter, WARP, which Dawn gives when it is
// asked for the fallback adapter (`forceFallbackAdapter`; webgpu-dawn.ts `chooseAdapter`). Linux has a software Vulkan driver only when Mesa's
// lavapipe is installed, which Dawn takes as the fallback adapter; else Dawn's Vulkan is given the SwiftShader ICD that the platform package
// already carries for ANGLE (`angle/vk_swiftshader_icd.json`, a path relative to the JSON file). The Vulkan loader reads its driver files when an
// instance is made, so they are set before Dawn's instance is created (webgpu-dawn.ts `createGpu`), and only when no hardware or system
// software adapter was found or KINETOGRAPH_WEBGPU_BACKEND=swiftshader.
//
// The rest of the process (the compositor's wgpu, Skia on wgpu's device, ANGLE, ffmpeg) reads the same environment, so SwiftShader is added
// beside the host's own drivers (`VK_ADD_DRIVER_FILES`, Vulkan loader 1.3.234 and newer), where wgpu, which ranks a CPU adapter last, keeps
// the GPU it had. Only when the host has no Vulkan driver at all is it named in place of them (`VK_DRIVER_FILES`, and `VK_ICD_FILENAMES`, the
// older name, which a loader as old as Ubuntu 22.04's 1.3.204 reads): there is nothing to lose, and the system's loader, which the compositor
// opens, reads those. Dawn opens the loader in its own folder (`dawn/libvulkan.so.1`, copied from the ANGLE files by scripts/fetch-dawn.mjs),
// which reads the addition; a dawn.node from elsewhere (KINETOGRAPH_DAWN_MODULE, KINETOGRAPH_DAWN_DIR) may open a system loader older than
// 1.3.234, which ignores it: on a host with drivers Dawn then finds no SwiftShader and the built-in WebGPU layer draws. The loader of
// an elevated process ignores all of them (the lesson of the ANGLE work); Windows does not need them.

import { existsSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { isMainThread } from 'node:worker_threads';

type Env = Record<string, string | undefined>;

/** KINETOGRAPH_WEBGPU_BACKEND: `swiftshader` forces the software Vulkan driver (Linux). Anything else set is refused with the list. */
export function softwareChoice(env: Env = process.env): 'swiftshader' | null {
  const value = env.KINETOGRAPH_WEBGPU_BACKEND;
  if (!value) return null;
  if (value === 'swiftshader') return 'swiftshader';
  throw new Error(`KINETOGRAPH_WEBGPU_BACKEND=${value} is not a backend; the one there is: swiftshader`);
}

/**
 * The SwiftShader ICD file: in `KINETOGRAPH_ANGLE_DIR`, else the `angle/` folder beside the `dawn/` folder dawn.node was loaded from (the
 * platform package, or `npm/<platform>/` of a checkout). Null when there is none: this platform package was made without SwiftShader.
 */
export function swiftshaderIcd(dawnDir: string | null, env: Env = process.env, platform: string = process.platform): string | null {
  const library = platform === 'win32' ? 'vk_swiftshader.dll' : platform === 'darwin' ? 'libvk_swiftshader.dylib' : 'libvk_swiftshader.so';
  const folders = [env.KINETOGRAPH_ANGLE_DIR, dawnDir === null ? undefined : join(dirname(dawnDir), 'angle')];
  for (const folder of folders) {
    if (!folder || !isAbsolute(folder)) continue;
    const icd = join(folder, 'vk_swiftshader_icd.json');
    if (existsSync(icd) && existsSync(join(folder, library))) return icd;
  }
  return null;
}

const NAMES = ['VK_DRIVER_FILES', 'VK_ICD_FILENAMES', 'VK_ADD_DRIVER_FILES'] as const;

const files = (value: string | undefined): string[] => (value ?? '').split(':').filter(Boolean);

/** The folders the Vulkan loader of Linux reads driver manifests from, as this environment sets them (the loader's LoaderDriverInterface.md). */
export function icdFolders(env: Env = process.env): string[] {
  const home = env.HOME ?? '';
  const config = [env.XDG_CONFIG_HOME || join(home, '.config'), ...(env.XDG_CONFIG_DIRS || '/etc/xdg').split(':'), '/etc'];
  const data = [env.XDG_DATA_HOME || join(home, '.local', 'share'), ...(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')];
  return [...config, ...data].filter((dir) => isAbsolute(dir)).map((dir) => join(dir, 'vulkan', 'icd.d'));
}

/** The loader would find a driver other than `icd`: one its variables name, or, when they name none in place of the folders, a manifest there. */
export function otherVulkanDrivers(icd: string, env: Env = process.env, folders: string[] = icdFolders(env)): boolean {
  const named = env.VK_DRIVER_FILES || env.VK_ICD_FILENAMES;
  if ([...files(named), ...files(env.VK_ADD_DRIVER_FILES)].some((file) => file !== icd)) return true;
  if (named) return false;
  return folders.some((dir) => {
    try {
      return readdirSync(dir).some((name) => name.endsWith('.json'));
    } catch {
      return false;
    }
  });
}

/** What the loader's variables become for SwiftShader: added beside the host's drivers, or named in place of them when the host has none. */
export function swiftshaderEnv(icd: string, env: Env = process.env, folders: string[] = icdFolders(env)): Partial<Record<(typeof NAMES)[number], string>> {
  if (!otherVulkanDrivers(icd, env, folders)) return { VK_DRIVER_FILES: icd, VK_ICD_FILENAMES: icd };
  const added = files(env.VK_ADD_DRIVER_FILES);
  return { VK_ADD_DRIVER_FILES: added.includes(icd) ? added.join(':') : [icd, ...added].join(':') };
}

/** The loader already finds SwiftShader: this process was pointed at it (`keepSwiftshader`, or by hand). */
const pointed = (icd: string, env: Env): boolean => (env.VK_DRIVER_FILES || env.VK_ICD_FILENAMES) === icd || files(env.VK_ADD_DRIVER_FILES).includes(icd);

/** Points the Vulkan loader at the ICD file (its own environment, `process.env`: native code reads the process's). Returns what undoes it. */
export function useSwiftshader(icd: string, env: Env = process.env, folders: string[] = icdFolders(env)): () => void {
  const was = NAMES.map((name) => [name, env[name]] as const);
  Object.assign(env, swiftshaderEnv(icd, env, folders));
  return () => {
    for (const [name, value] of was) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  };
}

/**
 * Runs `make` (the making of a Dawn instance, which reads the Vulkan loader's environment) with the loader on the ICD file, and puts the environment
 * back after, so the rest of the process (the compositor, ANGLE, Skia, ffmpeg) keeps its own drivers. Not when the environment already names it
 * (`keepSwiftshader` set it for the process, or it was set by hand), and never in a worker: there `process.env` is a copy that native code does not read, so the main
 * thread's decision (`keepSwiftshader`, before the workers start) is the one that counts.
 */
export function withSwiftshader<T>(icd: string, make: () => T, env: Env = process.env, main: boolean = isMainThread, folders: string[] = icdFolders(env)): T {
  if (!main || pointed(icd, env)) return make();
  const undo = useSwiftshader(icd, env, folders);
  try {
    return make();
  } finally {
    undo();
  }
}

/** For the whole process, from the main thread before its workers are made: Dawn needs SwiftShader and the workers' instances are made where this thread's real environment applies. */
export function keepSwiftshader(icd: string, env: Env = process.env, main: boolean = isMainThread, folders: string[] = icdFolders(env)): void {
  if (main && !pointed(icd, env)) useSwiftshader(icd, env, folders);
}
