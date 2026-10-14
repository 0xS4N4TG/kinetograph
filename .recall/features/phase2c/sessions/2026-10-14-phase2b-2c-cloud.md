# 2026-10-14 — phase2c/phase2b-2c-cloud (also covers phase2b)

**Repo state:** perf/layer-bounds @ d299486 (main 198ea30 merged in at e88064a), pushed; draft PR 0xS4N4TG/kinetograph#4.

## Goal
Build Phase 2b then 2c back to back in one cloud session; code only, all GPU testing on the M4; nothing merged by me.

## What happened
- 2b: brief, 10-agent workflow (Sonnet high impl, Opus high review), history rewrite to drop a Claude-Session trailer,
  PR #3. User checked it on the M4, added goldens, merged it and deleted the branch.
- 2c round 1 (10-agent plan) got through the bench scene, bilinear blur and low-res shadow blur before the session
  restarted; the workflow was lost, the tree was clean.
- User gave new order and the M4 baseline. Merged origin/main, opened draft PR #4 against main, wrote brief-2c-v2,
  ran a 5-agent workflow wf_a3d8b100-e64 (Sonnet xhigh impl ×3, Opus high review ×2; ~1.9M subagent tokens, ~111 min).
  Reviewers found no code bugs; noted wrong golden lists in the round-1 commit messages (corrected in the PR body).
- User asked me to do the group buffer skip myself: d299486.

## Gotchas
- `r#"..."#` breaks on `"#fff"` in JSON test strings; use `r##"..."##`.
- Group `inset` clips are a load error; use polygon in tests.
- Workflows don't survive a session restart; check the journal and git log before relaunching.
