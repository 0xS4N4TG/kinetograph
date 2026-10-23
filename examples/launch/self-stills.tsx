// The stills shot 11 flickers through (public/self/v2-*.jpg): frames of this film and of its 1927 footage, each seen
// through one of the film's looks (looks.ts), like a sheet of looks. Frame `i` of the `self` composition is still `i`
// of SELF_STILLS; render each with `still self-stills.tsx <i>` and save it as public/self/<name>.jpg.

import React from 'react';
import { AbsoluteFill, Composition, Freeze, Img, registerRoot, staticFile, useCurrentFrame } from 'remotion';
import { Layer, Video } from '@kinetograph/core';
import { H, W } from './common.js';
import { S05 } from './act1.js';
import { S03 } from './act1-crt.js';
import { S08, S09 } from './act2.js';
import { M3, M4, M5 } from './act2-mg.js';
import { S10 } from './act3.js';
import { RAINBOW, crt, oneBit, thermal, vhs } from './looks.js';

const clip = (src: string) => () => <Video src={staticFile(src)} width={W} height={H} fit="cover" muted />;
const crowd = () => <Img src={staticFile('receipts/crowd.png')} style={{ width: W, height: H, objectFit: 'cover' }} />;
const shot = (C: React.FC) => () => <C />;
/** A face from the receipts, in the middle of a black frame. */
const face = (src: string) => () => (
  <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}><Img src={staticFile(src)} style={{ height: H * 0.92, objectFit: 'contain' }} /></AbsoluteFill>
);

export const SELF_STILLS: { name: string; draw: () => React.ReactNode; frame: number; fx?: any[] }[] = [
  { name: 'v2-veteran-iron', draw: clip('footage/veteran.mp4'), frame: 20, fx: thermal() },
  { name: 'v2-s03', draw: shot(S03), frame: 66 },
  { name: 'v2-hat-1bit', draw: clip('footage/hat.mp4'), frame: 10, fx: oneBit({ size: 3, paper: '#d8ecd9' }) },
  { name: 'v2-m3', draw: shot(M3), frame: 40 },
  { name: 'v2-s05-pass', draw: shot(S05), frame: 8 },
  { name: 'v2-beard-iron', draw: face('receipts/face-beard.png'), frame: 0, fx: thermal() },
  { name: 'v2-crowd-vhs', draw: crowd, frame: 0, fx: [vhs({ track: 0.7, trackAt: 0.4, trackW: 90 })] },
  { name: 'v2-m4', draw: shot(M4), frame: 40 },
  { name: 'v2-s05', draw: shot(S05), frame: 40 },
  { name: 'v2-veteran-rainbow', draw: clip('footage/veteran.mp4'), frame: 50, fx: thermal({ palette: RAINBOW }) },
  { name: 'v2-m5', draw: shot(M5), frame: 60 },
  { name: 'v2-veteran-crt', draw: clip('footage/veteran.mp4'), frame: 40, fx: [crt({ pitch: 5 })] },
  { name: 'v2-s08', draw: shot(S08), frame: 200 },
  { name: 'v2-hat-crt', draw: clip('footage/hat.mp4'), frame: 30, fx: [crt({ pitch: 5 })] },
  { name: 'v2-s10', draw: shot(S10), frame: 70 },
  { name: 'v2-s09', draw: shot(S09), frame: 150 },
  { name: 'v2-crowd-1bit', draw: crowd, frame: 0, fx: oneBit({ size: 4, ink: '#04060a', paper: '#cfe3ff' }) },
  { name: 'v2-pair-vhs', draw: face('receipts/face-pair.png'), frame: 0, fx: [vhs({ track: 0.5, trackAt: 0.7, trackW: 60 })] },
];

const Still: React.FC = () => {
  const s = SELF_STILLS[useCurrentFrame()]!;
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      <Freeze frame={s.frame}>
        <Layer id="self" effects={s.fx ?? []}>{s.draw()}</Layer>
      </Freeze>
    </AbsoluteFill>
  );
};

registerRoot(() => <Composition id="self" component={Still} width={W} height={H} fps={30} durationInFrames={SELF_STILLS.length} />);
