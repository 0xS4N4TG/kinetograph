# site

**Status:** active
**Paths:** `packages/site/**`, `README.md`, `docs/readme/**`
**Last touched:** 2026-10-25

## What this is
The marketing site + docs (Next.js static export, fumadocs) and the README.

## Current state
- Vercel project "kinetograph" (rootDirectory packages/site), kinetograph.dev + www valid; auto-deploys on push to main.
- Fonts DM Sans + JetBrains Mono (footer keeps Geist/Newsreader); cobalt #2238c4 accent; red #E0261B dot on the wordmark.
- public/llms.txt: install skills first (`npx skills add 0xS4N4TG/kinetograph`), `npm install kinetograph`, @kinetographdev/core.
- docs/reference/ (third-party rajz video + stills) deleted 2026-10-25 (e2d0d4eb); two stills remain in git history from e8fd8615 (rewrite needs user OK).

## Open threads
- [ ] Add GSAP (and later p5.brush) to compat docs when merged
- [ ] Decide on git-history rewrite for the two rajz stills

## Key files
- `packages/site/src/sections/hero.tsx`, `packages/site/src/app/page.tsx`, `packages/site/public/llms.txt`

## Recent sessions
- 2026-10-25-release-and-fixes — kinetograph.dev live on Vercel (auto-deploy from main); wordmark logo; llms.txt tells agents to install skills
