# phase2a

**Status:** active
**Paths:** `crates/core/**`, `docs/SCENE.md`
**Last touched:** 2026-10-14

## What this is
HANDOFF §8 Phase 2a (compositing basics): clip paths, gradient masks, track mattes, drop/inset shadow, colour filters,
gradient fills, backdrop blur, glow, chromatic aberration, custom WGSL. Built in a Claude Code cloud session (no GPU).

## Current state
- Code complete on branch `phase2a`, PR 0xS4N4TG/kinetograph#1 (open, base main). 18 commits ed39ad2..889f3a0.
- Cloud checks pass: build, fmt --check, clippy -D warnings, `cargo test --lib` (88). NOTHING rendered yet.
- Layer fields `clip`, `mask`, `matte`; effects `dropShadow`, `insetShadow`, `saturate`, `contrast`, `brightness`,
  `grayscale`, `sepia`, `hueRotate`, `invert`, `backdropBlur`, `glow`, `chromaticAberration`, `shader`. Shape `fill` /
  text `color` take a colour or `Gradient` (linear/radial/conic, extend pad/repeat/reflect).
- Order per layer: effects -> clip -> mask -> matte -> opacity+blend. Matte sources are not drawn on their own.
- Scene-wide canvas margin M = max effect reach (Phase 1 `blur` excluded), textures (w+2M)x(h+2M), readback crops.
  Phase 1 scenes have M=0 and should stay byte-identical (argued, not run).
- Colour filters merge consecutive entries into one 4x5 matrix, applied in sRGB (browser behaviour).
- Custom shader: user writes `fn effect(px) -> vec4<f32>`; prelude gives `layer(px)`, `kg` (frame, time, size, margin),
  `u.<name>` uniforms; validated at load with naga (layer id + line:col); pipelines built once in Compositor::new.
  Sees only its own layer (no backdrop input).
- CPU safety nets: naga validates every src/shaders/*.wgsl; every tests/scenes + examples JSON loads (fonts, images).

## Open threads
- [ ] On the M4: `cargo test` (Phase 1 goldens must still match), render + eyeball 10 new scenes at frame 15, then
  `UPDATE_GOLDEN=1 cargo test --test golden`: clip-paths, masks, mattes, shadows, colour-filters, gradient-fills,
  backdrop-blur, glow, chromatic-aberration, shader.
- [ ] New pixel tests in tests/render.rs: a_shadow_can_fall_on_the_canvas_from_a_layer_outside_it,
  a_margin_does_not_move_or_change_the_canvas (1-level tolerance).
- [ ] `bench` shadow/glow/backdrop-heavy scenes: Phase 1 Blur::run allocates textures per call, now called far more.
- [ ] Riskiest unrun bits: custom shader bind group / uniform sizes on Metal; conic start at 12 o'clock clockwise;
  chromatic aberration fringe direction; glow clamp at intensity 4; backdrop blur inside moving groups.
- [ ] Possible follow-up offered: give custom shaders the backdrop as a second input (custom transitions).
- [ ] PR body still contains the session link (user removed it from commit messages only; asked whether to strip it).

## Key files
- crates/core/src/{scene,resolve,render,compositor,color}.rs, src/tests.rs
- crates/core/src/shaders/{composite,shadow,color,...}.wgsl
- crates/core/tests/{golden,render}.rs, crates/core/tests/scenes/*.json
- docs/SCENE.md

## Recent sessions
- 2026-10-14-phase2a-cloud-workflow — 10-agent workflow built all of 2a; history rewritten to drop Claude-Session trailer
