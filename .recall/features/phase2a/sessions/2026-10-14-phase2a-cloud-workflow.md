# 2026-10-14 — phase2a/phase2a-cloud-workflow

**Repo state:** phase2a @ 889f3a0 (18 commits over main 6b05182), pushed; PR 0xS4N4TG/kinetograph#1 open.

## Goal
Build Phase 2a in a cloud session (code only; GPU work on the M4) with a 10-agent workflow: Sonnet 5.5 high
implementers, Opus 5.5 high reviewers, orchestrator in the main session.

## What happened
- Session started on stale branch (initial commit only); fetched main, created `phase2a`, verified push and a clean
  baseline (build/fmt/clippy/test --lib, 17 tests).
- Wrote a shared design brief (gradient type, clip/mask/matte, margin, each effect's schema) so agents agreed.
- Workflow wf_f68cc2a9-3e1: impl masks -> review -> impl shadows -> impl colour -> review -> impl gradients ->
  impl backdrop/glow/CA -> review -> impl shader -> final review. 10 agents, 0 errors, ~68 min, ~1.84M subagent tokens.
- Reviewers fixed: margin must sum chained shadows and count negative spread; margin test 1-level tolerance; scene test
  loads fonts/images; `kg_` names rejected in user shaders; doc tidy-ups.
- I re-ran the four checks (88 lib tests pass), rewrote the PR #1 description, subscribed to PR activity, armed a
  safety-net check-in (trig_01LLUJZc7p3ZK6eXzqSrnoGU).
- User asked to remove the `Claude-Session:` trailer from history: filter-branch --msg-filter over origin/main..phase2a,
  tree unchanged, force-with-lease push (a138e0d -> 889f3a0).
- Q&A: billing pool not visible from inside the session; explained custom WGSL; mapped camera/transitions/cuts to later
  phases (2b camera + motion blur, Phase 3 Sequence/Series/transitions, 3D after 3, Chrome fallback Phase 5).

## Gotchas
- Stop hook nags about uncommitted changes while workflow agents are mid-edit; ignore until the workflow finishes.
- The repo has no CI, so PR checks are empty; verification is the M4 run.
- Commit SHAs in the workflow output are pre-rewrite; use `git log origin/main..phase2a`.
