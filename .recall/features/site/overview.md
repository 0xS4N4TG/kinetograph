# site

**Status:** active
**Paths:** `packages/site/**`, `README.md`, `docs/readme/**`
**Last touched:** 2026-10-25

## What this is
The marketing site + docs (Next.js static export, fumadocs) and the README.

## Current state
- Live site unchanged since last dump except via main merges (auto-deploy). Tagline: README now "A blazingly fast programmatic video engine, made for agents." Site copies of "with no browser in it" removed on docs/changelog-0.2 (not merged).
- docs/changelog-0.2 adds /docs/changelog (meta.json after known-issues) + footer link + CHANGELOG.md; README status bullet; compat datamosh line; AUTHORING §11.9 GSAP.
- Still on the site: "blazingly fast" (README + layout.tsx) and About "no browser anywhere in the path" (asked user; no answer yet).
- Coming: Libraries page (packages/site/content/docs/libraries.mdx) from the plugins agent; HyperFrames sections from the loader branches.

## Open threads
- [ ] Merge docs/changelog-0.2 after adding #8/#9 entries
- [ ] Ask/decide: remove "no browser anywhere in the path" from the About section too?
- [ ] Decide on git-history rewrite for the two rajz stills

## Key files
- `packages/site/src/sections/hero.tsx`, `packages/site/src/app/page.tsx`, `packages/site/public/llms.txt`

## Recent sessions
- 2026-10-25-pipeline-expansion — changelog page + tagline cleanup on docs/changelog-0.2 (unmerged)
- 2026-10-25-release-and-fixes — kinetograph.dev live on Vercel (auto-deploy from main); wordmark logo; llms.txt tells agents to install skills
