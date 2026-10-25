# engine

**Status:** active
**Paths:** `crates/**`, `vendor/**`, `packages/core/**`, `packages/compat/**`, `packages/cli/src/**`, `packages/cli/skills/kinetograph/references/ENGINE.md`
**Last touched:** 2026-10-25

## What this is
The renderer: Rust compositor (Skia/Graphite default, Vello fallback), DOM islands (vendored blitz/stylo/taffy), the TS frame loop and CLI.

## Current state
- Determinism: launch film lossless (libx264 crf 0 yuv444p) gives 0/1184 differing frames between --concurrency 1 and 4 and across runs, after PR #3 (vendor/blitz-dom/src/layout/inline.rs: an inline box measured from taffy's size-only cache had no baseline -> relayout in PerformLayout). Test `an_edited_svg_beside_text_leaves_the_line_as_fresh`.
- The "different md5 every run" seen with h264_videotoolbox is one SEI byte the encoder writes (offset ~36329), not picture data.
- One unexplained one-off: a full c4 lossless render once differed on frame 377 by a 1-px diagonal line; two reruns matched. Keep watching (same family as old OPEN_ISSUES §9 GPU-ordering race).
- Worker scaling (2026-10-25, Skia, M4): launch film 1/2/4/6 workers all ~28-30 s wall (best 26.1 s), CPU time triples; serial limit, likely the single VideoToolbox encoder (not profiled). Papercut ep 13 renders in 22.9 s at c4.
- Vulkan: Skia's API version capped at 1.3 to match wgpu-hal's instance (crates/core/src/render/skia/vulkan.rs:97).
- SVG text inherits font from HTML ancestors (PR #4): crates/dom/src/paint/svg/serialize.rs computed_font(); test svg_text_inherits_its_font_from_the_html_around_it.
- `cargo clippy --all-targets` has 8 pre-existing lints in crates/core (compositor.rs, render/skia/draw*.rs, render.rs); not cleaned.

## Open threads
- [ ] Clean the 8 crates/core clippy lints
- [ ] CLI should log which backend/device it uses (GPU Skia vs CPU Skia vs Vello)
- [ ] Audio test off-by-one (squareA 11917 vs 11918); cli test tsc errors (render-parallel.test.ts)
- [ ] 45 Skia "non-invertible transform" warnings on papercut ep 13 (unchecked)
- [ ] Profile why launch film does not scale with workers
- [ ] FUTURE (user asked 2026-10-25 to park it): scale-out rendering pipeline, in this order:
  1. Chunked rendering: split frames into ranges, render + encode each range separately (machine/container/Lambda), join losslessly with ffmpeg concat (same encoder settings, keyframe at each chunk start), mix audio once. Deterministic frames mean seams cannot drift.
  2. Local parallel CPU encode: libx264 per chunk instead of one VideoToolbox session (VT caps ~218 fps and does not scale with sessions; Linux/Windows have no VT).
  3. Cloud: a `kinetograph render --chunk` primitive, then AWS Lambda and Cloud Run wrappers (no Chrome layer, so a much smaller bundle than Remotion/HyperFrames).
  Context: Remotion scales via --concurrency Chrome tabs + Lambda chunks; HyperFrames via `render --workers N` + AWS Lambda/Cloud Run chunk stitching (packages/aws-lambda, gcp-cloud-run). Ours: launch film ~28-30 s at any --concurrency (encoder + memory bandwidth + shared GPU bound).

## Key files
- `vendor/blitz-dom/src/layout/inline.rs` (baseline fix; noted in vendor/README.md)
- `crates/core/src/render/skia/vulkan.rs:97`
- `crates/dom/src/paint/svg/serialize.rs` (computed_font), `crates/dom/src/paint/svg/mod.rs` (font warnings)
- `packages/core/src/frame-loop.tsx:118` (drawFrame: sequential vs replay, breakSamplePasses)
- `packages/compat/src/dom/index.ts:57` (samplePass, incremental islands; KINETOGRAPH_NO_INCREMENTAL=1)

## Recent sessions
- 2026-10-25-release-and-fixes — Skia default; launch film now identical at 1 vs 4 workers (island baseline fix); workers do not speed the launch film
