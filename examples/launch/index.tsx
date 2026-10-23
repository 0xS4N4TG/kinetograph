// The Kinetograph launch film (STORYBOARD.md, storyboard.html): twelve shots and the motion-graphics run in one cut,
// about 50 s at 30 fps.

import React from 'react';
import { AbsoluteFill, Composition, Series, Sequence, registerRoot } from 'remotion';
import { FPS, H, LEN, W } from './common.js';
import { S01, S02 } from './act1-open.js';
import { S05, S06 } from './act1.js';
import { S03, S04 } from './act1-crt.js';
import { S07, S08, S09 } from './act2.js';
import { M1, M2, M3, M4, M5 } from './act2-mg.js';
import { S10, S11, S12 } from './act3.js';
import { Soundtrack } from './sound.js';

/** Where the burn (shot 6) is centred: on the cut from shot 5 into shot 7. */
export const BURN_CUT = LEN.s01 + LEN.s02 + LEN.s03 + LEN.s04 + LEN.s05;
export const TOTAL = BURN_CUT + LEN.s07 + LEN.m1 + LEN.m2 + LEN.m3 + LEN.m4 + LEN.m5 + LEN.s08 + LEN.s09 + LEN.s10 + LEN.s11 + LEN.s12;

const Launch: React.FC = () => (
  <AbsoluteFill>
    <Series>
      <Series.Sequence durationInFrames={LEN.s01}><S01 /></Series.Sequence>
      <Series.Sequence durationInFrames={LEN.s02}><S02 /></Series.Sequence>
      <Series.Sequence durationInFrames={LEN.s03}><S03 /></Series.Sequence>
      <Series.Sequence durationInFrames={LEN.s04}><S04 /></Series.Sequence>
      <Series.Sequence durationInFrames={LEN.s05}><S05 /></Series.Sequence>
      <Series.Sequence durationInFrames={LEN.s07}><S07 /></Series.Sequence>
      <Series.Sequence durationInFrames={LEN.m1}><M1 /></Series.Sequence>
      <Series.Sequence durationInFrames={LEN.m2}><M2 /></Series.Sequence>
      <Series.Sequence durationInFrames={LEN.m3}><M3 /></Series.Sequence>
      <Series.Sequence durationInFrames={LEN.m4}><M4 /></Series.Sequence>
      <Series.Sequence durationInFrames={LEN.m5}><M5 /></Series.Sequence>
      <Series.Sequence durationInFrames={LEN.s08}><S08 /></Series.Sequence>
      <Series.Sequence durationInFrames={LEN.s09}><S09 /></Series.Sequence>
      <Series.Sequence durationInFrames={LEN.s10}><S10 /></Series.Sequence>
      <Series.Sequence durationInFrames={LEN.s11}><S11 /></Series.Sequence>
      <Series.Sequence durationInFrames={LEN.s12}><S12 /></Series.Sequence>
    </Series>
    <Sequence from={BURN_CUT - Math.floor(LEN.s06 / 2)} durationInFrames={LEN.s06}><S06 /></Sequence>
    <Soundtrack />
  </AbsoluteFill>
);

registerRoot(() => <Composition id="launch" component={Launch} width={W} height={H} fps={FPS} durationInFrames={TOTAL} />);
