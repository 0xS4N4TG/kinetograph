// Hand-written copy and chosen media for the catalog pages, read by catalog.mjs. Written from each plugin's SKILL.md,
// README and presets, and from each component's index.tsx and README, in plain words. Nothing here names the private
// kinetograph-effects repo, no component says what it was modelled on, and no component quotes its own default on-screen text
// (those words are a component's placeholder, not what the site says). A feature with no `media` is text only.

/** The one line every plugin page says about installing: in words, no commands, none exist yet. */
const INSTALLED = 'It installs as a package you add to your project. Its skill comes with it, so an agent can use it without being taught.';

export const PLUGIN_COPY = {
  hexed: {
    summary: 'Roll a look onto any picture or clip. Hexed picks a grade, a print screen, lens effects, tape damage and a camera shake. Keep the parts you like and reroll the rest.',
    intro: 'A look is eleven slots, each holding one named effect. Roll a number and every slot fills. The same number always gives the same look, so a render comes out the same every time.',
    features: [
      { title: 'Roll a look', text: 'One number picks a crop, a grade, a print screen, lens effects, tape damage and a camera shake. Roll again for a different look.', media: { from: 'effects/hexed-demo/out/RickReel-10s.mp4', at: 0, len: 4, caption: 'Rick Astley, with a new look rolled every second and a half.' } },
      { title: 'Lock and reroll', text: 'Lock the slots you like and roll the rest again. Each label names the effects its number picked.', media: { from: 'effects/hexed-demo/out/dream.mp4', at: 1, len: 4, caption: 'Twenty seeds rolled onto one frame, each with its effects named under it.' } },
      { title: 'Saved looks', text: 'Save a look as a preset. Use it on the next video by name, and set how strong it is.', media: { from: 'effects/hexed-demo/out/RickLook.mp4', at: 0, len: 4, caption: 'The moss-impact preset on the same footage.' } },
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
      panel: "Studio gets a Hexed panel: a card for each slot with its effect, a strength slider, a lock and a shuffle button. Shuffle rerolls everything except the locked slots, and a menu holds your presets. It follows Studio's light and dark theme.",
      tools: [],
      note: 'An agent can roll a look, list what each slot accepts and read your presets. It then writes the look it settles on into your code or saves it as a preset, so the look does not live only in Studio.',
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
    summary: 'Captions that move with the voice, in fourteen ready-made styles. A hook word is set huge, and handwritten captions can follow a tracked subject.',
    intro: 'Captions sets a voiceover on screen. Each word arrives as it is said and the line leaves all together. A line with a big word is a hook: that word is set huge and the small words sit round it. HandCaptions writes the other way, one letter at a time in mixed handwriting.',
    features: [
      { title: 'Fourteen caption styles', text: 'Highlighter, typewriter, a text-selection sweep, a shine, a difference-blend prism and more. Pick one by name, then change its fonts, motion and colours. The accent colour and a readable shadow can come from your footage.' },
      { title: 'Hand captions', text: 'Each word writes itself across the time it is spoken, one letter at a time, every letter in a different handwritten face. Key words break out in a fat serif or a heavy italic, each with its own colour if you like. A dark halo keeps the letters readable over bright footage.', media: { from: 'effects/kinetic-type-demo/out/Centred.mp4', at: 0, len: 4, caption: 'A line written centred low on archive film.' } },
      { title: 'Follows a tracked subject', text: "The text hangs beside the subject, on the side with room. A reticle frames the subject and a bracket marks the letter being written. Give it the subject's box and the text stays clear of it.", media: { from: 'effects/kinetic-type-demo/out/tracked.mp4', at: 0, len: 4, caption: 'A line written beside a tracked anvil.' } },
    ],
    presetNote: '',
    examples: [
      {
        title: 'Captions in a ready-made style',
        code: `import { Captions, wordsFrom } from '@kinetographdev/kinetic-typography';

const words = wordsFrom(asr.words, 30);
const footage = { src: staticFile('me.mp4') };

<Video src={footage.src} />
<Captions words={words} split={[3, 3]} big={['premium']} preset="highlighter" footage={footage} />`,
      },
      {
        title: 'Hand captions from word timestamps',
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
      panel: 'Studio gets a Captions panel: a card for each style drawn in its own type, a Caption or Big text switch for font, case, weight, size, tracking and colour, layout cards, motion controls with an In and Out switch, and an accent colour you can take from the footage. Hook and Caption pins sit on the preview and you drag them up or down. HandCaptions has no panel.',
      tools: [],
      note: 'There are no agent tools. The skill tells an agent to take word timestamps from your speech-to-text or voice-over tool instead of placing frames by hand, choose the lines and the big words, and render a settled hook frame and caption frame to check that both read. For tracked text it tracks the subject with the VJ plugin.',
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
    summary: 'Give a video the feel of real paper. Keyword match cuts, photo cut-outs that unfold from a crumpled packet, and hand-drawn lines round a moving subject on torn paper.',
    intro: 'Paper brings creases, scanned fibres and grain to a video. From them it makes keyword match cuts, photo cut-outs and hand-drawn lines on torn paper.',
    features: [
      { title: 'MatchCut', text: 'A highlighted keyword holds still while the page under it changes several times a second. Use made-up pages or your own screenshots.', media: { from: 'effects/match-cut/out/web.mp4', at: 0, len: 4, caption: 'The web look, keyword Super Bowl.' } },
      { title: 'CutOut and FoldOut', text: 'A photo with its background removed becomes a paper cut-out. FoldOut opens it from a crumpled packet, in stop motion.', media: { from: 'effects/paper-photo/out/FoldOutDesk.mp4', at: 0, len: 2, caption: 'A cut-out opening on a desk.' } },
      { title: 'Scrapline', text: 'A marker, pencil, crayon, scribble or brush line is drawn round a moving subject, on torn paper. It redraws a few times a second, like hand animation.', media: { from: 'effects/scrapline/out/scrapline-demo.mp4', at: 20, len: 4, caption: 'A crayon line on binder paper round a moving subject.' } },
    ],
    presetNote: "Four ready-made MatchCut looks. Pick one in the Studio panel and adjust from there. Anything a look leaves out falls back to MatchCut's defaults.",
    presetLines: {
      web: 'Web pages and social posts: ten cuts a second, a strong blur and streak, creased grey paper, a yellow highlight.',
      broadsheet: 'Newspaper layouts (pull quote, italic, kicker, body, display) at ten cuts a second, with a closer push-in.',
      crumpled: 'The fastest and roughest: twelve cuts a second, heavy smear, streak and crumple, some grain.',
      clean: 'Eight cuts a second on near-white paper, with no blur, streak, crumple, grain or wander.',
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
    summary: 'Make footage look like a CRT, a worn VHS tape, a thermal camera or a 1-bit screen. Track what moves and draw boxes on it, cut a person into a pop-art poster, or fly a camera through clips seen as windows.',
    intro: 'VJ makes a picture look like it came from a screen, a tape or a sensor. Brightness stands in for heat and depth, so these are looks, not measurements. It also draws tracking marks on whatever moves, cuts a person into a pop-art poster and builds a camera fly-through of clips.',
    features: [
      { title: 'Screens and tapes', text: 'A CRT with curved glass that switches off, a worn VHS tape, a 1-bit screen, and a pixel magnifier that resolves into red, green and blue stripes.', media: { from: 'effects/vj-demo/out/Crt.mp4', at: 0, len: 4, caption: 'A CRT tube switching off, on archive film.' } },
      { title: 'Thermal and depth', text: 'Brightness becomes a thermal-camera palette or a depth-map look.', media: { from: 'effects/vj-demo/out/Thermal.mp4', at: 0, len: 4, caption: 'A thermal palette over a parade.' } },
      { title: 'Flash looks', text: 'Acid heat, night vision, screen glow and grainy black and white, to cut on the beat.', media: { from: 'effects/hexed-demo/out/flash.mp4', at: 3, len: 4, caption: 'Flash looks on a song, each held for a second and a half.' } },
      { title: 'PopArt', text: 'Footage of a person cuts to an anime poster of them: blue tones, ink lines and rim light over a halftone. It needs a matte of the person, which a bundled tool makes once per clip.', media: { from: 'effects/vj-demo/out/PopArt.mp4', at: 1.2, len: 4, caption: 'Fred Ott cut to an anime poster and back.' } },
      { title: 'Tracking', text: 'A tracker runs once and saves where things moved. Blobs draws boxes and links on every frame. Reticle marks one point.', media: { from: 'effects/vj-demo/out/Blobs.mp4', at: 0, len: 4, caption: 'Blob tracking over a 1-bit picture.' } },
      { title: 'Fragments', text: 'Clips show only through windows: boxes round the people and animals in them, tiles of sky, round holes. Each clip sits on its own plane at its own depth, and a camera flies through so near pieces slide past faster than far ones. Boxes carry name tags with a flickering confidence figure. Whoever edits the video names the boxes; no detection model runs.' },
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
      panel: "Studio gets a VJ panel with a card for each look and that look's own sliders and colours. Switching looks keeps the settings of the others. On the preview you drag and resize the CRT screen and drag the magnifier's centre. A second panel sets how the tracking marks look: box style, labels, links, blend, how many blobs to show, line width and colour.",
      tools: [],
      note: 'Tracking runs on your own machine ahead of time, so the panel only styles the result. The plugin adds no agent tools. The skill walks an agent through tracking a clip, checking the debug images, tuning the tracker and rendering a still to check. For Fragments it has the agent name the boxes from stills of each clip.',
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

/** Demo showrooms that are not components: what they show, in a sentence. */
export const DEMO_TEXT = {
  'match-cut': 'One composition per MatchCut look, five seconds each, keyword "Super Bowl", a paper flick on every cut.',
  'paper-photo': 'The four cut-out edges, and the fold-out on a green screen and on a desk.',
  'kinetic-type-demo': 'The fourteen caption styles over a talking head, and a line written beside a tracked anvil in archive film, then centred low.',
  'vj-demo': 'Blob tracking over a 1-bit picture and over a thermal camera, a CRT switching off and a VHS tape, on archive film.',
  'hexed-demo': 'A reel that rolls a new look every second and a half, and sheets of twenty seeds on one frame.',
  'plugin-ui-demo': 'Ready-made scenes for the Hexed, Paper, VJ and caption panels in Studio. Edit a value and the preview redraws.',
};

export const COMPONENT_COPY = {
  scrapline: {
    title: 'Scrapline cut-outs',
    description:
      'A hand-drawn border round a cut-out subject, on a sheet of torn paper. The line can be a wobbly marker, pencil, crayon, scribble or brush. Line and paper redraw a few times a second, like hand animation.',
    change: [
      'The subject: a video with a black and white matte, a video with alpha, an image with alpha, or an SVG path.',
      'The line style (Marker, Pencil, Crayon, Scribble or Brush), the paper (White, Kraft, Binder, Cardboard, your own picture or none), the line colour, the gap to the subject and the seed.',
    ],
    media: { hero: { from: 'effects/scrapline/out/scrapline-demo.mp4', at: 20, len: 5 } },
  },
  'word-flash': {
    title: 'Words cut to the beat',
    description:
      'A 9.4 second black-and-white type spot, cut on every hit of its track. Each cut shows one word or a two-word lockup on a ground that flips between black and white. A last word types on, then blurs away.',
    change: [
      'The words: an intro, a run with one word per cut, and an outro. The word count has to match the number of cuts.',
      'The track. A small tool finds its strongest hits and gives you the cuts.',
      'The typeface. Another face lands in the same places.',
    ],
    media: { hero: { from: 'effects/word-flash/out/word-flash.mp4', at: 2.5, len: 5 } },
  },
  'collage-burst': {
    title: 'Screenshot card burst',
    description:
      'A wordmark fades in on black, then a cluster of screenshot cards bursts out of one point as the camera flies in. The cards settle into a dense wall, drift, and whip off to the right. Big white type finishes it: two short lines, each starting as a single word.',
    change: [
      'The brand name and the word after it in the wordmark (or none), and the two closing lines.',
      'Your own screenshots or photos on the cards, and the words printed on the cards. With none, every card is drawn.',
      'The three typefaces (wordmark and cards, terminal, serif) and the colours: canvas, text, accent, paper and dark cards.',
      'The seed, which sets the tilt and timing of the burst.',
    ],
    media: { hero: { from: 'effects/collage-burst/out/collage-burst.mp4', at: 0.3, len: 4 } },
  },
  'greeting-intro': {
    title: 'App window greeting',
    description:
      'A gradient wordmark on a soft off-white ground shrinks away as an app window grows in behind it. The camera pushes into the window, tilted, and types a greeting and a question in large perspective type. Four suggestion cards slide in, then the camera pulls back and flattens to the whole window.',
    change: [
      'The brand name, the name in the greeting, the question under it and the placeholder in the prompt box.',
      'One to four suggestion cards, with your own labels, and the small caption at the bottom (or none).',
      'The typeface, and the colours: ground, glows, window, cards, text and the wordmark and greeting gradients.',
      'Whether it moves in two-frame steps or smoothly at 60 frames a second.',
    ],
    media: { hero: { from: 'effects/greeting-intro/out/greeting-intro.mp4', at: 0, len: 3.5 } },
  },
  'wait-ship': {
    title: 'Two lines on a focus pull',
    description:
      'Seven photo cards float round the edges of a near-black frame, out of focus. The camera pulls back and racks focus. A first line comes up out of the blur and a second line replaces it. The scene slides off to the right as the left card sharpens.',
    change: [
      'The two lines, and a product name in the second.',
      'Your own photos on the seven cards. Any card you leave out keeps its drawn picture.',
      'The typeface, weight, size, tracking and text colour, and the two colours of the background.',
      'How strong the focus blur, the film grain and the closing slide are, and the frame where the first line gives way to the second.',
    ],
    media: { hero: { from: 'effects/wait-ship/out/wait-ship.mp4', at: 0, len: 2.45 } },
  },
  'prompt-reply': {
    title: 'Chat prompt to reply',
    description:
      'A chat prompt types itself into a rounded box and sends. The shot cuts to the reply, built on a page the camera scrolls through. Two activity rows, a status line, a serif reply, a brand chip, a small table and a row of action icons fade up one after another.',
    change: [
      'The prompt, the two activity rows, the status line and the reply.',
      'The brand chip, and the table: three column heads and one row.',
      'The three typefaces (interface, mono chip, serif reply).',
      'The colours: background, panel, text, the warm typing tint, labels, links and icons.',
    ],
    media: { hero: { from: 'effects/prompt-reply/out/prompt-reply.mp4', at: 0, len: 5 } },
  },
  'phone-orbit': {
    title: 'Social post on a phone',
    description:
      'A phone showing a social post starts as a close-up of its lower edge, pulls back and glides to rest. Chat bubbles, avatars and icon chips pop in around it. A hand reaches into the photo and lifts the phone, and the screen swaps to a second one as the view count reaches its cap.',
    change: [
      'The brand name in the post header, the caption pill and the two-part subtitle on the photo.',
      'The view count: where it starts, where it stops, and its unit.',
      'The three chat bubbles, and the words on the second screen.',
      'Your own photo for the post, a second picture for the swap, a logo and four avatars. Without them, all of it is drawn.',
      'The typefaces and colours, and whether the motion steps at 24 frames a second or runs smooth at 60.',
    ],
    media: { hero: { from: 'effects/phone-orbit/out/phone-orbit-stock.mp4', at: 0.65, len: 2.55 } },
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
  'kinetic-typography/Captions': 'Sets a voiceover on screen in one of fourteen ready-made styles. Each word arrives as it is said and the line leaves all together. A line with a big word is a hook.',
  'kinetic-typography/STYLES': 'The fourteen ready-made styles, by name.',
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

/**
 * The motion components, one folder of the private checkout per kind (components/<dir>/). Maps are left out for now.
 * The order here is the order on the site.
 */
export const KIND_DIRS = ['grids', 'carousels', 'charts', 'showcase', 'backgrounds', 'audio-viz', 'effects'];

/**
 * Copy and media for each composition a kind folder registers, keyed by composition id. `preview` is the render in the
 * folder's out/; `at` and `len` pick the cut for the hero clip (seconds). A composition with no entry here is skipped.
 */
export const KIND_COPY = {
  // grids
  GridRect: { title: 'Rectangular photo grid', description: 'A wall of photo cards ripples in from the middle card, then the camera pulls back, trucks across and pushes in on a new card.', preview: 'GridRect.mp4', at: 0.8, len: 4 },
  GridRadial: { title: 'Photo rings', description: 'Three concentric rings of photos at different depths open from the centre. The camera swings side to side, then pushes in as focus racks from the inner ring to the outer one.', preview: 'GridRadial.mp4', at: 0.3, len: 4 },
  GridPath: { title: 'Photos along a curve', description: 'Upright photo cards follow a curve: a wave, a triangle, a square or an infinity sign. The line draws on, the leading card sets off, and the camera trucks along the line.', preview: 'GridPath.mp4', at: 0.3, len: 4 },
  GridSpherical: { title: 'Photo sphere', description: 'Cards sit tangent to a sphere. It assembles from its centre and turns a full orbit, then settles on one hero card and pushes in.', preview: 'GridSpherical.mp4', at: 0.5, len: 4 },
  GridForwardOrient: { title: 'Photo ring facing forward', description: 'A ring of cards on a tilted turntable, each turned to face the way it travels. The camera orbits and closes in during one slow stroke.', preview: 'GridForwardOrient.mp4', at: 0.4, len: 4 },
  GridCenterOrient: { title: 'Photo rosette', description: 'A grid in which every card turns to point at the centre. The twist travels outward into a rosette while the camera rolls and pushes in.', preview: 'GridCenterOrient.mp4', at: 0.8, len: 4 },
  GridPathOrient: { title: 'Photo loop on a triangle', description: 'Cards ride a rounded triangle, each turned to the direction of the path. The camera looks down and orbits as the cards swing through the corners.', preview: 'GridPathOrient.mp4', at: 0.4, len: 4 },
  GridFaceScreen: { title: 'Photo ring facing the screen', description: 'A carousel ring where every card turns to face the screen. It steps one card at a time with a rest between steps, while the camera lifts and closes in.', preview: 'GridFaceScreen.mp4', at: 0.3, len: 4 },
  // carousels
  CircleCarousel1: { title: 'Growing circle carousel', description: 'Square covers sit on a ring that grows from tiny to large as it turns.', preview: 'circle-carousel-1.mp4', at: 0.3, len: 4 },
  CircleCarousel2: { title: 'Spiral carousel', description: 'Covers wind inward on a spiral. They are born at the rim and swallowed at the centre.', preview: 'circle-carousel-2.mp4', at: 0.3, len: 4 },
  CircleCarousel3: { title: 'U-shaped carousel', description: 'Covers are filed into a U and sit askew, like prints that have been handled.', preview: 'circle-carousel-3.mp4', at: 0.3, len: 4 },
  CardRail: { title: 'Card rail', description: 'Portrait cards sit on a tilted plane and are flicked along it in two throws, each with a label.', preview: 'card-rail.mp4', at: 0.5, len: 4 },
  ReelWall: { title: 'Spinning card ring', description: 'A 3D ring of tall cards spins to rest on one, which steps forward with its name.', preview: 'reel-wall.mp4', at: 1.5, len: 4 },
  OrbitGallery: { title: 'Orbit gallery', description: 'Nine photos spiral in around a title and settle on an ellipse.', preview: 'orbit-gallery.mp4', at: 0, len: 4 },
  GalleryPush: { title: 'Gallery wall push-in', description: 'A wall of photo columns unrolls from the middle while the camera pushes in.', preview: 'gallery-push.mp4', at: 0.3, len: 4 },
  ShowcaseDrift: { title: 'Work card drift', description: 'Cards of work slide in behind a headline and settle without a bounce.', preview: 'showcase-drift.mp4', at: 0, len: 3 },
  // charts
  AreaChart: { title: 'Area chart', description: 'A gradient area draws in under a trucking camera and lands on a tooltip. Light or dark.', preview: 'area-chart.mp4', at: 0.2, len: 4 },
  LineTicker: { title: 'Line ticker', description: 'A climbing line with the camera chasing its head and a large live number above it. Light or dark.', preview: 'line-ticker.mp4', at: 0.3, len: 4 },
  BarChart: { title: 'Bar chart', description: 'Bars grow in turn, then focus racks and the camera pushes in on the winner. A small gap between bars makes it a histogram.', preview: 'bar-chart.mp4', at: 1.2, len: 4 },
  DonutChart: { title: 'Donut chart', description: 'One sweep draws the segments, then the leading segment steps out with a callout. Light or dark.', preview: 'donut-chart.mp4', at: 0.3, len: 4 },
  ScatterBloom: { title: 'Scatter bloom', description: 'Points bloom onto a plane in coloured groups. The camera then tips and orbits to show their heights.', preview: 'scatter-bloom.mp4', at: 1, len: 4 },
  HexTally: { title: 'Hexagon tally', description: 'A unit chart of hexagons fills in beside a metric card that counts up.', preview: 'hex-tally.mp4', at: 0.5, len: 4 },
  TallyRise: { title: 'Currency counter', description: 'A currency amount rolls up like an odometer, its wheels locking from left to right.', preview: 'tally-rise.mp4', at: 0.3, len: 4 },
  RadarChart: { title: 'Radar chart', description: 'A radar chart fills in axis by axis as the camera circles it, then a second series springs open.', preview: 'radar-chart.mp4', at: 1.5, len: 4 },
  RingChart: { title: 'Ring chart', description: 'Rings fill one at a time with the camera riding each head, then it pulls back on the whole chart.', preview: 'ring-chart.mp4', at: 1.5, len: 4 },
  FunnelChart: { title: 'Funnel chart', description: 'A funnel blooms stage by stage as the camera moves down it and each number counts up.', preview: 'funnel-chart.mp4', at: 1.5, len: 4 },
  HeatmapChart: { title: 'Heatmap chart', description: 'A year of activity lights up week by week, then the camera leans in on the busiest day.', preview: 'heatmap-chart.mp4', at: 1.5, len: 4 },
  SankeyChart: { title: 'Sankey chart', description: 'The camera follows the strongest flow, then every other link draws in around it.', preview: 'sankey-chart.mp4', at: 1.5, len: 4 },
  CandlestickChart: { title: 'Candlestick chart', description: 'Candles print one by one while the camera rides the newest through a breakout.', preview: 'candlestick-chart.mp4', at: 2, len: 4 },
  // showcase
  ThreePhone: { title: 'Three phones fanned out', description: 'Three tilted phones fan out on an arc from the centre one. Each screen is drawn in, or is your own image.', preview: 'three-phone.mp4', at: 0.1, len: 4 },
  PhonePitch: { title: 'Phone with a pitch', description: 'A headline, a line of body text and a button sit beside a phone that lands with a settle.', preview: 'phone-pitch.mp4', at: 0, len: 4 },
  ScreenTunnel: { title: 'Phone tunnel', description: 'Phones recede down a corridor on either side of a headline.', preview: 'screen-tunnel.mp4', at: 0.3, len: 4 },
  LaptopOpen: { title: 'Laptop opening', description: 'A 3D laptop lid opens, the screen wakes, and the camera moves into the app.', preview: 'laptop-open.mp4', at: 0.5, len: 4.5 },
  ScreenTouch: { title: 'Touch to the next screen', description: 'A finger presses a button and the next screen opens outward from the touch point.', preview: 'screen-touch.mp4', at: 0.5, len: 4 },
  CheckoutPush: { title: 'Checkout push', description: 'A phone checkout where the amount lands and the camera pushes in.', preview: 'checkout-push.mp4', at: 0, len: 2 },
  VaultCount: { title: 'Wallet count-up', description: 'A wallet balance counts up beside a stack of payment cards.', preview: 'vault-count.mp4', at: 0, len: 3 },
  BuildOut: { title: 'Send button zoom-out', description: 'A send button zooms out to show the whole app around it.', preview: 'build-out.mp4', at: 0, len: 3.8 },
  RecapDial: { title: 'Year recap dial', description: 'A year in review on a dial that snaps month by month, with a sticker for each.', preview: 'recap-dial.mp4', at: 0.5, len: 4 },
  LaunchFilm: { title: 'Launch film', description: 'A twenty-second product launch film, from a typed headline to the final mark.', preview: 'launch-film.mp4', at: 0, len: 6 },
  // backgrounds
  GrainGradient: { title: 'Grain gradient', description: 'A mesh gradient drifts under film grain. It loops with no join at whole-number speeds.', preview: 'grain-gradient.mp4', at: 0, len: 4 },
  Paper: { title: 'Paper texture', description: 'A paper height field lit by a raking light that circles slowly. It loops with no join at whole-number speeds.', preview: 'paper.mp4', at: 0, len: 4 },
  DotField: { title: 'Halftone dot field', description: 'A grid of halftone dots breathes on a ring-shaped wave. It loops with no join at whole-number speeds.', preview: 'dot-field.mp4', at: 0, len: 4 },
  Aurora: { title: 'Aurora ribbons', description: 'Ribbons of light drift and are blended so that overlaps never blow out. It loops with no join at whole-number speeds.', preview: 'aurora.mp4', at: 0, len: 4 },
  AuroraVeil: { title: 'Aurora veil', description: 'Skewed curtains of colour drift in from the top-right corner. It loops with no join.', preview: 'aurora-veil.mp4', at: 0, len: 4 },
  LiquidGradient: { title: 'Liquid gradient', description: 'A plum, crimson and amber gradient swirls and settles. It loops with no join.', preview: 'liquid-gradient.mp4', at: 0, len: 4 },
  GrainFlow: { title: 'Grain flow', description: 'Sheets of cobalt light flow past a navy valley under film grain. It loops with no join.', preview: 'grain-flow.mp4', at: 0, len: 4 },
  DriftGradient: { title: 'Drift gradient', description: 'Soft pools of blue and cyan drift like defocused light through water. It loops with no join.', preview: 'drift-gradient.mp4', at: 0, len: 4 },
  TideGradient: { title: 'Tide gradient', description: 'Pools of cyan, mint and steel blue swell and sink into black. It loops with no join.', preview: 'tide-gradient.mp4', at: 0, len: 4 },
  GraphPaperTall: { title: 'Graph paper', description: 'A faint squared grid on off-white paper that fades towards the edges, cut tall for phones. It loops with no join.', preview: 'graph-paper-tall.mp4', at: 0, len: 4 },
  // audio-viz
  AudioScope: { title: 'Audio scope', description: 'An oscilloscope draws the sound as red and yellow traces over a dark grid. It is drawn from the audio file itself.', preview: 'AudioScope.mp4', at: 1, len: 4 },
  AudioPlasma: { title: 'Audio plasma', description: 'A white-hot trace glows inside blue copies, with the running time in huge soft numerals. It is drawn from the audio file itself.', preview: 'AudioPlasma.mp4', at: 1, len: 4 },
  // effects
  LightLeak: { title: 'Light leak', description: 'A warm, streaked leak of light from one edge. It can cover a cut between two clips.', preview: 'light-leak.mp4', at: 1.2, len: 3.5 },
  Halation: { title: 'Halation', description: 'A red-orange halo round the bright parts of a picture, with film grain on top.', preview: 'halation.mp4', at: 0, len: 3 },
  GlassLens: { title: 'Glass lens', description: 'A glass ball moves over the picture and refracts what is behind it.', preview: 'glass-lens.mp4', at: 0, len: 4 },
  FilmBurn: { title: 'Film burn transition', description: 'A heat front scorches the first picture and reveals the second.', preview: 'film-burn.mp4', at: 1, len: 3 },
};

/**
 * The tastes: reusable styles, one per folder of the checkout's kit/tastes/ (`dir`). The card plays a cut of the demo reel's
 * render in effects/tastes/ (`src`, then `at` and `len` in seconds). The display name and the sentence are written here.
 * The order here is the order on the site.
 */
export const TASTE_COPY = {
  archive: { dir: 'archive', title: 'Archive', description: 'Period photographs drift in layers under film flicker and dust, with typed dates and captions.', src: 'effects/tastes/archive-reel/out/hold-still.mp4', at: 1, len: 4 },
  collage: { dir: 'collage', title: 'Collage', description: 'Paper cut-outs and torn labels sit over an old newspaper page and move in stop motion.', src: 'effects/tastes/collage-reel/out/collage-intro.mp4', at: 1.6, len: 1.5 },
  explainer: { dir: 'explainer', title: 'Explainer', description: 'Cut-out objects on textured paper under big type, with one colour for the key word and quick wipes between beats.', src: 'effects/tastes/explainer-tastes/out/all-tastes.mp4', at: 2, len: 4 },
  papercut: { dir: 'papercut', title: 'Papercut', description: 'A toy-like paper diorama of cut-paper characters and props, with the camera circling the set.', src: 'effects/tastes/papercut-reel/out/papercut-reel.mp4', at: 2, len: 4 },
  print: { dir: 'print', title: 'Print', description: 'Flat inks print in turn over paper, with a dot screen that jumps and a slight misregistration.', src: 'effects/tastes/print-reel/out/one-ink.mp4', at: 1, len: 4 },
  'vox-style': { dir: 'vox', title: 'Vox style', description: 'Tinted, halftoned photos on grid paper, caps that fill yellow, and numbers that roll like an odometer.', src: 'effects/tastes/vox-reel/out/krakatoa.mp4', at: 1, len: 4 },
};
