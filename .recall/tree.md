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

- **release** [active] — 0.1.0 live on npm (@kinetographdev/*, CLI `kinetograph`); fixes merged on main since; 0.1.1 publish pending
  - paths: `.github/workflows/**`, `crates/node/npm/**`, `**/package.json`, `scripts/check-packages.mjs`
  - last: 2026-10-25 (release-and-fixes)
- **engine** [active] — Skia default; launch film now identical at 1 vs 4 workers (island baseline fix); workers do not speed the launch film
  - paths: `crates/**`, `vendor/**`, `packages/core/**`, `packages/compat/**`, `packages/cli/src/**`, `packages/cli/skills/kinetograph/references/ENGINE.md`
  - last: 2026-10-25 (release-and-fixes)
- **compat** [active] — GSAP crashes today (feat/gsap in progress); datamosh merge in progress; p5.brush gap test running; HyperFrames ~3x
  - paths: `packages/compat/**`, `packages/scene/src/webgl.ts`, `packages/site/content/docs/compat.mdx`, `packages/site/content/docs/known-issues.mdx`, `packages/cli/skills/kinetograph-migrate/**`
  - last: 2026-10-25 (release-and-fixes)
- **site** [active] — kinetograph.dev live on Vercel (auto-deploy from main); wordmark logo; llms.txt tells agents to install skills
  - paths: `packages/site/**`, `README.md`, `docs/readme/**`
  - last: 2026-10-25 (release-and-fixes)
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
