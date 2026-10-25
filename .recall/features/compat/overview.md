# compat

**Status:** active
**Paths:** `packages/compat/**`, `packages/scene/src/webgl.ts`, `packages/site/content/docs/compat.mdx`, `packages/site/content/docs/known-issues.mdx`, `packages/cli/skills/kinetograph-migrate/**`
**Last touched:** 2026-10-25

## What this is
What third-party code runs on Kinetograph: Remotion packages, GSAP, WebGL libraries, and benchmarks against Remotion/HyperFrames.

## Current state
- main 4a2a1511 (2026-10-25): merged #12 lib-compat (Recharts 0.14-0.28, d3-selection, anime 0.02, Motion animate 0.38, Paper.js, Rapier f0, customElements, *AttributeNS, Mermaid DOM gaps; rAF runs after the frame and catches up on jumps), #13 HyperFrames loader+extras (29 comps: 15 MATCH / 6 CLOSE / 8 DIFF / 0 FAIL, was 11/6/10/2), #14 svg-cascade (page CSS styles SVG; var()/oklch/color-mix in SVG paint, fixes Bklit colours), #15 WebGPU (shaders.iife blocks; ripples/swirl pixel-identical to HF).
- Launch film lossless framemd5 identical to pre-merge main after every merge and on final main with the new addon.
- Round 2 smoke tests done: Plot, Vega canvas, Shiki, Code Hike, flubber, MathJax work (2-4x faster than Chrome); Mermaid, KaTeX broken (see open threads).
- In flight: chore/hf-svg-workarounds (Sonnet agent: delete svg-style.ts/pinSvgFonts/svgRules now covered by Rust, rerun 29-comp compare into scratchpad/hf-final); feat/plugins (gsap, p5-brush done; motion, anime, Libraries page in progress).
- Real HyperFrames projects test (Haiku): BLOCKED by auto-mode classifier (external code: npx hyperframes init, repo clone, community repos). Asked user to approve / pick safer scope.

## Open threads
- [ ] Merge chore/hf-svg-workarounds after verdicts no worse; record final 29-comp numbers
- [ ] Merge feat/plugins (gsap, p5-brush, motion, anime + site Libraries page)
- [ ] Real HyperFrames projects test: waiting on user OK for external code
- [ ] Round 3 smoke test (LAST proactive round): Theatre.js, React Spring, ECharts, Rive, Tone.js, shadcn/Radix, icon sets, SplitType/Splitting, react-countup. Then fix from doctor warnings/user reports only.
- [ ] Round 2 gaps: KaTeX vlist/table layout (crates/dom, M); accept+hide <math> (S); MathJax ~9% ex-unit scale (S); glyph fallback for missing symbols (crates/skia/render/src/text.rs:184, M); Code Hike lighter grammar fetch at render; Shiki rerun with mono font; rerun Mermaid + Vega SVG after #12
- [ ] HF Rust gaps: inline-block wrap in nowrap abs box; canvas gradient premul interpolation (draw.rs:1864, one flag); drawArraysInstanced; offset-path; variable-font advances ~13% wide; LUT/grain on DOM; batched computed styles; WebGPU textures/samplers/compute
- [ ] Motion colour mixing via WAAPI element.animate (now throws, JS fallback)
- [ ] MapLibre GL / animated maps: parked, user wants to discuss
- [ ] GSAP: warn on tweens not attached to the seeked timeline
- [ ] Studio selection tag shows raw path ($0.0.2.3.0), not the layer name

## Key files
- `packages/compat/src/shim/` (3.4k-line DOM shim: element.ts, tree.ts, canvas.ts)
- `packages/scene/src/webgl.ts`
- `packages/site/content/docs/compat.mdx:36` ("What works")

## Recent sessions
- 2026-10-25-pipeline-expansion — GSAP + WebGL merged; HyperFrames loader 11/29 match; lib-compat, plugins, WebGPU, HF extras in flight
- 2026-10-25-release-and-fixes — GSAP crashes today (feat/gsap in progress); datamosh merge in progress; p5.brush gap test running; HyperFrames ~3x
