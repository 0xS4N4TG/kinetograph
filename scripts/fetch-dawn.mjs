// Fetches Dawn for Node (dawn.node, WebGPU) for one platform package: the files of the `webgpu` npm package at a pinned version.
//   node scripts/fetch-dawn.mjs <darwin-arm64|linux-x64-gnu|win32-x64-msvc> [--cache <dir>] [--out <dir>] [--angle <dir>]
//
// The package (MIT, dawn-gpu/node-webgpu, built from Google's Dawn) holds every platform in one 137 MB tarball. Ours takes only the
// files of one platform, by exact name: the tarball is checked against its npm integrity (sha512, the one `package-lock.json` has),
// and each extracted file against a SHA-256 pinned here. Nothing from the archive is ever run. The files land in the platform
// package's `dawn/` folder, where the CLI loads dawn.node from by full path (packages/cli/src/dawn.ts).
//
// On Linux and Windows the folder also gets the Khronos Vulkan loader (`libvulkan.so.1`, `vulkan-1.dll`), copied from the platform package's
// `angle/` folder, which `node scripts/fetch-angle.mjs <platform> --swiftshader` fills first, and checked against the SHA-256 that script pins:
// nothing more is downloaded. Dawn opens the loader from its own folder before the system's, so Dawn needs no `libvulkan1` and always has a
// loader that reads `VK_ADD_DRIVER_FILES` (1.3.234 and newer; Ubuntu 22.04's is 1.3.204), which SwiftShader is added with
// (packages/compat/src/shim/dawn-software.ts). Its licence is in `angle/THIRD-PARTY-NOTICES.txt` with ANGLE's.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { PLATFORMS as ANGLE_CHROME, RELEASE as ANGLE_RELEASE } from './fetch-angle.mjs';

export const VERSION = '0.6.2';
export const TARBALL = `https://registry.npmjs.org/webgpu/-/webgpu-${VERSION}.tgz`;
export const INTEGRITY = 'sha512-3L4GfmqJLvYUIEWJngEQY+2HQiUlAFkg8+P8NDDj3Xx5hHHIFO/r8JW+ynfqBj7kHN4mbnwO74uB+lrRtLhp4Q==';

