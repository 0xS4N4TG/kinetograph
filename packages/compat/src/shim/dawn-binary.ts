// Where Dawn's binary is and how it is loaded. dawn.node ships in the `dawn/` folder of the addon's platform package
// (scripts/fetch-dawn.mjs puts it there, as scripts/fetch-angle.mjs puts ANGLE in `angle/`); it is loaded by full path, so
// neither the working directory nor a project's `node_modules` decides which binary runs. `KINETOGRAPH_DAWN_DIR` names another
// folder holding a `dawn.node`.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';

type Any = any; // Dawn's objects are native classes with no TypeScript surface here.

/** A message that already says what is wrong and what to do (`dawnLoadMessage` passes it on as it is). */
export class DawnBinaryError extends Error {}

/** The platform package this process runs on, as `scripts/fetch-dawn.mjs` names it, or null where Dawn has no binary. */
export function dawnPlatform(platform: string = process.platform, arch: string = process.arch): string | null {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64-gnu';
  if (platform === 'win32' && arch === 'x64') return 'win32-x64-msvc';
  return null;
}

/**
 * The folder holding dawn.node: `KINETOGRAPH_DAWN_DIR`, else `dawn/` of the installed platform package, else of `npm/<platform>/` in a source
 * checkout (beside `@kinetographdev/native`). `from` is the URL resolution starts at (the CLI's, not a project bundle's).
 */
export function dawnDirectory(from: string = import.meta.url, env: Record<string, string | undefined> = process.env): string {
  const file = 'dawn.node';
  const override = env.KINETOGRAPH_DAWN_DIR;
  if (override) {
    if (!isAbsolute(override)) throw new DawnBinaryError(`KINETOGRAPH_DAWN_DIR must be an absolute path, got ${JSON.stringify(override)}`);
    if (!existsSync(join(override, file))) throw new DawnBinaryError(`KINETOGRAPH_DAWN_DIR=${override} has no ${file}`);
    return override;
  }
  const platform = dawnPlatform();
  if (platform === null) {
    throw new DawnBinaryError(`there is no Dawn binary for this platform (${process.platform}-${process.arch}); it ships for macOS arm64, Linux x64 (glibc) and Windows x64`);
  }
  const found = platformFolder('dawn', file, from, platform);
  if (found.dir !== null) return found.dir;
  throw new DawnBinaryError(
    `no ${file} in the platform package (${found.tried.length === 0 ? `@kinetographdev/native-${platform} is not installed` : `looked in ${found.tried.join(', ')}`}); reinstall kinetograph, or in a source checkout run \`node scripts/fetch-dawn.mjs ${platform}\`, or set KINETOGRAPH_DAWN_DIR`,
  );
}

/**
 * The folder `sub` (`dawn`, `angle`) of the addon's platform package that holds `file`: the installed platform package, else `npm/<platform>/<sub>`
 * beside `@kinetographdev/native` in a source checkout. `tried` is every folder looked in.
 */
export function platformFolder(sub: string, file: string, from: string, platform: string): { dir: string; tried: string[] } | { dir: null; tried: string[] } {
  const require = createRequire(from);
  const tried: string[] = [];
  const roots: [string, string[]][] = [
    [`@kinetographdev/native-${platform}/package.json`, [sub]],
    ['@kinetographdev/native/package.json', [sub, join('npm', platform, sub)]],
  ];
  for (const [spec, subs] of roots) {
    let root: string;
    try {
      root = dirname(require.resolve(spec));
    } catch {
      continue;
    }
    for (const folder of subs) {
      const dir = join(root, folder);
      if (existsSync(join(dir, file))) return { dir, tried };
      tried.push(dir);
    }
  }
  return { dir: null, tried };
}

const UNMAPS = Symbol.for('kinetograph.dawn.deviceDestroyUnmapsBuffers');

/**
 * `GPUDevice.destroy()` is specified to unmap every buffer of the device, and dawn.node leaves them mapped, so their `getMappedRange`
 * ArrayBuffers stay attached. Each device's buffers are tracked weakly (a strong set would hold every buffer a device ever made) and the
 * mapped ones are unmapped on the way into `destroy`. Once per library.
 */
function unmapBuffersOnDestroy(globals: Any): void {
  const proto = globals.GPUDevice?.prototype;
  if (!proto || proto[UNMAPS]) return;
  const buffers = new WeakMap<object, Set<WeakRef<Any>>>();
  const collected = new FinalizationRegistry<{ set: Set<WeakRef<Any>>; ref: WeakRef<Any> }>(({ set, ref }) => set.delete(ref));
  const { createBuffer, destroy } = proto;
  proto.createBuffer = function (this: object, ...args: unknown[]) {
    const buffer = createBuffer.apply(this, args);
    let set = buffers.get(this);
    if (!set) buffers.set(this, (set = new Set()));
    const ref = new WeakRef(buffer);
    set.add(ref);
    collected.register(buffer, { set, ref });
    return buffer;
  };
  proto.destroy = function (this: object, ...args: unknown[]) {
    const set = buffers.get(this);
    if (set) {
      for (const ref of set) {
        const buffer = ref.deref();
        if (buffer?.mapState === 'mapped') {
          try {
            buffer.unmap();
          } catch {
            // One buffer that will not unmap must not stop the device from being destroyed.
          }
        }
      }
      set.clear();
    }
    return destroy.apply(this, args);
  };
  proto[UNMAPS] = true;
}

/** Dawn for Node (`{ create, globals }`) from the platform package's dawn.node, with the device-destroy fix applied. */
export function loadDawnBinary(from: string = import.meta.url): { create: Any; globals: Any; directory: string } {
  const dir = dawnDirectory(from);
  const { create, globals } = createRequire(from)(join(dir, 'dawn.node')) as { create: Any; globals: Any };
  unmapBuffersOnDestroy(globals);
  return { create, globals, directory: dir };
}
