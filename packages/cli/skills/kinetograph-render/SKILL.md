---
name: kinetograph-render
description: Look at, check and export a Kinetograph composition. Use to see frames (`still`, `strip`, `onion`), check a project without pixels (`inspect`, `lint`, `check`, `doctor`, `snapshot`, `audio analyze`), render to MP4, MOV, WebM, GIF or an image sequence, choose codecs, ProRes profiles, alpha and size, or confirm a render came out right.
metadata:
  version: "0.4.0-rc.1"
---

# Look, check, render

Commands take an entry: a project file (`.tsx`, `.ts`, `.jsx`, `.js`), a `.json` scene, or an HTML page (its `index.html`,
or the directory holding it). Choose a composition with `--comp <id>` (`compositions <entry>` lists them) and pass props
with `--props '{"title":"Hi"}'` or a JSON file path. Without `-o`, outputs go to `out/stills/`, `out/sheets/` and
`out/renders/` and the path is printed.

## 1. Look

Open the PNG to see it. `Main` below is the composition id.

- `kinetograph strip src/index.tsx -n 12`: twelve labelled frames at once, `out/sheets/Main-strip.png`. Do this first; it shows
  the whole animation. `--range 10..40`, `--cols N`.
- `kinetograph still src/index.tsx 45`: one frame, `out/stills/Main-f45.png`.
- `kinetograph onion src/index.tsx 0..60 -n 6`: frames blended over each other to show a motion path,
  `out/sheets/Main-onion.png`.

`--scale N` draws at N times the size. A range `a..b` is a to b-1; `a..=b` includes b.

## 2. Check without pixels

- `lint <entry>` (`--frames 0,45,89`; default 8 spread out): text overflowing its box or the canvas, layers off the canvas,
  overlapping text, missing fonts and assets, type errors, each with the frame and layer id. Fix every lint error. It only
  checks what a frame can show: a layer at opacity 0 (or inside a group at opacity 0) and one its clip cuts away
  completely are skipped at that frame.
- `inspect <entry> --frame 45`: every layer's resolved position, size, `bounds`, `matrix` (canvas pixels), effects and text
  lines. Use it instead of guessing from the picture.
- `check <entry>`: `tsc --noEmit` on the project (its nearest `tsconfig.json`). Rendering never type-checks, so a
  misspelled prop (`opactiy={0.5}`) draws at full opacity without an error; `lint` reports the same as `type-error`.
- `audio analyze <entry>`: `integratedLufs` (null means silence; aim for about -14 for online video), `truePeakDb` (keep it
  under -1), `clippedSamples` (should be 0) and `silences`. `--range`, `--scenes 0..90,90..180`.
- `snapshot <entry> --update` approves frames (default first, middle, last; `--frames 0,30`); `snapshot <entry>` later diffs
  against `__snapshots__/` and flags a pixel that moved by more than 2 levels.
- `bench <entry>` times the stages (`--frame`, `--runs`, `--range`); `effects` lists the effects and their fields.

Habit: `lint` before `strip`, `strip` before `render`. A command that fails prints the cause: read `error.message` and
`error.code` before changing anything.

## 3. Doctor

`doctor` alone says what this install can do: renderer, addon, CLI and skill versions. `doctor <entry>` (`--range`) runs the
JS stage for every frame, with no GPU, and reports what the engine cannot draw (compat mode; what it can is in
`kinetograph-markup`):

- how many frames are clean (`cleanFrames`, `unsupportedFrames`, `cleanShare`);
- each issue, grouped by element, property and reason, the one on the most frames first: `values` it was seen with, the
  element `paths` (`$0.2 <div>`, the host-tree position) and the inclusive frame `ranges`. An issue with a `property` is that
  CSS property on that element; one with `null` is the element itself. A page script's own `console.error` or uncaught
  error is an issue too.

Remove or replace what the top issues name, then run it again; 100% clean means nothing is left out. `still`, `strip` and
`render` warn about the same on stderr (`compat.leftOut` with `--json`); `--strict` fails with `UNSUPPORTED_CONTENT` on the
first such frame. Run `doctor` before a long render of a project that uses DOM elements or CSS.

## 4. Render

`kinetograph render src/index.tsx` writes `out/renders/Main.mp4` with audio. Common options:

- `--draft` (half size, same as `--scale 0.5`), `--range 0..90`, `--concurrency 4` (frames drawn at once; the file is the same).
- `--scale 2` for 4K from 1080p, drawn at that size, not upscaled.
- `--codec h264|h265|prores|vp9|gif` (the output extension must fit: `.mov` for prores, `.webm` for vp9, `.gif` for gif).
- `--crf 20` or `--video-bitrate 8M`, not both; `--prores-profile 4444`; `--pixel-format yuv444p`; `--audio-codec opus`.
- `--sequence` writes one image per frame into the `-o` folder instead of a video.

Bad combinations are refused with what to change. React runs in production mode (faster); `--dev-react` keeps the
development build for React's warnings. All flags, alpha, codec and encoder rules, and `--sequence` details are in
`references/export.md`.

## 5. Check the render

- Read the summary it prints: size, codec, encoder, pixel format, frames, `repeated`, and the `renderer:` line. `Skia GPU
  (...)` is fast; `Skia CPU (...)` means slow.
- For a long film, `strip` a range first, or render `--draft --range` to check timing.
- With `--json`, read `output` and the `compat` list for what was left out.
- Check the sound with `audio analyze`, and a transparent render by opening the first frame as a PNG
  (`--sequence`) or in a player that shows alpha.
