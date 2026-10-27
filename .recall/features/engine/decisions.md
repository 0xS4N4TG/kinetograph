# engine — decisions

## 2026-10-25
**Call:** Determinism check = lossless render (libx264 crf 0 yuv444p) compared with ffmpeg framemd5, never mp4 md5 (VideoToolbox writes a varying SEI byte).

## 2026-10-25
**Call:** A warm (incremental) frame must equal a cold build; fix the edit path, never disable incremental mode.

## 2026-10-25
**Call:** Removed ENGINE.md §12 "launch is GPU-bound, 4 workers 30-36 s" note: measured before Skia.
- 2026-10-25: scale-out rendering (chunked render + concat, parallel CPU encode, Lambda/Cloud Run) parked for later; plan in overview.

## 2026-10-27: Three.js comes back, as an adapter
**Call:** support Three.js 1:1 in the future via our own WebGL2 plus a `@kinetographdev/three` clock plugin; scene3d stays.
**Why:** most existing Remotion/web 3D code is Three.js or r3f; running it unchanged makes far more projects drop-in. Reverses 2026-10-15.
