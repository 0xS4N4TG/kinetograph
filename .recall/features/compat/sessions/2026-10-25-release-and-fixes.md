# 2026-10-25 — compat/release-and-fixes

**Session ID:** 2026-10-25-release-and-fixes  (split across release, engine, compat, site, launch-film)
**Repo state:** main @ 9dbe566a, 2 dirty (untracked .playwright-mcp/, examples/rajz-cards/example/)

## Goal
Ship and harden Kinetograph after launch: npm release, outside bug report, determinism, comparisons, new library support.

## What happened
- Benchmarked vs Remotion and HyperFrames (Haiku agents), found GSAP crash and SVG text bugs, launched GSAP, datamosh and p5.brush agents.

## Decisions made
- GSAP/WebGL libraries are supported by making the engine behave like the browser (port), not by per-library add-ons.
- Comparisons must be the same picture: check parity images by eye before quoting a speedup.
- Do not claim 42x vs Remotion (busy-machine artifact); public claim stays ~5x (papercut ~6x).

## Open threads at end of session
- [ ] Review + merge feat/gsap (then compat.mdx lists GSAP), ship in 0.1.2
- [ ] Review + merge merge/datamosh
- [ ] p5.brush gap list -> scoped WebGL gap tasks (Sonnet medium) so it runs as-is; optional @kinetographdev/p5 adapter later
- [ ] Re-run HyperFrames comparison on published 0.1.1 with bold headline; parity images
- [ ] HyperFrames drop-in (HTML entry + script runtime + their data-* contract): est 2-4 weeks; product decision pending