// `dir` is the folder of `dist/` the package keeps the platform in (macOS has one build for both architectures); each file is [name, sha256].
export const PLATFORMS = {
  'darwin-arm64': {
    dir: 'darwin-universal',
    files: [['dawn.node', 'f5b278f3dc65276bf1f8a667f91650d32585431d5b2d148ca729f67924c574a3']],
  },
  'linux-x64-gnu': {
    dir: 'linux-x64',
    files: [['dawn.node', 'ab18a659f8325e874ea45c80347b64336d7f748601102753d2bc669fdecfd710']],
    loader: 'libvulkan.so.1',
  },
  // Dawn compiles HLSL with the DXC and FXC compilers it finds beside dawn.node; the package ships both.
  'win32-x64-msvc': {
    dir: 'win32-x64',
    files: [
      ['dawn.node', '75fff5db8a7541ad7a2d22c468e6f8bc3614b87c3b649c8ce712f7f5148ef338'],
      ['dxcompiler.dll', '04cf618004bf19f789f54e8931c7f7106223bccd354b093c4ff725c748512602'],
      ['d3dcompiler_47.dll', '289767b49dc8525bce262ea06fee4ef9fced2e131a55b25654ce871c1f0498b2'],
    ],
    // Licence files that come with those two DLLs, copied under the names the package's notices point at.
    notices: [
      ['dxcompiler-LICENSE.TXT', '05f32c081b3c75cd2cc2a0655b571ba94ebcfc64e9ccca6e5a9e36d6cb67e540'],
      ['dxcompiler-ThirdPartyNotices.txt', '87539fdc00b6350520942dbb0683c56acba5e38f5ddbcded046a6958a1386188'],
    ],
    loader: 'vulkan-1.dll',
  },
};
// The package's own licence (Dawn's BSD-3-Clause), kept as `DAWN-LICENSE`.
const LICENSE_SHA256 = '12b5a762d9f74ebc820c9ff13a79fd5108525c1fda37c5ab4fd924f89484aba2';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// The regular files of a .tar.gz by name: Map(name -> bytes). The npm tarball is ustar with a `package/` top folder and pax headers
// for long names; only regular files are kept, a pax `path` replaces the name of the entry after it.
export function tarFiles(gz) {
  const tar = zlib.gunzipSync(gz);
  const files = new Map();
  const field = (at, len) => tar.toString('utf8', at, at + len).replace(/\0.*$/s, '');
  let longName = null;
  for (let p = 0; p + 512 <= tar.length && tar[p] !== 0; ) {
    const size = parseInt(field(p + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(tar[p + 156] || 0x30);
    const body = tar.subarray(p + 512, p + 512 + size);
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      longName = m ? m[1] : null;
    } else if (type === '0') {
      const prefix = field(p + 345, 155);
      files.set(longName ?? (prefix ? `${prefix}/` : '') + field(p, 100), body);
      longName = null;
    }
    p += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** The Vulkan loader of the platform's ANGLE files in `angleDir`, when its SHA-256 is one fetch-angle.mjs pins for it (either source): [bytes, hash]. */
export function angleLoader(platform, name, angleDir) {
  const file = path.join(angleDir, name);
  if (!fs.existsSync(file)) {
    throw new Error(`${file} is missing: run \`node scripts/fetch-angle.mjs ${platform} --swiftshader\` first (dawn/ takes the Vulkan loader of the ANGLE files)`);
  }
  const pinned = [ANGLE_RELEASE.platforms[platform], ANGLE_CHROME[platform]].flatMap((spec) => spec?.software ?? []).filter(([n]) => n === name).map(([, hash]) => hash);
  const data = fs.readFileSync(file);
  const got = sha256(data);
  if (!pinned.includes(got)) throw new Error(`${file}: SHA-256 is ${got}, which scripts/fetch-angle.mjs does not pin (${pinned.join(', ')})`);
  return [data, got];
}

async function tarballFor(cacheDir) {
  const cached = path.join(cacheDir, `webgpu-${VERSION}.tgz`);
  const ok = (buf) => `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}` === INTEGRITY;
  if (fs.existsSync(cached)) {
    const buf = fs.readFileSync(cached);
    if (ok(buf)) return buf;
    console.log(`${cached} does not match its integrity; downloading it again`);
  }
  console.log(`downloading ${TARBALL}`);
  const res = await fetch(TARBALL);
  if (!res.ok) throw new Error(`${TARBALL}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!ok(buf)) throw new Error(`${TARBALL}: integrity is not ${INTEGRITY}`);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(`${cached}.part`, buf);
  fs.renameSync(`${cached}.part`, cached);
  return buf;
}

export async function fetchDawn(platform, { cacheDir, outDir, angleDir } = {}) {
  const spec = PLATFORMS[platform];
  if (!spec) throw new Error(`unknown platform ${JSON.stringify(platform)}; one of ${Object.keys(PLATFORMS).join(', ')}`);
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  cacheDir ??= path.join(os.homedir(), '.cache', 'kinetograph', 'dawn');
  outDir ??= path.join(here, '..', 'crates', 'node', 'npm', platform, 'dawn');
  angleDir ??= path.join(path.dirname(outDir), 'angle');
  const loader = spec.loader ? angleLoader(platform, spec.loader, angleDir) : null;
  const wanted = [...spec.files, ...(spec.notices ?? [])];
  const sourceText = [
    `Dawn for Node, the webgpu npm package ${VERSION} (MIT; Google's Dawn, built by github.com/dawn-gpu/node-webgpu)`,
    TARBALL,
    `integrity ${INTEGRITY}`,
    ...wanted.map(([name, hash]) => `dist/${spec.dir}/${name} sha256 ${hash}`),
    `LICENSE.md (kept as DAWN-LICENSE) sha256 ${LICENSE_SHA256}`,
    ...(loader ? [`${spec.loader} sha256 ${loader[1]}, the Khronos Vulkan loader copied from angle/ (angle/SOURCE.txt; its licence is in angle/THIRD-PARTY-NOTICES.txt)`] : []),
    '',
  ].join('\n');

  const own = [...wanted, ...(loader ? [[spec.loader, loader[1]]] : [])];
  const names = [...own.map(([n]) => n), 'DAWN-LICENSE', 'SOURCE.txt'];
  const upToDate =
    fs.existsSync(path.join(outDir, 'SOURCE.txt')) &&
    fs.readFileSync(path.join(outDir, 'SOURCE.txt'), 'utf8') === sourceText &&
    names.every((n) => fs.existsSync(path.join(outDir, n))) &&
    own.every(([n, h]) => sha256(fs.readFileSync(path.join(outDir, n))) === h) &&
    fs.readdirSync(outDir).every((n) => names.includes(n));
  if (upToDate) {
    console.log(`${outDir} is up to date (webgpu ${VERSION})`);
    return outDir;
  }

  // The folder is cleaned of what is not Dawn's (below): not a folder that something else owns (a typo in `--out`), which holds no SOURCE.txt.
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0 && !fs.existsSync(path.join(outDir, 'SOURCE.txt'))) {
    throw new Error(`${outDir} is not empty and has no SOURCE.txt, so it is not a folder this script made; not touching it`);
  }

  const entries = tarFiles(await tarballFor(cacheDir));
  const take = (name, hash) => {
    const data = entries.get(name);
    if (!data) throw new Error(`${name} is not in the webgpu ${VERSION} package`);
    const got = sha256(data);
    if (got !== hash) throw new Error(`${name}: SHA-256 is ${got}, expected ${hash}`);
    return data;
  };
  const files = new Map(wanted.map(([name, hash]) => [name, take(`package/dist/${spec.dir}/${name}`, hash)]));
  files.set('DAWN-LICENSE', take('package/LICENSE.md', LICENSE_SHA256));
  if (loader) files.set(spec.loader, loader[0]);
  files.set('SOURCE.txt', Buffer.from(sourceText));

  fs.mkdirSync(outDir, { recursive: true });
  for (const name of fs.readdirSync(outDir)) if (!files.has(name)) fs.rmSync(path.join(outDir, name), { force: true });
  for (const [name, data] of files) fs.writeFileSync(path.join(outDir, name), data, { mode: spec.files.some(([n]) => n === name) || name === spec.loader ? 0o755 : 0o644 });
  console.log(`${outDir}: ${[...files.entries()].map(([n, d]) => `${n} (${d.length} bytes)`).join(', ')}`);
  return outDir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const args = process.argv.slice(2);
  const take = (flag) => {
    const i = args.indexOf(flag);
    return i < 0 ? undefined : args.splice(i, 2)[1];
  };
  const cacheDir = take('--cache');
  const outDir = take('--out');
  const angleDir = take('--angle');
  const [platform] = args;
  if (!platform || args.length !== 1) {
    console.error('usage: node scripts/fetch-dawn.mjs <darwin-arm64|linux-x64-gnu|win32-x64-msvc> [--cache <dir>] [--out <dir>] [--angle <dir>]');
    process.exit(2);
  }
  fetchDawn(platform, { cacheDir, outDir, angleDir }).catch((e) => {
    console.error(`fetch-dawn: ${e.message}`);
    process.exit(1);
  });
}
