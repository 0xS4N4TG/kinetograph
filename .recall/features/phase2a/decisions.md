# phase2a — decisions

## Branch phase2a, not the session's assigned branch
**Date:** 2026-10-14
**Call:** Work on `phase2a` from origin/main (user named it). PR #1 opened from the Claude Code UI.

## Scene-wide canvas margin, Phase 1 blur not counted
**Date:** 2026-10-14
**Call:** Pad every texture by M = max reach of Phase 2a effects (shadows count chained sums and shrinking spread).
**Why:** "Layer bounds padded so nothing clips" with canvas-sized textures. Excluding `blur` keeps Phase 1 scenes at M=0,
so their goldens stay byte-identical (blur pyramid grid would shift otherwise).
**Tradeoff:** a blur after another effect can lose its faint tail past M.

## CSS order and semantics
**Date:** 2026-10-14
**Call:** effects -> clip -> mask -> matte -> blend; gradients interpolate in sRGB premultiplied; colour filters in sRGB;
conic angle from 12 o'clock clockwise; inset clip relative to the layer box (error on groups); matte source hidden (AE).

## Backdrop blur coverage and groups
**Date:** 2026-10-14
**Call:** Shape layers frost their whole geometry (translucent fill still frosts); others use alpha. Inside a group the
backdrop is the parent's backdrop + the group's earlier children.

## Blur::run per-call allocation left alone
**Date:** 2026-10-14
**Call:** Not pooled. **Why:** Phase 1 code, textures not canvas-sized; decide after `bench`.

## Commit trailers: no Claude-Session line
**Date:** 2026-10-14
**Call:** User had the `Claude-Session:` trailer removed from all phase2a commits (filter-branch + force-push).
Keep `Co-Authored-By` only in future commits.

## Opus allowed as reviewer here
**Date:** 2026-10-14
**Call:** User asked for Sonnet 5.5 high implementers + Opus 5.5 high reviewers for this phase.

## Branch names describe the work
**Date:** 2026-10-14
**Call:** Repo will be public: `feat/<work>` branches, phase number in the PR title, no session links in commits or PRs.

## Merge phases with a merge commit
**Date:** 2026-10-14
**Call:** Keeps commit SHAs that notes and recall reference valid.

## Cloud codes, M4 renders
**Date:** 2026-10-14
**Call:** User wants coding in cloud sessions (laptop closed); the M4 does rendering, goldens, benchmarks and ideation.
