# Launch film: handoff (2026-10-23, v3 plan)

This file has three parts:

- the film as it stands (v7)
- what the owner said about it
- the agreed plan for v3

Work through the plan in the order given under "Order of work". `STORYBOARD.md` is the original plan from 2026-10-17.
Where the two differ, this file is newer.

## Working rules for this film

- **Who does what:** Opus writes the film code. A Haiku 5.5 (high) agent runs the shell work: renders, stills, ffmpeg,
  TTS, ASR, tracking and downloads.
- **Checking:** look at every still yourself. Never take an agent's description of an image as the check.
- **Where things go:**
  - Renders and stills go to `examples/launch/out/`, which is gitignored, never the scratchpad.
  - Raw downloads go to `out/sources/`.
- **Commits:** examples commit straight to main, with Conventional Commits and the Co-Authored-By line. One commit per
  shot or change.
- **Speed claims:** measure them. Render with the bench lock held:
  `…/scratchpad/final/bench.sh acquire|release TAG`. Take the median of 3 runs.
- **Strict renders:** `--strict` must pass with no warnings.
- **Voice:** don't regenerate it until the picture is final (see "Order of work").

## The film now (v7, commit `666c27cb`)

- `out/launch-v7.mp4`: 49.7 s, 1,491 frames, 1920x1080 at 30 fps, with audio.
  - md5 `5c385b05c6ed66f05777913793fdfcce`.
  - It renders in 27.3 s (the median of 3 runs at `--concurrency 4`).
- **Entry:** `index.tsx`, composition `launch`. Shot lengths are `LEN` in `common.tsx`, and shot starts are `START` in
  `sound-timing.ts`.
- **Timing:** each shot takes its timing from the narrator's word timestamps through `spoken(file)` in `sound-timing.ts`,
  which uses the `VO` list and `tools/narration/voice/asr_narrator_final.json`. Don't hand-place frames that belong to
  a spoken word.

| Shot | File | What it is |
|---|---|---|
| s01 leader | `act1-open.tsx` | SMPTE leader, sepia, counting down |
| s02 1891 | `act1-open.tsx` | Blacksmith Scene (1893), then Fred Ott's Sneeze (1894), with handwritten captions on a track |
| s03 screenshots | `act1-crt.tsx` | Browser-window pile on a full-screen CRT (picture from `act1.tsx` `Problem`) |
| s04 switch-off | `act1-crt.tsx` | The tape tears, the tube folds to a dot; "you don't need one." |
| s05 camera | `act1-camera.tsx` | 3D vintage camera: a depth pass, then a thermal grade on "render" |
| s06 burn | `act1.tsx` | 16 mm burn over the cut from 5 to 7 |
| s07 archive + receipts | `act2-s07.tsx`, `print/` | 1927 parade film with captions, then the thermal-printer receipts |
| m1–m5 | `act2-mg.tsx` | 3D type, isometric blocks, GLSL shader, canvas flow field, glass spheres |
| s08 Remotion | `act2-s08.tsx` | Code close-up pulls out to a wall of exports; 98% |
| s09 render clock | `act2-s09.tsx` | The film's own frames race past on a strip; the clock stops at `RENDER_SECONDS` |
| s10 pixels | `act3.tsx` | Struck words, a red loop, a zoom into RGB subpixels (`pixels()` in `looks.ts`) |
| s11 flicker | `act3.tsx` | Flickers through the film's looks (`public/self/v2-*.jpg`, made by `self-stills.tsx`) |
| s12 end card | `act3.tsx` | "kinetograph." / MOTION PICTURES, WRITTEN IN CODE. / kinetograph.dev |

Looks live in `looks.ts`: `crt`, `vhs`, `oneBit`, `thermal`, `depthLook` and `pixels`.

## What the owner said about v7

1. **Opening:** the leader cuts in on a "3", which feels abrupt. It should run on through 2 and 1.
2. **1891 tracking:** track the object (the anvil and the hammer), not the person.
3. **Voice (the biggest problem):**
   - It doesn't sound like one continuous voice. Its speed changes from the start to the middle to the end.
   - Its tone is high-pitched and weird.
   - The cause is that v7 cut one take into 16 pieces, spread the pieces apart to fit the picture (which stretched the
     pauses), and then re-voiced line 09 as a separate generation (114 Hz against the take's 116 Hz, at a different
     pace).
4. **Pace:** the fast opening is good, and the whole film should move at that pace.
5. **Shot 3 script:** "Today, to make a video with code…" is wrong, because traditional editors exist. Frame it as
   the old way of making video with code, then the twist.
   - The shot 3 framing is off: the pile sits upper right and leaves a hole on the left.
