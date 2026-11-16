// Fetches the ANGLE libraries for one platform package: our own release (default) or Chrome for Testing (no dependencies).
//   node scripts/fetch-angle.mjs <darwin-arm64|linux-x64-gnu|win32-x64-msvc> [--swiftshader] [--source chrome|release] [--cache <dir>] [--out <dir>]
//
// SOURCE: where the libraries come from. `release` (the default, DEFAULT_SOURCE below) is our own ANGLE build, the GitHub
// release in RELEASE (repository 0xS4N4TG/kinetograph-angle, built by that repository's workflow). `chrome` is Chrome for
// Testing, below. Pass `--source` for one run. The release holds the two libraries, SwiftShader (the software Vulkan driver
// and its ICD file, plus the Vulkan loader on Linux and Windows; macOS links the loader into ANGLE), ANGLE's LICENSE,
// THIRD-PARTY-NOTICES.txt (every third-party component built into the files, with its licence) and a SOURCE.txt.
//
// ANGLE is not published on its own. Chrome ships it, and until Chrome 150 the headless shell kept it in separate files
// (libEGL, libGLESv2); from 151 on (macOS) and 152 on (Linux, Windows) those files are empty stubs and ANGLE is linked
// into the browser. So the pin is Chrome 150.0.7871.124, the last build with working files on all three platforms; the
// same version for every platform. Only the library files named in PLATFORMS are taken (by exact name), each checked
// against its SHA-256, from an archive checked against its own SHA-256. Nothing from the archive is ever run.
//
// Ships by default: libEGL and libGLESv2, plus ANGLE's licence and the credits file (the libraries carry compiled-in
// third-party code that file covers: Chrome's, or THIRD-PARTY-NOTICES.txt of our release). `--swiftshader` adds the software
// Vulkan driver (and, on Linux and Windows, the Vulkan loader) for `KINETOGRAPH_ANGLE_BACKEND=swiftshader`; off by default
// because the Linux engine already needs a system Vulkan driver (Mesa lavapipe) and the files add 6 to 21 MB.
// Windows does not ship d3dcompiler_47.dll: ANGLE loads it by name and Windows 10 and later have it in System32.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export const CHROME = '150.0.7871.124';
// 'chrome' or 'release'. The one place that decides what a run with no `--source` takes.
export const DEFAULT_SOURCE = 'release';

