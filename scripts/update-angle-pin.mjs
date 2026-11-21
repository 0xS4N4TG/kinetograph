// Moves the ANGLE pin in scripts/fetch-angle.mjs (RELEASE: tag, asset names, archive and file SHA-256s) to a release of
// 0xS4N4TG/kinetograph-angle. Run by .github/workflows/angle-pin.yml; also usable by hand.
//   node scripts/update-angle-pin.mjs <tag>
// Downloads each platform's archive (checked against the release asset's `digest` when the API gives one), hashes every
// file the pin lists, and rewrites only the RELEASE block. Fails, leaving the file alone, if an asset or file is missing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { RELEASE, tarFiles, zipEntries, zipRead } from './fetch-angle.mjs';

const FILE = new URL('./fetch-angle.mjs', import.meta.url);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const tag = process.argv[2];
if (!/^angle-[0-9a-f]{10}(-[A-Za-z0-9]+)?$/.test(tag ?? '')) {
  console.error('usage: node scripts/update-angle-pin.mjs <angle-sha10[-revision]>');
  process.exit(2);
}
const sha10 = tag.split('-')[1];
const headers = process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {};

const res = await fetch(`https://api.github.com/repos/${RELEASE.repo}/releases/tags/${tag}`, { headers });
if (!res.ok) throw new Error(`release ${tag}: HTTP ${res.status}`);
const release = await res.json();
if (release.draft || release.prerelease) throw new Error(`release ${tag} is a draft or a prerelease`);

// Per platform: the new asset (same name ending as the pinned one, new commit), its archive hash and the hash of every pinned file.
const next = {};
for (const [platform, old] of Object.entries(RELEASE.platforms)) {
  const ending = old.asset.replace(/^angle-[0-9a-f]{10}/, '');
  const asset = release.assets.find((a) => a.name === `angle-${sha10}${ending}`);
  if (!asset) throw new Error(`${tag} has no asset angle-${sha10}${ending}`);
  const dl = await fetch(asset.browser_download_url);
  if (!dl.ok) throw new Error(`${asset.name}: HTTP ${dl.status}`);
  const archive = Buffer.from(await dl.arrayBuffer());
  const archiveHash = sha256(archive);
  if (asset.digest && asset.digest !== `sha256:${archiveHash}`) throw new Error(`${asset.name}: downloaded ${archiveHash}, API says ${asset.digest}`);
  let entries;
  if (asset.name.endsWith('.zip')) {
    const zip = zipEntries(archive);
    entries = new Map([...zip.keys()].map((n) => [n, zipRead(archive, zip, n)]));
  } else {
    entries = tarFiles(archive);
  }
  const hashes = new Map();
  for (const name of [...old.libs, ...old.software].map(([n]) => n).concat('THIRD-PARTY-NOTICES.txt')) {
    const data = entries.get(name);
    if (!data) throw new Error(`${name} is not in ${asset.name}`);
    hashes.set(name, sha256(data));
  }
  next[platform] = { asset: asset.name, archive: archiveHash, hashes };
}

// Rewrite the RELEASE block line by line.
const lines = fs.readFileSync(FILE, 'utf8').split('\n');
const start = lines.findIndex((l) => l.startsWith('export const RELEASE = {'));
const end = lines.findIndex((l, i) => i > start && l === '};');
if (start < 0 || end < 0) throw new Error('RELEASE block not found in fetch-angle.mjs');
let platform = null;
for (let i = start; i < end; i++) {
  const l = lines[i];
  const p = l.match(/^ {4}'([\w-]+)': \{$/);
  if (p) platform = p[1];
  if (/^ {2}tag: /.test(l)) lines[i] = `  tag: '${tag}',`;
  else if (platform && /^ {6}asset: /.test(l)) lines[i] = `      asset: '${next[platform].asset}',`;
  else if (platform && /^ {6}archive: /.test(l)) lines[i] = `      archive: '${next[platform].archive}',`;
  else if (platform && /^ {6}notices: /.test(l)) lines[i] = `      notices: '${next[platform].hashes.get('THIRD-PARTY-NOTICES.txt')}',`;
  else if (platform && /^ {8}\['[^']+', '[0-9a-f]{64}'\],$/.test(l)) {
    const name = l.match(/\['([^']+)'/)[1];
    lines[i] = `        ['${name}', '${next[platform].hashes.get(name)}'],`;
  }
}
const text = lines.join('\n').replace(/^(\/\/ Our own build: the release of the ANGLE commit )[0-9a-f]{10}[^.]*\./m, `$1${sha10}.`);
fs.writeFileSync(FILE, text);
console.log(`pinned ${tag}`);