6. **m1 3D:** red plastic type on cream. Make it cinematic.
7. **m2 isometric:** good, as long as it matches the film's theme.
8. **m3 shader:** should be different. The purple noise is a generic look.
9. **m4 canvas:** "really ugly". Replace it.
10. **m5 glass:** "really ugly". Put the glass over aesthetic niche images, such as Japanese prints or Soviet posters.
11. **Remotion line:** "Already using Remotion? Kinetograph is a drop-in replacement."
12. **Chromium:** say somewhere in the film that it's a Chromium-less approach.
13. **Captions:** the handwritten captions stay on the archive film only (s02 and s07), not through the whole film.

## v3 script (about 40 s)

1. In 1891, the Kinetograph made pictures move.
2. Until now, video from code meant a browser screenshotting every single frame.
3. Kinetograph doesn't need one. It renders straight on the GPU.
4. Your demo. Your launch. Your changelog. Write it in code, and it renders.
5. And not just text. Real 3D. Isometric scenes. Shaders. Canvas. Even glass that bends the light.
6. Already using Remotion? Kinetograph is a drop-in replacement.
7. This whole film rendered in N seconds.
8. No Chromium. No screenshots. Just pixels.
9. Kinetograph. Motion pictures, written in code. Try it at kinetograph dot dev.

Line 7's N is the measured render time of the finished v3 picture (see "Order of work"). Spell it in words in
`take.json`, and write it as digits on screen.

## v3 plan, shot by shot

### s01 leader

- Let the leader run 3 → 2 and cut on the 2 with the classic "2-pop": a 1 kHz beep, one frame long.
- Then 2 frames of black, then the first frame of 1891.
- `public/footage/leader.mp4` holds only 4 and 3 (SMPTE `-ss 21.4 -t 1.6`). Recut it from the source in
  `out/sources/scout/smpte_univ-lead_*` so it covers 3 into 2.
- Start the shot on the sweep, partway through 3, so it doesn't open cold on a still number.

### s02 1891

- Retrack with `tools/track/track.mjs`:
  - On `blacksmith.mp4`: the anvil, or the hammer's strike point.
  - On `fred.mp4`: the handkerchief, or the hand that holds it.
- Check the tracked box drawn onto frames by eye.
- The captions anchor to the object. The reticle label stays `TRK 01`.

### s03 screenshots (line 2)

- Captions: "Until now," / "video from code" / "meant a browser" / "screenshotting" / "every single frame." Set
  `split` and `hot` to fit the new words. The hot words are screenshotting and frame.
- Reframe: centre the pile on the tube (`PILE` in `act1-crt.tsx`), and keep the caption block under it.

### s04 switch-off (line 3, first sentence)

- The tube switches off as now. "Kinetograph doesn't need one." lands in the dark.
- `S04_AT` comes from `spoken()`.

### s05 camera (line 3, second sentence)

- "It renders straight on the GPU." The thermal grade lands on "renders" (`S05_PASS`).
- Set the on-screen words to fit.

### s07 archive and receipts (line 4)

- No change apart from the new timings.

### m1 3D (cinematic)

- A dark stage, not cream. The extruded wordmark is brushed metal or dark chrome.
- One hard key light rakes across it, with a soft rim from behind. Deep shadows on a dark floor.
- A slow dolly, then the film grade: shot 7's `TONE` or `thermal`, `glow` for halation, and `grain`.
- The four dropping props can stay if they read on dark. Cut them if they clutter.

### m2 isometric

- Keep the geometry and the ripple.
- Regrade it into the film's palette: ink, cream and signal red. No mustard ground.
- Use low, warm dusk light with long shadows and a little `grain`.

### m3 shader

- Replace the purple fbm with a shader that works on the archive film itself. For example, heat haze or an ink
  dissolve warping a Fred Ott or 1927 parade frame. The picture stays in the film's grade.
- The plate stays: "03 `<GlslShader>`".

### m4 canvas: a zoetrope

- `<Canvas>` draws Eadweard Muybridge's "The Horse in Motion" (1878, public domain) as pen-plotter strokes: 12 or so
  frames of the gallop round a slotted drum.
- The drum spins up until the horse gallops in the slits.
- Ink lines on paper or cream on black, matching the leader's sepia.
- This ties pre-cinema to the 1891 opening.
- **Asset:** a public-domain scan of the Muybridge sequence from archive.org or the Library of Congress. Trace the
  frames to polylines offline (a script under `tools/`) and ship them as JSON. The canvas draws only the JSON.

### m5 glass

- The glass refracts a niche, aesthetic public-domain image instead of the parade crowd.
  - **First choice:** Japanese woodblock night scenes with lamps (Hiroshige, or Hasui Kawase prints published before
    1929).
  - **Second choice:** 1920s Soviet film posters (the Stenberg brothers, published before 1929).
  - Scout both, and pick the one that looks best through the glass.
- Use a lens or prism sliding across the frame, not the big spheres. The large sphere reads as a grey blob.
- Keep dispersion on.
- **Rights:** "published before 1929" with the item's rights field checked. Record each image in
  `out/sources/manifest.tsv`.

### s08 Remotion (line 6)

- Same picture, retimed to the line. The 98% plate stays as it is.

### s09 render clock (line 7)

