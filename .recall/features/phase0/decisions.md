# phase0 — decisions

## Own the engine instead of building on fframes
**Date:** 2026-10-14
**Call:** Build Kinetograph's renderer from scratch; fframes is a reference only (CLI design, pipeline ideas, no code).
**Why:** User's call. Supported by the trial: fframes renders SVG per frame with affine transforms only, so 2.5D camera, depth sort, blend-mode compositing and motion blur don't fit; perspective had to be faked with 32 strips.
**Tradeoff:** More to build; no head start on Skia/libav plumbing.

## Repo: private, dual licence, reference video gitignored
**Date:** 2026-10-14
**Call:** Private GitHub repo 0xS4N4TG/kinetograph, MIT OR Apache-2.0, rajz-reference.mp4 kept local only.
**Why:** Nothing built yet; the reference is third-party footage.

## Phase 0 scope cut to one fframes still
**Date:** 2026-10-14
**Call:** No papercut port, no full renders, no render benchmarks in fframes.
**Why:** User: one still is enough evidence; decision was already made.

## Subagents default to Sonnet 5.5 at high effort
**Date:** 2026-10-14
**Call:** CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-5-5 (global and project), modelSettings effort high in .claude/settings.json.
**Why:** User preference; ask before using Opus.
