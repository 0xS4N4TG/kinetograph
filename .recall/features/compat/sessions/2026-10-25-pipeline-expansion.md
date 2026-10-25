# 2026-10-25 — pipeline expansion (shared session: release, engine, compat, site, studio)

**Repo state:** main @ a5baead7 (local clean apart from untracked .playwright-mcp/, examples/rajz-cards/example/); many worktrees under .claude/worktrees/ and scratchpad/wt-*.

## What happened
- Merged to main: #5 datamosh, #6 studio Copy for agent, #7 GSAP, #8 text fixes (ink-overflow + text-stroke), #9 WebGL gaps. Main addon rebuilt with rustup toolchain.
- Deleted: perf/gpu-yuv (tip ccbaa4a0 saved in scratchpad/deleted-branches.txt), feat/datamosh, feat/studio-agent-copy, fix/ink-overflow, feat/text-stroke, worktrees wt-v2/wt-vk/wt-plain/wt-mosh/wt-studio/wt-ink/wt-stroke.
- Disk: freed ~29 GB of stale per-agent cargo target dirs in the scratchpad (target-mosh 18 G, target-vk 12 G, ...). Now ~21 GB free.
- Size comparison (hand-written source lines): Kinetograph ~179k (+175k vendor), Remotion ~1.58M, HyperFrames ~1.52M.
- Library smoke test round 1 (11 libs) and HyperFrames 30-comp comparison done (numbers in compat overview).
- Reddit reply drafted for "editable After Effects file?" (no; .jsx rebuild-script idea, FCPXML/OTIO cheaper).
- Security reviews caught: studio WS/agent with no auth (fixed: token + Origin + loopback), agent-fs symlink escape (fixed), fetch-deps any-URL download and integrity only on fresh download (fixed).
- Quit for the user: Next.js dev server on :3100, java (Eclipse JDT LS, 2 days old), Cua Driver (hermes tool server).

## In flight at dump time (agents)
- feat/lib-compat (Sonnet): NodeList/HTMLCollection, compareDocumentPosition, defaultView, bundler browser map, Rapier f0, Chart.js warning, Recharts, + Bklit UI charts.
- feat/hyperframes-more (Sonnet): data-hidden, grading, speed ramps, audio lanes, fonts, first-frame speed, + 30-comp causes (CDN data fetch caching, transitions, offset-path, remote video, canvas brightness, silent doctor).
- fix/svg-cascade (Sonnet, Rust): SVG from page CSS cascade, @font-face in svg text, moov-at-end audio.
- feat/webgpu (Sonnet, Rust after target-webgl gone and >=15 GB free): WebGPU shim for shaders.iife backgrounds.
- feat/plugins (Sonnet): @kinetographdev/gsap, p5-brush, then anime, motion; site Libraries page.
- 3 Haiku smoke tests round 2: Shiki/Code Hike/flubber, Mermaid/KaTeX/MathJax, Observable Plot/Vega-Lite (+ speed vs Chrome).
- docs/changelog-0.2 ready (needs #8/#9 entries).

## Decisions made
- Next release is 0.2.0 (not 0.1.1/0.1.5): new features + output changes; semver pre-1.0 minor bump.
- No Three.js support; translate via kinetograph-migrate references/three.md instead (add a HyperFrames section).
- Plugins are thin peer-dep glue, never forks/mirrors of the libraries; plugins only for libs with their own clock or RNG (GSAP, p5.brush, anime.js, Motion; next Theatre.js, React Spring; Rive/Tone.js after a test); others get recipes on a Libraries page.
- Studio goal: Canva-simple by default, full control behind "Show details"; agent chat over ACP (any agent), not Claude-only.
- Scale-out rendering (chunks, parallel CPU encode, Lambda/Cloud Run) parked for later (engine overview).
- MapLibre/animated maps: parked, to discuss.
- README tagline: dropped "with no browser in it".

## Gotchas
- Homebrew rustc is broken (libz3); ~/.cargo/bin has no rustc here; use PATH=/opt/homebrew/opt/rustup/bin:$PATH.
- Background `run_in_background` servers get killed (exit 144) when agents clean up; start user-facing servers with nohup.
- Agents re-send their final report repeatedly; stop them with TaskStop after the first.
