# phase2c

**Status:** active
**Paths:** `crates/core/**`, `crates/cli/**`, `examples/bench-diorama.json`, `docs/SCENE.md`, `README.md`
**Last touched:** 2026-10-14

## What this is
HANDOFF §8 Phase 2c (performance) on branch perf/layer-bounds, draft PR #4 against main. One commit per item so the
M4 can bench each and revert it alone. Nothing measured in the cloud.

## Current state
- M4 baseline (user, before 2c items): bench-diorama frame 60 310–338 ms/frame (composite 254–273, raster ~64, PNG ~25);
  render 294 ms/frame; motion-blur.json 246 ms/frame at 480x270.
- Commits after the main merge e88064a: bench scene b93f737; bilinear blur 80902cf (changes blurred pixels ±1 level);
  low-res shadow blur 392c6b6 (changes shadows blur ≥ 4); bounds-limited passes 33667d1 and bounds-sized pooled
  textures 00cfbf6 (both meant byte-identical); erf shadows 019e4da (changes eligible shadows); layer cache 6d8ab9c
  (off by default; render and bench --range turn it on); MSAA8 cd0175c (changes every edge); motion-blur sub-frames
  rasterise their bounds 5eb2524 (rare f32 ulp flips, motion-blur golden only); group buffer skip d299486 (f16
  rounding only for multi-child groups; no golden expected to change).
- 276 core + 12 CLI lib tests; four checks green.

## Open threads
- [ ] M4: go commit by commit — bench + goldens after each; keep or revert. Expect golden moves only where the PR says.
- [ ] Reverting C, D or E alone conflicts textually (later commits touch the same lines); F and the group skip revert cleanly.
- [ ] Follow-ups: halftone/warp/displace/custom shader and the blur pyramid still use canvas-size textures (bilinear
  weights depend on size); clip/mask rasters still full-target per motion sub-frame; erf only when the shadow is the
  first effect (diorama's big second shadows still blur); rasterise every layer's bounds in Vello (not byte-identical).
- [ ] Metal fast math could reassociate p.xy + origin in 4 shaders (00cfbf6) → ±1 level; check if B alone moves goldens.

## Key files
- crates/core/src/{bounds,cache,box_shadow,blur,compositor,render}.rs, shaders/shadow_box.wgsl
- crates/cli/src (bench --range)
- examples/bench-diorama.json

## Recent sessions
- 2026-10-14-phase2b-2c-cloud — round 1 (bench, bilinear, low-res shadows) then round 2 (5 agents) + group skip by hand