// Our own build: the release of the ANGLE commit 454620d149 (Chrome Stable's chromium/8103). Each platform's archive holds
// the files below at its top level, plus LICENSE and SOURCE.txt. Hashes are from the release's SHA256SUMS.
export const RELEASE = {
  repo: '0xS4N4TG/kinetograph-angle',
  tag: 'angle-454620d149',
  platforms: {
    'darwin-arm64': {
      asset: 'angle-454620d149-darwin-arm64.tar.gz',
      archive: 'ee03e8953a76c18919ca2ee455c6c1f20f6fa45587384dbc2ce589c875e3f36b',
      libs: [
        ['libEGL.dylib', '0afeb443aef7a19fa5edb89961ac214fec078635caab4c963c9c049bf7ddee36'],
        ['libGLESv2.dylib', '108a5d964a2892fa5baf5a5703833d0c79d3de9f3e7941ac7d0a24b1bbfb9da1'],
      ],
      software: [
        ['libvk_swiftshader.dylib', '9a6fc34d91d8700af3eb0e87932bdf2041b5eeaf2f8c8887357a5a677a2c9b0c'],
        ['vk_swiftshader_icd.json', 'd717d915e31e7c27948b80b36ab34e2d897888114c5c7d0af835f93eb53e58f5'],
      ],
      notices: 'a8fe58d7e957f192bafaa8d35d78990783344accb79e44514ee1d0d339d657fa',
    },
    'linux-x64-gnu': {
      asset: 'angle-454620d149-linux-x64.tar.gz',
      archive: '50135d4eeb32dcb7676d853de7e3190970d1bd885d839a3ae1bdc78271506857',
      libs: [
        ['libEGL.so', '56ffa31c80cd99a2448d9438937aff96979a77317a1c345a981ff07c52d76e0f'],
        ['libGLESv2.so', '048416d25331166eebfde7b5d0835e50025d9a6e09c789778546f936f1fe52a2'],
      ],
      software: [
        ['libvk_swiftshader.so', 'd0972a335126ce9d2cf80fc91ad20c79ca3a5594f58fe47ba6f4d35ba897596c'],
        ['vk_swiftshader_icd.json', 'c9eef28b6b984fec220ef0abfecc40b502d46946706e47bfe97707027cb818bd'],
        ['libvulkan.so.1', 'c23b764de4fb9c9168414d5c1dc54f2023116b6fb93824db8f0f64f0f536dffb'],
      ],
      notices: '17af45aaea94b639fb9fc3d062d187a01f35bf871bc1e7722c3e9c6f4adef38d',
    },
    'win32-x64-msvc': {
      asset: 'angle-454620d149-win32-x64.zip',
      archive: 'bfd0c052aae00e6e677583afb4abac0be3a12565a99bff49fd177ec27b9c6d13',
      libs: [
        ['libEGL.dll', '61873082e73799e3df02ee6d39eb5057e23c95df414e5bad736b838a14ec7b7d'],
        ['libGLESv2.dll', '1920bb6c80c9d352dd6299344b05ea8a58e50e2b306f7cce79991dc2b2fa3768'],
      ],
      software: [
        ['vk_swiftshader.dll', 'bbbd8062723a1947d412185dde03673b181c936af9de4433f5ac7ebc14532b7b'],
        ['vk_swiftshader_icd.json', '32d83ff113fef532a9f97e0d2831f8656628ab1c99e9060f0332b1532839afd9'],
        ['vulkan-1.dll', '97a137347c09796a9f605b67f7187a45222016bf7bd1f91a415a7226ce884cb6'],
      ],
      notices: '0ba824a3ec9c1aaae414b467e81140118e4616ebeb5b01085f4473156c3dd79b',
    },
  },
};
const BASE = 'https://storage.googleapis.com/chrome-for-testing-public';

// `cft` is Chrome for Testing's platform name; each file is `[name, sha256]`.
export const PLATFORMS = {
  'darwin-arm64': {
    cft: 'mac-arm64',
    archive: 'c050d28c34e1f47530913da744ca5bcf10c482df8725102dfdd2aa633d72053b',
    libs: [
      ['libEGL.dylib', 'c1653fd5c552c4bf8b4c5ee643c7f18ecc2f25b304b93a295389d82f896cd57f'],
      ['libGLESv2.dylib', '0a23d93b18f91904ba22a8a16bbaf309d699c8d35a5c1e47b5183c39d8616343'],
    ],
    software: [
      ['libvk_swiftshader.dylib', '02958ed48578bf3b7d68f6cbd8b3fb9514f179bdfe15717d663ed12f1a5f81c4'],
      ['vk_swiftshader_icd.json', 'd717d915e31e7c27948b80b36ab34e2d897888114c5c7d0af835f93eb53e58f5'],
    ],
  },
  'linux-x64-gnu': {
    cft: 'linux64',
    archive: '98de0bcdc661d14b2fc122ae99a27df35d47e464e8d38a4a5e01f81a4ce295c2',
    libs: [
      ['libEGL.so', '9ea9fccce5f5c4a6d1055c8a2bd688de494dc0bbb77d3fda9485ba4bf9aedbb1'],
      ['libGLESv2.so', 'a85e93cf20a090a0b2b35ea7d54bd1b80baccd5f6634dd94c668e319211b6f04'],
    ],
    software: [
      ['libvk_swiftshader.so', '63291c9b5ae5c5d323894a61cc04899e566ec47de081e52068967bd0f9adc4dd'],
      ['vk_swiftshader_icd.json', 'c9eef28b6b984fec220ef0abfecc40b502d46946706e47bfe97707027cb818bd'],
      ['libvulkan.so.1', '7d87578de91b040748e9c1acbf64f606950d3c3208dc3095ea4a7666574b9cc2'],
    ],
  },
  'win32-x64-msvc': {
    cft: 'win64',
    archive: 'c7816e19a110f4848d9f658b31818c94cfe20f2f24b63622d882da437a9d2b3a',
    libs: [
      ['libEGL.dll', '287cd96f0a32c9ac69890c36ef6393edbc80277ae84b29d9d7501a8481b2563e'],
      ['libGLESv2.dll', '04ba623016f14022b5d119b2465a9d33f70b1c5725ea46d1fbfb320d749cb4c6'],
    ],
    software: [
      ['vk_swiftshader.dll', '555b2001632448a76a47b01a9e86f5ce905fb90d0540014d8f6931e477005f68'],
      ['vk_swiftshader_icd.json', '32d83ff113fef532a9f97e0d2831f8656628ab1c99e9060f0332b1532839afd9'],
      ['vulkan-1.dll', 'd25cd8c070bb3a32af7d76275682ec56a3a60aad12591de9acda144696f95402'],
    ],
  },
};

