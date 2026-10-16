# Kinetograph launch video: storyboard (draft 1, 2026-10-16)

## Spine

The reference reel (jordans.archivess, `DeKDmkmh_gM`) asks a question and then refuses to answer it in words: "How do
you communicate change? You don't. You just show it." The launch video takes that move:

> **how do you make a video without a browser?**
> you don't take screenshots.
> you just render it.

Every claim after that is shown as a render, not said. The name gives the second motif: the Kinetograph was Edison's
1891 motion-picture camera, so film stock (16mm burns, gate dust, grain) runs through it, from the old camera to the
new engine.

## Style DNA taken from the reference (not its shots)

| Trait in the reel | How the launch uses it |
|---|---|
| Off-white paper with a soft vignette and grain; hard flips to near-black and to flat red | The same three grounds: paper `#E9E8E6`, ink `#141414`, signal red `#E0261B`. One accent per scene, never two |
| One small lowercase geometric sans line that builds word by word, synced to the VO | Same; the line sits on the lower third, words land with a 3-frame blur-in |
| A hand-drawn ink line that writes itself beside the type, then scribbles out | Our own SVG strokes (path draw + jitter), plus the handwritten overlays for single words |
| Pixel-art objects that burst in, orbit, whip past with motion blur | Pixel icons drawn by us as SVG grids: a browser window, a camera, a film reel, a GPU chip, a coin, a heart… |
| Word cards on black, "action. ▍", one object each, a red four-point star glint | Feature cards: "css. ▍" "svg. ▍" "webgl. ▍" "3d. ▍" "skia. ▍" |
| Objects eaten away by black ink blots | The pixel-melt removal from the showcase (shot 1), which the browser gets |
| Thermal duotone subject (orange to red on black) with an orbit line drawn around it | Our own 3D object in the same duotone, with the orbit line |
| Spaced letters L O V E with an object between, the ground flashing white/black/red per beat, then the letters scatter and get circled in red | K I N E T O G R A P H, logo-flicker style, ending on the wordmark |
| Cuts every 0.25 to 1 s, on beat, snappy ease-out with overshoot, motion blur on whips | Same rhythm; motion blur from the engine, not faked |

## Format

16:9, 1920x1080, 30 fps, about 45 s. Rendered by Kinetograph itself; the render time goes on the end card.

## Shots

| # | Time | Ground | Picture | Line on screen / VO |
|---|---|---|---|---|
| 1 | 0.0–0.7 | flat mustard, dashed rules | Huge bold "how" (the reel's opener move: one word, full height) | "how" |
| 2 | 0.7–3.0 | paper | "how" slides off left behind a black redaction bar; the sentence builds word by word; an ink line writes a signature-like stroke under "browser" | "how do you make a video without a browser?" |
| 3 | 3.0–6.0 | ink | Logo-flicker burst: pixel browser windows, screenshot frames and a shutter count "frame 0001 0002 0003…" flashing 2–3 frames each; a red sweep streak | "every frame, a screenshot." |
| 4 | 6.0–8.0 | ink → paper | The browser window **pixel-melts away** (showcase shot 1 effect), draining down to paper | "you don't." |
| 5 | 8.0–11.0 | ink | Duotone 3D object (a film camera, our `scene3d`) turning, orbit line draws around it; handwritten **"FILM"** overlay (screen blend) flicks on over it | "you just render it." |
| 6 | 11.0–11.9 | — | **16mm burn 01** transition into the proof run | — |
| 7 | 11.9–22.0 | ink / paper alternating per card | Five feature cards, ~2 s each, each with a pixel icon, a red star glint and a micro-demo drawn live: **css.** (a card with shadow, blur, gradient border) · **svg.** (path drawing itself) · **webgl.** (a shader warping) · **3d.** (a lit model with shadow) · **skia.** (paths unioned and stroked). Whip with speed lines between cards | "css." "svg." "webgl." "3d." "skia." |
| 8 | 22.0–25.0 | paper | Pixel icons of the Remotion APIs orbit in a ring (the reel's ring); one gap left in it is filled by a "98%" ring gauge | "your remotion code." "unchanged." |
| 9 | 25.0–33.0 | ink | Numbers, bklit-style rebuilt frame-driven: two horizontal bars race, Remotion 8.86 s vs Kinetograph 1.25 s on the same project (S04, 89 frames, measured); the Kinetograph bar finishes and a counter rolls to **7.0x**; handwritten **"IMPACT"** overlay; a second small stat "988 / 988 frames" from the papercut corpus | "same project. same frames." "7x faster." |
| 10 | 33.0–36.0 | paper | Small line: "no chrome. no screenshots. just pixels." Each word ink-scribbled out as it lands except "pixels" | "no chrome. no screenshots. just pixels." |
| 11 | 36.0–41.0 | white / ink / red per beat | K I N E T O G R A P H spaced across the frame, one pixel icon between letters per beat, ground flashing per beat (logo-flicker rhythm), then the letters scatter on paper and get circled in red ink | — |
| 12 | 41.0–45.0 | paper | Letters snap into the wordmark "kinetograph"; tagline "write remotion. render native."; small print "this video: rendered by kinetograph in N s" (measured at final render) | tagline |

Overlays across the whole cut: grunge `overlay_6` (paper texture, multiply, ~25%) on paper scenes, `overlay_2` (gate
dust, screen, ~40%) on ink scenes, plus grain.

## Assets used (copied into `examples/launch/public/`, only these)

- Transition: `CUSTOM TRANSITIONS/FILM BURNS/16mm burn 01.mov` (shot 6). Possibly one `LIGHT LEAKS` clip into shot 12.
- Handwritten words: `"FILM" txt.mp4` (shot 5), `"IMPACT" txt.mp4` (shot 9). Alternates: `"CREATE"`, `"NEW"`, `"DIFFERENT"`.
- Grunge: `overlay_6.mp4`, `overlay_2.mp4`.
- From snapcn: logo-flicker (shots 3 and 11).
- bklit is a browser chart library animated on the wall clock, so its bar and ring look is rebuilt frame-driven, not
  installed.

The handwritten overlays are 2160x3840 portrait, white on black: they are cropped to the word and screen-blended.

## Motion rules

- Entrances ease out (`cubic-bezier(0.16, 1, 0.3, 1)`), 6–10 frames; exits ease in, 4–6 frames, faster than entrances.
- Overshoot only on objects (icons, cards), never on type.
- One thing moves at a time per beat; the eye is led by the VO word.
- Whips use real motion blur and 2–3 frames of speed lines; hard cuts land on the beat.

## Decided (2026-10-16)

- Format: 16:9, 1920x1080.
- VO: a new voice, a man with a deep tone.
- End card: `kinetograph.dev`.

Visual storyboard: `storyboard.html` beside this file.

## Still open

- Music: needs a track with a clear beat for shots 3, 7 and 11.
