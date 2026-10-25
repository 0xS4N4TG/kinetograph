# 2026-10-25 — engine/release-and-fixes

**Session ID:** 2026-10-25-release-and-fixes  (split across release, engine, compat, site, launch-film)
**Repo state:** main @ 9dbe566a, 2 dirty (untracked .playwright-mcp/, examples/rajz-cards/example/)

## Goal
Ship and harden Kinetograph after launch: npm release, outside bug report, determinism, comparisons, new library support.

## What happened
- Measured worker scaling and found the c1 vs c4 frame difference (frames 180-181, caption "screenshotting"); bisected with KINETOGRAPH_NO_INCREMENTAL; Sonnet agent found the taffy cache baseline loss; I verified (test red/green, full film md5s) and merged PR #3.
- SVG font bug found via the HyperFrames chart port; Sonnet agent fixed it; verified and opened PR #4.

## Decisions made
- Determinism check = lossless render (libx264 crf 0 yuv444p) compared with ffmpeg framemd5, never mp4 md5 (VideoToolbox writes a varying SEI byte).
- A warm (incremental) frame must equal a cold build; fix the edit path, never disable incremental mode.
- Removed ENGINE.md §12 "launch is GPU-bound, 4 workers 30-36 s" note: measured before Skia.

## Open threads at end of session
- [ ] Clean the 8 crates/core clippy lints
- [ ] CLI should log which backend/device it uses (GPU Skia vs CPU Skia vs Vello)
- [ ] Audio test off-by-one (squareA 11917 vs 11918); cli test tsc errors (render-parallel.test.ts)
- [ ] 45 Skia "non-invertible transform" warnings on papercut ep 13 (unchecked)
- [ ] Profile why launch film does not scale with workers