// Sections of Chrome's credits file (LICENSE.headless_shell), by their heading, written as their own files.
const LICENSES = [
  ['ANGLE-LICENSE', 'Almost Native Graphics Layer Engine', false],
  ['SWIFTSHADER-LICENSE', 'SwiftShader', true],
  ['VULKAN-LOADER-LICENSE', 'Vulkan Loader Components', true],
];
const CREDITS = 'CHROMIUM-CREDITS.txt';
const NOTICES = 'THIRD-PARTY-NOTICES.txt';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// The entries of a zip by name: [{ name, method, size, offset }] read from the central directory.
function zipEntries(zip) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip file');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const nameLength = zip.readUInt16LE(p + 28);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLength);
    entries.set(name, { method: zip.readUInt16LE(p + 10), size: zip.readUInt32LE(p + 20), offset: zip.readUInt32LE(p + 42) });
    p += 46 + nameLength + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return entries;
}

function zipRead(zip, entries, name) {
  const e = entries.get(name);
  if (!e) throw new Error(`${name} is not in the archive`);
  if (zip.readUInt32LE(e.offset) !== 0x04034b50) throw new Error(`bad zip entry for ${name}`);
  const start = e.offset + 30 + zip.readUInt16LE(e.offset + 26) + zip.readUInt16LE(e.offset + 28);
  const data = zip.subarray(start, start + e.size);
  if (e.method === 0) return data;
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`${name}: unsupported zip method ${e.method}`);
}

