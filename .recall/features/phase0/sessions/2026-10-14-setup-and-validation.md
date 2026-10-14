# 2026-10-14 — phase0/setup-and-validation

**Session ID:** 2026-10-14-kinetograph-1
**Repo state:** main @ 473e9ff, 1 dirty (phase0/ untracked)

## Goal
Set up the GitHub repo and run Phase 0 (validate fframes vs owning the engine).

## What happened
- Haiku subagent: git init, .gitignore (mp4 ignored), LICENSE-MIT/APACHE, README, private repo pushed (e8fd861).
- Sonnet subagent: Remotion baseline of ep 13 S04 → phase0/remotion-baseline.md.
- fframes code-read agent launched, later stopped by the user mid-clone.
- fframes rebuild agent: installed skill locally + cargo-fframes, built reference card stack; user cut scope to one still → RESULTS.md, LOG.md, compare JPG.
- I wrongly said subagents were on Opus; they were on Sonnet 5.5 via global env. Added project .claude/settings.json anyway (3b47669).
- User decided: build engine from scratch. Recorded in HANDOFF §3/§8 and CLAUDE.md (473e9ff).
- User installed rustup; my toolchain check was rejected — waiting.

## Files touched
- .gitignore, LICENSE-MIT, LICENSE-APACHE, README.md (subagent)
- .claude/settings.json — subagent model/effort
- docs/HANDOFF.md — §3 decision, §8 step 2 marked decided
- CLAUDE.md — Phase 0 instruction replaced with decision + "Next is Phase 1"
- phase0/remotion-baseline.md, phase0/fframes/** (subagents, untracked)

## Decisions made
- Own the engine, not fframes (user).
- Private repo, MIT OR Apache-2.0, reference mp4 local only.
- fframes trial cut to one still.
- Subagents: Sonnet 5.5, high effort.

## Open threads at end of session
- [ ] Verify Rust toolchain (rustup vs Homebrew rustc on PATH).
- [ ] Commit phase0/ evidence, drop clutter.
- [ ] Phase 1 kickoff on user's go.

## Gotchas
- Homebrew rustc dies: llvm linked to libz3.4.15, z3 is 5.1.0. fframes agent shimmed with DYLD_FALLBACK_LIBRARY_PATH.
- `npx skills add` drops dirs for many agent tools (.agents, .claude, .hermes, .kiro, .zcode) into cwd.
- Remotion render of S04 isn't byte-deterministic (two alternating PNGs, ≤3/channel diff).
- Remotion scratch outputs live in the session scratchpad (temporary): remotion-bench/S04-final.mp4, still-1.png.
- Check CLAUDE_CODE_SUBAGENT_MODEL before claiming a subagent's model.
