# Kinetograph

A browserless programmatic video engine: agents write Remotion-shaped TypeScript and Web Audio code, Node runs it,
and a Rust GPU compositor (an N-API addon) renders it. "Kinetograph" is the final name (decided 2026-10-16).

Phases 0 to 5 are built and merged into `main` (core renderer, effects, authoring, studio and video layers, Remotion
compat on a native DOM engine, GPU-pass work); see `README.md`, `docs/ENGINE.md`, `docs/AUTHORING.md` and `docs/SCENE.md`.
The Remotion compatibility reference (what is drawn, what is unsupported, `doctor`) is on the kinetograph site at
`/docs/#compat`, and the known gaps at `/docs/#known-issues`.

- `docs/reference/`: the target motion-graphics video (`rajz-reference.mp4`) and frame sheets from it.

Decided 2026-10-14: own the engine, built from scratch. fframes is a reference only. Phase 2 (2a,
2b, 2c) done 2026-10-14. Phase 3 done 2026-10-15 (PR #11, with its fixes #18–#21). Phases 4 and 5 and
the GPU-pass work merged into `main` 2026-10-16 (S04 7.0x faster than Remotion; papercut corpus 988/988 frames native).
Phase 6 done 2026-10-16: Canvas 2D, CSS gaps, corpus leftovers, WebGL fragment shaders, the own 3D layer, and the
Chrome fallback is removed (the render path has no browser; unsupported content warns, `--strict` fails; Chrome for
Testing stays only as a test oracle).

Use the rustup toolchain (`~/.cargo/bin`, `/opt/homebrew/opt/rustup/bin`); Homebrew's `/opt/homebrew/bin/rustc` is
broken.

Related code elsewhere on this machine (`$KINETOGRAPH_CORPUS` is a private corpus repo; its local path is in the
untracked `CLAUDE.local.md`):

- Papercut Remotion pipeline (first real test corpus):
  `$KINETOGRAPH_CORPUS/lib/papercut/` (kit, `CATALOG.md`, `tools/render.sh`)
- Synthesised SFX in JS (first synth test corpus):
  `$KINETOGRAPH_CORPUS/lib/audio/sfx/`

Rules:

- Rendering is a pure function of (project, frame); nothing reads the wall clock.
- Measure speed claims with a benchmark; never assume them.
- Reimplement Remotion APIs from their documented behaviour; don't copy Remotion source (licence).
- Use existing crates for text shaping, layout and rasterising; write the glue.
- No browser in the render path, ever, canvas and WebGL included. Chrome for Testing is a test oracle only; never propose Chrome as a feature's answer.
- Port, don't work around: draw every CSS and SVG feature natively. No Chrome image layers, no parallel Chrome pages.
- Unsupported content is drawn without (or approximated) and warned about; `--strict` makes it an error. Decide per frame, never per scene.
- `random(seed)` must match Remotion's implementation bit for bit.
- Never measure text before its fonts are registered.
- GPU tests, goldens and `bench` run on the M4; cloud sessions write code only.

---

# Behavioral Guidelines

Guidelines to reduce common LLM coding mistakes.

**Tradeoff:** These bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and
clarifying questions come before implementation rather than after mistakes.

---

# Project Conventions

## Git: commit per major change

After completing each major change (a feature, redesign, or distinct fix), create a git commit so we always have
backups/restore points. Don't batch many unrelated changes into one commit — one logical change per commit, with a clear
Conventional Commits message. Push to `origin` only when the user asks.
