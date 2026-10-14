# phase2b — decisions

## Clock: fractional t for keyframes, whole frame for seeds
**Date:** 2026-10-14
**Call:** `Clock { t, frame, fps }`; keyframes evaluate at t (motion blur sub-frames), seeded patterns use the output frame.
**Why:** grain/dither must not average away under motion blur; rendering stays a pure function of (scene, frame).

## 3D = flat raster then homography warp
**Date:** 2026-10-14
**Call:** each layer rasterises flat, then warps by H = Proj·P·W·P⁻¹; preserve3d groups depth-sorted (painter's, stable,
depths quantised to 1/1024 px as i64 so ±0 tie). Points behind the eye are cut, not mirrored.
**Tradeoff:** no mipmaps, so steep or far cards can alias.

## SVG attribute names for displace
**Date:** 2026-10-14
**Call:** feTurbulence/feDisplacementMap names and maths, written from memory of the spec (w3.org blocked by the proxy).
**Why:** papercut's url(#torn)/url(#rough) port with the same values.

## No Claude-Session trailers
**Date:** 2026-10-14
**Call:** a Sonnet agent added one; history on the unmerged branch was rewritten with filter-branch (tree unchanged),
force-with-lease pushed. Workflow prompts now say the attribution reminder does not apply to this repo.
