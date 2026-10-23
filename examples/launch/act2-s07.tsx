// Shot 7: "Your demo. Your launch. Your changelog. Write it in code, and it renders." Archive film of the 1927
// Armistice Day parade in Columbus, Ohio (US National Archives, public domain): the veterans of the reviewing stand,
// graded silver and warm, grain and gate weave, pushing in slowly, letterboxed. The voiceover writes itself beside a
// tracked face in the Geronimo Stilton way (print/captions.tsx). On "and it renders" the cut is to a thermal printer
// feeding out a receipt, then to the pile of receipts on a table (print/receipts.tsx).

import React from 'react';
import { AbsoluteFill, Sequence, interpolate, random, staticFile, useCurrentFrame } from 'remotion';
import { Layer, Video, glow, gradientMap, grain } from '@kinetograph/core';
import { CLAMP, H, LEN, W } from './common.js';
import { Captions, type CaptionLine, type Point } from './print/captions.js';
import { Receipts } from './print/receipts.js';
import { VO, spoken } from './sound-timing.js';
import veteranTrack from './track/veteran.json';
import hatTrack from './track/hat.json';

const AT = (file: string) => VO.find((v) => v.file === file)!.at;
/** The voiceover lines of the shot, where sound-timing.ts puts them. */
export const LINES: CaptionLine[] = [
  { file: '07a-your', at: AT('07a-your'), split: [2, 2, 2], hot: ['demo', 'launch', 'changelog'] },
  { file: '07b-write', at: AT('07b-write'), split: [4, 3], hot: ['code', 'renders'] },
];

type Track = { points: number[][] };
/** The film under the captions: the clip (public/footage, cut by tools/track/README.md's recipe), the frame of the
 *  shot it cuts in, and its tracked face (tools/track/track.mjs, one point per frame). */
export const CUTS = [
  { at: 0, src: 'footage/veteran.mp4', track: veteranTrack as Track },
  { at: AT('07b-write') - 2, src: 'footage/hat.mp4', track: hatTrack as Track },
] as const;
/** The cut to the receipts, on "and it renders". */
export const RECEIPTS_AT = spoken('07b-write')[4]!.from;
/** Letterbox bars for 2.39:1. */
export const BAR = Math.round((H - W / 2.39) / 2);

const TONE = [{ offset: 0, color: '#060708' }, { offset: 0.5, color: '#7d766b' }, { offset: 1, color: '#fff2dc' }];

/** The film's slow push-in and its gate weave at shot frame `f` of a cut that began at `at`. */
export function camera(f: number, at: number) {
  const s = 1.04 + 0.05 * ((f - at) / 60);
  const jx = (random(`weave-x-${f}`) - 0.5) * 3, jy = (random(`weave-y-${f}`) - 0.5) * 2.5;
  return { s, jx, jy, map: (p: Point): Point => ({ x: W / 2 + (p.x - W / 2) * s + jx, y: H / 2 + (p.y - H / 2) * s + jy }) };
}

/** The tracked face on shot frame `f`, through the camera; null where nothing is tracked. */
function anchor(f: number): (Point & { side?: 'left' | 'right' }) | null {
  const i = [...CUTS].reverse().findIndex((c) => f >= c.at);
  if (f >= RECEIPTS_AT || i < 0) return receiptAnchor(f);
  const c = CUTS[CUTS.length - 1 - i]!;
  const pts = c.track.points;
  const [x, y] = pts[Math.min(pts.length - 1, f - c.at)]!;
  return camera(f, c.at).map({ x, y });
}

/** On the printer close-up the words hang off the paper's right edge as it comes out of the slot, to its right. */
function receiptAnchor(f: number): (Point & { side: 'right' }) | null {
  const t = f - RECEIPTS_AT;
  if (t < 0 || t > 44) return null;
  return { x: 1110, y: Math.max(560, 820 - t * 24), side: 'right' };
}

export const Film: React.FC<{ src: string; at: number; id?: string }> = ({ src, at, id = 'film' }) => {
  const frame = useCurrentFrame() + at;
  const cam = camera(frame, at);
  // the projector's flicker: the exposure breathes a few percent frame to frame
  const flicker = 0.94 + random(`flicker-${frame}`) * 0.08;
  return (
    <Layer id={`${id}-${at}`} x={(1 - cam.s) * (W / 2) + cam.jx} y={(1 - cam.s) * (H / 2) + cam.jy} scale={cam.s} opacity={flicker}
      effects={[gradientMap({ stops: TONE }), glow({ radius: 40, intensity: 0.3 }), grain(0.09, { seed: 7 + at })]}>
      <Video src={staticFile(src)} width={W} height={H} fit="cover" muted />
    </Layer>
  );
};

/** A two-frame flash on a cut, warm, like light through the gate. */
export const Flash: React.FC<{ at: number }> = ({ at }) => {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{ background: '#FFE9C8', opacity: interpolate(frame, [at, at + 1, at + 4], [0.6, 0.3, 0], CLAMP) }} />;
};

export const S07: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      {CUTS.map((c, i) => (
        <Sequence key={c.src} from={c.at} durationInFrames={(CUTS[i + 1]?.at ?? RECEIPTS_AT) - c.at}>
          <Film src={c.src} at={c.at} />
        </Sequence>
      ))}
      <Sequence from={RECEIPTS_AT}><Receipts frames={LEN.s07 - RECEIPTS_AT} /></Sequence>
      {/* the vignette of an old lens */}
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse 80% 75% at 50% 50%, rgba(0,0,0,0) 50%, rgba(0,0,0,0.6) 100%)' }} />
      <Captions lines={LINES} anchor={anchor} width={W} height={H} top={BAR + 30} />
      <AbsoluteFill>
        <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: BAR, background: '#000' }} />
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: BAR, background: '#000' }} />
      </AbsoluteFill>
      {[CUTS[1].at, RECEIPTS_AT].map((at) => frame >= at && frame < at + 4 && <Flash key={at} at={at} />)}
    </AbsoluteFill>
  );
};
