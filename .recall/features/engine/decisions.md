# engine — decisions

## 2026-10-25
**Call:** Determinism check = lossless render (libx264 crf 0 yuv444p) compared with ffmpeg framemd5, never mp4 md5 (VideoToolbox writes a varying SEI byte).

## 2026-10-25
**Call:** A warm (incremental) frame must equal a cold build; fix the edit path, never disable incremental mode.

## 2026-10-25
**Call:** Removed ENGINE.md §12 "launch is GPU-bound, 4 workers 30-36 s" note: measured before Skia.
- 2026-10-25: scale-out rendering (chunked render + concat, parallel CPU encode, Lambda/Cloud Run) parked for later; plan in overview.
