# 2026-10-25 — release/release-and-fixes

**Session ID:** 2026-10-25-release-and-fixes  (split across release, engine, compat, site, launch-film)
**Repo state:** main @ 9dbe566a, 2 dirty (untracked .playwright-mcp/, examples/rajz-cards/example/)

## Goal
Ship and harden Kinetograph after launch: npm release, outside bug report, determinism, comparisons, new library support.

## What happened
- Ran the release autonomously (user authorized): scope rename to @kinetographdev (81ad677e), native run green, dry run, publish; clean `npm install kinetograph@0.1.0` verified.
- Verified issue #1 against wgpu-hal 30.0.1 and Skia m153 source, reproduced in Docker (Ubuntu 25.10, lavapipe 1.4.318) with npm 0.1.0, fixed (a399fba1), verified with the CI-built Linux addon, merged PR #2, commented on the issue.
- Opened/merged PR #3 (determinism) and PR #4 (SVG font, pending).

## Decisions made
- Publish workflow may be run by Claude for a release only when the user explicitly authorizes that release (did so for 0.1.0 and 0.1.1).
- Fix PRs merge only after native CI is green on all 3 platforms + smoke; merge commits, branch deleted after.
- 0.1.1 = Vulkan cap + island determinism + SVG font (+ datamosh if merged in time); GSAP goes to 0.1.2.

## Open threads at end of session
- [ ] PR #4 green + merged (background job), then datamosh merge (merge/datamosh, Sonnet agent running)
- [ ] Bump everything to 0.1.1, push, wait native.yml green, publish.yml dry run, then real publish (user authorized 2026-10-25)
- [ ] npm trusted publishing + delete NPM_TOKEN; GitHub release v0.1.0/v0.1.1 with notes
- [ ] 0.1.2: GSAP support (feat/gsap, Sonnet agent running)
- [ ] Unmerged branches still: fix/ink-overflow, feat/text-stroke, feat/studio-agent-copy (user OK'd merging after determinism); delete perf/gpu-yuv (stale) and feat/launch-v2 (merged)
