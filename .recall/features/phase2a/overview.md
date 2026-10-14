# phase2a

**Status:** stable
**Paths:** `crates/core/**`, `docs/SCENE.md`
**Last touched:** 2026-10-14

## What this is
HANDOFF §8 Phase 2a (compositing basics): clip paths, gradient masks, track mattes, drop/inset shadow, colour filters,
gradient fills, backdrop blur, glow, chromatic aberration, custom WGSL. Built in a Claude Code cloud session (no GPU).

## Current state
- Done and merged: PR #2 (branch feat/compositing-effects, merge commit 0ca894b on main). PR #1 was closed by the
  branch rename; same commits.
- Verified on the M4: full `cargo test --release` passes; 10 new goldens checked by eye at frame 15 (d3f381f);
  Phase 1 goldens byte-identical; both margin pixel tests pass.
- Speed: a 34-layer papercut diorama with 30 effects (1080x1920) runs 213-313 ms/frame in `bench`, composite ~234 ms.
  Too slow for Phase 3's 5x target; HANDOFF §8 now has a Phase 2c performance pass.
- Layer fields `clip`, `mask`, `matte`; effects `dropShadow`, `insetShadow`, colour filters, `backdropBlur`, `glow`,
  `chromaticAberration`, `shader`; gradient fills. Order per layer: effects -> clip -> mask -> matte -> opacity+blend.
  Scene-wide canvas margin M = max effect reach; textures (w+2M)x(h+2M).

## Open threads
- [ ] Phase 2b runs in a cloud session (kickoff prompt: branch feat/looks-camera-video from main); M4 then renders,
  makes goldens, benches.
- [ ] Phase 2c performance pass (HANDOFF §8 2c), including Phase 1's MSAA 16x / Gaussian / full-canvas textures.
- [ ] Possible follow-up: give custom shaders the backdrop as a second input (custom transitions).
- [ ] Remote branch feat/compositing-effects still exists (no auto-delete); delete if unwanted.

## Key files
- crates/core/src/{scene,resolve,render,compositor,color}.rs, src/tests.rs
- crates/core/src/shaders/{composite,shadow,color,...}.wgsl
- crates/core/tests/{golden,render}.rs, crates/core/tests/scenes/*.json
- docs/SCENE.md

## Recent sessions
- 2026-10-14-m4-verify-and-merge — M4 tests + goldens, papercut demo + bench, 2c planned, merged as PR #2
- 2026-10-14-phase2a-cloud-workflow — 10-agent workflow built all of 2a; history rewritten to drop Claude-Session trailer
