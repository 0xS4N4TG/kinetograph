# Launch film: handoff (2026-10-23)

Everything needed to pick the launch film up where it was left: what it is, its style, how shot 7 was rebuilt, the
assets and their rights, how to render and check it, and what the owner said about each version. `STORYBOARD.md` is the
original plan from 2026-10-17. Where they differ, this file is newer.

## What it is

- **Length and format:** a 51 s film at 1920x1080 and 30 fps, 1,542 frames.
- **Where it lives:** `examples/launch/index.tsx`, composition `launch`.
- **How it's made:** Kinetograph renders it, with no browser.
- **Sound:** the whole soundtrack is synthesised in `sound-cues.ts` and `sound-synth.ts`, apart from the voiceover.
- **Voiceover:** the Tiny Agent narrator (a Qwen3-TTS clone), read in one take and cut into lines (`tools/narration`).
  `sound-timing.ts` says which shot frame each line starts on.
- **Word timings:** the narrator's per-word timestamps are in `tools/narration/voice/asr_narrator_final.json`. The
  captions read them. Don't estimate timings, and don't run speech-to-text again.

Shot order and lengths are `LEN` in `common.tsx`. Shot 6 (the burn) lies over the cut from shot 5 to shot 7.

| Shot | Frames | Voiceover |
|---|---|---|
| s01 "how" | 24 | none |
| s02 question | 80 | "How do you make a video with code, without a browser?" |
| s03 screenshots | 84 | "Right now, a browser screenshots every single frame." |
| s04 melt | 56 | "With Kinetograph, you don't need one." |
| s05 camera | 80 | "You just render it. Straight on the GPU," |
| **s07 archive + receipts** | **174** | "your demo, your launch, your changelog," / "write it in code and it renders for you." |
| m1–m5 motion graphics | 344 | "And it goes way past text. Real 3D, isometric scenes, WebGL shaders, canvas, even glass that bends the light." |
| s08 Remotion | 210 | "Already using Remotion? ... ninety-eight percent of the API." |
| s09 numbers | 160 | "Same project, same frames. It finished seven times faster." |
| s10 pixels | 75 | "No Chrome. No screenshots. Just pixels." |
| s11 flicker | 120 | none |
| s12 end card | 135 | "Kinetograph. Write Remotion, render native. Try it at kinetograph dot dev." |

## Style of the whole film

- **Palette:**
  - Grounds: paper `#ECEAE6`, ink `#111111`, signal red `#E0261B` (and mustard `#D9A621`).
  - One accent per scene.
  - Shot 7 is the exception: warm silver film tones and a cream `#FFF4E2`.
- **Type:**
  - DM Sans for the film's own lines.
  - JetBrains Mono for small print and tracker labels.
  - Rock Salt for hand lettering.
  - Shot 7 uses its own handwritten set (below).
- **Motion:**
  - Entrances ease out, `cubic-bezier(0.16, 1, 0.3, 1)`, over 6–10 frames. Exits are faster.
  - Overshoot on objects, not on type.
  - Cuts land on the beat.
  - Motion blur comes from the engine.
- **Motif:** the Kinetograph was Edison's 1891 film camera. Film stock (burns, gate dust, grain, projector clatter) runs
  through the cut. Shot 7's 1927 archive film is part of that motif.

## Shot 7, as rebuilt on 2026-10-23

File: `act2-s07.tsx`. The parts are in `print/`:

| File | What it is |
|---|---|
| `print/captions.tsx` | The captions |
| `print/receipts.tsx` | The receipts collage |
| `print/receipt.tsx` | One receipt |
| `print/thermal.ts` | The dither shader |
| `print/qr.tsx` | QR codes and barcodes |

### Picture

1. **Frames 0–56: the bearded veteran.** `public/footage/veteran.mp4` is the veterans of the reviewing stand.
2. **Frames 56–78: the man in the hat.** `public/footage/hat.mp4`.
3. **Footage grade** (`Film` in `act2-s07.tsx`):
   - A `gradientMap` to warm silver (`#060708` → `#7d766b` → `#fff2dc`).
   - `glow` at radius 40 and intensity 0.3, for halation.
   - `grain` at 0.09.
   - Projector flicker: the opacity varies by up to about 8% from frame to frame.
   - Gate weave: a jitter of ±1.5 px.
   - A slow push-in from 1.04, at +0.05 per 60 frames.
   - A lens vignette.
   - 2.39:1 letterbox bars (138 px).
   - A warm two-frame flash on each cut.
