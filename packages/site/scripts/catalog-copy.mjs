// Hand-written copy and chosen media for the catalog pages, read by catalog.mjs. Written from each plugin's SKILL.md,
// README and presets, and from each template's index.tsx and README, in plain words. Nothing here names the private
// kinetograph-effects repo, and no template says what it was modelled on.

/** The one line every plugin page says about installing: in words, no commands, none exist yet. */
const INSTALLED = 'How it installs: as a package you add to your project. Its skill comes with it, so an agent can use it without being taught.';

export const PLUGIN_COPY = {
  hexed: {
    summary: 'Put a look on any picture or clip. Hexed picks a grade, a print screen, a lens effect, some tape damage and a camera shake for you. Keep the parts you like and reroll the rest.',
    intro: 'Hexed puts a look on a picture or a clip. Roll a number and you get a new look, and the same number always gives the same one. A look is built from eleven slots, each holding one named effect.',
    features: [
      { title: 'Roll a look', text: 'Roll a number for a grade, a print screen, lens effects, tape damage and a camera shake. Roll again for another.', media: { from: 'effects/hexed-demo/out/RickReel-10s.mp4', at: 0, len: 4, caption: 'Rick Astley, with a new look rolled every second and a half.' } },
      { title: 'Lock and reroll', text: 'Lock the slots you like and roll the rest again. Each label names the effects that seed rolled.', media: { from: 'effects/hexed-demo/out/dream.mp4', at: 1, len: 4, caption: 'Twenty seeds rolled onto one frame, each with its effects named under it.' } },
      { title: 'Saved looks', text: 'Save a look as a preset and use it on the next video. Pick one by name and set how strong it is.', media: { from: 'effects/hexed-demo/out/RickLook.mp4', at: 0, len: 4, caption: 'The moss-impact preset on the same footage.' } },
    ],
    presetNote: 'Saved looks. Pick one by name, or roll your own and save it.',
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
      panel: 'Studio gets a Hexed panel: a card for each slot with its effect, a strength slider, a lock and a shuffle button. A Shuffle for the whole look leaves the locked slots alone, and a menu holds your saved presets. It follows Studio’s light and dark theme.',
      tools: [],
      note: 'An agent can roll a look, list what each slot accepts and read the saved presets. It then writes the look it settles on into your code or saves it as a preset, so the look does not live only in Studio.',
      installed: INSTALLED,
    },
    presetLines: {},
    media: {
      hero: { from: 'effects/hexed-demo/out/RickReel-10s.mp4', at: 5, len: 4 },
      presets: {},
      demos: {
        'hexed-demo': [
          { from: 'effects/hexed-demo/out/reel.mp4', at: 1, len: 4, caption: 'A reel that rolls a new look every second and a half.' },
          { from: 'effects/hexed-demo/out/dream.mp4', at: 1, len: 4, caption: 'Twenty seeds rolled onto one frame.' },
        ],
      },
    },
  },

  'kinetic-typography': {
    summary: 'Captions that write themselves on screen in many handwritten styles, timed to your voiceover. Key words jump out in a heavy display face, and the text can follow a tracked subject.',
    intro: 'HandCaptions writes a voiceover on screen letter by letter, each letter in a different handwritten face. Key words break out whole in a display face.',
    features: [
      { title: 'Hand captions', text: 'Each word writes itself across the time it is spoken. Key words break out in a fat serif or a heavy italic.', media: { from: 'effects/kinetic-type-demo/out/Centred.mp4', at: 0, len: 4, caption: 'A line written centred low on archive film.' } },
      { title: 'Follows a tracked subject', text: 'Captions sit beside the subject on the side with room, with a reticle on it and a bracket on the letter being written.', media: { from: 'effects/kinetic-type-demo/out/tracked.mp4', at: 0, len: 4, caption: 'A line written beside a tracked anvil.' } },
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
      note: 'There is no Studio panel and no agent tools. The skill tells an agent to take word timestamps from your speech-to-text or voice-over tool instead of placing frames by hand, choose the pages and key words, track the subject with the VJ plugin, and render a few stills to check the text fits.',
      installed: INSTALLED,
    },
    presetLines: {},
    media: {
      hero: { from: 'effects/kinetic-type-demo/out/tracked.mp4', at: 0.6, len: 4 },
      presets: {},
      demos: {
        'kinetic-type-demo': [
          { from: 'effects/kinetic-type-demo/out/tracked.mp4', at: 0, len: 4, caption: 'Tracked: the line beside an anvil.' },
          { from: 'effects/kinetic-type-demo/out/Centred.mp4', at: 0, len: 4, caption: 'Centred: the same line, low in the frame.' },
        ],
      },
    },
  },

  paper: {
    summary: 'Paper textures and what you can make from them: a keyword held still while pages flick past underneath, photo cut-outs that unfold from a crumpled packet, and a hand-drawn line round a moving subject on torn paper.',
    intro: 'Paper gives a video the feel of real paper: creases, scanned fibres and grain. It makes keyword match cuts, photo cut-outs and hand-drawn lines on torn paper.',
    features: [
      { title: 'MatchCut', text: 'A highlighted keyword holds still while the page under it changes several times a second. Use made-up pages or your own screenshots.', media: { from: 'effects/match-cut/out/web.mp4', at: 0, len: 4, caption: 'The web look, keyword Super Bowl.' } },
      { title: 'CutOut and FoldOut', text: 'A photo with its background removed becomes a paper cut-out. FoldOut opens it from a crumpled packet in stop motion.', media: { from: 'effects/paper-photo/out/FoldOutDesk.mp4', at: 0, len: 2, caption: 'A cut-out opening on a desk.' } },
      { title: 'Scrapline', text: 'A marker, pencil, crayon, scribble or brush line is drawn round a moving subject, on torn paper. It redraws a few times a second.', media: { from: 'effects/scrapline/out/scrapline-demo.mp4', at: 20, len: 4, caption: 'A crayon line on binder paper round a moving subject.' } },
    ],
    presetNote: 'Four ready-made MatchCut looks. Pick one in the Studio panel and adjust from there. Anything a look leaves out falls back to MatchCut’s defaults.',
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
      panel: 'Studio gets a Paper panel for MatchCut: a card for each look, a page layout picker, sliders for keyword size, cuts per second, push-in, blur, streak, crumple and grain, colour pickers for the highlight and the paper, and a box on the preview that you drag onto the keyword. CutOut and FoldOut get a sheet view with edge and paper cards, sliders for creases and shadow, and a handle to place the picture.',
      tools: [],
      note: 'The plugin adds no agent tools. An agent sets values in Studio, checks the preview, then writes the look it settled on into your code or a preset.',
      installed: INSTALLED,
    },
    media: {
      hero: { from: 'effects/match-cut/out/Broadsheet.mp4', at: 1, len: 4 },
      presets: {
        web: { from: 'effects/match-cut/out/web.mp4', at: 1 },
        broadsheet: { from: 'effects/match-cut/out/Broadsheet.mp4', at: 1 },
        crumpled: { from: 'effects/match-cut/out/Crumpled.mp4', at: 1 },
        clean: { from: 'effects/match-cut/out/Clean.mp4', at: 1 },
      },
      demos: {
        'match-cut': [
          { from: 'effects/match-cut/out/Crumpled.mp4', at: 0, len: 4, caption: 'The crumpled look.' },
          { from: 'effects/match-cut/out/Clean.mp4', at: 0, len: 4, caption: 'The clean look.' },
        ],
        'paper-photo': [
          { from: 'effects/paper-photo/out/FoldOut.mp4', at: 0, len: 2, caption: 'A cut-out opening on a green screen.' },
          { from: 'effects/paper-photo/out/FoldOutDesk.mp4', at: 0, len: 2, caption: 'A cut-out opening on a desk.' },
        ],
      },
    },
  },

  vj: {
    summary: 'Make footage look like it came from a CRT, a worn VHS tape, a thermal camera or a 1-bit screen, cut a person into a cyberpunk pop-art poster, and draw tracking boxes on whatever moves.',
    intro: 'VJ makes a picture seem to come from a screen, a tape or a sensor. It also cuts a person into a pop-art poster and draws tracking marks on whatever moves. Brightness stands in for heat and depth, so these are looks, not measurements.',
    features: [
      { title: 'Screens and tapes', text: 'A CRT with curved glass that switches off, a worn VHS tape, a 1-bit screen and a red, green and blue pixel magnifier.', media: { from: 'effects/vj-demo/out/Crt.mp4', at: 0, len: 4, caption: 'A CRT tube switching off, on archive film.' } },
      { title: 'Thermal and depth', text: 'Brightness becomes a thermal camera palette or a depth map look.', media: { from: 'effects/vj-demo/out/Thermal.mp4', at: 0, len: 4, caption: 'A thermal palette over a parade.' } },
      { title: 'Flash looks', text: 'Acid heat, night vision, screen glow and grainy black and white.', media: { from: 'effects/hexed-demo/out/flash.mp4', at: 3, len: 4, caption: 'Flash looks on a song, each held for a second and a half.' } },
      { title: 'PopArt', text: 'Footage of a person cuts to an anime poster of them in blue tones with ink lines and rim light, over a halftone.', media: { from: 'effects/vj-demo/out/PopArt.mp4', at: 1.2, len: 4, caption: 'Fred Ott cut to an anime poster and back.' } },
      { title: 'Tracking', text: 'A tracker runs once and saves where things moved. Blobs draws boxes and links on every frame, and Reticle marks one point.', media: { from: 'effects/vj-demo/out/Blobs.mp4', at: 0, len: 4, caption: 'Blob tracking over a 1-bit picture.' } },
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
      panel: 'Studio gets a VJ panel with a card for each look and that look’s own sliders and colours. Switching looks keeps the settings of the others. On the preview you drag and resize the CRT screen and drag the magnifier’s centre. A second panel sets how the tracking marks look: box style, labels, links, blend, how many blobs to show, line width and colour.',
      tools: [],
      note: 'Tracking is run on your own machine ahead of time, so the panel only styles the result. The plugin adds no agent tools. The skill walks an agent through tracking a clip, checking the debug images, tuning the tracker and rendering a still to check.',
      installed: INSTALLED,
    },
    media: {
      hero: { from: 'effects/vj-demo/out/Vhs.mp4', at: 0, len: 4 },
      presets: {},
      demos: {
        'vj-demo': [
          { from: 'effects/vj-demo/out/PopArt.mp4', at: 1.2, len: 4, caption: 'PopArt: Fred Ott cut to an anime poster and back.' },
          { from: 'effects/vj-demo/out/Blobs.mp4', at: 0, len: 4, caption: 'Blobs: tracking over a 1-bit picture.' },
          { from: 'effects/vj-demo/out/Thermal.mp4', at: 0, len: 4, caption: 'Thermal: a parade in thermal colour.' },
          { from: 'effects/vj-demo/out/Crt.mp4', at: 0, len: 4, caption: 'Crt: a tube switching off.' },
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
  'plugin-ui-demo': 'Ready-made scenes set up for the Hexed, Paper and VJ panels in Studio.',
};

export const TEMPLATE_COPY = {
  scrapline: {
    description:
      'A hand-drawn border round a cut-out subject: a wobbly marker, pencil, crayon, scribble or brush line, on a sheet of torn paper behind it. Both are redrawn a few times a second, like hand animation.',
    change: [
      'The subject: a video with a black and white matte, a video with alpha, an image with alpha, or an SVG path.',
      'The line style (Marker, Pencil, Crayon, Scribble or Brush), the paper (White, Kraft, Binder, Cardboard, your own picture or none), the line colour, the gap to the subject and the seed.',
    ],
    media: { hero: { from: 'effects/scrapline/out/scrapline-demo.mp4', at: 20, len: 5 } },
  },
  'word-flash': {
    description:
      'A black-and-white type spot, 9.4 seconds, cut on every hit of its track. Each cut shows one word or a two-word lockup, the background swaps between black and white, and a last word types on and blurs away.',
    change: [
      'The words: an intro, a run with one word per cut, and an outro. The word count has to match the number of cuts.',
      'The track. A small tool finds its strongest hits and gives you the cuts.',
      'The typeface. Another face lands in the same places.',
    ],
    media: { hero: { from: 'effects/word-flash/out/word-flash.mp4', at: 2.5, len: 5 } },
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
