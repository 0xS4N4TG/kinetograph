// Hand-written copy and chosen media for the catalog pages, read by catalog.mjs. Written from each plugin's SKILL.md,
// README and presets, and from each template's index.tsx and README, in plain words. Nothing here names the private
// kinetograph-effects repo, and no template says what it was modelled on.

/** Studio-side facts that SKILL.md states once per plugin. */
const INSTALLED = 'Run `npx kinetograph plugins` to see that a plugin is installed; agents read its skill from there.';

export const PLUGIN_COPY = {
  hexed: {
    summary: 'Rolls a look onto any picture or clip from eleven slots, such as grade, screen, optics and damage. Lock what you like and shuffle the rest.',
    about: [
      'Hexed rolls a look onto a picture or a clip. The look is made of eleven slots: crop, shake, fps, time, mirror, isolate, grade, screen, optics, damage and grunge. Each slot holds one gene (a named effect, such as a sepia print grade or a twelve-frame-a-second stutter), a seed and an amount.',
      'The whole look is a genome: plain JSON with one strand per slot. A genome plays back the same every time, so a look you like can be kept in code or saved as a preset. Roll from a seed, lock the slots you want to keep, and reroll the rest.',
      'Use it when a video needs a grade, glitch, grain, shake or print look, or when you want to reroll and save looks.',
    ],
    presetNote: 'Presets live in presets/*.json. Roll and save one with the plugin’s save-preset tool.',
    examples: [
      {
        title: 'Roll a look onto a clip',
        code: `import { Video, staticFile } from '@kinetographdev/core';
import { Hexed } from '@kinetographdev/hexed';

<Hexed seed={42}><Video src={staticFile('clip.mp4')} /></Hexed>`,
      },
      {
        title: 'Lock a slot, switch one off, or use a saved look',
        code: `import { Image, staticFile } from '@kinetographdev/core';
import { Hexed } from '@kinetographdev/hexed';

<Hexed seed={42} lock={{ grade: 'sepia-print' }} off={['mirror']}><Image src={staticFile('photo.jpg')} /></Hexed>
<Hexed preset="moss-impact" amount={0.7} adjust={{ contrast: 20 }}><Image src={staticFile('photo.jpg')} /></Hexed>`,
      },
    ],
    studio: {
      panel:
        'A Hexed panel for any prop that uses genomeSchema: one card per slot with a gene list, an amount slider, a lock and the slot’s seed (click to copy), a shuffle per slot, a Shuffle button for the whole look that keeps locked slots, and a preset menu. It follows Studio’s light and dark theme.',
      tools: [
        { name: 'hexed_roll', text: 'Rolls a look and returns { seed, genome }. Without a seed it picks one and returns it, so the roll can be repeated. With a genome in from and slot names in locks, the locked slots keep their strands and the rest reroll.' },
        { name: 'hexed_genes', text: 'Lists the gene ids each slot accepts, with a note on the slot. Takes an optional slot.' },
        { name: 'hexed_presets', text: 'Returns the saved looks as { name: genome }.' },
      ],
      note: 'The tools are available while Kinetograph’s MCP server is running (kinetograph mcp). Try looks with studio_set_props, then write the settled genome into the code or save it as a preset; do not leave it only in Studio’s live props.',
      installed: INSTALLED,
    },
    presetLines: {},
    media: {
      hero: { from: 'effects/hexed-demo/out/reel.mp4', at: 8 },
      presets: {},
      demos: {
        'hexed-demo': [{ from: 'effects/hexed-demo/out/dream.mp4', at: 3, caption: 'Twenty seeds rolled onto one frame, each with its genes named under it.' }],
      },
    },
  },

  'kinetic-typography': {
    summary: 'Hand-written captions that write on letter by letter to a voiceover, with key words breaking out in display faces, optionally hung off a tracked subject.',
    about: [
      'HandCaptions writes a voiceover on screen letter by letter. Each word writes itself across its spoken time, every letter in a different handwritten face, so it reads as one restless hand. Key words break out whole in a display face: a fat serif with a doodle beside it, or a heavy italic that streaks in.',
      'The captions can hang off a tracked subject. They sit beside it on the side where they fit, with a reticle on the subject, lines to the text and off the frame, and a bracket with coordinates on the letter being written. Without a tracked subject they sit centred low.',
    ],
    presetNote: '',
    examples: [
      {
        title: 'Captions from word timestamps',
        code: `import { HandCaptions, wordsFrom } from '@kinetographdev/kinetic-typography';

const words = wordsFrom(asr.words, 30, 12); // seconds to frames, starting on frame 12

<HandCaptions words={words} split={[2, 2, 3]} hot={['1891', 'kinetograph', 'move']} />`,
      },
      {
        title: 'Hung off a tracked subject',
        code: `import { HandCaptions, wordsFrom } from '@kinetographdev/kinetic-typography';
import { pointAt } from '@kinetographdev/vj';

// track the subject once:
//   node plugins/vj/tools/track.mjs --in <clip> --box x,y,w,h --out <json>

<HandCaptions words={words} hot={['move']} anchor={(f) => pointAt(track, f, 30)} />`,
      },
    ],
    studio: {
      panel: '',
      tools: [],
      note: 'The plugin ships a skill and no Studio panel or agent tools. The skill tells an agent to get word timestamps from an ASR or TTS list rather than place frames by hand, to choose the pages and key words, to track the subject with the VJ plugin’s point tracker, and to render stills on a few word frames to check the block fits.',
      installed: INSTALLED,
    },
    presetLines: {},
    media: {
      hero: { from: 'effects/kinetic-type-demo/out/tracked.mp4', at: 1.3 },
      presets: {},
      demos: {
        'kinetic-type-demo': [{ from: 'effects/kinetic-type-demo/out/tracked.mp4', at: 2.4, caption: 'A line written beside a tracked anvil, on archive film.' }],
      },
    },
  },

  paper: {
    summary: 'A paper material with creases, scans and grain, and effects made of it: a text match cut over changing pages, and photo cut-outs that fold open.',
    about: [
      'Paper is a paper material (creases, scans, grain) and the effects made of it. MatchCut holds a highlighted keyword still while the page under it changes several times a second, on made-up pages or on your own screenshots. CutOut turns a photo with its background removed into a paper cut-out, and FoldOut unfolds it flap by flap in stop motion.',
      'MatchCut comes with four looks to start from (web, broadsheet, crumpled and clean) and a look object that overrides any of them. With your own screenshots you give a rough box around the word and it snaps to it.',
      'Use it for fast keyword-over-pages edits and paper-craft looks.',
    ],
    presetNote: 'The four MatchCut looks are in presets/match-cut/*.json. Picking one in the Studio panel replaces look with that preset’s fields; what it leaves out falls back to MatchCut’s defaults.',
    presetLines: {
      web: 'Web pages and social posts, ten cuts a second, a strong blur and streak, creased grey paper, a yellow highlight.',
      broadsheet: 'Newspaper layouts (pull quote, italic, kicker, body, display) at ten cuts a second, with a closer push-in.',
      crumpled: 'The fastest and roughest: twelve cuts a second, heavy smear, streak and crumple, some grain.',
      clean: 'Eight cuts a second on near-white paper with no blur, streak, crumple, grain or wander.',
    },
    examples: [
      {
        title: 'A match cut on made-up pages',
        code: `import { MatchCut, flicks } from '@kinetographdev/paper';

flicks({ frames: 150, fps: 30, cutsPerSecond: 10 });

<MatchCut keyword="Super Bowl" preset="web" />
<MatchCut keyword="Super Bowl" preset="broadsheet" look={{ zoom: 1.2, highlight: '#ffd400' }} />`,
      },
      {
        title: 'On your own screenshots',
        code: `<MatchCut
  keyword="Super Bowl"
  screenshots={[{ src: 'shots/a.png', hint: [212, 1180, 388, 64] }]}
  everyNth={1}
  showKeyBox
/>`,
      },
    ],
    studio: {
      panel:
        'matchCutLookSchema carries the Paper panel, so Studio mounts it for a look field instead of a generated form. It has preset cards with a drawn swatch, a layout picker with a thumbnail per layout, sliders for keyword size and height, cuts per second, push-in, blur, streak, crumple, grain and wander, colour pickers for the highlight and the paper tint, and a keyword box on the preview you drag to set anchorY and keySize. cutOutLookSchema and foldOutLookSchema carry a sheet view: edge cards and stock cards (white, newsprint, kraft), sliders for creases, shadow, boil and seed, and on the preview a handle to place the picture.',
      tools: [],
      note: 'The plugin adds no agent tools. Inside Studio, set values with studio_set_props and read the result in the preview, then write the chosen look into the code or a preset. Give the composition look: matchCutLookSchema and leave preset out of its schema, since the preset cards write into look.',
      installed: INSTALLED,
    },
    media: {
      hero: { from: 'effects/match-cut/out/Broadsheet.mp4', at: 1 },
      presets: {
        web: { from: 'effects/match-cut/out/web.mp4', at: 1 },
        broadsheet: { from: 'effects/match-cut/out/Broadsheet.mp4', at: 1 },
        crumpled: { from: 'effects/match-cut/out/Crumpled.mp4', at: 1 },
        clean: { from: 'effects/match-cut/out/Clean.mp4', at: 1 },
      },
      demos: {
        'paper-photo': [{ from: 'effects/paper-photo/out/FoldOutDesk.mp4', at: 1.2, caption: 'A cut-out opening on a desk.' }],
      },
    },
  },

  vj: {
    summary: 'Screen, tape and sensor looks (CRT, VHS, 1-bit, thermal, depth, pixels) and tracking overlays: boxes on moving blobs and a reticle on one point.',
    about: [
      'VJ adds looks that make a picture seem to come from a screen, a tape or a sensor: a CRT with curved glass, scanlines and a switch-off, a worn VHS tape, a 1-bit dither in two inks, a thermal camera palette, a depth pass, and a magnifier that resolves into red, green and blue subpixels. Each look is a layer effect. Brightness stands in for heat and for depth, so these are looks, not measurements.',
      'It also draws tracking overlays. A blob tracker runs once, offline, over a clip and writes JSON; Blobs then draws boxes, ids, coordinates and links from that JSON on every frame, so a render stays a pure function of the frame. A second tool follows one patch of the picture, and Reticle puts a ticked box on it.',
    ],
    presetNote: '',
    presetLines: {},
    examples: [
      {
        title: 'A look and tracked boxes over a clip',
        code: `import { Blobs, thermal, type BlobTrack } from '@kinetographdev/vj';
import track from './track/clip-blobs.json' with { type: 'json' };

<Layer id="clip" effects={thermal()}>
  <Video src={staticFile('clip.mp4')} width={1920} height={1080} fit="cover" muted />
</Layer>
<Blobs track={track as BlobTrack} box="corners" links="chain" />`,
      },
      {
        title: 'Track once, offline, then draw',
        code: `# finds what moved since the last frame; --debug writes every 10th frame with its boxes
node plugins/vj/tools/blobs.mjs --in public/clip.mp4 --out track/clip-blobs.json --debug out/blobs

# follows one patch (x, y, w, h on the first frame)
node plugins/vj/tools/track.mjs --in public/clip.mp4 --box 900,300,120,120 --out track/clip-point.json`,
      },
    ],
    studio: {
      panel:
        'Two schemas carry the plugin’s panel. vjLookSchema gives a card per look (none, CRT, VHS, 1-bit, thermal, depth, pixels) and the chosen look’s sliders and colours; each look keeps its own settings when you switch, and on the preview the CRT’s tube face is a box to drag and resize and the magnifier’s centre a cross to drag. blobStyleSchema gives the marks: box, label, links and blend as segmented choices, and sliders for most blobs, smallest, link reach, inverted share, line width, label size and colour. lookEffects(look) turns the look into layer effects, and the marks spread into Blobs.',
      tools: [],
      note: 'The panel only sets props. Tracking stays a command, because a browser panel cannot run ffmpeg. The plugin adds no agent tools; the skill walks an agent through running the tracker, opening two or three of the debug images, tuning the thresholds and rendering a still to check.',
      installed: INSTALLED,
    },
    media: {
      hero: { from: 'effects/vj-demo/out/Thermal-40.png' },
      presets: {},
      demos: {
        'vj-demo': [
          { from: 'effects/vj-demo/out/Blobs-40.png', caption: 'Blob tracking over a 1-bit picture.' },
          { from: 'effects/vj-demo/out/Crt-50.png', caption: 'A CRT tube on archive film.' },
          { from: 'effects/vj-demo/out/Vhs-40.png', caption: 'A worn VHS tape.' },
        ],
      },
    },
  },
};

