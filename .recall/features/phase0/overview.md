# phase0

**Status:** active
**Paths:** `phase0/**`, `docs/**`, `CLAUDE.md`, `.claude/**`, `README.md`
**Last touched:** 2026-10-14

## What this is
Validation before building the engine (docs/HANDOFF.md §8 Phase 0): Remotion speed baseline, an agent trial of fframes, and the build-on-fframes vs own-the-engine decision. Also the initial repo setup.

## Current state
- Decision made: own the engine, built from scratch (HANDOFF §3, CLAUDE.md updated, commit 473e9ff).
- Remotion baseline (phase0/remotion-baseline.md): ep 13 S04, 89 frames, warm 18.6 s total, ~157 ms/frame marginal + 2.26 s fixed per render, still ~2 s. Concurrency 1–10 makes no difference (serial bottleneck, unknown). 5x target: ~3.7 s scene, <0.6 s still.
- fframes trial (phase0/fframes/RESULTS.md, LOG.md): one still of the reference card stack at 22 s, partial match. No perspective/3D in fframes (faked with 32 strips). Incremental build 15.5 s median (link-bound), cold 7m23s; still 0.1 s warm. One E0597 lifetime error.
- fframes code read was stopped by the user; no architecture doc. Clone never finished (nothing on disk).
- phase0/ is untracked (not committed yet).

## Open threads
- [x] Rust toolchain: rustup stable 1.99.0 active via ~/.zshrc PATH (2026-10-14). The first rustup install had been interrupted (no rustc); reinstalled.
- [ ] Decide what to commit from phase0/: keep remotion-baseline.md, fframes LOG/RESULTS/compare/reference src; drop unused papercut/ template and skill-installer clutter (.agents, .claude, .hermes, .kiro, .zcode, skills-lock.json).
- [ ] Start Phase 1 (workspace, compositor layers, blur, blend modes, PNG `still`, `bench`) once the user says go.

## Key files
- docs/HANDOFF.md §3, §8 — decision and roadmap
- phase0/remotion-baseline.md
- phase0/fframes/RESULTS.md, phase0/fframes/LOG.md, phase0/fframes/compare/reference_still_ref_left_fframes_right.jpg
- .claude/settings.json — subagent model/effort

## Recent sessions
- 2026-10-14-setup-and-validation — repo setup, baseline, fframes still, own-the-engine decision
