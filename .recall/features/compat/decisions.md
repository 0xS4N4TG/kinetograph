# compat — decisions

## 2026-10-25
**Call:** GSAP/WebGL libraries are supported by making the engine behave like the browser (port), not by per-library add-ons.

## 2026-10-25
**Call:** Comparisons must be the same picture: check parity images by eye before quoting a speedup.

## 2026-10-25
**Call:** Do not claim 42x vs Remotion (busy-machine artifact); public claim stays ~5x (papercut ~6x).
- 2026-10-25: no Three.js support; translate Three.js scenes with kinetograph-migrate (references/three.md) instead.
- 2026-10-25: plugins are thin peer-dependency glue, never forks or mirrors; only for libraries with their own clock or RNG (GSAP, p5.brush, anime.js, Motion; next Theatre.js, React Spring). Others get recipes on a Libraries page.
- 2026-10-25: support HyperFrames HTML as-is (loader + extras + WebGPU backgrounds); MapLibre/animated maps parked for discussion.
