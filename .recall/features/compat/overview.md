# compat

**Status:** active
**Paths:** `packages/compat/**`, `packages/scene/src/webgl.ts`, `packages/site/content/docs/compat.mdx`, `packages/site/content/docs/known-issues.mdx`, `packages/cli/skills/kinetograph-migrate/**`
**Last touched:** 2026-10-25

## What this is
What third-party code runs on Kinetograph: Remotion packages, GSAP, WebGL libraries, and benchmarks against Remotion/HyperFrames.

## Current state
- GSAP: MERGED (PR #7). Root cause of the "$0.2" crash was an off-by-one in packages/react/src/readback.ts (paths counted AbsoluteFill's dropped background rect). 8-case corpus matches Remotion (mean <=0.14 levels, text <=1.13). Plugins TextPlugin/SplitText/DrawSVG/MotionPath/CustomEase checked; Flip loads untested. Gap: a tween not on a paused seeked timeline stays frozen, no warning yet.
- WebGL: MERGED (PR #9): gl_VertexID, per-frame fresh ops (preserveDrawingBuffer no longer carries frames: behaviour change), POINTS via instanced quads (max 511), blitFramebuffer, texSubImage2D into FBO textures, instancing (divisor 1). p5.brush standalone strokes/hatch/fill match Chrome (mean <=0.1). All 14 HyperFrames WebGL shader transitions draw. Still unsupported: lines, depth/stencil, renderbuffers, readPixels, divisor>1.
- Library smoke test (main before GSAP merge): works = d3 via React, rough.js, visx, Matter, Motion static, @remotion/motion-blur/layout-utils/captions, Chart.js, Rapier (f0 blank). Broken = d3-selection (compareDocumentPosition), anime.js + Motion animate() (NodeList), Paper.js (bundler ignores browser map; defaultView), Recharts (SVG silently dropped; measure loop). Fix agent on feat/lib-compat (+ Bklit UI: visx+d3+motion, MIT; user marked d3-selection and Recharts must-fix).
- HyperFrames loader on feat/hyperframes-html (tip 3f03f8dc, not merged): `kinetograph render <index.html|dir>`, data-* contract, nested comps, __timelines seek, <video>/<audio> -> native, `fetch-deps` (https + CDN allowlist + SRI + sha256 cache re-check). NYT chart vs HyperFrames mean ~0.15. 30-comp comparison: MATCH 11, CLOSE 6, DIFFERENT 10, FAILED 2 of 29 (scratchpad/hf-compare/RESULTS.md). Causes: fonts (11), CDN data fetch (2 maps), transition offsets (3), WebGPU shaders black + silent doctor, offset-path, remote video, canvas +1.7 levels.
- In flight: feat/hyperframes-more (data-hidden, colour grading, speed ramps, audio lanes, fonts, claude-exchange 40 s first frame, + the comparison causes); feat/webgpu (WebGPU shim for shaders.iife backgrounds aurora/blob/ripples/swirl); feat/plugins (@kinetographdev/gsap, p5-brush, anime, motion as thin peer-dep glue + site Libraries page); 3 Haiku smoke tests (Shiki/Code Hike/flubber, Mermaid/KaTeX/MathJax, Observable Plot/Vega-Lite) in scratchpad/libsmoke/round2-{a,b,c}.

## Open threads
- [ ] Merge feat/hyperframes-html after hyperframes-more lands its fixes; re-run hf-compare for before/after totals
- [ ] Merge feat/lib-compat (re-test Recharts on current main; bundler browser-map change must be tested on papercut corpus + examples: could break existing projects)
- [ ] Merge feat/webgpu; WebGPU failure must warn per frame (currently silent black)
- [ ] Plugins: GSAP + p5.brush first, anime + Motion after lib-compat; then next queue: smoke-test Theatre.js, React Spring, ECharts, Rive, Tone.js, then a 2nd Sonnet plugin agent for Theatre.js + React Spring (Rive/Tone wait on test)
- [ ] Add a HyperFrames section to kinetograph-migrate skill (Three.js blocks -> translate via references/three.md)
- [ ] MapLibre GL / animated maps: parked, user wants to discuss (likely a translate recipe via d3-geo)
- [ ] GSAP: warn on tweens not attached to the seeked timeline

## Key files
- `packages/compat/src/shim/` (3.4k-line DOM shim: element.ts, tree.ts, canvas.ts)
- `packages/scene/src/webgl.ts`
- `packages/site/content/docs/compat.mdx:36` ("What works")

## Recent sessions
- 2026-10-25-pipeline-expansion — GSAP + WebGL merged; HyperFrames loader 11/29 match; lib-compat, plugins, WebGPU, HF extras in flight
- 2026-10-25-release-and-fixes — GSAP crashes today (feat/gsap in progress); datamosh merge in progress; p5.brush gap test running; HyperFrames ~3x
