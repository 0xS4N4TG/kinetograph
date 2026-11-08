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

## The list (17 page clips)

| Name | Page | Length | Sound | What it shows | Source |
|---|---|---|---|---|---|
| `what-is-kinetograph` | `index` | 20 s | silent | A montage of four short reels: a launch film, a paper-cut reel, a type spot and a 3D scene. | Cut from `examples/launch` (`public/film/launch.mp4`), `examples/rajz-cards` (`public/examples/rajz-cards.mp4`), `examples/showcase` and `examples/showcase-3d` renders |
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

## Film tiles (What is Kinetograph)

The tiles on `index` come from `src/lib/films.ts`. Each film is `<base>films/<name>.mp4`, 1280x720 or the source size, H.264 with its sound
kept. Posters are small WebPs already in `public/docs-media/films/` (about 56 KB in all). Until the base URL is set, a tile opens a
"coming soon" dialog. All eight are Kinetograph renders of our own examples; none is a reference reel by someone else.
Durations were measured with ffprobe.

| Name | Duration | Sound | Source |
|---|---|---|---|
| `launch` | 39.5 s | yes | `examples/launch/out/launch-v13.mp4` (project `examples/launch`) |
| `showcase` | 37.1 s | no | `packages/site/public/examples/showcase.mp4` (project `examples/showcase`) |
| `showcase-3d` | 6.0 s | no | `packages/site/public/examples/showcase-3d.mp4` (project `examples/showcase-3d`) |
| `datamosh` | 5.0 s | yes | `examples/launch/out/datamosh/jets-datamosh.mp4` (project `examples/datamosh`) |
| `papercut-card` | 2.0 s, 1080x1920 | no | `packages/site/public/examples/papercut-card.mp4` (`examples/papercut-card.json`) |
| `canvas` | 2.0 s | no | `packages/site/public/examples/canvas.mp4` (project `examples/canvas`) |
| `video-overlay` | 6.0 s | no | `packages/site/public/examples/video-overlay.mp4` (project `examples/video-overlay`) |
| `bench-diorama` | 3.0 s, 1080x1920 | no | `packages/site/public/examples/bench-diorama.mp4` (`examples/bench-diorama.json`) |

Hosting is on GitHub release assets; set `NEXT_PUBLIC_DOCS_VIDEO_BASE` to the release download URL prefix, with a trailing slash,
and upload `films/<name>.mp4` and the clips above under it.
