// Shots 1 and 2, the opening: "In 1891, the Kinetograph made pictures move." Shot 1 is a film leader counting down
// through the 3 to the 2, where it pops and goes black, as the projector runs up. Shot 2 is two of the first films ever shot, both made on Edison's
// Kinetograph and in the public domain: the Blacksmith Scene (1893), then Fred Ott's Sneeze (1894), whose sneeze lands
// on "move". Both are graded like shot 7's archive film, and the line writes itself beside the tracked face in the
// same mixed hands (print/captions.tsx).

import React from 'react';
import { AbsoluteFill, Sequence, interpolate, random, staticFile, useCurrentFrame } from 'remotion';
import { Layer, Video, glow, gradientMap, grain } from '@kinetographdev/core';
import { CLAMP, H, LEN, W } from './common.js';
import { BAR, Film, Flash, camera } from './act2-s07.js';
import { Captions, type CaptionLine, type Point } from './print/captions.js';
import { VO, spoken } from './sound-timing.js';
import fredTrack from './track/fred.json';
import smithTrack from './track/blacksmith.json';

const OPEN_AT = VO.find((v) => v.file === '02-1891')!.at;
/** The opening line, split into pages: "In 1891," / "the Kinetograph" / "made pictures move." */
export const S02_LINES: CaptionLine[] = [{ file: '02-1891', at: OPEN_AT, split: [2, 2, 3], hot: ['1891', 'kinetograph', 'move'] }];

/** The cut to Fred Ott, on "the Kinetograph" (the third word). */
export const FRED_AT = spoken('02-1891')[2]!.from - 2;
type Track = { points: number[][] };
export const S02_CUTS = [
  { at: 0, src: 'footage/blacksmith.mp4', track: smithTrack as Track },
  { at: FRED_AT, src: 'footage/fred.mp4', track: fredTrack as Track },
] as const;

function anchor(f: number): Point | null {
  const c = f >= FRED_AT ? S02_CUTS[1] : S02_CUTS[0];
  const pts = c.track.points;
  const [x, y] = pts[Math.min(pts.length - 1, Math.max(0, f - c.at))]!;
  return camera(f, c.at).map({ x, y });
}

/** The leader's frame with the first "2" (public/footage/leader.mp4: 22 frames of 3, two of 2, two of black). */
export const S01_POP = 22;

/** Shot 1: the leader, sepia, flickering, its sweep turning, the projector getting up to speed. */
export const S01: React.FC = () => {
  const frame = useCurrentFrame();
  const flicker = 0.88 + random(`lead-${frame}`) * 0.16;
  const jx = (random(`lx-${frame}`) - 0.5) * 4, jy = (random(`ly-${frame}`) - 0.5) * 5;
  const s = 1.03 + 0.02 * (frame / LEN.s01);
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      <Layer id="leader" x={(1 - s) * (W / 2) + jx} y={(1 - s) * (H / 2) + jy} scale={s} opacity={flicker}
        effects={[gradientMap({ stops: [{ offset: 0, color: '#0b0806' }, { offset: 0.55, color: '#8a7458' }, { offset: 1, color: '#fff0d6' }] }), glow({ radius: 40, intensity: 0.35 }), grain(0.12, { seed: 3 })]}>
        <Video src={staticFile('footage/leader.mp4')} width={W} height={H} fit="cover" muted />
      </Layer>
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse 80% 75% at 50% 50%, rgba(0,0,0,0) 45%, rgba(0,0,0,0.7) 100%)' }} />
    </AbsoluteFill>
  );
};

/** Shot 2: the two films, the line written beside the faces. */
export const S02: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      {S02_CUTS.map((c, i) => (
        <Sequence key={c.src} from={c.at} durationInFrames={(S02_CUTS[i + 1]?.at ?? LEN.s02) - c.at}>
          <Film src={c.src} at={c.at} id="s02-film" />
        </Sequence>
      ))}
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse 80% 75% at 50% 50%, rgba(0,0,0,0) 50%, rgba(0,0,0,0.6) 100%)' }} />
      <Captions lines={S02_LINES} anchor={anchor} width={W} height={H} top={BAR + 30} />
      <AbsoluteFill>
        <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: BAR, background: '#000' }} />
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: BAR, background: '#000' }} />
      </AbsoluteFill>
      {[0, FRED_AT].map((at) => frame >= at && frame < at + 4 && <Flash key={at} at={at} />)}
    </AbsoluteFill>
  );
};
