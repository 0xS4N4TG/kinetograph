# compat

**Status:** active
**Paths:** `packages/compat/**`, `packages/scene/src/webgl.ts`, `packages/site/content/docs/compat.mdx`, `packages/site/content/docs/known-issues.mdx`, `packages/cli/skills/kinetograph-migrate/**`
**Last touched:** 2026-10-25

## What this is
What third-party code runs on Kinetograph: Remotion packages, GSAP, WebGL libraries, and benchmarks against Remotion/HyperFrames.

## Current state
- vs Remotion: papercut ep 13 Kinetograph 22.9 s vs Remotion 131 s (22 Oct quiet machine) = ~6x. 25 Oct rerun gave Remotion ~16 min (busy machine, untrusted). Launch film can't render in Remotion (uses Kinetograph-only 3D).
- vs HyperFrames (heygen-com/hyperframes @7bc363c, Apache-2.0): its NYT Graph example ported to TSX (/private/tmp/claude-501/-Users-sanatgupta-Documents-Code-RustProjects-kinetograph/5148e0af-5c77-4567-bffa-ed032d28ec61/scratchpad/vs-hf/kg/index.tsx): Kinetograph ~2.8-3.0 s vs HyperFrames 9.0 s (4 workers) = ~3x. Earlier port render lacked SVG labels (old addon; fixed by PR #3) and labels were serif (PR #4). Port's headline weight wrong (should be bold). Not a drop-in: HyperFrames = HTML + GSAP scripts.
- GSAP: crashes ("no element at path $0.2 in the island") with the standard paused-timeline + seek(frame/fps) pattern; repro /private/tmp/claude-501/-Users-sanatgupta-Documents-Code-RustProjects-kinetograph/5148e0af-5c77-4567-bffa-ed032d28ec61/scratchpad/gsaptest/index.tsx. Sonnet medium agent on feat/gsap; Haiku building Remotion/Chrome references in /private/tmp/claude-501/-Users-sanatgupta-Documents-Code-RustProjects-kinetograph/5148e0af-5c77-4567-bffa-ed032d28ec61/scratchpad/gsap-corpus (g01-g08, frames 0,10,20,30,45,59).
- datamosh: Sonnet medium agent merging feat/datamosh into merge/datamosh (Skia path check, launch film unchanged).
- p5.brush (MIT): needs WebGL2; Kinetograph has a native WebGL port (packages/scene/src/webgl.ts) with gaps (no depth/stencil attachments, renderbuffers, float textures, instancing, points/lines, readPixels refused, framebuffers blank each frame). Haiku agent testing the standalone build in /private/tmp/claude-501/-Users-sanatgupta-Documents-Code-RustProjects-kinetograph/5148e0af-5c77-4567-bffa-ed032d28ec61/scratchpad/p5brush for a gap list.

## Open threads
- [ ] Review + merge feat/gsap (then compat.mdx lists GSAP), ship in 0.1.2
- [ ] Review + merge merge/datamosh
- [ ] p5.brush gap list -> scoped WebGL gap tasks (Sonnet medium) so it runs as-is; optional @kinetographdev/p5 adapter later
- [ ] Re-run HyperFrames comparison on published 0.1.1 with bold headline; parity images
- [ ] HyperFrames drop-in (HTML entry + script runtime + their data-* contract): est 2-4 weeks; product decision pending

## Key files
- `packages/compat/src/shim/` (3.4k-line DOM shim: element.ts, tree.ts, canvas.ts)
- `packages/scene/src/webgl.ts`
- `packages/site/content/docs/compat.mdx:36` ("What works")

## Recent sessions
- 2026-10-25-release-and-fixes — GSAP crashes today (feat/gsap in progress); datamosh merge in progress; p5.brush gap test running; HyperFrames ~3x
