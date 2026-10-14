# 2026-10-14 — phase1/phase1-workflow

**Repo state:** main, Phase 1 commits 00817e2..aea6ae6 plus docs/recall commit; pushed to origin.

## Goal
User: run a small workflow (≤5 agents; Opus orchestrating, Sonnet 5.5 high implementing and reviewing), complete Phase 1, commit and push.

## What happened
- Fixed toolchain: rustup stable install was interrupted (no rustc); reinstalled 1.99.0; ~/.zshrc PATH puts ~/.cargo/bin and /opt/homebrew/opt/rustup/bin first.
- Committed phase0 evidence (a38280b), amended to exclude reference-video crops.
- Workflow wf_5a0e2481-fdc: impl core → impl effects → review (1 major: blur not shift-invariant, 4 minor) → fix → final review (pass, minors only). ~49 min, 705k subagent tokens.
- I re-verified: fmt, clippy -D warnings, tests (31) pass in release; two `still` runs byte-identical; bench total 46.3 ms; viewed the papercut still (looks right).
- Discussion: Remotion API mapping, missing Phase 2 items (clip paths, masks, shadows, colour filters, gradients), custom WGSL escape hatch, Three.js via WebGPU, runtime choice (rquickjs vs V8; Bun vs Ion). User found runtime options confusing; simplified answer given.

## Gotchas
- Vello 0.11: image atlas reset when scene has only solid paths → blank images on later frames; second renderer workaround.
- Vello Area AA nondeterministic → MSAA16.
- Golden PNGs are M4/Metal-specific.