// The regular files of a .tar.gz by name: Map(name -> bytes). Only what the release's packaging writes (ustar or pax
// headers, short names); anything else in it is skipped.
export function tarFiles(gz) {
  const tar = zlib.gunzipSync(gz);
  const files = new Map();
  const field = (at, len) => tar.toString('utf8', at, at + len).replace(/\0.*$/s, '');
  for (let p = 0; p + 512 <= tar.length && tar[p] !== 0; ) {
    const size = parseInt(field(p + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(tar[p + 156] || 0x30);
    if (type === '0') files.set(field(p, 100).replace(/^\.\//, ''), tar.subarray(p + 512, p + 512 + size));
    p += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

// A bare file name: no separator, no `..`.
function safeName(name) {
  if (name !== path.basename(name) || name.includes('..') || name.includes('\\') || name.includes('/') || name === '') {
    throw new Error(`refusing the file name ${JSON.stringify(name)}`);
  }
  return name;
}

// An archive by its URL, from the cache when its hash matches, else downloaded and checked against `hash`.
async function archiveFor(url, cachedName, hash, cacheDir) {
  const cached = path.join(cacheDir, cachedName);
  if (fs.existsSync(cached)) {
    const buf = fs.readFileSync(cached);
    if (sha256(buf) === hash) return buf;
    console.log(`${cached} does not match its hash; downloading it again`);
  }
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}${res.status === 404 ? ' (a release that is still a draft is not public)' : ''}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== hash) throw new Error(`${url}: SHA-256 is ${got}, expected ${hash}`);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(`${cached}.part`, buf);
  fs.renameSync(`${cached}.part`, cached);
  return buf;
}

// Section `heading` of the credits file: the text between its heading and the next one.
function creditsSection(text, heading) {
  const re = /^-{20}\r?\n(.+)\r?\n-{20}\r?\n/gm;
  const marks = [...text.matchAll(re)];
  const at = marks.findIndex((m) => m[1].trim() === heading);
  if (at < 0) throw new Error(`the credits file has no section ${JSON.stringify(heading)}`);
  const from = marks[at].index + marks[at][0].length;
  const to = at + 1 < marks.length ? marks[at + 1].index : text.length;
  return `${heading}\n\n${text.slice(from, to).trim()}\n`;
}

export async function fetchAngle(platform, { swiftshader = false, source = DEFAULT_SOURCE, cacheDir, outDir } = {}) {
  const spec = PLATFORMS[platform];
  if (!spec) throw new Error(`unknown platform ${JSON.stringify(platform)}; one of ${Object.keys(PLATFORMS).join(', ')}`);
  if (source !== 'chrome' && source !== 'release') throw new Error(`unknown source ${JSON.stringify(source)}; chrome or release`);
  const own = source === 'release';
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  cacheDir ??= path.join(os.homedir(), '.cache', 'kinetograph', 'angle');
  outDir ??= path.join(here, '..', 'crates', 'node', 'npm', platform, 'angle');
  const rel = RELEASE.platforms[platform];
  const wanted = own ? [...rel.libs, ...(swiftshader ? rel.software : [])] : [...spec.libs, ...(swiftshader ? spec.software : [])];
  const top = `chrome-headless-shell-${spec.cft}`;
  const releaseUrl = own ? `https://github.com/${RELEASE.repo}/releases/download/${RELEASE.tag}/${rel.asset}` : '';
  const sourceText = (own
    ? [`ANGLE ${RELEASE.tag}`, `${RELEASE.repo} release ${RELEASE.tag}, ${rel.asset}`, releaseUrl, `archive sha256 ${rel.archive}`]
    : [`ANGLE ${CHROME}`, `Chrome for Testing ${CHROME}, ${top}.zip (${spec.cft})`, `${BASE}/${CHROME}/${spec.cft}/${top}.zip`, `archive sha256 ${spec.archive}`]
  )
    .concat(wanted.map(([name, hash]) => `${name} sha256 ${hash}`), own ? [`${NOTICES} sha256 ${rel.notices}`] : [], '')
    .join('\n');

  // Files this script manages and does not want now (another source, SwiftShader switched off) are removed, so the folder is exact.
  const managed = [...spec.libs, ...spec.software, ...rel.software].map(([n]) => n).concat(LICENSES.map(([n]) => n), CREDITS, NOTICES, 'SOURCE.txt');
  const keep = new Set(
    own
      ? [...wanted.map(([n]) => n), 'ANGLE-LICENSE', NOTICES, 'SOURCE.txt']
      : [...wanted.map(([n]) => n), ...LICENSES.filter(([, , soft]) => !soft || swiftshader).map(([n]) => n), CREDITS, 'SOURCE.txt'],
  );

  const upToDate =
    fs.existsSync(path.join(outDir, 'SOURCE.txt')) &&
    fs.readFileSync(path.join(outDir, 'SOURCE.txt'), 'utf8').startsWith(sourceText) &&
    [...keep].every((n) => fs.existsSync(path.join(outDir, n))) &&
    wanted.every(([n, h]) => sha256(fs.readFileSync(path.join(outDir, n))) === h) &&
    managed.every((n) => keep.has(n) || !fs.existsSync(path.join(outDir, n)));
  if (upToDate) {
    console.log(`${outDir} is up to date (${own ? RELEASE.tag : `ANGLE ${CHROME}`})`);
    return outDir;
  }

  const files = new Map();
  if (own) {
    const archive = await archiveFor(releaseUrl, `${RELEASE.tag}-${rel.asset}`, rel.archive, cacheDir);
    let entries;
    if (rel.asset.endsWith('.zip')) {
      const zip = zipEntries(archive);
      entries = new Map([...zip.keys()].map((n) => [n, zipRead(archive, zip, n)]));
    } else {
      entries = tarFiles(archive);
    }
    const take = (name) => {
      const data = entries.get(safeName(name));
      if (!data) throw new Error(`${name} is not in ${rel.asset}`);
      return data;
    };
    for (const [name, hash] of wanted) {
      const data = take(name);
      const got = sha256(data);
      if (got !== hash) throw new Error(`${name}: SHA-256 is ${got}, expected ${hash}`);
      files.set(name, data);
    }
    files.set('ANGLE-LICENSE', take('LICENSE'));
    const notices = take(NOTICES);
    if (sha256(notices) !== rel.notices) throw new Error(`${NOTICES}: SHA-256 is ${sha256(notices)}, expected ${rel.notices}`);
    files.set(NOTICES, notices);
    // The release's own record of the build (commit, gn arguments, runner image) follows ours.
    files.set('SOURCE.txt', Buffer.from(`${sourceText}\n${take('SOURCE.txt').toString('utf8')}`));
  } else {
    const zip = await archiveFor(`${BASE}/${CHROME}/${spec.cft}/${top}.zip`, `${CHROME}-${top}.zip`, spec.archive, cacheDir);
    const entries = zipEntries(zip);
    for (const [name, hash] of wanted) {
      const data = zipRead(zip, entries, `${top}/${safeName(name)}`);
      const got = sha256(data);
      if (got !== hash) throw new Error(`${name}: SHA-256 is ${got}, expected ${hash}`);
      files.set(name, data);
    }
    const credits = zipRead(zip, entries, `${top}/LICENSE.headless_shell`);
    files.set(CREDITS, credits);
    for (const [name, heading, soft] of LICENSES) {
      if (!soft || swiftshader) files.set(name, Buffer.from(creditsSection(credits.toString('utf8'), heading)));
    }
    files.set('SOURCE.txt', Buffer.from(sourceText));
  }

  fs.mkdirSync(outDir, { recursive: true });
  for (const name of managed) if (!keep.has(name)) fs.rmSync(path.join(outDir, name), { force: true });
  for (const [name, data] of files) fs.writeFileSync(path.join(outDir, safeName(name)), data, { mode: wanted.some(([n]) => n === name) ? 0o755 : 0o644 });
  console.log(`${outDir}: ${[...files.keys()].join(', ')}`);
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
  const source = take('--source') ?? DEFAULT_SOURCE;
  const si = args.indexOf('--swiftshader');
  const swiftshader = si >= 0 && !!args.splice(si, 1);
  const [platform] = args;
  if (!platform || args.length !== 1) {
    console.error('usage: node scripts/fetch-angle.mjs <darwin-arm64|linux-x64-gnu|win32-x64-msvc> [--swiftshader] [--source chrome|release] [--cache <dir>] [--out <dir>]');
    process.exit(2);
  }
  fetchAngle(platform, { swiftshader, source, cacheDir, outDir }).catch((e) => {
    console.error(`fetch-angle: ${e.message}`);
    process.exit(1);
  });
}
