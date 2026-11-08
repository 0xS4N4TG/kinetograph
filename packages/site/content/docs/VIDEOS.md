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

## The list (12 clips)

| Name | Page | Length | Sound | What it shows | Source |
|---|---|---|---|---|---|
| `what-is-kinetograph` | `index` | 20 s | silent | A montage of four short reels: a launch film, a paper-cut reel, a type spot and a 3D scene. | Cut from `examples/launch` (`public/film/launch.mp4`), `examples/rajz-cards` (`public/examples/rajz-cards.mp4`), `examples/showcase` and `examples/showcase-3d` renders |
| `first-video` | `getting-started/first-video` | 2 s | silent | The finished starter title card: a word appears and a line grows under it. Loops. | Render of `npx kinetograph init` (`src/scenes/Title.tsx`) |
| `examples-reel` | `examples` | 8 s | silent | The eight templates on the page, one second each. | Hero clips of `word-flash`, `launch-film`, `scrapline`, `grid-reel`, `laptop-open`, `recap-dial`, `dostoevsky`, `prompt-reply` (`content/catalog.json`, `public/catalog`) |
| `what-to-make` | `making/index` | 8 s | silent | Four kinds in turn, two seconds each: moving text, photos, a paper-cut reel, a glitch. | Cuts of `prompt-intro`, `wait-ship`, `examples/rajz-cards`, `examples/datamosh` |
| `title-cards-and-text` | `making/title-cards-and-text` | 6 s | silent | A headline writes on one letter at a time, then three words slide up, 3 frames apart. | New small project; the write-on is `<HandCaptions>` from `plugins/kinetic-typography` |
| `photos-and-footage` | `making/photos-and-footage` | 8 s | silent | Four photos, each with a slow push-in and a dissolve between them, ending on a short clip. | New small project using photos and a clip from `examples/launch/public`; the prompt on the page makes it |
| `voice-music-captions` | `making/voice-music-captions` | 10 s | on | A clip with a narration, a music bed that ducks under it, and captions that light the word being said. | Excerpt of `examples/launch` (voice and music) with `<Captions preset="highlighter">` |
| `paper-cut` | `making/paper-cut` | 6 s | silent | A cut-out photo unfolds from a crumpled packet on kraft paper, then a hand-drawn line circles it. | `examples/rajz-cards` and `papercut-card.json`; `<FoldOut>` and `<Scrapline>` from `plugins/paper` |
| `glitch-effects` | `making/glitch-effects` | 6 s | silent | A datamosh cut (the old picture melts along the new shot's motion), then the same clip with a VHS look. | `examples/datamosh` (pig and clouds clips) and `vhs()` from `plugins/vj` |
| `pin-text` | `making/pin-text` | 6 s | silent | A box and the label "Look here" follow a blacksmith's hammer. | Re-encode `public/docs-media/making-videos/motion-tracking-example.mp4` (from `making-videos/motion-tracking`) |
| `bring-a-project` | `making/bring-a-project` | 8 s | silent | A Remotion project in Remotion Studio, then the same project rendered by Kinetograph, side by side. | Screen recording of Remotion Studio plus the Kinetograph render of `examples/rajz-cards` |
| `library-item` | `library/use-an-item` | 8 s | silent | A template added with `npx kinetograph add`, then its words changed. | Screen recording of the command, then renders of the template before and after |

## Not made yet

Pages that HyperFrames shows a clip on and Kinetograph does not (the agent pages, the Studio pages) have no clip. Studio
shows still screenshots (`public/docs-media/studio/`). Add a screen recording of Studio to `studio/index` later if it is
wanted: that would be a 13th clip.
