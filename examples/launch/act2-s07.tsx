// Shot 7: "your demo, your launch, your changelog, write it in code and it renders for you." The voiceover as big
// word-by-word captions with the tracker locked on the words (print/captions.tsx), over our own renders, cut on each
// phrase; on "and it renders" the picture cuts to thermal receipts printing out (print/receipts.tsx).

import React from 'react';
import { AbsoluteFill, Sequence, Video, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { CLAMP, H, LEN, W } from './common.js';
import { Captions, FACES, TrackHud, type CaptionLine } from './print/captions.js';
import { Receipts } from './print/receipts.js';

/** The voiceover lines of the shot (sound-timing.ts puts 07a at frame 4 and 07b at frame 58). */
export const LINES: CaptionLine[] = [
  { file: '07a-your', at: 4, split: [2, 2, 2], face: FACES.square, hot: ['demo', 'launch', 'changelog'] },
  { file: '07b-write', at: 58, split: [2, 2, 3, 2], face: FACES.doto, hot: ['code', 'renders'] },
];

/** The footage under the captions, cut on each phrase: the clip, the frame it cuts in, and the clip frames skipped. */
export const CUTS = [
  { at: 0, src: 'pool/clip-pig.mp4', trim: 0 },      // your demo
  { at: 23, src: 'pool/clip-clouds.mp4', trim: 0 },  // your launch
  { at: 36, src: 'pool/clip-ep13.mp4', trim: 0 },    // your changelog
  { at: 58, src: 'pool/clip-code.mp4', trim: 30 },   // write it in code (past its title card)
] as const;
/** The cut to the receipts, on "and it renders". */
export const RECEIPTS_AT = 78;

/** A two-frame white flash on a cut. */
const Flash: React.FC<{ at: number }> = ({ at }) => {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{ background: '#FFFFFF', opacity: interpolate(frame, [at, at + 1, at + 3], [0.55, 0.25, 0], CLAMP) }} />;
};

export const S07: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      {CUTS.map((c, i) => (
        <Sequence key={c.src} from={c.at} durationInFrames={(CUTS[i + 1]?.at ?? RECEIPTS_AT) - c.at}>
          <Video src={staticFile(c.src)} muted trimBefore={c.trim} width={W} height={H} fit="cover" />
        </Sequence>
      ))}
      <Sequence from={RECEIPTS_AT}><Receipts frames={LEN.s07 - RECEIPTS_AT} /></Sequence>
      {/* a soft darkening behind the words, so white type reads over bright footage */}
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse 60% 45% at 50% 50%, rgba(0,0,0,0.32) 0%, rgba(0,0,0,0) 100%)' }} />
      <Captions lines={LINES} />
      <TrackHud lines={LINES} />
      {[...CUTS.slice(1).map((c) => c.at), RECEIPTS_AT].map((at) => frame >= at && frame < at + 3 && <Flash key={at} at={at} />)}
    </AbsoluteFill>
  );
};
