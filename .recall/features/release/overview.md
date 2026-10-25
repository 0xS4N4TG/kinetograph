# release

**Status:** active
**Paths:** `.github/workflows/**`, `crates/node/npm/**`, `**/package.json`, `scripts/check-packages.mjs`
**Last touched:** 2026-10-25

## What this is
Publishing Kinetograph: npm packages, the native CI matrix (native.yml), publish.yml, GitHub issues/PRs, version bumps.

## Current state
- npm: all 11 packages at 0.1.0 (kinetograph + @kinetographdev/{scene,compat,react,core,audio,studio,native,native-darwin-arm64,native-linux-x64-gnu,native-win32-x64-msvc}), published 2026-10-24 by publish.yml run 40003005784 (native run 39998607907) with provenance.
- main has 3 fixes NOT on npm yet: Vulkan 1.4 cap (PR #2, fc1f4a08), island-edit baseline determinism (PR #3, 9dbe566a), SVG text font inheritance (PR #4, CI pending, auto-merges when green via a background job).
- Issue #1 (CodaVibe, Vulkan 1.4 CPU fallback) closed by the user; comment links PR #2.
- Version bump touches: 14 package.json versions, pinned internal deps "@kinetographdev/*": "0.1.0", Cargo workspace version (Cargo.toml), package-lock.json, Cargo.lock. Site package also 0.1.0 (not published).

## Open threads
- [ ] PR #4 green + merged (background job), then datamosh merge (merge/datamosh, Sonnet agent running)
- [ ] Bump everything to 0.1.1, push, wait native.yml green, publish.yml dry run, then real publish (user authorized 2026-10-25)
- [ ] npm trusted publishing + delete NPM_TOKEN; GitHub release v0.1.0/v0.1.1 with notes
- [ ] 0.1.2: GSAP support (feat/gsap, Sonnet agent running)
- [ ] Unmerged branches still: fix/ink-overflow, feat/text-stroke, feat/studio-agent-copy (user OK'd merging after determinism); delete perf/gpu-yuv (stale) and feat/launch-v2 (merged)

## Key files
- `.github/workflows/publish.yml` (inputs native_run_id, dry_run, tag; NPM_TOKEN secret)
- `.github/workflows/native.yml` (push on all branches; builds 3 platforms + smoke)
- `crates/node/index.js:67` (NAPI_RS_NATIVE_LIBRARY_PATH override: test an addon without overwriting crates/node/*.node)

## Recent sessions
- 2026-10-25-release-and-fixes — 0.1.0 live on npm (@kinetographdev/*, CLI `kinetograph`); fixes merged on main since; 0.1.1 publish pending
