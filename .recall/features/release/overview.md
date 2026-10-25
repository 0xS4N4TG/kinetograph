# release

**Status:** active
**Paths:** `.github/workflows/**`, `crates/node/npm/**`, `**/package.json`, `scripts/check-packages.mjs`
**Last touched:** 2026-10-25

## What this is
Publishing Kinetograph: npm packages, the native CI matrix (native.yml), publish.yml, GitHub issues/PRs, version bumps.

## Current state
- npm still 0.1.0. Decision: next release is 0.2.0, not 0.1.1 (many features; output changes). Bump plan unchanged (14 package.json + pinned "@kinetographdev/*" deps + Cargo workspace + both lockfiles), plus new plugin packages under packages/plugins/* must join publish.yml.
- On main since 0.1.0: PRs #2 Vulkan cap, #3 determinism, #4 SVG font, #5 datamosh, #6 studio Copy for agent, #7 GSAP, #8 text fixes, #9 WebGL. README tagline lost "with no browser in it" (5bbab94f, pushed via #8).
- Behaviour changes for notes: text with glow/shadow/opacity/rotation keeps descenders (snapshot re-approve); AbsoluteFill background emitted as hex; failed DOM measurement warns not throws; WebGL canvases start empty each frame; pending: studio URLs need ?token=, bundler may pick browser builds (lib-compat).
- Branch docs/changelog-0.2 (tip 7c12a797, worktree agent-ae0769cba1663a815, not pushed): CHANGELOG.md + site /docs/changelog; needs #8 (text) and #9 (WebGL) entries added before PR.

## Open threads
- [ ] Update docs/changelog-0.2 with #8 + #9 entries, drop text-stroke from unsupported lists, PR + merge
- [ ] Merge remaining 0.2.0 work: studio-agentic (+timeline), hyperframes-html (+more), lib-compat, plugins, svg-cascade, webgpu (each verified: tests, launch film framemd5, determinism)
- [ ] Clean benchmark AFTER all compat work is merged (user, 2026-10-25), before 0.2.0: idle machine (no agents/cargo; scratchpad/final/bench.sh acquire), Haiku runner; launch film + showcase + site renders.json set, Kinetograph vs Remotion 4.0.531 same M4, 2+ runs each; refresh renders.json render_median + README/site speed claims (current public claim ~5x, papercut ~6x; old launch baseline 1521 f 183.6 s in scratchpad/final/baseline.txt)
- [ ] Bump to 0.2.0, push, native.yml green, publish.yml dry run, real publish (user authorized a release earlier; confirm 0.2.0 before publishing)
- [ ] npm trusted publishing + delete NPM_TOKEN; GitHub release notes from CHANGELOG
- [ ] Reddit/X: reply drafted for "does it build an editable After Effects file" (no; AE .jsx export idea parked)

## Key files
- `.github/workflows/publish.yml` (inputs native_run_id, dry_run, tag; NPM_TOKEN secret)
- `.github/workflows/native.yml` (push on all branches; builds 3 platforms + smoke)
- `crates/node/index.js:67` (NAPI_RS_NATIVE_LIBRARY_PATH override: test an addon without overwriting crates/node/*.node)

## Recent sessions
- 2026-10-25-pipeline-expansion — 0.2.0 decided; PRs #5-#9 merged; changelog branch ready; 6 feature branches in flight [deep]
- 2026-10-25-release-and-fixes — 0.1.0 live on npm (@kinetographdev/*, CLI `kinetograph`); fixes merged on main since; 0.1.1 publish pending
