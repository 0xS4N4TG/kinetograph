# kinetograph

Last touched: 2026-10-14

## Features

<!--
Format per feature:
- **<name>** [status] — one-line summary of current state
  - paths: `glob/**`, `another/glob/**`
  - last: YYYY-MM-DD (session-slug)

Status values: active | stable | blocked | archived
-->

- **phase0** [stable] — decided to own the engine (not fframes); Remotion baseline + fframes still committed (reference-video crops gitignored)
  - paths: `phase0/**`, `docs/**`, `CLAUDE.md`, `.claude/**`, `README.md`
  - last: 2026-10-14 (setup-and-validation)
- **phase1** [stable] — core renderer done: JSON scene graph, Vello raster, linear-light WGSL compositor, 16 blend modes, Gaussian blur, `still`, `bench`, golden tests
  - paths: `crates/**`, `examples/**`, `assets/**`, `docs/SCENE.md`, `docs/HANDOFF.md`
  - last: 2026-10-14 (phase1-workflow)
- **phase2a** [stable] — merged (PR #2, branch feat/compositing-effects); M4 tests + goldens pass; next 2b (cloud) and 2c perf
  - paths: `crates/core/**`, `docs/SCENE.md`
  - last: 2026-10-14 (m4-verify-and-merge)
- **phase2b** [stable] — looks, camera, motion blur, `render`; merged (PR #3); goldens from the M4
  - paths: `crates/core/**`, `crates/cli/**`, `docs/SCENE.md`, `README.md`
  - last: 2026-10-14 (phase2b-2c-cloud)
- **phase2c** [active] — perf items one commit each on perf/layer-bounds, draft PR #4; M4 bench + goldens per commit next
  - paths: `crates/core/**`, `crates/cli/**`, `examples/bench-diorama.json`
  - last: 2026-10-14 (phase2b-2c-cloud)
