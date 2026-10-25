# kinetograph

Last touched: 2026-10-25

## Features

<!--
Format per feature:
- **<name>** [status] — one-line summary of current state
  - paths: `glob/**`, `another/glob/**`
  - last: YYYY-MM-DD (session-slug)

Status values: active | stable | blocked | archived
-->

- **release** [active] — 0.1.0 on npm; next is 0.2.0 (PRs #2-#9 merged); changelog branch ready; 6 feature branches in flight
  - paths: `.github/workflows/**`, `crates/node/npm/**`, `**/package.json`, `scripts/check-packages.mjs`
  - last: 2026-10-25 (pipeline-expansion)
- **engine** [active] — PRs #5 datamosh, #8 text, #9 WebGL merged; determinism holds; svg-cascade + WebGPU in flight; rustup PATH trap
  - paths: `crates/**`, `vendor/**`, `packages/core/**`, `packages/compat/**`, `packages/cli/src/**`, `packages/cli/skills/kinetograph/references/ENGINE.md`
  - last: 2026-10-25 (pipeline-expansion)
- **compat** [active] — GSAP + WebGL merged (p5.brush works); HyperFrames loader 11/29 match; lib-compat, plugins, HF extras in flight
  - paths: `packages/compat/**`, `packages/scene/src/webgl.ts`, `packages/site/content/docs/compat.mdx`, `packages/site/content/docs/known-issues.mdx`, `packages/cli/skills/kinetograph-migrate/**`
  - last: 2026-10-25 (pipeline-expansion)
- **site** [active] — changelog page + tagline cleanup on docs/changelog-0.2 (unmerged); Libraries page coming
  - paths: `packages/site/**`, `README.md`, `docs/readme/**`
  - last: 2026-10-25 (pipeline-expansion)
- **studio** [active] — agentic studio (readable names, ACP chat, Canva-simple timeline) on feat/studio-timeline; user reviewing on :3300
  - paths: `packages/studio/**`
  - last: 2026-10-25 (pipeline-expansion)
- **launch-film** [active] — v13 final (~39.5 s, 1184 frames); end-card stills made; renders in ~26-30 s
  - paths: `examples/launch/**`
  - last: 2026-10-25 (release-and-fixes)
- **phase3** [archived] — Node authoring layer (2026-10-14); superseded by the current packages
  - paths: `packages/**`
  - last: 2026-10-14 (phase3-cloud-orchestrator)
- **phase2c** [archived] — Vello-era perf work; superseded by the Skia backend
  - paths: `crates/core/**`
  - last: 2026-10-14 (phase2b-2c-cloud)
- **phase2b** [archived] — looks, camera, motion blur, `render`
  - paths: `crates/core/**`, `crates/cli/**`
  - last: 2026-10-14 (phase2b-2c-cloud)
- **phase2a** [archived] — compositing effects
  - paths: `crates/core/**`
  - last: 2026-10-14 (m4-verify-and-merge)
- **phase1** [archived] — first renderer (Vello, WGSL compositor)
  - paths: `crates/**`
  - last: 2026-10-14 (phase1-workflow)
- **phase0** [archived] — phase0/ folder deleted (moved to Trash 2026-10-24); decision to own the engine stands
  - paths: (none)
  - last: 2026-10-14 (setup-and-validation)
