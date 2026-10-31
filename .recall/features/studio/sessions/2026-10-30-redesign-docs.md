# 2026-10-30 — redesign docs (shared session: studio, release, site)

**Repo state:** feat/studio-redesign @ 078b20fc at ../kinetograph-redesign; main checkout on fix/canvas-source-reuse (dirty: .recall audit). Machine on battery: no builds/tests run today after the audit.

## What happened
- Plugin-card builder finished: plugin cards in the Props tab, range selection + contact sheet for the agent, edited props and panel state survive a reload (5c3c005e). PR #71 (Windows paths) merged; #27/#28 closed.
- Docs for the new editor written by a Sonnet builder (network died at the recall step; finished by hand): CHANGELOG dcb0921a, README 95483a00, site docs 078b20fc. ffmpeg-license.mdx: dropped the "not legal advice" line (user).
- Other branches today: fix/island-css-moves (perf/js-frame-loop on main, clean cherry-picks, unverified), feat/site-catalog (/plugins page generated out of ../kinetograph-effects: 4 plugins, 5 templates).
- HF audit: 29 comps 20/7/2/0; CSS-filter-in-SVG and variable-font fixes on the fix/hf-* branches.

## Decisions made
- Next release 0.3.0, not 0.2.6: the editor is replaced and plugins are new; patch numbers are for fixes.
- perf/js-frame-loop is a general fix (any stylesheet mentioning transition/animation kept islands out of the cache); the launch film didn't move because it has no stylesheet.

## Gotchas
- `git worktree add` for feat/studio-redesign fails: the branch is already checked out at ../kinetograph-redesign; work there.
- The PII hook blocks a Bash command or Agent prompt whose text contains a "from" that looks like a mail header.