- Same design. `RACE[1]` lands on the spoken number. Change `RACE` if the number is one word or two in the ASR.

### s10 pixels (line 8)

- "No Chromium. No screenshots. Just pixels."
- Update the word list in `act3.tsx`: strikes on phrases 1 and 2, the red loop on "pixels".

### s12 end card (line 9)

- No change apart from the timings.

## Voice: one continuous take

- **One file:** the narration is ONE take, played as ONE audio file, never cut or re-spaced. The picture is timed to the
  take, not the take to the picture.
- **Tooling:** generate with `tools/narration` (`take.json`, `voice.json`) and narrate.py, using Qwen3-TTS from
  `qwen3-tts-local`, `HF_HUB_OFFLINE=1`.
  - `voice.json`'s `ref_audio` holds a literal `$KINETOGRAPH_CORPUS/…`, which narrate.py doesn't expand. Run with a
    scratchpad copy that has the absolute path.
- **Pick:** make 5 or more takes and pick on all of these:
  - exact ASR match
  - low, even pitch (the lowest median that sounds natural, and the smallest spread)
  - a steady pace (words per second per sentence within 15% of the take's mean)
  - no sentence noticeably faster than the rest

  Don't pitch-shift unless a test shows no artefacts. Play the pick to the owner before the picture is retimed.
- **Wiring:** replace the per-line `VO` list with one take:
  1. `public/vo/take.wav` starts at one film frame. `sound-vo.ts` holds its duration.
  2. Run ASR once on it into `asr_narrator_final.json` (one key).
  3. Each shot's start comes from the take's word times (a shot cut sits in the gap before its first word), so `LEN`
     is derived from the take rather than written by hand.
  4. `spoken()` keeps its signature, returning shot frames.
  5. Ducking (`DUCK`) follows the sentences.
- **Pace:** aim for about 40 s in total. The pictures between lines hold only as long as they need.

## Order of work

1. **Assets:** a Haiku agent downloads and cuts them, and Opus checks each one:
   - the leader recut
   - the Muybridge scan
   - the glass prints and posters
2. **Picture:** build the new shots (m1, m2, m3, m4, m5, s01, s02 tracks, s03 framing) against a scratch timing, and
   check stills of each.
3. **Measure:** render with a placeholder number and measure the render time (median of 3). That's N.
4. **Voice:** write N into `take.json` and generate the takes. Pick one, and the owner listens.
5. **Retime:** retime to the take, set `RENDER_SECONDS = N`, render, and re-measure.
   - If the render time moved by more than 0.5 s, either re-voice the whole take or fix the speed. Never splice in a
     line.
6. **Finish:** a final render, owner review, then commit.

## Assets and rights

- **1891 opening:** Blacksmith Scene (1893) and Fred Ott's Sneeze (1894), both Edison, public-domain mark.
  - `public/footage/blacksmith.mp4`: `-ss 2`, crop 480:270:0:45.
  - `public/footage/fred.mp4`: GG Restore, crop 644:362:0:0.
  - `public/footage/leader.mp4`: SMPTE Universal Leader, public-domain mark.
- **Shot 7 and receipts:** "Armistice Day Parade, Columbus, Ohio, 1927", US National Archives
  (https://archive.org/details/111-h-1555). A US government work. Its clips are `veteran.mp4` and `hat.mp4`.
- **Scouted, not used:** `out/sources/scout/` holds 23 public-domain items (`manifest.tsv` has the rights, verbatim).
  - Grandma's Reading Glass (1900)
  - Sandow (1894)
  - Dickson Experimental Sound Film (1894)
  - SMPTE leaders
  - Prelinger clips at 320x240
- **Fonts:** OFL Google Fonts only.

## How to render and check

```sh
# from examples/launch, with the CLI and addon built
npx tsc --noEmit -p .                                                    # types
node ../../packages/cli/dist/cli.js still index.tsx 400 -o /abs/path.png # one frame: use an absolute -o
node ../../packages/cli/dist/cli.js render index.tsx -o out/launch-vN.mp4 --concurrency 4 --strict
node ../../packages/cli/dist/cli.js still self-stills.tsx <i> -o /abs/path.png  # the s11 look stills
```

- `public/fx/` is gitignored and has to be copied in from the main checkout.
- **WGSL:** `smooth` is a reserved word in WGSL; `pixels()` fell over on it once.
- **Noise:** `noiseSource` loops the 3 s noise buffer for longer sounds.
- **s11 stills:** after a shot changes, re-render its `self-stills.tsx` entry. s09 and s11 show those jpgs.

## Open, outside v3

- **Datamosh:** `feat/datamosh` is unmerged (it needs the owner's OK). The Tuy Hoa jets are downloaded.
- **Engine branches:** `fix/ink-overflow` is unmerged (it needs the owner's OK).
- **Site copy:** `packages/site/src/sections/page.tsx` still says "1,521 frames, rendered in 297 seconds".
- **Receipt sounds:** the owner hasn't listened to them yet.
