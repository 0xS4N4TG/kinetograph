export const GITHUB = 'https://github.com/0xS4N4TG/kinetograph';
export const DOCS = `${GITHUB}#readme`;
export const doc = (path: string) => `${GITHUB}/blob/main/${path}`;
export const NPM = 'https://www.npmjs.com/package/kinetograph';

/**
 * Where the docs' videos are served from: `<base><name>.mp4` and `<base><name>.jpg`. The clips are the assets of the
 * `docs-media` GitHub release (not in git); `scripts/fetch-videos.mjs` copies them into `public/docs-video/` before each
 * build, so the site serves them with the right type (GitHub serves release assets as octet-stream attachments, which iOS
 * will not play). Set NEXT_PUBLIC_DOCS_VIDEO_BASE (with a trailing slash) to use another host and skip the fetch.
 * The clip list is in content/docs/VIDEOS.md.
 */
export const VIDEO_BASE = process.env.NEXT_PUBLIC_DOCS_VIDEO_BASE ?? '/docs-video/';
