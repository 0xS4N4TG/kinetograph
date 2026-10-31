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

## Audit 2026-10-30 (verified against origin/main 7b0f4e69; supersedes stale lines below)
- v0.2.5 released 2026-10-28; 0 open issues, 0 open PRs; #2-#71 merged since 10-25.
- DONE since notes: tracking #55/#57, mono fallback + SVG gradients #43, React canvas #44, doctor root attrs #45, Mermaid #47/#56, KaTeX, foreignObject #56, WebGPU compute #24, Windows paths #71 (#27/#28 closed).
- OPEN: merge local stack (feat/studio-redesign contains feat/plugin-ui + docs/migrate-hyperframes; fix/canvas-source-reuse; all merge clean); CHANGELOG Unreleased empty (#71, sources table, plugin tools missing); determinism 1-level Graphite diff; worker scaling; clean bench + speed claims; VAAPI/QSV real-hardware run; npm trusted publishing (publish.yml still NPM_TOKEN); Three.js adapter; tracking Studio UI + ONNX plugin.
- perf/js-frame-loop, perf/pipeline, perf/render-path: local, 106 behind main, need rebase; papercut ep13 c4 -28% / -14.7% / -3.6%, launch -0 / -3.3% / -9.0%; duplicate font/picture-size caches in two of them.
- Housekeeping: origin/fix/windows-paths, archive*, backup/cyberpunk-local, tag q-B, 2 stashes.

## Plan 2026-10-30: next release is 0.3.0
- Contents: Studio redesign + plugins (feat/studio-redesign), canvas sources table (fix/canvas-source-reuse), island-moves perf fix (fix/island-css-moves = perf/js-frame-loop rebased on main, unverified: needs cargo test -p kinetograph-dom + compat vitest on power), HF fixes fix/hf-svg-filter-shadows + fix/hf-fonts-video-blend, site catalog feat/site-catalog (copy decisions pending with user). CHANGELOG Unreleased now has studio + #71 (dcb0921a on the redesign branch).
- Bump (package.json files, Cargo, tag) on release day only, after tests; never pre-bump.

## Open threads
- [ ] Changelog: #12-#16 done (in #16); #18 (GSAP clock, async effects, Flip), #19 (fetch-deps remote pictures), #20 (WebGPU textures + effects), #21 (preserve-3d), #22 (cli test types), #23 (HF grading GPU pass + readback island cache: claude-exchange 12.5->1.7 s, launch film 96->71 s lossless) wrote their own entries; main crates/node addon = #23 build; gate.sh now overwrites its md5 with ffmpeg -y (a stale md5 once gave a false IDENTICAL); add hf-svg-workarounds if it changes behaviour
- [ ] Clean benchmark: include a gsap project started at a late frame (#18 renders skipped frames for gsap imports; cost unmeasured)
- [ ] Before 0.2.0 (decide with user): rare render difference = Skia Graphite on Metal drawing while another renderer uses the GPU: a few pixels off by 1 in one channel, one frame (launch film f747-775 wall of chips; ~2 in 35 full renders). NOT a leak and NOT carried state: shows with layer cache off, gone on redraw, needs 2+ renderers; KINETOGRAPH_SKIA_CPU=1 gives 0 in 58,000 draws. Documented in known-issues (#26). Workaround: --concurrency 1 or KINETOGRAPH_SKIA_CPU=1 (not gate-verified). Next if wanted: minimal Graphite repro, try Skia path-render options, report upstream; scripts in scratchpad/determ (stress4.cjs). The 146 GB 'leak' was the agent's harness (sync loop never let napi buffer finalizers run, +8.3 MB/draw); with a yield per draw memory is flat, engine does not leak. Watchdog scratchpad/watchdog/watchdog.sh (node >6 GB) still worth running for stress work.
- [ ] Clean benchmark AFTER all compat work is merged (user, 2026-10-25), before 0.2.0: idle machine, bench lock, Haiku runner; launch film + showcase + site renders.json set, Kinetograph vs Remotion 4.0.531, 2+ runs each; refresh renders.json + README/site speed claims (public claim ~5x, papercut ~6x)
- [ ] Bump to 0.2.0 (incl. packages/plugins/* in publish.yml), push, native.yml green, publish.yml dry run, real publish (confirm 0.2.0 with user first)
- [ ] npm trusted publishing + delete NPM_TOKEN; GitHub release notes from CHANGELOG

- [ ] 0.2.0 = what is on main now (2026-10-27, user). Deferred to a 0.2.x patch (e.g. 0.2.3): determinism default (0.2.0 ships it as documented in known-issues #26), monospace fallback font (Shiki/Code Hike), SVG gradients interpolated premultiplied (canvas fixed in #39; browsers interpolate SVG gradients unpremultiplied too), Mermaid blank + doctor misses it (documented in known-issues). Worker-scaling profile and concurrency work: 0.2.5 or 0.3.0. #27/#28 Windows paths: fixed in #71, merged 2026-10-29, issues closed; ships in the next release.

- [ ] ROADMAP (2026-10-27): 0.2.x patch = determinism default, monospace fallback, SVG gradients, Mermaid; 0.2.5 or 0.3.0 = worker scaling (profile first); motion tracking DONE (stage 1 #55 + stage 2 #57, merged 2026-10-27; crates/track, `kinetograph track`, `useTrack`); later = tracking studio UI (v2) and the opt-in ONNX plugin (CoTracker / SAM 2).

- [ ] 0.2.x React canvas fix (user 2026-10-27; found, scratchpad/plaincanvas/r): a Remotion-path `<canvas>` drawn in useEffect KEEPS its pixels between frames in a sequential render, but a still (or a worker starting mid-way) does not replay the skipped frames' effects, so frame 45 differs between `still 45` (2 dots) and a full render (trail). Breaks 'a frame is a pure function of its number' and contradicts the docs ('a canvas starts empty each frame'). Fix: clear the canvas at the start of each frame on the React path (as documented). HTML/HF pages are fine: canvas keeps pixels and a jump replays rAF calls; still == render frame (max diff 1).
- [ ] 0.2.x (user 2026-10-27): `doctor` (and render) on an HTML page without the root `data-composition-id`/`data-width`/`data-height`/`data-duration` should say what to add; today it silently renders 1920x1080 for 1 s. Skill already documents the attributes (dba081f9).

## Key files
- `.github/workflows/publish.yml` (inputs native_run_id, dry_run, tag; NPM_TOKEN secret)
- `.github/workflows/native.yml` (push on all branches; builds 3 platforms + smoke)
- `crates/node/index.js:67` (NAPI_RS_NATIVE_LIBRARY_PATH override: test an addon without overwriting crates/node/*.node)

## Recent sessions
- 2026-10-25-pipeline-expansion — 0.2.0 decided; PRs #5-#9 merged; changelog branch ready; 6 feature branches in flight [deep]
- 2026-10-25-release-and-fixes — 0.1.0 live on npm (@kinetographdev/*, CLI `kinetograph`); fixes merged on main since; 0.1.1 publish pending