4. **Frames 78–122: printer close-up** (`CloseUp`).
   - One receipt (`shibuya`) feeds up out of a thermal printer's slot at a steady 15 px a frame. Paper comes out of the
     slot; it isn't revealed from the top.
   - The shot is magnified 1.9 to 1.72 times, with a hand-held drift.
   - It pulls focus: a blur of 7 px clears by frame 14.
   - The printer body says "KG-80 THERMAL" and has a green LED.
   - The cutter snaps at frame 41 and gives the camera a small jolt.
5. **Frames 122–174: wide shot of the pile** (`Wide`).
   - The table is tilted away (CSS perspective 1700, rotateX 36° to 32°), and the camera creeps in and turns.
   - Depth of field: receipts farther up the table are blurred more.
   - Four receipts drop on from above the camera. Each lands on a spring, big and high, then settles flat.
   - Warm key light from the top left, a dark falloff, and grain at 0.07.
6. **Receipt photos:** faces and the crowd from the same 1927 film (`public/receipts/face-*.png` and `crowd.png`),
   printed through the Bayer-dither shader. The receipt text is Japanese and English, with puns on the engine:
   - "レンダー定食 Skia + wgpu"
   - "ノーブラウザ 軟膏"
   - "スクリーンショット x 1,542 枚" (1,542 is the film's frame count)

### Captions: the "Geronimo Stilton" style

The owner's reference was an Instagram reel by the maker of jellysynth.com
(https://www.instagram.com/reels/DexW821zDDU/). It shows projected captions which, in the reel's own words, were
"inspired from the Geronimo Stilton ... genre of books". What that means here:

- **Mixed hands.** Words write on letter by letter, spread across each word's spoken time, and the handwritten face
  changes per letter, so the line reads as one restless hand.
  - The faces are Caveat 700, Shadows Into Light, Indie Flower, Gloria Hallelujah, Patrick Hand and Gochi Hand.
  - Each letter is randomly lifted ±5 px, tilted ±4.5° and scaled 0.92 to 1.1.
- **Emphasis words break out** whole, in a display face, taking turns:
  - Abril Fatface, with a small pink flower doodle drawn on beside it.
  - Archivo Black italic, which streaks in with a blurred ghost.
  - Emphasis words are 1.26 to 1.38 times the base size of 124 px.
- **Look:**
  - Warm cream `#FFF4E2` with a two-layer glow, like projected light.
  - Each letter lands slightly big, with a pink/cyan fringe (5 px apart) that closes up over 6 frames.
- **Tracking on the text and the subject:**
  - A reticle sits on the tracked face (`TRK 01` and a confidence number).
  - Thin lines run from the face to the text, and off the edge of the frame.
  - A bracket rides the letter being written, labelled with the face's coordinates (`x: 1029  y: 664`).
- **Layout:**
  - The text block sits 90 px beside and 150 px above the face, on whichever side the page fits on one line.
  - It grows upward from its bottom, and never above the letterbox.
  - On the printer close-up it hangs to the right of the paper.
  - Pages are set per voiceover line (`split`): 07a is [2, 2, 2] and 07b is [4, 3, 2].
- **Tracking data:** `tools/track/track.mjs` is an offline template-matching tracker. It works on a grey 480x270 copy,
  with a ±40 px search and an adapting template. It writes `track/<clip>.json` with one point per frame, and the film
  only reads that JSON. To redo a track, pass `--box x,y,w,h` of the face on the clip's first frame, in 1920x1080
  pixels:
  - Veteran: `--box 720,560,160,180`
  - Hat: `--box 1225,515,150,170`

  I drew the tracked box onto frames of both clips and checked it by eye: it stays on the face while the camera pans.

### Sound of shot 7 (`sound-cues.ts`, "shot 7")

- **Under the film:** a projector's clatter, and a shutter on the cut.
- **Words:** a pen scratch across each plain word as it writes; a low thump (65 Hz) and a tick on each emphasis word.
- **Receipts:**
  - A hit on the cut, then a quiet room tone.
  - `thermal()`: a stepper buzz near 910 steps a second (a sawtooth through a steep high-pass, so a click per step),
    rung through housing resonances at 2.35, 4.1 and 6.6 kHz and roughened by noise, with spin-up and spin-down, plus
    paper hiss.
  - `cutter()`: a click, a clack and a faint metal ring.
  - `paperDrop()`: air past the paper, a slap, a body thump and a low thud when it lands.
- **The music bed:** pads per section. The beat that used to run under shot 7 is gone; the archive film carries its
  own rhythm.

The receipt sounds are synthesised, and nobody has listened to them yet. If they still don't convince, the next step is
recorded CC0 foley (a real thermal printer and paper drops). That needs a download and the owner's OK.

## Assets and rights

- **Footage:** "Armistice Day Parade, Columbus, Ohio, November 11, 1927", US National Archives (Signal Corps official
  film no. 731), https://archive.org/details/111-h-1555.
  - It's a US government work: public domain, no licence URL on the item.
  - It's reached through FedFlix and destockd.com ("public-domain/unrestricted FedFlix archive").
  - The people in it are anonymous members of the public at a 1927 parade. They aren't celebrities.
- **Clips cut from it:**
  - The source is 4:3, pillarboxed inside 16:9. The clips are cropped back to 16:9 and scaled to 1080p.
  - `veteran.mp4`: `-ss 188.0 -t 2.6`, crop 1440:810:240:150.
  - `hat.mp4`: `-ss 199.6 -t 1.4`, crop 1440:810:240:120.
- **Also downloaded:** "Tuy Hoa Air Base, Vietnam, 188th TFS" (https://archive.org/details/330-dimoc-niagara0023,
  1080p, 281 MB), for the datamosh shot. It isn't used yet. archive.org was slow: about 100 KB/s, and one 500 error.
- **Fonts:** all OFL Google Fonts, loaded through `@remotion/google-fonts`. Geist Pixel was tried and dropped.
- **Earlier placeholder footage:** `public/pool/clip-*.mp4`, our own renders. Shot 7 no longer uses it.

## How to render and check

```sh
# from examples/launch, with the CLI and addon built
node ../../packages/cli/dist/cli.js check index.tsx                      # types
node ../../packages/cli/dist/cli.js still index.tsx 400 -o /abs/path.png # one frame: use an absolute -o
node ../../packages/cli/dist/cli.js render index.tsx -o out.mp4 --concurrency 4 --strict
ffmpeg -v error -i out.mp4 -map 0:v -f md5 -                             # the video md5
node ../../packages/cli/dist/cli.js studio index.tsx --port 3002         # live preview
```

- Shot 7 runs from film frame 324 to frame 497.
- `public/fx/` is gitignored and must be copied in from the main checkout before the film renders.
- The md5 gate changes whenever the film changes, so record the new one with each change.
  - The original film was `06c47d3edbd3e799361b3061f6c67ee9`.
  - The first shot 7 rebuild was `fe37af01…`.
- Renders must match at `--concurrency` 2 and 4.

## What the owner said, in order (2026-10-23)

1. Asked for:
   - word-by-word captions with spring pop
   - a different font per word or phrase
   - thick outlines, ±3° tilt, bigger emphasis words, at most 2–3 words, no background
   - a "Geronimo style tracking filter"
   - a receipt-paper collage scene
   - datamosh on destockd footage
2. The first build was separate compositions with comic fonts per word, blob boxes on the footage, and pool clips.
   Verdict: the tracking had to be on the text itself; the font switching was "way too often"; and it had to be part of
   the launch film.
3. The second build put shot 7 in the film with Geist Pixel and Doto, matched to jellysynth.com's UI type.
   Verdict: "not the pixelated font. this looks bad".
4. The owner then said:
   - Watch the reel: that is the Geronimo Stilton effect.
   - "there is nothing cinematic about this entire thing", the receipts included.
   - Download the clips and show which ones are used.
   - The receipt sound effects "kinda suck".
5. The end card: "eh this is weird the tag line write remotion and render native."
   - Two things are definitely wrong. The wordmark's "g" and "p" are cut off at the bottom: that's an engine bug, text
     overflow clipped under a filter, and `fix/ink-overflow` is being fixed. And "rendered by kinetograph in 297 s" is
     stale: set `RENDER_SECONDS` in `act3.tsx` from the final render.
   - The tagline's wording is still open with the owner. Changing it means a new voiceover line for `12-end`.

## Open

- **Datamosh:** the effect is built on `feat/datamosh`. It needs a shot of its own using the Tuy Hoa jets.
- **End card:** the descender clip (engine fix), the render time, and the tagline decision.
- **Receipt sounds:** need an owner listen. Recorded foley is the fallback.
- **Real outlines:** `feat/text-stroke` adds a native `-webkit-text-stroke`. Shot 7 doesn't need it now; the earlier
  stacked-shadow outline is gone.
- **Site copy:** `packages/site/src/sections/page.tsx` still says "1,521 frames, rendered in 297 seconds".
