# release

**Status:** active
**Paths:** `.github/workflows/**`, `crates/node/npm/**`, `**/package.json`, `scripts/check-packages.mjs`
**Last touched:** 2026-10-25

## What this is
Publishing Kinetograph: npm packages, the native CI matrix (native.yml), publish.yml, GitHub issues/PRs, version bumps.

## Current state
- npm still 0.1.0. Next release 0.2.0. Merged since 0.1.0: #2-#9, #10 changelog page, #11 agentic studio, #12 lib-compat, #13 HyperFrames, #14 svg-cascade, #15 WebGPU. Main 4a2a1511; main's crates/node addon replaced with the merged build (old copy scratchpad/gate/main-addon-old.node).
- CHANGELOG.md + site /docs/changelog cover #2-#11; #12-#15 entries still to add (behaviour: rAF after frame render; bundler browser map for unresolved imports; HF body margin 0; Arial/Helvetica -> Inter for HF pages only).
- Gate script: scratchpad/gate/gate.sh <checkout> <tag> (ADDON= override; links launch node_modules/public/fx); baseline scratchpad/gate/main.md5. Do NOT set NAPI_RS_NATIVE_LIBRARY_PATH when running vitest (breaks rolldown, also napi-rs).

## Open threads
- [ ] Changelog entries for #12-#15 (+ plugins, hf-svg-workarounds)
- [ ] Clean benchmark AFTER all compat work is merged (user, 2026-10-25), before 0.2.0: idle machine, bench lock, Haiku runner; launch film + showcase + site renders.json set, Kinetograph vs Remotion 4.0.531, 2+ runs each; refresh renders.json + README/site speed claims (public claim ~5x, papercut ~6x)
- [ ] Bump to 0.2.0 (incl. packages/plugins/* in publish.yml), push, native.yml green, publish.yml dry run, real publish (confirm 0.2.0 with user first)
- [ ] npm trusted publishing + delete NPM_TOKEN; GitHub release notes from CHANGELOG

## Key files
- `.github/workflows/publish.yml` (inputs native_run_id, dry_run, tag; NPM_TOKEN secret)
- `.github/workflows/native.yml` (push on all branches; builds 3 platforms + smoke)
- `crates/node/index.js:67` (NAPI_RS_NATIVE_LIBRARY_PATH override: test an addon without overwriting crates/node/*.node)

## Recent sessions
- 2026-10-25-pipeline-expansion — 0.2.0 decided; PRs #5-#9 merged; changelog branch ready; 6 feature branches in flight [deep]
- 2026-10-25-release-and-fixes — 0.1.0 live on npm (@kinetographdev/*, CLI `kinetograph`); fixes merged on main since; 0.1.1 publish pending
