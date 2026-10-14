# phase3

**Status:** active
**Paths:** `docs/AUTHORING.md`, `packages/**`, `crates/node/**`, `crates/core/**`, `crates/cli/**`, `spikes/three-dawn/**`,
`examples/rajz-cards/**`
**Last touched:** 2026-10-14

## What this is
HANDOFF §8 Phase 3 (authoring + agents), built in one cloud session: an Opus orchestrator wrote the contract
(`docs/AUTHORING.md`) and typed stubs, five Sonnet subagents built the streams in worktrees, the orchestrator merged
them into `feat/node-authoring` (draft PR against main). Stream PRs: #6 reconciler, #7 CLI/audio/MCP, #8 Remotion shim,
#9 N-API addon, #10 layout/glyphs/Lottie. No GPU was opened in the cloud.

## Current state
- CPU checks green: Rust lib core 346, cli 19, node 9; npm native 8 (+9 GPU skipped), scene 63, react 111, core 199,
  audio 39, cli 90.
- The reference rebuild runs end to end on the CPU through the real CLI (bundle, Google font, shim, reconciler, frame
  loop, addon inspect/lint) and is deterministic across processes. Not rendered.

## Open threads
- [ ] M4: `cargo test` (7 new goldens: image-fit, box-units, motion-frames, origin-align, layout, glyph-text, lottie;
      renderer_reuse), `KINETOGRAPH_GPU_TESTS=1 npm test -w @kinetograph/native`, spike 1, spike 2, render the reference.
- [ ] M4: TSX port of ep 13 S04Meter, timing against Remotion (go/no-go 5x).
- [ ] Box-unit linear gradients at non-axis angles are skewed on non-square boxes (helper has no box size).
- [ ] Not implemented from @remotion/*: makeArrow, makeCallout, makeSpark, warpPath, interpolatePaths,
      useTransitionProgress, extra presentations; `<Svg>` and `<Video>` elements.
