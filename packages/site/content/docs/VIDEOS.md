# Clips the docs need

This file is not a docs page: `source.config.ts` builds only `.mdx`. It lists every clip the docs show through
`<Video name="..." />` (`src/components/docs/video.tsx`). Until the clips are hosted, each shows the placeholder poster
`public/docs-media/video-placeholder.svg`.

## How to add a clip

1. Make `<name>.mp4` (H.264, 1280x720, 30 fps) and a poster `<name>.jpg` (the same size, one good frame).
2. Upload both to the video host, so they stay out of `public/` and out of the Vercel deployment storage. Do not
   commit MP4s.
3. Set `NEXT_PUBLIC_DOCS_VIDEO_BASE` (with a trailing slash) at build time. Every clip is then
   `<base><name>.mp4` and `<base><name>.jpg` (`VIDEO_BASE` in `src/sections/links.ts`).

Targets: 8 seconds or less and 1.5 MB or less for a silent clip, 20 seconds for `what-is-kinetograph`. A silent clip
(`silent`) autoplays muted and loops. A clip with sound starts on click, so keep its audio at about -16 LUFS. Make the
poster from a frame that reads without motion. The captions on the pages are one line, so a clip needs no burned-in text.

Existing renders in `public/examples/`, `public/film/` and `public/docs-media/` are good sources: cut and re-encode them,
then upload the result to the host.

## The list (16 page clips)

