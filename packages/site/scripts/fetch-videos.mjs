// Fetches the docs' clips and posters (the assets of the `docs-media` GitHub release) into public/docs-video/, so the
// site serves them itself with `Content-Type: video/mp4` (GitHub serves release assets as octet-stream attachments, which
// iOS will not play). Run by `npm run build`; also `npm run videos`. Files already present with the right size are kept.
// The listing comes from the public GitHub API (no token needed: 3 calls of the 60 an hour); the files from GitHub's CDN.
// Skipped when NEXT_PUBLIC_DOCS_VIDEO_BASE points the site at another host.
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const REPO = '0xS4N4TG/kinetograph';
const TAG = 'docs-media';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'docs-video');
const API = `https://api.github.com/repos/${REPO}/releases`;
const headers = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : undefined;

if (process.env.NEXT_PUBLIC_DOCS_VIDEO_BASE) {
  console.log('videos: NEXT_PUBLIC_DOCS_VIDEO_BASE is set, not fetching');
  process.exit(0);
}

async function json(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}${res.status === 403 ? ' (GitHub API rate limit? set GITHUB_TOKEN)' : ''}`);
  return res.json();
}

async function listAssets() {
  const release = await json(`${API}/tags/${TAG}`);
  const assets = [];
  for (let page = 1; ; page++) {
    const batch = await json(`${API}/${release.id}/assets?per_page=100&page=${page}`);
    assets.push(...batch);
    if (batch.length < 100) return assets;
  }
}

async function present(file, size) {
  try {
    return (await stat(file)).size === size;
  } catch {
    return false;
  }
}

async function download(asset) {
  const file = join(OUT, asset.name);
  if (await present(file, asset.size)) return false;
  const res = await fetch(asset.browser_download_url);
  if (!res.ok || !res.body) throw new Error(`${asset.name}: HTTP ${res.status}`);
  const part = `${file}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
  const got = (await stat(part)).size;
  if (got !== asset.size) {
    await unlink(part);
    throw new Error(`${asset.name}: got ${got} bytes, the release lists ${asset.size}`);
  }
  await rename(part, file);
  return true;
}

const assets = await listAssets();
if (!assets.length) throw new Error(`release ${TAG} has no assets`);
await mkdir(OUT, { recursive: true });
let fetched = 0;
const queue = [...assets];
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let a = queue.pop(); a; a = queue.pop()) if (await download(a)) fetched++;
  }),
);
console.log(`videos: ${assets.length} files in public/docs-video (${fetched} downloaded)`);
