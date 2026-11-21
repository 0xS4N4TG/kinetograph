// Dawn on a machine with no GPU. macOS has Metal on every Mac. Windows has Direct3D 12's software adapter, WARP, which Dawn gives when it is
// asked for the fallback adapter (`forceFallbackAdapter`; webgpu-dawn.ts `chooseAdapter`). Linux has no software Vulkan driver of its own, so Dawn's
// Vulkan is pointed at the SwiftShader ICD that the platform package already carries for ANGLE (`angle/vk_swiftshader_icd.json`, a path
// relative to the JSON file): `VK_DRIVER_FILES` (and `VK_ICD_FILENAMES`, the older name) say which driver files the Vulkan loader reads.
// They are read when a Vulkan instance is made, so they are set before Dawn's instance is created (webgpu-dawn.ts `createGpu`), and only when no
// hardware adapter was found or KINETOGRAPH_WEBGPU_BACKEND=swiftshader. The loader of an elevated Windows process ignores them
// (the lesson of the ANGLE work); Windows does not need them.

import { existsSync } from 'node:fs';
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

const NAMES = ['VK_DRIVER_FILES', 'VK_ICD_FILENAMES'] as const;

/** Points the Vulkan loader at the ICD file (its own environment, `process.env`: native code reads the process's). Returns what undoes it. */
export function useSwiftshader(icd: string, env: Env = process.env): () => void {
  const was = NAMES.map((name) => [name, env[name]] as const);
  for (const name of NAMES) env[name] = icd;
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
 * (`keepSwiftshader` set it for the process), and never in a worker: there `process.env` is a copy that native code does not read, so the main
 * thread's decision (`keepSwiftshader`, before the workers start) is the one that counts.
 */
export function withSwiftshader<T>(icd: string, make: () => T, env: Env = process.env, main: boolean = isMainThread): T {
  if (!main || env.VK_DRIVER_FILES === icd) return make();
  const undo = useSwiftshader(icd, env);
  try {
    return make();
  } finally {
    undo();
  }
}

/** For the whole process, from the main thread before its workers are made: Dawn needs SwiftShader and the workers' instances are made where this thread's real environment applies. */
export function keepSwiftshader(icd: string, env: Env = process.env, main: boolean = isMainThread): void {
  if (main) useSwiftshader(icd, env);
}
