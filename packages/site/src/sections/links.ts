export const GITHUB = 'https://github.com/0xS4N4TG/kinetograph';
export const DOCS = `${GITHUB}#readme`;
export const doc = (path: string) => `${GITHUB}/blob/main/${path}`;
export const NPM = 'https://www.npmjs.com/package/kinetograph';

/**
 * Where the docs' videos are hosted: `<base><name>.mp4` and `<base><name>.jpg`. The clips live outside the site, so
 * they stay out of `public/` and the Vercel deployment. Set NEXT_PUBLIC_DOCS_VIDEO_BASE (with a trailing slash) when
 * they are uploaded; until then the docs show a placeholder poster. The clip list is in content/docs/VIDEOS.md.
 */
export const VIDEO_BASE = process.env.NEXT_PUBLIC_DOCS_VIDEO_BASE ?? 'https://github.com/0xS4N4TG/kinetograph/releases/download/docs-media/';