/** Demo showrooms that are not templates: what they show, in a sentence. */
export const DEMO_TEXT = {
  'match-cut': 'One composition per MatchCut look, five seconds each, keyword "Super Bowl", a paper flick on every cut.',
  'paper-photo': 'The four cut-out edges, and the fold-out on a green screen and on a desk.',
  'kinetic-type-demo': 'A line written beside an anvil in archive film, tracked, and the same line centred low.',
  'vj-demo': 'Blob tracking over a 1-bit picture and over a thermal camera, a CRT switching off, and a VHS tape, on archive film.',
  'hexed-demo': 'A reel that rolls a new look every second and a half, and sheets of twenty seeds on one frame.',
  'plugin-ui-demo': 'Compositions wired to the Hexed, Paper and VJ Studio panels.',
};

export const TEMPLATE_COPY = {
  'cyberpunk-reel': {
    description:
      'A nine-second pop-art reel at 1920 by 1080: a person cut out of footage is painted in blue anime tones over a halftone background, with jagged rays, flying low-poly shapes, flames and a three-row title, and the cuts in and out break into shards and slices. You swap the footage and its matte, and the kicker and the two title lines.',
    change: [
      'The footage and its person matte (public/subject.mp4 and matte.mp4); the media tool crops the clip, makes the matte and tracks the person.',
      'The title: the kicker and two title lines are props of the CyberpunkReel composition.',
    ],
    media: { hero: { from: 'effects/cyberpunk-reel/out/cyberpunk-reel.mp4', at: 6 } },
  },
  'lyric-reel': {
    description:
      'A seventeen-second square kinetic-type video in four looks: silver words stacking in a night sky full of glinting stars, black type on an orange band between letterbox bars, small blue words turning in the clouds, and a finale back in the stars. Words sit in 3D and one camera moves through them. You swap the words and the song.',
    change: [
      'The words, in words.ts: one entry per word with the frame it starts to arrive, the same count per shot or the layouts in shots/ adjusted.',
      'The song, at public/song.mp3; it plays from 16.04 seconds in.',
    ],
    media: { hero: { from: 'effects/lyric-reel/out/lyric-reel.mp4', at: 2 } },
  },
  scrapline: {
    description:
      'A hand-drawn border round a cut-out subject: a wobbly marker, pencil, crayon, scribble or brush line, on a sheet of torn paper behind it, both redrawn a few times a second like hand animation. You swap the subject and its matte, and choose the line style, the paper and the colour.',
    change: [
      'The subject: a video with a black and white matte, a video with alpha, an image with alpha, or an SVG path.',
      'The style (Marker, Pencil, Crayon, Scribble, Brush), the paper (White, Kraft, Binder, Cardboard, your own picture or none), the line colour, the gap to the subject and the seed.',
    ],
    media: { hero: { from: 'effects/scrapline/out/scrapline-demo.mp4', at: 20 } },
  },
  'wish-reel': {
    description:
      'An eighteen-second pop-art edit at 1440 by 1080: street footage flattens into pastel colours under ribbons of colour with 3D props tracked into it, then a helix of strands in a white void, a collage of photos in stop motion, black title cards and a typewriter ending. You swap the clips, whose cameras a bundled tool solves, or run the WishFilter composition on one video of your own.',
    change: [
      'The five clips and the camera track for each, made with the camera-tracking tool.',
      'Or one video of your own, prepared as "input" with the prepare tool, for the WishFilter composition; it also takes eight photos for the collage.',
    ],
    media: { hero: { from: 'effects/wish-reel/out/wish-reel.mp4', at: 2 } },
  },
  'word-flash': {
    description:
      'A black-and-white type spot at 1080 by 1920 and 9.4 seconds, cut on every hit of its track: one word or a two-word lockup per cut, the background swapping black and white, ending with a last word that types on and blurs away. You swap the words, the track and the typeface.',
    change: [
      'The words, in script.ts (intro, run and outro). The run is one word per cut, so the word count has to match the number of cuts.',
      'The track, at public/audio.m4a; a small tool finds its strongest hits and gives the cuts to paste into script.ts.',
      'The typeface, FONT in lib.tsx. Positions are ink boxes, so another face lands in the same places.',
    ],
    media: { hero: { from: 'effects/word-flash/out/word-flash.mp4', at: 2.5 } },
  },
};

