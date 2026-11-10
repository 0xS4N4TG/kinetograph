# Export options

The names are Remotion's. The flags are checked before the project is bundled, and each refusal says what to change. The
full contract is `AUTHORING.md` §9 in `kinetograph-markup/references/`.

## Flags of `render`

| Flag | Does |
|---|---|
| `-o <path>` | The file (`out/renders/<id>.<ext>` by default; the extension follows the codec). With `--sequence`, a folder |
| `--range a..b` | Frames `a` to `b-1`; `a..=b` includes `b` |
| `--scale N` | Output size multiplier, above 0 and at most 8, drawn at that size (sides round down to even). `--draft` is `--scale 0.5`; both together is an error |
| `--codec` | `h264` (default), `h265`, `prores`, `vp9`, `gif`; a `.webm` path means `vp9`, a `.gif` path `gif`. `.mp4` or `.mov` for h264 and h265, `.mov` for prores |
| `--crf N` / `--video-bitrate R` | Quality or bit rate (`8M`, `2500k`); not both. CRF 0 to 51 for h264 and h265, 0 to 63 for vp9; not for prores or gif |
| `--x264-preset` | libx264 and libx265 speed: `ultrafast` ... `veryfast` (default) ... `medium` (as in Remotion) ... `placebo`; an error with any other encoder |
| `--pixel-format` | `yuv420p` (default), `yuv422p`, `yuv444p`, `yuv420p10le`, `yuv422p10le`, `yuv444p10le`; `yuva444p10le` and `yuva420p` keep alpha (below) |
| `--prores-profile` | With `--codec prores`: `proxy`, `light`, `standard`, `hq` (default), `4444`, `4444-xq` |
| `--audio-codec` | `aac` (default for `.mp4` and `.mov`), `opus` (`.webm`), `pcm` (`.mov`, default for prores); `--audio-bitrate 320k` for aac and opus |
| `--every-nth-frame N` | gif only: draw every Nth frame and play at the frame rate over N |
| `--encoder NAME` | An ffmpeg encoder for the codec, in place of the default (below) |
| `--concurrency N` | Frames drawn at once in worker threads; default half the cores, at most 4; 1 draws in the main thread. The file is the same for any N. Each worker takes 0.5 to 1 GB on a heavy film |
| `--sequence`, `--image-format png\|jpeg` | One image per frame instead of a video (below) |
| `--strict` | Fail on the first frame with content the engine cannot draw |
| `--dev-react` | React's development build (about 5x slower on a heavy film) |

## Alpha

A video keeps transparency only with an alpha pixel format, and only for a frame with no opaque background:

- ProRes: `--codec prores --prores-profile 4444` (or `4444-xq`) `--pixel-format yuva444p10le`, to a `.mov`. The 4444 profiles drop
  alpha unless the pixel format asks for it.
- VP9: `--codec vp9 --pixel-format yuva420p`, to a `.webm`.
- Alpha is written straight (not premultiplied). A composition with no `background` is transparent; a `.json` scene with
  none is black.
- Players handle alpha, 4:2:2, 4:4:4 and 10-bit unevenly; 4:2:0 8-bit plays everywhere.

## Image sequence

`render --sequence -o frames/` writes `<id>-<frame>.png`, the frame number zero-padded to the width of the last frame
(`Main-042.png`). `png` (default) is the frame as drawn, alpha included; `jpeg` is quality 80 flattened over black. No audio
is written, and the video flags (codec, quality, pixel format, audio, `--encoder`, `--every-nth-frame`) are refused.

## Encoders

H.264 defaults to `libx264` at `crf 18`, H.265 to `libx265`, VP9 to `libvpx-vp9`, on every platform; ProRes uses
`prores_videotoolbox` on macOS else `prores_ks`. `h264_videotoolbox` and `hevc_videotoolbox` are opt-in with `--encoder`. The
summary names the codec, encoder and pixel format used.

The built-in ffmpeg does all decoding and encodes with what it has. An encoder it lacks runs in an external `ffmpeg`
program: the GPL one bundled in the platform package (`libx264`, `libx265`), or your own. `KINETOGRAPH_FFMPEG=$(which ffmpeg)`
makes your system ffmpeg's encoders available, including `h264_vaapi`, `hevc_vaapi`, `h264_qsv` and `hevc_qsv` for Intel and
AMD GPUs on Linux (`--encoder` only; never the default; 4:2:0 only). An encoder no ffmpeg has is an error that says to set
`KINETOGRAPH_FFMPEG`. See `/docs/getting-started/installation/#ffmpeg-licence`.
