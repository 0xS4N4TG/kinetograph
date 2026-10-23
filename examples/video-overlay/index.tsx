// A footage overlay, the kind of composition where Kinetograph's speed gain
// over Remotion should be smallest: a full-frame
// clip with its sound, word-by-word captions, a lower third that springs in
// and out, and a looping GIF badge.
//
// It is written the way an agent would write it for Remotion: `OffthreadVideo`
// from `remotion`, `Gif` from `@remotion/gif`, captions from
// `@remotion/captions`, a Google font, plus Kinetograph's native elements for
// the overlays. The media are ffmpeg test sources made by `make-media.sh`
// (no real footage in the repo); `public/` holds them.
//
// Render on the M4:
//   npx kinetograph still examples/video-overlay/index.tsx 90 -o out/overlay-90.png
//   npx kinetograph strip examples/video-overlay/index.tsx -n 12 -o out/overlay-strip.png
//   npx kinetograph render examples/video-overlay/index.tsx -o out/video-overlay.mp4
//   npx kinetograph studio examples/video-overlay/index.tsx
// and time `render` against Remotion rendering the same clip.

import React from 'react';
import {
  Composition,
  OffthreadVideo,
  Sequence,
  interpolate,
  registerRoot,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { Gif } from '@remotion/gif';
import { createTikTokStyleCaptions, parseSrt } from '@remotion/captions';
import { loadFont } from '@remotion/google-fonts/Inter';
import { Layer, Rect, Text, dropShadow, linearGradient } from '@kinetographdev/core';

const { fontFamily } = loadFont('normal', { weights: ['400', '700'] });

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const DURATION = 180;
const ACCENT = '#ffd23f';

// ---- captions: one cue per word, grouped into pages ----

const SRT = `1
00:00:00,400 --> 00:00:00,750
Every

2
00:00:00,750 --> 00:00:01,000
 frame

3
00:00:01,000 --> 00:00:01,300
 of

4
00:00:01,300 --> 00:00:01,900
 this

5
00:00:01,900 --> 00:00:02,600
 clip

6
00:00:02,700 --> 00:00:03,050
 is

7
00:00:03,050 --> 00:00:03,600
 decoded

8
00:00:03,600 --> 00:00:04,000
 in

9
00:00:04,000 --> 00:00:04,500
 Rust,

10
00:00:04,600 --> 00:00:05,000
 not

11
00:00:05,000 --> 00:00:05,700
 Chrome.
`;

const { pages } = createTikTokStyleCaptions({
  captions: parseSrt({ input: SRT }).captions,
  combineTokensWithinMilliseconds: 1400,
});

const CAPTION_WIDTH = 1500;

/** One page of captions; the word being spoken is in the accent colour. */
const CaptionPage: React.FC<{ page: (typeof pages)[number] }> = ({ page }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ms = page.startMs + (frame / fps) * 1000;
  // The page's text is its tokens joined, so each token covers a run of code points.
  const colors: (string | null)[] = [];
  for (const token of page.tokens) {
    const active = ms >= token.fromMs && ms < token.toMs;
    for (const _ of Array.from(token.text)) colors.push(active ? ACCENT : null);
  }
  const pop = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 8 });
  return (
    <Text
      font={fontFamily}
      weight={700}
      size={72}
      color="#ffffff"
      align="center"
      maxWidth={CAPTION_WIDTH}
      x={(WIDTH - CAPTION_WIDTH) / 2}
      y={830 + (1 - pop) * 20}
      opacity={pop}
      chars={colors.map((color) => (color === null ? null : { color }))}
      effects={[dropShadow({ y: 4, blur: 12, color: '#000000aa' })]}
    >
      {page.text}
    </Text>
  );
};

const Captions: React.FC = () => {
  const { fps } = useVideoConfig();
  return (
    <>
      {pages.map((page) => (
        <Sequence
          key={page.startMs}
          name={`caption ${page.text.trim()}`}
          from={Math.round((page.startMs / 1000) * fps)}
          durationInFrames={Math.max(1, Math.round((page.durationMs / 1000) * fps))}
        >
          <CaptionPage page={page} />
        </Sequence>
      ))}
    </>
  );
};

// ---- lower third ----

const LowerThird: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 16 } });
  const exit = spring({ frame: frame - (durationInFrames - 15), fps, config: { damping: 200 } });
  // A wipe from the left, with the contents easing in behind it.
  const shown = enter - exit;
  const wipe = 700 * shown; // wide enough for the shadow at rest
  return (
    <Layer
      id="lower-third"
      x={96 - 40 * (1 - shown)}
      y={96}
      clip={{ kind: 'polygon', points: [[0, -40], [wipe, -40], [wipe, 180], [0, 180]] }}
    >
      <Rect width={620} height={132} radius={12} fill="#101218e6" effects={[dropShadow({ y: 10, blur: 30, color: '#00000080' })]} />
      <Rect width={10} height={132} fill={ACCENT} />
      <Text font={fontFamily} weight={700} size={44} color="#ffffff" x={40} y={22}>
        Test Pattern No. 2
      </Text>
      <Text font={fontFamily} size={28} color="#c7cad4" x={40} y={80} opacity={interpolate(frame, [8, 20], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}>
        ffmpeg testsrc2, 640x360, 30 fps
      </Text>
    </Layer>
  );
};

// ---- the composition ----

const VideoOverlay: React.FC = () => (
  <>
    <OffthreadVideo
      id="footage"
      src={staticFile('clip.mp4')}
      style={{ width: WIDTH, height: HEIGHT, objectFit: 'cover' }}
      trimBefore={15}
      loop
      volume={(f) => interpolate(f, [0, 20, DURATION - 20, DURATION], [0, 0.5, 0.5, 0], { extrapolateRight: 'clamp' })}
    />
    {/* A dark fade under the captions so white text reads on the bright pattern. */}
    <Rect
      y={HEIGHT - 420}
      width={WIDTH}
      height={420}
      fill={linearGradient(['#00000000', '#000000cc'])}
    />
    <Sequence name="lower third" from={20} durationInFrames={130}>
      <LowerThird />
    </Sequence>
    <Gif id="badge" src={staticFile('badge.gif')} width={120} height={120} x={WIDTH - 96 - 120} y={96} clip={{ kind: 'inset', radius: 24 }} />
    <Captions />
  </>
);

registerRoot(() => (
  <Composition
    id="VideoOverlay"
    component={VideoOverlay}
    durationInFrames={DURATION}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
    background="#000000"
  />
));