/** Short notes for genes whose source carries no comment, keyed slot/id. */
export const GENE_NOTES = {
  'crop/punch-in': 'Zooms in a little and nudges the frame off centre.',
  'crop/off-centre': 'A tighter crop pushed to one side.',
  'crop/tilt': 'Turns the frame a few degrees and crops in to hide the corners.',
  'shake/handheld': 'A slow, small camera wobble.',
  'shake/jitter': 'Quick jumps from one position to the next.',
  'shake/impact': 'A hard knock every half second or so that settles back.',
  'shake/breathe': 'A slow push in and out.',
  'fps/fps-12': 'Holds frames so the clip steps at 12 a second.',
  'fps/fps-8': 'Holds frames so the clip steps at 8 a second.',
  'fps/fps-6': 'Holds frames so the clip steps at 6 a second.',
  'time/echo': 'Trails of the picture from earlier frames.',
  'time/ghost': 'A faint copy of an earlier frame laid over the current one.',
  'time/strobe': 'Flashes a frame.',
  'time/repeat': 'Plays each short beat twice.',
  'time/reverse': 'The last few frames of a block play backwards, like a scratch.',
  'time/blend': 'Blends frames into a smear.',
  'mirror/mirror-x': 'Mirrors the frame left to right.',
  'mirror/mirror-y': 'Mirrors the frame top to bottom.',
  'mirror/quad': 'Four mirrored copies of the frame.',
  'mirror/tile-2': 'The frame tiled two across.',
  'mirror/tile-3': 'The frame tiled three across.',
  'mirror/kaleido': 'A kaleidoscope with three to eight segments.',
  'mirror/split-offset': 'Splits the frame in two and slides one half.',
  'isolate/keep-red': 'Keeps the reds and drains the rest to grey.',
  'isolate/keep-warm': 'Keeps orange and yellow tones and drains the rest.',
  'isolate/keep-green': 'Keeps the greens and drains the rest.',
  'isolate/keep-blue': 'Keeps the blues and drains the rest.',
  'isolate/keep-any': 'Keeps one randomly chosen hue and drains the rest.',
  'isolate/shift-one': 'Turns one hue into a different one and leaves the rest.',
  'grade/teal-crush': 'Crushed blacks with teal shadows and warm highlights.',
  'grade/bleach': 'Washed-out colour with hard contrast, like a bleach bypass print.',
  'screen/halftone': 'Dots of ink, as in a newspaper photo.',
  'screen/dither': 'A few flat colours broken up with a dither pattern.',
  'screen/scanlines': 'Scanlines across the picture.',
  'screen/crt': 'Scanlines plus the curved glass of a tube.',
  'screen/two-ink': 'A print in two inks.',
  'screen/engraving': 'Fine engraved lines in ink on paper.',
  'screen/crosshatch': 'Crosshatched pen lines in ink on paper.',
  'screen/painterly': 'A painted look that smooths detail into brush shapes.',
  'screen/ascii': 'The picture drawn in text characters.',
  'screen/pixelate': 'Large square pixels.',
  'optics/fringe': 'Red and blue edges split a little apart, as in a cheap lens.',
  'optics/split': 'A strong colour split along one axis.',
  'optics/bloom': 'Highlights glow.',
  'optics/halation': 'A red or orange glow round bright spots, as film does.',
  'optics/soft-focus': 'A slight blur with a glow on top.',
  'optics/fringe-bloom': 'Colour fringing and bloom together.',
  'optics/zoom-blur': 'Blur that radiates from the centre.',
  'optics/streaks': 'Highlights stretched into streaks.',
  'optics/anamorphic': 'A coloured horizontal flare, as from an anamorphic lens.',
  'optics/light-leak': 'A burst of coloured light, as from a film camera that leaks.',
  'optics/vignette': 'Dark corners.',
  'optics/lens-wobble': 'The picture ripples as if seen through a warped lens.',
  'damage/slice-glitch': 'Horizontal slices of the picture shift sideways.',
  'damage/rgb-slice': 'Slices shift and the colour channels come apart.',
  'damage/fine-grain': 'Fine monochrome grain.',
  'damage/coarse-grain': 'Large, coloured grain.',
  'damage/film-wear': 'Dust, hairs and scratches of an old print.',
  'damage/tape': 'Worn video tape: tracking errors, noise and smeared colour.',
  'damage/glitch': 'Digital blocks and colour splits.',
  'damage/warp': 'The picture warps as if drawn on rippling water.',
  'grunge/creases': 'Folded-paper creases.',
  'grunge/stains': 'Stains and blotches.',
  'grunge/speckle': 'Speckled dirt.',
  'grunge/scratches': 'Scratches.',
  'grunge/fibre': 'Paper fibres.',
  'grunge/toner': 'Photocopier toner.',
};

/** Summaries for public exports whose source has no JSDoc line, keyed plugin/name. */
export const EXPORT_NOTES = {
  'hexed/Hexed': 'Wraps any children and rolls a look onto them. It fills the composition unless you give a width and height.',
  'hexed/Grunge': 'Lays a texture (a procedural one or a scan) over the finished picture.',
  'paper/MatchCut': 'A keyword holds still, highlighted, while the page under it changes several times a second. It fills its composition.',
  'paper/CutOut': 'A photo with its background already removed (a PNG with alpha) as a paper cut-out.',
  'paper/FoldOut': 'A CutOut that unfolds from a crumpled packet to a flat sheet.',
  'vj/crt': 'A colour tube: curved glass, scanlines, aperture grille, misconvergence, a rolling bar, static and dark corners.',
  'vj/vhs': 'A worn tape: line wobble, late smeared colour, a head-switch tear, a drifting tracking band, snow and dropouts.',
  'vj/thermal': "A thermal camera's palette on the picture's brightness, a little soft.",
  'vj/pixels': 'A magnifier: blocks, then red, green and blue subpixel stripes as the zoom grows.',
};
