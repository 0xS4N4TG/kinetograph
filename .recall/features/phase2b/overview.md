# phase2b

**Status:** stable
**Paths:** `crates/core/**`, `crates/cli/**`, `docs/SCENE.md`, `README.md`
**Last touched:** 2026-10-14

## What this is
HANDOFF §8 Phase 2b (looks, camera and video): gradientMap, lut (.cube), grain, dither, halftone, dotMatrix,
displace (feTurbulence → feDisplacementMap, papercut seeds 7/11), noise and meshGradient layers, cornerPin,
2.5D camera (rotateX/Y, z, scene camera, preserve3d depth sort), per-layer motion blur, `kinetograph render`
(ffmpeg-next 9; h264_videotoolbox on macOS else libx264; BT.709; 2-frame channel to an encoder thread).

## Current state
- Merged: PR #3 (branch feat/looks-camera-video, merge 0b74a4e on main). The user added the 10 goldens on the M4
  (aebe0f0) and fixed the CLI encode test (as_chunks, 2017378). Branch deleted on GitHub at merge; HANDOFF now says
  keep phase branches after merge.
- Built by a 10-agent cloud workflow (Sonnet impl, Opus review); 223 core + 12 CLI lib tests.

## Open threads
- [ ] Choices flagged in PR #3 for the user: gradientMap/halftone luminance is sRGB Rec.709 (2a masks use linear);
  channel selectors default R/G; noise rgba stored linear; displace margin can be √2 short on rotated layers; matte
  sources can't be 3D; no motion blur under preserve3d; .cube rejects LUT_3D_INPUT_RANGE.
- [ ] Known leftovers: error paths can drop pooled textures (fatal anyway); motion-blur f16 running sum ~1e-3 drift.

## Key files
- crates/core/src/{lut,turbulence,mesh,warp,hash}.rs, render.rs, compositor.rs, shaders/*.wgsl
- crates/cli/src/{lib,encode,render}.rs
- crates/core/tests/scenes/{gradient-map,grain,dither,halftone,dot-matrix,turbulence,mesh-gradient,camera,corner-pin,motion-blur}.json

## Recent sessions
- 2026-10-14-phase2b-2c-cloud — 2b built and merged (PR #3); 2c built on perf/layer-bounds (PR #4)
