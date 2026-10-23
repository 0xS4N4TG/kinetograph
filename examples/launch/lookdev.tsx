// Look development, not part of the film: each frame shows one of looks.ts on a piece of the film, so a still per frame
// is a look sheet. `still lookdev.tsx <frame>`.

import React from 'react';
import { AbsoluteFill, Composition, registerRoot, staticFile, useCurrentFrame } from 'remotion';
import { Layer, Video } from '@kinetograph/core';
import { H, W } from './common.js';
import { crt, depthLook, oneBit, RAINBOW, thermal, vhs } from './looks.js';
import { Problem } from './act1.js';

const LOOKS = [
  { name: 'crt', fx: [crt()] },
  { name: 'vhs', fx: [vhs({ track: 0.6, trackAt: 0.55 })] },
  { name: '1-bit', fx: oneBit() },
  { name: 'thermal iron', fx: thermal() },
  { name: 'thermal rainbow', fx: thermal({ palette: RAINBOW }) },
  { name: 'depth', fx: depthLook() },
  { name: 'crt off line', fx: [crt({ offy: 0.012 })] },
  { name: 'crt off dot', fx: [crt({ offy: 0.006, offx: 0.03 })] },
];

const Look: React.FC = () => {
  const frame = useCurrentFrame();
  const look = LOOKS[frame % LOOKS.length]!;
  // even frames below 8 the 1927 footage; 8 and on the screenshot pile of shot 3 through the same look
  const screen = frame >= LOOKS.length;
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      <Layer id="look" effects={look.fx}>
        {screen ? <Problem t={frame} /> : <Video src={staticFile('footage/veteran.mp4')} width={W} height={H} fit="cover" muted />}
      </Layer>
      <div style={{ position: 'absolute', left: 30, top: 24, color: '#fff', fontSize: 30, fontFamily: 'monospace' }}>{look.name}</div>
    </AbsoluteFill>
  );
};

registerRoot(() => <Composition id="lookdev" component={Look} width={W} height={H} fps={30} durationInFrames={16} />);
