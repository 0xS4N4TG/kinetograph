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
- [x] #17 merged: pinSvgFonts removed. HF 29 comps now MATCH 17 / CLOSE 6 / DIFF 5 / FAIL 1 (code-slice-hero f59 depth test). Results scratchpad/hf-final.
- [ ] SVG cascade gap (keeps applySvgRules alive): SVG elements created by scripts after a fetch are not styled by page CSS (us-map-flow arcs/dots draw black without the TS workaround); an @media rule's fill does not reach an SVG shape. Fix in crates/dom, then delete svg-style.ts/svgRules.
- [ ] HF real projects (scratchpad/hf-real, 7 public projects): 4 MATCH, 1 CLOSE, 2 FAIL; 3.6-6.4x faster than HF. #19 merged: fetch-deps downloads remote pictures for HF pages (hashed cache, render offline); not yet: script-set pictures, <picture><source srcset>. Remotion path (packages/core/src/remote-assets.ts makeRemoteAssetResolver) still downloads remote <Img>/url() AT RENDER TIME with no hash; PARKED by user 2026-10-25 ("not right now"): small fix = lock file of hashes on first download + allowed hosts + --offline (~200 lines); full fetch-deps pre-pass is much bigger. IN FLIGHT fix/preserve3d-flatten (target-p3d): flatten a preserve-3d element that has a grouping property (opacity/filter/etc.) as browsers do, instead of the scene error; make doctor run the render's scene check. Gaps found: (a) NullMotion 22-kinetic-headline: "a preserve3d group cannot have effects" scene error, and doctor misses it; (b) system fonts (social-ad) fall back, CLOSE on f0; (c) CSS background url() to remote https is skipped (no network at render; fetch-deps doesn't fetch it).
- [ ] HF still DIFFERENT: mk-clone-wall-transition (inline-block nowrap wrap), code-typing (?), weight-wave (variable-font advances), transitions-destruction (canvas gradient premul), three-orbiting-cards (preserve-3d)
- [x] Plugins merged (#16, f0f68c5c): gsap, p5-brush, anime, motion + /docs/libraries; Bklit colours confirmed fixed by #14 (line/bar/pie/geo <=0.14 at f59)
- [ ] In flight (2026-10-25, Sonnet + Haiku helpers): feat/gsap-clock-async-effects (GSAP free tweens via gsap.updateRoot on virtual clock with catch-up, async createEffect/HtmlInCanvas via delayRender, Flip test, ScrollTrigger/Draggable doc rewrite, 3 stale doc fixes); feat/webgpu-textures (Rust: textures, samplers, copyExternalImageToTexture incl. video, offscreen passes; then webgpu effects)
- [ ] Parked by user: @remotion/webcodecs encode/decode, nested HtmlInCanvas, WebGPU compute/depth/MSAA/readback. Effect state across frames is BY DESIGN (frame independence), not a gap.
- [ ] Engine bug: anime.js `width: [0, 100]` on inline `width: 0` element draws nothing (Chrome draws); repro scratchpad/plugins-verify/anime/src/c.tsx (zero-size DOM mutation path?)
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
