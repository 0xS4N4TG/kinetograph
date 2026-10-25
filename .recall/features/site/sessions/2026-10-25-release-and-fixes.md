# 2026-10-25 — site/release-and-fixes

**Session ID:** 2026-10-25-release-and-fixes  (split across release, engine, compat, site, launch-film)
**Repo state:** main @ 9dbe566a, 2 dirty (untracked .playwright-mcp/, examples/rajz-cards/example/)

## Goal
Ship and harden Kinetograph after launch: npm release, outside bug report, determinism, comparisons, new library support.

## What happened
- Removed docs/reference and all mentions (e2d0d4eb).

## Decisions made
- Site copy must not call Kinetograph "open source": licence is PolyForm Small Business 1.0.0.

## Open threads at end of session
- [ ] Add GSAP (and later p5.brush) to compat docs when merged
- [ ] Decide on git-history rewrite for the two rajz stills
