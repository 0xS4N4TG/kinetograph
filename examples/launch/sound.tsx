// The soundtrack: the voiceover as <Audio>, and the music and sound design synthesised in sound-cues.ts through
// onFrame (deterministic: noise from random(seed)). The voiceover is one take from tools/narration (the Tiny Agent narrator).

import React from 'react';
import { Audio, Sequence, staticFile } from 'remotion';
import { TAKE_AT } from './cut.js';
import './sound-cues.js';

export const Soundtrack: React.FC = () => (
  <>
    {/* the narration: one take, played whole */}
    <Sequence from={TAKE_AT}>
      <Audio src={staticFile('vo/take.wav')} volume={0.85} />
    </Sequence>
  </>
);