| Name | Page | Length | Sound | What it shows | Source |
|---|---|---|---|---|---|
| `first-video` | `getting-started/first-video` | 2 s | silent | The finished starter title card: a word appears and a line grows under it. Loops. | Render of `npx kinetograph init` (`src/scenes/Title.tsx`) |
| `what-to-make` | `making/index` | 8 s | silent | Four kinds in turn, two seconds each: moving text, photos, a paper-cut reel, a glitch. | Cuts of `prompt-intro`, `wait-ship`, `examples/rajz-cards`, `examples/datamosh` |
| `title-cards-and-text` | `making/title-cards-and-text` | 6 s | silent | A headline writes on one letter at a time, then three words slide up, 3 frames apart. | New small project; the write-on is `<HandCaptions>` from `plugins/kinetic-typography` |
| `photos-and-footage` | `making/photos-and-footage` | 8 s | silent | Four photos, each with a slow push-in and a dissolve between them, ending on a short clip. | New small project using photos and a clip from `examples/launch/public`; the prompt on the page makes it |
| `voice-music-captions` | `making/voice-music-captions` | 10 s | on | A clip with a narration, a music bed that ducks under it, and captions that light the word being said. | Excerpt of `examples/launch` (voice and music) with `<Captions preset="highlighter">` |
| `paper-cut` | `making/paper-cut` | 6 s | silent | A cut-out photo unfolds from a crumpled packet on kraft paper, then a hand-drawn line circles it. | `examples/rajz-cards` and `papercut-card.json`; `<FoldOut>` and `<Scrapline>` from `plugins/paper` |
| `glitch-effects` | `making/glitch-effects` | 6 s | silent | A datamosh cut (the old picture melts along the new shot's motion), then the same clip with a VHS look. | `examples/datamosh` (pig and clouds clips) and `vhs()` from `plugins/vj` |
| `pin-text` | `making/pin-text` | 6 s | silent | A box and the label "Look here" follow a blacksmith's hammer. | Re-encode `public/docs-media/making-videos/motion-tracking-example.mp4` (from `making-videos/motion-tracking`) |
| `bring-a-project` | `making/bring-a-project` | 8 s | silent | A Remotion project in Remotion Studio, then the same project rendered by Kinetograph, side by side. | Screen recording of Remotion Studio plus the Kinetograph render of `examples/rajz-cards` |
| `library-item` | `library/use-an-item` | 8 s | silent | A template added with `npx kinetograph add`, then its words changed. | Screen recording of the command, then renders of the template before and after |
| `compare` | `compare` | 8 s | silent | The same title card drawn by Remotion, HyperFrames and Kinetograph, side by side. | Renders of the starter title card from each tool (Remotion project from `compare` page code, HyperFrames page, `npx kinetograph init`) |
| `tips-overview` | `tips/index` | 8 s | silent | A prompt on screen, the video it made, then the video after one changed word. | Screen capture plus two renders of the starter title card |
| `tips-motion` | `tips/motion` | 6 s | silent | The same card moving with three different easings, one after another. | New small project using `interpolate` with three easings (`making-videos/animation`) |
| `tips-sound` | `tips/voice-music-sound` | 10 s | on | A clip with narration, music that ducks under it and a click as each card lands. | Excerpt of `examples/launch` with its sound cues |
| `tips-text` | `tips/text-captions-code` | 8 s | silent | A caption look, a line of code typing out and a lower third. | `plugins/kinetic-typography` `<Captions>` and a typed-code scene |
| `tips-looks` | `tips/colour-effects-3d` | 8 s | silent | One shot with a warm grade, a VHS look and a 3D camera move. | `examples/datamosh` footage with `vhs()` and `examples/showcase-3d` |

## Not made yet

Pages that HyperFrames shows a clip on and Kinetograph does not (the agent pages, the Studio pages) have no clip. Studio
shows still screenshots (`public/docs-media/studio/`). Add a screen recording of Studio to `studio/index` later if it is
wanted: that would be a 13th clip.

## Films (What is Kinetograph)

The hero of `index` is the full launch film with sound and controls, `films-launch.mp4`, already in the release (poster: `public/docs-media/films/launch.webp`).
The tiles come from `src/lib/films.ts`. Every film is a flat release asset named `films-<name>.mp4`, H.264 with faststart and AAC where there is
sound, under 15 MB. Web copies are already encoded in the scratchpad folder `docs-media2/`. Posters are small WebPs in the repo (88 KB in all). Until
`NEXT_PUBLIC_DOCS_VIDEO_BASE` is set, a tile opens a "coming soon" dialog. All are Kinetograph renders. Durations were measured with ffprobe.

| Upload as | Title / category | Duration | Sound | Web copy | Source |
|---|---|---|---|---|---|
| `films-launch.mp4` | hero | 39.5 s | yes | 1280x720, 8.7 MB | `examples/launch/out/launch-v13.mp4` |
| `films-launch2.mp4` | Every frame, straight / Launch film | 43.3 s | yes | 1280x720, 11.8 MB | `kinetograph-ui/templates/inside/out/launch2-v7.mp4` |
| `films-dostoevsky.mp4` | Dostoevsky in 40 seconds / Explainer | 39.7 s | no | 720x1280, 8.6 MB | `kinetograph-ui/templates/dostoevsky/out/dostoevsky.mp4` |
| `films-worlds.mp4` | Worlds / Showreel | 29.7 s | no | 1280x720, 8.8 MB | `kinetograph-ui/templates/inside/out/worlds-preview.mp4` |
| `films-wish-reel.mp4` | A birthday wish reel / Social | 18.0 s | yes | 1280x960, 11.5 MB | `kinetograph-ui/templates/wish-reel/out/wish-reel.mp4` |
| `films-page-turn.mp4` | Page turn / Looks | 5.7 s | no | 720x1280, 0.3 MB | `kinetograph-ui/templates/looks-demo/out/page-turn.mp4` |
| `films-match-cut.mp4` | Match cut / Text | 5.0 s | yes | 720x1280, 1.8 MB | `kinetograph-ui/templates/match-cut/out/match-cut.mp4` |
| `films-papercut-demo.mp4` | All paper / Paper-cut | 5.0 s | no | 720x1280, 0.5 MB | `kinetograph-ui/templates/papercut-demo/out/papercut-demo.mp4` |
| `films-stack-credits.mp4` | Stacked credits / Titles | 4.7 s | no | 720x1280, 1.0 MB | `kinetograph-ui/templates/stack-credits/out/stack-credits.mp4` |

## Route previews (What do you want to make?)

The picker on `making/index` shows a muted 16:9 loop for each route, `routes-<clip>.mp4` (6 to 8 s, under 1.5 MB). Until they are uploaded each shows its
poster, a frame from the films above. The routes with no poster (pin text, data, bring a project, any other) show a plain tinted box.

| Upload as | Route | Suggested source |
|---|---|---|
| `routes-launch.mp4` | Show a product or launch | `films-launch2` cut to 8 s |
| `routes-explain.mp4` | Explain an idea | `films-dostoevsky` cropped to 16:9 |
| `routes-title.mp4` | Title card or moving text | `films-match-cut`, 16:9 crop |
| `routes-photos.mp4` | Photos and footage | `films-worlds` cut |
| `routes-sound.mp4` | Voice, music and captions | `films-wish-reel` cut |
| `routes-paper.mp4` | Paper-cut | `films-papercut-demo`, 16:9 crop |
| `routes-glitch.mp4` | Glitch effects | `films-launch` GLSL shot |

## Lesson videos (Lessons)

Each lesson's Watch step plays `lesson-<slug>.mp4`: about 2 minutes, 1280x720, with sound and captions. Until it is uploaded the lesson shows the
placeholder. The takeaways and glossary under each video are in `src/lib/lessons.ts`; the video should say the same four things, in the same order.

| Upload as | Lesson | Script (what it says and shows) |
|---|---|---|
| `lesson-animate-your-logo.mp4` | A quick win: animate your logo | 0:00 Show the finished 4 second sting. 0:15 The request: length, logo file in `public/images`, the word in quotes. 0:45 Say the move in plain words (ease out in, slight overshoot to 1.08, settle), then the same move with numbers. 1:15 The exit with an ease in; why a linear ease looks mechanical. 1:40 Fix one thing by giving a time ("leaves at 3.4 s") and change nothing else. 1:55 The four takeaways on screen. |
| `lesson-words-on-your-footage.mp4` | Put words on your own footage | 0:00 A clip, then the same clip with captions. 0:20 Where the files go (`public/video`, `public/captions`) and naming the part of the clip. 0:45 Kinetograph reads timings and does not transcribe: bring a subtitle file or word timings. 1:10 Three to five words at a time, lower third, the current word lit. 1:35 One style, then `lint` catching text past the edge. 1:55 The four takeaways on screen. |
| `lesson-paper-cut-or-glitch.mp4` | Give a clip a paper-cut or glitch look | 0:00 A paper cut-out and a datamosh, back to back. 0:20 Name the look as an effect: stock and edge, or a frame count. 0:45 A cut-out needs its background removed; unfold it from a crumpled packet. 1:10 A datamosh needs H.264 or MPEG-4 clips; show the smear. 1:35 A seed brings the same random look back: keep it, change one slot. 1:55 The four takeaways on screen. |

## Studio clips (Studio section)

Headless screen captures of Studio, 1280x720 (the window at 1600 px wide, scaled), 4 to 8 seconds, no sound, loops. Capture with a project that
has an HTML composition with sound, so the Edit, Mixer and Library tabs all show. Upload as `<name>.mp4` with a `<name>.jpg` poster.

| Name | Page | What it shows |
|---|---|---|
| `studio-open` | Open Studio | Typing `npx kinetograph studio src/index.tsx`, the browser opening on the loaded project |
| `studio-first-video` | Make your first video in Studio | One request typed in the Agent chat, the title card appearing in the preview, then Export |
| `studio-continue` | Continue from Claude Code | A project an agent made opening in Studio, then the same folder back in the terminal |
| `studio-edit-agent` | Edit with the agent | Pressing M, drawing a box on the title, writing a note, sending it, the preview changing |
| `studio-tour` | Find your way around Studio | A slow pan over the three columns: chat, preview with timeline, inspector |
| `studio-tour-chat` | Find your way around Studio, The agent chat | Sending a message with the picture switch on, then a second message waiting in Up next |
| `studio-tour-preview` | Find your way around Studio, The preview | The V, H, Z and M tools in turn, then 0 and 1 |
| `studio-tour-timeline` | Find your way around Studio, The timeline | Expanding the rows, dragging a clip, dragging an edge to trim, Ctrl-wheel zoom |
| `studio-tour-inspector` | Find your way around Studio, The inspector tabs | Clicking through Props, Scene, Edit, Mixer, Renders and Library |
| `studio-tour-edit` | Find your way around Studio, Edit | Colour strength, an effect moved up and removed, a font and weight change, Cmd+Z |
| `studio-tour-mixer` | Find your way around Studio, Mixer | A fader moved, M and S pressed, Add lane, Duck under voice, the Master loudness |
| `studio-tour-library` | Find your way around Studio, Library | Searching, switching Blocks and Components, Add to project |
| `studio-connect-agent` | Connect your agent | Cmd+K, Switch agent, picking Claude Code, a message sent |
| `studio-export` | Export a video | Export, Whole video, Start export, the Renders tab filling up and finishing |

## Taste page clip

| Name | Page | What it shows |
|---|---|---|
| `taste-match` | Make a video like one you like | A reference reel and the Kinetograph video made to match it, side by side. Use a reference you have the right to use, or one of our own films |
