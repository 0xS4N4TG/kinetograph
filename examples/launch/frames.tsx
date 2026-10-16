// Style frames for the storyboard (storyboard.html): each shot as its own composition, for stills.

import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { FPS, H, LEN, W } from './common.js';
import { S01, S02, S03, S04, S05, S06 } from './act1.js';
import { S07, S08, S09 } from './act2.js';
import { S10, S11, S12 } from './act3.js';

const SHOTS: [keyof typeof LEN, React.FC<any>][] = [
  ['s01', S01], ['s02', S02], ['s03', S03], ['s04', S04], ['s05', S05], ['s06', S06],
  ['s07', S07], ['s08', S08], ['s09', S09], ['s10', S10], ['s11', S11], ['s12', S12],
];

const Root: React.FC = () => (
  <>
    {SHOTS.map(([id, c]) => <Composition key={id} id={id} component={c} width={W} height={H} fps={FPS} durationInFrames={LEN[id]} />)}
    <Composition id="s05-raw" component={S05} defaultProps={{ graded: false }} width={W} height={H} fps={FPS} durationInFrames={LEN.s05} />
  </>
);

registerRoot(Root);
