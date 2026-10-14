# phase2c — decisions

## Byte-identity first; filtered passes keep canvas-size textures
**Date:** 2026-10-14
**Call:** bounds limit passes by scissor (clears stay full); bounds-sized textures for textureLoad passes only.
Halftone, warp/corner-pin, displace, custom shader and the blur pyramid read a canvas-size copy.
**Why:** hardware bilinear weights depend on texture size, so a smaller texture can't be byte-identical.
**Tradeoff:** blur/shadow/glow still pay canvas-size clears and stores.

## Custom shaders, non-separable blends and text bounds stay conservative
**Date:** 2026-10-14
**Call:** custom shaders run over the whole texture; hue/saturation/color/luminosity blends draw the whole texture
(NaN on transparent sources); text bounds grow by one full font size.

## Layer cache off by default
**Date:** 2026-10-14
**Call:** Renderer cache off; `render` and `bench --range a..b` enable it; `bench --frame` times uncached work.
**Why:** bench repeats one frame (would time hits); tests/render.rs expects raster_ms > 0 on a repeat.

## Group skip only when exact up to f16 order
**Date:** 2026-10-14
**Call:** skip a group's buffer only for normal blend, opacity 1, no effects/clip/mask/matte/motion/3D, no backdrop
reader inside, every drawn child normal and not preserve3d. Done by the orchestrator after the workflow.

## Round 2 order from the user
**Date:** 2026-10-14
**Call:** bounds passes, bounds textures, erf shadows, cache, MSAA8, motion-blur bounds raster; frame-range render dropped
(done in 2b); group skip added afterwards at the user's request.
